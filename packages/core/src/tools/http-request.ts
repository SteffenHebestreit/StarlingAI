/**
 * Tier 2 (execute, per-call approval) — Make arbitrary HTTP requests.
 *
 * Enables agents to interact with REST/GraphQL APIs, webhooks, and
 * external services.  Request bodies, headers, and query parameters
 * are fully configurable.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import { isPrivateHost } from "./web.js";

const log = childLogger("tool:http-request");
const MAX_RESPONSE_BODY = 64_000; // truncate large bodies
const MAX_REDIRECTS = 5;

/** SSRF predicate: private by literal OR by DNS (all address families, incl. IPv6). */
async function hostIsBlocked(host: string): Promise<boolean> {
  if (isPrivateHost(host)) return true;
  try {
    const records = await dnsLookup(host, { all: true });
    if (records.some((r) => isPrivateHost(r.address))) return true;
  } catch {
    /* DNS failure — IP literal / offline resolver; non-fatal */
  }
  return false;
}

registerTool({
  name: "http_request",
  description:
    "Make an HTTP request to an external URL. Supports GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS. " +
    "Use this for REST API calls, webhook triggers, GraphQL queries, or any HTTP interaction. " +
    "The response body is returned (truncated at 64 KB). " +
    "Requires per-call approval because it communicates with external services.",
  embeddingDescription: "Make HTTP request, call REST API, trigger webhook, send GraphQL query, curl equivalent. HTTP-Anfrage senden, API aufrufen, Webhook auslösen, REST-Endpoint abfragen.",
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "Full URL to request (must be http:// or https://).",
      },
      method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        description: "HTTP method (default: GET).",
        default: "GET",
      },
      headers: {
        type: "object",
        description: "Optional request headers as key-value pairs.",
        additionalProperties: { type: "string" },
      },
      body: {
        type: "string",
        description: "Optional request body (string). For JSON, stringify the object first.",
      },
      timeoutMs: {
        type: "number",
        description: "Request timeout in milliseconds (default: 30000, max: 120000).",
        default: 30000,
      },
    },
    required: ["url"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const url = String(args["url"] ?? "");
    const method = String(args["method"] ?? "GET").toUpperCase();
    const rawHeaders = args["headers"] as Record<string, string> | undefined;
    const body = args["body"] != null ? String(args["body"]) : undefined;
    const timeoutMs = Math.min(Math.max(Number(args["timeoutMs"] ?? 30000), 1000), 120_000);

    // Validate URL scheme
    if (!/^https?:\/\//i.test(url)) {
      return { success: false, output: "", error: "URL must start with http:// or https://" };
    }

    let originOrigin: string;
    try {
      originOrigin = new URL(url).origin;
    } catch {
      return { success: false, output: "", error: "Invalid URL" };
    }

    const headers = new Headers();
    if (rawHeaders) {
      for (const [key, value] of Object.entries(rawHeaders)) {
        headers.set(key, String(value));
      }
    }

    // Auto-set Content-Type for bodies when not explicitly provided
    if (body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      log.info({ url, method, sessionId: ctx.sessionId }, "http_request executing");

      // Follow redirects manually so we can (a) re-run the SSRF guard on EVERY hop
      // (a public URL can 30x-redirect to an internal host) and (b) DROP the caller's
      // headers when a hop crosses origins, so Authorization / X-Api-Key can't leak
      // to a third-party host. The single timer bounds the whole chain.
      let current = url;
      let currentHeaders = headers;
      let response: Response;
      for (let hop = 0; ; hop++) {
        const host = new URL(current).hostname;
        if (await hostIsBlocked(host)) {
          clearTimeout(timer);
          return { success: false, output: "", error: "Requesting private/internal network addresses is not allowed" };
        }
        response = await fetch(current, {
          method,
          headers: currentHeaders,
          body: ["GET", "HEAD", "OPTIONS"].includes(method) ? undefined : body,
          signal: controller.signal,
          redirect: "manual",
        });
        if (response.status < 300 || response.status >= 400 || !response.headers.has("location")) break;
        if (hop >= MAX_REDIRECTS) { clearTimeout(timer); return { success: false, output: "", error: "Too many redirects" }; }
        const next = new URL(response.headers.get("location")!, current);
        if (!/^https?:$/i.test(next.protocol)) { clearTimeout(timer); return { success: false, output: "", error: "Redirect to a non-http(s) scheme is not allowed" }; }
        if (next.origin !== originOrigin) currentHeaders = new Headers(); // strip caller headers cross-origin
        current = next.toString();
      }

      clearTimeout(timer);

      let responseBody: string;
      const contentType = response.headers.get("content-type") ?? "";

      if (method === "HEAD") {
        responseBody = "";
      } else {
        const raw = await response.text();
        responseBody = raw.length > MAX_RESPONSE_BODY
          ? raw.slice(0, MAX_RESPONSE_BODY) + `\n\n[... truncated at ${MAX_RESPONSE_BODY} chars]`
          : raw;
      }

      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => { responseHeaders[key] = value; });

      const output = [
        `HTTP ${response.status} ${response.statusText}`,
        `Content-Type: ${contentType}`,
        "",
        responseBody,
      ].join("\n");

      return {
        success: response.ok,
        output,
        metadata: {
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          bodyLength: responseBody.length,
        },
      };
    } catch (err) {
      clearTimeout(timer);
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ url, method, err }, "http_request failed");
      return {
        success: false,
        output: "",
        error: message.includes("aborted") ? `Request timed out after ${timeoutMs}ms` : message,
      };
    }
  },
});
