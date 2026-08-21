/**
 * Prometheus + Alertmanager tools — Wave 3.
 *
 * External-only: every call targets a remote Prometheus / Alertmanager
 * instance configured under `monitoring.prometheus` / `monitoring.alertmanager`
 * in starlingai.json. The gateway never runs its own Prometheus stack.
 */
import { getConfig } from "../config/loader.js";
import type {
  AlertmanagerInstanceSchema,
  PrometheusInstanceSchema,
} from "../config/schema.js";
import type { z } from "zod";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import { fetchWithTimeout, resolveSecretRef } from "./infrastructure-shared.js";

const log = childLogger("tool:prometheus");

type PrometheusInstance = z.infer<typeof PrometheusInstanceSchema>;
type AlertmanagerInstance = z.infer<typeof AlertmanagerInstanceSchema>;

const MAX_BODY_BYTES = 64_000;

function truncate(body: string): string {
  if (body.length <= MAX_BODY_BYTES) return body;
  return `${body.slice(0, MAX_BODY_BYTES)}\n\n[Response truncated at ${MAX_BODY_BYTES} bytes]`;
}

function resolvePrometheusInstance(
  requestedName: unknown,
): { name?: string; instance?: PrometheusInstance; error?: string } {
  const config = getConfig();
  const explicit = typeof requestedName === "string" && requestedName.trim() ? requestedName.trim() : undefined;
  const name = explicit ?? config.monitoring.defaultPrometheus;
  if (!name) {
    return { error: "No Prometheus instance configured. Set monitoring.defaultPrometheus or pass instance=<name>." };
  }
  const instance = config.monitoring.prometheus[name];
  if (!instance) {
    return { error: `Unknown Prometheus instance '${name}'` };
  }
  return { name, instance };
}

function resolveAlertmanagerInstance(
  requestedName: unknown,
): { name?: string; instance?: AlertmanagerInstance; error?: string } {
  const config = getConfig();
  const explicit = typeof requestedName === "string" && requestedName.trim() ? requestedName.trim() : undefined;
  const name = explicit ?? config.monitoring.defaultAlertmanager;
  if (!name) {
    return { error: "No Alertmanager instance configured. Set monitoring.defaultAlertmanager or pass instance=<name>." };
  }
  const instance = config.monitoring.alertmanager[name];
  if (!instance) {
    return { error: `Unknown Alertmanager instance '${name}'` };
  }
  return { name, instance };
}

function buildAuthHeaders(
  instance: { bearerToken?: string; basicAuth?: { username: string; password: string }; headers?: Record<string, string> },
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (instance.headers) {
    for (const [key, value] of Object.entries(instance.headers)) {
      const resolved = resolveSecretRef(value) ?? value;
      headers[key] = resolved;
    }
  }
  if (instance.bearerToken) {
    const token = resolveSecretRef(instance.bearerToken) ?? instance.bearerToken;
    if (token) headers["Authorization"] = `Bearer ${token}`;
  } else if (instance.basicAuth) {
    const username = resolveSecretRef(instance.basicAuth.username) ?? instance.basicAuth.username;
    const password = resolveSecretRef(instance.basicAuth.password) ?? instance.basicAuth.password;
    const encoded = Buffer.from(`${username}:${password}`).toString("base64");
    headers["Authorization"] = `Basic ${encoded}`;
  }
  return headers;
}

function parseTimeValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// prometheus_query — instant or range query (read-only)
// ─────────────────────────────────────────────────────────────────────────────
registerTool({
  name: "prometheus_query",
  description:
    "Run a PromQL query against an external Prometheus instance. Omit start/end/step for an instant query (/api/v1/query); include start+end+step for a range query (/api/v1/query_range). Read-only.",
  embeddingDescription:
    "prometheus promql query metric time-series observability cpu memory http error rate slo saturation range instant",
  costHint: "low",
  latencyHint: "low",
  parameters: {
    type: "object",
    properties: {
      expr: {
        type: "string",
        description: "PromQL expression, e.g. rate(http_requests_total[5m]).",
      },
      time: {
        type: "string",
        description: "Evaluation timestamp for instant queries (RFC3339 or Unix seconds). Ignored for range queries.",
      },
      start: {
        type: "string",
        description: "Range query start timestamp (RFC3339 or Unix seconds). Triggers range mode when set.",
      },
      end: {
        type: "string",
        description: "Range query end timestamp. Required with start.",
      },
      step: {
        type: "string",
        description: "Range query step, e.g. '30s', '5m', '1h'. Required with start and end.",
      },
      instance: {
        type: "string",
        description: "Prometheus instance name (from monitoring.prometheus). Defaults to monitoring.defaultPrometheus.",
      },
      timeoutMs: {
        type: "number",
        description: "Request timeout in ms. Defaults to the instance's configured timeout.",
      },
    },
    required: ["expr"],
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const resolved = resolvePrometheusInstance(args["instance"]);
    if (resolved.error || !resolved.instance) {
      return { success: false, output: "", error: resolved.error ?? "Prometheus instance unavailable" };
    }
    const instance = resolved.instance;

    const expr = String(args["expr"] ?? "").trim();
    if (!expr) {
      return { success: false, output: "", error: "expr is required" };
    }
    const start = parseTimeValue(args["start"]);
    const end = parseTimeValue(args["end"]);
    const step = parseTimeValue(args["step"]);
    const isRange = Boolean(start || end || step);
    if (isRange && (!start || !end || !step)) {
      return { success: false, output: "", error: "range query requires start, end, and step together" };
    }

    const params = new URLSearchParams({ query: expr });
    let path = "/api/v1/query";
    if (isRange) {
      path = "/api/v1/query_range";
      params.set("start", start!);
      params.set("end", end!);
      params.set("step", step!);
    } else {
      const t = parseTimeValue(args["time"]);
      if (t) params.set("time", t);
    }

    const timeoutMs = typeof args["timeoutMs"] === "number" && Number.isFinite(args["timeoutMs"])
      ? Math.max(1_000, Math.min(300_000, Math.trunc(args["timeoutMs"])))
      : instance.timeoutMs;

    const url = `${instance.baseUrl.replace(/\/$/, "")}${path}?${params.toString()}`;
    log.debug({ url, instance: resolved.name, range: isRange }, "prometheus_query executing");

    try {
      const response = await fetchWithTimeout(url, {
        method: "GET",
        headers: buildAuthHeaders(instance),
      }, timeoutMs);
      const text = await response.text();
      if (!response.ok) {
        return {
          success: false,
          output: truncate(text),
          error: `Prometheus returned HTTP ${response.status}`,
        };
      }
      let parsed: unknown = undefined;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Non-JSON body — return raw text.
      }
      return {
        success: true,
        output: parsed ? JSON.stringify(parsed, null, 2) : truncate(text),
        metadata: {
          instance: resolved.name,
          mode: isRange ? "range" : "instant",
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: "", error: `Prometheus query failed: ${message}` };
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// alertmanager_silences_list — read current silences (read-only)
// ─────────────────────────────────────────────────────────────────────────────
registerTool({
  name: "alertmanager_silences_list",
  description:
    "List active silences on an external Alertmanager instance. Read-only. Optional filter parameter uses Alertmanager filter syntax, e.g. 'service=\"api\"'.",
  embeddingDescription:
    "alertmanager silences list active maintenance mute suppress alerts view",
  costHint: "low",
  latencyHint: "low",
  parameters: {
    type: "object",
    properties: {
      filter: {
        type: "string",
        description: "Optional Alertmanager filter expression, e.g. 'service=\"api\"'.",
      },
      instance: {
        type: "string",
        description: "Alertmanager instance name. Defaults to monitoring.defaultAlertmanager.",
      },
      timeoutMs: {
        type: "number",
        description: "Request timeout in ms.",
      },
    },
    required: [],
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const resolved = resolveAlertmanagerInstance(args["instance"]);
    if (resolved.error || !resolved.instance) {
      return { success: false, output: "", error: resolved.error ?? "Alertmanager instance unavailable" };
    }
    const instance = resolved.instance;
    const timeoutMs = typeof args["timeoutMs"] === "number" && Number.isFinite(args["timeoutMs"])
      ? Math.max(1_000, Math.min(300_000, Math.trunc(args["timeoutMs"])))
      : instance.timeoutMs;

    const params = new URLSearchParams();
    if (typeof args["filter"] === "string" && String(args["filter"]).trim()) {
      params.set("filter", String(args["filter"]).trim());
    }
    const qs = params.toString();
    const url = `${instance.baseUrl.replace(/\/$/, "")}/api/v2/silences${qs ? `?${qs}` : ""}`;

    try {
      const response = await fetchWithTimeout(url, {
        method: "GET",
        headers: buildAuthHeaders(instance),
      }, timeoutMs);
      const text = await response.text();
      if (!response.ok) {
        return { success: false, output: truncate(text), error: `Alertmanager returned HTTP ${response.status}` };
      }
      let parsed: unknown = undefined;
      try {
        parsed = JSON.parse(text);
      } catch {
        // fallthrough
      }
      return {
        success: true,
        output: parsed ? JSON.stringify(parsed, null, 2) : truncate(text),
        metadata: {
          instance: resolved.name,
          count: Array.isArray(parsed) ? parsed.length : undefined,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: "", error: `Alertmanager request failed: ${message}` };
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// alertmanager_silence_create — create a silence (mutates, HITL)
// ─────────────────────────────────────────────────────────────────────────────
registerTool({
  name: "alertmanager_silence_create",
  description:
    "Create a silence on an external Alertmanager instance to mute matching alerts during maintenance or an investigation. Matchers are (name, value, isRegex, isEqual) tuples. Duration is either an ISO endsAt timestamp or a relative durationMinutes value.",
  embeddingDescription:
    "alertmanager silence create mute suppress alerts maintenance window incident quiet matcher regex",
  parameters: {
    type: "object",
    properties: {
      matchers: {
        type: "array",
        description: "List of matchers; each is {name, value, isRegex?, isEqual?}.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            value: { type: "string" },
            isRegex: { type: "boolean" },
            isEqual: { type: "boolean" },
          },
          required: ["name", "value"],
        },
      },
      comment: {
        type: "string",
        description: "Short reason for the silence. Operators see this.",
      },
      createdBy: {
        type: "string",
        description: "Who is creating the silence (service account or operator identifier).",
      },
      endsAt: {
        type: "string",
        description: "Silence end time as ISO8601. Mutually exclusive with durationMinutes.",
      },
      durationMinutes: {
        type: "number",
        description: "Silence duration from now in minutes. Mutually exclusive with endsAt.",
      },
      startsAt: {
        type: "string",
        description: "Silence start time as ISO8601. Defaults to now.",
      },
      instance: {
        type: "string",
        description: "Alertmanager instance name. Defaults to monitoring.defaultAlertmanager.",
      },
      timeoutMs: {
        type: "number",
        description: "Request timeout in ms.",
      },
    },
    required: ["matchers", "comment", "createdBy"],
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const resolved = resolveAlertmanagerInstance(args["instance"]);
    if (resolved.error || !resolved.instance) {
      return { success: false, output: "", error: resolved.error ?? "Alertmanager instance unavailable" };
    }
    const instance = resolved.instance;

    const matchers = Array.isArray(args["matchers"]) ? args["matchers"] : [];
    if (matchers.length === 0) {
      return { success: false, output: "", error: "matchers must be a non-empty array" };
    }
    const normalizedMatchers = matchers.map((m: any) => {
      if (!m || typeof m !== "object" || typeof m.name !== "string" || typeof m.value !== "string") {
        throw new Error("each matcher requires a string name and value");
      }
      return {
        name: m.name,
        value: m.value,
        isRegex: Boolean(m.isRegex),
        isEqual: m.isEqual === false ? false : true,
      };
    });

    const comment = String(args["comment"] ?? "").trim();
    const createdBy = String(args["createdBy"] ?? "").trim();
    if (!comment) return { success: false, output: "", error: "comment is required" };
    if (!createdBy) return { success: false, output: "", error: "createdBy is required" };

    const endsAtRaw = typeof args["endsAt"] === "string" ? String(args["endsAt"]).trim() : "";
    const durationMinutes = typeof args["durationMinutes"] === "number" && Number.isFinite(args["durationMinutes"])
      ? Math.max(1, Math.trunc(args["durationMinutes"]))
      : undefined;
    if (endsAtRaw && durationMinutes !== undefined) {
      return { success: false, output: "", error: "endsAt and durationMinutes are mutually exclusive" };
    }
    if (!endsAtRaw && durationMinutes === undefined) {
      return { success: false, output: "", error: "one of endsAt or durationMinutes is required" };
    }
    const startsAtRaw = typeof args["startsAt"] === "string" ? String(args["startsAt"]).trim() : "";
    const startsAt = startsAtRaw || new Date().toISOString();
    const endsAt = endsAtRaw || new Date(Date.now() + (durationMinutes ?? 0) * 60_000).toISOString();

    const timeoutMs = typeof args["timeoutMs"] === "number" && Number.isFinite(args["timeoutMs"])
      ? Math.max(1_000, Math.min(300_000, Math.trunc(args["timeoutMs"])))
      : instance.timeoutMs;

    const body = {
      matchers: normalizedMatchers,
      startsAt,
      endsAt,
      createdBy,
      comment,
    };

    let normalizedMatchersForCatch: typeof normalizedMatchers;
    try {
      normalizedMatchersForCatch = normalizedMatchers;
      const response = await fetchWithTimeout(
        `${instance.baseUrl.replace(/\/$/, "")}/api/v2/silences`,
        {
          method: "POST",
          headers: {
            ...buildAuthHeaders(instance),
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        },
        timeoutMs,
      );
      const text = await response.text();
      if (!response.ok) {
        return { success: false, output: truncate(text), error: `Alertmanager returned HTTP ${response.status}` };
      }
      let parsed: unknown = undefined;
      try {
        parsed = JSON.parse(text);
      } catch {
        // ignore
      }
      return {
        success: true,
        output: parsed ? JSON.stringify(parsed, null, 2) : truncate(text),
        metadata: {
          instance: resolved.name,
          startsAt,
          endsAt,
          matcherCount: normalizedMatchersForCatch.length,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: "", error: `Alertmanager request failed: ${message}` };
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// alertmanager_silence_expire — expire (delete) an existing silence
// ─────────────────────────────────────────────────────────────────────────────
registerTool({
  name: "alertmanager_silence_expire",
  description:
    "Expire (delete) a silence by id on an external Alertmanager instance. Use after a maintenance window closes or an incident resolves.",
  embeddingDescription:
    "alertmanager silence expire delete end cancel remove mute unmute unsilence",
  parameters: {
    type: "object",
    properties: {
      silenceId: {
        type: "string",
        description: "The silence id returned by silence_create or silences_list.",
      },
      instance: {
        type: "string",
        description: "Alertmanager instance name. Defaults to monitoring.defaultAlertmanager.",
      },
      timeoutMs: {
        type: "number",
        description: "Request timeout in ms.",
      },
    },
    required: ["silenceId"],
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const resolved = resolveAlertmanagerInstance(args["instance"]);
    if (resolved.error || !resolved.instance) {
      return { success: false, output: "", error: resolved.error ?? "Alertmanager instance unavailable" };
    }
    const instance = resolved.instance;
    const silenceId = String(args["silenceId"] ?? "").trim();
    if (!silenceId) return { success: false, output: "", error: "silenceId is required" };
    const timeoutMs = typeof args["timeoutMs"] === "number" && Number.isFinite(args["timeoutMs"])
      ? Math.max(1_000, Math.min(300_000, Math.trunc(args["timeoutMs"])))
      : instance.timeoutMs;

    const url = `${instance.baseUrl.replace(/\/$/, "")}/api/v2/silence/${encodeURIComponent(silenceId)}`;
    try {
      const response = await fetchWithTimeout(url, {
        method: "DELETE",
        headers: buildAuthHeaders(instance),
      }, timeoutMs);
      const text = await response.text();
      if (!response.ok) {
        return { success: false, output: truncate(text), error: `Alertmanager returned HTTP ${response.status}` };
      }
      return {
        success: true,
        output: text.trim() || `Silence ${silenceId} expired`,
        metadata: { instance: resolved.name, silenceId },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: "", error: `Alertmanager request failed: ${message}` };
    }
  },
});
