import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  sanitizeAppRoot,
  injectBaseHref,
  buildServeRunArgs,
  listServedApps,
  __setDockerExecForTests,
  __setHealthProbeForTests,
  __setAppFetchForTests,
  __resetServedAppsForTests,
  type DockerExec,
  type AppFetch,
  type ServedApp,
} from "../tools/serve-app.js";
import { getTool } from "../tools/registry.js";

const ctx = { sessionId: "serve-test", workspacePath: "/tmp/ws" } as unknown as Parameters<NonNullable<ReturnType<typeof getTool>>["execute"]>[1];

function dockerSuccess(): DockerExec {
  return async (args) => {
    if (args[0] === "run") return { code: 0, stdout: "deadbeefcontainerid", stderr: "" };
    return { code: 0, stdout: "", stderr: "" }; // rm / logs
  };
}

describe("serve_app — pure helpers", () => {
  it("sanitizeAppRoot accepts a workspace-relative dir and normalizes slashes", () => {
    expect(sanitizeAppRoot("generated/my-app")).toBe("generated/my-app");
    expect(sanitizeAppRoot("generated\\my-app\\")).toBe("generated/my-app");
  });
  it("sanitizeAppRoot rejects traversal, absolute, and empty roots", () => {
    expect(sanitizeAppRoot("../etc")).toBeNull();
    expect(sanitizeAppRoot("generated/../../etc")).toBeNull();
    expect(sanitizeAppRoot("/abs/path")).toBeNull();
    expect(sanitizeAppRoot("C:\\Windows")).toBeNull();
    expect(sanitizeAppRoot("   ")).toBeNull();
  });

  it("injectBaseHref inserts a <base> after <head>, wraps bare <html>, prepends otherwise, and is a no-op when present", () => {
    expect(injectBaseHref("<html><head><title>x</title></head>", "/api/app/abc/")).toContain('<head><base href="/api/app/abc/">');
    expect(injectBaseHref("<html><body>x</body></html>", "/api/app/abc/")).toContain('<head><base href="/api/app/abc/"></head>');
    expect(injectBaseHref("just text", "/api/app/abc/")).toBe('<base href="/api/app/abc/">just text');
    expect(injectBaseHref('<head><base href="/other/"></head>', "/api/app/abc/")).not.toContain("/api/app/abc/");
  });

  it("buildServeRunArgs produces an isolated, named, networked container that binds $PORT and mounts the app dir", () => {
    const app: ServedApp = {
      id: "abc123", name: "demo", containerName: "sai-app-abc123", runtime: "node-express",
      internalPort: 3000, network: "starlingai-public", image: "node:22-alpine",
      root: "generated/demo", command: "node server.js", status: "starting", startedAt: Date.now(), sessionId: "s",
    };
    const args = buildServeRunArgs(app, "/host/ws/generated/demo");
    expect(args.slice(0, 2)).toEqual(["run", "-d"]);
    expect(args).toContain("--name"); expect(args).toContain("sai-app-abc123");
    expect(args).toContain("--network"); expect(args).toContain("starlingai-public");
    expect(args).toContain("--label"); expect(args).toContain("starlingai.app=abc123");
    expect(args).toContain("-e"); expect(args).toContain("PORT=3000");
    expect(args).toContain("-v"); expect(args).toContain("/host/ws/generated/demo:/app");
    expect(args).toContain("node:22-alpine");
    expect(args.slice(-3)).toEqual(["sh", "-lc", "node server.js"]);
    expect(args).toContain("--security-opt"); // no-new-privileges hardening
  });
});

