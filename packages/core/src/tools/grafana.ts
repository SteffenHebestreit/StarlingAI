/**
 * Grafana tools — Wave 4.
 *
 * External-only: every call targets a remote Grafana instance configured
 * under `monitoring.grafana` in starlingai.json. The gateway never runs
 * its own Grafana.
 */
import { getConfig } from "../config/loader.js";
import type { GrafanaInstanceSchema } from "../config/schema.js";
import type { z } from "zod";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import { fetchWithTimeout, resolveSecretRef } from "./infrastructure-shared.js";

const log = childLogger("tool:grafana");

type GrafanaInstance = z.infer<typeof GrafanaInstanceSchema>;

const MAX_BODY_BYTES = 64_000;

function truncate(body: string): string {
  if (body.length <= MAX_BODY_BYTES) return body;
  return `${body.slice(0, MAX_BODY_BYTES)}\n\n[Response truncated at ${MAX_BODY_BYTES} bytes]`;
}

function resolveGrafanaInstance(
  requestedName: unknown,
): { name?: string; instance?: GrafanaInstance; error?: string } {
  const config = getConfig();
  const explicit = typeof requestedName === "string" && requestedName.trim() ? requestedName.trim() : undefined;
  const name = explicit ?? config.monitoring.defaultGrafana;
  if (!name) {
    return { error: "No Grafana instance configured. Set monitoring.defaultGrafana or pass instance=<name>." };
  }
  const instance = config.monitoring.grafana[name];
  if (!instance) {
    return { error: `Unknown Grafana instance '${name}'` };
  }
  return { name, instance };
}

function buildGrafanaHeaders(instance: GrafanaInstance, contentType?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (contentType) headers["Content-Type"] = contentType;
  if (instance.headers) {
    for (const [key, value] of Object.entries(instance.headers)) {
      headers[key] = resolveSecretRef(value) ?? value;
    }
  }
  if (instance.apiKey) {
    const key = resolveSecretRef(instance.apiKey) ?? instance.apiKey;
    if (key) headers["Authorization"] = `Bearer ${key}`;
  }
  if (instance.orgId !== undefined) {
    headers["X-Grafana-Org-Id"] = String(instance.orgId);
  }
  return headers;
}

function timeoutFor(args: Record<string, unknown>, instance: GrafanaInstance): number {
  if (typeof args["timeoutMs"] === "number" && Number.isFinite(args["timeoutMs"])) {
    return Math.max(1_000, Math.min(300_000, Math.trunc(args["timeoutMs"])));
  }
  return instance.timeoutMs;
}

