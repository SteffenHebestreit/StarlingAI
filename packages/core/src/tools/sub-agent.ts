/**
 * Sub-agent tools
 *
 * delegate_to_agent — hand a task off to a named specialist sub-agent
 * list_agents       — enumerate configured sub-agents (so the orchestrator can pick)
 */

import { registerTool, getAllTools, rerankToolsForTask, searchToolsByEmbedding, type SwarmState, type SwarmTaskAttempt, type SwarmTaskState, type ToolContext, type ToolResult } from "./registry.js";
import { runSubAgent, runSubAgentWithStats } from "../agent/sub-agent.js";
import { getConfig } from "../config/loader.js";
import { computeAgentIntentAdjustment, computeAgentTaskShapeAdjustment, isEmbeddingAvailable, scoreAgentKeywordMatch, searchByEmbedding, computeQueryEmbedding, cosineSimilarity } from "../providers/embeddings.js";
import { getEmbeddingProvider } from "../providers/index.js";
import { logAudit } from "../audit/logger.js";
import { readRecentOutcomes, computeAgentCostProfile, computeOutcomeRoutingMultiplier, extractTaskKeywords, type AgentCostProfile } from "../agent/outcomes.js";
import { getToolTier, ToolTier } from "../guardrails/tool-tiers.js";
import { readPromotedAgents, promoteEphemeralAgent, PROMOTION_MIN_SUCCESSES, PROMOTION_MIN_SUCCESS_RATE } from "../agent/promoted-agents.js";
import { emitSwarmEvent } from "../swarm/bus.js";
import { announceAgentCapability } from "../swarm/capabilities.js";
import { clearTaskBids, collectTaskBids, DEFAULT_AUTONOMOUS_BID_WINDOW_MS, isAutonomousBiddingStarted } from "../swarm/bidding.js";
import { acquireTaskLock, releaseTaskLock } from "../swarm/locks.js";
import { formatSharedContextForPrompt, appendPartialResult, extractFactsFromOutput, writeSharedFact, searchSharedFacts, searchPartialResults } from "../swarm/memory.js";
import { graphPromoteFact } from "../memory/graph-service.js";
import { rerankCandidates } from "../retrieval/reranker.js";
import { recordCapabilityGap } from "../agent/self-improve.js";
import { isNavigationRoutingRequest } from "../agent/intent-classifier.js";

const SERVER_EXECUTION_AGENT_NAMES = new Set(["shell_agent", "ops_triage", "infrastructure_agent"]);
/**
 * Minimum score for a candidate to qualify when semantic embeddings are
 * actually used (rerank mode).  Semantic similarity scores are normalized
 * narrowly around 0.5–0.95, so the cutoff sits high.
 */
const SEMANTIC_AGENT_ROUTING_MIN_SCORE = 0.72;

/**
 * Minimum score for a candidate to qualify when only keyword scoring is
 * available (no embedding endpoint reachable — typical in unit tests and
 * when LM Studio is unavailable).  Keyword scores are aggressively
 * normalized down by the per-token-then-average-and-clamp pipeline in
 * scoreAgentKeywordMatch; they rarely cross 0.72 even for unambiguous
 * specialist matches like "git commit" → git_developer.  A higher floor
 * here causes the routing layer to silently drop legitimate candidates
 * and return "none" for common queries.
 */
const KEYWORD_AGENT_ROUTING_MIN_SCORE = 0.45;

function confidenceLabel(score: number): "high" | "medium" | "low" {
  if (score >= 0.72) return "high";
  if (score >= 0.45) return "medium";
  return "low";
}

function confidenceThreshold(label: "high" | "medium" | "low"): number {
  if (label === "high") return 0.72;
  if (label === "medium") return 0.45;
  return 0;
}

interface HeuristicRoutingSignals {
  looksBroad: boolean;
  looksFresh: boolean;
  looksSourceHeavy: boolean;
  looksDocumentDeliverable: boolean;
  looksResearchTask: boolean;
  looksSourceGroundedDocumentWorkflow: boolean;
  looksWebTask: boolean;
  looksArtifactRender: boolean;
  looksGroundedInput: boolean;
  looksSequential: boolean;
  looksVisualization: boolean;
  looksDataHeavy: boolean;
  looksExternalData: boolean;
  looksSynthesisHeavy: boolean;
  looksMultiStageEvidenceWorkflow: boolean;
  looksRenderFromProvidedData: boolean;
  looksBrowserLoginTask: boolean;
  looksComputerUse: boolean;
  looksServerAdmin: boolean;
  looksServiceTroubleshooting: boolean;
  domainCount: number;
  prefersPlanner: boolean;
}

function analyzeHeuristicRoutingQuery(query: string): HeuristicRoutingSignals {
  const normalized = query.trim().toLowerCase();
  const looksTimeWindow = /\b(last|past)\s+\d+\s+(days?|weeks?|months?|years?)\b/i.test(normalized);
  const looksMarketData = /\b(etf|fund|funds|index|indices|stocks?|shares?|equities|benchmark|benchmarks|returns?|historical|history|time[ -]?series|performance)\b/i.test(normalized);
  const looksBroad = /\b(comprehensive|guide|tutorial|walkthrough|step by step|step-by-step|deep dive|covering|compare|comparison|overview|audit)\b/i.test(normalized);
  const looksFresh = /\b(2025|2026|current|currently|latest|recent|recently|updated|today|now|last year|this year)\b/i.test(normalized);
  const looksSourceHeavy = /\b(official|source|sources|citation|citations|reference|references|documentation|docs|release notes|spec|specification|standard)\b/i.test(normalized);
  const looksDocumentDeliverable = /\b(report|reports|brief|briefs|paper|papers|summary|summaries|presentation|writeup|write-ups?|document|documents|whitepaper|white paper|essay|bericht|berichte|aufsatz)\b/i.test(normalized);
  const looksResearchTask = /\b(research|researching|researcher|recherche|recherchiere|forschung|investigate|investigation)\b/i.test(normalized);
  // Bare `web` matches casual phrasing like "search the web for X" which
  // is researcher's idiom — not a real browser/online task.  Require an
  // explicit web/browser/online noun so wtc only owns true web tasks.
  const looksWebTask = /\b(website|webseite|browser|online|wcag|a11y|accessibility|testing|audit)\b/i.test(normalized);
  const looksArtifactRender = /\b(create|build|generate|render|produce|turn|convert|visuali[sz]e|present|html)\b/i.test(normalized);
  const looksGroundedInput = /\b(already|verified|provided|given|attached|collected|existing|these|this data|the data|following|from these|from this|using the verified|using the collected)\b/i.test(normalized);
  // Plain `next` matches "next Friday" / "next week" — those are date
  // qualifiers, not sequential-workflow signals.  Require a workflow noun
  // after `next` (step, task, phase, …) so weather/scheduler queries
  // don't get classified as multi-step missions.
  const looksSequential = /\b(first|then|after|before|next\s+(step|task|phase|stage|action|item|iteration|round)|based on|using the findings|using findings|depends on|dependency|dependencies|workflow|pipeline|plan)\b/i.test(normalized);
  const looksVisualization = /\b(chart|graph|plot|table|diagram|visuali[sz]ation|dashboard|mermaid)\b/i.test(normalized);
  const looksDataHeavy = /\b(data|dataset|csv|json|spreadsheet|metrics?|average|averages|trend|trends|monthly|yearly|quarterly|statistics?|analy[sz]e|analyse|calculate|comparison)\b/i.test(normalized)
    || looksMarketData
    || looksTimeWindow;
  const looksExternalData = /\b(weather|climate|temperature|temperatures|sales|revenue|prices?|market|population|forecast|statistics?|latest|recent|current|source|sources)\b/i.test(normalized)
    || (looksMarketData && !looksGroundedInput)
    || (looksTimeWindow && looksVisualization && !looksGroundedInput);
  const looksSynthesisHeavy = /\b(compare|comparison|merge|combine|reconcile|aggregate|synthesi[sz]e|summari[sz]e)\b/i.test(normalized);
  const looksRenderFromProvidedData = looksGroundedInput
    && (looksVisualization || looksArtifactRender)
    && !looksSourceHeavy
    && !looksFresh
    && !looksExternalData
    && !looksSequential;
  // Require both a login/form/auth signal AND a site/navigation/target signal so that
  // isolated keywords like "login" in unrelated contexts (e.g. "login taxonomy regulatory")
  // do not over-match.
  const hasLoginSignal = /\b(log[ -]?in|login|sign[ -]?in|signin|anmeld(?:en|ung)?|zugangsdaten|credentials?|username|password|portal|account|dashboard|inbox|mailbox|form|formular|apply|application|bewerb(?:en|ung)?|submit|checkout|invoice|rechnung)\b/i.test(normalized);
  const hasBrowserTargetSignal = /\b(browser|website|web\s?site|webseite|seite|page|url|https?:\/\/|\.(?:com|de|org|net|io|co|app|dev|gov|edu)(?:\/|\b)|site|login[- ]?url|freelancermap|github|gitlab|twitter|linkedin|xing|amazon|ebay|facebook|instagram|portal|dashboard|inbox|mailbox|nachrichten?|messages?|fill|navigate|navigation|open|browse|visit|check|retrieve|download|upload|click|type)\b/i.test(normalized);
  const looksBrowserLoginTask = hasLoginSignal && hasBrowserTargetSignal;
  const looksMultiStageEvidenceWorkflow = (looksVisualization || looksArtifactRender)
    && (looksDataHeavy || looksExternalData || looksSourceHeavy || looksFresh)
    && (!looksRenderFromProvidedData || looksSequential);
  const looksSecurityScan = /\b(pentest|penetration|security|vulnerabilit|cve|exploit|scan|nmap|nikto|sqlmap|hydra|metasploit|authorized scope)\b/i.test(normalized);
  const hasDesktopKeyword = /\b(meinem?\s+(?:pc|computer|rechner|desktop|workstation)|my\s+(?:pc|computer|desktop|workstation)|on\s+(?:the\s+)?(?:pc|computer|desktop|machine)\s+at|lokale[mnrs]?\s+(?:pc|computer|rechner|desktop))\b/i.test(normalized);
  const hasIpAddress = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(normalized);
  const hasDesktopAppContext = /\b(rdp|vnc|desktop|lm\s*studio|obs|vs\s*code|app(?:lication)?|open|type|click|screenshot|launched?|running|installed|geladen|gestartet|geöffnet|bildschirm|fenster)\b/i.test(normalized);
  // `n8n` alone is the workflow product, not a server.  Only the explicit
  // `n8n-server` form indicates an admin/ops target.  Bare `n8n` belongs
  // to workflow_designer's scope.
  const hasServerTarget = /\b(server|host|vm|vps|instance|container|containers|n8n-server|ssh)\b/i.test(normalized);
  const hasServerAdminAction = /\b(ssh|docker|docker\s+ps|docker\s+compose|systemctl|journalctl|kubectl|podman|service\s+status|tail(?:\s+-f)?|ps\s+aux|df\s+-h|container|containers)\b/i.test(normalized)
    || /\b(?:show|view|check|inspect|read|tail)\s+logs?\b/i.test(normalized)
    || /(?:^|\s)(?:top|htop)(?=$|\s|[.,;:!?])/i.test(normalized);
  const looksServiceTroubleshooting = (
    /\b(logs?|health|healthy|unhealthy|restart|restarted|crash|crashed|failing|failed|failure|down|stopped|error|incident|debug|diagnos(?:e|ing|is)|investigat(?:e|ing|ion)|why)\b/i.test(normalized)
      && /\b(server|host|vm|vps|instance|container|containers|n8n(?:-server)?|docker|systemctl|journalctl|service)\b/i.test(normalized)
  ) || /\b(journalctl|docker\s+logs|systemctl\s+status|docker\s+compose\s+ps)\b/i.test(normalized);
  const looksServerAdmin = !looksSecurityScan
    && (hasServerAdminAction || (hasIpAddress && /\b(ssh|docker|systemctl|journalctl|kubectl|server|host|vm|container)\b/i.test(normalized)) || hasServerTarget)
    && !hasDesktopKeyword
    && !/\b(rdp|vnc|desktop|bildschirm|fenster|click|type|screenshot)\b/i.test(normalized);
  const looksComputerUse = !looksSecurityScan
    && !looksServerAdmin
    && (hasDesktopKeyword || (hasIpAddress && hasDesktopAppContext));

  const domainCount = [
    looksWebTask || looksSourceHeavy || looksFresh,
    looksDataHeavy,
    looksVisualization,
    looksDocumentDeliverable,
  ].filter(Boolean).length;

  const looksSourceGroundedDocumentWorkflow = looksDocumentDeliverable
    && (looksSourceHeavy
      || looksFresh
      || looksResearchTask
      || looksSynthesisHeavy
      || domainCount >= 2
      || /\b(compare|comparison|versus|vs\.?|vergleich|protocol|protocols|protokoll|protokolle|standard|standards)\b/i.test(normalized));

  return {
    looksBroad,
    looksFresh,
    looksSourceHeavy,
    looksDocumentDeliverable,
    looksResearchTask,
    looksSourceGroundedDocumentWorkflow,
    looksWebTask,
    looksArtifactRender,
    looksGroundedInput,
    looksSequential,
    looksVisualization,
    looksDataHeavy,
    looksExternalData,
    looksSynthesisHeavy,
    looksMultiStageEvidenceWorkflow,
    looksRenderFromProvidedData,
    looksBrowserLoginTask,
    looksComputerUse,
    looksServerAdmin,
    looksServiceTroubleshooting,
    domainCount,
    prefersPlanner: looksSequential
      || looksMultiStageEvidenceWorkflow
      || looksSourceGroundedDocumentWorkflow
      || (looksVisualization && (looksExternalData || looksDataHeavy))
      || (looksSynthesisHeavy && domainCount >= 2)
      || domainCount >= 3
      || (looksBroad && domainCount >= 2),
  };
}

function looksLikeDurableMemoryTask(task: string): boolean {
  const normalized = task.trim().toLowerCase();
  if (!normalized) return false;

  const hasMemoryVerb = /\b(remember|save|store|persist|record|note|take a note|save this|remember this|memorize|merk dir|speicher(?:e|n)?|notier(?:e|en)?|merke|festhalten)\b/i.test(normalized);
  const hasMemoryDestination = /\b(memory|workspace memory|user memory|persistent memory|durable memory|future session|future sessions|future tasks?|for later|preferences?|user info(?:rmation)?|user identity|operator|main user|portfolio|website url|public website|public url)\b/i.test(normalized);

  return hasMemoryVerb && hasMemoryDestination;
}

function looksLikeLiveSingleShotWebTask(task: string): boolean {
  const normalized = task.trim().toLowerCase();
  if (!normalized) return false;

  const liveLookup = /\b(news|headlines?|weather|forecast|live score|scores?|lottery|lotto|eurojackpot|stock quote|stock price|exchange rate|fx rate|breaking news|aktuelle nachrichten|schlagzeilen|wetter|gewinnzahlen|b[öo]rsen|aktienkurs)\b/i.test(normalized);
  const browserWorkflow = /\b(browser|website|web\s?site|webseite|page|url|screenshot|snapshot|login|sign[ -]?in|form|click|navigate|open\s+the\s+website|capture\s+a\s+page|prüf(?:e|en)?[\s,]+ob\s+ich\s+neue\s+nachrichten|pruef(?:e|en)?[\s,]+ob\s+ich\s+neue\s+nachrichten)\b|\b[a-z0-9-]+\.(?:com|de|org|net|io|ai)\b/i.test(normalized);

  return liveLookup || browserWorkflow;
}

function resolveExplicitDelegationAgentOverride(request: DelegationRequest, ctx: ToolContext): string | null {
  const requested = request.agentName?.trim();
  if (requested !== "web_task_coordinator") return null;
  if (looksLikeLiveSingleShotWebTask(request.routingQuery ?? request.task)) return null;

  const task = request.routingQuery ?? request.task;
  const signals = analyzeHeuristicRoutingQuery(task);
  const looksProductVerification = /\b(datasheet|spec(?:s|ification)?|pricing|price|availability|distributors?|mouser|digikey|farnell|tme|component|components?|parts?|module|modules?|evaluation board|known issues?|reviews?|improvements?|product suggestions?|component recommendations?)\b/i.test(task);
  const candidates = [
    (signals.prefersPlanner || signals.looksSourceGroundedDocumentWorkflow || signals.looksMultiStageEvidenceWorkflow || looksProductVerification)
      ? "mission_coordinator"
      : null,
    (signals.looksResearchTask || signals.looksSourceHeavy || looksProductVerification)
      ? "researcher"
      : null,
  ].filter((value): value is string => Boolean(value));

  const validation = sanitizeDelegationAgentList(candidates, ctx);
  return validation.valid.find((name) => name !== requested) ?? null;
}

function getPinnedAgentForTask(task: string): string | null {
  if (looksLikeDurableMemoryTask(task)) {
    return "productivity_agent";
  }
  const signals = analyzeHeuristicRoutingQuery(task);
  if (signals.looksServerAdmin) {
    return signals.looksServiceTroubleshooting ? "ops_triage" : "shell_agent";
  }
  if (signals.looksComputerUse) {
    return "computer_use_agent";
  }
  return null;
}

function resolvePinnedDelegationAgent(task: string, ctx: ToolContext): string | null {
  const pinned = getPinnedAgentForTask(task);
  if (!pinned) return null;
  const validation = sanitizeDelegationAgentList([pinned], ctx);
  return validation.valid[0] ?? null;
}

function buildCoordinatorMatchedTerms(signals: HeuristicRoutingSignals): string[] {
  return [
    "web",
    "research",
    ...(signals.looksBroad ? ["guide"] : []),
  ];
}

function buildMissionCoordinatorMatchedTerms(signals: HeuristicRoutingSignals): string[] {
  return [
    "coordination",
    "parallel",
    ...(signals.looksDocumentDeliverable ? ["report"] : []),
    ...(signals.looksSequential ? ["dependencies"] : []),
    ...(signals.looksVisualization ? ["visualization"] : []),
    ...(signals.looksDataHeavy ? ["analysis"] : []),
    ...(signals.looksExternalData ? ["research"] : []),
    ...(signals.looksSynthesisHeavy ? ["synthesis"] : []),
    "quality",
  ];
}

function buildPlannerMatchedTerms(signals: HeuristicRoutingSignals): string[] {
  return [
    "planning",
    "workflow",
    ...(signals.looksSequential ? ["dependencies"] : []),
    ...(signals.looksBroad ? ["roadmap"] : []),
    ...(signals.looksSynthesisHeavy ? ["coordination"] : []),
  ];
}

function buildChartDesignerMatchedTerms(signals: HeuristicRoutingSignals): string[] {
  return [
    ...(signals.looksGroundedInput ? ["verified"] : []),
    ...(signals.looksVisualization ? ["chart"] : []),
    ...(signals.looksDataHeavy ? ["data"] : []),
    "artifact",
  ];
}

function shouldPreferWebTaskCoordinator(query: string, ctx: ToolContext, exclude: string[]): boolean {
  const signals = analyzeHeuristicRoutingQuery(query);
  if (!(signals.looksWebTask || signals.looksSourceHeavy || signals.looksFresh)) {
    return false;
  }

  if (signals.looksBrowserLoginTask) {
    return false;
  }

  if (signals.looksSourceGroundedDocumentWorkflow) {
    return false;
  }

  if (signals.looksMultiStageEvidenceWorkflow && !signals.looksWebTask) {
    return false;
  }

  if (exclude.includes("web_task_coordinator")) {
    return false;
  }

  if (ctx.allowedAgents && !ctx.allowedAgents.includes("web_task_coordinator")) {
    return false;
  }

  return Boolean(getConfig().subAgents["web_task_coordinator"]);
}

function shouldPreferProjectPlanner(query: string, ctx: ToolContext, exclude: string[]): boolean {
  const signals = analyzeHeuristicRoutingQuery(query);
  if (!signals.prefersPlanner) {
    return false;
  }

  if (exclude.includes("project_planner")) {
    return false;
  }

  if (ctx.allowedAgents && !ctx.allowedAgents.includes("project_planner")) {
    return false;
  }

  const planner = getConfig().subAgents["project_planner"];
  if (!planner) {
    return false;
  }

  const tools = planner.tools ?? [];
  return tools.includes("delegate_to_agent") || tools.includes("swarm_delegate") || tools.includes("parallel_delegate") || tools.includes("run_task_graph");
}

