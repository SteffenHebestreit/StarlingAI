/**
 * Pure delegation-result & artifact-fulfillment CLASSIFIERS, extracted from the
 * tools/sub-agent.ts delegation god-file. Structural, side-effect-free predicates over a
 * delegated result's TEXT, the run's tool STATS, and the target agent's tool CONFIG — no
 * ToolContext, no getConfig, no I/O. They answer: did this delegation only NARRATE a plan,
 * miss a workspace mutation, miss producing the artifact it was asked for, or is the target
 * even capable of producing it? The ctx-bound wrappers (agentCanFulfillArtifactTask,
 * routeAgentCandidates, executeDelegationWithFallback) stay in sub-agent.ts and import these.
 */
import { isCanonicalResearchSliceTask } from "../agent/source-sensitive-delegation.js";
import { looksLikeContainerLevelFailure, looksLikeModelTemplateArtifact } from "../agent/container-failure.js";

// ── Concrete evidence in a result's OWN text (2026-10-05) ──────────────────────────────────
// Units of measure and currencies: symbols, not words of any language. Durations are left out
// on purpose — "timed out after 30 s" / "after 240000ms" is how a FAILURE reports itself.
const EVIDENCE_FIGURE_RE = /(?<![\p{L}\d.,])\d+(?:[.,]\d+)?\s?(?:%|‰|°\s?[CF]?|[kKMGTµunm]?(?:Hz|B|bit|bps|V|A|W|Wh|Ah|mAh|Ω|ohm|F|g|m|dB|dBA|dBm|px|fps|rpm|lm|lx|Pa|bar|J|l|L)|mm|cm|km|kg|mg|€|\$|£|EUR|USD|CHF|GBP)(?![\p{L}\d])|[$€£]\s?\d/gu;
const EVIDENCE_SOURCE_RE = /\bhttps?:\/\/[^\s)>\]]+|(?<![\w@.-])(?:[a-z0-9-]+\.)+(?:com|org|net|io|de|eu|gov|edu|dev|ai|co\.uk|ch|at)\b(?![\w-]*\.\w)/i;
const EVIDENCE_SCAN_CHARS = 8_000;
const EVIDENCE_MIN_FIGURES = 2;

/**
 * True when a delegated result's own text carries concrete evidence: measured figures (a number
 * with a unit, a percentage, a price) — two of them, or one backed by a cited source (a URL or a
 * bare domain). Structural and language-independent. A source alone is NOT evidence: a failure
 * report names the URL it could not reach, and a planning stub names the URL it will fetch next.
 * Figures the TASK already contained are not evidence either — "No results found for the 2 A /
 * 5 V charger query" echoes the question (adversarial review 2026-10-05) — so pass `task`.
 * Evidence lets a result survive a failure PHRASE ("the first attempt failed to reach the vendor
 * site, so I used the cached datasheet: 12 mA at 3.3 V"); it never outranks the planning verdict
 * or a run whose every work call failed (see classifyDelegationResult).
 */
export function carriesConcreteEvidence(text: string, task = ""): boolean {
  const scan = (text ?? "").slice(0, EVIDENCE_SCAN_CHARS);
  if (!scan.trim()) return false;
  const normalizeFigure = (figure: string): string => figure.replace(/\s+/g, "").toLowerCase();
  const echoed = new Set((task.match(EVIDENCE_FIGURE_RE) ?? []).map(normalizeFigure));
  const figures = (scan.match(EVIDENCE_FIGURE_RE) ?? []).filter((figure) => !echoed.has(normalizeFigure(figure))).length;
  return figures >= EVIDENCE_MIN_FIGURES || (figures >= 1 && EVIDENCE_SOURCE_RE.test(scan));
}

export function looksLikePlanningOnlyResult(result: string): boolean {
  const preview = result.slice(0, 600).trim();
  if (!preview) return false;

  // Openers that signal "the model started narrating intent". Both English
  // and German because qwen mirrors the user's language; session 6b3f2123
  // showed an entire 3 KB planning loop in German ("Ich werde…", "Lass mich
  // einen anderen Ansatz wählen", "Stattdessen…", "Letztendlich…") that the
  // English-only regex missed entirely.
  // 2026-10-05: discourse openers that announce no INTENT were dropped — "Aufgrund …",
  // "Allerdings …", "Da …" open conclusions just as often ("Aufgrund der Datenblätter
  // empfehle ich den ESP32-S3 …" was discarded as a planning loop). A fronted clause that
  // DOES announce intent is still caught structurally: the first sentence inverts the future
  // auxiliary ("Da es sich um eine große Datei handelt, werde ich sie aufteilen").
  const startsLikePlanning = /^\s*(let me|now let me|first let me|now i can|now i (?:have|understand)\b[\s\S]{0,160}\blet me|i (?:now )?(?:have|understand)\b[\s\S]{0,160}\blet me|i(?:'m| am) going to|i(?:'ll| will)|i(?:'m| am) trying to|i need to|next,? i(?:'m| am) going to|ich werde|ich erstelle|ich nutze|ich verwende|ich entscheide|ich w(?:ä|ae)hle|ich versuche|ich muss|lass mich|stattdessen|letztendlich|der (?:beste|pragmatischste|einfachste) ansatz)\b/i.test(preview)
    || /^[^.!?\n]{0,200}?\b(?:werde ich|werden wir)\b/i.test(preview);
  if (!startsLikePlanning) return false;

  // English keywords stay strictly bounded so we don't false-match across
  // unrelated words. German verb stems are matched as a stem-prefix (no
  // trailing \b) because conjugated forms like "erstellen" / "erstelle" /
  // "verwende" all need to match the same `erstell` / `verwend` stem.
  const planningAction = /\b(try|attempt|start|check|verify|fetch|get|gather|collect|retrieve|research|search|look for|look up|read|download|continue|proceed|focus|click|type|open|inspect|retry|use|switch|launch|list|attach|create|update|modify|edit|write|patch|save)\b|\b(erstell|schreib|verwend|nutz|aufteil|zusammenf(?:ü|ue)hr|umgeh|brauch|w(?:ä|ae)hl|entscheid)\w*/i.test(preview);
  if (!planningAction) return false;

  const terminalMarker = /\b(completed|done|finished|succeeded|successfully|typed|opened|clicked|verified|updated|modified|edited|wrote|written|saved|patched|failed|error|could not|did not)\b|\b(abgeschlossen|fertig|erfolgreich|geschrieben|gespeichert|fehlgeschlagen|nicht m(?:ö|oe)glich)/i.test(preview);
  // No length gate. The earlier `preview.length <= 220 || unresolvedMarker`
  // condition was meant to avoid flagging short legitimate narration, but
  // by accepting only short results it missed long planning loops — the
  // exact failure mode we want to catch. If the final assistant message
  // opens with planning narrative AND no terminal marker is present, the
  // agent narrated instead of executing regardless of how verbose it got.
  // Figures in the narration do not rescue it: "I'll compare the ESP32-S3 (240 MHz, 512 KB
  // SRAM) with the RP2040 (133 MHz). Let me search for their datasheets next." is still a plan
  // (adversarial review 2026-10-05 — an evidence veto here let such stubs through as success).
  return !terminalMarker;
}

