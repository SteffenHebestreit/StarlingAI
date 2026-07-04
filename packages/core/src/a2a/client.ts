/**
 * A2A client — pulls each configured peer's agent card and registers every
 * exposed skill as a *virtual* sub-agent in the StarlingAI runtime.
 *
 * Naming convention: `a2a__<peerId>__<skillId>`.  The orchestrator can
 * delegate to these the same way it delegates to any local sub-agent
 * (`delegate_to_agent`, `swarm_delegate`, scene allowedAgents, …).  At
 * call time the inline-config runtime translates the delegation into an
 * A2A `tasks/send` JSON-RPC against the peer.
 *
 * Refresh cadence: peers are polled at startup and on `a2a.refreshIntervalMs`
 * (default 15 min).  Disconnected peers stay registered with stale skill
 * lists — the next refresh will reconcile.  Removed peers are unregistered.
 */
import { randomUUID } from "node:crypto";

import { getConfig } from "../config/loader.js";
import type { SubAgentConfig } from "../config/schema.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { isSafePeerUrl } from "../federation/index.js";
import {
  A2A_PROTOCOL_VERSION,
  type A2AAgentCard,
  type A2AAgentSkill,
  type A2AJsonRpcResponse,
  type A2ATask,
} from "./protocol.js";

const log = childLogger("a2a:client");

/** Agent cards / task results are KBs; cap responses so a hostile peer can't OOM us. */
const A2A_MAX_BODY_BYTES = 8 * 1024 * 1024;

/** Refuse to fetch a peer URL that isn't an http(s) public host (SSRF / metadata guard). */
function assertSafeA2AUrl(rawUrl: string): void {
  if (!isSafePeerUrl(rawUrl, false)) {
    throw new Error(`A2A URL is not an allowed http(s) public endpoint: ${rawUrl}`);
  }
}

/** Parsed URL origin, or null when unparseable. */
function safeOrigin(rawUrl: string): string | null {
  try { return new URL(rawUrl).origin; } catch { return null; }
}

/** Read a JSON response with a hard byte cap so a peer can't exhaust memory. */
async function readJsonCapped<T>(res: Response, maxBytes = A2A_MAX_BODY_BYTES): Promise<T> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`A2A response body too large (Content-Length ${declared} > ${maxBytes})`);
  }
  const reader = res.body?.getReader();
  if (!reader) {
    const txt = await res.text();
    if (txt.length > maxBytes) throw new Error(`A2A response body too large (${txt.length} > ${maxBytes})`);
    return JSON.parse(txt) as T;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`A2A response body exceeded ${maxBytes} bytes; aborting`);
      }
      chunks.push(value);
    }
  }
  return JSON.parse(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8")) as T;
}

interface RegisteredPeer {
  id: string;
  url: string;
  description?: string;
  card?: A2AAgentCard;
  skills: A2AAgentSkill[];
  lastPolledAt: string;
  lastError?: string;
  /** Virtual sub-agent names registered for this peer. */
  virtualAgents: string[];
}

const _peers = new Map<string, RegisteredPeer>();
let _refreshTimer: ReturnType<typeof setInterval> | null = null;

const A2A_AGENT_PREFIX = "a2a__";

/** Public dashboard accessor — current state of every registered peer. */
export function listA2APeers(): RegisteredPeer[] {
  return [..._peers.values()];
}

export async function startA2AClient(): Promise<void> {
  stopA2AClient(); // clear any prior refresh timer so repeated calls don't leak intervals
  const config = getConfig();
  if (!config.a2a.enabled) return;

  await refreshAllPeers();

  if (config.a2a.refreshIntervalMs > 0) {
    _refreshTimer = setInterval(() => {
      void refreshAllPeers().catch((err) => log.warn({ err }, "A2A refresh threw"));
    }, config.a2a.refreshIntervalMs);
    _refreshTimer.unref();
  }
}

export function stopA2AClient(): void {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
}

async function refreshAllPeers(): Promise<void> {
  const config = getConfig();
  const desiredPeers = config.a2a.peers.filter((p) => p.enabled);
  const desiredIds = new Set(desiredPeers.map((p) => p.id));

  // Drop peers that disappeared from config
  for (const id of [..._peers.keys()]) {
    if (!desiredIds.has(id)) {
      unregisterPeer(id);
    }
  }

  await Promise.allSettled(desiredPeers.map((peer) => refreshPeer(peer.id, peer.url, peer.bearerToken, peer.description)));
}

