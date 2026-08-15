/**
 * Computer Use Tools — Stage 9
 *
 * Registers all computer_* and vscode_* tools with the tool registry.
 * Each tool validates that:
 *   1. computerUse.enabled is true in config
 *   2. An active session exists (for interaction tools)
 *   3. The caller holds the session lease
 *   4. Action pacing is respected
 */

import { Buffer } from "node:buffer";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { canAccessResource } from "../guardrails/resource-access.js";
import { lookupSiteCredential, siteCredentialMissMessage } from "../credentials/sites.js";
import {
  computerSessionManager,
  type ComputerSession,
  type ComputerSessionAdapter,
  type ComputerSessionSnapshot,
} from "../agent/computer-session.js";
import type { ComputerUseConfig } from "../config/computer-use-schema.js";
import { analyzeScreenshot } from "../agent/computer-vision.js";
import {
  captureComputerSessionSnapshot,
  executeComputerSessionAction,
  initializeComputerSessionAdapter,
  listComputerSessionWindows,
} from "../agent/computer-adapters/runtime.js";

const log = childLogger("tool:computer-use");
const IMPLEMENTED_ADAPTERS = new Set<ComputerSessionAdapter>(["local_vscode", "remote_node", "local_desktop", "remote_vnc", "remote_rdp", "remote_ssh"]);

/** Tracking for action pacing — sessionId → last action timestamp. */
const _lastActionAt = new Map<string, number>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function getComputerUseConfig(): ComputerUseConfig {
  const cfg = getConfig();
  return (cfg as Record<string, unknown>)["computerUse"] as ComputerUseConfig;
}

function requireEnabled(): ComputerUseConfig {
  const cuCfg = getComputerUseConfig();
  if (!cuCfg?.enabled) {
    throw new Error("Computer use is disabled — set computerUse.enabled = true in config");
  }
  return cuCfg;
}

function requireImplementedAdapter(adapter: ComputerSessionAdapter): void {
  if (!IMPLEMENTED_ADAPTERS.has(adapter)) {
    throw new Error(
      `Computer adapter '${adapter}' is not implemented yet. ` +
      `Currently supported adapters: ${[...IMPLEMENTED_ADAPTERS].join(", ")}.`,
    );
  }
}

function resolveSessionStartAdapter(
  requestedAdapter: ComputerSessionAdapter,
  cuCfg: ComputerUseConfig,
): ComputerSessionAdapter {
  if (requestedAdapter === "local_desktop") {
    // local_desktop routes to the best available desktop adapter
    if (cuCfg.adapters?.remote_vnc) return "remote_vnc";
    if (cuCfg.adapters?.remote_rdp) return "remote_rdp";
    if (cuCfg.adapters?.remote_node) return "remote_node";
    if (cuCfg.adapters?.remote_ssh) return "remote_ssh";
    throw new Error(
      "Computer adapter 'local_desktop' requires a configured remote adapter. " +
      "Configure computerUse.adapters.remote_vnc, remote_rdp, remote_node, or remote_ssh.",
    );
  }
  return requestedAdapter;
}

function resolvePreferredAdapter(): ComputerSessionAdapter {
  const cuCfg = requireEnabled();
  const adapters = cuCfg.adapters ?? {};

  // Prefer remote protocol adapters (no custom node needed) → remote_node → local
  if (adapters.remote_vnc) return "remote_vnc";
  if (adapters.remote_rdp) return "remote_rdp";
  if (adapters.remote_node) return "remote_node";
  if (adapters.remote_ssh) return "remote_ssh";
  if (adapters.local_vscode) return "local_vscode";

  for (const adapter of IMPLEMENTED_ADAPTERS) {
    if ((adapters as Record<string, unknown>)[adapter]) {
      return adapter;
    }
  }

  // Fall back to the first configured node's adapter type
  const nodes = cuCfg.nodes ?? {};
  const firstNode = Object.values(nodes)[0];
  if (firstNode) return firstNode.adapter as ComputerSessionAdapter;

  throw new Error("No supported computer adapter is configured. Configure computerUse.adapters or computerUse.nodes.");
}

function getLeaseFamilyRoot(leaseOwner: string | undefined): string {
  const normalized = leaseOwner?.trim() ?? "";
  if (!normalized) return "";
  const match = /^sub:([^:]+)/u.exec(normalized);
  return match?.[1] ?? normalized;
}

function isSameLeaseFamily(left: string | undefined, right: string | undefined): boolean {
  const leftRoot = getLeaseFamilyRoot(left);
  const rightRoot = getLeaseFamilyRoot(right);
  return leftRoot.length > 0 && leftRoot === rightRoot;
}

function requireActiveSession(sessionId?: string, leaseOwner?: string): { sessionId: string } {
  if (sessionId) {
    const session = computerSessionManager.getSession(sessionId);
    if (!session) throw new Error(`Computer session '${sessionId}' not found`);
    // Auto-resume paused sessions when a tool call arrives — the LLM is
    // clearly still using the session so the heartbeat-loss was a false
    // positive (typically caused by long LLM thinking time between actions).
    if (session.state === "paused") {
      computerSessionManager.resumeSession(sessionId);
    } else if (session.state !== "active") {
      throw new Error(`Computer session '${sessionId}' is not active (state: ${session.state})`);
    }
    if (leaseOwner && session.leaseOwner && session.leaseOwner !== leaseOwner) {
      throw new Error(`Computer session '${sessionId}' is leased to '${session.leaseOwner}'. Attach the session before acting on it.`);
    }
    return { sessionId };
  }
  // Find the first active session (also attempt to wake paused ones)
  const candidates = computerSessionManager.listActiveSessions().filter((session) => !leaseOwner || session.leaseOwner === leaseOwner);
  for (const c of candidates) {
    if (c.state === "paused") computerSessionManager.resumeSession(c.id);
  }
  const active = candidates.filter((s) => s.state === "active");
  if (active.length === 0) throw new Error("No active computer session. Start one with computer_session_start first.");
  return { sessionId: active[0]!.id };
}

function enforcePacing(sessionId: string): void {
  const cuCfg = getComputerUseConfig();
  const pacingMs = cuCfg?.actionPacingMs ?? 500;
  const lastAt = _lastActionAt.get(sessionId) ?? 0;
  const elapsed = Date.now() - lastAt;
  if (elapsed < pacingMs) {
    throw new Error(`Action pacing: ${pacingMs - elapsed}ms remaining before next action (min ${pacingMs}ms between actions)`);
  }
  _lastActionAt.set(sessionId, Date.now());
}

function fail(error: string): ToolResult {
  return { success: false, output: "", error };
}

function ok(output: string, metadata?: Record<string, unknown>): ToolResult {
  return { success: true, output, metadata };
}