// ── What a delegation was asked to hand back (2026-10-09) ─────────────────────────────────
/**
 * What a delegation was DECLARED to hand back by the call that dispatched it: the `deliverable`
 * argument of delegate_to_agent, swarm_delegate, a parallel_delegate task, a run_task_graph node,
 * a record_plan step or create_ephemeral_agent — or the runtime, for a delegation it dispatches
 * itself (the corrective build). "file": the task is to create or change a file in the workspace.
 * "answer": the reply is the result. Undeclared reads as "answer" for every verdict on a run.
 *
 * WHY A DECLARATION. Whether a run that wrote nothing MISSED its deliverable used to be read off
 * the task text with WORKSPACE_MUTATION_TASK_RE, a table of ~50 English and German verbs. In E2E
 * session 7c4cbb28 (2026-10-09) the user pasted two Python files and asked for a diagnosis; the
 * orchestrator delegated "Statische Code-Analyse (kein Ausführen, kein Ändern): Identifiziere …"
 * to code_analyst, which answered in prose with no tool call, as it should. The table found a verb
 * anyway: it reads neither a negation ("do not change anything" counts) nor whose words a verb is
 * (the pasted docstring's "add 20% tax" counts). code_analyst holds write_file, so the delegation
 * failed as "narrative-only", every candidate failed and the user got an error.
 *
 * The other signals the runtime holds were measured, and none carries it. The turn's deliverable
 * intent (agent/deliverable-intent.ts) is a verb+noun table over the USER's message, for the
 * whole turn: a diagnosis request whose pasted code writes a report (`f.write` to report.txt)
 * reads as "wants a file", 2d810e7d's "erzeuge mir eine vollumfängliche Lernwebsite" does not,
 * and a turn that does want a file cannot tell its research step from its build step. The
 * staged-build classification measures size, not a request. A file named in the task is as often
 * the input as the output. The delegator, which read the request in whatever language it came,
 * is the one that knows; it says so here.
 */
export type DelegationDeliverable = "file" | "answer";

/** A declared deliverable from loosely typed tool arguments; anything but "file"/"answer" is undeclared. */
export function readDelegationDeliverable(value: unknown): DelegationDeliverable | undefined {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  return normalized === "file" || normalized === "answer" ? normalized : undefined;
}

/** The `deliverable` parameter, one definition for every tool that dispatches a delegation. */
export function deliverableParameterSchema(): Record<string, unknown> {
  return {
    type: "string",
    enum: ["file", "answer"],
    description: "\"file\" if the task must create or change a workspace file (a run that writes none fails); \"answer\" if the reply is the result (an analysis, a diagnosis, findings).",
  };
}

/**
 * The verb test the pre-run gates steer work by — the routing filter, the render exemption from the
 * research redirect, the cached-evidence guard and the inline-document harvest — and the routing
 * reorder for requested file formats (agent-routing.ts requestedOutputFormats). It reads verbs
 * only: a negated one ("do not change anything") and one in pasted material ("add 20% tax" in a
 * docstring) count, and a German verb with a leading umlaut ("Ändere") never matches, because \b
 * is ASCII. No verdict on a run reads it: that is the declaration's (DelegationDeliverable).
 */
export const WORKSPACE_MUTATION_TASK_RE = /\b(?:update|modify|edit|write|patch|save|create|add|change|set|switch|configure|implement|apply|fix|adjust|build|generate|produce|draft|compose|anpass(?:en|ung|ungen)?|angepasst|pass(?:e|en|t)\b[\s\S]{0,80}\ban|aendere|ändere|ändern|aktualisier(?:e|en|ung)?|bearbeit(?:e|en)|schreib(?:e|en)?|erstell(?:e|en)?|erzeug(?:e|en|ung)?|generier(?:e|en)?|bau(?:e|en)?|hinzuf(?:ue|ü)gen|setz(?:e|en)?|konfigurier(?:e|en)|umstell(?:e|en))\b/i;
export const WORKSPACE_MUTATION_TOOL_NAMES = new Set(["write_file", "edit_file", "create_dir", "delete_file", "shell_exec"]);
export const READ_ONLY_CONTEXT_TOOL_NAMES = new Set([
  "read_file", "list_files", "workspace_search", "read_shared_facts", "search_agents", "agent_catalog", "git_status", "git_diff",
]);

export function hasWorkspaceMutationTool(stats: { toolNames: string[] } | undefined): boolean {
  return (stats?.toolNames ?? []).some((toolName) => WORKSPACE_MUTATION_TOOL_NAMES.has(toolName));
}

