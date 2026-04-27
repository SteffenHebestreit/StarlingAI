/**
 * Federation tools (Stage 11) — give the orchestrator the ability to discover
 * peer instances and delegate tasks across the federation.
 *
 *   list_federation_peers     — Tier 0, returns the configured peer list with
 *                               cached capability snapshots and recent ping
 *                               results.  Use this before delegating to know
 *                               which agents each peer exposes.
 *   delegate_to_remote_agent  — Tier 2, ships a task to a peer's named agent
 *                               and returns the synthesized output.  The peer
 *                               enforces ITS OWN tier policy; this side just
 *                               routes the request.
 *
 * Both refuse to execute unless `federation.enabled` is true and a shared
 * secret is configured, regardless of tier.
 */
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { getConfig } from "../config/loader.js";
import {
  broadcastWorkspaceSearch,
  delegateToRemotePeer,
  delegateToRemotePeerStreaming,
  fetchPeerCapability,
  pingPeer,
  getFederationConfig,
  type FederationStreamProgress,
} from "../federation/index.js";
import { searchWorkspace } from "./workspace-search.js";

function ensureFederationReady(): string | null {
  const config = getFederationConfig();
  if (!config.enabled) return "Federation is disabled (set federation.enabled = true in starlingai.json)";
  if (!config.sharedSecret || config.sharedSecret.length < 32) {
    return "Federation requires federation.sharedSecret (≥32 chars) to be configured";
  }
  return null;
}

