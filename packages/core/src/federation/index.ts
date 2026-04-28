/**
 * Federated swarms (Stage 11) — outbound + inbound delegation between
 * StarlingAI instances.
 *
 * Auth model: every federation request carries an HMAC-signed JWT (HS256)
 * over the shared secret configured on both sides.  Tokens are short-lived
 * (5 min) and scoped to a specific peer via the `aud` claim.  Each instance
 * keeps full control of its own tool tiers and human-in-loop policies —
 * federation cannot bypass local guardrails.  See ROADMAP.md → Stage 11.
 */
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { getConfig } from "../config/loader.js";
import type { FederationConfig, FederationPeerConfig } from "../config/schema.js";
import { childLogger } from "../logger.js";
import { logAudit, subscribeToAudit } from "../audit/logger.js";
import type { AuditEvent } from "../audit/schema.js";
import { withSpan, injectTraceContext } from "../observability/tracing.js";

const log = childLogger("federation");

const TOKEN_ALGORITHM = "HS256";
const TOKEN_TTL_SECONDS = 300; // 5 min — long enough for clock skew, short enough to limit replay
const FEDERATION_VERSION = "1.0";

export interface FederationCapability {
  instanceId: string;
  version: string;
  protocolVersion: string;
  agents: { name: string; description?: string; capabilities?: string[]; tags?: string[] }[];
  /** Tier-1 + Tier-2 tools the peer exposes via federated delegation.  Tier-3+ are NEVER advertised. */
  toolNames: string[];
  /** ISO timestamp of when the peer assembled this capability snapshot. */
  generatedAt: string;
}

export interface FederationDelegateRequest {
  agentName: string;
  task: string;
  context?: string;
  /** Optional originating session id, included in the peer's audit log for traceability. */
  originSessionId?: string;
  /** Hard cap honored by the peer.  Default = peer's federation.delegationTimeoutMs. */
  timeoutMs?: number;
}

export interface FederationDelegateResponse {
  ok: boolean;
  output?: string;
  error?: string;
  remoteSessionId?: string;
  /** Remote stats — token counts, tool calls, terminal state.  Best-effort. */
  stats?: Record<string, unknown>;
}

interface CapabilityCacheEntry {
  capability: FederationCapability;
  fetchedAt: number;
}

const _capabilityCache = new Map<string, CapabilityCacheEntry>();

/**
 * Bounded in-memory ring of recent federation_* audit events for the
 * dashboard.  Populated lazily on first read so test environments that
 * never touch the dashboard don't pay for the subscription.  A pure ring
 * (cap = 200) keeps memory bounded in long-running processes — older
 * events fall off as new ones land.
 */
const FEDERATION_EVENT_BUFFER_CAP = 200;
const _recentFederationEvents: AuditEvent[] = [];
let _auditSubscriptionInstalled = false;

function ensureAuditSubscription(): void {
  if (_auditSubscriptionInstalled) return;
  subscribeToAudit((event) => {
    if (!event.type.startsWith("federation_")) return;
    _recentFederationEvents.push(event);
    if (_recentFederationEvents.length > FEDERATION_EVENT_BUFFER_CAP) {
      _recentFederationEvents.splice(0, _recentFederationEvents.length - FEDERATION_EVENT_BUFFER_CAP);
    }
  });
  _auditSubscriptionInstalled = true;
}

/** Recent federation_* audit events (most recent last).  Bounded ring of 200 entries. */
export function getRecentFederationEvents(limit = 50): AuditEvent[] {
  if (_recentFederationEvents.length <= limit) return [..._recentFederationEvents];
  return _recentFederationEvents.slice(-limit);
}

// Install at module load so events accumulate from process start, not from
// the first dashboard poll.
ensureAuditSubscription();

/**
 * Resolve the federation config and assert it is enabled + sufficiently
 * configured to talk to peers.  Throws on misconfiguration so callers get a
 * loud failure instead of a silent disabled state.
 */