export function usedOnlyReadOnlyContextTools(stats: { toolCount: number; toolNames: string[] } | undefined): boolean {
  const toolNames = stats?.toolNames ?? [];
  return (stats?.toolCount ?? 0) > 0
    && toolNames.length > 0
    && toolNames.every((toolName) => READ_ONLY_CONTEXT_TOOL_NAMES.has(toolName));
}

export function looksLikeRawWorkspaceConfigDump(result: string): boolean {
  const text = result.trim();
  if (!text) return false;
  const compact = text.replace(/\s+/g, " ").slice(0, 12_000);
  if (/\.starlingai\/\s+agent_outcomes\.ndjson\s+README\.md\s+agents\/\s+10-core-agents\.jsonc\s+2\d-[a-z-]+\.jsonc/i.test(compact)) {
    return true;
  }
  if (/[{]\s*"(?:agents|subAgents)"\s*:\s*[{]/i.test(compact)
    && /"systemPrompt"\s*:/i.test(compact)
    && /"primary"\s*:\s*"lmstudio\//i.test(compact)) {
    return true;
  }
  return /####\s+Tool Calls/i.test(text)
    && /\b(?:read_file|list_files|search_agents|agent_catalog)\b/i.test(text)
    && /\b(?:agents\/|10-core-agents\.jsonc|2\d-[a-z-]+\.jsonc|"subAgents"|"agents")\b/i.test(text);
}

/**
 * A delegation declared to change a file that only read context or dumped the configuration it
 * read. Decided by the declaration (DelegationDeliverable), not by the task's words: this used to
 * fire on a mutation verb plus a workspace word ("agent", "config", "tool", "model", …) or a
 * maintenance agent's tags, so "review the agent config, do not change anything" answered from
 * read_file alone was a failure.
 */
export function looksLikeReadOnlyMutationMiss(
  output: string,
  stats: { toolCount: number; toolNames: string[] } | undefined,
  deliverable: DelegationDeliverable | undefined,
): boolean {
  if (deliverable !== "file") return false;
  if (hasWorkspaceMutationTool(stats)) return false;
  return usedOnlyReadOnlyContextTools(stats) || looksLikeRawWorkspaceConfigDump(output);
}

// Tools that directly produce a user-visible deliverable. If the agent had
// any of these AND the task asked for one AND the agent called none of them,
// the agent narrated intent instead of executing — regardless of how the
// output is phrased. This catches the failure mode where the model says
// "Let me build this as a complete single-file HTML application" or "Die
// Website wurde erstellt" but never actually called write_file.
export const ARTIFACT_PRODUCING_TOOLS = new Set([
  "write_file", "edit_file", "create_dir",
  "generate_document", "generate_website", "generate_presentation", "generate_docx", "generate_pptx", "generate_pdf",
  "render_pdf",
  "bundle_artifact_zip", "export_workspace_artifact",
  // fetch_image downloads + SAVES a real local image file — that saved asset is the
  // deliverable, which cached research facts can never satisfy. Without this, an
  // image-sourcing delegation gets short-circuited by findReusableSessionEvidence and
  // never actually runs (audit cdd731d6: image_sourcer "reusedFromSessionMemory", 0 images).
  "fetch_image",
  "shell_exec",
  // EVERY generator that writes a file into the workspace has to be here, not just the
  // document-shaped ones.
  //
  // `generate_image` was missing, and the consequence was not subtle. image_creator
  // generated a sunset, saved a 1.5 MB PNG and recorded the artifact — and because
  // `generate_image` was not in this set, looksLikeArtifactDeliverableMiss saw an agent that
  // held artifact tools, was asked for a deliverable, and (as far as this set could tell)
  // called none of them. classifyDelegationResult therefore returned "failure" for a
  // delegation that had entirely succeeded. Only the best-partial fallback rescued it, so
  // every image turn came back flagged `partialFallback`, tripped the evidence backstop, and
  // told the orchestrator its specialist had failed at something it had just done.
  //
  // The gap was general: ten workspace-writing tools were absent. Audio, charts, diagrams,
  // spreadsheets, pentest reports and PDF form-filling were all misclassified the same way.
  // The list is now derived from the question this set actually asks — "does calling this
  // tool put a deliverable on disk?" — rather than from which generators happened to exist
  // when it was written.
  "generate_image", "transform_image", "generate_svg", "generate_qr_code",
  "synthesize_speech",
  "generate_chart_html", "generate_mermaid_diagram",
  "spreadsheet_write", "pdf_fill", "pentest_report", "export_evidence_ledger",
]);

// Coordinators can also "produce" by delegating the work. If they called
// none of these AND none of ARTIFACT_PRODUCING_TOOLS, they truly did
// nothing useful.
export const PRODUCTIVE_COORDINATOR_TOOLS = new Set([
  "delegate_to_agent", "parallel_delegate", "run_task_graph",
  "run_workflow", "create_ephemeral_agent", "swarm_delegate",
]);

/**
 * The run was declared to produce a file (`deliverable: "file"`), held a tool that writes one,
 * and called none — nor, for an agent that can delegate, handed the work on. Without that
 * declaration a run that answers in prose has not missed anything, whatever tools it holds:
 * nearly every specialist holds write_file and edit_file to keep notes, and code_analyst's prose
 * diagnosis of pasted code is the deliverable (E2E 7c4cbb28; see DelegationDeliverable).
 */
export function looksLikeArtifactDeliverableMiss(
  task: string,
  stats: { toolCount: number; toolNames: string[] } | undefined,
  agentCfg: import("../config/schema.js").SubAgentConfig | undefined,
  deliverable: DelegationDeliverable | undefined,
): boolean {
  if (deliverable !== "file") return false;
  if (!agentCfg) return false;
  // We can only fire this check when stats are present — without them we
  // don't know which tools the agent actually called, and treating absent
  // stats as "called nothing" would false-positive on every legacy test
  // path that mocks runSubAgent without runSubAgentWithStats.
  if (!stats) return false;
  // A runtime-authored research slice embeds the user's ORIGINAL request
  // (which may say "bauen"/"build a device"), but the slice's own deliverable
  // is prose evidence by construction. Judging the researcher against the
  // embedded build verb branded a successful 8.8KB sourced report a failure
  // because it never called write_file (audit b5107ae4) — which then cascaded
  // into an architect-built ephemeral that re-researched ONE component and
  // shipped that as the whole answer. The slice keeps its exemption even when
  // the delegation it was cut from declared a file: the research-first rewrite
  // replaces the build with a gather, and a gather's deliverable is evidence.
  if (isCanonicalResearchSliceTask(task)) return false;
  // NOTE: do NOT skip on `toolCount === 0 && toolNames.length === 0`. The
  // earlier "treat empty stats as a mock signal" shortcut let real
  // production failures through: session 25f55376 (2026-05-28) had
  // mission_coordinator generate 4096 tokens of "I'll write it in one go"
  // narrative with literally zero tool calls and get marked as success.
  // On a delegation declared to produce a file that is the strongest
  // narrative-only signal we have; we must catch it.

  const availableArtifactTools = (agentCfg.tools ?? []).filter((t) => ARTIFACT_PRODUCING_TOOLS.has(t));
  if (availableArtifactTools.length === 0) return false;

  const calledTools = new Set(stats.toolNames ?? []);
  const calledArtifact = [...calledTools].some((t) => ARTIFACT_PRODUCING_TOOLS.has(t));
  if (calledArtifact) return false;

  // If the agent could delegate (coordinator-shaped) and actually did,
  // that's a legitimate alternative path — the work might still happen
  // downstream. Don't flag it here.
  const couldDelegate = (agentCfg.tools ?? []).some((t) => PRODUCTIVE_COORDINATOR_TOOLS.has(t));
  if (couldDelegate) {
    const delegated = [...calledTools].some((t) => PRODUCTIVE_COORDINATOR_TOOLS.has(t));
    if (delegated) return false;
  }

  return true;
}

// Routing-time gate. If the task asks for a deliverable (write/create/edit/
// erstelle/...) the candidate agent must be able to either produce one
// directly (artifact tool) or fan out via a productive coordinator tool.
// Without this gate, swarm routing was sending CPSA-F "erzeuge mir eine
// Lernwebsite" to `quality_supervisor` (session 2d810e7d, 2026-05-28) — a
// read/audit-only agent that has no write_file/edit_file/shell_exec — and
// the agent narrated a review of nothing while burning the delegation
// budget.
export function agentCfgCanFulfillArtifactTask(
  task: string,
  cfg: { tools?: string[] } | undefined,
): boolean {
  if (!WORKSPACE_MUTATION_TASK_RE.test(task.trim())) return true;
  if (!cfg) return true; // unknown agent — let the downstream attempt fail loudly rather than silently filtering
  const tools = cfg.tools ?? [];
  return tools.some((t) => ARTIFACT_PRODUCING_TOOLS.has(t))
    || tools.some((t) => PRODUCTIVE_COORDINATOR_TOOLS.has(t));
}

/**
 * Failure shapes that are not prose: no output at all, the runtime's empty-answer placeholder,
 * a container that never ran, a reply made only of model template tokens. These hold whatever
 * verdict the run minted for itself.
 */
export function looksLikeStructuralFailureResult(result: string): boolean {
  if (!result.trim()) return true;
  const preview = result.slice(0, 600);
  if (/^sub-agent produced no final response\.?$/i.test(preview.trim())) {
    return true;
  }
  if (looksLikeContainerLevelFailure(preview)) {
    return true;
  }
  // Detect when the sub-agent emitted only LLM template special tokens
  // (e.g. `<|mask_end|>`, `<|im_end|>`).  Apply to the FULL result, not
  // the preview, so that a 12-char template-only output is caught even
  // when the preview happens to be padded.
  return looksLikeModelTemplateArtifact(result);
}

export function looksLikeFailureResult(result: string): boolean {
  return looksLikeStructuralFailureResult(result) || looksLikeProseFailureResult(result);
}

/**
 * The PROSE failure sniff: failure vocabulary, refusals, missing-tool talk, planning-only
 * narration. A weak signal — "The HTTP 404 not found response means …" is an answer, not a
 * failure — so classifyDelegationResult consults it only when the run left no structural verdict
 * (no explicit `<final_answer status>`, no artifacts, no concrete evidence; see there).
 */
export function looksLikeProseFailureResult(result: string): boolean {
  if (!result.trim()) return false;
  const preview = result.slice(0, 600);
  if (/\b(no results|not found|unable to|failed to|error:|timed out|cancelled|incomplete|max.{0,20}iterations|sub_agent_max_iterations|could not complete|did not complete|exited with code|exit code)\b/i.test(preview)) {
    return true;
  }
  // A result that OPENS with "Error:" reports a failure. The list above never matched it: its
  // trailing \b needs a word character after the colon (adversarial review 2026-10-05).
  if (/^\s*error:/i.test(preview)) {
    return true;
  }

  if (/\bis already running via\s+(?:[a-z0-9_:-]*(?:_agent|_coordinator)|researcher|another agent)\b/i.test(preview)) {
    return true;
  }

  if (/\bNo (?:agents|workflows) matched\b/i.test(preview)) {
    return true;
  }

  if (/\b(i can(?:not|'t) access|i do not have access|i can(?:not|'t) retrieve|cannot retrieve the latest|cannot access real[- ]time|knowledge cutoff|my knowledge is based on the data i was trained on)\b/i.test(preview)) {
    return true;
  }

  if (/\b(need to start a session|no computer_session_start|not available in my tool list|available tools are only|missing tool|cannot complete because .*tool)\b/i.test(preview)) {
    return true;
  }

  // The full result, not the preview (the planning check reads its own 600-char window).
  return looksLikePlanningOnlyResult(result);
}

/** What a sub-agent run left behind that is not prose, and what its dispatch declared — the
 *  inputs to a structural verdict. */
export interface DelegationRunSignals {
  /** The run closed with its own `<final_answer status="…">…</final_answer>` (parseFinalAnswerTag). */
  readonly explicitVerdict?: boolean;
  /** What the delegation was declared to hand back (DelegationDeliverable). Only "file" lets a run
   *  that wrote nothing be judged a missed deliverable. */
  readonly deliverable?: DelegationDeliverable;
  /** Tool names of THIS run's calls that ran and failed — one entry per failed call; a nested
   *  specialist's failures and the person's declines excluded. Preferred over the count. */
  readonly failedToolNames?: readonly string[];
  /** The same as a count, for callers without the names. */
  readonly toolFailureCount?: number;
}

// The run's own bookkeeping — sharing a finding, reading the shared facts, the memory and note
// tools, the plan record. A failed bookkeeping call is not failed WORK: "a summary after three
// failed share_finding calls" is still the summary (adversarial review 2026-10-05).
const NON_WORK_TOOL_NAMES = new Set(["share_finding", "read_shared_facts", "recall_context", "record_plan"]);
export function isWorkToolName(name: string): boolean {
  return !NON_WORK_TOOL_NAMES.has(name) && !/^memory_/.test(name) && !/^research_notes?(?:_|$)/.test(name);
}

/**
 * Every WORK tool call the run made failed. `toolNames` lists the run's calls, one entry per
 * call; bookkeeping tools (isWorkToolName) are left out of both sides of the count.
 */
export function everyWorkToolCallFailed(
  toolCount: number | undefined,
  toolNames: readonly string[] | undefined,
  run: Pick<DelegationRunSignals, "failedToolNames" | "toolFailureCount">,
): boolean {
  const names = toolNames ?? [];
  if (run.failedToolNames) {
    const workCalls = names.filter(isWorkToolName).length;
    return workCalls > 0 && run.failedToolNames.filter(isWorkToolName).length >= workCalls;
  }
  if (run.toolFailureCount === undefined) return false;
  const workCalls = Math.max(0, (toolCount ?? names.length) - names.filter((name) => !isWorkToolName(name)).length);
  return workCalls > 0 && run.toolFailureCount >= workCalls;
}

const FINAL_ANSWER_TAG_RE = /<final_answer\s+status="([^"]+)">([\s\S]*?)<\/final_answer>/i;

