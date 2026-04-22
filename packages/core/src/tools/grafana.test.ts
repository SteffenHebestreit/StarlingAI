import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../credentials/store.js", () => ({
  getCredential: vi.fn((name: string) => name === "grafana_key" ? "stored-grafana-key" : undefined),
}));

async function setupGrafanaConfig() {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-grafana-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    monitoring: {
      defaultGrafana: "prod",
      grafana: {
        prod: {
          baseUrl: "https://grafana.example.com",
          apiKey: "secret:grafana_key",
          orgId: 2,
          timeoutMs: 30000,
        },
      },
    },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  return tempDir;
}

describe("grafana tools", () => {
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
    vi.resetModules();
  });

  it("registers all Wave 4 Grafana tools", async () => {
    const [{ getAllTools }] = await Promise.all([
      import("./registry.js"),
      import("./grafana.js"),
    ]);
    const names = getAllTools().map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      "grafana_dashboard_search",
      "grafana_alerts_list",
      "grafana_dashboard_apply",
      "grafana_alert_apply",
    ]));
  });

  it("grafana_dashboard_search builds query + tag + limit + org header", async () => {
    cleanup.push(await setupGrafanaConfig());
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify([{ uid: "abc", title: "API" }]),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./grafana.js"),
    ]);

    const result = await getTool("grafana_dashboard_search")!.execute({
      query: "api",
      tags: ["prod", "latency"],
      limit: 25,
    }, { sessionId: "s1", workspacePath: "/workspace" });

    expect(result.success).toBe(true);
    expect(result.metadata?.["count"]).toBe(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const urlStr = String(url);
    expect(urlStr).toContain("/api/search?");
    expect(urlStr).toContain("query=api");
    expect(urlStr).toContain("tag=prod");
    expect(urlStr).toContain("tag=latency");
    expect(urlStr).toContain("limit=25");
    expect(urlStr).toContain("type=dash-db");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer stored-grafana-key");
    expect(headers["X-Grafana-Org-Id"]).toBe("2");
  });

  it("grafana_alerts_list scopes to a folder when provided", async () => {
    cleanup.push(await setupGrafanaConfig());
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify([]),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./grafana.js"),
    ]);

    await getTool("grafana_alerts_list")!.execute({
      folder: "folder-abc",
    }, { sessionId: "s1", workspacePath: "/workspace" });

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/api/v1/provisioning/folder/folder-abc/rule-groups");
  });

  it("grafana_alerts_list falls back to the unscoped endpoint when no folder", async () => {
    cleanup.push(await setupGrafanaConfig());
    fetchMock.mockResolvedValue(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./grafana.js"),
    ]);

    await getTool("grafana_alerts_list")!.execute({}, { sessionId: "s1", workspacePath: "/workspace" });

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toMatch(/\/api\/v1\/provisioning\/alert-rules$/);
  });

  it("grafana_dashboard_apply rejects non-object dashboard", async () => {
    cleanup.push(await setupGrafanaConfig());
    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./grafana.js"),
    ]);

    const result = await getTool("grafana_dashboard_apply")!.execute({
      dashboard: "not-an-object",
    }, { sessionId: "s1", workspacePath: "/workspace" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("JSON object");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("grafana_dashboard_apply POSTs the expected body with overwrite + folderUid", async () => {
    cleanup.push(await setupGrafanaConfig());
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ id: 42, uid: "abc", url: "/d/abc", status: "success" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./grafana.js"),
    ]);

    const result = await getTool("grafana_dashboard_apply")!.execute({
      dashboard: { uid: "abc", title: "API Latency", panels: [] },
      folderUid: "platform",
      message: "add p95 panel",
      overwrite: true,
    }, { sessionId: "s1", workspacePath: "/workspace" });

    expect(result.success).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/api\/dashboards\/db$/);
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.dashboard.uid).toBe("abc");
    expect(body.folderUid).toBe("platform");
    expect(body.message).toBe("add p95 panel");
    expect(body.overwrite).toBe(true);
  });

  it("grafana_alert_apply uses POST for create and PUT for update", async () => {
    cleanup.push(await setupGrafanaConfig());
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ uid: "rule-1" }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./grafana.js"),
    ]);

    await getTool("grafana_alert_apply")!.execute({
      rule: { title: "High latency", folderUID: "prod", ruleGroup: "api" },
    }, { sessionId: "s1", workspacePath: "/workspace" });

    const createCall = fetchMock.mock.calls[0];
    expect(String(createCall?.[0])).toMatch(/\/provisioning\/alert-rules$/);
    expect((createCall?.[1] as RequestInit).method).toBe("POST");

    await getTool("grafana_alert_apply")!.execute({
      rule: { title: "High latency", folderUID: "prod", ruleGroup: "api" },
      uid: "rule-1",
      disableProvenance: true,
    }, { sessionId: "s1", workspacePath: "/workspace" });

    const updateCall = fetchMock.mock.calls[1];
    expect(String(updateCall?.[0])).toMatch(/\/provisioning\/alert-rules\/rule-1$/);
    expect((updateCall?.[1] as RequestInit).method).toBe("PUT");
    const updateHeaders = (updateCall?.[1] as RequestInit).headers as Record<string, string>;
    expect(updateHeaders["X-Disable-Provenance"]).toBe("true");
  });

  it("surfaces Grafana HTTP errors cleanly", async () => {
    cleanup.push(await setupGrafanaConfig());
    fetchMock.mockResolvedValue(new Response("forbidden", { status: 403 }));

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./grafana.js"),
    ]);

    const result = await getTool("grafana_dashboard_search")!.execute({}, { sessionId: "s1", workspacePath: "/workspace" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("HTTP 403");
  });

  it("surfaces a clear error when no Grafana instance is configured", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-grafana-empty-"));
    cleanup.push(tempDir);
    writeFileSync(join(tempDir, "starlingai.json"), JSON.stringify({
      monitoring: { grafana: {}, prometheus: {}, alertmanager: {} },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./grafana.js"),
    ]);

    const result = await getTool("grafana_dashboard_search")!.execute({}, { sessionId: "s1", workspacePath: "/workspace" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("No Grafana instance");
  });
});
