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
import { logAudit } from "../audit/logger.js";

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

/** Look up a peer by id from the configured peer list.  Returns undefined if unknown. */
export function findPeerById(peerId: string): FederationPeerConfig | undefined {
  return getConfig().federation.peers.find((p) => p.id === peerId);
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
  try {
    return await fetch(url, { ...init, signal: controller.signal });
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

export const FEDERATION_PROTOCOL_VERSION = FEDERATION_VERSION;

/** Test-only: clear the in-memory capability cache. */
export function _resetFederationCacheForTests(): void {
  _capabilityCache.clear();
}