/**
 * The sub-agent's own closing verdict, `<final_answer status="…">…</final_answer>` — the ONE
 * parser every reader uses (tools/sub-agent.ts's delegation verdict and the run outcome below
 * used to disagree: one required the closing tag, the other accepted the opening tag alone).
 * Note: no prompt instructs this tag today, so it is a rare, opportunistic signal.
 */
export function parseFinalAnswerTag(output: string): { status: string; data: string } | null {
  const match = FINAL_ANSWER_TAG_RE.exec(output ?? "");
  return match ? { status: match[1]!.trim().toLowerCase(), data: match[2]!.trim() } : null;
}

/**
 * The outcome of a sub-agent run that ENDED NORMALLY (agent/sub-agent.ts, stats.outcome), read
 * from structure first:
 *  1. the run's own `<final_answer status>`;
 *  2. artifacts it produced → success;
 *  3. every WORK call failed → failure when the answer reports a failure (or is empty), else
 *     partial — a correct knowledge answer after a failed search ("The capital of Australia is
 *     Canberra.") is kept and flagged, not discarded (adversarial review 2026-10-05);
 *  4. concrete evidence not echoed from the task → success;
 *  5. only then the prose tie-breaker (five failure phrases over the opening) → partial.
 * Before 2026-10-05 the prose decided alone, so an explicit success that explained an "HTTP 404
 * not found" response became partial, and "Keine Ergebnisse gefunden" after failed fetches success.
 */
