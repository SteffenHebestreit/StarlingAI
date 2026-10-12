import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolContext, ToolResult } from "../tools/registry.js";

/**
 * delegate_to_agent frames a specialist's answer for the orchestrator: "[<agent>]: <answer>", and a
 * "↳ Auto-routed to <agent> (…)" line when routing picked the agent (formatDelegatedOutput). Every
 * path that ships such an answer to the user takes the frame off (stripDelegateRelayFrame). The
 * corrective reroute did since the E2E turn guards-list-files-on-a-file; these are the other copies:
 * the QA delivery loop's escalation to mission_coordinator, which shipped "[mission_coordinator]:"
 * as the first words of the corrected answer, and the single-deliverable relay, which shipped the
 * routing note as its last line.
 */
vi.mock("../audit/logger.js", () => ({ logAudit: vi.fn(), subscribeToAudit: () => () => {} }));
vi.mock("../tools/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/registry.js")>();
  return {
    ...actual,
    executeTool: vi.fn(async (name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
      if (name !== "delegate_to_agent") return actual.executeTool(name, args, ctx);
      return {
        success: true,
        output: formatDelegatedOutput("mission_coordinator", CORRECTED, { confidence: "high", matchedTerms: [] }),
        metadata: { agentName: "mission_coordinator", delegationOutcome: "success", delegationSucceeded: true },
      };
    }),
  };
});

const { formatDelegatedOutput } = await import("../agent/runtime-evidence-dump.js");
const { applyTerminalResponseGuards } = await import("../agent/turn-finalize-guards.js");
const { classifyDeliverableIntent } = await import("../agent/deliverable-intent.js");
const { AgentSession, resetSessionsForTests } = await import("../agent/session.js");
const { persistTurnPlan } = await import("../agent/turn-plan.js");
const { getConfig, resetConfigForTests } = await import("../config/loader.js");
const { buildModelVisibleToolResult } = await import("../agent/tool-result-format.js");
const { extractSingleRelayableDeliverable } = await import("../agent/deliverable-relay.js");

const REQUEST = "Compare the two recorder designs and say which one meets the battery-life target.";
const DRAFT = "Design A runs about 14 hours on its 500 mAh cell and design B about 9 hours on 350 mAh. "
  + "Design A meets the 12-hour target and design B does not. Both use the same MEMS microphone and the same MCU, "
  + "so the difference is the cell and the deep-sleep current.";
const CORRECTED = "## Battery life against the 12-hour target\n\n"
  + "- Design A: 500 mAh cell, 32 mA average draw, about 15.6 hours — meets the target (datasheet: https://example.test/a).\n"
  + "- Design B: 350 mAh cell, 36 mA average draw, about 9.7 hours — misses the target (datasheet: https://example.test/b).\n\n"
  + "Design A is the one that meets the target; design B would need a cell of at least 432 mAh.";

afterEach(() => {
  resetConfigForTests();
  resetSessionsForTests();
});

