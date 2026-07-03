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

export function looksLikePlanningOnlyResult(result: string): boolean {
  const preview = result.slice(0, 600).trim();
  if (!preview) return false;

  // Openers that signal "the model started narrating intent". Both English
  // and German because qwen mirrors the user's language; session 6b3f2123
  // showed an entire 3 KB planning loop in German ("Ich werde…", "Lass mich
  // einen anderen Ansatz wählen", "Stattdessen…", "Letztendlich…") that the
  // English-only regex missed entirely.
  const startsLikePlanning = /^\s*(let me|now let me|first let me|now i can|now i (?:have|understand)\b[\s\S]{0,160}\blet me|i (?:now )?(?:have|understand)\b[\s\S]{0,160}\blet me|i(?:'m| am) going to|i(?:'ll| will)|i(?:'m| am) trying to|i need to|next,? i(?:'m| am) going to|ich werde|ich erstelle|ich nutze|ich verwende|ich entscheide|ich w(?:ä|ae)hle|ich versuche|ich muss|lass mich|stattdessen|letztendlich|allerdings|aufgrund|der (?:beste|pragmatischste|einfachste) ansatz|da (?:es sich|ich|write_file|das))\b/i.test(preview);
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
  return !terminalMarker;
}

export const WORKSPACE_MUTATION_TASK_RE = /\b(?:update|modify|edit|write|patch|save|create|add|change|set|switch|configure|implement|apply|fix|adjust|build|generate|produce|draft|compose|anpass(?:en|ung|ungen)?|angepasst|pass(?:e|en|t)\b[\s\S]{0,80}\ban|aendere|ändere|ändern|aktualisier(?:e|en|ung)?|bearbeit(?:e|en)|schreib(?:e|en)?|erstell(?:e|en)?|erzeug(?:e|en|ung)?|generier(?:e|en)?|bau(?:e|en)?|hinzuf(?:ue|ü)gen|setz(?:e|en)?|konfigurier(?:e|en)|umstell(?:e|en))\b/i;
export const WORKSPACE_MUTATION_CONTEXT_RE = /\b(?:starlingai|workspace|repo|repository|agent|agents|scene|scenes|job|jobs|workflow|workflows|config|configuration|prompt|prompts|tool|tools|model|routing|self[- ]?improvement|selbstverbesserung|konfiguration|modell|agenten|szene|szenen|wartung)\b/i;
export const WORKSPACE_MUTATION_TOOL_NAMES = new Set(["write_file", "edit_file", "create_dir", "delete_file", "shell_exec"]);
export const READ_ONLY_CONTEXT_TOOL_NAMES = new Set([
  "read_file", "list_files", "workspace_search", "read_shared_facts", "search_agents", "agent_catalog", "git_status", "git_diff",
]);

export function looksLikeWorkspaceMutationTask(
  task: string,
  agentCfg: import("../config/schema.js").SubAgentConfig | undefined,
  agentName: string,
): boolean {
  const text = task.trim();
  if (!text || !WORKSPACE_MUTATION_TASK_RE.test(text)) return false;
  const tags = new Set((agentCfg?.tags ?? []).map((tag) => tag.toLowerCase()));
  const maintenanceAgent = agentName === "swarm_maintainer"
    || tags.has("swarm")
    || tags.has("maintenance")
    || tags.has("selfimprovement")
    || tags.has("agents")
    || tags.has("prompts")
    || tags.has("workflow");
  return maintenanceAgent || WORKSPACE_MUTATION_CONTEXT_RE.test(text);
}

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

export function looksLikeReadOnlyMutationMiss(
  output: string,
  task: string,
  stats: { toolCount: number; toolNames: string[] } | undefined,
  agentCfg: import("../config/schema.js").SubAgentConfig | undefined,
  agentName: string,
): boolean {
  if (!looksLikeWorkspaceMutationTask(task, agentCfg, agentName)) return false;
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
  "bundle_artifact_zip", "export_workspace_artifact",
  // fetch_image downloads + SAVES a real local image file — that saved asset is the
  // deliverable, which cached research facts can never satisfy. Without this, an
  // image-sourcing delegation gets short-circuited by findReusableSessionEvidence and
  // never actually runs (audit cdd731d6: image_sourcer "reusedFromSessionMemory", 0 images).
  "fetch_image",
  "shell_exec",
]);

