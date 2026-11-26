import { describe, expect, it, vi } from "vitest";
import type { ModelConfig } from "../config/schema.js";
import type { LLMMessage } from "../providers/lmstudio.js";

/**
 * THE TURN REPORT COUNTS EVERY AGENT'S MODEL CALLS.
 *
 * turn_performance's llmCalls / llmTimeMs are the orchestrator loop's own calls. On a turn that
 * delegates, the specialist's model calls run inside the delegation tool, so they landed in
 * toolExecutionTimeMs, and the chat bubble's "LLM time" read 20.5 s on a 4.9-minute research turn
 * whose researcher spent about 162 s in its own calls (session e2b53b6f). The providers now count
 * each call into the turn it was made in (recordTurnModelCall), and the report carries the totals
 * beside the orchestrator's own figures (allModelCalls, allModelTimeMs, allPromptTokens,
 * allCompletionTokens).
 */

vi.mock("../audit/logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../audit/logger.js")>()),
  logAudit: () => {},
}));

const { LMStudioProvider } = await import("../providers/lmstudio.js");
const metrics = await import("../agent/turn-metrics.js");
const { runWithRequestContext } = await import("../runtime/request-context.js");

const base = { primary: "lmstudio/qwen", contextWindow: 8192, maxTokens: 64 } as ModelConfig;
const messages: LLMMessage[] = [
  { role: "system", content: "You are a careful assistant." },
  { role: "user", content: "Say ok." },
];

/**
 * A timer can fire a millisecond before Date.now() says its delay has passed (CI measured 19 ms
 * for a 20 ms wait): the timer runs on a monotonic clock, the measure on the wall clock.
 */
const TIMER_SLACK_MS = 3;

/** A provider whose server answers every call with `usage`, after `delayMs`; or fails. */
function provider(opts: { usage?: { prompt_tokens: number; completion_tokens: number }; delayMs?: number; fail?: boolean } = {}) {
  const instance = new LMStudioProvider("http://localhost:1234/v1", "test", base, { maxRetries: 0 });
  (instance as unknown as { client: unknown }).client = {
    chat: {
      completions: {
        create: async () => {
          if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
          if (opts.fail) throw new Error("connection reset");
          return {
            choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            ...(opts.usage ? { usage: opts.usage } : {}),
          };
        },
      },
    },
  };
  return instance;
}

/** The report a turn would write now (only the all-agents fields matter here). */
function report(llm: { calls: number; timeMs: number } = { calls: 0, timeMs: 0 }) {
  return metrics.buildTurnPerformanceMetrics({
    turnStartedAt: Date.now(),
    llmCalls: llm.calls,
    llmTimeMs: llm.timeMs,
    toolCallsRequested: 0,
    toolExecutionTimeMs: 0,
    lastPromptMetrics: { systemPromptChars: 0, collapsedHistoryMessages: 0, collapsedHistoryChars: 0, promptChars: 0 },
    completionChars: 0,
    finishReason: "stop",
    blocked: false,
    toolIterations: 0,
  });
}

describe("the turn report's all-agents model totals", () => {
  it("counts each call made in the turn, its time and its tokens, beside the orchestrator's own figures", async () => {
    const worker = provider({ usage: { prompt_tokens: 1200, completion_tokens: 80 }, delayMs: 30 });
    const distill = provider({ usage: { prompt_tokens: 300, completion_tokens: 20 } });

    const perf = await metrics.runWithPhaseTimings(async () => {
      await worker.complete(messages, []);
      await distill.complete(messages, []);
      // The orchestrator's own figures are what the loop passes in, untouched.
      return report({ calls: 1, timeMs: 5 });
    });

    expect(perf).toMatchObject({ llmCalls: 1, llmTimeMs: 5, allModelCalls: 2, allPromptTokens: 1500, allCompletionTokens: 100 });
    expect(perf.allModelTimeMs).toBeGreaterThanOrEqual(30 - TIMER_SLACK_MS);
  });

  it("counts a delegated agent's calls, which run in a request context of their own, in the turn that started them", async () => {
    const specialist = provider({ usage: { prompt_tokens: 6000, completion_tokens: 400 } });

    const perf = await metrics.runWithPhaseTimings(async () => {
      // A sub-agent runs its loop in a fresh request context (no inheritance), as delegate_to_agent does.
      await runWithRequestContext({ sessionId: "sub:chat:researcher:1", agentName: "researcher" }, async () => {
        await Promise.all([specialist.complete(messages, []), specialist.complete(messages, [])]);
      });
      return report();
    });

    expect(perf).toMatchObject({ allModelCalls: 2, allPromptTokens: 12_000, allCompletionTokens: 800 });
  });

  it("counts a nested turn's calls in its own report and in the turn around it", async () => {
    const model = provider({ usage: { prompt_tokens: 100, completion_tokens: 10 } });
    let inner: ReturnType<typeof report> | undefined;

    const outer = await metrics.runWithPhaseTimings(async () => {
      await model.complete(messages, []);
      // run_workflow's step: a nested runTurn opens its own timing store.
      inner = await metrics.runWithPhaseTimings(async () => {
        await model.complete(messages, []);
        await model.complete(messages, []);
        return report();
      });
      return report();
    });

    expect(inner).toMatchObject({ allModelCalls: 2, allPromptTokens: 200 });
    expect(outer).toMatchObject({ allModelCalls: 3, allPromptTokens: 300 });
  });

  it("counts a call that failed, with the time it took and no tokens", async () => {
    const broken = provider({ fail: true, delayMs: 20 });

    const perf = await metrics.runWithPhaseTimings(async () => {
      await expect(broken.complete(messages, [])).rejects.toThrow();
      return report();
    });

    expect(perf).toMatchObject({ allModelCalls: 1, allPromptTokens: 0, allCompletionTokens: 0 });
    expect(perf.allModelTimeMs).toBeGreaterThanOrEqual(20 - TIMER_SLACK_MS);
  });

  it("outside a turn counts nothing and reports no totals", async () => {
    await provider({ usage: { prompt_tokens: 50, completion_tokens: 5 } }).complete(messages, []);
    expect(() => metrics.recordTurnModelCall({ durationMs: 10, promptTokens: 5, completionTokens: 1 })).not.toThrow();

    const perf = report();
    expect(perf.allModelCalls).toBeUndefined();
    expect(perf.allModelTimeMs).toBeUndefined();
  });

  it("ignores a duration or a token count that is not a positive number", async () => {
    const perf = await metrics.runWithPhaseTimings(async () => {
      metrics.recordTurnModelCall({ durationMs: -5, promptTokens: null, completionTokens: Number.NaN });
      metrics.recordTurnModelCall({ durationMs: Number.NaN, promptTokens: 7, completionTokens: -1 });
      return report();
    });

    expect(perf).toMatchObject({ allModelCalls: 2, allModelTimeMs: 0, allPromptTokens: 7, allCompletionTokens: 0 });
  });
});
