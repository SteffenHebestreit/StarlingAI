/**
 * Agent Runtime — the main agent loop.
 * LLM call → parse tool calls → execute (with guardrails) → loop → final response
 */
import { getChatProvider, getChatProviderForTier, getChatProviderWithOverride } from "../providers/index.js";
import type { ChatProvider, LLMMessage, LLMResponse, StreamChunk } from "../providers/lmstudio.js";
import { getToolsAsLLMDefs, executeTool, normalizeToolCall, type SwarmState, type ToolContext } from "../tools/registry.js";
import { isToolAllowed, requiresApproval } from "../guardrails/tool-tiers.js";
import { loadTurnPlan, classifyTurnRisk } from "./turn-plan.js";
import { checkInput, checkToolOutput } from "../guardrails/input.js";
import { moderateInputText, moderateToolResultText } from "../guardrails/moderation.js";
import { scanOutput } from "../guardrails/output.js";
import { checkRateLimit } from "../guardrails/rate-limiter.js";
import { logAudit } from "../audit/logger.js";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import type { AgentSession, SessionHistoryMessage, SessionTranscriptAttachment } from "./session.js";
import { classifyToolIntervention, type InterventionNotice } from "./interventions.js";
import { getMainAssistantToolNames, type MainAssistantToolMode } from "./default-tools.js";
import { longRunningGenerationManager } from "./long-running-generation.js";
import { turnSteeringManager } from "./turn-steering.js";
import { registerSessionAbortController, deregisterSessionAbortController } from "./warden.js";
import { formatFlowMemoryGuidance } from "./flow-memory.js";
import { looksLikeProviderErrorEcho } from "./container-failure.js";
import { sanitizeAssistantContent, NARRATED_TOOL_TEXT_RE } from "./sanitize-response.js";
import { formatScopedMemoryGuidance } from "../memory/service.js";
import { retrieveSkillGuidance } from "../skills/service.js";
import { recordSkillOutcomeAsync, recordSkillHoldoutOutcomeAsync } from "../skills/store.js";
import { maybeDistillSkillFromTurn } from "../skills/distiller.js";
import { formatUserModelGuidance } from "../user-model/service.js";
import { lookupTrajectory, writeTrajectory, invalidateTrajectory } from "../memory/trajectory-cache.js";
import { graphMarkSessionRetrievalsUseful, graphMarkSessionRetrievalsUnhelpful } from "../memory/graph-service.js";
import type { SubAgentProgressEvent } from "./sub-agent.js";
import { listAllJobs } from "../credentials/jobs.js";
import { listAllScenes } from "../credentials/scenes.js";
import { readAllFacts } from "../swarm/memory.js";
import {
  buildDynamicTurnGuidance,
  type DynamicTurnGuidance,
  buildLanguageAndIdentityTurnGuidance,
  PRODUCT_RECOMMENDATION_PATTERNS,
  WORKFLOW_HINT_TERMS,
  WORKFLOW_ACTION_TERMS,
  WORKFLOW_DELIVERABLE_HINT_TERMS,
  WORKFLOW_REQUEST_PATTERNS,
  toSoftRoutingHint,
  looksMultiDomainResearch,
} from "./intent-classifier.js";
import { buildSourceSensitiveOriginalRequestTask, deriveSourceSensitiveDelegationFocus, buildEffectiveResearchSubject } from "./source-sensitive-delegation.js";

const log = childLogger("agent:runtime");

const DEFAULT_MAX_TOOL_ITERATIONS = 20;
const MAX_LENGTH_CONTINUATION_ATTEMPTS = 2;
const MAX_CONTINUATION_OVERLAP_CHARS = 400;
const PER_TURN_TOOL_CALL_LIMITS: Partial<Record<string, number>> = {
  delegate_to_agent: 5,
  search_agents: 4,
  search_workflows: 2,
  run_workflow: 2,
  create_ephemeral_agent: 1,
  computer_session_start: 1,
  computer_focus_window: 2,
  computer_snapshot: 3,
  computer_list_windows: 2,
  computer_click: 8,
  computer_type: 6,
  computer_hotkey: 6,
  computer_scroll: 4,
  computer_move_mouse: 4,
  computer_wait: 3,
  vscode_focus_panel: 2,
  vscode_run_terminal_command: 3,
};
export interface RunTurnOptions {
  session: AgentSession;
  userMessage: string;
  userDisplayContent?: string;
  userAttachments?: SessionTranscriptAttachment[];
  onChunk?: (text: string) => void;
  /** Live chain-of-thought tokens for the main assistant turn. Streams ahead
   * of the answer; the UI shows it in a collapsible panel that auto-collapses
   * once the first answer token arrives. */
  onReasoning?: (text: string) => void;
  onStatus?: (status: { phase: string; message: string; iteration?: number }) => void;
  onToolCall?: (toolCallId: string, name: string, args: Record<string, unknown>) => void;
  onToolResult?: (toolCallId: string, name: string, result: string, metadata?: Record<string, unknown>) => void;
  onSubAgentProgress?: (event: SubAgentProgressEvent) => void;
  onComputerAction?: (action: { computerSessionId: string; actionType: string; [key: string]: unknown }) => void;
  onComputerScreenshot?: (screenshot: { computerSessionId: string; dataUrl: string; width: number; height: number; [key: string]: unknown }) => void;
  onComputerSessionState?: (sessionState: { computerSessionId: string; state: string; [key: string]: unknown }) => void;
  onIntervention?: (notice: InterventionNotice) => void;
  onSwarmState?: (state: SwarmState) => void;
  approvalCallback?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
  inputCallback?: (question: string, choices?: string[], timeoutMs?: number) => Promise<string>;
  signal?: AbortSignal;
  /** Sub-agents this turn is allowed to delegate to (undefined = no restriction) */
  allowedAgents?: string[];
  /** Tool names that must pause for human approval this turn (enforced unconditionally) */
  humanInLoopSteps?: string[];
  /** Auto-approve all tool calls this turn — skips the approvalCallback gate entirely. */
  autoApprove?: boolean;
  /** Override sub-agent maxIterations for delegated tasks this turn. 0 disables the cap. */
  maxIterationsOverride?: number;
  /** When set, this turn is a tool-dev session — iteration limits are lifted. */
  _toolDevSessionId?: string;
  /** Active reusable workflow execution stack for nested workflow/self-reentry guards. Internal. */
  _workflowExecutionStack?: string[];
  /** Override the per-turn timeout in ms (replaces config gateway.turnTimeoutMs). 0 disables the timeout. */
  turnTimeoutOverrideMs?: number;
  /** Per-message Qwen3.5 thinking toggle. true = on, false = off, undefined = model default. */
  enableThinking?: boolean;
}

export interface TurnOutput {
  response: string;
  toolCallsExecuted: number;
  guardrailEvents: Array<{ type: string; details: string }>;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  blocked: boolean;
  swarmState?: SwarmState;
  performance?: TurnPerformanceMetrics;
}

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
  completionChars: number;
  toolIterations: number;
  finishReason: string;
  blocked: boolean;
}

export function getPerTurnToolCallLimit(toolName: string): number | undefined {
  const cfgOverride = getConfig().orchestration?.perTurnCaps?.[toolName];
  if (cfgOverride !== undefined) return cfgOverride;
  return PER_TURN_TOOL_CALL_LIMITS[toolName];
}

export function buildDelegationLoopResponse(
  session: AgentSession,
  latestOutput: string,
  reason: "identical-output" | "limit" = "identical-output",
): string {
  const normalized = latestOutput.trim() || "The delegated agent returned no usable output.";
  const evidence = findRecentDelegateEvidence(session.getHistory());
  const bestAvailable = evidence?.evidence?.trim() || normalized;

  if (reason === "limit") {
    const intro = evidence
      ? "I stopped here because the delegation limit for this turn was reached. Here is the best grounded result collected so far:"
      : "I stopped here because the delegation limit for this turn was reached before a grounded final answer could be completed.";
    return `${intro}\n\n${bestAvailable}\n\nIf you want me to continue past this limit, tell me to raise the delegation limit for this task. Otherwise, we can stop here.`;
  }

  return [
    "Delegation loop detected. I stopped the repeated delegation and am using the best grounded result collected so far.",
    "",
    bestAvailable,
    "",
    "If you want another attempt, tell me to try a different strategy. Otherwise, we can stop here.",
  ].join("\n");
}

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

async function formatSharedFactsForFinalSynthesis(sessionId: string, maxChars = 4_000): Promise<string> {
  try {
    const facts = await readAllFacts(sessionId);
    const entries = Object.entries(facts)
      .filter(([, value]) => value.trim().length > 0)
      .sort(([left], [right]) => left.localeCompare(right));
    if (entries.length === 0) return "";

    const lines: string[] = [];
    let usedChars = 0;
    for (const [key, value] of entries) {
      const line = `- ${key}: ${value.replace(/\s+/g, " ").trim()}`;
      if (usedChars + line.length > maxChars && lines.length > 0) break;
      lines.push(line.length > maxChars ? `${line.slice(0, maxChars - 3)}...` : line);
      usedChars += line.length;
      if (lines.length >= 20) break;
    }

    return [
      "[SHARED FINDINGS AVAILABLE] Use these shared findings when producing the final answer. Do not duplicate work or answer from training data when a shared finding covers the fact.",
      ...lines,
    ].join("\n");
  } catch (err) {
    log.debug({ err, sessionId }, "Failed to load shared findings for final synthesis");
    return "";
  }
}

async function hasSharedFactsForFinalSynthesis(sessionId: string): Promise<boolean> {
  try {
    const facts = await readAllFacts(sessionId);
    return Object.values(facts).some((value) => value.trim().length >= 80);
  } catch (err) {
    log.debug({ err, sessionId }, "Failed to check shared findings for final synthesis");
    return false;
  }
}

// A shared-fact value that is a raw tool dump, not user-facing evidence: PDF
// bytes / internals, or a bare url_inspect HTTP-probe line (status + headers,
// no prose). These must never crowd out or stand in for curated findings — they
// are exactly what produced the "answer = %PDF-1.7 … 200 OK application/pdf"
// garbage when a coordinator's synthesis timed out and the backstop fired.
export function isJunkEvidenceValue(value: string): boolean {
  const v = value.trim();
  if (!v) return true;
  if (/%PDF-\d/i.test(v)) return true;
  if (/\bendobj\b|\bendstream\b|\/FlateDecode\b|\/MediaBox\b/i.test(v)) return true;
  if (/(?:\b0{6,}\b[^\n]*){3,}/.test(v)) return true; // PDF xref offset tables
  // url_inspect probe: "200 OK final: <url> content-type: …" with no sentence.
  if (/\b\d{3}\s+(?:OK|Not Found|Found|Moved|Forbidden)\b/i.test(v)
    && /\bcontent-type:/i.test(v)
    && !/[.!?]\s/.test(v)) return true;
  return false;
}

// True when most non-empty lines of an evidence blob are raw-tool junk — used to
// reject a long raw dump in favour of concise curated findings.
function evidenceIsMostlyJunk(evidence: string): boolean {
  const lines = evidence.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  const junk = lines.filter((l) => isJunkEvidenceValue(l)).length;
  return junk / lines.length >= 0.5;
}

export async function getSharedFactsEvidenceForFinalSynthesis(
  sessionId: string,
  maxChars = 4_000,
): Promise<{ evidence: string; itemCount: number } | null> {
  try {
    const facts = await readAllFacts(sessionId);
    const entries = Object.entries(facts)
      .filter(([, value]) => value.trim().length > 0)
      // Raw tool dumps (PDF bytes, bare HTTP probes) are not user-facing evidence
      // and would otherwise fill the budget ahead of curated findings.
      .filter(([, value]) => !isJunkEvidenceValue(value))
      // Curated share_finding entries (claims/specs, e.g. im73a135v01_verified_specs)
      // first; auto_<agent>_<tool>_<hash> raw shares last. The old plain
      // alphabetical sort let auto_* junk crowd out the verified findings.
      .sort(([left], [right]) => {
        const lj = left.startsWith("auto_") ? 1 : 0;
        const rj = right.startsWith("auto_") ? 1 : 0;
        if (lj !== rj) return lj - rj;
        return left.localeCompare(right);
      });
    if (entries.length === 0) return null;

    const lines: string[] = [];
    let usedChars = 0;
    for (const [key, value] of entries) {
      const line = `- ${key}: ${value.replace(/\s+/g, " ").trim()}`;
      if (usedChars + line.length > maxChars && lines.length > 0) break;
      lines.push(line.length > maxChars ? `${line.slice(0, maxChars - 3)}...` : line);
      usedChars += line.length;
      if (lines.length >= 20) break;
    }

    const evidence = lines.join("\n").trim();
    if (!evidence) return null;

    const itemCount = countStructuredItems(evidence);
    if (itemCount < 1 && evidence.length < 80) return null;

    return { evidence, itemCount };
  } catch (err) {
    log.debug({ err, sessionId }, "Failed to build shared-findings evidence for final synthesis");
    return null;
  }
}

/**
 * Returns true when the evidence looks like a raw shared-facts dump that
 * should not go to the user verbatim. Two shapes show up in practice:
 *
 *   1. `getSharedFactsEvidenceForFinalSynthesis` output — bullet list whose
 *      lines start with `- auto_<agent>_<tool>_<hash>:` keys.
 *   2. `read_shared_facts` tool output collapsed into a sub-agent's
 *      partial-progress evidence snippet — prefixed by `- read_shared_facts:`
 *      and containing `## Shared Session Facts (N)` plus space-separated
 *      `**auto_xxx**: <value>` pairs (whitespace flattened by the snippet
 *      truncator). This shape arrives when a coordinator's final synthesis
 *      times out at the LLM provider after collecting shared findings.
 *
 * Either shape is debug-shaped output unsuitable for the user.
 */
function looksLikeRawSharedFactsDump(evidence: string): boolean {
  const trimmed = evidence.trim();
  if (!trimmed) return false;
  if (/^[ \t]*-\s+auto_[a-z0-9_]+:\s*/im.test(trimmed)) return true;
  if (/##\s+Shared\s+Session\s+Facts\s+\(\d+\)/i.test(trimmed)
    && /(?:\*\*)?auto_[a-z0-9_]+(?:\*\*)?:\s*/i.test(trimmed)) {
    return true;
  }
  if (/^[ \t]*-\s+read_shared_facts:\s*/im.test(trimmed)
    && /(?:\*\*)?auto_[a-z0-9_]+(?:\*\*)?:\s*/i.test(trimmed)) {
    return true;
  }
  return false;
}

function looksLikeRawWorkspaceToolDump(evidence: string): boolean {
  const trimmed = evidence.trim();
  if (!trimmed) return false;
  const compact = trimmed.replace(/\s+/g, " ").slice(0, 12_000);
  if (/\.starlingai\/\s+agent_outcomes\.ndjson\s+README\.md\s+agents\/\s+10-core-agents\.jsonc\s+20-subagents-general\.jsonc/i.test(compact)) {
    return true;
  }
  if (/[{]\s*"(?:agents|subAgents)"\s*:\s*[{]/i.test(compact)
    && /"systemPrompt"\s*:/i.test(compact)
    && /"primary"\s*:\s*"lmstudio\//i.test(compact)) {
    return true;
  }
  return /####\s+Tool Calls/i.test(trimmed)
    && /\b(?:read_file|list_files|search_agents|agent_catalog)\b/i.test(trimmed)
    && /\b(?:agents\/|10-core-agents\.jsonc|20-subagents-general\.jsonc|"subAgents"|"agents")\b/i.test(trimmed);
}

function formatRawWorkspaceToolDumpFailure(): string {
  return "The delegated maintenance attempt only returned raw workspace/config read output and did not provide evidence of a completed write, validation, or config rebuild.";
}

/**
 * Reformat a raw shared-facts dump into a user-readable list. Strips the
 * `auto_<agent>_<tool>_<hash>:` keys and the `[agent/tool]` provenance tag
 * (still useful for the LLM context but noisy for end users), and rewrites
 * mid-word "..." truncations to clean ellipses at sentence/word boundaries.
 *
 * Handles both the bullet-line shape (`- auto_xxx: <value>`) and the
 * `read_shared_facts` heading shape (`## Shared Session Facts (N) **auto_xxx**:
 * <value> **auto_yyy**: <value>`), splitting on whichever marker is present.
 *
 * Non-shared-facts evidence (e.g. delegation evidence with structured
 * markdown) is returned unchanged so we don't accidentally damage real
 * dossiers that happen to land on this code path.
 */
function formatSharedFactsRecoveryForUserDisplay(evidence: string): string {
  if (!looksLikeRawSharedFactsDump(evidence)) return evidence;
  // Strip shared-facts framing that would otherwise leak into the output:
  //   `- read_shared_facts:` prefix the coordinator added when the
  //   tool result was harvested as a recovery evidence snippet, and the
  //   `## Shared Session Facts (N)` heading from `read_shared_facts`.
  const stripped = evidence
    .replace(/^[ \t]*-\s+read_shared_facts:\s*/im, "")
    .replace(/##\s+Shared\s+Session\s+Facts\s+\(\d+\)\s*/i, "")
    // Defense-in-depth: our own injected agent hint must never reach the user, even
    // for facts stored before result-shaping started stripping it (audit 65f46046).
    .replace(/💡?\s*If this content is useful for your task,?\s*call share_finding now[\s\S]*?(?:runs out\.?|(?=\n)|$)/gi, "")
    .trim();
  // Split on whichever auto-key marker is present:
  //   `- auto_xxx_yyy:` (bullet-line shape) — preserve the leading split
  //   `**auto_xxx_yyy**:` (heading shape) — preserve same
  const splitRe = /(?=(?:^|[\s])[ \t]*-?\s*(?:\*\*)?auto_[a-z0-9_]+(?:\*\*)?:)/gim;
  const blocks = stripped
    .split(splitRe)
    .map((block) => block.trim())
    .filter(Boolean);
  const cleanedBlocks: string[] = [];
  for (const rawBlock of blocks) {
    const cleaned = rawBlock
      .replace(/^[ \t]*-\s+/, "")
      .replace(/^\*\*auto_[a-z0-9_]+\*\*:\s*/i, "")
      .replace(/^auto_[a-z0-9_]+:\s*/i, "")
      .replace(/^\[[^\]]+\]\s*/, "")
      .trim();
    if (!cleaned) continue;
    cleanedBlocks.push(`- ${trimSharedFactDisplayTail(cleaned)}`);
  }
  if (cleanedBlocks.length === 0) return evidence;
  return cleanedBlocks.join("\n\n");
}

function trimSharedFactDisplayTail(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact.endsWith("...") && !compact.endsWith("…")) return compact;
  const stripped = compact.replace(/[\s.…]+$/g, "").trim();
  const lastPeriod = stripped.lastIndexOf(".");
  if (lastPeriod >= 120 && lastPeriod < stripped.length - 1) {
    return stripped.slice(0, lastPeriod + 1);
  }
  const lastSpace = stripped.lastIndexOf(" ");
  if (lastSpace >= 120) return `${stripped.slice(0, lastSpace).trim()} […]`;
  return `${stripped} […]`;
}

function buildRecoveryEvidenceUserMessage(evidence: string): string {
  const formatted = formatSharedFactsRecoveryForUserDisplay(evidence);
  // Bilingual preamble + suffix so this works whether the user wrote in German
  // or English. Both are short — the evidence is the bulk of the message.
  return [
    "Die Recherche wurde unterbrochen, bevor ein vollständiges Dossier fertiggestellt werden konnte. Die bisher gesammelten Quellen und Fakten:",
    formatted,
    // Topic-agnostic footer. NEVER name domain-specific sections here (an earlier version
    // hardcoded "(Produkt-Empfehlungen, Verdrahtung, BOM, Verbesserungen)" — overfit to one
    // hardware-BOM request, audit 65f46046 surfaced it verbatim on a Dresden architecture deck).
    "Falls Abschnitte fehlen, starte den Lauf bei Bedarf mit einem engeren Fokus erneut, damit ein Spezialist die noch offenen Punkte vollständig abdecken kann.\n(If anything is missing, you can re-run with a narrower focus so a specialist can complete the remaining sections.)",
  ].join("\n\n");
}

function formatRecoveryEvidenceForFinalUser(
  evidence: string,
  options?: { sourceSensitive?: boolean },
): string {
  if (looksLikeRawSharedFactsDump(evidence)) return buildRecoveryEvidenceUserMessage(evidence);
  if (options?.sourceSensitive) return formatSourceSensitiveEvidenceBackstop(evidence);
  return evidence;
}

/**
 * True when a string is a RAW TOOL-RESULT DUMP rather than a written answer: web_fetch
 * page text ("Content from: <url> …"), search-result blocks ("Web Search Results for:
 * …"), recovered-evidence scaffolding, or scraped page chrome ("Jump to content",
 * "move to sidebar", "Create account Log in"). Such a dump must never be the
 * user-facing final answer (audit 003f5aeb: every Dresden presentation run, when the
 * artifact build failed, shipped the raw Dresden_Castle Wikipedia nav menu verbatim).
 * Requires >= 2 distinct structural markers so a genuine synthesized answer that merely
 * cites a URL is not flagged. Topic- and site-agnostic — structural framing only.
 */
export function looksLikeRawToolEvidenceDump(value: string): boolean {
  const v = value.trim();
  if (v.length < 200) return false;
  // A user-facing answer that LEADS with a raw tool-result header is always a dump —
  // a synthesized answer never begins with "Web Search Results for:", "Content from:
  // <url>", or recovered-evidence scaffolding. One leading marker is enough (audit
  // 33df2aec: a search-results partial led with "Web Search Results for: … MENU Home
  // Travel …" and shipped verbatim — only one structural marker, so the >=2 rule below
  // missed it). Tolerates a little leading markdown/punctuation.
  if (/^[\s>*#`_-]{0,8}(?:Web Search Results for:|Content from:\s*https?:\/\/|Recovered evidence snippets|Partial progress before interruption)/i.test(v)) {
    return true;
  }
  let hits = 0;
  if (/(?:^|\n|\s)Content from:\s*https?:\/\//i.test(v)) hits += 1;
  if (/Web Search Results for:/i.test(v)) hits += 1;
  if (/Recovered evidence snippets|Partial progress before interruption/i.test(v)) hits += 1;
  if (/Jump to content|Skip to (?:main )?content|move to sidebar|Create account\s+Log\s*in/i.test(v)) hits += 1;
  return hits >= 2;
}

/**
 * Honest user-facing message for the "research succeeded but the artifact step failed"
 * end-state. Surfaces the curated, sourced findings (so the gathered work isn't lost)
 * under a bilingual could-not-finish preamble — never the raw dump. Used by the
 * last-resort terminal guard.
 */
/**
 * Heuristic: the user's request asks to CREATE a concrete artifact/deliverable (a file,
 * website, presentation/deck, document, report, chart, app) — not merely to research or
 * answer a question. Mutation verb + artifact noun, EN + DE. Used to decide whether a
 * source-sensitive turn that only gathered evidence should auto-build the artifact in the
 * same turn. Topic-agnostic — verb+noun shape only.
 */
export function looksLikeArtifactCreationRequest(userMessage: string): boolean {
  const t = (userMessage ?? "").toLowerCase();
  const hasVerb = /\b(create|build|generate|make|write|produce|draft|compose|erstelle|erstellen|erstell|baue|bau|schreibe|schreib|generiere|generier|verfasse|verfass|erzeuge|erzeug|mach)\b/.test(t);
  if (!hasVerb) return false;
  return /\b(presentation|pr[äa]sentation|slides?|slide deck|deck|folien|foliensatz|website|web ?site|webseite|webpage|web ?page|landing ?page|microsite|site|document|dokument|report|bericht|paper|file|datei|html|reveal\.?js|dashboard|chart|diagram|diagramm|brochure|flyer|poster|pdf|docx|pptx)\b/.test(t);
}

const ARTIFACT_NOUN_RE =
  /\b(presentation|pr[äa]sentation|slides?|slide deck|folien|foliensatz|deck|website|web ?site|webseite|webpage|web ?page|landing ?page|microsite|document|dokument|report|bericht|paper|file|datei|index\.html|html|reveal\.?js|dashboard|chart|diagram|diagramm|brochure|flyer|poster|pdf|docx|pptx|artifact|artefakt)\b/i;

/**
 * Broader than {@link looksLikeArtifactCreationRequest}: the turn asks to CREATE *or* CHANGE
 * a concrete artifact (update / edit / insert into / add to / embed in / replace). Used to
 * scope the false-completion guard so a "füge die Bilder in die Präsentation ein" (modify)
 * request is covered, not just "erstelle eine Präsentation" (create). Topic-agnostic.
 */
export function looksLikeArtifactMutationRequest(userMessage: string): boolean {
  if (looksLikeArtifactCreationRequest(userMessage)) return true;
  const t = (userMessage ?? "").toLowerCase();
  const hasMutateVerb =
    /\b(update|updated|edit|modify|change|revise|adjust|insert|add|append|embed|replace|fix|aktualisiere?|aktualisier|ändere?|änder|bearbeite?|bearbeit|überarbeite?|überarbeit|ergänze?|ergänz|einf[üu]gen|einf[üu]ge|f[üu]ge|hinzuf[üu]gen|hinzuf[üu]ge|einbette?|einbinden|einbinde|ersetze?|ersetz)\b/.test(t);
  if (!hasMutateVerb) return false;
  return ARTIFACT_NOUN_RE.test(t);
}

/**
 * The answer ASSERTS, as a completed fact, that it created/updated/saved/inserted the
 * artifact — yet the caller only invokes this when NO artifact was produced this turn, so a
 * match means a FALSE "I updated the presentation" claim (audit 14661623 turn 2: the run
 * gathered image URLs, never rebuilt the deck, but said "Die Bilder wurden eingefügt …
 * URLs überprüft"). Clause-scoped so a negated, honest "I did NOT update the deck" is not
 * flagged. Structural + bilingual; needs a completion verb AND an artifact noun in the SAME
 * clause, with no negation in that clause.
 */
export function claimsArtifactWrittenButUnproduced(value: string): boolean {
  const text = value ?? "";
  if (!text.trim()) return false;
  const claimVerb =
    /(eingef[üu]gt|eingebettet|aktualisiert|erstellt|gespeichert|hinzugef[üu]gt|geändert|überarbeitet|ergänzt|integriert|eingebunden|ersetzt|inserted|embedded|updated|created|saved|added|modified|written|generated|built|produced)/i;
  const negation =
    /(\bnicht\b|\bkein|\bniemals\b|\bohne\b|\bnot\b|\bnever\b|couldn'?t|could ?not|cannot|can'?t|\bno\b|\bunable\b|konnte)/i;
  // Split into clauses so a negated clause ("… wurde NICHT geändert") can't trip the claim.
  for (const clause of text.split(/[.!?\n;:]+/)) {
    if (claimVerb.test(clause) && ARTIFACT_NOUN_RE.test(clause) && !negation.test(clause)) return true;
  }
  return false;
}

/**
 * Heuristic: the answer INLINES a full artifact (a complete HTML document, or a large
 * fenced code block carrying the whole deliverable) instead of it being a real workspace
 * file. On a source-sensitive artifact-creation turn that produced NO artifact, this is the
 * model hand-writing the deliverable from training data and passing it off as the result
 * (audit 453a263e: after the build was stopped, synthesis pasted a multi-KB reveal.js deck
 * — fabricated, falsely "verified"). Structural only: full-document markers or a big code
 * fence; format-agnostic, no topic terms. The caller scopes this to the no-artifact case.
 */
export function looksLikeInlinedArtifactFabrication(value: string): boolean {
  const v = value ?? "";
  if (v.length < 1500) return false;
  // A complete HTML/XML document inlined into the answer.
  if (/<!DOCTYPE\s+html/i.test(v) && /<\/html>/i.test(v)) return true;
  if (/```[a-z]*\s*<!DOCTYPE\s+html/i.test(v)) return true;
  if (/```[a-z]*\s*<html[\s>]/i.test(v)) return true;
  // The whole deliverable pasted as one large fenced code block rather than written to a file.
  const fences = v.match(/```[\s\S]*?```/g);
  if (fences && fences.some((f) => f.length >= 1500)) return true;
  return false;
}

function buildResearchGatheredFallback(curatedEvidence: string | null): string {
  const head = [
    "Ich konnte das angeforderte Artefakt (z. B. die HTML-Datei) in diesem Lauf nicht fertigstellen. "
    + "Die Inhalte wurden jedoch recherchiert und mit Quellen belegt — bestätige bitte, dann lasse ich die Datei vom zuständigen Spezialisten erstellen.",
    "I couldn't finish the requested artifact (e.g. the HTML file) this turn, but the content was researched and sourced — confirm and I'll have the content specialist build the file.",
  ].join("\n\n");
  const curated = curatedEvidence?.trim();
  if (curated) {
    return `${head}\n\n## Recherchierte Fakten & Quellen / Researched facts & sources\n\n${formatSharedFactsRecoveryForUserDisplay(curated)}`;
  }
  return head;
}

function compactSourceSensitiveEvidenceForDisplay(evidence: string): string {
  const lines = evidence
    .split("\n")
    .map((rawLine) => rawLine.trim())
    .filter(Boolean)
    .map((rawLine) => {
      let line = rawLine
        .replace(/^-\s+auto_[a-z0-9_]+:\s*/i, "- ")
        .replace(/\s*###\s*Page state\b[\s\S]*$/i, "")
        .replace(/\s*Page Snapshot:\s*[\s\S]*$/i, "")
        .replace(/```[\s\S]*?```/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (line.length > 900) line = `${line.slice(0, 897)}...`;
      return line;
    })
    .filter((line) => !looksLikeOrchestrationOnlyEvidence(line))
    // Drop raw PDF bytes / bare HTTP-probe lines — never show binary or
    // header-only junk to the user as "evidence".
    .filter((line) => !isJunkEvidenceValue(line))
    .filter((line) => line.length > 0);
  return lines.join("\n").trim() || "In diesem Lauf wurde keine verwertbare fachliche Evidenz erzeugt.";
}

export function formatSourceSensitiveEvidenceBackstop(evidence: string): string {
  const compactEvidence = compactSourceSensitiveEvidenceForDisplay(evidence);
  return [
    "Die bisher belastbare Evidenz aus diesem Lauf:",
    compactEvidence,
    "Alle übrigen angefragten Aussagen bleiben unverifiziert oder unvollständig, bis eine erfolgreiche Quellenrecherche vorliegt.",
  ].join("\n\n");
}

function sourceSensitiveEvidenceTokens(evidence: string): string[] {
  const stopwords = new Set([
    "about", "after", "agent", "available", "before", "completed", "content", "current", "evidence", "fetch", "finding", "from", "generic", "matched", "observed", "official", "output", "partial", "progress", "research", "result", "source", "state", "strongly", "task", "title", "tools", "url", "with",
    "alle", "aus", "bisher", "bleiben", "diesem", "diese", "evidenz", "lauf", "quelle", "quellen", "recherche", "unvollstaendig", "unverifiziert", "wurde",
  ]);
  const tokens = new Set<string>();
  for (const match of evidence.matchAll(/[A-Za-z0-9][A-Za-z0-9._/-]{3,}/g)) {
    const token = match[0]!.toLowerCase();
    if (stopwords.has(token)) continue;
    if (/^https?:\/\//i.test(token)) {
      try {
        tokens.add(new URL(match[0]!).hostname.replace(/^www\./i, "").toLowerCase());
      } catch {
        tokens.add(token.slice(0, 80));
      }
      continue;
    }
    if (/^[a-z]{1,2}\d+$/i.test(token)) continue;
    tokens.add(token.slice(0, 80));
  }
  return [...tokens].slice(0, 80);
}

function looksEvidenceAnchored(sourceSensitiveDraft: string, evidence: string): boolean {
  const normalizedDraft = sourceSensitiveDraft.toLowerCase();
  if (normalizedDraft.length < 120) return false;
  const anchors = sourceSensitiveEvidenceTokens(evidence);
  if (anchors.length === 0) return false;
  let hits = 0;
  for (const anchor of anchors) {
    if (normalizedDraft.includes(anchor)) hits += 1;
    if (hits >= Math.min(3, anchors.length)) return true;
  }
  return false;
}

/**
 * QA evidence-anchoring decision (gated by orchestration.qaEvidenceAnchoring).
 * True when a source-sensitive answer that shipped on the SUCCESS path (the
 * failure-path backstop never fired) should be re-grounded: there ARE usable
 * curated findings, the answer is substantial, yet it references none of the
 * verified tokens — i.e. the model likely answered from training data while the
 * run's verified facts sit unused in shared findings. Pure + exported for tests.
 */
export function answerNeedsEvidenceAnchoringRepair(
  finalResponse: string,
  evidence: string | null | undefined,
): boolean {
  if (!evidence) return false;
  if (looksLikeWeakRecoveryEvidence(evidence)) return false;
  const draft = stripPresentationFormatting(finalResponse).trim();
  if (draft.length <= 200) return false;
  return !looksEvidenceAnchored(draft, evidence);
}

async function synthesizeSourceSensitiveEvidenceBackstop(
  session: AgentSession,
  provider: ChatProvider,
  signal: AbortSignal,
  evidence: string,
): Promise<string | null> {
  const instruction = [
    "SOURCE-SENSITIVE RECOVERY SYNTHESIS:",
    "The prior delegation failed or timed out, but the evidence below was recovered. Answer the user in German using ONLY this recovered evidence and shared findings.",
    "Do not invent missing manufacturer, interface, protocol, pricing, layout, BOM, or product claims. If a requested section is not supported by the evidence, mark it as unverifiziert/unvollstaendig.",
    "Do not dump raw page snapshots or tool traces. Convert supported evidence into a concise useful partial answer with: 1) Verifiziert, 2) Noch nicht belegt, 3) Naechster sinnvoller Recherche-Schritt.",
    "Recovered evidence:",
    evidence.trim(),
  ].join("\n");
  const synthesized = await forceSynthesis(session, provider, signal, instruction);
  if (!synthesized) return null;
  const cleaned = stripPresentationFormatting(synthesized).trim();
  if (!looksEvidenceAnchored(cleaned, evidence)) return null;
  if (/\b(VendorX|I2S-only)\b/i.test(cleaned) && !/\b(VendorX|I2S-only)\b/i.test(evidence)) return null;
  return cleaned;
}

function looksLikeWeakRecoveryEvidence(evidence: string): boolean {
  const trimmed = evidence.trim();
  if (!trimmed) return true;
  if (looksLikeRawWorkspaceToolDump(trimmed)) return true;
  if (/^Sub-agent '[^']+' timed out/i.test(trimmed)) return true;
  if (/Partial progress before interruption:/i.test(trimmed)) return true;
  if (/^Recovered evidence snippets from completed tools:/im.test(trimmed)) return true;
  if (/^(?:-\s*)?(?:search_agents|search_workflows)\s+\[partial\]/im.test(trimmed)) return true;
  if (/No (?:agents|workflows) matched/i.test(trimmed)) return true;
  if (looksLikeDelegationTaskEcho(trimmed)) return true;
  return false;
}

export function chooseBetterRecoveryEvidence(
  delegateEvidence: { evidence: string; itemCount: number } | null,
  sharedFactsEvidence: { evidence: string; itemCount: number } | null,
  options?: { preferHigherScore?: boolean },
): { evidence: string; itemCount: number } | null {
  if (!delegateEvidence) return sharedFactsEvidence;
  if (looksLikeWeakRecoveryEvidence(delegateEvidence.evidence)) {
    return sharedFactsEvidence;
  }
  // A delegate "evidence" blob that is mostly raw tool junk (PDF bytes, HTTP
  // probes) must not win on length over concise curated findings — that is what
  // shipped %PDF garbage instead of the verified specs the swarm had gathered.
  if (sharedFactsEvidence && evidenceIsMostlyJunk(delegateEvidence.evidence)) {
    return sharedFactsEvidence;
  }
  if (!sharedFactsEvidence) return delegateEvidence;

  if (options?.preferHigherScore === false) {
    return delegateEvidence;
  }

  const delegateScore = delegateEvidence.evidence.length + (delegateEvidence.itemCount * 200);
  const sharedScore = sharedFactsEvidence.evidence.length + (sharedFactsEvidence.itemCount * 200);
  return sharedScore > delegateScore ? sharedFactsEvidence : delegateEvidence;
}

function defaultResearchFallbackAgentsFor(agentName: string | undefined, guidance: DynamicTurnGuidance | null | undefined): string[] {
  const preferredAgents = guidance?.freshnessSensitive && !guidance?.sourceSensitive
    ? ["web_task_coordinator", "researcher", "mission_coordinator"]
    : ["mission_coordinator", "researcher"];
  return preferredAgents
    .filter((candidate) => candidate !== agentName)
    .filter((candidate) => chooseConfiguredAgent([candidate]) === candidate);
}

function withDefaultResearchFallbackAgents(
  args: Record<string, unknown>,
  guidance: DynamicTurnGuidance | null | undefined,
): Record<string, unknown> {
  const agentName = typeof args["agentName"] === "string" ? String(args["agentName"]).trim() : undefined;
  if (!agentName) return args;
  const existingFallbacks = Array.isArray(args["fallbackAgents"])
    ? args["fallbackAgents"].map(String).filter(Boolean)
    : [];
  if (existingFallbacks.length > 0) return args;
  const fallbackAgents = defaultResearchFallbackAgentsFor(agentName, guidance);
  return fallbackAgents.length > 0 ? { ...args, fallbackAgents } : args;
}

function stripUntrustedDelegationContext(args: Record<string, unknown>): Record<string, unknown> {
  if (!("context" in args)) return args;
  const nextArgs = { ...args };
  delete nextArgs["context"];
  return nextArgs;
}

function looksLikeTransparentIncompleteReport(text: string): boolean {
  const normalized = text.toLowerCase();
  return /\b(partial|incomplete|failed|failure|blocked|timed out|timeout|could not|unable|unverified|missing evidence|attempted)\b/.test(normalized);
}

function isBroadSourceSensitiveAdvisoryRequest(userMessage: string): boolean {
  const normalized = userMessage.trim().toLowerCase();
  if (!normalized) return false;

  let signals = 0;
  if (PRODUCT_RECOMMENDATION_PATTERNS.some((pattern) => pattern.test(normalized))) signals += 1;
  if (/\b(layout|wiring|schematic|verdrahtung|schaltplan|connect(?:ion)?|put all of it together|zusammenbauen|zusammenstecken)\b/i.test(normalized)) signals += 1;
  if (/\b(what else do i need|what do i need|bom|bill of materials|parts list|st[üu]ckliste|bauteilliste|battery|usb-c|charger|charging module|buttons?)\b/i.test(normalized)) signals += 1;
  if (/\b(improvement|improvements|improve|best quality|quality for transcription|transcription quality|verbesser(?:ung|ungen|e|n)?|beste qualit[äa]t)\b/i.test(normalized)) signals += 1;
  if ((normalized.match(/\n/g) ?? []).length >= 4) signals += 1;

  return signals >= 2;
}

export function hasRecentSourceSensitivePartialDelegation(
  history: readonly { role: string; content?: string | null; metadata?: Record<string, unknown> }[],
): boolean {
  const recent = [...history].reverse().slice(0, 12);

  for (const message of recent) {
    if (message.role !== "tool") continue;
    const content = String(message.content ?? "");
    const meta = message.metadata ?? {};
    if (!DELEGATE_TOOL_RESULT_RE.test(content) && !looksLikeDelegateMetadata(meta)) continue;

    const delegationOutcome = typeof meta["delegationOutcome"] === "string"
      ? String(meta["delegationOutcome"]).toLowerCase()
      : "";

    if (delegationOutcome === "failure") return true;
    // Any PARTIAL outcome means the swarm did not fully cover the request, so the
    // curated shared findings must ground the final synthesis — regardless of
    // terminalState. A coordinator that synthesizes after its inner researchers time
    // out reports outcome "partial" with terminalState "completed"; the old list
    // (timeout/max_iterations/cancelled/empty) excluded that case, so the backstop
    // never fired and a confident training-data answer shipped that CONTRADICTED the
    // verified finding (audit 1ba15cb5: shared finding = IM73A135V01 is analog; the
    // answer said "digital PDM").
    if (delegationOutcome === "partial") return true;
  }

  return false;
}

function hasRecentSparseSourceSensitiveMemoryReuse(
  history: readonly { role: string; content?: string | null; metadata?: Record<string, unknown> }[],
  userMessage: string,
): boolean {
  if (!isBroadSourceSensitiveAdvisoryRequest(userMessage)) return false;

  const recent = [...history].reverse().slice(0, 12);

  for (const message of recent) {
    if (message.role !== "tool") continue;
    const content = String(message.content ?? "");
    const meta = message.metadata ?? {};
    if (!DELEGATE_TOOL_RESULT_RE.test(content) && !looksLikeDelegateMetadata(meta)) continue;

    const reusedFromSessionMemory = meta["reusedFromSessionMemory"] === true;
    const factCount = typeof meta["factCount"] === "number" ? Number(meta["factCount"]) : 0;
    const partialCount = typeof meta["partialCount"] === "number" ? Number(meta["partialCount"]) : 0;
    if (reusedFromSessionMemory && factCount > 0 && factCount <= 3 && partialCount === 0) {
      return true;
    }
  }

  return false;
}

/** Lightweight German detection to localize the unverified-answer caveat. */
function answerLooksGerman(text: string): boolean {
  const t = text.toLowerCase();
  if (/[äöüß]/.test(t)) return true;
  return /\b(ich|und|der|die|das|nicht|mit|für|oder|eine?|brauche|möchte|wie|was|kann|mir|dein|deine|ist|sind)\b/.test(t);
}

/**
 * Prepend a clear "unverified" banner to a source-sensitive answer that was
 * produced WITHOUT any research evidence (the model declined to delegate after
 * the research nudge, so no web/tool evidence backs it). This keeps the useful
 * general guidance but stops the swarm from presenting pre-assumptions — part
 * numbers, specs, prices, manufacturers — as confirmed facts. Regression:
 * session f59f85f5 (2026-05-29) shipped a wall of invented part numbers.
 */
export function prependUnverifiedSourceCaveat(answer: string, userMessage: string): string {
  if (answer.includes("NICHT mit aktuellen Online-Quellen") || answer.includes("NOT verified against live web sources")) {
    return answer;
  }
  const german = answerLooksGerman(userMessage) || answerLooksGerman(answer);
  const caveat = german
    ? "> ⚠️ **Ungeprüft:** Diese Antwort beruht auf allgemeinem Wissen und wurde NICHT mit aktuellen Online-Quellen verifiziert. Behandle konkrete Teilenummern, Spezifikationen, Preise und Herstellerangaben als unbestätigte Annahmen, die vor dem Verlass darauf noch zu prüfen sind."
    : "> ⚠️ **Unverified:** This answer is based on general knowledge and was NOT verified against live web sources. Treat specific part numbers, specifications, prices, and manufacturer claims as unconfirmed assumptions to verify before relying on them.";
  return `${caveat}\n\n${answer}`;
}

/** Pull the prior turn's topic + answer from history so a contextless follow-up
 *  ("validate your response") can be delegated with the real subject folded in. */
function extractPriorTurnContext(
  history: readonly SessionHistoryMessage[],
  currentMessage: string,
): { priorUserRequest?: string; priorAssistantAnswer?: string } {
  const current = currentMessage.trim();
  let priorAssistantAnswer: string | undefined;
  let priorUserRequest: string | undefined;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i]!;
    const content = typeof message.content === "string" ? message.content.trim() : "";
    const hasToolCalls = Array.isArray((message as { tool_calls?: unknown[] }).tool_calls)
      && (((message as { tool_calls?: unknown[] }).tool_calls?.length ?? 0) > 0);
    if (!priorAssistantAnswer && message.role === "assistant" && content.length > 40 && !hasToolCalls) {
      priorAssistantAnswer = content;
    }
    if (!priorUserRequest && message.role === "user" && content && content !== current) {
      priorUserRequest = content;
    }
    if (priorAssistantAnswer && priorUserRequest) break;
  }
  return { priorUserRequest, priorAssistantAnswer };
}

/**
 * True when a final answer is substantially a verbatim copy of an EARLIER
 * assistant turn. On a turn where every tool call was blocked (no successful work
 * happened), this means the model gave up and parroted a previous deliverable
 * summary — shipping a stale FALSE SUCCESS that implies the user's new request was
 * carried out when it was not (audit 43b3ec65 turn 3: "update the presentation and
 * add the sources" shipped a verbatim copy of the turn-1 "presentation created"
 * summary — no edit, no sources). Scans EVERY prior assistant answer, not just the
 * most recent, because the parroted turn may be several turns back. A shared
 * 180-char normalized leading slice is a near-certain duplication signal; genuinely
 * distinct answers do not coincidentally share that much text. Topic-agnostic.
 */
function leadingContentTokenSet(normalized: string): Set<string> {
  // First ~80 word tokens of the leading slice, Unicode-aware so German umlaut
  // words ("präsentation", "zerstörung") stay intact (\w would shred them).
  return new Set(
    normalized.slice(0, 600).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 2).slice(0, 80),
  );
}

export function looksLikeRegurgitatedPriorAnswer(
  candidate: string,
  history: readonly SessionHistoryMessage[],
): boolean {
  const norm = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();
  const cand = norm(candidate);
  if (cand.length < 180) return false;
  const candHead = cand.slice(0, 180);
  const candTokens = leadingContentTokenSet(cand);
  for (const message of history) {
    if (message.role !== "assistant") continue;
    const hasToolCalls = Array.isArray((message as { tool_calls?: unknown[] }).tool_calls)
      && (((message as { tool_calls?: unknown[] }).tool_calls?.length ?? 0) > 0);
    if (hasToolCalls) continue;
    const prior = typeof message.content === "string" ? norm(message.content) : "";
    if (prior.length < 180) continue;
    // (a) Byte-exact leading slice — the original strict signal.
    if (prior.slice(0, 180) === candHead) return true;
    // (b) One leading slice fully contained in the other — catches a verbatim copy
    //     that merely gained or lost a short prefix (e.g. a "[content_writer]:"
    //     delegate tag, or a "## Zusammenfassung" header). Byte-exact prefix alone
    //     was too brittle: audit f6e10341 turn 3 re-pasted the turn-1 deck summary
    //     yet slipped past the exact check because the stored copy had drifted.
    if (prior.includes(candHead) || cand.includes(prior.slice(0, 180))) return true;
    // (c) High leading-token overlap — near-verbatim with small reordering/word drift
    //     (also survives history compaction, which can lightly reword the stored copy).
    if (candTokens.size >= 20) {
      const priorTokens = leadingContentTokenSet(prior);
      let inter = 0;
      for (const t of candTokens) if (priorTokens.has(t)) inter++;
      const union = new Set([...candTokens, ...priorTokens]).size;
      if (union > 0 && inter / union >= 0.9) return true;
    }
  }
  return false;
}

/**
 * True when a create_ephemeral_agent spec grants WRITE/artifact tools but no
 * web-reaching tools (web_search / web_fetch / browser_*). Such an agent renders
 * already-gathered evidence — it is NOT a researcher — so the source-sensitive
 * "WEB RESEARCH TASK — gather datasheets/sourcing/pricing" preamble must not be
 * injected into its task: that boilerplate both mis-frames the writer AND is the
 * exact trigger for the agent-factory research-capability gate, which then rejects
 * the writer for lacking web tools (audit 74e49d90: presentation_builder rejected,
 * artifact never built, turn shipped a raw evidence dump). Mirrors the gate's own
 * web-tool set (web_search/web_fetch/browser_*; url_inspect does not count).
 * Empty/omitted tools ⇒ inherits all (may include web) ⇒ do not skip.
 */
export function ephemeralAgentSpecLacksWebTools(args: Record<string, unknown>): boolean {
  const tools = Array.isArray(args["tools"])
    ? args["tools"].filter((t): t is string => typeof t === "string")
    : null;
  if (!tools || tools.length === 0) return false;
  return !tools.some((t) => /^web_search$/i.test(t) || /^web_fetch$/i.test(t) || /^browser_/i.test(t));
}

export function enforceSourceSensitiveOriginalRequestOnToolCall(
  toolCall: LLMResponse["tool_calls"][number],
  userMessage: string,
  guidance: DynamicTurnGuidance | null | undefined,
  sessionId: string,
  guardrailEvents: Array<{ type: string; details: string }>,
): void {
  if (!guidance?.sourceSensitive) return;
  // A source-sensitive task may still spawn a downstream WRITER to render the
  // gathered evidence into an artifact. Don't rewrite a write-only ephemeral
  // agent's task into a research-gather preamble — it would be rejected for
  // lacking web tools and the artifact would never be produced.
  if (toolCall.name === "create_ephemeral_agent" && ephemeralAgentSpecLacksWebTools(toolCall.arguments ?? {})) {
    return;
  }
  const originalArgs = toolCall.arguments ?? {};
  let nextArgs: Record<string, unknown> | null = null;

  if (toolCall.name === "delegate_to_agent" || toolCall.name === "swarm_delegate" || toolCall.name === "create_ephemeral_agent") {
    const originalTask = typeof originalArgs["task"] === "string" ? String(originalArgs["task"]) : "";
    const focus = deriveSourceSensitiveDelegationFocus(originalTask, userMessage);
    nextArgs = withDefaultResearchFallbackAgents(
      stripUntrustedDelegationContext({ ...originalArgs, task: buildSourceSensitiveOriginalRequestTask(userMessage, undefined, focus) }),
      guidance,
    );
  } else if (toolCall.name === "parallel_delegate") {
    const rawTasks = Array.isArray(originalArgs["tasks"])
      ? originalArgs["tasks"].filter((taskSpec): taskSpec is Record<string, unknown> => Boolean(taskSpec) && typeof taskSpec === "object")
      : [];
    if (rawTasks.length > 0) {
      nextArgs = {
        ...originalArgs,
        tasks: rawTasks.map((taskSpec, index) => withDefaultResearchFallbackAgents(
          stripUntrustedDelegationContext({
            ...taskSpec,
            task: buildSourceSensitiveOriginalRequestTask(
              userMessage,
              `SLICE ${index + 1}/${rawTasks.length}`,
              deriveSourceSensitiveDelegationFocus(typeof taskSpec["task"] === "string" ? String(taskSpec["task"]) : "", userMessage),
            ),
          }),
          guidance,
        )),
      };
    }
  } else if (toolCall.name === "run_task_graph") {
    const rawNodes = Array.isArray(originalArgs["nodes"])
      ? originalArgs["nodes"].filter((node): node is Record<string, unknown> => Boolean(node) && typeof node === "object")
      : [];
    if (rawNodes.length > 0) {
      nextArgs = {
        ...originalArgs,
        objective: userMessage,
        nodes: rawNodes.map((node, index) => withDefaultResearchFallbackAgents(
          stripUntrustedDelegationContext({
            ...node,
            task: buildSourceSensitiveOriginalRequestTask(
              userMessage,
              `GRAPH NODE ${index + 1}/${rawNodes.length}`,
              deriveSourceSensitiveDelegationFocus(typeof node["task"] === "string" ? String(node["task"]) : "", userMessage),
            ),
          }),
          guidance,
        )),
      };
    }
  }

  if (!nextArgs || stableSerialize(nextArgs) === stableSerialize(originalArgs)) return;
  toolCall.arguments = nextArgs;
  guardrailEvents.push({ type: "delegation_required", details: `${toolCall.name}:source_sensitive_original_request_enforced` });
  logAudit("tool_call_recovered", {
    originalTool: toolCall.name,
    rewrittenTo: toolCall.name,
    reason: "source_sensitive_original_request_enforced",
  }, { sessionId, severity: "info" });
}

function collapseDuplicateToolCallsInResponse(
  toolCalls: LLMResponse["tool_calls"],
  sessionId: string,
  guardrailEvents: Array<{ type: string; details: string }>,
): LLMResponse["tool_calls"] {
  const seenFingerprints = new Set<string>();
  const filtered: LLMResponse["tool_calls"] = [];

  for (const toolCall of toolCalls) {
    const fingerprint = `${toolCall.name}|${stableSerialize(toolCall.arguments ?? {})}`;
    if (seenFingerprints.has(fingerprint)) {
      logAudit("tool_call_blocked", {
        tool: toolCall.name,
        reason: "duplicate_same_response",
        args: toolCall.arguments,
      }, {
        sessionId,
        severity: "warn",
      });
      guardrailEvents.push({ type: "tool_blocked", details: `${toolCall.name}:duplicate_same_response` });
      continue;
    }

    seenFingerprints.add(fingerprint);
    filtered.push(toolCall);
  }

  return filtered;
}

function collapseExcessDirectDelegationsInResponse(
  toolCalls: LLMResponse["tool_calls"],
  sessionId: string,
  guardrailEvents: Array<{ type: string; details: string }>,
): LLMResponse["tool_calls"] {
  let seenDirectDelegation = false;
  const filtered: LLMResponse["tool_calls"] = [];

  for (const toolCall of toolCalls) {
    if (toolCall.name !== "delegate_to_agent") {
      filtered.push(toolCall);
      continue;
    }

    if (!seenDirectDelegation) {
      seenDirectDelegation = true;
      filtered.push(toolCall);
      continue;
    }

    logAudit("tool_call_blocked", {
      tool: toolCall.name,
      reason: "multiple_direct_delegations_same_response",
      args: toolCall.arguments,
    }, {
      sessionId,
      severity: "warn",
    });
    guardrailEvents.push({ type: "tool_blocked", details: `${toolCall.name}:multiple_direct_delegations_same_response` });
  }

  return filtered;
}

const ORCHESTRATION_LAUNCHER_TOOL_NAMES = new Set([
  "delegate_to_agent",
  "parallel_delegate",
  "run_task_graph",
  "run_workflow",
  "create_ephemeral_agent",
]);
const PERSISTED_SWARM_STATE_TOOL_NAMES = new Set([
  ...ORCHESTRATION_LAUNCHER_TOOL_NAMES,
  "swarm_delegate",
]);
const AGENT_DISCOVERY_TOOL_NAMES = new Set([
  "search_agents",
  "list_agents",
  "search_tools",
  "search_workflows",
]);

interface WorkflowCatalogMatch {
  name: string;
  workflowType: "scene" | "job";
  score: number;
  matchedTerms: string[];
}

interface WorkflowCatalogSignal {
  required: boolean;
  reason: "explicit_request" | "catalog_match" | "uncertain_match" | "hint_terms" | "none";
  strongestMatch?: WorkflowCatalogMatch;
  /** Plausible but unconfirmed candidates — used to ASK the user instead of forcing routing. */
  uncertainCandidates?: WorkflowCatalogMatch[];
}

interface ApprovedWorkflowFollowUp {
  workflowName: string;
  workflowType: "scene";
  params: Record<string, string>;
  candidateName: string;
}

const RUN_CANDIDATE_RE = /(?:^|\n)\s*RUN_CANDIDATE:\s*(.+?)\s*$/im;
const AFFIRMATIVE_WORKFLOW_APPROVAL_RE = /^\s*(?:yes|yeah|yep|sure|ok(?:ay)?|please do(?: that)?|do it|go ahead|run (?:it|that)|start (?:it|that)|ja|jep|klar|ja bitte|mach(?:\s+es)?|tu(?:\s+es)?|bitte(?:\s+(?:mach(?:\s+es)?|starte(?:\s+es)?|ausf(?:ü|ue)hren))?|starte(?:\s+es)?|ausf(?:ü|ue)hren(?:\s+bitte)?)\s*[.!?]*\s*$/i;

function extractRunCandidateName(content: string | null | undefined): string | null {
  if (typeof content !== "string" || content.length === 0) return null;
  const match = content.match(RUN_CANDIDATE_RE);
  if (!match) return null;

  const candidateName = match[1]?.trim().replace(/^["'`]+|["'`]+$/g, "") ?? "";
  return candidateName.length > 0 ? candidateName : null;
}

function parseToolCallArguments(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function detectApprovedRunCandidateFollowUp(
  history: readonly { role: string; content?: string | null; metadata?: Record<string, unknown>; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }[],
  userMessage: string,
): ApprovedWorkflowFollowUp | null {
  const normalizedMessage = userMessage.trim();
  if (!normalizedMessage || normalizedMessage.length > 80 || !AFFIRMATIVE_WORKFLOW_APPROVAL_RE.test(normalizedMessage)) {
    return null;
  }

  let foundCurrentUser = false;
  let candidateName: string | null = null;
  let sawProjectListWorkflow = false;

  for (let index = history.length - 1; index >= Math.max(0, history.length - 30); index -= 1) {
    const message = history[index];
    if (!message) continue;

    if (message.role === "user") {
      if (!foundCurrentUser) {
        foundCurrentUser = true;
        continue;
      }
      break;
    }

    if (!foundCurrentUser) continue;

    if (!candidateName) {
      candidateName = extractRunCandidateName(message.content) ?? candidateName;
    }

    if (message.role === "tool") {
      const workflowName = typeof message.metadata?.["workflowName"] === "string"
        ? String(message.metadata["workflowName"])
        : "";
      const workflowType = typeof message.metadata?.["workflowType"] === "string"
        ? String(message.metadata["workflowType"])
        : "";
      if (workflowName === "n8n_project_list" && workflowType === "scene") {
        sawProjectListWorkflow = true;
      }
    }

    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;

    for (const toolCall of message.tool_calls) {
      if (toolCall?.function?.name !== "run_workflow") continue;
      const args = parseToolCallArguments(toolCall.function.arguments);
      const workflowName = typeof args?.["name"] === "string" ? String(args["name"]) : "";
      const workflowType = typeof args?.["workflowType"] === "string" ? String(args["workflowType"]) : "auto";
      if (workflowName === "n8n_project_list" && (workflowType === "scene" || workflowType === "auto")) {
        sawProjectListWorkflow = true;
      }
    }
  }

  if (!candidateName || !sawProjectListWorkflow) return null;

  return {
    workflowName: "n8n_run_workflow",
    workflowType: "scene",
    params: {
      workflowName: candidateName,
    },
    candidateName,
  };
}

function buildApprovedRunCandidateGuidance(followUp: ApprovedWorkflowFollowUp): string {
  return [
    "Approved workflow follow-up detected for this turn.",
    `The previous n8n_project_list result ended with RUN_CANDIDATE: ${followUp.candidateName}.`,
    "The user just approved running that exact workflow.",
    `Call run_workflow now with name \"${followUp.workflowName}\", workflowType \"${followUp.workflowType}\", and params.workflowName \"${followUp.candidateName}\".`,
    "Do NOT call search_agents, search_workflows, delegate_to_agent, parallel_delegate, or run_task_graph first.",
    "Do NOT answer in natural language before issuing that run_workflow call.",
  ].join(" ");
}

function isApprovedRunCandidateToolCall(
  toolCall: { name: string; arguments?: Record<string, unknown> },
  followUp: ApprovedWorkflowFollowUp,
): boolean {
  if (toolCall.name !== "run_workflow") return false;

  const workflowName = typeof toolCall.arguments?.["name"] === "string"
    ? String(toolCall.arguments["name"])
    : "";
  const workflowType = typeof toolCall.arguments?.["workflowType"] === "string"
    ? String(toolCall.arguments["workflowType"])
    : "auto";
  const params = toolCall.arguments?.["params"];
  const workflowParamName = params && typeof params === "object" && !Array.isArray(params) && typeof (params as Record<string, unknown>)["workflowName"] === "string"
    ? String((params as Record<string, unknown>)["workflowName"])
    : "";

  return workflowName === followUp.workflowName
    && (workflowType === followUp.workflowType || workflowType === "auto")
    && workflowParamName.trim() === followUp.candidateName;
}

function extractWorkflowCatalogMatchesFromMetadata(metadata: Record<string, unknown> | undefined): WorkflowCatalogMatch[] {
  const rawMatches = metadata?.["workflowMatches"];
  if (!Array.isArray(rawMatches)) return [];

  return rawMatches
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const name = typeof record["name"] === "string" ? record["name"] : "";
      const workflowType = record["workflowType"] === "job" ? "job" : (record["workflowType"] === "scene" ? "scene" : null);
      const score = typeof record["score"] === "number" ? record["score"] : 0;
      const matchedTerms = Array.isArray(record["matchedTerms"])
        ? record["matchedTerms"].map(String).filter(Boolean)
        : [];
      if (!name || !workflowType) return null;
      return { name, workflowType, score, matchedTerms } satisfies WorkflowCatalogMatch;
    })
    .filter((match): match is WorkflowCatalogMatch => Boolean(match))
    .sort((left, right) => right.score - left.score);
}

function extractAgentRoutingSuggestionFromMetadata(
  metadata: Record<string, unknown> | undefined,
): { agentName: string; query?: string; fallbackAgents?: string[] } | undefined {
  const agentName = typeof metadata?.["topResult"] === "string"
    ? String(metadata["topResult"]).trim()
    : "";
  if (!agentName) return undefined;

  const query = typeof metadata?.["query"] === "string"
    ? String(metadata["query"]).trim()
    : "";
  const fallbackAgents = Array.isArray(metadata?.["suggestedFallbackAgents"])
    ? (metadata?.["suggestedFallbackAgents"] as unknown[])
      .map((value) => typeof value === "string" ? value.trim() : "")
      .filter((value): value is string => Boolean(value) && value !== agentName)
    : [];

  return {
    agentName,
    query: query || undefined,
    fallbackAgents: fallbackAgents.length > 0 ? fallbackAgents : undefined,
  };
}

function searchAgentsReturnedNoMatch(metadata: Record<string, unknown> | undefined): boolean {
  const resultCount = typeof metadata?.["resultCount"] === "number" ? metadata["resultCount"] : 0;
  const topResult = typeof metadata?.["topResult"] === "string" ? metadata["topResult"].trim() : "";
  return resultCount === 0 && !topResult;
}

function chooseConfiguredAgent(candidates: readonly string[]): string | undefined {
  const configuredAgents = getConfig().subAgents ?? {};
  return candidates.find((name) => name in configuredAgents);
}

type RequiredResearchFallbackRoute = {
  toolName: "delegate_to_agent" | "create_ephemeral_agent";
  args: Record<string, unknown>;
  label: string;
};

export function buildRequiredResearchFallbackRoute(
  userMessage: string,
  guidance: DynamicTurnGuidance | null | undefined,
  allowedToolNameSet: Set<string>,
  allowedAgents?: string[] | null,
): RequiredResearchFallbackRoute | null {
  // De-layer single-domain research: a coordinator only earns its extra hop when
  // the task genuinely spans multiple areas (Anthropic/Cognition consensus).
  // Otherwise route straight to the researcher specialist. Freshness single-shot
  // lookups keep web_task_coordinator (its purpose-built lane).
  const multiDomain = looksMultiDomainResearch(userMessage);
  const basePreference = guidance?.freshnessSensitive && !guidance?.sourceSensitive
    ? ["web_task_coordinator", "researcher", "mission_coordinator"]
    : (multiDomain ? ["mission_coordinator", "researcher"] : ["researcher", "mission_coordinator"]);
  // Inside a scoped scene/job step the session restricts which agents may run. Routing
  // to an agent outside that set hard-fails ("not permitted in this scene"), so respect
  // it: keep only allowed preferences, and when none of the default research agents are
  // allowed, fall back to the step's OWN allowed agents (the step task names them — e.g.
  // an image step's only agent is image_sourcer). Unrestricted turns keep the old list.
  const allowSet = allowedAgents && allowedAgents.length > 0 ? new Set(allowedAgents) : null;
  const preferredAgents = allowSet
    ? (basePreference.filter((name) => allowSet.has(name)).concat(allowedAgents!.filter((name) => !basePreference.includes(name))))
    : basePreference;
  if (preferredAgents.length === 0) return null;
  const selectedAgent = chooseConfiguredAgent(preferredAgents) ?? preferredAgents[0]!;
  const fallbackAgents = preferredAgents.filter((agentName) => agentName !== selectedAgent && chooseConfiguredAgent([agentName]));

  if (allowedToolNameSet.has("delegate_to_agent")) {
    return {
      toolName: "delegate_to_agent",
      label: selectedAgent,
      args: {
        agentName: selectedAgent,
        fallbackAgents,
        task: userMessage,
      },
    };
  }

  if (allowedToolNameSet.has("create_ephemeral_agent")) {
    return {
      toolName: "create_ephemeral_agent",
      label: "ephemeral_research_specialist",
      args: {
        agentName: "ephemeral_research_specialist",
        description: "Purpose-built specialist for source-grounded research and product/component verification.",
        systemPrompt: [
          "You are a source-grounded research specialist.",
          "Use web_search and web_fetch to gather evidence before answering.",
          "Return concise findings with source URLs and be explicit about uncertainty.",
          "Do not invent product names, specifications, or artifact paths.",
        ].join(" "),
        tools: ["web_search", "web_fetch", "read_shared_facts", "share_finding"],
        maxIterations: 5,
        // Leaf sub-agents default to `subAgentTurnSloMs` (60 s), which is far
        // too short for a research specialist doing 5 web_search iterations.
        // Grant 5 minutes — the same budget as the configured researcher agent.
        timeoutMs: 300_000,
        task: userMessage,
      },
    };
  }

  return null;
}

function buildSearchAgentsNoMatchFallbackPrompt(route: RequiredResearchFallbackRoute): string {
  if (route.toolName === "delegate_to_agent") {
    const fallbackAgents = Array.isArray(route.args["fallbackAgents"]) ? route.args["fallbackAgents"].map(String).filter(Boolean) : [];
    return [
      "ROUTING FALLBACK: search_agents returned no usable specialist candidates for this source-sensitive request.",
      "Do NOT call search_agents or list_agents again in this turn.",
      `You MUST call delegate_to_agent now with agentName="${route.label}"${fallbackAgents.length ? ` and fallbackAgents=[${fallbackAgents.map((name) => `"${name}"`).join(",")}]` : ""} using the original user request as the task.`,
      "A further discovery-only response is invalid; delegation must happen before any final answer.",
    ].join(" ");
  }

  return [
    "ROUTING FALLBACK: search_agents returned no usable specialist candidates for this source-sensitive request.",
    "Do NOT call search_agents or list_agents again in this turn.",
    "You MUST call create_ephemeral_agent now using the provided research-specialist shape and the original user request as the task.",
    "A further discovery-only response is invalid; orchestration must happen before any final answer.",
  ].join(" ");
}

function enforceRequiredResearchFallbackRouteOnToolCall(
  toolCall: LLMResponse["tool_calls"][number],
  route: RequiredResearchFallbackRoute,
  sessionId: string,
  guardrailEvents: Array<{ type: string; details: string }>,
): void {
  const discoveryRetryTools = new Set(["search_agents", "list_agents", "search_workflows"]);
  const shouldRewriteDiscoveryRetry = discoveryRetryTools.has(toolCall.name);
  const shouldEnforceCanonicalRouteArgs = toolCall.name === route.toolName;
  if (!shouldRewriteDiscoveryRetry && !shouldEnforceCanonicalRouteArgs) return;

  const originalTool = toolCall.name;
  const originalArgs = toolCall.arguments ?? {};
  const routeArgs = { ...route.args };
  const changed = originalTool !== route.toolName || stableSerialize(originalArgs) !== stableSerialize(routeArgs);
  if (!changed) return;

  toolCall.name = route.toolName;
  toolCall.arguments = routeArgs;
  guardrailEvents.push({ type: "delegation_required", details: "required_research_original_task_enforced" });
  logAudit("tool_call_recovered", {
    originalTool,
    rewrittenTo: route.toolName,
    reason: shouldRewriteDiscoveryRetry
      ? "required_research_discovery_retry_rewritten"
      : "required_research_original_task_enforced",
    recoveredAgentName: route.label,
  }, { sessionId, severity: shouldRewriteDiscoveryRetry ? "warn" : "info" });
}

function isExplicitAgentCatalogRequest(message: string): boolean {
  return /\b(list|show|display|print|enumerate|inspect|browse|catalog|catalogue|katalog|liste|auflisten|anzeigen)\b[\s\S]{0,80}\b(agents?|sub[- ]?agents?|specialists?|spezialisten|agenten|catalog|catalogue|katalog)\b/i.test(message)
    || /\b(agents?|sub[- ]?agents?|specialists?|spezialisten|agenten|catalog|catalogue|katalog)\b[\s\S]{0,80}\b(list|show|display|print|enumerate|inspect|browse|liste|auflisten|anzeigen)\b/i.test(message);
}

function mergeWorkflowCatalogMatches(...groups: WorkflowCatalogMatch[][]): WorkflowCatalogMatch[] {
  const merged = new Map<string, WorkflowCatalogMatch>();

  for (const group of groups) {
    for (const match of group) {
      const key = `${match.workflowType}:${match.name}`;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, {
          ...match,
          matchedTerms: [...match.matchedTerms],
        });
        continue;
      }

      merged.set(key, {
        ...existing,
        score: Math.max(existing.score, match.score),
        matchedTerms: [...new Set([...existing.matchedTerms, ...match.matchedTerms])],
      });
    }
  }

  return [...merged.values()].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.matchedTerms.length !== left.matchedTerms.length) return right.matchedTerms.length - left.matchedTerms.length;
    return left.name.localeCompare(right.name);
  });
}

export function shouldRequireWorkflowExecutionAfterSearch(matches: WorkflowCatalogMatch[]): boolean {
  const topMatch = matches[0];
  if (!topMatch) return false;
  // Only FORCE a workflow run when the match is genuinely strong. The
  // search_workflows tool surfaces candidates at a low floor (>=0.18) as a
  // discovery aid, but hard-forcing run_workflow on a weak/incidental match
  // (e.g. an unrelated DB-analysis job scoring 0.24 on two generic terms like
  // "inspection"/"analysis") deadlocks the turn: the model rightly refuses the
  // irrelevant workflow, produces nothing, and the user gets an empty answer.
  //
  // With keyword overlap the user's own words land in the workflow signature,
  // so a moderate score is a real signal.
  const hasKeywordOverlap = topMatch.matchedTerms.length > 0;
  if (hasKeywordOverlap) {
    return topMatch.score >= 0.5 || (topMatch.matchedTerms.length >= 3 && topMatch.score >= 0.3);
  }
  // Pure-semantic matches with NO keyword overlap need a much higher bar.
  // Embedding similarity routinely produces 0.5–0.7 for unrelated topics
  // (session b15e2099 forced apply_jobs at 0.65 against an unrelated
  // CPSA-F learning-website request and burned 12 minutes of browser
  // automation). Only force on a strong semantic-only match.
  return topMatch.score >= 0.78;
}

function formatWorkflowExecutionPromptFromSearch(matches: WorkflowCatalogMatch[]): string {
  const topMatches = matches.slice(0, 3)
    .map((match) => `${match.name} [${match.workflowType}] (score ${match.score.toFixed(2)})`)
    .join(", ");

  return [
    "COMPLIANCE CORRECTION: search_workflows already returned reusable matches for this request.",
    topMatches ? `Returned matches: ${topMatches}.` : "",
    "Do NOT call search_workflows again, and do NOT switch to delegate_to_agent, parallel_delegate, run_task_graph, or direct answering yet.",
    "Call run_workflow now using the best returned workflow, or another returned match if it fits better.",
    "Only fall back to ad hoc delegation after a run_workflow attempt proves unsuitable or fails for a concrete reason.",
  ].filter(Boolean).join(" ");
}

function isWorkflowNameResolutionFailureMessage(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.includes("workflow not found:")
    || (normalized.includes("workflow name '") && normalized.includes("is ambiguous"));
}

function formatWorkflowExecutionCorrectionPromptFromSearch(matches: WorkflowCatalogMatch[], lastError: string): string {
  const topMatches = matches.slice(0, 3)
    .map((match) => `${match.name} [${match.workflowType}]`)
    .join(", ");

  return [
    "COMPLIANCE CORRECTION: run_workflow used an invalid or ambiguous workflow name after search_workflows already returned reusable matches.",
    lastError ? `Last run_workflow error: ${lastError}` : "",
    topMatches ? `Use one of these exact returned workflow names: ${topMatches}.` : "",
    "Call run_workflow again now with the exact workflow name and workflowType from the returned catalog results.",
    "Do NOT call search_workflows again, do NOT call search_agents, and do NOT invent a new workflow name.",
  ].filter(Boolean).join(" ");
}

function isWorkflowCatalogToolName(toolName: string): boolean {
  return toolName === "search_workflows" || toolName === "run_workflow";
}

// ─── Workflow catalog detector (opt-in trigger model) ─────────────────────
//
// The previous detector scored token-overlap between the user message and a
// concatenated `name + description + task + params` blob for every scene/job.
// That design mis-fired constantly:
//   • pasted iptables/wireguard configs dominated tokenisation
//   • German function words (wir/ich/des/den/was/muss/tun) all looked like topic terms
//   • topic words (`cluster`, `wireguard`, `tunnel`) legitimately overlap with infra
//     scenes regardless of whether the user is asking how to *deploy* or how to *understand*
//   • substring matches like `"sim"` ⊂ `"simplify"` and `"site"` ⊂ `"call sites"`
//
// Replacement: scenes/jobs declare narrow opt-in triggers in their config.
// Three layered signals drive the guardrail now:
//   A. Explicit workflow request (e.g. "use the X scene", "run workflow Y") — already covered
//      by `WORKFLOW_REQUEST_PATTERNS`.
//   B. Author-declared triggers (`scene.triggers.patterns: [{ all: [regex, ...] }, ...]`).
//      An entry matches when ALL of its `all` regexes match the message; ANY entry → match.
//   C. Action-verb gate. Scenes marked `requiresActionVerb: true` only fire as a CONFIRMED
//      intent when the message also contains an imperative/action verb. Without one, the
//      match becomes an UNCERTAIN candidate — we ask the user instead of forcing routing.
//
// Anything without `triggers` is still discoverable via `search_workflows` by the LLM —
// it just no longer trips the guardrail on its own. This is intentional: false positives
// were dramatically worse than the recall loss on rare borderline phrasings.

/**
 * Action verbs (DE + EN) that signal the user wants something *done*, not
 * just explained. Used by `requiresActionVerb` triggers to distinguish
 * "wie konfiguriere ich X" (no verb of execution → uncertain) from
 * "konfiguriere X jetzt" (`konfiguriere` is action verb → confirmed).
 *
 * NOTE: imperative/infinitive forms only. Question words like "wie/was/wer"
 * and modal+verb constructions ("wie konfiguriere ich") legitimately contain
 * an action stem; we still want those to count as "uncertain" when no other
 * imperative verb is present, so the user gets asked instead of force-routed.
 */
const WORKFLOW_ACTION_VERB_PATTERN = new RegExp(
  "\\b(?:" + [
    // English imperatives
    "apply", "deploy", "rollout", "roll\\s*out", "run", "execute", "provision",
    "scale", "migrate", "install", "uninstall", "update", "upgrade", "configure",
    "setup", "set\\s*up", "spin\\s*up", "tear\\s*down", "restart", "reboot",
    "create", "build", "publish", "release", "ship",
    // German imperatives + verbal nouns
    "ausroll(?:en|e)?", "anwend(?:en|e)?", "umsetz(?:en|e)?", "provisionier(?:en|e)?",
    "skalier(?:en|e)?", "migrier(?:en|e)?", "installier(?:en|e)?", "deinstallier(?:en|e)?",
    "aktualisier(?:en|e)?", "upgrade(?:n|t)?", "starte(?:n)?", "neu\\s*starte(?:n)?",
    "richte\\s*ein", "einricht(?:en|e)?", "aufsetz(?:en|e)?", "anlegen", "erstell(?:en|e)?",
    "baue(?:n)?", "ver(?:o|oe|\u00f6)ffentlich(?:en|e)?", "ausf(?:u|ue|\u00fc)hr(?:en|e)?",
    "durchf(?:u|ue|\u00fc)hr(?:en|e)?", "einspiel(?:en|e)?", "auspielen",
  ].join("|") + ")\\b",
  "i",
);

interface WorkflowCatalogTriggerCandidate {
  name: string;
  workflowType: "scene" | "job";
  patternsCompiled: Array<RegExp[]>;
  requiresActionVerb: boolean;
}

function compileWorkflowTriggerEntries(): WorkflowCatalogTriggerCandidate[] {
  const out: WorkflowCatalogTriggerCandidate[] = [];

  const compileEntry = (
    name: string,
    workflowType: "scene" | "job",
    triggers: { patterns: { all: string[] }[]; requiresActionVerb?: boolean } | undefined,
  ): void => {
    if (!triggers || !Array.isArray(triggers.patterns) || triggers.patterns.length === 0) return;
    const patternsCompiled: RegExp[][] = [];
    for (const entry of triggers.patterns) {
      const compiled: RegExp[] = [];
      for (const raw of entry.all) {
        try {
          compiled.push(new RegExp(raw, "iu"));
        } catch (err) {
          log.warn({ err, name, workflowType, raw }, "Skipping invalid workflow trigger regex");
          compiled.length = 0;
          break;
        }
      }
      if (compiled.length > 0) patternsCompiled.push(compiled);
    }
    if (patternsCompiled.length === 0) return;
    out.push({
      name,
      workflowType,
      patternsCompiled,
      requiresActionVerb: triggers.requiresActionVerb === true,
    });
  };

  for (const scene of listAllScenes()) {
    compileEntry(scene.name, "scene", scene.triggers);
  }
  for (const job of listAllJobs()) {
    compileEntry(job.name, "job", job.catalogTriggers);
  }
  return out;
}

function detectWorkflowCatalogSignal(userMessage: string): WorkflowCatalogSignal {
  const trimmed = userMessage.trim();
  if (!trimmed) return { required: false, reason: "none" };

  const normalized = userMessage.toLowerCase();

  // Signal A: explicit workflow request — these are unambiguous.
  if (WORKFLOW_REQUEST_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { required: true, reason: "explicit_request" };
  }

  // Signal B: author-declared triggers + Signal C: action-verb gate.
  const candidates = compileWorkflowTriggerEntries();
  if (candidates.length === 0) {
    // No catalog triggers configured anywhere — fall through to hint-term heuristic only.
  } else {
    const hasActionVerb = WORKFLOW_ACTION_VERB_PATTERN.test(userMessage);

    const confirmedMatches: WorkflowCatalogMatch[] = [];
    const uncertainMatches: WorkflowCatalogMatch[] = [];

    for (const candidate of candidates) {
      const matchedEntry = candidate.patternsCompiled.find((entryRegexes) =>
        entryRegexes.every((rx) => rx.test(userMessage)),
      );
      if (!matchedEntry) continue;
      const match: WorkflowCatalogMatch = {
        name: candidate.name,
        workflowType: candidate.workflowType,
        score: 1,
        matchedTerms: matchedEntry.map((rx) => rx.source.replace(/\\b/g, "").slice(0, 60)),
      };
      if (candidate.requiresActionVerb && !hasActionVerb) {
        uncertainMatches.push(match);
      } else {
        confirmedMatches.push(match);
      }
    }

    if (confirmedMatches.length > 0) {
      // Prefer scenes over jobs at equal precision (jobs orchestrate scenes).
      const strongestMatch = confirmedMatches.sort((left, right) => {
        if (left.workflowType !== right.workflowType) return left.workflowType === "scene" ? -1 : 1;
        return left.name.localeCompare(right.name);
      })[0];
      return { required: true, reason: "catalog_match", strongestMatch };
    }

    if (uncertainMatches.length > 0) {
      // Don't FORCE routing — just suggest, and ask the user.
      return {
        required: true,
        reason: "uncertain_match",
        strongestMatch: uncertainMatches[0],
        uncertainCandidates: uncertainMatches,
      };
    }
  }

  // Last-resort heuristic: explicit workflow vocabulary in user prose
  // (e.g. "show me available scenes", "list workflows"). Cheap and bounded —
  // these terms are themselves narrow signals of intent.
  const matchedHints = WORKFLOW_HINT_TERMS.filter((term) => normalized.includes(term));
  const matchedDeliverableHints = WORKFLOW_DELIVERABLE_HINT_TERMS.filter((term) => normalized.includes(term));
  if (
    matchedHints.length >= 2
    || (matchedHints.length === 1 && WORKFLOW_ACTION_TERMS.some((term) => normalized.includes(term)))
    || matchedDeliverableHints.length >= 2
  ) {
    return { required: true, reason: "hint_terms" };
  }

  return { required: false, reason: "none" };
}

function buildWorkflowCatalogGuidance(signal: WorkflowCatalogSignal): string {
  if (!signal.required) return "";

  if (signal.reason === "uncertain_match" && signal.strongestMatch) {
    const candidates = (signal.uncertainCandidates ?? [signal.strongestMatch])
      .slice(0, 3)
      .map((match) => `${match.name} [${match.workflowType}]`)
      .join(", ");
    return [
      "POSSIBLE WORKFLOW MATCH (UNCERTAIN):",
      `One or more reusable workflows might fit this request: ${candidates}.`,
      "However, the message lacks a clear action verb (apply / deploy / run / ausrollen / anwenden / durchführen ...) — the user may just be asking for an explanation.",
      "Do NOT call run_workflow yet. Ask the user in ONE concise sentence (in their language) whether they want one of these workflows executed, or whether they just want an answer to their question.",
      "After they confirm, on the next turn either call run_workflow with the chosen workflow or answer normally.",
    ].join(" ");
  }

  const strongestMatchText = signal.strongestMatch
    ? ` Strongest current reusable match: ${signal.strongestMatch.name} [${signal.strongestMatch.workflowType}].`
    : "";
  return [
    "Reusable workflow guidance for this turn: check the workflow catalog before inventing an ad hoc coordinator plan when a reusable scene or job may already fit.",
    strongestMatchText.trim(),
    "If the match is exact, call run_workflow directly. Otherwise call search_workflows first and then either run_workflow or explain honestly why no reusable workflow fits.",
  ].filter(Boolean).join(" ");
}

// Internal exports for unit tests.
const __workflowCatalog = {
  detectWorkflowCatalogSignal,
  buildWorkflowCatalogGuidance,
  WORKFLOW_ACTION_VERB_PATTERN,
};

const __swarmStateContinuity = {
  loadPreviousTurnSwarmTasks,
  buildPersistableSwarmTaskDelta,
};

function collapseMixedOrchestrationLaunchersInResponse(
  toolCalls: LLMResponse["tool_calls"],
  sessionId: string,
  guardrailEvents: Array<{ type: string; details: string }>,
): LLMResponse["tool_calls"] {
  let firstLauncherName: string | null = null;
  const filtered: LLMResponse["tool_calls"] = [];

  for (const toolCall of toolCalls) {
    if (!ORCHESTRATION_LAUNCHER_TOOL_NAMES.has(toolCall.name)) {
      filtered.push(toolCall);
      continue;
    }

    if (!firstLauncherName) {
      firstLauncherName = toolCall.name;
      filtered.push(toolCall);
      continue;
    }

    logAudit("tool_call_blocked", {
      tool: toolCall.name,
      reason: "multiple_orchestration_launchers_same_response",
      keptTool: firstLauncherName,
      args: toolCall.arguments,
    }, {
      sessionId,
      severity: "warn",
    });
    guardrailEvents.push({ type: "tool_blocked", details: `${toolCall.name}:multiple_orchestration_launchers_same_response` });
  }

  return filtered;
}

function collapseMixedDiscoveryAndOrchestrationToolsInResponse(
  toolCalls: LLMResponse["tool_calls"],
  sessionId: string,
  guardrailEvents: Array<{ type: string; details: string }>,
): LLMResponse["tool_calls"] {
  const selectedPhase: "discovery" | "orchestration" | null = toolCalls.some((toolCall) =>
    ORCHESTRATION_LAUNCHER_TOOL_NAMES.has(toolCall.name)
  )
    ? "orchestration"
    : toolCalls.some((toolCall) => AGENT_DISCOVERY_TOOL_NAMES.has(toolCall.name))
      ? "discovery"
      : null;
  const filtered: LLMResponse["tool_calls"] = [];

  for (const toolCall of toolCalls) {
    const phase = ORCHESTRATION_LAUNCHER_TOOL_NAMES.has(toolCall.name)
      ? "orchestration"
      : AGENT_DISCOVERY_TOOL_NAMES.has(toolCall.name)
        ? "discovery"
        : null;

    if (!phase) {
      filtered.push(toolCall);
      continue;
    }

    if (selectedPhase === phase) {
      filtered.push(toolCall);
      continue;
    }

    logAudit("tool_call_blocked", {
      tool: toolCall.name,
      reason: "mixed_discovery_and_orchestration_same_response",
      keptPhase: selectedPhase,
      args: toolCall.arguments,
    }, {
      sessionId,
      severity: "warn",
    });
    guardrailEvents.push({ type: "tool_blocked", details: `${toolCall.name}:mixed_discovery_and_orchestration_same_response` });
  }

  return filtered;
}

export function buildRepeatedOutputFingerprint(toolName: string, args: Record<string, unknown>, resultText: string): string {
  return `${toolName}|${stableSerialize(args)}|${resultText.slice(0, 500)}`;
}

export { __workflowCatalog };
export { __swarmStateContinuity };

function sanitizeUserFacingAssistantResponse(value: string, toolIterations: number): string {
  return sanitizeAssistantContent(value, toolIterations > 0);
}

const EMPTY_ASSISTANT_RESPONSE_FALLBACK = "I wasn't able to generate a usable reply for that turn. Please try again.";

function looksLikeGenericNoUsableReply(value: string): boolean {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized === EMPTY_ASSISTANT_RESPONSE_FALLBACK
    || /^i wasn'?t able to generate a usable reply\b/i.test(normalized)
    || /^please try again\.?$/i.test(normalized);
}

function shouldResynthesizeUserFacingResponse(raw: string, cleaned: string, toolIterations: number): boolean {
  if (!raw.trim() || cleaned.length === 0) return true;
  if (toolIterations > 0 && looksLikeGenericNoUsableReply(cleaned)) return true;
  if (toolIterations === 0) return false;
  if (!NARRATED_TOOL_TEXT_RE.test(raw)) return false;
  return cleaned.length === 0 || cleaned.length < Math.min(120, Math.ceil(raw.length / 3));
}

const CONTINUATION_PROMISE_RE = /\b(i(?:'ll| will)(?:\s+now)?|i am going to|ich werde(?:\s+nun)?|ich beauftrage(?:\s+nun)?|n[äa]chste orchestrierung|next orchestration|next logical step|n[äa]chste logische aktion)\b/i;
const IMPLICIT_CONTINUATION_EXECUTION_RE = /\b(?:i(?:\s+have|'ve)[\s\S]{0,80}\b(?:corrected|fixed|updated|adjusted)\b[\s\S]{0,80}\b(?:am\s+)?(?:now\s+)?(?:running|executing|starting|retrying|restarting)\b|ich\s+habe[\s\S]{0,80}\b(?:korrigiert|angepasst|berichtigt)\b[\s\S]{0,80}\b(?:und\s+)?(?:f(?:[üu]hre|uehre)|starte|versuche|sto(?:ss|ß)e)\b[\s\S]{0,40}\b(?:nun|jetzt)\b[\s\S]{0,20}\b(?:aus|an)\b)/i;
const MAINTENANCE_EXECUTION_PROMISE_RE = /\b(?:i(?:'ll| will)\s+(?:create|generate|delegate|build)|ich\s+(?:werde|erstelle|generiere|delegiere|beauftrage)|(?:erstelle|generiere|delegiere|beauftrage)\s+ich(?:\s+nun|\s+jetzt)?)\b/i;
const MISLEADING_EXECUTED_NEXT_STEP_RE = /\b(the next (?:logical )?(?:step|action)|der n[äa]chste(?: logische)?(?: schritt| aktion)|die n[äa]chste(?: logische)? aktion)\b[\s\S]{0,80}\b(which has been executed|has been executed|was executed|has already been executed|wurde(?:\s+bereits)?\s+ausgef[üu]hrt|ist bereits erfolgt)\b/i;
const NEXT_TURN_HANDOFF_RE = /\b(would you like me to (?:initiate|start|retry)|in the next turn|im n[äa]chsten zug|im n[äa]chsten turn|neue[nr]? delegations(?:strategie|versuch)|new delegation attempt|no further tool calls can be made in this turn|keine weiteren tool calls .* in diesem zug)\b/i;

function looksLikeContinuationPromise(value: string): boolean {
  return CONTINUATION_PROMISE_RE.test(value) || IMPLICIT_CONTINUATION_EXECUTION_RE.test(value);
}

function looksLikeMaintenanceExecutionPromise(value: string): boolean {
  return looksLikeContinuationPromise(value) || MAINTENANCE_EXECUTION_PROMISE_RE.test(value);
}

function shouldRewriteTerminalResponse(value: string, toolIterations: number): boolean {
  if (toolIterations === 0) return false;
  return looksLikeContinuationPromise(value)
    || MISLEADING_EXECUTED_NEXT_STEP_RE.test(value)
    || NEXT_TURN_HANDOFF_RE.test(value);
}

function hasRecentUnresolvedDelegatedAction(history: readonly { role: string; content?: string | null; metadata?: Record<string, unknown> }[]): boolean {
  const recentMessages = [...history].reverse().slice(0, 12);

  for (const message of recentMessages) {
    if (message.role !== "tool") continue;

    const metadata = message.metadata ?? {};
    const delegationOutcome = typeof metadata["delegationOutcome"] === "string"
      ? String(metadata["delegationOutcome"]).toLowerCase()
      : undefined;
    const terminalState = typeof metadata["terminalState"] === "string"
      ? String(metadata["terminalState"]).toLowerCase()
      : undefined;
    const content = String(message.content ?? "");

    if (
      delegationOutcome === "partial"
      || delegationOutcome === "failure"
      || terminalState === "max_iterations"
      || terminalState === "timeout"
      || terminalState === "cancelled"
      || /PARTIAL RESULT|max_iterations|timed out|could not complete|delegation limit/i.test(content)
    ) {
      return true;
    }
  }

  return false;
}

function hasRecentWorkflowAuthoringMaintenanceContext(history: readonly { role: string; content?: string | null }[]): boolean {
  let skippedCurrentUser = false;
  let inspectedPriorUserMessages = 0;

  for (const message of [...history].reverse()) {
    if (message.role !== "user") continue;

    const content = String(message.content ?? "").trim();
    if (!content) continue;

    if (!skippedCurrentUser) {
      skippedCurrentUser = true;
      continue;
    }

    inspectedPriorUserMessages += 1;
    const normalized = content.toLowerCase();
    const guidance = buildDynamicTurnGuidance(content);
    const workflowLike = WORKFLOW_REQUEST_PATTERNS.some((pattern) => pattern.test(normalized))
      || WORKFLOW_HINT_TERMS.some((term) => normalized.includes(term));

    if (guidance?.swarmMaintenanceSensitive && workflowLike) {
      return true;
    }

    if (inspectedPriorUserMessages >= 2) {
      break;
    }
  }

  return false;
}

async function rewriteTerminalResponseIfNeeded(
  response: string,
  toolIterations: number,
  session: AgentSession,
  provider: ChatProvider,
  signal: AbortSignal,
): Promise<string> {
  if (!shouldRewriteTerminalResponse(response, toolIterations)) {
    return response;
  }

  const rewritten = await forceSynthesis(
    session,
    provider,
    signal,
    "Write the final user-facing answer for this turn now. This turn is ending. Do NOT promise that you will do another tool call, delegation, orchestration step, or investigation next. Do NOT say 'I will now', 'next orchestration', or similar future-action phrasing unless that action already happened. Do NOT turn a proposed next step into a completed action: phrases in delegated evidence like 'I will now attempt...' or 'the next step...' are not proof that the action ran, and you must not say a next step 'has been executed' unless this turn includes the completed tool result for that action. Either give the best current answer from the gathered evidence or ask one concise user-facing question if a user decision is required.",
  );

  const cleaned = sanitizeUserFacingAssistantResponse(rewritten ?? "", 0);
  if (!cleaned) return response;
  // When the original is substantive (> 300 chars), only replace it with
  // the rewrite if the rewrite is itself substantive relative to the
  // original.  The common failure mode: delegated-evidence text that
  // incidentally contains "I will …" / "ich werde …" triggers a rewrite
  // call, but forceSynthesis returns a short apology (≤ 100–200 chars)
  // because the model has nothing new to add.  In that situation the
  // original evidence is far more useful than the stub.
  if (response.length > 300 && cleaned.length < Math.max(200, Math.ceil(response.length * 0.25))) {
    return response;
  }
  return cleaned;
}

async function finalizeUserFacingAssistantResponse(
  rawResponse: string,
  toolIterations: number,
  session: AgentSession,
  provider: ChatProvider,
  signal: AbortSignal,
): Promise<string> {
  const cleaned = sanitizeUserFacingAssistantResponse(rawResponse, toolIterations);
  let resolved: string;
  if (!shouldResynthesizeUserFacingResponse(rawResponse, cleaned, toolIterations)) {
    const stableResponse = resolveEmptyAssistantResponseFallback(rawResponse, cleaned, session);
    resolved = await rewriteTerminalResponseIfNeeded(stableResponse, toolIterations, session, provider, signal);
  } else {
    const synthesized = await forceSynthesis(
      session,
      provider,
      signal,
      "You have already executed the necessary tools. Write the final user-facing answer now."
      + " Synthesize the tool results and [SHARED FINDINGS AVAILABLE] entries into a complete, well-structured answer in the user's language."
      + " Do NOT echo raw shared-finding key names (e.g. auto_xxx_yyy) — convert them into readable sentences."
      + " Do NOT narrate searches, fetches, document generation, or tool calls. Never include literal [Tool: ...] traces.",
    );
    if (synthesized) {
      const cleanedSynthesized = sanitizeUserFacingAssistantResponse(synthesized, 0);
      if (cleanedSynthesized) {
        resolved = await rewriteTerminalResponseIfNeeded(cleanedSynthesized, toolIterations, session, provider, signal);
      } else {
        const fallback = resolveEmptyAssistantResponseFallback(rawResponse, cleaned, session);
        resolved = await rewriteTerminalResponseIfNeeded(fallback, toolIterations, session, provider, signal);
      }
    } else {
      const fallback = resolveEmptyAssistantResponseFallback(rawResponse, cleaned, session);
      resolved = await rewriteTerminalResponseIfNeeded(fallback, toolIterations, session, provider, signal);
    }
  }

  return await enforceDelegateCoverage(resolved, toolIterations, session, provider, signal);
}

const DELEGATE_TOOL_RESULT_RE = /^(Delegated result from|Parallel delegation completed|Task graph (completed|finished))/i;
const WORKFLOW_TOOL_RESULT_RE = /^Workflow\s+\S+\s+\[[^\]]+\]\s+(?:completed|blocked)\./i;
const EVIDENCE_SECTION_RE = /^Observed evidence:\s*/m;

function isForcedSynthesisSystemMessage(message: { role: string; content?: string | null }): boolean {
  return message.role === "system"
    && typeof message.content === "string"
    && (
      message.content.startsWith("[SYNTHESIS REQUIRED]")
      || message.content.startsWith("[WARDEN STOP — FORCED SYNTHESIS]")
    );
}

const PRIOR_DELEGATION_JUNK_SUBSTANCE_FLOOR = 1500;

/**
 * Walk recent history for the most recent delegation tool result and decide
 * whether it qualifies as "junk" — i.e. a partial/timeout result whose
 * actual substantive evidence is below the usability floor. Used by the
 * synthesis-required guardrail (Fix 3) to allow ONE recovery delegation
 * through instead of locking the model into synthesizing from a truncated
 * stub. Returns null when the most recent delegation is either substantial
 * or absent.
 */
function findRecentJunkDelegationResult(
  history: readonly { role: string; content?: string | null; metadata?: Record<string, unknown> }[],
): { agentName: string; substanceChars: number; terminalState: string | null } | null {
  const recent = [...history].reverse().slice(0, 12);
  for (const message of recent) {
    if (message.role !== "tool") continue;
    const content = String(message.content ?? "");
    const meta = message.metadata ?? {};
    const isDelegate = DELEGATE_TOOL_RESULT_RE.test(content) || looksLikeDelegateMetadata(meta);
    if (!isDelegate) continue;

    const terminalState = typeof meta["terminalState"] === "string" ? String(meta["terminalState"]) : null;
    const delegationOutcome = typeof meta["delegationOutcome"] === "string" ? String(meta["delegationOutcome"]) : null;
    const isPartialOrTimeout = terminalState === "timeout"
      || delegationOutcome === "partial"
      || /—\s*PARTIAL PROGRESS|TIMEOUT|TASK FAILED/i.test(content);
    if (!isPartialOrTimeout) {
      // Most recent delegation succeeded with full evidence — there is no
      // recovery scenario to authorize. Stop walking.
      return null;
    }

    // Measure substantive evidence: strip the "Delegated result from / IMPORTANT / Observed evidence:" wrapper and count the body.
    const evidenceMatch = /Observed evidence:\s*([\s\S]+?)(?:\n\n|$)/.exec(content);
    const body = evidenceMatch ? evidenceMatch[1]!.trim() : content.trim();
    // A body containing the "Recovered delegated specialist body (full):"
    // marker is NOT junk — Fix 2 already surfaced the full delegated answer.
    if (/Recovered delegated specialist body \(full\):/i.test(body)) return null;
    if (body.length >= PRIOR_DELEGATION_JUNK_SUBSTANCE_FLOOR) return null;

    const agentName = typeof meta["agentName"] === "string" && meta["agentName"]
      ? meta["agentName"]
      : (content.match(/Delegated result from\s+([^\s—]+)/)?.[1] ?? "a specialist agent");
    return { agentName, substanceChars: body.length, terminalState };
  }
  return null;
}

function hasRecentForcedSynthesisNudge(
  history: readonly { role: string; content?: string | null }[],
): boolean {
  const recent = [...history].reverse().slice(0, 16);
  return recent.some((message) => isForcedSynthesisSystemMessage(message));
}

function resolveEmptyAssistantResponseFallback(
  rawResponse: string,
  cleaned: string,
  session: AgentSession,
): string {
  const stableResponse = cleaned || rawResponse.trim();
  if (stableResponse) return stableResponse;

  const history = session.getHistory();
  if (hasRecentForcedSynthesisNudge(history)) {
    const evidence = findRecentDelegateEvidence(history);
    if (evidence) {
      logAudit(
        "guardrail_flagged",
        {
          type: "empty_response_evidence_backstop",
          evidenceLength: evidence.evidence.length,
          evidenceItems: evidence.itemCount,
        },
        { sessionId: session.id, channel: session.channel, severity: "warn" },
      );
      // Format the evidence before returning — raw shared-fact key dumps
      // (auto_xxx_yyy: "...") and orchestration scaffolding must not reach
      // the user verbatim; formatRecoveryEvidenceForFinalUser renders them
      // into a bilingual partial-answer preamble that is at least readable.
      return formatRecoveryEvidenceForFinalUser(evidence.evidence);
    }
  }

  // Diagnostic fallback: when the model produced no usable text AND the
  // most recent tool result is a failed delegation, the generic "please
  // try again" placeholder is unhelpful — the user gets no signal about
  // WHY their request couldn't be answered.  Surface a short diagnostic
  // that names the failed agent and the failure reason instead, so they
  // can decide whether to retry, rephrase, or ask for a different path.
  // Common case: a containerized sub-agent crashed (Docker daemon down,
  // image missing, OOM) and the model couldn't recover synthesis on its
  // own (typical when the request needed live evidence the user couldn't
  // provide inline).
  const recentFailedDelegation = findRecentFailedDelegation(history);
  if (recentFailedDelegation) {
    logAudit(
      "guardrail_flagged",
      {
        type: "empty_response_failed_delegation_diagnostic",
        agentName: recentFailedDelegation.agentName,
        reason: recentFailedDelegation.reason.slice(0, 200),
      },
      { sessionId: session.id, channel: session.channel, severity: "warn" },
    );
    return recentFailedDelegation.message;
  }

  return EMPTY_ASSISTANT_RESPONSE_FALLBACK;
}

/**
 * Walk recent history for a failed delegation tool result.  Returns a
 * short user-facing diagnostic message naming the agent and reason —
 * better UX than the generic empty-response placeholder when the model
 * produced no recoverable text and we already know one specific thing
 * went wrong.  Returns null when the recent transcript shows successful
 * delegations or no delegations at all (in those cases the placeholder
 * remains correct).
 */
function findRecentFailedDelegation(
  history: readonly { role: string; content?: string | null; metadata?: Record<string, unknown> }[],
): { agentName: string; reason: string; message: string } | null {
  const recent = [...history].reverse().slice(0, 8);
  for (const message of recent) {
    if (message.role !== "tool") continue;
    const content = String(message.content ?? "");
    const meta = message.metadata ?? {};
    const isDelegate = DELEGATE_TOOL_RESULT_RE.test(content) || looksLikeDelegateMetadata(meta);
    if (!isDelegate) continue;
    // Only fire on visible-failure shape — the runtime's
    // buildModelVisibleToolResult rewrites the heading to "TASK FAILED"
    // when the underlying output looked like a failure.  Reading that
    // marker keeps us aligned with what the model itself saw.
    if (!/TASK FAILED\b/i.test(content)) {
      // Successful delegation in scope — don't fire a failure diagnostic.
      return null;
    }
    const agentName = typeof meta["agentName"] === "string" && meta["agentName"]
      ? meta["agentName"]
      : (content.match(/Delegated result from\s+([^\s—]+)/)?.[1] ?? "a specialist agent");
    const evidenceMatch = /Observed evidence:\s*([\s\S]+?)(?:\n\n|$)/.exec(content);
    const reason = evidenceMatch ? evidenceMatch[1]!.trim().slice(0, 280) : "";
    const reasonHint = reason ? ` Reason: ${reason}` : "";
    return {
      agentName,
      reason,
      message:
        `I delegated this task to ${agentName} but the attempt failed before producing an answer.${reasonHint} `
        + `Try the request again, or rephrase it so it can be answered without that specialist.`,
    };
  }
  return null;
}

function looksLikeDelegateMetadata(meta: Record<string, unknown> | undefined): boolean {
  if (!meta) return false;
  if (typeof meta["delegationOutcome"] === "string") return true;
  if (typeof meta["agentName"] === "string") return true;
  if (meta["delegationSucceeded"] === true) return true;
  if (typeof meta["taskCount"] === "number" || typeof meta["succeeded"] === "number") return true;
  return false;
}

function countStructuredItems(text: string): number {
  if (!text) return 0;
  const tableRows = (text.match(/^\s*\|.+\|\s*$/gm) ?? []).length;
  // Plain numbered list: "1. foo" / "1) foo".
  const numbered = (text.match(/^\s*\d{1,3}[.)]\s+\S/gm) ?? []).length;
  // Bold-prefixed numbered headlines/sections, common in coordinator
  // markdown output: "**1. Title**" or "**1) Title**". The plain regex
  // above misses these because the line starts with "*".
  const boldNumbered = (text.match(/^\s*\*\*\d{1,3}[.)]\s+\S/gm) ?? []).length;
  const bullets = (text.match(/^\s*[-*+]\s+\S/gm) ?? []).length;
  // Headings (markdown ###/####) used as item separators in long
  // structured deliverables.
  const headings = (text.match(/^\s*#{1,6}\s+\S/gm) ?? []).length;
  return Math.max(tableRows, numbered, boldNumbered, bullets, headings);
}

function stripInterruptedSubAgentBoilerplate(text: string): string {
  return text
    // The reason text is sometimes extended with a tail clause such as
    //   "timed out after Nms after finishing the current operation"
    //   "timed out after Nms before starting another tool run"
    // (see sub-agent.ts hard-deadline branches). The original alternation
    // required `\d+ms` to be followed directly by whitespace + "Partial
    // progress before interruption:", which fails for the extended form
    // and leaves the scaffold prefix in the surfaced evidence. Allow any
    // non-newline tail between the duration and the partial-progress
    // header so both shapes get stripped cleanly.
    .replace(
      /Sub-agent '[^']+' timed out after \d+ms[^\n]*\s+Partial progress before interruption:\s*[\s\S]*?(?=Recovered evidence snippets from completed tools:|\n\n---|$)/g,
      "",
    )
    .replace(
      /Sub-agent '[^']+' produced no final response after substantive work\.[^\n]*\s+Partial progress before interruption:\s*[\s\S]*?(?=Recovered evidence snippets from completed tools:|\n\n---|$)/g,
      "",
    )
    .replace(
      /Sub-agent '[^']+' was cancelled[^\n]*\s+Partial progress before interruption:\s*[\s\S]*?(?=Recovered evidence snippets from completed tools:|\n\n---|$)/g,
      "",
    )
    // Also strip a bare "Partial progress before interruption:" stanza
    // that may appear after the extended-reason text was already matched
    // by an earlier regex but the partial-progress block still trails.
    .replace(
      /Partial progress before interruption:\s*[\s\S]*?(?=Recovered evidence snippets from completed tools:|\n\n---|$)/g,
      "",
    )
    .replace(/Sub-agent '[^']+' timed out after \d+ms[^\n]*\n?/g, "")
    .replace(/Sub-agent '[^']+' produced no final response after substantive work\.[^\n]*\n?/g, "")
    .replace(/Sub-agent '[^']+' was cancelled[^\n]*\n?/g, "")
    .trim();
}

// Matches an interrupted sub-agent's terminal-reason line — including the
// extended forms ("after finishing the current operation", "before starting
// another tool run") that are tacked onto the duration. This is the first
// line of `buildInterruptedSubAgentOutput` (sub-agent.ts) before the
// `Sub-agent '...' ` prefix is stripped by upstream sanitizers.
const INTERRUPTED_REASON_LINE_RE = /^(?:after finishing the current operation|before starting another tool run|timed out after \d+ms|produced no final response after substantive work|was cancelled)\b/i;

// A bullet-prefixed scaffold line that `buildInterruptedSubAgentOutput`
// produces ("- Tool calls executed: N (...)", "- Iterations completed: N",
// "- Artifacts collected: N (...)"). The pre-existing check matched these
// only at start-of-string without a leading dash; orchestration scaffolds
// always have the dash, so the match consistently failed and the scaffold
// got surfaced as if it were real evidence.
const SCAFFOLD_LIST_LINE_RE = /^(?:[-*]\s+)?(?:Tool calls executed:|Iterations completed:|Artifacts collected:)/i;

function stripToolEvidencePrefix(text: string): string {
  return text.replace(/^(?:[-*]\s*)?(?:[a-z][a-z0-9_]*|artifact)\s*(?:\[[^\]]+\])?:\s+/, "").trim();
}

function stripRecoveredSnippetToolLabel(text: string): string {
  const stripped = stripToolEvidencePrefix(text);
  return stripped || text.trim();
}

function looksLikeOrchestrationOnlyEvidence(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  const withoutToolPrefix = stripToolEvidencePrefix(trimmed);
  if (withoutToolPrefix && withoutToolPrefix !== trimmed && looksLikeOrchestrationOnlyEvidence(withoutToolPrefix)) return true;
  if (looksLikeHallucinatedTruncationClaim(trimmed)) return true;
  if (looksLikeDelegationTaskEcho(trimmed)) return true;
  if (/Partial progress before interruption:/i.test(trimmed)) {
    return true;
  }
  if (/^Recovered evidence snippets from completed tools:/i.test(trimmed)) {
    return true;
  }
  // Whole-string check: every non-empty line is a scaffold line. This
  // catches the residue left after `stripInterruptedSubAgentBoilerplate`
  // failed (or only partially matched) the extended-reason prefix and
  // we're left with a few lines like:
  //   "after finishing the current operation"
  //   "- Tool calls executed: 5 (...)"
  //   "- Iterations completed: 4"
  // None of which carry actual evidence for the user.
  const lines = trimmed.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length > 0 && lines.every((line) =>
    INTERRUPTED_REASON_LINE_RE.test(line)
    || SCAFFOLD_LIST_LINE_RE.test(line)
    || /^Partial progress before interruption:?$/i.test(line)
    || /^Recovered evidence snippets from completed tools:?$/i.test(line),
  )) {
    return true;
  }
  if (/^(?:No agents matched|No workflows matched|Tool calls executed:|Iterations completed:)/i.test(trimmed)) {
    return true;
  }
  if (/\bis already running via\s+(?:[a-z0-9_:-]*(?:_agent|_coordinator)|researcher|another agent)\b/i.test(trimmed)) {
    return true;
  }
  if (/^(?:task_\d+\s+\[running\]|parallel_\d+\s+\[(?:running|pending)\])/i.test(trimmed)) {
    return true;
  }
  if (/^Sub-agent '[^']+'/i.test(trimmed)) {
    return true;
  }
  if (/^Delegated result from/i.test(trimmed) && trimmed.length < 220) {
    return true;
  }
  // Workflow discovery results — coordinator planning steps, not research findings.
  if (/^Workflow matches for\s+["']?/i.test(trimmed)) {
    return true;
  }
  // Workflow config/reference errors — not usable research evidence.
  if (/^Workflow\s+["']?[^"']+["']?\s+\[[^\]]+\]\s+references\s+a\s+scene/i.test(trimmed)) {
    return true;
  }
  if (/^(?:Without the underlying scene|Add the missing scene|or remove the job)/i.test(trimmed)) {
    return true;
  }
  return false;
}

function looksLikeHallucinatedTruncationClaim(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /\b(?:workflow|tool|delegat(?:ed|ion)|evidence|output|result|context|inhalt|ergebnis)\b.{0,140}\b(?:truncated|cut\s+off|cuts\s+off|abgeschnitten|not\s+visible|nicht\s+sichtbar|cannot\s+see)\b/i.test(trimmed)
    || /\b(?:truncated|cut\s+off|cuts\s+off|abgeschnitten|not\s+visible|nicht\s+sichtbar|cannot\s+see)\b.{0,140}\b(?:workflow|tool|delegat(?:ed|ion)|evidence|output|result|context|inhalt|ergebnis)\b/i.test(trimmed);
}

function looksLikeDelegationTaskEcho(text: string): boolean {
  const normalized = collapseWhitespace(stripPresentationFormatting(text));
  if (!normalized) return false;
  return /\bSOURCE-SENSITIVE DELEGATION(?:\s+(?:SLICE|GRAPH NODE))?\b/i.test(normalized)
    || /\b(?:Original user request|Parent task):\b/i.test(normalized)
    || /\bvia\s+[a-z0-9_:-]+\s+SOURCE-SENSITIVE DELEGATION\b/i.test(normalized);
}

function stripDelegationProgressPrefix(text: string): string {
  return text
    .replace(/^(?:parallel|task)_\d+\s+\[[^\]]+\]\s*/i, "")
    .replace(/^[a-z_]+\s+\[[^\]]+\]\s*/i, "")
    .trim();
}

function collectInterruptedDelegationSnippets(text: string): string[] {
  const cleaned = stripPresentationFormatting(text);
  const snippets: string[] = [];
  const seen = new Set<string>();

  const pushSnippet = (candidate: string) => {
    const normalized = stripInterruptedSubAgentBoilerplate(candidate)
      .replace(/^IMPORTANT:\s.*$/gim, "")
      .trim();
    if (!normalized || normalized.length < 80 || looksLikeOrchestrationOnlyEvidence(normalized)) return;
    if (looksLikeProviderErrorEcho(normalized)) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    snippets.push(normalized);
  };

  // Recovered delegated specialist body — full delegated content surfaced
  // verbatim by the inner agent's interrupt path (Fix 2). Push it FIRST so
  // it ranks ahead of bullet-list snippets and a downstream cap preserves
  // the actual delegated answer rather than a 900-char head.
  const fullBodyMatch = /Recovered delegated specialist body \(full\):\s*\n([\s\S]+?)(?=\nRecovered evidence snippets from completed tools:|$)/i.exec(cleaned);
  if (fullBodyMatch?.[1]) {
    pushSnippet(fullBodyMatch[1].trim());
  }

  const progressMatch = /Partial progress before interruption:\s*([\s\S]*?)(?=\nRecovered (?:delegated specialist body \(full\)|evidence snippets from completed tools):|$)/i.exec(cleaned);
  if (progressMatch?.[1]) {
    for (const rawLine of progressMatch[1].split("\n")) {
      const line = rawLine.trim();
      if (!line.startsWith("- ")) continue;
      const body = line.slice(2).trim();
      if (!body || /^(?:Tool calls executed:|Iterations completed:)/i.test(body)) continue;
      if (/\[(?:running|pending)\]/i.test(body)) continue;
      if (/^(?:parallel|task)_\d+\s+\[[^\]]+\]/i.test(body) && !body.includes(" | ")) continue;
      const normalizedBody = stripDelegationProgressPrefix(body);
      const candidate = normalizedBody.includes(" | ")
        ? normalizedBody.split(/\s+\|\s+/).slice(1).join(" | ")
        : normalizedBody;
      pushSnippet(candidate);
    }
  }

  const recoveredMatch = /Recovered evidence snippets from completed tools:\s*\n([\s\S]+)$/i.exec(cleaned);
  if (recoveredMatch?.[1]) {
    for (const rawLine of recoveredMatch[1].split("\n")) {
      const line = rawLine.trim();
      if (!line.startsWith("- ")) continue;
      const body = line.slice(2).trim();
      const candidate = stripRecoveredSnippetToolLabel(body);
      pushSnippet(candidate);
    }
  }

  return snippets;
}

function extractUsefulInterruptedDelegationEvidence(text: string): string | null {
  if (!/Partial progress before interruption:|Recovered evidence snippets from completed tools:/i.test(text)) {
    return null;
  }
  const snippets = collectInterruptedDelegationSnippets(text);
  if (snippets.length > 0) return snippets.join("\n\n");

  const fallback = stripInterruptedSubAgentBoilerplate(stripPresentationFormatting(text))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^(?:Tool calls executed:|Iterations completed:|Recovered evidence snippets from completed tools:)/i.test(line))
    .filter((line) => !looksLikeOrchestrationOnlyEvidence(line))
    .join("\n");

  if (fallback.length < 120) return null;
  if (looksLikeProviderErrorEcho(fallback)) return null;
  return fallback;
}

function looksLikeInterruptedDelegationWithoutUsableEvidence(text: string): boolean {
  return /Partial progress before interruption:|Recovered evidence snippets from completed tools:/i.test(text)
    && !extractUsefulInterruptedDelegationEvidence(text);
}

function measureEvidenceCoverage(
  text: string,
  evidence: { evidence: string; itemCount: number },
): { textItems: number; itemShortfall: boolean; lengthShortfall: boolean } {
  const textItems = countStructuredItems(text);
  return {
    textItems,
    itemShortfall: evidence.itemCount >= 5
      && textItems < Math.ceil(evidence.itemCount * 0.6),
    lengthShortfall: evidence.evidence.length >= 1500
      && text.length < Math.ceil(evidence.evidence.length * 0.4),
  };
}

function findRecentDelegateEvidence(
  history: readonly { role: string; content?: string | null; metadata?: Record<string, unknown> }[],
): { evidence: string; itemCount: number } | null {
  const recent = [...history].reverse().slice(0, 24);
  let bestCandidate: { evidence: string; itemCount: number; score: number } | null = null;

  for (const message of recent) {
    if (message.role !== "tool") continue;
    const content = String(message.content ?? "");
    const meta = message.metadata ?? {};

    // Workflow execution results (run_workflow) carry the same
    // "Observed evidence:" block as delegated results and are an equally
    // valid synthesis backstop when the model misbehaves at the synthesis
    // step (e.g. emits another tool call after [SYNTHESIS REQUIRED]).
    // Recognize them here so the terminal-evidence backstop can prefer
    // the actual workflow dossier over the model's preamble text.
    const isWorkflowResult = WORKFLOW_TOOL_RESULT_RE.test(content)
      || typeof meta["workflowName"] === "string";
    const isDelegate = DELEGATE_TOOL_RESULT_RE.test(content) || looksLikeDelegateMetadata(meta);
    if (!isDelegate && !isWorkflowResult) continue;

    const evidenceMatch = EVIDENCE_SECTION_RE.exec(content);
    const rawEvidence = evidenceMatch
      ? content.slice(evidenceMatch.index + evidenceMatch[0].length).trim()
      : content.trim();
    const evidence = extractUsefulInterruptedDelegationEvidence(rawEvidence) ?? rawEvidence;
    const delegationOutcome = typeof meta["delegationOutcome"] === "string"
      ? String(meta["delegationOutcome"]).toLowerCase()
      : "";
    const terminalState = typeof meta["terminalState"] === "string"
      ? String(meta["terminalState"]).toLowerCase()
      : "";
    const partialLike = delegationOutcome === "partial"
      || terminalState === "timeout"
      || /(?:TASK COMPLETED \(PARTIAL|PARTIAL PROGRESS|Partial progress before interruption:)/i.test(content);
    const minimumEvidenceChars = partialLike ? 120 : 400;
    if (!evidence || evidence.length < minimumEvidenceChars) continue;
    // Reject evidence that is just a regurgitated provider/HTTP/HTML error
    // — surfacing an LM Studio 500 page or an "OpenAI-compatible request
    // failed" string as the final answer is worse than the generic
    // "no usable evidence" fallback.
    if (looksLikeProviderErrorEcho(evidence)) continue;
    if (looksLikeRawWorkspaceToolDump(evidence)) continue;
    // Reject evidence whose every non-empty line is interrupted-sub-agent
    // scaffolding ("after finishing the current operation", "- Tool calls
    // executed: N", "- Iterations completed: N"). Without this, the
    // empty-response evidence backstop dumps the scaffold to the user as
    // if it were real findings. A 161-char scaffold is technically above
    // the partial-like 120-char minimum but is zero-information.
    if (looksLikeOrchestrationOnlyEvidence(evidence)) continue;

    const itemCount = countStructuredItems(evidence);
    const score = evidence.length + (itemCount * 200);
    if (!bestCandidate || score > bestCandidate.score) {
      bestCandidate = { evidence, itemCount, score };
    }
  }

  return bestCandidate
    ? { evidence: bestCandidate.evidence, itemCount: bestCandidate.itemCount }
    : null;
}

const EXPLICIT_SOURCE_RECHECK_RE = /\b(verify|verification|check|recheck|validate|validation|source|sources|citation|citations|cite|official|datasheet|spec(?:ification)?s?|price|prices|supplier|suppliers|mouser|digikey|lcsc|aliexpress|search|lookup|look\s+up|find\s+online|recherch|pruef|pruefe|pruefen|verifiz|validier|quelle|quellen|beleg|belege)\b/i;
const CONTEXTUAL_DECISION_FOLLOW_UP_RE = /\b(ok|okay|thx|thanks|thank\s+you|danke|got\s+it|verstanden|we\s+will|we'll|wir\s+werden|wir\s+nutzen|wir\s+nehmen|i\s+will|ich\s+werde|ich\s+nehme|let'?s|lass\s+uns|use\s+them|using\s+them|go\s+with|nehmen\s+wir)\b/i;

function shouldReusePriorDelegateEvidenceForSourceFollowUp(
  userMessage: string,
  guidance: DynamicTurnGuidance | null | undefined,
  priorEvidence: { evidence: string; itemCount: number } | null,
): boolean {
  if (!guidance?.sourceSensitive || guidance.freshnessSensitive || guidance.artifactSensitive) return false;
  if (!priorEvidence || priorEvidence.evidence.length < 400) return false;
  if (EXPLICIT_SOURCE_RECHECK_RE.test(userMessage)) return false;
  if (/[?？]/.test(userMessage)) return false;
  return userMessage.length <= 700 && CONTEXTUAL_DECISION_FOLLOW_UP_RE.test(userMessage);
}

function buildPriorEvidenceFollowUpPrompt(evidence: { evidence: string; itemCount: number }): string {
  return [
    "CONTINUATION FROM PRIOR EVIDENCE: The latest user message appears to accept or refine a previously researched topic, not request fresh verification.",
    "Use the existing delegated evidence and the user's latest decision to answer directly.",
    "Do NOT call tools or delegate again unless the user explicitly asks for new source checks, current prices, supplier availability, or additional external facts.",
    `Prior delegated evidence preview (${evidence.evidence.length} chars, ${evidence.itemCount} structured items): ${truncatePlainText(evidence.evidence, 2200)}`,
  ].join(" ");
}

/**
 * Decide whether to skip the LLM synthesis call entirely and surface the
 * delegated evidence verbatim.  Fires when either the model has been
 * caught looping on rejected tool calls (`synthesis_required_tool_call_rejected`)
 * or the runtime hit max iterations with substantial evidence already in
 * the transcript.  The threshold deliberately accepts modest evidence
 * payloads — operators repeatedly hit the failure mode where 1-2 KB of
 * tool output exists but the synthesis call returns 50-100 chars of
 * apology, leaving the user with effectively no answer.
 */
/**
 * Terminal finish reasons that indicate the runtime is "giving up" after
 * a tool/orchestration loop — there's no useful work left to do, but we
 * still owe the user the evidence we already have.  Extends beyond the
 * original `synthesis_required_tool_call_rejected` to cover:
 *
 *  - `all_tool_calls_blocked`: model kept retrying tools that hit
 *    per-turn caps — operator-visible 73-char "I can't" replies.
 *  - `max_tool_iterations`: hit the iteration cap; the previous fallback
 *    message ("I've gathered partial results...") is technically truthful
 *    but throws away the partial results.
 */
const EVIDENCE_BACKSTOP_GIVE_UP_REASONS = new Set([
  "synthesis_required_tool_call_rejected",
  "all_tool_calls_blocked",
  "max_tool_iterations",
]);

function shouldBypassTerminalSynthesisWithEvidence(
  finishReason: string,
  evidence: { evidence: string; itemCount: number } | null,
): boolean {
  if (!evidence) return false;
  if (!EVIDENCE_BACKSTOP_GIVE_UP_REASONS.has(finishReason)) return false;
  // Threshold: anything materially structured (>= 4 items) OR >= 800 chars
  // is good enough to stand on its own as a backstop answer.  The previous
  // 4000-char / 12-item bar excluded most real-world delegated outputs and
  // forced the runtime through a synthesis path that consistently produced
  // empty / apologetic 50–100 char replies.
  return evidence.itemCount >= 4 || evidence.evidence.length >= 800;
}

/**
 * Catch the post-synthesis case the bypass missed: the synthesis call ran,
 * but came back with a suspiciously short reply while substantial evidence
 * is still sitting in the transcript.  In that situation the answer the
 * user actually wants is the evidence — not whatever 50-100 char fragment
 * the synthesis produced.
 */
function looksLikeUnderpoweredSynthesis(synthesized: string | null): boolean {
  if (synthesized === null) return true;
  const trimmed = synthesized.trim();
  if (trimmed.length === 0) return true;
  // 300 chars is roughly two paragraphs of substantive text — anything
  // shorter for a turn that did real tool work is almost certainly an
  // apology, an empty acknowledgement, or a refusal.
  if (trimmed.length < 300) return true;
  if (looksLikeGenericNoUsableReply(trimmed)) return true;
  // Refusal / apology shapes that don't carry information.
  if (/^(?:i\s+(?:am\s+)?(?:sorry|unable|can(?:not|'?t)|wasn'?t\s+able)|sorry,\s+i)\b/i.test(trimmed)
    && trimmed.length < 600) {
    return true;
  }
  return false;
}

async function enforceDelegateCoverage(
  finalResponse: string,
  toolIterations: number,
  session: AgentSession,
  provider: ChatProvider,
  signal: AbortSignal,
): Promise<string> {
  if (toolIterations === 0) return finalResponse;
  if (!finalResponse || finalResponse.length < 50) return finalResponse;

  const evidence = findRecentDelegateEvidence(session.getHistory());
  if (!evidence) return finalResponse;

  const initialCoverage = measureEvidenceCoverage(finalResponse, evidence);
  const finalItems = initialCoverage.textItems;
  const itemShortfall = initialCoverage.itemShortfall;
  const lengthShortfall = initialCoverage.lengthShortfall;

  if (!itemShortfall && !lengthShortfall) return finalResponse;

  // A15: Action-task exemption. Delete, move, archive, send, and similar
  // mutation tasks produce short confirmation responses that legitimately
  // do not enumerate all evidence items — the evidence is an intermediate
  // listing the agent fetched before acting, not the deliverable itself.
  // Replacing a valid "I deleted 3 emails" confirmation with the raw email
  // listing confuses the user and makes it look like nothing happened.
  const ACTION_COMPLETION_RE =
    /\b(deleted?|gelöscht|archiv(?:iert|ed?)|moved?|verschoben|sent|gesendet|forwarded?|weitergeleitet|replied?|beantwortet|created?|erstellt|cleared?|geleert|removed?|entfernt|marked?|markiert|emptied?|erfolgreich|successfully|abgeschlossen|erledigt|fertig)\b/i;
  const TRUNCATION_CLAIM_QUICK_RE =
    /\b(abgeschnitten|truncated|cut off|nicht sichtbar|cannot see)\b/i;
  if (ACTION_COMPLETION_RE.test(finalResponse) && !TRUNCATION_CLAIM_QUICK_RE.test(finalResponse)) {
    return finalResponse;
  }

  // I14: Hallucinated-truncation detector. When the model's draft answer
  // CLAIMS the evidence is truncated, cut off, abgeschnitten, or "not
  // visible in my context" while substantial structured evidence is
  // actually sitting in the most recent tool result, no amount of
  // re-prompting will fix it — the model has convinced itself the data
  // is gone. Detect that pattern and present the evidence verbatim
  // instead of going through another LLM round-trip that will produce
  // the same hallucination.
  const HALLUCINATED_TRUNCATION_RE =
    /\b(abgeschnitten|truncated|cut off|nicht sichtbar|in meinem Kontext nicht|not visible|content (is|was) (truncated|missing|cut)|Ergebnis(?:blöcke|inhalt) (?:wurden?|ist|sind)\s+(?:hier\s+)?(?:abgeschnitten|nicht)|cannot see|kann (?:ich)? (?:die|den)\s+\w+\s+nicht (?:sehen|finden))/i;
  // Evidence is "rich" when EITHER it has many structured items OR it
  // is large in absolute terms relative to the draft. The item-only
  // gate misses unstructured prose deliverables and bold-numbered
  // headlines that the counter previously missed.
  const evidenceIsRich =
    (evidence.evidence.length >= 1500 && evidence.itemCount >= 5)
    || (evidence.evidence.length >= 1500
        && finalResponse.length < Math.ceil(evidence.evidence.length * 0.3));
  const draftClaimsTruncation = HALLUCINATED_TRUNCATION_RE.test(finalResponse);
  if (evidenceIsRich && draftClaimsTruncation) {
    logAudit(
      "hallucinated_truncation_bypass",
      {
        evidenceLength: evidence.evidence.length,
        evidenceItems: evidence.itemCount,
        finalLength: finalResponse.length,
        finalItems,
        bypassReason: "model_claimed_truncation_with_evidence_present",
      },
      { sessionId: session.id, channel: session.channel, severity: "warn" },
    );
    return evidence.evidence;
  }

  logAudit(
    "coverage_shortfall_resynthesis",
    {
      evidenceLength: evidence.evidence.length,
      evidenceItems: evidence.itemCount,
      finalLength: finalResponse.length,
      finalItems,
      itemShortfall,
      lengthShortfall,
    },
    { sessionId: session.id, channel: session.channel, severity: "warn" },
  );

  // E24: structured synthesis template with evidence enumeration. We give
  // the model a fill-in-the-blanks checklist so it has to visibly account
  // for each item rather than drift into a summary that drops rows.
  const enumerationTemplate = evidence.itemCount >= 3
    ? ` Use this structure:\n\n### All items from the evidence\n1. <first item — full text with source>\n2. <second item — full text with source>\n... continue for all ${evidence.itemCount} items.\n\n### Summary\n<one short paragraph>\n\n`
    : "";
  const instruction = [
    "COVERAGE CORRECTION: Your previous draft answer dropped material from the most recent delegated tool result.",
    `The delegated evidence contained ${evidence.itemCount} structured items (bullets, numbered list rows, or table rows) and ${evidence.evidence.length} characters of content,`,
    `but your draft contained only ${finalItems} items and ${finalResponse.length} characters.`,
    "Rewrite the answer NOW so it includes EVERY item, headline, source, URL, name, number, and source attribution from the delegated evidence above.",
    "If the evidence covers multiple sources (e.g. several news outlets, several repositories, several findings), your answer MUST visibly cover ALL of them \u2014 do not keep only the first source.",
    "Preserve the structure (numbered list, bullets, table) and headings of the evidence.",
    "Do NOT summarize, do NOT trim, do NOT collapse rows into 'and others', do NOT add markers like '(truncated)' or '(abgeschnitten)'.",
    "Do NOT claim the evidence is truncated, cut off, abgeschnitten, or invisible \u2014 the FULL evidence is in the tool result above and you MUST relay it verbatim.",
    "Do NOT call any tools \u2014 the evidence is already collected. Just rewrite the user-facing answer.",
    enumerationTemplate ? `\n\nREQUIRED OUTPUT TEMPLATE:${enumerationTemplate}` : "",
  ].filter(Boolean).join(" ");

  const resynth = await forceSynthesis(session, provider, signal, instruction);
  if (!resynth) {
    // Resynthesis failed entirely (e.g. local GPU returned null/empty after
    // a long session).  When rich evidence exists, always prefer surfacing the
    // coordinator's full answer over keeping the under-synthesized draft —
    // regardless of whether the draft claimed truncation.
    if (evidenceIsRich) {
      return evidence.evidence;
    }
    return finalResponse;
  }
  const cleanedResynth = sanitizeUserFacingAssistantResponse(resynth, 0);
  if (!cleanedResynth) return finalResponse;
  // I14: If the resynthesis ALSO claims truncation while rich evidence
  // exists, the model is locked into the hallucination. Bypass to the
  // raw evidence rather than ship either bad draft.
  if (evidenceIsRich && HALLUCINATED_TRUNCATION_RE.test(cleanedResynth)) {
    logAudit(
      "hallucinated_truncation_bypass",
      {
        evidenceLength: evidence.evidence.length,
        evidenceItems: evidence.itemCount,
        finalLength: finalResponse.length,
        finalItems,
        resynthLength: cleanedResynth.length,
        bypassReason: "resynthesis_repeated_truncation_claim",
      },
      { sessionId: session.id, channel: session.channel, severity: "warn" },
    );
    return evidence.evidence;
  }
  // Only accept if the resynthesis genuinely improved coverage.
  const resynthCoverage = measureEvidenceCoverage(cleanedResynth, evidence);
  const newItems = resynthCoverage.textItems;
  const improved = cleanedResynth.length > finalResponse.length * 1.2 || newItems > finalItems;
  if (!improved) {
    // Resynthesis did not materially improve the undercovered answer.
    // When rich delegated evidence exists, prefer that evidence over
    // keeping the incomplete summary that triggered correction.
    if (evidenceIsRich) {
      return evidence.evidence;
    }
    return finalResponse;
  }
  if (resynthCoverage.itemShortfall || resynthCoverage.lengthShortfall) {
    logAudit(
      "hallucinated_truncation_bypass",
      {
        evidenceLength: evidence.evidence.length,
        evidenceItems: evidence.itemCount,
        finalLength: finalResponse.length,
        finalItems,
        resynthLength: cleanedResynth.length,
        resynthItems: newItems,
        bypassReason: "resynthesis_still_under_coverage_threshold",
      },
      { sessionId: session.id, channel: session.channel, severity: "warn" },
    );
    return evidence.evidence;
  }
  return await rewriteTerminalResponseIfNeeded(cleanedResynth, toolIterations, session, provider, signal);
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateForContext(value: string, maxChars: number): string {
  const normalized = collapseWhitespace(value);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function truncatePlainText(value: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripAgentPrefix(value: string): string {
  return value.replace(/^\[[^\]]+\]:\s*/i, "").trim();
}

function stripWorkflowPreamble(value: string): string {
  // Remove "Workflow <name> [scene|job] completed/blocked ...\n\n" system prefix
  // so only the actual deliverable content reaches the orchestrator LLM.
  return value.replace(/^Workflow\s+\S+\s+\[(?:scene|job)\]\s+\S[^\n]*\n\n?/, "").trim();
}

function stripPresentationFormatting(value: string): string {
  return value
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function looksLikeDelegatedFailureEvidence(value: string): boolean {
  const preview = value.trim().slice(0, 600);
  if (!preview) return false;
  if (/^sub-agent produced no final response\.?$/i.test(preview)) return true;
  if (/<\|channel\>\w+/i.test(preview)) return true;
  if (looksLikeProviderErrorEcho(preview)) return true;
  return /^error:/i.test(preview)
    || /\b(no results|not found|unable to|failed to|timed out|cancelled|incomplete|max.{0,20}iterations|could not complete|did not complete|cannot complete|cannot proceed|delegation limit|already failed|not permitted|produced no final response|no usable delegated result returned)\b/i.test(preview)
    || /\bis already running via\s+(?:[a-z0-9_:-]*(?:_agent|_coordinator)|researcher|another agent)\b/i.test(preview)
    || /\bNo (?:agents|workflows) matched\b/i.test(preview)
    || /\b(container error|containerized delegation failed|sandbox (?:bootstrap|startup|start) failed|bootstrap failed|runtime crash(?:ed)?|terminated unexpectedly)\b/i.test(preview)
    || /\b(blocker:|missing source data|required .* unavailable|requested .* unavailable|not available in the current workspace|not available in the workspace|could not be fulfilled with exact figures|cannot be generated at this time|please provide the structured json data to proceed|please provide the source data to proceed|please provide .*json data|i need .*structured json.* to proceed|i need .*data to proceed|task cannot be completed|table does not exist|confirmed non-existent|no source provided the specific .* data)\b/i.test(preview);
}

const CONTINUATION_CUE_RE = /\b(next (logical )?(step|action)|n[äa]chste (logische )?(schritt|aktion)|before summarizing|continue orchestration|continue with|drill down|inspect the contents|fetch the contents|final required action|determine the actual data file format|extract the raw numerical values)\b/i;
const USER_INTERACTION_CUE_RE = /\b(please confirm|confirm .* before|approval required|needs approval|ask the user|missing .* from the user|which one|which option|clarify|need the user to|authorization reference|approved target scope)\b/i;

type PostOrchestrationDisposition = "continue" | "synthesize" | "ask_user" | "failure" | "none";

export function classifyPostOrchestrationDisposition(
  toolResultMessages: Array<LLMMessage & { metadata?: Record<string, unknown> }>,
): PostOrchestrationDisposition {
  const orchestrationResults = toolResultMessages.filter((message) => {
    const text = typeof message.content === "string" ? message.content : "";
    const isWorkflowExecutionResult = /^Workflow\s+.+\s+\[[^\]]+\]\s+(blocked|completed)\./i.test(text);
    return text.includes("Observed evidence:")
      && (
        text.includes("Delegated result from")
        || text.includes("Parallel delegation completed")
        || text.includes("Task graph completed")
        || isWorkflowExecutionResult
        || text.includes("Ephemeral agent ")
      );
  });

  if (orchestrationResults.length === 0) {
    return "none";
  }

  let sawContinuationCue = false;

  for (const message of orchestrationResults) {
    const text = typeof message.content === "string" ? message.content : "";
    const metadata = message.metadata ?? {};
    const agentName = typeof metadata["agentName"] === "string"
      ? String(metadata["agentName"])
      : (text.match(/^Delegated result from\s+([^\s—]+)/m)?.[1] ?? "");
    const terminalState = typeof metadata["terminalState"] === "string" ? String(metadata["terminalState"]) : undefined;
    const delegationSucceeded = metadata["delegationSucceeded"] !== false;
    const delegationOutcome = typeof metadata["delegationOutcome"] === "string" ? String(metadata["delegationOutcome"]) : undefined;
    const delegationPartial = delegationOutcome === "partial";
    const evidenceMatch = EVIDENCE_SECTION_RE.exec(text);
    const observedEvidence = evidenceMatch
      ? text.slice(evidenceMatch.index + evidenceMatch[0].length).trim()
      : text;
    const hasInterruptedShape = /Partial progress before interruption:|Recovered evidence snippets from completed tools:/i.test(observedEvidence);
    const interruptedPartialWithoutUsableEvidence = agentName !== "computer_use_agent"
      && delegationPartial
      && (looksLikeInterruptedDelegationWithoutUsableEvidence(text) || (!hasInterruptedShape && looksLikeOrchestrationOnlyEvidence(observedEvidence)));

    if (USER_INTERACTION_CUE_RE.test(text)) {
      return "ask_user";
    }

    if (/^Delegated result from .+ — TASK FAILED\./m.test(text)) {
      return "failure";
    }

    if (
      interruptedPartialWithoutUsableEvidence
      || !delegationSucceeded
      || delegationOutcome === "failure"
      || (!delegationPartial && terminalState && terminalState !== "completed")
      || (!delegationPartial && looksLikeDelegatedFailureEvidence(text))
    ) {
      return "failure";
    }

    // A timed-out partial result carries enough evidence to synthesize from.
    // Force "synthesize" immediately rather than letting the model re-delegate.
    if (delegationPartial && terminalState === "timeout") {
      return "synthesize";
    }

    if (CONTINUATION_CUE_RE.test(text)) {
      sawContinuationCue = true;
    }
  }

  return sawContinuationCue ? "continue" : "synthesize";
}

export function buildModelVisibleToolResult(
  toolName: string,
  resultText: string,
  metadata?: Record<string, unknown>,
): string {
  const fallback = truncateForContext(resultText, 600);

  if (toolName === "delegate_to_agent" || toolName === "swarm_delegate") {
    const agentName = typeof metadata?.["agentName"] === "string" ? String(metadata["agentName"]) : "delegated agent";
    const attemptedAgents = Array.isArray(metadata?.["attemptedAgents"])
      ? (metadata?.["attemptedAgents"] as unknown[]).map(String).filter(Boolean)
      : [];
    const routingReason = metadata?.["routingReason"] && typeof metadata["routingReason"] === "object"
      ? metadata["routingReason"] as Record<string, unknown>
      : undefined;
    const cleaned = stripPresentationFormatting(stripAgentPrefix(resultText));
    const delegationOutcome = typeof metadata?.["delegationOutcome"] === "string" ? String(metadata["delegationOutcome"]) : undefined;
    const hasInterruptedShape = /Partial progress before interruption:|Recovered evidence snippets from completed tools:/i.test(cleaned);
    const rawWorkspaceToolDump = looksLikeRawWorkspaceToolDump(cleaned);
    const partialHasNoUsableEvidence = agentName !== "computer_use_agent"
      && delegationOutcome === "partial"
      && (
        rawWorkspaceToolDump
        || looksLikeInterruptedDelegationWithoutUsableEvidence(cleaned)
        || (!hasInterruptedShape && looksLikeOrchestrationOnlyEvidence(cleaned))
      );
    // A "partial" outcome whose surfaced content is just a regurgitated
    // provider/HTTP error (e.g. LM Studio HTTP 500 HTML page that the
    // soft-deadline synthesis quoted back) is not a useful partial — the
    // model has no real evidence to relay.  Treat it as an outright
    // failure so the parent assistant gets a clear failure signal and
    // can ask the user to retry instead of trying to synthesize an
    // answer from an HTML error page.
    const partialIsProviderErrorEcho = delegationOutcome === "partial" && looksLikeProviderErrorEcho(cleaned);
    const delegationPartial = delegationOutcome === "partial"
      && !partialIsProviderErrorEcho
      && !partialHasNoUsableEvidence;
    const delegationFailed = rawWorkspaceToolDump
      || delegationOutcome === "failure"
      || partialIsProviderErrorEcho
      || partialHasNoUsableEvidence
      || (!delegationPartial && (
        metadata?.["delegationSucceeded"] === false
        || /^error:/i.test(cleaned)
        || looksLikeDelegatedFailureEvidence(cleaned)
      ));

    if (agentName === "computer_use_agent") {
      const evidence = truncatePlainText(cleaned, 1600);
      if (delegationFailed) {
        const parts = [
          `Delegated result from ${agentName} — TASK FAILED.`,
          attemptedAgents.length > 1 ? `Attempts: ${attemptedAgents.join(", ")}.` : "",
          routingReason?.["confidence"] ? `Routing confidence: ${String(routingReason["confidence"])}.` : "",
          "IMPORTANT: This delegated attempt failed. Report the failure honestly using only the explicit evidence below.",
          "Do NOT claim the task was completed.",
          "Do NOT invent root causes like connectivity, firewall, permissions, or configuration unless the evidence explicitly says so.",
          "Do NOT delegate again for the same information in this turn.",
          `Observed evidence:\n${evidence || "No usable delegated result returned."}`,
        ].filter(Boolean);
        return parts.join("\n");
      }
      if (delegationPartial) {
        const parts = [
          `Delegated result from ${agentName} — PARTIAL PROGRESS.`,
          attemptedAgents.length > 1 ? `Attempts: ${attemptedAgents.join(", ")}.` : "",
          routingReason?.["confidence"] ? `Routing confidence: ${String(routingReason["confidence"])}.` : "",
          "IMPORTANT: Use the evidence below. State clearly that the desktop run made progress but was interrupted before full completion.",
          "Do NOT ignore the collected evidence.",
          "Do NOT invent root causes like connectivity, firewall, permissions, or configuration unless the evidence explicitly says so.",
          "Do NOT delegate again for the same information in this turn unless the user asks for another attempt.",
          `Observed evidence:\n${evidence || "No usable delegated result returned."}`,
        ].filter(Boolean);
        return parts.join("\n");
      }
      const parts = [
        `Delegated result from ${agentName} — TASK COMPLETED SUCCESSFULLY.`,
        attemptedAgents.length > 1 ? `Attempts: ${attemptedAgents.join(", ")}.` : "",
        routingReason?.["confidence"] ? `Routing confidence: ${String(routingReason["confidence"])}.` : "",
        "IMPORTANT: Relay ALL specific details from the evidence below (names, numbers, sizes, statuses) in your answer. Do NOT omit items, say 'partially visible', or claim information is 'cut off' if the evidence lists it. The evidence is authoritative.",
        "Do NOT delegate again for the same information — it has already been collected.",
        `Observed evidence:\n${evidence || "No usable delegated result returned."}`,
      ].filter(Boolean);
      return parts.join("\n");
    }

    const partialEvidence = rawWorkspaceToolDump ? null : extractUsefulInterruptedDelegationEvidence(cleaned);
    // When the inner agent surfaced its full delegated specialist body via
    // the "Recovered delegated specialist body (full):" marker (Fix 2), the
    // partial evidence IS the actual completed sub-task answer — bump the
    // cap to the long-deliverable budget so it survives wrapping. Otherwise
    // the parent only sees ~1.6 KB of a 13 KB completed answer.
    const partialEvidenceHasFullBody = /Recovered delegated specialist body \(full\):/i.test(cleaned);
    const partialEvidenceCap = partialEvidenceHasFullBody ? 12_000 : 1600;
    const evidence = rawWorkspaceToolDump
      ? formatRawWorkspaceToolDumpFailure()
      : truncatePlainText(partialEvidence ?? cleaned, partialEvidenceCap);
    if (delegationFailed) {
      const parts = [
        `Delegated result from ${agentName} — TASK FAILED.`,
        attemptedAgents.length > 1 ? `Attempts: ${attemptedAgents.join(", ")}.` : "",
        routingReason?.["confidence"] ? `Routing confidence: ${String(routingReason["confidence"])}.` : "",
        "IMPORTANT: This delegated attempt failed. Report the failure honestly using only the explicit evidence below.",
        "Do NOT claim the task was completed or infer extra causes that are not explicitly present in the evidence.",
        `Observed evidence:\n${evidence || "No usable delegated result returned."}`,
      ].filter(Boolean);
      return parts.join("\n");
    }
    if (delegationPartial) {
      const terminalState = typeof metadata?.["terminalState"] === "string" ? String(metadata["terminalState"]) : undefined;
      const timedOut = terminalState === "timeout";
      const importantNote = timedOut
        ? "IMPORTANT: The specialist timed out. Use only the explicit partial evidence below; state what remains unverified or incomplete instead of filling gaps. Do NOT delegate again for this task in this turn."
        : "IMPORTANT: Use the partial evidence below to continue your workflow. Do NOT treat this as a workflow failure. Proceed with any dependent tools.";
      const parts = [
        `Delegated result from ${agentName} — PARTIAL PROGRESS${timedOut ? " (TIMEOUT)" : ""}.`,
        attemptedAgents.length > 1 ? `Attempts: ${attemptedAgents.join(", ")}.` : "",
        routingReason?.["confidence"] ? `Routing confidence: ${String(routingReason["confidence"])}.` : "",
        importantNote,
        `Observed evidence:\n${evidence || "No usable delegated result returned."}`,
      ].filter(Boolean);
      return parts.join("\n");
    }
    // For long completed deliverables (papers, reports, analyses) and
    // structured tabular/list content (markdown tables, numbered lists with
    // many rows) keep markdown intact and pass the full content so the
    // orchestrator LLM can relay it verbatim. Smaller models are otherwise
    // prone to summarising a 27-row headline table down to 2 rows and
    // appending an invented "(truncated)" marker.
    const tableRowCount = (cleaned.match(/^\s*\|.+\|\s*$/gm) ?? []).length;
    const numberedListCount = (cleaned.match(/^\s*\d{1,3}[.)]\s+\S/gm) ?? []).length;
    const bulletListCount = (cleaned.match(/^\s*[-*+]\s+\S/gm) ?? []).length;
    const looksStructured =
      tableRowCount >= 4 || numberedListCount >= 5 || bulletListCount >= 8;
    const isLongDeliverable = cleaned.length > 2500 || looksStructured;
    const successEvidence = isLongDeliverable
      ? truncatePlainText(stripWorkflowPreamble(stripAgentPrefix(resultText)), getConfig().agents.performance.maxDelegatedResultChars)
      : evidence;
    const importantNote = isLongDeliverable
      ? "IMPORTANT: Present the full content below VERBATIM to the user. Reproduce EVERY row, bullet, list item, table entry, heading, name, number, date, URL, and source exactly as shown. Do NOT summarize, shorten, rephrase, omit any section, collapse rows into 'and others', insert ellipses, or add markers like '(truncated)', '(abgeschnitten)', '(cut off)', '(Zusammenfassung)' — the evidence is the FULL deliverable, not a snippet. Output it exactly as-is, preserving all headings, bullet points, tables, and structure."
      : "IMPORTANT: Relay ALL specific details from the evidence below (names, numbers, values) in your answer. Do NOT paraphrase with different numbers or names. Do NOT add markers like '(truncated)' or '(abgeschnitten)'.";
    const parts = [
      `Delegated result from ${agentName} — TASK COMPLETED.`,
      attemptedAgents.length > 1 ? `Attempts: ${attemptedAgents.join(", ")}.` : "",
      routingReason?.["confidence"] ? `Routing confidence: ${String(routingReason["confidence"])}.` : "",
      importantNote,
      `Observed evidence:\n${successEvidence || "No usable delegated result returned."}`,
    ].filter(Boolean);
    return parts.join("\n");
  }

  if (toolName === "parallel_delegate") {
    const succeeded = Number(metadata?.["succeeded"] ?? 0);
    const failed = Number(metadata?.["failed"] ?? 0);
    const taskCount = Number(metadata?.["taskCount"] ?? succeeded + failed);
    const evidence = truncatePlainText(stripPresentationFormatting(resultText), 1600);
    return [
      `Parallel delegation completed. Successful tasks: ${succeeded}/${taskCount}. Failed tasks: ${failed}.`,
      "IMPORTANT: Relay ALL specific details from the evidence below (names, numbers, values, statuses) in your answer. Do NOT replace them with guessed details.",
      `Observed evidence:\n${evidence || "No usable delegated result returned."}`,
    ].join("\n");
  }

  if (toolName === "run_task_graph") {
    const completed = Array.isArray(metadata?.["completed"]) ? (metadata?.["completed"] as unknown[]).length : 0;
    const failed = Array.isArray(metadata?.["failed"]) ? (metadata?.["failed"] as unknown[]).length : 0;
    const blocked = Array.isArray(metadata?.["blocked"]) ? (metadata?.["blocked"] as unknown[]).length : 0;
    const evidence = truncatePlainText(stripPresentationFormatting(resultText), 1600);
    const taskGraphStatus = failed > 0 || blocked > 0
      ? `Task graph finished with incomplete status. Nodes completed: ${completed}. Failed: ${failed}. Blocked: ${blocked}.`
      : `Task graph completed. Nodes completed: ${completed}. Failed: ${failed}. Blocked: ${blocked}.`;
    return [
      taskGraphStatus,
      "IMPORTANT: Relay ALL specific details from the evidence below (task states, selected agents, values) in your answer. Do NOT replace them with guessed details.",
      `Observed evidence:\n${evidence || "No usable task-graph result returned."}`,
    ].join("\n");
  }

  if (toolName === "run_workflow") {
    const workflowName = typeof metadata?.["workflowName"] === "string" ? String(metadata["workflowName"]) : "workflow";
    const workflowType = typeof metadata?.["workflowType"] === "string" ? String(metadata["workflowType"]) : "workflow";
    const blocked = metadata?.["blocked"] === true;
    const stepCount = Number(metadata?.["stepCount"] ?? 1);
    const executedSteps = Number(metadata?.["executedSteps"] ?? stepCount);
    const evidence = truncatePlainText(stripPresentationFormatting(resultText), 1600);
    return [
      `Workflow ${workflowName} [${workflowType}] ${blocked ? "blocked" : "completed"}. Executed steps: ${executedSteps}/${stepCount}.`,
      blocked
        ? "IMPORTANT: This workflow did not complete. Treat the evidence below as a failure report, not as completed research. Do NOT jump straight to drafting-only agents like paper_author or summarizer unless earlier evidence was already collected successfully."
        : "IMPORTANT: Treat this as executed workflow output, not a plan. Relay the concrete evidence below and do not claim extra steps were run. Do NOT start fresh ad hoc delegation, create_ephemeral_agent, or rerun research for the same request in this turn unless the workflow evidence itself identifies one smallest corrective follow-up.",
      `Observed evidence:\n${evidence || "No usable workflow result returned."}`,
    ].join("\n");
  }

  if (toolName === "create_ephemeral_agent") {
    const agentName = typeof metadata?.["agentName"] === "string" ? String(metadata["agentName"]) : "ephemeral agent";
    const rejectedTools = Array.isArray(metadata?.["rejectedTools"]) ? (metadata?.["rejectedTools"] as unknown[]).map(String).filter(Boolean) : [];
    const evidence = truncatePlainText(stripPresentationFormatting(stripAgentPrefix(resultText)), 1600);
    const failed = looksLikeDelegatedFailureEvidence(evidence);
    return [
      `Ephemeral agent ${agentName} ${failed ? "failed" : "completed"}.`,
      rejectedTools.length > 0 ? `Rejected tools: ${rejectedTools.join(", ")}.` : "",
      failed
        ? "IMPORTANT: This ephemeral-agent attempt failed. Report the failure honestly using only the explicit evidence below. Do NOT claim the task was completed or delegated successfully."
        : "IMPORTANT: Relay ALL specific details from the evidence below in your answer.",
      `Observed evidence:\n${evidence || "No usable ephemeral-agent result returned."}`,
    ].filter(Boolean).join("\n");
  }

  if (toolName === "search_agents") {
    const evidence = truncatePlainText(stripPresentationFormatting(resultText), 1600);
    return [
      "Agent routing suggestions only. No delegation has happened yet.",
      "IMPORTANT: Treat this as candidate-selection guidance, not as proof that any task was routed or executed.",
      "If this turn ends without a completed delegate_to_agent call, do NOT tell the user that work was routed to any suggested agent.",
      `Observed evidence:\n${evidence || "No routing suggestions returned."}`,
    ].join("\n");
  }

  if (toolName === "search_workflows") {
    const evidence = truncatePlainText(stripPresentationFormatting(resultText), 1600);
    return [
      "Workflow catalog suggestions only. No workflow has been executed yet.",
      "IMPORTANT: Treat this as reusable-workflow discovery, not as proof that any scene or job ran.",
      "If this turn ends without a completed run_workflow call, do NOT tell the user that a workflow was executed.",
      "If concrete matches were returned, prefer run_workflow next instead of delegate_to_agent or other ad hoc orchestration.",
      `Observed evidence:\n${evidence || "No workflow matches returned."}`,
    ].join("\n");
  }

  if (toolName === "list_agents") {
    const evidence = truncatePlainText(stripPresentationFormatting(resultText), 1600);
    return [
      "Agent search results only. No delegation has happened yet.",
      "IMPORTANT: Treat this as candidate-selection guidance, not as proof that any task was routed or executed.",
      "If this turn ends without a completed delegate_to_agent call, do NOT tell the user that work was routed to any suggested agent.",
      `Observed evidence:\n${evidence || "No agent candidates returned."}`,
    ].join("\n");
  }

  // Informational capability directory the user explicitly asked for — relay it
  // in full (generously capped) instead of the small generic fallback. The full
  // list is below; explicitly tell the model not to abbreviate or claim
  // truncation (the slow local model otherwise lists only the first few).
  if (toolName === "agent_catalog") {
    return [
      "Complete specialist agent directory below — it is NOT truncated.",
      "If the user asked which agents exist or what they can do, list EVERY entry below. Do NOT abbreviate, sample, summarize to a few, or claim the list was cut off.",
      truncatePlainText(resultText, 12_000),
    ].join("\n");
  }

  return fallback;
}

export function buildTemporalContextPrompt(now: Date = new Date()): string {
  const formattedDate = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const isoDate = now.toISOString().slice(0, 10);
  return [
    `Authoritative temporal context for this turn: today's date is ${formattedDate} (${isoDate}). Current year: ${now.getFullYear()}.`,
    "If the answer mentions the current date, year, recency, deadlines, schedules, or terms like today, latest, current, next, or recent, it must be consistent with this date.",
    "When tool results provide dated evidence, prefer the freshest dated evidence and never fall back to older model memory.",
  ].join(" ");
}

export async function runTurn(opts: RunTurnOptions): Promise<TurnOutput> {
  const config = getConfig();
  // Per-turn timeout — inline override wins, then config, then default 15 min.
  // An explicit override of 0 disables the timeout entirely.
  const resolvedTurnTimeoutMs = opts.turnTimeoutOverrideMs ?? config.gateway?.turnTimeoutMs ?? 1_800_000;
  const turnTimeoutMs = resolvedTurnTimeoutMs > 0 ? resolvedTurnTimeoutMs : undefined;
  const turnAbort = turnTimeoutMs ? new AbortController() : undefined;
  const inertAbort = new AbortController();
  const timeoutHandle = turnAbort
    ? setTimeout(() => turnAbort.abort(), turnTimeoutMs)
    : undefined;

  // Warden abort: allows the Warden to cancel this turn mid-flight on severe anomalies.
  const wardenAbort = new AbortController();
  const sessionId = opts.session.id;
  registerSessionAbortController(sessionId, wardenAbort);
  // Fresh turn: clear any per-turn "operator stopped" latch so a stop in a
  // previous turn never auto-stops this one's long-running generations.
  longRunningGenerationManager.clearStopRequested(sessionId);
  // Mark this turn live so the user can steer it mid-flight (drained in the loop);
  // cleared in the finally below so the active flag never leaks across turns.
  turnSteeringManager.markTurnActive(sessionId);

  // Merge caller signal + timeout signal + warden signal: any source can cancel the turn.
  const allSignals: AbortSignal[] = [];
  if (opts.signal) allSignals.push(opts.signal);
  if (turnAbort) allSignals.push(turnAbort.signal);
  allSignals.push(wardenAbort.signal);
  const signal: AbortSignal = allSignals.length === 1
    ? allSignals[0]!
    : AbortSignal.any(allSignals);

  try {
    const out = await _runTurn(opts, signal, turnAbort?.signal ?? inertAbort.signal);
    return finalizeTurnOutput(out, sessionId);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    deregisterSessionAbortController(sessionId);
    turnSteeringManager.markTurnDone(sessionId);
  }
}

/**
 * Turn invariant — a chat turn must never hand the user a blank response.
 *
 * Most terminals build a non-empty message, but some suppression paths (e.g. a
 * tool call dropped as synthesis-required with no accompanying text, or an
 * unexpected early return) can leave `response` empty. This single chokepoint
 * on the runTurn boundary guarantees the user is never met with silence: an
 * empty/whitespace response is replaced with a graceful, recoverable message
 * and the occurrence is audited so the underlying cause stays visible.
 *
 * Non-empty responses pass through unchanged.
 */
export function finalizeTurnOutput(out: TurnOutput, sessionId: string): TurnOutput {
  if (out.response && out.response.trim().length > 0) return out;
  logAudit("guardrail_flagged", {
    type: "empty_response_recovered",
    blocked: out.blocked,
    finishReason: out.performance?.finishReason ?? "unknown",
  }, { sessionId, severity: "warn" });
  return {
    ...out,
    response: "I wasn't able to produce a complete answer this turn. Please retry, or rephrase the request — breaking a complex task into smaller parts usually helps.",
  };
}

async function _runTurn(opts: RunTurnOptions, signal: AbortSignal, timeoutSignal: AbortSignal): Promise<TurnOutput> {
  const { session, userMessage } = opts;
  const guardrailEvents: TurnOutput["guardrailEvents"] = [];
  const turnStartedAt = Date.now();
  let firstModelResponseMs: number | undefined;
  let llmCalls = 0;
  let llmTimeMs = 0;
  let toolCallsRequested = 0;
  let toolExecutionTimeMs = 0;
  let lastPromptMetrics = {
    systemPromptChars: 0,
    collapsedHistoryMessages: 0,
    collapsedHistoryChars: 0,
    promptChars: 0,
  };

  // ── Rate limit check ──────────────────────────────────────────────────────
  const rl = await checkRateLimit(session.id, "request");
  if (!rl.allowed) {
    logAudit("rate_limited", { remaining: 0, resetAt: rl.resetAt }, { sessionId: session.id });
    return blocked("Rate limit exceeded. Please wait before sending another message.");
  }

  // ── Input guardrail ───────────────────────────────────────────────────────
  // Scene/job runs carry the operator-authored task text from config as the
  // "message" (channel "scene"). That is trusted input, so the prompt-injection
  // scanner flags but does not block it — otherwise a scene's own security
  // instruction (e.g. "Never expose credential values") would hard-block the run
  // with zero turns. Untrusted channels (chat, telegram, email, webhook, a2a, …)
  // remain strictly blocked.
  const trustedWorkflowInput = session.channel === "scene";
  const inputCheck = checkInput(userMessage, { trusted: trustedWorkflowInput });
  if (!inputCheck.allowed) {
    const details = inputCheck.reason ?? "Prompt injection detected";
    logAudit("guardrail_blocked", { type: "input", reason: details, patterns: inputCheck.detectedPatterns }, {
      sessionId: session.id,
      severity: "warn",
    });
    guardrailEvents.push({ type: "input_blocked", details });
    return blocked(`I can't process that message: ${details}`);
  }

  if (inputCheck.detectedPatterns && inputCheck.detectedPatterns.length > 0) {
    guardrailEvents.push({ type: "input_flagged", details: inputCheck.reason ?? "" });
    logAudit("guardrail_flagged", { patterns: inputCheck.detectedPatterns }, { sessionId: session.id, severity: "warn" });
  }

  const moderatedInput = await moderateInputText(userMessage);
  if (moderatedInput?.blocked) {
    const details = `Model moderation blocked input: ${moderatedInput.summary}`;
    logAudit("guardrail_blocked", { type: "input_model", reason: details, categories: moderatedInput.categories }, {
      sessionId: session.id,
      severity: "warn",
    });
    guardrailEvents.push({ type: "input_model_blocked", details });
    return blocked(`I can't process that message: ${details}`);
  }

  if (moderatedInput?.flagged) {
    const details = `Model moderation flagged input: ${moderatedInput.summary}`;
    guardrailEvents.push({ type: "input_model_flagged", details });
    logAudit("guardrail_flagged", { type: "input_model", categories: moderatedInput.categories }, { sessionId: session.id, severity: "warn" });
  }

  // ── Build message history ─────────────────────────────────────────────────
  const userMetadata: Record<string, unknown> = {};
  if (opts.userDisplayContent?.trim()) {
    userMetadata["displayContent"] = opts.userDisplayContent.trim();
  }
  if (opts.userAttachments?.length) {
    userMetadata["attachments"] = opts.userAttachments;
  }
  session.addMessage({
    role: "user",
    content: userMessage,
    ...(Object.keys(userMetadata).length > 0 ? { metadata: userMetadata } : {}),
  });
  session.pruneTransientTurnSystemMessages();
  session.incrementTurn();

  logAudit("message_received", { length: userMessage.length }, {
    sessionId: session.id,
    channel: session.channel,
    userId: session.userId,
  });

  const detectedDynamicGuidance = buildDynamicTurnGuidance(userMessage);
  const priorDelegateEvidenceForFollowUp = findRecentDelegateEvidence(session.getHistory());
  const reusePriorDelegateEvidenceForFollowUp = shouldReusePriorDelegateEvidenceForSourceFollowUp(
    userMessage,
    detectedDynamicGuidance,
    priorDelegateEvidenceForFollowUp,
  );
  const effectiveToolMode: MainAssistantToolMode | undefined = detectedDynamicGuidance?.computerAccessSensitive && !detectedDynamicGuidance?.pentestSensitive
    ? "delegate_only"
    : ((detectedDynamicGuidance?.freshnessSensitive || (detectedDynamicGuidance?.sourceSensitive && !reusePriorDelegateEvidenceForFollowUp) || detectedDynamicGuidance?.artifactSensitive)
        ? "orchestration_only"
        : undefined);
  const initialDynamicGuidance = reusePriorDelegateEvidenceForFollowUp
    ? null
    : effectiveToolMode
    ? (buildDynamicTurnGuidance(userMessage, effectiveToolMode) ?? detectedDynamicGuidance)
    : detectedDynamicGuidance;
  // Canonical research subject for source-sensitive / required-research
  // delegations. A bare follow-up like "validate your response" carries no
  // topic; fold in the prior turn's request + answer so the specialist
  // researches the right thing instead of bouncing with "what should I
  // research?" (regression: session 3a35cff0).
  const { priorUserRequest, priorAssistantAnswer } = extractPriorTurnContext(session.getHistory(), userMessage);
  const researchSubject = buildEffectiveResearchSubject(userMessage, priorUserRequest, priorAssistantAnswer);
  const priorEvidenceFollowUpPrompt = reusePriorDelegateEvidenceForFollowUp && priorDelegateEvidenceForFollowUp
    ? buildPriorEvidenceFollowUpPrompt(priorDelegateEvidenceForFollowUp)
    : "";
  let allowedToolNames = getMainAssistantToolNames(effectiveToolMode);
  const suppressAgentCatalogTool = Boolean(
    (initialDynamicGuidance?.freshnessSensitive || initialDynamicGuidance?.sourceSensitive || initialDynamicGuidance?.artifactSensitive)
    && !isExplicitAgentCatalogRequest(userMessage),
  );
  if (suppressAgentCatalogTool) {
    allowedToolNames = allowedToolNames.filter((toolName) => toolName !== "list_agents");
  }
  const allowedToolNameSet = new Set(allowedToolNames);
  const recentWorkflowAuthoringMaintenanceContext = hasRecentWorkflowAuthoringMaintenanceContext(session.getHistory());
  const workflowCatalogSignal = detectWorkflowCatalogSignal(userMessage);
  const approvedRunCandidateFollowUp = detectApprovedRunCandidateFollowUp(session.getHistory(), userMessage);
  const tools = getToolsAsLLMDefs(allowedToolNames);
  // Register tool schema size on the session so the history trimmer accounts
  // for the full actual prompt cost (system + tool schemas + history), and the
  // context window of the model actually running this turn so the trimmer
  // budgets against the real window rather than the global default.
  session.setToolSchemasChars(JSON.stringify(tools).length);
  session.setContextWindow(getConfig().agents.defaults.model.contextWindow);
  const resolvedApprovalCallback = opts.autoApprove
    ? async (_toolName: string, _args: Record<string, unknown>) => true
    : opts.approvalCallback;

  const carriedSwarmTasks = loadPreviousTurnSwarmTasks(session.getHistory());
  const carriedSwarmTaskFingerprint = stableSerialize(carriedSwarmTasks);
  const toolContext: ToolContext = {
    sessionId: session.id,
    workspacePath: session.getWorkspacePath(),
    userId: session.userId,
    approvalCallback: resolvedApprovalCallback,
    inputCallback: opts.inputCallback,
    onSubAgentProgress: opts.onSubAgentProgress,
    onComputerAction: opts.onComputerAction,
    onComputerScreenshot: opts.onComputerScreenshot,
    onComputerSessionState: opts.onComputerSessionState,
    allowedAgents: opts.allowedAgents,
    allowedTools: allowedToolNames,
    humanInLoopSteps: opts.humanInLoopSteps,
    autoApprove: opts.autoApprove,
    maxIterationsOverride: opts.maxIterationsOverride,
    turnTimeoutOverrideMs: opts.turnTimeoutOverrideMs,
    onSwarmState: opts.onSwarmState,
    signal,
    _workflowExecutionStack: opts._workflowExecutionStack,
    swarmState: {
      objective: userMessage,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      // Seed from previous turn so retries reuse completed research instead of
      // running the same sub-agent tasks from scratch.
      tasks: carriedSwarmTasks,
    },
  };
  let turnUsedSwarmTools = false;
  const getTurnSwarmState = (): SwarmState | undefined => selectPersistableSwarmState(
    toolContext.swarmState,
    carriedSwarmTasks,
    carriedSwarmTaskFingerprint,
    turnUsedSwarmTools,
  );

  let totalUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let iterationCount = 0;
  // Per-tool output tracking within this turn — detects stuck loops (same result ≥N times).
  const _recentOutputsByTool = new Map<string, string[]>();
  const _turnToolCallCounts = new Map<string, number>();
  const _lastToolResultByName = new Map<string, string>();
  const _lastToolCallSig = new Map<string, { args: string; result: string; metadata?: Record<string, unknown> }>();
  const IDENTICAL_OUTPUT_LOOP_THRESHOLD = 3;
  // Iteration-level loop detection — tracks tool-name sets across iterations.
  const _iterationToolSets: string[] = [];
  const ITERATION_LOOP_THRESHOLD = 4;
  // Assistant text repetition detection — catches the LLM re-emitting identical text each iteration.
  let _lastAssistantContent = "";
  // Per-tool consecutive-iteration streak — catches tools re-appearing even when the full set varies.
  const _toolIterationStreak = new Map<string, number>();
  const TOOL_STREAK_THRESHOLD = 3;
  // Consecutive iterations where every tool call was blocked (per-turn limit / not-allowed).
  let _consecutiveFullyBlockedIterations = 0;
  // D16: Consecutive delegation failures — when ≥2, escalate to warden-stop synthesis.
  let _consecutiveDelegationFailures = 0;
  // I8: Reused-delegation counter — `executeDelegationWithFallback` returns
  // metadata.reused=true when a coordinator paraphrases a task whose
  // signature already completed in this session. After 2 reuses in one turn
  // the coordinator is clearly stuck re-asking for finished work; we stop and
  // synthesize from the cached output instead of burning more LLM iterations.
  let _turnReusedDelegationCount = 0;
  const REUSED_DELEGATION_LOOP_THRESHOLD = 2;
  // F29: Turn-level scorecard accumulators
  let _turnDelegationCount = 0;
  let _turnShareFindingCount = 0;
  let _forcedSynthesisFired = false;
  // G33: Collected share_finding texts for trajectory cache write
  const sharedFindingsThisTurn: string[] = [];
  // Phase 3: skills injected into the planner this turn — outcomes recorded at
  // turn end so retrieval reliability is learned (success rate drives ranking).
  let injectedSkillSlugs: string[] = [];
  // Skills that matched this turn but were deliberately held out (not injected)
  // for lift measurement — their outcome is recorded as a baseline at turn end.
  let heldOutSkillSlugs: string[] = [];
  // Shared findings injected into the main LLM context after delegations complete.
  // Populated once after the first delegation tool result arrives so the main
  // orchestrator's final synthesis call sees verified sub-agent findings rather
  // than falling back to training-data hallucinations.
  let _sharedFindingsSystemMessage = "";
  const FULLY_BLOCKED_ITERATION_THRESHOLD = 2;
  // Trust-the-LLM routing (Phase 2). The weak, false-positive-prone *freshness*
  // keyword heuristic ("jetzt"/"now"/"latest") no longer forces delegation when
  // trustModelRouting is on (default) — the model's own decision to answer
  // directly is respected; freshness stays as advisory guidance in the prompt.
  // *Source-sensitive* intent is explicit ("cite official sources", "search
  // online", product research) and still forces delegation for anti-hallucination
  // value. Set trustModelRouting=false to also force on freshness. Either way the
  // never-empty release applies if the model declines after the nudge.
  const trustModelRouting = getConfig().agents.mainAssistant.trustModelRouting !== false;
  // Soft routing enforcement (Flaw 2): when on, the routing-class enforcement
  // prompts (maintenance / workflow-catalog / search-no-match) are injected as
  // advisory hints rather than hard "You MUST … this turn" gates, and the hard
  // search_agents tool-removal gate is relaxed. Anti-hallucination (source-
  // sensitive research) and correctness (unresolved clarification) enforcement
  // stay hard. Default off — flipping it on changes tuned routing behavior and
  // should be gated on live-model eval.
  const softRoutingEnforcement = getConfig().agents.performance.softRoutingEnforcement === true;
  const applyRoutingTone = (text: string): string =>
    softRoutingEnforcement && text ? toSoftRoutingHint(text) : text;
  // A workflow-channel session is a scoped scene/job STEP: the author already wrote its
  // task (which names the exact agent) and its allowedAgents. The top-level source-sensitive
  // TASK rewrite must NOT fire here — it re-frames the step's delegation as a generic "WEB
  // RESEARCH TASK" and appends researcher/mission_coordinator fallbacks the step forbids,
  // so e.g. the image step gets routed to researcher and hard-fails (audit 158f1435). The
  // research-routing NUDGE stays on, but its fallback route is now allowedAgents-aware
  // (buildRequiredResearchFallbackRoute) so it targets the step's OWN agent, never an agent
  // outside the scene. The TOP-LEVEL launching turn (user channel) keeps full enforcement.
  const inWorkflowStep = session.channel === "workflow";
  const requiresDelegatedResearch = effectiveToolMode === "orchestration_only"
    && Boolean(
      initialDynamicGuidance?.sourceSensitive
      || (initialDynamicGuidance?.freshnessSensitive && !trustModelRouting),
    );
  const requiresArtifactDelegation = effectiveToolMode === "orchestration_only"
    && Boolean(initialDynamicGuidance?.artifactSensitive);
  const activeMainAssistantToolMode = effectiveToolMode ?? getConfig().agents.mainAssistant.toolMode;
  const requiresSwarmMaintenanceDelegation = activeMainAssistantToolMode !== "hybrid"
    && Boolean(initialDynamicGuidance?.swarmMaintenanceSensitive)
    && allowedToolNameSet.has("delegate_to_agent");
  const requiresMaintenanceFollowUpDelegation = recentWorkflowAuthoringMaintenanceContext
    && (allowedToolNameSet.has("delegate_to_agent")
      || allowedToolNameSet.has("parallel_delegate")
      || allowedToolNameSet.has("run_task_graph")
      || allowedToolNameSet.has("create_ephemeral_agent"));
  const requiresMaintenanceDelegation = requiresSwarmMaintenanceDelegation || requiresMaintenanceFollowUpDelegation;
  let delegatedResearchRetryUsed = false;
  let delegatedResearchEnforcementPrompt = "";
  let maintenanceDelegationRetryUsed = false;
  let maintenanceMisrouteRetryUsed = false;
  let maintenanceDelegationEnforcementPrompt = "";
  let unresolvedDelegationContinuationRetryUsed = false;
  let unresolvedDelegationEnforcementPrompt = "";
  // Synthesis-required-after-junk recovery retry. The synthesis-required
  // guardrail rejects further tool calls once a forced-synthesis nudge is in
  // history — the right behavior when the prior delegation actually returned
  // substantial evidence. But when the prior delegation TIMED OUT and what
  // the model received was a truncated stub, the model's recovery delegation
  // is correct: there is nothing useful to synthesize from. Allow ONE such
  // recovery retry per turn (Fix 3).
  let synthesisRequiredRecoveryRetryUsed = false;
  const isWorkflowExecutionTurn = session.channel === "workflow" || (opts._workflowExecutionStack?.length ?? 0) > 0;
  const workflowCatalogSuppressedForMaintenance = Boolean(
    initialDynamicGuidance?.swarmMaintenanceSensitive || recentWorkflowAuthoringMaintenanceContext,
  );
  const workflowCatalogGuidance = !isWorkflowExecutionTurn && !workflowCatalogSuppressedForMaintenance && workflowCatalogSignal.required
    ? buildWorkflowCatalogGuidance(workflowCatalogSignal)
    : "";
  const approvedRunCandidateGuidance = !isWorkflowExecutionTurn && approvedRunCandidateFollowUp
    ? buildApprovedRunCandidateGuidance(approvedRunCandidateFollowUp)
    : "";
  const workflowCatalogRequired = Boolean(
    (allowedToolNameSet.has("search_workflows") || allowedToolNameSet.has("run_workflow"))
    && !isWorkflowExecutionTurn
    && !initialDynamicGuidance?.pentestMethodologySensitive
    && !workflowCatalogSuppressedForMaintenance
    && workflowCatalogSignal.required
    // Uncertain matches advise the model to ASK the user; they do NOT enforce
    // that a workflow tool must be called this turn.
    && workflowCatalogSignal.reason !== "uncertain_match",
  );
  let workflowCatalogRetryUsed = false;
  let workflowCatalogEnforcementPrompt = "";
  // Seed from history: if the previous turn already ran search_workflows / run_workflow in this
  // session, skip the catalog-check enforcement on the follow-up turn (e.g. "try again").
  // We only look in messages that belong to the immediately prior completed turn — between the
  // second-to-last user message and the current (most recent) user message.
  const workflowCatalogAttemptedInPriorTurn = (() => {
    if (!workflowCatalogRequired) return false;
    const hist = session.getHistory();
    let foundCurrentUser = false;
    for (let i = hist.length - 1; i >= Math.max(0, hist.length - 40); i--) {
      const msg = hist[i];
      if (msg?.role === "user") {
        if (!foundCurrentUser) { foundCurrentUser = true; continue; }
        // Reached the start of the prior turn — stop here
        break;
      }
      if (msg?.role === "assistant" && Array.isArray(msg.tool_calls)) {
        if (msg.tool_calls.some((tc) => isWorkflowCatalogToolName(tc.function.name))) {
          return true;
        }
      }
    }
    return false;
  })();
  let workflowCatalogAttemptedThisTurn = workflowCatalogAttemptedInPriorTurn;
  let workflowExecutionRetryUsed = false;
  let workflowExecutionForceUsed = false;
  let workflowExecutionCorrectionRetryUsed = false;
  let workflowExecutionEnforcementPrompt = "";
  let approvedRunCandidateRetryUsed = false;
  let approvedRunCandidateEnforcementPrompt = "";
  let workflowSearchMatches: WorkflowCatalogMatch[] = [];
  let workflowRunCompletedThisTurn = false;
  // Track the most recent assistant text content that we suppressed because
  // the model emitted it alongside (rejected-or-not) tool calls.  When the
  // turn ends in a give-up state (synthesis loop, all tool calls blocked,
  // max iterations) AND the synthesis call itself comes back empty / short,
  // the suppressed text is still the closest thing we have to a real
  // answer the model wrote — better than the 73-char apology that
  // operators have been reporting.
  let lastSuppressedAssistantText: string | null = null;
  let pendingSearchAgentSuggestion: { agentName: string; query?: string; fallbackAgents?: string[] } | undefined;
  let searchAgentsNoMatchCount = 0;
  let requiredResearchFallbackRoute: RequiredResearchFallbackRoute | null = null;
  let searchAgentsNoMatchFallbackPrompt = "";
  const provider = opts.enableThinking !== undefined
    ? getChatProviderWithOverride({ enableThinking: opts.enableThinking })
    : getChatProvider();
  // Tool development sessions have no iteration cap — they use convergence-based completion
  // and lease/heartbeat oversight via the tool-dev-warden instead.
  const isToolDevSession = !!opts._toolDevSessionId;
  const maxToolIterations = isToolDevSession
    ? Number.MAX_SAFE_INTEGER
    : (opts.maxIterationsOverride === 0
        ? Number.MAX_SAFE_INTEGER
        : (opts.maxIterationsOverride ?? getConfig().agents.maxToolIterations ?? DEFAULT_MAX_TOOL_ITERATIONS));
  let terminalSynthesisInstruction =
    "You have reached the tool-call limit for this turn. Using ONLY the information gathered in the tool results above, write a complete, useful response to the original request. Do NOT call any more tools. If data is incomplete, acknowledge it and provide the best answer possible with what you have.";
  let terminalFinishReason = "max_tool_iterations";
  // ── G33: Trajectory cache lookup ─────────────────────────────────────────
  // Before the first LLM call, check if we have a cached trajectory for a
  // semantically similar recent query.  If yes, inject it as extra system context
  // so the model can decide whether to reuse or re-research the evidence.
  let trajectoryInjectionContext = "";
  let injectedTrajectoryIdentity: { normalizedQuery: string; finishedAt: string } | null = null;
  try {
    const cachedHit = await lookupTrajectory(
      userMessage,
      session.getWorkspacePath(),
      initialDynamicGuidance?.freshnessSensitive ?? false,
    );
    const cachedTrajectory = cachedHit?.entry ?? null;
    if (cachedTrajectory && cachedTrajectory.finalAnswer.length > 50) {
      const evidence = cachedTrajectory.sharedFindings.length > 0
        ? `\n\nEvidence gathered:\n${cachedTrajectory.sharedFindings.slice(0, 5).map(f => `• ${f.slice(0, 300)}`).join("\n")}`
        : "";
      trajectoryInjectionContext =
        `[CACHED RECENT EVIDENCE — verify before reuse, cached at ${cachedTrajectory.finishedAt}]\n${cachedTrajectory.finalAnswer.slice(0, 1500)}${evidence}`;
      injectedTrajectoryIdentity = {
        normalizedQuery: cachedTrajectory.normalizedQuery,
        finishedAt: cachedTrajectory.finishedAt,
      };
      logAudit(
        "trajectory_cache_hit",
        {
          similarity: Number(cachedHit!.similarity.toFixed(3)),
          ageMs: Date.now() - new Date(cachedTrajectory.finishedAt).getTime(),
          findingsCount: cachedTrajectory.sharedFindings.length,
          finalAnswerChars: cachedTrajectory.finalAnswer.length,
        },
        { sessionId: session.id, channel: session.channel },
      );
    }
  } catch { /* best-effort — never block the turn */ }

  // ── Main agent loop ───────────────────────────────────────────────────────
  while (iterationCount < maxToolIterations) {
    if (signal.aborted) {
      // Only synthesize when the INTERNAL timeout fired — not when the caller (WS) disconnected.
      // Synthesising after a WS close wastes LLM budget: the result can never be delivered.
      const wasInternalTimeout = timeoutSignal.aborted;
      if (wasInternalTimeout && iterationCount > 0) {
        const synthesized = await forceSynthesis(
          session, provider, signal,
          "The request timed out mid-turn. Using ONLY the tool results gathered so far, write the most useful partial response you can. Be explicit about what was completed and what was not.",
        );
        if (synthesized) {
          const finalResponse = sanitizeUserFacingAssistantResponse(synthesized, iterationCount) || synthesized;
          persistAssistantTurnState(session, finalResponse, getTurnSwarmState());
          if (opts.onChunk) opts.onChunk(finalResponse);
          const performance = buildTurnPerformanceMetrics({
            turnStartedAt, firstModelResponseMs, llmCalls, llmTimeMs, toolCallsRequested,
            toolExecutionTimeMs, lastPromptMetrics, completionChars: finalResponse.length,
            finishReason: "aborted_synthesized", blocked: false, toolIterations: iterationCount,
          });
          return {
            response: finalResponse, toolCallsExecuted: iterationCount,
            guardrailEvents, usage: totalUsage, blocked: false,
            swarmState: getTurnSwarmState(), performance,
          };
        }
      }
      return blocked(
        "Request cancelled or timed out",
        getTurnSwarmState(),
        buildTurnPerformanceMetrics({
          turnStartedAt,
          firstModelResponseMs,
          llmCalls,
          llmTimeMs,
          toolCallsRequested,
          toolExecutionTimeMs,
          lastPromptMetrics,
          completionChars: 0,
          finishReason: "aborted",
          blocked: true,
          toolIterations: iterationCount,
        }),
      );
    }

    // Mid-turn user steering: fold any messages the user sent WHILE this turn
    // has been running into the conversation as authoritative guidance before the
    // next model call, so they redirect the remaining work without aborting (Stop
    // is the abort path). Drains the per-turn queue; a no-op on iteration 0 (the
    // queue was cleared at turn start). Opt-out via orchestration.midTurnSteering.
    if (getConfig().orchestration?.midTurnSteering ?? true) {
      const steering = turnSteeringManager.drain(session.id);
      if (steering.length > 0) {
        const joined = steering.map((s) => `- ${s}`).join("\n");
        session.addMessage({
          role: "user",
          content: "[USER STEERING — sent mid-turn] The user added the following while you were working. "
            + "Take it into account in the REMAINING steps of this turn: adjust course, drop now-irrelevant work, and prioritise it. "
            + "Do not restart from scratch or re-do already-completed steps.\n" + joined,
        });
        logAudit("turn_steering_injected", {
          count: steering.length,
          iteration: iterationCount,
        }, { sessionId: session.id, channel: session.channel, severity: "info" });
        opts.onStatus?.({ phase: "steering", message: "Folding in your mid-turn message…", iteration: iterationCount });
      }
    }

    let systemPrompt = session.getSystemPrompt();
    const temporalContext = buildTemporalContextPrompt();
    const dynamicGuidance = iterationCount === 0 ? initialDynamicGuidance : null;
    // Lean context injection: when on, the heavy per-turn memory/user-model/skill/
    // flow/trajectory blocks are not pushed into the prompt — the model pulls them
    // on demand via recall_context (see config.agents.performance.leanContextInjection).
    // This also skips the retrieval calls entirely, saving latency on turns that
    // don't need that context.
    const leanContextInjection = getConfig().agents.performance.leanContextInjection === true;
    const injectTurnContext = iterationCount === 0 && !leanContextInjection;
    let flowGuidance = injectTurnContext
      ? formatFlowMemoryGuidance(session.getWorkspacePath(), userMessage, { limit: 3 })
      : "";
    const languageAndIdentityGuidance = iterationCount === 0
      ? buildLanguageAndIdentityTurnGuidance(userMessage)
      : "";
    let memoryGuidance = injectTurnContext
      ? await formatScopedMemoryGuidance(session.getWorkspacePath(), userMessage, {
          sessionId: session.id,
          scopes: ["session", "workspace", "user"],
          limit: 4,
          maxChars: Math.min(1_400, Math.round(getConfig().agents.performance.promptBudgetChars * 0.08)),
        })
      : "";
    // Procedural memory: surface reusable skills the swarm distilled from past
    // successful work, so the planner reuses a known-good approach before
    // inventing a fresh plan. Guidance only — the guardrail stack still applies.
    let skillGuidance = "";
    if (injectTurnContext && getConfig().skillLibrary.enabled) {
      const retrieved = await retrieveSkillGuidance(session.getWorkspacePath(), userMessage, {
        maxChars: Math.min(1_400, Math.round(getConfig().agents.performance.promptBudgetChars * 0.08)),
      });
      skillGuidance = retrieved.text;
      injectedSkillSlugs = retrieved.slugs;
      heldOutSkillSlugs = retrieved.heldOutSlugs ?? [];
    }
    // Dialectic user model — small, injected only when populated. Adapts the
    // agent to the user across sessions; droppable under prompt budget.
    let userModelGuidance = injectTurnContext ? formatUserModelGuidance() : "";
    let activeTrajectoryInjectionContext = injectTurnContext ? trajectoryInjectionContext : null;
    // In lean mode, replace the always-on context blocks with a one-line pointer
    // so the model knows to pull what it needs instead of assuming it is in view.
    const contextRecallDigest = (iterationCount === 0 && leanContextInjection)
      ? "Durable memory, the user model, this session's working facts, recent related sessions, and learned skills are NOT preloaded into this prompt. Before any non-trivial planning or delegation, call recall_context(query) to pull what is relevant. Do not assume that context is already in view."
      : "";
    // Plan-first checkpoint: on a genuinely multi-area / multi-step turn, nudge
    // the orchestrator to record a short structured plan before fanning out so
    // the risk-gated QA pass can check the answer against acceptance criteria and
    // the operator dock can surface a high-stakes plan for approval. Soft and
    // droppable; trivial and single-domain turns are unaffected.
    let planGuidance = (iterationCount === 0 && (getConfig().orchestration?.planFirst ?? true) && looksMultiDomainResearch(userMessage))
      ? "PLAN FIRST: this spans several steps/areas. Before fanning out, CONSIDER REUSABLE WORKFLOWS: if a 'Strong reusable match' scene/job is noted this turn, plan a reuse step that runs it via run_workflow; otherwise call search_workflows ONCE to check whether an existing scene or job already fits before decomposing into agents. Then call record_plan once with a short plan — objective; the few steps (each tagged reuse | delegate | direct, with agentName for delegate steps and a parallelGroup for genuinely independent work); the acceptance criteria the answer must meet; and stop conditions. Prefer a reuse step (run an existing scene/job/workflow via run_workflow) over decomposing into agents when one fits. Do not over-fan-out — keep parallel work to independent steps only."
      : "";
    const collapsedHistory = session.getCollapsedHistory();

    const buildSystemMessages = (): LLMMessage[] => [
      { role: "system", content: systemPrompt },
      { role: "system", content: temporalContext },
      ...(languageAndIdentityGuidance ? [{ role: "system" as const, content: languageAndIdentityGuidance }] : []),
      ...(priorEvidenceFollowUpPrompt ? [{ role: "system" as const, content: priorEvidenceFollowUpPrompt }] : []),
      ...(dynamicGuidance ? [{ role: "system" as const, content: dynamicGuidance.prompt }] : []),
      ...(contextRecallDigest ? [{ role: "system" as const, content: contextRecallDigest }] : []),
      ...(planGuidance ? [{ role: "system" as const, content: planGuidance }] : []),
      ...(workflowCatalogGuidance ? [{ role: "system" as const, content: workflowCatalogGuidance }] : []),
      ...(approvedRunCandidateGuidance ? [{ role: "system" as const, content: approvedRunCandidateGuidance }] : []),
      ...(delegatedResearchEnforcementPrompt ? [{ role: "system" as const, content: delegatedResearchEnforcementPrompt }] : []),
      ...(searchAgentsNoMatchFallbackPrompt ? [{ role: "system" as const, content: applyRoutingTone(searchAgentsNoMatchFallbackPrompt) }] : []),
      ...(maintenanceDelegationEnforcementPrompt ? [{ role: "system" as const, content: applyRoutingTone(maintenanceDelegationEnforcementPrompt) }] : []),
      ...(unresolvedDelegationEnforcementPrompt ? [{ role: "system" as const, content: unresolvedDelegationEnforcementPrompt }] : []),
      ...(workflowCatalogEnforcementPrompt ? [{ role: "system" as const, content: applyRoutingTone(workflowCatalogEnforcementPrompt) }] : []),
      ...(approvedRunCandidateEnforcementPrompt ? [{ role: "system" as const, content: approvedRunCandidateEnforcementPrompt }] : []),
      ...(workflowExecutionEnforcementPrompt ? [{ role: "system" as const, content: workflowExecutionEnforcementPrompt }] : []),
      ...(flowGuidance ? [{ role: "system" as const, content: flowGuidance }] : []),
      ...(skillGuidance ? [{ role: "system" as const, content: skillGuidance }] : []),
      ...(userModelGuidance ? [{ role: "system" as const, content: userModelGuidance }] : []),
      ...(memoryGuidance ? [{ role: "system" as const, content: memoryGuidance }] : []),
      // G33: Inject cached trajectory evidence on first iteration only
      ...(iterationCount === 0 && activeTrajectoryInjectionContext ? [{ role: "system" as const, content: activeTrajectoryInjectionContext }] : []),
      // Inject shared findings from sub-agents on post-delegation iterations so the
      // main orchestrator's synthesis call sees verified facts instead of hallucinating
      // from training data (e.g. mic interface type, verified part specs, etc.).
      ...(_sharedFindingsSystemMessage ? [{ role: "system" as const, content: _sharedFindingsSystemMessage }] : []),
    ];

    let systemMessages = buildSystemMessages();
    lastPromptMetrics = measurePrompt(systemMessages, collapsedHistory);

    // ── Per-section prompt-size telemetry ─────────────────────────────────
    // Emitted once per turn (iteration 0) so we can see exactly what dominates
    // the system prompt and prove the win from lean context injection. The base
    // template is typically the bulk; memory/skill/user/flow/trajectory are the
    // reducible part that recall_context now covers on demand.
    if (iterationCount === 0) {
      logAudit("prompt_section_sizes", {
        total: lastPromptMetrics.systemPromptChars,
        base: systemPrompt.length,
        temporal: temporalContext.length,
        dynamicGuidance: dynamicGuidance?.prompt.length ?? 0,
        languageIdentity: languageAndIdentityGuidance.length,
        flow: flowGuidance.length,
        skill: skillGuidance.length,
        userModel: userModelGuidance.length,
        memory: memoryGuidance.length,
        plan: planGuidance.length,
        trajectory: activeTrajectoryInjectionContext?.length ?? 0,
        contextDigest: contextRecallDigest.length,
        leanContextInjection,
      }, { sessionId: session.id, severity: "info" });
    }

    // ── Prompt budget enforcement ─────────────────────────────────────────
    // Fix 6: when the system prompt exceeds the configured budget, trim
    // optional/auxiliary sections in priority order (least → most critical)
    // until under budget OR no further drops are available. The previous
    // behavior was to log a warning and ship the over-budget prompt anyway,
    // which never actually reduced any prompt and made the audit a dead
    // signal. We never touch the main systemPrompt or active enforcement
    // prompts — those were set this turn for a reason.
    if (iterationCount === 0) {
      const promptBudget = getConfig().agents.performance.promptBudgetChars;
      if (lastPromptMetrics.systemPromptChars > promptBudget) {
        const initialChars = lastPromptMetrics.systemPromptChars;
        const droppedSections: Array<{ name: string; chars: number }> = [];

        // Priority 1: trajectory injection (cached evidence — helpful but optional)
        if (lastPromptMetrics.systemPromptChars > promptBudget && activeTrajectoryInjectionContext) {
          droppedSections.push({ name: "trajectoryInjectionContext", chars: activeTrajectoryInjectionContext.length });
          activeTrajectoryInjectionContext = null;
          systemMessages = buildSystemMessages();
          lastPromptMetrics = measurePrompt(systemMessages, collapsedHistory);
        }
        // Priority 2: memory guidance (background context — non-critical)
        if (lastPromptMetrics.systemPromptChars > promptBudget && memoryGuidance) {
          droppedSections.push({ name: "memoryGuidance", chars: memoryGuidance.length });
          memoryGuidance = "";
          systemMessages = buildSystemMessages();
          lastPromptMetrics = measurePrompt(systemMessages, collapsedHistory);
        }
        // Priority 2b: skill guidance (procedural memory — non-critical)
        if (lastPromptMetrics.systemPromptChars > promptBudget && skillGuidance) {
          droppedSections.push({ name: "skillGuidance", chars: skillGuidance.length });
          skillGuidance = "";
          systemMessages = buildSystemMessages();
          lastPromptMetrics = measurePrompt(systemMessages, collapsedHistory);
        }
        // Priority 2c: user-model guidance (cross-session adaptation — non-critical)
        if (lastPromptMetrics.systemPromptChars > promptBudget && userModelGuidance) {
          droppedSections.push({ name: "userModelGuidance", chars: userModelGuidance.length });
          userModelGuidance = "";
          systemMessages = buildSystemMessages();
          lastPromptMetrics = measurePrompt(systemMessages, collapsedHistory);
        }
        // Priority 3: flow guidance (workflow memory — non-critical)
        if (lastPromptMetrics.systemPromptChars > promptBudget && flowGuidance) {
          droppedSections.push({ name: "flowGuidance", chars: flowGuidance.length });
          flowGuidance = "";
          systemMessages = buildSystemMessages();
          lastPromptMetrics = measurePrompt(systemMessages, collapsedHistory);
        }
        // Priority 4: plan-first nudge — high value (governs turn structure), so
        // dropped only under the most extreme prompt pressure, after the above.
        if (lastPromptMetrics.systemPromptChars > promptBudget && planGuidance) {
          droppedSections.push({ name: "planGuidance", chars: planGuidance.length });
          planGuidance = "";
          systemMessages = buildSystemMessages();
          lastPromptMetrics = measurePrompt(systemMessages, collapsedHistory);
        }
        // Priority 4 (last resort): compact the base system prompt itself.
        // Until now the trimmer dropped only auxiliary blocks and shipped the
        // base over budget anyway — the base is the dominant consumer, so the
        // audit signal was effectively dead. This strips clearly non-load-bearing
        // verbose sections (response-format/formatting guidance) while preserving
        // Core Principles, Swarm Rules, Tool Use Discipline, and Security. It
        // fires only when everything else has been dropped and we are still over.
        if (lastPromptMetrics.systemPromptChars > promptBudget) {
          const compacted = compactBasePromptUnderPressure(systemPrompt);
          if (compacted.length < systemPrompt.length) {
            droppedSections.push({ name: "basePromptCompaction", chars: systemPrompt.length - compacted.length });
            systemPrompt = compacted;
            systemMessages = buildSystemMessages();
            lastPromptMetrics = measurePrompt(systemMessages, collapsedHistory);
          }
        }

        const stillOver = lastPromptMetrics.systemPromptChars > promptBudget;
        logAudit("prompt_budget_exceeded", {
          systemPromptChars: lastPromptMetrics.systemPromptChars,
          budgetChars: promptBudget,
          initialChars,
          excessChars: Math.max(0, lastPromptMetrics.systemPromptChars - promptBudget),
          agentId: session.id,
          droppedSections: droppedSections.map((section) => section.name),
          droppedChars: droppedSections.reduce((sum, section) => sum + section.chars, 0),
          remainsOverBudget: stillOver,
        }, { sessionId: session.id, severity: stillOver ? "warn" : "info" });
        log.warn({
          initialChars,
          finalChars: lastPromptMetrics.systemPromptChars,
          budget: promptBudget,
          droppedSections: droppedSections.map((section) => section.name),
          remainsOverBudget: stillOver,
        }, stillOver
          ? "System prompt still exceeds budget after trimming optional sections — consider shortening the main system prompt or enforcement messages"
          : "System prompt was over budget; trimmed optional sections to fit");
      }
    }

    const messages: LLMMessage[] = [...systemMessages, ...collapsedHistory];

    if (iterationCount === 0 && dynamicGuidance) {
      logAudit("turn_guidance_applied", {
        sourceSensitive: dynamicGuidance.sourceSensitive,
        freshnessSensitive: dynamicGuidance.freshnessSensitive,
      }, { sessionId: session.id, severity: "info" });
    } else if (iterationCount === 0 && priorEvidenceFollowUpPrompt) {
      logAudit("turn_guidance_applied", {
        sourceSensitive: false,
        freshnessSensitive: false,
        reusedPriorDelegatedEvidence: true,
        originalSourceSensitive: detectedDynamicGuidance?.sourceSensitive ?? false,
      }, { sessionId: session.id, severity: "info" });
    }

    let llmResponse: LLMResponse;
    const llmStartedAt = Date.now();
    llmCalls += 1;
    try {
      const suppressInitialInlineStreaming = iterationCount === 0 && (
        requiresDelegatedResearch
        || requiresArtifactDelegation
        || workflowCatalogRequired
        || requiresMaintenanceDelegation
      );
      const chunkSink = iterationCount === 0 && !suppressInitialInlineStreaming ? opts.onChunk : undefined;
      if (!chunkSink) {
        opts.onStatus?.({
          phase: suppressInitialInlineStreaming ? "routing" : "synthesizing",
          message: suppressInitialInlineStreaming
            ? "Selecting the required specialist path before drafting the answer."
            : "Reviewing completed tool results and preparing the final response.",
          iteration: iterationCount,
        });
      }
      // After a search_agents no-match, the hard gate removes the discovery
      // tools so the model cannot loop on broader keyword retries. Under soft
      // routing enforcement we keep them available and rely on the (softened)
      // fallback hint instead — trust-the-LLM over a hard tool removal.
      const activeTools = (searchAgentsNoMatchFallbackPrompt && !softRoutingEnforcement)
        ? tools.filter((tool) => tool.name !== "search_agents" && tool.name !== "list_agents")
        : tools;
      llmResponse = await collectStream(provider.stream(messages, activeTools, signal), chunkSink, {
        deferTextUntilToolDecision: activeTools.length > 0,
        onReasoning: opts.onReasoning,
      });
      const llmDurationMs = Date.now() - llmStartedAt;
      llmTimeMs += llmDurationMs;
      if (firstModelResponseMs === undefined) {
        firstModelResponseMs = Date.now() - turnStartedAt;
      }
      if (llmResponse.reasoning && llmResponse.reasoning.trim()) {
        const reasoningText = llmResponse.reasoning.trim();
        logAudit("agent_reasoning", {
          iteration: iterationCount,
          reasoningChars: reasoningText.length,
          reasoningPreview: reasoningText.slice(0, 2000),
        }, { sessionId: session.id, channel: session.channel, severity: "info" });
      }
      if (llmResponse.tool_calls.length === 0 && llmResponse.finishReason === "length") {
        const continued = await continueLengthLimitedResponse(provider, messages, llmResponse, signal, chunkSink);
        llmResponse = continued.response;
        llmCalls += continued.additionalCalls;
        llmTimeMs += continued.additionalTimeMs;
        if (continued.runawayInlineArtifact) {
          // Orchestrator inlined a giant code block instead of delegating to
          // an artifact-writing specialist. We stopped the length-continuation
          // loop early so the partial doesn't balloon further, but the
          // partial itself is still going out — flag it so the scorecard
          // doesn't claim a clean turn.
          guardrailEvents.push({ type: "runaway_inline_artifact", details: `orchestrator inlined ${llmResponse.content?.length ?? 0} chars of code instead of delegating` });
          logAudit("guardrail_flagged", {
            type: "runaway_inline_artifact",
            completionChars: llmResponse.content?.length ?? 0,
            iteration: iterationCount,
            finishReason: "length",
          }, { sessionId: session.id, channel: session.channel, severity: "warn" });
        }
      } else if (
        llmResponse.tool_calls.length === 0
        && typeof llmResponse.content === "string"
        && looksLikeRunawayInlineArtifact(llmResponse.content)
      ) {
        // Same shape as the length-continuation case, but the model finished
        // cleanly within the completion budget. Observed live in session
        // 006ca6bf turn 12:49: completionChars=40857, finishReason="stop",
        // toolCallsRequested=0 — the orchestrator dumped 40 KB of HTML into
        // chat in one shot and the scorecard reported a clean turn. Flag it
        // here so the audit catches both finishReason="length" AND
        // finishReason="stop" variants of the same failure.
        guardrailEvents.push({ type: "runaway_inline_artifact", details: `orchestrator inlined ${llmResponse.content.length} chars of code in one shot instead of delegating` });
        logAudit("guardrail_flagged", {
          type: "runaway_inline_artifact",
          completionChars: llmResponse.content.length,
          iteration: iterationCount,
          finishReason: llmResponse.finishReason ?? "stop",
        }, { sessionId: session.id, channel: session.channel, severity: "warn" });
      }
    } catch (err) {
      log.error({ err, sessionId: session.id }, "LLM call failed");
      const delegateEvidence = findRecentDelegateEvidence(session.getHistory());
      const sharedFactsEvidence = await getSharedFactsEvidenceForFinalSynthesis(session.id);
      const recoveryEvidence = chooseBetterRecoveryEvidence(delegateEvidence, sharedFactsEvidence, { preferHigherScore: false });
      if (recoveryEvidence) {
        const finalResponse = formatRecoveryEvidenceForFinalUser(recoveryEvidence.evidence, {
          sourceSensitive: initialDynamicGuidance?.sourceSensitive ?? false,
        });
        persistAssistantTurnState(session, finalResponse, getTurnSwarmState());
        if (opts.onChunk) opts.onChunk(finalResponse);
        const performance = buildTurnPerformanceMetrics({
          turnStartedAt,
          firstModelResponseMs,
          llmCalls,
          llmTimeMs,
          toolCallsRequested,
          toolExecutionTimeMs,
          lastPromptMetrics,
          completionChars: finalResponse.length,
          finishReason: "llm_error_evidence_backstop",
          blocked: false,
          toolIterations: iterationCount,
        });
        logAudit("guardrail_flagged", {
          type: "llm_error_evidence_backstop",
          error: String(err).slice(0, 300),
          evidenceLength: recoveryEvidence.evidence.length,
          evidenceItems: recoveryEvidence.itemCount,
        }, { sessionId: session.id, channel: session.channel, severity: "warn" });
        logAudit("turn_performance", { ...performance, usage: totalUsage }, {
          sessionId: session.id,
          channel: session.channel,
          severity: "warn",
        });
        logAudit("message_sent", { length: finalResponse.length, toolCalls: iterationCount, usage: totalUsage, performance }, {
          sessionId: session.id,
          channel: session.channel,
          severity: "warn",
        });
        logAudit("turn_scorecard", {
          delegationCount: _turnDelegationCount,
          shareFindingCount: _turnShareFindingCount,
          forcedSynthesisFired: _forcedSynthesisFired,
          wardenFailureCount: _consecutiveDelegationFailures,
          finalAnswerLength: finalResponse.length,
          toolIterations: iterationCount,
          finishReason: "llm_error_evidence_backstop",
        }, { sessionId: session.id, channel: session.channel, severity: "warn" });
        return {
          response: finalResponse,
          toolCallsExecuted: iterationCount,
          guardrailEvents,
          usage: totalUsage,
          blocked: false,
          swarmState: getTurnSwarmState(),
          performance,
        };
      }
      return blocked(
        `LLM error: ${String(err)}`,
        getTurnSwarmState(),
        buildTurnPerformanceMetrics({
          turnStartedAt,
          firstModelResponseMs,
          llmCalls,
          llmTimeMs,
          toolCallsRequested,
          toolExecutionTimeMs,
          lastPromptMetrics,
          completionChars: 0,
          finishReason: "llm_error",
          blocked: true,
          toolIterations: iterationCount,
        }),
      );
    }

    totalUsage.promptTokens += llmResponse.usage.promptTokens;
    totalUsage.completionTokens += llmResponse.usage.completionTokens;
    totalUsage.totalTokens += llmResponse.usage.totalTokens;

    for (const tc of llmResponse.tool_calls) normalizeToolCall(tc);
    llmResponse.tool_calls = collapseDuplicateToolCallsInResponse(llmResponse.tool_calls, session.id, guardrailEvents);
    llmResponse.tool_calls = collapseExcessDirectDelegationsInResponse(llmResponse.tool_calls, session.id, guardrailEvents);
    llmResponse.tool_calls = collapseMixedOrchestrationLaunchersInResponse(llmResponse.tool_calls, session.id, guardrailEvents);
    llmResponse.tool_calls = collapseMixedDiscoveryAndOrchestrationToolsInResponse(llmResponse.tool_calls, session.id, guardrailEvents);
    const sourceSensitiveOriginalRequestEnforcementActive = Boolean(
      initialDynamicGuidance?.sourceSensitive
      && !inWorkflowStep
      && (!findRecentDelegateEvidence(session.getHistory()) || _consecutiveDelegationFailures > 0),
    );
    if (sourceSensitiveOriginalRequestEnforcementActive) {
      for (const tc of llmResponse.tool_calls) {
        enforceSourceSensitiveOriginalRequestOnToolCall(tc, researchSubject, initialDynamicGuidance, session.id, guardrailEvents);
      }
    }
    if (requiredResearchFallbackRoute) {
      for (const tc of llmResponse.tool_calls) {
        enforceRequiredResearchFallbackRouteOnToolCall(tc, requiredResearchFallbackRoute, session.id, guardrailEvents);
      }
    }

    if (llmResponse.tool_calls.length > 0 && llmResponse.content?.trim()) {
      logAudit("assistant_text_with_tool_calls_suppressed", {
        contentChars: llmResponse.content.length,
        toolNames: llmResponse.tool_calls.map((toolCall) => toolCall.name),
        finishReason: llmResponse.finishReason,
      }, { sessionId: session.id, severity: "warn" });
      guardrailEvents.push({ type: "assistant_text_suppressed", details: "tool_call_response" });
      // Keep the text in scope for the terminal-exit evidence backstop.
      // Only retain meaningfully-long content (>= 200 chars) — anything
      // shorter is almost certainly narration like "I'll call X next".
      const trimmedContent = llmResponse.content.trim();
      if (trimmedContent.length >= 200) {
        lastSuppressedAssistantText = trimmedContent;
      }
      llmResponse = { ...llmResponse, content: null };
    }

    // ── Pre-emptive synthesis: every requested tool is already at its
    // per-turn cap.  Without this guard the runtime invokes each tool,
    // gets blocked with reason=per_turn_limit, accumulates blocked
    // results, and only forces synthesis after FULLY_BLOCKED_ITERATION_THRESHOLD
    // (= 2) consecutive zero-execution iterations — burning two LLM calls
    // worth of latency and tokens for no gain.  When we can predict
    // every call will be blocked, skip directly to the terminal synthesis
    // path with the same finishReason the post-hoc detector would emit.
    //
    // Exclusion: orchestration launchers (delegate_to_agent and friends)
    // have richer cap-hit handling further down in the per-tool-call loop
    // — buildDelegationLoopResponse emits a "best grounded result collected
    // so far" message with the harvested evidence plus an explicit "raise
    // the limit / stop here" question to the user.  Pre-empting on those
    // would replace that targeted UX with the generic evidence-backstop,
    // which is strictly worse for the operator.
    const ORCHESTRATION_LAUNCHER_PREEMPT_EXCLUSIONS = new Set([
      "delegate_to_agent",
      "parallel_delegate",
      "swarm_delegate",
      "run_task_graph",
      "run_workflow",
    ]);
    if (
      llmResponse.tool_calls.length > 0
      && llmResponse.tool_calls.every((tc) => {
        if (ORCHESTRATION_LAUNCHER_PREEMPT_EXCLUSIONS.has(tc.name)) return false;
        const limit = getPerTurnToolCallLimit(tc.name);
        if (!limit) return false;
        const current = _turnToolCallCounts.get(tc.name) ?? 0;
        return current >= limit;
      })
    ) {
      const blockedNames = [...new Set(llmResponse.tool_calls.map((tc) => tc.name))];
      logAudit("tool_loop_detected", {
        reason: "all_tool_calls_capped_preempt",
        blockedTools: blockedNames,
        iterations: iterationCount,
      }, { sessionId: session.id, severity: "warn" });
      guardrailEvents.push({ type: "synthesis_required", details: "preempt_all_capped" });
      terminalFinishReason = "all_tool_calls_blocked";
      terminalSynthesisInstruction =
        "Every tool the model attempted in this iteration has already hit its per-turn cap. Stop trying tools. Using ONLY the evidence already present in the conversation, write the best possible final answer now. Do NOT invent missing information.";
      _forcedSynthesisFired = true;
      log.warn(
        { iterationCount, blockedTools: blockedNames },
        "Pre-emptive synthesis: all requested tools already at per-turn cap",
      );
      break;
    }

    const workflowCatalogToolRequested = llmResponse.tool_calls.some((toolCall) => isWorkflowCatalogToolName(toolCall.name));
    const runWorkflowRequested = llmResponse.tool_calls.some((toolCall) => toolCall.name === "run_workflow");
    const approvedRunCandidateToolRequested = approvedRunCandidateFollowUp
      ? llmResponse.tool_calls.some((toolCall) => isApprovedRunCandidateToolCall(toolCall, approvedRunCandidateFollowUp))
      : false;
    if (workflowCatalogToolRequested) {
      workflowCatalogAttemptedThisTurn = true;
    }

    const maintenanceDelegationToolRequested = llmResponse.tool_calls.some((toolCall) =>
      toolCall.name === "delegate_to_agent"
      || toolCall.name === "parallel_delegate"
      || toolCall.name === "run_task_graph"
      || toolCall.name === "create_ephemeral_agent"
    );
    if (requiresSwarmMaintenanceDelegation && !maintenanceDelegationToolRequested && llmResponse.tool_calls.length > 0) {
      if (!maintenanceMisrouteRetryUsed) {
        maintenanceMisrouteRetryUsed = true;
        maintenanceDelegationEnforcementPrompt = [
          "COMPLIANCE CORRECTION: This is StarlingAI swarm maintenance or scene/job authoring, not a request to discover or execute reusable workflows.",
          "Do NOT call search_workflows, run_workflow, search_agents, list_agents, or unavailable file-listing pseudo-tools for this request.",
          "You MUST call delegate_to_agent now with agentName='swarm_maintainer' and pass the full user request as the task.",
          "A workflow-search-only response is invalid for this turn.",
        ].join(" ");
        guardrailEvents.push({ type: "delegation_required", details: "maintenance_misroute_rejected" });
        logAudit("guardrail_flagged", {
          type: "maintenance_misroute_rejected",
          toolNames: llmResponse.tool_calls.map((toolCall) => toolCall.name),
          swarmMaintenanceSensitive: initialDynamicGuidance?.swarmMaintenanceSensitive ?? false,
        }, { sessionId: session.id, severity: "warn" });
        opts.onStatus?.({ phase: "guardrail", message: "This is a StarlingAI maintenance request, so I am routing it to the swarm maintainer instead of workflow discovery.", iteration: iterationCount });
        continue;
      }

      guardrailEvents.push({ type: "delegation_required", details: "maintenance_misroute_released" });
      logAudit("guardrail_flagged", {
        type: "maintenance_misroute_released",
        toolNames: llmResponse.tool_calls.map((toolCall) => toolCall.name),
      }, { sessionId: session.id, severity: "info" });
    }

    if (approvedRunCandidateFollowUp && !workflowRunCompletedThisTurn && !approvedRunCandidateToolRequested) {
      if (!approvedRunCandidateRetryUsed) {
        approvedRunCandidateRetryUsed = true;
        approvedRunCandidateEnforcementPrompt = [
          "COMPLIANCE CORRECTION: the user just approved a recent n8n RUN_CANDIDATE follow-up.",
          `You MUST call run_workflow now with name \"${approvedRunCandidateFollowUp.workflowName}\", workflowType \"${approvedRunCandidateFollowUp.workflowType}\", and params.workflowName \"${approvedRunCandidateFollowUp.candidateName}\".`,
          "Do NOT call search_agents, search_workflows, delegate_to_agent, parallel_delegate, run_task_graph, or give a tool-free answer first.",
          "Any response that skips this exact run_workflow call is invalid for this turn.",
        ].join(" ");
        guardrailEvents.push({ type: "workflow_required", details: "approved_run_candidate_follow_up_rejected" });
        logAudit("guardrail_flagged", {
          type: "approved_run_candidate_follow_up_rejected",
          candidateName: approvedRunCandidateFollowUp.candidateName,
          toolNames: llmResponse.tool_calls.map((toolCall) => toolCall.name),
        }, { sessionId: session.id, severity: "warn" });
        continue;
      }

      return blocked(
        "This turn required running the approved n8n workflow candidate, but the model still skipped the required run_workflow call.",
        getTurnSwarmState(),
        buildTurnPerformanceMetrics({
          turnStartedAt,
          firstModelResponseMs,
          llmCalls,
          llmTimeMs,
          toolCallsRequested,
          toolExecutionTimeMs,
          lastPromptMetrics,
          completionChars: 0,
          finishReason: "missing_approved_run_candidate_execution",
          blocked: true,
          toolIterations: iterationCount,
        }),
      );
    }

    // Set when the deterministic workflow-run force (below) rewrites this iteration's
    // tool calls into a single run_workflow. That forced call must be exempt from the
    // synthesis-required / user-response-required terminal guards further down — running
    // the curated workflow IS the deliverable path, not a re-research loop (audit
    // b8e3b68f: the force fired but was rejected by the synthesis-required guard).
    let forcedWorkflowRunThisIteration = false;
    const nonWorkflowOrchestrationRequested = llmResponse.tool_calls.some((toolCall) =>
      // Use the broader swarm-state set, not just ORCHESTRATION_LAUNCHER_TOOL_NAMES, so
      // swarm_delegate counts too: otherwise the model bypasses the workflow-run force by
      // delegating research directly (audit b8e3b68f: 2x swarm_delegate ran the source
      // research first, forcing synthesis BEFORE the late run_workflow force could fire,
      // so the sourced_presentation scene never ran and the deck shipped guessed images).
      PERSISTED_SWARM_STATE_TOOL_NAMES.has(toolCall.name) && toolCall.name !== "run_workflow"
    );
    const nonWorkflowDiscoveryRequested = llmResponse.tool_calls.some((toolCall) =>
      AGENT_DISCOVERY_TOOL_NAMES.has(toolCall.name) && toolCall.name !== "search_workflows"
    );
    const repeatedWorkflowSearchRequested = llmResponse.tool_calls.some((toolCall) => toolCall.name === "search_workflows");
    if (
      !workflowCatalogSuppressedForMaintenance
      &&
      shouldRequireWorkflowExecutionAfterSearch(workflowSearchMatches)
      && !workflowRunCompletedThisTurn
      && !runWorkflowRequested
      && (nonWorkflowOrchestrationRequested || nonWorkflowDiscoveryRequested || repeatedWorkflowSearchRequested)
    ) {
      if (!workflowExecutionRetryUsed) {
        workflowExecutionRetryUsed = true;
        workflowExecutionEnforcementPrompt = formatWorkflowExecutionPromptFromSearch(workflowSearchMatches);
        guardrailEvents.push({ type: "workflow_required", details: "workflow_run_required_after_search" });
        logAudit("guardrail_flagged", {
          type: "workflow_run_required_after_search",
          toolNames: llmResponse.tool_calls.map((toolCall) => toolCall.name),
          workflowMatches: workflowSearchMatches.slice(0, 3),
        }, { sessionId: session.id, severity: "warn" });
        continue;
      }

      // Nudged once but the model STILL chose a non-workflow path (e.g. direct
      // delegation) despite a strong reusable match. The slow local model often
      // won't comply with a prompt nudge, and the source-sensitive auto-research
      // /auto-build path it falls into here ships a worse result than the curated
      // workflow — e.g. the `sourced_presentation` scene verifies image URLs via
      // fetch_image instead of letting an auto-build embed guessed hotlinks. So on
      // the SECOND miss, deterministically rewrite the orchestration call to the
      // strong match's run_workflow, mirroring the source-sensitive original-request
      // rewrite (which also can't rely on the model's compliance). The original user
      // request rides along as `context` so the scene's agents see the real topic
      // even though the scene template only carries default param placeholders.
      const forcedWorkflowMatch = workflowSearchMatches[0];
      if (!workflowExecutionForceUsed && forcedWorkflowMatch) {
        workflowExecutionForceUsed = true;
        forcedWorkflowRunThisIteration = true;
        workflowExecutionEnforcementPrompt = "";
        const forcedToolCallId = llmResponse.tool_calls[0]?.id ?? `forced_run_workflow_${iterationCount}`;
        llmResponse.tool_calls = [{
          id: forcedToolCallId,
          name: "run_workflow",
          arguments: {
            name: forcedWorkflowMatch.name,
            workflowType: forcedWorkflowMatch.workflowType,
            context: userMessage,
          },
        }];
        guardrailEvents.push({ type: "workflow_required", details: "workflow_run_forced_after_search" });
        logAudit("tool_call_recovered", {
          originalTool: "non_workflow_orchestration",
          rewrittenTo: "run_workflow",
          reason: "workflow_run_forced_after_search",
          workflowName: forcedWorkflowMatch.name,
          workflowType: forcedWorkflowMatch.workflowType,
          score: forcedWorkflowMatch.score,
        }, { sessionId: session.id, severity: "warn" });
        // Fall through (no `continue`): the rewritten run_workflow call executes
        // in this iteration via the tool-dispatch loop below. On success this sets
        // workflowRunCompletedThisTurn so this block never re-fires; on a concrete
        // failure the model pivots and the `else` arm below releases.
      } else {
        // Already forced once and we're back here — the forced workflow run did
        // not resolve the turn (it failed for a concrete reason and the model
        // pivoted to ad-hoc delegation). Trust that choice rather than dead-ending.
        workflowExecutionEnforcementPrompt = "";
        guardrailEvents.push({ type: "workflow_required", details: "workflow_run_released_after_search" });
        logAudit("guardrail_flagged", {
          type: "workflow_run_released_after_search",
          toolNames: llmResponse.tool_calls.map((toolCall) => toolCall.name),
          workflowMatches: workflowSearchMatches.slice(0, 3),
        }, { sessionId: session.id, severity: "info" });
      }
    }

    if (workflowCatalogRequired && !workflowCatalogAttemptedThisTurn && llmResponse.tool_calls.length > 0) {
      if (!workflowCatalogRetryUsed) {
        workflowCatalogRetryUsed = true;
        workflowCatalogEnforcementPrompt = [
          "COMPLIANCE CORRECTION: This request is workflow-shaped and reusable workflow tools are available.",
          "Do NOT jump straight to delegate_to_agent or a direct natural-language answer.",
          "You MUST inspect the workflow catalog first.",
          ...(workflowCatalogSignal.strongestMatch
            ? [`Strong reusable match: ${workflowCatalogSignal.strongestMatch.name} [${workflowCatalogSignal.strongestMatch.workflowType}].`]
            : []),
          "If the exact reusable scene, job, or workflow is already known, call run_workflow now.",
          "Otherwise call search_workflows now, then either run_workflow or explain the catalog matches honestly.",
          "A catalog-free response is invalid for this turn.",
        ].join(" ");
        guardrailEvents.push({ type: "workflow_required", details: "workflow_catalog_check_rejected" });
        logAudit("guardrail_flagged", {
          type: "workflow_catalog_check_rejected",
          toolNames: llmResponse.tool_calls.map((toolCall) => toolCall.name),
          strongestMatch: workflowCatalogSignal.strongestMatch,
          reason: workflowCatalogSignal.reason,
        }, { sessionId: session.id, severity: "warn" });
        continue;
      }

      // Already nudged once this turn. The workflow-catalog check is a soft
      // routing heuristic, not a hard gate — trust the model's tool calls
      // instead of dead-ending into an empty answer. Let the requested tools
      // (e.g. delegate_to_agent, rag_ingest/rag_search) execute.
      workflowCatalogEnforcementPrompt = "";
      guardrailEvents.push({ type: "workflow_required", details: "workflow_catalog_check_released" });
      logAudit("guardrail_flagged", {
        type: "workflow_catalog_check_released",
        toolNames: llmResponse.tool_calls.map((toolCall) => toolCall.name),
        reason: workflowCatalogSignal.reason,
      }, { sessionId: session.id, severity: "info" });
    }

    const synthesisRequiredInHistory = collapsedHistory.some((message) => isForcedSynthesisSystemMessage(message));
    const userResponseRequiredInHistory = collapsedHistory.some((message) =>
      message.role === "system"
      && typeof message.content === "string"
      && message.content.startsWith("[USER RESPONSE REQUIRED]"),
    );

    if (synthesisRequiredInHistory && llmResponse.tool_calls.length > 0 && !forcedWorkflowRunThisIteration) {
      // Fix 3: If the prior delegation was a partial/timeout whose surfaced
      // substance is below the usability floor (e.g. 900-char truncation
      // stub), the model's recovery delegation is the correct response —
      // there is no real evidence to synthesize from. Allow ONE retry per
      // turn so the swarm can recover the lost work instead of being locked
      // into "answer from a stub" mode. Subsequent tool calls in the same
      // turn still fall through to the original block-and-synthesize path.
      const junkPriorDelegation = synthesisRequiredRecoveryRetryUsed
        ? null
        : findRecentJunkDelegationResult(collapsedHistory);
      if (junkPriorDelegation) {
        synthesisRequiredRecoveryRetryUsed = true;
        logAudit("guardrail_flagged", {
          type: "synthesis_required_recovery_allowed",
          priorAgent: junkPriorDelegation.agentName,
          priorSubstanceChars: junkPriorDelegation.substanceChars,
          priorTerminalState: junkPriorDelegation.terminalState,
          retryToolNames: llmResponse.tool_calls.map((toolCall) => toolCall.name),
        }, { sessionId: session.id, severity: "info" });
        guardrailEvents.push({ type: "synthesis_required", details: "recovery_retry_allowed" });
        log.info(
          {
            sessionId: session.id,
            priorAgent: junkPriorDelegation.agentName,
            priorSubstanceChars: junkPriorDelegation.substanceChars,
            priorTerminalState: junkPriorDelegation.terminalState,
          },
          "Synthesis-required guardrail granted one recovery retry — prior delegation produced sub-floor evidence",
        );
        // Fall through to normal tool-call processing this iteration.
      } else {
        logAudit("guardrail_flagged", {
          type: "tool_calls_after_synthesis_required",
          toolNames: llmResponse.tool_calls.map((toolCall) => toolCall.name),
          recoveryRetryUsed: synthesisRequiredRecoveryRetryUsed,
        }, { sessionId: session.id, severity: "warn" });
        guardrailEvents.push({ type: "synthesis_required", details: "post_orchestration_tool_call_rejected" });
        _forcedSynthesisFired = true;
        terminalFinishReason = "synthesis_required_tool_call_rejected";
        terminalSynthesisInstruction =
          "RESEARCH INCOMPLETE — WRITE A PARTIAL ANSWER NOW. The delegated research ran out of time before covering all topics. Do NOT call any more tools. Do NOT write raw search snippets or tool-trace text. Instead write a proper user-facing answer in the user's language that: (1) clearly states the research was incomplete and which topics still need verification, (2) presents every concrete verified fact that IS in the tool results and shared findings above as a structured answer (component names, specs, prices, sources — whatever was found), (3) explicitly marks sections as [unverifiziert — Recherche unvollständig] when no evidence was found for them, and (4) asks the user whether to retry the missing sections. Never dump raw 'Web Search Results for:' blocks. Convert all search snippet evidence into readable prose or a structured list.";
        opts.onStatus?.({ phase: "synthesizing", message: "Stopping repeated tool calls and writing the answer from gathered evidence.", iteration: iterationCount });
        log.warn({ sessionId: session.id, toolCalls: llmResponse.tool_calls.map((toolCall) => toolCall.name) }, "Model attempted more tool calls after synthesis was required — forcing synthesis");
        break;
      }
    }

    if (userResponseRequiredInHistory && llmResponse.tool_calls.length > 0 && !forcedWorkflowRunThisIteration) {
      logAudit("guardrail_flagged", {
        type: "tool_calls_after_user_response_required",
        toolNames: llmResponse.tool_calls.map((toolCall) => toolCall.name),
      }, { sessionId: session.id, severity: "warn" });
      guardrailEvents.push({ type: "synthesis_required", details: "post_orchestration_tool_call_rejected" });
      _forcedSynthesisFired = true;
      terminalFinishReason = "user_response_required_tool_call_rejected";
      terminalSynthesisInstruction =
        "A previous delegated result requires a user response, clarification, authorization, or approval, but the model attempted another tool call. Reject that tool call. Ask the user the required question in one concise message using only the evidence already present above. Do NOT call tools, delegate, search, browse, or promise automatic continuation.";
      opts.onStatus?.({ phase: "synthesizing", message: "Stopping extra tool calls and preparing the required user-facing question.", iteration: iterationCount });
      log.warn({ sessionId: session.id, toolCalls: llmResponse.tool_calls.map((toolCall) => toolCall.name) }, "Model attempted more tool calls after delegated results required a user response — forcing synthesis");
      break;
    }

    // ── No tool calls — final response ────────────────────────────────────
    // NOTE: do NOT short-circuit on finishReason === "stop" here — many quantized
    // models (LM Studio, Ollama) return finish_reason:"stop" even when they include
    // tool_calls in the same response.  Only treat the turn as complete when there
    // are literally zero tool calls to process.
    if (llmResponse.tool_calls.length === 0) {
      const rawResponse = llmResponse.content ?? "";
      // Trust-the-LLM never-empty guarantee. The routing guardrails below each
      // nudge the model ONCE to use an orchestration/workflow tool. If it still
      // answers tool-free after that nudge, we no longer dead-end the turn into
      // an empty `blocked()` response — we release its draft answer through the
      // normal finalization path (which still runs the security output scan +
      // redactor). Once a terminal decides to release, this flag short-circuits
      // the remaining routing terminals so the draft falls straight through.
      let releasedAfterRoutingNudge = false;
      // Set when a source-sensitive answer is released after the research nudge
      // without any research evidence having been gathered this turn — the
      // answer then gets an explicit unverified caveat (anti-hallucination).
      let releasedWithoutResearchEvidence = false;
      const releaseAfterRoutingNudge = (original: string): void => {
        releasedAfterRoutingNudge = true;
        guardrailEvents.push({ type: "routing_nudge_released", details: original });
        logAudit("guardrail_flagged", {
          type: "routing_nudge_released",
          original,
          reason: "model answered directly after one delegation nudge; releasing draft instead of blocking",
        }, { sessionId: session.id, severity: "info" });
      };
      const unresolvedDelegatedActionInHistory = hasRecentUnresolvedDelegatedAction(session.getHistory());
      const promisedContinuationWithoutTools = looksLikeContinuationPromise(rawResponse);
      const promisedMaintenanceExecutionWithoutTools = requiresMaintenanceDelegation
        && looksLikeMaintenanceExecutionPromise(rawResponse);

      if (!releasedAfterRoutingNudge && promisedMaintenanceExecutionWithoutTools) {
        if (!maintenanceDelegationRetryUsed) {
          maintenanceDelegationRetryUsed = true;
          maintenanceDelegationEnforcementPrompt = [
            "COMPLIANCE CORRECTION: This is follow-up information for an ongoing workflow-authoring maintenance request.",
            "Do NOT claim that you are creating, generating, or delegating the workflow unless this response actually includes the orchestration tool call.",
            "You MUST call an orchestration tool now.",
            "Prefer delegate_to_agent with swarm_maintainer when available.",
            "A tool-free promise to create the workflow is invalid for this turn.",
          ].join(" ");
          guardrailEvents.push({ type: "delegation_required", details: "tool_free_maintenance_answer_rejected" });
          logAudit("guardrail_flagged", {
            type: "tool_free_maintenance_answer_rejected",
            recentWorkflowAuthoringMaintenanceContext,
          }, { sessionId: session.id, severity: "warn" });
          continue;
        }

        releaseAfterRoutingNudge("tool_free_maintenance_answer_rejected");
      }

      if (!releasedAfterRoutingNudge && workflowCatalogRequired && !workflowCatalogAttemptedThisTurn) {
        if (!workflowCatalogRetryUsed) {
          workflowCatalogRetryUsed = true;
          workflowCatalogEnforcementPrompt = [
            "COMPLIANCE CORRECTION: This request is workflow-shaped and reusable workflow tools are available.",
            "Do NOT answer from memory or promise delegation before checking the workflow catalog.",
            ...(workflowCatalogSignal.strongestMatch
              ? [`Strong reusable match: ${workflowCatalogSignal.strongestMatch.name} [${workflowCatalogSignal.strongestMatch.workflowType}].`]
              : []),
            "You MUST call search_workflows or run_workflow now.",
            "If no reusable workflow matches, explain that only after the catalog check completes.",
            "A tool-free answer is invalid for this turn.",
          ].join(" ");
          guardrailEvents.push({ type: "workflow_required", details: "tool_free_workflow_answer_rejected" });
          logAudit("guardrail_flagged", {
            type: "tool_free_workflow_answer_rejected",
            strongestMatch: workflowCatalogSignal.strongestMatch,
            reason: workflowCatalogSignal.reason,
          }, { sessionId: session.id, severity: "warn" });
          continue;
        }

        releaseAfterRoutingNudge("tool_free_workflow_answer_rejected");
      }

      if (
        !releasedAfterRoutingNudge
        && !workflowCatalogSuppressedForMaintenance
        &&
        shouldRequireWorkflowExecutionAfterSearch(workflowSearchMatches)
        && !workflowRunCompletedThisTurn
      ) {
        if (!workflowExecutionRetryUsed) {
          workflowExecutionRetryUsed = true;
          workflowExecutionEnforcementPrompt = formatWorkflowExecutionPromptFromSearch(workflowSearchMatches);
          guardrailEvents.push({ type: "workflow_required", details: "tool_free_workflow_run_rejected" });
          logAudit("guardrail_flagged", {
            type: "tool_free_workflow_run_rejected",
            workflowMatches: workflowSearchMatches.slice(0, 3),
          }, { sessionId: session.id, severity: "warn" });
          continue;
        }

        releaseAfterRoutingNudge("tool_free_workflow_run_rejected");
      }

      if (promisedContinuationWithoutTools && unresolvedDelegatedActionInHistory && !unresolvedDelegationContinuationRetryUsed) {
        unresolvedDelegationContinuationRetryUsed = true;
        unresolvedDelegationEnforcementPrompt = [
          "COMPLIANCE CORRECTION: The session already contains an unfinished delegated action from a previous turn.",
          "The user's latest message is follow-up guidance for that unfinished work.",
          "Do NOT write that you will now do something unless this response actually includes the tool call.",
          "You MUST either call the required tool or orchestration tool now, or explicitly state that no action is being executed in this turn.",
          "For server administration follow-ups, prefer delegate_to_agent(agentName: \"shell_agent\", task: \"...\") or ops_triage when diagnosis is needed.",
          "A tool-free continuation promise is invalid for this turn.",
        ].join(" ");
        guardrailEvents.push({ type: "delegation_required", details: "tool_free_continuation_promise_rejected" });
        logAudit("guardrail_flagged", {
          type: "tool_free_continuation_promise_rejected",
          serverAccessSensitive: initialDynamicGuidance?.serverAccessSensitive ?? false,
          computerAccessSensitive: initialDynamicGuidance?.computerAccessSensitive ?? false,
        }, { sessionId: session.id, severity: "warn" });
        continue;
      }

      const currentTurnHasExecutableOrchestration = _turnDelegationCount > 0
        || workflowRunCompletedThisTurn
        || ((_turnToolCallCounts.get("run_workflow") ?? 0) > 0);

      if (!releasedAfterRoutingNudge && requiresArtifactDelegation && !currentTurnHasExecutableOrchestration) {
        if (!delegatedResearchRetryUsed) {
          delegatedResearchRetryUsed = true;
          delegatedResearchEnforcementPrompt = [
            "COMPLIANCE CORRECTION: This request asks for a durable downloadable or viewable artifact.",
            "Do NOT paste the full artifact source into chat.",
            "You MUST call an orchestration tool now so a specialist can write/export the artifact file.",
            "For HTML pages, how-to blogs, documentation pages, or static websites, prefer delegate_to_agent with agentName='content_writer'.",
            "Ask the specialist to save the file as an artifact and publish the artifact path/download details. The final chat answer should be only a concise summary and artifact reference.",
            "A tool-free artifact dump is invalid for this turn.",
          ].join(" ");
          guardrailEvents.push({ type: "delegation_required", details: "tool_free_artifact_answer_rejected" });
          logAudit("guardrail_flagged", {
            type: "tool_free_artifact_answer_rejected",
            artifactSensitive: initialDynamicGuidance?.artifactSensitive ?? false,
          }, { sessionId: session.id, severity: "warn" });
          opts.onStatus?.({ phase: "guardrail", message: "The draft skipped artifact creation, so I am retrying with the required specialist workflow.", iteration: iterationCount });
          continue;
        }

        releaseAfterRoutingNudge("tool_free_artifact_answer_rejected");
      }

      let autoResearchAnswer: string | null = null;
      if (!releasedAfterRoutingNudge && requiresDelegatedResearch && !currentTurnHasExecutableOrchestration) {
        if (!delegatedResearchRetryUsed) {
          delegatedResearchRetryUsed = true;
          const route: RequiredResearchFallbackRoute | null = requiredResearchFallbackRoute ?? buildRequiredResearchFallbackRoute(researchSubject, initialDynamicGuidance, allowedToolNameSet, opts.allowedAgents);
          if (route) {
            requiredResearchFallbackRoute = route;
            searchAgentsNoMatchFallbackPrompt ||= buildSearchAgentsNoMatchFallbackPrompt(route);
          }
          delegatedResearchEnforcementPrompt = route
            ? buildSearchAgentsNoMatchFallbackPrompt(route)
            : [
                "COMPLIANCE CORRECTION: This request requires specialist-agent orchestration.",
                "Do NOT answer directly from memory.",
                "You MUST call an orchestration tool now instead of writing a natural-language answer.",
                "For a simple web lookup, prefer delegate_to_agent with researcher.",
                "For broader multi-step online research, hardware/product verification, component recommendations, or source-backed reports, prefer delegate_to_agent with mission_coordinator. Use web_task_coordinator only for live single-shot lookups or browser-heavy workflows.",
                "A tool-free answer before delegation is invalid for this turn.",
              ].join(" ");
          guardrailEvents.push({ type: "delegation_required", details: "tool_free_research_answer_rejected" });
          logAudit("guardrail_flagged", {
            type: "tool_free_research_answer_rejected",
            freshnessSensitive: initialDynamicGuidance?.freshnessSensitive ?? false,
            sourceSensitive: initialDynamicGuidance?.sourceSensitive ?? false,
          }, { sessionId: session.id, severity: "warn" });
          opts.onStatus?.({ phase: "guardrail", message: "The draft skipped required research orchestration, so I am retrying with a specialist agent.", iteration: iterationCount });
          continue;
        }

        // Source-sensitive turn, model refused to delegate even after the nudge.
        // Operator policy (orchestration.autoResearchOnRefusal): do NOT ship a
        // training-data answer — auto-run ONE research delegation and synthesize from
        // the gathered findings; fall back to the caveated draft only if that yields
        // nothing. Enforces the source-sensitive correctness invariant without
        // dead-ending (audit bdbace34: a hardware build shipped fabricated mic specs
        // with zero delegations after the single nudge release).
        const autoRoute = ((getConfig().orchestration?.autoResearchOnRefusal ?? true) && !signal.aborted)
          ? (requiredResearchFallbackRoute ?? buildRequiredResearchFallbackRoute(researchSubject, initialDynamicGuidance, allowedToolNameSet, opts.allowedAgents))
          : null;
        if (autoRoute) {
          logAudit("guardrail_flagged", {
            type: "source_sensitive_auto_research_delegated",
            tool: autoRoute.toolName,
            agent: autoRoute.label,
          }, { sessionId: session.id, severity: "warn" });
          opts.onStatus?.({ phase: "guardrail", message: "Der Entwurf hat keine Recherche ausgeführt — ich hole jetzt belegte Quellen über einen Recherche-Spezialisten.", iteration: iterationCount });
          try {
            await executeTool(autoRoute.toolName, autoRoute.args, toolContext);
            _turnDelegationCount += 1;
          } catch (err) {
            log.warn({ err, sessionId: session.id }, "Auto-research delegation on refusal failed");
          }
          const autoEvidence = await getSharedFactsEvidenceForFinalSynthesis(session.id);
          const autoDelegateEvidence = findRecentDelegateEvidence(session.getHistory());
          const recovery = chooseBetterRecoveryEvidence(autoDelegateEvidence, autoEvidence, { preferHigherScore: true });
          if (recovery && !looksLikeWeakRecoveryEvidence(recovery.evidence)) {
            const synthesized = await forceSynthesis(
              session,
              provider,
              signal,
              "WEB RESEARCH RESULTS — synthesize the final answer now. A research specialist gathered the findings below for the user's request. "
              + "Write the complete answer in the SAME language as the user's request, grounded ONLY in these findings and this conversation's tool results. "
              + "Do not invent manufacturer, interface, pricing, part, or layout claims beyond the findings; mark anything the findings do not cover as still to verify.\n"
              + "Findings:\n" + recovery.evidence.slice(0, 6_000),
            );
            const candidate = synthesized ? sanitizeUserFacingAssistantResponse(synthesized, 0) : null;
            autoResearchAnswer = candidate && candidate.trim().length >= 200
              ? candidate
              : formatSourceSensitiveEvidenceBackstop(recovery.evidence);
            logAudit("guardrail_flagged", {
              type: "source_sensitive_auto_research_synthesized",
              evidenceItems: recovery.itemCount,
              evidenceLength: recovery.evidence.length,
              synthesized: Boolean(candidate && candidate.trim().length >= 200),
            }, { sessionId: session.id, severity: "warn" });
          }
        }

        if (!autoResearchAnswer) {
          releaseAfterRoutingNudge("tool_free_research_answer_rejected");
          // No delegation/orchestration ran and no findings were shared, yet the
          // turn is source/freshness-sensitive — the released draft is unverified.
          if (!currentTurnHasExecutableOrchestration && _turnShareFindingCount === 0) {
            releasedWithoutResearchEvidence = true;
          }
        }
      }

      // Output guardrail scan
      const outputScan = scanOutput(rawResponse);
      const effectiveToolIterations = promisedContinuationWithoutTools && unresolvedDelegatedActionInHistory
        ? Math.max(iterationCount, 1)
        : iterationCount;
      let finalResponse = await finalizeUserFacingAssistantResponse(rawResponse, effectiveToolIterations, session, provider, signal);

      // General shared-facts synthesis backstop — fires for ALL turns (not just source-sensitive)
      // when the final response looks like a raw dump or is suspiciously short after orchestration
      // ran. The source-sensitive path below handles `sourceSensitive` cases; this catches the
      // general research case (BOM, hardware design, multi-source comparison, etc.) where the
      // researcher gathered good shared facts but forceSynthesis timed out or the model echoed
      // raw auto_xxx_yyy key names instead of synthesizing them into prose.
      if (
        currentTurnHasExecutableOrchestration
        && !initialDynamicGuidance?.sourceSensitive
        && (
          looksLikeRawSharedFactsDump(finalResponse)
          || looksLikeOrchestrationOnlyEvidence(finalResponse)
          || (_forcedSynthesisFired && finalResponse.length < 600)
        )
      ) {
        const sharedFactsEvidence = await getSharedFactsEvidenceForFinalSynthesis(session.id, 6_000);
        const delegateEvidence = findRecentDelegateEvidence(session.getHistory());
        const recoveryEvidence = chooseBetterRecoveryEvidence(delegateEvidence, sharedFactsEvidence, { preferHigherScore: true });
        if (recoveryEvidence && !looksLikeWeakRecoveryEvidence(recoveryEvidence.evidence)) {
          const synthesized = await forceSynthesis(
            session,
            provider,
            signal,
            "Research specialists have gathered findings during this turn. Synthesize all [SHARED FINDINGS AVAILABLE] entries and the recovered evidence below into a complete, well-structured answer in the user's language.\n"
            + "Do NOT echo raw key names (e.g. auto_xxx_yyy). Convert every finding into readable, user-facing prose.\n"
            + "Recovered evidence:\n" + recoveryEvidence.evidence.slice(0, 5_000),
          );
          const candidateResponse = synthesized && sanitizeUserFacingAssistantResponse(synthesized, 0);
          if (candidateResponse && candidateResponse.length > finalResponse.length) {
            finalResponse = candidateResponse;
            logAudit("guardrail_flagged", {
              type: "general_shared_facts_synthesis_backstop",
              evidenceLength: recoveryEvidence.evidence.length,
              evidenceItems: recoveryEvidence.itemCount,
              originalLength: rawResponse.length,
              synthesizedLength: finalResponse.length,
            }, { sessionId: session.id, channel: session.channel, severity: "warn" });
          } else {
            // Synthesis still failed or was too short — format the evidence at minimum
            finalResponse = formatRecoveryEvidenceForFinalUser(recoveryEvidence.evidence);
            logAudit("guardrail_flagged", {
              type: "general_shared_facts_format_backstop",
              evidenceLength: recoveryEvidence.evidence.length,
              evidenceItems: recoveryEvidence.itemCount,
            }, { sessionId: session.id, channel: session.channel, severity: "warn" });
          }
        }
      }

      if (
        initialDynamicGuidance?.sourceSensitive
        && currentTurnHasExecutableOrchestration
        && (
          _forcedSynthesisFired
          || _consecutiveDelegationFailures > 0
          || hasRecentSourceSensitivePartialDelegation(session.getHistory())
          || hasRecentSparseSourceSensitiveMemoryReuse(session.getHistory(), userMessage)
        )
      ) {
        const delegateEvidence = findRecentDelegateEvidence(session.getHistory());
        const sharedFactsEvidence = await getSharedFactsEvidenceForFinalSynthesis(session.id);
        const recoveryEvidence = chooseBetterRecoveryEvidence(delegateEvidence, sharedFactsEvidence);
        if (recoveryEvidence) {
          const finalResponseAnchored = looksEvidenceAnchored(stripPresentationFormatting(finalResponse), recoveryEvidence.evidence);
          const finalResponseTransparent = looksLikeTransparentIncompleteReport(finalResponse);
          if (!finalResponseAnchored || !finalResponseTransparent) {
            finalResponse = await synthesizeSourceSensitiveEvidenceBackstop(session, provider, signal, recoveryEvidence.evidence)
              ?? formatSourceSensitiveEvidenceBackstop(recoveryEvidence.evidence);
            logAudit("guardrail_flagged", {
              type: "source_sensitive_failed_delegation_evidence_backstop",
              evidenceLength: recoveryEvidence.evidence.length,
              evidenceItems: recoveryEvidence.itemCount,
              originalLength: rawResponse.length,
              finalResponseAnchored,
              finalResponseTransparent,
            }, { sessionId: session.id, severity: "warn" });
          }
        } else if (!looksLikeTransparentIncompleteReport(finalResponse)) {
          finalResponse = [
            "Die Recherche ist in diesem Lauf fehlgeschlagen, bevor belastbare Quellen- oder Tool-Evidenz vorlag.",
            "Ich kann die angefragten Produkt-, Hersteller-, Schnittstellen-, Preis- und Layout-Aussagen deshalb nicht verifizieren, ohne Fakten zu erfinden.",
            "Bitte starte die Recherche erneut oder reduziere den Umfang auf einen kleineren Teilbereich, damit ein Spezialist echte Quellen sammeln kann.",
          ].join("\n\n");
          logAudit("guardrail_flagged", {
            type: "source_sensitive_final_answer_without_evidence_blocked",
            originalLength: rawResponse.length,
          }, { sessionId: session.id, severity: "warn" });
        }
      }

      // Auto-research synthesis (source-sensitive refusal): the model refused to
      // delegate, so the runtime ran a research specialist above and synthesized from
      // the gathered findings — that grounded answer replaces the training-data draft.
      if (autoResearchAnswer) {
        finalResponse = autoResearchAnswer;
      }

      // Anti-hallucination caveat: a source-sensitive answer that shipped with
      // NO research evidence (model declined to delegate) gets an explicit
      // unverified banner so pre-assumptions aren't read as confirmed facts.
      // Only for substantial answers — a short "it depends" needs no banner.
      if (releasedWithoutResearchEvidence && finalResponse.trim().length > 400) {
        finalResponse = prependUnverifiedSourceCaveat(finalResponse, userMessage);
        guardrailEvents.push({ type: "guardrail_flagged", details: "unverified_source_sensitive_answer_caveated" });
        logAudit("guardrail_flagged", {
          type: "unverified_source_sensitive_answer_caveated",
          sourceSensitive: initialDynamicGuidance?.sourceSensitive ?? false,
          freshnessSensitive: initialDynamicGuidance?.freshnessSensitive ?? false,
        }, { sessionId: session.id, severity: "warn" });
      }

      // False-completion guard: the turn asked to CREATE or MODIFY an artifact, produced
      // NO artifact this turn (no build delegation surfaced an attachment, no workspace
      // write), yet the answer claims it created/updated/inserted the artifact — ship an
      // honest status instead of the false success (audit 14661623 turn 2: gathered image
      // URLs via one search, never rebuilt the deck, but answered "Die Bilder wurden
      // eingefügt … URLs überprüft"). The three AND-conditions keep real builds (an artifact
      // was produced → skipped) and report-only turns (no claim → skipped) untouched;
      // topic-agnostic. Runs for ALL backends, not only source-sensitive ones.
      if (
        looksLikeArtifactMutationRequest(userMessage)
        && collectTurnArtifactAttachments(session).length === 0
        && claimsArtifactWrittenButUnproduced(finalResponse)
      ) {
        logAudit("guardrail_flagged", {
          type: "artifact_completion_claim_unbacked_suppressed",
          finishReason: terminalFinishReason,
          answerLength: finalResponse.length,
        }, { sessionId: session.id, channel: session.channel, severity: "warn" });
        const honest = await forceSynthesis(
          session, provider, signal,
          "Your draft claims the requested file/presentation/document was created, updated, inserted, or embedded — but NOTHING was actually written to the workspace in THIS turn (no file was produced). Do NOT claim it was created or changed. "
          + "Reply briefly and honestly IN THE USER'S LANGUAGE: state plainly that the artifact was NOT created or modified this turn, summarize what you actually DID (e.g. gathered/listed information), and offer to have the content specialist build or update the file now. Do NOT invent a file path and do NOT restate a success you cannot point to in this turn's own results.",
        );
        const candidate = honest ? sanitizeUserFacingAssistantResponse(honest, iterationCount) : null;
        finalResponse = (candidate && candidate.trim().length >= 40 && !claimsArtifactWrittenButUnproduced(candidate))
          ? candidate
          : "Ich habe die Datei in diesem Schritt **nicht** erstellt oder geändert — ich habe nur die angefragten Informationen gesammelt. Bestätige bitte, dann lasse ich den Inhalts-Spezialisten die Präsentation jetzt damit erstellen bzw. aktualisieren.\n\nI did **not** create or modify the file in this turn — I only gathered the requested information. Confirm and I'll have the content specialist build or update the presentation now.";
      }

      // Risk-gated auto-verify QA gate: for high-stakes turns that recorded a
      // plan with acceptance criteria, check the answer against those criteria
      // and repair if it falls short. Source-sensitive turns were already
      // anchored by the evidence backstop above, so they skip the redundant
      // verify call. Low-stakes / chat turns skip QA entirely.
      if (getConfig().orchestration?.riskGatedQA ?? true) {
        const qaPlan = await loadTurnPlan(session.id);
        const invokedApprovalGatedTool = [..._turnToolCallCounts.keys()].some(requiresApproval);
        const risk = classifyTurnRisk({
          planRiskTier: qaPlan?.riskTier,
          sourceSensitive: initialDynamicGuidance?.sourceSensitive ?? false,
          invokedApprovalGatedTool,
        });
        if (risk === "high") {
          if (initialDynamicGuidance?.sourceSensitive) {
            // The failure-path backstop above only fires on a failed/partial run. For a
            // source-sensitive turn that delegated SUCCESSFULLY, the answer was never
            // cross-checked — so a training-data answer can ship while verified facts sit
            // unused in shared findings. Re-ground it if it references none of them.
            const anchorEvidence = (getConfig().orchestration?.qaEvidenceAnchoring ?? false) && !signal.aborted
              ? await getSharedFactsEvidenceForFinalSynthesis(session.id)
              : null;
            if (anchorEvidence && answerNeedsEvidenceAnchoringRepair(finalResponse, anchorEvidence.evidence)) {
              const anchorInstruction = [
                "EVIDENCE-ANCHORING REPAIR:",
                "Your previous answer did not reference the verified findings this run gathered. Re-write the answer so it is grounded in the findings below, in the SAME language as the user's request.",
                "Use ONLY these findings plus this conversation's tool results. Do not invent manufacturer, interface, pricing, part, layout, or BOM claims. Mark anything the findings do not support as unverified/incomplete.",
                "Keep it a concise, useful answer — do not dump raw tool traces or page snapshots.",
                "Verified findings:",
                anchorEvidence.evidence.trim(),
              ].join("\n");
              const reanchored = await forceSynthesis(session, provider, signal, anchorInstruction);
              const candidate = reanchored ? sanitizeUserFacingAssistantResponse(reanchored, 0) : null;
              if (
                candidate
                && candidate.trim().length >= Math.min(200, Math.floor(finalResponse.trim().length * 0.5))
                && looksEvidenceAnchored(stripPresentationFormatting(candidate), anchorEvidence.evidence)
              ) {
                finalResponse = candidate;
                guardrailEvents.push({ type: "guardrail_flagged", details: "qa_evidence_anchoring_repaired" });
                logAudit("flow_verification_repaired", { reason: "unanchored_to_shared_findings", evidenceItems: anchorEvidence.itemCount }, { sessionId: session.id, severity: "warn" });
              } else {
                logAudit("flow_high_stakes_unverified", { reason: "answer_unanchored_repair_failed", evidenceItems: anchorEvidence.itemCount }, { sessionId: session.id, severity: "warn" });
              }
            } else {
              logAudit("flow_verification_passed", {
                reason: anchorEvidence ? "answer_anchored_to_shared_findings" : "covered_by_source_sensitive_backstop",
              }, { sessionId: session.id, severity: "info" });
            }
          } else if (qaPlan && qaPlan.acceptanceCriteria.length > 0 && finalResponse.trim().length > 200 && !signal.aborted) {
            const verifyInstruction = "Before finalizing, verify your answer meets ALL of these acceptance criteria for the user's task:\n"
              + qaPlan.acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join("\n")
              + "\nIf every criterion is met and every claim is grounded in this conversation's tool results and shared findings, return the SAME answer. "
              + "If a criterion is unmet or a claim is unsupported, return a corrected answer that fixes the gap or transparently marks what could not be verified. Do not add unsupported claims.";
            const verified = await forceSynthesis(session, provider, signal, verifyInstruction);
            const candidate = verified ? sanitizeUserFacingAssistantResponse(verified, 0) : null;
            // Guard against catastrophic truncation — a legitimate repair may
            // shorten the answer (dropping unsupported claims), so allow down to
            // half the length but never accept a stub.
            if (candidate && candidate.trim().length >= Math.min(200, Math.floor(finalResponse.trim().length * 0.5))) {
              const repaired = candidate.trim() !== finalResponse.trim();
              finalResponse = candidate;
              logAudit(repaired ? "flow_verification_repaired" : "flow_verification_passed",
                { acceptanceCriteria: qaPlan.acceptanceCriteria.length, repaired },
                { sessionId: session.id, severity: repaired ? "warn" : "info" });
              if (repaired) guardrailEvents.push({ type: "guardrail_flagged", details: "risk_gated_qa_repaired" });
            } else {
              logAudit("flow_verification_passed", { reason: "verify_produced_no_better_candidate" }, { sessionId: session.id, severity: "info" });
            }
          } else {
            logAudit("flow_high_stakes_unverified", { reason: qaPlan ? "no_acceptance_criteria" : "no_plan", invokedApprovalGatedTool }, { sessionId: session.id, severity: "info" });
          }
        }
      }

      if (!outputScan.safe && outputScan.redacted) {
        finalResponse = outputScan.redacted;
        guardrailEvents.push({ type: "output_redacted", details: (outputScan.detectedTypes ?? []).join(", ") });
        logAudit("output_redacted", { types: outputScan.detectedTypes }, { sessionId: session.id, severity: "warn" });
      }

      persistAssistantTurnState(session, finalResponse, getTurnSwarmState());

      const performance = buildTurnPerformanceMetrics({
        turnStartedAt,
        firstModelResponseMs,
        llmCalls,
        llmTimeMs,
        toolCallsRequested,
        toolExecutionTimeMs,
        lastPromptMetrics,
        completionChars: finalResponse.length,
        finishReason: llmResponse.finishReason,
        blocked: false,
        toolIterations: iterationCount,
      });

      logAudit("turn_performance", { ...performance, usage: totalUsage }, {
        sessionId: session.id,
        channel: session.channel,
      });

      logAudit("message_sent", { length: finalResponse.length, toolCalls: iterationCount, usage: totalUsage, performance }, {
        sessionId: session.id,
        channel: session.channel,
      });

      // F29: Per-turn quality scorecard
      logAudit("turn_scorecard", {
        delegationCount: _turnDelegationCount,
        shareFindingCount: _turnShareFindingCount,
        forcedSynthesisFired: _forcedSynthesisFired,
        wardenFailureCount: _consecutiveDelegationFailures,
        finalAnswerLength: finalResponse.length,
        toolIterations: iterationCount,
      }, { sessionId: session.id, channel: session.channel });

      // G33: Write trajectory for future cache reuse
      if (_turnShareFindingCount > 0 && finalResponse.length > 50) {
        writeTrajectory(
          {
            channel: session.channel,
            normalizedQuery: userMessage.toLowerCase().trim().slice(0, 300),
            sharedFindings: sharedFindingsThisTurn,
            finalAnswer: finalResponse.slice(0, 2000),
          },
          session.getWorkspacePath(),
          initialDynamicGuidance?.freshnessSensitive ?? false,
        ).catch(() => undefined);
      }

      // E26: close the graph-memory retrieval feedback loop for this turn.
      // A non-blocked turn that produced a substantive answer is treated as a
      // successful outcome — memories retrieved during the turn get credited
      // (wasUseful=true + importance boost). Same signal the sub-agent uses.
      // An apology or stub answer is treated as an unhelpful outcome: the
      // memories were retrieved and still didn't help, so mark them
      // wasUseful=false and apply a modest importance penalty. This is the
      // negative-signal counterpart that closes the E26 loop in both
      // directions rather than relying solely on slow decay.
      const isApology = finalResponse.toLowerCase().startsWith("i apologize");
      // Phase 3: credit/penalize the skills injected into this turn so retrieval
      // reliability is learned. Success graduates drafts to active in the store.
      // Only attribute on turns that actually did multi-step work — skills are
      // procedures, so a direct single-shot answer is not evidence the procedure
      // was followed (avoids inflating success rates on trivial turns).
      // Fire-and-forget async writes — never block the turn return.
      if ((injectedSkillSlugs.length > 0 || heldOutSkillSlugs.length > 0) && _turnDelegationCount > 0) {
        const outcome = finalResponse.length > 50 && !isApology ? "success" : "failure";
        const skillWorkspace = session.getWorkspacePath();
        for (const slug of injectedSkillSlugs) {
          void recordSkillOutcomeAsync(skillWorkspace, slug, outcome).catch(() => { /* non-critical */ });
        }
        // Held-out matches record the counterfactual baseline so skillLift can
        // tell whether injecting the skill actually moves the outcome.
        for (const slug of heldOutSkillSlugs) {
          void recordSkillHoldoutOutcomeAsync(skillWorkspace, slug, outcome).catch(() => { /* non-critical */ });
        }
      }
      if (finalResponse.length > 50 && !isApology) {
        graphMarkSessionRetrievalsUseful(session.id, { boost: 0.04 }).catch(() => {});
        // Phase 2: distill a reusable skill from this successful multi-step turn
        // (gated by skillLibrary.autoAuthor). Best-effort — never blocks the turn.
        maybeDistillSkillFromTurn({
          workspacePath: session.getWorkspacePath(),
          sessionId: session.id,
          objective: userMessage,
          finalAnswer: finalResponse,
          delegationCount: _turnDelegationCount,
          sharedFindings: sharedFindingsThisTurn,
          swarmState: getTurnSwarmState(),
          loadedSkillSlugs: injectedSkillSlugs,
        }).catch(() => undefined);
        // G33 follow-up: positive signal — the injected cached trajectory
        // contributed to a successful answer. Pairs with `trajectory_cache_hit`
        // and `trajectory_cache_invalidated` so operators can compute the
        // hit-and-helpful rate from the audit log without further plumbing.
        if (injectedTrajectoryIdentity) {
          logAudit(
            "trajectory_cache_used",
            {
              normalizedQuery: injectedTrajectoryIdentity.normalizedQuery.slice(0, 200),
              finishedAt: injectedTrajectoryIdentity.finishedAt,
              finalAnswerChars: finalResponse.length,
              toolIterations: iterationCount,
            },
            { sessionId: session.id, channel: session.channel },
          );
        }
      } else if (finalResponse.length <= 50 || isApology) {
        graphMarkSessionRetrievalsUnhelpful(session.id, { penalty: 0.02 }).catch(() => {});
        // G33 follow-up: if a cached trajectory was injected and the turn
        // still ended in apology / stub, the cached evidence is almost
        // certainly stale or wrong. Invalidate it so future similar
        // queries don't keep inheriting the same bad outcome.
        if (injectedTrajectoryIdentity) {
          invalidateTrajectory(session.getWorkspacePath(), injectedTrajectoryIdentity);
          logAudit(
            "trajectory_cache_invalidated",
            {
              normalizedQuery: injectedTrajectoryIdentity.normalizedQuery.slice(0, 200),
              finishedAt: injectedTrajectoryIdentity.finishedAt,
              reason: isApology ? "apology" : "stub_response",
              finalAnswerChars: finalResponse.length,
            },
            { sessionId: session.id, channel: session.channel, severity: "warn" },
          );
        }
      }

      return {
        response: finalResponse,
        toolCallsExecuted: iterationCount,
        guardrailEvents,
        usage: totalUsage,
        blocked: false,
        swarmState: getTurnSwarmState(),
        performance,
      };
    }

    // ── Assistant text repetition detection ────────────────────────────────
    // If the LLM regenerates nearly identical text across iterations while also
    // requesting tool calls, it is stuck in a regeneration loop.  Break early.
    // Only update _lastAssistantContent when the model actually produced text;
    // tool-only iterations (content=null) should NOT reset the comparison.
    // Whitespace-only content (e.g. "\n\n" left after stripping Qwen3 thinking
    // tags) is not meaningful text — skip the check to avoid false positives.
    if (llmResponse.content && llmResponse.content.trim() && iterationCount >= 2) {
      if (_lastAssistantContent) {
        const curPrefix = llmResponse.content.slice(0, 200);
        const prevPrefix = _lastAssistantContent.slice(0, 200);
        if (curPrefix === prevPrefix) {
          logAudit("tool_loop_detected", {
            reason: "assistant_text_repetition",
            iterations: iterationCount,
            contentPrefix: curPrefix.slice(0, 100),
          }, { sessionId: session.id, severity: "warn" });
          log.warn({ iterationCount }, "Assistant text repeated across iterations — forcing synthesis");
          break; // falls through to forceSynthesis below
        }
      }
      _lastAssistantContent = llmResponse.content;
    }

    // ── Process tool calls ────────────────────────────────────────────────

    session.addMessage({
      role: "assistant",
      content: llmResponse.content,
      tool_calls: llmResponse.tool_calls.map(tc => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    });

    const toolResultMessages: Array<LLMMessage & { metadata?: Record<string, unknown> }> = [];
    let workflowExecutionCorrectionPending = false;
    let workflowExecutionCorrectionExhausted = false;

    for (const tc of llmResponse.tool_calls) {
      if (signal.aborted) break;

      if (requiredResearchFallbackRoute && (tc.name === "search_agents" || tc.name === "list_agents")) {
        const originalTool = tc.name;
        tc.name = requiredResearchFallbackRoute.toolName;
        tc.arguments = { ...requiredResearchFallbackRoute.args };
        logAudit("tool_call_recovered", {
          originalTool,
          rewrittenTo: requiredResearchFallbackRoute.toolName,
          reason: "search_agents_no_match_fallback",
          recoveredAgentName: requiredResearchFallbackRoute.label,
          noMatchCount: searchAgentsNoMatchCount,
        }, { sessionId: session.id, severity: "warn" });
        guardrailEvents.push({ type: "tool_recovered", details: `${originalTool}:search_agents_no_match_fallback` });
      }

      toolCallsRequested += 1;
      // F29: Count delegation and share_finding calls for the turn scorecard
      if (
        tc.name === "delegate_to_agent" ||
        tc.name === "parallel_delegate" ||
        tc.name === "run_task_graph" ||
        tc.name === "swarm_delegate" ||
        tc.name === "create_ephemeral_agent"
      ) {
        _turnDelegationCount += 1;
      } else if (tc.name === "share_finding") {
        _turnShareFindingCount += 1;
        // G33: Collect finding text for trajectory cache
        const findingText = typeof tc.arguments?.["finding"] === "string"
          ? (tc.arguments["finding"] as string).slice(0, 500)
          : typeof tc.arguments?.["content"] === "string"
            ? (tc.arguments["content"] as string).slice(0, 500)
            : "";
        if (findingText) sharedFindingsThisTurn.push(findingText);
      }
      const nextToolCallCount = (_turnToolCallCounts.get(tc.name) ?? 0) + 1;
      _turnToolCallCounts.set(tc.name, nextToolCallCount);
      const perTurnToolLimit = getPerTurnToolCallLimit(tc.name);

      if (perTurnToolLimit && nextToolCallCount > perTurnToolLimit) {
        logAudit("tool_call_blocked", {
          tool: tc.name,
          reason: "per_turn_limit",
          limit: perTurnToolLimit,
          attemptedCallNumber: nextToolCallCount,
        }, {
          sessionId: session.id,
          severity: "warn",
        });
        guardrailEvents.push({ type: "tool_blocked", details: `${tc.name}:per_turn_limit` });

        const limitMessage = `Error: Tool '${tc.name}' call limit (${perTurnToolLimit}) reached for this turn. Stop calling this tool and synthesize your findings or ask the user for the missing information directly.`;
        if (opts.onToolResult) opts.onToolResult(tc.id, tc.name, limitMessage);

        if (tc.name === "delegate_to_agent") {
          const finalResponse = buildDelegationLoopResponse(session, _lastToolResultByName.get(tc.name) ?? "", "limit");
          persistAssistantTurnState(session, finalResponse, getTurnSwarmState());

          const performance = buildTurnPerformanceMetrics({
            turnStartedAt,
            firstModelResponseMs,
            llmCalls,
            llmTimeMs,
            toolCallsRequested,
            toolExecutionTimeMs,
            lastPromptMetrics,
            completionChars: finalResponse.length,
            finishReason: "delegate_loop_terminated",
            blocked: false,
            toolIterations: iterationCount,
          });

          logAudit("turn_performance", { ...performance, usage: totalUsage }, {
            sessionId: session.id,
            channel: session.channel,
            severity: "warn",
          });

          logAudit("message_sent", { length: finalResponse.length, toolCalls: iterationCount, usage: totalUsage, performance }, {
            sessionId: session.id,
            channel: session.channel,
            severity: "warn",
          });

          // F29: Per-turn quality scorecard (delegate-loop-terminated path)
          logAudit("turn_scorecard", {
            delegationCount: _turnDelegationCount,
            shareFindingCount: _turnShareFindingCount,
            forcedSynthesisFired: _forcedSynthesisFired,
            wardenFailureCount: _consecutiveDelegationFailures,
            finalAnswerLength: finalResponse.length,
            toolIterations: iterationCount,
            finishReason: "delegate_loop_terminated",
          }, { sessionId: session.id, channel: session.channel, severity: "warn" });

          return {
            response: finalResponse,
            toolCallsExecuted: iterationCount,
            guardrailEvents,
            usage: totalUsage,
            blocked: false,
            swarmState: getTurnSwarmState(),
            performance,
          };
        }

        toolResultMessages.push({
          role: "tool",
          content: limitMessage,
          tool_call_id: tc.id,
        });
        continue;
      }

      // Rate limit tool calls
      const toolRl = await checkRateLimit(session.id, "tool_call");
      if (!toolRl.allowed) {
        const rateLimitMessage = "Error: Rate limit exceeded for tool calls. Please reduce frequency.";
        if (opts.onToolResult) opts.onToolResult(tc.id, tc.name, rateLimitMessage);
        toolResultMessages.push({
          role: "tool",
          content: rateLimitMessage,
          tool_call_id: tc.id,
        });
        continue;
      }

      if (!allowedToolNameSet.has(tc.name)) {
        // ── Agent-name-as-tool recovery ──────────────────────────────────────
        // Local LLMs sometimes call "computer_use_agent(...)" as if it were a
        // tool, instead of delegate_to_agent(agentName: "computer_use_agent").
        // If the unrecognised tool name matches a configured sub-agent AND
        // delegate_to_agent is available, silently rewrite the call.
        const knownAgents = getConfig().subAgents ?? {};
        if (tc.name in knownAgents && allowedToolNameSet.has("delegate_to_agent")) {
          const recoveredAgentName = tc.name;
          const recoveredTask = typeof tc.arguments?.task === "string"
            ? tc.arguments.task
            : (typeof tc.arguments?.query === "string" ? tc.arguments.query : JSON.stringify(tc.arguments));
          tc.arguments = { agentName: recoveredAgentName, task: recoveredTask };
          tc.name = "delegate_to_agent";
          logAudit("tool_call_recovered", {
            originalTool: recoveredAgentName,
            rewrittenTo: "delegate_to_agent",
            reason: "agent_name_as_tool",
          }, { sessionId: session.id, severity: "info" });
        } else {
        logAudit("tool_call_blocked", { tool: tc.name, reason: "not_in_turn_toolset" }, {
          sessionId: session.id,
          severity: "warn",
        });
        guardrailEvents.push({ type: "tool_blocked", details: `${tc.name}:not_in_turn_toolset` });
        const unavailableMessage = tc.name === "write_file" || tc.name === "export_workspace_artifact"
          ? `Error: Direct artifact tool '${tc.name}' is not available in this turn. Do not retry it directly. Use delegate_to_agent with content_writer or another artifact-capable specialist, or synthesize from existing evidence if no artifact tool is available.`
          : `Error: Tool '${tc.name}' is not available in this turn. Use only the tools that were provided for this request. If this is a desktop-control task, delegate to computer_use_agent instead of calling direct computer_* or browser_* tools.`;
        if (opts.onToolResult) opts.onToolResult(tc.id, tc.name, unavailableMessage);
        toolResultMessages.push({
          role: "tool",
          content: unavailableMessage,
          tool_call_id: tc.id,
        });
        continue;
        }
      }

      // Block disallowed tools
      if (!isToolAllowed(tc.name)) {
        logAudit("tool_call_blocked", { tool: tc.name, reason: "not_allowed" }, {
          sessionId: session.id,
          severity: "warn",
        });
        guardrailEvents.push({ type: "tool_blocked", details: tc.name });
        const blockedMessage = `Error: Tool '${tc.name}' is blocked by security policy.`;
        if (opts.onToolResult) opts.onToolResult(tc.id, tc.name, blockedMessage);
        toolResultMessages.push({
          role: "tool",
          content: blockedMessage,
          tool_call_id: tc.id,
        });
        continue;
      }

      logAudit("tool_call_requested", { tool: tc.name, args: tc.arguments }, { sessionId: session.id });
      if (opts.onToolCall) opts.onToolCall(tc.id, tc.name, tc.arguments);

      // Reject tool calls with unparseable arguments from the LLM
      if (tc.arguments && "_parse_error" in tc.arguments) {
        const rawArgs = (tc.arguments as Record<string, unknown>)["_raw"];
        const intervention = classifyToolIntervention({
          toolName: tc.name,
          success: false,
          error: "Malformed JSON arguments produced by the model",
          malformedArguments: true,
        });
        logAudit("tool_call_failed", {
          tool: tc.name,
          reason: "invalid_arguments",
          raw: String(rawArgs).slice(0, 200),
          issueCode: intervention?.reasonCode,
          intervention,
        }, {
          sessionId: session.id, severity: "warn",
        });
        if (intervention) opts.onIntervention?.(intervention);
        const parseErrorMessage = `Error: Could not parse arguments for tool '${tc.name}'. The arguments were malformed JSON. Do not retry the same large inline payload; synthesize from existing evidence or use a smaller valid tool call.`;
        if (opts.onToolResult) opts.onToolResult(tc.id, tc.name, parseErrorMessage);
        toolResultMessages.push({
          role: "tool",
          content: parseErrorMessage,
          tool_call_id: tc.id,
        });
        continue;
      }

      if (tc.name === "delegate_to_agent") {
        const requestedAgentName = typeof tc.arguments?.["agentName"] === "string"
          ? String(tc.arguments["agentName"]).trim()
          : "";
        if (!requestedAgentName && pendingSearchAgentSuggestion?.agentName) {
          tc.arguments = {
            ...(tc.arguments ?? {}),
            agentName: pendingSearchAgentSuggestion.agentName,
            fallbackAgents: Array.isArray(tc.arguments?.["fallbackAgents"]) && tc.arguments["fallbackAgents"].length > 0
              ? tc.arguments["fallbackAgents"]
              : pendingSearchAgentSuggestion.fallbackAgents,
          };
          logAudit("tool_call_recovered", {
            originalTool: "delegate_to_agent",
            rewrittenTo: "delegate_to_agent",
            reason: "reuse_search_agents_top_result",
            recoveredAgentName: pendingSearchAgentSuggestion.agentName,
            routingQuery: pendingSearchAgentSuggestion.query ?? null,
            recoveredFallbackAgents: pendingSearchAgentSuggestion.fallbackAgents ?? [],
          }, {
            sessionId: session.id,
            severity: "info",
          });
        }
      } else if (tc.name === "swarm_delegate" && pendingSearchAgentSuggestion?.agentName && allowedToolNameSet.has("delegate_to_agent")) {
        tc.name = "delegate_to_agent";
        tc.arguments = {
          ...(tc.arguments ?? {}),
          agentName: pendingSearchAgentSuggestion.agentName,
          fallbackAgents: Array.isArray(tc.arguments?.["fallbackAgents"]) && tc.arguments["fallbackAgents"].length > 0
            ? tc.arguments["fallbackAgents"]
            : pendingSearchAgentSuggestion.fallbackAgents,
        };
        logAudit("tool_call_recovered", {
          originalTool: "swarm_delegate",
          rewrittenTo: "delegate_to_agent",
          reason: "reuse_search_agents_top_result",
          recoveredAgentName: pendingSearchAgentSuggestion.agentName,
          routingQuery: pendingSearchAgentSuggestion.query ?? null,
          recoveredFallbackAgents: pendingSearchAgentSuggestion.fallbackAgents ?? [],
        }, {
          sessionId: session.id,
          severity: "info",
        });
      }

      const argsSig = JSON.stringify(tc.arguments ?? {});
      const cachedToolCall = _lastToolCallSig.get(tc.name);
      if (tc.name !== "delegate_to_agent" && cachedToolCall && cachedToolCall.args === argsSig) {
        const cachedResultText = `${cachedToolCall.result}\n\n[Note: This is a cached result — you already called '${tc.name}' with identical arguments earlier in this turn. Do NOT call it again. Use this result and move to a different step.]`;
        _lastToolResultByName.set(tc.name, cachedToolCall.result);

        logAudit("tool_call_completed", {
          tool: tc.name,
          success: true,
          outputChars: cachedToolCall.result.length,
          metadata: cachedToolCall.metadata,
          cachedResult: true,
          suspiciousReturn: false,
          intervention: null,
        }, {
          sessionId: session.id,
          severity: "warn",
        });

        if (opts.onToolResult) opts.onToolResult(tc.id, tc.name, cachedResultText, cachedToolCall.metadata);

        toolResultMessages.push({
          role: "tool",
          content: buildModelVisibleToolResult(tc.name, cachedResultText, cachedToolCall.metadata),
          tool_call_id: tc.id,
          metadata: cachedToolCall.metadata,
        });

        pendingSearchAgentSuggestion = tc.name === "search_agents"
          ? extractAgentRoutingSuggestionFromMetadata(cachedToolCall.metadata)
          : undefined;

        if (tc.name === "search_agents" && requiresDelegatedResearch && searchAgentsReturnedNoMatch(cachedToolCall.metadata)) {
          searchAgentsNoMatchCount += 1;
          const route: RequiredResearchFallbackRoute | null = requiredResearchFallbackRoute ?? buildRequiredResearchFallbackRoute(researchSubject, initialDynamicGuidance, allowedToolNameSet, opts.allowedAgents);
          if (route) {
            requiredResearchFallbackRoute = route;
            searchAgentsNoMatchFallbackPrompt = buildSearchAgentsNoMatchFallbackPrompt(route);
            logAudit("guardrail_flagged", {
              type: "agent_discovery_no_match_fallback",
              noMatchCount: searchAgentsNoMatchCount,
              fallbackTool: route.toolName,
              fallbackAgent: route.label,
              cachedResult: true,
            }, { sessionId: session.id, severity: "warn" });
            opts.onStatus?.({ phase: "guardrail", message: "Agent discovery returned no usable match, so I am falling back to a required research specialist instead of searching again.", iteration: iterationCount });
          }
        }
        continue;
      }

      const toolStartedAt = Date.now();
      const result = await executeTool(tc.name, tc.arguments, toolContext);
      const toolDurationMs = Date.now() - toolStartedAt;
      if (PERSISTED_SWARM_STATE_TOOL_NAMES.has(tc.name)) {
        turnUsedSwarmTools = true;
      }
      toolExecutionTimeMs += toolDurationMs;
      const intervention = classifyToolIntervention({
        toolName: tc.name,
        success: result.success,
        output: result.output,
        error: result.error,
      });

      logAudit(
        result.success ? "tool_call_completed" : "tool_call_failed",
        {
          tool: tc.name,
          success: result.success,
          error: result.error,
          outputChars: result.output.length,
          durationMs: toolDurationMs,
          metadata: result.metadata,
          issueCode: intervention?.reasonCode,
          suspiciousReturn: result.success && Boolean(intervention),
          intervention,
        },
        { sessionId: session.id, severity: result.success ? "info" : "warn" }
      );

      let resultText = result.success
        ? result.output
        : (result.error?.trim()
            ? `Error: ${result.error}`
            : (result.output.trim() || "Error: Unknown error"));

      const workflowMatchesFromResult = extractWorkflowCatalogMatchesFromMetadata(result.metadata);

      if (tc.name === "search_workflows") {
        workflowSearchMatches = result.success
          ? extractWorkflowCatalogMatchesFromMetadata(result.metadata)
          : [];
      } else if (tc.name === "run_workflow" && workflowMatchesFromResult.length > 0) {
        workflowSearchMatches = mergeWorkflowCatalogMatches(workflowSearchMatches, workflowMatchesFromResult);
      } else if (tc.name === "run_workflow" && result.success) {
        workflowRunCompletedThisTurn = true;
      }

      pendingSearchAgentSuggestion = tc.name === "search_agents"
        ? extractAgentRoutingSuggestionFromMetadata(result.metadata)
        : undefined;

      if (tc.name === "search_agents" && requiresDelegatedResearch && searchAgentsReturnedNoMatch(result.metadata)) {
        searchAgentsNoMatchCount += 1;
        const route: RequiredResearchFallbackRoute | null = requiredResearchFallbackRoute ?? buildRequiredResearchFallbackRoute(researchSubject, initialDynamicGuidance, allowedToolNameSet, opts.allowedAgents);
        if (route) {
          requiredResearchFallbackRoute = route;
          searchAgentsNoMatchFallbackPrompt = buildSearchAgentsNoMatchFallbackPrompt(route);
          logAudit("guardrail_flagged", {
            type: "agent_discovery_no_match_fallback",
            noMatchCount: searchAgentsNoMatchCount,
            fallbackTool: route.toolName,
            fallbackAgent: route.label,
          }, { sessionId: session.id, severity: "warn" });
          opts.onStatus?.({ phase: "guardrail", message: "Agent discovery returned no usable match, so I am falling back to a required research specialist instead of searching again.", iteration: iterationCount });
        }
      }

      if (
        tc.name === "run_workflow"
        && !result.success
      ) {
        const workflowCorrectionMatches = mergeWorkflowCatalogMatches(workflowSearchMatches, workflowMatchesFromResult);
        const workflowErrorText = result.error?.trim() || resultText;
        if (
          isWorkflowNameResolutionFailureMessage(workflowErrorText)
          && !workflowCatalogSuppressedForMaintenance
          && shouldRequireWorkflowExecutionAfterSearch(workflowCorrectionMatches)
        ) {
          if (!workflowExecutionCorrectionRetryUsed) {
            workflowExecutionCorrectionRetryUsed = true;
            workflowExecutionEnforcementPrompt = formatWorkflowExecutionCorrectionPromptFromSearch(workflowCorrectionMatches, workflowErrorText);
            workflowExecutionCorrectionPending = true;
            guardrailEvents.push({ type: "workflow_required", details: "workflow_run_correction_required" });
            logAudit("guardrail_flagged", {
              type: "workflow_run_correction_required",
              attemptedWorkflowName: typeof tc.arguments?.["name"] === "string" ? tc.arguments["name"] : undefined,
              error: workflowErrorText,
              workflowMatches: workflowCorrectionMatches.slice(0, 3),
            }, { sessionId: session.id, severity: "warn" });
          } else {
            workflowExecutionCorrectionExhausted = true;
          }
        }
      }

      _lastToolResultByName.set(tc.name, resultText);

      // ── Reused-delegation loop detection ─────────────────────────────────
      // When a coordinator keeps paraphrasing the same task, the underlying
      // signature still matches and `executeDelegationWithFallback` returns
      // the cached output with metadata.reused=true. Counting these in-turn
      // catches semantic loops that the byte-equality fingerprint below
      // misses (because each paraphrase mutates the args).
      if (
        tc.name === "delegate_to_agent"
        && result.success
        && (result.metadata as { reused?: unknown } | undefined)?.reused === true
      ) {
        _turnReusedDelegationCount += 1;
        if (_turnReusedDelegationCount >= REUSED_DELEGATION_LOOP_THRESHOLD) {
          logAudit(
            "tool_call_completed",
            {
              tool: tc.name,
              success: true,
              outputChars: result.output.length,
              reusedDelegationLoop: true,
              reusedDelegationCount: _turnReusedDelegationCount,
            },
            { sessionId: session.id, severity: "warn" },
          );
          const finalResponse = buildDelegationLoopResponse(session, result.output, "identical-output");
          persistAssistantTurnState(session, finalResponse, getTurnSwarmState());
          const performance = buildTurnPerformanceMetrics({
            turnStartedAt,
            firstModelResponseMs,
            llmCalls,
            llmTimeMs,
            toolCallsRequested,
            toolExecutionTimeMs,
            lastPromptMetrics,
            completionChars: finalResponse.length,
            finishReason: "delegate_loop_terminated",
            blocked: false,
            toolIterations: iterationCount,
          });
          return {
            response: finalResponse,
            toolCallsExecuted: toolCallsRequested,
            guardrailEvents,
            usage: totalUsage,
            blocked: false,
            swarmState: getTurnSwarmState(),
            performance,
          };
        }
      }

      // ── Identical output loop detection ──────────────────────────────────
      // Track BOTH successes and failures — repeated errors are loops too.
      {
        const outputFingerprint = buildRepeatedOutputFingerprint(tc.name, tc.arguments, resultText);
        const prev = _recentOutputsByTool.get(tc.name) ?? [];
        prev.push(outputFingerprint);
        if (prev.length > IDENTICAL_OUTPUT_LOOP_THRESHOLD) prev.shift();
        _recentOutputsByTool.set(tc.name, prev);

        if (
          prev.length >= IDENTICAL_OUTPUT_LOOP_THRESHOLD &&
          prev.every(o => o === prev[0])
        ) {
          const loopIntervention = classifyToolIntervention({
            toolName: tc.name,
            success: result.success,
            output: result.output,
            error: result.error,
            repeatedIdenticalOutput: true,
          });
          logAudit(
            "tool_call_completed",
            {
              tool: tc.name,
              success: result.success,
              outputChars: result.output.length,
              suspiciousReturn: true,
              repeatedIdenticalOutput: true,
              issueCode: loopIntervention?.reasonCode,
              intervention: loopIntervention,
            },
            { sessionId: session.id, severity: "warn" },
          );

          if (tc.name === "delegate_to_agent") {
            const finalResponse = buildDelegationLoopResponse(session, result.output, "identical-output");
            persistAssistantTurnState(session, finalResponse, getTurnSwarmState());

            const performance = buildTurnPerformanceMetrics({
              turnStartedAt,
              firstModelResponseMs,
              llmCalls,
              llmTimeMs,
              toolCallsRequested,
              toolExecutionTimeMs,
              lastPromptMetrics,
              completionChars: finalResponse.length,
              finishReason: "delegate_loop_terminated",
              blocked: false,
              toolIterations: iterationCount,
            });

            logAudit("turn_performance", { ...performance, usage: totalUsage }, {
              sessionId: session.id,
              channel: session.channel,
              severity: "warn",
            });

            logAudit("message_sent", { length: finalResponse.length, toolCalls: iterationCount, usage: totalUsage, performance }, {
              sessionId: session.id,
              channel: session.channel,
              severity: "warn",
            });

            // F29: Per-turn quality scorecard (identical-output loop terminated path)
            logAudit("turn_scorecard", {
              delegationCount: _turnDelegationCount,
              shareFindingCount: _turnShareFindingCount,
              forcedSynthesisFired: _forcedSynthesisFired,
              wardenFailureCount: _consecutiveDelegationFailures,
              finalAnswerLength: finalResponse.length,
              toolIterations: iterationCount,
              finishReason: "delegate_loop_terminated",
            }, { sessionId: session.id, channel: session.channel, severity: "warn" });

            return {
              response: finalResponse,
              toolCallsExecuted: iterationCount,
              guardrailEvents,
              usage: totalUsage,
              blocked: false,
              swarmState: getTurnSwarmState(),
              performance,
            };
          }

          resultText +=
            `\n\n[System notice: ${tc.name} has returned identical output ${IDENTICAL_OUTPUT_LOOP_THRESHOLD} times in a row. ` +
            `You are stuck in a loop. Do NOT call this tool again. Summarise what you have found so far and report it to the user, or try a clearly different approach.]`;
          if (loopIntervention) opts.onIntervention?.(loopIntervention);
          _recentOutputsByTool.set(tc.name, []); // reset so alert fires at most once per burst
        }
      }

      // Redact any secrets that leaked into the tool output before the LLM ever sees it
      // (DB error messages, SSH banners, etc. can echo credentials back).
      const secretScan = scanOutput(resultText);
      if (!secretScan.safe && secretScan.redacted) {
        resultText = secretScan.redacted;
        guardrailEvents.push({ type: "tool_output_secret_redacted", details: `${tc.name}:${(secretScan.detectedTypes ?? []).join(",")}` });
        logAudit("output_redacted", {
          surface: "tool_output",
          tool: tc.name,
          detectedTypes: secretScan.detectedTypes,
        }, { sessionId: session.id, severity: "warn" });
      }

      // Prevent indirect prompt injection from tool output payloads
      const outCheck = checkToolOutput(resultText);
      if (!outCheck.allowed) {
        const blockedIntervention = classifyToolIntervention({
          toolName: tc.name,
          success: false,
          error: outCheck.reason,
          outputBlocked: true,
        });
        logAudit("tool_output_blocked", {
          tool: tc.name,
          reason: outCheck.reason,
          issueCode: blockedIntervention?.reasonCode,
          intervention: blockedIntervention,
        }, { sessionId: session.id, severity: "error" });
        resultText = "Error: Tool output blocked by guardrails (suspicious payload detected).";
        guardrailEvents.push({ type: "tool_output_blocked", details: tc.name });
        if (blockedIntervention) opts.onIntervention?.(blockedIntervention);
      } else if (intervention) {
        opts.onIntervention?.(intervention);
      }

      if (outCheck.allowed) {
        const moderatedToolResult = await moderateToolResultText(resultText);
        if (moderatedToolResult?.blocked) {
          logAudit("tool_output_blocked", {
            tool: tc.name,
            reason: `Model moderation blocked tool output: ${moderatedToolResult.summary}`,
            categories: moderatedToolResult.categories,
          }, { sessionId: session.id, severity: "error" });
          resultText = "Error: Tool output blocked by model-backed guardrails.";
          guardrailEvents.push({ type: "tool_output_model_blocked", details: tc.name });
        } else if (moderatedToolResult?.flagged) {
          guardrailEvents.push({ type: "tool_output_model_flagged", details: `${tc.name}: ${moderatedToolResult.summary}` });
          logAudit("guardrail_flagged", {
            type: "tool_output_model",
            tool: tc.name,
            categories: moderatedToolResult.categories,
          }, { sessionId: session.id, severity: "warn" });
        }
      }

      _lastToolCallSig.set(tc.name, {
        args: argsSig,
        result: resultText,
        metadata: result.metadata,
      });

      if (opts.onToolResult) opts.onToolResult(tc.id, tc.name, resultText, result.metadata);

      const modelVisibleResultText = buildModelVisibleToolResult(tc.name, resultText, result.metadata);

      toolResultMessages.push({
        role: "tool",
        content: modelVisibleResultText,
        tool_call_id: tc.id,
        metadata: result.metadata,
      });

      if (workflowExecutionCorrectionExhausted) {
        session.addMessages(toolResultMessages);
        return blocked(
          "This turn searched the workflow catalog but still failed to call run_workflow with one of the returned workflow names.",
          getTurnSwarmState(),
          buildTurnPerformanceMetrics({
            turnStartedAt,
            firstModelResponseMs,
            llmCalls,
            llmTimeMs,
            toolCallsRequested,
            toolExecutionTimeMs,
            lastPromptMetrics,
            completionChars: 0,
            finishReason: "invalid_workflow_name_after_search",
            blocked: true,
            toolIterations: iterationCount,
          }),
        );
      }

    }

    session.addMessages(toolResultMessages);

    if (workflowExecutionCorrectionPending) {
      continue;
    }

    // ── Post-orchestration synthesis nudge ─────────────────────────────────
    // When orchestration returns grounded evidence, inject a strong nudge
    // telling the model to synthesize NOW instead of re-delegating for the same data.
    {
      const disposition = classifyPostOrchestrationDisposition(toolResultMessages);
      if (disposition === "synthesize") {
        _consecutiveDelegationFailures = 0;
        session.addMessage({
          role: "system",
          content:
            "[SYNTHESIS REQUIRED] The orchestration results above contain grounded evidence blocks. " +
            "You MUST now write your final answer using ONLY the details from those Observed evidence blocks. " +
            "Do NOT delegate again for the same information — the evidence is already collected. " +
            "Copy the exact names, numbers, values, task states, and statuses from the evidence into your answer.",
        });
      } else if (disposition === "continue") {
        _consecutiveDelegationFailures = 0;
        session.addMessage({
          role: "system",
          content:
            "[CONTINUE ORCHESTRATION] The latest delegated evidence identifies a concrete follow-up action that has not yet been executed. " +
            "You may continue in this same turn if the next action is materially different from prior delegations and directly advances the request. " +
            "Do NOT repeat the same delegation, and do NOT ask for information already present in the evidence. " +
            "Treat delegated phrases like 'I will now attempt...' or 'the next step...' as proposed follow-up work, not proof that it already happened. Do NOT tell the user a next step 'has been executed' unless this turn includes the completed tool result for that action.",
        });
      } else if (disposition === "ask_user") {
        _consecutiveDelegationFailures = 0;
        session.addMessage({
          role: "system",
          content:
            "[USER RESPONSE REQUIRED] The latest delegated evidence indicates that further progress requires clarification, authorization, approval, or another user decision. " +
            "Ask the user yourself in one concise message and do NOT call more tools until they respond.",
        });
      } else if (disposition === "failure") {
        _consecutiveDelegationFailures += 1;
        if (_consecutiveDelegationFailures >= 2) {
          // D16: Warden escalation
          _forcedSynthesisFired = true; // F29
          session.addMessage({
            role: "system",
            content:
              "[WARDEN STOP — FORCED SYNTHESIS] Two or more consecutive delegation attempts have failed. " +
              "You MUST stop delegating and respond to the user now. " +
              "If any partial evidence exists in the evidence blocks above, synthesize it into the best possible answer. " +
              "If there is no usable evidence, tell the user honestly that the information could not be retrieved at this time and suggest what they could do next. " +
              "Do NOT call any more delegation tools in this turn.",
          });
        } else {
          session.addMessage({
            role: "system",
            content:
              "[DELEGATION FAILED] The latest delegated action failed or did not return useful evidence. " +
              "Do NOT retry the same exact delegation. You may attempt a different strategy or ask the user for guidance.",
          });
        }
      }

      if (toolResultMessages.length > 0) {
        session.addMessage({
          role: "system",
          content:
            "[USER INTERACTION OWNERSHIP] The main assistant owns all user-facing interaction. " +
            "If the latest delegated results require clarification, authorization, approval, or another user decision, ask the user yourself in one concise message and stop delegating until they respond. " +
            "If meaningful intermediate results were confirmed and more work still remains, provide a short progress update summarizing what is already known and what remains open. " +
            "Only describe a next action if you are actually going to call another tool in this same turn. Never restate a proposed follow-up from delegated evidence as already executed unless a completed tool result in this turn proves it happened. If synthesis is required or the turn is ending, do not promise automatic continuation.",
        });
      }
    }

    iterationCount++;

    // After each iteration that included a delegation, refresh the shared-findings
    // system message so the next LLM call (which may be the final synthesis) sees
    // any facts that sub-agents published to shared session memory.  This prevents
    // the orchestrator from hallucinating training-data values (e.g. wrong mic
    // interface type) when a researcher has already verified and shared the truth.
    if (_turnDelegationCount > 0) {
      _sharedFindingsSystemMessage = await formatSharedFactsForFinalSynthesis(session.id);
    }

    // ── All-blocked iteration guard ────────────────────────────────────────
    // If every tool call in this iteration was blocked (per-turn limit, not-allowed,
    // or parse error) the model is stuck — force synthesis after N such iterations.
    {
      const executed = toolResultMessages.filter(m => {
        const txt = typeof m.content === "string" ? m.content : "";
        return !txt.startsWith("Error:") && !txt.includes("blocked by security policy") && !txt.includes("call limit");
      });
      if (executed.length === 0 && toolResultMessages.length > 0) {
        _consecutiveFullyBlockedIterations++;
      } else {
        _consecutiveFullyBlockedIterations = 0;
      }
      if (_consecutiveFullyBlockedIterations >= FULLY_BLOCKED_ITERATION_THRESHOLD) {
        logAudit("tool_loop_detected", {
          reason: "all_tool_calls_blocked",
          consecutiveBlockedIterations: _consecutiveFullyBlockedIterations,
          iterations: iterationCount,
        }, { sessionId: session.id, severity: "warn" });
        terminalFinishReason = "all_tool_calls_blocked";
        terminalSynthesisInstruction =
          "The model repeatedly attempted tool calls that were blocked or unavailable, so NOTHING was created or changed this turn. Stop trying tools. Using ONLY the evidence already present in the conversation, write the best possible final answer now. If the user asked you to create or modify an artifact and you have no direct file tool, say plainly that you could not apply the change and offer to delegate it — do NOT invent an artifact path, and do NOT repeat or re-paste an earlier turn's answer as if the change had been applied.";
        _forcedSynthesisFired = true;
        log.warn({ iterationCount, blocked: _consecutiveFullyBlockedIterations }, "All tool calls blocked for consecutive iterations — forcing synthesis");
        break;
      }
    }

    // ── Iteration-level loop detection ──────────────────────────────────────
    // (a) Identical tool-name set repeating N iterations in a row → force-synthesise.
    const iterToolNames = llmResponse.tool_calls.map(tc => tc.name);
    const iterToolSet = [...iterToolNames].sort().join(",");
    const iterToolSetFullyBoundedByPerTurnCaps = iterToolNames.length > 0
      && iterToolNames.every((toolName) => getPerTurnToolCallLimit(toolName) !== undefined);
    _iterationToolSets.push(iterToolSet);
    if (_iterationToolSets.length > ITERATION_LOOP_THRESHOLD) _iterationToolSets.shift();
    if (
      !iterToolSetFullyBoundedByPerTurnCaps &&
      _iterationToolSets.length >= ITERATION_LOOP_THRESHOLD &&
      _iterationToolSets.every(s => s === _iterationToolSets[0])
    ) {
      logAudit("tool_loop_detected", {
        reason: "iteration_tool_set_repeat",
        toolSet: iterToolSet,
        iterations: iterationCount,
      }, { sessionId: session.id, severity: "warn" });
      log.warn({ iterationCount, toolSet: iterToolSet }, "Same tool-call set repeated across iterations — forcing synthesis");
      break; // falls through to forceSynthesis below
    }

    // (b) Per-tool consecutive-iteration streak — catches "growing" patterns where the
    //     overall tool set changes each iteration but the same core tools keep appearing.
    //     Skip tools that already have a per-turn limit — those are bounded by the limit
    //     and handled by the all-blocked-iterations guard above.
    {
      const currentIterTools = new Set(llmResponse.tool_calls.map(tc => tc.name));
      for (const toolName of currentIterTools) {
        if (!getPerTurnToolCallLimit(toolName)) {
          _toolIterationStreak.set(toolName, (_toolIterationStreak.get(toolName) ?? 0) + 1);
        }
      }
      // Reset streak for tools NOT called in this iteration
      for (const [toolName] of _toolIterationStreak) {
        if (!currentIterTools.has(toolName)) _toolIterationStreak.delete(toolName);
      }
      let streakLoop = false;
      for (const [toolName, streak] of _toolIterationStreak) {
        if (streak >= TOOL_STREAK_THRESHOLD) {
          logAudit("tool_loop_detected", {
            reason: "tool_streak_across_iterations",
            tool: toolName,
            consecutiveIterations: streak,
            iterations: iterationCount,
          }, { sessionId: session.id, severity: "warn" });
          log.warn({ toolName, streak, iterationCount }, "Tool repeated across too many consecutive iterations — forcing synthesis");
          streakLoop = true;
          break;
        }
      }
      if (streakLoop) break; // falls through to forceSynthesis below
    }
  }

  // Exceeded max iterations (or iteration-level loop) — force a synthesis response from the LLM
  opts.onStatus?.({ phase: "synthesizing", message: "Writing the final response from the evidence gathered so far.", iteration: iterationCount });
  const terminalDelegateEvidence = findRecentDelegateEvidence(session.getHistory());
  const terminalSharedFactsEvidence = await getSharedFactsEvidenceForFinalSynthesis(session.id);
  const terminalEvidenceBackstop = chooseBetterRecoveryEvidence(
    terminalDelegateEvidence,
    terminalSharedFactsEvidence,
    { preferHigherScore: false },
  );
  const bypassTerminalSynthesis = shouldBypassTerminalSynthesisWithEvidence(terminalFinishReason, terminalEvidenceBackstop);
  let synthesized = bypassTerminalSynthesis
    ? null
    : await forceSynthesis(
        session, provider, signal, terminalSynthesisInstruction,
      );
  // Honesty guard for terminal turns that did NOT deliver the user's NEW request,
  // yet "answer" by re-pasting an EARLIER turn's deliverable summary almost verbatim —
  // shipping a stale false success. First seen on all_tool_calls_blocked (audit
  // 43b3ec65 turn 3), but the SAME reship happens when a turn ends with tool calls
  // rejected after synthesis was required (audit f6e10341 turn 2: "add images"
  // produced only a sidecar JSON yet the answer re-pasted the turn-1 "presentation
  // created" summary) or hits the iteration limit. So fire across that whole "nothing
  // was actually delivered for THIS request" terminal set, not just the blocked path.
  // The corrective pass keeps the user's language and does NOT assert "nothing was
  // created" (a sidecar may have been written) — only that the prior deliverable was
  // not updated as the stale copy implied.
  const REGURGITATION_GUARD_REASONS = new Set([
    "all_tool_calls_blocked",
    "synthesis_required_tool_call_rejected",
    "max_tool_iterations",
  ]);
  if (
    REGURGITATION_GUARD_REASONS.has(terminalFinishReason)
    && synthesized
    && looksLikeRegurgitatedPriorAnswer(synthesized, session.getHistory())
  ) {
    logAudit("guardrail_flagged", {
      type: "blocked_turn_regurgitated_prior_answer",
      finishReason: terminalFinishReason,
      synthesizedLength: synthesized.length,
    }, { sessionId: session.id, channel: session.channel, severity: "warn" });
    const honest = await forceSynthesis(
      session, provider, signal,
      "Your previous draft re-pasted an earlier turn's answer almost verbatim, which falsely implies the user's NEW request in THIS turn was already carried out. Do NOT ship that stale copy. "
      + "Reply briefly and honestly IN THE USER'S LANGUAGE: describe only what actually happened in THIS turn (what, if anything, was produced or attempted this turn), and if the requested change was NOT applied to the deliverable, say so plainly and offer to delegate it to the right specialist so it gets done. "
      + "Do NOT re-paste the earlier deliverable as if it had been updated, do NOT invent a file path, and do NOT claim a success you cannot point to in this turn's own results.",
    );
    synthesized = (honest && !looksLikeRegurgitatedPriorAnswer(honest, session.getHistory()))
      ? honest
      : "I didn't actually apply that change in this turn, and I won't restate the earlier result as if it had been updated. Confirm and I'll delegate the work to the right specialist so it gets done.\n\nIch habe die Änderung in diesem Schritt nicht tatsächlich angewendet und gebe das frühere Ergebnis nicht als aktualisiert aus. Bestätige bitte, dann delegiere ich die Arbeit an den passenden Spezialisten.";
  }
  // When we have evidence in scope, prefer it over the generic
  // "I've gathered partial results" message — that string was correct
  // about what happened but threw away the partial results.  Only fall
  // back to the static message when no usable evidence exists.
  // The bypass evidence is often a raw shared-facts dump (`- auto_xxx_xxx:
  // <tool tag> <content>` with mid-word "..." cuts). Surfacing that
  // verbatim looks like debug output to the user. Reformat it into a
  // readable list with a clear "research was interrupted" preamble before
  // it becomes the final answer.
  const fallbackMsg = (bypassTerminalSynthesis && terminalEvidenceBackstop)
    ? (looksLikeRawSharedFactsDump(terminalEvidenceBackstop.evidence)
        ? buildRecoveryEvidenceUserMessage(terminalEvidenceBackstop.evidence)
        : terminalEvidenceBackstop.evidence)
    : terminalFinishReason === "max_tool_iterations"
      ? "I've gathered partial results but reached the tool-call limit. Please review the tool outputs above for details."
      : resolveEmptyAssistantResponseFallback("", "", session);
  // Second-chance evidence backstop.  Even when the synthesis call ran,
  // it often comes back with an apologetic 50-200 char reply while
  // substantial structured evidence sits in the transcript — the exact
  // "all the info, no answer" failure mode operators report.  When the
  // synthesis is underpowered AND we have evidence available, prefer the
  // evidence.  Strictly post-hoc — doesn't change cases where synthesis
  // genuinely produced a real answer.
  const useEvidenceOverSynthesis = !bypassTerminalSynthesis
    && terminalEvidenceBackstop
    && looksLikeUnderpoweredSynthesis(synthesized);
  // Last-resort: the runtime suppresses the model's text when it's
  // emitted alongside tool calls (correct in the common case — that text
  // is usually narration like "I'll call X next").  But after several
  // iterations of suppression the most recent suppressed content is
  // typically the closest thing to a real answer the model produced.
  // When BOTH the synthesis call AND the evidence backstop are unavailable
  // (or when synthesis is underpowered AND no delegate evidence exists),
  // surface that suppressed text as the response.
  const useSuppressedTextOverSynthesis = !bypassTerminalSynthesis
    && !useEvidenceOverSynthesis
    && lastSuppressedAssistantText !== null
    && lastSuppressedAssistantText.length >= 200
    && looksLikeUnderpoweredSynthesis(synthesized);
  if (useEvidenceOverSynthesis && terminalEvidenceBackstop) {
    logAudit("sub_agent_synthesis_forced", {
      reason: "underpowered_synthesis_replaced_with_evidence",
      finishReason: terminalFinishReason,
      synthesizedLength: synthesized?.length ?? 0,
      evidenceLength: terminalEvidenceBackstop.evidence.length,
      evidenceItems: terminalEvidenceBackstop.itemCount,
    }, { sessionId: session.id, severity: "warn" });
  } else if (useSuppressedTextOverSynthesis && lastSuppressedAssistantText !== null) {
    logAudit("sub_agent_synthesis_forced", {
      reason: "underpowered_synthesis_replaced_with_suppressed_text",
      finishReason: terminalFinishReason,
      synthesizedLength: synthesized?.length ?? 0,
      suppressedTextLength: lastSuppressedAssistantText.length,
    }, { sessionId: session.id, severity: "warn" });
  }
  const evidenceForUserDisplay = terminalEvidenceBackstop
    && looksLikeRawSharedFactsDump(terminalEvidenceBackstop.evidence)
    ? buildRecoveryEvidenceUserMessage(terminalEvidenceBackstop.evidence)
    : terminalEvidenceBackstop?.evidence;
  const finalCandidate = useEvidenceOverSynthesis && evidenceForUserDisplay
    ? evidenceForUserDisplay
    : useSuppressedTextOverSynthesis && lastSuppressedAssistantText !== null
      ? lastSuppressedAssistantText
      : (synthesized ?? fallbackMsg);
  const normalizedFinalMsg = sanitizeUserFacingAssistantResponse(finalCandidate, iterationCount) || fallbackMsg;
  const evidenceBackstopMsg = looksLikeGenericNoUsableReply(normalizedFinalMsg)
    ? (evidenceForUserDisplay ?? resolveEmptyAssistantResponseFallback("", "", session))
    : normalizedFinalMsg;
  // Auto-build-after-research (orchestration.autoBuildAfterResearch): on a slow backend,
  // research alone can consume the whole turn and the forced terminal synthesis then
  // ships the gathered evidence without ever reaching the artifact-build step. When the
  // user's ORIGINAL request asked to create a concrete artifact, the turn is
  // source-sensitive, research produced curated findings, and NO artifact was produced
  // this turn, auto-run ONE content_writer build from the gathered facts before shipping
  // (audit 33df2aec: a "create a verified reveal.js deck" turn spent ~7 min researching,
  // then shipped a raw search dump and never built the deck). Mirrors autoResearchOnRefusal;
  // degrades to the honest research-gathered fallback if the build produces nothing.
  let autoBuildFinalMsg: string | null = null;
  const curatedForBuild = terminalSharedFactsEvidence
    && !looksLikeRawToolEvidenceDump(terminalSharedFactsEvidence.evidence)
    ? terminalSharedFactsEvidence.evidence
    : null;
  if (
    (getConfig().orchestration?.autoBuildAfterResearch ?? true)
    && initialDynamicGuidance?.sourceSensitive
    && curatedForBuild
    && (terminalSharedFactsEvidence?.itemCount ?? 0) >= 3
    && looksLikeArtifactCreationRequest(userMessage)
    && collectTurnArtifactAttachments(session).length === 0
    && !signal.aborted
  ) {
    logAudit("guardrail_flagged", {
      type: "source_sensitive_auto_build_delegated",
      curatedFacts: terminalSharedFactsEvidence?.itemCount ?? 0,
    }, { sessionId: session.id, channel: session.channel, severity: "warn" });
    opts.onStatus?.({ phase: "guardrail", message: "Die Recherche ist abgeschlossen — ich lasse jetzt den Inhalts-Spezialisten das Artefakt aus den belegten Fakten erstellen.", iteration: iterationCount });
    const buildTask = "BUILD TASK — the research is already done; produce the requested deliverable NOW from the verified findings in the context. "
      + "Do NOT re-research. Use ONLY facts present in the context; cite the source URLs where relevant. "
      + "If it is an HTML page / reveal.js presentation, author compact content and let generate_presentation/generate_website assemble it, or build the file incrementally with write_file mode:\"append\" — never one giant write.\n\nOriginal request:\n"
      + userMessage;
    let buildResultMetadata: Record<string, unknown> | undefined;
    try {
      const buildResult = await executeTool("delegate_to_agent", {
        agentName: "content_writer",
        task: buildTask,
        context: curatedForBuild.slice(0, 8_000),
        // Operator Stop means "build now from what we gathered," so this one bounded
        // build delegation runs even when the stop latch is set (audit 453a263e).
      }, { ...toolContext, allowDelegationAfterOperatorStop: true });
      _turnDelegationCount += 1;
      buildResultMetadata = buildResult.metadata;
      // executeTool here runs OUTSIDE the main tool loop, which is what normally
      // appends the result (with artifacts metadata) to history. Record the auto-build
      // delegation as a well-formed assistant+tool pair so (a) the built artifact
      // surfaces as a clickable attachment on the final message (persistAssistantTurnState
      // → collectTurnArtifactAttachments only reads tool-role history) and (b) history
      // stays valid for synthesis and the next turn (audit 65f46046: the deck WAS built
      // but the success message never shipped because the stale history walk found no
      // artifact and the failure backstop won instead).
      const autoBuildCallId = `autobuild_${Date.now().toString(36)}`;
      session.addMessage({
        role: "assistant",
        content: "",
        tool_calls: [{
          id: autoBuildCallId,
          type: "function",
          function: { name: "delegate_to_agent", arguments: JSON.stringify({ agentName: "content_writer", task: "BUILD TASK (auto-build after research)" }) },
        }],
      });
      session.addMessage({
        role: "tool",
        content: (buildResult.success ? buildResult.output : (buildResult.error?.trim() ? `Error: ${buildResult.error}` : buildResult.output)).slice(0, 4_000),
        tool_call_id: autoBuildCallId,
        metadata: buildResult.metadata,
      });
    } catch (err) {
      log.warn({ err, sessionId: session.id }, "Auto-build-after-research delegation failed");
    }
    // Detect the built artifact from the delegation RETURN metadata first (authoritative;
    // see above), falling back to the history walk.
    const builtArtifacts: Array<Record<string, unknown>> = [];
    if (buildResultMetadata) extractArtifactsFromMetadata(buildResultMetadata, builtArtifacts, new Set<string>());
    if (builtArtifacts.length === 0) {
      for (const a of collectTurnArtifactAttachments(session)) builtArtifacts.push(a);
    }
    if (builtArtifacts.length > 0) {
      const paths = builtArtifacts
        .map((a) => (typeof a["relativePath"] === "string" && a["relativePath"] ? a["relativePath"] : (typeof a["filename"] === "string" ? a["filename"] : "")))
        .filter((p): p is string => Boolean(p));
      const synth = await forceSynthesis(
        session,
        provider,
        signal,
        "The requested artifact has just been BUILT by the content specialist from the verified findings. "
        + "Confirm to the user in the SAME language as their request: state that the file was created, give its path(s), and a 2–3 sentence summary of what it contains and the sources used. Do NOT dump raw evidence.",
      );
      const candidate = synth ? sanitizeUserFacingAssistantResponse(synth, iterationCount) : null;
      autoBuildFinalMsg = candidate && candidate.trim().length >= 80
        ? candidate
        : `Die angeforderte Datei wurde aus den belegten Fakten erstellt: ${paths.join(", ")}.\n\n(The requested file was built from the verified findings: ${paths.join(", ")}.)`;
      logAudit("guardrail_flagged", {
        type: "source_sensitive_auto_build_synthesized",
        artifacts: paths.length,
        synthesized: Boolean(candidate && candidate.trim().length >= 80),
      }, { sessionId: session.id, channel: session.channel, severity: "warn" });
    }
  }

  // Last-resort guard: a raw tool-result dump (web_fetch page chrome, search-result
  // blocks, recovered-evidence scaffolding) must never be the user-facing answer
  // (audit 003f5aeb: every Dresden run, when the artifact build failed, shipped the raw
  // Dresden_Castle Wikipedia nav menu verbatim). Replace it with the curated, sourced
  // findings under an honest could-not-finish preamble, or an honest status when nothing
  // clean was gathered. Structural detection only — topic- and site-agnostic.
  let presentableFinalMsg: string = autoBuildFinalMsg ?? evidenceBackstopMsg;
  if (!autoBuildFinalMsg && looksLikeRawToolEvidenceDump(presentableFinalMsg)) {
    const curated = terminalSharedFactsEvidence
      && !looksLikeRawToolEvidenceDump(terminalSharedFactsEvidence.evidence)
      ? terminalSharedFactsEvidence.evidence
      : null;
    logAudit("guardrail_flagged", {
      type: "raw_tool_evidence_dump_suppressed",
      finishReason: terminalFinishReason,
      dumpLength: presentableFinalMsg.length,
      curatedFacts: terminalSharedFactsEvidence?.itemCount ?? 0,
    }, { sessionId: session.id, channel: session.channel, severity: "warn" });
    presentableFinalMsg = buildResearchGatheredFallback(curated);
  }
  // Fabricated-inline-artifact guard: on a source-sensitive artifact-creation turn that
  // produced NO real artifact (the build was stopped/blocked/never ran), the model
  // sometimes hand-writes the whole deliverable inline (a multi-KB <!DOCTYPE html> /
  // fenced code block) from training data and presents it as the verified result (audit
  // 453a263e: the operator Stopped mid-research, the auto-build was correctly blocked, and
  // synthesis pasted a fabricated reveal.js deck repeating the Permoser→Neumann error + an
  // invented source URL — no workspace file, false "verified" claim). Replace it with the
  // honest curated-facts fallback: the verified findings + real sources, stating the file
  // was not built this turn. Scoped to the no-artifact case so legit builds are untouched.
  if (
    !autoBuildFinalMsg
    && initialDynamicGuidance?.sourceSensitive
    && looksLikeArtifactCreationRequest(userMessage)
    && (terminalSharedFactsEvidence?.itemCount ?? 0) >= 1
    && collectTurnArtifactAttachments(session).length === 0
    && looksLikeInlinedArtifactFabrication(presentableFinalMsg)
  ) {
    const curatedForHonest = terminalSharedFactsEvidence
      && !looksLikeRawToolEvidenceDump(terminalSharedFactsEvidence.evidence)
      ? terminalSharedFactsEvidence.evidence
      : null;
    if (curatedForHonest) {
      logAudit("guardrail_flagged", {
        type: "inline_artifact_fabrication_suppressed",
        answerLength: presentableFinalMsg.length,
        curatedFacts: terminalSharedFactsEvidence?.itemCount ?? 0,
      }, { sessionId: session.id, channel: session.channel, severity: "warn" });
      presentableFinalMsg = buildResearchGatheredFallback(curatedForHonest);
    }
  }
  const finalMsg = await rewriteTerminalResponseIfNeeded(presentableFinalMsg, iterationCount, session, provider, signal);
  persistAssistantTurnState(session, finalMsg, getTurnSwarmState());
  if (opts.onChunk) opts.onChunk(finalMsg);

  const performance = buildTurnPerformanceMetrics({
    turnStartedAt,
    firstModelResponseMs,
    llmCalls,
    llmTimeMs,
    toolCallsRequested,
    toolExecutionTimeMs,
    lastPromptMetrics,
    completionChars: finalMsg.length,
    finishReason: terminalFinishReason,
    blocked: false,
    toolIterations: iterationCount,
  });
  logAudit("turn_performance", { ...performance, usage: totalUsage }, {
    sessionId: session.id,
    channel: session.channel,
    severity: "warn",
  });
  logAudit("message_sent", { length: finalMsg.length, toolCalls: iterationCount, usage: totalUsage, performance }, {
    sessionId: session.id,
    channel: session.channel,
    severity: "warn",
  });
  logAudit("turn_scorecard", {
    delegationCount: _turnDelegationCount,
    shareFindingCount: _turnShareFindingCount,
    forcedSynthesisFired: _forcedSynthesisFired,
    wardenFailureCount: _consecutiveDelegationFailures,
    finalAnswerLength: finalMsg.length,
    toolIterations: iterationCount,
    finishReason: terminalFinishReason,
  }, { sessionId: session.id, channel: session.channel, severity: "warn" });
  return {
    response: finalMsg,
    toolCallsExecuted: iterationCount,
    guardrailEvents,
    usage: totalUsage,
    blocked: false,
    swarmState: getTurnSwarmState(),
    performance,
  };
}

/**
 * Inject a synthesis prompt and make one final LLM call with no tools.
 * Used when the turn hits max iterations or is cancelled mid-flight.
 * Returns null if the synthesis call itself fails or is aborted.
 */
async function forceSynthesis(
  session: AgentSession,
  provider: ChatProvider,
  signal: AbortSignal,
  instruction: string,
): Promise<string | null> {
  try {
    // Don't attempt synthesis if already aborted and we have nothing
    if (signal.aborted && session.getHistory().length < 3) return null;
    const sharedFindingsPrompt = await formatSharedFactsForFinalSynthesis(session.id);

    // Inject a synthesize-now user message (not stored in permanent history)
    const messages: LLMMessage[] = [
      { role: "system", content: session.getSystemPrompt() },
      { role: "system", content: buildTemporalContextPrompt() },
      ...(sharedFindingsPrompt ? [{ role: "system" as const, content: sharedFindingsPrompt }] : []),
      ...session.getCollapsedHistory(),
      { role: "user", content: `[SYSTEM INSTRUCTION — RESPOND NOW]: ${instruction} Before drafting, verify every assumption against the tool results and shared findings in this conversation. If a claim is not supported there, omit it or mark it unverified.` },
    ];

    // No hard timeout on the synthesis call — the provider (LMStudio / API)
    // is responsible for its own request deadline, and large local GPU models
    // may need several minutes for a full context. A fixed JS timer here
    // aborts a still-running synthesis and returns null, causing the user to
    // see a raw evidence dump instead of a real answer.
    const synthAbort = new AbortController();

    // E25: prefer the synthesis-tier provider when configured — smaller,
    // instruction-tuned models produce tighter final answers and avoid the
    // reasoning-model tendency to re-narrate tool calls during rewrite.
    const synthesisProvider = getChatProviderForTier("synthesis") ?? provider;

    try {
      const response = await synthesisProvider.complete(messages, [], synthAbort.signal);
      const text = response.content?.trim();
      return text || null;
    } finally {
      synthAbort.abort(); // release resources if call is still open
    }
  } catch {
    return null;
  }
}

function blocked(reason: string, swarmState?: SwarmState, performance?: TurnPerformanceMetrics): TurnOutput {
  return {
    response: reason,
    toolCallsExecuted: 0,
    guardrailEvents: [{ type: "blocked", details: reason }],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    blocked: true,
    swarmState,
    performance,
  };
}

/**
 * Walk backward through session history and extract completed/partial swarm
 * tasks from the most recent assistant message that has persisted swarm state.
 *
 * These are seeded into the new turn's swarmState.tasks so that, on a retry,
 * sub-agents see prior research and skip re-running identical tasks instead of
 * doing all the work from scratch.
 *
 * Only `completed` and `partial` tasks are carried forward. `failed`, `running`,
 * `pending`, and `blocked` tasks are dropped so they can be re-attempted cleanly.
 */
function loadPreviousTurnSwarmTasks(history: readonly SessionHistoryMessage[]): SwarmState["tasks"] {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]!;
    if (msg.role !== "assistant") continue;
    const raw = msg.metadata?.["swarmState"];
    if (!raw || typeof raw !== "object") continue;
    const prev = raw as SwarmState;
    if (!prev.tasks) continue;
    const carried: SwarmState["tasks"] = {};
    for (const [id, task] of Object.entries(prev.tasks)) {
      if (task.status === "completed" || task.status === "partial") {
        carried[id] = task;
      }
    }
    // Only return if there is something worth carrying forward
    if (Object.keys(carried).length > 0) return carried;
  }
  return {};
}

function buildPersistableSwarmTaskDelta(
  currentTasks: SwarmState["tasks"],
  carriedTasks: SwarmState["tasks"],
): SwarmState["tasks"] {
  const delta: SwarmState["tasks"] = {};

  for (const [taskId, task] of Object.entries(currentTasks)) {
    const carriedTask = carriedTasks[taskId];
    if (!carriedTask) {
      delta[taskId] = task;
      continue;
    }

    const carriedAttempts = carriedTask.attempts ?? [];
    const currentAttempts = task.attempts ?? [];
    const nextAttempts = currentAttempts.slice(carriedAttempts.length);
    const carriedOutput = typeof carriedTask.output === "string" ? carriedTask.output : "";
    const currentOutput = typeof task.output === "string" ? task.output : "";
    const carriedError = typeof carriedTask.error === "string" ? carriedTask.error : "";
    const currentError = typeof task.error === "string" ? task.error : "";
    const outputChanged = currentOutput !== carriedOutput;
    const errorChanged = currentError !== carriedError;
    const statusChanged = task.status !== carriedTask.status;

    if (nextAttempts.length === 0 && !outputChanged && !errorChanged && !statusChanged) {
      continue;
    }

    delta[taskId] = {
      ...task,
      attempts: nextAttempts,
      output: outputChanged ? task.output : undefined,
      error: errorChanged ? task.error : undefined,
    };
  }

  return delta;
}

function selectPersistableSwarmState(
  swarmState: SwarmState | undefined,
  carriedTasks: SwarmState["tasks"],
  carriedTaskFingerprint: string,
  usedSwarmTools: boolean,
): SwarmState | undefined {
  if (!swarmState) return undefined;
  const currentTasks = swarmState.tasks ?? {};
  if (Object.keys(currentTasks).length === 0) return undefined;
  const persistableTasks = buildPersistableSwarmTaskDelta(currentTasks, carriedTasks);
  if (Object.keys(persistableTasks).length === 0) {
    return undefined;
  }
  if (!usedSwarmTools && stableSerialize(currentTasks) === carriedTaskFingerprint) {
    return undefined;
  }
  return {
    ...swarmState,
    tasks: persistableTasks,
  };
}

function persistAssistantTurnState(session: AgentSession, content: string, swarmState?: SwarmState): void {
  // Pull all artifacts produced during the current turn (since the last user
  // message) onto the final assistant message. The frontend already extracts
  // artifacts from each tool call's metadata on the iteration messages, but
  // (a) those intermediate messages can be pruned by history trimming over
  // long sessions, and (b) the final synthesis message is the durable
  // "here's what I made for you" surface — having attachments live there
  // keeps the artifact list reachable as long as the message itself exists.
  const attachments = collectTurnArtifactAttachments(session);
  const metadata: Record<string, unknown> = {};
  if (swarmState) metadata["swarmState"] = structuredClone(swarmState);
  if (attachments.length > 0) metadata["attachments"] = attachments;

  if (Object.keys(metadata).length > 0) {
    session.addMessage({ role: "assistant", content, metadata });
    return;
  }
  session.addMessage({ role: "assistant", content });
}

/**
 * Walk the current turn's tool-role messages (since the last user message) and
 * extract every artifact reference into a normalized `SessionTranscriptAttachment`
 * list. Recurses into nested `artifacts[]` arrays (the shape used by
 * `delegate_to_agent` to bubble sub-agent artifacts back up). Dedupes by the
 * fields that the transcript builder also uses, so the final-message
 * attachments don't get duplicated when a single artifact bubbles through
 * multiple delegation hops.
 */
export function collectTurnArtifactAttachments(session: AgentSession): Array<Record<string, unknown>> {
  const history = session.getHistory();
  const attachments: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  type RawMessage = { role: string; metadata?: Record<string, unknown> };
  // Walk backwards from the end until we hit the user message that opened
  // this turn. We only want artifacts from THIS turn — not from previously
  // persisted assistant turns.
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i] as unknown as RawMessage;
    if (msg.role === "user") break;
    if (msg.role !== "tool") continue;
    if (!msg.metadata || typeof msg.metadata !== "object") continue;
    extractArtifactsFromMetadata(msg.metadata, attachments, seen);
  }
  return attachments;
}

function extractArtifactsFromMetadata(
  metadata: Record<string, unknown>,
  out: Array<Record<string, unknown>>,
  seen: Set<string>,
): void {
  const filename = typeof metadata["filename"] === "string" ? metadata["filename"].trim() : "";
  const outputPath = typeof metadata["outputPath"] === "string" ? metadata["outputPath"].trim() : "";
  const externalUrl = typeof metadata["externalUrl"] === "string" ? metadata["externalUrl"].trim() : "";

  if (filename || outputPath || externalUrl) {
    const key = [outputPath, externalUrl, filename, typeof metadata["sourceTool"] === "string" ? metadata["sourceTool"] : ""].join("::");
    if (!seen.has(key)) {
      seen.add(key);
      // A `filename` is required by the transcript builder. Derive one when
      // only a path is available. `pop()` can yield an empty string for a
      // trailing-slash path (e.g. "subdir/") — fall back to the raw path
      // so the transcript builder never sees an empty filename.
      const derivedFilename = filename
        || (outputPath ? (outputPath.split("/").pop() || outputPath) : "")
        || externalUrl;
      const entry: Record<string, unknown> = { filename: derivedFilename };
      if (outputPath) entry["relativePath"] = outputPath;
      if (externalUrl) entry["externalUrl"] = externalUrl;
      if (typeof metadata["contentType"] === "string") entry["contentType"] = metadata["contentType"];
      if (typeof metadata["previewMode"] === "string") entry["previewMode"] = metadata["previewMode"];
      if (typeof metadata["size"] === "number") entry["size"] = metadata["size"];
      else if (typeof metadata["bytes"] === "number") entry["size"] = metadata["bytes"];
      if (metadata["isDirectory"] === true) entry["isDirectory"] = true;
      if (typeof metadata["title"] === "string" && metadata["title"]) entry["title"] = metadata["title"];
      if (typeof metadata["sourceTool"] === "string" && metadata["sourceTool"]) entry["sourceTool"] = metadata["sourceTool"];
      out.push(entry);
    }
  }

  const nested = metadata["artifacts"];
  if (Array.isArray(nested)) {
    for (const item of nested) {
      if (item && typeof item === "object") {
        extractArtifactsFromMetadata(item as Record<string, unknown>, out, seen);
      }
    }
  }
}

function appendNonDuplicatedContinuation(existing: string, continuation: string): string {
  if (!continuation) return existing;
  if (!existing) return continuation;
  if (existing.endsWith(continuation)) return existing;

  const maxOverlap = Math.min(existing.length, continuation.length, MAX_CONTINUATION_OVERLAP_CHARS);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (existing.slice(-size) === continuation.slice(0, size)) {
      return `${existing}${continuation.slice(size)}`;
    }
  }

  return `${existing}${continuation}`;
}

/**
 * Recognise the "model is dumping a giant artifact inline as a chat code
 * block" failure mode. Observed live: orchestrator falls back to writing the
 * full HTML in chat when a delegated content_writer fails to call write_file,
 * the response hits the token cap mid-document, and the length-continuation
 * loop stitches it back together — eventually a 50 KB cut-off chat reply
 * with no artifact persisted anywhere.
 *
 * Heuristic: a single ```html / ```javascript / ```css / ```vue fence with
 * a body larger than INLINE_ARTIFACT_FENCE_BYTES, OR the unclosed-fence
 * shape that happens when the cap fires mid-block. Plain prose, even very
 * long, isn't flagged; tutorial answers with multiple small snippets aren't
 * flagged.
 */
const INLINE_ARTIFACT_FENCE_BYTES = 5000;
const INLINE_ARTIFACT_LANGS = ["html", "javascript", "js", "ts", "tsx", "jsx", "css", "vue", "svelte", "xml"];

export function looksLikeRunawayInlineArtifact(content: string): boolean {
  if (content.length < INLINE_ARTIFACT_FENCE_BYTES) return false;
  const fenceRe = /```([a-zA-Z0-9_+\-]*)\n([\s\S]*?)(?:```|$)/g;
  let match: RegExpExecArray | null;
  while ((match = fenceRe.exec(content)) !== null) {
    const lang = (match[1] ?? "").toLowerCase();
    const body = match[2] ?? "";
    if (!INLINE_ARTIFACT_LANGS.includes(lang)) continue;
    if (body.length >= INLINE_ARTIFACT_FENCE_BYTES) return true;
    // Cap fired mid-fence → the regex's `|$` branch matched; the body
    // length reflects everything from the opener to EOF, so the size
    // check above already covers it. No extra logic needed.
  }
  return false;
}

async function continueLengthLimitedResponse(
  provider: ChatProvider,
  baseMessages: readonly LLMMessage[],
  initialResponse: LLMResponse,
  signal: AbortSignal,
  onChunk?: (text: string) => void,
): Promise<{ response: LLMResponse; additionalCalls: number; additionalTimeMs: number; runawayInlineArtifact: boolean }> {
  let response: LLMResponse = { ...initialResponse, tool_calls: [...initialResponse.tool_calls] };
  let additionalCalls = 0;
  let additionalTimeMs = 0;
  let runawayInlineArtifact = false;

  for (let attempt = 0; attempt < MAX_LENGTH_CONTINUATION_ATTEMPTS; attempt += 1) {
    if (response.finishReason !== "length" || response.tool_calls.length > 0 || signal.aborted) {
      break;
    }

    const partialContent = response.content ?? "";
    if (!partialContent.trim()) {
      break;
    }

    // If the partial already looks like a runaway inline-artifact dump,
    // stop stitching. Continuing would just append more lines of the same
    // truncated HTML; the user is better served by a visible failure than
    // a 50 KB cut-off chat reply that pretends to be a working app.
    if (looksLikeRunawayInlineArtifact(partialContent)) {
      runawayInlineArtifact = true;
      break;
    }

    const continuationMessages: LLMMessage[] = [
      ...baseMessages,
      { role: "assistant", content: partialContent },
      {
        role: "user",
        content: [
          "Continue your previous response exactly where it stopped.",
          "Return only the next continuation chunk.",
          "Do not restart the answer, do not repeat earlier lines, do not add a new introduction, and do not call tools.",
        ].join(" "),
      },
    ];

    const continuationStartedAt = Date.now();
    const continuationResponse = await collectStream(provider.stream(continuationMessages, [], signal), onChunk);
    additionalCalls += 1;
    additionalTimeMs += Date.now() - continuationStartedAt;

    response = {
      content: appendNonDuplicatedContinuation(partialContent, continuationResponse.content ?? ""),
      tool_calls: continuationResponse.tool_calls,
      usage: {
        promptTokens: response.usage.promptTokens + continuationResponse.usage.promptTokens,
        completionTokens: response.usage.completionTokens + continuationResponse.usage.completionTokens,
        totalTokens: response.usage.totalTokens + continuationResponse.usage.totalTokens,
      },
      finishReason: continuationResponse.finishReason,
    };
  }

  return { response, additionalCalls, additionalTimeMs, runawayInlineArtifact };
}

function measurePrompt(systemMessages: readonly LLMMessage[], history: readonly LLMMessage[]): {
  systemPromptChars: number;
  collapsedHistoryMessages: number;
  collapsedHistoryChars: number;
  promptChars: number;
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
    promptChars: systemPromptChars + collapsedHistoryChars,
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

/**
 * Consume a streaming LLM generator into a complete LLMResponse.
 * Optionally defers text until the response is known not to contain tool calls.
 */
async function collectStream(
  generator: AsyncGenerator<StreamChunk>,
  onChunk?: (text: string) => void,
  options: { deferTextUntilToolDecision?: boolean; onReasoning?: (text: string) => void } = {},
): Promise<LLMResponse> {
  let content = "";
  let reasoning = "";
  const toolCallBuffers = new Map<string, { id: string; name: string; args: string }>();
  let finishReason = "stop";
  let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let sawToolCall = false;

  for await (const chunk of generator) {
    if (chunk.type === "reasoning_delta" && chunk.content) {
      reasoning += chunk.content;
      // Reasoning always streams live — it precedes the answer and the UI
      // collapses it once the first answer token arrives.
      options.onReasoning?.(chunk.content);
    } else if (chunk.type === "text_delta" && chunk.content) {
      content += chunk.content;
      if (!options.deferTextUntilToolDecision) {
        onChunk?.(chunk.content);
      }
    } else if (chunk.type === "tool_call_start" && chunk.toolCallId && chunk.toolName) {
      sawToolCall = true;
      toolCallBuffers.set(chunk.toolCallId, { id: chunk.toolCallId, name: chunk.toolName, args: "" });
    } else if (chunk.type === "tool_call_delta" && chunk.toolCallId && chunk.argumentsDelta) {
      const buf = toolCallBuffers.get(chunk.toolCallId);
      if (buf) buf.args += chunk.argumentsDelta;
    } else if (chunk.type === "done") {
      if (chunk.finishReason) finishReason = chunk.finishReason;
      if (chunk.usage) usage = chunk.usage;
    }
  }

  const tool_calls = [...toolCallBuffers.values()].map(buf => ({
    id: buf.id,
    name: buf.name,
    arguments: (() => {
      try { return JSON.parse(buf.args) as Record<string, unknown>; }
      catch { return { _parse_error: true, _raw: buf.args } as Record<string, unknown>; }
    })(),
  }));

  if (options.deferTextUntilToolDecision && onChunk && !sawToolCall && content) {
    onChunk(content);
  }

  return { content: content || null, ...(reasoning ? { reasoning } : {}), tool_calls, usage, finishReason };
}

function buildTurnPerformanceMetrics(input: {
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
  };
  completionChars: number;
  finishReason: string;
  blocked: boolean;
  toolIterations: number;
}): TurnPerformanceMetrics {
  return {
    turnDurationMs: Date.now() - input.turnStartedAt,
    firstModelResponseMs: input.firstModelResponseMs,
    llmCalls: input.llmCalls,
    llmTimeMs: input.llmTimeMs,
    toolCallsRequested: input.toolCallsRequested,
    toolExecutionTimeMs: input.toolExecutionTimeMs,
    systemPromptChars: input.lastPromptMetrics.systemPromptChars,
    collapsedHistoryMessages: input.lastPromptMetrics.collapsedHistoryMessages,
    collapsedHistoryChars: input.lastPromptMetrics.collapsedHistoryChars,
    promptChars: input.lastPromptMetrics.promptChars,
    completionChars: input.completionChars,
    toolIterations: input.toolIterations,
    finishReason: input.finishReason,
    blocked: input.blocked,
  };
}