function requireEnabledConfig(): FederationConfig {
  const config = getConfig().federation;
  if (!config.enabled) {
    throw new Error("Federation is disabled (set federation.enabled = true in starlingai.json)");
  }
  if (!config.sharedSecret || config.sharedSecret.length < 32) {
    throw new Error("Federation requires federation.sharedSecret (≥32 chars) to be configured");
  }
  return config;
}

/** Get the current federation config without enforcing enabled — used by inbound auth to short-circuit early. */
export function getFederationConfig(): FederationConfig {
  return getConfig().federation;
}

/**
 * Discovered (non-configured) peers — populated by `discoverPeersTransitively`
 * at startup + on a periodic timer when `federation.discovery.enabled` is on.
 * These do not persist; a restart re-discovers them.
 */
const _discoveredPeers = new Map<string, FederationPeerConfig & { discoveredAt: string; lastSeenAt: string }>();

/** Look up a peer by id from the configured peer list, then the discovered cache. */
export function findPeerById(peerId: string): FederationPeerConfig | undefined {
  return getConfig().federation.peers.find((p) => p.id === peerId)
    ?? _discoveredPeers.get(peerId);
}

interface KnownPeerSummary extends FederationPeerConfig {
  source: "configured" | "discovered";
}

/** Union of configured + discovered peers, marked by source. */
export function listAllKnownPeers(): KnownPeerSummary[] {
  const configured = getConfig().federation.peers.map((p) => ({ ...p, source: "configured" as const }));
  const discovered = [..._discoveredPeers.values()]
    .filter((p) => !configured.find((c) => c.id === p.id))
    .map(({ discoveredAt: _d, lastSeenAt: _l, ...rest }) => ({ ...rest, source: "discovered" as const }));
  return [...configured, ...discovered];
}

/** Test-only — clear the discovered-peer cache. */
export function _resetDiscoveredPeersForTests(): void {
  _discoveredPeers.clear();
}

/** Mint a federation JWT addressed to `audiencePeerId`.  Caller is the local instance. */
export async function mintFederationToken(audiencePeerId: string, purpose: "capabilities" | "delegate" | "health"): Promise<string> {
  const config = requireEnabledConfig();
  const secret = new TextEncoder().encode(config.sharedSecret);
  return new SignJWT({ purpose })
    .setProtectedHeader({ alg: TOKEN_ALGORITHM })
    .setIssuer(config.instanceId)
    .setAudience(audiencePeerId)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .sign(secret);
}

export interface VerifiedFederationToken {
  issuer: string;
  audience: string;
  purpose: string;
  payload: JWTPayload;
}

/**
 * Verify an inbound federation JWT.  Returns null if the token is missing,
 * malformed, expired, or signed with the wrong secret.  This is intentionally
 * silent — log + audit the failure once at the call site so callers can return
 * 401 without leaking which check failed.
 */
