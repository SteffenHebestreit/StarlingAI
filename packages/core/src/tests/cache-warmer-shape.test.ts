/**
 * The warm-up must send the shape a real turn sends, tool block included.
 *
 * It used to pass an empty tool array while every orchestrator turn carries its whole tool
 * block — 36 schemas and about 9,170 tokens under this deployment's `orchestration_only`
 * mode, 89 and 19,550 under `hybrid`. The server renders tools into the prompt, so a
 * tool-less warm-up prefills a prefix that diverges from the live one before the tools
 * begin, and the next real turn pays the full cold prefill anyway.
 *
 * Measured against this backend, same system text, 40 stub tools, a unique text per trial so
 * nothing else could have warmed it:
 *
 *   warm WITHOUT tools, then a tooled turn ->  10,017 ms
 *   warm WITH tools,    then a tooled turn ->     425 ms
 *   a genuinely warm repeat                ->     450 ms
 *
 * So the tool array is not a detail of the warm-up. It is most of what is being warmed, and
 * a warm-up that omits it is indistinguishable from no warm-up at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string | undefined;

/** Boot the warmer against a stub provider and report what it put on the wire. */
async function warmAndCapture(performance: Record<string, unknown>, toolMode = "orchestration_only") {
  vi.resetModules();
  tempDir = mkdtempSync(join(tmpdir(), "starlingai-warm-shape-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    agents: {
      defaults: { model: { primary: "lmstudio/qwen" } },
      // The tool MODE decides the block, and the two modes differ by 53 tools. The warmer
      // must follow whatever the deployment runs, so the tests pin it explicitly rather than
      // inheriting a default and measuring whichever shape that happens to produce.
      mainAssistant: { toolMode },
      performance,
    },
    subAgents: {},
    workspacePath: tempDir,
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;

  const calls: Array<{ messages: unknown[]; tools: unknown[] }> = [];
  vi.doMock("../providers/index.js", async () => ({
    ...(await vi.importActual<Record<string, unknown>>("../providers/index.js")),
    getChatProvider: () => ({
      complete: async (messages: unknown[], tools: unknown[]) => {
        calls.push({ messages, tools: tools ?? [] });
        return { content: "ok" };
      },
    }),
  }));

  // register-builtins is what populates the registry the warmer reads its tool list from.
  await import("../tools/register-builtins.js");
  const warmer = await import("../agent/cache-warmer.js");
  warmer.startCacheWarmer();
  // startCacheWarmer fires warmOnce without awaiting it.
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
  warmer.stopCacheWarmer();
  return calls;
}

describe("prompt-cache warm-up shape", () => {
  beforeEach(() => { delete process.env["SAI_CONFIG_PATH"]; });
  afterEach(async () => {
    vi.doUnmock("../providers/index.js");
    delete process.env["SAI_CONFIG_PATH"];
    if (tempDir) { rmSync(tempDir, { recursive: true, force: true }); tempDir = undefined; }
    vi.resetModules();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  it("warms WITH the orchestrator's tool block", async () => {
    const calls = await warmAndCapture({ promptCacheWarmKeeper: true });

    expect(calls.length, "the warmer should have fired once on boot").toBeGreaterThan(0);
    const tools = calls[0]!.tools as unknown[];
    // The number that decides whether the warm-up is worth anything. An empty array here is
    // the defect: it warms a prefix production never sends.
    expect(tools.length, "an empty tool array warms a shape no turn sends").toBeGreaterThan(10);
  });

  it("follows the tool MODE, so it never warms a block the turn does not send", async () => {
    const orchestrationOnly = await warmAndCapture({ promptCacheWarmKeeper: true }, "orchestration_only");
    const hybrid = await warmAndCapture({ promptCacheWarmKeeper: true }, "hybrid");

    const narrow = (orchestrationOnly[0]!.tools as unknown[]).length;
    const wide = (hybrid[0]!.tools as unknown[]).length;
    // Hybrid adds the direct capability tools. Warming the wide block while the deployment
    // runs the narrow one is the same defect in the other direction: two prefixes, neither
    // of them warm. This deployment runs orchestration_only.
    expect(wide).toBeGreaterThan(narrow);
    expect(narrow).toBeGreaterThan(10);
  });

  it("warms the LEAN block in hybrid mode, where the lean catalog actually applies", async () => {
    const full = await warmAndCapture({ promptCacheWarmKeeper: true }, "hybrid");
    const lean = await warmAndCapture({ promptCacheWarmKeeper: true, leanToolCatalog: true }, "hybrid");

    const fullCount = (full[0]!.tools as unknown[]).length;
    const leanCount = (lean[0]!.tools as unknown[]).length;
    // The flag is a no-op outside hybrid — measured on this deployment it changes the block
    // by -419 chars, because all it does there is add load_tool. Pinning the mode is what
    // makes this test about the lean catalog rather than about the default.
    expect(leanCount).toBeLessThan(fullCount);
    expect(leanCount).toBeGreaterThan(0);
  });

  it("does nothing at all when the flag is off", async () => {
    // Discriminance control: without it, a warmer that always fired would pass both cases
    // above while costing every deployment a background completion it did not ask for.
    const calls = await warmAndCapture({ promptCacheWarmKeeper: false });
    expect(calls).toHaveLength(0);
  });
});
