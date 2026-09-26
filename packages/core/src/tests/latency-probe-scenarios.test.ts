/**
 * The latency probe (scripts/latency-probe.ts) is only worth its numbers if it sends what production
 * sends and reads the answers right. These tests hold three things in place without calling a model:
 *
 * - The prompts are the production call sites' own. Five come from exported builders; the goal-met
 *   oversight, the finding distillation and the QA verdict build theirs inline, so their copies are
 *   compared with what the real functions hand the provider (or, for the QA verdict inside
 *   runtime.ts, with the source text). The orchestrator head is compared with what the warm-keeper
 *   sends.
 * - The plans put the right calls in the right order: nonces where a call must be cold, identical
 *   bodies where a call must be warm, the concurrency and the abort each experiment needs.
 * - The math and the verdicts: timings parsed, queue = wall - prompt - generation, and each verdict
 *   decided on canned timings that sit on either side of its threshold.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as S from "../agent/latency-probe-scenarios.js";
import { classifyFrontDesk, buildReceptionistMessages } from "../agent/receptionist.js";
import { buildProgressJudgePrompt } from "../agent/progress-verifier.js";
import { buildDisagreementCheckMessages } from "../agent/sub-agent-disagreement.js";
import {
  UNGROUNDED_JUDGE_MIN_CHARS,
  buildSourceSensitiveQuestionJudgeMessages,
  buildUngroundedClaimJudgeMessages,
} from "../agent/ungrounded-claim-judge.js";
import { formatQaTurnRecord } from "../agent/qa-turn-record.js";
import { DECISION_POINTS } from "../decisions/points.js";
import { computeOutputTokenBudget, estimatePromptTokensForRequest, type LLMMessage, type LLMToolDef } from "../providers/lmstudio.js";

const SETTINGS: S.DecisionPromptSettings = {
  receptionist: { confidenceAttempt: false, personaLines: [], defaultLanguage: "German" },
  qaRequireEvidence: true,
};

const tool = (name: string): LLMToolDef => ({ name, description: `${name} does one thing`, parameters: { type: "object", properties: { q: { type: "string" } } } });

const HEAD: S.HeadShape = {
  label: "orchestrator",
  system: "You are the main assistant.\n\nFirst rules paragraph with enough words to have a middle.\n\nSecond rules paragraph.\n\nThird paragraph closes it.",
  tools: [tool("delegate_to_agent"), tool("search_agents"), tool("memory_store")],
};
const SUB_HEAD: S.HeadShape = { label: "sub_agent:probe", system: "You render pictures.\n\nAgent name: probe", tools: [tool("generate_image")] };
const SUBSET = [tool("delegate_to_agent")];

function context(overrides: Partial<S.PlanContext> = {}): S.PlanContext {
  return {
    runId: "run1",
    reps: 2,
    settings: SETTINGS,
    orchestratorHead: HEAD,
    subAgentHead: SUB_HEAD,
    forcedSubsetTools: SUBSET,
    abortAfterMs: 20,
    prewarmStaggerMs: 1500,
    ...overrides,
  };
}

const requestsOf = (plan: S.ExperimentPlan): S.ProbeRequest[] => plan.phases.flatMap((phase) => phase.calls.map((call) => call.request));
const firstSystem = (request: S.ProbeRequest): string => String(request.messages[0]?.content ?? "");
const nonceLine = (nonce: string): string => String(S.withNonce([], nonce)[0]!.content);
const lastUser = (request: S.ProbeRequest): string => String(request.messages[request.messages.length - 1]?.content ?? "");

// ── Production prompts ─────────────────────────────────────────────────────────────────────────

describe("decision prompts are the production builders' own", () => {
  it("builds the receptionist prompt from the short message production sends to the micro-call", () => {
    for (const language of S.PROBE_LANGUAGES) {
      for (let i = 0; i < S.SYNTHETIC_TOPIC_COUNT + 2; i += 1) {
        const c = S.syntheticCase(language, i);
        for (const confidenceAttempt of [false, true]) {
          const settings = { ...SETTINGS, receptionist: { ...SETTINGS.receptionist, confidenceAttempt } };
          expect(S.buildDecisionMessages("fast_lane", c, settings)).toEqual(buildReceptionistMessages(c.short, {
            memoryCapsule: S.SYNTHETIC_MEMORY_CAPSULE,
            personaLines: [],
            confidenceAttempt,
            defaultLanguage: "German",
          }));
        }
        // Stage 0 escalates anything else without a call, so only such a message costs a micro-call.
        expect(classifyFrontDesk(c.short)).toEqual({ fastLane: true });
      }
    }
    expect(S.SYNTHETIC_MEMORY_CAPSULE.length).toBeLessThanOrEqual(400);
  });

  it("passes the assistant's name through when the deployment has one", () => {
    const named = { ...SETTINGS, receptionist: { ...SETTINGS.receptionist, assistantName: "Probe" } };
    expect(String(S.buildDecisionMessages("fast_lane", S.syntheticCase("en", 0), named)[0]!.content)).toContain('you are "Probe"');
  });

  it("uses the judges', the disagreement check's and the progress judge's exported builders", () => {
    for (const language of S.PROBE_LANGUAGES) {
      const c = S.syntheticCase(language, 3);
      expect(S.buildDecisionMessages("source_sensitive", c, SETTINGS)).toEqual(buildSourceSensitiveQuestionJudgeMessages(c.message));
      expect(S.buildDecisionMessages("ungrounded_draft", c, SETTINGS)).toEqual(buildUngroundedClaimJudgeMessages(c.message, S.syntheticDraft(c)));
      expect(S.buildDecisionMessages("slices_disagree", c, SETTINGS)).toEqual(buildDisagreementCheckMessages(S.syntheticSlices(c)));
      expect(S.buildDecisionMessages("run_drifting", c, SETTINGS)).toEqual(buildProgressJudgePrompt({ objective: c.message, recentActivity: S.syntheticActivity(c) }));
    }
  });

  it("gives the post-draft judge drafts long enough that production would call it", () => {
    for (const language of S.PROBE_LANGUAGES) {
      for (let i = 0; i < S.SYNTHETIC_TOPIC_COUNT; i += 1) {
        expect(S.syntheticDraft(S.syntheticCase(language, i)).length).toBeGreaterThanOrEqual(UNGROUNDED_JUDGE_MIN_CHARS);
      }
    }
  });

  it("builds the QA verdict in the order runQaDeliveryGate writes it, with the evidence line when asked", () => {
    const c = S.syntheticCase("de", 1);
    const block = formatQaTurnRecord([{ role: "user" }], { opening: c.message, midTurn: [] });
    expect(block).toContain(c.message);
    const withEvidence = S.buildDecisionMessages("qa_verdict", c, SETTINGS);
    const expectedLines = (passLine: string) => [
      S.QA_VERDICT_LINES.intro,
      S.QA_VERDICT_LINES.criteriaHeader,
      "1. Die Antwort beantwortet jeden Teil der Anfrage.",
      "2. Konkrete Zahlen, Fristen und Beträge sind belegt oder als unbestätigt gekennzeichnet.",
      "3. Die Antwort ist auf Deutsch geschrieben.",
      block,
      "",
      S.QA_VERDICT_LINES.answerHeader,
      S.syntheticDraft(c),
      "",
      passLine,
      S.QA_VERDICT_LINES.scope,
      S.QA_VERDICT_LINES.fail,
    ].join("\n");
    expect(withEvidence).toEqual([
      { role: "system", content: S.QA_VERDICT_SYSTEM },
      { role: "user", content: expectedLines(S.QA_VERDICT_LINES.passWithEvidence) },
    ]);
    const plain = S.buildDecisionMessages("qa_verdict", c, { ...SETTINGS, qaRequireEvidence: false });
    expect(plain[1]!.content).toBe(expectedLines(S.QA_VERDICT_LINES.passPlain));
  });

  it("keeps the QA verdict's copied lines identical to runtime.ts", () => {
    const source = readFileSync(fileURLToPath(new URL("../agent/runtime.ts", import.meta.url)), "utf8");
    for (const line of [S.QA_VERDICT_SYSTEM, ...Object.values(S.QA_VERDICT_LINES)]) {
      expect(source, line.slice(0, 60)).toContain(JSON.stringify(line));
    }
    const squash = (text: string) => text.replace(/\s+/g, "");
    expect(squash(source)).toContain(squash('...crit.map((c, i) => `${i + 1}. ${c}`), ...(disputedEvidenceBlock ? [disputedEvidenceBlock] : []), ...(turnRecordBlock ? [turnRecordBlock] : []), "", "ANSWER:", current, "", passLine,'));
    expect(squash(source)).toContain(squash(`{ role: "system", content: ${JSON.stringify(S.QA_VERDICT_SYSTEM)} }, { role: "user", content: instruction },`));
  });

  it("has German and English cases for every shape, all distinct, and marks repeats past the topic list", () => {
    for (const shape of S.DECISION_SHAPES) {
      for (const language of S.PROBE_LANGUAGES) {
        const bodies = new Set<string>();
        for (let i = 0; i < S.SYNTHETIC_TOPIC_COUNT * 2; i += 1) {
          bodies.add(JSON.stringify(S.buildDecisionMessages(shape, S.syntheticCase(language, i), SETTINGS)));
        }
        expect(bodies.size, `${shape}/${language}`).toBe(S.SYNTHETIC_TOPIC_COUNT * 2);
      }
    }
    const repeat = S.syntheticCase("en", S.SYNTHETIC_TOPIC_COUNT + 1);
    expect(repeat.message).toBe(`${S.syntheticCase("en", 1).message} #${S.SYNTHETIC_TOPIC_COUNT + 1}`);
    expect(repeat.facts[0]).toContain(`#${S.SYNTHETIC_TOPIC_COUNT + 1}`);
    expect(S.syntheticCase("de", 0).language).toBe("de");
  });

  it("lays the progress digest out as the sub-agent loop lays it out for the judge", () => {
    const source = readFileSync(fileURLToPath(new URL("../agent/sub-agent.ts", import.meta.url)), "utf8");
    expect(source).toContain("`Latest output:\\n${String(lastAssistant.content).slice(0, 1200)}`");
    expect(source).toContain('`Recent tool calls: ${toolNames.slice(-8).join(", ")}`');
    expect(source).toContain('].filter(Boolean).join("\\n\\n") || "(no assistant output or tool calls yet)";');
    expect(S.PROGRESS_DIGEST_OUTPUT_CHARS).toBe(1_200);
    for (const language of S.PROBE_LANGUAGES) {
      const c = S.syntheticCase(language, 2);
      const [output, tools, ...rest] = S.syntheticActivity(c).split("\n\n");
      expect(rest).toEqual([]);
      expect(output).toBe(`Latest output:\n${S.syntheticDraft(c).slice(0, 1_200)}`);
      expect(tools).toMatch(/^Recent tool calls: [a-z_]+(, [a-z_]+)*$/);
    }
  });

  it("marks as Laya points exactly the shapes decisions/points.ts defines", () => {
    for (const shape of S.DECISION_SHAPES) expect(S.DECISION_PLACEMENT[shape].layaPoint, shape).toBe(shape in DECISION_POINTS);
    // The distillation is joined only where its text is read; every other call is awaited.
    expect(S.DECISION_SHAPES.filter((shape) => !S.DECISION_PLACEMENT[shape].awaited)).toEqual(["finding_relevant"]);
  });

  it("gives the distillation page chrome only, sized like a fetched page", () => {
    const c = S.syntheticCase("en", 2);
    const chrome = S.syntheticPageChrome(c);
    expect(chrome.length).toBeGreaterThan(1_500);
    expect(chrome.length).toBeLessThanOrEqual(6_000);
    for (const fact of c.facts) expect(chrome).not.toContain(fact.slice(0, 30));
  });
});

// ── Against the running code: warm-keeper, goal-met, distillation ───────────────────────────────

let tempDir: string | undefined;

afterEach(async () => {
  vi.doUnmock("../providers/index.js");
  delete process.env["SAI_CONFIG_PATH"];
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
  vi.resetModules();
  (await import("../config/loader.js")).resetConfigForTests();
});

interface Captured {
  warm: Array<{ messages: LLMMessage[]; tools: LLMToolDef[] }>;
  tier: LLMMessage[][];
}

/** Fresh modules on a temp config, with the providers replaced by recorders. */
async function boot(performance: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<{ captured: Captured; S: typeof S }> {
  vi.resetModules();
  tempDir = mkdtempSync(join(tmpdir(), "starlingai-latency-probe-"));
  const configPath = join(tempDir, "starlingai.json");
  const manyTools = ["read_file", "write_file", "list_files", "edit_file", "memory_search", "memory_store", "web_search", "web_fetch", "recall_context", "record_plan", "get_swarm_state", "search_agents", "list_agents", "delegate_to_agent"];
  writeFileSync(configPath, JSON.stringify({
    agents: {
      defaults: { model: { primary: "lmstudio/qwen" } },
      mainAssistant: { toolMode: "orchestration_only" },
      performance: { promptCacheWarmKeeper: true, ...performance },
    },
    subAgents: {
      probe_agent: { description: "Finds things.", systemPrompt: "You find things and report them.", tools: ["read_file", "list_files"] },
      wide_agent: { description: "Does much.", systemPrompt: "You do much.", tools: manyTools },
    },
    workspacePath: tempDir,
    ...extra,
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  delete process.env["SAI_LAYA_URL"];
  const captured: Captured = { warm: [], tier: [] };
  const reply = (content: string) => ({ content, tool_calls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" });
  vi.doMock("../providers/index.js", async () => ({
    ...(await vi.importActual<Record<string, unknown>>("../providers/index.js")),
    getChatProvider: () => ({
      complete: async (messages: LLMMessage[], tools: LLMToolDef[]) => {
        captured.warm.push({ messages, tools: tools ?? [] });
        return reply("ok");
      },
    }),
    getChatProviderForTier: () => ({
      complete: async (messages: LLMMessage[]) => {
        captured.tier.push(messages);
        return reply("CONTINUE");
      },
    }),
  }));
  await import("../tools/register-builtins.js");
  const fresh = await import("../agent/latency-probe-scenarios.js");
  return { captured, S: fresh };
}

async function warmOnce(): Promise<void> {
  const warmer = await import("../agent/cache-warmer.js");
  warmer.startCacheWarmer();
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
  warmer.stopCacheWarmer();
}

describe("the probe's heads and inline prompts match the running code", () => {
  it("builds the orchestrator head exactly as the warm-keeper sends it, split and unsplit", async () => {
    const systems: string[] = [];
    for (const split of [false, true]) {
      const { captured, S: fresh } = await boot({ splitOrchestrationPrompt: split });
      await warmOnce();
      const head = fresh.collectOrchestratorHead();
      expect(captured.warm).toHaveLength(1);
      expect(captured.warm[0]!.messages).toEqual(fresh.headMessages(head, "."));
      expect(captured.warm[0]!.messages).toEqual(fresh.productionHeadRequest(head, fresh.PRODUCTION_HEAD_BEFORE).messages);
      expect(captured.warm[0]!.tools).toEqual(head.tools);
      expect(head.tools.length).toBeGreaterThan(10);
      systems.push(head.system);
      vi.doUnmock("../providers/index.js");
      rmSync(tempDir!, { recursive: true, force: true });
      tempDir = undefined;
      (await import("../config/loader.js")).resetConfigForTests();
    }
    // The split must change the head, or the comparison above could not tell the two modes apart.
    expect(systems[0]).not.toBe(systems[1]);
  });

  it("copies the goal-met oversight prompt exactly, clipping included", async () => {
    const { captured, S: fresh } = await boot({});
    const { assessOversightGoalMet } = await import("../agent/sub-agent.js");
    const c = fresh.syntheticCase("de", 2);
    const criteria = ["Die Antwort nennt die Förderprogramme.", "Jede Angabe hat eine Quelle."];
    const longEvidence = `${fresh.syntheticEvidence(c)}\n${"x".repeat(3_500)}`;
    for (const evidence of [fresh.syntheticEvidence(c), longEvidence, ""]) {
      captured.tier.length = 0;
      await assessOversightGoalMet(criteria, evidence);
      expect(captured.tier).toHaveLength(1);
      expect(captured.tier[0]).toEqual(fresh.buildGoalMetMessages(criteria, evidence));
    }
  });

  it("copies the finding-distillation prompt exactly, clipping included", async () => {
    const { S: fresh } = await boot({});
    const { distillFindingForSharedFacts } = await import("../agent/sub-agent.js");
    const c = fresh.syntheticCase("en", 4);
    const seen: LLMMessage[][] = [];
    const provider = {
      complete: async (messages: LLMMessage[]) => {
        seen.push(messages);
        return { content: "NONE", tool_calls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, finishReason: "stop" };
      },
    };
    const cases: Array<[string, string]> = [
      [c.message, fresh.syntheticPageChrome(c)],
      [`  ${"objective ".repeat(90)}\n  with   spaces`, "y".repeat(7_000)],
    ];
    for (const [objective, raw] of cases) {
      seen.length = 0;
      await distillFindingForSharedFacts({ objective, toolName: "web_fetch", rawEvidence: raw, provider: provider as never });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toEqual(fresh.buildFindingDistillMessages(objective, "web_fetch", raw));
    }
  });

  it("shapes a sub-agent head from the agent's prompt and tools, capped, and refuses an unknown agent", async () => {
    const { S: fresh } = await boot({});
    const head = fresh.collectSubAgentShapedHead("probe_agent", "Friday, September 25, 2026");
    expect(head.system.startsWith("You find things and report them.\n\nAgent name: probe_agent\nCurrent workspace: ")).toBe(true);
    expect(head.system.endsWith("\nToday's date: Friday, September 25, 2026")).toBe(true);
    expect(head.tools.map((t) => t.name).sort()).toEqual(["list_files", "read_file"]);
    expect(fresh.collectSubAgentShapedHead("wide_agent").tools.length).toBe(fresh.SUB_AGENT_HEAD_MAX_TOOLS);
    expect(() => fresh.collectSubAgentShapedHead("no_such_agent")).toThrow(/no sub-agent "no_such_agent"/);
    expect(fresh.subAgentHeadDate(new Date(2026, 8, 25))).toBe("Friday, September 25, 2026");
  });

  it("shapes E8's staged-builder head: the fresh staged directive first, the agent's prompt, and every tool uncapped", async () => {
    const { S: fresh } = await boot({});
    const { buildStagedArtifactBuildGuidance } = await import("../agent/sub-agent-prompt-guidance.js");
    const head = fresh.collectStagedBuilderHead("wide_agent", "Friday, September 25, 2026");
    expect(head.system.startsWith(`${buildStagedArtifactBuildGuidance()}\n\nYou do much.\n\nAgent name: wide_agent\n`)).toBe(true);
    // No SUB_AGENT_HEAD_MAX_TOOLS cap: the head is the agent's whole tool block, as the runner sends it.
    expect(head.tools.length).toBeGreaterThan(fresh.SUB_AGENT_HEAD_MAX_TOOLS);
    expect(() => fresh.collectStagedBuilderHead("no_such_agent")).toThrow(/no sub-agent "no_such_agent"/);
  });

  it("reads the decision settings the way the call sites read them", async () => {
    const off = { qaEvidenceRequired: false, qaToolJudge: false, qaStrictVerdicts: false };
    const { S: plain } = await boot({}, { orchestration: off });
    const settings = plain.collectDecisionSettings();
    expect(settings.receptionist.confidenceAttempt).toBe(false);
    expect(settings.qaRequireEvidence).toBe(false);
    expect(typeof settings.receptionist.defaultLanguage).toBe("string");
    expect(Array.isArray(settings.receptionist.personaLines)).toBe(true);
    vi.doUnmock("../providers/index.js");
    (await import("../config/loader.js")).resetConfigForTests();
    const { S: strict } = await boot({}, { receptionist: { enabled: true, confidenceAttempt: true }, orchestration: { ...off, qaStrictVerdicts: true } });
    const strictSettings = strict.collectDecisionSettings();
    expect(strictSettings.receptionist.confidenceAttempt).toBe(true);
    expect(strictSettings.qaRequireEvidence).toBe(true);
  });
});

// ── The wire ───────────────────────────────────────────────────────────────────────────────────

describe("the request body", () => {
  const wire: S.WireOptions = { model: "qwen", contextWindow: 131_072, declaredMaxTokens: 8_192 };

  it("sends the provider's shape: folded system, mapped tools, thinking off, cache_prompt, temperature 0", () => {
    const request: S.ProbeRequest = { step: "cold", shape: "orchestrator_head", messages: S.withNonce(S.headMessages(HEAD, "hi"), "n1"), tools: HEAD.tools, maxTokens: 1 };
    const body = S.buildWireBody(request, wire);
    expect(body["model"]).toBe("qwen");
    expect(body["messages"]).toEqual([
      { role: "system", content: `${nonceLine("n1")}\n\n${HEAD.system}` },
      { role: "user", content: "hi" },
    ]);
    expect(body["tools"]).toEqual(HEAD.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })));
    expect(body["tool_choice"]).toBe("auto");
    expect(body["temperature"]).toBe(0);
    expect(body["stream"]).toBe(false);
    expect(body["cache_prompt"]).toBe(true);
    expect(body["chat_template_kwargs"]).toEqual({ enable_thinking: false });
    expect(body["reasoning_effort"]).toBe("none");
    expect(body["max_tokens"]).toBe(1);
  });

  it("leaves tools out of a tool-less call and sends the production budget when the probe sets none", () => {
    const messages = S.buildDecisionMessages("source_sensitive", S.syntheticCase("en", 0), SETTINGS);
    const request: S.ProbeRequest = { step: "warm", shape: "source_sensitive", messages, tools: [] };
    const body = S.buildWireBody(request, wire);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body["max_tokens"]).toBe(8_192);
    const uncapped = S.buildWireBody(request, { model: "qwen", contextWindow: 32_768 });
    expect(uncapped["max_tokens"]).toBe(computeOutputTokenBudget({ contextWindow: 32_768, estimatedPromptTokens: estimatePromptTokensForRequest(messages, []) }));
    expect(uncapped["max_tokens"]).toBeGreaterThan(20_000);
  });
});

// ── Plans ──────────────────────────────────────────────────────────────────────────────────────

describe("experiment plans", () => {
  it("E1: a cold call with its own nonce, a prime, warm calls in both languages, then the last warm call repeated", () => {
    const plan = S.buildExperimentPlan("E1", context({ reps: 3 }));
    expect(plan.question).toBe(S.EXPERIMENT_QUESTIONS.E1);
    const requests = requestsOf(plan);
    expect(requests).toHaveLength(S.DECISION_SHAPES.length * (1 + 1 + 2 * 3 + 1));
    const colds = new Set<string>();
    for (const shape of S.DECISION_SHAPES) {
      const mine = requests.filter((r) => r.shape === shape);
      expect(mine.map((r) => r.step)).toEqual(["cold", "prime", "warm", "warm", "warm", "warm", "warm", "warm", "repeat"]);
      expect(firstSystem(mine[0]!)).toBe(nonceLine(`run1-E1-r0-${shape}`));
      colds.add(firstSystem(mine[0]!));
      for (const warm of mine.slice(1)) expect(firstSystem(warm)).not.toContain("latency probe");
      // The prime puts the warm calls' static system part into the cache, with a case of its own.
      const [prime, ...warms] = mine.slice(1, 8);
      expect(firstSystem(prime!)).toBe(firstSystem(warms[0]!));
      for (const warm of warms) expect(prime!.messages).not.toEqual(warm.messages);
      expect(mine.slice(2, 8).map((r) => r.language)).toEqual(["de", "en", "de", "en", "de", "en"]);
      expect(mine[8]!.messages).toEqual(mine[7]!.messages);
      expect(new Set(mine.slice(2, 8).map((r) => JSON.stringify(r.messages))).size).toBe(6);
      for (const r of mine) {
        expect(r.tools).toEqual([]);
        expect(r.maxTokens).toBeUndefined();
      }
    }
    expect(colds.size).toBe(S.DECISION_SHAPES.length);
    expect(plan.phases.every((phase) => phase.calls.length === 1)).toBe(true);
  });

  it("opens every nonce line with a start no other nonce of the run shares, so a cold call finds nothing cached", () => {
    const ctx = context({ reps: 3, stagedBuilderHead: STAGED, forcedHeads: FORCED });
    const lines = new Set<string>();
    for (const id of S.EXPERIMENT_IDS) {
      for (const r of requestsOf(S.buildExperimentPlan(id, ctx))) if (firstSystem(r).includes("latency probe")) lines.add(firstSystem(r));
    }
    const all = [...lines];
    expect(all.length).toBeGreaterThan(30);
    let longest = 0;
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        let n = 0;
        while (n < all[i]!.length && all[i]![n] === all[j]![n]) n += 1;
        longest = Math.max(longest, n);
      }
    }
    // "[" and a hex digit or two of the hash: a few tokens, far under COLD_CACHE_TOKENS. Opened with
    // the nonce itself the lines shared "[latency probe run1-E" and more.
    expect(longest).toBeLessThanOrEqual(4);
    expect(S.nonceTag("run1-E1-r0-head")).toMatch(/^[0-9a-f]{8}$/);
    expect(S.nonceTag("run1-E1-r0-head")).not.toBe(S.nonceTag("run1-E1-r1-head"));
  });

  it("E2: appends that extend the previous prompt, history twice, then a change in the middle of the system text", () => {
    const plan = S.buildExperimentPlan("E2", context());
    for (const rep of [0, 1]) {
      const requests = plan.phases.filter((p) => p.rep === rep).flatMap((p) => p.calls.map((c) => c.request));
      expect(requests.map((r) => r.step)).toEqual([
        "cold", "append_1", "append_18", "append_100", "append_500", "append_2000", "history_first", "history_next_user", "mid_system_change",
      ]);
      for (const r of requests) {
        expect(firstSystem(r)).toBe(nonceLine(`run1-E2-r${rep}-head`));
        expect(r.maxTokens).toBe(S.HEAD_PROBE_MAX_TOKENS);
        expect(r.tools).toEqual(HEAD.tools);
      }
      const chain = requests.slice(0, 6).map(lastUser);
      for (let i = 1; i < chain.length; i += 1) {
        expect(chain[i]!.startsWith(chain[i - 1]!)).toBe(true);
        expect(chain[i]!.length).toBeGreaterThan(chain[i - 1]!.length);
      }
      expect(chain[5]!.length - chain[4]!.length).toBeGreaterThan(2000 * 3);
      expect(requests.slice(1, 6).map((r) => r.tags?.["appendedTokens"])).toEqual([...S.APPEND_STEPS]);
      const history = S.syntheticHistory();
      expect(requests[6]!.messages.slice(2, 2 + history.length)).toEqual(history);
      expect(requests[7]!.messages.slice(2, 2 + history.length)).toEqual(history);
      expect(lastUser(requests[7]!)).not.toBe(lastUser(requests[6]!));
      const mid = requests[8]!;
      expect(lastUser(mid)).toBe(chain[0]);
      const changed = String(mid.messages[1]!.content);
      const at = Number(mid.tags?.["changeAtChar"]);
      expect(changed.slice(0, at)).toBe(HEAD.system.slice(0, at));
      expect(changed).not.toBe(HEAD.system);
      expect(at).toBeGreaterThanOrEqual(Math.floor(HEAD.system.length / 2));
    }
    expect(firstSystem(requestsOf(plan)[0]!)).not.toBe(firstSystem(plan.phases.find((p) => p.rep === 1)!.calls[0]!.request));
  });

  it("E3: K distinct small calls between two head calls, for every K", () => {
    const plan = S.buildExperimentPlan("E3", context());
    const rep0 = plan.phases.filter((p) => p.rep === 0).flatMap((p) => p.calls.map((c) => c.request));
    expect(rep0[0]!.step).toBe("head_warmup");
    for (const k of S.INTERFERENCE_KS) {
      const small = rep0.filter((r) => r.step === `small_k${k}`);
      expect(small).toHaveLength(k);
      expect(new Set(small.map((r) => firstSystem(r))).size).toBe(k);
      const headIndex = rep0.findIndex((r) => r.step === `head_after_k${k}`);
      expect(rep0[headIndex]!.tags).toEqual({ k });
      expect(rep0.slice(headIndex - k, headIndex).every((r) => r.step === `small_k${k}`)).toBe(true);
    }
  });

  it("E4: each shape alone, then the pair together, then four together", () => {
    const plan = S.buildExperimentPlan("E4", context());
    const rep0 = plan.phases.filter((p) => p.rep === 0);
    expect(rep0.map((p) => p.calls.length)).toEqual([1, 1, 1, 1, 2, 4]);
    expect(rep0[4]!.calls.map((c) => c.request.shape)).toEqual(["fast_lane", "source_sensitive"]);
    expect(rep0[5]!.calls.map((c) => c.request.shape)).toEqual(["fast_lane", "source_sensitive", "ungrounded_draft", "run_drifting"]);
    expect(rep0.flatMap((p) => p.calls).every((c) => c.startAfterMs === 0)).toBe(true);
    // The judge in the pair reads the same kind of short message the receptionist runs on.
    const shorts: string[] = [];
    const longs: string[] = [];
    for (const language of S.PROBE_LANGUAGES) {
      for (let i = 0; i < S.SYNTHETIC_TOPIC_COUNT; i += 1) {
        shorts.push(S.syntheticCase(language, i).short);
        longs.push(S.syntheticCase(language, i).message);
      }
    }
    for (const phase of rep0) {
      for (const call of phase.calls.filter((c) => c.request.shape === "source_sensitive")) {
        const text = lastUser(call.request);
        expect(shorts.some((s) => text.startsWith(s)), text).toBe(true);
        expect(longs.some((l) => text.startsWith(l)), text).toBe(false);
      }
    }
  });

  it("E5: the incumbent aborted after the set delay, the identical prompt resent, a completed one for contrast", () => {
    const plan = S.buildExperimentPlan("E5", context({ abortAfterMs: 35 }));
    const rep1 = plan.phases.filter((p) => p.rep === 1).flatMap((p) => p.calls.map((c) => c.request));
    expect(rep1.map((r) => r.step)).toEqual([
      "head_warmup", "head_after_nothing", "aborted_decision", "head_after_abort", "aborted_resend", "completed_decision", "head_after_completed",
    ]);
    const aborted = rep1[2]!;
    expect(aborted.abortAfterMs).toBe(35);
    expect(firstSystem(aborted)).toBe(nonceLine("run1-E5-r1-aborted"));
    expect(rep1[4]!.messages).toEqual(aborted.messages);
    expect(rep1[4]!.abortAfterMs).toBeUndefined();
    expect(firstSystem(rep1[5]!)).toBe(nonceLine("run1-E5-r1-completed"));
    expect(rep1[5]!.abortAfterMs).toBeUndefined();
  });

  it("E6: cold, prewarm then the call, and a prewarm still in flight when the call starts", () => {
    const plan = S.buildExperimentPlan("E6", context({ prewarmStaggerMs: 900 }));
    const rep0 = plan.phases.filter((p) => p.rep === 0);
    expect(rep0.map((p) => p.calls.map((c) => c.request.step))).toEqual([
      ["cold_first_call"], ["prewarm"], ["first_call_after_prewarm"], ["prewarm_concurrent", "first_call_concurrent"],
    ]);
    const [cold, prewarm, after] = rep0.slice(0, 3).map((p) => p.calls[0]!.request);
    expect(firstSystem(prewarm!)).toBe(firstSystem(after!));
    expect(firstSystem(cold!)).not.toBe(firstSystem(prewarm!));
    expect(lastUser(prewarm!)).toBe(".");
    expect(prewarm!.maxTokens).toBe(1);
    expect(prewarm!.tools).toEqual(SUB_HEAD.tools);
    const inFlight = rep0[3]!.calls;
    expect(inFlight.map((c) => c.startAfterMs)).toEqual([0, 900]);
    expect(firstSystem(inFlight[0]!.request)).toBe(firstSystem(inFlight[1]!.request));
    expect(new Set([cold, prewarm, inFlight[0]!.request].map((r) => firstSystem(r!))).size).toBe(3);
  });

  it("E7: full and subset tool blocks alternating on one head, and a cold subset", () => {
    const plan = S.buildExperimentPlan("E7", context());
    const rep0 = plan.phases.filter((p) => p.rep === 0).flatMap((p) => p.calls.map((c) => c.request));
    expect(rep0.map((r) => r.step)).toEqual(["full_cold", "full_warm", "subset_after_full", "subset_warm", "full_after_subset", "subset_after_full_again", "subset_cold"]);
    for (const r of rep0) expect(r.tools).toEqual(r.step.startsWith("full") ? HEAD.tools : SUBSET);
    const nonces = rep0.map((r) => firstSystem(r));
    expect(new Set(nonces.slice(0, 6)).size).toBe(1);
    expect(nonces[6]).not.toBe(nonces[0]);
  });
});