function shouldPreferMissionCoordinator(query: string, ctx: ToolContext, exclude: string[]): boolean {
  const signals = analyzeHeuristicRoutingQuery(query);

  if (!(signals.prefersPlanner || signals.looksSourceGroundedDocumentWorkflow)) {
    return false;
  }

  if (signals.looksRenderFromProvidedData) {
    return false;
  }

  if (
    signals.looksGroundedInput
    && signals.looksDocumentDeliverable
    && !signals.looksWebTask
    && !signals.looksFresh
    && !signals.looksExternalData
  ) {
    return false;
  }

  if (exclude.includes("mission_coordinator")) {
    return false;
  }

  if (ctx.allowedAgents && !ctx.allowedAgents.includes("mission_coordinator")) {
    return false;
  }

  const coordinator = getConfig().subAgents["mission_coordinator"];
  if (!coordinator) {
    return false;
  }

  const tools = coordinator.tools ?? [];
  return tools.includes("delegate_to_agent") || tools.includes("swarm_delegate") || tools.includes("parallel_delegate") || tools.includes("run_task_graph");
}

export interface AgentRoutingCandidate {
  name: string;
  description: string;
  model: string;
  confidence: "high" | "medium" | "low";
  score: number;
  matchedTerms: string[];
  capabilities: string[];
  tags: string[];
  /** Performance and cost profile derived from recent outcome log entries. */
  costProfile?: AgentCostProfile;
  /** GPU/compute resource requirements declared by the agent (Stage 9). */
  computeProfile?: { gpuPreferred: boolean; gpuTier: string; minVramMb: number };
}

export interface AgentRoutingResolution {
  query: string;
  minConfidence: "high" | "medium" | "low";
  mode: "keyword" | "hybrid";
  results: AgentRoutingCandidate[];
  weakCandidates: AgentRoutingCandidate[];
  gated: boolean;
  /** Agents excluded because their circuit breaker is open (too many recent failures). */
  trippedAgents: string[];
  /** True when every result is only "low" confidence — consider ephemeral agent or user clarification. */
  allLowConfidence: boolean;
  /** Agents explicitly excluded from this routing pass, such as the invoking coordinator. */
  excludedAgents?: string[];
}

interface RoutingSelectionReason {
  confidence: "high" | "medium" | "low";
  matchedTerms: string[];
  score: number;
}

export function computeHybridRoutingScore(
  keywordScore: number,
  semanticScore: number,
  semanticSearchAvailable: boolean,
): number {
  if (semanticSearchAvailable) {
    return semanticScore >= SEMANTIC_AGENT_ROUTING_MIN_SCORE ? semanticScore : 0;
  }
  if (keywordScore > 0 && semanticScore > 0) {
    return keywordScore * 0.25 + semanticScore * 0.75;
  }
  if (semanticScore > 0) {
    return semanticScore;
  }
  if (semanticSearchAvailable && keywordScore > 0) {
    return keywordScore * 0.65;
  }
  return keywordScore;
}

function toCandidate(
  name: string,
  cfg: NonNullable<ReturnType<typeof getConfig>["subAgents"][string]>,
  score: number,
  matchedTerms: string[],
  defaultModel: string,
  workspacePath: string,
): AgentRoutingCandidate {
  return {
    name,
    description: cfg.description,
    model: cfg.model?.primary ?? defaultModel,
    confidence: confidenceLabel(score),
    score,
    matchedTerms,
    capabilities: cfg.capabilities ?? [],
    tags: cfg.tags ?? [],
    costProfile: computeAgentCostProfile(name, workspacePath) ?? undefined,
    computeProfile: cfg.compute ? {
      gpuPreferred: cfg.compute.gpuPreferred ?? false,
      gpuTier: cfg.compute.gpuTier ?? "none",
      minVramMb: cfg.compute.minVramMb ?? 0,
    } : undefined,
  };
}

function compareRoutingResults(
  left: { combinedScore: number; matchedTerms: string[]; name: string },
  right: { combinedScore: number; matchedTerms: string[]; name: string },
): number {
  if (right.combinedScore !== left.combinedScore) {
    return right.combinedScore - left.combinedScore;
  }
  if (right.matchedTerms.length !== left.matchedTerms.length) {
    return right.matchedTerms.length - left.matchedTerms.length;
  }
  return left.name.localeCompare(right.name);
}

function looksLikeNavigationSpecialist(cfg: { description: string; capabilities?: string[]; tags?: string[] }): boolean {
  const combined = `${cfg.description} ${(cfg.capabilities ?? []).join(" ")} ${(cfg.tags ?? []).join(" ")}`.toLowerCase();
  return /(navigation|distance|travel time|travel|fahrzeit|reisezeit|entfernung|route planning|\broute\b)/.test(combined);
}

// Circuit breaker: if an agent fails ≥60% of its last 10 calls (min 3 samples),
// its circuit is "open" and it is excluded from routing until outcomes improve.
const CIRCUIT_LOOKBACK = 10;
const CIRCUIT_MIN_SAMPLES = 3;
const CIRCUIT_FAILURE_THRESHOLD = 0.60;

export function isCircuitOpen(agentName: string, workspacePath: string): boolean {
  const outcomes = readRecentOutcomes(workspacePath, 50);
  const recent = outcomes.filter(o => o.agent === agentName).slice(-CIRCUIT_LOOKBACK);
  if (recent.length < CIRCUIT_MIN_SAMPLES) return false;
  const failures = recent.filter(o => o.outcome === "failure").length;
  return failures / recent.length > CIRCUIT_FAILURE_THRESHOLD;
}

/**
 * Returns a small reputation boost/penalty based on recent agent outcomes.
 * Range: approximately [-0.125, +0.125]. Returns 0 when no history exists.
 */
function computeOutcomeBoost(agentName: string, workspacePath: string): number {
  const outcomes = readRecentOutcomes(workspacePath, 50);
  const relevant = outcomes.filter(o => o.agent === agentName);
  if (relevant.length === 0) return 0;
  const successRate =
    (relevant.filter(o => o.outcome === "success").length +
     relevant.filter(o => o.outcome === "partial").length * 0.5) /
    relevant.length;
  // Neutral (0.5 win rate) → 0, perfect → +0.125, all failures → -0.125
  return (successRate - 0.5) * 0.25;
}

/**
 * Compute a GPU-affinity score adjustment for an agent.
 *
 * Rules (Stage 9 GPU-aware routing):
 *   - If the agent declares gpuTier "none" and the query contains compute-heavy
 *     terms, it gets a small negative adjustment to yield to GPU-capable peers.
 *   - If the agent declares gpuPreferred: true and the query looks compute-heavy,
 *     it gets a small positive boost.
 *   - If an agent declares a minVramMb > 0, that metadata is surfaced in search
 *     results so operators know the requirement (routing cannot enforce VRAM at
 *     runtime without hardware introspection — see ROADMAP Stage 9).
 */
const GPU_HEAVY_QUERY_TERMS = [
  "embed", "embedding", "transcribe", "speech", "audio", "image", "generate image",
  "vision", "ocr", "stable diffusion", "whisper", "llava", "gpu", "cuda", "vram",
  "neural", "inference", "model weights", "fine-tune", "fine tune",
];

function computeGpuAffinityAdjustment(
  query: string,
  cfg: { compute?: { gpuPreferred?: boolean; gpuTier?: string } | null },
  poolHasGpuAgents: boolean,
): number {
  const lq = query.toLowerCase();
  const isComputeHeavy = GPU_HEAVY_QUERY_TERMS.some(t => lq.includes(t));
  if (!isComputeHeavy) return 0;

  const gpuTier = cfg.compute?.gpuTier ?? "none";
  if (cfg.compute?.gpuPreferred && gpuTier !== "none") return 0.06; // prefer GPU-capable agents
  // Only penalize non-GPU agents when there is at least one GPU-capable peer —
  // otherwise the penalty lowers everyone's score equally and pushes the router
  // toward ephemeral agent generation unnecessarily.
  if (gpuTier === "none" && poolHasGpuAgents) return -0.04;
  return 0;
}

export async function resolveAgentRouting(
  query: string,
  opts?: {
    minConfidence?: "high" | "medium" | "low";
    allowedAgents?: string[];
    excludeAgents?: string[];
  },
): Promise<AgentRoutingResolution> {
  const raw = query.trim();
  const vulnerabilityResearchIntent = /\b(cve|cvss|vulnerability|vulnerabilities|advisory|advisories|exploit(?:-db)?|nvd|patch(?:es| status)?|threat intelligence)\b/i.test(raw);
  const minConfidence = opts?.minConfidence ?? "medium";
  // The qualification floor is computed AFTER we know whether semantic
  // search produced results (see further down), since the floor depends
  // on which scoring mode is in use.  Keep it as `let` here so the
  // post-rerank gate can read the resolved value.
  let minScore = Math.max(confidenceThreshold(minConfidence), SEMANTIC_AGENT_ROUTING_MIN_SCORE);
  const config = getConfig();
  // Merge promoted agents — they are visible to routing but don't override
  // permanent config entries.
  const promotedAgents = readPromotedAgents(config.workspacePath);
  const promotedEntries = Object.entries(promotedAgents).filter(
    ([name]) => !config.subAgents[name],
  );
  let entries = [...Object.entries(config.subAgents), ...promotedEntries];
  if (opts?.allowedAgents) {
    entries = entries.filter(([name]) => opts.allowedAgents!.includes(name));
  }
  if (opts?.excludeAgents?.length) {
    const excludedAgents = new Set(opts.excludeAgents);
    entries = entries.filter(([name]) => !excludedAgents.has(name));
  }
  const availableEntries = new Map(entries);

  // Filter out agents whose circuit breaker is open
  const trippedAgents: string[] = entries
    .filter(([name]) => isCircuitOpen(name, config.workspacePath))
    .map(([name]) => name);
  if (trippedAgents.length > 0) {
    entries = entries.filter(([name]) => !trippedAgents.includes(name));
  }

  const semanticScores = new Map<string, number>();
  let usedSemanticSearch = false;

  if (isEmbeddingAvailable()) {
    try {
      const provider = getEmbeddingProvider();
      const results = await searchByEmbedding(raw, provider, 8);
      for (const result of results) {
        if (opts?.allowedAgents && !opts.allowedAgents.includes(result.agentName)) continue;
        semanticScores.set(result.agentName, Math.max(0, (result.score + 1) / 2));
      }
      usedSemanticSearch = semanticScores.size > 0;
    } catch {
      // fallback to keyword-only ranking
    }
  }

  // Resolve the qualification floor now that we know which scoring mode
  // is active.  Keyword-only scores are aggressively normalized down by
  // scoreAgentKeywordMatch (per-token-then-coverage-then-clamp) and rarely
  // cross 0.72 even for unambiguous specialist matches; using the
  // semantic floor in that mode silently drops legitimate candidates.
  // At keyword mode we honor the requested confidence label verbatim:
  //   high   → 0.72  (only confident keyword matches qualify)
  //   medium → 0.45  (specialist matches with one or two keyword hits)
  //   low    → 0     (anything with score > 0 surfaces — useful when the
  //                   caller is doing its own re-rank or mining the long
  //                   tail for capability-gap detection)
  if (!usedSemanticSearch) {
    minScore = confidenceThreshold(minConfidence);
  }

  // Pre-compute whether any agent in the pool declares GPU capability, so the
  // GPU-affinity penalty is only applied when a GPU-capable peer actually exists.
  const poolHasGpuAgents = entries.some(([, cfg]) => cfg.compute?.gpuPreferred && (cfg.compute?.gpuTier ?? "none") !== "none");
  // G32: Task-class keywords for outcome-weighted routing multiplier
  const queryKeywords = extractTaskKeywords(raw);

  const positiveNavigationIntent = isNavigationRoutingRequest(raw);

  let ranked = entries
    .map(([name, cfg]) => {
      const keywordMatch = usedSemanticSearch ? { score: 0, matchedTerms: [] } : scoreAgentKeywordMatch(raw, name, cfg);
      const semanticScore = semanticScores.get(name) ?? 0;
      const combinedScore = computeHybridRoutingScore(keywordMatch.score, semanticScore, usedSemanticSearch);

      const outcomeBoost = usedSemanticSearch ? 0 : computeOutcomeBoost(name, config.workspacePath);
      const intentReinforcement = usedSemanticSearch ? 0 : computeAgentIntentAdjustment(raw, cfg, [
        ...keywordMatch.matchedTerms,
        ...(cfg.capabilities ?? []),
        ...(cfg.tags ?? []),
      ]) * 0.25;
      const taskShapeAdjustment = usedSemanticSearch ? 0 : computeAgentTaskShapeAdjustment(raw, cfg);
      const gpuAdjustment = usedSemanticSearch ? 0 : computeGpuAffinityAdjustment(raw, cfg, poolHasGpuAgents);
      // G32: Multiply by historical outcome weight (±20% max, requires ≥25 samples)
      const outcomeMultiplier = usedSemanticSearch ? 1 : computeOutcomeRoutingMultiplier(name, queryKeywords, config.workspacePath);
      const boostedScore = Math.max(0, Math.min(1, (combinedScore + outcomeBoost + intentReinforcement + taskShapeAdjustment + gpuAdjustment) * outcomeMultiplier));
      return {
        name,
        cfg,
        matchedTerms: keywordMatch.matchedTerms,
        combinedScore: boostedScore,
      };
    })
    .filter((result) => result.combinedScore > 0)
    .filter((result) => positiveNavigationIntent || !looksLikeNavigationSpecialist(result.cfg))
    .sort(compareRoutingResults)
    .slice(0, 5);

  const rerankScores = await rerankCandidates(
    raw,
    ranked.map((result) => ({
      id: result.name,
      title: result.name,
      content: [
        result.cfg.description,
        `Capabilities: ${(result.cfg.capabilities ?? []).join(", ")}`,
        `Tags: ${(result.cfg.tags ?? []).join(", ")}`,
        `Tools: ${(result.cfg.tools ?? []).join(", ")}`,
      ].filter(Boolean).join("\n"),
    })),
  );

  if (rerankScores) {
    ranked = ranked
      .map((result) => {
        const rerankScore = rerankScores.get(result.name);
        if (rerankScore === undefined) return result;
        return {
          ...result,
          combinedScore: Math.max(0, Math.min(1, result.combinedScore * 0.7 + rerankScore * 0.3)),
        };
      })
      .sort(compareRoutingResults);
  }

  if (vulnerabilityResearchIntent) {
    ranked = ranked
      .map((result) => {
        if (!looksLikeNavigationSpecialist(result.cfg) || result.matchedTerms.length > 0) {
          return result;
        }
        return {
          ...result,
          combinedScore: Math.min(result.combinedScore, 0.2),
        };
      })
      .sort(compareRoutingResults);
  }

  const preferenceSignals = analyzeHeuristicRoutingQuery(raw);
  // Workflow / automation / n8n / webhook-design queries are
  // workflow_designer's primary scope.  Without an explicit signal here,
  // queries like "design an n8n workflow" or "create an automation
  // pipeline" get pulled by project_planner ("design"/"create" + the
  // generic plan-shape match) or mission_coordinator (multi-stage feel).
  const looksWorkflowDesign = /\b(n8n|webhook|webhooks|workflow|workflows|automation|automatisierung|integration|integrations|integrieren?)\b/i.test(raw)
    && /\b(design|designed|build|create|automate|automates|automating|wire|wiring|connect|connects|trigger|triggers|generate|generates|architecture)\b/i.test(raw);
  // Evidence authorship: writing a paper / report / brief from already-
  // collected notes / citations / sources.  This is paper_author's scope,
  // not mission_coordinator's — the user has already done the gathering,
  // so a multi-stage workflow is wrong.  Triggers on (write|draft|author|
  // compose|prepare) + (paper|report|brief|review|article) + a grounded-
  // input phrase (collected|provided|given|attached|verified|existing|...).
  const looksEvidenceAuthoring = /\b(write|draft|author|compose|prepare)\b/i.test(raw)
    && /\b(paper|papers|report|reports|brief|briefs|review|article|articles)\b/i.test(raw)
    // Require an EXPLICIT grounded marker — the gathering is already done.
    // "from the collected notes", "using the existing evidence", "based on
    // the provided citations" all qualify.  "current sources" / "with
    // citations" alone do NOT (those imply the user wants the agent to
    // gather first, which is mission_coordinator's territory).
    && /\b(collected|provided|given|attached|verified|existing|saved|prior|earlier)\b/i.test(raw)
    && /\b(notes|citations?|evidence|findings|sources|data|material|materials|research)\b/i.test(raw);
  // Documentation / release-notes / spec / reference lookups are
  // researcher's primary scope.  Without this heuristic, queries with
  // "latest" + "release notes" pull web_task_coordinator via the
  // freshnessNewsIntent boost even though they're documentation tasks,
  // and pure "find official documentation" queries fall to incidental
  // matchers (prompt_optimizer, channel_operator) because researcher's
  // raw keyword score doesn't beat them in keyword-only mode.
  const looksDocumentationLookup = /\b(find|search|look\s*up|lookup|get|locate|fetch|gather)\b/i.test(raw)
    && /\b(official\s+documentation|official\s+docs|api\s+docs?|api\s+documentation|api\s+reference|release\s+notes|specifications?|spec|specs|reference\s+(?:for|on)|documentation\s+for|docs\s+for)\b/i.test(raw);
  // Single-shot code + data analysis (e.g. "create a Python script that
  // reads a CSV and computes averages") is data_analyst / coder territory,
  // not mission_coordinator's.  Suppresses the multi-stage workflow
  // preference when the query is clearly one-shot specialist work.
  const looksSingleShotCodeData = /\b(create|write|build|implement|generate)\b/i.test(raw)
    && /\b(python|typescript|javascript|node|bash|go|rust|sql|script|function|program|module|class|notebook)\b/i.test(raw)
    && /\b(csv|json|spreadsheet|xlsx|tsv|excel|dataframe|pandas|sql\s+table)\b/i.test(raw)
    && !/\b(first|then|after|workflow|pipeline\s+that|multi-step|step\s+by\s+step|orchestrate)\b/i.test(raw);
  // Image / screenshot / document analysis is media_analyst's scope —
  // not browser_agent (which is interactive web work) and not data_analyst
  // (tabular).  Triggers on direct "analyse this X" or "extract from X"
  // shapes where X is an image/screenshot/PDF/document.
  const looksMediaAnalysis = (
    /\b(analy[sz]e|analy[sz]ing|inspect|interpret|describe|recognize|recognise|read|extract)\b/i.test(raw)
    && /\b(screenshot|screenshots|image|images|picture|pictures|photo|photos|bild|bilder|screen\s?cap|pdf|pdfs|document|documents|dokument|dokumente|chart|charts|diagram|diagrams)\b/i.test(raw)
  ) || /\b(extract\s+(?:the\s+)?(?:text|content)\s+from|ocr|optical\s+character\s+recognition)\b/i.test(raw);
  // Freshness lookups owned by web_task_coordinator: news, weather, live
  // scores, lottery results, stock quotes — anything that's a one-shot
  // current-state query (vs. a sourced/citation-grade research task,
  // which goes to researcher).  Includes German equivalents so DE
  // queries route the same way as EN ones.
  const looksNewsTask = /\b(news|updates?|headlines|breaking|nachrichten|neuigkeiten|meldungen|trends|schlagzeilen|weather|wetter|forecast|vorhersage|score|scores|spielstand|live|ergebnisse|lottery|lotto|jackpot|eurojackpot|stocks?|aktien|b[oö]rse|markets?)\b/i.test(raw);
  // `screenshot` / `snapshot` alone (without a browser/page/url context)
  // is media_analyst's territory ("analyse this screenshot") — don't
  // pull browser_agent in just because the query mentions a screenshot.
  const looksBrowserEvidenceTask = /\b(browser|website|web\s?site|webseite|page|url|playwright|open\s+the\s+website|capture\s+a\s+page)\b/i.test(raw)
    || (/\b(screenshot|snapshot)\b/i.test(raw)
        && /\b(browser|website|page|url|portal|dashboard|playwright|navigate|capture\s+a\s+page|of\s+the\s+(?:website|page|portal|dashboard))\b/i.test(raw));
  const sourceGroundedDocumentWorkflowInSearch = preferenceSignals.looksSourceGroundedDocumentWorkflow
    && !(preferenceSignals.looksGroundedInput
      && !preferenceSignals.looksFresh
      && !preferenceSignals.looksExternalData
      && !preferenceSignals.looksWebTask);
  const preferMissionInSearch = preferenceSignals.looksMultiStageEvidenceWorkflow
    || sourceGroundedDocumentWorkflowInSearch
    || (preferenceSignals.looksSequential
      && (preferenceSignals.looksVisualization || preferenceSignals.looksExternalData || preferenceSignals.looksSourceHeavy || preferenceSignals.looksDataHeavy));
  const preferWebCoordinatorInSearch = !preferenceSignals.looksMultiStageEvidenceWorkflow
    && !sourceGroundedDocumentWorkflowInSearch
    && !preferenceSignals.looksBrowserLoginTask
    && !preferenceSignals.looksDataHeavy
    && !preferenceSignals.looksVisualization
    && !preferenceSignals.looksDocumentDeliverable
    // Source-heavy queries (release notes, official documentation, specs,
    // citations, references) are researcher's territory.  When the query
    // looks source-heavy AND has no real "freshness" or "web task"
    // signal, drop the wtc preference so researcher wins on its keyword
    // strength rather than getting bumped to second place by the
    // preferredNames re-sort.
    && (preferenceSignals.looksWebTask
      || (preferenceSignals.looksFresh && !preferenceSignals.looksSourceHeavy));
  const preferProjectPlannerInSearch = preferenceSignals.prefersPlanner
    && !preferMissionInSearch
    && !preferenceSignals.looksSourceHeavy
    && !preferenceSignals.looksFresh
    && !preferenceSignals.looksExternalData
    && !preferenceSignals.looksVisualization
    && !preferenceSignals.looksDataHeavy;
  const preferredNames = [
    preferenceSignals.looksServerAdmin
      ? (preferenceSignals.looksServiceTroubleshooting ? "ops_triage" : "shell_agent")
      : null,
    vulnerabilityResearchIntent ? "security_researcher" : null,
    positiveNavigationIntent ? "distance_specialist" : null,
    preferenceSignals.looksComputerUse ? "computer_use_agent" : null,
    looksBrowserEvidenceTask && !preferMissionInSearch ? "browser_agent" : null,
    preferenceSignals.looksBrowserLoginTask ? "browser_agent" : null,
    preferenceSignals.looksRenderFromProvidedData ? "chart_designer" : null,
    // Suppress mission_coordinator when the query is paper_author's
    // (writing from already-collected notes / citations) or a one-shot
    // code+data task (data_analyst / coder territory) — the multi-stage
    // workflow shape is wrong for both.
    (preferMissionInSearch && !looksEvidenceAuthoring && !looksSingleShotCodeData) ? "mission_coordinator" : null,
    looksEvidenceAuthoring ? "paper_author" : null,
    looksSingleShotCodeData ? "data_analyst" : null,
    // Documentation / release-notes / spec lookups are researcher's primary
    // scope — pre-empt wtc and prompt_optimizer for these queries.
    looksDocumentationLookup ? "researcher" : null,
    // Workflow_designer first when n8n/webhook/automation-design shape
    // hits — keeps project_planner from grabbing "design an n8n workflow"
    // or "create an automation pipeline" via the generic plan-shape match.
    looksWorkflowDesign ? "workflow_designer" : null,
    looksMediaAnalysis ? "media_analyst" : null,
    // Either signal is enough to put wtc above researcher in the
    // preferredNames bump.  looksNewsTask covers freshness lookups
    // (weather, scores, lottery, breaking) where wtc is the actual
    // owner; researcher stays the fallback if wtc isn't in the catalog.
    (preferWebCoordinatorInSearch || looksNewsTask) ? "web_task_coordinator" : null,
    (preferWebCoordinatorInSearch || looksNewsTask) ? "researcher" : null,
    // Suppress project_planner when the query is workflow_designer's —
    // "design an n8n workflow" hits prefersPlanner via "design" but
    // belongs to workflow_designer.
    (preferProjectPlannerInSearch && !looksWorkflowDesign) ? "project_planner" : null,
  ].filter((value): value is string => Boolean(value));

  const maybeAppendHeuristicCandidate = (name: string, score: number, matchedTerms: string[]) => {
    const existing = ranked.find((candidate) => candidate.name === name);
    if (existing) {
      // Boost existing candidate if heuristic score is higher
      if (score > existing.combinedScore) {
        existing.combinedScore = score;
        existing.matchedTerms = [...new Set([...existing.matchedTerms, ...matchedTerms])];
      }
      return;
    }
    const cfg = availableEntries.get(name);
    if (!cfg) {
      return;
    }
    ranked.push({
      name,
      cfg,
      matchedTerms,
      combinedScore: score,
    });
  };

  if (preferenceSignals.looksServerAdmin) {
    maybeAppendHeuristicCandidate(
      preferenceSignals.looksServiceTroubleshooting ? "ops_triage" : "shell_agent",
      0.78,
      preferenceSignals.looksServiceTroubleshooting
        ? ["server", "ops", "logs", "containers"]
        : ["server", "ssh", "shell", "docker"],
    );
  }
  if (vulnerabilityResearchIntent) {
    maybeAppendHeuristicCandidate("security_researcher", 0.82, ["security", "cve", "vulnerability"]);
  }
  if (positiveNavigationIntent) {
    maybeAppendHeuristicCandidate("distance_specialist", 0.82, ["navigation", "distance", "travel time"]);
  }
  if (preferenceSignals.looksComputerUse) {
    maybeAppendHeuristicCandidate("computer_use_agent", 0.75, ["computer", "desktop", "automation"]);
  }
  if (looksBrowserEvidenceTask && !preferMissionInSearch) {
    maybeAppendHeuristicCandidate("browser_agent", 0.78, ["browser", "website", "snapshot"]);
  }
  if (preferenceSignals.looksBrowserLoginTask) {
    maybeAppendHeuristicCandidate("browser_agent", 0.8, ["browser", "login", "form", "credentials"]);
  }
  if (preferenceSignals.looksRenderFromProvidedData) {
    maybeAppendHeuristicCandidate("chart_designer", 0.72, buildChartDesignerMatchedTerms(preferenceSignals));
  }
  if (preferMissionInSearch) {
    maybeAppendHeuristicCandidate("mission_coordinator", 0.72, buildMissionCoordinatorMatchedTerms(preferenceSignals));
  }
  if (preferWebCoordinatorInSearch) {
    maybeAppendHeuristicCandidate("web_task_coordinator", 0.72, buildCoordinatorMatchedTerms(preferenceSignals));
    maybeAppendHeuristicCandidate("researcher", 0.72, ["research", "sources", "web"]);
  }
  if (looksNewsTask) {
    // Freshness/news queries are web_task_coordinator's primary scope —
    // bump its heuristic score clearly above the routing floor so an
    // operator's `skillMatchThreshold: 0.75` recognizes it as a strong
    // catalog match.  researcher stays at 0.72 (the floor) so it shows up
    // as a fallback candidate but doesn't bypass strict thresholds when
    // it's the only candidate (in which case ephemeral spawn is preferred).
    maybeAppendHeuristicCandidate("web_task_coordinator", 0.82, ["web", "news", "research"]);
    maybeAppendHeuristicCandidate("researcher", 0.72, ["research", "news", "sources"]);
  }
  if (preferProjectPlannerInSearch && !looksWorkflowDesign) {
    maybeAppendHeuristicCandidate("project_planner", 0.72, buildPlannerMatchedTerms(preferenceSignals));
  }
  if (looksWorkflowDesign) {
    maybeAppendHeuristicCandidate("workflow_designer", 0.82, ["n8n", "workflow", "automation", "webhook"]);
  }
  if (looksMediaAnalysis) {
    maybeAppendHeuristicCandidate("media_analyst", 0.82, ["image", "media", "extract", "analyse", "screenshot"]);
  }
  if (looksEvidenceAuthoring) {
    maybeAppendHeuristicCandidate("paper_author", 0.85, ["paper", "evidence", "citations", "notes"]);
  }
  if (looksDocumentationLookup) {
    maybeAppendHeuristicCandidate("researcher", 0.85, ["documentation", "official", "spec", "research"]);
  }
  if (looksSingleShotCodeData) {
    maybeAppendHeuristicCandidate("data_analyst", 0.82, ["data", "csv", "python", "analysis"]);
  }

  ranked = ranked.sort(compareRoutingResults).slice(0, 5);

  for (const preferredName of preferredNames) {
    const preferredCandidate = ranked.find((candidate) => candidate.name === preferredName);
    if (!preferredCandidate) {
      continue;
    }
    ranked = [preferredCandidate, ...ranked.filter((candidate) => candidate.name !== preferredName)];
    break;
  }

  const gated = ranked.filter((result) => result.combinedScore >= minScore);
  const weakCandidates = ranked
    .filter((result) => result.combinedScore < minScore)
    .slice(0, 3)
    .map((result) => toCandidate(result.name, result.cfg, result.combinedScore, result.matchedTerms, config.agents.defaults.model.primary, config.workspacePath));

  const resolvedResults = gated.map((result) =>
    toCandidate(result.name, result.cfg, result.combinedScore, result.matchedTerms, config.agents.defaults.model.primary, config.workspacePath)
  );
  const allLowConfidence = resolvedResults.length > 0 && resolvedResults.every(r => r.confidence === "low");

  return {
    query: raw,
    minConfidence,
    mode: usedSemanticSearch ? "hybrid" : "keyword",
    results: resolvedResults,
    weakCandidates,
    gated: ranked.length > 0 && gated.length === 0,
    trippedAgents,
    allLowConfidence,
    excludedAgents: opts?.excludeAgents ? [...opts.excludeAgents] : undefined,
  };
}

