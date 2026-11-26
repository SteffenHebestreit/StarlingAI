import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A FILE WAS ASKED FOR AND THE RUN ONLY SAID HOW IT WOULD MAKE IT.
 *
 * Session b0a37996: image_creator was delegated "put a flower in the person's left hand" with
 * deliverable "file". It read the picture, answered "I'll use generate_image with baseImage on the
 * balanced engine …" and stopped — no call, no file — and the plan counted the step done, so the
 * person got a status report instead of a picture. A run whose delegation declared a file and that
 * has made none is now handed back once; the evidence is the declaration and the empty workspace
 * trail, not the wording of the announcement.
 */

const completeViaStreamMock = vi.fn();
const auditEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];

vi.mock("../providers/lmstudio.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/lmstudio.js")>()),
  LMStudioProvider: class {
    async completeViaStream(messages: unknown, tools: unknown, signal?: AbortSignal, options?: unknown) {
      return completeViaStreamMock(messages, tools, signal, options);
    }
    async complete(messages: unknown, tools: unknown, signal?: AbortSignal) {
      return completeViaStreamMock(messages, tools, signal, undefined);
    }
  },
}));

vi.mock("../audit/logger.js", async (importActual) => ({
  ...(await importActual<typeof import("../audit/logger.js")>()),
  logAudit: (event: string, payload: Record<string, unknown>) => { auditEvents.push({ event, payload }); },
}));

interface StubResponse {
  content: string | null;
  reasoning: string;
  tool_calls: unknown[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number; estimated: boolean };
  finishReason: string;
}

const usage = { promptTokens: 7000, completionTokens: 30, totalTokens: 7030, estimated: true };
const text = (content: string): StubResponse => ({ content, reasoning: "", tool_calls: [], usage, finishReason: "stop" });
const call = (name: string, args: Record<string, unknown>): StubResponse => ({
  content: null, reasoning: "", tool_calls: [{ id: `call_${name}`, name, arguments: args }], usage, finishReason: "tool_calls",
});

const ANNOUNCEMENT = "Good — the hand is on the right. I'll use generate_image with baseImage on the balanced engine, which keeps the rest of the picture.";
const NUDGE = "YOUR TASK ASKS FOR A FILE";

async function run(sequence: StubResponse[], deliverable?: "file" | "answer") {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-file-deliverable-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    workspacePath: tempDir,
    subAgents: {
      maker: {
        description: "File deliverable fixture",
        systemPrompt: "Work the task.",
        tools: ["read_file", "write_file"],
        maxIterations: 6,
        turnTimeoutMs: 600_000,
      },
    },
  }), "utf8");
  writeFileSync(join(tempDir, "notes.txt"), "source material", "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  vi.resetModules();

  let index = 0;
  completeViaStreamMock.mockImplementation(() => Promise.resolve(sequence[Math.min(index++, sequence.length - 1)]!));
  // Registers read_file and write_file.
  await import("../tools/filesystem.js");
  const { runSubAgent } = await import("../agent/sub-agent.js");
  const output = String(await runSubAgent({
    agentName: "maker",
    task: "Put a small white flower in the figure's left hand of notes.txt's picture and save the result.",
    parentSessionId: `file-deliverable-${Math.random().toString(36).slice(2)}`,
    workspacePath: tempDir,
    ...(deliverable ? { deliverable } : {}),
  }));
  rmSync(tempDir, { recursive: true, force: true });
  return { output, calls: completeViaStreamMock.mock.calls.length };
}

function userMessagesOfCall(index: number): string[] {
  return (completeViaStreamMock.mock.calls[index]![0] as Array<{ role: string; content: unknown }>)
    .filter((m) => m.role === "user").map((m) => String(m.content));
}

describe("a delegation that declared a file", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    completeViaStreamMock.mockReset();
    auditEvents.length = 0;
    vi.resetModules();
    (await import("../config/loader.js")).resetConfigForTests();
    await (await import("../swarm/memory.js")).resetSharedMemoryForTests();
  });

  it("hands an announcement back once, and the run then makes the file", async () => {
    const { output, calls } = await run([
      call("read_file", { path: "notes.txt" }),
      text(ANNOUNCEMENT),
      call("write_file", { path: "flower.txt", content: "the edited picture" }),
      text("Saved generated/flower.txt."),
    ], "file");

    expect(calls).toBe(4);
    expect(userMessagesOfCall(2).at(-1)).toContain(NUDGE);
    expect(output).toContain("flower.txt");
    const intervened = auditEvents.filter((e) => e.event === "progress_verifier_intervened" && e.payload["verdict"] === "file_deliverable_missing");
    expect(intervened).toHaveLength(1);
  });

  it("hands it back only once: a run that still makes nothing ends with its answer", async () => {
    const { output, calls } = await run([
      call("read_file", { path: "notes.txt" }),
      text(ANNOUNCEMENT),
      text("I cannot make the picture here: no image tool is available to me."),
    ], "file");

    expect(calls).toBe(3);
    expect(output).toContain("no image tool");
  });

  it("leaves a run alone that made its file, or whose delegation asked for an answer — the controls", async () => {
    const made = await run([
      call("write_file", { path: "flower.txt", content: "the edited picture" }),
      text("Saved generated/flower.txt."),
    ], "file");
    expect(made.calls).toBe(2);
    expect(completeViaStreamMock.mock.calls.flatMap((_, i) => userMessagesOfCall(i)).some((m) => m.includes(NUDGE))).toBe(false);

    completeViaStreamMock.mockReset();
    const answered = await run([call("read_file", { path: "notes.txt" }), text(ANNOUNCEMENT)], "answer");
    expect(answered.calls).toBe(2);
  });
});
