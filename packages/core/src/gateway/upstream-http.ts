/**
 * Upstream-HTTP + MCP-response utilities, extracted verbatim from the gateway god-file
 * (gateway/index.ts createGateway()). Pure, closure-free helpers shared by the model-endpoint
 * health probes and the multimodal (image/STT/TTS/file-conversion) proxy routes: timed fetch,
 * bearer-header assembly, upstream error/JSON extraction, Python-literal + MCP tool-result
 * parsing, and the disabled-service responses. No gateway/session/config state — every input is
 * an explicit argument, so these are independently testable and reusable.
 */
import { getMcpConnections } from "../mcp/registry.js";
import JSON5 from "json5";

export function upstreamUrl(baseUrl: string, routePath: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(routePath.replace(/^\//, ""), normalizedBase).toString();
}

export function upstreamHeaders(apiKey?: string, init: Record<string, string> | Headers = {}): Headers {
  const headers = new Headers(init);
  if (apiKey && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

export async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Request to ${url} failed: ${detail}`);
  } finally {
    clearTimeout(timer);
  }
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function summarizeUpstreamText(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return "empty response";
  return collapsed.length > 240 ? `${collapsed.slice(0, 237)}...` : collapsed;
}

export async function extractUpstreamError(response: Response, fallback: string): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";

  try {
    if (contentType.includes("application/json")) {
      const body = await response.json() as Record<string, unknown>;
      const detail = body["detail"] ?? body["error"] ?? body["message"];
      if (typeof detail === "string" && detail.trim()) {
        return detail.trim();
      }
      return fallback;
    }

    const text = await response.text();
    if (text.trim()) {
      return `${fallback}: ${summarizeUpstreamText(text)}`;
    }
  } catch {
    // Ignore parse failures and fall back to the generic message.
  }

  return fallback;
}

export async function parseUpstreamJsonResponse(response: Response, fallback: string): Promise<Record<string, unknown>> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    const text = await response.text();
    throw new Error(`${fallback}: ${summarizeUpstreamText(text)}`);
  }

  try {
    return await response.json() as Record<string, unknown>;
  } catch (error) {
    throw new Error(error instanceof Error ? `${fallback}: ${error.message}` : fallback);
  }
}

export function normalizePythonLiteralText(value: string): string {
  let output = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (let index = 0; index < value.length;) {
    const char = value[index];

    if (quote) {
      output += char;
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === quote) {
        quote = null;
      }
      index += 1;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      output += char;
      index += 1;
      continue;
    }

    const before = index === 0 ? "" : (value[index - 1] ?? "");
    const afterTrue = value[index + 4] ?? "";
    const afterFalse = value[index + 5] ?? "";
    const afterNone = value[index + 4] ?? "";
    const boundaryBefore = before === "" || /[^A-Za-z0-9_]/.test(before);

    if (boundaryBefore && value.startsWith("True", index) && (afterTrue === "" || /[^A-Za-z0-9_]/.test(afterTrue))) {
      output += "true";
      index += 4;
      continue;
    }

    if (boundaryBefore && value.startsWith("False", index) && (afterFalse === "" || /[^A-Za-z0-9_]/.test(afterFalse))) {
      output += "false";
      index += 5;
      continue;
    }

    if (boundaryBefore && value.startsWith("None", index) && (afterNone === "" || /[^A-Za-z0-9_]/.test(afterNone))) {
      output += "null";
      index += 4;
      continue;
    }

    output += char;
    index += 1;
  }

  return output;
}

export function parseMcpToolTextResponse(text: string, fallback: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(fallback);
  }

  try {
    return JSON5.parse(normalizePythonLiteralText(trimmed)) as Record<string, unknown>;
  } catch (error) {
    throw new Error(error instanceof Error ? `${fallback}: ${error.message}` : fallback);
  }
}

export async function callMultimodalToolViaMcp(input: {
  serverName: string;
  toolName: string;
  filename: string;
  contentType: string;
  fileBytes: ArrayBuffer;
  timeoutMs: number;
}): Promise<Record<string, unknown>> {
  const connection = getMcpConnections().get(input.serverName);
  if (!connection) {
    throw new Error(`Configured MCP server not connected: ${input.serverName}`);
  }

  const result = await withTimeout(
    connection.client.callTool({
      name: input.toolName,
      arguments: {
        filename: input.filename,
        content_type: input.contentType,
        base64_content: Buffer.from(input.fileBytes).toString("base64"),
      },
    }),
    input.timeoutMs,
    `MCP tool ${input.serverName}/${input.toolName}`,
  );

  const text = (result.content as Array<{ type: string; text?: string }> | undefined)
    ?.map(item => (item.type === "text" ? (item.text ?? "") : JSON.stringify(item)))
    .join("\n")
    .trim() ?? "";

  if ((result as { isError?: boolean }).isError) {
    throw new Error(text || `MCP tool ${input.serverName}/${input.toolName} failed`);
  }

  return parseMcpToolTextResponse(text, `MCP tool ${input.serverName}/${input.toolName} returned an unparsable response`);
}

export async function checkEndpointHealth(input: {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  path: string;
  method?: "GET" | "POST" | "OPTIONS";
  body?: FormData | string;
  headers?: Record<string, string>;
  successStatuses?: number[];
}): Promise<{ ok: boolean; status?: number; error?: string }> {
  const successStatuses = input.successStatuses ?? [200];

  try {
    const response = await fetchWithTimeout(
      upstreamUrl(input.baseUrl, input.path),
      {
        method: input.method ?? "GET",
        headers: upstreamHeaders(input.apiKey, input.headers),
        body: input.body,
      },
      Math.min(input.timeoutMs, 5000),
    );

    if (successStatuses.includes(response.status)) {
      return { ok: true, status: response.status };
    }

    return {
      ok: false,
      status: response.status,
      error: await extractUpstreamError(response, `Upstream returned HTTP ${response.status}`),
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function multimodalServiceConfigured(baseUrl: string | undefined): boolean {
  return typeof baseUrl === "string" && baseUrl.trim().length > 0;
}

// The fastapi-mcp-template wraps tool results as { success, result: {...} },
// so the actual { markdown, filename } payload lives under `.result`. Other
// backends return it at the top level. Normalize both so the upload endpoint
// (and the web composer, which reads result.markdown) see markdown directly.
// (Without this, attaching a file failed with "File conversion returned no
// markdown" because body.markdown was undefined.)
export function unwrapConversionResult(body: Record<string, unknown>): Record<string, unknown> {
  const inner = body["result"];
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  return body;
}

export function disabledServiceStatus(message: string): { ok: false; disabled: true; error: string } {
  return { ok: false, disabled: true, error: message };
}

export function disabledServiceResponse(message: string): Response {
  return Response.json({ error: message, disabled: true }, { status: 503 });
}
