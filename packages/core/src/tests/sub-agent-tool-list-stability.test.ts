import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * THE SUB-AGENT'S TOOL LIST IS PART OF THE CACHE KEY.
 *
 * The tool block renders AHEAD of the history in the chat template, so every mid-run
 * change to the list handed to the provider threw the whole prefix away. Probed on the
 * serving station (18 tool schemas + 7K-token system prompt, cache_prompt on):
 *
 *   tools + tool_choice auto, warm   prompt 9,938  processed     4   0.40 s
 *   tools + tool_choice "none"       prompt 9,938  processed     4   0.41 s
 *   tools + tool_choice required     prompt 9,938  processed     4   0.50 s
 *   NO tools                         prompt 7,027  processed 7,027   7.28 s
 *
 * In the audit log 6 of the 8 tools-stripped calls were cold (41 messages / 12,732
 * tokens / 14.6 s TTFT; 35 messages / 17,628 tokens / 24.7 s). So "no more tools" is
 * tool_choice "none" on the SAME list, a withdrawn tool is blocked at the call site, and
 * the rescue passes deliver their instruction as a trailing system message instead of
 * appending it to the system prompt (0.33 s unchanged vs 41.29 s appended vs 0.87 s
 * trailing on a 24,731-token context).
 *
 * Every assertion here is about what the provider RECEIVED (tool names, options,
 * messages) or what the tool spies saw — not about the text the run produced.
 */

interface RecordedCall {
  method: "complete" | "completeViaStream";
  toolNames: string[];
  options: { toolChoice?: string } | undefined;
  messages: Array<{ role: string; content: unknown }>;
}

const recordedCalls: RecordedCall[] = [];
const responseQueue = vi.fn();
const auditEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];

function record(method: RecordedCall["method"], messages: unknown, tools: unknown, options: unknown) {
  recordedCalls.push({
    method,
    toolNames: (tools as Array<{ name: string }>).map((tool) => tool.name),
    options: options as RecordedCall["options"],
    messages: messages as RecordedCall["messages"],
  });
  return responseQueue();
}

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async complete(messages: unknown, tools: unknown, _signal?: AbortSignal, options?: unknown) {
      return record("complete", messages, tools, options);
    }
    async completeViaStream(messages: unknown, tools: unknown, _signal?: AbortSignal, options?: unknown) {
      return record("completeViaStream", messages, tools, options);
    }
  },
}));

vi.mock("../audit/logger.js", async (importActual) => ({
  ...(await importActual<typeof import("../audit/logger.js")>()),
  logAudit: (event: string, payload: Record<string, unknown>) => { auditEvents.push({ event, payload }); },
}));

const AGENT = "stability_probe";

function writeTempConfig(
  maxIterations: number,
  turnTimeoutMs?: number,
  orchestration?: Record<string, unknown>,
  agentTools: string[] = ["web_search", "web_fetch"],
  /** Written to agents.defaults.model — the object a sub-agent's own model config merges over. */
  model?: Record<string, unknown>,
): { tempDir: string; configPath: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-sub-agent-tool-list-stability-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    ...(orchestration ? { orchestration } : {}),
    ...(model ? { agents: { defaults: { model } } } : {}),
    subAgents: {
      [AGENT]: {
        description: "Probe specialist that exercises wire tool-list stability.",
        systemPrompt: "Gather evidence with the tools, then answer.",
        tools: agentTools,
        maxIterations,
        ...(turnTimeoutMs ? { turnTimeoutMs } : {}),
      },
    },
  }), "utf8");
  return { tempDir, configPath };
}

function toolCall(id: string, name: string, args: Record<string, unknown>, content = "") {
  return {
    content,
    tool_calls: [{ id, name, arguments: args }],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    finishReason: "tool_calls",
  };
}

function text(content: string) {
  return {
    content,
    tool_calls: [],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    finishReason: "stop",
  };
}

/** Same-named fakes as sub-agent-tool-caps.test.ts: the real modules are never imported
 *  here, so the registry only ever holds these. */
