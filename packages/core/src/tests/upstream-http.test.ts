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
} from "../gateway/upstream-http.js";

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