// ── Running ────────────────────────────────────────────────────────────────────────────────────

const TIMINGS_BODY = {
  model: "qwen",
  system_fingerprint: "b6500-abc",
  usage: { prompt_tokens: 540, completion_tokens: 6 },
  timings: { prompt_n: 12, cache_n: 528, prompt_ms: 40.5, predicted_n: 6, predicted_ms: 110 },
};

function transport(fetchImpl: typeof fetch, now: () => number = () => performance.now(), callTimeoutMs = 5_000): S.ProbeTransport {
  return { chatUrl: "http://station.invalid/v1/chat/completions", headers: { Authorization: "Bearer k" }, fetchImpl, now, callTimeoutMs };
}

const REQUEST: S.ProbeRequest = { step: "warm", shape: "source_sensitive", messages: [{ role: "user", content: "x" }], tools: [] };

describe("sending a call", () => {
  it("times from before the send to the last byte and reads usage, timings and the server's identity", async () => {
    const clock = [1_000, 1_850];
    let sent: RequestInit | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      sent = init;
      // Per-request headers stay out, or every call would read as a server of its own.
      return new Response(JSON.stringify(TIMINGS_BODY), {
        status: 200,
        headers: { "x-upstream": "evox2", "x-api-key": "secret", "x-request-id": "r-81f2", "x-response-time": "812ms" },
      });
    }) as typeof fetch;
    const outcome = await S.runProbeCall({ model: "qwen", n: 1 }, REQUEST, transport(fetchImpl, () => clock.shift() ?? 0));
    expect(outcome.status).toBe("ok");
    expect(outcome.wallMs).toBe(850);
    expect(outcome.promptTokens).toBe(540);
    expect(outcome.completionTokens).toBe(6);
    expect(outcome.timings).toEqual({ promptN: 12, cacheN: 528, cacheNDerived: false, promptMs: 40.5, predictedN: 6, predictedMs: 110 });
    expect(outcome.station).toBe("build=b6500-abc model=qwen x-upstream=evox2");
    expect(JSON.parse(String(sent?.body))).toEqual({ model: "qwen", n: 1 });
    expect((sent?.headers as Record<string, string>)["Authorization"]).toBe("Bearer k");
    expect(S.queueMsOf(outcome)).toBeCloseTo(850 - 40.5 - 110);
  });

  it("aborts a call when the plan says so and reports it as aborted, not failed", async () => {
    const hanging = ((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as typeof fetch;
    const outcome = await S.runProbeCall({}, { ...REQUEST, abortAfterMs: 5 }, transport(hanging));
    expect(outcome.status).toBe("aborted");
    expect(outcome.wallMs).toBeGreaterThanOrEqual(4);
    const timedOut = await S.runProbeCall({}, REQUEST, transport(hanging, undefined, 10));
    expect(timedOut.status).toBe("error");
  });

  it("reports an HTTP error and an answer that is not JSON as errors", async () => {
    const failing = (async () => new Response("model not found", { status: 404 })) as typeof fetch;
    expect(await S.runProbeCall({}, REQUEST, transport(failing))).toMatchObject({ status: "error", httpStatus: 404, error: "HTTP 404: model not found" });
    const garbled = (async () => new Response("<html>", { status: 200 })) as typeof fetch;
    expect(await S.runProbeCall({}, REQUEST, transport(garbled))).toMatchObject({ status: "error", error: "the answer is not JSON" });
    const plain = (async () => new Response(JSON.stringify({ usage: { prompt_tokens: 3 } }), { status: 200 })) as typeof fetch;
    const noTimings = await S.runProbeCall({}, REQUEST, transport(plain));
    expect(noTimings.status).toBe("ok");
    expect(noTimings.timings).toBeUndefined();
    expect(S.queueMsOf(noTimings)).toBeUndefined();
  });
});

