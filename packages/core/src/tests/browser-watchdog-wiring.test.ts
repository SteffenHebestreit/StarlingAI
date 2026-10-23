import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../tools/registry.js";

/** The browser tools report each call to the watchdog (browser-watchdog.ts), off the call's path. */
const noted = vi.hoisted(() => ({ failures: [] as string[], successes: 0 }));
vi.mock("../tools/browser-watchdog.js", () => ({
  browserWatchdog: async () => ({
    noteSuccess: () => { noted.successes += 1; },
    noteFailure: (error: string) => { noted.failures.push(error); return null; },
  }),
}));

describe("the browser tools and the watchdog", () => {
  it("report a failed call with its error", async () => {
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/multimodal.js");
    const result = await getTool("browser_snapshot")!.execute({}, { sessionId: "sub:w:browser_agent:1", workspacePath: "/w" } as ToolContext);
    expect(result.success).toBe(false);
    await vi.waitFor(() => expect(noted.failures).toEqual([result.error]));
    expect(noted.successes).toBe(0);
  });
});