function formatCostProfile(profile: AgentCostProfile): string {
  const tokenStr = profile.avgTokens > 0 ? `~${profile.avgTokens.toLocaleString()} tokens/run` : "";
  const iterStr = `~${profile.avgIterations} iter/run`;
  const rateStr = `${Math.round(profile.successRate * 100)}% success`;
  const parts = [rateStr, tokenStr, iterStr].filter(Boolean).join(" | ");
  return `\n  Stats (${profile.runs} runs): ${parts}`;
}

function formatRoutingCandidate(candidate: AgentRoutingCandidate): string {
  const matchLine = candidate.matchedTerms.length > 0
    ? `\n  Matches: ${candidate.matchedTerms.join(", ")}`
    : "";
  const capabilities = candidate.capabilities.length > 0
    ? `\n  Capabilities: ${candidate.capabilities.join(", ")}`
    : "";
  const costNote = candidate.costProfile ? formatCostProfile(candidate.costProfile) : "";
  const scorePct = `${Math.round(candidate.score * 100)}%`;
  return `**${candidate.name}** (${candidate.model})\n  ${candidate.description}\n  Confidence: ${candidate.confidence} (${scorePct} skill match)${capabilities}${matchLine}${costNote}`;
}

// ─── create_ephemeral_agent ───────────────────────────────────────────────────

// Tools the factory is allowed to grant to ephemeral agents (must exist in registry)
const GRANTABLE_TOOLS = new Set([
  "read_file", "list_files", "write_file", "edit_file", "create_dir", "delete_file",
  "memory_search", "memory_store", "record_lesson",
  "share_finding", "read_shared_facts",
  "parallel_delegate",
  "workspace_search",
  "web_search", "web_fetch",
  "shell_exec", "run_script",
  "mcp__playwright__browser_navigate", "mcp__playwright__browser_click",
  "mcp__playwright__browser_type", "mcp__playwright__browser_snapshot",
  "mcp__playwright__browser_screenshot",
  "mcp__code_sandbox__run_js", "mcp__code_sandbox__run_ts",
  "mcp__filesystem__read_file", "mcp__filesystem__list_directory",
  "computer_session_start", "computer_session_attach", "computer_session_stop",
  "computer_list_nodes", "computer_snapshot", "computer_click", "computer_type", "computer_hotkey",
  "computer_scroll", "computer_list_windows", "computer_focus_window",
  "computer_capture_region",
  "get_site_credentials", "site_fill_credentials", "computer_type_credential",
]);

const EXECUTION_TOOL_FAMILIES = {
  shell: new Set(["shell_exec", "run_script"]),
  browser: new Set([
    "mcp__playwright__browser_navigate",
    "mcp__playwright__browser_click",
    "mcp__playwright__browser_type",
    "mcp__playwright__browser_snapshot",
    "mcp__playwright__browser_screenshot",
  ]),
  code: new Set(["mcp__code_sandbox__run_js", "mcp__code_sandbox__run_ts"]),
  computer: new Set([
    "computer_session_start", "computer_click", "computer_type", "computer_type_credential",
    "computer_hotkey", "computer_scroll", "computer_focus_window",
  ]),
};

function validateEphemeralToolSelection(tools: string[], opts?: { allowZeroTools?: boolean }): string[] {
  const issues: string[] = [];

  if (tools.length === 0 && !opts?.allowZeroTools) {
    issues.push("Ephemeral agents must have at least one valid tool.");
  }

  const usesComputerTools = tools.some(t => EXECUTION_TOOL_FAMILIES.computer.has(t));
  const toolCap = usesComputerTools ? 10 : 6;

  if (tools.length > toolCap) {
    issues.push(`Ephemeral agents may grant at most ${toolCap} tools. Keep them narrowly specialized.`);
  }

  const privilegedTools = tools.filter((toolName) => getToolTier(toolName).tier >= ToolTier.TWO_EXECUTE);
  if (privilegedTools.length > 5) {
    issues.push(`Ephemeral agents may grant at most 5 execution-capable tools, got ${privilegedTools.length}.`);
  }

  const selectedFamilies = Object.entries(EXECUTION_TOOL_FAMILIES)
    .filter(([, familyTools]) => tools.some((toolName) => familyTools.has(toolName)))
    .map(([family]) => family);

  if (selectedFamilies.length > 1) {
    issues.push(`Ephemeral agents cannot mix multiple execution families (${selectedFamilies.join(", ")}). Split the mission into focused agents instead.`);
  }

  if (tools.includes("parallel_delegate") && privilegedTools.length > 1) {
    issues.push("Ephemeral coordinator agents using parallel_delegate cannot also hold additional execution-heavy tools.");
  }

  return issues;
}

interface DelegationRequest {
  agentName?: string;
  task: string;
  context?: string;
  fallbackAgents?: string[];
  routingQuery?: string;
  skillMatchThreshold?: number;
  taskId?: string;
  taskTitle?: string;
  dependsOn?: string[];
}

interface TaskGraphNodeInput {
  id: string;
  title?: string;
  agentName?: string;
  task: string;
  context?: string;
  dependsOn?: string[];
  fallbackAgents?: string[];
  routingQuery?: string;
  skillMatchThreshold?: number;
}

const DEFAULT_MAX_AGENT_CALLS_PER_TURN = 2;
const DEFAULT_MAX_TOTAL_DELEGATIONS_PER_TURN = 8;

function totalDelegationsThisTurn(ctx: ToolContext): number {
  return [...(ctx._turnAgentCounts?.values() ?? [])].reduce((sum, count) => sum + count, 0);
}

function getPerAgentDelegationLimit(ctx: ToolContext, agentName: string): number {
  const override = ctx._turnAgentRepeatLimitOverrides?.[agentName];
  return Math.max(DEFAULT_MAX_AGENT_CALLS_PER_TURN, override ?? DEFAULT_MAX_AGENT_CALLS_PER_TURN);
}

function getTotalDelegationLimit(ctx: ToolContext): number {
  return Math.max(DEFAULT_MAX_TOTAL_DELEGATIONS_PER_TURN, ctx._turnTotalDelegationLimitOverride ?? DEFAULT_MAX_TOTAL_DELEGATIONS_PER_TURN);
}

function withDelegationFanoutAllowance(ctx: ToolContext, agentNames: Array<string | undefined>, plannedDelegations: number): ToolContext {
  const counts = new Map<string, number>();
  for (const agentName of agentNames) {
    const normalized = agentName?.trim();
    if (!normalized) continue;
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  }

  const repeatOverrides: Record<string, number> = {
    ...(ctx._turnAgentRepeatLimitOverrides ?? {}),
  };

  let changed = false;
  for (const [agentName, count] of counts.entries()) {
    if (count <= DEFAULT_MAX_AGENT_CALLS_PER_TURN) continue;
    const nextLimit = Math.max(repeatOverrides[agentName] ?? DEFAULT_MAX_AGENT_CALLS_PER_TURN, count);
    if (repeatOverrides[agentName] !== nextLimit) {
      repeatOverrides[agentName] = nextLimit;
      changed = true;
    }
  }

  const nextTotalLimit = Math.max(
    ctx._turnTotalDelegationLimitOverride ?? DEFAULT_MAX_TOTAL_DELEGATIONS_PER_TURN,
    totalDelegationsThisTurn(ctx) + Math.max(1, plannedDelegations) + 1,
  );

  if (!changed && nextTotalLimit === (ctx._turnTotalDelegationLimitOverride ?? DEFAULT_MAX_TOTAL_DELEGATIONS_PER_TURN)) {
    return ctx;
  }

  return {
    ...ctx,
    _turnAgentRepeatLimitOverrides: repeatOverrides,
    _turnTotalDelegationLimitOverride: nextTotalLimit,
  };
}

interface ArchitectEphemeralSpec {
  agentName?: unknown;
  description?: unknown;
  systemPrompt?: unknown;
  tools?: unknown;
  maxIterations?: unknown;
  model?: unknown;
}

function getEphemeralGenerationSettings() {
  const config = getConfig();
  return config.agents.ephemeralGeneration;
}

function resolveSkillMatchThreshold(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override)) {
    return Math.max(0, Math.min(1, override));
  }
  return getEphemeralGenerationSettings().skillMatchThreshold;
}

function shouldGenerateEphemeralAgent(bestScore: number | undefined, threshold: number): boolean {
  return bestScore === undefined || bestScore < threshold;
}

function shouldPreferCatalogAgent(
  bestScore: number | undefined,
  bestConfidence: "high" | "medium" | "low" | undefined,
  threshold: number,
): boolean {
  // The operator's explicit `skillMatchThreshold` is the contract — even a
  // "high"-confidence keyword match must clear it before we skip the
  // ephemeral spawn.  Previously the fast-path returned true for ANY
  // high-confidence candidate, which let TOOL_KEYWORD_RULES-induced score
  // inflation (an agent with `web_search`/`web_fetch` automatically picks
  // up "news"/"current"/"latest"/"updates" into its keyword pool, pushing
  // its score to the 0.72 high-confidence floor) bypass thresholds > 0.72.
  // Concretely: a stub agent with description "Finds web documentation."
  // and one `web_search` tool was beating an explicit `0.75` threshold
  // for queries like "today top headlines current news", which suppressed
  // legitimate ephemeral-agent spawns.
  void bestConfidence; // retained on the signature for callers that pass it
  return !shouldGenerateEphemeralAgent(bestScore, threshold);
}

function extractFirstJsonObject(content: string): string {
  const start = content.indexOf("{");
  if (start === -1) {
    throw new SyntaxError("No JSON object found in architect response");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < content.length; index += 1) {
    const char = content[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return content.slice(start, index + 1);
      }
    }
  }

  throw new SyntaxError("Unterminated JSON object in architect response");
}

function parseArchitectSpec(content: string): ArchitectEphemeralSpec {
  const trimmed = content.trim();
  const jsonStr = extractFirstJsonObject(trimmed);
  return JSON.parse(jsonStr) as ArchitectEphemeralSpec;
}

function buildArchitectPrompt(task: string, previousContext?: string): string {
  const toolList = [...GRANTABLE_TOOLS].join(", ");
  const defaultModel = getConfig().agents.defaults.model.primary;
  return [
    "You are an agent architect. Design a minimal, focused ephemeral agent to complete the given task.",
    "Return valid JSON only. Do not include markdown fences or commentary.",
    "",
    `Available tools: ${toolList}`,
    `Default model: ${defaultModel}`,
    "",
    "Rules:",
    "- Choose at most 4 tools (up to 6 for computer-use tasks).",
    "- If the task can be completed purely from the provided task text and context, tools may be an empty array [].",
    "- Do NOT mix execution families: shell (shell_exec, run_script), browser (mcp__playwright__*), and code (mcp__code_sandbox__*) are separate families — pick at most one.",
    "- If the task requires fetching data from the web using browser tools (mcp__playwright__*), ALWAYS also include web_search so the agent can discover valid URLs before navigating. Never invent placeholder or example URLs.",
    "- Keep systemPrompt concise (under 200 words). State the role, key rules, and a tool budget.",
    "- maxIterations must be between 3 and 8 for non-computer tasks. For computer-use tasks (tools starting with computer_), use 10-15 iterations because each screen interaction needs snapshot+action+verify cycles.",
    "- For computer-use agents: include 'Do NOT call the same tool with identical arguments twice in a row' in the systemPrompt. The session is already started — begin with computer_list_windows, not computer_session_start.",
    "- Choose a model appropriate for the task. Use a single string model id in model.primary when you want to override the default.",
    "",
    "Schema:",
    "{",
    '  "agentName": "<snake_case_name>",',
    '  "description": "<one line>",',
    '  "systemPrompt": "<instructions>",',
    '  "tools": ["<tool1>", "<tool2>"],',
    '  "maxIterations": 5,',
    '  "model": { "primary": "<optional model id override>", "temperature": 0.1, "maxTokens": 6144 }',
    "}",
    "",
    `Task: ${task.slice(0, 1200)}`,
    ...(previousContext ? ["", "Context from previous attempts (use these real URLs and facts — do NOT invent placeholder URLs):", previousContext] : []),
  ].join("\n");
}

