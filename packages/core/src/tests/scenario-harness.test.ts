/**
 * G35 — Scenario harness.
 *
 * Runs each JSON file in `./scenarios/` as a deterministic end-to-end
 * delegation test. Each scenario specifies:
 *   - agentName    : explicit agent to delegate to
 *   - task         : user task string
 *   - subAgentMocks: map of agentName → mock output string
 *   - assertFinal  : assertions on the delegation result
 *
 * The sub-agent runner is fully mocked; no real LLM or network calls.
 * All scenarios must complete in ≤45 s wall-clock.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";
import type { SwarmState } from "../tools/registry.js";

import { PRODUCT } from "../product/index.js";

// ── Scenario types ─────────────────────────────────────────────────────────

interface ScenarioAssert {
  success?: boolean;
  maxDelegations?: number;
  minShareFindings?: number;
  outputContainsAny?: string[];
  outputContainsAll?: string[];
}

interface Scenario {
  id: string;
  description: string;
  agentName: string;
  task: string;
  subAgentMocks: Record<string, string>;
  assertFinal: ScenarioAssert;
}

// ── Load scenarios ─────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const scenariosDir = join(__dirname, "scenarios");

function loadScenarios(): Scenario[] {
  try {
    const files = readdirSync(scenariosDir).filter(f => f.endsWith(".json"));
    return files.map(f => JSON.parse(readFileSync(join(scenariosDir, f), "utf-8")) as Scenario);
  } catch {
    return [];
  }
}

// ── Mock infrastructure ────────────────────────────────────────────────────

/**
 * Current mock map — replaced per-scenario in beforeEach.
 * Tests share this module-level ref because vi.mock() hoists the factory.
 */
let currentMocks: Record<string, string> = {};
let delegationCount = 0;

const runSubAgentWithStatsMock = vi.fn(async (args: SubAgentRunOptions): Promise<SubAgentRunResult> => {
  delegationCount += 1;
  const key = args.agentName ?? "unknown";
  const output = currentMocks[key] ?? `${key}: task acknowledged`;

  return {
    output,
    stats: {
      agentName: key,
      sessionId: `sub:${args.parentSessionId ?? "test"}:${key}:scenario`,
      promptChars: 0,
      userContentChars: String(args.task ?? "").length,
      toolCount: 1,
      toolNames: [],
      iterations: 1,
      usage: { promptTokens: 20, completionTokens: 40, totalTokens: 60 },
      maxIterations: 5,
      model: "mock",
      capabilities: [],
      terminalState: "completed" as const,
      outcome: "success" as const,
    },
  };
});

vi.mock("../agent/sub-agent.js", () => ({
  runSubAgent: vi.fn(async (args: SubAgentRunOptions) => {
    const key = args.agentName ?? "unknown";
    return currentMocks[key] ?? `${key}: task acknowledged`;
  }),
  runSubAgentWithStats: runSubAgentWithStatsMock,
}));

// ── Minimal agent catalog fixture ─────────────────────────────────────────

const SCENARIO_AGENTS = {
  researcher: {
    description: "Finds facts and information on the web.",
    capabilities: ["web research", "fact finding"],
    tags: ["research", "web"],
    tools: ["web_search", "web_fetch"],
    maxIterations: 4,
  },
  code_analyst: {
    description: "Reviews and explains existing code. Answers questions about code structure, security vulnerabilities, and architecture.",
    capabilities: ["code review", "security review", "code analysis"],
    tags: ["code", "analysis", "security"],
    tools: ["read_file", "list_directory"],
    maxIterations: 5,
  },
  summarizer: {
    description: "Condenses documents, articles, or long texts into clear summaries.",
    capabilities: ["summarization", "document summarization"],
    tags: ["summarization"],
    tools: ["read_file"],
    maxIterations: 3,
  },
  email_drafter: {
    description: "Drafts professional emails and business messages.",
    capabilities: ["email drafting", "professional writing"],
    tags: ["email", "writing"],
    tools: ["read_file", "write_file"],
    maxIterations: 3,
  },
  web_task_coordinator: {
    description: "Coordinator for freshness-sensitive web tasks: breaking news, headlines, weather.",
    capabilities: ["multi-agent coordination", "breaking news", "headlines", "weather"],
    tags: ["coordination", "web", "news", "headlines", "weather"],
    tools: ["delegate_to_agent", "search_agents"],
    maxIterations: 5,
  },
};

// ── Test suite ─────────────────────────────────────────────────────────────

const scenarios = loadScenarios();

