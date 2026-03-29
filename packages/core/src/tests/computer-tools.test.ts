import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateComputerUseConfig } from "../config/computer-use-schema.js";

const PNG_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO9WZ4QAAAAASUVORK5CYII=";

let configLoader: typeof import("../config/loader.js");
let executeTool: typeof import("../tools/registry.js").executeTool;
let computerSessionManager: typeof import("../agent/computer-session.js").computerSessionManager;
let resetComputerAdapterRuntimeForTests: typeof import("../agent/computer-adapters/runtime.js").resetComputerAdapterRuntimeForTests;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("computer tools", () => {
  let tempDir = "";
  let configPath = "";
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "starlingai-computer-tools-"));
    configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      workspacePath: tempDir,
      computerUse: {
        enabled: true,
        adapters: {
          remote_node: {
            baseUrl: "http://node.test",
            authToken: "secret-token",
            timeoutMs: 5000,
            label: "Lab workstation",
          },
        },
        remoteAccessService: {
          baseUrl: "http://computer-remote.test",
          authToken: "sidecar-token",
          timeoutMs: 8000,
          label: "Computer remote sidecar",
        },
        nodes: {
          desktop: {
            adapter: "remote_vnc",
            host: "10.10.0.2",
            port: 5901,
            protocol: "vnc",
            credentials: "starling",
            reconnectAttempts: 1,
            reconnectDelayMs: 100,
            label: "Remote desktop via sidecar",
          },
          "win-workstation": {
            adapter: "remote_rdp",
            host: "10.10.0.3",
            port: 3389,
            protocol: "rdp",
            credentials: "Administrator:password",
            displayResolution: "1920x1080",
            reconnectAttempts: 1,
            reconnectDelayMs: 100,
            label: "Windows workstation via RDP",
          },
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    configLoader = await import("../config/loader.js");
    ({ executeTool } = await import("../tools/registry.js"));
    ({ computerSessionManager } = await import("../agent/computer-session.js"));
    ({ resetComputerAdapterRuntimeForTests } = await import("../agent/computer-adapters/runtime.js"));
    await import("../tools/computer-use.js");
    configLoader.resetConfigForTests();
    configLoader.loadConfig();

    fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/sessions/start")) {
        const payload = JSON.parse(String(init?.body ?? "{}")) as {
          target?: { config?: { displayResolution?: string } };
        };
        const match = /^(\d+)x(\d+)$/u.exec(payload.target?.config?.displayResolution ?? "");
        const width = match ? Number(match[1]) : 1;
        const height = match ? Number(match[2]) : 1;
        return jsonResponse({
          ok: true,
          sessionId: "bridge-session",
          topology: {
            monitors: [{ id: 0, x: 0, y: 0, width, height, dpiScale: 1 }],
            primary: 0,
          },
        });
      }
      if (url.endsWith("/sessions/stop")) {
        return jsonResponse({ ok: true, sessionId: "bridge-session" });
      }
      if (url.endsWith("/health")) {
        return jsonResponse({ ok: true, healthy: true, label: "Lab workstation", platform: "win32" });
      }
      if (url.endsWith("/display-topology")) {
        return jsonResponse({
          topology: {
            monitors: [{ id: 0, x: 0, y: 0, width: 1, height: 1, dpiScale: 1 }],
            primary: 0,
          },
        });
      }
      if (url.endsWith("/snapshot")) {
        return jsonResponse({
          screenshotHash: "snapshot-hash",
          timestamp: Date.now(),
          frameId: "frame-1",
          dataUrl: PNG_DATA_URL,
          width: 1,
          height: 1,
        });
      }
      if (url.endsWith("/action")) {
        const payload = JSON.parse(String(init?.body ?? "{}")) as { action?: { type?: string } };
        const actionType = payload.action?.type ?? "unknown";
        return jsonResponse({
          success: true,
          output: `Executed ${actionType}`,
          durationMs: 4,
          screenshotDataUrl: PNG_DATA_URL,
          screenshotWidth: 1,
          screenshotHeight: 1,
          screenshotHash: `hash-${actionType}`,
        });
      }
      return jsonResponse({ error: `Unexpected request: ${url}` }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await resetComputerAdapterRuntimeForTests();
    computerSessionManager.resetForTests();
    configLoader.resetConfigForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("validates remote_node adapter config", () => {
    const config = validateComputerUseConfig({
      enabled: true,
      adapters: {
        remote_node: {
          baseUrl: "http://10.10.0.2:8877",
          authToken: "token-value",
          timeoutMs: 12000,
          label: "Windows host",
        },
      },
    });

    expect(config.adapters.remote_node?.baseUrl).toBe("http://10.10.0.2:8877");
    expect(config.adapters.remote_node?.timeoutMs).toBe(12000);
    expect(config.adapters.remote_node?.label).toBe("Windows host");
  });

  it("starts remote-node sessions and emits snapshots/actions", async () => {
    const seenStates: string[] = [];
    const seenActions: string[] = [];
    const seenScreenshots: string[] = [];
    const ctx = {
      sessionId: "controller-1",
      workspacePath: tempDir,
      approvalCallback: async () => true,
      onComputerSessionState(event: { state: string }) {
        seenStates.push(event.state);
      },
      onComputerAction(event: { actionType: string }) {
        seenActions.push(event.actionType);
      },
      onComputerScreenshot(event: { dataUrl: string }) {
        seenScreenshots.push(event.dataUrl);
      },
    };

    const start = await executeTool("computer_session_start", { adapter: "remote_node" }, ctx);
    expect(start.success).toBe(true);
    const sessionId = String(start.metadata?.["sessionId"]);
    expect(sessionId).not.toHaveLength(0);
    expect(computerSessionManager.getSession(sessionId)?.adapter).toBe("remote_node");
    expect(seenStates).toContain("active");

    const snapshot = await executeTool("computer_snapshot", { sessionId }, ctx);
    expect(snapshot.success).toBe(true);
    expect(snapshot.output).toContain("[Desktop Snapshot");
    expect(seenScreenshots).toHaveLength(1);

    const click = await executeTool("computer_click", { sessionId, x: 0, y: 0 }, ctx);
    expect(click.success).toBe(true);
    expect(click.output).toContain("Executed click");
    expect(seenActions).toContain("click");
    expect(seenScreenshots).toHaveLength(2);

    const authHeaders = fetchMock.mock.calls.map(([, init]) => (init?.headers as Record<string, string> | undefined)?.authorization).filter(Boolean);
    expect(authHeaders).toContain("Bearer secret-token");
  });

  it("gracefully degrades window enumeration failures", async () => {
    fetchMock.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/health")) {
        return jsonResponse({ ok: true, healthy: true, label: "Lab workstation", platform: "win32" });
      }
      if (url.endsWith("/display-topology")) {
        return jsonResponse({
          topology: {
            monitors: [{ id: 0, x: 0, y: 0, width: 1920, height: 1080, dpiScale: 1 }],
            primary: 0,
          },
        });
      }
      if (url.endsWith("/windows")) {
        return jsonResponse({ error: "Internal Server Error" }, 500);
      }
      if (url.endsWith("/snapshot")) {
        return jsonResponse({
          screenshotHash: "snapshot-hash",
          timestamp: Date.now(),
          frameId: "frame-1",
          dataUrl: PNG_DATA_URL,
          width: 1920,
          height: 1080,
        });
      }
      if (url.endsWith("/action")) {
        return jsonResponse({ success: true, output: "Executed action", durationMs: 4 });
      }
      return jsonResponse({ error: `Unexpected request: ${url}` }, 404);
    });

    const ctx = {
      sessionId: "controller-windows-fallback",
      workspacePath: tempDir,
      approvalCallback: async () => true,
    };

    const start = await executeTool("computer_session_start", { adapter: "remote_node" }, ctx);
    expect(start.success).toBe(true);
    const sessionId = String(start.metadata?.["sessionId"]);

    const windows = await executeTool("computer_list_windows", { sessionId }, ctx);
    expect(windows.success).toBe(true);
    expect(windows.output).toContain("Window enumeration is temporarily unavailable");
    expect(windows.output).toContain("Continue with computer_snapshot");
  });

  it("rejects non-numeric click coordinates before calling the node", async () => {
    const ctx = {
      sessionId: "controller-click-validate",
      workspacePath: tempDir,
      approvalCallback: async () => true,
    };

    const start = await executeTool("computer_session_start", { adapter: "remote_node" }, ctx);
    expect(start.success).toBe(true);
    const sessionId = String(start.metadata?.["sessionId"]);

    const beforeCalls = fetchMock.mock.calls.length;
    const click = await executeTool("computer_click", { sessionId, element: "title bar", ref: "(3600, 50)" }, ctx);
    expect(click.success).toBe(false);
    expect(click.error).toContain("requires numeric 'x' and 'y' arguments");
    expect(fetchMock.mock.calls.length).toBe(beforeCalls);
  });

  it("auto-resumes a paused session when a tool call arrives", async () => {
    const ctx = {
      sessionId: "controller-resume",
      workspacePath: tempDir,
      approvalCallback: async () => true,
    };

    // Start a session
    const start = await executeTool("computer_session_start", { adapter: "remote_node" }, ctx);
    expect(start.success).toBe(true);
    const sessionId = String(start.metadata?.["sessionId"]);
    expect(computerSessionManager.getSession(sessionId)?.state).toBe("active");

    // Manually transition to paused (simulates heartbeat timeout)
    const session = computerSessionManager.getSession(sessionId)!;
    (session as Record<string, unknown>).state = "paused";
    expect(computerSessionManager.getSession(sessionId)?.state).toBe("paused");

    // Tool call should auto-resume the session instead of failing
    const snapshot = await executeTool("computer_snapshot", { sessionId }, ctx);
    expect(snapshot.success).toBe(true);
    expect(computerSessionManager.getSession(sessionId)?.state).toBe("active");
  });

  it("maps local_desktop requests onto the configured remote desktop node", async () => {
    const start = await executeTool("computer_session_start", { adapter: "local_desktop" }, {
      sessionId: "controller-2",
      workspacePath: tempDir,
      approvalCallback: async () => true,
    });

    expect(start.success).toBe(true);
    const sessionId = String(start.metadata?.["sessionId"]);
    expect(sessionId).not.toHaveLength(0);
    expect(start.metadata?.["requestedAdapter"]).toBe("local_desktop");
    expect(start.metadata?.["adapter"]).toBe("remote_node");
    expect(computerSessionManager.getSession(sessionId)?.adapter).toBe("remote_node");
    expect(start.output).toContain("Requested adapter: local_desktop");
    expect(start.output).toContain("Adapter: remote_node");
  });

  it("reuses an existing active session instead of creating a duplicate", async () => {
    const ctx = {
      sessionId: "controller-idem",
      workspacePath: tempDir,
      approvalCallback: async () => true,
    };

    const first = await executeTool("computer_session_start", { adapter: "remote_node" }, ctx);
    expect(first.success).toBe(true);
    const sessionId = String(first.metadata?.["sessionId"]);

    const second = await executeTool("computer_session_start", { adapter: "remote_node" }, ctx);
    expect(second.success).toBe(true);
    expect(String(second.metadata?.["sessionId"])).toBe(sessionId);
    expect(second.metadata?.["reused"]).toBe(true);
    expect(second.output).toContain("already active");
  });

  it("routes named remote_vnc nodes through the remote access sidecar", async () => {
    const ctx = {
      sessionId: "controller-sidecar",
      workspacePath: tempDir,
      approvalCallback: async () => true,
    };

    const start = await executeTool("computer_session_start", { node: "desktop" }, ctx);
    expect(start.success).toBe(true);
    const sessionId = String(start.metadata?.["sessionId"]);
    expect(computerSessionManager.getSession(sessionId)?.adapter).toBe("remote_vnc");

    const snapshot = await executeTool("computer_snapshot", { sessionId }, ctx);
    expect(snapshot.success).toBe(true);

    const remoteCalls = fetchMock.mock.calls.filter(([input]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return url.startsWith("http://computer-remote.test/");
    });
    expect(remoteCalls.length).toBeGreaterThan(0);

    const startCall = remoteCalls.find(([input]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return url.endsWith("/sessions/start");
    });
    expect(startCall).toBeTruthy();
    const startHeaders = startCall?.[1]?.headers as Record<string, string> | undefined;
    expect(startHeaders?.authorization).toBe("Bearer sidecar-token");
  });

  it("reuses the same node session after lease handoff instead of starting another remote session", async () => {
    const firstCtx = {
      sessionId: "sub:parent-session:computer_use_agent:1",
      workspacePath: tempDir,
      approvalCallback: async () => true,
    };
    const secondCtx = {
      sessionId: "sub:parent-session:computer_use_agent:2",
      workspacePath: tempDir,
      approvalCallback: async () => true,
    };

    const first = await executeTool("computer_session_start", { node: "desktop" }, firstCtx);
    expect(first.success).toBe(true);
    const sessionId = String(first.metadata?.["sessionId"]);

    computerSessionManager.attachSession(sessionId, "parent-session", true);

    const beforeRemoteStarts = fetchMock.mock.calls.filter(([input]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return url.endsWith("/sessions/start");
    }).length;

    const second = await executeTool("computer_session_start", { node: "desktop" }, secondCtx);
    expect(second.success).toBe(true);
    expect(String(second.metadata?.["sessionId"])).toBe(sessionId);
    expect(second.metadata?.["reused"]).toBe(true);
    expect(computerSessionManager.getSession(sessionId)?.leaseOwner).toBe(secondCtx.sessionId);

    const afterRemoteStarts = fetchMock.mock.calls.filter(([input]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return url.endsWith("/sessions/start");
    }).length;
    expect(afterRemoteStarts).toBe(beforeRemoteStarts);
  });

  it("passes the configured RDP display resolution through the sidecar", async () => {
    const ctx = {
      sessionId: "controller-rdp-resolution",
      workspacePath: tempDir,
      approvalCallback: async () => true,
    };

    const start = await executeTool("computer_session_start", { node: "win-workstation" }, ctx);
    expect(start.success).toBe(true);
    expect(start.output).toContain("Primary display: 1920x1080");

    const startCall = fetchMock.mock.calls.find(([input]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return url.endsWith("/sessions/start");
    });
    expect(startCall).toBeTruthy();

    const payload = JSON.parse(String(startCall?.[1]?.body ?? "{}")) as {
      target?: { adapter?: string; config?: { displayResolution?: string } };
    };
    expect(payload.target?.adapter).toBe("remote_rdp");
    expect(payload.target?.config?.displayResolution).toBe("1920x1080");
  });
});