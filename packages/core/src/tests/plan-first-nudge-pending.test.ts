/**
 * The plan-first nudge stays in the tail until the turn acts.
 *
 * It was armed on iteration 0 only, but its own multi-domain text sends iteration 0 to
 * search_workflows, so record_plan could come at iteration 1 at the earliest, by which time the tail
 * had been rebuilt without the nudge. Session 9991d150 (E2E new-plan-round-fold-site-facts):
 * iteration 0 called search_workflows and search_agents, search_agents' result said to delegate
 * now, iteration 1 sent two delegations, no plan was recorded, and the plan round fold had nothing
 * to fold.
 *
 * These pin the rule: after iteration 0 the multi-domain nudge is repeated while every call the turn
 * has made was a discovery call, nothing has been delegated, no plan is stored and no correction is
 * pending, and the head does not move. Anything else, the single-domain nudge, and a config with
 * planFirst off leave the prompt as it was.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LLMMessage } from "../providers/lmstudio.js";

vi.mock("../audit/logger.js", () => ({ logAudit: vi.fn() }));

/** Makes the plan store unreadable for the fail-closed case. The rest of the module is the real one. */
const planStore = vi.hoisted(() => ({ failReads: false }));
vi.mock("../agent/turn-plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent/turn-plan.js")>();
  return {
    ...actual,
    loadTurnPlan: async (sessionId: string) => {
      if (planStore.failReads) throw new Error("plan store unavailable");
      return actual.loadTurnPlan(sessionId);
    },
  };
});

const configDir = mkdtempSync(join(tmpdir(), "sai-plan-nudge-"));
const configPath = join(configDir, "starlingai.json");

function writeConfig(orchestration: Record<string, unknown> = {}, performance: Record<string, unknown> = {}): void {
  writeFileSync(configPath, JSON.stringify({
    agents: { performance: { leanContextInjection: true, ...performance } },
    orchestration: { discoveryPrefetch: false, ...orchestration },
  }), "utf8");
}

/**
 * The config source is resolved when the loader is first imported, so the modules are imported
 * once the path is set. One at a time, the mocked turn-plan.js first: imported together, the
 * prompt module could be handed the unmocked one.
 */
async function loadModules() {
  vi.resetModules();
  const plan = await import("../agent/turn-plan.js");
  const { AgentSession } = await import("../agent/session.js");
  const prompt = await import("../agent/turn-system-prompt.js");
  const { measurePrompt } = await import("../agent/turn-metrics.js");
  const { resetConfigForTests } = await import("../config/loader.js");
  return { plan, AgentSession, prompt, measurePrompt, resetConfigForTests };
}

let mod: Awaited<ReturnType<typeof loadModules>>;

beforeAll(async () => {
  writeConfig();
  process.env["SAI_CONFIG_PATH"] = configPath;
  mod = await loadModules();
});

afterEach(() => {
  planStore.failReads = false;
  writeConfig();
  mod.resetConfigForTests();
});

afterAll(() => {
  delete process.env["SAI_CONFIG_PATH"];
  mod.resetConfigForTests();
  rmSync(configDir, { recursive: true, force: true });
});

/** Shaped like the E2E message: 300+ characters and three questions, so the multi-domain nudge. */
const USER_MESSAGE =
  "For a short company note I need three details from the website of the Nordlicht tools company:\n"
  + "1. How many employees does the company have according to the home page?\n"
  + "2. What does express shipping cost there?\n"
  + "3. Which torque level is the NW-AS 18 cordless screwdriver set to at the factory, according to the documentation?\n"
  + "Plan the steps briefly, then work through the plan. Summarise the three details in at most four sentences.";

/** Under 300 characters, so the single-domain nudge. */
const SINGLE_DOMAIN_MESSAGE =
  "Visit the shop's website: find the employee count on the home page, the express shipping price on the pricing page "
  + "and the torque setting in the documentation. Plan the steps briefly, then work through the plan.";

/** Every correction the runtime can have pending, each of which names the next call itself. */
const CORRECTIONS = [
  "delegatedResearchEnforcementPrompt",
  "searchAgentsNoMatchFallbackPrompt",
  "maintenanceDelegationEnforcementPrompt",
  "unresolvedDelegationEnforcementPrompt",
  "workflowCatalogEnforcementPrompt",
  "approvedRunCandidateEnforcementPrompt",
  "workflowExecutionEnforcementPrompt",
  "directiveAgentPrompt",
] as const;

type Params = Parameters<typeof import("../agent/turn-system-prompt.js")["assembleTurnSystemMessages"]>[0];

