/**
 * Channel registry — tracks all running message channel instances and
 * exposes their status for the /api/channels REST endpoint.
 */
const MAX_DELIVERY_LATENCY_SAMPLES = 200;

export interface ChannelHealthResult {
  healthy: boolean;
  latencyMs?: number;
  error?: string;
  checkedAt?: string;
}

export interface ChannelDeliveryLatencySummary {
  sampleCount: number;
  lastMs?: number;
  maxMs?: number;
  p50Ms?: number;
  p95Ms?: number;
  p99Ms?: number;
}

export interface ChannelDeliverySloSummary {
  totalDeliveries: number;
  delivered: number;
  failed: number;
  successRatePct: number;
}

export interface ChannelDeliveryWindowSummary extends ChannelDeliverySloSummary {
  windowMs: number;
  maxMs?: number;
  p50Ms?: number;
  p95Ms?: number;
  p99Ms?: number;
}

export interface ChannelStatus {
  type: string;
  enabled: boolean;
  running: boolean;
  error?: string;
  health?: ChannelHealthResult;
  metrics?: ChannelMetrics;
}

export interface ChannelMetrics {
  delivered: number;
  deliveryFailures: number;
  ingressDenied: number;
  lastDeliveryError?: string;
  lastIngressDeniedAt?: string;
  deliveryLatency?: ChannelDeliveryLatencySummary;
  deliverySlo?: ChannelDeliverySloSummary;
  deliveryWindows?: {
    last5m?: ChannelDeliveryWindowSummary;
    last1h?: ChannelDeliveryWindowSummary;
  };
}

interface ChannelDeliveryEvent {
  ts: number;
  delivered: boolean;
  latencyMs?: number;
}

interface ChannelEntry {
  type: string;
  enabled: boolean;
  running: boolean;
  error?: string;
  stop?: () => Promise<void>;
  healthCheck?: () => Promise<ChannelHealthResult>;
  health?: ChannelHealthResult;
  metrics: ChannelMetrics;
  latencySamples: number[];
  lastDeliveryLatencyMs?: number;
  deliveryEvents: ChannelDeliveryEvent[];
}

const _channels = new Map<string, ChannelEntry>();

export function registerChannel(type: string, enabled: boolean): void {
  const existing = _channels.get(type);
  _channels.set(type, {
    type,
    enabled,
    running: false,
    metrics: createBaseMetrics(existing?.metrics),
    latencySamples: existing?.latencySamples ?? [],
    lastDeliveryLatencyMs: existing?.lastDeliveryLatencyMs,
    deliveryEvents: existing?.deliveryEvents ?? [],
  });
}

export function setChannelRunning(type: string, stop: () => Promise<void>): void {
  const entry = _channels.get(type);
  if (entry) { entry.running = true; entry.stop = stop; entry.error = undefined; }
}

export function setChannelError(type: string, error: string): void {
  const entry = _channels.get(type);
  if (entry) { entry.running = false; entry.error = error; }
}

export function setChannelStopped(type: string): void {
  const entry = _channels.get(type);
  if (entry) { entry.running = false; entry.stop = undefined; }
}

export function setChannelHealthCheck(
  type: string,
  checkFn: () => Promise<ChannelHealthResult>
): void {
  const entry = _channels.get(type);
  if (entry) entry.healthCheck = checkFn;
}

export function getChannelStatuses(): ChannelStatus[] {
  return [..._channels.values()].map(e => ({
    type: e.type,
    enabled: e.enabled,
    running: e.running,
    error: e.error,
    health: e.health,
    metrics: buildMetrics(e),
  }));
}

export function getChannelStatus(type: string): ChannelStatus | undefined {
  const entry = _channels.get(type);
  if (!entry) return undefined;
  return {
    type: entry.type,
    enabled: entry.enabled,
    running: entry.running,
    error: entry.error,
    health: entry.health,
    metrics: buildMetrics(entry),
  };
}

export function recordChannelDelivery(type: string, delivered: boolean, error?: string, latencyMs?: number): void {
  const entry = _channels.get(type);
  if (!entry) return;
  const now = Date.now();
  if (typeof latencyMs === "number" && Number.isFinite(latencyMs) && latencyMs >= 0) {
    entry.lastDeliveryLatencyMs = latencyMs;
    entry.latencySamples.push(latencyMs);
    if (entry.latencySamples.length > MAX_DELIVERY_LATENCY_SAMPLES) {
      entry.latencySamples.splice(0, entry.latencySamples.length - MAX_DELIVERY_LATENCY_SAMPLES);
    }
  }
  entry.deliveryEvents.push({ ts: now, delivered, latencyMs });
  if (entry.deliveryEvents.length > MAX_DELIVERY_LATENCY_SAMPLES) {
    entry.deliveryEvents.splice(0, entry.deliveryEvents.length - MAX_DELIVERY_LATENCY_SAMPLES);
  }
  const oldestToKeep = now - 60 * 60 * 1000;
  entry.deliveryEvents = entry.deliveryEvents.filter((event) => event.ts >= oldestToKeep);
  if (delivered) {
    entry.metrics.delivered += 1;
    return;
  }
  entry.metrics.deliveryFailures += 1;
  entry.metrics.lastDeliveryError = error;
}