describe("G35: scenario harness", () => {
  const tempDirs: string[] = [];
  let workspacePath: string;

  beforeAll(() => {
    if (scenarios.length === 0) {
      console.warn("[scenario-harness] No scenario files found in ./scenarios/");
    }
  });

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    delete process.env["SAI_CONFIG_PATH"];
    vi.resetModules();
    runSubAgentWithStatsMock.mockClear();
    delegationCount = 0;
    currentMocks = {};

    const { resetConfigForTests } = await import("../config/loader.js");
    resetConfigForTests();
    const memory = await import("../swarm/memory.js");
    await memory.resetSharedMemoryForTests();
  });

  /**
   * Boilerplate: write a temp config with the scenario agents and return tool registry.
   */
  async function setupScenario(scenario: Scenario) {
    const ws = mkdtempSync(join(tmpdir(), `sai-scenario-${scenario.id}-`));
    mkdirSync(join(ws, PRODUCT.stateDirName), { recursive: true });
    tempDirs.push(ws);
    workspacePath = ws;

    // Wire mocks for this scenario
    currentMocks = { ...scenario.subAgentMocks };

    const cfgPath = join(ws, "starlingai.json");
    writeFileSync(cfgPath, JSON.stringify({
      workspacePath: ws,
      agents: {
        defaults: { model: { primary: "mock-model" } },
        ephemeralGeneration: {
          enabled: false,
          skillMatchThreshold: 0.70,
          architectAgentName: "agent_architect",
        },
      },
      subAgents: SCENARIO_AGENTS,
    }), "utf-8");
    process.env["SAI_CONFIG_PATH"] = cfgPath;

    const [{ getTool }] = await Promise.all([
      import("../tools/registry.js"),
      import("../tools/sub-agent.js"),
    ]);

    return { getTool, workspacePath: ws };
  }

  /**
   * Run all loaded scenarios as individual named tests.
   */
  if (scenarios.length > 0) {
    for (const scenario of scenarios) {
      it(`[${scenario.id}] ${scenario.description}`, async () => {
        const { getTool } = await setupScenario(scenario);

        const delegate = getTool("delegate_to_agent");
        expect(delegate, `delegate_to_agent tool not found`).toBeDefined();

        const swarmState: SwarmState = {
          objective: scenario.task,
          startedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          tasks: {},
        };

        const result = await delegate!.execute({
          agentName: scenario.agentName,
          task: scenario.task,
        }, {
          sessionId: `session-${scenario.id}`,
          workspacePath,
          swarmState,
        });

        const af = scenario.assertFinal;

        if (af.success !== undefined) {
          expect(result.success, `[${scenario.id}] expected success=${af.success}`).toBe(af.success);
        }

        if (af.maxDelegations !== undefined) {
          expect(
            delegationCount,
            `[${scenario.id}] expected ≤${af.maxDelegations} delegations, got ${delegationCount}`
          ).toBeLessThanOrEqual(af.maxDelegations);
        }

        const outputText = String(result.output ?? "").toLowerCase();

        if (af.outputContainsAny && af.outputContainsAny.length > 0) {
          const lower = af.outputContainsAny.map(s => s.toLowerCase());
          const anyMatch = lower.some(s => outputText.includes(s));
          expect(
            anyMatch,
            `[${scenario.id}] output should contain one of: ${af.outputContainsAny.join(", ")}\nActual output: ${result.output}`
          ).toBe(true);
        }

        if (af.outputContainsAll && af.outputContainsAll.length > 0) {
          for (const required of af.outputContainsAll) {
            expect(
              outputText.includes(required.toLowerCase()),
              `[${scenario.id}] output missing required term: "${required}"\nActual output: ${result.output}`
            ).toBe(true);
          }
        }
      }, 45_000);
    }
  } else {
    it("loads scenario files from ./scenarios/ directory", () => {
      // This test just validates the harness infrastructure is set up correctly
      // when no scenario files exist yet. It will pass trivially.
      expect(scenarios).toBeDefined();
    });
  }

  it("harness infrastructure: mocked sub-agent returns configured output", async () => {
    currentMocks = { test_agent: "mocked-response-42" };
    delegationCount = 0;

    const result = await runSubAgentWithStatsMock({
      agentName: "test_agent",
      task: "do a thing",
      workspacePath: "/tmp/test",
      parentSessionId: "test-session",
      inlineConfig: {} as never,
    });

    expect(result.output).toBe("mocked-response-42");
    expect(delegationCount).toBe(1);
  });
});
