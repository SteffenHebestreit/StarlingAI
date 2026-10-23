import { describe, expect, it } from "vitest";
import { applyEdits, parseEditorOutput, taskFactScreen, validateEdit, type EditContext, type LabEdit } from "../harness-lab/edit-format.js";
import { buildDigest } from "../harness-lab/digest.js";
import { compose, type ComposerCandidate } from "../harness-lab/composer.js";
import { combinePicks } from "../harness-lab/selector.js";
import { gateDecision, type GateTaskResult } from "../harness-lab/gate.js";
import { mergeEdits } from "../harness-lab/cycle.js";
import { RULE_OVERLAP, ruleOverlap } from "../harness-lab/edit-format.js";
import { buildPromptChanges } from "../harness-lab/proposal.js";
import { promptSha256, stalePromptChange } from "../agent/config-assistant-proposals.js";
import { scenarioToTask } from "../harness-lab/import-seeds.js";
import type { RunScore } from "../harness-lab/scoring.js";
import type { LabRunRecord } from "../harness-lab/turn-runner.js";

const MAIN = "Answer in the user's language.\nKeep answers short.";

function record(over: Partial<LabRunRecord> = {}, turn: Partial<LabRunRecord["turns"][number]> = {}): LabRunRecord {
  return {
    taskId: "t", arm: "base", attempt: 1, sessionId: "s1", durationMs: 1, stubbedCalls: [],
    turns: [{ message: "Summarize the quarterly figures for Nordwind GmbH from invoice 4711.", status: "ok", reply: "Done.", durationMs: 1, toolCalls: [], events: [], artifacts: [], checkFailures: [], checked: true, ...turn }],
    ...over,
  };
}

function ctx(over: Partial<EditContext> = {}): EditContext {
  return {
    editor: "INV",
    idPrefix: "INV-t",
    digest: buildDigest(record()),
    prompts: { main_assistant: MAIN, researcher: "You research." },
    taskText: "Summarize the quarterly figures for Nordwind GmbH from invoice 4711.",
    ...over,
  };
}

const good = { op: "append_rule", target: "main_assistant", scope: "completion", text: "Before you answer, check that every requested item is covered.", moment: "M1", why: "The reply skipped an item." };