async function refreshPeer(
  id: string,
  url: string,
  bearerToken: string | undefined,
  description: string | undefined,
): Promise<void> {
  const cardUrl = `${url.replace(/\/$/, "")}/.well-known/agent-card.json`;
  let card: A2AAgentCard | null = null;
  let lastError: string | undefined;

  try {
    assertSafeA2AUrl(cardUrl);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (bearerToken) headers["Authorization"] = `Bearer ${resolveSecret(bearerToken)}`;
    const res = await fetch(cardUrl, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      lastError = `HTTP ${res.status}`;
    } else {
      card = await readJsonCapped<A2AAgentCard>(res);
      if (card.protocolVersion && card.protocolVersion !== A2A_PROTOCOL_VERSION) {
        log.warn(
          { peer: id, expected: A2A_PROTOCOL_VERSION, got: card.protocolVersion },
          "A2A peer reports a different protocol version; proceeding optimistically",
        );
      }
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err);
  }

  const previous = _peers.get(id);
  const previousAgentNames = new Set(previous?.virtualAgents ?? []);
  const skills = card?.skills ?? [];

  // The RPC endpoint the BEARER TOKEN gets sent to. The admin-configured `url` is
  // trusted; the peer-advertised `card.url` is not — only honor it when it's a safe
  // public host AND same-origin as the configured peer, so a compromised peer can't
  // redirect our credential to an attacker/internal host.
  const derivedEndpoint = `${url.replace(/\/$/, "")}/a2a/v1`;
  let rpcEndpoint = derivedEndpoint;
  if (card?.url) {
    const configuredOrigin = safeOrigin(url);
    const cardOrigin = safeOrigin(card.url);
    if (isSafePeerUrl(card.url, false) && configuredOrigin && cardOrigin === configuredOrigin) {
      rpcEndpoint = card.url;
    } else {
      log.warn({ peer: id, advertised: card.url }, "A2A: ignoring peer-advertised card.url (unsafe or cross-origin); using configured endpoint");
    }
  }

  const virtualAgents: string[] = [];
  if (card) {
    for (const skill of skills) {
      const name = `${A2A_AGENT_PREFIX}${id}__${skill.id}`;
      registerVirtualAgent(name, id, skill, rpcEndpoint, bearerToken);
      virtualAgents.push(name);
      previousAgentNames.delete(name);
    }
  }

  // Drop stale virtual agents that disappeared from the card
  for (const stale of previousAgentNames) {
    unregisterVirtualAgent(stale);
  }

  const record: RegisteredPeer = {
    id,
    url,
    description,
    skills,
    lastPolledAt: new Date().toISOString(),
    virtualAgents,
    ...(card ? { card } : {}),
    ...(lastError ? { lastError } : {}),
  };
  _peers.set(id, record);

  if (lastError) {
    logAudit("a2a_peer_unreachable", { peer: id, url, reason: lastError }, { severity: "warn" });
  } else if (!previous) {
    logAudit("a2a_peer_added", { peer: id, url, skills: skills.length });
  }
}

function unregisterPeer(id: string): void {
  const peer = _peers.get(id);
  if (!peer) return;
  for (const name of peer.virtualAgents) {
    unregisterVirtualAgent(name);
  }
  _peers.delete(id);
  logAudit("a2a_peer_removed", { peer: id });
}

// ─── Virtual sub-agent registration ──────────────────────────────────────────

/**
 * The StarlingAI runtime resolves a sub-agent definition out of
 * `config.subAgents[name]`.  Plain config-file edits aren't an option from a
 * runtime client, so we patch a per-process overlay onto the loaded config
 * here — `runSubAgentWithStats` will see the virtual agent and route to it
 * via the `inlineConfig` field on the run options.
 *
 * The runtime call path goes through {@link runSubAgentInline} in
 * `agent/sub-agent.ts` if `inlineConfig` is set.  For our virtual agents we
 * intercept at the registry level: we register the virtual agent as a tool
 * named `a2a__<peer>__<skill>` that the orchestrator can call directly,
 * AND we attach the inline config so `delegate_to_agent` discovers it.
 */
import { registerTool, unregisterTool } from "../tools/registry.js";