describe("running plans", () => {
  const plan = (id: S.ExperimentId, phases: S.ProbePhase[]): S.ExperimentPlan => ({ id, question: "q", phases });
  const req = (step: string): S.ProbeRequest => ({ ...REQUEST, step });
  const ok: S.CallOutcome = { status: "ok", wallMs: 100, timings: { promptN: 10, cacheN: 5, cacheNDerived: false, promptMs: 30, predictedN: 1, predictedMs: 20 } };

  it("runs phases in order, the calls of a phase together after their offsets, and records each", async () => {
    const started: Array<{ step: string; at: number }> = [];
    const t0 = performance.now();
    const phasesSeen: number[] = [];
    const results = await S.runPlans([
      plan("E4", [
        { rep: 0, calls: [{ request: req("a"), startAfterMs: 0 }] },
        { rep: 1, calls: [{ request: req("b"), startAfterMs: 0 }, { request: req("c"), startAfterMs: 40 }] },
      ]),
      plan("E7", [{ rep: 0, calls: [{ request: req("d"), startAfterMs: 0 }] }]),
    ], async (request) => {
      started.push({ step: request.step, at: performance.now() - t0 });
      await new Promise((resolve) => setTimeout(resolve, 5));
      return ok;
    }, { now: () => performance.now(), runStartedAt: t0, onPhase: (r) => { phasesSeen.push(r.length); } });
    expect(started.map((s) => s.step)).toEqual(["a", "b", "c", "d"]);
    expect(started[2]!.at - started[1]!.at).toBeGreaterThanOrEqual(30);
    expect(phasesSeen).toEqual([1, 2, 1]);
    expect(results.map((r) => [r.experiment, r.phase, r.rep, r.inFlight, r.step])).toEqual([
      ["E4", 0, 0, 1, "a"], ["E4", 1, 1, 2, "b"], ["E4", 1, 1, 2, "c"], ["E7", 0, 0, 1, "d"],
    ]);
    expect(results[0]!.queueMs).toBe(50);
    expect(results[2]!.startedAtMs).toBeGreaterThanOrEqual(30);
  });

  it("skips every phase that would start after the deadline without sending it", async () => {
    let sent = 0;
    let clock = 0;
    const results = await S.runPlans([plan("E1", [
      { rep: 0, calls: [{ request: req("a"), startAfterMs: 0 }] },
      { rep: 0, calls: [{ request: req("b"), startAfterMs: 0 }] },
    ])], async () => {
      sent += 1;
      clock = 1_000;
      return ok;
    }, { now: () => clock, runStartedAt: 0, deadlineAt: 500 });
    expect(sent).toBe(1);
    expect(results.map((r) => r.status)).toEqual(["ok", "skipped"]);
  });
});

