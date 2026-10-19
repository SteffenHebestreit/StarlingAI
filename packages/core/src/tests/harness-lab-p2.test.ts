import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSkills, writeSkill, skillsDir } from "../skills/store.js";
import { setSkillSnapshot, snapshotSkills, withArm } from "../harness-lab/arm.js";
import { validateEdit, applyEdits, type EditContext, type LabEdit } from "../harness-lab/edit-format.js";
import { armFor, runCycle, DEFAULT_CYCLE, type CycleDeps, type TaskWork } from "../harness-lab/cycle.js";
import { buildDigest } from "../harness-lab/digest.js";
import { buildPromptChanges, emitProposal } from "../harness-lab/proposal.js";
import { parseReflection } from "../harness-lab/reflector.js";
import { appendEntries, finalVerdict, readEntries, renderIndex, type ExperienceEntry } from "../harness-lab/library.js";
import type { GateDecision } from "../harness-lab/gate.js";
import type { HarnessTask } from "../harness-lab/task-schema.js";
import type { LabRunRecord } from "../harness-lab/turn-runner.js";

const dirs: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };

function record(failures: string[] = [], reply = "Done."): LabRunRecord {
  return {
    taskId: "t", arm: "base", attempt: 1, sessionId: "s1", durationMs: 1, stubbedCalls: [],
    turns: [{ message: "Compare the three offers from Kessler Bau.", status: "ok", reply, durationMs: 1, toolCalls: [], events: [], artifacts: [], checkFailures: failures, checked: true }],
  };
}

const task: HarnessTask = { id: "t", title: "t", origin: "manual", tags: [], domain: "documents", role: "both", requires: [], turns: [{ message: "Compare the three offers from Kessler Bau." }] };

function ctx(over: Partial<EditContext> = {}): EditContext {
  return { editor: "DOM", idPrefix: "DOM-t", digest: buildDigest(record()), prompts: { main_assistant: "Base." }, taskText: "Compare the three offers from Kessler Bau.", ...over };
}

const skillEdit = { op: "add_skill", scope: "structure", name: "Offer comparison", whenToUse: "When several offers of the same kind are compared.", text: "1. Put the offers side by side.\n2. Name the price, the scope and the deadline of each.\n3. Recommend one and say why.", moment: "M1", why: "The reply compared nothing." };

