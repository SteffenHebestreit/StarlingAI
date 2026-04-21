/**
 * Tier 2 (execute, per-call approval) — Make arbitrary HTTP requests.
 *
 * Enables agents to interact with REST/GraphQL APIs, webhooks, and
 * external services.  Request bodies, headers, and query parameters
 * are fully configurable.
 */
import { resolve as dnsResolve } from "node:dns/promises";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import { isPrivateHost } from "./web.js";

const log = childLogger("tool:http-request");
const MAX_RESPONSE_BODY = 64_000; // truncate large bodies

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

    // SSRF guard — reject loopback, RFC1918, link-local, and cloud-metadata targets.
    // Also DNS-resolve to catch hostnames that point at internal IPs.
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      if (isPrivateHost(host)) {
        return { success: false, output: "", error: "Requesting private/internal network addresses is not allowed" };
      }
      try {
        const addrs = await dnsResolve(host);
        if (addrs.some((addr) => isPrivateHost(addr))) {
          return { success: false, output: "", error: "Requesting private/internal network addresses is not allowed" };
        }
      } catch {
        // DNS failure is non-fatal — could be an IP literal or unavailable resolver.
      }
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

      const response = await fetch(url, {
        method,
        headers,
        body: ["GET", "HEAD", "OPTIONS"].includes(method) ? undefined : body,
        signal: controller.signal,
      });

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
