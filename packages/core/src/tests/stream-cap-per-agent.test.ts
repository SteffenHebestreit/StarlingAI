import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import JSON5 from "json5";
import {
  BUILDER_MAX_STREAM_TOTAL_MS,
  LMStudioProvider,
  MAX_STREAM_TOTAL_CEILING_MS,
  MAX_STREAM_TOTAL_MS,
  resolveStreamTotalCapMs,
  type StreamChunk,
} from "../providers/lmstudio.js";
import {
  canWriteWorkspaceFiles,
  emitsWholeFileArtifacts,
  resolveAgentStreamCapMs,
  applyStreamCapOverlay,
} from "../agent/sub-agent-model-config.js";
import type { ModelConfig } from "../config/schema.js";

/**
 * The total-stream cap is PER AGENT, not one flat constant.
 *
 * An agent emitting a ~30 KB artifact needs ~9K completion tokens; at the measured
 * ~16.8 tok/s on qwen3.8-27b that is ~9 minutes of pure emission, and the reasoning
 * block before it costs as much again — so ONE legitimate build pass can run ~26
 * minutes. Under the old flat 20-minute ceiling that pass was guillotined at exactly
 * 1,200,000 ms with zero artifact tool calls (run f08195d2). Whole-file emitters now
 * get 45 minutes; everything else keeps 20.
 *
 * The cap stays a BACKSTOP: it sits above the agent's own turn deadline, because only
 * the deadline (DeadlineAbort) both salvages the partial AND resynthesizes it. It is
 * the operative bound only on a run that HAS no deadline.
 */
const base: ModelConfig = {
  primary: "lmstudio/qwen/qwen3.8-27b",
  contextWindow: 32_768,
  maxTokens: 256,
  temperature: 0,
  enableThinking: false,
};

const cap = (
  toolNames: readonly string[] | undefined,
  turnTimeoutMs: number | undefined,
  declaredTurnTimeoutMs?: number,
): number => resolveAgentStreamCapMs({ toolNames, turnTimeoutMs, declaredTurnTimeoutMs });