async function requestArchitectSpec(task: string, ctx: ToolContext, previousContext?: string): Promise<ArchitectEphemeralSpec | null> {
  const settings = getEphemeralGenerationSettings();
  const architectAgentName = settings.architectAgentName;
  const architectPrompt = buildArchitectPrompt(task, previousContext);

  try {
    const response = await runSubAgent({
      agentName: architectAgentName,
      task: architectPrompt,
      parentSessionId: ctx.sessionId,
      workspacePath: ctx.workspacePath,
      signal: ctx.signal,
      approvalCallback: ctx.approvalCallback,
      humanInLoopSteps: ctx.humanInLoopSteps,
      maxIterationsOverride: ctx.maxIterationsOverride,
      _workflowExecutionStack: ctx._workflowExecutionStack,
    });
    return parseArchitectSpec(response);
  } catch (error) {
    logAudit(
      "architect_fallback_failed",
      { reason: "architect_agent_error", architectAgentName, err: String(error) },
      { sessionId: ctx.sessionId, severity: "warn" },
    );
    return null;
  }
}

function normalizeArchitectModel(model: unknown): import("../config/schema.js").SubAgentConfig["model"] {
  if (!model) return undefined;
  if (typeof model === "string" && model.trim()) {
    return { primary: model.trim() };
  }
  if (typeof model !== "object") return undefined;
  const raw = model as Record<string, unknown>;
  const primary = typeof raw.primary === "string" && raw.primary.trim() ? raw.primary.trim() : undefined;
  const temperature = typeof raw.temperature === "number" ? raw.temperature : undefined;
  const maxTokens = typeof raw.maxTokens === "number" ? raw.maxTokens : undefined;
  if (!primary && temperature === undefined && maxTokens === undefined) return undefined;
  return {
    ...(primary ? { primary } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

function publishSwarmState(ctx: ToolContext): void {
  if (!ctx.swarmState || !ctx.onSwarmState) return;
  ctx.onSwarmState(structuredClone(ctx.swarmState));
}

function ensureSwarmState(ctx: ToolContext, objectiveHint: string): SwarmState {
  if (!ctx.swarmState) {
    const now = new Date().toISOString();
    ctx.swarmState = {
      objective: objectiveHint,
      startedAt: now,
      updatedAt: now,
      tasks: {},
    };
  }

  ctx.swarmState.updatedAt = new Date().toISOString();
  return ctx.swarmState;
}

function getOrCreateSwarmTask(ctx: ToolContext, taskId: string, title: string, dependsOn: string[] = [], signature?: string): SwarmTaskState {
  const swarmState = ensureSwarmState(ctx, title);
  swarmState.tasks[taskId] ??= {
    id: taskId,
    title,
    status: "pending",
    dependsOn: [...dependsOn],
    signature,
    attempts: [],
  };

  const task = swarmState.tasks[taskId]!;
  task.dependsOn = [...dependsOn];
  task.signature = signature ?? task.signature;
  publishSwarmState(ctx);
  return task;
}

function summarizeText(text: string, maxLength = 180): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength)}...` : compact;
}

/**
 * Resolve the per-task soft budgets from config.
 * Returns 0 for any disabled limit. Kept inline so config changes are picked up
 * each call without restart.
 */
function getTaskBudgets(): { tokens: number; toolCalls: number; durationMs: number } {
  const budgets = getConfig().agents.budgets;
  return {
    tokens: budgets?.maxTokensPerTask ?? 0,
    toolCalls: budgets?.maxToolCallsPerTask ?? 0,
    durationMs: budgets?.maxDurationMsPerTask ?? 0,
  };
}

/**
 * Finalize a SwarmTaskAttempt with duration, budget breach detection, and
 * task-level totals rollup. Always pair `attempt.startedAt` with this call so
 * `durationMs` is correct. Logs a `task_budget_exceeded` audit when caps trip.
 *
 * Idempotent — safe to call once per attempt at the point where finishedAt is set.
 */
function finalizeAttemptBudget(
  ctx: ToolContext,
  task: SwarmTaskState,
  attempt: SwarmTaskAttempt,
): void {
  if (!attempt.finishedAt) attempt.finishedAt = new Date().toISOString();
  const startedMs = Date.parse(attempt.startedAt);
  const finishedMs = Date.parse(attempt.finishedAt);
  if (Number.isFinite(startedMs) && Number.isFinite(finishedMs) && finishedMs >= startedMs) {
    attempt.durationMs = finishedMs - startedMs;
  }

  const budgets = getTaskBudgets();
  const breaches: string[] = [];
  if (budgets.tokens > 0 && (attempt.totalTokens ?? 0) > budgets.tokens) breaches.push("tokens");
  if (budgets.toolCalls > 0 && (attempt.toolCount ?? 0) > budgets.toolCalls) breaches.push("toolCalls");
  if (budgets.durationMs > 0 && (attempt.durationMs ?? 0) > budgets.durationMs) breaches.push("durationMs");
  if (breaches.length > 0) {
    attempt.budgetExceeded = true;
    attempt.budgetBreaches = breaches;
    logAudit(
      "task_budget_exceeded",
      {
        taskId: task.id,
        agentName: attempt.agentName,
        breaches,
        totalTokens: attempt.totalTokens ?? 0,
        toolCount: attempt.toolCount ?? 0,
        durationMs: attempt.durationMs ?? 0,
        limits: budgets,
      },
      { sessionId: ctx.sessionId, severity: "warn" },
    );
  }

  recomputeTaskTotals(task);
}

/** Recompute per-task rollup totals from its attempts. Called by finalizeAttemptBudget. */
function recomputeTaskTotals(task: SwarmTaskState): void {
  let toolCount = 0, iterations = 0, promptTokens = 0, completionTokens = 0, totalTokens = 0, durationMs = 0;
  for (const a of task.attempts) {
    toolCount += a.toolCount ?? 0;
    iterations += a.iterations ?? 0;
    promptTokens += a.promptTokens ?? 0;
    completionTokens += a.completionTokens ?? 0;
    totalTokens += a.totalTokens ?? 0;
    durationMs += a.durationMs ?? 0;
  }
  task.totals = {
    attempts: task.attempts.length,
    toolCount, iterations,
    promptTokens, completionTokens, totalTokens,
    durationMs,
  };
}

function buildTaskSignature(title: string, task: string, dependsOn: string[] = []): string {
  const normalizedTitle = summarizeText(title, 120).toLowerCase();
  const normalizedTask = summarizeText(task, 240).toLowerCase();
  const normalizedDeps = [...dependsOn].sort().join(",");
  return `${normalizedTitle}::${normalizedTask}::${normalizedDeps}`;
}

function findReusableSwarmTask(ctx: ToolContext, signature: string): SwarmTaskState | undefined {
  if (!ctx.swarmState) return undefined;
  return Object.values(ctx.swarmState.tasks).find((task) => task.signature === signature);
}

function allocateParallelTaskIds(ctx: ToolContext, count: number): string[] {
  if (count <= 0) return [];

  const existingTasks = ctx.swarmState ? Object.keys(ctx.swarmState.tasks) : [];
  const maxParallelIndex = existingTasks.reduce((maxIndex, taskId) => {
    const match = /^parallel_(\d+)$/.exec(taskId);
    if (!match) return maxIndex;
    const parsed = Number.parseInt(match[1] ?? "0", 10);
    return Number.isFinite(parsed) ? Math.max(maxIndex, parsed) : maxIndex;
  }, 0);

  return Array.from({ length: count }, (_value, index) => `parallel_${maxParallelIndex + index + 1}`);
}

function retryIntroducesNewAgent(
  request: Pick<DelegationRequest, "agentName" | "fallbackAgents">,
  attemptedAgents: string[],
): boolean {
  const retryCandidates = uniqueNames([
    request.agentName ?? "",
    ...(request.fallbackAgents ?? []),
  ]);
  if (retryCandidates.length === 0) {
    return false;
  }

  const attempted = new Set(attemptedAgents.filter(Boolean));
  return retryCandidates.some((candidate) => !attempted.has(candidate));
}

function isResearchLikeDelegation(
  candidate: string,
  task: string,
  routingQuery?: string,
  agentCfg?: { tools?: string[]; capabilities?: string[] },
): boolean {
  const text = `${routingQuery ?? ""}\n${task}`.toLowerCase();
  const tools = agentCfg?.tools ?? [];
  const capabilities = agentCfg?.capabilities ?? [];
  const researchAgentName = /(research|citation|librarian|evidence|source_verifier)/i.test(candidate);
  const researchTools = tools.includes("web_search") || tools.includes("web_fetch");
  const researchCapabilities = capabilities.some((capability) => /research|documentation|source|fact.?check|citation/i.test(capability));
  const sourceHeavyTask = /\b(research|recherche|recherchiere|find|gather|sammle|look for|source|sources|quelle|quellen|citation|citations|zitierfahig|zitierfaehig|reference|references|docs?|documentation|dokumentation|spec|specification|spezifikation|spezifikationen|official|publisher|publication|validate|validiere|protocol|protocols|protokoll|protokolle)\b/i.test(text);
  return sourceHeavyTask && (researchAgentName || researchTools || researchCapabilities);
}

function formatReusableSessionEvidenceOutput(
  title: string,
  factMatches: Array<{ key: string; value: string; score: number }>,
  partialMatches: Array<{ taskId: string; agentName: string; content: string; score: number }>,
): string {
  const factSection = factMatches.length > 0
    ? "## Shared facts already gathered\n" + factMatches
      .slice(0, 4)
      .map((match) => `- **${match.key}** (${Math.round(match.score * 100)}%): ${summarizeText(match.value, 280)}`)
      .join("\n")
    : "";
  const partialSection = partialMatches.length > 0
    ? "## Relevant prior partial results\n" + partialMatches
      .slice(0, 3)
      .map((match) => `### ${match.agentName} (${match.taskId}, ${Math.round(match.score * 100)}%)\n${summarizeText(match.content, 520)}`)
      .join("\n\n")
    : "";

  return [
    `Reused relevant session/task memory for '${title}' instead of launching another duplicate research pass.`,
    factSection,
    partialSection,
  ].filter(Boolean).join("\n\n");
}

async function findReusableSessionEvidence(
  candidate: string,
  request: DelegationRequest,
  ctx: ToolContext,
  agentCfg?: { tools?: string[]; capabilities?: string[] },
): Promise<{ output: string; factCount: number; partialCount: number } | null> {
  if (!isResearchLikeDelegation(candidate, request.task, request.routingQuery, agentCfg)) {
    return null;
  }

  const query = (request.routingQuery ?? request.taskTitle ?? summarizeText(request.task, 160)).trim();
  if (!query) {
    return null;
  }

  const config = getConfig();
  const embeddingModel = config.agents.defaults.model.embeddingModel;
  const factMatches = await searchSharedFacts(ctx.sessionId, query, {
    maxResults: 4,
    provider: embeddingModel ? getEmbeddingProvider() : undefined,
    embeddingModel,
  });
  const partialMatches = await searchPartialResults(ctx.sessionId, query, { maxResults: 3 });

  const relevantFacts = factMatches.filter((match) => match.score >= 0.18);
  const relevantPartials = partialMatches.filter((match) => match.score >= 0.18);
  const enoughEvidence = relevantFacts.length >= 2 || (relevantFacts.length >= 1 && relevantPartials.length >= 1);

  if (!enoughEvidence) {
    return null;
  }

  return {
    output: formatReusableSessionEvidenceOutput(
      request.taskTitle ?? summarizeText(request.task, 80),
      relevantFacts,
      relevantPartials,
    ),
    factCount: relevantFacts.length,
    partialCount: relevantPartials.length,
  };
}

function looksLikePlanningOnlyResult(result: string): boolean {
  const preview = result.slice(0, 600).trim();
  if (!preview) return false;

  const startsLikePlanning = /^\s*(let me|now let me|first let me|i(?:'m| am) going to|i(?:'ll| will)|i(?:'m| am) trying to|i need to|next,? i(?:'m| am) going to)\b/i.test(preview);
  if (!startsLikePlanning) return false;

  const planningAction = /\b(try|attempt|start|check|verify|fetch|get|gather|collect|retrieve|research|search|look for|look up|read|download|continue|proceed|focus|click|type|open|inspect|retry|use|switch|launch|list|attach|create)\b/i.test(preview);
  if (!planningAction) return false;

  const unresolvedMarker = /\b(sessionid|session id|empty string|null|again|different approach|tool list|available tools)\b/i.test(preview);
  const terminalMarker = /\b(completed|done|finished|succeeded|successfully|typed|opened|clicked|verified|failed|error|could not|did not)\b/i.test(preview);
  return !terminalMarker && (unresolvedMarker || preview.length <= 220);
}

