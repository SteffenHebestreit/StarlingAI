import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * AN MCP SERVER THAT FAILED TO CONNECT IS TRIED AGAIN (2026-10-12).
 *
 * The gateway connected its MCP servers at boot and on an mcp config reload only. ProcessMem, a
 * companion stack started next to a running gateway, stayed "failed to connect" and its tools stayed
 * missing until the gateway was recreated. A failed server is now retried on its own, with a backoff,
 * and the servers already connected are left alone.
 */

const servers = vi.hoisted(() => ({ lateUp: false }));

vi.mock("../mcp/client.js", () => ({
  connectMcpServer: vi.fn(async (serverName: string) => {
    if (serverName === "late" && !servers.lateUp) throw new Error("fetch failed: getaddrinfo ENOTFOUND late");
    return {
      serverName,
      client: { callTool: vi.fn() },
      tools: [{ name: "remember", description: "remember", inputSchema: { type: "object", properties: {} } }],
      disconnect: vi.fn(async () => {}),
    };
  }),
  cleanupConfiguredDockerMcpContainers: vi.fn(async () => {}),
}));

describe("an MCP server that failed to connect", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "sai-mcp-retry-"));
    writeFileSync(join(tempDir, "starlingai.json"), JSON.stringify({
      mcp: {
        servers: {
          early: { transport: "stdio", command: "echo", args: [], autoStart: true },
          late: { transport: "stdio", command: "echo", args: [], autoStart: true },
        },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");
    servers.lateUp = false;
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env["SAI_CONFIG_PATH"];
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function load() {
    const registry = await import("../mcp/registry.js");
    const { getTool } = await import("../tools/registry.js");
    const { getRuntimeStatusSnapshot } = await import("../runtime/status.js");
    const { connectMcpServer } = await import("../mcp/client.js");
    vi.mocked(connectMcpServer).mockClear();
    const mcpStatus = () => getRuntimeStatusSnapshot().components.find((component) => component.name === "mcp");
    const connects = (name: string) => vi.mocked(connectMcpServer).mock.calls.filter(([server]) => server === name).length;
    return { registry, getTool, mcpStatus, connects };
  }

  it("connects once its host is up, on its own, and the status turns healthy", async () => {
    const { registry, getTool, mcpStatus, connects } = await load();
    await registry.syncMcpServers();
    expect(getTool("mcp__late__remember")).toBeUndefined();
    expect(mcpStatus()?.healthy).toBe(false);

    // Still down at the first retry: it stays failed and is tried again later.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(connects("late")).toBe(2);
    expect(mcpStatus()?.healthy).toBe(false);

    servers.lateUp = true;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getTool("mcp__late__remember")).toBeDefined();
    expect(mcpStatus()?.healthy).toBe(true);
    // The server that was connected all along was not reconnected.
    expect(connects("early")).toBe(1);
    expect(getTool("mcp__early__remember")).toBeDefined();

    // Nothing is left to retry.
    await vi.advanceTimersByTimeAsync(600_000);
    expect(connects("late")).toBe(3);
    await registry.shutdownMcpServers();
  });

  it("is not retried after a shutdown", async () => {
    const { registry, connects } = await load();
    await registry.syncMcpServers();
    await registry.shutdownMcpServers();
    servers.lateUp = true;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(connects("late")).toBe(1);
  });
});