export async function verifyFederationToken(token: string | null | undefined): Promise<VerifiedFederationToken | null> {
  if (!token) return null;
  const config = getFederationConfig();
  if (!config.enabled || !config.sharedSecret || config.sharedSecret.length < 32) {
    return null;
  }
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(config.sharedSecret), {
      // We don't pin issuer or audience here — we accept any peer that holds
      // the shared secret.  Audience MUST match this instance though.
      audience: config.instanceId,
    });
    if (typeof payload.iss !== "string" || typeof payload.aud !== "string") return null;
    if (typeof payload["purpose"] !== "string") return null;
    return {
      issuer: payload.iss,
      audience: payload.aud,
      purpose: payload["purpose"] as string,
      payload,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch a peer's capability snapshot.  Cached per-peer for
 * `federation.capabilityCacheTtlMs`; pass `force=true` to bypass.
 */
export async function fetchPeerCapability(peerId: string, options: { force?: boolean } = {}): Promise<FederationCapability> {
  const config = requireEnabledConfig();
  const peer = findPeerById(peerId);
  if (!peer) {
    throw new Error(`Unknown federation peer: ${peerId}`);
  }
  const cached = _capabilityCache.get(peerId);
  const now = Date.now();
  if (!options.force && cached && now - cached.fetchedAt < config.capabilityCacheTtlMs) {
    return cached.capability;
  }
  const token = await mintFederationToken(peer.id, "capabilities");
  const url = joinUrl(peer.url, "/api/federation/capabilities");
  const res = await fetchWithTimeout(url, {
    method: "GET",
    headers: { "authorization": `Bearer ${token}`, "accept": "application/json" },
  }, 15_000);
  if (!res.ok) {
    throw new Error(`Peer ${peerId} returned ${res.status} when fetching capabilities`);
  }
  const capability = (await res.json()) as FederationCapability;
  _capabilityCache.set(peerId, { capability, fetchedAt: now });
  return capability;
}

/** Drop the cached capability snapshot for a peer (e.g. after auth failure). */
export function invalidatePeerCapability(peerId: string): void {
  _capabilityCache.delete(peerId);
}

/**
 * Transitive peer discovery — ask each currently-known peer "who else do you
 * talk to?", probe each new candidate with `/api/federation/health`, and add
 * any that respond successfully to the discovered-peer cache.  Trust is the
 * shared HMAC: a probe that auths is by definition a peer in our trust web.
 *
 * Returns counts so the periodic loop can log progress.  Idempotent — known
 * peers refresh their `lastSeenAt` rather than duplicating.
 */
export async function discoverPeersTransitively(): Promise<{ probed: number; added: number; refreshed: number; failed: number }> {
  const config = requireEnabledConfig();
  if (!config.discovery.enabled) return { probed: 0, added: 0, refreshed: 0, failed: 0 };

  const localId = config.instanceId;
  const seen = new Set<string>([localId, ...config.peers.map((p) => p.id)]);
  const candidates: FederationPeerConfig[] = [];

  // Ask each configured peer for THEIR known-peers list.
  for (const peer of config.peers) {
    try {
      const token = await mintFederationToken(peer.id, "capabilities");
      const res = await fetchWithTimeout(joinUrl(peer.url, "/api/federation/peers-known"), {
        method: "GET",
        headers: { "authorization": `Bearer ${token}`, "accept": "application/json" },
      }, 10_000);
      if (!res.ok) continue;
      const body = (await res.json()) as { peers?: FederationPeerConfig[] };
      for (const p of body.peers ?? []) {
        if (!p.id || !p.url) continue;
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        candidates.push({ id: p.id, url: p.url, tags: p.tags ?? [] });
      }
    } catch {
      // Peer may be unreachable — non-fatal, the next refresh will retry.
    }
  }

  let added = 0;
  let refreshed = 0;
  let failed = 0;

  // Probe each candidate via /api/federation/health to verify shared trust.
  // We can't use mintFederationToken normally because the candidate isn't in
  // our peer list yet — temporarily add it to discovered cache, attempt the
  // probe, and roll back on failure.
  for (const candidate of candidates) {
    const now = new Date().toISOString();
    _discoveredPeers.set(candidate.id, { ...candidate, discoveredAt: now, lastSeenAt: now });
    const probe = await pingPeer(candidate.id);
    if (probe.ok) {
      added += 1;
      logAudit("federation_peer_discovered", {
        peerId: candidate.id,
        peerUrl: candidate.url,
        instanceId: probe.instanceId ?? null,
        latencyMs: probe.latencyMs,
      });
    } else {
      _discoveredPeers.delete(candidate.id);
      failed += 1;
    }
  }

  // Refresh lastSeenAt for already-discovered peers that still respond.
  for (const [id, peer] of _discoveredPeers) {
    if (candidates.find((c) => c.id === id)) continue; // just probed above
    const probe = await pingPeer(id);
    if (probe.ok) {
      peer.lastSeenAt = new Date().toISOString();
      refreshed += 1;
    } else {
      _discoveredPeers.delete(id);
      logAudit("federation_peer_unreachable", { peerId: id, peerUrl: peer.url, error: probe.error ?? "ping failed" }, { severity: "warn" });
    }
  }

  return { probed: candidates.length, added, refreshed, failed };
}

let _discoveryTimer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic discovery loop. */
export function startPeerDiscovery(): void {
  const config = getFederationConfig();
  if (!config.enabled || !config.discovery.enabled) return;
  if (_discoveryTimer) return; // already running
  // Kick off an initial pass without blocking.
  void discoverPeersTransitively().then((counts) => {
    log.info({ ...counts }, "Initial federation peer discovery complete");
  }).catch((err) => log.warn({ err }, "Initial federation peer discovery failed"));

  _discoveryTimer = setInterval(() => {
    void discoverPeersTransitively().then((counts) => {
      if (counts.added > 0 || counts.refreshed > 0 || counts.failed > 0) {
        log.debug({ ...counts }, "Federation peer discovery refresh");
      }
    }).catch((err) => log.warn({ err }, "Federation peer discovery refresh failed"));
  }, config.discovery.intervalMs);
  // Don't keep the process alive solely for the discovery loop.
  _discoveryTimer.unref?.();
}

/** Stop the discovery loop (graceful shutdown). */
export function stopPeerDiscovery(): void {
  if (_discoveryTimer) {
    clearInterval(_discoveryTimer);
    _discoveryTimer = null;
  }
}

/** Probe a peer's `/api/federation/health` endpoint and return latency + identity. */
export async function pingPeer(peerId: string): Promise<{ ok: boolean; latencyMs: number; instanceId?: string; error?: string }> {
  const peer = findPeerById(peerId);
  if (!peer) return { ok: false, latencyMs: 0, error: "unknown peer" };
  const startedAt = Date.now();
  try {
    const token = await mintFederationToken(peer.id, "health");
    const res = await fetchWithTimeout(joinUrl(peer.url, "/api/federation/health"), {
      method: "GET",
      headers: { "authorization": `Bearer ${token}` },
    }, 5_000);
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) return { ok: false, latencyMs, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { instanceId?: string };
    return { ok: true, latencyMs, instanceId: body.instanceId };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - startedAt, error: (err as Error).message };
  }
}

