/**
 * A SPECIALIST THAT ONLY DESCRIBED THE FILE IT WAS ASKED FOR DID NOT DELIVER IT.
 *
 * Session b0a37996: the plan delegated "put a white flower in the boy's left hand" to image_creator
 * with deliverable "file". It read the picture, answered "I'll use generate_image with baseImage …"
 * and stopped. The delegation judged that a narrative-only miss, but kept the 310 characters as a
 * substantive partial anyway (the text named an "edited" picture, which the planning-phrase check
 * reads as work done), so delegate_to_agent came back a success and the plan counted the step done.
 * A run that ends on its own like that now fails the delegation; a run something cut short keeps
 * what it said, as before.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SwarmState } from "../tools/registry.js";
import type { SubAgentRunOptions, SubAgentRunResult } from "../agent/sub-agent.js";

const runSubAgentWithStatsMock = vi.fn<(args: SubAgentRunOptions) => Promise<SubAgentRunResult>>();

vi.mock("../agent/sub-agent.js", () => ({
  runSubAgent: vi.fn(async () => ""),
  runSubAgentWithStats: runSubAgentWithStatsMock,
}));

// Invented, in the shape of the session's answer: an announcement, a path, and "edited".
const ANNOUNCEMENT =
  "I'll use generate_image with baseImage on the balanced engine to put the white flower into the hand on the viewer's left "
  + "of the already edited picture generated/retouched/quay_no_cars.png, keeping the rest of the scene unchanged, "
  + "and save the result beside it under a readable name.";
const TASK = "STEP s1 — Put a white flower in the boy's left hand; he holds it out to the woman. Base: the retouched picture.";

const swarmState = (): SwarmState => ({
  objective: "test",
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  tasks: {},
});

/** One image_creator run that read the picture and ended as `terminalState`. */
function runThatOnlyRead(terminalState: "completed" | "timeout") {
  runSubAgentWithStatsMock.mockImplementation(async (args) => ({
    output: ANNOUNCEMENT,
    stats: {
      agentName: args.agentName,
      sessionId: `sub:${args.parentSessionId}:${args.agentName}:test`,
      promptChars: 0,
      userContentChars: String(args.task ?? "").length,
      toolCount: 2,
      toolNames: ["read_shared_facts", "analyze_image"],
      iterations: terminalState === "timeout" ? 4 : 1,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      maxIterations: 8,
      model: "mock",
      capabilities: [],
      terminalState,
      outcome: terminalState === "completed" ? "success" : "failure",
    },
  }));
}

describe("a delegation asked for a file whose run only described it", () => {
  let workspacePath = "";

  beforeEach(async () => {
    workspacePath = mkdtempSync(join(tmpdir(), "sai-narrated-file-"));
    writeFileSync(join(workspacePath, "starlingai.json"), JSON.stringify({
      workspacePath,
      subAgents: {
        image_creator: {
          description: "Generates and edits pictures.",
          systemPrompt: "Edit the picture you are given.",
          tools: ["generate_image", "transform_image", "analyze_image", "read_shared_facts"],
          maxIterations: 8,
        },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(workspacePath, "starlingai.json");
    runSubAgentWithStatsMock.mockReset();
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
  });

  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
    rmSync(workspacePath, { recursive: true, force: true });
    vi.resetModules();
  });

  const delegate = async (sessionId: string) => {
    const [{ getTool }] = await Promise.all([import("../tools/registry.js"), import("../tools/sub-agent.js")]);
    return getTool("delegate_to_agent")!.execute(
      { agentName: "image_creator", task: TASK, deliverable: "file" },
      { sessionId, workspacePath, swarmState: swarmState() },
    );
  };

  it("is not phrased like a plan, so only the deliverable verdict can catch it", async () => {
    // The precondition that makes the next case discriminate: the phrase check lets this text by.
    const { looksLikePlanningOnlyResult } = await import("../tools/delegation-artifact-classification.js");
    expect(looksLikePlanningOnlyResult(ANNOUNCEMENT)).toBe(false);
  });

  it("fails when the run ended on its own, naming the tool it should have called", async () => {
    runThatOnlyRead("completed");

    const result = await delegate("s-narrated-file");

    expect(result.success).toBe(false);
    expect(result.metadata?.["partialFallback"]).toBeUndefined();
    expect(String(result.error)).toMatch(/narrative-only/);
    expect(String(result.error)).toContain("generate_image");
  }, 30_000);

  it("keeps what a run said when something cut it short — the control", async () => {
    runThatOnlyRead("timeout");

    const result = await delegate("s-narrated-file-timeout");

    expect(result.success).toBe(true);
    expect(result.metadata?.["partialFallback"]).toBe(true);
    expect(result.output).toContain("generated/retouched/quay_no_cars.png");
  }, 30_000);
});
