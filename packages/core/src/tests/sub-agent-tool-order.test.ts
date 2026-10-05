import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A SUB-AGENT'S TOOL ORDER IS HELD ONCE IT IS RANKED (finding 2026-10-05).
 *
 * The tool block renders right behind a sub-agent's system prompt, so a different ORDER is a
 * different prompt head and a full cold prefill (47 s against 0.43 s for a rotated block on the
 * serving cluster). The rerank used to run on every dispatch, and when its embedding failed it fell
 * back to registration order — rotating the block of an agent whose tools had not changed. The real
 * rerank runs here over registered tools; only the embedder is scripted.
 */
const embedder = vi.hoisted(() => ({
  mode: "ok" as "ok" | "fail" | "none" | "stall",
  queryCalls: 0,
  release: null as null | (() => void),
}));

/** A 2-d embedding from the text: the role statement points at "beta", each tool somewhere else. */
function vectorFor(text: string): Float32Array {
  if (text.includes("Tool: read_file")) return new Float32Array([0, 1]);
  if (text.includes("Tool: write_file")) return new Float32Array([1, 0]);
  if (text.includes("Tool: list_files")) return new Float32Array([0.6, 0.8]);
  if (text.includes("Tool: web_fetch")) return new Float32Array([0.8, 0.6]);
  return new Float32Array([1, 0]);   // the ranking key
}

vi.mock("../providers/embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../providers/embeddings.js")>();
  return {
    ...actual,
    isEmbeddingAvailable: () => true,
    computeQueryEmbedding: vi.fn(async (text: string) => {
      const isToolText = text.startsWith("Tool: ");
      if (!isToolText) embedder.queryCalls += 1;
      if (!isToolText && embedder.mode === "fail") throw new Error("embedder down");
      // An embedder that answers with nothing: the rerank then returns the order it was given,
      // as a successful call — only its report says the order is not a ranking.
      if (!isToolText && embedder.mode === "none") return null;
      if (!isToolText && embedder.mode === "stall") {
        await new Promise<void>((resolve) => { embedder.release = resolve; });
      }
      return vectorFor(text);
    }),
  };
});

const { registerTool, getToolsAsLLMDefs } = await import("../tools/registry.js");
const { orderSubAgentTools, _resetSubAgentToolOrdersForTests } = await import("../agent/sub-agent-tool-order.js");

// Real tool names: the registry refuses a name the tier map does not know. Only these four are
// registered here, with stub handlers, so the rerank sees exactly them.
const NAMES = ["read_file", "write_file", "list_files", "web_fetch"];
for (const name of NAMES) {
  registerTool({
    name,
    description: `test tool ${name}`,
    parameters: { type: "object", properties: {} },
    execute: async () => ({ success: true, output: "" }),
  });
}

const tools = () => getToolsAsLLMDefs(NAMES);
const order = (defs: Array<{ name: string }>) => defs.map((d) => d.name);
const dispatch = (timeoutMs?: number) => orderSubAgentTools({
  agentName: "order_probe",
  rankingKey: "Probe specialist",
  tools: tools(),
  minTools: 1,
  ...(timeoutMs !== undefined ? { timeoutMs } : {}),
});

describe("orderSubAgentTools", () => {
  beforeEach(() => {
    _resetSubAgentToolOrdersForTests();
    embedder.mode = "ok";
    embedder.queryCalls = 0;
    embedder.release = null;
  });

  it("keeps the first ranked order on a second dispatch whose embedder fails", async () => {
    const first = order(await dispatch());
    // The discriminator: the ranking really differs from the order a failed rerank falls back to.
    expect(first).toEqual(["write_file", "web_fetch", "list_files", "read_file"]);
    expect(first).not.toEqual(order(tools()));

    embedder.mode = "fail";
    expect(order(await dispatch())).toEqual(first);
  });

  it("does not ask the embedder again once the order is held", async () => {
    await dispatch();
    await dispatch();
    expect(embedder.queryCalls).toBe(1);
  });

  it("does not hold a fallback: a failed first rerank leaves the next dispatch free to rank", async () => {
    embedder.mode = "fail";
    expect(order(await dispatch())).toEqual(order(tools()));
    // The fallback that comes back as a successful rerank is not held either.
    embedder.mode = "none";
    expect(order(await dispatch())).toEqual(order(tools()));
    embedder.mode = "ok";
    expect(order(await dispatch())).toEqual(["write_file", "web_fetch", "list_files", "read_file"]);
  });

  it("does not wait past its deadline for a stalled embedder, and the late ranking is held for the next dispatch", async () => {
    embedder.mode = "stall";
    const startedAt = Date.now();
    const first = order(await dispatch(50));
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(first).toEqual(order(tools()));   // nothing held yet: the order it was given

    embedder.release?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    embedder.mode = "fail";
    expect(order(await dispatch(50))).toEqual(["write_file", "web_fetch", "list_files", "read_file"]);
  });
});
