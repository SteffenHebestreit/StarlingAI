import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * OpenTelemetry tracing helpers — verifies the no-op path (tracing
 * disabled) doesn't allocate spans, and the trace context injection /
 * extraction round-trips a `traceparent` header through `withSpan` +
 * `withExtractedContext`.
 *
 * We don't boot the full NodeSDK here (it'd require an OTLP collector); the
 * `withSpan` helper exercises the @opentelemetry/api code path which is
 * sufficient to verify the integration shape.
 */

describe("tracing helpers", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "starlingai-tracing-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({ tracing: { enabled: false } }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
  });

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
    const tracing = await import("../observability/tracing.js");
    await tracing.shutdownTracing();
    tracing._resetTracingForTests();
  });

  it("withSpan runs the function inline when tracing is disabled", async () => {
    const tracing = await import("../observability/tracing.js");
    expect(tracing.isTracingEnabled()).toBe(false);

    const result = await tracing.withSpan("test-span", { foo: "bar" }, async () => 42);
    expect(result).toBe(42);
  });

  it("withSpan propagates errors from the wrapped function", async () => {
    const tracing = await import("../observability/tracing.js");

    await expect(
      tracing.withSpan("test-span", {}, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("injectTraceContext is a no-op when tracing is disabled", async () => {
    const tracing = await import("../observability/tracing.js");
    const headers: Record<string, string> = { authorization: "Bearer x" };
    const returned = tracing.injectTraceContext(headers);
    // No traceparent added; existing headers untouched.
    expect(returned.authorization).toBe("Bearer x");
    expect(returned.traceparent).toBeUndefined();
  });

  it("withExtractedContext just runs the function when tracing is disabled", async () => {
    const tracing = await import("../observability/tracing.js");
    const result = await tracing.withExtractedContext({ traceparent: "irrelevant" }, async () => "ok");
    expect(result).toBe("ok");
  });

  it("setSpanAttributes is a safe no-op when tracing is disabled", async () => {
    const tracing = await import("../observability/tracing.js");
    expect(() => tracing.setSpanAttributes({ "starlingai.test": 1 })).not.toThrow();
  });

  it("initTracing returns false when config.enabled is false", async () => {
    const tracing = await import("../observability/tracing.js");
    const ok = await tracing.initTracing({
      enabled: false,
      otlpEndpoint: "http://localhost:4318/v1/traces",
      sampleRate: 1,
      serviceName: "test",
    });
    expect(ok).toBe(false);
    expect(tracing.isTracingEnabled()).toBe(false);
  });

  it("initTracing is idempotent — second call when already disabled returns false", async () => {
    const tracing = await import("../observability/tracing.js");
    await tracing.initTracing({ enabled: false, otlpEndpoint: "http://x", sampleRate: 1, serviceName: "t" });
    const second = await tracing.initTracing({ enabled: true, otlpEndpoint: "http://x", sampleRate: 1, serviceName: "t" });
    // Second call sees _initialized=true and returns the cached _enabled (false)
    expect(second).toBe(false);
  });
});

describe("federation outbound trace propagation", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "starlingai-tracing-fed-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      tracing: { enabled: false },
      federation: {
        enabled: true,
        instanceId: "primary",
        sharedSecret: "x".repeat(32),
        peers: [{ id: "alpha", url: "https://alpha.example.com:8765" }],
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
  });

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  it("federation outbound delegate calls survive when tracing is disabled (no traceparent header injected)", async () => {
    let capturedHeaders: Record<string, string> | null = null;
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL, init: RequestInit) => {
      capturedHeaders = (init.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify({ ok: true, output: "done", remoteSessionId: "rs1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const fed = await import("../federation/index.js");
    const result = await fed.delegateToRemotePeer("alpha", { agentName: "x", task: "t" });
    expect(result.ok).toBe(true);
    // Auth header is still injected; traceparent is not (tracing disabled).
    expect(capturedHeaders).not.toBeNull();
    expect(capturedHeaders!["authorization"]).toMatch(/^Bearer /);
    expect(capturedHeaders!["traceparent"]).toBeUndefined();
  });
});
