/**
 * Progress messages: what a running turn tells the person while it works.
 *
 * A long turn showed what it did only as a step list and a status line that kept being replaced: a
 * person waiting minutes for a plan of three specialists never read what the plan was, which part
 * was done or what came next. Now the turn posts short messages into the chat, each its own
 * message before the answer:
 *
 * - bridge: when the orchestrator reaches for tools, a line on what it is looking into ("Let me
 *   check which tools I need for this"). Held back for a moment (orchestration.progressBridgeDelayMs)
 *   so a quick lookup that is answered right away posts nothing, and dropped when a plan comes first.
 * - plan: the plan record_plan stored, its steps as a numbered list; again when it is revised.
 * - step: when a plan step finishes or fails: which one, what it produced, what runs now, what is next.
 *
 * Each message has a fixed wording in German or English, filled with the plan's own step
 * descriptions. With orchestration.progressMessagePhrasing the narration-tier model
 * (agents.defaults.model.tiers.narration) words it instead, from the same facts; what it writes is
 * taken only when it stays short and names no number the facts do not hold. It gets
 * orchestration.progressMessagePhrasingTimeoutMs, and the fixed wording goes out when that runs out.
 * Not the routing tier: that is often the task model itself, and in the lab (2026-11-05) it timed
 * out on 10 of 13 messages while the turn's specialists kept it busy.
 *
 * Messages go out one at a time and in the order they were reported. When the turn ends, anything
 * still waiting goes out in its fixed wording, before the answer.
 */
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import type { ChatProvider } from "../providers/lmstudio.js";
import { runWithCallAttribution } from "../runtime/request-context.js";

const log = childLogger("turn-progress");

export type TurnProgressKind = "bridge" | "plan" | "step";

export interface ProgressStep {
  id: string;
  description: string;
  agent?: string;
}

export type TurnProgressFacts =
  | {
    kind: "bridge";
    /** What the person asked, as they wrote it. */
    request: string;
    /** The tools and specialists the orchestrator's first calls reach for. */
    reachingFor: string[];
  }
  | { kind: "plan"; revised: boolean; steps: ProgressStep[] }
  | {
    kind: "step";
    step: ProgressStep;
    /** The step's place in the plan (1-based) and the plan's length. */
    position: number;
    total: number;
    outcome: "done" | "failed";
    /** What the step's run answered, for the model to take the gist from. */
    result?: string;
    /** The files it produced. */
    files?: string[];
    /** Why it failed. */
    reason?: string;
    /** Steps still running beside it. */
    running: ProgressStep[];
    /** The next step that has not started. Absent with nothing running: the plan is through. */
    next?: ProgressStep;
  };

export interface TurnProgressReporter {
  report(facts: TurnProgressFacts): void;
  /** The bridge line, after the delay, unless the turn ended or posted something else first. */
  scheduleBridge(facts: Extract<TurnProgressFacts, { kind: "bridge" }>): void;
  /** Send what is still waiting, in its fixed wording, and stop. */
  close(): Promise<void>;
}

/** Turns facts into a message: null keeps the fixed wording. */
export type ProgressPhraser = (
  facts: TurnProgressFacts,
  fixedText: string,
  language: string,
  signal: AbortSignal,
) => Promise<string | null>;

/** A plan step as a progress message names it: what it does, and who or what does it. */
export function progressStepOf(step: { id: string; description: string; agent?: string; workflow?: string; tool?: string }): ProgressStep {
  const by = step.agent ?? step.workflow ?? step.tool;
  return { id: step.id, description: step.description, ...(by ? { agent: by } : {}) };
}

/**
 * What a response's tool calls reach for, for the bridge line: each tool once, a delegation by the
 * specialist it names.
 */
export function progressBridgeTargets(calls: ReadonlyArray<{ name: string; arguments?: Record<string, unknown> }>): string[] {
  const targets = calls.map((call) => {
    const agent = call.arguments?.["agentName"];
    return typeof agent === "string" && agent.trim() ? `${call.name} (${agent.trim()})` : call.name;
  });
  return [...new Set(targets)];
}

// ── Fixed wording ────────────────────────────────────────────────────────────────────────────

/** "German" gets the German form; every other language the English one, as localizedFixedText. */
function isGerman(language: string): boolean {
  return language.trim().toLowerCase() === "german";
}

function sentence(text: string): string {
  return text.trim().replace(/[\s.!?…:;,]+$/u, "");
}

function stepNames(steps: readonly ProgressStep[]): string {
  return steps.map((step) => sentence(step.description)).join("; ");
}

/** The numbered list a plan message shows, whoever wrote the line above it. */
export function planList(steps: readonly ProgressStep[]): string {
  return steps.map((step, index) => `${index + 1}. ${sentence(step.description)}${step.agent ? ` (${step.agent})` : ""}`).join("\n");
}