export function recordChannelIngressDenied(type: string): void {
  const entry = _channels.get(type);
  if (!entry) return;
  entry.metrics.ingressDenied += 1;
  entry.metrics.lastIngressDeniedAt = new Date().toISOString();
}

export function resetChannelRegistryForTests(): void {
  _channels.clear();
}

export async function runChannelHealthChecks(): Promise<void> {
  for (const entry of _channels.values()) {
    if (!entry.running || !entry.healthCheck) continue;
    const start = Date.now();
    try {
      const result = await entry.healthCheck();
      entry.health = { ...result, latencyMs: Date.now() - start, checkedAt: new Date().toISOString() };
    } catch (err) {
      entry.health = { healthy: false, latencyMs: Date.now() - start, error: String(err), checkedAt: new Date().toISOString() };
    }
  }
}

function createBaseMetrics(existing?: ChannelMetrics): ChannelMetrics {
  return {
    delivered: existing?.delivered ?? 0,
    deliveryFailures: existing?.deliveryFailures ?? 0,
    ingressDenied: existing?.ingressDenied ?? 0,
    lastDeliveryError: existing?.lastDeliveryError,
    lastIngressDeniedAt: existing?.lastIngressDeniedAt,
  };
}

function buildMetrics(entry: ChannelEntry): ChannelMetrics {
  const metrics: ChannelMetrics = { ...entry.metrics };
  const latency = summarizeLatency(entry.latencySamples, entry.lastDeliveryLatencyMs);
  if (latency) metrics.deliveryLatency = latency;
  const slo = summarizeSlo(entry.metrics);
  if (slo) metrics.deliverySlo = slo;
  const windows = summarizeWindows(entry.deliveryEvents);
  if (windows.last5m || windows.last1h) metrics.deliveryWindows = windows;
  return metrics;
}

function summarizeLatency(samples: number[], lastDeliveryLatencyMs?: number): ChannelDeliveryLatencySummary | undefined {
  if (samples.length === 0) return undefined;
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    sampleCount: sorted.length,
    lastMs: lastDeliveryLatencyMs,
    maxMs: sorted[sorted.length - 1],
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
  };
}

function summarizeSlo(metrics: ChannelMetrics): ChannelDeliverySloSummary | undefined {
  const totalDeliveries = metrics.delivered + metrics.deliveryFailures;
  if (totalDeliveries === 0) return undefined;
  return {
    totalDeliveries,
    delivered: metrics.delivered,
    failed: metrics.deliveryFailures,
    successRatePct: Number(((metrics.delivered / totalDeliveries) * 100).toFixed(2)),
  };
}

function summarizeWindows(events: ChannelDeliveryEvent[]): { last5m?: ChannelDeliveryWindowSummary; last1h?: ChannelDeliveryWindowSummary } {
  return {
    last5m: summarizeWindow(events, 5 * 60 * 1000),
    last1h: summarizeWindow(events, 60 * 60 * 1000),
  };
}

function summarizeWindow(events: ChannelDeliveryEvent[], windowMs: number): ChannelDeliveryWindowSummary | undefined {
  const cutoff = Date.now() - windowMs;
  const windowEvents = events.filter((event) => event.ts >= cutoff);
  if (windowEvents.length === 0) return undefined;

  const delivered = windowEvents.filter((event) => event.delivered).length;
  const failed = windowEvents.length - delivered;
  const latencies = windowEvents
    .map((event) => event.latencyMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((left, right) => left - right);

  return {
    windowMs,
    totalDeliveries: windowEvents.length,
    delivered,
    failed,
    successRatePct: Number(((delivered / windowEvents.length) * 100).toFixed(2)),
    maxMs: latencies.length ? latencies[latencies.length - 1] : undefined,
    p50Ms: latencies.length ? percentile(latencies, 50) : undefined,
    p95Ms: latencies.length ? percentile(latencies, 95) : undefined,
    p99Ms: latencies.length ? percentile(latencies, 99) : undefined,
  };
}

function percentile(sorted: number[], pct: number): number {
  const index = Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1);
  return sorted[index] ?? sorted[sorted.length - 1] ?? 0;
}