function registerVirtualAgent(
  name: string,
  peerId: string,
  skill: A2AAgentSkill,
  rpcUrl: string,
  bearerToken: string | undefined,
): void {
  // 1. Register a tool that the orchestrator can call directly.
  try {
    registerTool({
      name,
      description:
        `[A2A:${peerId}] ${skill.description || `Delegate to remote skill ${skill.id}.`}`,
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "Task description to delegate." },
          context: { type: "string", description: "Optional supporting context." },
        },
        required: ["task"],
      },
      async execute(args) {
        const task = String(args["task"] ?? "");
        const context = typeof args["context"] === "string" ? (args["context"] as string) : undefined;
        if (!task.trim()) {
          return { success: false, output: "", error: "task is required" };
        }
        try {
          const result = await sendA2ATask(rpcUrl, bearerToken, skill.id, task, context);
          return { success: true, output: result, metadata: { peerId, skillId: skill.id } };
        } catch (err) {
          return { success: false, output: "", error: `A2A delegation failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      },
    });
  } catch (err) {
    log.warn({ err, name }, "Could not register A2A virtual tool — name may collide with a built-in");
    return;
  }

  // 2. Inject the virtual sub-agent into config.subAgents so the orchestrator
  // can also reach it via `delegate_to_agent`.  The config object loaded by
  // `getConfig()` is mutable in process; runtime additions don't persist to
  // disk (and shouldn't, since they're discovered live).
  const inlineConfig = buildVirtualAgentConfig(name, peerId, skill);
  const config = getConfig();
  (config.subAgents as Record<string, SubAgentConfig>)[name] = inlineConfig;
}

function unregisterVirtualAgent(name: string): void {
  try { unregisterTool(name); } catch { /* ignore */ }
  const config = getConfig();
  delete (config.subAgents as Record<string, SubAgentConfig>)[name];
}

function buildVirtualAgentConfig(
  name: string,
  peerId: string,
  skill: A2AAgentSkill,
): SubAgentConfig {
  // The inline config is intentionally minimal: the runtime will short-
  // circuit through the `a2a__*` tool path, not the LLM loop.  But the
  // orchestrator catalog needs the fields populated so search_agents +
  // routing don't filter the entry out.
  return {
    description: `[A2A:${peerId}] ${skill.description || skill.name}`,
    capabilities: skill.tags ?? [],
    tags: ["a2a", `peer:${peerId}`, ...(skill.tags ?? [])],
    domain: "a2a",
    role: "specialist",
    systemPrompt: `Virtual agent bridged from A2A peer "${peerId}" skill "${skill.id}".  Calls translate to A2A tasks/send.`,
    tools: [name],
    maxIterations: 1,
  } as unknown as SubAgentConfig;
}

async function sendA2ATask(
  rpcUrl: string,
  bearerToken: string | undefined,
  skillId: string,
  task: string,
  context: string | undefined,
): Promise<string> {
  const config = getConfig();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bearerToken) headers["Authorization"] = `Bearer ${resolveSecret(bearerToken)}`;

  const payload = {
    jsonrpc: "2.0",
    method: "tasks/send",
    id: randomUUID(),
    params: {
      id: randomUUID(),
      sessionId: `a2a-out:${randomUUID()}`,
      agentId: skillId,
      message: { role: "user", parts: [{ type: "text", text: task }] },
      ...(context ? { metadata: { context } } : {}),
    },
  };

  assertSafeA2AUrl(rpcUrl);
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(config.a2a.taskTimeoutMs),
  });
  if (!res.ok) {
    throw new Error(`A2A peer returned HTTP ${res.status}`);
  }

  const body = await readJsonCapped<A2AJsonRpcResponse<A2ATask>>(res);
  if (body.error) {
    throw new Error(`${body.error.code} ${body.error.message}`);
  }
  const result = body.result;
  if (!result) throw new Error("A2A peer returned no result");
  if (result.status?.state === "failed") {
    const reason = result.status.message?.parts?.[0]?.text ?? "unknown failure";
    throw new Error(reason);
  }
  // Guard a peer that omits `parts` (or parts lacking `text`) — otherwise a missing
  // field throws a TypeError surfaced as a bare "A2A delegation failed".
  const text = result.artifacts
    ?.flatMap((m) => (m.parts ?? []).map((p) => p?.text ?? ""))
    .filter(Boolean)
    .join("\n");
  return text ?? "";
}

function resolveSecret(value: string): string {
  if (value.startsWith("$")) return process.env[value.slice(1)] ?? "";
  return value;
}
