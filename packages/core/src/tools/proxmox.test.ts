import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("proxmox tool", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("registers the proxmox_vm tool", async () => {
    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./proxmox.js"),
    ]);

    expect(getTool("proxmox_vm")).toBeDefined();
  });

  it("clones and starts a VM using token authentication", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);

      if (url.endsWith("/nodes/pve/qemu/9000/clone")) {
        expect(init?.headers).toMatchObject({ Authorization: "PVEAPIToken=root@pam!starlingai=token-secret" });
        return jsonResponse({ data: "UPID:pve:clone" });
      }
      if (url.endsWith("/nodes/pve/tasks/UPID%3Apve%3Aclone/status")) {
        return jsonResponse({ data: { status: "stopped", exitstatus: "OK" } });
      }
      if (url.endsWith("/nodes/pve/qemu/321/config")) {
        return jsonResponse({ data: "UPID:pve:config" });
      }
      if (url.endsWith("/nodes/pve/tasks/UPID%3Apve%3Aconfig/status")) {
        return jsonResponse({ data: { status: "stopped", exitstatus: "OK" } });
      }
      if (url.endsWith("/nodes/pve/qemu/321/status/start")) {
        return jsonResponse({ data: "UPID:pve:start" });
      }
      if (url.endsWith("/nodes/pve/tasks/UPID%3Apve%3Astart/status")) {
        return jsonResponse({ data: { status: "stopped", exitstatus: "OK" } });
      }
      if (url.endsWith("/nodes/pve/qemu/321/status/current")) {
        return jsonResponse({ data: { status: "running", qmpstatus: "running", name: "app-321" } });
      }

      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./proxmox.js"),
    ]);

    const tool = getTool("proxmox_vm");
    const result = await tool!.execute({
      action: "clone",
      apiUrl: "https://pve.example.com:8006",
      tokenId: "root@pam!starlingai",
      tokenSecret: "token-secret",
      node: "pve",
      vmId: 321,
      sourceVmid: 9000,
      name: "app-321",
      cores: 4,
      memoryMb: 8192,
      startAfterClone: true,
    }, {
      sessionId: "session-proxmox-clone",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("VM cloned successfully");
    expect(result.output).toContain("VM ID: 321");
  });

  it("logs in with username and password refs for status queries", async () => {
    process.env["PVE_TEST_PASSWORD"] = "super-secret";
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/access/ticket")) {
        expect(init?.method).toBe("POST");
        return jsonResponse({ data: { ticket: "ticket-1", CSRFPreventionToken: "csrf-1" } });
      }
      if (url.endsWith("/nodes/pve/qemu/321/status/current")) {
        expect(init?.headers).toMatchObject({ Cookie: "PVEAuthCookie=ticket-1" });
        return jsonResponse({ data: { status: "running", name: "app-321" } });
      }

      throw new Error(`Unexpected fetch call: ${url}`);
    });

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./proxmox.js"),
    ]);

    const tool = getTool("proxmox_vm");
    const result = await tool!.execute({
      action: "status",
      apiUrl: "https://pve.example.com:8006/api2/json",
      username: "root@pam",
      password: "$PVE_TEST_PASSWORD",
      node: "pve",
      vmId: 321,
    }, {
      sessionId: "session-proxmox-status",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Status: running");

    delete process.env["PVE_TEST_PASSWORD"];
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}