describe("resolveAgentStreamCapMs — tiering by capability", () => {
  it("promotes a whole-file EMITTER and nobody else", () => {
    expect(cap(["generate_presentation"], undefined)).toBe(BUILDER_MAX_STREAM_TOTAL_MS);
    expect(cap(["read_file", "generate_document"], undefined)).toBe(BUILDER_MAX_STREAM_TOTAL_MS);
    expect(cap(["web_search", "read_file"], undefined)).toBe(MAX_STREAM_TOTAL_MS);
    expect(cap(undefined, undefined)).toBe(MAX_STREAM_TOTAL_MS);
  });

  it("does NOT promote an agent that merely holds write_file / edit_file", () => {
    // This is the correction: 39 of the 49 shipped agents hold these, mostly for notes.
    // Keying the raised tier on them made 45 minutes the near-universal default.
    expect(emitsWholeFileArtifacts(["read_file", "write_file", "edit_file"])).toBe(false);
    expect(cap(["read_file", "write_file", "edit_file"], undefined)).toBe(MAX_STREAM_TOTAL_MS);
    // ...but they still count as "can put bytes in the workspace", which is a different
    // question and the one the ephemeral factory's request ceiling asks.
    expect(canWriteWorkspaceFiles(["read_file", "write_file"])).toBe(true);
    expect(canWriteWorkspaceFiles(["shell_exec", "create_dir", "read_file"])).toBe(false);
  });

  it("does NOT promote a shell/ops agent — shell_exec and create_dir emit no artifact content", () => {
    expect(emitsWholeFileArtifacts(["shell_exec", "create_dir", "read_file"])).toBe(false);
    expect(cap(["shell_exec", "create_dir"], undefined)).toBe(MAX_STREAM_TOTAL_MS);
  });

  it("keeps the DEADLINE primary by lifting the cap above it", () => {
    // The coordinator default is gateway.turnTimeoutMs * 0.85 = 1_530_000, which already
    // exceeded the flat 1_200_000 cap: the cap fired first and the run lost the deadline's
    // synthesis path. Now the cap is lifted clear of it.
    expect(cap(["run_task_graph"], 1_530_000)).toBeGreaterThan(1_530_000);
    expect(cap(["generate_website"], 1_500_000)).toBe(BUILDER_MAX_STREAM_TOTAL_MS);
    // Largest AGENT-declarable deadline still fits under the absolute ceiling.
    expect(cap(["read_file"], 1_800_000)).toBeGreaterThan(1_800_000);
    expect(cap(["read_file"], 1_800_000)).toBeLessThanOrEqual(MAX_STREAM_TOTAL_CEILING_MS);
  });

  it("the absolute ceiling WINS over the lift — the ordering is not an invariant", () => {
    // `--timeout 0` resolves to 7_200_000 (gateway/rpc.ts). The lift would want 7_260_000
    // and the clamp cuts it to 60 min, so the cap sits BELOW the deadline again. Asserted
    // because the comments used to promise the opposite.
    expect(cap(["read_file"], 7_200_000)).toBe(MAX_STREAM_TOTAL_CEILING_MS);
    expect(cap(["read_file"], 7_200_000)).toBeLessThan(7_200_000);
  });

  it("never reduces below the leak backstop, whatever the agent declared", () => {
    // The declared-budget FLOOR is now inert by arithmetic, and that is the point: the
    // backstop is one hour, no agent may declare more than 1_800_000, and the ceiling is
    // also one hour — so `max(tier, declared + margin)` can never exceed the tier. The
    // floor mattered while the tier was 20 minutes and a declaration could out-reach it.
    expect(cap(["write_file"], undefined, 1_500_000)).toBe(MAX_STREAM_TOTAL_MS);
    expect(cap(["write_file"], 0, 1_500_000)).toBe(MAX_STREAM_TOTAL_MS);
    // Never a REDUCTION: a short declaration cannot pull the cap under the backstop.
    expect(cap(["write_file"], undefined, 600_000)).toBe(MAX_STREAM_TOTAL_MS);
    // "unbound" reaches here as `undefined` — no statement, no floor.
    expect(cap(["write_file"], undefined, undefined)).toBe(MAX_STREAM_TOTAL_MS);
  });

  it("rides in on ModelConfig, the object every provider construction path already receives", () => {
    const overlaid = applyStreamCapOverlay(base, { toolNames: ["generate_website"], turnTimeoutMs: 600_000 });
    expect(overlaid.maxStreamTotalMs).toBe(BUILDER_MAX_STREAM_TOTAL_MS);
    expect(resolveStreamTotalCapMs(overlaid)).toBe(BUILDER_MAX_STREAM_TOTAL_MS);
    // Unset → the provider default, so nothing that never goes through the overlay changes.
    expect(resolveStreamTotalCapMs(base)).toBe(MAX_STREAM_TOTAL_MS);
  });

  it("an explicit per-agent pin is the documented route for a bare-write_file builder", () => {
    const pinned = applyStreamCapOverlay(
      { ...base, maxStreamTotalMs: BUILDER_MAX_STREAM_TOTAL_MS },
      { toolNames: ["write_file", "edit_file"], turnTimeoutMs: 1_500_000 },
    );
    expect(pinned.maxStreamTotalMs).toBe(BUILDER_MAX_STREAM_TOTAL_MS);
  });
});

/**
 * The tier is measured against the SHIPPED ROSTER, not hand-written tool arrays.
 *
 * Nothing did that before, which is how "builder" came to match 39 of the 49 agents in
 * workspace/agents/*.jsonc — summarizer, qa_guard, diff_reviewer, researcher and every
 * pentest agent among them — while every unit test asserted against invented arrays and
 * passed. Reading the committed shards (not the gitignored starlingai.json) mirrors
 * edit-test-loop.test.ts and workspace-catalog.test.ts.
 */
describe("the raised tier against the real workspace roster", () => {
  const agentsDir = fileURLToPath(new URL("../../../../workspace/agents/", import.meta.url));
  type Agent = { tools?: string[] };
  const subAgents: Record<string, Agent> = {};
  for (const file of readdirSync(agentsDir)) {
    if (!file.endsWith(".jsonc")) continue;
    const shard = JSON5.parse<{ subAgents?: Record<string, Agent> }>(readFileSync(join(agentsDir, file), "utf-8"));
    Object.assign(subAgents, shard.subAgents ?? {});
  }
  const promoted = Object.entries(subAgents)
    .filter(([, a]) => emitsWholeFileArtifacts(a.tools))
    .map(([name]) => name);

  it("has a roster to measure (guards against a silently empty parse)", () => {
    expect(Object.keys(subAgents).length).toBeGreaterThan(20);
  });

  it("promotes a small minority, not most of the swarm", () => {
    // 39/49 was the defect. A quarter of the roster is the outer bound of "targeted".
    expect(promoted.length / Object.keys(subAgents).length).toBeLessThan(0.25);
  });

  it("does not promote the note-takers the old set caught", () => {
    for (const name of ["summarizer", "researcher", "qa_guard", "diff_reviewer", "shell_agent", "coder"]) {
      if (!subAgents[name]) continue; // a fork may not ship this agent
      expect(promoted, `${name} takes notes with write_file; its deliverable is not a file`).not.toContain(name);
    }
  });

  it("still promotes the agents whose deliverable IS the emitted file", () => {
    for (const name of ["content_writer", "web_coder"]) {
      if (!subAgents[name]) continue;
      expect(promoted, `${name} emits whole files`).toContain(name);
    }
  });
});