export function fixedProgressText(facts: TurnProgressFacts, language: string): string {
  const de = isGerman(language);
  if (facts.kind === "bridge") {
    return de
      ? "Ich schaue kurz, welche Werkzeuge und Spezialisten ich dafür brauche."
      : "Let me see which tools and specialists I need for this.";
  }
  if (facts.kind === "plan") {
    const intro = facts.revised
      ? (de ? "Ich habe den Plan angepasst:" : "I've changed the plan:")
      : (de ? "So gehe ich vor:" : "Here's my plan:");
    return `${intro}\n${planList(facts.steps)}`;
  }
  const parts: string[] = [];
  const what = sentence(facts.step.description);
  if (facts.outcome === "done") {
    parts.push(de
      ? `Schritt ${facts.position} von ${facts.total} ist erledigt: ${what}.`
      : `Step ${facts.position} of ${facts.total} is done: ${what}.`);
    if (facts.files?.length) parts.push(de ? `Ergebnis: ${facts.files.join(", ")}.` : `Result: ${facts.files.join(", ")}.`);
  } else {
    const reason = facts.reason ? ` (${sentence(facts.reason)})` : "";
    parts.push(de
      ? `Schritt ${facts.position} von ${facts.total} hat nicht geklappt: ${what}${reason}.`
      : `Step ${facts.position} of ${facts.total} didn't work: ${what}${reason}.`);
  }
  if (facts.running.length > 0) parts.push(de ? `Gerade läuft: ${stepNames(facts.running)}.` : `Now running: ${stepNames(facts.running)}.`);
  if (facts.next) parts.push(de ? `Als Nächstes: ${sentence(facts.next.description)}.` : `Next: ${sentence(facts.next.description)}.`);
  if (facts.running.length === 0 && !facts.next) {
    parts.push(facts.outcome === "done"
      ? (de ? "Alle Schritte sind durch; ich stelle die Antwort zusammen." : "All steps are through; I'm putting the answer together.")
      : (de ? "Ich prüfe, wie ich damit umgehe." : "I'm working out how to deal with that."));
  }
  return parts.join(" ");
}

// ── Model wording ────────────────────────────────────────────────────────────────────────────

const MAX_WORDED_CHARS: Record<TurnProgressKind, number> = { bridge: 160, plan: 200, step: 420 };
const RESULT_CHARS_FOR_MODEL = 600;

function factsText(facts: TurnProgressFacts): string {
  if (facts.kind === "bridge") {
    return `The person asked: ${facts.request.slice(0, 400)}\nYou are about to use: ${facts.reachingFor.join(", ") || "your tools"}`;
  }
  if (facts.kind === "plan") {
    return `${facts.revised ? "You just changed your plan. The new plan" : "You just made a plan. It"} has these steps:\n${planList(facts.steps)}`;
  }
  const lines = [
    `Step ${facts.position} of ${facts.total} ${facts.outcome === "done" ? "finished" : "failed"}: ${sentence(facts.step.description)}`,
  ];
  if (facts.result) lines.push(`What it answered: ${facts.result.slice(0, RESULT_CHARS_FOR_MODEL)}`);
  if (facts.files?.length) lines.push(`Files it produced: ${facts.files.join(", ")}`);
  if (facts.reason) lines.push(`Why it failed: ${facts.reason}`);
  if (facts.running.length) lines.push(`Still running: ${stepNames(facts.running)}`);
  if (facts.next) lines.push(`Next: ${sentence(facts.next.description)}`);
  if (!facts.running.length && !facts.next) lines.push("Nothing else in the plan is left; the answer comes next.");
  return lines.join("\n");
}

const ASK: Record<TurnProgressKind, string> = {
  bridge: "Write ONE short sentence (at most 15 words) saying what you are checking first, like \"Let me check your calendar.\" Do not say what you will find.",
  plan: "Write ONE short sentence that introduces the plan; the steps are shown right after it as a numbered list, so do not repeat them.",
  step: "Write one or two short sentences: what was just finished (with its key result, if it has one) and what happens now or next.",
};

/** The messages the routing-tier model is asked with. Exported for tests. */
export function phrasingMessages(facts: TurnProgressFacts, language: string): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: "You write the short status messages an assistant posts to the person it works for while it is busy with their request. "
        + `Write in ${language}. Use only the facts given: add no result, number or claim they do not hold, and never answer the request itself. `
        + "First person, plain and friendly; no greeting, no markdown, no list, no emoji. Reply with the message only.",
    },
    { role: "user", content: `${factsText(facts)}\n\n${ASK[facts.kind]}` },
  ];
}

/**
 * What the model wrote, as the message: null when it cannot be taken. Too long, more than one
 * paragraph, markup or a reasoning block, or a number the facts do not hold (a count, a sum, a
 * date it made up) keep the fixed wording. A plan's line gets the plan's list below it. Exported
 * for tests.
 */