export function inferCompletedRunOutcome(
  output: string,
  run: {
    toolCount: number;
    toolNames?: readonly string[];
    failedToolNames?: readonly string[];
    toolFailureCount?: number;
    artifactCount: number;
    task?: string;
  },
): "success" | "partial" | "failure" {
  const explicit = parseFinalAnswerTag(output)?.status;
  if (explicit === "success") return "success";
  if (explicit === "failure") return "failure";
  if (explicit) return "partial"; // partial / needs_info: the run itself says it is not done
  if (run.artifactCount > 0) return "success";
  if (everyWorkToolCallFailed(run.toolCount, run.toolNames, run)) {
    return !output.trim() || looksLikeProseFailureResult(output) ? "failure" : "partial";
  }
  if (carriesConcreteEvidence(output, run.task)) return "success";
  return /no results|not found|unable to|failed to|error:/i.test(output.slice(0, 300)) ? "partial" : "success";
}

export function looksLikeRunningTaskStatusResult(result: string): boolean {
  const normalized = result
    .replace(/^\[[^\]]+\]:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || normalized.length > 1000) return false;
  return /\bis already running via\s+(?:[a-z0-9_:-]*(?:_agent|_coordinator)|researcher|another agent)\b/i.test(normalized)
    && !/(?:^|\s)(?:FACT:|https?:\/\/|datasheet|specification|voltage|current|capacity|snr|frequency|dimension|pinout)\b/i.test(normalized);
}

/**
 * Detect infrastructure-level failures where retrying via a different agent
 * or ephemeral agent cannot succeed (host unreachable, service down, etc.).
 */