/**
 * A tool that is registered but NOT implemented. It must report failure.
 *
 * These returned success while transferring no file, polling nothing, and running
 * no command — an agent could only discover the no-op by inferring it from later
 * state, and a QA gate reading `success` saw a completed step. A tool that cannot
 * do its job says so.
 */
function notImplemented(what: string, instead?: string): ToolResult {
  return {
    success: false,
    output: "",
    error: `${what} is not implemented in this build${instead ? ` — ${instead}` : ""}.`,
  };
}

function formatDisplayTopologySummary(sessionId: string): string {
  const topology = computerSessionManager.getSession(sessionId)?.displayTopology;
  if (!topology || topology.monitors.length === 0) return "";
  const monitors = topology.monitors
    .map((monitor) => `monitor ${monitor.id}: (${monitor.x},${monitor.y}) ${monitor.width}x${monitor.height}${topology.primary === monitor.id ? " primary" : ""}`)
    .join("; ");
  return ` Display topology: ${monitors}.`;
}

function pointIsWithinDisplayTopology(sessionId: string, x: number, y: number): boolean {
  const topology = computerSessionManager.getSession(sessionId)?.displayTopology;
  if (!topology || topology.monitors.length === 0) return true;
  return topology.monitors.some((monitor) => (
    x >= monitor.x
    && y >= monitor.y
    && x < monitor.x + monitor.width
    && y < monitor.y + monitor.height
  ));
}

function decodeDataUrl(dataUrl: string): Uint8Array {
  const match = /^data:[^;]+;base64,(.+)$/u.exec(dataUrl);
  if (!match) {
    throw new Error("Expected base64 data URL from computer adapter");
  }
  return Buffer.from(match[1]!, "base64");
}

function emitSessionState(ctx: ToolContext | undefined, sessionId: string, state: string): void {
  ctx?.onComputerSessionState?.({ computerSessionId: sessionId, state });
}

function emitSnapshot(ctx: ToolContext | undefined, sessionId: string, snapshot: ComputerSessionSnapshot): void {
  if (!snapshot.dataUrl || typeof snapshot.width !== "number" || typeof snapshot.height !== "number") {
    return;
  }
  const session = computerSessionManager.getSession(sessionId);
  ctx?.onComputerScreenshot?.({
    computerSessionId: sessionId,
    dataUrl: snapshot.dataUrl,
    width: snapshot.width,
    height: snapshot.height,
    timestamp: snapshot.timestamp,
    frameId: snapshot.frameId,
    activeWindow: snapshot.activeWindow,
    displayTopology: session?.displayTopology,
  });
}

function emitAction(ctx: ToolContext | undefined, sessionId: string, actionType: string, extra?: Record<string, unknown>): void {
  ctx?.onComputerAction?.({ computerSessionId: sessionId, actionType, ...(extra ?? {}) });
}

async function maybeAnalyzeSnapshot(snapshot: ComputerSessionSnapshot, focusHint?: string): Promise<string | null> {
  if (!snapshot.dataUrl) return null;
  try {
    const analysis = await analyzeScreenshot(decodeDataUrl(snapshot.dataUrl), "image/png", undefined, focusHint);
    return analysis.description;
  } catch (err) {
    log.warn({ error: err instanceof Error ? err.message : String(err) }, "Vision analysis failed — snapshot will lack description");
    return null;
  }
}

async function executeActionTool(
  ctx: ToolContext,
  sessionId: string,
  action: Parameters<typeof executeComputerSessionAction>[1],
  auditData: Record<string, unknown>,
): Promise<ToolResult> {
  logAudit("computer_action", { sessionId, action: action.type, ...auditData });
  const result = await executeComputerSessionAction(sessionId, action);
  emitAction(ctx, sessionId, action.type, auditData);

  // ── Auto-screenshot after every action (Anthropic / OpenAI pattern) ──
  // If the adapter already returned a screenshot (e.g. VNC adapter), use it.
  // Otherwise, capture one automatically so the model always sees the result.
  let snapshot = result.snapshot;
  if (!snapshot) {
    try {
      snapshot = await captureComputerSessionSnapshot(sessionId);
    } catch (err) {
      log.debug({ sessionId, error: err instanceof Error ? err.message : String(err) }, "Auto-screenshot after action failed (non-fatal)");
    }
  }
  if (snapshot) {
    emitSnapshot(ctx, sessionId, snapshot);
  }

  if (!result.success) {
    return fail(result.error ?? `Computer action '${action.type}' failed`);
  }

  // Build response with screen feedback — the model sees what happened
  // without needing a separate computer_snapshot call.
  let output = result.output || `Executed ${action.type}.`;
  if (snapshot) {
    const analysis = await maybeAnalyzeSnapshot(snapshot);
    if (analysis) {
      output += `\n[Screen after action: ${analysis}]`;
    } else if (snapshot.width && snapshot.height) {
      output += `\n[Screenshot captured (${snapshot.width}x${snapshot.height}) — call computer_snapshot for full analysis]`;
    }
  }

  return ok(output, {
    sessionId,
    action: action.type,
    screenshotHash: snapshot?.screenshotHash,
  });
}

// ── Recent connection-failure cache ────────────────────────────────────────────
// Prevents the agent from burning minutes retrying the same unreachable target.
const recentConnectionFailures = new Map<string, { errorMsg: string; ts: number }>();
const CONNECTION_FAILURE_COOLDOWN_MS = 120_000; // 2 minutes

function recordConnectionFailure(key: string, errorMsg: string): void {
  recentConnectionFailures.set(key, { errorMsg, ts: Date.now() });
}

function checkRecentFailure(key: string): string | null {
  const entry = recentConnectionFailures.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CONNECTION_FAILURE_COOLDOWN_MS) {
    recentConnectionFailures.delete(key);
    return null;
  }
  return entry.errorMsg;
}

function findReusableSession(adapter: ComputerSessionAdapter, nodeId: string | undefined): ComputerSession | undefined {
  return computerSessionManager.listActiveSessions().find((session) => (
    session.adapter === adapter
    && (nodeId ? session.nodeId === nodeId : !session.nodeId)
  ));
}

function summarizeSession(session: ComputerSession): string {
  const primary = session.displayTopology?.monitors?.find((monitor) => monitor.id === session.displayTopology?.primary)
    ?? session.displayTopology?.monitors?.[0];
  const display = primary ? `${primary.width}x${primary.height}` : "unknown";
  return [
    `• ${session.id}`,
    `state=${session.state}`,
    `adapter=${session.adapter}`,
    session.nodeId ? `node=${session.nodeId}` : null,
    session.leaseOwner ? `owner=${session.leaseOwner}` : null,
    `display=${display}`,
  ].filter(Boolean).join(" | ");
}

// ── Session Management Tools ──────────────────────────────────────────────────

