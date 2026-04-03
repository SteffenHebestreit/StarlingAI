import { emitSwarmEvent, onSwarmEvent, type SwarmEvent } from "./bus.js";

const STALE_AFTER_MS = 10 * 60 * 1_000;

export interface AgentCapabilityAnnouncement {
  sessionId?: string;
  agentName: string;
  domain?: string;
  capabilities?: string[];
  tags?: string[];
  availability?: "idle" | "busy" | "degraded";
  activeTaskId?: string;
  source?: string;
}

export interface AgentCapabilitySnapshot {
  agentName: string;
  domain?: string;
  capabilities: string[];
  tags: string[];
  availability: "idle" | "busy" | "degraded";
  activeTaskId?: string;
  source?: string;
  sessionId?: string;
  lastAnnouncedAt: string;
  ageMs: number;
  stale: boolean;
}

const _capabilities = new Map<string, Omit<AgentCapabilitySnapshot, "ageMs" | "stale">>();
let _unsubscribe: (() => void) | null = null;

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).map((entry) => entry.trim()).filter(Boolean))];
}

function recordAnnouncement(payload: AgentCapabilityAnnouncement, ts = new Date().toISOString()): void {
  if (!payload.agentName.trim()) return;
  _capabilities.set(payload.agentName, {
    agentName: payload.agentName,
    domain: payload.domain,
    capabilities: normalizeStringArray(payload.capabilities),
    tags: normalizeStringArray(payload.tags),
    availability: payload.availability ?? "idle",
    activeTaskId: payload.activeTaskId,
    source: payload.source,
    sessionId: payload.sessionId,
    lastAnnouncedAt: ts,
  });
}

function handleSwarmEvent(event: SwarmEvent): void {
  if (event.type !== "agent_capability_announce") return;

  const data = (event.data ?? {}) as Record<string, unknown>;
  recordAnnouncement({
    sessionId: event.sessionId,
    agentName: event.agentName ?? String(data["agentName"] ?? ""),
    domain: typeof data["domain"] === "string" ? data["domain"] : undefined,
    capabilities: normalizeStringArray(data["capabilities"]),
    tags: normalizeStringArray(data["tags"]),
    availability: data["availability"] === "busy" || data["availability"] === "degraded"
      ? data["availability"]
      : "idle",
    activeTaskId: typeof data["activeTaskId"] === "string" ? data["activeTaskId"] : undefined,
    source: typeof data["source"] === "string" ? data["source"] : undefined,
  }, event.ts);
}

function ensureTracking(): void {
  if (_unsubscribe) return;
  _unsubscribe = onSwarmEvent(handleSwarmEvent);
}

export function announceAgentCapability(payload: AgentCapabilityAnnouncement): void {
  ensureTracking();
  recordAnnouncement(payload);
  emitSwarmEvent("agent_capability_announce", {
    sessionId: payload.sessionId,
    agentName: payload.agentName,
    data: {
      domain: payload.domain,
      capabilities: payload.capabilities ?? [],
      tags: payload.tags ?? [],
      availability: payload.availability ?? "idle",
      activeTaskId: payload.activeTaskId,
      source: payload.source,
    },
  });
}

export function getAgentCapabilitySnapshot(): AgentCapabilitySnapshot[] {
  ensureTracking();
  const now = Date.now();

  return [..._capabilities.values()]
    .map((entry) => {
      const ageMs = Math.max(0, now - new Date(entry.lastAnnouncedAt).getTime());
      return {
        ...entry,
        ageMs,
        stale: ageMs > STALE_AFTER_MS,
      };
    })
    .sort((left, right) => left.agentName.localeCompare(right.agentName));
}

export function resetAgentCapabilityRegistryForTests(): void {
  _capabilities.clear();
  _unsubscribe = null;
}