// Coordinators can also "produce" by delegating the work. If they called
// none of these AND none of ARTIFACT_PRODUCING_TOOLS, they truly did
// nothing useful.
export const PRODUCTIVE_COORDINATOR_TOOLS = new Set([
  "delegate_to_agent", "parallel_delegate", "run_task_graph",
  "run_workflow", "create_ephemeral_agent", "swarm_delegate",
]);

export function looksLikeArtifactDeliverableMiss(
  task: string,
  stats: { toolCount: number; toolNames: string[] } | undefined,
  agentCfg: import("../config/schema.js").SubAgentConfig | undefined,
): boolean {
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
  // shipped that as the whole answer.
  if (isCanonicalResearchSliceTask(task)) return false;
  // NOTE: do NOT skip on `toolCount === 0 && toolNames.length === 0`. The
  // earlier "treat empty stats as a mock signal" shortcut let real
  // production failures through: session 25f55376 (2026-05-28) had
  // mission_coordinator generate 4096 tokens of "I'll write it in one go"
  // narrative with literally zero tool calls and get marked as success.
  // That is the strongest narrative-only signal we have; we must catch it.
  if (!WORKSPACE_MUTATION_TASK_RE.test(task.trim())) return false;

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

export function looksLikeFailureResult(result: string): boolean {
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
  if (looksLikeModelTemplateArtifact(result)) {
    return true;
  }
  if (/\b(no results|not found|unable to|failed to|error:|timed out|cancelled|incomplete|max.{0,20}iterations|sub_agent_max_iterations|could not complete|did not complete|exited with code|exit code)\b/i.test(preview)) {
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

  return looksLikePlanningOnlyResult(preview);
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
 * `delegationOutcome`.
 */
export function classifyDelegationResult(
  output: string,
  delegationOutcome: string | undefined,
  stats: { toolCount: number; toolNames: string[]; terminalState?: string; outcome?: string } | undefined,
  agentCfg: import("../config/schema.js").SubAgentConfig | undefined,
  agentName: string,
  task: string,
  artifacts: Record<string, unknown>[] = [],
): DelegationClassification {
  const planningOnly = looksLikePlanningOnlyResult(output);

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
    // Restrict the zero-tool extension to PURE orchestration coordinators
    // (delegation/read tools only). A coordinator that also owns artifact tools
    // (write_file, generate_*, shell_exec, browser_*) narrating "I'll build this"
    // without calling them must stay an artifact-deliverable-miss failure below,
    // which carries the "expected write_file" hint — so don't pre-empt it here.
    const hasArtifactTools = (agentCfg?.tools ?? []).some((name) =>
      /^(?:write_file|edit_file|generate_|bundle_artifact|shell_exec|send_|post_|browser_)/.test(name)
    );
    const calledNoTools =
      !hasArtifactTools && (stats.toolCount ?? 0) === 0 && (stats.toolNames ?? []).length === 0;
    if (!actuallyWorked && (calledNoTools || output.trim().length < 80 || planningOnly)) {
      return "coordinator_noop";
    }
  }

  if (planningOnly) {
    return "failure";
  }

  if (looksLikeReadOnlyMutationMiss(output, task, stats, agentCfg, agentName)) {
    return "failure";
  }

  // Language-agnostic fallback: the agent had artifact-producing tools
  // (write_file, generate_website, …) AND the task asks for a deliverable
  // AND the agent called none of them AND, for coordinators, didn't
  // delegate either. Catches "Let me build this as a complete single-file
  // HTML application" / "Die Website wurde erstellt" / "This is a
  // substantial deliverable…" — phrasings the planning-only regex misses.
  if (looksLikeArtifactDeliverableMiss(task, stats, agentCfg)) {
    return "failure";
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
      || looksLikeFailureResult(output)
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
): boolean {
  if (classification !== "failure") return false;
  if (looksLikeContainerLevelFailure(output)) return false;
  return looksLikePlanningOnlyResult(output) || looksLikeArtifactDeliverableMiss(task, stats, agentCfg);
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