describe("edit rules", () => {
  it("accepts a well-formed edit that rests on a moment", () => {
    expect(validateEdit(good, 0, ctx())).toMatchObject({ id: "INV-t-1", op: "append_rule", moment: "M1" });
  });

  it.each([
    [{ op: "rewrite" }, /op must be/],
    [{ target: "nobody" }, /target "nobody"/],
    [{ scope: "deliverable_shape" }, /scope must be one of procedure/],
    [{ moment: "M99" }, /speculation/],
    [{ moment: undefined }, /speculation/],
    [{ text: "" }, /empty/],
    [{ text: "x".repeat(401) }, /at most 400/],
    [{ op: "replace_span", find: "nowhere" }, /occurs 0 times/],
    [{ op: "replace_span", find: "Keep answers short.", text: "y".repeat(350) }, /grows the prompt/],
    [{ text: "keep answers   SHORT." }, /already says/],
    [{ text: "Always quote the quarterly figures for each company." }, /repeats the task's words/],
    [{ text: "Cross-check invoice 4711 before answering." }, /figure "4711"/],
  ])("rejects %j", (patch, reason) => {
    const result = validateEdit({ ...good, ...patch }, 0, ctx());
    expect(typeof result).toBe("string");
    expect(result as string).toMatch(reason);
  });

  it("keeps DOM to its own dimension", () => {
    expect(validateEdit({ ...good, scope: "completion" }, 0, ctx({ editor: "DOM" }))).toMatch(/deliverable_shape/);
    expect(validateEdit({ ...good, scope: "structure" }, 0, ctx({ editor: "DOM" }))).toMatchObject({ editor: "DOM" });
  });

  it("parses keep-base, edits over the limit, and malformed answers", () => {
    expect(parseEditorOutput('{"keepBase": true, "reason": "model noise"}', ctx())).toEqual({ kind: "keep_base", reason: "model noise" });
    const three = parseEditorOutput(`\`\`\`json\n${JSON.stringify({ edits: [good, { ...good, text: "Name the files you delivered." }, { ...good, text: "Third." }] })}\n\`\`\``, ctx());
    expect(three.kind === "edits" && [three.edits.length, three.rejected]).toEqual([2, ["edit 3: over the limit of 2 edits"]]);
    expect(parseEditorOutput("I would keep it.", ctx()).kind).toBe("malformed");
  });

  it("the task-fact screen catches the task's addresses and lets the prompt's own words through", () => {
    expect(taskFactScreen("Write to ops@example.org first.", "Mail ops@example.org the plan.", "")).not.toBeNull();
    expect(taskFactScreen("Answer in the user's language always.", "answer in the user's language please", "Answer in the user's language.")).toBeNull();
  });

  it("applies edits literally, a $ pattern included", () => {
    const edits: LabEdit[] = [
      { id: "a", editor: "INV", op: "replace_span", target: "main_assistant", scope: "procedure", text: "Keep answers short; cite $& sources.", find: "Keep answers short.", moment: "M1", why: "" },
      { id: "b", editor: "INV", op: "append_rule", target: "main_assistant", scope: "completion", text: "Name the files you delivered.", moment: "M1", why: "" },
    ];
    expect(applyEdits({ main_assistant: MAIN }, edits)).toEqual({ main_assistant: "Answer in the user's language.\nKeep answers short; cite $& sources.\nName the files you delivered." });
  });
});

describe("digest", () => {
  it("numbers moments, collapses repeats, and keeps only shown ids citable when cut", () => {
    const events = Array.from({ length: 6 }, () => ({ type: "tool_call_blocked", sessionId: "s1", data: { tool: "web_search", reason: "not_in_turn_toolset" } }));
    const digest = buildDigest(record({}, { events, checkFailures: ["reply does not include \"total\""] }));
    expect(digest.text).toContain("M2–M7 6× orchestrator ✗ web_search refused");
    expect(digest.text).toContain("[check failed]");
    expect(digest.moments.has("M7")).toBe(true);
    const long = buildDigest(record({}, { events: Array.from({ length: 300 }, (_, i) => ({ type: "sub_agent_started", sessionId: "s1", data: { agentName: `agent${i}`, task: "x".repeat(150) } })) }), { maxChars: 2_000 });
    expect(long.text).toContain("moments cut");
    expect(long.text.length).toBeLessThanOrEqual(2_100);
    expect(long.moments.has("M1")).toBe(true);
    expect(long.moments.has("M150")).toBe(false);
  });
});

const score = (over: Partial<RunScore> = {}): RunScore => ({ unscored: false, delivered: true, checksFailed: 0, recordedDefects: 0, ...over });
const edit = (id: string, text = `Rule ${id}.`): LabEdit => ({ id, editor: "INV", op: "append_rule", target: "main_assistant", scope: "procedure", text, moment: "M1", why: "" });

describe("composer rules around the model", () => {
  const candidate = (label: string, edits: LabEdit[], delivered: boolean): ComposerCandidate => ({
    label, edits, probes: [1, 2].map(() => ({ record: record(), score: score({ delivered }) })),
  });

  it("drops an UNSAFE candidate's edits without asking, and a missing decision is a drop", async () => {
    let asked = "";
    const result = await compose({
      referenceSummary: "", referenceDigest: "",
      candidates: [candidate("INV", [edit("i1")], false), candidate("DOM", [edit("d1"), edit("d2")], true)],
      revalidate: (e) => e,
    }, async (_role, _system, user) => { asked = user; return JSON.stringify({ rows: [{ decision: "kept", edit: "d1", evidence: "probe 2 delivered the table" }] }); });
    expect(asked).not.toContain("i1");
    expect(result.edits.map((e) => e.id)).toEqual(["d1"]);
    expect(result.rows).toEqual([
      expect.objectContaining({ edit: "i1", decision: "dropped", unsafe: true }),
      expect.objectContaining({ edit: "d1", decision: "kept" }),
      expect.objectContaining({ edit: "d2", decision: "dropped", evidence: "the composer gave no decision" }),
    ]);
  });

  it("a revision may only shorten and must pass the rules again; at most three survive", async () => {
    const edits = ["a", "b", "c", "d", "e"].map((id) => edit(id, `A rule named ${id} that is reasonably long.`));
    const result = await compose({
      referenceSummary: "", referenceDigest: "",
      candidates: [candidate("INV", edits, true)],
      revalidate: (e, text) => (text.includes("bad") ? "fails a rule" : { ...e, text }),
    }, async () => JSON.stringify({ rows: [
      { decision: "revised", edit: "a", evidence: "x", text: "A longer revision that adds a whole new clause to the rule." },
      { decision: "revised", edit: "b", evidence: "x", text: "bad rule" },
      { decision: "revised", edit: "c", evidence: "x", text: "Rule c." },
      { decision: "kept", edit: "d", evidence: "x" },
      { decision: "kept", edit: "e", evidence: "x" },
    ] }));
    expect(result.rows.find((r) => r.edit === "a")?.evidence).toMatch(/only shorten/);
    expect(result.rows.find((r) => r.edit === "b")?.evidence).toMatch(/fails a rule/);
    expect(result.edits.map((e) => [e.id, e.text])).toEqual([["c", "Rule c."], ["d", edits[3]!.text], ["e", edits[4]!.text]]);
  });
});

describe("selector picks", () => {
  it.each([
    ["A", "B", "base"],
    ["B", "A", "candidate"],
    ["A", "A", "inconsistent"],
    ["tie", "tie", "tie"],
    ["A", "none", "inconsistent"],
  ] as const)("%s then %s → %s", (first, second, winner) => {
    expect(combinePicks(first, second)).toBe(winner);
  });
});

describe("gate", () => {
  const pair = (base: Partial<RunScore>, candidate: Partial<RunScore>, selector?: "base" | "candidate" | "tie" | "inconsistent") => ({ base: score(base), candidate: score(candidate), ...(selector ? { selector } : {}) });
  const target = (attempts: GateTaskResult["attempts"], id = "t1"): GateTaskResult => ({ taskId: id, role: "target", attempts });
  const guard = (attempts: GateTaskResult["attempts"], id = "g1"): GateTaskResult => ({ taskId: id, role: "guard", attempts });
  const fixed = pair({ checksFailed: 1 }, {});
  const same = pair({}, {});

  it("accepts on deterministic wins with a quiet guard set", () => {
    const decision = gateDecision([target([fixed, fixed]), guard([same, same])]);
    expect([decision.verdict, decision.evidence]).toEqual(["accept", "deterministic"]);
    expect(decision.signTestP).toBeCloseTo(0.25);
  });

  it("rejects a guard that regressed, a target that got worse, and an improvement within noise", () => {
    const worse = pair({}, { checksFailed: 2 });
    expect(gateDecision([target([fixed, fixed, fixed]), guard([worse, worse, same])]).reasons.join()).toMatch(/guard g1 lost 2/);
    expect(gateDecision([target([fixed, fixed]), target([worse], "t2"), guard([same])]).reasons.join()).toMatch(/target t2 got worse/);
    expect(gateDecision([target([fixed]), guard([same])]).verdict).toBe("reject");
  });

  it("accepts on selector-only evidence only when every target pair tied and the selector never preferred the base", () => {
    expect(gateDecision([target([pair({}, {}, "candidate"), pair({}, {}, "candidate"), pair({}, {}, "tie")]), guard([same])]))
      .toMatchObject({ verdict: "accept", evidence: "selector-only" });
    expect(gateDecision([target([pair({}, {}, "candidate"), pair({}, {}, "base"), pair({}, {}, "candidate")]), guard([same])]).verdict).toBe("reject");
  });

  it("does not accept on one selector verdict: it needs as many as a deterministic accept needs won pairs", () => {
    // The nightly run of 2026-10-23: one target pair, tied, the selector's one consistent verdict.
    expect(gateDecision([target([pair({}, {}, "candidate")]), guard([same])]).verdict).toBe("reject");
    expect(gateDecision([target([pair({}, {}, "candidate"), pair({}, {}, "candidate")]), guard([same])]))
      .toMatchObject({ verdict: "accept", evidence: "selector-only" });
  });

  it("is no verdict when too many pairs could not be scored", () => {
    expect(gateDecision([target([fixed, pair({ unscored: true }, {})]), guard([same])]).verdict).toBe("no_verdict");
  });
});

describe("merging the winners' edits", () => {
  // The two lines of the first accepted proposal (2026-10-19): one rule, said twice.
  const INV_LINE = "Requests for structured visual diagrams (e.g., Mermaid, flowcharts, sequence diagrams) are NOT direct answers. Explicitly forbid inline markdown code blocks for them; instead, mandate delegation to diagram_designer or use the generate_mermaid_diagram tool immediately.";
  const DOM_LINE = "Generate a Mermaid flowchart, sequence diagram, or other structured visual diagram → diagram_designer (it owns generate_mermaid_diagram).";

  it("keeps one of two appended rules that say the same thing: the shorter", () => {
    expect(ruleOverlap(INV_LINE, DOM_LINE)).toBeGreaterThanOrEqual(RULE_OVERLAP);
    const { merged, dropped } = mergeEdits({ main_assistant: MAIN }, [[edit("inv", INV_LINE), edit("dom", DOM_LINE)]]);
    expect(merged.map((e) => e.id)).toEqual(["dom"]);
    expect(dropped).toEqual([expect.stringMatching(/^inv: says what dom says \(\d+% of its words\), and is longer$/)]);
    // In either order.
    expect(mergeEdits({ main_assistant: MAIN }, [[edit("dom", DOM_LINE)], [edit("inv", INV_LINE)]]).merged.map((e) => e.id)).toEqual(["dom"]);
  });

  it("keeps two rules about the same agent that say different things", () => {
    const routing = "Send diagram requests (flowcharts, sequence diagrams) to diagram_designer instead of answering them yourself.";
    const naming = "When diagram_designer reports a saved diagram, quote the file path it returned and never invent another name.";
    expect(ruleOverlap(routing, naming)).toBeNull();
    expect(mergeEdits({ main_assistant: MAIN }, [[edit("a", routing), edit("b", naming)]]).merged.map((e) => e.id)).toEqual(["a", "b"]);
    // Too short to judge: never merged on a handful of words.
    expect(ruleOverlap("Cite sources.", "Cite your sources.")).toBeNull();
  });

  it("keeps identical text once, one replace per span, three edits and 1200 characters per prompt", () => {
    const replace = (id: string, text: string): LabEdit => ({ ...edit(id), op: "replace_span", find: "Keep answers short.", text });
    const big = (id: string) => edit(id, `${id} ${"y".repeat(390)}`);
    const { merged, dropped } = mergeEdits({ main_assistant: MAIN }, [
      [edit("a", "Same rule."), replace("r1", "Keep answers short and sourced.")],
      [edit("b", "Same rule."), replace("r2", "Keep answers brief.")],
      [big("c"), big("d"), big("e")],
    ]);
    expect(merged.map((e) => e.id)).toEqual(["a", "r1", "c"]);
    expect(dropped.join("\n")).toMatch(/b: same text[\s\S]*r2: replaces a span[\s\S]*d: main_assistant already has 3 edits/);
  });
});

describe("the proposal's prompt changes", () => {
  it("appends rules as rules, and makes a replace carry the hash of the prompt it was measured on", () => {
    const changes = buildPromptChanges({ main_assistant: MAIN, researcher: "You research." }, [
      edit("a", "Name the files you delivered."),
      { ...edit("r"), target: "researcher", op: "replace_span", find: "You research.", text: "You research and cite." },
    ], () => "why");
    expect(changes).toEqual([
      { agentName: "main_assistant", strategy: "append", prompt: "Name the files you delivered.", rationale: "why" },
      { agentName: "researcher", strategy: "replace", prompt: "You research and cite.", rationale: "why", baseSha256: promptSha256("You research.") },
    ]);
    const replace = changes[1]!;
    expect(stalePromptChange({ subAgents: { researcher: { systemPrompt: "You research." } } }, replace)).toBeUndefined();
    expect(stalePromptChange({ subAgents: { researcher: { systemPrompt: "You research. Someone edited this." } } }, replace)).toMatch(/has changed/);
  });
});

describe("seed import", () => {
  const scenario = (over: Record<string, unknown>) => ({ id: "s", title: "S", group: "core", steps: [{ kind: "turn", message: "Hi --auto", expect: { reply: { includes: ["x"] }, judge: { rubric: "a rubric text", minScore: 7 } } }], ...over }) as never;

  it("takes a one-session scenario with its checks, without the judge", () => {
    expect(scenarioToTask(scenario({}))).toMatchObject({ id: "e2e.s", origin: "e2e", turns: [{ message: "Hi --auto", expect: { reply: { includes: ["x"] } } }] });
    expect(JSON.stringify(scenarioToTask(scenario({})))).not.toContain("rubric");
  });

  it.each([
    [{ requires: ["browser"] }, /needs browser/],
    [{ steps: [{ kind: "turn", message: "a" }, { kind: "newSession" }, { kind: "turn", message: "b" }] }, /several sessions/],
    [{ steps: [{ kind: "http", method: "GET", path: "/x" }] }, /http step/],
    [{ steps: [{ kind: "turn", message: "a", attachments: ["f.pdf"] }] }, /attaches/],
  ])("skips %j", (over, reason) => {
    const result = scenarioToTask(scenario(over));
    expect("skip" in result && result.skip).toMatch(reason);
  });
});
