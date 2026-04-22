import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../credentials/store.js", () => ({
  getCredential: vi.fn((name: string) => name === "prom_token" ? "stored-prom-token" : undefined),
}));

async function setupMonitoringConfig(extra: Record<string, unknown> = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-prom-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    monitoring: {
      defaultPrometheus: "prod",
      defaultAlertmanager: "prod",
      prometheus: {
        prod: {
          baseUrl: "https://prometheus.example.com",
          bearerToken: "secret:prom_token",
          timeoutMs: 30000,
        },
        staging: {
          baseUrl: "https://prom-staging.example.com",
          basicAuth: { username: "ops", password: "$STAGING_PW" },
          timeoutMs: 30000,
        },
      },
      alertmanager: {
        prod: {
          baseUrl: "https://alerts.example.com",
          bearerToken: "secret:prom_token",
          timeoutMs: 30000,
        },
      },
      ...extra,
    },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  return tempDir;
}

describe("prometheus + alertmanager tools", () => {
  const cleanup: string[] = [];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const dir of cleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["STAGING_PW"];
    vi.resetModules();
  });

  it("registers all Wave 3 monitoring tools", async () => {
    const [{ getAllTools }] = await Promise.all([
      import("./registry.js"),
      import("./prometheus.js"),
    ]);
    const names = getAllTools().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      "prometheus_query",
      "alertmanager_silences_list",
      "alertmanager_silence_create",
      "alertmanager_silence_expire",
    ]));
  });

  it("prometheus_query runs an instant query and resolves bearer token", async () => {
    cleanup.push(await setupMonitoringConfig());
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ status: "success", data: { resultType: "vector", result: [] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./prometheus.js"),
    ]);

    const result = await getTool("prometheus_query")!.execute({
      expr: "up",
    }, { sessionId: "s1", workspacePath: "/workspace" });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("https://prometheus.example.com/api/v1/query?query=up");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer stored-prom-token");
    expect(result.metadata?.["mode"]).toBe("instant");
  });

  it("prometheus_query switches to /query_range when start+end+step provided", async () => {
    cleanup.push(await setupMonitoringConfig());
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ status: "success", data: { resultType: "matrix", result: [] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./prometheus.js"),
    ]);

    const result = await getTool("prometheus_query")!.execute({
      expr: "rate(http_requests_total[5m])",
      start: "2026-04-22T08:00:00Z",
      end: "2026-04-22T09:00:00Z",
      step: "60s",
    }, { sessionId: "s1", workspacePath: "/workspace" });

    expect(result.success).toBe(true);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/api/v1/query_range");
    expect(url).toContain("start=2026-04-22T08");
    expect(url).toContain("step=60s");
    expect(result.metadata?.["mode"]).toBe("range");
  });

  it("prometheus_query rejects partial range params", async () => {
    cleanup.push(await setupMonitoringConfig());
    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./prometheus.js"),
    ]);

    const result = await getTool("prometheus_query")!.execute({
      expr: "up",
      start: "2026-04-22T08:00:00Z",
    }, { sessionId: "s1", workspacePath: "/workspace" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("start, end, and step");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prometheus_query surfaces non-2xx responses as failure", async () => {
    cleanup.push(await setupMonitoringConfig());
    fetchMock.mockResolvedValue(new Response("bad query", { status: 400 }));

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./prometheus.js"),
    ]);

    const result = await getTool("prometheus_query")!.execute({
      expr: "invalid syntax!",
    }, { sessionId: "s1", workspacePath: "/workspace" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("HTTP 400");
  });

  it("prometheus_query resolves basic-auth credentials with env refs", async () => {
    process.env["STAGING_PW"] = "env-staging-password";
    cleanup.push(await setupMonitoringConfig());
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ status: "success", data: {} }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./prometheus.js"),
    ]);

    await getTool("prometheus_query")!.execute({
      expr: "up",
      instance: "staging",
    }, { sessionId: "s1", workspacePath: "/workspace" });

    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Basic ${Buffer.from("ops:env-staging-password").toString("base64")}`);
  });

  it("alertmanager_silences_list appends filter query and returns parsed body", async () => {
    cleanup.push(await setupMonitoringConfig());
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify([{ id: "abc", comment: "maintenance" }]),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./prometheus.js"),
    ]);

    const result = await getTool("alertmanager_silences_list")!.execute({
      filter: 'service="api"',
    }, { sessionId: "s1", workspacePath: "/workspace" });

    expect(result.success).toBe(true);
    expect(result.metadata?.["count"]).toBe(1);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/api/v2/silences?filter=");
  });

  it("alertmanager_silence_create requires matchers, comment, and endsAt|durationMinutes", async () => {
    cleanup.push(await setupMonitoringConfig());
    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./prometheus.js"),
    ]);
    const tool = getTool("alertmanager_silence_create")!;

    const missingDuration = await tool.execute({
      matchers: [{ name: "service", value: "api" }],
      comment: "maintenance",
      createdBy: "ops@example.com",
    }, { sessionId: "s1", workspacePath: "/workspace" });
    expect(missingDuration.success).toBe(false);
    expect(missingDuration.error).toContain("endsAt or durationMinutes");

    const bothDuration = await tool.execute({
      matchers: [{ name: "service", value: "api" }],
      comment: "maintenance",
      createdBy: "ops@example.com",
      endsAt: "2026-04-22T10:00:00Z",
      durationMinutes: 60,
    }, { sessionId: "s1", workspacePath: "/workspace" });
    expect(bothDuration.success).toBe(false);
    expect(bothDuration.error).toContain("mutually exclusive");
  });

  it("alertmanager_silence_create POSTs the expected body", async () => {
    cleanup.push(await setupMonitoringConfig());
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ silenceID: "silence-99" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./prometheus.js"),
    ]);

    const before = Date.now();
    const result = await getTool("alertmanager_silence_create")!.execute({
      matchers: [
        { name: "service", value: "api" },
        { name: "severity", value: "warning|info", isRegex: true },
      ],
      comment: "planned maintenance window",
      createdBy: "ops@example.com",
      durationMinutes: 30,
    }, { sessionId: "s1", workspacePath: "/workspace" });

    expect(result.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/api/v2/silences");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.matchers).toHaveLength(2);
    expect(body.matchers[1]).toEqual({ name: "severity", value: "warning|info", isRegex: true, isEqual: true });
    expect(body.createdBy).toBe("ops@example.com");
    expect(body.comment).toBe("planned maintenance window");
    const endsAt = new Date(body.endsAt).getTime();
    expect(endsAt).toBeGreaterThan(before + 28 * 60_000);
    expect(endsAt).toBeLessThan(Date.now() + 32 * 60_000);
  });

  it("alertmanager_silence_expire DELETEs the silence id", async () => {
    cleanup.push(await setupMonitoringConfig());
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./prometheus.js"),
    ]);

    const result = await getTool("alertmanager_silence_expire")!.execute({
      silenceId: "silence-99",
    }, { sessionId: "s1", workspacePath: "/workspace" });

    expect(result.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("/api/v2/silence/silence-99");
    expect((init as RequestInit).method).toBe("DELETE");
  });

  it("surfaces a clear error when no Prometheus instance is configured", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-prom-empty-"));
    cleanup.push(tempDir);
    writeFileSync(join(tempDir, "starlingai.json"), JSON.stringify({
      monitoring: { prometheus: {}, alertmanager: {}, grafana: {} },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./prometheus.js"),
    ]);

    const result = await getTool("prometheus_query")!.execute({
      expr: "up",
    }, { sessionId: "s1", workspacePath: "/workspace" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("No Prometheus instance");
  });
});