describe("serve_app — lifecycle", () => {
  beforeEach(() => { __resetServedAppsForTests(); });
  afterEach(() => {
    __setDockerExecForTests(null);
    __setHealthProbeForTests(null);
    __resetServedAppsForTests();
    delete process.env["SAI_APP_HEALTH_TIMEOUT_MS"];
    delete process.env["SAI_APP_MAX"];
  });

  it("start launches a container, health-checks it, and returns a /api/app/<id>/ preview path", async () => {
    __setDockerExecForTests(dockerSuccess());
    __setHealthProbeForTests(async () => true);
    const tool = getTool("serve_app");
    expect(tool).toBeDefined();

    const res = await tool!.execute({ action: "start", root: "generated/demo", name: "Demo" }, ctx);
    expect(res.success).toBe(true);
    expect(String(res.metadata?.["previewPath"])).toMatch(/^\/api\/app\/[a-f0-9]{8}\/$/);
    expect(res.metadata?.["status"]).toBe("running");
    expect(listServedApps()).toHaveLength(1);
  });

  it("stop removes the app from the registry", async () => {
    __setDockerExecForTests(dockerSuccess());
    __setHealthProbeForTests(async () => true);
    const tool = getTool("serve_app")!;
    const started = await tool.execute({ action: "start", root: "generated/demo" }, ctx);
    const id = String(started.metadata?.["id"]);
    const stopped = await tool.execute({ action: "stop", id }, ctx);
    expect(stopped.success).toBe(true);
    expect(listServedApps()).toHaveLength(0);
  });

  it("reports failure (with logs) when the server never becomes reachable", async () => {
    process.env["SAI_APP_HEALTH_TIMEOUT_MS"] = "1";
    __setDockerExecForTests(async (args) => (args[0] === "run"
      ? { code: 0, stdout: "cid", stderr: "" }
      : { code: 0, stdout: "Error: listen EACCES", stderr: "" }));
    __setHealthProbeForTests(async () => false);
    const res = await getTool("serve_app")!.execute({ action: "start", root: "generated/demo" }, ctx);
    expect(res.success).toBe(false);
    expect(res.metadata?.["status"]).toBe("failed");
    expect(res.output).toContain("listen EACCES");
  });

  it("rejects an unsafe root and a missing root", async () => {
    const tool = getTool("serve_app")!;
    expect((await tool.execute({ action: "start", root: "../escape" }, ctx)).success).toBe(false);
    expect((await tool.execute({ action: "start" }, ctx)).success).toBe(false);
  });

  it("enforces the running-app cap", async () => {
    process.env["SAI_APP_MAX"] = "1";
    __setDockerExecForTests(dockerSuccess());
    __setHealthProbeForTests(async () => true);
    const tool = getTool("serve_app")!;
    expect((await tool.execute({ action: "start", root: "generated/a" }, ctx)).success).toBe(true);
    const second = await tool.execute({ action: "start", root: "generated/b" }, ctx);
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/too many running apps/i);
  });
});