/** Progress event relayed from the peer's sub-agent runner over SSE. */
export interface FederationStreamProgress {
  type: "progress";
  agentName: string;
  kind: string;
  iteration: number;
  toolName?: string;
  summary?: string;
}

export interface FederationStreamCompleted extends Omit<FederationDelegateResponse, "ok"> {
  type: "completed";
}

export interface FederationStreamError {
  type: "error";
  error: string;
}

export type FederationStreamEvent = FederationStreamProgress | FederationStreamCompleted | FederationStreamError;

/**
 * Delegate a task to a remote agent.  The peer enforces its own tier policy,
 * tool allowlists, and humanInLoopSteps — federation never bypasses local
 * guardrails.  Returns the synthesized result blob plus an optional remote
 * session id for cross-instance audit correlation.
 */
export async function delegateToRemotePeer(
  peerId: string,
  request: FederationDelegateRequest,
): Promise<FederationDelegateResponse> {
  return withSpan(
    `federation.delegate ${peerId}`,
    {
      "starlingai.federation.peer": peerId,
      "starlingai.federation.agent": request.agentName,
      "starlingai.federation.streaming": false,
    },
    async (span) => {
      const result = await delegateToRemotePeerInner(peerId, request);
      span.setAttribute("starlingai.federation.ok", result.ok);
      if (result.remoteSessionId) span.setAttribute("starlingai.federation.remoteSessionId", result.remoteSessionId);
      return result;
    },
  );
}

