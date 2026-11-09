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

export type TurnProgressKind = "bridge" | "plan" | "step" | "milestone" | "working";

export interface ProgressStep {
  id: string;
  description: string;
  agent?: string;
}

/** A specialist that came back from a delegation no plan step made (see the milestone kind). */
export interface ProgressFinish {
  agent: string;
  outcome: "done" | "failed";
  /** What it answered, for the model to take the gist from. */
  result?: string;
  files?: string[];
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
  }
  | {
    /**
     * Specialists that came back from delegations no plan step made: the orchestrator's own, or a
     * coordinator's. A turn without a plan has no steps to tell, and a coordinator records none,
     * so this is what such a turn can say about where it is. Reported one finish at a time; the
     * reporter holds them back until the turn has run a while and gathers those that come back
     * close together into one message, with who is still working (from the specialists' starts
     * and ends, which it is told of).
     */
    kind: "milestone";
    finished: ProgressFinish[];
    /** Filled by the reporter when it sends the message. */
    running?: string[];
  }
  | {
    /**
     * Still on it: posted by the reporter itself when specialists are working and nothing has been
     * said for a while (a single long delegation told the person nothing between its first line and
     * the answer: two minutes in the lab). Who is working, and their latest action.
     */
    kind: "working";
    working: Array<{ agent: string; doing?: string }>;
    elapsedSeconds: number;
  };

export interface TurnProgressReporter {
  report(facts: TurnProgressFacts): void;
  /** The bridge line, after the delay, unless the turn ended or posted something else first. */
  scheduleBridge(facts: Extract<TurnProgressFacts, { kind: "bridge" }>): void;
  /** A specialist started, acted or ended, at any depth: who is still working and what they do now. */
  noteSpecialist(event: { agentName: string; kind: string; toolName?: string }): void;
  /** Send what is still waiting, in its fixed wording, and stop. Milestones not yet sent are dropped: the answer comes next. */
  close(): Promise<void>;
}

/** Turns facts into a message: null keeps the fixed wording. */
export type ProgressPhraser = (
  facts: TurnProgressFacts,
  fixedText: string,
  language: string,
  signal: AbortSignal,
) => Promise<string | null>;

/**
 * What a specialist's latest tool does, in words, for "still on it". The model was handed the raw
 * tool name in the lab and wrote "der Tool web_fetch", and with two specialists gave one's action
 * to the other; a tool not here is not mentioned at all.
 */
const TOOL_ACTIONS: ReadonlyArray<readonly [RegExp, { de: string; en: string }]> = [
  [/^(?:web_fetch|web_table|fetch_image)$/, { de: "liest eine Webseite", en: "reading a web page" }],
  [/^(?:web_search|wikipedia_lookup|get_news_headlines|search_documents|rag_search|search_knowledge_base)$/, { de: "sucht nach Quellen", en: "searching for sources" }],
  [/^browser_/, { de: "arbeitet im Browser", en: "working in the browser" }],
  [/^(?:read_file|extract_file_content|spreadsheet_read|mail_read)$/, { de: "liest eine Datei", en: "reading a file" }],
  [/^(?:write_file|edit_file)$/, { de: "schreibt eine Datei", en: "writing a file" }],
  [/^(?:generate_docx)$/, { de: "schreibt ein Word-Dokument", en: "writing a Word document" }],
  [/^(?:generate_document|generate_pdf|render_pdf)$/, { de: "schreibt ein Dokument", en: "writing a document" }],
  [/^(?:generate_pptx|generate_presentation)$/, { de: "baut eine Präsentation", en: "building a presentation" }],
  [/^(?:generate_website)$/, { de: "baut eine Website", en: "building a website" }],
  [/^(?:generate_chart_html|generate_mermaid_diagram)$/, { de: "zeichnet ein Diagramm", en: "drawing a chart" }],
  [/^(?:generate_image|transform_image|generate_svg|comfyui_run)$/, { de: "erstellt ein Bild", en: "creating an image" }],
  [/^(?:comfyui_workflow)$/, { de: "baut einen ComfyUI-Workflow", en: "building a ComfyUI workflow" }],
  [/^(?:shell_exec|run_script|run_test_suite|ssh_exec)$/, { de: "führt Befehle aus", en: "running commands" }],
  [/^(?:verify_page|verify_app)$/, { de: "prüft das Ergebnis", en: "checking the result" }],
  [/^(?:delegate_to_agent|parallel_delegate|run_task_graph)$/, { de: "gibt Arbeit an Spezialisten", en: "handing work to specialists" }],
];

/** The words for what a tool does, or undefined for one without them. */
export function toolAction(toolName: string | undefined, language: string): string | undefined {
  if (!toolName) return undefined;
  const name = toolName.split(/__|\./).pop()?.toLowerCase() ?? "";
  const words = TOOL_ACTIONS.find(([pattern]) => pattern.test(name))?.[1];
  return words ? (isGerman(language) ? words.de : words.en) : undefined;
}

