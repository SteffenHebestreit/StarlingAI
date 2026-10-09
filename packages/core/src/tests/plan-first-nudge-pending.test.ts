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
 * These pin the rule: after iteration 0 the same nudge is repeated while every call the turn has
 * made was a discovery call, nothing has been delegated and no plan is stored, and the head does not
 * move. Anything else, and a config with planFirst off, leaves the prompt as it was.
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

function writeConfig(orchestration: Record<string, unknown> = {}): void {
  writeFileSync(configPath, JSON.stringify({
    agents: { performance: { leanContextInjection: true } },
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

const USER_MESSAGE =
  "Visit the shop's website: find the employee count on the home page, the express shipping price on the pricing page "
  + "and the torque setting in the documentation. Plan the steps briefly, then work through the plan.";

type Params = Parameters<typeof import("../agent/turn-system-prompt.js")["assembleTurnSystemMessages"]>[0];

function setUp(orchestration: Record<string, unknown> = {}) {
  writeConfig(orchestration);
  mod.resetConfigForTests();
  const session = new mod.AgentSession({ channel: "test", workspacePath: configDir, systemPrompt: "You are a test agent." });
  session.addMessage({ role: "user", content: USER_MESSAGE });
  const assemble = async (iterationCount: number, extra: Partial<Params> = {}) => (await mod.prompt.assembleTurnSystemMessages({
    session,
    iterationCount,
    userMessage: USER_MESSAGE,
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
  })).messages;
  return { session, assemble };
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