async function delegateToRemotePeerInner(
  peerId: string,
  request: FederationDelegateRequest,
): Promise<FederationDelegateResponse> {
  const config = requireEnabledConfig();
  const peer = findPeerById(peerId);
  if (!peer) {
    return { ok: false, error: `Unknown federation peer: ${peerId}` };
  }

  const timeoutMs = Math.min(request.timeoutMs ?? config.delegationTimeoutMs, config.delegationTimeoutMs);
  const auditPayload = {
    peerId,
    peerUrl: peer.url,
    agentName: request.agentName,
    taskPreview: request.task.slice(0, 240),
    originSessionId: request.originSessionId ?? null,
    timeoutMs,
  };
  logAudit("federation_delegate_started", auditPayload, { sessionId: request.originSessionId });

  const startedAt = Date.now();
  try {
    const token = await mintFederationToken(peer.id, "delegate");
    const url = joinUrl(peer.url, "/api/federation/delegate");
    const res = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
        "accept": "application/json",
      },
      body: JSON.stringify({
        agentName: request.agentName,
        task: request.task,
        context: request.context,
        originSessionId: request.originSessionId,
        timeoutMs,
      }),
    }, timeoutMs + 10_000); // grant the peer slightly more wall clock than its hard cap
    const durationMs = Date.now() - startedAt;
    if (!res.ok) {
      const text = await safeReadText(res);
      logAudit("federation_delegate_failed", { ...auditPayload, status: res.status, durationMs, body: text.slice(0, 200) }, { sessionId: request.originSessionId });
      return { ok: false, error: `peer ${peerId} returned HTTP ${res.status}` };
    }
    const body = (await res.json()) as FederationDelegateResponse;
    logAudit("federation_delegate_completed", {
      ...auditPayload,
      durationMs,
      remoteSessionId: body.remoteSessionId ?? null,
      ok: body.ok,
    }, { sessionId: request.originSessionId });
    return body;
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = (err as Error).message;
    logAudit("federation_delegate_failed", { ...auditPayload, error: message, durationMs }, { sessionId: request.originSessionId });
    log.warn({ peerId, err: message }, "federation delegation failed");
    return { ok: false, error: message };
  }
}

function joinUrl(base: string, path: string): string {
  const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;
  return `${trimmed}${path}`;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const handle = setTimeout(() => controller.abort(), timeoutMs);
  // Inject the current trace context so the federation peer can attach its
  // sub-spans to ours.  Standard W3C `traceparent`/`tracestate` headers.
  const headers: Record<string, string> = {};
  if (init.headers) {
    for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
      headers[k] = v;
    }
  }
  injectTraceContext(headers);
  try {
    return await fetch(url, { ...init, headers, signal: controller.signal });
  } finally {
    clearTimeout(handle);
  }
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

/**
 * Stream a remote delegation, forwarding peer progress events as they arrive
 * and resolving with the final completed/error envelope.  The peer sends
 * Server-Sent Events of shape:
 *
 *   data: {"type":"progress","agentName":"researcher","kind":"tool_start", ...}
 *   data: {"type":"completed","output":"...","stats":{...},"remoteSessionId":"..."}
 *   data: {"type":"error","error":"..."}
 *
 * `onProgress` fires for each progress frame; the returned promise resolves
 * with the final response (ok=true on completed, ok=false on error or EOF
 * without completion).
 */
export async function delegateToRemotePeerStreaming(
  peerId: string,
  request: FederationDelegateRequest,
  onProgress: (event: FederationStreamProgress) => void,
): Promise<FederationDelegateResponse> {
  return withSpan(
    `federation.delegate ${peerId}`,
    {
      "starlingai.federation.peer": peerId,
      "starlingai.federation.agent": request.agentName,
      "starlingai.federation.streaming": true,
    },
    async (span) => {
      const result = await delegateToRemotePeerStreamingInner(peerId, request, onProgress);
      span.setAttribute("starlingai.federation.ok", result.ok);
      if (result.remoteSessionId) span.setAttribute("starlingai.federation.remoteSessionId", result.remoteSessionId);
      return result;
    },
  );
}