/**
 * An agent, workflow or tool as a message names it: words, not an identifier. An agent made on the
 * fly reached the chat as "ephemeral:http_semantics_rfc_finder"; it reads "http semantics rfc finder".
 */
export function agentLabel(name: string): string {
  return name.replace(/^ephemeral:/i, "").replace(/[_-]+/g, " ").trim() || name;
}

/** A plan step as a progress message names it: what it does, and who or what does it. */
export function progressStepOf(step: { id: string; description: string; agent?: string; workflow?: string; tool?: string }): ProgressStep {
  const by = step.agent ?? step.workflow ?? step.tool;
  return { id: step.id, description: step.description, ...(by ? { agent: by } : {}) };
}

/** The files a run's artifacts name, by their own name, each once. */
export function progressFileNames(artifacts: readonly unknown[] | undefined): string[] {
  const names = (artifacts ?? []).flatMap((artifact) => {
    if (!artifact || typeof artifact !== "object") return [];
    const record = artifact as Record<string, unknown>;
    const path = [record["relativePath"], record["path"], record["filename"]].find((value) => typeof value === "string" && value.trim());
    return typeof path === "string" ? [path.split(/[\\/]/).pop() ?? path] : [];
  });
  return [...new Set(names)];
}

/**
 * The milestone a delegation's result makes (see the milestone kind), or null when it makes none:
 * no specialist ran (refused before one was picked) or the result was served from what the turn
 * already had, which is no news.
 */
