import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * THE RE-WARM'S HEAD ON THE WIRE (agents.performance.subAgentHeadRewarm).
 *
 * sub-agent-head-rewarm.test.ts proves the re-warm hands the provider the loop's own system message
 * and tool array. This proves what that is worth: the request BODY the real provider (LMStudioProvider)
 * puts on the wire for the re-warm carries the same head as the body of the run's first loop call — the
 * folded system message, the tool block, tool_choice and cache_prompt — although the loop streams
 * (completeViaStream) with the agent's own thinking controls and the re-warm completes with the
 * warm-up's. A head that differs anywhere keeps 0% of the cache on this model (probe E2).
 *
 * The case that needs the wire: on gpt-oss the reasoning level is head text (a `Reasoning: <level>`
 * system line the provider folds into the system message), so the re-warm must send the AGENT's level,
 * not the warm-up's thinking-off — and must judge that by the agent's model, not the orchestrator's
 * (warmCallOptions(modelPrimary)). Only the OpenAI SDK client is replaced here; the runner and the
 * provider are the real ones.
 */

type Body = Record<string, unknown> & { messages: Array<{ role: string; content: unknown }>; tools?: unknown[]; stream?: boolean };

const wire = vi.hoisted(() => ({
  bodies: [] as Body[],
  respond: (_body: Body): unknown => undefined,
}));

vi.mock("openai", () => {
  class FakeOpenAI {
    chat = { completions: { create: async (body: Body) => { wire.bodies.push(body); return wire.respond(body); } } };
    models = { list: async () => ({ data: [] }) };
    embeddings = { create: async () => ({ data: [] }) };
    constructor(_opts: unknown) {}
  }
  return { default: FakeOpenAI, OpenAI: FakeOpenAI };
});

const QWEN_AGENT = "writer_agent";
const GPT_OSS_AGENT = "oss_writer_agent";

let dir = "";
let configPath = "";
let subAgent: typeof import("../agent/sub-agent.js");
let rewarm: typeof import("../agent/sub-agent-head-rewarm.js");
let resetConfig: () => void;

const isRewarm = (body: Body): boolean => !body.stream && body.messages.at(-1)?.content === ".";
const loopBodies = (): Body[] => wire.bodies.filter((body) => body.stream === true && Array.isArray(body.tools));
/** The leading system run (the provider may put the gpt-oss `Reasoning:` line ahead of the prompt) and the tool block. */
const headOf = (body: Body): Body["messages"] => body.messages.slice(0, Math.max(1, body.messages.findIndex((m) => m.role !== "system")));
const headChars = (body: Body): number => JSON.stringify(headOf(body)).length + JSON.stringify(body.tools ?? []).length;
const promptChars = (body: Body): number => JSON.stringify(body.messages).length + JSON.stringify(body.tools ?? []).length;

