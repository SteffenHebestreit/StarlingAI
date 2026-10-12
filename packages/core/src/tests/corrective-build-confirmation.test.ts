import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CorrectiveContext } from "../agent/turn-corrective.js";
import type { LLMMessage } from "../providers/lmstudio.js";
import type { ToolContext } from "../tools/registry.js";

// The final-QA corrective build wrote the file, and its confirmation told the user it had not been
// created. In the E2E run of 2026-10-10 (guards-list-files-on-a-file, step 1) content_writer wrote
// generated/e2e-guards/inventur ("File written: … (34 chars)"), and the confirmation, a synthesis over
// the turn's whole history, followed an earlier skill_manage refusal: "Systemfehler … Datei wurde
// nicht erstellt". The confirmation now reads the request, the build's own call and result, and the
// artifact facts, and nothing else of the turn.

const sentMessages = vi.hoisted(() => [] as LLMMessage[][]);

vi.mock("../providers/index.js", () => {
  const provider = {
    checkHealth: async () => ({ healthy: true }),
    verifyToolCallSupport: async () => true,
    stream: () => (async function* () { /* unused */ })(),
    complete: async (messages: LLMMessage[]) => {
      sentMessages.push(messages);
      return {
        content: "Die Datei generated/e2e-guards/inventur wurde erstellt (1 KB) und enthält die Zeile „Inventur Westmark: Regal 4, Fach 9“.",
        tool_calls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        finishReason: "stop",
      };
    },
    embed: async () => [],
    isHealthy: () => true,
  };
  return {
    applyActiveModelPreset: (model: Record<string, unknown>) => model,
    tierModelDefaults: () => ({}),
    createChatProvider: () => provider,
    getChatProvider: () => provider,
    getChatProviderWithOverride: () => provider,
    getChatProviderForTier: () => provider,
  };
});
vi.mock("../audit/logger.js", () => ({ logAudit: vi.fn() }));

const BUILD_REPORT = "File written: generated/e2e-guards/inventur (34 chars)";
const ARTIFACT = { relativePath: "generated/e2e-guards/inventur", filename: "inventur", size: 34 };

vi.mock("../tools/registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/registry.js")>();
  return {
    ...actual,
    executeTool: vi.fn(async () => ({ success: true, output: BUILD_REPORT, metadata: { artifacts: [ARTIFACT] } })),
  };
});

const REQUEST = "Lege die Datei generated/e2e-guards/inventur an, Inhalt: Inventur Westmark: Regal 4, Fach 9";
/** What the turn had done before the build: a refused call and a draft that gave up on the file. */
const REFUSAL = "Error: skill_manage is blocked for this turn by security policy.";
const GAVE_UP = "Systemfehler: Die Datei konnte nicht erstellt werden.";

const configDir = mkdtempSync(join(tmpdir(), "sai-corrective-confirmation-"));

let modules: {
  runtime: typeof import("../agent/runtime.js");
  corrective: typeof import("../agent/turn-corrective.js");
  intent: typeof import("../agent/deliverable-intent.js");
  AgentSession: typeof import("../agent/session.js")["AgentSession"];
};

beforeAll(async () => {
  writeFileSync(join(configDir, "starlingai.json"), JSON.stringify({ agents: { mainAssistant: { defaultLanguage: "German" } } }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(configDir, "starlingai.json");
  vi.resetModules();
  const { AgentSession } = await import("../agent/session.js");
  const runtime = await import("../agent/runtime.js");
  const corrective = await import("../agent/turn-corrective.js");
  const intent = await import("../agent/deliverable-intent.js");
  modules = { runtime, corrective, intent, AgentSession };
});

afterAll(() => {
  delete process.env["SAI_CONFIG_PATH"];
  rmSync(configDir, { recursive: true, force: true });
});

beforeEach(() => {
  sentMessages.length = 0;
});

function turnSoFar() {
  const session = new modules.AgentSession({ channel: "test", workspacePath: configDir, systemPrompt: "You are a test agent." });
  session.addMessage({ role: "user", content: REQUEST });
  session.addMessage({
    role: "assistant",
    content: "",
    tool_calls: [{ id: "c1", type: "function", function: { name: "skill_manage", arguments: "{}" } }],
  });
  session.addMessage({ role: "tool", content: REFUSAL, tool_call_id: "c1" });
  session.addMessage({ role: "assistant", content: GAVE_UP });
  return session;
}

function correctiveContext(session: InstanceType<typeof modules.AgentSession>): CorrectiveContext {
  let latch = false;
  return {
    signal: new AbortController().signal,
    session,
    userMessage: REQUEST,
    deliverableIntent: modules.intent.classifyDeliverableIntent(REQUEST),
    toolContext: { sessionId: session.id, workspacePath: configDir } as ToolContext,
    getIterationCount: () => 2,
    getProvider: () => ({}) as never,
    getStashedBuilderTaskSpec: () => null,
    getQaCorrectiveBuildUsed: () => latch,
    setQaCorrectiveBuildUsed: (value) => { latch = value; },
    getCorrectiveRerouteUsed: () => false,
    setCorrectiveRerouteUsed: () => undefined,
    incrementDelegationCount: () => undefined,
    forceSynthesis: modules.runtime.forceSynthesis,
    selectCorrectiveResumeTarget: () => null,
    collectTurnArtifactAttachments: () => [],
    extractArtifactsFromMetadata: (metadata, out) => {
      for (const artifact of (metadata["artifacts"] as Array<Record<string, unknown>> | undefined) ?? []) out.push(artifact);
    },
    logWarn: () => undefined,
  };
}

const sentText = (messages: readonly LLMMessage[]) => messages.map((message) => (typeof message.content === "string" ? message.content : "")).join("\n");

describe("the corrective build's confirmation", () => {
  it("is written from the request, the build's own result and the artifact facts, not from the turn's history", async () => {
    const session = turnSoFar();

    const confirmation = await modules.corrective.runCorrectiveBuild("", correctiveContext(session));

    expect(confirmation).toContain("generated/e2e-guards/inventur");
    expect(sentMessages).toHaveLength(1);
    const sent = sentText(sentMessages[0]!);
    expect(sent).toContain(REQUEST);
    expect(sent).toContain(BUILD_REPORT);
    expect(sent).toContain("ARTIFACT FACTS");
    expect(sent).not.toContain(REFUSAL);
    expect(sent).not.toContain(GAVE_UP);
    // The build is still recorded in the session, where the turn's attachments are read from.
    expect(session.getHistory().some((message) => message.content === BUILD_REPORT)).toBe(true);
  });

  it("is not written when the caller keeps its own answer: no model call, the built paths come back", async () => {
    // Review of d2d064bc: the completion gate keeps a turn's answer after a repair and discarded
    // this confirmation, a whole synthesis call on the slow model.
    const session = turnSoFar();

    const built = await modules.corrective.runCorrectiveBuild("", correctiveContext(session), { confirm: false });

    expect(built).toBe("generated/e2e-guards/inventur");
    expect(sentMessages).toHaveLength(0);
    // The build itself is recorded as before, so the file still surfaces as an attachment.
    expect(session.getHistory().some((message) => message.content === BUILD_REPORT)).toBe(true);
  });

  it("control: a forced synthesis given no history reads the session's, as before", async () => {
    const session = turnSoFar();

    await modules.runtime.forceSynthesis(session, {} as never, new AbortController().signal, "Write the final answer.");

    const sent = sentText(sentMessages[0]!);
    expect(sent).toContain(REFUSAL);
    expect(sent).toContain(GAVE_UP);
  });
});
