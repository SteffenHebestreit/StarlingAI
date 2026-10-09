/**
 * Turn metrics & prompt-sizing cluster (god-file seam, extracted from runtime.ts).
 *
 * Pure, non-loop helpers that measure a turn's prompt size, perform last-resort
 * base-prompt compaction under budget pressure, and assemble the
 * TurnPerformanceMetrics record emitted at the end of a turn.
 *
 * The per-stage wall-clock accumulator (`_phaseTimingsStore` + `timedPhase`) lives
 * here too: it is an AsyncLocalStorage singleton, not a main-loop dependency, so it
 * encapsulates cleanly. runtime.ts wraps a turn in `runWithPhaseTimings()` so any
 * `timedPhase()` call during the turn records into THAT turn's map, which
 * `buildTurnPerformanceMetrics()` reads back.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { LLMMessage } from "../providers/lmstudio.js";
import { effectiveOrchestratorTurnSloMs } from "../runtime/effort-context.js";

export interface TurnPerformanceMetrics {
  turnDurationMs: number;
  firstModelResponseMs?: number;
  llmCalls: number;
  llmTimeMs: number;
  toolCallsRequested: number;
  toolExecutionTimeMs: number;
  systemPromptChars: number;
  collapsedHistoryMessages: number;
  collapsedHistoryChars: number;
  promptChars: number;
  /**
   * Serialized size of the tool schemas sent with the request. NOT part of
   * promptChars: schemas travel in the provider's `tools` parameter, not in the
   * messages, so every other prompt metric here is blind to them — yet the tool
   * block can exceed the system prompt itself (measured ~72 KB of schemas vs a
   * ~17 KB system prompt in hybrid mode), which is what made the lean-catalog
   * (B37) saving impossible to observe in production. Optional: non-LLM / early
   * exit paths that build this shape have no tool payload to report.
   */
  toolSchemasChars?: number;
  completionChars: number;
  toolIterations: number;
  finishReason: string;
  blocked: boolean;
  /** Effective orchestrator turn-SLO budget for this turn (ms), reflecting the
   *  active effort profile. The Warden reads it off the turn_performance event so a
   *  high/max-effort turn doesn't trip a spurious SLO-breach alert — without the
   *  Warden having to import the session store (avoids a module cycle). */
  effortSloBudgetMs?: number;
  /** Per-stage wall-clock (ms) for work that runs OUTSIDE llmTimeMs/toolExecutionTimeMs —
   *  e.g. discoveryPrefetch, documentRag, qaDeliveryLoop, receptionistFastLane. Lets the
   *  Warden + eval attribute turn latency to a stage instead of treating turnDurationMs as
   *  a black box. */
  phaseTimingsMs?: Record<string, number>;
  /** turnDurationMs minus llmTimeMs, toolExecutionTimeMs, and all tracked phase timings —
   *  the residual that surfaces the next unmeasured cost. */
  untrackedMs?: number;
  /**
   * The model calls the QA gates made — the delivery loop's and the consistency gate's
   * verdicts and their rewrite calls — and the wall-clock they took. A BREAKDOWN, not another
   * slice: the time already sits inside phaseTimingsMs.qaDeliveryLoop /
   * deliverableConsistencyQa, and it is NOT in llmTimeMs, which stays the orchestrator loop's
   * own calls. Those stage timings are what the Warden partitions a slow turn by, so moving
   * QA time into llmTimeMs would have either counted it twice or renamed a "qaDeliveryLoop was
   * slow" alert into "llm was slow". What the stage timing cannot say is how much of it was
   * the model and over how many calls: session f4ebf47b's 145 s turn showed llmTimeMs 19 s
   * and qaDeliveryLoop 85 s, and only the provider rows showed that 85 s was three calls,
   * two of them verdicts that reasoned for 30 s and 47 s. Present only when a QA call ran.
   */
  qaLlmCalls?: number;
  qaLlmTimeMs?: number;
}

// Turn-scoped accumulator for per-stage wall-clock (A1). A turn runs inside one
// runTurn() invocation, but the gateway runs turns concurrently — so this MUST be
// AsyncLocalStorage (a module-level singleton would cross-contaminate turns), not a
// shared mutable. timedPhase() records the elapsed ms of a stage into the active
// turn's store; buildTurnPerformanceMetrics() reads it and computes untrackedMs.
interface TurnTimingStore {
  phases: Record<string, number>;
  /** The QA gates' model calls — see TurnPerformanceMetrics.qaLlmCalls. */
  qaLlm: { calls: number; timeMs: number };
}

const _phaseTimingsStore = new AsyncLocalStorage<TurnTimingStore>();

/**
 * Establish a fresh per-turn phase-timing store and run `fn` inside it, so any
 * `timedPhase()` call anywhere in the turn records into THIS turn's map.
 */
export function runWithPhaseTimings<T>(fn: () => Promise<T>): Promise<T> {
  return _phaseTimingsStore.run({ phases: Object.create(null) as Record<string, number>, qaLlm: { calls: 0, timeMs: 0 } }, fn);
}

export async function timedPhase<T>(phase: string, fn: () => Promise<T>): Promise<T> {
  const store = _phaseTimingsStore.getStore();
  if (!store) return fn();
  const start = Date.now();
  try {
    return await fn();
  } finally {
    store.phases[phase] = (store.phases[phase] ?? 0) + (Date.now() - start);
  }
}