describe("the QA delivery loop's escalation to mission_coordinator", () => {
  it("ships the coordinator's corrected answer without its relay frame", async () => {
    getConfig().orchestration.qaDeliveryLoop = true;
    getConfig().orchestration.qaDeliveryLoopEscalateToCoordinator = true;
    const session = new AgentSession({ channel: "test", workspacePath: "/workspace", systemPrompt: "You are a test agent." });
    await persistTurnPlan(session.id, {
      objective: "Compare the recorder designs",
      steps: [],
      acceptanceCriteria: ["states each design's battery life with its source"],
      stopConditions: [],
      riskTier: "low",
      wide: false,
      createdAt: new Date().toISOString(),
    });
    const escalated: Array<string | null> = [];
    const ctx = {
      signal: new AbortController().signal,
      session,
      provider: {} as never,
      userMessage: REQUEST,
      toolContext: { sessionId: session.id, workspacePath: "/workspace" } as ToolContext,
      deliverableIntent: classifyDeliverableIntent(REQUEST),
      initialDynamicGuidance: null,
      rawResponse: DRAFT,
      iterationCount: 2,
      effectiveToolIterations: 2,
      terminalFinishReason: "stop",
      toolCallsRequested: 1,
      skipDraftRecovery: true,
      currentTurnHasExecutableOrchestration: true,
      forcedSynthesisFired: false,
      consecutiveDelegationFailures: 0,
      turnToolCallCounts: new Map<string, number>(),
      turnShareFindingCount: 0,
      turnKnowledgeBaseSourceUrls: new Set<string>(),
      workflowRunCompletedThisTurn: false,
      releasedWithoutResearchEvidence: false,
      autoResearchAnswer: null,
      outputScan: { safe: true, redacted: DRAFT } as never,
      getTurnDelegationCount: () => 1,
      getQaCorrectiveBuildUsed: () => false,
      incrementDelegationCount: () => undefined,
      guardrailEvents: [],
      finalizeUserFacingAssistantResponse: async (raw: string) => raw,
      forceSynthesis: async () => null,
      collectTurnArtifactAttachments: () => [],
      // A rewrite round has failed the re-check; the loop hands the flaws to the coordinator.
      runQaDeliveryGate: async (
        _session: unknown, _provider: unknown, _signal: unknown, answer: string, criteria: string[], _rounds: number,
        escalate?: (current: string, flaws: string, crit: string[]) => Promise<string | null>,
      ) => {
        const improved = escalate ? await escalate(answer, "No source is named for either figure.", criteria) : null;
        escalated.push(improved);
        return {
          answer: improved ?? answer,
          changed: improved !== null,
          rounds: 2,
          passed: true,
          status: "pass" as const,
          artifactProbeStatus: "not_requested" as const,
          artifactProbeCount: 0,
          escalated: true,
          unverified: false,
        };
      },
      runDeliverableConsistencyGate: async (_s: unknown, _p: unknown, _sig: unknown, answer: string) => ({ answer, changed: false, rounds: 0 }),
      runCorrectiveBuild: async () => null,
      runCorrectiveReroute: async () => null,
      logWarn: () => undefined,
    };

    const finalMsg = await applyTerminalResponseGuards(ctx as never);

    expect(escalated).toEqual([CORRECTED]);
    expect(finalMsg).toContain("Design A is the one that meets the target");
    expect(finalMsg).not.toContain("[mission_coordinator]");
    expect(finalMsg).not.toContain("Auto-routed");
  });
});

describe("the single-deliverable relay", () => {
  it("relays a routed specialist's deliverable without the routing note", () => {
    const deliverable = [
      "## Recommendation",
      "The **ESP32-C61** is the best pick for OTA sync plus deep-sleep efficiency.",
      "",
      "## Key specs",
      "| Field | Value |",
      "| --- | --- |",
      "| Deep sleep | 0.01 mA |",
      "| Wi-Fi | Wi-Fi 6 |",
      "| BLE | 5.3 |",
      "| Package | QFN |",
      "",
      "## Bill of materials",
      "- MEMS microphone: Infineon IM73A135V01 (analog differential output, IP57 rated, 4x3x1.2 mm package)",
      "- MCU: ESP32-C61-WROOM module with Wi-Fi 6 and BLE 5.3 for dual OTA paths",
      "- ADC: TI PCM1804 (24-bit, I2S output) to digitise the differential microphone outputs",
      "- Battery: 503048 LiPo pouch cell (~500 mAh) for a slim portable profile",
      "- USB-C charger: TP4056 linear charger with an IP5306 power-path controller",
      "- Wireless charging: Adafruit 1901 (BQ51013B) Qi receiver, 4.8-5.2 V at 500 mA",
      "",
      "## Waterproofing",
      "- Enclosure: IP67 ABS/PC shell with a silicone perimeter gasket and conformal-coated PCB",
      "- Mic ports: ePTFE acoustic vents that pass sound while blocking water and dust ingress",
    ].join("\n");
    const metadata = {
      agentName: "researcher",
      delegationOutcome: "success",
      delegationSucceeded: true,
      routingReason: { confidence: "high", matchedTerms: [], score: 0.84 },
    };
    const frame = buildModelVisibleToolResult(
      "delegate_to_agent",
      formatDelegatedOutput("researcher", deliverable, { confidence: "high", matchedTerms: [] }),
      metadata,
    );

    const relayed = extractSingleRelayableDeliverable([{ role: "tool", content: frame, metadata }], 1);

    expect(relayed).toBe(deliverable);
  });
});