async function delegateToRemotePeerStreamingInner(
  peerId: string,
  request: FederationDelegateRequest,
  onProgress: (event: FederationStreamProgress) => void,
): Promise<FederationDelegateResponse> {
  const config = requireEnabledConfig();
  const peer = findPeerById(peerId);
  if (!peer) return { ok: false, error: `Unknown federation peer: ${peerId}` };

  const timeoutMs = Math.min(request.timeoutMs ?? config.delegationTimeoutMs, config.delegationTimeoutMs);
  const auditPayload = {
    peerId,
    peerUrl: peer.url,
    agentName: request.agentName,
    taskPreview: request.task.slice(0, 240),
    originSessionId: request.originSessionId ?? null,
    timeoutMs,
    streaming: true,
  };
  logAudit("federation_delegate_started", auditPayload, { sessionId: request.originSessionId });

  const startedAt = Date.now();
  let token: string;
  try {
    token = await mintFederationToken(peer.id, "delegate");
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const url = joinUrl(peer.url, "/api/federation/delegate/stream");

  const controller = new AbortController();
  const overallTimer = setTimeout(() => controller.abort(), timeoutMs + 10_000);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "authorization": `Bearer ${token}`,
        "content-type": "application/json",
        "accept": "text/event-stream",
      },
      body: JSON.stringify({
        agentName: request.agentName,
        task: request.task,
        context: request.context,
        originSessionId: request.originSessionId,
        timeoutMs,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(overallTimer);
    const message = (err as Error).message;
    logAudit("federation_delegate_failed", { ...auditPayload, error: message, durationMs: Date.now() - startedAt }, { sessionId: request.originSessionId });
    return { ok: false, error: message };
  }

  if (!res.ok || !res.body) {
    clearTimeout(overallTimer);
    const status = res.status;
    const body = res.body ? await safeReadText(res) : "";
    logAudit("federation_delegate_failed", { ...auditPayload, status, durationMs: Date.now() - startedAt, body: body.slice(0, 200) }, { sessionId: request.originSessionId });
    return { ok: false, error: `peer ${peerId} returned HTTP ${status}` };
  }

  let final: FederationDelegateResponse | null = null;
  try {
    const decoder = new TextDecoder();
    let buffered = "";
    const reader = res.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      const events = consumeSseEvents(buffered);
      buffered = events.remainder;
      for (const raw of events.events) {
        const parsed = parseSseDataLine(raw);
        if (!parsed) continue;
        if (parsed.type === "progress") {
          onProgress(parsed);
        } else if (parsed.type === "completed") {
          final = { ok: true, output: parsed.output, remoteSessionId: parsed.remoteSessionId, stats: parsed.stats };
        } else if (parsed.type === "error") {
          final = { ok: false, error: parsed.error };
        }
      }
    }
  } finally {
    clearTimeout(overallTimer);
  }

  const durationMs = Date.now() - startedAt;
  if (!final) {
    logAudit("federation_delegate_failed", { ...auditPayload, error: "stream ended without completion frame", durationMs }, { sessionId: request.originSessionId });
    return { ok: false, error: "stream ended without completion frame" };
  }
  logAudit("federation_delegate_completed", {
    ...auditPayload,
    durationMs,
    remoteSessionId: final.remoteSessionId ?? null,
    ok: final.ok,
  }, { sessionId: request.originSessionId });
  return final;
}

export interface FederationSearchMatch {
  /** Source peer ("local" for the local instance, otherwise the peer id). */
  source: string;
  /** Peer's advertised instanceId, or "local" for own results. */
  instanceId: string;
  file: string;
  snippets: string[];
}

export interface FederationSearchPeerResult {
  peerId: string;
  instanceId?: string;
  ok: boolean;
  matched: number;
  durationMs?: number;
  error?: string;
}

export interface FederationSearchResult {
  matches: FederationSearchMatch[];
  peers: FederationSearchPeerResult[];
}