export function looksLikeInfrastructureFailure(result: string): boolean {
  if (!result.trim()) return false;
  const preview = result.slice(0, 800);
  // Sub-agent execution timeouts ("Sub-agent 'X' timed out after Yms") are
  // retryable with a different agent — they are NOT infrastructure failures.
  if (/\bSub-agent\b.{0,60}\btimed out\b/i.test(preview)) return false;
  return /\b(timed out|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|connection refused|not reachable|host is down|failed recently and is still in cooldown|Do NOT retry)\b/i.test(preview);
}

export function shouldAcceptPartialDelegation(
  agentName: string,
  task: string,
  stats: { toolCount: number; toolNames: string[]; terminalState?: string; outcome?: string } | undefined,
  artifacts: Record<string, unknown>[] = [],
): boolean {
  if (stats?.outcome !== "partial") {
    return false;
  }

  const hasArtifactOutput = artifacts.some((artifact) => {
    if (!artifact || typeof artifact !== "object") return false;
    const value = artifact as Record<string, unknown>;
    return typeof value["outputPath"] === "string"
      || typeof value["dataUrl"] === "string"
      || typeof value["externalUrl"] === "string";
  });
  if (hasArtifactOutput) {
    return true;
  }

  // Accept research-type agents that made meaningful tool progress
  // (used web_search, web_fetch, or similar) — research agents that fetch
  // content but hit max_iterations should be treated as partial successes.
  const hasResearchTools = stats.toolNames.some((name) =>
    name === "web_search" || name === "web_fetch" || name === "read_shared_facts"
  );
  if (hasResearchTools && stats.toolCount >= 2) {
    return true;
  }

  // Structural gate only: a computer-use partial counts when the agent that ran
  // is the computer-use specialist (or it actually invoked a computer_* tool).
  // The task-text keyword sniff was removed — routing/acceptance must not read topic words.
  if (agentName !== "computer_use_agent") {
    return false;
  }

  return stats.toolCount > 0 || stats.toolNames.some((toolName) => toolName.startsWith("computer_"));
}

/**
 * Detect when a "partial" timeout/cancel output contains nothing but failed
 * tool stubs in its recovered-evidence section.  The classic failure mode
 * (audit session 0a93078b, May 2026) is a coordinator that times out after
 * its only tool calls were search_agents → 0 results, list_agents → 0
 * results, create_ephemeral_agent → spawn that itself errored.  The
 * `buildInterruptedSubAgentOutput` formatter produces a "Partial progress
 * before interruption" block whose Recovered evidence snippets list reads:
 *
 *   - search_agents: No agents matched ...
 *   - list_agents: No agents matched ...
 *   - create_ephemeral_agent: Sub-agent error: ...
 *
 * The classifier was treating that as `partial` (because outcome=partial and
 * the output is non-empty), letting the runtime persist it as evidence and
 * skip the failure-handling cascade.  Demote those to `failure` so the
 * failed-delegation diagnostic and warden escalation can fire.
 */
/**
 * True when a failed/timed-out attempt's output carries real gathered evidence
 * (findings, figures, sources) rather than just an interrupted/max-iteration NOTICE.
 * Used to decide whether a captured partial is substantial enough to HALT escalation:
 * a bare "reached the maximum number of tool-call iterations … partial may be
 * incomplete" notice (even when it echoes the task) is not evidence worth stopping
 * for, so we still escalate past it. Distinguishes the 687a224b keystone (a 3789-char
 * verified-spec body → halt) from a researcher's max-iteration notice (→ keep escalating).
 */
export function partialResultHasSubstantiveEvidence(output: string): boolean {
  if (!output) return false;
  const stripped = output
    .replace(/Sub-agent\s+'[^']*'\s+reached the maximum number of tool-call iterations[^.]*\.?/gi, " ")
    .replace(/reached the maximum number of tool-call iterations\s*\(\d+\)/gi, " ")
    .replace(/Partial result may be incomplete\.?/gi, " ")
    .replace(/before producing usable topic-related output\.?/gi, " ")
    .replace(/Partial progress before interruption:?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.length >= 200;
}

export function looksLikeOnlyFailureStubs(output: string): boolean {
  if (!output) return false;
  const text = output.trim();
  // Must be the shape `buildInterruptedSubAgentOutput` produces — header
  // line + "Partial progress before interruption" block.
  if (!/Partial progress before interruption:/i.test(text)) return false;
  // Extract the recovered-evidence section if present.
  const evidenceMatch = /Recovered evidence snippets from completed tools:\s*\n([\s\S]+)$/.exec(text);
  if (!evidenceMatch) {
    // No recovered snippets at all — the only content is the timeout/cancel
    // header plus the swarm-progress lines.  That's effectively no evidence.
    return true;
  }
  const snippets = evidenceMatch[1]!
    .split(/\n(?=- )/)
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);
  if (snippets.length === 0) return true;
  // Patterns that mark a snippet as "failure stub only — no usable evidence".
  const FAILURE_STUB_PATTERNS: RegExp[] = [
    /^[\w_]+:\s*No agents matched\b/i,
    /^[\w_]+:\s*No workspace files contain\b/i,
    /^[\w_]+:\s*No (?:results|matches|files|content|entries) found\b/i,
    /^[\w_]+:\s*Sub-agent error:/i,
    /^[\w_]+:\s*Tool '[^']+' has been called \d+ times this run/i,
    /^[\w_]+:\s*\[ephemeral:[^\]]+\]:\s*Sub-agent error:/i,
    /Request timed out\.?$/i,
    /container error:/i,
    /failed to spawn/i,
  ];
  // Every recovered snippet must match a failure-stub pattern for the output
  // to qualify as "only failure stubs". Even one substantive snippet (e.g. a
  // real web_search hit, a read_file payload, a workspace_search snippet
  // with content) is enough to keep this as a real partial result.
  return snippets.every((snippet) => FAILURE_STUB_PATTERNS.some((pattern) => pattern.test(snippet)));
}