export function acceptPhrasing(facts: TurnProgressFacts, output: string): string | null {
  let text = output.trim().replace(/^["'„“”«»]+|["'„“”«»]+$/gu, "").trim();
  if (!text || /<\/?think|^[[{]|```|^#|\n\s*\n/iu.test(text)) return null;
  text = text.replace(/\s+/g, " ");
  if (text.length > MAX_WORDED_CHARS[facts.kind]) return null;
  const known = factsText(facts);
  const numbers = text.match(/\d+(?:[.,:]\d+)*/g) ?? [];
  if (numbers.some((number) => !known.includes(number))) return null;
  return facts.kind === "plan" ? `${text}\n${planList(facts.steps)}` : text;
}

/**
 * The phraser that asks the narration-tier model (agents.defaults.model.tiers.narration). Off the
 * turn's critical path: a message waits for it, the turn does not.
 */
export function modelPhraser(provider: ChatProvider): ProgressPhraser {
  return async (facts, _fixedText, language, signal) => {
    const response = await runWithCallAttribution(
      { callSite: "background", agentName: "progress_narrator" },
      () => provider.complete(phrasingMessages(facts, language), [], signal, {
        maxTokens: 120,
        controls: { enableThinking: false, reasoningEffort: "none" },
      }),
    );
    return acceptPhrasing(facts, response.content ?? "");
  };
}

// ── The reporter ─────────────────────────────────────────────────────────────────────────────

export interface TurnProgressReporterOptions {
  /** Keep and send one message; returns what was stored, for the audit row. */
  deliver: (message: { kind: TurnProgressKind; text: string }) => SessionProgressStored | void;
  /** The person's language ("German", "English", …). */
  language: string;
  /** Absent: every message keeps its fixed wording. */
  phrase?: ProgressPhraser;
  phrasingTimeoutMs: number;
  bridgeDelayMs: number;
  /** The turn's signal: a stopped or superseded turn posts nothing more. */
  signal?: AbortSignal;
  sessionId?: string;
}

interface SessionProgressStored { id: string }

export function createTurnProgressReporter(options: TurnProgressReporterOptions): TurnProgressReporter {
  let chain: Promise<void> = Promise.resolve();
  let closing = false;
  let closed = false;
  let bridgeTimer: ReturnType<typeof setTimeout> | undefined;
  let postedOtherThanBridge = false;
  let bridgeQueued = false;
  const phrasing = new Set<AbortController>();

  const produce = async (facts: TurnProgressFacts): Promise<void> => {
    if (options.signal?.aborted) return;
    const fixed = fixedProgressText(facts, options.language);
    let text = fixed;
    let worded: "model" | "fixed" = "fixed";
    let fallback: string | undefined;
    const startedAt = Date.now();
    if (options.phrase && !closing) {
      const controller = new AbortController();
      phrasing.add(controller);
      const timer = setTimeout(() => controller.abort(), options.phrasingTimeoutMs);
      const onTurnAbort = (): void => controller.abort();
      options.signal?.addEventListener("abort", onTurnAbort, { once: true });
      try {
        const out = await options.phrase(facts, fixed, options.language, controller.signal);
        if (out) {
          text = out;
          worded = "model";
        } else {
          fallback = "rejected";
        }
      } catch (err) {
        fallback = controller.signal.aborted ? (closing ? "turn_ended" : "timeout") : "error";
        if (fallback === "error") log.debug({ err }, "Progress phrasing failed; using the fixed wording");
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onTurnAbort);
        phrasing.delete(controller);
      }
    }
    if (options.signal?.aborted) return;
    const stored = options.deliver({ kind: facts.kind, text });
    logAudit("turn_progress_message", {
      kind: facts.kind,
      worded,
      ...(fallback ? { fallback } : {}),
      phrasingMs: worded === "model" || fallback ? Date.now() - startedAt : 0,
      chars: text.length,
      ...(stored ? { messageId: stored.id } : {}),
    }, { ...(options.sessionId ? { sessionId: options.sessionId } : {}), severity: "info" });
  };

  const report = (facts: TurnProgressFacts): void => {
    if (closed) return;
    if (facts.kind !== "bridge") {
      postedOtherThanBridge = true;
      if (bridgeTimer) { clearTimeout(bridgeTimer); bridgeTimer = undefined; }
    }
    chain = chain.then(() => produce(facts)).catch((err) => {
      log.warn({ err }, "Progress message not sent");
    });
  };

  return {
    report,
    scheduleBridge(facts) {
      if (closing || bridgeQueued || postedOtherThanBridge || bridgeTimer) return;
      bridgeTimer = setTimeout(() => {
        bridgeTimer = undefined;
        if (closing || postedOtherThanBridge || bridgeQueued) return;
        bridgeQueued = true;
        report(facts);
      }, options.bridgeDelayMs);
    },
    async close() {
      if (closed) return;
      closing = true;
      if (bridgeTimer) { clearTimeout(bridgeTimer); bridgeTimer = undefined; }
      for (const controller of phrasing) controller.abort();
      await chain;
      closed = true;
    },
  };
}