export function looksLikeFailureResult(result: string): boolean {
  if (!result.trim()) return true;
  const preview = result.slice(0, 600);
  if (/^sub-agent produced no final response\.?$/i.test(preview.trim())) {
    return true;
  }
  if (/\b(no results|not found|unable to|failed to|error:|timed out|cancelled|incomplete|max.{0,20}iterations|sub_agent_max_iterations|could not complete|did not complete|exited with code|exit code)\b/i.test(preview)) {
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

function shouldAcceptPartialDelegation(
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

  const looksComputerUse = agentName === "computer_use_agent" || analyzeHeuristicRoutingQuery(task).looksComputerUse;
  if (!looksComputerUse) {
    return false;
  }

  return stats.toolCount > 0 || stats.toolNames.some((toolName) => toolName.startsWith("computer_"));
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
    if (!actuallyWorked && (output.trim().length < 80 || planningOnly)) {
      return "coordinator_noop";
    }
  }

  if (planningOnly) {
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
    if (hasPartialContent && output.trim() && !looksLikePlanningOnlyResult(output)) {
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

function formatArtifactReferencesForSharedContext(artifacts: Record<string, unknown>[]): string {
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

  return lines.length > 0
    ? `\n\nArtifacts generated by this result:\n${lines.join("\n")}`
    : "";
}

function uniqueNames(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function getKnownDelegationAgentNames(workspacePath?: string): Set<string> {
  const config = getConfig();
  const known = new Set(Object.keys(config.subAgents));
  const promotedAgents = readPromotedAgents(workspacePath ?? config.workspacePath);
  for (const name of Object.keys(promotedAgents)) {
    known.add(name);
  }
  return known;
}

function sanitizeDelegationAgentList(agentNames: string[] | undefined, ctx: ToolContext): {
  valid: string[];
  invalid: string[];
  disallowed: string[];
} {
  if (!agentNames?.length) {
    return { valid: [], invalid: [], disallowed: [] };
  }

  const knownAgents = getKnownDelegationAgentNames(ctx.workspacePath);
  const enforceKnownAgents = knownAgents.size > 0;
  const valid: string[] = [];
  const invalid: string[] = [];
  const disallowed: string[] = [];

  for (const agentName of uniqueNames(agentNames)) {
    if (enforceKnownAgents && !knownAgents.has(agentName)) {
      invalid.push(agentName);
      continue;
    }
    if (ctx.allowedAgents && !ctx.allowedAgents.includes(agentName)) {
      disallowed.push(agentName);
      continue;
    }
    valid.push(agentName);
  }

  return { valid, invalid, disallowed };
}

function maybeEnrichServerDelegationContext(agentName: string, task: string, context: string | undefined): string | undefined {
  if (!SERVER_EXECUTION_AGENT_NAMES.has(agentName)) {
    return context;
  }

  const signals = analyzeHeuristicRoutingQuery(`${task}\n${context ?? ""}`);
  if (!signals.looksServerAdmin) {
    return context;
  }

  const combined = `${task}\n${context ?? ""}`.toLowerCase();
  const nodes = (getConfig().computerUse as { nodes?: Record<string, Record<string, unknown>> } | undefined)?.nodes ?? {};

  for (const [nodeName, node] of Object.entries(nodes)) {
    if (node["adapter"] !== "remote_ssh") continue;

    const label = typeof node["label"] === "string" ? node["label"] : "";
    const host = typeof node["host"] === "string" ? node["host"] : "";
    const username = typeof node["username"] === "string" ? node["username"] : "root";
    const port = typeof node["port"] === "number" ? node["port"] : 22;
    const authMethod = typeof node["authMethod"] === "string" ? node["authMethod"] : "";
    const aliases = [nodeName, label, host]
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);

    const matched = aliases.some((alias) => {
      const variants = new Set([
        alias,
        alias.replace(/[_\s]+/g, "-"),
        alias.replace(/[-_]+/g, " "),
      ]);
      return [...variants].some((variant) => combined.includes(variant));
    });

    if (!matched) continue;

    const addition = [
      "Known configured SSH target for this task:",
      `- nodeName: ${nodeName}`,
      `- host: ${host}`,
      `- port: ${port}`,
      `- username: ${username}`,
      authMethod ? `- authMethod: ${authMethod}` : "",
      `Use ssh_exec with nodeName=\"${nodeName}\" so the runtime can reuse the configured target and credentials instead of rediscovering them.`,
      /\b(docker|container|containers)\b/i.test(task)
        ? "This is a direct remote inventory task. Prefer one SSH command such as docker ps or docker ps --format '{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Ports}}' and then stop."
        : "Prefer a direct remote command first and only inspect local config files if that remote call fails and you need to verify the configuration.",
      "Do not spend multiple iterations browsing local runtime or workspace files when the target is already identified above.",
    ].filter(Boolean).join("\n");

    if (context?.includes(`nodeName: ${nodeName}`) || context?.includes(`nodeName=\"${nodeName}\"`)) {
      return context;
    }
    return context ? `${context}\n\n${addition}` : addition;
  }

  return context;
}

function buildDelegationFailureMessage(title: string, detail: string, opts?: { prefix?: string }): string {
  const trimmedDetail = detail.trim();
  const prefix = opts?.prefix ?? `All candidate agents failed for task '${title}'.`;
  if (!trimmedDetail) {
    return prefix;
  }
  return `${prefix}\n${trimmedDetail}`;
}

async function routeAgentCandidates(query: string, ctx: ToolContext, exclude: string[]): Promise<AgentRoutingCandidate[]> {
  const excluded = new Set(exclude);
  if (ctx.currentAgentName) {
    excluded.add(ctx.currentAgentName);
  }
  const preferMissionCoordinator = shouldPreferMissionCoordinator(query, ctx, exclude);
  const preferWebTaskCoordinator = shouldPreferWebTaskCoordinator(query, ctx, exclude);
  const preferProjectPlanner = shouldPreferProjectPlanner(query, ctx, exclude);
  const medium = await resolveAgentRouting(query, {
    minConfidence: "medium",
    allowedAgents: ctx.allowedAgents,
    excludeAgents: [...excluded],
  });

  let candidates: AgentRoutingCandidate[] = medium.results;
  if (candidates.length === 0) {
    const low = await resolveAgentRouting(query, {
      minConfidence: "low",
      allowedAgents: ctx.allowedAgents,
      excludeAgents: [...excluded],
    });
    candidates = [...low.results, ...low.weakCandidates];

    // Total routing failure — no agent at any confidence. Auto-record for self-improvement.
    if (candidates.length === 0) {
      recordCapabilityGap({
        description: `Delegation failed — no agent found for task: "${query.slice(0, 300)}"`,
        exampleInput: query.slice(0, 500),
        sessionId: ctx.sessionId,
      }).catch(() => { /* self-improvement may be disabled */ });
    }
  }

  // Deduplicate by name, exclude already-attempted agents
  const seen = new Set<string>();
  const routed = candidates.filter(c => {
    if (excluded.has(c.name) || seen.has(c.name)) return false;
    seen.add(c.name);
    return true;
  });

  const { candidates: heuristicCandidates, boosts: heuristicBoosts } = buildHeuristicRoutingCandidates(query, ctx, excluded, seen);

  // Apply heuristic score boosts to routed candidates that were already seen
  for (const [name, boost] of heuristicBoosts) {
    const existing = routed.find(c => c.name === name);
    if (existing && boost.score > existing.score) {
      existing.score = boost.score;
      existing.matchedTerms = [...new Set([...existing.matchedTerms, ...boost.matchedTerms])];
    }
  }

  const mergedCandidates = [...routed, ...heuristicCandidates]
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (right.matchedTerms.length !== left.matchedTerms.length) {
        return right.matchedTerms.length - left.matchedTerms.length;
      }
      return left.name.localeCompare(right.name);
    });

  const preferredCoordinators = [
    preferMissionCoordinator ? "mission_coordinator" : null,
    preferWebTaskCoordinator ? "web_task_coordinator" : null,
    preferProjectPlanner ? "project_planner" : null,
  ].filter((value): value is string => Boolean(value));

  for (const preferredCoordinator of preferredCoordinators) {
    const coordinatorCandidate = mergedCandidates.find((candidate) => candidate.name === preferredCoordinator);
    if (coordinatorCandidate) {
      return [coordinatorCandidate, ...mergedCandidates.filter((candidate) => candidate.name !== coordinatorCandidate.name)];
    }
  }

  return mergedCandidates;
}

function buildHeuristicRoutingCandidates(
  query: string,
  ctx: ToolContext,
  excluded: Set<string>,
  seen: Set<string>,
): { candidates: AgentRoutingCandidate[]; boosts: Map<string, { score: number; matchedTerms: string[] }> } {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return { candidates: [], boosts: new Map() };

  const config = getConfig();
  const defaultModel = config.agents.defaults.model.primary;
  const heuristicCandidates: AgentRoutingCandidate[] = [];
  const heuristicBoosts = new Map<string, { score: number; matchedTerms: string[] }>();
  const signals = analyzeHeuristicRoutingQuery(normalized);
  const positiveNavigationIntent = isNavigationRoutingRequest(query);
  const vulnerabilityResearchIntent = /\b(cve|cvss|vulnerability|vulnerabilities|advisory|advisories|exploit(?:-db)?|nvd|patch(?:es| status)?|threat intelligence)\b/i.test(normalized);
  const looksNewsTask = /\b(news|updates?|nachrichten|neuigkeiten|meldungen|trends)\b/i.test(normalized);
  const looksBrowserEvidenceTask = /\b(browser|website|web\s?site|webseite|page|url|screenshot|snapshot|playwright|open\s+the\s+website|capture\s+a\s+page)\b/i.test(normalized);

  const maybeAdd = (name: string, score: number, matchedTerms: string[]) => {
    if (excluded.has(name)) return;
    if (ctx.allowedAgents && !ctx.allowedAgents.includes(name)) return;
    const cfg = config.subAgents[name];
    if (!cfg) return;
    if (seen.has(name)) {
      // Agent already in routed candidates — record boost request so the
      // caller can apply it to the existing entry.
      heuristicBoosts.set(name, { score, matchedTerms });
      return;
    }
    seen.add(name);
    heuristicCandidates.push(toCandidate(name, cfg, score, matchedTerms, defaultModel, config.workspacePath));
  };

  if (signals.looksComputerUse) {
    maybeAdd("computer_use_agent", 0.75, ["computer", "desktop", "automation"]);
  }

  if (vulnerabilityResearchIntent) {
    maybeAdd("security_researcher", 0.82, ["security", "cve", "vulnerability"]);
  }

  if (positiveNavigationIntent) {
    maybeAdd("distance_specialist", 0.82, ["navigation", "distance", "travel time"]);
  }

  if (looksBrowserEvidenceTask && !shouldPreferMissionCoordinator(normalized, ctx, [...excluded])) {
    maybeAdd("browser_agent", 0.78, ["browser", "website", "snapshot"]);
  }

  if (signals.looksBrowserLoginTask) {
    maybeAdd("browser_agent", 0.8, ["browser", "login", "form", "credentials"]);
  }

  if (signals.looksServerAdmin) {
    maybeAdd(
      signals.looksServiceTroubleshooting ? "ops_triage" : "shell_agent",
      0.78,
      signals.looksServiceTroubleshooting
        ? ["server", "ops", "logs", "containers"]
        : ["server", "ssh", "shell", "docker"],
    );
  }

  if (shouldPreferMissionCoordinator(normalized, ctx, [...excluded])) {
    maybeAdd("mission_coordinator", 0.72, buildMissionCoordinatorMatchedTerms(signals));
  }

  if (signals.looksWebTask && (signals.looksBroad || signals.looksFresh || signals.looksSourceHeavy)) {
    maybeAdd("web_task_coordinator", 0.72, buildCoordinatorMatchedTerms(signals));
    maybeAdd("researcher", 0.72, ["research", "sources", "web"]);
  }

  if (looksNewsTask) {
    maybeAdd("web_task_coordinator", 0.72, ["web", "news", "research"]);
    maybeAdd("researcher", 0.72, ["research", "news", "sources"]);
  }

  if (shouldPreferProjectPlanner(normalized, ctx, [...excluded])) {
    maybeAdd("project_planner", 0.72, buildPlannerMatchedTerms(signals));
  }

  if (signals.looksRenderFromProvidedData) {
    maybeAdd("chart_designer", 0.72, buildChartDesignerMatchedTerms(signals));
  }

  // Boost browser_agent when the task explicitly mentions Playwright, browser automation,
  // or cookie handling — avoid sending these to researcher which only has web_fetch.
  if (/\b(playwright|browser.?agent|cookie.?consent|cookie.?banner|interactive|js.?rendered|javascript.?heavy)\b/i.test(normalized)) {
    maybeAdd("browser_agent", 0.72, ["browser", "playwright", "interactive"]);
  }

  // Boost web_task_coordinator for web data tasks that need coordinated retrieval + charting
  if (signals.looksVisualization && (signals.looksExternalData || signals.looksDataHeavy) && !signals.looksRenderFromProvidedData) {
    maybeAdd("web_task_coordinator", 0.72, ["web", "data", "chart", "coordination"]);
  }

  if ((signals.looksSourceHeavy && /\b(citation|citations|reference|references|bibliograph|paper|papers|report|reports|brief|briefs)\b/i.test(normalized))
    || /\b(wcag|spec|specification|standard|guideline|guidelines)\b/i.test(normalized)) {
    maybeAdd("researcher", 0.56, ["official", "sources"]);
  }

  return { candidates: heuristicCandidates, boosts: heuristicBoosts };
}

// ─── Architect fallback ───────────────────────────────────────────────────────

/**
 * After a successful ephemeral run, check whether this agent type has proven
 * reliable enough to be promoted to the permanent catalog.
 */
function maybePromoteEphemeral(
  agentName: string,
  workspacePath: string,
  cfg: import("../config/schema.js").SubAgentConfig,
): void {
  const outcomes = readRecentOutcomes(workspacePath, 100);
  const relevant = outcomes.filter(o => o.agent === agentName);
  const successes = relevant.filter(o => o.outcome === "success").length;
  if (successes < PROMOTION_MIN_SUCCESSES) return;
  const successRate = successes / relevant.length;
  if (successRate < PROMOTION_MIN_SUCCESS_RATE) return;
  // Strip "ephemeral:" prefix for the promoted catalog name
  const promotedName = agentName.replace(/^ephemeral:/, "");
  // Don't overwrite an existing permanent agent
  const config = getConfig();
  if (config.subAgents[promotedName]) return;
  promoteEphemeralAgent(workspacePath, promotedName, cfg);
}

/**
 * Last-resort routing path: ask the LLM to design a minimal ephemeral agent
 * tailored to the task, run it, and conditionally auto-promote it.
 *
 * Returns null if the LLM call or spec validation fails so the caller can
 * handle the hard-failure case gracefully.
 */
async function runArchitectFallback(task: string, ctx: ToolContext): Promise<ToolResult | null> {
  const config = getConfig();
  const settings = getEphemeralGenerationSettings();
  if (!settings.enabled) {
    return null;
  }

  // Gather shared context from prior attempts so the ephemeral agent knows
  // about URLs, facts, and partial results already discovered.
  const sharedCtx = await formatSharedContextForPrompt(ctx.sessionId, { agentName: "architect" });
  const spec = await requestArchitectSpec(task, ctx, sharedCtx ?? undefined);
  if (!spec) {
    return null;
  }

  const agentName = String(spec.agentName ?? "architect_agent")
    .trim()
    .replace(/\W+/g, "_")
    .slice(0, 64);
  const systemPrompt = String(spec.systemPrompt ?? "").trim();
  const description = String(spec.description ?? agentName);
  const rawTools = Array.isArray(spec.tools) ? spec.tools.map(String) : [];
  const tools = rawTools.filter(t => GRANTABLE_TOOLS.has(t));
  const usesComputerTools = tools.some(t => EXECUTION_TOOL_FAMILIES.computer.has(t));
  const iterCap = usesComputerTools ? 20 : 8;
  const iterFloor = usesComputerTools ? 8 : 1;
  const maxIterations = Math.min(iterCap, Math.max(iterFloor, Number(spec.maxIterations ?? (usesComputerTools ? 12 : 5)) || 5));
  const model = normalizeArchitectModel(spec.model);

  const policyIssues = validateEphemeralToolSelection(tools, { allowZeroTools: true });
  if (policyIssues.length > 0 || !systemPrompt) {
    logAudit(
      "architect_fallback_rejected",
      { agentName, policyIssues, missingSystemPrompt: !systemPrompt },
      { sessionId: ctx.sessionId, severity: "warn" },
    );
    return null;
  }

  const inlineConfig: import("../config/schema.js").SubAgentConfig = {
    description,
    capabilities: [],
    tags: [],
    systemPrompt,
    tools,
    maxIterations,
    model,
    // Architect-spawned agents run in-process so they can reach gateway-bound
    // tools (web_search via SearXNG, Playwright browser, MCP tools). The
    // agent-worker container image cannot satisfy these dependencies and would
    // return "container error: unknown". Disable containerization unconditionally.
    container: { disabled: true, enabled: false, image: "starlingai/agent-worker:dev", memoryMb: 512, cpus: 0.5, timeoutMs: 60_000 },
  };

  const ephemeralName = `ephemeral:${agentName}`;

  logAudit(
    "architect_fallback_started",
    { agentName: ephemeralName, tools, maxIterations, model: model?.primary ?? null, architectAgentName: settings.architectAgentName },
    { sessionId: ctx.sessionId },
  );

  let result: string;
  let terminalState: string | undefined;
  try {
    // Inject shared facts into the ephemeral agent's context so it can use
    // URLs, partial results, and evidence discovered by earlier agents.
    const ephemeralSharedCtx = await formatSharedContextForPrompt(ctx.sessionId, { agentName: ephemeralName });
    const runResult = await runSubAgentWithStats({
      agentName: ephemeralName,
      task,
      context: ephemeralSharedCtx ?? undefined,
      parentSessionId: ctx.sessionId,
      workspacePath: ctx.workspacePath,
      allowedAgents: ctx.allowedAgents,
      signal: ctx.signal,
      approvalCallback: ctx.approvalCallback,
      humanInLoopSteps: ctx.humanInLoopSteps,
      swarmState: ctx.swarmState,
      onSwarmState: ctx.onSwarmState,
      _turnAgentCounts: ctx._turnAgentCounts,
      _turnAgentRepeatLimitOverrides: ctx._turnAgentRepeatLimitOverrides,
      _turnTotalDelegationLimitOverride: ctx._turnTotalDelegationLimitOverride,
      _workflowExecutionStack: ctx._workflowExecutionStack,
      inlineConfig,
    });
    result = runResult.output;
    terminalState = runResult.stats.terminalState;
  } catch (err) {
    logAudit(
      "architect_fallback_failed",
      { agentName: ephemeralName, reason: "run_error", err: String(err) },
      { sessionId: ctx.sessionId, severity: "warn" },
    );
    return null;
  }

  let parsedOutcome: any = null;
  const tagMatch = result.match(/<final_answer\s+status="([^"]+)">([\s\S]*?)<\/final_answer>/i);
  if (tagMatch) {
    parsedOutcome = { status: tagMatch[1]!.toLowerCase(), data: tagMatch[2]!.trim() };
  }

  const success = terminalState === undefined || terminalState === "completed"
    ? (parsedOutcome ? parsedOutcome.status !== "failure" && parsedOutcome.status !== "needs_info" : !looksLikeFailureResult(result))
    : (terminalState === "max_iterations" && result.length > 0 && !looksLikeFailureResult(result));

  if (parsedOutcome) {
    result = parsedOutcome.data || result;
  }

  logAudit(
    "architect_fallback_completed",
    { agentName: ephemeralName, success, resultLength: result.length, terminalState: terminalState ?? null },
    { sessionId: ctx.sessionId },
  );

  if (success) {
    maybePromoteEphemeral(ephemeralName, ctx.workspacePath, inlineConfig);
  }

  return {
    success,
    output: success ? `[${ephemeralName}]: ${result}` : result,
    error: success ? undefined : `Architect-designed agent '${agentName}' could not complete the task.`,
    metadata: {
      agentName: ephemeralName,
      architect: true,
      tools,
      promoted: success && config.subAgents[agentName] === undefined,
    },
  };
}

async function executeDelegationWithFallback(request: DelegationRequest, ctx: ToolContext): Promise<ToolResult> {
  const title = request.taskTitle ?? summarizeText(request.task, 80);
  const signature = buildTaskSignature(title, request.task, request.dependsOn ?? []);
  const skillMatchThreshold = resolveSkillMatchThreshold(request.skillMatchThreshold);
  const explicitAgentRequested = typeof request.agentName === "string" && request.agentName.trim().length > 0;
  const hasExplicitFallbacks = (request.fallbackAgents?.length ?? 0) > 0;
  const reusableTaskById = request.taskId
    ? ctx.swarmState?.tasks[request.taskId]
    : undefined;
  const reusableTask = reusableTaskById?.signature === signature
    ? reusableTaskById
    : (request.taskId ? undefined : findReusableSwarmTask(ctx, signature));
  const reusableTaskAttemptedAgents = reusableTask?.attempts.map((attempt) => attempt.agentName) ?? [];

  if (reusableTask?.status === "completed" && reusableTask.output) {
    return {
      success: true,
      output: reusableTask.output,
      metadata: {
        agentName: reusableTask.selectedAgent,
        taskId: reusableTask.id,
        attemptedAgents: reusableTaskAttemptedAgents,
        delegationSucceeded: true,
        reused: true,
      },
    };
  }

  if (reusableTask?.status === "partial" && reusableTask.output) {
    return {
      success: true,
      output: reusableTask.output,
      metadata: {
        agentName: reusableTask.selectedAgent,
        taskId: reusableTask.id,
        attemptedAgents: reusableTaskAttemptedAgents,
        delegationSucceeded: true,
        delegationOutcome: "partial",
        reused: true,
      },
    };
  }

  if (reusableTask?.status === "running") {
    return {
      success: true,
      output: `Task '${title}' is already running via ${reusableTask.selectedAgent ?? reusableTask.attempts[reusableTask.attempts.length - 1]?.agentName ?? "another agent"}.`,
      metadata: {
        agentName: reusableTask.selectedAgent,
        taskId: reusableTask.id,
        attemptedAgents: reusableTaskAttemptedAgents,
        reused: true,
        inFlight: true,
      },
    };
  }

  if (!request.taskId && reusableTask?.status === "failed" && !retryIntroducesNewAgent(request, reusableTaskAttemptedAgents)) {
    return {
      success: false,
      output: "",
      error: `Delegation for task '${title}' already failed earlier in this turn${reusableTaskAttemptedAgents.length > 0 ? ` after trying ${reusableTaskAttemptedAgents.join(", ")}` : ""}. Do not retry the same task verbatim. ${reusableTask.error ?? "Use a different agent or provide a more specific task."}`,
      metadata: {
        agentName: reusableTask.selectedAgent,
        taskId: reusableTask.id,
        attemptedAgents: reusableTaskAttemptedAgents,
        delegationSucceeded: false,
        reused: true,
        priorFailure: true,
      },
    };
  }

  const taskId = request.taskId ?? reusableTask?.id ?? `task_${Object.keys(ensureSwarmState(ctx, request.task).tasks).length + 1}`;
  const taskState = getOrCreateSwarmTask(ctx, taskId, title, request.dependsOn ?? [], signature);
  const explicitAgentOverride = resolveExplicitDelegationAgentOverride(request, ctx);
  const pinnedAgentName = !request.agentName
    ? resolvePinnedDelegationAgent(request.routingQuery ?? request.task, ctx)
    : null;
  const attemptedAgents: string[] = [];
  // I12: Track candidates skipped because they had already exhausted their
  // per-agent delegation cap this turn. Without this, when every routed
  // candidate is already maxed out (e.g. researcher already called 2/2
  // times by an earlier parallel_delegate) we silently fall through to
  // "No suitable agent completed the task" which makes the coordinator
  // think it's a routing problem and re-delegate the same work.
  const cappedCandidates: string[] = [];
  const usesAutonomousBidding = !request.agentName;

  if (usesAutonomousBidding) {
    clearTaskBids(taskId);
  }

  emitSwarmEvent("task_announced", {
    sessionId: ctx.sessionId,
    taskId,
    task: request.task,
    agentName: request.agentName,
    ...(usesAutonomousBidding
      ? {
        data: {
          dispatchMode: "autonomous_bidding",
          routingQuery: request.routingQuery ?? request.task,
          allowedAgents: ctx.allowedAgents ?? [],
          excludeAgents: attemptedAgents,
          bidWindowMs: DEFAULT_AUTONOMOUS_BID_WINDOW_MS,
        },
      }
      : {}),
  });

  let candidateQueue = uniqueNames([
    explicitAgentOverride ?? "",
    request.agentName ?? "",
    pinnedAgentName ?? "",
    ...(request.fallbackAgents ?? []),
  ]);
  let biddingTried = false;
  let bestAutoMatchScore: number | undefined;
  let bestAutoMatchConfidence: "high" | "medium" | "low" | undefined;
  let lastFailureWasInfrastructure = false;
  let bestPartialResult:
    | {
      agentName: string;
      output: string;
      terminalState?: string;
      routingInfo?: RoutingSelectionReason;
      artifacts?: Record<string, unknown>[];
    }
    | undefined;
  /** Routing metadata for agents that were auto-selected by resolveAgentRouting. */
  const routingCandidateMap = new Map<string, RoutingSelectionReason>();

  if (pinnedAgentName) {
    routingCandidateMap.set(pinnedAgentName, {
      confidence: "high",
      matchedTerms: ["memory", "productivity"],
      score: 0.9,
    });
  }

  if (explicitAgentOverride) {
    routingCandidateMap.set(explicitAgentOverride, {
      confidence: "high",
      matchedTerms: ["source-grounded", "research", "web-task-redirect"],
      score: 0.86,
    });
  }

  if (!ctx._turnAgentCounts) ctx._turnAgentCounts = new Map();

  while (true) {
    // Abort early if the parent turn was cancelled
    if (ctx.signal?.aborted) {
      taskState.status = "failed";
      taskState.error = "Turn cancelled.";
      publishSwarmState(ctx);
      return {
        success: false,
        output: "",
        error: buildDelegationFailureMessage(
          title,
          taskState.error,
          { prefix: "Turn cancelled — delegation aborted." },
        ),
        metadata: { taskId, attemptedAgents, delegationSucceeded: false },
      };
    }

    // Hard ceiling: if we've already spawned too many agents this turn, stop and tell the LLM to synthesize
    const totalDelegations = totalDelegationsThisTurn(ctx);
    const maxTotalDelegationsPerTurn = getTotalDelegationLimit(ctx);
    if (totalDelegations >= maxTotalDelegationsPerTurn) {
      taskState.status = "failed";
      taskState.error = "Turn delegation budget exceeded.";
      publishSwarmState(ctx);
      return {
        success: false,
        output: "",
        error: `Turn delegation limit (${maxTotalDelegationsPerTurn}) reached. Stop delegating and synthesize your findings into a final response for the user now.`,
        metadata: { taskId, attemptedAgents, delegationSucceeded: false },
      };
    }

    if (candidateQueue.length === 0) {
      // Explicit delegate_to_agent calls stay explicit unless the caller opted
      // into retries with fallbackAgents. Hidden auto-routing after an explicit
      // pick led to wasted coordinator hops and surprising tool churn.
      const allowImplicitFallbackRouting = !explicitAgentRequested || hasExplicitFallbacks;

      if (!allowImplicitFallbackRouting) {
        break;
      }

      // ── Step 1: embedding + keyword routing (fast, outcome-boosted) ──────
      // Run first for all undirected delegations — deterministic, uses
      // accumulated outcome data, and incurs no extra latency.
      if (candidateQueue.length === 0) {
        const routingCandidates = await routeAgentCandidates(request.routingQuery ?? request.task, ctx, attemptedAgents);
        if (routingCandidates.length > 0) {
          const topCandidate = routingCandidates[0]!;
          bestAutoMatchScore = topCandidate.score;
          bestAutoMatchConfidence = topCandidate.confidence;
          const shouldQueueRoutedCandidate = explicitAgentRequested
            || attemptedAgents.length > 0
            || shouldPreferCatalogAgent(bestAutoMatchScore, bestAutoMatchConfidence, skillMatchThreshold);
          if (shouldQueueRoutedCandidate) {
            routingCandidateMap.set(topCandidate.name, {
              confidence: topCandidate.confidence,
              matchedTerms: topCandidate.matchedTerms,
              score: topCandidate.score,
            });
            candidateQueue.push(topCandidate.name);
          }
        }
      }

      // ── Step 2: heuristic coordinator fallbacks ─────────────────────────
      if (candidateQueue.length === 0) {
        if (attemptedAgents.length > 0 && shouldPreferMissionCoordinator(request.routingQuery ?? request.task, ctx, attemptedAgents)) {
          routingCandidateMap.set("mission_coordinator", {
            confidence: "medium",
            matchedTerms: buildMissionCoordinatorMatchedTerms(analyzeHeuristicRoutingQuery(request.routingQuery ?? request.task)),
            score: 0.68,
          });
          candidateQueue.push("mission_coordinator");
        }
      }

      if (candidateQueue.length === 0) {
        if (attemptedAgents.length > 0 && shouldPreferWebTaskCoordinator(request.routingQuery ?? request.task, ctx, attemptedAgents)) {
          routingCandidateMap.set("web_task_coordinator", {
            confidence: "medium",
            matchedTerms: buildCoordinatorMatchedTerms(analyzeHeuristicRoutingQuery(request.routingQuery ?? request.task)),
            score: 0.62,
          });
          candidateQueue.push("web_task_coordinator");
        }
      }

      // ── Step 3: autonomous bidding (last resort — 125ms window) ─────────
      // Only when both routing and heuristics came up empty. Bidding is the
      // correct fallback for tasks that require a dynamic peer-elected agent
      // not represented in the static catalog.
      if (candidateQueue.length === 0 && usesAutonomousBidding && isAutonomousBiddingStarted() && !biddingTried) {
        biddingTried = true;
        const bids = await collectTaskBids(taskId, DEFAULT_AUTONOMOUS_BID_WINDOW_MS);
        bestAutoMatchScore = bids[0]?.score ?? bestAutoMatchScore;
        bestAutoMatchConfidence = bids[0]?.confidence as ("high" | "medium" | "low" | undefined) ?? bestAutoMatchConfidence;
        if (shouldPreferCatalogAgent(bestAutoMatchScore, bestAutoMatchConfidence, skillMatchThreshold)) {
          for (const bid of bids) {
            routingCandidateMap.set(bid.agentName, {
              confidence: bid.confidence,
              matchedTerms: bid.matchedTerms,
              score: bid.score,
            });
          }
          candidateQueue = uniqueNames(bids.map(bid => bid.agentName));
        }
      }

      if (candidateQueue.length === 0) break;
    }

    const candidate = candidateQueue.shift()!;
    if (attemptedAgents.includes(candidate)) continue;

    // Per-agent repeat cap: skip if this agent has already been called its allowed number of times this turn
    const prevCalls = ctx._turnAgentCounts.get(candidate) ?? 0;
    if (prevCalls >= getPerAgentDelegationLimit(ctx, candidate)) {
      // I12: Remember WHO got skipped so the failure path can produce an
      // honest "these agents are already maxed out for this turn"
      // diagnostic instead of pretending nothing matched.
      if (!cappedCandidates.includes(candidate)) {
        cappedCandidates.push(candidate);
      }
      continue;
    }
    ctx._turnAgentCounts.set(candidate, prevCalls + 1);

    attemptedAgents.push(candidate);

    if (ctx.allowedAgents && !ctx.allowedAgents.includes(candidate)) {
      continue;
    }

    const startedAt = new Date().toISOString();
    taskState.status = "running";
    taskState.selectedAgent = candidate;
    taskState.output = undefined;
    taskState.error = undefined;
    taskState.attempts.push({
      agentName: candidate,
      status: "running",
      startedAt,
    });
    ensureSwarmState(ctx, request.task).updatedAt = startedAt;
    publishSwarmState(ctx);

    emitSwarmEvent("task_claimed", { sessionId: ctx.sessionId, taskId, agentName: candidate, task: request.task });

    // Acquire a distributed lock so a re-queued broadcast of the same task can't
    // be double-claimed in a multi-instance deployment. Lock TTL = 30 s; released
    // on completion or failure.
    const lockOwner = await acquireTaskLock(taskId);

    const attempt = taskState.attempts[taskState.attempts.length - 1]!;
    const config = getConfig();
    const promotedAgents = readPromotedAgents(config.workspacePath);
    const agentCfg = config.subAgents[candidate] ?? promotedAgents[candidate];
    announceAgentCapability({
      sessionId: ctx.sessionId,
      agentName: candidate,
      domain: agentCfg?.domain,
      capabilities: agentCfg?.capabilities ?? [],
      tags: agentCfg?.tags ?? [],
      availability: "busy",
      activeTaskId: taskId,
      source: "runtime",
    });

    try {
      // Inject shared facts from other agents into this sub-agent's context
      const sharedCtx = await formatSharedContextForPrompt(ctx.sessionId, { agentName: candidate });
      const enrichedContext = sharedCtx
        ? `${sharedCtx}\n\n---\n\n${request.context ?? ""}`.trim()
        : request.context;

      const reusableSessionEvidence = await findReusableSessionEvidence(candidate, request, ctx, agentCfg);
      if (reusableSessionEvidence) {
        attempt.finishedAt = new Date().toISOString();
        attempt.status = "completed";
        attempt.summary = summarizeText(reusableSessionEvidence.output);
        attempt.toolCount = 0;
        attempt.iterations = 0;
        attempt.toolNames = [];
        finalizeAttemptBudget(ctx, taskState, attempt);
        taskState.status = "completed";
        taskState.output = reusableSessionEvidence.output;
        taskState.error = undefined;
        ensureSwarmState(ctx, request.task).updatedAt = attempt.finishedAt;
        publishSwarmState(ctx);
        emitSwarmEvent("task_completed", {
          sessionId: ctx.sessionId,
          taskId,
          agentName: candidate,
          data: {
            reusedSessionEvidence: true,
            factCount: reusableSessionEvidence.factCount,
            partialCount: reusableSessionEvidence.partialCount,
          },
        });
        announceAgentCapability({
          sessionId: ctx.sessionId,
          agentName: candidate,
          domain: agentCfg?.domain,
          capabilities: agentCfg?.capabilities ?? [],
          tags: agentCfg?.tags ?? [],
          availability: "idle",
          source: "runtime",
        });
        if (lockOwner) await releaseTaskLock(taskId, lockOwner);
        return {
          success: true,
          output: reusableSessionEvidence.output,
          metadata: {
            agentName: candidate,
            taskId,
            attemptedAgents,
            delegationSucceeded: true,
            reused: true,
            reusedFromSessionMemory: true,
            factCount: reusableSessionEvidence.factCount,
            partialCount: reusableSessionEvidence.partialCount,
          },
        };
      }

      // B7: Cross-agent context handoff — when this is a fallback agent (prior attempts
      // already exist), prepend a brief summary of what was tried so the new agent does
      // not repeat the same failing approaches. Pass as context (not task) so it goes
      // into the system prompt area and won't contaminate the agent's output text.
      let handoffContext = enrichedContext;
      const priorAttempts = taskState.attempts.slice(0, -1); // all but the one just pushed
      if (priorAttempts.length > 0) {
        const priorLines = priorAttempts.map((a) => {
          const status = a.status === "partial" ? "partial evidence" : "failed";
          // Omit the raw error summary to avoid accidentally leaking failure-detection
          // patterns into the new agent's context in a confusing way.
          return `  - ${a.agentName} (${status})`;
        });
        const handoffPrefix =
          `[PRIOR AGENT ACTIVITY]\n` +
          priorLines.join("\n") +
          "\nDo NOT repeat these exact approaches. Use a different strategy or source.\n";
        handoffContext = handoffPrefix + (enrichedContext ? `\n${enrichedContext}` : "");
      }

      const subAgentArgs = {
        agentName: candidate,
        task: request.task,
        context: handoffContext,
        parentSessionId: ctx.sessionId,
        workspacePath: ctx.workspacePath,
        allowedAgents: ctx.allowedAgents,
        signal: ctx.signal,
        approvalCallback: ctx.approvalCallback,
        onProgress: ctx.onSubAgentProgress,
        humanInLoopSteps: ctx.humanInLoopSteps,
        onComputerAction: ctx.onComputerAction,
        onComputerScreenshot: ctx.onComputerScreenshot,
        onComputerSessionState: ctx.onComputerSessionState,
        maxIterationsOverride: ctx.maxIterationsOverride,
        turnTimeoutOverrideMs: ctx.turnTimeoutOverrideMs,
        swarmState: ctx.swarmState,
        onSwarmState: ctx.onSwarmState,
        _turnAgentCounts: ctx._turnAgentCounts,
        _turnAgentRepeatLimitOverrides: ctx._turnAgentRepeatLimitOverrides,
        _turnTotalDelegationLimitOverride: ctx._turnTotalDelegationLimitOverride,
        _workflowExecutionStack: ctx._workflowExecutionStack,
        // E18: Soft deadline — give the specialist 70% of its effective timeout so
        // it starts wrapping up before the hard timeout fires.
        softDeadlineMs: (() => {
          const effective = ctx.turnTimeoutOverrideMs ?? agentCfg?.turnTimeoutMs ?? 60_000;
          return Date.now() + Math.floor(effective * 0.70);
        })(),
      };

      let output: string;
      let stats: {
        toolCount: number;
        iterations: number;
        toolNames: string[];
        terminalState?: string;
        outcome?: string;
        usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
      } | undefined;
      let artifacts: Record<string, unknown>[] = [];

      if (typeof runSubAgentWithStats === "function") {
        const maybeResult = await runSubAgentWithStats(subAgentArgs);
        if (
          maybeResult
          && typeof maybeResult.output === "string"
          && maybeResult.stats
          && Array.isArray(maybeResult.stats.toolNames)
        ) {
          output = maybeResult.output;
          stats = maybeResult.stats;
          artifacts = Array.isArray(maybeResult.artifacts)
            ? maybeResult.artifacts.map((artifact) => ({ ...artifact }))
            : [];
        } else {
          output = await runSubAgent(subAgentArgs);
        }
      } else {
        output = await runSubAgent(subAgentArgs);
      }

      if (stats) {
        attempt.toolCount = stats.toolCount;
        attempt.iterations = stats.iterations;
        attempt.toolNames = [...stats.toolNames];
        if (stats.usage) {
          attempt.promptTokens = stats.usage.promptTokens;
          attempt.completionTokens = stats.usage.completionTokens;
          attempt.totalTokens = stats.usage.totalTokens;
        }
        if (stats.terminalState) {
          attempt.terminalState = stats.terminalState;
        }
      }

      let delegationOutcome = stats?.outcome;
      let parsedOutcome: any = null;
      const tagMatch = output.match(/<final_answer\s+status="([^"]+)">([\s\S]*?)<\/final_answer>/i);
      if (tagMatch) {
        parsedOutcome = { status: tagMatch[1]!.toLowerCase(), data: tagMatch[2]!.trim() };
      }

      if (parsedOutcome && parsedOutcome.status) {
        delegationOutcome = parsedOutcome.status;
        output = parsedOutcome.data || output;
      }

      // D14: Consolidated classification — replaces the scattered acceptPartial /
      // coordinatorMicroCompletion / weak variables that used to live here.
      const classification = classifyDelegationResult(
        output, delegationOutcome, stats, agentCfg, candidate, request.task, artifacts,
      );
      const routingInfo = routingCandidateMap.get(candidate);

      attempt.finishedAt = new Date().toISOString();
      attempt.summary = summarizeText(output);
      finalizeAttemptBudget(ctx, taskState, attempt);

      if (classification !== "success" && classification !== "partial") {
        // "coordinator_noop", "failure", and "infrastructure_failure"
        // all continue to the next candidate.
        attempt.status = "failed";
        taskState.error = output.trim().slice(0, 4000) || summarizeText(output);
        taskState.status = "failed";
        lastFailureWasInfrastructure = classification === "infrastructure_failure";
        publishSwarmState(ctx);
        emitSwarmEvent("task_failed", {
          sessionId: ctx.sessionId,
          taskId,
          agentName: candidate,
          data: { reason: "weak_result" },
        });
        announceAgentCapability({
          sessionId: ctx.sessionId,
          agentName: candidate,
          domain: agentCfg?.domain,
          capabilities: agentCfg?.capabilities ?? [],
          tags: agentCfg?.tags ?? [],
          availability: "degraded",
          activeTaskId: taskId,
          source: "runtime",
        });
        if (lockOwner) await releaseTaskLock(taskId, lockOwner);
        // Infrastructure failures cannot be solved by a different agent — stop immediately
        if (lastFailureWasInfrastructure) break;
        continue;
      }

      // Store successful output as a partial result and extract any FACT: lines
      await appendPartialResult({
        sessionId: ctx.sessionId,
        taskId,
        agentName: candidate,
        content: `${summarizeText(output, 1200)}${formatArtifactReferencesForSharedContext(artifacts)}`.trim(),
        ts: attempt.finishedAt!,
      });
      const extractedFacts = extractFactsFromOutput(output);
      for (const [k, v] of Object.entries(extractedFacts)) {
        await writeSharedFact(ctx.sessionId, k, v);
        // Promote to durable graph node so facts outlive the 4h Redis TTL
        graphPromoteFact(k, v, candidate, ctx.sessionId).catch(() => {});
      }

      const partial = classification === "partial";
      attempt.status = partial ? "partial" : "completed";
      taskState.status = partial ? "partial" : "completed";
      taskState.output = output;
      taskState.error = undefined;
      ensureSwarmState(ctx, request.task).updatedAt = attempt.finishedAt;
      publishSwarmState(ctx);
      emitSwarmEvent(partial ? "task_partial" : "task_completed", { sessionId: ctx.sessionId, taskId, agentName: candidate });
      announceAgentCapability({
        sessionId: ctx.sessionId,
        agentName: candidate,
        domain: agentCfg?.domain,
        capabilities: agentCfg?.capabilities ?? [],
        tags: agentCfg?.tags ?? [],
        availability: "idle",
        source: "runtime",
      });
      if (lockOwner) await releaseTaskLock(taskId, lockOwner);

      const routingNote = routingInfo
        ? `\n↳ Auto-routed to ${candidate} (${routingInfo.confidence} confidence${routingInfo.matchedTerms.length > 0 ? `, matched: ${routingInfo.matchedTerms.join(", ")}` : ""})`
        : "";
      return {
        success: true,
        output: `[${candidate}]: ${output}${routingNote}`,
        metadata: {
          agentName: candidate,
          taskId,
          attemptedAgents,
          delegationSucceeded: true,
          delegationOutcome: delegationOutcome ?? "success",
          ...(artifacts.length > 0 ? { artifacts } : {}),
          ...(stats?.terminalState ? { terminalState: stats.terminalState } : {}),
          ...(routingInfo && { routingReason: { confidence: routingInfo.confidence, matchedTerms: routingInfo.matchedTerms, score: routingInfo.score } }),
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempt.finishedAt = new Date().toISOString();
      attempt.status = "failed";
      attempt.summary = summarizeText(message);
      finalizeAttemptBudget(ctx, taskState, attempt);
      taskState.status = "failed";
      taskState.error = summarizeText(message);
      ensureSwarmState(ctx, request.task).updatedAt = attempt.finishedAt;
      publishSwarmState(ctx);
      emitSwarmEvent("task_failed", { sessionId: ctx.sessionId, taskId, agentName: candidate, data: { error: message } });
      announceAgentCapability({
        sessionId: ctx.sessionId,
        agentName: candidate,
        domain: agentCfg?.domain,
        capabilities: agentCfg?.capabilities ?? [],
        tags: agentCfg?.tags ?? [],
        availability: "degraded",
        activeTaskId: taskId,
        source: "runtime",
      });
      if (lockOwner) await releaseTaskLock(taskId, lockOwner);
    }
  }

  // ── Architect fallback ────────────────────────────────────────────────────
  // When routing found zero candidates (no agent was even tried), ask the LLM
  // architect to design a purpose-built ephemeral agent for this task.
  // Skip architect if the failure was infrastructure-level (host unreachable, etc.) —
  // an ephemeral agent would face the exact same connectivity problem.
  if (!explicitAgentRequested && !lastFailureWasInfrastructure && (attemptedAgents.length === 0 || shouldGenerateEphemeralAgent(bestAutoMatchScore, skillMatchThreshold))) {
    const architectResult = await runArchitectFallback(request.task, ctx);
    if (architectResult) {
      clearTaskBids(taskId);
      if (architectResult.success || !bestPartialResult) {
        taskState.status = architectResult.success ? "completed" : "failed";
        taskState.output = architectResult.success ? architectResult.output : undefined;
        taskState.error = architectResult.success ? undefined : architectResult.error;
        ensureSwarmState(ctx, request.task).updatedAt = new Date().toISOString();
        publishSwarmState(ctx);
        return {
          ...architectResult,
          metadata: { ...architectResult.metadata, taskId, attemptedAgents, skillMatchThreshold, bestAutoMatchScore, delegationSucceeded: architectResult.success },
        };
      }
    }
  }

  if (bestPartialResult) {
    clearTaskBids(taskId);
    taskState.status = "partial";
    taskState.selectedAgent = bestPartialResult.agentName;
    taskState.output = bestPartialResult.output;
    taskState.error = undefined;
    ensureSwarmState(ctx, request.task).updatedAt = new Date().toISOString();
    publishSwarmState(ctx);

    const routingNote = bestPartialResult.routingInfo
      ? `\n↳ Auto-routed to ${bestPartialResult.agentName} (${bestPartialResult.routingInfo.confidence} confidence${bestPartialResult.routingInfo.matchedTerms.length > 0 ? `, matched: ${bestPartialResult.routingInfo.matchedTerms.join(", ")}` : ""})`
      : "";
    return {
      success: true,
      output: `[${bestPartialResult.agentName}]: ${bestPartialResult.output}${routingNote}`,
      metadata: {
        agentName: bestPartialResult.agentName,
        taskId,
        attemptedAgents,
        delegationSucceeded: true,
        delegationOutcome: "partial",
        partialFallback: true,
        ...(bestPartialResult.artifacts?.length ? { artifacts: bestPartialResult.artifacts } : {}),
        ...(bestPartialResult.terminalState ? { terminalState: bestPartialResult.terminalState } : {}),
        ...(bestPartialResult.routingInfo
          ? {
            routingReason: {
              confidence: bestPartialResult.routingInfo.confidence,
              matchedTerms: bestPartialResult.routingInfo.matchedTerms,
              score: bestPartialResult.routingInfo.score,
            },
          }
          : {}),
      },
    };
  }

  taskState.status = "failed";
  taskState.error = taskState.error ?? "No suitable agent completed the task.";
  clearTaskBids(taskId);
  ensureSwarmState(ctx, request.task).updatedAt = new Date().toISOString();
  publishSwarmState(ctx);

  // I9: Surface timeout cascades explicitly. When every attempt in this
  // delegation hit `terminalState === "timeout"`, the operator's per-agent
  // `turnTimeoutMs` is too tight for the chosen model to finish the work,
  // not a routing failure. Append (don't replace) so the rich per-attempt
  // diagnostic text from the sub-agent (e.g. "Partial progress before
  // interruption: ...") is preserved for the coordinator and audit log.
  const timeoutAttempts = taskState.attempts.filter((a) => a.terminalState === "timeout");
  const allAttemptsTimedOut = taskState.attempts.length > 0
    && timeoutAttempts.length === taskState.attempts.length;
  // I12: When every routed candidate was skipped due to the per-agent
  // delegation cap, that's the actual cause of failure — not routing.
  // Tell the coordinator plainly so it stops re-delegating the same work.
  const allCandidatesCapped = taskState.attempts.length === 0
    && cappedCandidates.length > 0;
  const baseError = taskState.error ?? "No suitable agent completed the task.";
  let errorBody = baseError;
  if (allAttemptsTimedOut) {
    errorBody = `${baseError}\n\nTimeout cascade: every delegated attempt hit its per-agent turnTimeoutMs (${timeoutAttempts.length} attempt(s) on ${[...new Set(timeoutAttempts.map((a) => a.agentName))].join(", ")}). The model did not finish within the configured budget — this is a timeout, not a routing failure. Either raise turnTimeoutMs for these agents in starlingai.json, switch them to a faster model, or split the task into smaller pieces. Do NOT re-delegate the same work in this turn.`;
  } else if (allCandidatesCapped) {
    errorBody = `Per-agent delegation cap exhausted: every routed candidate (${cappedCandidates.join(", ")}) has already been delegated to its per-turn maximum (${DEFAULT_MAX_AGENT_CALLS_PER_TURN} call(s)) earlier in this turn. This is NOT a routing failure — the same agents already ran for this work. Stop re-delegating to them. Either accept what those earlier delegations returned (look back at the prior parallel_delegate / delegate_to_agent results in this conversation), or escalate the task back to the user with what you have.`;
  }

  return {
    success: false,
    output: "",
    error: buildDelegationFailureMessage(title, errorBody),
    metadata: {
      taskId,
      attemptedAgents,
      delegationSucceeded: false,
      ...(allAttemptsTimedOut
        ? {
          delegationOutcome: "timeout_cascade",
          timeoutCascade: true,
          timedOutAgents: [...new Set(timeoutAttempts.map((a) => a.agentName))],
        }
        : {}),
      ...(allCandidatesCapped
        ? {
          delegationOutcome: "per_agent_cap_exhausted",
          perAgentCapExhausted: true,
          cappedCandidates: [...cappedCandidates],
        }
        : {}),
    },
  };
}

function formatSwarmState(state: SwarmState): string {
  const tasks = Object.values(state.tasks);
  if (tasks.length === 0) {
    return `Objective: ${state.objective}\nNo swarm tasks recorded yet.`;
  }

  const lines = tasks.map((task) => {
    const attempts = task.attempts
      .map((attempt) => {
        const flag = attempt.budgetExceeded ? `!budget(${(attempt.budgetBreaches ?? []).join("/")})` : "";
        return `${attempt.agentName}:${attempt.status}${flag ? ` ${flag}` : ""}`;
      })
      .join(", ");
    const totals = task.totals
      ? ` | totals: ${task.totals.totalTokens}tok, ${task.totals.toolCount}tools, ${task.totals.durationMs}ms`
      : "";
    return `- ${task.id} [${task.status}] ${task.title}${task.selectedAgent ? ` via ${task.selectedAgent}` : ""}${attempts ? ` | attempts: ${attempts}` : ""}${totals}`;
  });

  return `Objective: ${state.objective}\nUpdated: ${state.updatedAt}\nTasks:\n${lines.join("\n")}`;
}

function formatSwarmBudget(state: SwarmState): { output: string; metadata: Record<string, unknown> } {
  const tasks = Object.values(state.tasks);
  const budgets = getTaskBudgets();

  const overall = {
    attempts: 0,
    toolCount: 0,
    iterations: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    durationMs: 0,
  };
  const perAgent = new Map<string, typeof overall>();
  const breachedAttempts: Array<{ taskId: string; agentName: string; breaches: string[]; totalTokens: number; toolCount: number; durationMs: number }> = [];

  for (const task of tasks) {
    if (task.totals) {
      overall.attempts += task.totals.attempts;
      overall.toolCount += task.totals.toolCount;
      overall.iterations += task.totals.iterations;
      overall.promptTokens += task.totals.promptTokens;
      overall.completionTokens += task.totals.completionTokens;
      overall.totalTokens += task.totals.totalTokens;
      overall.durationMs += task.totals.durationMs;
    }
    for (const a of task.attempts) {
      const slot = perAgent.get(a.agentName) ?? {
        attempts: 0, toolCount: 0, iterations: 0,
        promptTokens: 0, completionTokens: 0, totalTokens: 0, durationMs: 0,
      };
      slot.attempts += 1;
      slot.toolCount += a.toolCount ?? 0;
      slot.iterations += a.iterations ?? 0;
      slot.promptTokens += a.promptTokens ?? 0;
      slot.completionTokens += a.completionTokens ?? 0;
      slot.totalTokens += a.totalTokens ?? 0;
      slot.durationMs += a.durationMs ?? 0;
      perAgent.set(a.agentName, slot);

      if (a.budgetExceeded) {
        breachedAttempts.push({
          taskId: task.id,
          agentName: a.agentName,
          breaches: a.budgetBreaches ?? [],
          totalTokens: a.totalTokens ?? 0,
          toolCount: a.toolCount ?? 0,
          durationMs: a.durationMs ?? 0,
        });
      }
    }
  }

  const lines: string[] = [];
  lines.push(`Objective: ${state.objective}`);
  lines.push(`Tasks tracked: ${tasks.length}`);
  lines.push("");
  lines.push("## Configured per-task budgets");
  lines.push(`- maxTokensPerTask: ${budgets.tokens > 0 ? budgets.tokens : "(unset)"}`);
  lines.push(`- maxToolCallsPerTask: ${budgets.toolCalls > 0 ? budgets.toolCalls : "(unset)"}`);
  lines.push(`- maxDurationMsPerTask: ${budgets.durationMs > 0 ? budgets.durationMs : "(unset)"}`);
  lines.push("");
  lines.push("## Overall totals");
  lines.push(`- attempts: ${overall.attempts}`);
  lines.push(`- iterations: ${overall.iterations}`);
  lines.push(`- toolCount: ${overall.toolCount}`);
  lines.push(`- promptTokens: ${overall.promptTokens}`);
  lines.push(`- completionTokens: ${overall.completionTokens}`);
  lines.push(`- totalTokens: ${overall.totalTokens}`);
  lines.push(`- durationMs: ${overall.durationMs}`);
  lines.push("");
  lines.push("## Per-agent breakdown");
  if (perAgent.size === 0) {
    lines.push("- (no attempts recorded yet)");
  } else {
    const sorted = [...perAgent.entries()].sort((a, b) => b[1].totalTokens - a[1].totalTokens);
    for (const [agent, totals] of sorted) {
      lines.push(`- ${agent}: ${totals.attempts} attempts, ${totals.totalTokens}tok, ${totals.toolCount}tools, ${totals.durationMs}ms`);
    }
  }
  lines.push("");
  lines.push("## Budget breaches");
  if (breachedAttempts.length === 0) {
    lines.push("- (none)");
  } else {
    for (const b of breachedAttempts) {
      lines.push(`- task ${b.taskId} via ${b.agentName}: ${b.breaches.join(", ")} | ${b.totalTokens}tok, ${b.toolCount}tools, ${b.durationMs}ms`);
    }
  }

  return {
    output: lines.join("\n"),
    metadata: {
      budgets,
      overall,
      perAgent: Object.fromEntries(perAgent),
      breaches: breachedAttempts,
    },
  };
}

function validateTaskGraphNodes(nodes: TaskGraphNodeInput[]): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();

  for (const node of nodes) {
    if (!node.id?.trim()) issues.push("Each task-graph node needs a non-empty id.");
    if (ids.has(node.id)) issues.push(`Duplicate task-graph node id: ${node.id}`);
    ids.add(node.id);
    if (!node.task?.trim()) issues.push(`Task-graph node '${node.id}' is missing its task.`);
  }

  for (const node of nodes) {
    for (const dep of node.dependsOn ?? []) {
      if (!ids.has(dep)) issues.push(`Task-graph node '${node.id}' depends on unknown node '${dep}'.`);
      if (dep === node.id) issues.push(`Task-graph node '${node.id}' cannot depend on itself.`);
    }
  }

  return issues;
}

registerTool({
  name: "get_swarm_state",
  description: "Read the current turn-local swarm state, including tracked sub-tasks, statuses, attempts, and selected agents.",
  parameters: {
    type: "object",
    properties: {},
  },
  async execute(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const state = ensureSwarmState(ctx, "Current turn");
    publishSwarmState(ctx);
    return {
      success: true,
      output: formatSwarmState(state),
      metadata: { swarmState: state },
    };
  },
});

registerTool({
  name: "get_swarm_budget",
  description: "Aggregate token, tool-call, and wall-clock spending across all swarm tasks this turn. Shows configured per-task budgets, overall totals, per-agent breakdown, and any attempts that breached a budget.",
  parameters: {
    type: "object",
    properties: {},
  },
  async execute(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const state = ensureSwarmState(ctx, "Current turn");
    const { output, metadata } = formatSwarmBudget(state);
    return {
      success: true,
      output,
      metadata,
    };
  },
});

registerTool({
  name: "run_task_graph",
  description: "Execute a dependency-aware swarm task graph. Ready nodes run in parallel, dependent nodes wait for prerequisites, and failed nodes can fall back to alternative agents.",
  parameters: {
    type: "object",
    properties: {
      objective: {
        type: "string",
        description: "Optional swarm objective label for the graph run.",
      },
      nodes: {
        type: "array",
        description: "Task graph nodes with ids, dependencies, agent selection, and optional fallback agents.",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            agentName: { type: "string" },
            task: { type: "string" },
            context: { type: "string" },
            dependsOn: { type: "array", items: { type: "string" } },
            fallbackAgents: { type: "array", items: { type: "string" } },
            routingQuery: { type: "string" },
            skillMatchThreshold: { type: "number" },
          },
          required: ["id", "task"],
        },
      },
    },
    required: ["nodes"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const rawNodes = Array.isArray(args["nodes"]) ? args["nodes"] as TaskGraphNodeInput[] : [];
    if (rawNodes.length === 0) {
      return { success: false, output: "", error: "nodes array must not be empty" };
    }
    if (rawNodes.length > 8) {
      return { success: false, output: "", error: "Task graphs are limited to 8 nodes per turn" };
    }

    const issues = validateTaskGraphNodes(rawNodes);
    if (issues.length > 0) {
      return { success: false, output: "", error: issues.join(" ") };
    }

    const swarmState = ensureSwarmState(ctx, String(args["objective"] ?? "Swarm task graph"));
    swarmState.objective = String(args["objective"] ?? swarmState.objective);
    publishSwarmState(ctx);

    const delegatedCtx = withDelegationFanoutAllowance(ctx, rawNodes.map((node) => node.agentName), rawNodes.length);

    const remaining = new Map(rawNodes.map((node) => [node.id, node]));
    const completed = new Set<string>();
    const failed = new Set<string>();
    const blocked = new Set<string>();
    const graphId = `graph_${Date.now()}_${Object.keys(swarmState.tasks).length}`;

    for (const node of rawNodes) {
      getOrCreateSwarmTask(ctx, node.id, node.title ?? summarizeText(node.task, 80), node.dependsOn ?? []);
    }

    // Emit graph-level lifecycle event
    emitSwarmEvent("graph_started", {
      sessionId: ctx.sessionId,
      taskId: graphId,
      task: String(args["objective"] ?? "Swarm task graph"),
      data: {
        nodeCount: rawNodes.length,
        nodeIds: rawNodes.map(n => n.id),
      },
    });

    const active = new Map<string, Promise<{ node: TaskGraphNodeInput; result: ToolResult }>>();

    const blockFailedDependents = () => {
      for (const [nodeId, node] of [...remaining.entries()]) {
        if ((node.dependsOn ?? []).some((dep) => failed.has(dep) || blocked.has(dep))) {
          const task = getOrCreateSwarmTask(ctx, nodeId, node.title ?? summarizeText(node.task, 80), node.dependsOn ?? []);
          task.status = "blocked";
          task.error = "Blocked by failed dependency.";
          publishSwarmState(ctx);
          blocked.add(nodeId);
          remaining.delete(nodeId);

          emitSwarmEvent("graph_node_blocked", {
            sessionId: ctx.sessionId,
            taskId: nodeId,
            data: { graphId, reason: "dependency_failed" },
          });
        }
      }
    };

    const startReadyNodes = () => {
      const ready = [...remaining.values()].filter((node) => (node.dependsOn ?? []).every((dep) => completed.has(dep)));

      for (const node of ready) {
        remaining.delete(node.id);

        emitSwarmEvent("graph_node_ready", {
          sessionId: ctx.sessionId,
          taskId: node.id,
          agentName: node.agentName,
          task: node.task,
          data: {
            graphId,
            dependsOn: node.dependsOn ?? [],
            completedDeps: [...completed],
          },
        });

        active.set(node.id, executeDelegationWithFallback({
          agentName: node.agentName,
          task: node.task,
          context: node.context,
          fallbackAgents: node.fallbackAgents,
          routingQuery: node.routingQuery,
          skillMatchThreshold: node.skillMatchThreshold,
          taskId: node.id,
          taskTitle: node.title,
          dependsOn: node.dependsOn,
        }, delegatedCtx).then((result) => ({ node, result })));
      }
    };

    while (remaining.size > 0 || active.size > 0) {
      blockFailedDependents();

      if (active.size === 0) {
        startReadyNodes();
      }

      if (active.size === 0) {
        if (remaining.size === 0) {
          break;
        }

        for (const [nodeId, node] of remaining.entries()) {
          const task = getOrCreateSwarmTask(ctx, nodeId, node.title ?? summarizeText(node.task, 80), node.dependsOn ?? []);
          task.status = "blocked";
          task.error = task.error ?? "Task graph could not make progress; check dependencies for cycles.";
          publishSwarmState(ctx);
          blocked.add(nodeId);

          emitSwarmEvent("graph_node_blocked", {
            sessionId: ctx.sessionId,
            taskId: nodeId,
            data: { graphId, reason: "cycle_detected" },
          });
        }
        remaining.clear();
        break;
      }

      const { node, result } = await Promise.race(active.values());
      active.delete(node.id);

      if (result.success) {
        completed.add(node.id);
      } else {
        failed.add(node.id);
      }

      blockFailedDependents();
      startReadyNodes();
    }

    // Emit graph completion event
    emitSwarmEvent("graph_completed", {
      sessionId: ctx.sessionId,
      taskId: graphId,
      data: {
        completedNodes: [...completed],
        failedNodes: [...failed],
        blockedNodes: [...blocked],
        success: failed.size === 0,
      },
    });

    const summary = rawNodes.map((node) => {
      const task = swarmState.tasks[node.id];
      return `- ${node.id} [${task?.status ?? "unknown"}] ${task?.selectedAgent ?? node.agentName ?? "unassigned"}`;
    }).join("\n");

    return {
      success: failed.size === 0,
      output: `Swarm task graph complete.\n${summary}\n\n${formatSwarmState(swarmState)}`,
      metadata: { completed: [...completed], failed: [...failed], blocked: [...blocked], swarmState },
    };
  },
});