// ── Math ───────────────────────────────────────────────────────────────────────────────────────

describe("math", () => {
  it("parses llama.cpp timings, deriving cache_n from usage only when the build omits it", () => {
    expect(S.parseLlamaTimings(TIMINGS_BODY)).toEqual({ promptN: 12, cacheN: 528, cacheNDerived: false, promptMs: 40.5, predictedN: 6, predictedMs: 110 });
    const older = { usage: { prompt_tokens: 540 }, timings: { prompt_n: 12, prompt_ms: 40, predicted_n: 6, predicted_ms: 100 } };
    expect(S.parseLlamaTimings(older)).toMatchObject({ cacheN: 528, cacheNDerived: true });
    const bare = { timings: { prompt_n: 12, prompt_ms: 40, predicted_n: 6, predicted_ms: 100 } };
    expect(S.parseLlamaTimings(bare)).toEqual({ promptN: 12, cacheNDerived: false, promptMs: 40, predictedN: 6, predictedMs: 100 });
    expect(S.parseLlamaTimings({ timings: { prompt_n: 12, prompt_ms: Number.NaN, predicted_n: 1, predicted_ms: 1 } })).toBeUndefined();
    expect(S.parseLlamaTimings({ timings: { prompt_n: 12 } })).toBeUndefined();
    expect(S.parseLlamaTimings({})).toBeUndefined();
    expect(S.parseLlamaTimings(null)).toBeUndefined();
  });

  it("summarises with the middle value, the nearest-rank p90 and the range", () => {
    expect(S.summarize([5, 1, 3])).toEqual({ n: 3, median: 3, p90: 5, min: 1, max: 5 });
    expect(S.summarize([4, 1, 3, 2])).toEqual({ n: 4, median: 2.5, p90: 4, min: 1, max: 4 });
    expect(S.summarize(Array.from({ length: 10 }, (_, i) => i + 1))?.p90).toBe(9);
    expect(S.summarize([])).toBeNull();
    expect(S.median([Number.NaN, 2])).toBe(2);
  });

  it("fits cold prefill on cold calls only and recovers its rate and intercept", () => {
    const cold = (promptN: number, cacheN: number): S.CallResult => canned("E2", "cold", 0, { promptN, cacheN, promptMs: 200 + promptN * 1.1, wall: 0 });
    const fit = S.fitColdPrefill([cold(1_000, 0), cold(6_000, 3), cold(13_000, 16), cold(13_000, 12_990), cold(100, 0)]);
    expect(fit?.n).toBe(3);
    expect(fit?.msPerToken).toBeCloseTo(1.1);
    expect(fit?.interceptMs).toBeCloseTo(200);
    expect(fit?.tokensPerSecond).toBeCloseTo(909.09, 1);
    expect(S.fitLinear([[1, 1]])).toBeNull();
    expect(S.fitLinear([[2, 1], [2, 5]])).toBeNull();
  });

  it("calls a difference material only above both the absolute and the relative threshold", () => {
    expect(S.isMaterial(249, 100)).toBe(false);
    expect(S.isMaterial(250, 100)).toBe(true);
    expect(S.isMaterial(-300, 1_000)).toBe(true);
    expect(S.isMaterial(1_400, 10_000)).toBe(false);
    expect(S.isMaterial(1_500, 10_000)).toBe(true);
  });

  it("totals the prompt from usage, or from processed plus reused tokens", () => {
    const timings = { promptN: 10, cacheN: 90, cacheNDerived: false, promptMs: 1, predictedN: 1, predictedMs: 1 };
    expect(S.totalPromptTokens({ promptTokens: 120, timings })).toBe(120);
    expect(S.totalPromptTokens({ timings })).toBe(100);
    expect(S.cacheShare({ timings })).toBeCloseTo(0.9);
    expect(S.cacheShare({ timings: { ...timings, cacheN: undefined } })).toBeUndefined();
  });

  it("writes filler that grows as a prefix of itself", () => {
    const sizes = [1, 19, 119, 619, 2619];
    const texts = sizes.map((n) => S.fillerText(n));
    for (let i = 1; i < texts.length; i += 1) expect(texts[i]!.startsWith(texts[i - 1]!)).toBe(true);
    expect(S.fillerText(0)).toBe("");
    expect(Math.abs(texts[4]!.length - 2619 * S.FILLER_CHARS_PER_TOKEN)).toBeLessThan(120);
    expect(S.headUserMessage(0)).not.toBe(S.headUserMessage(1));
    expect(S.headUserMessage(7)).toMatch(/#h7$/);
  });
});

// ── Verdicts on canned timings ─────────────────────────────────────────────────────────────────

interface CannedOptions {
  wall?: number;
  promptN?: number;
  cacheN?: number;
  promptMs?: number;
  predictedMs?: number;
  promptTokens?: number;
  shape?: string;
  language?: S.ProbeLanguage;
  status?: S.CallResult["status"];
  station?: string;
  inFlight?: number;
}

function canned(experiment: string, step: string, rep: number, o: CannedOptions): S.CallResult {
  const wall = o.wall ?? 1_000;
  const timings = o.promptN === undefined
    ? undefined
    : { promptN: o.promptN, cacheN: o.cacheN ?? 0, cacheNDerived: false, promptMs: o.promptMs ?? 0, predictedN: 1, predictedMs: o.predictedMs ?? 0 };
  return {
    experiment,
    step,
    rep,
    phase: 0,
    shape: o.shape ?? "orchestrator_head",
    inFlight: o.inFlight ?? 1,
    startedAtMs: 0,
    status: o.status ?? "ok",
    wallMs: wall,
    ...(timings ? { timings, queueMs: wall - timings.promptMs - timings.predictedMs } : {}),
    ...(o.promptTokens !== undefined ? { promptTokens: o.promptTokens } : {}),
    ...(o.language ? { language: o.language } : {}),
    station: o.station ?? "model=qwen",
  };
}

const CTX: S.VerdictContext = { layaMs: 20 };

describe("E1 verdict", () => {
  function e1(overrides: Partial<Record<S.DecisionShape, { wall: number; promptMs: number }>> = {}, reps = 2): S.CallResult[] {
    const out: S.CallResult[] = [];
    for (const shape of S.DECISION_SHAPES) {
      const cost = overrides[shape] ?? { wall: 1_800, promptMs: 300 };
      out.push(canned("E1", "cold", 0, { shape, wall: cost.wall + 400, promptN: 540, promptMs: cost.promptMs + 400 }));
      // The prime pays for the static part; were it counted, every median below would move.
      out.push(canned("E1", "prime", 0, { shape, language: "en", wall: 9_000, promptN: 540, promptMs: 8_000 }));
      for (let rep = 0; rep < reps; rep += 1) {
        out.push(canned("E1", "warm", rep, { shape, language: "de", wall: cost.wall + 100, promptN: 30, cacheN: 510, promptMs: cost.promptMs, predictedMs: 110 }));
        out.push(canned("E1", "warm", rep, { shape, language: "en", wall: cost.wall - 100, promptN: 30, cacheN: 510, promptMs: cost.promptMs, predictedMs: 110 }));
      }
      out.push(canned("E1", "repeat", reps - 1, { shape, wall: 900, promptN: 1, cacheN: 539, promptMs: 20 }));
    }
    return out;
  }

  it("reports the saving per call per shape, per language, and which calls are floor-dominated", () => {
    const v = S.computeVerdict("E1", e1({
      goal_met: { wall: 1_900, promptMs: 300 },
      finding_relevant: { wall: 2_000, promptMs: 1_400 },
      qa_verdict: { wall: 2_500, promptMs: 300 },
    }), CTX);
    expect(v.conclusive).toBe(true);
    expect(v.code).toBe("measured");
    const fast = v.rows!.find((row) => row["shape"] === "fast_lane")!;
    expect(fast["warmWallMs"]).toBe(1_800);
    expect(fast["warmWallDeMs"]).toBe(1_900);
    expect(fast["warmWallEnMs"]).toBe(1_700);
    expect(fast["savingPerCallMs"]).toBe(1_780);
    expect(fast["kind"]).toBe("floor_dominated");
    expect(fast["repeatWallMs"]).toBe(900);
    expect(fast["coldWallMs"]).toBe(2_200);
    expect(fast["awaited"]).toBe("yes");
    expect(v.rows!.find((row) => row["shape"] === "finding_relevant")!["kind"]).toBe("prefill_dominated");
    expect(v.numbers["floorDominatedShapes"]).toBe(7);
    expect(v.answer).toContain("7 of 8");
    // The headline is Laya's points the turn waits for: the background distillation and the QA
    // verdict (no Laya point) keep their rows but stay out of it, whatever they cost.
    expect(v.rows).toHaveLength(8);
    expect(v.numbers["shapesCounted"]).toBe(6);
    expect(v.numbers["savingMaxMs"]).toBe(1_880);
    expect(v.numbers["savingMedianMs"]).toBe(1_780);
    expect(v.notes.join(" ")).toContain("finding_relevant runs beside the work");
    expect(v.notes.join(" ")).toContain("qa_verdict is no Laya decision point");
  });

  it("states the saving as a share of a turn when given one, and is inconclusive with a shape measured once", () => {
    const withTurn = S.computeVerdict("E1", e1(), { layaMs: 20, turnMs: 10_000 });
    expect(withTurn.rows![0]!["savingShareOfTurn"]).toBe(0.178);
    // A call the turn does not wait for is no share of the turn.
    expect(withTurn.rows!.find((row) => row["shape"] === "finding_relevant")!["savingShareOfTurn"]).toBeNull();
    const onlyUncounted = S.computeVerdict("E1", e1().filter((r) => r.shape === "finding_relevant" || r.shape === "qa_verdict"), CTX);
    expect(onlyUncounted.code).toBe("inconclusive");
    expect(onlyUncounted.rows).toHaveLength(2);
    const thin = e1().filter((r) => !(r.shape === "qa_verdict" && r.step === "warm" && (r.rep === 1 || r.language === "en")));
    const v = S.computeVerdict("E1", thin, CTX);
    expect(v.conclusive).toBe(false);
    expect(v.notes.join(" ")).toContain("qa_verdict");
    expect(S.computeVerdict("E1", [], CTX).code).toBe("inconclusive");
  });
});

describe("E2 verdict", () => {
  function e2(overhead: number, historyNextPromptN: number): S.CallResult[] {
    const out: S.CallResult[] = [];
    for (const rep of [0, 1]) {
      let total = 13_000;
      out.push(canned("E2", "cold", rep, { promptN: total, cacheN: 0, promptMs: 14_000, wall: 14_500 }));
      for (const n of S.APPEND_STEPS) {
        const next = total + n;
        const promptN = n + overhead;
        out.push(canned("E2", `append_${n}`, rep, { promptN, cacheN: next - promptN, promptMs: promptN * 1.2, predictedMs: 20, wall: 700 + promptN * 1.2 }));
        total = next;
      }
      out.push(canned("E2", "history_first", rep, { promptN: 1_210, cacheN: 12_990, promptMs: 1_500, wall: 2_100 }));
      out.push(canned("E2", "history_next_user", rep, { promptN: historyNextPromptN, cacheN: 14_200 - historyNextPromptN, promptMs: 100, wall: 800 }));
      out.push(canned("E2", "mid_system_change", rep, { promptN: 7_000, cacheN: 6_000, promptMs: 8_000, wall: 8_600 }));
    }
    return out;
  }

  it("calls reuse exact when appends re-process only the new tokens and the template's closing turn", () => {
    const v = S.computeVerdict("E2", e2(10, 30), CTX);
    expect(v.code).toBe("fixed_overhead");
    expect(v.conclusive).toBe(true);
    expect(v.numbers["overheadTokensMedian"]).toBe(10);
    expect(v.numbers["floorWallMs"]).toBe(713);
    expect(v.numbers["historyReused"]).toBe(1);
    expect(v.numbers["midSystemChangeCacheShare"]).toBeCloseTo(0.462, 3);
  });

  it("calls it checkpoint spacing when every append re-processes a fixed extra stretch, and sees a re-processed history", () => {
    const v = S.computeVerdict("E2", e2(520, 1_205), CTX);
    expect(v.code).toBe("checkpoint_spacing");
    expect(v.numbers["overheadTokensMedian"]).toBe(520);
    expect(v.numbers["historyReused"]).toBe(0);
    expect(v.answer).toContain("520 tokens");
  });

  it("is inconclusive without consecutive appends", () => {
    expect(S.computeVerdict("E2", e2(10, 30).filter((r) => r.step === "cold" || r.step === "append_1" && r.rep === 0), CTX).conclusive).toBe(false);
  });
});

describe("E3 verdict", () => {
  function e3(share: (k: number) => number, wall: (k: number) => number = () => 2_000, station = (_rep: number) => "model=qwen"): S.CallResult[] {
    const out: S.CallResult[] = [];
    for (const rep of [0, 1]) {
      for (const k of S.INTERFERENCE_KS) {
        const cacheN = Math.round(13_000 * share(k));
        out.push(canned("E3", `head_after_k${k}`, rep, { promptN: 13_000 - cacheN, cacheN, wall: wall(k), promptMs: 500, station: station(rep) }));
      }
    }
    return out;
  }

  it("finds the head surviving, evicted at a given K, or kept but slower", () => {
    expect(S.computeVerdict("E3", e3(() => 0.99), CTX).code).toBe("head_survives");
    // Lost with nothing between: no K can be blamed.
    const never = S.computeVerdict("E3", e3(() => 0.1), CTX);
    expect(never.code).toBe("head_not_reused");
    expect(never.conclusive).toBe(false);
    const evicted = S.computeVerdict("E3", e3((k) => (k >= 4 ? 0.1 : 0.99)), CTX);
    expect(evicted.code).toBe("head_evicted_at_k4");
    expect(evicted.numbers["k4EvictedReps"]).toBe(2);
    const slower = S.computeVerdict("E3", e3(() => 0.99, (k) => (k >= 2 ? 4_000 : 2_000)), CTX);
    expect(slower.code).toBe("head_kept_but_slower");
    expect(slower.numbers["k2ExtraWallMs"]).toBe(2_000);
  });

  it("does not trust a comparison across two servers or with a K missing", () => {
    const mixed = S.computeVerdict("E3", e3(() => 0.99, undefined, (rep) => (rep === 0 ? "model=a" : "model=b")), CTX);
    expect(mixed.conclusive).toBe(false);
    expect(mixed.notes[0]).toContain("2 different servers");
    expect(S.computeVerdict("E3", e3(() => 0.99).filter((r) => r.step !== "head_after_k2"), CTX).code).toBe("inconclusive");
  });
});

describe("E4 verdict", () => {
  function e4(pairWall: number): S.CallResult[] {
    const out: S.CallResult[] = [];
    for (const rep of [0, 1]) {
      for (const [shape, wall] of [["fast_lane", 1_500], ["source_sensitive", 1_500], ["ungrounded_draft", 1_600], ["run_drifting", 1_600]] as const) {
        out.push(canned("E4", "c1", rep, { shape, wall, promptN: 20, cacheN: 500, promptMs: 60, predictedMs: 110 }));
      }
      // The pair's two answers arrive 200 ms apart: the pair is done when the later one is.
      for (const [shape, offset] of [["fast_lane", -100], ["source_sensitive", 100]] as const) {
        out.push(canned("E4", "c2", rep, { shape, wall: pairWall + offset, promptN: 20, cacheN: 500, promptMs: 60, predictedMs: 110, inFlight: 2 }));
      }
      for (const [shape, wall] of [["fast_lane", 2_400], ["source_sensitive", 2_500], ["ungrounded_draft", 2_600], ["run_drifting", 2_700]] as const) {
        out.push(canned("E4", "c4", rep, { shape, wall, promptN: 20, cacheN: 500, promptMs: 60, predictedMs: 110, inFlight: 4 }));
      }
    }
    return out;
  }

  it("tells a parallel saving from no gain and from a loss", () => {
    const saves = S.computeVerdict("E4", e4(1_600), CTX);
    expect(saves.code).toBe("parallel_saves");
    expect(saves.numbers["savingPairMs"]).toBe(1_300);
    expect(saves.numbers["savingQuadMs"]).toBe(3_500);
    expect(S.computeVerdict("E4", e4(2_900), CTX).code).toBe("parallel_no_gain");
    expect(S.computeVerdict("E4", e4(3_600), CTX).code).toBe("parallel_hurts");
    expect(S.computeVerdict("E4", e4(1_600).filter((r) => r.step !== "c2"), CTX).code).toBe("inconclusive");
  });
});

describe("E5 verdict", () => {
  function e5(afterAbort: number, resendCacheN: number, abortedStatus: S.CallResult["status"] = "aborted"): S.CallResult[] {
    const out: S.CallResult[] = [];
    for (const rep of [0, 1, 2]) {
      out.push(canned("E5", "head_after_nothing", rep, { wall: 2_000, promptN: 40, cacheN: 12_960, promptMs: 200 }));
      out.push(canned("E5", "aborted_decision", rep, { wall: 21, status: rep === 2 ? abortedStatus : "aborted" }));
      out.push(canned("E5", "head_after_abort", rep, { wall: afterAbort, promptN: 40, cacheN: 12_960, promptMs: 200 }));
      out.push(canned("E5", "aborted_resend", rep, { wall: 1_500, promptN: 540 - resendCacheN, cacheN: resendCacheN, promptMs: 300, shape: "source_sensitive" }));
      out.push(canned("E5", "head_after_completed", rep, { wall: 2_400, promptN: 40, cacheN: 12_960, promptMs: 200 }));
    }
    return out;
  }

  it("finds an abort free when the next call is not slower, and says whether the server processed the prompt", () => {
    const free = S.computeVerdict("E5", e5(2_050, 0), CTX);
    expect(free.code).toBe("abort_free:not_processed");
    expect(free.numbers["completedCostMedianMs"]).toBe(400);
    const costly = S.computeVerdict("E5", e5(3_000, 530), CTX);
    expect(costly.code).toBe("abort_costs:processed");
    expect(costly.numbers["abortCostMedianMs"]).toBe(1_000);
    expect(S.computeVerdict("E5", e5(2_050, 200), CTX).code).toBe("abort_free:partially_processed");
    // From half of the prompt on, the server evidently worked on it after the abort.
    expect(S.computeVerdict("E5", e5(2_050, 330), CTX).code).toBe("abort_free:processed");
    expect(S.computeVerdict("E5", e5(2_050, 50), CTX).code).toBe("abort_free:not_processed");
  });

  it("leaves out a repetition whose incumbent answered before the abort", () => {
    const rows = e5(2_050, 0, "ok").map((r) => (r.rep === 2 && r.step === "head_after_abort" ? { ...r, wallMs: 9_000 } : r));
    const v = S.computeVerdict("E5", rows, CTX);
    expect(v.code).toBe("abort_free:not_processed");
    expect(v.notes.join(" ")).toContain("answered before the abort");
    const onlyOne = rows.filter((r) => r.rep !== 1);
    expect(S.computeVerdict("E5", onlyOne, CTX).code).toBe("inconclusive");
  });
});

describe("E6 verdict", () => {
  function e6(afterPrewarm: number, concurrent: number, coldCacheN = 0): S.CallResult[] {
    const out: S.CallResult[] = [];
    for (const rep of [0, 1]) {
      out.push(canned("E6", "cold_first_call", rep, { wall: 7_000, promptN: 6_000 - coldCacheN, cacheN: coldCacheN, promptMs: 6_500 }));
      out.push(canned("E6", "prewarm", rep, { wall: 6_500, promptN: 5_990, cacheN: 0, promptMs: 6_400 }));
      out.push(canned("E6", "first_call_after_prewarm", rep, { wall: afterPrewarm, promptN: 40, cacheN: 5_960, promptMs: 100 }));
      out.push(canned("E6", "first_call_concurrent", rep, { wall: concurrent, promptN: 40, cacheN: 5_960, promptMs: 100 }));
    }
    return out;
  }

  it("tells a prewarm that helps finished, helps in flight, hurts in flight, or does nothing", () => {
    expect(S.computeVerdict("E6", e6(600, 7_100), CTX).code).toBe("helps_only_when_finished");
    expect(S.computeVerdict("E6", e6(600, 5_200), CTX).code).toBe("helps_even_in_flight");
    expect(S.computeVerdict("E6", e6(600, 9_000), CTX).code).toBe("in_flight_hurts");
    const none = S.computeVerdict("E6", e6(6_900, 7_000), CTX);
    expect(none.code).toBe("no_gain");
    expect(S.computeVerdict("E6", e6(600, 7_100), CTX).numbers["sequentialSavingMs"]).toBe(6_400);
  });

  it("does not trust a cold call that was not cold", () => {
    const v = S.computeVerdict("E6", e6(600, 7_100, 5_900), CTX);
    expect(v.conclusive).toBe(false);
    expect(v.notes.join(" ")).toContain("not make them cold");
  });
});

describe("E7 verdict", () => {
  function e7(subsetAfterFull: number, fullAfterSubset: number): S.CallResult[] {
    const out: S.CallResult[] = [];
    for (const rep of [0, 1]) {
      out.push(canned("E7", "full_cold", rep, { wall: 15_000, promptN: 13_000, cacheN: 0, promptMs: 14_500 }));
      out.push(canned("E7", "full_warm", rep, { wall: 2_500, promptN: 30, cacheN: 12_970, promptMs: 150 }));
      out.push(canned("E7", "subset_after_full", rep, { wall: subsetAfterFull, promptN: 3_000, cacheN: 1_000, promptMs: 3_000 }));
      out.push(canned("E7", "subset_warm", rep, { wall: 800, promptN: 30, cacheN: 3_970, promptMs: 60 }));
      out.push(canned("E7", "full_after_subset", rep, { wall: fullAfterSubset, promptN: 30, cacheN: 12_970, promptMs: 150 }));
      out.push(canned("E7", "subset_after_full_again", rep, { wall: 820, promptN: 30, cacheN: 3_970, promptMs: 60 }));
      out.push(canned("E7", "subset_cold", rep, { wall: 4_200, promptN: 4_000, cacheN: 0, promptMs: 4_000 }));
    }
    return out;
  }

  it("prices a switch between the tool blocks", () => {
    const costly = S.computeVerdict("E7", e7(3_900, 2_600), CTX);
    expect(costly.code).toBe("subset_switch_costly");
    expect(costly.numbers["switchToSubsetMs"]).toBe(3_100);
    expect(costly.numbers["switchReuseShare"]).toBe(0.25);
    expect(costly.answer).toContain("both blocks stay cached");
    expect(S.computeVerdict("E7", e7(900, 2_600), CTX).code).toBe("subset_switch_cheap");
    expect(S.computeVerdict("E7", e7(900, 6_000), CTX).code).toBe("subset_switch_costly");
    expect(S.computeVerdict("E7", e7(900, 2_600).filter((r) => r.step !== "subset_warm"), CTX).code).toBe("inconclusive");
  });
});

// ── Server facts ───────────────────────────────────────────────────────────────────────────────

describe("server facts", () => {
  it("keeps only allowlisted llama-server flags, and only a model's file name", () => {
    const cmd = "/app/llama-server --port 9001 -m /models/Qwen3.6-35B-A3B-Q4_K_M.gguf -np 4 --ctx-size=131072 --cache-ram 8192 -ub 512 --swa-full --api-key s3cret --ctx-checkpoints 8 -fa on";
    expect(S.extractServerFlags(cmd)).toEqual({
      model: "Qwen3.6-35B-A3B-Q4_K_M.gguf",
      parallel: "4",
      ctxSize: "131072",
      cacheRamMiB: "8192",
      ubatchSize: "512",
      swaFull: true,
      ctxCheckpoints: "8",
      flashAttn: "on",
    });
    expect(JSON.stringify(S.extractServerFlags(cmd))).not.toContain("s3cret");
    expect(S.extractServerFlags("llama-server -np --verbose")).toEqual({});
  });

  it("reduces /running, /props and /slots to what the report needs", () => {
    expect(S.summarizeRunning({ running: [{ model: "qwen", state: "ready", cmd: "llama-server -np 2" }, { state: "x" }, null] }))
      .toEqual([{ model: "qwen", state: "ready", flags: { parallel: "2" } }]);
    expect(S.summarizeRunning({})).toEqual([]);
    expect(S.summarizeProps({ total_slots: 4, default_generation_settings: { n_ctx: 131072 }, model_path: "C:\\models\\q.gguf", build_info: "b6500", chat_template: "{{ secret }}" }))
      .toEqual({ totalSlots: 4, nCtx: 131072, modelFile: "q.gguf", buildInfo: "b6500" });
    expect(S.summarizeProps(null)).toEqual({});
    const slots = S.summarizeSlots([
      { n_ctx: 32768, is_processing: true, prompt: "a user's words" },
      { n_ctx: 32768, is_processing: false },
      { n_ctx: 32768 },
    ]);
    expect(slots).toEqual({ count: 3, processing: 1, nCtx: [32768] });
    expect(JSON.stringify(slots)).not.toContain("user's words");
    expect(S.summarizeSlots({})).toBeUndefined();
  });

  it("finds where the chat template renders the tool block", () => {
    const body = S.renderOrderProbeBody() as { messages: Array<{ content: string }>; tools: Array<{ function: { name: string } }> };
    const system = body.messages[0]!.content;
    const toolName = body.tools[0]!.function.name;
    expect(S.detectRenderOrder(`<|im_start|>system\n${system}\n\n# Tools\n{"name":"${toolName}"}`)).toBe("system_first");
    expect(S.detectRenderOrder(`<tools>${toolName}</tools><|im_start|>system\n${system}`)).toBe("tools_first");
    expect(S.detectRenderOrder(`<|im_start|>system\n${system}`)).toBe("tools_not_rendered");
    expect(S.detectRenderOrder("nothing")).toBe("unknown");
    expect(S.detectRenderOrder(undefined)).toBe("unknown");
    expect(S.endpointOrigin("http://192.168.12.11:8080/v1/")).toBe("http://192.168.12.11:8080");
    expect(S.endpointOrigin("http://host:8080")).toBe("http://host:8080");
  });
});

// ── Report ─────────────────────────────────────────────────────────────────────────────────────

describe("report", () => {
  function input(results: S.CallResult[], experiments: S.ExperimentId[] = ["E4"], reasons: string[] = []): S.ReportInput {
    return {
      generatedAt: "2026-09-26T00:00:00.000Z",
      runId: "run1",
      endpoint: { baseUrl: "http://station.invalid/v1", model: "qwen" },
      source: { revision: "abc", dirty: true, diffSha256: "f00" },
      settings: { reps: 2 },
      server: { errors: [], renderOrder: "system_first" },
      heads: [HEAD, { label: "forced_subset", system: HEAD.system, tools: SUBSET }],
      experiments,
      results,
      verdictContext: CTX,
      environmentReasons: reasons,
    };
  }
  const e4Rows = (pairWall: number): S.CallResult[] => {
    const out: S.CallResult[] = [];
    for (const rep of [0, 1]) {
      for (const shape of ["fast_lane", "source_sensitive", "ungrounded_draft", "run_drifting"]) out.push(canned("E4", "c1", rep, { shape, wall: 1_500, promptN: 20, cacheN: 500, promptMs: 60 }));
      for (const shape of ["fast_lane", "source_sensitive"]) out.push(canned("E4", "c2", rep, { shape, wall: pairWall, promptN: 20, cacheN: 500, promptMs: 60, inFlight: 2 }));
    }
    return out;
  };

  it("is conclusive and exits 0 when every experiment answered, with the production head bracketing the run", () => {
    const rows = [
      canned(S.SETUP_EXPERIMENT, S.PRODUCTION_HEAD_BEFORE, 0, { wall: 14_000, promptN: 13_000, cacheN: 0, promptMs: 13_800 }),
      ...e4Rows(1_600),
      canned(S.SETUP_EXPERIMENT, S.PRODUCTION_HEAD_AFTER, 0, { wall: 600, promptN: 2, cacheN: 12_998, promptMs: 20 }),
    ];
    const report = S.buildProbeReport(input(rows));
    expect(report.verdict).toBe("conclusive");
    expect(S.probeExitCode(report)).toBe(0);
    expect(report.productionHead.before).toEqual({ wallMs: 14_000, cacheShare: 0, promptTokens: 13_000 });
    expect(report.productionHead.after?.cacheShare).toBe(1);
    expect(report.global.coldPrefill).toBeNull();
    expect(report.global.timingsCoverage).toBe(1);
    expect(report.steps["E4"]!.map((s) => s.key)).toContain("c2 · fast_lane");
    expect(report.heads.map((h) => [h.label, h.toolCount])).toEqual([["orchestrator", 3], ["forced_subset", 1]]);
    const md = S.formatProbeMarkdown(report);
    expect(md).toContain("**parallel_saves**");
    expect(md).toContain("Verdict: **conclusive**");
    expect(md).toContain("Tool block renders: system_first");
  });

  it("is inconclusive (exit 2) when an experiment could not answer, and environment-suspect (exit 3) without timings", () => {
    const inconclusive = S.buildProbeReport(input(e4Rows(1_600), ["E4", "E7"]));
    expect(inconclusive.verdict).toBe("inconclusive");
    expect(S.probeExitCode(inconclusive)).toBe(2);
    const noTimings = e4Rows(1_600).map((r) => {
      const { timings: _timings, queueMs: _queueMs, ...rest } = r;
      return rest as S.CallResult;
    });
    const suspect = S.buildProbeReport(input(noTimings));
    expect(suspect.verdict).toBe("environment_suspect");
    expect(suspect.environment.reasons.join(" ")).toContain("llama.cpp timings");
    expect(S.probeExitCode(suspect)).toBe(3);
    expect(S.buildProbeReport(input([], ["E4"], ["the endpoint is unreachable"])).verdict).toBe("environment_suspect");
    const skipped = e4Rows(1_600).map((r) => ({ ...r, status: "skipped" as const }));
    expect(S.buildProbeReport(input(skipped)).environment.reasons.join(" ")).toContain("skipped");
    const failed = e4Rows(1_600).map((r) => ({ ...r, status: "error" as const }));
    expect(S.buildProbeReport(input(failed)).environment.reasons).toContain("no call succeeded");
  });

  it("never carries prompt text: rows hold step names and numbers only", async () => {
    const plans = (["E1", "E4"] as const).map((id) => S.buildExperimentPlan(id, context()));
    const results = await S.runPlans(plans, async () => ({ status: "ok", wallMs: 5, timings: { promptN: 1, cacheN: 1, cacheNDerived: false, promptMs: 1, predictedN: 1, predictedMs: 1 } }), {
      now: () => performance.now(),
      runStartedAt: performance.now(),
    });
    const json = JSON.stringify(S.buildProbeReport(input(results, ["E1", "E4"])));
    for (const language of S.PROBE_LANGUAGES) {
      for (let i = 0; i < S.SYNTHETIC_TOPIC_COUNT; i += 1) {
        const c = S.syntheticCase(language, i);
        expect(json).not.toContain(c.short);
        expect(json).not.toContain(c.facts[1]!);
      }
    }
    expect(json).not.toContain(HEAD.system);
    expect(json).not.toContain(S.SYNTHETIC_MEMORY_CAPSULE.slice(0, 40));
  });
});

// ── E8 and E9: the cache plan's probes ─────────────────────────────────────────────────────────

/** A head big enough that the E8 runs have steps to take: ~32k characters of system text. */
const STAGED: S.HeadShape = { label: "staged_builder:probe", system: `STAGED BUILD directive.\n\n${S.fillerText(8_000)}`, tools: [tool("write_file"), tool("edit_file")] };
const MODULE = "## Swarm Rules\nRoute to specialists.";
const FORCED: S.ForcedHeadSet = {
  full: { label: "full", system: [HEAD.system], tools: HEAD.tools },
  plan: { label: "forced_plan", system: [HEAD.system, MODULE], tools: [tool("delegate_to_agent"), tool("search_agents"), tool("record_plan")] },
  dispatch: { label: "forced_dispatch", system: [HEAD.system, MODULE], tools: [tool("delegate_to_agent"), tool("search_agents"), tool("execute_plan")] },
  literalSubsetTools: [tool("delegate_to_agent"), tool("search_agents"), tool("execute_plan")],
  temporal: "Authoritative temporal context for this turn: a synthetic date line.",
};

describe("E8 and E9 plans", () => {
  it("withNonceTool puts a marker named after the nonce first in the tool block, so a tools-first template is cold too", () => {
    const a = S.withNonceTool(HEAD.tools, "run1-E8-r0-L3");
    const b = S.withNonceTool(HEAD.tools, "run1-E8-r0-L6");
    expect(a.slice(1)).toEqual(HEAD.tools);
    expect(a[0]!.name).toBe(`probe_marker_${S.nonceTag("run1-E8-r0-L3")}`);
    expect(a[0]!.name).not.toBe(b[0]!.name);
  });

  it("E8: per repetition the head's size, five runs grown to their multiple, other agents' traffic in (d), and the concurrent arm", async () => {
    const { estimatePromptTokensForRequest: estimate } = await import("../providers/lmstudio.js");
    const plan = S.buildExperimentPlan("E8", context({ reps: 1, stagedBuilderHead: STAGED }));
    const requests = requestsOf(plan);
    expect(requests[0]!.step).toBe("head_size");
    const headEstimate = estimate(S.headMessages(STAGED, "."), STAGED.tools);
    for (const arm of S.E8_ARMS) {
      const armCalls = requests.filter((r) => r.tags?.["arm"] === arm && r.step !== "unrelated" && r.step !== "interleaved");
      const multiplier = Number(armCalls[0]!.tags!["multiplier"]);
      // One nonce per arm, in the system text AND leading the tool block, on every call of the arm.
      expect(new Set(armCalls.map((r) => firstSystem(r))).size).toBe(1);
      expect(new Set(armCalls.map((r) => r.tools[0]!.name)).size).toBe(1);
      expect(armCalls.every((r) => r.tools.length === STAGED.tools.length + 1)).toBe(true);
      // The run grows by appending: every grow call extends the one before it.
      const grows = armCalls.filter((r) => r.step === "grow_cold" || r.step === "grow");
      for (let i = 1; i < grows.length; i += 1) {
        expect(grows[i]!.messages.slice(0, grows[i - 1]!.messages.length)).toEqual(grows[i - 1]!.messages);
      }
      // ...to its multiple of the head, measured in one unit (the provider's estimator), and by no
      // more than one step past it.
      const last = grows[grows.length - 1]!;
      const reached = estimate(last.messages.slice(1), STAGED.tools);
      const step = estimate(last.messages.slice(-2));
      expect(reached).toBeGreaterThanOrEqual(multiplier * headEstimate);
      expect(reached).toBeLessThan(multiplier * headEstimate + step + 50);
      const tail = armCalls.slice(grows.length).map((r) => r.step);
      expect(tail).toEqual(arm === "L6_head_only" ? ["head_only", "consume_first", "consume_second"]
        : arm === "L1.5_interleaved" ? ["new_conversation_interleaved"] : ["new_conversation"]);
      // A new conversation: the same head, a different task.
      const fresh = armCalls[grows.length + (arm === "L6_head_only" ? 1 : 0)]!;
      expect(fresh.messages.length).toBe(3);
      expect(lastUser(fresh)).not.toBe(lastUser(grows[0]!));
    }
    // The unrelated call before a new conversation has a nonce of its own: it shares nothing.
    const unrelated = requests.filter((r) => r.step === "unrelated");
    expect(unrelated).toHaveLength(S.E8_ARMS.length - 1);
    expect(new Set(unrelated.map((r) => firstSystem(r))).size).toBe(S.E8_ARMS.length - 1);
    // (d): after the 1.5x run and before its new conversation, other agents' conversations — one
    // per slot, each on a head of its own (its own nonce, no tools) of about 6k tokens.
    const interleavedArm = requests.filter((r) => r.tags?.["arm"] === "L1.5_interleaved").map((r) => r.step);
    const lastGrowAt = interleavedArm.lastIndexOf("grow");
    expect(interleavedArm.slice(lastGrowAt + 1)).toEqual([...Array<string>(S.E8_INTERLEAVED_HEADS).fill("interleaved"), "new_conversation_interleaved"]);
    const others = requests.filter((r) => r.step === "interleaved");
    expect(new Set(others.map((r) => firstSystem(r))).size).toBe(S.E8_INTERLEAVED_HEADS);
    expect(others.every((r) => r.tools.length === 0)).toBe(true);
    // Sized like the filler everywhere else here: about four characters per token of English prose.
    const otherChars = others[0]!.messages.reduce((n, m) => n + String(m.content ?? "").length, 0);
    expect(otherChars).toBeGreaterThan(S.E8_INTERLEAVED_HEAD_TOKENS * S.FILLER_CHARS_PER_TOKEN * 0.95);
    expect(otherChars).toBeLessThan(S.E8_INTERLEAVED_HEAD_TOKENS * S.FILLER_CHARS_PER_TOKEN * 1.1);
    // (f): a finished prewarm, then three new conversations in ONE phase.
    const concurrent = plan.phases[plan.phases.length - 1]!;
    expect(concurrent.calls.map((c) => c.request.step)).toEqual(["concurrent_new", "concurrent_new", "concurrent_new"]);
    expect(plan.phases[plan.phases.length - 2]!.calls[0]!.request.step).toBe("prewarm");
    expect(() => S.buildExperimentPlan("E8", context())).toThrow(/staged builder head/);
  });

  it("E9: four interleaved arms; in TREATMENT each live forced call's head starts with a head the arm warmed", async () => {
    const { normalizeMessagesForModel } = await import("../providers/lmstudio.js");
    const folded = (r: S.ProbeRequest) => String(normalizeMessagesForModel(r.messages, "qwen")[0]!.content);
    const plan = S.buildExperimentPlan("E9", context({ reps: 1, forcedHeads: FORCED }));
    const requests = requestsOf(plan);
    const steps = (arm: string) => requests.filter((r) => r.tags?.["arm"] === arm).map((r) => r.step);
    expect(steps("control")).toEqual(["control_warm_full", "control_live_a", "control_live_b"]);
    expect(steps("treatment")).toEqual(["treatment_warm_full", "treatment_warm_plan", "treatment_warm_dispatch", "treatment_live_a", "treatment_live_b", "treatment_full_after", "treatment_rewarm_plan", "treatment_rewarm_dispatch"]);
    expect(steps("literal")).toEqual(["literal_warm_full", "literal_warm_literal_subset", "literal_warm_full_module", "literal_live_a", "literal_live_b"]);
    expect(steps("eviction")).toEqual(["eviction_warm_full", "eviction_warm_plan", "eviction_warm_dispatch", ...Array<string>(S.E9_EVICTION_PROMPTS).fill("eviction_evict"), "eviction_live_a"]);

    const byStep = (step: string) => requests.find((r) => r.step === step)!;
    for (const [warmStep, liveStep] of [["treatment_warm_plan", "treatment_live_a"], ["treatment_warm_dispatch", "treatment_live_b"]] as const) {
      const warm = byStep(warmStep);
      const live = byStep(liveStep);
      expect(JSON.stringify(live.tools)).toBe(JSON.stringify(warm.tools));
      expect(folded(live).startsWith(folded(warm))).toBe(true);
      expect(folded(live).length).toBeGreaterThan(folded(warm).length);
      expect(folded(live)).toContain(FORCED.temporal);
    }
    // CONTROL warmed only the full block: its live forced call meets a tool block nothing warmed.
    expect(JSON.stringify(byStep("control_live_a").tools)).not.toBe(JSON.stringify(byStep("control_warm_full").tools));
    // LITERAL: the no-plan-argument subset on the lean base, and the full block on base + module.
    expect(byStep("literal_warm_literal_subset").tools.slice(1)).toEqual(FORCED.literalSubsetTools);
    expect(folded(byStep("literal_warm_full_module"))).toContain(MODULE);
    // Every arm its own nonce; the eviction prompts each their own too, and about 30k tokens.
    expect(new Set(S.E9_ARMS.map((arm) => firstSystem(byStep(`${arm}_warm_full`)))).size).toBe(4);
    const evictions = requests.filter((r) => r.step === "eviction_evict");
    expect(new Set(evictions.map((r) => firstSystem(r))).size).toBe(S.E9_EVICTION_PROMPTS);
    expect(lastUser(evictions[0]!).length).toBeGreaterThan(S.E9_EVICTION_TOKENS * S.FILLER_CHARS_PER_TOKEN * 0.95);
    expect(() => S.buildExperimentPlan("E9", context())).toThrow(/forced heads/);
  });

  it("records the server's idle-slot switch, which decides what E8 should see", () => {
    expect(S.extractServerFlags("llama-server -m /m/q.gguf --no-cache-idle-slots -np 4")).toMatchObject({ noCacheIdleSlots: true, parallel: "4" });
    expect(S.extractServerFlags("llama-server --cache-idle-slots")).toMatchObject({ cacheIdleSlots: true });
  });
});

describe("E8 verdict", () => {
  const H = 7_600;
  const T = 1_500;
  const tagged = (r: S.CallResult, tags: Record<string, number | string>): S.CallResult => ({ ...r, tags });
  const warmCall = (step: string, rep: number, tags: Record<string, number | string>) =>
    tagged(canned("E8", step, rep, { wall: 2_500, promptN: T, cacheN: H, promptMs: 2_000 }), tags);
  const coldCall = (step: string, rep: number, tags: Record<string, number | string>) =>
    tagged(canned("E8", step, rep, { wall: 11_000, promptN: H + T, cacheN: 0, promptMs: 10_000 }), tags);
  function e8(warmAt: Record<string, boolean>, opts: { reps?: number; consume?: [boolean, boolean]; concurrentWarm?: number } = {}): S.CallResult[] {
    const out: S.CallResult[] = [];
    for (let rep = 0; rep < (opts.reps ?? 3); rep += 1) {
      out.push(canned("E8", "head_size", rep, { promptN: H, cacheN: 0, promptMs: 8_000 }));
      for (const m of S.E8_RUN_MULTIPLIERS) {
        const arm = `L${m}`;
        out.push(tagged(canned("E8", "grow_cold", rep, { promptN: H + T, cacheN: 0, promptMs: 10_000 }), { arm, multiplier: m }));
        out.push(tagged(canned("E8", "grow", rep, { promptN: 1_200, cacheN: Math.round(m * H) - 1_200, promptMs: 1_500 }), { arm, multiplier: m, step: 9 }));
        out.push((warmAt[arm] ? warmCall : coldCall)("new_conversation", rep, { arm, multiplier: m }));
      }
      if (opts.consume) {
        out.push((opts.consume[0] ? warmCall : coldCall)("consume_first", rep, { arm: "L6_head_only", multiplier: 6 }));
        out.push((opts.consume[1] ? warmCall : coldCall)("consume_second", rep, { arm: "L6_head_only", multiplier: 6 }));
      }
      for (let i = 0; i < S.E8_CONCURRENT; i += 1) {
        out.push((i < (opts.concurrentWarm ?? 1) ? warmCall : coldCall)("concurrent_new", rep, { arm: "concurrent", slot: i }));
      }
    }
    return out;
  }

  it("calls a call warm only when the head was reused, only the tail processed, in about the tail's time", () => {
    const base = canned("E8", "new_conversation", 0, { promptN: T, cacheN: H, promptMs: 2_000 });
    expect(S.isE8Warm(base, H, T)).toBe(true);
    // 0.95 x 7,600 = 7,220 reused; the tail plus 64 processed; 1,500/900 s + 1 s = 2,667 ms.
    expect(S.isE8Warm(canned("E8", "x", 0, { promptN: T, cacheN: 7_219, promptMs: 2_000 }), H, T)).toBe(false);
    expect(S.isE8Warm(canned("E8", "x", 0, { promptN: T + 65, cacheN: H, promptMs: 2_000 }), H, T)).toBe(false);
    expect(S.isE8Warm(canned("E8", "x", 0, { promptN: T, cacheN: H, promptMs: 2_700 }), H, T)).toBe(false);
  });

  it("names the rule: warm at 1.5x and 3x, cold at 6x is the quarter-share load rule, not checkpoint eviction", () => {
    const v = S.computeVerdict("E8", e8({ "L1.5": true, L3: true, L6: false }, { consume: [true, false], concurrentWarm: 1 }), CTX);
    expect(v.code).toBe("load_rule_quarter_share");
    expect(v.conclusive).toBe(true);
    expect(v.numbers["headTokens"]).toBe(H);
    expect(v.numbers["tailTokens"]).toBe(T);
    expect(v.numbers["L3ReachedMultiple"]).toBe(3);
    expect(v.numbers["consumeFirstWarm"]).toBe(3);
    expect(v.numbers["consumeSecondWarm"]).toBe(0);
    expect(v.numbers["concurrentExactlyOneReps"]).toBe(3);
    expect(v.answer).toContain("used up");
    expect(S.computeVerdict("E8", e8({ "L1.5": true, L3: true, L6: true }), CTX).code).toBe("entries_survive");
    expect(S.computeVerdict("E8", e8({ "L1.5": false, L3: false, L6: false }), CTX).code).toBe("no_reuse_across_conversations");
    expect(S.computeVerdict("E8", e8({ "L1.5": false, L3: true, L6: false }), CTX).code).toBe("mixed");
    // Warm only after the SHORT run is not the quarter rule either: at 3x the new prompt still
    // shares a third of the entry, so the rule predicts warm there too.
    expect(S.computeVerdict("E8", e8({ "L1.5": true, L3: false, L6: false }), CTX).code).toBe("mixed");
  });

  it("reports (d), the head after other agents' conversations, apart from the plain 1.5x arm", () => {
    const withInterleaved = (warm: boolean) => e8({ "L1.5": true, L3: true, L6: false }).concat([0, 1, 2].map((rep) =>
      (warm ? warmCall : coldCall)("new_conversation_interleaved", rep, { arm: "L1.5_interleaved", multiplier: 1.5 })));
    const kept = S.computeVerdict("E8", withInterleaved(true), CTX);
    expect(kept.numbers).toMatchObject({ interleavedWarm: 3, interleavedCalls: 3, "L1_5Calls": 3, "L1_5Warm": 3 });
    expect(kept.answer).toContain("still warm in 3 of 3");
    const lost = S.computeVerdict("E8", withInterleaved(false), CTX);
    expect(lost.numbers).toMatchObject({ interleavedWarm: 0, interleavedCalls: 3, "L1_5Warm": 3 });
    expect(lost.answer).toContain("pushed it out");
    // It is a separate question: it does not move the rule's classification.
    expect(lost.code).toBe("load_rule_quarter_share");
  });

  it("is not conclusive with fewer than three repetitions, a run on the wrong side of 4x, or without the head's size", () => {
    expect(S.computeVerdict("E8", e8({ "L1.5": true, L3: true, L6: false }, { reps: 2 }), CTX).conclusive).toBe(false);
    const overshot = e8({ "L1.5": true, L3: true, L6: false }).map((r) => r.step === "grow" && r.tags?.["arm"] === "L3"
      ? { ...r, timings: { ...r.timings!, cacheN: Math.round(4.5 * H) - 1_200 } }
      : r);
    const v = S.computeVerdict("E8", overshot, CTX);
    expect(v.conclusive).toBe(false);
    expect(v.notes.join(" ")).toContain("other side of the 4x boundary");
    expect(S.computeVerdict("E8", e8({ L3: true }).filter((r) => r.step !== "head_size"), CTX).code).toBe("inconclusive");
  });
});

describe("E9 verdict", () => {
  const liveRow = (step: string, rep: number, cacheN: number, promptN: number, promptMs: number) =>
    canned("E9", step, rep, { wall: promptMs + 500, promptN, cacheN, promptMs });
  function e9(opts: { reps?: number; treatmentCacheN?: number; controlCacheN?: number; fullShare?: number } = {}): S.CallResult[] {
    const out: S.CallResult[] = [];
    for (let rep = 0; rep < (opts.reps ?? 3); rep += 1) {
      out.push(liveRow("treatment_warm_plan", rep, 0, 12_500, 13_000));
      out.push(liveRow("treatment_warm_dispatch", rep, 0, 12_400, 12_900));
      const tc = opts.treatmentCacheN ?? 12_000;
      out.push(liveRow("treatment_live_a", rep, tc, 13_400 - tc, tc >= 11_800 ? 2_000 : 9_000));
      out.push(liveRow("treatment_live_b", rep, tc, 13_300 - tc, tc >= 11_800 ? 1_900 : 9_000));
      const cc = opts.controlCacheN ?? 0;
      out.push(liveRow("control_live_a", rep, cc, 13_400 - cc, 12_500));
      out.push(liveRow("control_live_b", rep, cc, 13_300 - cc, 12_400));
      const share = opts.fullShare ?? 0.95;
      out.push(liveRow("treatment_full_after", rep, Math.round(14_000 * share), Math.round(14_000 * (1 - share)), 2_500));
      out.push(liveRow("treatment_rewarm_plan", rep, 12_000, 500, 900));
      out.push(liveRow("treatment_rewarm_dispatch", rep, 12_000, 400, 800));
      out.push(liveRow("literal_live_a", rep, 0, 13_400, 12_000));
      out.push(liveRow("literal_live_b", rep, 9_000, 4_300, 5_000));
      out.push(liveRow("eviction_live_a", rep, 0, 13_400, 12_600));
    }
    return out;
  }

  it("passes when TREATMENT's forced calls reuse their heads, CONTROL's do not, the arms separate and the full head stays", () => {
    const v = S.computeVerdict("E9", e9(), CTX);
    expect(v.code).toBe("forced_heads_warm");
    expect(v.conclusive).toBe(true);
    expect(v.numbers).toMatchObject({ treatmentPassReps: 3, controlColdReps: 3, separatedReps: 3, fullKeptReps: 3, warmPlanColdMs: 13_000, rewarmPlanMs: 900 });
    expect(v.numbers["literalLiveBShare"]).toBeCloseTo(9_000 / 13_300, 3);
  });

  it("rejects TREATMENT that reused under half its prompt on two of three repetitions", () => {
    expect(S.computeVerdict("E9", e9({ treatmentCacheN: 3_000 }), CTX).code).toBe("treatment_rejected");
    // The rule is two of three, not three of three: one good repetition does not rescue it...
    const twoBad = e9().map((r) => (r.rep < 2 && r.step.startsWith("treatment_live_") ? { ...r, timings: { ...r.timings!, cacheN: 3_000, promptN: 10_400, promptMs: 9_000 } } : r));
    expect(S.computeVerdict("E9", twoBad, CTX).code).toBe("treatment_rejected");
    // ...and one bad repetition alone is a failed criterion, not a rejection.
    const oneBad = e9().map((r) => (r.rep === 0 && r.step.startsWith("treatment_live_") ? { ...r, timings: { ...r.timings!, cacheN: 3_000, promptN: 10_400, promptMs: 9_000 } } : r));
    expect(S.computeVerdict("E9", oneBad, CTX).code).toBe("criteria_not_met");
  });

  it("counts a live call warm only when it reused the warm call's prompt to within the slack", () => {
    // treatment_warm_plan processed 12,500 tokens, so live A must find at least 12,500 - 700 = 11,800.
    const at = (cacheN: number) => e9().map((r) => (r.step === "treatment_live_a" ? { ...r, timings: { ...r.timings!, cacheN, promptN: 13_400 - cacheN, promptMs: 2_000 } } : r));
    expect(S.computeVerdict("E9", at(11_800), CTX).code).toBe("forced_heads_warm");
    const short = S.computeVerdict("E9", at(11_799), CTX);
    expect(short.code).toBe("criteria_not_met");
    expect(short.answer).toContain("TREATMENT live calls warm in 0 of 3");
  });

  it("does not pass when CONTROL was already warm, or the full head was pushed out", () => {
    // A CONTROL live call that found 5,000 tokens: the arms were not independent.
    const warmControl = S.computeVerdict("E9", e9({ controlCacheN: 5_000 }), CTX);
    expect(warmControl.code).toBe("criteria_not_met");
    expect(warmControl.answer).toContain("CONTROL live calls cold in 0 of 3");
    expect(S.computeVerdict("E9", e9({ fullShare: 0.5 }), CTX).code).toBe("criteria_not_met");
  });

  it("gives no verdict under three repetitions", () => {
    expect(S.computeVerdict("E9", e9({ reps: 2 }), CTX).code).toBe("inconclusive");
  });
});