/**
 * The behavioural half: the provider must actually enforce the value it was handed.
 *
 * Date.now() is stubbed so the stream can "take" 25 minutes without the test taking any
 * time. The per-chunk inactivity timer runs on real timers and never fires here.
 */
function providerWithCap(maxStreamTotalMs: number | undefined): LMStudioProvider {
  const cfg: ModelConfig = maxStreamTotalMs === undefined ? base : { ...base, maxStreamTotalMs };
  return new LMStudioProvider("http://localhost:1234/v1", "k", cfg, { maxRetries: 0 });
}

/** Fake OpenAI stream: one text chunk, then 25 minutes of clock, then a second chunk. */
function installFakeStream(provider: LMStudioProvider, clock: { now: number }, gapMs: number): void {
  const chunk = (content: string) => ({ choices: [{ delta: { content }, finish_reason: null }] });
  (provider as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async () => ({
          async *[Symbol.asyncIterator]() {
            yield chunk("first pass");
            clock.now += gapMs;
            yield chunk(" second pass");
            yield { choices: [{ delta: {}, finish_reason: "stop" }] };
          },
        }),
      },
    },
  };
}

async function drain(provider: LMStudioProvider): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of provider.stream([{ role: "user", content: "build it" }], [])) out.push(c);
  return out;
}

describe("LMStudioProvider.streamOnce — enforces the per-agent cap", () => {
  afterEach(() => vi.restoreAllMocks());

  const GAP_MS = 1_500_000; // 25 min: the worst LEGITIMATE single build pass on this hardware

  it("does NOT cut a 25-minute generation — that is a legitimate build pass, not a runaway", async () => {
    // This assertion is inverted from what it used to be, deliberately. The default was
    // 20 minutes and it guillotined exactly this shape to the millisecond (run f08195d2:
    // 1,200,000 ms, 64,587 reasoning chars, zero artifact tool calls). A capability guess
    // is not a health signal; the cap is now an hour and only bounds a caller with no
    // deadline at all.
    const clock = { now: Date.now() };
    vi.spyOn(Date, "now").mockImplementation(() => clock.now);
    const provider = providerWithCap(undefined);
    installFakeStream(provider, clock, GAP_MS);

    const chunks = await drain(provider);
    expect(chunks.filter((c) => c.type === "text_delta").map((c) => c.content).join(""))
      .toBe("first pass second pass");
  });

  it("cuts a generation that runs past the hour, with no caller deadline in sight", async () => {
    const clock = { now: Date.now() };
    vi.spyOn(Date, "now").mockImplementation(() => clock.now);
    const provider = providerWithCap(undefined);
    installFakeStream(provider, clock, MAX_STREAM_TOTAL_MS + 60_000);

    await expect(drain(provider)).rejects.toThrow(/exceeded its total budget/);
  });

  it("a builder that runs past even 45 minutes is still cut, and the partial is salvaged", async () => {
    const clock = { now: Date.now() };
    vi.spyOn(Date, "now").mockImplementation(() => clock.now);
    const provider = providerWithCap(BUILDER_MAX_STREAM_TOTAL_MS);
    installFakeStream(provider, clock, BUILDER_MAX_STREAM_TOTAL_MS + 60_000);

    // completeViaStream keeps what was produced rather than failing the turn — the cap
    // error routes through the catch, not through a clean `break` that would launder a
    // guillotined generation into a reported success.
    const r = await provider.completeViaStream([{ role: "user", content: "build it" }], []);
    expect(r.content).toBe("first pass");
    expect(r.finishReason).toBe("length");
    expect(r.usage.completionTokens).toBeGreaterThan(0);
  });
});