// ─────────────────────────────────────────────────────────────────────────────
// grafana_dashboard_search — list/find dashboards (read-only)
// ─────────────────────────────────────────────────────────────────────────────
registerTool({
  name: "grafana_dashboard_search",
  description:
    "Search Grafana dashboards by query string, tag list, or folder. Read-only. Returns dashboard UIDs, titles, folder, tags, and URLs.",
  embeddingDescription:
    "grafana dashboard search list find query tag folder panel visualization inventory",
  costHint: "low",
  latencyHint: "low",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Text query against dashboard titles.",
      },
      tags: {
        type: "array",
        description: "Filter by tags (AND across entries).",
        items: { type: "string" },
      },
      folderIds: {
        type: "array",
        description: "Restrict to specific folder IDs.",
        items: { type: "number" },
      },
      limit: {
        type: "number",
        description: "Max results. Defaults to 50.",
      },
      instance: {
        type: "string",
        description: "Grafana instance name. Defaults to monitoring.defaultGrafana.",
      },
      timeoutMs: {
        type: "number",
        description: "Request timeout in ms.",
      },
    },
    required: [],
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const resolved = resolveGrafanaInstance(args["instance"]);
    if (resolved.error || !resolved.instance) {
      return { success: false, output: "", error: resolved.error ?? "Grafana instance unavailable" };
    }
    const instance = resolved.instance;
    const params = new URLSearchParams();
    if (typeof args["query"] === "string" && String(args["query"]).trim()) {
      params.set("query", String(args["query"]).trim());
    }
    if (Array.isArray(args["tags"])) {
      for (const tag of args["tags"]) {
        if (typeof tag === "string" && tag.trim()) params.append("tag", tag.trim());
      }
    }
    if (Array.isArray(args["folderIds"])) {
      for (const id of args["folderIds"]) {
        if (typeof id === "number" && Number.isFinite(id)) params.append("folderIds", String(Math.trunc(id)));
      }
    }
    const limit = typeof args["limit"] === "number" && Number.isFinite(args["limit"])
      ? Math.max(1, Math.min(1000, Math.trunc(args["limit"])))
      : 50;
    params.set("limit", String(limit));
    params.set("type", "dash-db");

    const url = `${instance.baseUrl.replace(/\/$/, "")}/api/search?${params.toString()}`;
    log.debug({ url, instance: resolved.name }, "grafana_dashboard_search executing");

    try {
      const response = await fetchWithTimeout(url, {
        method: "GET",
        headers: buildGrafanaHeaders(instance),
      }, timeoutFor(args, instance));
      const text = await response.text();
      if (!response.ok) {
        return { success: false, output: truncate(text), error: `Grafana returned HTTP ${response.status}` };
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
          count: Array.isArray(parsed) ? parsed.length : undefined,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: "", error: `Grafana request failed: ${message}` };
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// grafana_alerts_list — unified-alerting rules (read-only)
// ─────────────────────────────────────────────────────────────────────────────
registerTool({
  name: "grafana_alerts_list",
  description:
    "List Grafana unified-alerting rules in a folder (or all folders). Read-only. Returns rule groups with provisioned rules and their conditions.",
  embeddingDescription:
    "grafana alerts list unified alerting rules provisioned conditions thresholds inventory",
  costHint: "low",
  latencyHint: "low",
  parameters: {
    type: "object",
    properties: {
      folder: {
        type: "string",
        description: "Optional folder UID to scope the listing.",
      },
      instance: {
        type: "string",
        description: "Grafana instance name. Defaults to monitoring.defaultGrafana.",
      },
      timeoutMs: {
        type: "number",
        description: "Request timeout in ms.",
      },
    },
    required: [],
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const resolved = resolveGrafanaInstance(args["instance"]);
    if (resolved.error || !resolved.instance) {
      return { success: false, output: "", error: resolved.error ?? "Grafana instance unavailable" };
    }
    const instance = resolved.instance;

    const folder = typeof args["folder"] === "string" && String(args["folder"]).trim() ? String(args["folder"]).trim() : "";
    const url = folder
      ? `${instance.baseUrl.replace(/\/$/, "")}/api/v1/provisioning/folder/${encodeURIComponent(folder)}/rule-groups`
      : `${instance.baseUrl.replace(/\/$/, "")}/api/v1/provisioning/alert-rules`;

    try {
      const response = await fetchWithTimeout(url, {
        method: "GET",
        headers: buildGrafanaHeaders(instance),
      }, timeoutFor(args, instance));
      const text = await response.text();
      if (!response.ok) {
        return { success: false, output: truncate(text), error: `Grafana returned HTTP ${response.status}` };
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
          folder: folder || null,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: "", error: `Grafana request failed: ${message}` };
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// grafana_dashboard_apply — create or update a dashboard (mutates, HITL)
// ─────────────────────────────────────────────────────────────────────────────
registerTool({
  name: "grafana_dashboard_apply",
  description:
    "Create or update a Grafana dashboard (POST /api/dashboards/db). Approval-gated. The dashboard JSON body must include panels and targets. Set overwrite=true to replace an existing version on version conflict.",
  embeddingDescription:
    "grafana dashboard apply create update import publish panels visualization deploy provision",
  parameters: {
    type: "object",
    properties: {
      dashboard: {
        type: "object",
        description: "Grafana dashboard JSON definition (panels, templating, time, uid, title).",
        additionalProperties: true,
      },
      folderId: {
        type: "number",
        description: "Optional folder ID to place the dashboard in.",
      },
      folderUid: {
        type: "string",
        description: "Optional folder UID (takes precedence over folderId on recent Grafana versions).",
      },
      message: {
        type: "string",
        description: "Commit-message-like changelog for the new dashboard version.",
      },
      overwrite: {
        type: "boolean",
        description: "If true, overwrite an existing dashboard with the same uid/slug even on version conflict.",
      },
      instance: {
        type: "string",
        description: "Grafana instance name. Defaults to monitoring.defaultGrafana.",
      },
      timeoutMs: {
        type: "number",
        description: "Request timeout in ms.",
      },
    },
    required: ["dashboard"],
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const resolved = resolveGrafanaInstance(args["instance"]);
    if (resolved.error || !resolved.instance) {
      return { success: false, output: "", error: resolved.error ?? "Grafana instance unavailable" };
    }
    const instance = resolved.instance;

    const dashboard = args["dashboard"];
    if (!dashboard || typeof dashboard !== "object" || Array.isArray(dashboard)) {
      return { success: false, output: "", error: "dashboard must be a JSON object" };
    }

    const body: Record<string, unknown> = {
      dashboard,
      overwrite: args["overwrite"] === true,
    };
    if (typeof args["folderId"] === "number" && Number.isFinite(args["folderId"])) {
      body["folderId"] = Math.trunc(args["folderId"]);
    }
    if (typeof args["folderUid"] === "string" && String(args["folderUid"]).trim()) {
      body["folderUid"] = String(args["folderUid"]).trim();
    }
    if (typeof args["message"] === "string" && String(args["message"]).trim()) {
      body["message"] = String(args["message"]).trim();
    }

    const url = `${instance.baseUrl.replace(/\/$/, "")}/api/dashboards/db`;
    try {
      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: buildGrafanaHeaders(instance, "application/json"),
        body: JSON.stringify(body),
      }, timeoutFor(args, instance));
      const text = await response.text();
      if (!response.ok) {
        return { success: false, output: truncate(text), error: `Grafana returned HTTP ${response.status}` };
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
          overwrite: args["overwrite"] === true,
          folderId: args["folderId"] ?? null,
          folderUid: args["folderUid"] ?? null,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: "", error: `Grafana request failed: ${message}` };
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// grafana_alert_apply — create or update a unified-alerting rule (mutates, HITL)
// ─────────────────────────────────────────────────────────────────────────────
registerTool({
  name: "grafana_alert_apply",
  description:
    "Create a new unified-alerting rule (POST) or update an existing one (PUT when uid is given) via the provisioning API. Approval-gated. The rule body must include title, condition, data (queries + conditions), noDataState, execErrState, and the target folderUID + ruleGroup.",
  embeddingDescription:
    "grafana alert rule create update unified alerting threshold notification provisioning",
  parameters: {
    type: "object",
    properties: {
      rule: {
        type: "object",
        description: "Grafana AlertRule JSON body.",
        additionalProperties: true,
      },
      uid: {
        type: "string",
        description: "Optional rule uid. When present the tool issues PUT (update) instead of POST (create).",
      },
      disableProvenance: {
        type: "boolean",
        description: "Send X-Disable-Provenance header so the rule can be edited in the UI after provisioning.",
      },
      instance: {
        type: "string",
        description: "Grafana instance name. Defaults to monitoring.defaultGrafana.",
      },
      timeoutMs: {
        type: "number",
        description: "Request timeout in ms.",
      },
    },
    required: ["rule"],
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const resolved = resolveGrafanaInstance(args["instance"]);
    if (resolved.error || !resolved.instance) {
      return { success: false, output: "", error: resolved.error ?? "Grafana instance unavailable" };
    }
    const instance = resolved.instance;

    const rule = args["rule"];
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      return { success: false, output: "", error: "rule must be a JSON object" };
    }

    const uid = typeof args["uid"] === "string" && String(args["uid"]).trim() ? String(args["uid"]).trim() : "";
    const method = uid ? "PUT" : "POST";
    const url = uid
      ? `${instance.baseUrl.replace(/\/$/, "")}/api/v1/provisioning/alert-rules/${encodeURIComponent(uid)}`
      : `${instance.baseUrl.replace(/\/$/, "")}/api/v1/provisioning/alert-rules`;

    const headers = buildGrafanaHeaders(instance, "application/json");
    if (args["disableProvenance"] === true) {
      headers["X-Disable-Provenance"] = "true";
    }

    try {
      const response = await fetchWithTimeout(url, {
        method,
        headers,
        body: JSON.stringify(rule),
      }, timeoutFor(args, instance));
      const text = await response.text();
      if (!response.ok) {
        return { success: false, output: truncate(text), error: `Grafana returned HTTP ${response.status}` };
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
          action: uid ? "update" : "create",
          uid: uid || null,
          disableProvenance: args["disableProvenance"] === true,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: "", error: `Grafana request failed: ${message}` };
    }
  },
});
