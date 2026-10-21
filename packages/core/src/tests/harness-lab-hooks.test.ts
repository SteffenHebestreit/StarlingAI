import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyEdits, HOOKS_TARGET, validateEdit, type EditContext, type LabEdit } from "../harness-lab/edit-format.js";
import { armFor, toolsThatRan } from "../harness-lab/cycle.js";
import { withArm } from "../harness-lab/arm.js";
import { emitProposal } from "../harness-lab/proposal.js";
import { buildDigest } from "../harness-lab/digest.js";
import { configChangeRefusal } from "../agent/config-assistant-proposals.js";
import { getConfig } from "../config/loader.js";
import type { GateDecision } from "../harness-lab/gate.js";
import type { LabRunRecord } from "../harness-lab/turn-runner.js";

/**
 * The harness lab proposes enforcement hooks: the INV editor's add_hook edit, run in the candidate
 * arm only, and filed as a config change a person applies. Invented content throughout.
 */
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function record(): LabRunRecord {
  return {
    taskId: "t", arm: "base", attempt: 1, sessionId: "s1", durationMs: 1, stubbedCalls: [],
    turns: [{
      message: "Draw the order flow of the Sonnenhang bakery as a diagram.", status: "ok", reply: "Saved.", durationMs: 1,
      toolCalls: [{ id: "c1", name: "delegate_to_agent", args: {} }],
      events: [{ type: "sub_agent_tool_call", timestamp: "t", sessionId: "sub:s1:diagram_designer:1", data: { tool: "generate_mermaid_diagram", phase: "done", success: false } }] as never,
      artifacts: [], checkFailures: ["artifacts.minCount: expected ≥1, saw 0"], checked: true,
    }],
  };
}

const ctx = (over: Partial<EditContext> = {}): EditContext => ({
  editor: "INV",
  idPrefix: "INV-t",
  digest: buildDigest(record()),
  prompts: { main_assistant: "Base.", diagram_designer: "Draw diagrams." },
  taskText: "Draw the order flow of the Sonnenhang bakery as a diagram.",
  toolNames: new Set(toolsThatRan([record()])),
  ...over,
});

const hookEdit = (hook: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  op: "add_hook", target: HOOKS_TARGET, scope: "tool_use", moment: "M1", why: "the tool refused the name twice",
  text: "Name Mermaid files with .mmd.", hook, ...over,
});
const HINT = { action: "append_hint", tools: ["generate_mermaid_diagram"], errorMatches: "extension", after: 1, hint: "Name the output file with the .mmd extension." };

describe("an add_hook edit", () => {
  it("is valid for a tool the run called, with an id of its own", () => {
    expect(toolsThatRan([record()])).toEqual(["delegate_to_agent", "generate_mermaid_diagram"]);
    const edit = validateEdit(hookEdit(HINT), 0, ctx());
    expect(edit).toMatchObject({
      op: "add_hook", target: "hooks", hookId: "lab-inv-t-1",
      hook: { action: "append_hint", tools: ["generate_mermaid_diagram"], hint: "Name the output file with the .mmd extension.", description: "Name Mermaid files with .mmd." },
    });
  });

  it.each([
    ["from the DOM editor", hookEdit(HINT), { editor: "DOM" as const }, /add_hook is an INV edit/],
    ["that is not a hook", hookEdit({ action: "rewrite_prompt", tools: ["web_fetch"] }), {}, /not a valid enforcement hook/],
    ["on a tool the run never called", hookEdit({ ...HINT, tools: ["web_fetch"] }), {}, /watches no tool the run called/],
    ["for an agent that did not run", hookEdit({ ...HINT, agents: ["researcher"] }), {}, /agent "researcher" is not one of/],
    ["that takes a tool away", hookEdit({ action: "cap_tool", tools: ["generate_mermaid_diagram"], maxCalls: 0 }), {}, /at least one call/],
    ["whose pattern does not compile", hookEdit({ ...HINT, errorMatches: "([" }), {}, /not a regular expression/],
    ["whose hint carries the task's own words", hookEdit({ ...HINT, hint: "Draw the order flow of the Sonnenhang bakery as a flowchart." }), {}, /a hook acts on other tasks too/],
    ["without a moment", hookEdit(HINT, { moment: "" }), {}, /moment must name a moment/],
  ])("is refused %s", (_label, raw, over, reason) => {
    expect(validateEdit(raw, 0, ctx(over))).toMatch(reason);
  });

  it("changes no prompt", () => {
    const edit = validateEdit(hookEdit(HINT), 0, ctx()) as LabEdit;
    expect(applyEdits({ main_assistant: "Base." }, [edit])).toEqual({});
  });
});

describe("a candidate with a hook", () => {
  it("has the hook in its attempts only, in memory", async () => {
    process.env["SAI_HARNESS_LAB_PROCESS"] = "1";
    const edit = validateEdit(hookEdit(HINT), 0, ctx()) as LabEdit;
    const arm = armFor("INV-t", { main_assistant: "Base." }, [edit]);
    expect(arm.hooks).toEqual({ "lab-inv-t-1": edit.hook });
    const before = getConfig().enforcementHooks;
    const scratch = mkdtempSync(join(tmpdir(), "sai-lab-hooks-"));
    dirs.push(scratch);
    let during: unknown;
    await withArm(arm, scratch, "a1", async () => { during = getConfig().enforcementHooks; });
    expect(during).toMatchObject({ ...before, "lab-inv-t-1": { action: "append_hint" } });
    expect(getConfig().enforcementHooks).toEqual(before);
    let base: unknown;
    await withArm({ name: "base" }, scratch, "a2", async () => { base = getConfig().enforcementHooks; });
    expect(base).toEqual(before);
  });
});

describe("a proposal with a hook", () => {
  const gate = {
    verdict: "accept", evidence: "deterministic", reasons: ["targets won"], unscoredRate: 0, signTestP: null,
    tallies: [{ taskId: "e2e.mermaid", role: "target", wins: 3, losses: 0, ties: 0, unscored: 0, selectorWins: 0, selectorLosses: 0 }],
  } as unknown as GateDecision;

  it("files the hook as a config change a person applies, beside any prompt edit", () => {
    const ws = mkdtempSync(join(tmpdir(), "sai-lab-hook-proposal-"));
    dirs.push(ws);
    const hook = validateEdit(hookEdit(HINT), 0, ctx()) as LabEdit;
    const emitted = emitProposal({ liveWorkspacePath: ws, runId: "r1", basePrompts: { main_assistant: "Base." }, edits: [hook], composerRows: [], gate });
    expect(emitted).toMatchObject({
      proposal: {
        status: "pending",
        promptChanges: [],
        configChanges: [{ path: "enforcementHooks.lab-inv-t-1", value: expect.objectContaining({ action: "append_hint" }), reason: expect.stringMatching(/INV-t-1/) }],
        summary: expect.stringMatching(/1 enforcement hook\(s\) \(lab-inv-t-1\)/),
      },
    });
    // The config assistant applies it: enforcementHooks is a path a proposal may change.
    expect(configChangeRefusal({ path: "enforcementHooks.lab-inv-t-1", value: hook.hook })).toBeUndefined();
    expect(configChangeRefusal({ path: "enforcementHooks.x", value: { action: "cap_tool", apiKey: "x" } })).toMatch(/protected path or sets a credential/);
  });
});
