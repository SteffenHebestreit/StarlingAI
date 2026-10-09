import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The gateway removes its stale MCP containers when it starts. It found them by image alone, which is every
 * container of that image on the host: a start on 2026-09-28 removed another tool's mcp/playwright container
 * (Docker MCP Toolkit's browser) along with its own. It must only ever list its own.
 */
const dockerCalls: string[][] = [];

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: (file: string, args: string[], ...rest: unknown[]) => {
      const callback = rest.find((arg) => typeof arg === "function") as ((err: Error | null, out: { stdout: string; stderr: string }) => void);
      if (file === "docker") dockerCalls.push(args);
      callback(null, { stdout: "", stderr: "" });
      return {} as never;
    },
  };
});

describe("stale MCP container cleanup", () => {
  beforeEach(() => { dockerCalls.length = 0; });

  it("lists only the gateway's own containers of a configured image", async () => {
    const { cleanupConfiguredDockerMcpContainers } = await import("../mcp/client.js");
    await cleanupConfiguredDockerMcpContainers([
      { transport: "docker", image: "mcp/playwright", args: [] } as never,
    ]);
    const byImage = dockerCalls.filter((args) => args[0] === "ps" && args.some((a) => a.startsWith("ancestor=")));
    expect(byImage).toHaveLength(1);
    expect(byImage[0]).toContain("ancestor=mcp/playwright");
    expect(byImage[0]).toContain("name=^starlingai-mcp-");
  });
});