function setUp(orchestration: Record<string, unknown> = {}, userMessage = USER_MESSAGE, performance: Record<string, unknown> = {}) {
  writeConfig(orchestration, performance);
  mod.resetConfigForTests();
  const session = new mod.AgentSession({ channel: "test", workspacePath: configDir, systemPrompt: "You are a test agent." });
  session.addMessage({ role: "user", content: userMessage });
  const assembleResult = async (iterationCount: number, extra: Partial<Params> = {}) => mod.prompt.assembleTurnSystemMessages({
    session,
    iterationCount,
    userMessage,
    initialDynamicGuidance: null,
    documentRagFoundDocs: false,
    trajectoryInjectionContext: "",
    sharedFindingsSystemMessage: "",
    priorEvidenceFollowUpPrompt: "",
    sessionEvidenceReuseNudge: "",
    effortPromptAddendum: "",
    workflowCatalogGuidance: "",
    approvedRunCandidateGuidance: "",
    delegatedResearchEnforcementPrompt: "",
    searchAgentsNoMatchFallbackPrompt: "",
    maintenanceDelegationEnforcementPrompt: "",
    unresolvedDelegationEnforcementPrompt: "",
    workflowCatalogEnforcementPrompt: "",
    approvedRunCandidateEnforcementPrompt: "",
    workflowExecutionEnforcementPrompt: "",
    injectedSkillSlugs: [],
    heldOutSkillSlugs: [],
    applyRoutingTone: (text) => text,
    buildTemporalContextPrompt: () => "Today is the test day.",
    lastPromptMetrics: mod.measurePrompt([], []),
    ...extra,
  });
  const assemble = async (iterationCount: number, extra: Partial<Params> = {}) => (await assembleResult(iterationCount, extra)).messages;
  return { session, assemble, assembleResult };
}

/** The plan-first nudge in a message list, or undefined. Both variants open with "PLAN FIRST". */
function planNudge(messages: readonly LLMMessage[]): string | undefined {
  const found = messages.find((message) => message.role === "system"
    && typeof message.content === "string" && message.content.startsWith("PLAN FIRST"));
  return found?.content as string | undefined;
}

const searchedOnly = { turnToolCallCounts: new Map([["search_workflows", 1], ["search_agents", 1]]), turnDelegationCount: 0 };

describe("turnIsStillDiscovering", () => {
  it("holds for a turn whose every call so far was a discovery call", () => {
    expect(mod.prompt.turnIsStillDiscovering(new Map([["search_workflows", 1]]), 0)).toBe(true);
    expect(mod.prompt.turnIsStillDiscovering(new Map([["search_agents", 2], ["list_agents", 1], ["search_tools", 1]]), 0)).toBe(true);
  });

  it("ends with the first call that acts, and with any delegation", () => {
    expect(mod.prompt.turnIsStillDiscovering(new Map([["search_workflows", 1], ["delegate_to_agent", 1]]), 1)).toBe(false);
    expect(mod.prompt.turnIsStillDiscovering(new Map([["search_workflows", 1], ["recall_context", 1]]), 0)).toBe(false);
    expect(mod.prompt.turnIsStillDiscovering(new Map([["search_workflows", 1], ["record_plan", 1]]), 0)).toBe(false);
    // A delegation the tally holds without a call of its own (the auto-research on refusal).
    expect(mod.prompt.turnIsStillDiscovering(new Map([["search_agents", 1]]), 1)).toBe(false);
  });

  it("does not count a call the runtime gave back", () => {
    expect(mod.prompt.turnIsStillDiscovering(new Map([["search_workflows", 1], ["record_plan", 0]]), 0)).toBe(true);
  });

  it("does not hold for a turn that has called nothing, or without both inputs", () => {
    expect(mod.prompt.turnIsStillDiscovering(new Map(), 0)).toBe(false);
    expect(mod.prompt.turnIsStillDiscovering(new Map([["search_workflows", 0]]), 0)).toBe(false);
    expect(mod.prompt.turnIsStillDiscovering(undefined, 0)).toBe(false);
    expect(mod.prompt.turnIsStillDiscovering(new Map([["search_workflows", 1]]), undefined)).toBe(false);
  });
});

