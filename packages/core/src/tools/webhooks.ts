/**
 * Config-driven webhook tools.
 *
 * Each entry under `webhooks` in starlingai.json generates a tool named
 * `webhook__<key>` at Tier 1.  Header values starting with `$` are resolved
 * from process.env at call time.
 *
 * Call syncWebhookTools() after config load/reload to keep the registry aligned.
 */
import { registerTool, unregisterTool } from "./registry.js";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { markRuntimeComponentAttempt, markRuntimeComponentFailure, markRuntimeComponentSuccess } from "../runtime/status.js";

const log = childLogger("tool:webhooks");
const registeredWebhookTools = new Set<string>();

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function syncWebhookTools(): void {
  markRuntimeComponentAttempt("webhooks");
  const config = getConfig();
  const entries = Object.entries(config.webhooks ?? {});
  const desiredTools = new Set(entries.map(([name]) => `webhook__${name}`));

  try {
    for (const toolName of registeredWebhookTools) {
      if (!desiredTools.has(toolName)) {
        unregisterTool(toolName);
        registeredWebhookTools.delete(toolName);
        log.info({ toolName }, "Webhook tool unregistered");
      }
    }

    if (entries.length === 0) {
      markRuntimeComponentSuccess("webhooks", { registered: 0 });
      return;
    }

    for (const [name, def] of entries) {
      const toolName = `webhook__${name}`;

      registerTool({
        name: toolName,
        description: def.description,
        parameters: {
          type: "object",
          properties: {
            body: {
              type: "object",
              description: "Request body sent as JSON (for POST / PUT / PATCH methods)",
            },
            queryParams: {
              type: "object",
              description: "Key-value pairs appended as query string parameters",
            },
          },
          required: [],
        },
        async execute(args, _ctx) {
          const method = def.method ?? "POST";

          // Build headers — resolve $ENV_VAR references
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
            "Accept": "application/json",
            ...(def.headers ?? {}),
          };
          for (const [k, v] of Object.entries(headers)) {
            if (v.startsWith("$")) headers[k] = process.env[v.slice(1)] ?? "";
          }

          // Build URL with optional query params
          let url = def.url;
          if (args["queryParams"] && typeof args["queryParams"] === "object") {
            const qs = new URLSearchParams(
              Object.entries(args["queryParams"] as Record<string, unknown>)
                .filter(([, v]) => v != null)
                .reduce<Record<string, string>>((acc, [k, v]) => { acc[k] = String(v); return acc; }, {})
            ).toString();
            if (qs) url = `${url}?${qs}`;
          }

          const fetchOpts: RequestInit = { method, headers };
          if (method !== "GET" && method !== "DELETE" && args["body"] != null) {
            fetchOpts.body = typeof args["body"] === "string"
              ? args["body"]
              : JSON.stringify(args["body"]);
          }

          log.debug({ toolName, url, method }, "Webhook call");

          try {
            const res = await fetchWithTimeout(url, fetchOpts);

            if (!res.ok) {
              const body = await res.text().catch(() => "");
              return { success: false, output: "", error: `Webhook returned HTTP ${res.status}: ${body.substring(0, 200)}` };
            }

            const contentType = res.headers.get("content-type") ?? "";
            const responseBody = contentType.includes("json")
              ? JSON.stringify(await res.json())
              : await res.text();

            return {
              success: true,
              output: responseBody.substring(0, 4000),
              metadata: { status: res.status, url },
            };
          } catch (err) {
            log.error({ err, toolName }, "Webhook call failed");
            return { success: false, output: "", error: `Webhook failed: ${String(err)}` };
          }
        },
      });

      registeredWebhookTools.add(toolName);
      log.info({ toolName, url: def.url, method: def.method }, "Webhook tool registered");
    }

    markRuntimeComponentSuccess("webhooks", { registered: registeredWebhookTools.size });
  } catch (err) {
    markRuntimeComponentFailure("webhooks", err, { registered: registeredWebhookTools.size });
    throw err;
  }
}