function pageText(page: number, chars: number): string {
  const lines: string[] = [];
  let length = 0;
  for (let i = 0; length < chars; i += 1) {
    const line = `Page ${page}, paragraph ${i}: the section describes item ${page * 1_000 + i} and its measured value ${(i * 37) % 101}.`;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join("\n");
}

let pageChars = 3_000;

async function* chunks(parts: unknown[]): AsyncGenerator<unknown> {
  for (const part of parts) yield part;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "sai-head-rewarm-wire-"));
  configPath = join(dir, "starlingai.json");
  const agentConfig = (description: string, model?: Record<string, unknown>) => ({
    description,
    systemPrompt: Array.from({ length: 60 }, (_, i) => `Rule ${i}: write the page you are asked for from the sources you read, section ${i} first.`).join("\n"),
    tools: ["read_file"],
    maxIterations: 30,
    turnTimeoutMs: 60_000,
    ...(model ? { model } : {}),
  });
  writeFileSync(configPath, JSON.stringify({
    agents: {
      // The orchestrator's model: a family whose thinking switch is NOT head text.
      defaults: { model: { primary: "lmstudio/qwen", promptCache: true } },
      performance: { subAgentHeadRewarm: true },
    },
    subAgents: {
      [QWEN_AGENT]: agentConfig("Writes long pages from the sources it fetches."),
      // An agent on a family whose reasoning level IS head text.
      [GPT_OSS_AGENT]: agentConfig("Writes long pages from the sources it fetches, on gpt-oss.", { primary: "lmstudio/gpt-oss-20b", reasoningEffort: "high" }),
    },
    workspacePath: dir,
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  resetConfig = (await import("../config/loader.js")).resetConfigForTests;
  resetConfig();
  subAgent = await import("../agent/sub-agent.js");
  rewarm = await import("../agent/sub-agent-head-rewarm.js");
  const { registerTool } = await import("../tools/registry.js");
  registerTool({
    name: "read_file",
    description: "Read one numbered page of the sources.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    async execute(args) {
      const page = Number(/page-(\d+)/.exec(String(args["path"] ?? ""))?.[1] ?? 0);
      return { success: true, output: pageText(page, pageChars) };
    },
  });

  wire.respond = (body: Body) => {
    if (body.stream !== true) {
      return { choices: [{ message: { content: "ok", tool_calls: [] }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } };
    }
    const usage = { choices: [], usage: { prompt_tokens: Math.round(promptChars(body) / 4), completion_tokens: 1, total_tokens: Math.round(promptChars(body) / 4) + 1 } };
    // Grow the run to ~6x its head (in characters, which the estimator's 3 chars/token follows),
    // half a head per page; then answer.
    if (promptChars(body) < 6 * headChars(body)) {
      pageChars = Math.ceil(headChars(body) * 0.5);
      const page = loopBodies().length;
      return chunks([
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `fetch-${page}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `sources/page-${page}.md` }) } }] }, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        usage,
      ]);
    }
    return chunks([
      { choices: [{ index: 0, delta: { content: "The overview page is written from the fetched sources." }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      usage,
    ]);
  };
});

afterEach(async () => {
  await rewarm.settleSubAgentHeadRewarms();
  rewarm.resetSubAgentHeadRewarmForTests();
  wire.bodies.length = 0;
});

afterAll(async () => {
  const { unregisterTool } = await import("../tools/registry.js");
  unregisterTool("read_file");
  delete process.env["SAI_CONFIG_PATH"];
  resetConfig();
  rmSync(dir, { recursive: true, force: true });
});

async function runAndCompare(agentName: string, parent: string): Promise<{ first: Body; warm: Body }> {
  await subAgent.runSubAgentWithStats({
    agentName,
    task: "Write the overview page from the fetched sources.",
    parentSessionId: parent,
    workspacePath: dir,
  });
  await rewarm.settleSubAgentHeadRewarms();
  const loop = loopBodies();
  expect(loop.length).toBeGreaterThan(3);
  const warms = wire.bodies.filter(isRewarm);
  expect(warms).toHaveLength(1);
  return { first: loop[0]!, warm: warms[0]! };
}

describe("the re-warm's request carries the loop's head byte for byte", () => {
  it("on a model whose thinking switch is not head text (qwen): same system message, tool block, tool_choice, cache_prompt", async () => {
    const { first, warm } = await runAndCompare(QWEN_AGENT, "conv-wire-qwen");
    expect(warm.messages).toHaveLength(2);
    expect(warm.messages[0]!.role).toBe("system");
    expect(JSON.stringify(headOf(warm))).toBe(JSON.stringify(headOf(first)));
    expect(JSON.stringify(warm.tools)).toBe(JSON.stringify(first.tools));
    expect(warm["tool_choice"]).toBe(first["tool_choice"]);
    expect(warm["cache_prompt"]).toBe(true);
    expect(first["cache_prompt"]).toBe(true);
    expect(warm["model"]).toBe(first["model"]);
    // Thinking off for the one token, as the warm-keeper sends it: after the user turn, not in the head.
    expect(warm["reasoning_effort"]).toBe("none");
  }, 60_000);

  it("on gpt-oss, whose level is head text, it keeps the AGENT's `Reasoning:` line although the orchestrator's model is qwen", async () => {
    const { first, warm } = await runAndCompare(GPT_OSS_AGENT, "conv-wire-oss");
    // The agent's level leads its head, as the system message the provider puts ahead of the prompt.
    expect(headOf(first)[0]).toEqual({ role: "system", content: "Reasoning: high" });
    expect(headOf(first)).toHaveLength(2);
    expect(JSON.stringify(headOf(warm))).toBe(JSON.stringify(headOf(first)));
    expect(warm.messages.slice(headOf(warm).length)).toEqual([{ role: "user", content: "." }]);
    expect(JSON.stringify(warm.tools)).toBe(JSON.stringify(first.tools));
    expect(warm["tool_choice"]).toBe(first["tool_choice"]);
    expect(warm["model"]).toBe(first["model"]);
  }, 60_000);
});