/**
 * Broadcast a workspace search to one or more peers in parallel and return
 * merged matches alongside per-peer status.  When `peerIds` is empty the
 * search hits every configured peer.  Results from unreachable peers surface
 * as ok=false entries instead of throwing — the caller decides whether
 * partial coverage is acceptable.
 */
export async function broadcastWorkspaceSearch(
  query: string,
  options: { peerIds?: string[]; maxResults?: number } = {},
): Promise<FederationSearchResult> {
  const config = requireEnabledConfig();
  const targetPeers = options.peerIds && options.peerIds.length > 0
    ? config.peers.filter((p) => options.peerIds!.includes(p.id))
    : config.peers;

  if (targetPeers.length === 0) {
    return { matches: [], peers: [] };
  }

  const maxResults = Math.min(30, Math.max(1, options.maxResults ?? 10));

  logAudit("federation_search_started", {
    query: query.slice(0, 80),
    maxResults,
    peerCount: targetPeers.length,
  });

  const results = await Promise.all(targetPeers.map(async (peer): Promise<{ peer: typeof peer; ok: boolean; matched: number; durationMs?: number; error?: string; instanceId?: string; matches: FederationSearchMatch[] }> => {
    const startedAt = Date.now();
    try {
      const token = await mintFederationToken(peer.id, "delegate");
      const res = await fetchWithTimeout(joinUrl(peer.url, "/api/federation/search"), {
        method: "POST",
        headers: {
          "authorization": `Bearer ${token}`,
          "content-type": "application/json",
          "accept": "application/json",
        },
        body: JSON.stringify({ query, maxResults }),
      }, 30_000);
      if (!res.ok) {
        return { peer, ok: false, matched: 0, durationMs: Date.now() - startedAt, error: `HTTP ${res.status}`, matches: [] };
      }
      const body = (await res.json()) as { matches?: { file: string; snippets: string[] }[]; instanceId?: string };
      const matches = (body.matches ?? []).map<FederationSearchMatch>((m) => ({
        source: peer.id,
        instanceId: body.instanceId ?? peer.id,
        file: m.file,
        snippets: m.snippets,
      }));
      return { peer, ok: true, matched: matches.length, durationMs: Date.now() - startedAt, instanceId: body.instanceId, matches };
    } catch (err) {
      return { peer, ok: false, matched: 0, durationMs: Date.now() - startedAt, error: (err as Error).message, matches: [] };
    }
  }));

  const peerResults: FederationSearchPeerResult[] = results.map((r) => ({
    peerId: r.peer.id,
    instanceId: r.instanceId,
    ok: r.ok,
    matched: r.matched,
    durationMs: r.durationMs,
    error: r.error,
  }));

  const merged = results.flatMap((r) => r.matches);
  logAudit("federation_search_completed", {
    query: query.slice(0, 80),
    peerCount: targetPeers.length,
    okPeers: peerResults.filter((p) => p.ok).length,
    totalMatches: merged.length,
  });

  return { matches: merged, peers: peerResults };
}

function consumeSseEvents(buffered: string): { events: string[]; remainder: string } {
  const events: string[] = [];
  let remainder = buffered;
  while (true) {
    const idx = remainder.indexOf("\n\n");
    if (idx === -1) break;
    events.push(remainder.slice(0, idx));
    remainder = remainder.slice(idx + 2);
  }
  return { events, remainder };
}

function parseSseDataLine(raw: string): FederationStreamEvent | null {
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      const parsed = JSON.parse(payload) as FederationStreamEvent;
      if (parsed && (parsed.type === "progress" || parsed.type === "completed" || parsed.type === "error")) {
        return parsed;
      }
    } catch {
      // Skip malformed frames silently — the peer may emit comments or
      // keep-alives that aren't valid event JSON.
    }
  }
  return null;
}

export const FEDERATION_PROTOCOL_VERSION = FEDERATION_VERSION;

/** Test-only: clear the in-memory capability cache. */
export function _resetFederationCacheForTests(): void {
  _capabilityCache.clear();
}