registerTool({
  name: "list_federation_peers",
  description: "List configured federation peer instances with their cached capability snapshots (agents + advertised tools) and current reachability. Use this BEFORE delegate_to_remote_agent to pick the right peer and confirm the agent you want exists there.",
  embeddingDescription: "list federation peers; show federated swarms; what other StarlingAI instances are available; cross-instance peer registry",
  costHint: "low",
  latencyHint: "low",
  parameters: {
    type: "object",
    properties: {
      ping: {
        type: "boolean",
        description: "When true, perform a live health probe against each peer. Default false (uses cached capabilities only).",
      },
      refreshCapabilities: {
        type: "boolean",
        description: "When true, bypass the capability cache and re-fetch each peer's agent + tool surface. Default false.",
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const blocker = ensureFederationReady();
    if (blocker) return { success: false, output: "", error: blocker };

    const ping = Boolean(args["ping"]);
    const refresh = Boolean(args["refreshCapabilities"]);
    const config = getConfig().federation;

    if (config.peers.length === 0) {
      return {
        success: true,
        output: "No federation peers configured. Add entries to federation.peers in starlingai.json.",
        metadata: { peers: [] },
      };
    }

    const results = await Promise.all(config.peers.map(async (peer) => {
      const summary: Record<string, unknown> = {
        id: peer.id,
        url: peer.url,
        description: peer.description ?? null,
        tags: peer.tags,
      };
      try {
        const capability = await fetchPeerCapability(peer.id, { force: refresh });
        summary["instanceId"] = capability.instanceId;
        summary["protocolVersion"] = capability.protocolVersion;
        summary["agents"] = capability.agents.map((a) => ({ name: a.name, description: a.description, tags: a.tags }));
        summary["advertisedToolCount"] = capability.toolNames.length;
        summary["capabilitiesFetchedAt"] = capability.generatedAt;
      } catch (err) {
        summary["capabilityError"] = (err as Error).message;
      }
      if (ping) {
        const probe = await pingPeer(peer.id);
        summary["ping"] = probe;
      }
      return summary;
    }));

    const lines = results.map((r) => {
      const tag = r["instanceId"] ? `${r["id"]} → ${r["instanceId"]}` : `${r["id"]} (UNREACHABLE)`;
      const agentList = Array.isArray(r["agents"])
        ? `${(r["agents"] as { name: string }[]).length} agents`
        : "no agents";
      const ping = r["ping"] && typeof r["ping"] === "object"
        ? ` · ping ${(r["ping"] as { ok: boolean; latencyMs: number }).ok ? "ok" : "fail"} ${(r["ping"] as { latencyMs: number }).latencyMs}ms`
        : "";
      return `- ${tag} · ${agentList}${ping}`;
    });

    return {
      success: true,
      output: `Federation peers (${results.length}):\n${lines.join("\n")}`,
      metadata: { peers: results },
    };
  },
});

registerTool({
  name: "delegate_to_remote_agent",
  description: "Delegate a task to a sub-agent on a REMOTE federated StarlingAI instance. Use this when the local swarm lacks a needed specialist but a peer instance has it. The remote instance enforces its own tool tiers and approval policies. Always call list_federation_peers first to confirm the agent name exists on the chosen peer.",
  embeddingDescription: "federated delegation; delegate to remote swarm; cross-instance handoff; ship task to peer StarlingAI; multi-instance coordination",
  costHint: "high",
  latencyHint: "high",
  parameters: {
    type: "object",
    properties: {
      peerId: {
        type: "string",
        description: "ID of the federation peer (matches federation.peers[].id in starlingai.json).",
      },
      agentName: {
        type: "string",
        description: "Name of the sub-agent on the remote peer to invoke (must be in that peer's exposed agent list).",
      },
      task: {
        type: "string",
        description: "Task or question for the remote sub-agent. Write this as a self-contained assignment — the peer has no access to your local context.",
      },
      context: {
        type: "string",
        description: "Optional background context to pass alongside the task. The peer treats this as opaque text.",
      },
      timeoutMs: {
        type: "number",
        description: "Optional hard cap on the remote delegation in ms. Bounded by the peer's federation.delegationTimeoutMs.",
      },
      stream: {
        type: "boolean",
        description: "When true, consume Server-Sent Events from the peer so the orchestrator surfaces live tool-call progress in the UI. Default true. Set false to fall back to a one-shot await.",
      },
    },
    required: ["peerId", "agentName", "task"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const blocker = ensureFederationReady();
    if (blocker) return { success: false, output: "", error: blocker };

    const peerId = String(args["peerId"] ?? "").trim();
    const agentName = String(args["agentName"] ?? "").trim();
    const task = String(args["task"] ?? "").trim();
    const context = typeof args["context"] === "string" ? (args["context"] as string) : undefined;
    const timeoutMs = typeof args["timeoutMs"] === "number" && args["timeoutMs"] > 0
      ? (args["timeoutMs"] as number)
      : undefined;
    // Default to streaming so federated calls render live progress like local
    // delegations.  Callers can opt out by passing stream=false.
    const useStream = args["stream"] !== false;

    if (!peerId || !agentName || !task) {
      return { success: false, output: "", error: "peerId, agentName, and task are required" };
    }

    const request = { agentName, task, context, timeoutMs, originSessionId: ctx.sessionId };
    const response = useStream
      ? await delegateToRemotePeerStreaming(peerId, request, (event: FederationStreamProgress) => {
          ctx.onSubAgentProgress?.({
            agentName: `${peerId}/${event.agentName}`,
            kind: event.kind as "started" | "thinking" | "tool_start" | "tool_done" | "completed",
            iteration: event.iteration,
            toolName: event.toolName,
            summary: event.summary,
            metadata: { federated: true, peerId },
          });
        })
      : await delegateToRemotePeer(peerId, request);

    if (!response.ok) {
      return {
        success: false,
        output: "",
        error: response.error ?? "remote delegation failed",
        metadata: { peerId, agentName, remoteSessionId: response.remoteSessionId ?? null },
      };
    }

    return {
      success: true,
      output: response.output ?? "",
      metadata: {
        source: `federated:${peerId}:${response.remoteSessionId ?? "unknown"}`,
        peerId,
        agentName,
        remoteSessionId: response.remoteSessionId ?? null,
        stats: response.stats ?? null,
      },
    };
  },
});

registerTool({
  name: "federated_workspace_search",
  description: "Run workspace_search across the local instance AND federated peers in parallel, then return merged matches grouped by source. Use this when the answer might live in a peer's workspace rather than your own. Returns local matches even when federation is disabled.",
  embeddingDescription: "federated retrieval; cross-instance workspace search; broadcast keyword search; multi-instance grep; find code across StarlingAI peers",
  costHint: "medium",
  latencyHint: "medium",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search term — matched case-insensitively across all workspace text files on each peer.",
      },
      maxResults: {
        type: "number",
        description: "Maximum number of matching files PER peer (default 10, max 30).",
      },
      peerIds: {
        type: "array",
        items: { type: "string" },
        description: "Optional subset of peer ids to broadcast to. Empty/omitted = all configured peers.",
      },
      includeLocal: {
        type: "boolean",
        description: "When true (default), include local workspace matches alongside peer results so you can compare. Set false to query peers only.",
      },
    },
    required: ["query"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = String(args["query"] ?? "").trim();
    if (!query) return { success: false, output: "", error: "query is required" };
    const requestedMax = Number(args["maxResults"] ?? 10) || 10;
    const maxResults = Math.min(30, Math.max(1, Math.floor(requestedMax)));
    const peerIds = Array.isArray(args["peerIds"]) ? args["peerIds"].map(String).filter(Boolean) : undefined;
    const includeLocal = args["includeLocal"] !== false;

    const sections: string[] = [];
    const allMatches: { source: string; file: string; snippets: string[] }[] = [];

    if (includeLocal) {
      const localMatches = searchWorkspace(ctx.workspacePath, query, maxResults);
      for (const m of localMatches) allMatches.push({ source: "local", file: m.file, snippets: m.snippets });
      if (localMatches.length > 0) {
        sections.push(`### local (${localMatches.length} match${localMatches.length === 1 ? "" : "es"})\n${formatMatches(localMatches.map((m) => ({ source: "local", file: m.file, snippets: m.snippets })))}`);
      }
    }

    const fedConfig = getFederationConfig();
    let peerSummary: string | null = null;
    if (fedConfig.enabled && fedConfig.sharedSecret && fedConfig.peers.length > 0) {
      const broadcast = await broadcastWorkspaceSearch(query, { maxResults, peerIds });
      for (const m of broadcast.matches) allMatches.push({ source: m.source, file: m.file, snippets: m.snippets });
      const peerLines = broadcast.peers.map((p) => {
        if (!p.ok) return `- ${p.peerId}: ⚠ ${p.error ?? "failed"}`;
        return `- ${p.peerId}${p.instanceId ? ` → ${p.instanceId}` : ""}: ${p.matched} match${p.matched === 1 ? "" : "es"} in ${p.durationMs ?? "?"}ms`;
      });
      peerSummary = peerLines.join("\n");
      const groupedByPeer = new Map<string, typeof broadcast.matches>();
      for (const m of broadcast.matches) {
        const arr = groupedByPeer.get(m.source) ?? [];
        arr.push(m);
        groupedByPeer.set(m.source, arr);
      }
      for (const [peer, peerMatches] of groupedByPeer) {
        sections.push(`### peer:${peer} (${peerMatches.length} match${peerMatches.length === 1 ? "" : "es"})\n${formatMatches(peerMatches)}`);
      }
    }

    if (allMatches.length === 0) {
      const reason = !fedConfig.enabled
        ? "(federation is disabled — only the local workspace was searched)"
        : fedConfig.peers.length === 0
          ? "(federation is enabled but no peers are configured)"
          : "";
      return {
        success: true,
        output: `No matches for "${query}". ${reason}`.trim(),
        metadata: { count: 0 },
      };
    }

    const header = `Found "${query}" in ${allMatches.length} location${allMatches.length === 1 ? "" : "s"} across ${peerSummary ? `local + ${fedConfig.peers.length} peer${fedConfig.peers.length === 1 ? "" : "s"}` : "local"}:`;
    const peerBlock = peerSummary ? `\n\n**Peer status:**\n${peerSummary}` : "";
    return {
      success: true,
      output: `${header}\n\n${sections.join("\n\n---\n\n")}${peerBlock}`,
      metadata: {
        count: allMatches.length,
        bySource: Object.fromEntries(
          [...new Set(allMatches.map((m) => m.source))].map((s) => [s, allMatches.filter((m) => m.source === s).length]),
        ),
      },
    };
  },
});

function formatMatches(matches: { source: string; file: string; snippets: string[] }[]): string {
  return matches
    .map((m) => `**${m.file}**\n${m.snippets.map((s) => "```\n" + s + "\n```").join("\n")}`)
    .join("\n\n");
}