async function registerFakeTools(
  searchResult?: (query: string) => Record<string, unknown>,
  fetchResult?: (url: string) => Record<string, unknown>,
) {
  const { registerTool, unregisterTool } = await import("../tools/registry.js");
  const searchSpy = vi.fn((query: string) => searchResult?.(query) ?? {
    success: true,
    output: `search result for ${query}: a sentence long enough to count as evidence for the probe.`,
  });
  const fetchSpy = vi.fn((url: string) => fetchResult?.(url) ?? {
    success: true,
    output: `fetched ${url}: a paragraph of page content long enough to count as evidence for the probe.`,
  });
  registerTool({
    name: "web_search",
    description: "Search the web.",
    parameters: { type: "object", properties: {} },
    async execute(args) {
      return searchSpy(String(args.query ?? "")) as never;
    },
  });
  registerTool({
    name: "web_fetch",
    description: "Fetch a web page.",
    parameters: { type: "object", properties: {} },
    async execute(args) {
      return fetchSpy(String(args.url ?? "")) as never;
    },
  });
  return {
    searchSpy,
    fetchSpy,
    cleanup: () => {
      unregisterTool("web_search");
      unregisterTool("web_fetch");
    },
  };
}

async function runProbe(
  responses: unknown[],
  maxIterations: number,
  searchResult?: (query: string) => Record<string, unknown>,
  turnTimeoutMs?: number,
  extra?: {
    fetchResult?: (url: string) => Record<string, unknown>;
    orchestration?: Record<string, unknown>;
    agentTools?: string[];
    model?: Record<string, unknown>;
  },
) {
  const { tempDir, configPath } = writeTempConfig(maxIterations, turnTimeoutMs, extra?.orchestration, extra?.agentTools, extra?.model);
  process.env["SAI_CONFIG_PATH"] = configPath;
  vi.resetModules();
  const queue = [...responses];
  responseQueue.mockImplementation(() => queue.shift() ?? text("Fallback answer."));
  const fakes = await registerFakeTools(searchResult, extra?.fetchResult);
  try {
    const { runSubAgentWithStats } = await import("../agent/sub-agent.js");
    const result = await runSubAgentWithStats({
      agentName: AGENT,
      task: "Verify the claim with web evidence.",
      parentSessionId: `parent-tool-list-stability-${maxIterations}`,
      workspacePath: tempDir,
    });
    return { result, ...fakes };
  } finally {
    fakes.cleanup();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("sub-agent wire tool list stays byte-identical for the whole run", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    recordedCalls.length = 0;
    auditEvents.length = 0;
    responseQueue.mockReset();
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
  });

  it("sends the final iteration the SAME tool list under tool_choice none, not an empty one", async () => {
    await runProbe([
      toolCall("s1", "web_search", { query: "claim source" }),
      toolCall("f1", "web_fetch", { url: "https://example.test/source" }),
      text("Final answer from the gathered evidence."),
    ], 3);

    expect(recordedCalls).toHaveLength(3);
    const [first, second, last] = recordedCalls as [RecordedCall, RecordedCall, RecordedCall];
    expect(first.toolNames).toEqual(["web_search", "web_fetch"]);
    expect(first.options?.toolChoice).toBe("auto");
    expect(second.options?.toolChoice).toBe("auto");
    // The last iteration: same wire list, tool grammar off.
    expect(last.toolNames).toEqual(second.toolNames);
    expect(last.options?.toolChoice).toBe("none");
    // And the head is the same bytes as the call before it — the nudge rides at the tail.
    expect(last.messages[0]).toEqual(second.messages[0]);
    const tail = last.messages[last.messages.length - 1]!;
    expect(tail.role).toBe("system");
    expect(String(tail.content)).toContain("TOOL CALLS ARE DISABLED");
  });

  it("blocks a withdrawn tool at the call site and leaves the wire list unchanged", async () => {
    const { searchSpy, fetchSpy } = await runProbe([
      toolCall("s1", "web_search", { query: "first query" }),
      // A second, DIFFERENT call to the withdrawn tool (an identical one would be served
      // from the idempotent-call cache and never reach the block).
      toolCall("s2", "web_search", { query: "second query" }),
      text("Answer without search."),
    ], 5, (query) => query === "first query"
      ? { success: false, output: "", error: "search backend unreachable", metadata: { searchDegraded: true } }
      : { success: true, output: `search result for ${query}` });

    // Executed once (the degraded call); the second never ran.
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy).toHaveBeenCalledWith("first query");
    expect(fetchSpy).not.toHaveBeenCalled();
    // The list on the wire after the withdrawal is the list before it.
    expect(recordedCalls.length).toBeGreaterThanOrEqual(3);
    expect(recordedCalls[1]!.toolNames).toEqual(recordedCalls[0]!.toolNames);
    expect(recordedCalls[2]!.toolNames).toEqual(recordedCalls[0]!.toolNames);
    expect(recordedCalls[0]!.toolNames).toContain("web_search");
    expect(recordedCalls[1]!.options?.toolChoice).toBe("auto");
    // The model was answered with the synthetic block result for the second call...
    const blockedResult = recordedCalls[2]!.messages.find((message) =>
      message.role === "tool" && /^Tool 'web_search' is disabled for the rest of this run/.test(String(message.content)));
    expect(blockedResult).toBeDefined();
    expect(String(blockedResult!.content)).toContain("search backend is degraded");
    // ...and the audit row carries the reason, not a warden-alerting "not_in_agent_tools".
    const blockedRows = auditEvents.filter((e) => e.event === "sub_agent_tool_blocked");
    expect(blockedRows).toHaveLength(1);
    expect(blockedRows[0]!.payload).toMatchObject({ tool: "web_search", reason: "search_backend_degraded" });
  });

  it("enforces the evidence cap at the call site, with the wire list and the audit reason intact", async () => {
    // The sufficiency strip is one of the five sites converted from `tools = tools.filter(...)`
    // to `blockedToolReasons.set(name, "evidence_cap_enforced")`, and nothing covered it: a
    // regression that re-filters the wire list here pays the measured 7,027-token re-prefill
    // again, and one that forgets the map write lets the model's next web_fetch EXECUTE after
    // "EVIDENCE COMPLETE" — or answers it with the warden-alerting allow-list wording.
    //
    // Reaching the strip: the cap counts EXTRACTED finding bytes (extractKeyFacts caps each at
    // 600), so no single result can reach SUFFICIENT_EVIDENCE_TOOL_STRIP_BYTES (12_000) — the
    // rung a real run trips is the nudge at 4_000 (7 findings) plus NUDGE_IGNORED_STRIP_ITERATIONS
    // more gathering iterations. Distillation is off so each finding is exactly its heuristic
    // extract and no distill call lands in `recordedCalls`.
    const page = (index: number) => ({
      success: true,
      output: [
        `Report ${index}: the ${2020 + index} unit shipped 1${index}4,000 pieces at EUR ${index}9.90 each.`,
        `Section ${index}A records a peak throughput of ${index}12 MB/s sustained over 48 hours of testing.`,
        `Section ${index}B lists supplier ${index} with lead time ${index * 3 + 5} days and a defect rate of 0.${index}4 %.`,
        `Section ${index}C: revenue rose ${index * 2 + 3} % year on year to EUR ${index}.7 million in the same period.`,
        `Section ${index}D notes the certification number CE-${index}0${index}1-${index}9 issued on 12 March ${2020 + index}.`,
        `Section ${index}E measures idle draw at ${index}.8 W and peak draw at ${index * 4 + 11} W under full load.`,
        `Section ${index}F gives the housing as ${index}4 x ${index}2 x 1${index} mm weighing ${index}80 g without the bracket.`,
        `Section ${index}G cites warranty terms of ${index + 2} years and a mean time between failures of ${index}5,000 hours.`,
      ].join("\n"),
    });
    const gather = Array.from({ length: 10 }, (_, i) =>
      toolCall(`f${i}`, "web_fetch", { url: `https://example.test/report-${i}` }));

    const { fetchSpy } = await runProbe([
      ...gather,
      // The bounded synthesis the strip fires immediately: empty, so the run falls through to
      // one more iteration instead of returning here.
      text(""),
      // That iteration calls the withdrawn tool again — alongside share_finding (the real
      // shared-facts write; a below-2-call share is deliberately NOT withdrawn by the strip),
      // so the iteration is not entirely blocked, the run does not break out, and the blocked
      // result is visible on the NEXT request's wire.
      {
        content: "",
        tool_calls: [
          { id: "f-after-strip", name: "web_fetch", arguments: { url: "https://example.test/report-after-strip" } },
          { id: "share-1", name: "share_finding", arguments: { key: "peak_throughput", value: "Peak throughput is 912 MB/s." } },
        ],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        finishReason: "tool_calls",
      },
      text("Final answer from the collected evidence."),
    ], 14, undefined, undefined, {
      fetchResult: (url) => page(Number(/(\d+)$/.exec(url)?.[1] ?? "0")),
      orchestration: { distillSharedFacts: false },
      agentTools: ["web_search", "web_fetch", "share_finding"],
    });

    // The strip really fired (otherwise everything below would describe an ordinary run).
    const stripRows = auditEvents.filter((e) =>
      e.event === "sub_agent_synthesis_forced" && e.payload["reason"] === "sufficient_evidence_tools_stripped");
    expect(stripRows).toHaveLength(1);
    expect(stripRows[0]!.payload["strippedToolNames"]).toContain("web_fetch");

    // The 11th call never ran: the tool is withdrawn from what the model may CALL.
    expect(fetchSpy).toHaveBeenCalledTimes(10);
    expect(fetchSpy).not.toHaveBeenCalledWith("https://example.test/report-after-strip");

    // ...and the withdrawal cost no prefix: every call that carries the run's own prompt head
    // went out with the same wire list, the withdrawn tool included. (The facts-first synthesis
    // pass is excluded on purpose — it is a fresh 2-message prompt with its own head and no
    // tools at all, a different prefix by design, not this list being edited.)
    const first = recordedCalls[0]!;
    expect(first.toolNames).toEqual(["web_search", "web_fetch", "share_finding"]);
    const workerCalls = recordedCalls.filter((call) => call.messages[0]!.content === first.messages[0]!.content);
    expect(workerCalls.length).toBeGreaterThanOrEqual(11);
    for (const call of workerCalls) expect(call.toolNames).toEqual(first.toolNames);

    // The model was answered with the evidence-cap wording, at the call site.
    const blockedResult = recordedCalls
      .flatMap((call) => call.messages)
      .find((message) => message.role === "tool"
        && String(message.content).startsWith("Tool 'web_fetch' has been disabled"));
    expect(blockedResult).toBeDefined();
    expect(String(blockedResult!.content)).toContain("you have gathered enough evidence");

    // ...and the row carries the run-internal reason, not the warden-alerting allow-list one.
    const blockedRows = auditEvents.filter((e) => e.event === "sub_agent_tool_blocked");
    expect(blockedRows).toHaveLength(1);
    expect(blockedRows[0]!.payload).toMatchObject({ tool: "web_fetch", reason: "evidence_cap_enforced" });
  }, 30_000);

  it("says on the digest row WHICH trigger fired, how much mass went and against which window", async () => {
    // A digest is a mid-prefix rewrite: everything behind the rewritten message re-prefills
    // (10-16 s cold on the audited runs). One break per 40K batch is the design; the overflow
    // exception below that threshold fires on whatever went stale THAT iteration, so on a
    // small-window model it repeats every iteration — one break per iteration, the pathology
    // the batching removed. The row logged {iteration, digested, remainingMessages} only, in
    // which those two cases are indistinguishable.
    const bigPage = (index: number) =>
      `Dossier ${index}. ` + `Paragraph ${index} of the retrieved page, carrying figures and prose. `.repeat(420);
    await runProbe([
      ...Array.from({ length: 5 }, (_, i) =>
        toolCall(`b${i}`, "web_fetch", { url: `https://example.test/dossier-${i}` })),
      text("Final answer from the collected dossiers."),
    ], 8, undefined, undefined, {
      fetchResult: (url) => ({ success: true, output: bigPage(Number(/(\d+)$/.exec(url)?.[1] ?? "0")) }),
      orchestration: { distillSharedFacts: false },
      // A 32K window would put the overflow guard, not the batch, in charge of these results.
      model: { contextWindow: 131_072 },
    });

    const digestRows = auditEvents.filter((e) => e.event === "sub_agent_history_digested");
    expect(digestRows.length).toBeGreaterThanOrEqual(1);
    expect(digestRows[0]!.payload).toMatchObject({
      agentName: AGENT,
      digestTrigger: "batch",
      contextWindow: 131_072,
    });
    expect(digestRows[0]!.payload["digestedStaleChars"]).toBeGreaterThanOrEqual(40_000);
    // ...and the mass on the row is the mass that left the wire: the request after the digest
    // carries the head+tail excerpt, not the page.
    const digestedOnWire = recordedCalls
      .flatMap((call) => call.messages)
      .filter((message) => message.role === "tool" && String(message.content).includes("chars elided"));
    expect(digestedOnWire.length).toBeGreaterThanOrEqual(2);
    for (const message of digestedOnWire) expect(String(message.content).length).toBeLessThan(2_000);
  }, 30_000);

  it("runs the empty-answer rescue on the same prompt head with the instruction trailing, under tool_choice none", async () => {
    const { result } = await runProbe([
      toolCall("f1", "web_fetch", { url: "https://example.test/source" }),
      text(""),
      text("Rescued answer built from the fetched page."),
    ], 5);

    expect(result.output).toContain("Rescued answer built from the fetched page.");
    expect(recordedCalls).toHaveLength(3);
    const [, before, rescue] = recordedCalls as [RecordedCall, RecordedCall, RecordedCall];
    // Byte-identical head: the system prompt was not appended to.
    expect(rescue.messages[0]).toEqual(before.messages[0]);
    expect(rescue.messages[0]!.role).toBe("system");
    // The instruction is the LAST message, as a system turn.
    const tail = rescue.messages[rescue.messages.length - 1]!;
    expect(tail.role).toBe("system");
    expect(String(tail.content)).toContain("Tool calls are disabled for this reply");
    expect(rescue.messages.length).toBeGreaterThan(2);
    // Same wire list, grammar off — never an empty list.
    expect(rescue.toolNames).toEqual(before.toolNames);
    expect(rescue.toolNames.length).toBeGreaterThan(0);
    expect(rescue.options?.toolChoice).toBe("none");
  });

  it("puts the soft-deadline instruction in a trailing system message, not on the system prompt", async () => {
    // The soft-deadline (pre-deadline) synthesis was the last site still composing
    // `systemPrompt + "\n\n[SOFT DEADLINE REACHED…]"`. Same wave-D measurement as the rest of
    // this file: 0.33 s unchanged head vs 41.29 s appended vs 0.87 s trailing on a
    // 24,731-token context — and since this pass now goes out with the run's tool block in
    // front of the head, the mutation threw away the whole prefix on the one path that only
    // fires when the run has already run out of time.
    //
    // Reaching the gate: it needs turnTimeoutMs >= 60 s and elapsed past the reserve
    // (min(0.6·T, max(30 s, 1.25·slowest call)) = 30 s at T = 60 s). Date.now is advanced by
    // the tool itself; the real setTimeout deadlines never fire, so nothing here races a clock.
    const realNow = Date.now.bind(Date);
    let clockOffset = 0;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffset);
    try {
      // Short result on purpose: below autoShareUsefulFinding's 180-char floor, so nothing is
      // auto-shared, curated findings stay under SYNTH_FACTS_MIN_CHARS and the synthesis takes
      // the HISTORY-bearing branch — the one this fix is about.
      await runProbe([
        toolCall("s1", "web_search", { query: "claim source" }),
        text("Never reached — the soft deadline fires first."),
      ], 6, () => {
        clockOffset = 40_000;
        return { success: true, output: "one short line of evidence." };
      }, 60_000);

      // The gate really fired (otherwise the assertions below would describe the last
      // iteration instead).
      expect(auditEvents.filter((e) => e.event === "sub_agent_soft_deadline")).toHaveLength(1);

      const [worker, synth] = recordedCalls as [RecordedCall, RecordedCall];
      expect(recordedCalls).toHaveLength(2);
      expect(synth.options?.toolChoice).toBe("none");
      // Byte-identical head — the instruction was NOT appended to the system prompt.
      expect(synth.messages[0]).toEqual(worker.messages[0]);
      expect(String(synth.messages[0]!.content)).not.toContain("SOFT DEADLINE REACHED");
      // It rides at the tail instead, and keeps this site's richer wording (the multi-source
      // and verbatim clauses the sufficiency-strip caller depends on).
      const tail = synth.messages[synth.messages.length - 1]!;
      expect(tail.role).toBe("system");
      expect(String(tail.content)).toContain("[SOFT DEADLINE REACHED — SYNTHESIZE NOW]");
      expect(String(tail.content)).toContain("across ALL sources");
      expect(String(tail.content)).toContain("3000 characters");
      expect(String(tail.content)).toContain("Do NOT mention the soft deadline");
      // The history is still there behind the head (this is the history-bearing branch).
      expect(synth.messages.some((m) => m.role === "tool")).toBe(true);
      // Same wire list, grammar off.
      expect(synth.toolNames).toEqual(worker.toolNames);
      expect(synth.toolNames.length).toBeGreaterThan(0);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("discards a tool_call that comes back under tool_choice none and logs the guardrail row", async () => {
    const { result, searchSpy } = await runProbe([
      toolCall("s1", "web_search", { query: "claim source" }),
      // Final iteration (tool_choice "none"): the model writes a call anyway.
      toolCall("s2", "web_search", { query: "one more query" }, "Answer text alongside a stray call."),
    ], 2);

    expect(recordedCalls[1]!.options?.toolChoice).toBe("none");
    // Never executed.
    expect(searchSpy).toHaveBeenCalledTimes(1);
    expect(searchSpy).toHaveBeenCalledWith("claim source");
    // The content stood as the answer.
    expect(result.output).toContain("Answer text alongside a stray call.");
    const rows = auditEvents.filter((e) => e.event === "guardrail_flagged" && e.payload["type"] === "tool_call_under_tool_choice_none");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ agentName: AGENT, toolNames: ["web_search"] });
  });
});