export function delegationMilestone(result: { success: boolean; output?: string; error?: string; metadata?: Record<string, unknown> }): Extract<TurnProgressFacts, { kind: "milestone" }> | null {
  const agent = result.metadata?.["agentName"];
  if (typeof agent !== "string" || !agent.trim()) return null;
  if (result.metadata?.["reusedFromSessionMemory"] === true || result.metadata?.["reused"] === true) return null;
  const artifacts = result.metadata?.["artifacts"];
  const files = progressFileNames(Array.isArray(artifacts) ? artifacts : undefined);
  const text = result.success ? result.output : result.error;
  return {
    kind: "milestone",
    finished: [{
      agent: agent.trim(),
      outcome: result.success ? "done" : "failed",
      ...(text?.trim() ? { result: text.trim() } : {}),
      ...(files.length ? { files } : {}),
    }],
  };
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
  return steps.map((step, index) => `${index + 1}. ${sentence(step.description)}${step.agent ? ` (${agentLabel(step.agent)})` : ""}`).join("\n");
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
  if (facts.kind === "milestone") {
    const told = facts.finished.map((finish) => finish.outcome === "done"
      ? `${agentLabel(finish.agent)} ${de ? "ist fertig" : "is done"}${finish.files?.length ? ` (${finish.files.join(", ")})` : ""}`
      : `${agentLabel(finish.agent)} ${de ? "kam nicht durch" : "did not get through"}`);
    const running = (facts.running ?? []).map(agentLabel);
    return `${told.join("; ")}.${running.length ? (de ? ` Gerade arbeiten noch: ${running.join(", ")}.` : ` Still working: ${running.join(", ")}.`) : ""}`;
  }
  if (facts.kind === "working") {
    const who = facts.working.map((entry) => {
      const doing = toolAction(entry.doing, language);
      if (de) return `${agentLabel(entry.agent)} ${doing ?? "arbeitet"}`;
      return `${agentLabel(entry.agent)} is ${doing ?? "working"}`;
    });
    return de ? `Ich bin noch dran: ${who.join("; ")}.` : `Still on it: ${who.join("; ")}.`;
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

const MAX_WORDED_CHARS: Record<TurnProgressKind, number> = { bridge: 160, plan: 200, step: 420, milestone: 420, working: 240 };
const RESULT_CHARS_FOR_MODEL = 600;

function factsText(facts: TurnProgressFacts): string {
  if (facts.kind === "bridge") {
    return `The person asked: ${facts.request.slice(0, 400)}\nYou are about to use: ${facts.reachingFor.join(", ") || "your tools"}`;
  }
  if (facts.kind === "plan") {
    return `${facts.revised ? "You just changed your plan. The new plan" : "You just made a plan. It"} has these steps:\n${planList(facts.steps)}`;
  }
  if (facts.kind === "milestone") {
    const share = Math.floor(RESULT_CHARS_FOR_MODEL / Math.max(1, facts.finished.length));
    const lines = facts.finished.map((finish) => [
      `${agentLabel(finish.agent)} ${finish.outcome === "done" ? "finished" : "failed"}.`,
      finish.result ? ` Its report, for its key result only: ${finish.result.slice(0, share)}` : "",
      finish.files?.length ? ` Files it produced: ${finish.files.join(", ")}` : "",
    ].join(""));
    const running = (facts.running ?? []).map(agentLabel);
    lines.push(running.length ? `Still working: ${running.join(", ")}` : "Nobody else is working on it any more: say no one is.");
    return lines.join("\n");
  }
  if (facts.kind === "working") {
    return [
      `The work has been going on for ${facts.elapsedSeconds} seconds and you have not told the person anything for a while.`,
      ...facts.working.map((entry) => {
        const doing = toolAction(entry.doing, "English");
        return `${agentLabel(entry.agent)} is still working${doing ? `; right now it is ${doing}` : ""}.`;
      }),
    ].join("\n");
  }
  const lines = [
    `Step ${facts.position} of ${facts.total} ${facts.outcome === "done" ? "finished" : "failed"}: ${sentence(facts.step.description)}`,
  ];
  if (facts.result) lines.push(`Its report, for a key result of THIS step only: ${facts.result.slice(0, RESULT_CHARS_FOR_MODEL)}`);
  if (facts.files?.length) lines.push(`Files it produced: ${facts.files.join(", ")}`);
  if (facts.reason) lines.push(`Why it failed: ${facts.reason}`);
  if (facts.running.length) lines.push(`Still running: ${stepNames(facts.running)}`);
  if (facts.next) lines.push(`Next: ${sentence(facts.next.description)}`);
  if (!facts.running.length && !facts.next) lines.push("That was the last step: what comes next is putting the answer together for the person.");
  return lines.join("\n");
}

const ASK: Record<TurnProgressKind, string> = {
  bridge: "Write ONE short sentence (at most 15 words) saying what you are checking first, like \"Let me check your calendar.\" Do not say what you will find.",
  plan: "Write ONE short sentence that introduces the plan; the steps are shown right after it as a numbered list, so do not repeat them.",
  // In the lab a coder's report on step 2 described step 1's file, and the message named that file as
  // step 2's; after the last step the model said it would "proceed to the next step".
  step: "Write one or two short sentences: that the step named above finished (call it what it is called there), its key result if "
    + "its report gives one for that step, and what happens now or next — after the last step, that you are putting the answer together.",
  milestone: "Write one or two short sentences: which specialist finished (by the name given) and its key result if its report gives "
    + "one, and who is still working (only those named as still working; if none, say no one else is). Do not say what comes after that.",
  working: "Write ONE short sentence that you are still on it and what is being done right now (say what the latest action does, "
    + "e.g. reading a web page, in plain words). Do not mention the seconds and do not claim any result.",
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
  // A plan's line is its first: the narration model wrote the list out again in 3 of 6 tries, and
  // below it the list is added from the plan itself.
  const own = facts.kind === "plan" ? output.trim().split(/\r?\n/)[0] ?? "" : output;
  let text = own.trim().replace(/^["'„“”«»]+|["'„“”«»]+$/gu, "").trim();
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
  /** How long a turn runs before a specialist's finish is told: a quick lookup tells none. Default 20 s. */
  milestoneAfterMs?: number;
  /** How long after the last message a milestone waits, gathering the finishes in between. Default 15 s. */
  milestoneGapMs?: number;
  /** How long without a message, while specialists work, before a "still on it". Default 60 s. */
  workingAfterMs?: number;
  /** The most "still on it" messages a turn posts. Default 5. */
  maxWorking?: number;
  /** Whether an agent coordinates others: it is not named as still working while one of its specialists is. */
  isCoordinator?: (agentName: string) => boolean;
  /** The turn's signal: a stopped or superseded turn posts nothing more. */
  signal?: AbortSignal;
  sessionId?: string;
}

interface SessionProgressStored { id: string }

const DEFAULT_MILESTONE_AFTER_MS = 20_000;
const DEFAULT_MILESTONE_GAP_MS = 15_000;
const DEFAULT_WORKING_AFTER_MS = 60_000;
const DEFAULT_MAX_WORKING = 5;

export function createTurnProgressReporter(options: TurnProgressReporterOptions): TurnProgressReporter {
  let chain: Promise<void> = Promise.resolve();
  let closing = false;
  let closed = false;
  let bridgeTimer: ReturnType<typeof setTimeout> | undefined;
  let postedOtherThanBridge = false;
  let bridgeQueued = false;
  const phrasing = new Set<AbortController>();
  const startedAt = Date.now();
  let lastPostedAt = 0;
  /** Specialists working now, by name: a count, as one may run twice at once. */
  const working = new Map<string, number>();
  const pendingFinishes: ProgressFinish[] = [];
  let milestoneTimer: ReturnType<typeof setTimeout> | undefined;
  const milestoneAfterMs = options.milestoneAfterMs ?? DEFAULT_MILESTONE_AFTER_MS;
  const milestoneGapMs = options.milestoneGapMs ?? DEFAULT_MILESTONE_GAP_MS;
  const workingAfterMs = options.workingAfterMs ?? DEFAULT_WORKING_AFTER_MS;
  const maxWorking = options.maxWorking ?? DEFAULT_MAX_WORKING;
  const isCoordinator = options.isCoordinator ?? (() => false);
  /** Each working specialist's latest tool. */
  const latestAction = new Map<string, string>();
  let workingTimer: ReturnType<typeof setTimeout> | undefined;
  let workingSent = 0;

  /** Who is working, coordinators only when nobody else is: they are the ones handing out the work. */
  const workingNow = (): string[] => {
    const all = [...working.keys()];
    const doers = all.filter((agent) => !isCoordinator(agent));
    return doers.length > 0 ? doers : all;
  };

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
    lastPostedAt = Date.now();
    logAudit("turn_progress_message", {
      kind: facts.kind,
      worded,
      ...(fallback ? { fallback } : {}),
      phrasingMs: worded === "model" || fallback ? Date.now() - startedAt : 0,
      chars: text.length,
      ...(stored ? { messageId: stored.id } : {}),
    }, { ...(options.sessionId ? { sessionId: options.sessionId } : {}), severity: "info" });
  };

  const enqueue = (facts: TurnProgressFacts): void => {
    chain = chain.then(() => produce(facts)).catch((err) => {
      log.warn({ err }, "Progress message not sent");
    });
  };

  /** The finishes gathered so far, as one message, with who is still working. */
  const flushMilestone = (): void => {
    milestoneTimer = undefined;
    if (closing || pendingFinishes.length === 0) return;
    // A specialist says it ended before its result comes back, so the finished are gone from
    // `working` already; one still there is a second run of the same specialist.
    enqueue({ kind: "milestone", finished: pendingFinishes.splice(0), running: [...working.keys()].filter((agent) => !isCoordinator(agent)) });
  };

  /** "Still on it" once nothing has been said for workingAfterMs while someone works; then again, up to maxWorking. */
  const armWorking = (): void => {
    if (workingTimer || closing || workingSent >= maxWorking) return;
    const due = Math.max(startedAt, lastPostedAt) + workingAfterMs;
    workingTimer = setTimeout(onWorkingDue, Math.max(0, due - Date.now()));
  };

  const onWorkingDue = (): void => {
    workingTimer = undefined;
    // Nobody working: the next start arms it again.
    if (closing || working.size === 0) return;
    if (Date.now() - Math.max(startedAt, lastPostedAt) >= workingAfterMs) {
      workingSent += 1;
      enqueue({
        kind: "working",
        working: workingNow().map((agent) => {
          const doing = latestAction.get(agent);
          return { agent, ...(doing ? { doing } : {}) };
        }),
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
      });
      // Counted as said now, not when its wording comes back, so it is not posted twice meanwhile.
      lastPostedAt = Math.max(lastPostedAt, Date.now());
    }
    armWorking();
  };

  const scheduleMilestone = (): void => {
    if (milestoneTimer) return;
    const now = Date.now();
    const at = Math.max(now, startedAt + milestoneAfterMs, lastPostedAt ? lastPostedAt + milestoneGapMs : 0);
    milestoneTimer = setTimeout(flushMilestone, at - now);
  };

  const report = (facts: TurnProgressFacts): void => {
    if (closed) return;
    if (facts.kind === "milestone") {
      if (closing) return;
      pendingFinishes.push(...facts.finished);
      scheduleMilestone();
      return;
    }
    if (facts.kind !== "bridge") {
      postedOtherThanBridge = true;
      if (bridgeTimer) { clearTimeout(bridgeTimer); bridgeTimer = undefined; }
    }
    enqueue(facts);
  };

  return {
    report,
    noteSpecialist(event) {
      if (event.kind === "started") {
        working.set(event.agentName, (working.get(event.agentName) ?? 0) + 1);
        armWorking();
      } else if (event.kind === "tool_start" && event.toolName) {
        latestAction.set(event.agentName, event.toolName);
      } else if (event.kind === "completed") {
        const left = (working.get(event.agentName) ?? 0) - 1;
        if (left > 0) working.set(event.agentName, left);
        else {
          working.delete(event.agentName);
          latestAction.delete(event.agentName);
        }
      }
    },
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
      // A finish not told yet is not told now: the answer that comes next says it.
      if (milestoneTimer) { clearTimeout(milestoneTimer); milestoneTimer = undefined; }
      if (workingTimer) { clearTimeout(workingTimer); workingTimer = undefined; }
      for (const controller of phrasing) controller.abort();
      await chain;
      closed = true;
    },
  };
}
