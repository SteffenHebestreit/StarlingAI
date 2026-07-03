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
