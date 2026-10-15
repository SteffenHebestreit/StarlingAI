import { describe, expect, it } from "vitest";
import {
  upstreamUrl,
  upstreamHeaders,
  summarizeUpstreamText,
  normalizePythonLiteralText,
  parseMcpToolTextResponse,
  unwrapConversionResult,
  multimodalServiceConfigured,
  disabledServiceStatus,
  disabledServiceResponse,
  extractUpstreamError,
  fetchWithTimeout,
  upstreamErrorText,
} from "../gateway/upstream-http.js";
import { createServer, type Server } from "node:http";

// Pure upstream-HTTP + MCP-parse helpers extracted from the gateway god-file.
describe("upstream-http helpers", () => {
  it("upstreamUrl joins base + path without double slashes and preserves the base path", () => {
    expect(upstreamUrl("http://svc:8000", "/v1/convert")).toBe("http://svc:8000/v1/convert");
    expect(upstreamUrl("http://svc:8000/", "v1/convert")).toBe("http://svc:8000/v1/convert");
  });

  it("upstreamHeaders adds a bearer only when an apiKey is given and none is present", () => {
    expect(upstreamHeaders("k").get("Authorization")).toBe("Bearer k");
    expect(upstreamHeaders(undefined).get("Authorization")).toBeNull();
    // does not clobber a caller-supplied Authorization
    expect(upstreamHeaders("k", { Authorization: "Bearer other" }).get("Authorization")).toBe("Bearer other");
  });

  it("summarizeUpstreamText collapses whitespace and truncates long bodies", () => {
    expect(summarizeUpstreamText("  a\n\n b  ")).toBe("a b");
    expect(summarizeUpstreamText("")).toBe("empty response");
    const long = summarizeUpstreamText("x".repeat(500));
    expect(long.endsWith("...")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(240);
  });

  it("normalizePythonLiteralText rewrites True/False/None outside strings only", () => {
    expect(normalizePythonLiteralText("{'ok': True, 'v': None, 'n': False}"))
      .toBe("{'ok': true, 'v': null, 'n': false}");
    // a literal inside a string is untouched
    expect(normalizePythonLiteralText("{'label': 'True story'}")).toBe("{'label': 'True story'}");
    // substrings of larger identifiers are untouched (boundary check)
    expect(normalizePythonLiteralText("Truthy")).toBe("Truthy");
  });

  it("parseMcpToolTextResponse parses JSON5 + Python-literal tool output, throws on empty", () => {
    expect(parseMcpToolTextResponse("{'markdown': 'hi', 'ok': True}", "fallback"))
      .toEqual({ markdown: "hi", ok: true });
    expect(() => parseMcpToolTextResponse("   ", "no content")).toThrow(/no content/);
  });

  it("unwrapConversionResult descends into a wrapping .result object, else returns the body", () => {
    expect(unwrapConversionResult({ result: { markdown: "m" } })).toEqual({ markdown: "m" });
    expect(unwrapConversionResult({ markdown: "top" })).toEqual({ markdown: "top" });
    expect(unwrapConversionResult({ result: [1, 2] })).toEqual({ result: [1, 2] }); // array is not a wrapper
  });

  it("multimodalServiceConfigured requires a non-blank base URL", () => {
    expect(multimodalServiceConfigured("http://svc")).toBe(true);
    expect(multimodalServiceConfigured("  ")).toBe(false);
    expect(multimodalServiceConfigured(undefined)).toBe(false);
  });

  it("disabled-service helpers carry the disabled flag", async () => {
    expect(disabledServiceStatus("off")).toEqual({ ok: false, disabled: true, error: "off" });
    const res = disabledServiceResponse("off");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "off", disabled: true });
  });
});

// 2026-10-14: only a bare string was read, so the speech service's real reason came back as
// "Transcription failed"; a timeout read "This operation was aborted" with the internal host.
describe("upstream errors, as the speech service sends them", () => {
  it("reads a string, OpenAI's {error: {message}} and FastAPI's validation list", () => {
    expect(upstreamErrorText("  model not found ")).toBe("model not found");
    expect(upstreamErrorText({ message: "Invalid voice", type: "invalid_request_error" })).toBe("Invalid voice");
    expect(upstreamErrorText([{ loc: ["body", "text"], msg: "Field required", type: "missing" }])).toBe("text: Field required");
    expect(upstreamErrorText({ detail: "upstream busy" })).toBe("upstream busy");
    expect(upstreamErrorText(42)).toBeUndefined();
  });

  it("extracts them from a response, and falls back when there is none", async () => {
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 400, headers: { "content-type": "application/json" } });
    expect(await extractUpstreamError(json({ error: { message: "unsupported response_format" } }), "Transcription failed")).toBe("unsupported response_format");
    expect(await extractUpstreamError(json({ detail: [{ loc: ["body", "file"], msg: "Field required" }] }), "Transcription failed")).toBe("file: Field required");
    expect(await extractUpstreamError(json({}), "Transcription failed")).toBe("Transcription failed");
  });

  it("says a request timed out, naming its path and not the service's host", async () => {
    const server: Server = createServer(() => { /* never answers */ });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    try {
      await expect(fetchWithTimeout(`http://127.0.0.1:${port}/v1/audio/speech`, {}, 200))
        .rejects.toThrow("Request to /v1/audio/speech timed out after 0 s");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