registerTool({
  name: "create_ephemeral_agent",
  description: [
    "Design and immediately run a purpose-built single-use agent for a task that no configured agent covers.",
    "Provide the agent's full spec inline: system prompt, tool list, model, and the task to run.",
    "The agent is ephemeral — it runs once and is discarded.",
    "Use this when semantic agent discovery returns no suitable high-confidence specialist for the original task.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      agentName: {
        type: "string",
        description: "Descriptive name for logging (e.g. 'judicative_researcher', 'tax_law_analyst')",
      },
      description: {
        type: "string",
        description: "One-line description of what this agent does",
      },
      systemPrompt: {
        type: "string",
        description: "Full system prompt for the agent — include role, domain expertise, and RULES for tool use limits",
      },
      tools: {
        type: "array",
        items: { type: "string" },
        description: `Tools to grant. Allowed values: ${[...GRANTABLE_TOOLS].join(", ")}`,
      },
      model: {
        type: "object",
        description: "Optional model override. Example: { \"primary\": \"lmstudio/qwen3.5-9b\", \"temperature\": 0.1 }",
        properties: {
          primary: { type: "string" },
          temperature: { type: "number" },
          maxTokens: { type: "number" },
        },
      },
      maxIterations: {
        type: "number",
        description: "Max tool-call iterations before the agent is forced to stop (default: 5, max: 10)",
      },
      timeoutMs: {
        type: "number",
        description: "Wall-clock timeout in milliseconds for the ephemeral agent run (minimum: 60000, maximum: 600000). Defaults to 60 s if omitted. Use 300000 for research tasks with multiple web_search iterations.",
      },
      task: {
        type: "string",
        description: "The task or question for the ephemeral agent to complete",
      },
      context: {
        type: "string",
        description: "Optional background context to pass to the agent",
      },
    },
    required: ["agentName", "systemPrompt", "tools", "task"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const agentName = String(args["agentName"] ?? "").trim().replace(/\W+/g, "_").slice(0, 64);
    const task = String(args["task"] ?? "").trim();
    const context = args["context"] ? String(args["context"]) : undefined;
    const systemPrompt = String(args["systemPrompt"] ?? "").trim();

    if (!agentName || !task || !systemPrompt) {
      return { success: false, output: "", error: "agentName, systemPrompt, and task are required" };
    }

    // Validate and filter tool list
    const requestedTools = Array.isArray(args["tools"]) ? args["tools"].map(String) : [];
    const tools = requestedTools.filter(t => GRANTABLE_TOOLS.has(t));
    const rejected = requestedTools.filter(t => !GRANTABLE_TOOLS.has(t));
    if (rejected.length > 0) {
      // Non-fatal: log and proceed with the valid subset
      ctx; // used for sessionId below
    }

    const policyIssues = validateEphemeralToolSelection(tools);
    if (policyIssues.length > 0) {
      logAudit("ephemeral_agent_rejected", {
        agentName,
        requestedTools,
        grantedTools: tools,
        rejectedTools: rejected,
        reasons: policyIssues,
      }, { sessionId: ctx.sessionId, severity: "warn", channel: "agent-factory" });

      return {
        success: false,
        output: "",
        error: policyIssues.join(" "),
        metadata: { agentName, rejectedTools: rejected, grantedTools: tools },
      };
    }

    // Build model config
    const modelOverride = args["model"] && typeof args["model"] === "object"
      ? args["model"] as Record<string, unknown>
      : {};

    const maxIter = Math.min(10, Math.max(1, Number(args["maxIterations"] ?? 5) || 5));
    // Honour an explicit timeoutMs from the caller (min 60 s, max 10 min).
    // The leaf-agent default of 60 s is far too short for research tasks with
    // multiple web_search iterations — callers should pass 300000 for those.
    const rawTimeoutMs = typeof args["timeoutMs"] === "number" ? args["timeoutMs"] : undefined;
    const resolvedTimeoutMs = rawTimeoutMs !== undefined
      ? Math.min(600_000, Math.max(60_000, rawTimeoutMs))
      : undefined;

    const inlineConfig = {
      description: String(args["description"] ?? agentName),
      capabilities: [],
      tags: [],
      systemPrompt,
      tools,
      maxIterations: maxIter,
      model: Object.keys(modelOverride).length > 0 ? {
        primary: modelOverride["primary"] ? String(modelOverride["primary"]) : undefined,
        temperature: typeof modelOverride["temperature"] === "number" ? modelOverride["temperature"] : undefined,
        maxTokens: typeof modelOverride["maxTokens"] === "number" ? modelOverride["maxTokens"] : undefined,
      } : undefined,
      ...(resolvedTimeoutMs !== undefined ? { turnTimeoutMs: resolvedTimeoutMs } : {}),
      // Ephemeral agents run in-process: the agent-worker container cannot reach
      // gateway-bound tools (web_search, Playwright, MCP). Disable containerization
      // so tool calls resolve through the live gateway runtime instead.
      container: { disabled: true, enabled: false, image: "starlingai/agent-worker:dev", memoryMb: 512, cpus: 0.5, timeoutMs: 60_000 },
    };

    const ephemeralName = `ephemeral:${agentName}`;

    const result = await runSubAgent({
      agentName: ephemeralName,
      task,
      context,
      parentSessionId: ctx.sessionId,
      workspacePath: ctx.workspacePath,
      signal: ctx.signal,
      approvalCallback: ctx.approvalCallback,
      humanInLoopSteps: ctx.humanInLoopSteps,
      inlineConfig,
      _workflowExecutionStack: ctx._workflowExecutionStack,
      // Note: ephemeral agents have their own maxIter baked into inlineConfig; ctx.maxIterationsOverride is intentionally not forwarded here.
    });

    const note = rejected.length > 0 ? ` [Note: tools ${rejected.join(", ")} were rejected as not grantable]` : "";
    return {
      success: true,
      output: `[ephemeral:${agentName}]: ${result}${note}`,
      metadata: { agentName: ephemeralName, grantedTools: tools, rejectedTools: rejected },
    };
  },
});