/** Time one model call a QA gate makes (a verdict, or the rewrite it asks for) into this turn's
 *  qaLlmCalls / qaLlmTimeMs. A call that throws still counts: it spent the time. */
export async function timedQaModelCall<T>(fn: () => Promise<T>): Promise<T> {
  const store = _phaseTimingsStore.getStore();
  if (!store) return fn();
  const start = Date.now();
  try {
    return await fn();
  } finally {
    store.qaLlm.calls += 1;
    store.qaLlm.timeMs += Date.now() - start;
  }
}

export function measurePrompt(
  systemMessages: readonly LLMMessage[],
  history: readonly LLMMessage[],
  toolSchemasChars = 0,
): {
  systemPromptChars: number;
  collapsedHistoryMessages: number;
  collapsedHistoryChars: number;
  promptChars: number;
  toolSchemasChars: number;
} {
  const systemPromptChars = systemMessages.reduce((sum, message) => {
    const contentLength = typeof message.content === "string" ? message.content.length : 0;
    return sum + contentLength;
  }, 0);
  const collapsedHistoryChars = history.reduce((sum, message) => {
    const contentLength = typeof message.content === "string" ? message.content.length : 0;
    return sum + contentLength;
  }, 0);
  return {
    systemPromptChars,
    collapsedHistoryMessages: history.length,
    collapsedHistoryChars,
    // Deliberately NOT folded into promptChars — schemas are a separate request
    // field, and adding them would silently move every prompt-budget threshold
    // that compares against promptChars.
    promptChars: systemPromptChars + collapsedHistoryChars,
    toolSchemasChars,
  };
}

/**
 * Last-resort base-prompt compaction, used only when the budget trimmer has
 * already dropped every auxiliary block and the prompt is *still* over budget.
 *
 * Strips clearly non-load-bearing verbose sections — the Markdown "## Response
 * Format" guidance — and collapses runs of blank lines. It deliberately leaves
 * Core Principles, Swarm Rules, Tool Use Discipline, Orchestration Strategy,
 * and Security untouched: those carry behavioral and safety contracts. Returns
 * the prompt unchanged when there is nothing safe to remove.
 */
export function compactBasePromptUnderPressure(prompt: string): string {
  let out = prompt;
  // Remove the "## Response Format" section (heading through to the next "## ").
  // Formatting guidance is the lowest-value block under genuine budget
  // pressure: the model still answers correctly without it.
  out = out.replace(/\n## Response Format\n[\s\S]*?(?=\n## )/, "\n");
  // Collapse 3+ consecutive newlines left behind by removals to a single blank line.
  out = out.replace(/\n{3,}/g, "\n\n");
  return out;
}

export function buildTurnPerformanceMetrics(input: {
  turnStartedAt: number;
  firstModelResponseMs?: number;
  llmCalls: number;
  llmTimeMs: number;
  toolCallsRequested: number;
  toolExecutionTimeMs: number;
  lastPromptMetrics: {
    systemPromptChars: number;
    collapsedHistoryMessages: number;
    collapsedHistoryChars: number;
    promptChars: number;
    toolSchemasChars?: number;
  };
  completionChars: number;
  finishReason: string;
  blocked: boolean;
  toolIterations: number;
}): TurnPerformanceMetrics {
  const turnDurationMs = Date.now() - input.turnStartedAt;
  // Per-stage timings recorded by timedPhase() during this turn (empty when no
  // tracked stage ran). untrackedMs is the residual after LLM + tool + tracked
  // stages — it surfaces the next unmeasured cost.
  const timingStore = _phaseTimingsStore.getStore();
  const phaseStore = timingStore?.phases;
  const phaseTimingsMs = phaseStore && Object.keys(phaseStore).length > 0 ? { ...phaseStore } : undefined;
  const qaLlm = timingStore && timingStore.qaLlm.calls > 0 ? timingStore.qaLlm : undefined;
  const trackedPhaseMs = phaseTimingsMs ? Object.values(phaseTimingsMs).reduce((a, b) => a + b, 0) : 0;
  const untrackedMs = Math.max(0, turnDurationMs - input.llmTimeMs - input.toolExecutionTimeMs - trackedPhaseMs);
  return {
    turnDurationMs,
    firstModelResponseMs: input.firstModelResponseMs,
    llmCalls: input.llmCalls,
    llmTimeMs: input.llmTimeMs,
    toolCallsRequested: input.toolCallsRequested,
    toolExecutionTimeMs: input.toolExecutionTimeMs,
    systemPromptChars: input.lastPromptMetrics.systemPromptChars,
    collapsedHistoryMessages: input.lastPromptMetrics.collapsedHistoryMessages,
    collapsedHistoryChars: input.lastPromptMetrics.collapsedHistoryChars,
    promptChars: input.lastPromptMetrics.promptChars,
    toolSchemasChars: input.lastPromptMetrics.toolSchemasChars ?? 0,
    completionChars: input.completionChars,
    toolIterations: input.toolIterations,
    finishReason: input.finishReason,
    blocked: input.blocked,
    // Resolved within the turn's effort context (or config default outside one).
    effortSloBudgetMs: effectiveOrchestratorTurnSloMs(),
    ...(phaseTimingsMs ? { phaseTimingsMs } : {}),
    untrackedMs,
    ...(qaLlm ? { qaLlmCalls: qaLlm.calls, qaLlmTimeMs: qaLlm.timeMs } : {}),
  };
}