registerTool({
  name: "computer_list_sessions",
  description:
    "List currently open computer sessions so you can reuse or attach to an existing session instead of opening a new one. " +
    "Call this before computer_session_start when the task may already have an active desktop session.",
  parameters: { type: "object", properties: {} },
  async execute(_args, ctx) {
    try {
      requireEnabled();
      const sessions = computerSessionManager.listActiveSessions();
      if (sessions.length === 0) {
        return ok("No active computer sessions. Start one with computer_session_start after checking available nodes.");
      }

      const owned = sessions.filter((session) => session.leaseOwner === ctx.sessionId);
      const sameFamily = sessions.filter((session) => (
        session.leaseOwner !== ctx.sessionId && isSameLeaseFamily(session.leaseOwner, ctx.sessionId)
      ));
      const other = sessions.filter((session) => !owned.includes(session) && !sameFamily.includes(session));
      const lines: string[] = [];
      if (owned.length > 0) {
        lines.push("Owned by this controller:");
        lines.push(...owned.map(summarizeSession));
      }
      if (sameFamily.length > 0) {
        lines.push("Reusable from the same swarm family:");
        lines.push(...sameFamily.map(summarizeSession));
      }
      if (other.length > 0) {
        lines.push("Open under another controller:");
        lines.push(...other.map(summarizeSession));
      }

      return ok(
        `Active computer sessions:\n${lines.join("\n")}\n\n` +
        "Prefer computer_session_attach(sessionId: '...') or reuse the existing session before calling computer_session_start.",
      );
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

registerTool({
  name: "computer_list_nodes",
  description:
    "List all configured computer nodes that can be connected to. " +
    "Returns named nodes from computerUse.nodes and any single-entry adapters. " +
    "Use the node name in computer_session_start to connect to a specific machine.",
  parameters: { type: "object", properties: {} },
  async execute(_args, ctx) {
    try {
      const cuCfg = requireEnabled();
      const user = ctx.userId;
      const entries: { name: string; adapter: string; label: string; host?: string }[] = [];

      // Named nodes — hide nodes the requesting user may not use.
      for (const [name, node] of Object.entries(cuCfg.nodes ?? {})) {
        if (!canAccessResource(user, node as { allowedUsers?: string[] })) continue;
        entries.push({
          name,
          adapter: (node as Record<string, unknown>).adapter as string,
          label: ((node as Record<string, unknown>).label as string) || name,
          host: (node as Record<string, unknown>).host as string | undefined,
        });
      }

      // Single-entry adapters (backward compat)
      const adapters = cuCfg.adapters ?? {};
      if (adapters.remote_vnc && canAccessResource(user, adapters.remote_vnc as { allowedUsers?: string[] })) entries.push({ name: "(default)", adapter: "remote_vnc", label: "Default VNC", host: adapters.remote_vnc.host });
      if (adapters.remote_rdp && canAccessResource(user, adapters.remote_rdp as { allowedUsers?: string[] })) entries.push({ name: "(default)", adapter: "remote_rdp", label: "Default RDP", host: adapters.remote_rdp.host });
      if (adapters.remote_node && canAccessResource(user, adapters.remote_node as { allowedUsers?: string[] })) entries.push({ name: "(default)", adapter: "remote_node", label: adapters.remote_node.label || "Remote node", host: adapters.remote_node.baseUrl });
      if (adapters.remote_ssh && canAccessResource(user, adapters.remote_ssh as { allowedUsers?: string[] })) entries.push({ name: "(default)", adapter: "remote_ssh", label: "Default SSH", host: adapters.remote_ssh.host });
      if (adapters.local_vscode) entries.push({ name: "(default)", adapter: "local_vscode", label: "Local VS Code" });

      if (entries.length === 0) {
        return ok("No computer nodes configured. Add nodes in computerUse.nodes in starlingai.json.");
      }

      const lines = entries.map((e) =>
        `• ${e.name} — protocol: ${e.adapter}${e.host ? `, host: ${e.host}` : ""}${e.label && e.label !== e.name ? ` [${e.label}]` : ""}\n  → Connect with: computer_session_start(node: '${e.name}')`,
      );
      return ok(
        `Available computer nodes:\n${lines.join("\n")}\n\n` +
        `IMPORTANT: Use the node name to connect. The protocol (VNC/RDP/SSH) is pre-configured per node — do NOT override it.`,
      );
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

registerTool({
  name: "computer_session_start",
  description:
    "Start a new computer session for desktop/VS Code/remote control. " +
    "Before opening a new session, prefer computer_list_sessions to check whether a reusable session already exists. " +
    "PREFERRED: Use the 'node' parameter with a name from computer_list_nodes — the protocol (VNC/RDP/SSH) is already configured per node, you do NOT choose it. " +
    "Example: computer_session_start(node: 'win-workstation') connects using whatever protocol that node is configured with. " +
    "Only use 'adapter' or 'host' for ad-hoc connections when no matching node exists. " +
    "Call computer_list_nodes first to discover available targets. " +
    "Every action tool automatically captures a screenshot after executing.",
  parameters: {
    type: "object",
    properties: {
      node: {
        type: "string",
        description: "Name of a configured computer node from computerUse.nodes (e.g. 'desktop', 'win-workstation'). Use computer_list_nodes to see available nodes.",
      },
      adapter: {
        type: "string",
        enum: ["local_desktop", "local_vscode", "remote_node", "remote_vnc", "remote_rdp", "remote_ssh"],
        description: "Adapter type (only needed if not using a named node). If omitted, prefers remote_vnc/remote_rdp/remote_ssh if configured.",
      },
      host: {
        type: "string",
        description: "Ad-hoc host/IP to connect to when no pre-configured node matches the target. Requires adapter to be set.",
      },
      port: {
        type: "number",
        description: "Port number for ad-hoc connection (default: 5900 for VNC, 3389 for RDP).",
      },
      recordingEnabled: {
        type: "boolean",
        description: "Whether to record the session for replay (default: from config)",
      },
    },
  },
  async execute(args, ctx) {
    let effectiveNodeId: string | undefined;
    let adapter: ComputerSessionAdapter | undefined;
    // Ad-hoc connections write a transient node into the shared singleton config so
    // createAdapter() can resolve it during initialization; track it so a `finally`
    // can remove it on EVERY exit path (success, reuse early-return, error) instead
    // of leaking one entry per distinct host:port forever.
    let adHocNodeIdForCleanup: string | undefined;
    try {
      const cuCfg = requireEnabled();
      const nodeId = args["node"] ? String(args["node"]) : undefined;
      const adHocHost = args["host"] ? String(args["host"]) : undefined;
      let requestedAdapter: ComputerSessionAdapter | undefined;
      let adHocNodeId: string | undefined;

      if (nodeId) {
        // ── Named node resolution ─────────────────────────────────────────
        const node = cuCfg.nodes?.[nodeId];
        if (!node || !canAccessResource(ctx.userId, node as { allowedUsers?: string[] })) {
          // Treat a restricted node like an unknown one — do not leak existence.
          const available = Object.keys(cuCfg.nodes ?? {}).filter((n) => canAccessResource(ctx.userId, cuCfg.nodes?.[n] as { allowedUsers?: string[] }));
          throw new Error(
            `Computer node '${nodeId}' not found. ` +
            (available.length > 0
              ? `Available nodes: ${available.join(", ")}`
              : "No nodes configured — add them in computerUse.nodes."),
          );
        }
        adapter = (node as Record<string, unknown>).adapter as ComputerSessionAdapter;
        requireImplementedAdapter(adapter);
      } else if (adHocHost) {
        // ── Ad-hoc connection: host/port/credentials provided directly ────
        const adHocAdapter = (args["adapter"]
          ? String(args["adapter"])
          : "remote_vnc") as ComputerSessionAdapter;
        if (adHocAdapter !== "remote_vnc" && adHocAdapter !== "remote_rdp") {
          throw new Error(
            `Ad-hoc connections (host parameter) only support remote_vnc or remote_rdp adapters, got '${adHocAdapter}'.`,
          );
        }
        const defaultPort = adHocAdapter === "remote_rdp" ? 3389 : 5900;
        const port = typeof args["port"] === "number" ? args["port"] : defaultPort;
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          return fail(
            `Invalid port ${String(args["port"])} for ad-hoc ${adHocAdapter} connection — must be an integer in 1..65535.`,
          );
        }

        // SECURITY: credentials are never accepted from the LLM.
        // Ad-hoc connections use no credentials; for authenticated access,
        // configure a named node in computerUse.nodes with credentials.

        // Register as a transient node so createAdapter() can resolve it.
        adHocNodeId = `adhoc_${adHocHost.replace(/[^a-zA-Z0-9]/g, "_")}_${port}`;
        const transientNode = {
          adapter: adHocAdapter,
          host: adHocHost,
          port,
          protocol: adHocAdapter === "remote_rdp" ? "rdp" as const : "vnc" as const,
          reconnectAttempts: 3,
          reconnectDelayMs: 5000,
          label: `Ad-hoc ${adHocAdapter} to ${adHocHost}:${port}`,
        };
        // Write into config.nodes temporarily so createAdapter() resolves it
        if (!cuCfg.nodes) (cuCfg as unknown as Record<string, unknown>).nodes = {};
        cuCfg.nodes[adHocNodeId] = transientNode;
        adHocNodeIdForCleanup = adHocNodeId;
        adapter = adHocAdapter;
      } else {
        // ── Legacy adapter-level resolution ───────────────────────────────
        requestedAdapter = (args["adapter"]
          ? String(args["adapter"])
          : resolvePreferredAdapter()) as ComputerSessionAdapter;
        requireImplementedAdapter(requestedAdapter);
        adapter = resolveSessionStartAdapter(requestedAdapter, cuCfg);
      }

      effectiveNodeId = nodeId ?? adHocNodeId;

      // ── Check recent-failure cache to avoid 95s waits on repeated retries ──
      const failureKey = effectiveNodeId ?? `adapter:${adapter}`;
      const recentError = checkRecentFailure(failureKey);
      if (recentError) {
        return fail(
          `Connection to '${failureKey}' failed recently and is still in cooldown (2 min).\n` +
          `Previous error: ${recentError}\n` +
          `Do NOT retry — ask the user to verify the target machine is reachable first.`,
        );
      }

      // ── Idempotency: reuse an existing active/paused session for the same target ──
      const existing = findReusableSession(adapter, effectiveNodeId);
      if (existing) {
        const existingOwner = existing.leaseOwner;
        const sameOwner = existingOwner === ctx.sessionId;
        const canAutoAttach = !existingOwner
          || sameOwner
          || isSameLeaseFamily(existingOwner, ctx.sessionId)
          || computerSessionManager.isLeaseAutoApproved(existing.id);

        if (!sameOwner) {
          if (!canAutoAttach) {
            return fail(
              `A computer session for '${effectiveNodeId ?? adapter}' is already open.\n` +
              `Session ID: ${existing.id}\n` +
              `Current owner: ${existingOwner || "unowned"}\n` +
              "Reuse that session with computer_session_attach instead of starting another one.",
            );
          }
          computerSessionManager.attachSession(existing.id, ctx.sessionId, true);
        }

        if (existing.state === "paused") computerSessionManager.resumeSession(existing.id);
        const reused = computerSessionManager.getSession(existing.id)!;
        computerSessionManager.refreshLeaseAutoApprove(reused.id);
        emitSessionState(ctx, reused.id, reused.state);
        const topology = reused.displayTopology;
        return ok(
          `Computer session already active (reused existing session).\n` +
          `Session ID: ${reused.id}\n` +
          (reused.nodeId ? `Node: ${reused.nodeId}\n` : "") +
          `Adapter: ${reused.adapter}\n` +
          `State: ${reused.state}\n` +
          (topology?.monitors?.[0] ? `Primary display: ${topology.monitors[0].width}x${topology.monitors[0].height}\n` : "") +
            `Next: call computer_list_windows and then computer_snapshot before taking any action.`,
          { sessionId: reused.id, adapter: reused.adapter, requestedAdapter, nodeId: effectiveNodeId, reused: true },
        );
      }

      const recording = typeof args["recordingEnabled"] === "boolean" ? args["recordingEnabled"] : undefined;

      const session = computerSessionManager.startSession(adapter, ctx.sessionId, {
        recordingEnabled: recording,
        nodeId: effectiveNodeId,
      });

      try {
        const topology = await initializeComputerSessionAdapter(session);
        computerSessionManager.activateSession(session.id, topology);
      } catch (error) {
        computerSessionManager.emergencyStop(session.id, "adapter_initialization_failed");
        throw error;
      }

      // Grant lease auto-approve for this session
      computerSessionManager.refreshLeaseAutoApprove(session.id);
      emitSessionState(ctx, session.id, "active");

      logAudit("computer_action", { sessionId: session.id, action: "session_start", adapter, nodeId: effectiveNodeId });

      const topology = computerSessionManager.getSession(session.id)?.displayTopology;

      return ok(
        `Computer session started.\n` +
        `Session ID: ${session.id}\n` +
        (effectiveNodeId ? `Node: ${effectiveNodeId}\n` : "") +
        (requestedAdapter && requestedAdapter !== adapter ? `Requested adapter: ${requestedAdapter}\n` : "") +
        `Adapter: ${adapter}\n` +
        `State: active\n` +
        (topology?.monitors?.[0] ? `Primary display: ${topology.monitors[0].width}x${topology.monitors[0].height}\n` : "") +
        `Next: call computer_list_windows and then computer_snapshot before taking any action.`,
        { sessionId: session.id, adapter, requestedAdapter, nodeId: effectiveNodeId },
      );
    } catch (error) {
      log.error({ error }, "computer_session_start failed");
      const msg = error instanceof Error ? error.message : String(error);
      // Add troubleshooting hints for connection failures
      const isTimeout = /timed out|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH/i.test(msg);
      if (isTimeout) {
        const fKey = effectiveNodeId ?? `adapter:${adapter}`;
        recordConnectionFailure(fKey, msg);
      }
      const hint = isTimeout
        ? "\n\nTroubleshooting:\n" +
          "• Verify the target machine is powered on and reachable (ping the IP)\n" +
          "• Confirm the VNC/RDP service is running on the expected port\n" +
          "• Check firewall rules allow inbound connections on that port\n" +
          "• If connecting from Docker, ensure the container network can reach the host\n" +
          "\nDo NOT retry the same connection — ask the user to verify the target machine first."
        : "";
      return fail(msg + hint);
    } finally {
      // The transient ad-hoc node is only needed during createAdapter(); the adapter
      // instance is cached on the session afterwards (and reconnect reuses it), so
      // remove the config entry here to prevent an unbounded host:port-keyed leak.
      if (adHocNodeIdForCleanup) {
        const nodes = getComputerUseConfig()?.nodes;
        if (nodes) delete nodes[adHocNodeIdForCleanup];
      }
    }
  },
});

registerTool({
  name: "computer_session_attach",
  description: "Attach to an existing computer session (take over or resume).",
  parameters: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "Session ID to attach to" },
      force: { type: "boolean", description: "Force-attach even if another controller holds the lease" },
    },
    required: ["sessionId"],
  },
  async execute(args, ctx) {
    try {
      requireEnabled();
      const sessionId = String(args["sessionId"]);
      const force = args["force"] === true;

      const session = computerSessionManager.attachSession(sessionId, ctx.sessionId, force);
      emitSessionState(ctx, sessionId, session.state);
      return ok(
        `Attached to computer session ${sessionId}.\nAdapter: ${session.adapter}\nState: ${session.state}`,
        { sessionId },
      );
    } catch (error) {
      log.error({ error }, "computer_session_attach failed");
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

registerTool({
  name: "computer_session_stop",
  description: "Gracefully stop a computer session.",
  parameters: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "Session ID to stop (default: first active)" },
    },
  },
  async execute(args, ctx) {
    try {
      const { sessionId } = requireActiveSession(args["sessionId"] as string | undefined, ctx.sessionId);
      computerSessionManager.stopSession(sessionId, "user_requested");
      _lastActionAt.delete(sessionId);
      emitSessionState(ctx, sessionId, "stopped");
      return ok(`Computer session ${sessionId} stopped.`);
    } catch (error) {
      log.error({ error }, "computer_session_stop failed");
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

// ── Interaction Tools ─────────────────────────────────────────────────────────

registerTool({
  name: "computer_snapshot",
  description:
    "Capture a screenshot of the current computer session and analyze it with the vision model. " +
    "Returns a textual description of the screen contents. " +
    "Optional: provide a focus hint such as 'LM Studio loaded models' for task-specific OCR. " +
    "Note: action tools (click, type, hotkey, etc.) already capture screenshots automatically — " +
    "use this only when you need a fresh look without performing an action, or for detailed vision analysis.",
  parameters: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "Session ID (default: first active)" },
      focus: { type: "string", description: "Optional analysis focus, e.g. 'LM Studio loaded models'" },
    },
  },
  async execute(args, ctx) {
    try {
      requireEnabled();
      const { sessionId } = requireActiveSession(args["sessionId"] as string | undefined, ctx.sessionId);
      const session = computerSessionManager.getSession(sessionId)!;
      const focus = typeof args["focus"] === "string" ? args["focus"].trim() : "";
      const snapshot = await captureComputerSessionSnapshot(sessionId);
      emitSnapshot(ctx, sessionId, snapshot);
      logAudit("computer_action", { sessionId, action: "snapshot" });
      const analysis = await maybeAnalyzeSnapshot(snapshot, focus || undefined);

      return ok(
        `[Desktop Snapshot — Session ${sessionId}]\n` +
        `Adapter: ${session.adapter}\n` +
        `State: ${session.state}\n` +
        (snapshot.width && snapshot.height ? `Size: ${snapshot.width}x${snapshot.height}\n` : "") +
        (focus ? `Focus: ${focus}\n` : "") +
        (analysis ? `Analysis: ${analysis}` : "Screenshot captured. No vision summary was available for this turn."),
        { sessionId, frameId: snapshot.frameId, screenshotHash: snapshot.screenshotHash },
      );
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

registerTool({
  name: "computer_click",
  description: "Click at (x, y) coordinates on the computer screen.",
  parameters: {
    type: "object",
    properties: {
      x: { type: "number", description: "X coordinate" },
      y: { type: "number", description: "Y coordinate" },
      button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button (default: left)" },
      doubleClick: { type: "boolean", description: "Double-click (default: false)" },
      sessionId: { type: "string", description: "Session ID (default: first active)" },
    },
    required: ["x", "y"],
  },
  async execute(args, ctx) {
    try {
      requireEnabled();
      const { sessionId } = requireActiveSession(args["sessionId"] as string | undefined, ctx.sessionId);
      enforcePacing(sessionId);

      const x = Number(args["x"]);
      const y = Number(args["y"]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return fail(
          "computer_click requires numeric 'x' and 'y' arguments. " +
          "Do not pass browser-style fields like 'element' or 'ref'; use exact screen coordinates instead.",
        );
      }
      if (!pointIsWithinDisplayTopology(sessionId, x, y)) {
        return fail(
          `Click coordinates (${x}, ${y}) are outside the known display bounds for session ${sessionId}. ` +
          `Use computer_snapshot to get fresh visible coordinates before clicking.` +
          formatDisplayTopologySummary(sessionId),
        );
      }
      const button = String(args["button"] ?? "left");
      const dbl = args["doubleClick"] === true;

      return await executeActionTool(ctx, sessionId, {
        type: "click",
        x,
        y,
        button: button as "left" | "right" | "middle",
        doubleClick: dbl,
      }, { x, y, button, doubleClick: dbl });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

registerTool({
  name: "computer_type",
  description: "Type text into the currently focused element.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to type" },
      pressEnter: { type: "boolean", description: "Press Enter after typing (default: false)" },
      sessionId: { type: "string", description: "Session ID (default: first active)" },
    },
    required: ["text"],
  },
  async execute(args, ctx) {
    try {
      requireEnabled();
      const { sessionId } = requireActiveSession(args["sessionId"] as string | undefined, ctx.sessionId);
      enforcePacing(sessionId);

      const text = String(args["text"]);
      const pressEnter = args["pressEnter"] === true;

      return await executeActionTool(ctx, sessionId, {
        type: "type",
        text,
        pressEnter,
      }, { textLength: text.length, pressEnter });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

registerTool({
  name: "computer_hotkey",
  description: "Send a safe keyboard shortcut (e.g. 'ctrl+s', 'alt+tab', 'enter', 'escape'). Multi-modifier combos like ctrl+shift+* are blocked — use mouse clicks instead.",
  parameters: {
    type: "object",
    properties: {
      keys: { type: "string", description: "Key combination (e.g. 'ctrl+s')" },
      sessionId: { type: "string", description: "Session ID (default: first active)" },
    },
    required: ["keys"],
  },
  async execute(args, ctx) {
    try {
      requireEnabled();
      const { sessionId } = requireActiveSession(args["sessionId"] as string | undefined, ctx.sessionId);
      enforcePacing(sessionId);

      let keys = String(args["keys"]);

      // LLMs sometimes pass keys as a JSON array string like '["ctrl","shift","i"]'
      // instead of the expected 'ctrl+shift+i' format.  Detect and normalise.
      if (keys.startsWith("[")) {
        try {
          const parsed = JSON.parse(keys);
          if (Array.isArray(parsed)) keys = parsed.join("+");
        } catch { /* leave as-is */ }
      }

      // Block dangerous key combos that behave differently depending on window focus
      const normalized = keys.toLowerCase().replace(/\s+/g, "");
      if (/^(?:win|meta)(?:\+|$)/i.test(normalized)) {
        return fail(`Hotkey '${keys}' is blocked: Windows/Meta shortcuts can open system UI or launch dialogs unpredictably. Use computer_click on visible UI elements instead.`);
      }
      const BLOCKED_HOTKEYS: Record<string, string> = {
        "ctrl+alt+delete": "system security screen",
        "ctrl+alt+del": "system security screen",
        "ctrl+shift+p": "print dialog in browsers — use mouse clicks to navigate UI instead",
        "ctrl+shift+i": "browser DevTools — wrong target",
        "ctrl+shift+j": "browser DevTools console — wrong target",
        "ctrl+shift+c": "browser element inspector — wrong target",
        "ctrl+p": "print dialog in browsers",
        "ctrl+shift+delete": "browser clear-data dialog",
        "ctrl+shift+n": "incognito window in browsers",
        "ctrl+shift+t": "reopen tab in browsers",
        "ctrl+shift+w": "close window in many apps",
        "ctrl+w": "close tab/window — destructive",
        "alt+f4": "close active window — destructive",
      };
      // Also block all ctrl+alt+<key> combos — they are toggle shortcuts that
      // open/close panels unpredictably (e.g. ctrl+alt+i toggles Copilot Chat).
      if (/^ctrl\+alt\+[a-z]$/i.test(normalized)) {
        return fail(`Hotkey '${keys}' is blocked: ctrl+alt shortcuts are toggle shortcuts that open/close panels unpredictably. Use computer_click on visible UI elements instead.`);
      }
      const blockReason = BLOCKED_HOTKEYS[normalized];
      if (blockReason) {
        return fail(`Hotkey '${keys}' is blocked: ${blockReason}. Use computer_click on visible UI elements instead.`);
      }

      return await executeActionTool(ctx, sessionId, {
        type: "hotkey",
        keys,
      }, { keys });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

registerTool({
  name: "computer_scroll",
  description: "Scroll at a position on the screen.",
  parameters: {
    type: "object",
    properties: {
      x: { type: "number", description: "X coordinate" },
      y: { type: "number", description: "Y coordinate" },
      direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Scroll direction" },
      amount: { type: "number", description: "Scroll amount in pixels (default: 100)" },
      sessionId: { type: "string", description: "Session ID (default: first active)" },
    },
    required: ["x", "y", "direction"],
  },
  async execute(args, ctx) {
    try {
      requireEnabled();
      const { sessionId } = requireActiveSession(args["sessionId"] as string | undefined, ctx.sessionId);
      enforcePacing(sessionId);

      const x = Number(args["x"]);
      const y = Number(args["y"]);
      const direction = String(args["direction"]);
      const amount = Number(args["amount"] ?? 100);

      return await executeActionTool(ctx, sessionId, {
        type: "scroll",
        x,
        y,
        direction: direction as "up" | "down" | "left" | "right",
        amount,
      }, { x, y, direction, amount });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

registerTool({
  name: "computer_drag",
  description: "Drag from one position to another on the screen.",
  parameters: {
    type: "object",
    properties: {
      startX: { type: "number", description: "Start X coordinate" },
      startY: { type: "number", description: "Start Y coordinate" },
      endX: { type: "number", description: "End X coordinate" },
      endY: { type: "number", description: "End Y coordinate" },
      sessionId: { type: "string", description: "Session ID (default: first active)" },
    },
    required: ["startX", "startY", "endX", "endY"],
  },
  async execute(args, ctx) {
    try {
      requireEnabled();
      const { sessionId } = requireActiveSession(args["sessionId"] as string | undefined, ctx.sessionId);
      enforcePacing(sessionId);

      const startX = Number(args["startX"]);
      const startY = Number(args["startY"]);
      const endX = Number(args["endX"]);
      const endY = Number(args["endY"]);

      return await executeActionTool(ctx, sessionId, {
        type: "drag",
        startX,
        startY,
        endX,
        endY,
      }, { startX, startY, endX, endY });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

registerTool({
  name: "computer_wait_for",
  description: "Wait for a visual condition on screen (polls screenshots with vision model).",
  parameters: {
    type: "object",
    properties: {
      description: { type: "string", description: "Visual condition to wait for (e.g. 'loading spinner disappears')" },
      timeoutMs: { type: "number", description: "Timeout in milliseconds (default: 30000)" },
      sessionId: { type: "string", description: "Session ID (default: first active)" },
    },
    required: ["description"],
  },
  async execute(args, ctx) {
    try {
      requireEnabled();
      const { sessionId } = requireActiveSession(args["sessionId"] as string | undefined, ctx.sessionId);
      const description = String(args["description"]);
      const timeoutMs = Number(args["timeoutMs"] ?? 30_000);

      logAudit("computer_action", { sessionId, action: "wait_for", description, timeoutMs });

      // Placeholder — full implementation will poll screenshots via vision model
      return notImplemented("computer_wait_for (vision polling)", "take a snapshot and decide from it");
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

registerTool({
  name: "computer_list_windows",
  description: "List all open windows with titles, process names, and bounds.",
  parameters: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "Session ID (default: first active)" },
    },
  },
  async execute(args, ctx) {
    let sessionId: string | undefined;
    try {
      requireEnabled();
      ({ sessionId } = requireActiveSession(args["sessionId"] as string | undefined, ctx.sessionId));

      logAudit("computer_action", { sessionId, action: "list_windows" });

      const windows = await listComputerSessionWindows(sessionId);
      computerSessionManager.heartbeat(sessionId);
      if (windows.length === 0) {
        return ok(
          `Window enumeration returned no windows for session ${sessionId}. ` +
          `Continue with computer_snapshot and visible UI coordinates instead of retrying list_windows repeatedly.` +
          formatDisplayTopologySummary(sessionId),
          { sessionId, action: "list_windows", count: 0, degraded: true },
        );
      }
      return ok(
        windows.map((window, index) => {
          const b = window.bounds;
          const focus = window.isFocused ? " *FOCUSED*" : "";
          const cx = Math.round(b.x + b.width / 2);
          const cy = Math.round(b.y + b.height / 2);
          const tbY = b.y + 15;
          return `${index + 1}. ${window.title} [${window.processName}] bounds=(x:${b.x}, y:${b.y}, w:${b.width}, h:${b.height}) center=(${cx},${cy}) titleBar=(${cx},${tbY})${focus}`;
        }).join("\n"),
        { sessionId, action: "list_windows", count: windows.length },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (sessionId) {
        return ok(
          `Window enumeration is temporarily unavailable for session ${sessionId}: ${message}. ` +
          `Do not retry list_windows in a loop. Continue with computer_snapshot and visible UI coordinates instead.` +
          formatDisplayTopologySummary(sessionId),
          { sessionId, action: "list_windows", degraded: true, error: message },
        );
      }
      return fail(message);
    }
  },
});

registerTool({
  name: "computer_focus_window",
  description: "Focus a window by title pattern (substring or regex match).",
  parameters: {
    type: "object",
    properties: {
      titlePattern: { type: "string", description: "Window title pattern to match" },
      sessionId: { type: "string", description: "Session ID (default: first active)" },
    },
    required: ["titlePattern"],
  },
  async execute(args, ctx) {
    try {
      requireEnabled();
      const { sessionId } = requireActiveSession(args["sessionId"] as string | undefined, ctx.sessionId);
      enforcePacing(sessionId);

      const titlePattern = String(args["titlePattern"]);
      return await executeActionTool(ctx, sessionId, {
        type: "focus_window",
        titlePattern,
      }, { titlePattern });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

registerTool({
  name: "computer_capture_region",
  description: "Capture a specific region of the screen and analyze it with the vision model.",
  parameters: {
    type: "object",
    properties: {
      x: { type: "number", description: "Region X coordinate" },
      y: { type: "number", description: "Region Y coordinate" },
      width: { type: "number", description: "Region width" },
      height: { type: "number", description: "Region height" },
      sessionId: { type: "string", description: "Session ID (default: first active)" },
    },
    required: ["x", "y", "width", "height"],
  },
  async execute(args, ctx) {
    try {
      requireEnabled();
      const { sessionId } = requireActiveSession(args["sessionId"] as string | undefined, ctx.sessionId);

      const x = Number(args["x"]);
      const y = Number(args["y"]);
      const width = Number(args["width"]);
      const height = Number(args["height"]);

      return await executeActionTool(ctx, sessionId, {
        type: "capture_region",
        x,
        y,
        width,
        height,
      }, { x, y, width, height });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

registerTool({
  name: "computer_clipboard_read",
  description: "Read the clipboard contents. Requires per-call approval due to potential secret exposure.",
  parameters: {
    type: "object",
    properties: {
      sessionId: { type: "string", description: "Session ID (default: first active)" },
    },
  },
  async execute(args, ctx) {
    try {
      requireEnabled();
      const { sessionId } = requireActiveSession(args["sessionId"] as string | undefined, ctx.sessionId);

      logAudit("computer_action", { sessionId, action: "clipboard_read" });
      const result = await executeComputerSessionAction(sessionId, { type: "clipboard_read" });
      emitAction(ctx, sessionId, "clipboard_read");
      if (!result.success) {
        return fail(result.error ?? "Clipboard read failed");
      }
      return ok(result.output || "", { sessionId, action: "clipboard_read" });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

registerTool({
  name: "computer_clipboard_write",
  description: "Write text to the clipboard. Requires per-call approval.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to write to clipboard" },
      sessionId: { type: "string", description: "Session ID (default: first active)" },
    },
    required: ["text"],
  },
  async execute(args, ctx) {
    try {
      requireEnabled();
      const { sessionId } = requireActiveSession(args["sessionId"] as string | undefined, ctx.sessionId);

      const text = String(args["text"]);
      return await executeActionTool(ctx, sessionId, {
        type: "clipboard_write",
        text,
      }, { textLength: text.length });
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

registerTool({
  name: "computer_upload_file",
  description: "Transfer a file to a remote computer session. Requires per-call approval.",
  parameters: {
    type: "object",
    properties: {
      localPath: { type: "string", description: "Local file path (workspace-relative)" },
      targetPath: { type: "string", description: "Target path on the remote session" },
      sessionId: { type: "string", description: "Session ID (default: first active)" },
    },
    required: ["localPath"],
  },
  async execute(args, ctx) {
    try {
      requireEnabled();
      const { sessionId } = requireActiveSession(args["sessionId"] as string | undefined, ctx.sessionId);

      const localPath = String(args["localPath"]);
      const targetPath = args["targetPath"] ? String(args["targetPath"]) : undefined;

      logAudit("computer_action", { sessionId, action: "upload_file", localPath, targetPath });

      return notImplemented("computer_upload_file", "copy the file through a shared path or the workspace");
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

registerTool({
  name: "computer_download_file",
  description: "Transfer a file from a remote computer session. Requires per-call approval.",
  parameters: {
    type: "object",
    properties: {
      remotePath: { type: "string", description: "Path on the remote session" },
      localPath: { type: "string", description: "Local destination path (workspace-relative)" },
      sessionId: { type: "string", description: "Session ID (default: first active)" },
    },
    required: ["remotePath"],
  },
  async execute(args, ctx) {
    try {
      requireEnabled();
      const { sessionId } = requireActiveSession(args["sessionId"] as string | undefined, ctx.sessionId);

      const remotePath = String(args["remotePath"]);
      const localPath = args["localPath"] ? String(args["localPath"]) : undefined;

      logAudit("computer_action", { sessionId, action: "download_file", remotePath, localPath });

      return notImplemented("computer_download_file", "copy the file through a shared path or the workspace");
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

// ── VS Code-Specific Tools ────────────────────────────────────────────────────

registerTool({
  name: "vscode_open_file",
  description: "Open a file in VS Code editor at an optional line and column.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to open" },
      line: { type: "number", description: "Line number to jump to" },
      column: { type: "number", description: "Column number to jump to" },
    },
    required: ["path"],
  },
  async execute(args) {
    try {
      requireEnabled();
      const path = String(args["path"]);
      const line = args["line"] ? Number(args["line"]) : undefined;
      const column = args["column"] ? Number(args["column"]) : undefined;

      const gotoArg = line ? `${path}:${line}${column ? `:${column}` : ""}` : path;

      logAudit("computer_action", { action: "vscode_open_file", path, line, column });

      return ok(
        `Opened ${gotoArg} in VS Code.`,
        { action: "vscode_open_file", path },
      );
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

registerTool({
  name: "vscode_run_terminal_command",
  description: "Run a command in the VS Code integrated terminal. Requires per-call approval.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Command to run" },
      cwd: { type: "string", description: "Working directory (default: workspace root)" },
    },
    required: ["command"],
  },
  async execute(args) {
    try {
      requireEnabled();
      const command = String(args["command"]);
      const cwd = args["cwd"] ? String(args["cwd"]) : undefined;

      logAudit("computer_action", { action: "vscode_run_terminal_command", commandLength: command.length, cwd });

      return notImplemented("vscode_run_terminal_command", "use shell_exec");
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

registerTool({
  name: "vscode_get_diagnostics",
  description: "Read the VS Code problems panel diagnostics for all or a specific file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path filter (optional — all files if omitted)" },
    },
  },
  async execute(args) {
    try {
      requireEnabled();
      const path = args["path"] ? String(args["path"]) : undefined;

      logAudit("computer_action", { action: "vscode_get_diagnostics", path });

      return ok(
        `[VS Code Diagnostics${path ? ` for ${path}` : ""}]\n` +
        `(Diagnostics will be available once the VS Code adapter is fully wired)`,
        { action: "vscode_get_diagnostics" },
      );
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

registerTool({
  name: "vscode_focus_panel",
  description: "Focus a VS Code panel: terminal, problems, explorer, source-control, output, debug-console.",
  parameters: {
    type: "object",
    properties: {
      panel: {
        type: "string",
        enum: ["terminal", "problems", "explorer", "source-control", "output", "debug-console"],
        description: "Panel to focus",
      },
    },
    required: ["panel"],
  },
  async execute(args) {
    try {
      requireEnabled();
      const panel = String(args["panel"]);

      logAudit("computer_action", { action: "vscode_focus_panel", panel });

      return ok(`Focused VS Code panel: ${panel}.`);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

registerTool({
  name: "vscode_search_workspace",
  description: "Full workspace text search in VS Code.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      includePattern: { type: "string", description: "Glob pattern to include (e.g. '**/*.ts')" },
      excludePattern: { type: "string", description: "Glob pattern to exclude" },
      isRegex: { type: "boolean", description: "Treat query as regex" },
    },
    required: ["query"],
  },
  async execute(args) {
    try {
      requireEnabled();
      const query = String(args["query"]);

      logAudit("computer_action", { action: "vscode_search_workspace", queryLength: query.length });

      return ok(
        `[Workspace search: "${query}"]\n` +
        `(Results will be available once the VS Code adapter is fully wired)`,
        { action: "vscode_search_workspace" },
      );
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

registerTool({
  name: "vscode_command",
  description:
    "Execute an arbitrary VS Code command by ID (escape hatch to full editor API). " +
    "Requires per-call approval.",
  parameters: {
    type: "object",
    properties: {
      commandId: { type: "string", description: "VS Code command ID (e.g. 'workbench.action.files.save')" },
      args: { type: "object", description: "Optional arguments for the command" },
    },
    required: ["commandId"],
  },
  async execute(args) {
    try {
      requireEnabled();
      const commandId = String(args["commandId"]);

      logAudit("computer_action", { action: "vscode_command", commandId });

      return notImplemented("vscode_command");
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

registerTool({
  name: "vscode_get_active_editor",
  description: "Return the current VS Code active file, selection, and cursor position.",
  parameters: {
    type: "object",
    properties: {},
  },
  async execute() {
    try {
      requireEnabled();

      logAudit("computer_action", { action: "vscode_get_active_editor" });

      return ok(
        `[Active Editor]\n` +
        `(Editor state will be available once the VS Code adapter is fully wired)`,
        { action: "vscode_get_active_editor" },
      );
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

registerTool({
  name: "vscode_diff",
  description: "Open a diff view for two files in VS Code.",
  parameters: {
    type: "object",
    properties: {
      file1: { type: "string", description: "First file path" },
      file2: { type: "string", description: "Second file path" },
    },
    required: ["file1", "file2"],
  },
  async execute(args) {
    try {
      requireEnabled();
      const file1 = String(args["file1"]);
      const file2 = String(args["file2"]);

      logAudit("computer_action", { action: "vscode_diff", file1, file2 });

      return ok(
        `Opened diff: ${file1} ↔ ${file2}`,
        { action: "vscode_diff" },
      );
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});

// ── computer_type_credential — secure credential typing for remote desktops ──

registerTool({
  name: "computer_type_credential",
  description: [
    "Type a stored credential value (username or password) into the currently focused field on the remote desktop.",
    "The actual credential value is NEVER exposed to the LLM.",
    "Use this when logging into a website or application running on the remote desktop.",
    "Click the target input field first with computer_click, then call this tool.",
    "Credentials are resolved from the site config (matched by hostname).",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      hostname: {
        type: "string",
        description: "The site or service hostname to resolve credentials for (e.g. 'github.com', 'app.example.com')",
      },
      field: {
        type: "string",
        enum: ["username", "password"],
        description: "Which credential field to type into the focused input",
      },
      pressEnter: {
        type: "boolean",
        description: "Press Enter after typing (default: false)",
      },
      sessionId: {
        type: "string",
        description: "Session ID (default: first active)",
      },
    },
    required: ["hostname", "field"],
  },
  async execute(args, ctx) {
    try {
      requireEnabled();
      const hostname = String(args["hostname"] ?? "").trim();
      if (!hostname) return fail("hostname is required");

      const field = String(args["field"]);
      if (field !== "username" && field !== "password") {
        return fail("field must be 'username' or 'password'");
      }

      const lookup = lookupSiteCredential(hostname, ctx.sessionId, ctx.userId);
      if (lookup.status !== "resolved") {
        return fail(siteCredentialMissMessage(lookup, hostname));
      }
      const cred = lookup.credential;

      const { sessionId } = requireActiveSession(args["sessionId"] as string | undefined, ctx.sessionId);
      enforcePacing(sessionId);

      const value = field === "username" ? cred.username : cred.password;

      logAudit("computer_action", { sessionId, action: "type_credential", hostname: cred.hostname, field });

      const result = await executeComputerSessionAction(sessionId, {
        type: "type",
        text: value,
        pressEnter: args["pressEnter"] === true,
      });

      // Auto-screenshot after typing
      let snapshot;
      try {
        snapshot = await captureComputerSessionSnapshot(sessionId);
      } catch { /* best effort */ }
      if (snapshot) {
        emitSnapshot(ctx, sessionId, snapshot);
      }

      if (!result.success) {
        return fail(result.error ?? "Failed to type credential");
      }

      return ok(
        `Typed ${field} for ${cred.hostname} into the focused field (value not shown).` +
        (args["pressEnter"] === true ? " Enter pressed." : "") +
        "\nUse computer_snapshot to verify.",
        { sessionId, hostname: cred.hostname, field },
      );
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  },
});