/** Consolidated classification of a completed sub-agent delegation. */
export type DelegationClassification =
  | "success"               // usable, complete answer
  | "partial"               // usable but incomplete evidence (accepted partial)
  | "coordinator_noop"      // coordinator returned a planning stub without delegating or sharing evidence
  | "failure"               // no usable output
  | "infrastructure_failure"; // failure caused by an unreachable service — do not retry with a different agent

/**
 * D14: Single classification function that replaces the scattered combination of
 * looksLikeFailureResult, looksLikePlanningOnlyResult, shouldAcceptPartialDelegation,
 * terminalState checks, stats.outcome, and the coordinator no-op heuristic.
 *
 * Call AFTER <final_answer> tag parsing has already mutated `output` and
 * `delegationOutcome`; pass `run.explicitVerdict` when that tag was present.
 *
 * STRUCTURE FIRST (2026-10-05). The run's own `<final_answer status>` is a verdict, and so is
 * the work it left — artifacts, concrete evidence in its text (figures the task did not already
 * contain) — and so are its WORK tool calls when every one of them failed. The failure-phrase
 * sniff only breaks the tie when none of those speaks. Verified misfires before this: an explicit
 * success explaining "the HTTP 404 not found response" → failure; a datasheet-based German
 * recommendation → planning-only → failure → discarded; "Keine Ergebnisse gefunden; Quelle nicht
 * erreichbar" after failed fetches → success. Per the adversarial review the same day: evidence
 * never outranks the planning verdict (a plan that quotes figures is still a plan) nor a run whose
 * every work call failed; such a run is a failure when it reports one, else partial (kept).
 */
export function classifyDelegationResult(
  output: string,
  delegationOutcome: string | undefined,
  stats: { toolCount: number; toolNames: string[]; terminalState?: string; outcome?: string } | undefined,
  agentCfg: import("../config/schema.js").SubAgentConfig | undefined,
  agentName: string,
  task: string,
  artifacts: Record<string, unknown>[] = [],
  run: DelegationRunSignals = {},
): DelegationClassification {
  const explicitVerdict = run.explicitVerdict === true && delegationOutcome !== undefined;
  const allWorkFailed = artifacts.length === 0 && everyWorkToolCallFailed(stats?.toolCount, stats?.toolNames, run);
  const leftEvidence = artifacts.length > 0 || (!allWorkFailed && carriesConcreteEvidence(output, task));
  const proseDecides = !explicitVerdict && !leftEvidence;
  const planningOnly = !explicitVerdict && artifacts.length === 0 && looksLikePlanningOnlyResult(output);

  // ── Coordinator no-op ──────────────────────────────────────────────────
  // A coordinator that completed without calling any delegation/evidence tools
  // and returned a short or planning-only stub is treated as a no-op.
  // Guard on terminalState === "completed" to avoid false positives from
  // test mocks that leave terminalState undefined.
  const isCoordinator =
    (agentCfg?.tags ?? []).includes("coordination") || agentName.endsWith("_coordinator");
  if (isCoordinator && stats?.terminalState === "completed" && delegationOutcome !== "failure") {
    const COORDINATOR_WORK_TOOLS = new Set([
      "delegate_to_agent", "parallel_delegate", "run_task_graph",
      "swarm_delegate", "share_finding", "run_workflow",
    ]);
    const actuallyWorked = (stats.toolNames ?? []).some((n) => COORDINATOR_WORK_TOOLS.has(n));
    // A coordinator's only job is orchestration via tools. If it called ZERO
    // tools at all and just emitted prose, it did nothing real — no matter how
    // long or plausible that prose reads. The previous (<80 chars || planningOnly)
    // guard let a 767-char capability refusal ("I have no tools for live news…
    // but here are some news sites") slip through as a "successful" completion,
    // so the explicit researcher fallback never ran and the orchestrator relayed
    // the refusal (audit 3a0fd176: "aktuelle news von heute" dead-ended while
    // searxng was reachable). Zero tool calls is the structural, language-
    // independent tell of a no-op. Keep the length/planning guard for the case
    // where the coordinator DID call some non-work tool (e.g. discovery) but
    // never delegated or shared evidence.
    // A coordinator that also owns artifact tools (write_file, generate_*,
    // shell_exec, browser_*) and was declared to produce a file, narrating
    // "I'll build this" without calling them, must stay an artifact-
    // deliverable-miss failure below, which carries the "expected write_file"
    // hint — so don't pre-empt it here. Without that declaration the miss
    // check does not fire, and a zero-tool coordinator is a no-op like any
    // other (it was exempt only so the miss check could name the tool).
    const hasArtifactTools = (agentCfg?.tools ?? []).some((name) =>
      /^(?:write_file|edit_file|generate_|bundle_artifact|shell_exec|send_|post_|browser_)/.test(name)
    );
    const leftToArtifactMiss = hasArtifactTools && run.deliverable === "file";
    const calledNoTools =
      !leftToArtifactMiss && (stats.toolCount ?? 0) === 0 && (stats.toolNames ?? []).length === 0;
    if (!actuallyWorked && (calledNoTools || output.trim().length < 80 || planningOnly)) {
      return "coordinator_noop";
    }
  }

  if (planningOnly) {
    return "failure";
  }

  if (looksLikeReadOnlyMutationMiss(output, stats, run.deliverable)) {
    return "failure";
  }

  // Language-agnostic fallback: the agent had artifact-producing tools
  // (write_file, generate_website, …) AND the delegation was declared to
  // produce a file AND the agent called none of them AND, for coordinators,
  // didn't delegate either. Catches "Let me build this as a complete
  // single-file HTML application" / "Die Website wurde erstellt" / "This is
  // a substantial deliverable…" — phrasings the planning-only regex misses.
  if (looksLikeArtifactDeliverableMiss(task, stats, agentCfg, run.deliverable)) {
    return "failure";
  }

  // Every WORK call the run made failed: a failure when the answer reports one (or is empty) —
  // figures in it do not rescue it, they may be echoed or remembered — else a partial: the answer
  // is kept and delivered, flagged as unbacked by any working tool. Only the run's own explicit
  // success outranks this.
  if (!(explicitVerdict && delegationOutcome === "success") && allWorkFailed) {
    if (!output.trim() || looksLikeProseFailureResult(output)) {
      return looksLikeInfrastructureFailure(output) ? "infrastructure_failure" : "failure";
    }
    return "partial";
  }

  // ── Partial acceptance ─────────────────────────────────────────────────
  const acceptPartial = shouldAcceptPartialDelegation(agentName, task, stats, artifacts);

  // ── Failure detection ──────────────────────────────────────────────────
  const isExplicitFailure = delegationOutcome === "failure";
  const isNeedsInfoUnaccepted = delegationOutcome === "needs_info" && !acceptPartial;
  const isIncompleteUnaccepted =
    !acceptPartial
    && (
      (stats?.terminalState !== undefined && stats.terminalState !== "completed")
      || looksLikeStructuralFailureResult(output)
      || (proseDecides && looksLikeProseFailureResult(output))
    );

  if (isExplicitFailure || isNeedsInfoUnaccepted || isIncompleteUnaccepted) {
    // Even in a failing result, partial content may still be usable
    const hasPartialContent =
      delegationOutcome === "partial"
      || (stats?.outcome === "partial" && delegationOutcome !== "success");
    // Demote partial-with-only-failure-stubs to failure: the recovered-
    // evidence section contains nothing but "No X matched" / "Sub-agent
    // error:" / per-tool-cap stubs, so there's nothing to synthesize from.
    // Letting this through as `partial` skips the failure-handling cascade
    // (failed-delegation diagnostic, warden escalation) and surfaces stubs
    // to the model as if they were real evidence.
    if (hasPartialContent && output.trim() && !looksLikePlanningOnlyResult(output) && !looksLikeOnlyFailureStubs(output) && !looksLikeRunningTaskStatusResult(output)) {
      return "partial";
    }
    return looksLikeInfrastructureFailure(output) ? "infrastructure_failure" : "failure";
  }

  // ── Success / partial-accepted ─────────────────────────────────────────
  if (acceptPartial || delegationOutcome === "partial") {
    return "partial";
  }
  return "success";
}