describe("verify_app — self-inspecting build verification", () => {
  // Start a healthy app (so the registry has a running entry), with docker logs
  // returning whatever `logs` we want verify_app to scan.
  async function startRunningApp(logs = ""): Promise<string> {
    const exec: DockerExec = async (args) => {
      if (args[0] === "run") return { code: 0, stdout: "cid", stderr: "" };
      if (args[0] === "logs") return { code: 0, stdout: logs, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    __setDockerExecForTests(exec);
    __setHealthProbeForTests(async () => true);
    const started = await getTool("serve_app")!.execute({ action: "start", root: "generated/demo" }, ctx);
    return String(started.metadata?.["id"]);
  }
  const fetchReturning = (r: Partial<{ status: number; contentType: string; body: string; error: string }>): AppFetch =>
    async () => ({ status: r.status ?? 200, contentType: r.contentType ?? "text/html", body: r.body ?? "", error: r.error });

  beforeEach(() => { __resetServedAppsForTests(); });
  afterEach(() => {
    __setDockerExecForTests(null);
    __setHealthProbeForTests(null);
    __setAppFetchForTests(null);
    __resetServedAppsForTests();
  });

  it("PASSES when the app responds 2xx with the expected content", async () => {
    const id = await startRunningApp("Server listening on 3000");
    __setAppFetchForTests(fetchReturning({ status: 200, body: "<h1>Rate Limiter Dashboard</h1>" }));
    const res = await getTool("verify_app")!.execute({ id, expectContent: "Rate Limiter Dashboard" }, ctx);
    expect(res.success).toBe(true);
    expect(res.metadata?.["verdict"]).toBe("pass");
    expect(res.metadata?.["contentPresent"]).toBe(true);
    expect(res.output).toContain("✅ PASS");
  });

  it("returns RENDER UNCONFIRMED for a client-rendered shell (map/canvas/SPA) instead of falsely PASSing", async () => {
    const id = await startRunningApp("Server listening on 3000");
    // A Leaflet shell: server answers 200 with the mount root + scripts, but the
    // map only paints in a browser — a JS error would leave this same shell.
    const shell = '<!DOCTYPE html><html><head><link rel="stylesheet" href="leaflet.css"/></head>'
      + '<body><div id="map"></div><script src="leaflet.js"></script><script>const m=L.map("map");</script></body></html>';
    __setAppFetchForTests(fetchReturning({ status: 200, body: shell }));
    const res = await getTool("verify_app")!.execute({ id, expectContent: "map" }, ctx);
    // The server check passed, so success is true — but the verdict is explicitly render-unconfirmed.
    expect(res.success).toBe(true);
    expect(res.metadata?.["clientRendered"]).toBe(true);
    expect(res.metadata?.["renderConfirmed"]).toBe(false);
    expect(res.output).toContain("RENDER UNCONFIRMED");
    expect(res.output).toMatch(/browser_navigate|browser_snapshot|browser_evaluate/);
  });

  it("does NOT flag a server-rendered page as client-rendered (no false render caveat)", async () => {
    const id = await startRunningApp("Server listening on 3000");
    __setAppFetchForTests(fetchReturning({ status: 200, body: "<h1>Report</h1><p>" + "x".repeat(500) + "</p>" }));
    const res = await getTool("verify_app")!.execute({ id, expectContent: "Report" }, ctx);
    expect(res.success).toBe(true);
    expect(res.metadata?.["clientRendered"]).toBe(false);
    expect(res.output).toContain("✅ PASS");
  });

  it("FAILS on a non-2xx HTTP status and gives a route fix hint", async () => {
    const id = await startRunningApp();
    __setAppFetchForTests(fetchReturning({ status: 500, body: "Internal Server Error" }));
    const res = await getTool("verify_app")!.execute({ id }, ctx);
    expect(res.success).toBe(false);
    expect(res.metadata?.["verdict"]).toBe("fail");
    expect(res.output).toMatch(/HTTP 500/);
    expect(res.error).toMatch(/HTTP 500/);
  });

  it("FAILS when the expected content is missing even on a 200", async () => {
    const id = await startRunningApp();
    __setAppFetchForTests(fetchReturning({ status: 200, body: "<h1>Wrong Page</h1>" }));
    const res = await getTool("verify_app")!.execute({ id, expectContent: "Rate Limiter" }, ctx);
    expect(res.success).toBe(false);
    expect(res.metadata?.["contentPresent"]).toBe(false);
    expect(res.output).toMatch(/was NOT found/);
  });

  it("FAILS when the app is unreachable and hints at the 0.0.0.0:$PORT bind", async () => {
    const id = await startRunningApp();
    __setAppFetchForTests(fetchReturning({ status: 0, error: "ECONNREFUSED" }));
    const res = await getTool("verify_app")!.execute({ id }, ctx);
    expect(res.success).toBe(false);
    expect(res.output).toMatch(/UNREACHABLE/);
    expect(res.output).toMatch(/0\.0\.0\.0:\$PORT/);
  });

  it("surfaces fatal runtime error lines from the container logs", async () => {
    const id = await startRunningApp("Error: Cannot find module 'express'\n    at require (node:internal)");
    __setAppFetchForTests(fetchReturning({ status: 200, body: "<h1>ok</h1>" }));
    const res = await getTool("verify_app")!.execute({ id, expectContent: "ok" }, ctx);
    expect(Array.isArray(res.metadata?.["errorLogLines"])).toBe(true);
    expect((res.metadata?.["errorLogLines"] as string[]).join(" ")).toMatch(/Cannot find module/);
  });

  it("errors for an unknown id", async () => {
    __resetServedAppsForTests();
    const res = await getTool("verify_app")!.execute({ id: "nope" }, ctx);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/No app with id/);
  });
});
