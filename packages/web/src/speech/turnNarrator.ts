/**
 * When a running turn speaks up, and what about. A turn that answers within a few seconds says
 * nothing until its answer; a longer one names each new kind of work it reaches — at most one line
 * every twenty seconds — and, when it has had nothing new to say for a while, that it is still at
 * it. A question or an approval it waits on is announced at once.
 *
 * Driven by snapshots of the turn's steps and a clock, so it decides without timers of its own.
 */

import type { Milestone } from "./speechPhrases";

/** The minimum of a turn step this needs (composables/turnSteps.ts TurnStep). */
export interface NarratedStep {
  id: string;
  kind: "tool" | "note";
  /** Tool name for a tool step; the runtime phase for a note. */
  name: string;
}

// Ordered: the first match wins, so the audits that run in a browser count as checking.
const TOOL_MILESTONES: ReadonlyArray<readonly [RegExp, Milestone]> = [
  [/^(?:delegate_to_agent|delegate_to_remote_agent|swarm_delegate|parallel_delegate|create_ephemeral_agent|run_task_graph|run_workflow)$/, "delegating"],
  [/^(?:execute_plan|record_plan)$/, "planning"],
  [/^(?:verify_page|verify_app|swarm_validate|lighthouse_audit|browser_axe_audit|run_test_suite)$/, "checking"],
  [/^(?:web_search|wikipedia_lookup|get_news_headlines|read_rss_feed|rag_search|search_documents|search_knowledge_base|workspace_search|federated_workspace_search|memory_search|mail_search|contacts_search|calendar_list_events|get_weather|get_fx_rate|get_crypto_price|grep_files|glob_files)$/, "searching"],
  [/^(?:web_fetch|web_table|fetch_image|read_file|extract_file_content|spreadsheet_read|mail_read|research_notes_read|analyze_image|transcribe_audio|transcribe_video|extract_[a-z_]+)$/, "reading"],
  [/^(?:browser|computer)_[a-z_]+$/, "browsing"],
  [/^(?:shell_exec|run_script|ssh_exec|host_shell|http_request|sql_query|terraform_exec|vm_manage|proxmox_vm|(?:ansible|kubectl|helm|git)_[a-z_]+)$/, "running"],
  [/^(?:write_file|edit_file|generate_document|generate_docx|generate_pptx|generate_pdf|render_pdf|generate_website|generate_presentation|spreadsheet_write|pdf_fill|generate_ics|bundle_artifact_zip)$/, "writing"],
  [/^(?:generate_image|transform_image|generate_svg|generate_chart_html|generate_mermaid_diagram|generate_qr_code|synthesize_speech)$/, "creating"],
];

const NOTE_MILESTONES: Readonly<Record<string, Milestone>> = {
  delegating: "delegating",
  reviewing: "checking",
  oversight: "checking",
  synthesizing: "composing",
};

/** The kind of work a step is, or undefined for one that is not worth a word (routing, bookkeeping). */
export function milestoneOf(step: NarratedStep): Milestone | undefined {
  if (step.kind === "note") return NOTE_MILESTONES[step.name];
  // An MCP tool can carry its server's prefix ("server__browser_click", "server.web_search").
  const name = step.name.split(/__|\./).pop()?.toLowerCase() ?? "";
  return TOOL_MILESTONES.find(([pattern]) => pattern.test(name))?.[1];
}

export type NarratorCue =
  | { kind: "milestone"; milestone: Milestone }
  | { kind: "stillWorking"; long: boolean }
  | { kind: "needsInput"; approval: boolean };

export interface NarratorOptions {
  /** Nothing is said before this — a quick turn goes straight to its answer. */
  firstAfterMs: number;
  /** Two lines are at least this far apart. */
  minGapMs: number;
  /** After this much silence, a reminder that the turn is still working; later ones wait twice as long. */
  stillWorkingAfterMs: number;
  /** A turn running this long says so in its reminder. */
  longAfterMs: number;
  maxReminders: number;
  /** A kind of work noticed this long ago and not announced yet is no longer news. */
  staleAfterMs: number;
}

export const DEFAULT_NARRATOR_OPTIONS: NarratorOptions = {
  firstAfterMs: 6_000,
  minGapMs: 20_000,
  stillWorkingAfterMs: 30_000,
  longAfterMs: 120_000,
  maxReminders: 4,
  staleAfterMs: 20_000,
};

export interface NarratorSnapshot {
  now: number;
  steps: readonly NarratedStep[];
  /** What the turn waits on the user for, keyed so each question is announced once. */
  waitingFor?: { key: string; approval: boolean } | null;
}

export class TurnNarrator {
  private readonly options: NarratorOptions;
  private readonly startedAt: number;
  private lastSpokenAt: number | null = null;
  private readonly announced = new Set<Milestone>();
  private readonly seenSteps = new Set<string>();
  private pending: { milestone: Milestone; at: number } | null = null;
  private reminders = 0;
  private waitingKey: string | null = null;

  constructor(startedAt: number, options: Partial<NarratorOptions> = {}) {
    this.startedAt = startedAt;
    this.options = { ...DEFAULT_NARRATOR_OPTIONS, ...options };
  }

  /** The line to say now, if any. */
  observe(snapshot: NarratorSnapshot): NarratorCue | null {
    const { now } = snapshot;
    if (snapshot.waitingFor) {
      if (snapshot.waitingFor.key === this.waitingKey) return null;
      this.waitingKey = snapshot.waitingFor.key;
      this.lastSpokenAt = now;
      return { kind: "needsInput", approval: snapshot.waitingFor.approval };
    }
    if (this.waitingKey !== null) {
      // Answered: the silence is counted from here, not from the call.
      this.waitingKey = null;
      this.lastSpokenAt = now;
    }

    for (const step of snapshot.steps) {
      if (this.seenSteps.has(step.id)) continue;
      this.seenSteps.add(step.id);
      const milestone = milestoneOf(step);
      if (milestone && !this.announced.has(milestone)) this.pending = { milestone, at: now };
    }
    if (this.pending && now - this.pending.at > this.options.staleAfterMs) this.pending = null;
    if (now - this.startedAt < this.options.firstAfterMs) return null;

    const sinceSpoken = this.lastSpokenAt === null ? Number.POSITIVE_INFINITY : now - this.lastSpokenAt;
    if (this.pending && sinceSpoken >= this.options.minGapMs) {
      const { milestone } = this.pending;
      this.pending = null;
      this.announced.add(milestone);
      this.lastSpokenAt = now;
      return { kind: "milestone", milestone };
    }

    const silence = now - (this.lastSpokenAt ?? this.startedAt);
    const reminderAfter = this.options.stillWorkingAfterMs * (this.reminders === 0 ? 1 : 2);
    if (silence >= reminderAfter && this.reminders < this.options.maxReminders) {
      this.reminders += 1;
      this.lastSpokenAt = now;
      return { kind: "stillWorking", long: now - this.startedAt >= this.options.longAfterMs };
    }
    return null;
  }
}