/**
 * Decide whether a FAILED delegation should be reported to the orchestrator as
 * "narrative-only" (the agent narrated intent but never called a work tool).
 *
 * A container/host-level crash — the agent-worker could not reach the model
 * endpoint or a gateway-bound MCP, failed to spawn, exited non-zero, or timed
 * out — is NOT a narrative-only miss even though it produced zero tool calls
 * (it never got to run). Labeling it "never called write_file — restate the
 * task as a single direct instruction, or pick a different specialist" is
 * misleading on two counts: the agent wasn't lazy, and re-wording the task to
 * the SAME broken containerized agent cannot succeed. Surface the raw container
 * error instead so the orchestrator can see it and route elsewhere.
 *
 * (audit: `coder` ran containerized for the CPSA-F learning-platform build, hit
 * "container error: unknown" with 0 tokens / 0 tools, and was reported as
 * "narrative-only — restate the task", which sent the orchestrator in circles
 * and cascaded the dependent nodes to blocked.)
 */
export function isNarrativeOnlyDeliverableFailure(
  classification: DelegationClassification,
  output: string,
  task: string,
  stats: { toolCount: number; toolNames: string[] } | undefined,
  agentCfg: import("../config/schema.js").SubAgentConfig | undefined,
  deliverable: DelegationDeliverable | undefined,
): boolean {
  if (classification !== "failure") return false;
  if (looksLikeContainerLevelFailure(output)) return false;
  return looksLikePlanningOnlyResult(output) || looksLikeArtifactDeliverableMiss(task, stats, agentCfg, deliverable);
}

export function formatArtifactReferencesForSharedContext(
  artifacts: Record<string, unknown>[],
  reuseDirective = false,
): string {
  const lines = artifacts
    .map((artifact) => {
      if (!artifact || typeof artifact !== "object") return "";
      const value = artifact as Record<string, unknown>;
      const outputPath = typeof value["outputPath"] === "string" ? value["outputPath"] : "";
      const filename = typeof value["filename"] === "string" ? value["filename"] : "";
      const previewMode = typeof value["previewMode"] === "string" ? value["previewMode"] : "";
      const sourceTool = typeof value["sourceTool"] === "string" ? value["sourceTool"] : "";
      const artifactRef = outputPath || filename;
      if (!artifactRef) return "";

      const qualifiers = [previewMode, sourceTool].filter(Boolean);
      return qualifiers.length > 0
        ? `- ${artifactRef} (${qualifiers.join(", ")})`
        : `- ${artifactRef}`;
    })
    .filter(Boolean)
    .slice(0, 6);

  if (lines.length === 0) return "";
  // Cross-agent artifact reuse (orchestration.crossAgentArtifactReuse). These artifact refs are
  // already surfaced to LATER delegated agents via the shared partial-results context, but by default
  // as a PASSIVE list — so agents re-AUTHOR the same content instead of reusing it (run 663ac153: ~50
  // questions written 3× across agents). When the directive is on, the same list becomes an explicit,
  // actionable REUSE instruction. Structural (artifact paths); advisory only — an agent may still
  // author a genuinely new variant.
  return reuseDirective
    // "earlier in this session" not "this turn": partial results are session-scoped (4h TTL, no
    // per-turn clear), so in a multi-turn session these refs can be from a prior turn. The agent is
    // told to READ (read_file) first, so it reuses the CURRENT file content, not a stale snapshot.
    ? `\n\nArtifacts produced earlier in this session — READ (read_file) and REUSE/EXTEND these instead of re-authoring their content from scratch:\n${lines.join("\n")}`
    : `\n\nArtifacts generated by this result:\n${lines.join("\n")}`;
}