describe("assembleTurnSystemMessages — the plan-first nudge after iteration 0", () => {
  it("repeats the iteration-0 nudge, unchanged, on iteration 1 of a turn that has only searched", async () => {
    const { assemble } = setUp();
    const first = await assemble(0);
    const nudge = planNudge(first);
    expect(nudge, "iteration 0 carries the nudge").toBeDefined();

    const second = await assemble(1, searchedOnly);
    expect(planNudge(second)).toBe(nudge);
    // In the tail, after the history: the person's message comes before it.
    const userIndex = second.findIndex((message) => message.role === "user" && message.content === USER_MESSAGE);
    const nudgeIndex = second.findIndex((message) => message.content === nudge);
    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(nudgeIndex).toBeGreaterThan(userIndex);
    // The head is the cache key and does not move.
    expect(mod.prompt.foldedSystemText(second)).toBe(mod.prompt.foldedSystemText(first));
    expect(mod.prompt.foldedSystemText(second)).not.toContain("PLAN FIRST");
  });

  it("is not repeated once a plan is stored", async () => {
    const { assemble, session } = setUp();
    await mod.plan.persistTurnPlan(session.id, mod.plan.normalizeTurnPlan({
      objective: "Report three facts from the site",
      steps: [{ id: "s1", description: "Read the three pages", kind: "delegate", agent: "browser_agent" }],
    }));
    expect(planNudge(await assemble(1, searchedOnly))).toBeUndefined();
  });

  it("is not repeated once the turn has delegated or called anything but a search", async () => {
    const { assemble } = setUp();
    expect(planNudge(await assemble(1, {
      turnToolCallCounts: new Map([["search_agents", 1], ["delegate_to_agent", 1]]),
      turnDelegationCount: 1,
    }))).toBeUndefined();
    expect(planNudge(await assemble(1, {
      turnToolCallCounts: new Map([["search_agents", 1]]),
      turnDelegationCount: 1,
    }))).toBeUndefined();
    expect(planNudge(await assemble(1, {
      turnToolCallCounts: new Map([["search_workflows", 1], ["recall_context", 1]]),
      turnDelegationCount: 0,
    }))).toBeUndefined();
  });

  it("stays off when the plan store cannot be read", async () => {
    const { assemble } = setUp();
    planStore.failReads = true;
    expect(planNudge(await assemble(1, searchedOnly))).toBeUndefined();
  });

  it("repeats only the multi-domain nudge, whose own text sends iteration 0 to a search", async () => {
    const { assemble } = setUp({}, SINGLE_DOMAIN_MESSAGE);
    const first = planNudge(await assemble(0));
    expect(first, "iteration 0 carries the single-domain nudge").toBeDefined();
    expect(first).not.toBe(planNudge(await setUp().assemble(0)));
    expect(planNudge(await assemble(1, searchedOnly))).toBeUndefined();
    expect(planNudge(await assemble(1, { turnToolCallCounts: new Map([["search_tools", 1]]), turnDelegationCount: 0 }))).toBeUndefined();
  });

  it("is not repeated beside a pending correction, which names the next call itself", async () => {
    const { assemble } = setUp();
    // The no-match fallback from the review: search_agents found no usable agent on a turn that
    // must delegate research, and the runtime now requires one named delegation.
    const fallback = "COMPLIANCE CORRECTION: You MUST call delegate_to_agent now with agentName='researcher'.";
    const withFallback = await assemble(1, { ...searchedOnly, searchAgentsNoMatchFallbackPrompt: fallback });
    expect(planNudge(withFallback)).toBeUndefined();
    expect(withFallback.some((message) => message.content === fallback)).toBe(true);
    for (const correction of CORRECTIONS) {
      expect(planNudge(await assemble(1, { ...searchedOnly, [correction]: "COMPLIANCE CORRECTION: x" })), correction).toBeUndefined();
    }
    // Iteration 0 is as it was: the nudge goes out whatever is pending.
    for (const correction of CORRECTIONS) {
      expect(planNudge(await assemble(0, { [correction]: "COMPLIANCE CORRECTION: x" })), correction).toBeDefined();
    }
  });

  it("stays off after iteration 0 when the caller passes no tally, as before", async () => {
    const { assemble } = setUp();
    expect(planNudge(await assemble(1))).toBeUndefined();
  });

  it("changes nothing with planFirst off", async () => {
    const { assemble } = setUp({ planFirst: false });
    const plain0 = await assemble(0);
    const plain1 = await assemble(1);
    expect(planNudge(plain0)).toBeUndefined();
    expect(JSON.stringify(await assemble(0, searchedOnly))).toBe(JSON.stringify(plain0));
    expect(JSON.stringify(await assemble(1, searchedOnly))).toBe(JSON.stringify(plain1));
  });
});

describe("assembleTurnSystemMessages — planFirstPending, for the routing pointer", () => {
  it("holds when the multi-domain nudge goes out, on iteration 0 and when it is repeated", async () => {
    const { assembleResult } = setUp();
    expect((await assembleResult(0)).planFirstPending).toBe(true);
    expect((await assembleResult(1, searchedOnly)).planFirstPending).toBe(true);
  });

  it("does not hold for the single-domain nudge, which asks for no search first", async () => {
    const { assembleResult } = setUp({}, SINGLE_DOMAIN_MESSAGE);
    const first = await assembleResult(0);
    expect(planNudge(first.messages)).toBeDefined();
    expect(first.planFirstPending).toBe(false);
  });

  it("does not hold beside a pending correction, even on iteration 0", async () => {
    const { assembleResult } = setUp();
    for (const correction of CORRECTIONS) {
      const result = await assembleResult(0, { [correction]: "COMPLIANCE CORRECTION: x" });
      expect(planNudge(result.messages), correction).toBeDefined();
      expect(result.planFirstPending, correction).toBe(false);
    }
  });

  it("does not hold when no nudge went out", async () => {
    // planFirst off.
    expect((await setUp({ planFirst: false }).assembleResult(0)).planFirstPending).toBe(false);
    // The turn has delegated.
    expect((await setUp().assembleResult(1, { turnToolCallCounts: new Map([["search_agents", 1]]), turnDelegationCount: 1 })).planFirstPending).toBe(false);
    // The budget trimmer dropped the nudge.
    const trimmed = await setUp({}, USER_MESSAGE, { promptBudgetChars: 1000 }).assembleResult(0);
    expect(planNudge(trimmed.messages)).toBeUndefined();
    expect(trimmed.planFirstPending).toBe(false);
  });
});