// ─── list_agents ──────────────────────────────────────────────────────────────
// IMPORTANT: list_agents now requires a query and routes through the same
// semantic + keyword engine as search_agents. It never dumps the full catalog.
// This prevents context bloat when the agent registry is large (56+ agents
// → 70 KB of text → LLM prefill timeout). Use search_agents when you only
// want the top match; use list_agents when you want up to 10 candidates for
// manual selection. Both tools require a query.

registerTool({
  name: "list_agents",
  description: "Search available sub-agents by semantic capability match and return up to 10 candidates — use this when you need to browse several candidates before choosing. Requires a natural-language query describing the task. NEVER dumps the full catalog. Prefer search_agents when you only need the single best match.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural-language description of the task or capability you need. Required — the tool does semantic search, not a flat dump.",
      },
    },
    required: ["query"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const raw = String(args["query"] ?? "").trim();
    if (!raw) {
      return {
        success: false,
        output: "",
        error: "query is required. Describe the task or capability you need — list_agents searches semantically, it does not dump the full catalog. Use search_agents for a single best-match lookup.",
      };
    }

    // Route through the same semantic+keyword engine as search_agents but
    // return up to 10 candidates and use "low" as minimum confidence so
    // browse-mode callers see the full competitive set.
    const resolution = await resolveAgentRouting(raw, {
      minConfidence: "low",
      excludeAgents: ctx.currentAgentName ? [ctx.currentAgentName] : undefined,
      allowedAgents: ctx.allowedAgents,
    });

    const allCandidates = [
      ...resolution.results,
      ...resolution.weakCandidates,
    ].slice(0, 10);

    if (allCandidates.length === 0) {
      const scopeNote = ctx.allowedAgents
        ? ` (this scene restricts delegation to: ${ctx.allowedAgents.join(", ")})`
        : "";
      return {
        success: true,
        output: `No agents matched "${raw}"${scopeNote}. Use create_ephemeral_agent to build a purpose-built specialist for this task.`,
        metadata: {
          query: raw,
          resultCount: 0,
          routingMode: resolution.mode,
        },
      };
    }

    const circuitNote = resolution.trippedAgents.length > 0
      ? `\n\n⚠ Circuit-open agents excluded from results: ${resolution.trippedAgents.join(", ")}`
      : "";

    const topCandidate = allCandidates[0];
    const topIsStrong = topCandidate &&
      (topCandidate.confidence === "high" ||
        (topCandidate.confidence === "medium" && topCandidate.score >= 0.5));
    const nextActionLine = topIsStrong
      ? `➡ NEXT ACTION: Call delegate_to_agent(agentName="${topCandidate.name}", task="<your task>") NOW.`
      : `ℹ Review the candidates below and pick the most relevant, or use create_ephemeral_agent if none fit.`;

    return {
      success: true,
      output: `${nextActionLine}\n\nAgents matching "${raw}" [${resolution.mode} search, ${allCandidates.length} result(s)]:\n\n${allCandidates.map(formatRoutingCandidate).join("\n\n")}${circuitNote}`,
      metadata: {
        query: raw,
        resultCount: allCandidates.length,
        routingMode: resolution.mode,
        topResult: allCandidates[0]?.name ?? null,
      },
    };
  },
});