describe("skill candidates", () => {
  it("validate as their own edit kind, outside the prompts", () => {
    const edit = validateEdit(skillEdit, 0, ctx());
    expect(edit).toMatchObject({ op: "add_skill", target: "skills", skillName: "Offer comparison" });
    expect(validateEdit({ ...skillEdit, whenToUse: "" }, 0, ctx())).toMatch(/needs a name, a whenToUse/);
    expect(validateEdit({ ...skillEdit, whenToUse: "When offers from Kessler Bau are compared." }, 0, ctx())).toMatch(/task's words/);
    expect(applyEdits({ main_assistant: "Base." }, [edit as LabEdit])).toEqual({});
    expect(armFor("c", { main_assistant: "Base." }, [edit as LabEdit])).toEqual({ name: "c", skills: [{ name: "Offer comparison", whenToUse: skillEdit.whenToUse, procedure: skillEdit.text }] });
    expect(buildPromptChanges({ main_assistant: "Base." }, [edit as LabEdit], () => "")).toEqual([]);
  });

  it("are not proposed as config: a candidate that only adds skills is refused with where to add them", () => {
    const gate = { verdict: "accept", evidence: "deterministic", reasons: [], tallies: [], unscoredRate: 0, signTestP: null } as GateDecision;
    const edit = validateEdit(skillEdit, 0, ctx()) as LabEdit;
    expect(emitProposal({ liveWorkspacePath: "/nowhere", runId: "r", basePrompts: {}, edits: [edit], composerRows: [], gate })).toEqual({ refused: expect.stringMatching(/Skills page/) });
  });

  it("an edit may name an experience entry only if the editor was shown it", () => {
    const rule = { op: "append_rule", target: "main_assistant", scope: "structure", text: "Lay comparable items side by side.", moment: "M1", why: "" };
    expect(validateEdit({ ...rule, fromEntry: "L3" }, 0, ctx({ libraryIds: new Set(["L3"]) }))).toMatchObject({ fromEntry: "L3" });
    expect(validateEdit({ ...rule, fromEntry: "L9" }, 0, ctx({ libraryIds: new Set(["L3"]) }))).toMatch(/not an entry you were shown/);
  });
});

describe("arm isolation with skills", () => {
  afterEach(() => { setSkillSnapshot(null); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("every attempt starts from the live library's copy; only the candidate sees its skill; the live library is untouched", async () => {
    process.env["SAI_HARNESS_LAB_PROCESS"] = "1";
    const live = tmp("lab-live-");
    writeSkill(live, { name: "Live Procedure", description: "Live.", procedure: "Do the live thing carefully.", status: "active" });
    const before = readFileSync(join(skillsDir(live), "live-procedure", "skill.meta.json"), "utf8");
    setSkillSnapshot(snapshotSkills(live, join(tmp("lab-snap-"), "skills")));
    const scratch = tmp("lab-scratch-");
    const seen: Record<string, string[]> = {};
    for (const arm of [{ name: "base" }, { name: "cand", skills: [{ name: "Offer comparison", whenToUse: "When offers are compared.", procedure: "Put them side by side and recommend one." }] }]) {
      await withArm(arm, scratch, "a1", async (ws) => { seen[arm.name] = listSkills(ws).map((s) => s.frontmatter.slug).sort(); });
    }
    delete process.env["SAI_HARNESS_LAB_PROCESS"];
    expect(seen).toEqual({ base: ["live-procedure"], cand: ["live-procedure", "offer-comparison"] });
    expect(listSkills(live).map((s) => s.frontmatter.slug)).toEqual(["live-procedure"]);
    expect(readFileSync(join(skillsDir(live), "live-procedure", "skill.meta.json"), "utf8")).toBe(before);
  });
});

function work(over: Partial<TaskWork> = {}): TaskWork {
  const pair = (b: number, c: number) => ({ base: { unscored: false, delivered: true, checksFailed: b, recordedDefects: 0 }, candidate: { unscored: false, delivered: true, checksFailed: c, recordedDefects: 0 } });
  return { taskId: "t", references: [record()], editors: [], probes: [], composedRuns: [], pairs: [pair(1, 0), pair(1, 0)], outcome: "win", reason: "", ...over };
}

describe("reflector", () => {
  const answer = (over: Record<string, unknown>) => JSON.stringify({ cue: "several comparable offers are to be weighed", component: "main_assistant", lesson: "A side-by-side rule made the reply compare instead of list.", evidence: ["kept -> DOM-t-1 -> both probes compared"], confidence: "high", ...over });

  it("keeps an evidence-backed lesson, and high confidence only for a task won on the record", () => {
    expect(parseReflection(answer({}), task, work())).toMatchObject({ confidence: "high", component: "main_assistant" });
    const tied = work({ pairs: [{ base: { unscored: false, delivered: true, checksFailed: 0, recordedDefects: 0 }, candidate: { unscored: false, delivered: true, checksFailed: 0, recordedDefects: 0 }, selector: "candidate" }] });
    expect(parseReflection(answer({}), task, tied)).toMatchObject({ confidence: "medium" });
  });

  it("declines without evidence, with the task's facts in its cue, or when the reflector says so", () => {
    expect(parseReflection(answer({ evidence: [] }), task, work())).toEqual({ noEntry: "the lesson cites no evidence" });
    expect(parseReflection(answer({ cue: "the three offers from Kessler Bau are compared" }), task, work())).toMatchObject({ noEntry: expect.stringMatching(/task's words/) });
    expect(parseReflection('{"noEntry": "the runs differ only by noise"}', task, work())).toEqual({ noEntry: "the runs differ only by noise" });
  });
});

describe("experience library", () => {
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const entry = (domain: string, lesson: string): Omit<ExperienceEntry, "id" | "ts"> => ({ runId: "r", taskId: "t", domain, cue: "c", component: "main_assistant", lesson, evidence: ["e"], confidence: "medium", verdict: "helped" });

  it("numbers entries across runs, writes an index, and shows the task's own domain first within its budget", () => {
    const dir = join(tmp("lab-lib-"), "library");
    appendEntries(dir, [entry("code", "first"), entry("documents", "second")]);
    const [third] = appendEntries(dir, [entry("code", "third")]);
    expect(third?.id).toBe("L3");
    expect(readEntries(dir).map((e) => e.id)).toEqual(["L1", "L2", "L3"]);
    expect(existsSync(join(dir, "INDEX.md"))).toBe(true);
    const index = renderIndex(readEntries(dir), { domain: "documents" });
    expect(index.split("\n")[0]).toMatch(/^L2 /);
    expect(renderIndex(readEntries(dir), {}, 60).split("\n")).toHaveLength(1);
  });

  it("tolerates a torn line", () => {
    const dir = join(tmp("lab-lib-"), "library");
    appendEntries(dir, [entry("code", "first")]);
    writeFileSync(join(dir, "entries.jsonl"), `${readFileSync(join(dir, "entries.jsonl"), "utf8")}{"id":"L2",`, "utf8");
    expect(readEntries(dir).map((e) => e.id)).toEqual(["L1"]);
  });

  it("sets each verdict from what the run showed once the gate decided", () => {
    const gate = (verdict: GateDecision["verdict"], guardLost = false) => ({ verdict, evidence: "none", reasons: [], unscoredRate: 0, signTestP: null, tallies: guardLost ? [{ taskId: "g", role: "guard", wins: 0, losses: 2, ties: 0, unscored: 0, selectorWins: 0, selectorLosses: 0 }] : [] }) as GateDecision;
    expect(finalVerdict(work(), gate("accept"))).toBe("helped");
    expect(finalVerdict(work(), gate("reject", true))).toBe("hurt");
    expect(finalVerdict(work(), gate("reject"))).toBe("no effect");
    expect(finalVerdict(work(), gate("no_verdict"))).toBe("confounded");
    expect(finalVerdict(work({ outcome: "keep_base", pairs: [{ base: { unscored: false, delivered: true, checksFailed: 0, recordedDefects: 0 }, candidate: { unscored: false, delivered: false, checksFailed: 0, recordedDefects: 0 } }] }), undefined)).toBe("hurt");
  });
});

describe("a cycle with a library", () => {
  beforeEach(() => undefined);

  it("shows the editors the index and asks the reflector after each worked task", async () => {
    const shown: string[] = [];
    const deps: CycleDeps = {
      basePrompts: () => ({ main_assistant: "Base." }),
      log: () => undefined,
      reflect: true,
      libraryIndex: () => "L7 [helped, medium] (main_assistant) when lists are asked for → say how many items",
      runAttempt: async (t, arm) => {
        const fixed = arm.mainAssistantInstructions?.includes("Name every item") === true;
        return { ...record(fixed || t.id !== "t" ? [] : ["reply misses an item"]), taskId: t.id, arm: arm.name };
      },
      complete: async (role, _system, user) => {
        if (role === "editor") {
          shown.push(user);
          return JSON.stringify({ edits: [{ op: "append_rule", target: "main_assistant", scope: "completion", text: "Name every item the task asked for.", moment: "M1", fromEntry: "L7", why: "" }] });
        }
        if (role === "composer") return JSON.stringify({ rows: [...new Set(user.match(/(?:INV|DOM)-t-\d+/g) ?? [])].map((id) => ({ decision: "kept", edit: id, evidence: "x" })) });
        if (role === "reflector") return JSON.stringify({ cue: "a list of items is asked for", component: "main_assistant", lesson: "Naming every item fixed the omission.", evidence: ["kept -> INV-t-1"], confidence: "medium" });
        return '{"winner": "tie"}';
      },
    };
    const result = await runCycle([task, { ...task, id: "g", role: "guard" }], DEFAULT_CYCLE, deps);
    expect(shown[0]).toContain("L7 [helped, medium]");
    expect(result.tasks[0]?.editors[0]?.outcome).toMatchObject({ kind: "edits", edits: [expect.objectContaining({ fromEntry: "L7" })] });
    expect(result.reflections).toEqual([{ taskId: "t", domain: "documents", reflection: expect.objectContaining({ cue: "a list of items is asked for" }) }]);
  });
});