// ─── search_agents ────────────────────────────────────────────────────────────
// Semantic discovery over agent capabilities — keeps orchestrator context small
// when the agent registry grows large.

registerTool({
  name: "search_agents",
  description: "Search available sub-agents by semantic capability match. Returns only suitable agents above the confidence threshold — much lighter than list_agents when the registry is large. If no suitable match is returned, stop discovery and delegate autonomously or use create_ephemeral_agent.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural-language capability or task description to match semantically against specialist agents",
      },
      minConfidence: {
        type: "string",
        enum: ["high", "medium", "low"],
        description: "Minimum confidence required for results. Default is medium. Use low only when explicitly inspecting weak candidates, not as an automatic no-match retry.",
      },
    },
    required: ["query"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const raw = String(args["query"] ?? "").trim();
    if (!raw) return { success: false, output: "", error: "query is required" };
    const minConfidence = args["minConfidence"] === "low" ? "low" : "medium";
    const currentAgentName = typeof ctx.currentAgentName === "string" && ctx.currentAgentName.trim().length > 0
      ? ctx.currentAgentName.trim()
      : undefined;
    // Route WITHOUT excludeAgents so the invoking agent can still appear in
    // rawResolution — we need that to detect self-exclusion.  The manual
    // filter below removes it before the result is returned to the caller.
    const rawResolution = await resolveAgentRouting(raw, {
      minConfidence,
      allowedAgents: ctx.allowedAgents,
    });
    const selfExcluded = currentAgentName
      ? rawResolution.results.some((candidate) => candidate.name === currentAgentName)
        || rawResolution.weakCandidates.some((candidate) => candidate.name === currentAgentName)
      : false;
    const resolution = currentAgentName
      ? {
          ...rawResolution,
          results: rawResolution.results.filter((candidate) => candidate.name !== currentAgentName),
          weakCandidates: rawResolution.weakCandidates.filter((candidate) => candidate.name !== currentAgentName),
        }
      : rawResolution;

    logAudit("agent_routing_evaluated", {
      query: raw,
      minConfidence,
      mode: resolution.mode,
      resultCount: resolution.results.length,
      weakCount: resolution.weakCandidates.length,
      gated: resolution.gated,
      trippedAgents: resolution.trippedAgents,
      excludedAgents: resolution.excludedAgents ?? [],
      allLowConfidence: resolution.allLowConfidence,
      topResult: resolution.results[0]?.name ?? null,
    }, { sessionId: ctx.sessionId, channel: "agent-routing" });

    const circuitNote = resolution.trippedAgents.length > 0
      ? `\n⚠ Circuit breakers open (excluded from routing): ${resolution.trippedAgents.join(", ")}`
      : "";
    const selfExclusionNote = ctx.currentAgentName
      ? `\nℹ Self excluded from routing suggestions: ${ctx.currentAgentName}`
      : "";

    if (resolution.results.length === 0 && resolution.weakCandidates.length === 0) {
      // Complete routing failure — auto-record a capability gap for self-improvement pipeline
      recordCapabilityGap({
        description: `No agent found for routing query: "${raw}"`,
        exampleInput: raw,
        sessionId: ctx.sessionId,
      }).catch(() => { /* self-improvement may be disabled */ });
      return {
        success: true,
        output: `No agents matched "${raw}". Do not call search_agents again for this turn. Delegate without an agentName so autonomous routing can bid on the original task, or use create_ephemeral_agent if this is a new capability.${circuitNote}${selfExclusionNote}`,
        metadata: {
          query: raw,
          minConfidence,
          routingMode: resolution.mode,
          resultCount: 0,
          weakCount: 0,
          topResult: null,
        },
      };
    }

    if (resolution.results.length === 0) {
      const topCandidates = resolution.weakCandidates.map((candidate) => `- ${candidate.name} (${candidate.confidence})`).join("\n");
      // Only weak candidates — record gap so the pipeline can design a better specialist
      recordCapabilityGap({
        description: `No agent met minimum confidence for routing query: "${raw}" (only low-confidence candidates)`,
        exampleInput: raw,
        sessionId: ctx.sessionId,
      }).catch(() => { /* self-improvement may be disabled */ });
      return {
        success: true,
        output: `No agents matched "${raw}" with ${minConfidence} confidence or better. Do not call search_agents again for this turn. Delegate without an agentName so autonomous routing can bid on the original task, delegate to a known coordinator, or use create_ephemeral_agent if this is a new capability.${circuitNote}${selfExclusionNote}\n\nTop weak candidates:\n${topCandidates}`,
        metadata: {
          query: raw,
          minConfidence,
          routingMode: resolution.mode,
          resultCount: 0,
          weakCount: resolution.weakCandidates.length,
          topResult: null,
        },
      };
    }

    const topAgent = resolution.results[0]!;
    const lowConfidenceWarning = resolution.allLowConfidence
      ? `\n⚠ LOW CONFIDENCE: No specialist found with medium+ confidence for this query. Consider using create_ephemeral_agent for a purpose-built agent, or ask the user to clarify the task before delegating.`
      : "";
    const resultSelfExclusionNote = selfExcluded && currentAgentName
      ? `\nℹ Self excluded from routing suggestions: ${currentAgentName}`
      : "";
    // I10: Only emit the assertive "NEXT ACTION: Call delegate_to_agent(<topAgent>)"
    // pointer when the top match is genuinely strong. Low-confidence top results
    // (or scores < 0.5) routinely surface bad agents — e.g. accessibility_tester
    // for "research news headlines" — and the imperative wording pushed weaker
    // models to delegate to the wrong specialist. For weak top results, present
    // the candidate list neutrally and let the LLM choose, including the option
    // to call list_agents or create_ephemeral_agent.
    const topResultIsStrong = topAgent.confidence === "high"
      || (topAgent.confidence === "medium" && topAgent.score >= 0.5);
    const nextActionLine = topResultIsStrong
      ? `➡ NEXT ACTION: Call delegate_to_agent(agentName="${topAgent.name}", task="<your task>") NOW. Do NOT call search_agents again.`
      : `ℹ Best available match is ${topAgent.name} (${topAgent.confidence} confidence, score ${topAgent.score.toFixed(2)}) — review the candidate list below and pick the most relevant agent, or use create_ephemeral_agent if none fit. Do NOT call search_agents again.`;
    return {
      success: true,
      output: `${nextActionLine}\n\nAgents matching "${raw}" [${resolution.mode} search, ${resolution.results.length} result(s)]:\n\n${resolution.results.map(formatRoutingCandidate).join("\n\n")}${lowConfidenceWarning}${circuitNote}${resultSelfExclusionNote}`,
      metadata: {
        query: raw,
        minConfidence,
        routingMode: resolution.mode,
        resultCount: resolution.results.length,
        weakCount: resolution.weakCandidates.length,
        topResult: topAgent.name,
        topResultConfidence: topAgent.confidence,
        topResultScore: topAgent.score,
        suggestedFallbackAgents: resolution.results.slice(1, 4).map((candidate) => candidate.name),
      },
    };
  },
});

// ─── search_tools ────────────────────────────────────────────────────────────
// Semantic search over the registered tool catalog. Keeps sub-agent context
// small: instead of printing the full tool list (which can exceed 50 KB when
// MCP surfaces are loaded), an agent can discover which tools are available
// for a specific sub-task without blowing up its context window.

registerTool({
  name: "search_tools",
  description: "Search available tools by semantic similarity to a task description. Returns the top-matching tool names and descriptions. Use this to discover which tools are available for a sub-task instead of relying on the static tool list in the system prompt.",
  embeddingDescription: "find tools, discover capabilities, what tools can do X, which tool handles Y, tool catalog search, tool discovery",
  costHint: "low" as const,
  latencyHint: "low" as const,
  parameters: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "Natural-language description of what you want to do. The tool returns the most semantically similar registered tools.",
      },
      topN: {
        type: "number",
        description: "Maximum number of results to return. Defaults to 8.",
      },
    },
    required: ["query"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const query = String(args["query"] ?? "").trim();
    if (!query) {
      return { success: false, output: "", error: "query is required" };
    }
    const topN = Math.min(20, Math.max(1, Number(args["topN"] ?? 8)));

    const handlers = getAllTools();
    if (handlers.length === 0) {
      return { success: true, output: "No tools are available in this context." };
    }

    // Single shared semantic-search path — uses the long-lived per-tool
    // embedding cache that warmToolEmbeddings populates, with a keyword
    // fallback when the embedding provider is unavailable.  Avoids the
    // earlier double-walk pattern (rerankToolsForTask + per-tool
    // computeQueryEmbedding) which re-embedded each tool's text via the
    // short-TTL query cache instead of the proper tool cache.
    const ranked = await searchToolsByEmbedding(query, topN, handlers);

    if (ranked.length === 0) {
      return {
        success: true,
        output: `No tools matched "${query}". Check that the required tools are in your tool list for this run.`,
        metadata: { query, resultCount: 0 },
      };
    }

    const mode = ranked[0]?.mode ?? "empty";
    const lines = ranked.map((r) => `- **${r.name}**: ${r.description}`);
    return {
      success: true,
      output: `Tools matching "${query}" (${ranked.length} result${ranked.length === 1 ? "" : "s"}, ${mode} mode):\n\n${lines.join("\n")}`,
      metadata: { query, resultCount: ranked.length, mode, topResult: ranked[0]?.name ?? null },
    };
  },
});

// ─── delegate_to_agent ────────────────────────────────────────────────────────

registerTool({
  name: "delegate_to_agent",
  description: "Delegate a task to a specialized sub-agent. When agentName is omitted the swarm's autonomous bidding system selects the best specialist — prefer this for tasks where the right specialist is not obvious. Provide agentName only when you already know from prior context exactly which specialist to use.",
  parameters: {
    type: "object",
    properties: {
      agentName: {
        type: "string",
        description: "Name of the sub-agent to invoke. OPTIONAL — omit to let the swarm bidding system pick the best specialist automatically.",
      },
      task: {
        type: "string",
        description: "The task or question for the sub-agent to complete",
      },
      context: {
        type: "string",
        description: "Optional background context to provide to the sub-agent (e.g. data gathered so far)",
      },
      fallbackAgents: {
        type: "array",
        items: { type: "string" },
        description: "Optional ordered fallback agents to try automatically if the primary agent fails or returns a weak result.",
      },
      routingQuery: {
        type: "string",
        description: "Optional routing query used to auto-select fallback agents when the primary path fails.",
      },
      skillMatchThreshold: {
        type: "number",
        description: "Optional 0-1 threshold. If the best auto-selected specialist scores below this value, generate an ephemeral agent instead.",
      },
    },
    required: ["task"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    // agentName is now optional — omitting it triggers undirected swarm bidding
    const requestedAgentName = args["agentName"] ? String(args["agentName"]).trim() : "";
    const task = String(args["task"] ?? "").trim();
    const context = args["context"] ? String(args["context"]) : undefined;
    const explicitFallbackAgents = Array.isArray(args["fallbackAgents"]) ? args["fallbackAgents"].map(String) : undefined;
    const routingQuery = args["routingQuery"] ? String(args["routingQuery"]) : undefined;
    const skillMatchThreshold = typeof args["skillMatchThreshold"] === "number" ? args["skillMatchThreshold"] : undefined;

    if (!task) {
      return { success: false, output: "", error: "task is required" };
    }

    const pinnedAgentName = !requestedAgentName ? getPinnedAgentForTask(task) : null;
    const rawAgentName = requestedAgentName || pinnedAgentName || "";
    const primaryValidation = sanitizeDelegationAgentList(rawAgentName ? [rawAgentName] : undefined, ctx);
    const agentName = primaryValidation.valid[0] ?? "";

    // Enforce per-scene agent scope only when an explicit agent was requested
    if (primaryValidation.disallowed.length > 0) {
      return {
        success: false,
        output: "",
        error: `Agent '${primaryValidation.disallowed[0]}' is not permitted in this scene. Allowed agents: ${ctx.allowedAgents?.join(", ") ?? ""}`,
      };
    }

    if (primaryValidation.invalid.length > 0) {
      // Ignore unknown explicit agent names so the task can still recover via
      // fallback agents or normal routing.
    }

    const rawFallbackAgents = explicitFallbackAgents?.length
      ? explicitFallbackAgents
      : agentName === "swarm_maintainer"
        ? ["integration_builder", "coder", "prompt_optimizer"].filter((candidate) => !ctx.allowedAgents || ctx.allowedAgents.includes(candidate))
        : undefined;
    const fallbackValidation = sanitizeDelegationAgentList(rawFallbackAgents, ctx);
    const fallbackAgents = fallbackValidation.valid.length > 0
      ? fallbackValidation.valid
      : undefined;

    if (pinnedAgentName && pinnedAgentName !== requestedAgentName) {
      logAudit("delegate_agent_pinned", {
        requestedAgentName: requestedAgentName || null,
        pinnedAgentName,
        taskPreview: summarizeText(task, 120),
      }, { sessionId: ctx.sessionId });
    }

    const enrichedContext = agentName
      ? maybeEnrichServerDelegationContext(agentName, task, context)
      : context;

    return executeDelegationWithFallback({
      agentName,
      task,
      context: enrichedContext,
      fallbackAgents,
      routingQuery,
      skillMatchThreshold,
      taskTitle: summarizeText(task, 80),
    }, ctx);
  },
});

// ─── swarm_delegate ────────────────────────────────────────────────────────────
//
// Undirected delegation only — no agentName parameter. The swarm routing system
// (keyword + embedding + outcome-weighted bidding) always picks the specialist.
// Use this when you do not yet know which agent is best for the task, or when
// you want the swarm to self-select based on current availability and skill scores.
// Prefer delegate_to_agent only when you already know from context which exact
// specialist to invoke.

registerTool({
  name: "swarm_delegate",
  description: "Delegate a task to the swarm without naming a specific agent. The autonomous routing system (embedding match + outcome-weighted bidding) selects the best available specialist. Use this when the ideal specialist is not obvious — the swarm almost always picks better than an LLM guess at this point in the conversation. For tasks where you already know the exact right specialist from prior context, use delegate_to_agent instead.",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "The task or question for a specialist to complete. Write this as a clear, self-contained assignment — the routing system uses its full text to pick the agent.",
      },
      context: {
        type: "string",
        description: "Optional background context — prior findings, data already gathered, or constraints the specialist should know.",
      },
      routingQuery: {
        type: "string",
        description: "Optional override query used for routing. Defaults to the task text. Provide this when the task text contains a lot of detail that might obscure the core capability needed.",
      },
      skillMatchThreshold: {
        type: "number",
        description: "Optional 0–1 threshold. If the best-matched specialist scores below this value an ephemeral agent is synthesised instead. Defaults to the swarm's global threshold.",
      },
    },
    required: ["task"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const task = String(args["task"] ?? "").trim();
    const context = args["context"] ? String(args["context"]) : undefined;
    const routingQuery = args["routingQuery"] ? String(args["routingQuery"]) : undefined;
    const skillMatchThreshold = typeof args["skillMatchThreshold"] === "number" ? args["skillMatchThreshold"] : undefined;

    if (!task) {
      return { success: false, output: "", error: "task is required" };
    }

    // Undirected — no agentName — the routing system owns the choice.
    return executeDelegationWithFallback({
      task,
      context,
      routingQuery,
      skillMatchThreshold,
      taskTitle: summarizeText(task, 80),
    }, ctx);
  },
});

// ─── parallel_delegate ────────────────────────────────────────────────────────

registerTool({
  name: "parallel_delegate",
  description: "Run multiple independent sub-agent tasks in parallel and collect all results. Use when the orchestrator needs outputs from 2–5 independent partitions. Repeating the same agent is allowed when each task is a distinct partition of the work. Returns all results concatenated with separators.",
  parameters: {
    type: "object",
    properties: {
      tasks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            agentName: { type: "string", description: "Name of the sub-agent to invoke" },
            task: { type: "string", description: "Task description for this agent" },
            context: { type: "string", description: "Optional context to pass to this agent" },
            fallbackAgents: { type: "array", items: { type: "string" }, description: "Optional fallback agents for this task" },
            routingQuery: { type: "string", description: "Optional routing query for self-healing fallback selection" },
            skillMatchThreshold: { type: "number", description: "Optional 0-1 threshold for generating an ephemeral agent when no specialist matches strongly enough" },
          },
          required: ["task"],
        },
        description: "Array of independent tasks to run in parallel (max 5)",
      },
    },
    required: ["tasks"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const tasks = Array.isArray(args["tasks"])
      ? (args["tasks"] as Array<{ agentName?: string; task: string; context?: string; fallbackAgents?: string[]; routingQuery?: string; skillMatchThreshold?: number }>)
      : [];

    if (tasks.length === 0) return { success: false, output: "", error: "tasks array must not be empty" };
    if (tasks.length > 5) return { success: false, output: "", error: "Maximum 5 parallel tasks allowed" };

    const normalizedTasks = tasks.map((taskSpec) => {
      const rawAgentName = taskSpec.agentName ? String(taskSpec.agentName).trim() : "";
      const primaryValidation = sanitizeDelegationAgentList(rawAgentName ? [rawAgentName] : undefined, ctx);
      if (primaryValidation.disallowed.length > 0) {
        return {
          error: `Agent '${primaryValidation.disallowed[0]}' is not permitted in this scene. Allowed: ${ctx.allowedAgents?.join(", ") ?? ""}`,
        };
      }
      if (primaryValidation.invalid.length > 0) {
        // Ignore unknown explicit agent names so the task can still recover via
        // fallback agents or normal routing.
      }

      const fallbackValidation = sanitizeDelegationAgentList(taskSpec.fallbackAgents, ctx);
      if (fallbackValidation.disallowed.length > 0) {
        return {
          error: `Agent '${fallbackValidation.disallowed[0]}' is not permitted in this scene. Allowed: ${ctx.allowedAgents?.join(", ") ?? ""}`,
        };
      }

      return {
        ...taskSpec,
        agentName: primaryValidation.valid[0],
        fallbackAgents: fallbackValidation.valid.length > 0 ? fallbackValidation.valid : undefined,
      };
    });

    const normalizationError = normalizedTasks.find((taskSpec): taskSpec is { error: string } => "error" in taskSpec);
    if (normalizationError && normalizationError.error) {
      return { success: false, output: "", error: normalizationError.error };
    }

    const runnableTasks: Array<{
      agentName: string | undefined;
      task: string;
      context?: string;
      fallbackAgents: string[] | undefined;
      routingQuery?: string;
      skillMatchThreshold?: number;
    }> = [];
    for (const taskSpec of normalizedTasks) {
      if ("error" in taskSpec) {
        continue;
      }
      runnableTasks.push(taskSpec);
    }

    logAudit(
      "parallel_delegate_started",
      { taskCount: tasks.length, agents: runnableTasks.map((taskSpec) => taskSpec.agentName ?? "auto") },
      { sessionId: ctx.sessionId }
    );

    const delegatedCtx = withDelegationFanoutAllowance(
      ctx,
      runnableTasks.map((taskSpec) => taskSpec.agentName),
      tasks.length,
    );
    const taskIds = allocateParallelTaskIds(delegatedCtx, runnableTasks.length);

    const results = await Promise.all(
      runnableTasks.map((taskSpec, index) => executeDelegationWithFallback({
        ...taskSpec,
        taskId: taskIds[index],
        taskTitle: summarizeText(taskSpec.task, 80),
      }, delegatedCtx))
    );

    const formatted = results.map((result, index) => {
      const label = tasks[index]?.agentName ?? `task_${index + 1}`;
      if (result.success) return `**[${label}]**:\n${result.output}`;
      return `**[${label}]** (failed): ${result.error ?? "unknown error"}`;
    });

    const succeeded = results.filter(result => result.success).length;

    return {
      success: succeeded > 0,
      output: formatted.join("\n\n---\n\n"),
      metadata: { taskCount: tasks.length, succeeded, failed: tasks.length - succeeded },
    };
  },
});
