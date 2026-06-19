import { randomUUID } from "node:crypto";
import { requestApprovalViaChannel } from "../approval/index.js";
import { archiveSession, createSession } from "../agent/session.js";
import { runSubAgentWithStats } from "../agent/sub-agent.js";
import { runTurn, collectTurnArtifactAttachments } from "../agent/runtime.js";
import { getConfig } from "../config/loader.js";
import { getJobDefinition, listAllJobs, resolveJobSteps, type JobSummary } from "../credentials/jobs.js";
import { getScene, listAllScenes, type SceneSummary } from "../credentials/scenes.js";
import { getEmbeddingProvider } from "../providers/index.js";
import { registerTool, type SwarmTaskState, type ToolContext, type ToolResult } from "./registry.js";

type WorkflowType = "scene" | "job";

interface WorkflowCatalogEntry {
  key: string;
  name: string;
  workflowType: WorkflowType;
  description: string;
  source: "config" | "store";
  task?: string;
  params?: Record<string, { description?: string; default?: string }>;
  allowedAgents?: string[];
  steps?: Array<{ label: string; scene: string }>;
}

interface WorkflowSearchCandidate {
  entry: WorkflowCatalogEntry;
  keywordScore: number;
  semanticScore: number;
  combinedScore: number;
  matchedTerms: string[];
}

function buildWorkflowExecutionKey(name: string, workflowType: WorkflowType): string {
  return `${workflowType}:${name}`;
}

const COORDINATOR_BOOTSTRAP_TOOL_NAMES = new Set([
  "delegate_to_agent",
  "parallel_delegate",
  "run_task_graph",
  "run_workflow",
]);

const COORDINATOR_BOOTSTRAP_ALLOWED_TOOL_NAMES = new Set([
  "search_agents",
  "delegate_to_agent",
  "parallel_delegate",
  "run_task_graph",
  "read_shared_facts",
  "share_finding",
  "share_evidence",
]);

const WORKFLOW_BOOTSTRAP_BLOCKED_TOOL_NAMES = new Set([
  "search_workflows",
  "run_workflow",
]);

const COORDINATOR_BOOTSTRAP_NON_PROGRESS_TOOL_NAMES = new Set([
  "read_shared_facts",
  "list_agents",
  "search_agents",
  "search_workflows",
  "run_workflow",
]);

const SEARCH_STOP_WORDS = new Set<string>([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "how",
  "i", "if", "in", "is", "it", "me", "my", "of", "on", "or", "please", "that",
  "the", "these", "this", "to", "use", "using", "with", "you",
  "bitte", "das", "der", "die", "dir", "du", "ein", "eine", "für", "fuer", "hier", "im", "in", "ist", "jetzt", "kann", "kannst", "mir", "mit",
  "oder", "thema", "und", "von", "wie", "zu", "zum", "zur",
]);

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_:/.-]+/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeSearchText(value: string): string[] {
  return [...new Set(
    normalizeSearchText(value)
      .split(" ")
      .filter((token) => (token.length >= 3 || /\d/.test(token)) && !SEARCH_STOP_WORDS.has(token))
  )];
}

function expandTokenVariants(token: string): string[] {
  const variants = new Set<string>([token]);
  if (token.length > 4 && token.endsWith("es")) variants.add(token.slice(0, -2));
  if (token.length > 3 && token.endsWith("s")) variants.add(token.slice(0, -1));
  return [...variants].filter((value) => (value.length >= 3 || /\d/.test(value)));
}

/** Module-level cache: key = `${model}\x00${document_text}`, value = embedding vector. */
const _workflowEmbeddingCache = new Map<string, Float32Array>();

function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  let normLeft = 0;
  let normRight = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    normLeft += leftValue * leftValue;
    normRight += rightValue * rightValue;
  }
  return normLeft === 0 || normRight === 0 ? 0 : dot / (Math.sqrt(normLeft) * Math.sqrt(normRight));
}

function buildWorkflowCatalogEntries(): WorkflowCatalogEntry[] {
  const sceneEntries: WorkflowCatalogEntry[] = listAllScenes().map((scene) => ({
    key: `scene:${scene.name}`,
    name: scene.name,
    workflowType: "scene",
    description: scene.description,
    source: scene.source,
    task: scene.task,
    params: scene.params,
    allowedAgents: scene.allowedAgents,
  }));

  const jobEntries: WorkflowCatalogEntry[] = listAllJobs().map((job) => ({
    key: `job:${job.name}`,
    name: job.name,
    workflowType: "job",
    description: job.description,
    source: job.source,
    params: job.params,
    steps: job.steps.map((step, index) => ({
      label: step.label?.trim() || `Step ${index + 1}`,
      scene: step.scene,
    })),
  }));

  return [...sceneEntries, ...jobEntries];
}

function buildWorkflowSearchDocument(entry: WorkflowCatalogEntry): string {
  const params = Object.entries(entry.params ?? {})
    .map(([key, def]) => `${key}: ${def.description ?? ""} ${def.default ?? ""}`.trim())
    .join("; ");
  const allowedAgents = entry.allowedAgents?.join(", ") ?? "";
  const steps = entry.steps?.map((step) => `${step.label} -> ${step.scene}`).join("; ") ?? "";

  return [
    `Workflow Type: ${entry.workflowType}`,
    `Workflow Name: ${entry.name}`,
    `Description: ${entry.description}`,
    entry.task ? `Task: ${entry.task}` : "",
    params ? `Params: ${params}` : "",
    allowedAgents ? `Allowed Agents: ${allowedAgents}` : "",
    steps ? `Steps: ${steps}` : "",
  ].filter(Boolean).join("\n");
}

function scoreWorkflowKeywordMatch(query: string, entry: WorkflowCatalogEntry): { score: number; matchedTerms: string[] } {
  const normalizedQuery = normalizeSearchText(query);
  const queryTokens = tokenizeSearchText(query);
  if (!normalizedQuery || queryTokens.length === 0) {
    return { score: 0, matchedTerms: [] };
  }

  const descriptionText = normalizeSearchText(entry.description);
  const nameText = normalizeSearchText(entry.name);
  const taskText = normalizeSearchText(entry.task ?? "");
  const paramsText = normalizeSearchText(Object.entries(entry.params ?? {})
    .map(([key, def]) => `${key} ${def.description ?? ""} ${def.default ?? ""}`)
    .join(" "));
  const stepsText = normalizeSearchText((entry.steps ?? []).map((step) => `${step.label} ${step.scene}`).join(" "));
  const typeText = entry.workflowType === "job" ? "job workflow pipeline" : "scene template";
  const matchedTerms = new Set<string>();

  let score = 0;
  if (nameText.includes(normalizedQuery)) score += 1.15;
  else if (descriptionText.includes(normalizedQuery)) score += 0.95;

  for (const token of queryTokens) {
    const variants = expandTokenVariants(token);
    let tokenScore = 0;

    if (variants.some((variant) => nameText.includes(variant))) tokenScore = Math.max(tokenScore, 0.95);
    if (variants.some((variant) => descriptionText.includes(variant))) tokenScore = Math.max(tokenScore, 0.8);
    if (variants.some((variant) => taskText.includes(variant))) tokenScore = Math.max(tokenScore, 0.68);
    if (variants.some((variant) => paramsText.includes(variant))) tokenScore = Math.max(tokenScore, 0.54);
    if (variants.some((variant) => stepsText.includes(variant))) tokenScore = Math.max(tokenScore, 0.62);
    if (variants.some((variant) => typeText.includes(variant))) tokenScore = Math.max(tokenScore, 0.48);

    if (tokenScore > 0) {
      score += tokenScore;
      matchedTerms.add(token);
    }
  }

  const coverageBonus = (matchedTerms.size / queryTokens.length) * 0.35;
  let normalizedScore = Math.min(1, ((score / queryTokens.length) + coverageBonus) / 1.3);

  const normalizedLower = normalizedQuery.toLowerCase();
  if (/\b(workflow|pipeline|packet|chain|multi step|multi-step)\b/i.test(normalizedLower) && entry.workflowType === "job") {
    normalizedScore = Math.min(1, normalizedScore + 0.08);
  }
  if (/\b(scene|template)\b/i.test(normalizedLower) && entry.workflowType === "scene") {
    normalizedScore = Math.min(1, normalizedScore + 0.06);
  }

  return { score: normalizedScore, matchedTerms: [...matchedTerms] };
}

function sortWorkflowSearchCandidates(left: WorkflowSearchCandidate, right: WorkflowSearchCandidate): number {
  if (right.combinedScore !== left.combinedScore) return right.combinedScore - left.combinedScore;
  if (right.matchedTerms.length !== left.matchedTerms.length) return right.matchedTerms.length - left.matchedTerms.length;
  return left.entry.name.localeCompare(right.entry.name);
}

function rankWorkflowReferenceCandidates(
  query: string,
  workflowType: WorkflowType | "auto",
): WorkflowSearchCandidate[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];

  return buildWorkflowCatalogEntries()
    .filter((entry) => workflowType === "auto" || entry.workflowType === workflowType)
    .map((entry) => {
      const keyword = scoreWorkflowKeywordMatch(query, entry);
      return {
        entry,
        keywordScore: keyword.score,
        semanticScore: 0,
        combinedScore: keyword.score,
        matchedTerms: keyword.matchedTerms,
      } satisfies WorkflowSearchCandidate;
    })
    .filter((candidate) => candidate.combinedScore >= 0.18)
    .sort(sortWorkflowSearchCandidates)
    .slice(0, 5);
}

function buildWorkflowMatchMetadata(candidates: WorkflowSearchCandidate[]): Array<{
  name: string;
  workflowType: WorkflowType;
  score: number;
  matchedTerms: string[];
}> {
  return candidates.map((candidate) => ({
    name: candidate.entry.name,
    workflowType: candidate.entry.workflowType,
    score: candidate.combinedScore,
    matchedTerms: candidate.matchedTerms,
  }));
}

function combineWorkflowScores(keywordScore: number, semanticScore: number, semanticAvailable: boolean): number {
  if (keywordScore > 0 && semanticScore > 0) {
    return keywordScore * 0.25 + semanticScore * 0.75;
  }
  if (semanticScore > 0) {
    return semanticScore;
  }
  if (semanticAvailable && keywordScore > 0) {
    return keywordScore * 0.65;
  }
  return keywordScore;
}

async function computeSemanticWorkflowScores(
  query: string,
  entries: WorkflowCatalogEntry[],
): Promise<Map<string, number>> {
  if (entries.length === 0) return new Map<string, number>();

  const config = getConfig();
  const model = config.agents.defaults.model.embeddingModel ?? config.agents.defaults.model.primary;
  if (!model) return new Map<string, number>();

  try {
    const provider = getEmbeddingProvider();
    const documents = entries.map(buildWorkflowSearchDocument);
    const docCacheKeys = documents.map((doc) => `${model}\x00${doc}`);
    const queryCacheKey = `${model}\x00query:${query}`;

    // Embed uncached documents
    const uncached = docCacheKeys
      .map((key, index) => ({ key, index }))
      .filter(({ key }) => !_workflowEmbeddingCache.has(key));

    if (uncached.length > 0) {
      const textsToEmbed = uncached.map(({ index }) => documents[index]!);
      const newVectors = await provider.embed(textsToEmbed, model);
      for (let i = 0; i < uncached.length; i += 1) {
        const vector = newVectors[i];
        if (vector) _workflowEmbeddingCache.set(uncached[i]!.key, vector);
      }
    }

    // Embed query — cached to avoid repeat embedding for the same query string
    if (!_workflowEmbeddingCache.has(queryCacheKey)) {
      const [qv] = await provider.embed([`Workflow query: ${query}`], model);
      if (qv) _workflowEmbeddingCache.set(queryCacheKey, qv);
    }
    const queryVector = _workflowEmbeddingCache.get(queryCacheKey);
    if (!queryVector) return new Map<string, number>();

    const scores = new Map<string, number>();
    for (let index = 0; index < entries.length; index += 1) {
      const vector = _workflowEmbeddingCache.get(docCacheKeys[index]!);
      if (!vector) continue;
      scores.set(entries[index]!.key, cosineSimilarity(queryVector, vector));
    }
    return scores;
  } catch {
    return new Map<string, number>();
  }
}

function formatWorkflowCandidate(candidate: WorkflowSearchCandidate): string {
  const entry = candidate.entry;
  const params = Object.entries(entry.params ?? {}).map(([key, def]) =>
    `${key}${def.default !== undefined ? `=${def.default}` : ""}`,
  );
  const detailLines = [
    `- Type: ${entry.workflowType}`,
    `- Score: ${candidate.combinedScore.toFixed(2)}${candidate.semanticScore > 0 ? ` (keyword ${candidate.keywordScore.toFixed(2)}, semantic ${candidate.semanticScore.toFixed(2)})` : ""}`,
    `- Source: ${entry.source}`,
    `- Matches: ${candidate.matchedTerms.length > 0 ? candidate.matchedTerms.join(", ") : "semantic match"}`,
    params.length > 0 ? `- Params: ${params.join(", ")}` : "",
    entry.steps?.length ? `- Steps: ${entry.steps.map((step) => `${step.label} -> ${step.scene}`).join(" | ")}` : "",
    entry.allowedAgents?.length ? `- Allowed agents: ${entry.allowedAgents.join(", ")}` : "",
  ].filter(Boolean);

  return `**${entry.name}** [${entry.workflowType}]\n${entry.description}\n${detailLines.join("\n")}`;
}

function normalizeStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((acc, [key, entry]) => {
    if (entry === undefined || entry === null) return acc;
    acc[key] = String(entry);
    return acc;
  }, {});
}

function applyTemplate(template: string, params: Record<string, string>): string {
  return template.replace(/\{\{(\w+)(?:\|([^}]*))?\}\}/g, (match, key: string, defaultVal?: string) => {
    if (key in params) return params[key] ?? "";
    if (defaultVal !== undefined) return defaultVal;
    return match;
  });
}

function extractTemplateKeys(template: string): Set<string> {
  const keys = new Set<string>();
  template.replace(/\{\{(\w+)(?:\|[^}]*)?\}\}/g, (_match, key: string) => {
    keys.add(key);
    return _match;
  });
  return keys;
}

function mergeSceneParams(scene: SceneSummary, overrides: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, def] of Object.entries(scene.params ?? {})) {
    if (def.default !== undefined) merged[key] = def.default;
  }
  Object.assign(merged, overrides);
  return merged;
}

function appendWorkflowContext(task: string, context?: string): string {
  if (!context?.trim()) return task;
  return `${task.trim()}\n\nAdditional workflow context:\n${context.trim()}`;
}

function buildWorkflowParamContext(
  template: string,
  params: Record<string, string>,
  workflowContext: string | undefined,
  originalObjective: string | undefined,
): string | undefined {
  const sections: string[] = [];
  if (workflowContext?.trim()) {
    sections.push(workflowContext.trim());
  }

  const trimmedObjective = originalObjective?.trim();
  if (trimmedObjective) {
    const objectiveAlreadyPresent = normalizeSearchText([
      template,
      workflowContext ?? "",
      ...Object.values(params),
    ].join(" ")).includes(normalizeSearchText(trimmedObjective));
    if (!objectiveAlreadyPresent) {
      sections.push(`Original user request:\n${trimmedObjective}`);
    }
  }

  const usedKeys = extractTemplateKeys(template);
  const supplementalLines = Object.entries(params)
    .filter(([key, value]) => value.trim().length > 0 && !usedKeys.has(key))
    .map(([key, value]) => `- ${key}: ${value}`);

  if (supplementalLines.length > 0) {
    sections.push(`Workflow parameters:\n${supplementalLines.join("\n")}`);
  }

  return sections.length > 0 ? sections.join("\n\n") : undefined;
}

function ensureWorkflowSwarmState(
  ctx: ToolContext,
  objective: string,
  workflowTaskId: string,
  title: string,
): void {
  const now = new Date().toISOString();
  if (!ctx.swarmState) {
    ctx.swarmState = {
      objective,
      startedAt: now,
      updatedAt: now,
      tasks: {},
    };
  }

  if (!ctx.swarmState.objective.trim()) {
    ctx.swarmState.objective = objective;
  }
  ctx.swarmState.updatedAt = now;
  ctx.swarmState.tasks[workflowTaskId] ??= {
    id: workflowTaskId,
    title,
    status: "running",
    dependsOn: [],
    attempts: [{
      agentName: "workflow_runner",
      status: "running",
      startedAt: now,
      toolCount: 0,
      iterations: 0,
      toolNames: [],
    }],
  };

  const workflowTask = ctx.swarmState.tasks[workflowTaskId]!;
  workflowTask.status = workflowTask.status === "completed" ? "completed" : "running";
  workflowTask.attempts[0] ??= {
    agentName: "workflow_runner",
    status: "running",
    startedAt: now,
    toolCount: 0,
    iterations: 0,
    toolNames: [],
  };
  workflowTask.attempts[0].status = workflowTask.status;
  workflowTask.attempts[0].startedAt ??= now;

  if (ctx.onSwarmState) {
    ctx.onSwarmState(structuredClone(ctx.swarmState));
  }
}

function finalizeWorkflowSwarmState(
  ctx: ToolContext,
  workflowTaskId: string,
  status: SwarmTaskState["status"],
  summary: string,
): void {
  if (!ctx.swarmState?.tasks[workflowTaskId]) return;

  const now = new Date().toISOString();
  const workflowTask = ctx.swarmState.tasks[workflowTaskId]!;
  workflowTask.status = status;
  workflowTask.output = status === "completed" || status === "partial" ? summary : workflowTask.output;
  workflowTask.error = status === "failed" || status === "blocked" ? summary : undefined;
  const attempt = workflowTask.attempts[0];
  if (attempt) {
    attempt.status = status === "completed"
      ? "completed"
      : status === "partial"
        ? "partial"
        : status === "running" || status === "pending"
          ? "running"
          : "failed";
    attempt.finishedAt = now;
    attempt.summary = summary;
  }
  ctx.swarmState.updatedAt = now;

  if (ctx.onSwarmState) {
    ctx.onSwarmState(structuredClone(ctx.swarmState));
  }
}

function intersectAllowedAgents(parent: string[] | undefined, child: string[] | undefined): string[] | undefined {
  if (!parent?.length) return child;
  if (!child?.length) return parent;
  return child.filter((agentName) => parent.includes(agentName));
}

function mergeHumanInLoopSteps(parent: string[] | undefined, child: string[] | undefined): string[] | undefined {
  const merged = new Set<string>([...(parent ?? []), ...(child ?? [])]);
  return merged.size > 0 ? [...merged] : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveCoordinatorBootstrapAgent(
  scene: SceneSummary,
  allowedAgents: string[] | undefined,
): string | null {
  const match = scene.task.match(/^\s*use\s+([a-z0-9_:-]+)\s+(?:first\b|to\b)/i);
  if (!match?.[1]) return null;

  const agentName = match[1].trim();
  if (allowedAgents?.length && !allowedAgents.includes(agentName)) {
    return null;
  }

  const agentConfig = getConfig().subAgents[agentName];
  if (!agentConfig) return null;

  const tools = agentConfig.tools ?? [];
  return tools.some((toolName) => COORDINATOR_BOOTSTRAP_TOOL_NAMES.has(toolName))
    ? agentName
    : null;
}

function isCoordinatorBootstrapAgent(agentName: string): boolean {
  const agentConfig = getConfig().subAgents[agentName];
  if (!agentConfig) return false;
  const tools = agentConfig.tools ?? [];
  return tools.some((toolName) => COORDINATOR_BOOTSTRAP_TOOL_NAMES.has(toolName));
}

/**
 * A scene/job step scoped to exactly ONE non-coordinator (leaf) agent has no
 * orchestration decision to make — the only legal action is "run that agent". On a
 * slow local model the per-step ORCHESTRATOR (runTurn) sometimes answers tool-free and
 * never delegates, burning the step's whole budget without producing the deliverable
 * (audit: a single-`content_writer` build step shipped a 389-char stub and never built
 * the deck). Running the leaf agent directly removes that escape entirely. Coordinators
 * are excluded — orchestrating IS their job, so they keep the runTurn/coordinator path.
 * Topic-neutral: applies to any single-leaf-agent step, not a specific workflow.
 */
export function resolveSingleStepLeafAgent(allowedAgents: string[] | undefined): string | null {
  if (!allowedAgents || allowedAgents.length !== 1) return null;
  const agentName = allowedAgents[0]!.trim();
  if (!agentName || !getConfig().subAgents[agentName]) return null;
  if (isCoordinatorBootstrapAgent(agentName)) return null;
  return agentName;
}

function resolveSceneBootstrapAgent(
  scene: SceneSummary,
  allowedAgents: string[] | undefined,
): string | null {
  const coordinatorBootstrap = resolveCoordinatorBootstrapAgent(scene, allowedAgents);
  if (coordinatorBootstrap) return coordinatorBootstrap;

  const match = scene.task.match(/^\s*use\s+([a-z0-9_:-]+)\s+(?:first\b|to\b)/i);
  if (match?.[1]) {
    const agentName = match[1].trim();
    const allowed = !(allowedAgents?.length && !allowedAgents.includes(agentName));
    if (allowed && getConfig().subAgents[agentName]) return agentName;
  }

  // No explicit "use X" lead — but a single-leaf-agent scene still runs that agent directly.
  return resolveSingleStepLeafAgent(allowedAgents);
}

function stripCoordinatorBootstrapInstruction(task: string, agentName: string): string {
  const trimmedTask = task.trim();
  const strippedFirstSentence = task.replace(
    new RegExp(`^\\s*use\\s+${escapeRegExp(agentName)}\\s+first(?:\\s+when\\b[^.?!]*[.?!]|\\s*[.?!])\\s*`, "i"),
    "",
  ).trim();
  if (strippedFirstSentence && strippedFirstSentence !== trimmedTask) return strippedFirstSentence;

  const strippedToDirective = task.replace(
    new RegExp(`^\\s*use\\s+${escapeRegExp(agentName)}\\s+to\\s+`, "i"),
    "",
  ).trim();
  if (strippedToDirective && strippedToDirective !== trimmedTask) return strippedToDirective;

  const strippedFirstDirective = task.replace(
    new RegExp(`^\\s*use\\s+${escapeRegExp(agentName)}\\s+first\\b[\\s.?!]*`, "i"),
    "",
  ).trim();
  return strippedFirstDirective || task;
}

function rewriteCoordinatorBootstrapTask(task: string): string {
  const rewritten = task
    .replace(/^\s*it\s+should\s+/i, "")
    .replace(/^\s*it\s+must\s+/i, "")
    .replace(/^\s*this\s+workflow\s+should\s+/i, "")
    .trim();

  if (!rewritten) return task.trim();
  return `${rewritten.slice(0, 1).toUpperCase()}${rewritten.slice(1)}`;
}

function shouldDisableBrowserSearchForBootstrap(agentName: string, task: string): boolean {
  if (agentName !== "browser_agent") return false;
  return /\bhttps?:\/\//i.test(task)
    || /\bget_site_credentials\b/i.test(task)
    || /\blogin\s*url\b/i.test(task)
    || /\bnamed\s+urls?\b/i.test(task);
}

function buildCoordinatorBootstrapInlineConfig(agentName: string) {
  const agentConfig = getConfig().subAgents[agentName];
  if (!agentConfig) return null;

  return {
    ...agentConfig,
    tools: (agentConfig.tools ?? []).filter((toolName) => (
      !WORKFLOW_BOOTSTRAP_BLOCKED_TOOL_NAMES.has(toolName)
      && COORDINATOR_BOOTSTRAP_ALLOWED_TOOL_NAMES.has(toolName)
    )),
  };
}

function buildSceneBootstrapInlineConfig(agentName: string, task: string) {
  if (isCoordinatorBootstrapAgent(agentName)) {
    return buildCoordinatorBootstrapInlineConfig(agentName);
  }

  const agentConfig = getConfig().subAgents[agentName];
  if (!agentConfig) return null;

  if (!shouldDisableBrowserSearchForBootstrap(agentName, task)) {
    return agentConfig;
  }

  return {
    ...agentConfig,
    tools: (agentConfig.tools ?? []).filter((toolName) => toolName !== "web_search"),
  };
}

function buildCoordinatorBootstrapContext(
  scene: SceneSummary,
  workflowContext: string | undefined,
  allowedAgents: string[] | undefined,
): string {
  return [
    `Selected reusable workflow: ${scene.name} [scene].`,
    `Scene description: ${scene.description}`,
    "This workflow is already selected. Execute it directly.",
    "Do NOT call search_workflows or run_workflow from inside this bootstrap coordinator.",
    allowedAgents?.length ? `Allowed specialists for this workflow: ${allowedAgents.join(", ")}.` : "",
    "For source-grounded deliverables, gather evidence with researcher and publish reusable source-backed findings via share_evidence before drafting.",
    "For source-grounded deliverables, require scored findings with exact source metadata such as title, canonical URL, publisher, dates, validation status, and trust/corroboration scores before those findings are treated as reusable evidence.",
    allowedAgents?.includes("source_verifier")
      ? "Before drafting or final synthesis, run source_verifier to validate the cited sources, export a normalized validated evidence ledger artifact, and mark doubtful or fabricated references as disputed instead of letting them flow upward."
      : "Before drafting or final synthesis, validate that the cited sources are real and correctly matched to the claims instead of letting unverified evidence flow upward.",
    "If read_shared_facts is empty or insufficient, do NOT stop with a plan-only response. Delegate or gather evidence before returning.",
    workflowContext?.trim() ? `Workflow context:\n${workflowContext.trim()}` : "",
  ].filter(Boolean).join("\n");
}

function buildSceneBootstrapContext(
  scene: SceneSummary,
  workflowContext: string | undefined,
  allowedAgents: string[] | undefined,
  agentName: string,
): string {
  if (isCoordinatorBootstrapAgent(agentName)) {
    return buildCoordinatorBootstrapContext(scene, workflowContext, allowedAgents);
  }

  return [
    `Selected reusable workflow: ${scene.name} [scene].`,
    `Scene description: ${scene.description}`,
    "This workflow is already selected. Execute it directly.",
    "Do NOT call search_workflows or run_workflow from inside this workflow.",
    agentName === "browser_agent"
      ? "The workflow already provides the target host or URL. Do NOT use web_search for this workflow."
      : "",
    agentName === "browser_agent"
      ? "Call get_site_credentials first to retrieve loginUrl, named URLs, selectors, and notes before navigating."
      : "",
    agentName === "browser_agent"
      ? "If the site credentials include a named URL for the requested destination, use that URL instead of guessing a path."
      : "",
    agentName === "browser_agent"
      ? "After site_fill_credentials submits a known login form, prefer the named destination URL from get_site_credentials immediately instead of waiting for generic landing-page text such as Projects, Home, or Dashboard."
      : "",
    agentName === "browser_agent"
      ? "After site_fill_credentials, do not wait for or re-check login-form text such as Sign in, Email, or Password, and do not click the submit button again unless a fresh snapshot shows the form is still awaiting submission. Use a short fixed delay or the known destination URL instead."
      : "",
    agentName === "browser_agent"
      ? "For known credentialed hosts, stay on that same host and do not guess alternate hosts such as localhost, app.n8n.io, or n8n.io. If the named URL still fails, report the blocker instead of inventing a fallback host."
      : "",
    agentName === "browser_agent"
      ? "For table or list extraction, prefer browser_snapshot over browser_screenshot and synthesize immediately once the visible rows or cells are readable."
      : "",
    workflowContext?.trim() ? `Workflow context:\n${workflowContext.trim()}` : "",
  ].filter(Boolean).join("\n");
}

function resolveSceneBootstrapTurnTimeoutMs(
  scene: SceneSummary,
  mergedParams: Record<string, string>,
  bootstrapAgent: string,
  inheritedTurnTimeoutMs: number | undefined,
): number | undefined {
  if (inheritedTurnTimeoutMs !== undefined) {
    return inheritedTurnTimeoutMs;
  }
  if (bootstrapAgent !== "browser_agent") {
    return undefined;
  }

  const rawNavigationTimeout = mergedParams["navigationTimeout"]?.trim();
  if (!rawNavigationTimeout) {
    return undefined;
  }

  const navigationTimeoutSec = Number.parseInt(rawNavigationTimeout, 10);
  if (!Number.isFinite(navigationTimeoutSec) || navigationTimeoutSec <= 0) {
    return undefined;
  }

  return Math.max(60_000, navigationTimeoutSec * 1000 + 30_000);
}

function sceneRequiresCoordinatorEvidence(scene: SceneSummary): boolean {
  const taskText = `${scene.description}\n${scene.task}`.toLowerCase();
  return taskText.includes("evidence")
    || taskText.includes("source")
    || taskText.includes("citation")
    || taskText.includes("research")
    || taskText.includes("grounded")
    || taskText.includes("official")
    || taskText.includes("current")
    || taskText.includes("share_finding")
    || taskText.includes("share_evidence")
    || (scene.allowedAgents?.some((agentName) => [
      "researcher",
    ].includes(agentName)) ?? false);
}

function coordinatorBootstrapLackedSubstantiveProgress(toolNames: string[] | undefined): boolean {
  const uniqueToolNames = [...new Set((toolNames ?? []).filter(Boolean))];
  if (uniqueToolNames.length === 0) return false;
  return uniqueToolNames.every((toolName) => COORDINATOR_BOOTSTRAP_NON_PROGRESS_TOOL_NAMES.has(toolName));
}

function resolveWorkflowApprovalCallback(
  scene: SceneSummary,
  ctx: ToolContext,
): ToolContext["approvalCallback"] {
  if (ctx.approvalCallback) {
    return ctx.approvalCallback;
  }
  if (!scene.approvalChannel) {
    return undefined;
  }

  return async (toolName: string, args: Record<string, unknown>) => requestApprovalViaChannel(
    scene.approvalChannel!,
    toolName,
    args,
    scene.name,
    scene.approvalTimeoutMs,
  );
}

function looksLikeApprovalBlockedWorkflowOutput(output: string): boolean {
  return /(?:\b(?:approval (?:timed out|expired|was not granted|not granted|explicitly denied)|execution denied by user|requires human approval|no approval channel)\b|\[APPROVAL BLOCKED\])/i.test(output);
}

function looksLikeOperationalWorkflowBlocker(output: string): boolean {
  const normalized = output.trim();
  if (!normalized) return false;
  if (/\b(?:no|without|keine?|ohne)\s+(?:current\s+)?blockers?\b/i.test(normalized)) return false;

  return /(?:^|\n)\s*(?:status\s*:\s*)?(?:[!\-*> ]*)?(?:⚠️\s*)?(?:blocker|blocked)\b/i.test(normalized)
    || /\b(?:no stored credentials|no credentials found|keine gespeicherten (?:anmeldedaten|credentials)|keine credentials|cannot log in|can't log in|kann sich nicht einloggen|kann nicht fortgesetzt werden)\b/i.test(normalized);
}

function workflowOutputIsBlocked(output: string): boolean {
  return looksLikeApprovalBlockedWorkflowOutput(output) || looksLikeOperationalWorkflowBlocker(output);
}

function buildCoordinatorBootstrapProgressFailure(
  scene: SceneSummary,
  toolNames: string[] | undefined,
): string | null {
  if (!sceneRequiresCoordinatorEvidence(scene)) return null;
  if (!coordinatorBootstrapLackedSubstantiveProgress(toolNames)) return null;

  const usedToolNames = [...new Set((toolNames ?? []).filter(Boolean))];
  const usedTools = usedToolNames.length > 0 ? usedToolNames.join(", ") : "no tools";
  return `Coordinator bootstrap stopped without evidence-gathering or delegation progress. It only used introspection/discovery tools (${usedTools}). For this workflow, do not treat that as completed research. If shared facts are empty or insufficient, gather evidence or delegate before finishing.`;
}

function resolveWorkflowReference(name: string, workflowType: WorkflowType | "auto"): {
  scene: SceneSummary | null;
  job: JobSummary | null;
  ambiguousMatches?: WorkflowCatalogEntry[];
  suggestedMatches?: WorkflowSearchCandidate[];
} {
  const exactScene = workflowType === "job" ? null : getScene(name);
  const exactJob = workflowType === "scene" ? null : getJobDefinition(name);

  if (exactScene || exactJob) {
    return { scene: exactScene, job: exactJob };
  }

  const normalizedQuery = normalizeSearchText(name);
  if (!normalizedQuery) {
    return { scene: null, job: null };
  }

  const suggestedMatches = rankWorkflowReferenceCandidates(name, workflowType);

  const candidates = buildWorkflowCatalogEntries()
    .filter((entry) => workflowType === "auto" || entry.workflowType === workflowType)
    .filter((entry) => {
      const normalizedName = normalizeSearchText(entry.name);
      if (normalizedName === normalizedQuery) return true;
      if (normalizedName.startsWith(normalizedQuery)) return true;
      return normalizedName.split(" ").some((token) => token.startsWith(normalizedQuery));
    });

  if (candidates.length !== 1) {
    return {
      scene: null,
      job: null,
      ...(suggestedMatches.length > 0 ? { suggestedMatches } : {}),
      ...(candidates.length > 1 ? { ambiguousMatches: candidates } : {}),
    };
  }

  const match = candidates[0]!;
  return {
    scene: match.workflowType === "scene" ? getScene(match.name) : null,
    job: match.workflowType === "job" ? getJobDefinition(match.name) : null,
  };
}

async function runSceneInline(
  scene: SceneSummary,
  params: Record<string, string>,
  workflowContext: string | undefined,
  ctx: ToolContext,
): Promise<{ response: string; blocked: boolean; toolCallsExecuted: number; bootstrapAgent?: string; artifacts?: Array<Record<string, unknown>> }> {
  const mergedParams = mergeSceneParams(scene, params);
  const enrichedWorkflowContext = buildWorkflowParamContext(scene.task, mergedParams, workflowContext, ctx.swarmState?.objective);
  const task = appendWorkflowContext(applyTemplate(scene.task, mergedParams), enrichedWorkflowContext);
  const allowedAgents = intersectAllowedAgents(ctx.allowedAgents, scene.allowedAgents);
  const mergedHumanInLoopSteps = mergeHumanInLoopSteps(ctx.humanInLoopSteps, scene.humanInLoopSteps);
  const approvalCallback = resolveWorkflowApprovalCallback(scene, ctx);
  const workflowExecutionStack = [
    ...(ctx._workflowExecutionStack ?? []),
    buildWorkflowExecutionKey(scene.name, "scene"),
  ];
  const workflowTaskId = `workflow:scene:${scene.name}`;
  ensureWorkflowSwarmState(ctx, task, workflowTaskId, scene.name);
  if (scene.allowedAgents?.length && allowedAgents?.length === 0) {
    throw new Error(`Workflow '${scene.name}' is restricted to agents that are not available in the current scope.`);
  }

  const session = createSession({
    sessionId: `workflow:${ctx.sessionId}:${scene.name}:${randomUUID()}`,
    channel: "workflow",
    userId: `workflow:${scene.name}`,
    workspacePath: ctx.workspacePath,
  });

  try {
    const bootstrapAgent = resolveSceneBootstrapAgent(scene, allowedAgents);
    if (bootstrapAgent) {
      const bootstrapTask = rewriteCoordinatorBootstrapTask(
        stripCoordinatorBootstrapInstruction(task, bootstrapAgent),
      );
      const bootstrapConfig = buildSceneBootstrapInlineConfig(bootstrapAgent, task);
      const bootstrapTurnTimeoutMs = resolveSceneBootstrapTurnTimeoutMs(
        scene,
        mergedParams,
        bootstrapAgent,
        ctx.turnTimeoutOverrideMs,
      );
      if (!bootstrapConfig) {
        throw new Error(`Workflow bootstrap agent '${bootstrapAgent}' is not configured.`);
      }

      const bootstrapRun = await runSubAgentWithStats({
        agentName: bootstrapAgent,
        task: bootstrapTask,
        context: buildSceneBootstrapContext(scene, enrichedWorkflowContext, allowedAgents, bootstrapAgent),
        parentSessionId: ctx.sessionId,
        workspacePath: ctx.workspacePath,
        allowedAgents,
        signal: ctx.signal,
        approvalCallback,
        onProgress: ctx.onSubAgentProgress,
        humanInLoopSteps: mergedHumanInLoopSteps,
        onComputerAction: ctx.onComputerAction,
        onComputerScreenshot: ctx.onComputerScreenshot,
        onComputerSessionState: ctx.onComputerSessionState,
        maxIterationsOverride: ctx.maxIterationsOverride,
        turnTimeoutOverrideMs: bootstrapTurnTimeoutMs,
        swarmState: ctx.swarmState,
        onSwarmState: ctx.onSwarmState,
        _turnAgentCounts: ctx._turnAgentCounts,
        _turnAgentRepeatLimitOverrides: ctx._turnAgentRepeatLimitOverrides,
        _turnTotalDelegationLimitOverride: ctx._turnTotalDelegationLimitOverride,
        _workflowExecutionStack: workflowExecutionStack,
        inlineConfig: bootstrapConfig,
      });

      const bootstrapResponse = bootstrapRun.output.trim() || `Workflow bootstrap delegation to ${bootstrapAgent} produced no output.`;
      const bootstrapProgressFailure = isCoordinatorBootstrapAgent(bootstrapAgent)
        ? buildCoordinatorBootstrapProgressFailure(scene, bootstrapRun.stats.toolNames)
        : null;
      const finalBootstrapResponse = bootstrapProgressFailure
        ? `${bootstrapResponse}\n\n${bootstrapProgressFailure}`
        : bootstrapResponse;
      const bootstrapBlocked = bootstrapRun.stats.outcome === "failure"
        || /^Sub-agent produced no final response\.?$/i.test(bootstrapResponse)
        || Boolean(bootstrapProgressFailure)
        || workflowOutputIsBlocked(bootstrapResponse);

      finalizeWorkflowSwarmState(
        ctx,
        workflowTaskId,
        bootstrapBlocked ? "blocked" : "completed",
        finalBootstrapResponse,
      );

      return {
        response: finalBootstrapResponse,
        blocked: bootstrapBlocked,
        toolCallsExecuted: 1,
        bootstrapAgent,
        // The bootstrap agent ran in its OWN sub-session, so the scene session's
        // collector finds nothing — thread the agent's own collected artifacts (e.g.
        // the built deck/paper, saved images) so the parent surfaces downloads.
        artifacts: bootstrapRun.artifacts,
      };
    }

    const result = await runTurn({
      session,
      userMessage: task,
      approvalCallback,
      signal: ctx.signal,
      allowedAgents,
      humanInLoopSteps: mergedHumanInLoopSteps,
      autoApprove: ctx.autoApprove,
      maxIterationsOverride: ctx.maxIterationsOverride,
      turnTimeoutOverrideMs: ctx.turnTimeoutOverrideMs,
      _workflowExecutionStack: workflowExecutionStack,
      onSubAgentProgress: ctx.onSubAgentProgress,
      onComputerAction: ctx.onComputerAction,
      onComputerScreenshot: ctx.onComputerScreenshot,
      onComputerSessionState: ctx.onComputerSessionState,
      onSwarmState: ctx.onSwarmState,
    });

    const resultBlocked = result.blocked || workflowOutputIsBlocked(result.response);
    finalizeWorkflowSwarmState(
      ctx,
      workflowTaskId,
      resultBlocked ? "blocked" : "completed",
      result.response,
    );

    // Surface the artifacts the scene built (e.g. the deck + its images) so the
    // parent turn sees them: collectTurnArtifactAttachments reads tool-role
    // history, but the scene ran in its OWN session that is about to be archived,
    // so the parent's collector would otherwise find nothing — leaving the user
    // without a clickable download AND letting the source-sensitive auto-build
    // spuriously re-fire (it keys on "zero artifacts this turn"). run_workflow
    // threads these into its result metadata.artifacts.
    return {
      response: result.response,
      blocked: resultBlocked,
      toolCallsExecuted: result.toolCallsExecuted,
      artifacts: collectTurnArtifactAttachments(session),
    };
  } finally {
    const workflowTask = ctx.swarmState?.tasks[workflowTaskId];
    if (workflowTask?.status === "running") {
      finalizeWorkflowSwarmState(ctx, workflowTaskId, "completed", `Workflow ${scene.name} completed.`);
    }
    archiveSession(session.id);
  }
}

async function runJobInline(
  job: JobSummary,
  params: Record<string, string>,
  workflowContext: string | undefined,
  ctx: ToolContext,
): Promise<{ response: string; blocked: boolean; toolCallsExecuted: number; executedSteps: number; artifacts?: Array<Record<string, unknown>> }> {
  const steps = resolveJobSteps(job, params);
  const enrichedWorkflowContext = buildWorkflowParamContext(job.description || job.name, params, workflowContext, ctx.swarmState?.objective);
  const workflowTaskId = `workflow:job:${job.name}`;
  ensureWorkflowSwarmState(ctx, job.description || job.name, workflowTaskId, job.name);
  const workflowExecutionStack = [
    ...(ctx._workflowExecutionStack ?? []),
    buildWorkflowExecutionKey(job.name, "job"),
  ];
  const session = createSession({
    sessionId: `workflow:${ctx.sessionId}:${job.name}:${randomUUID()}`,
    channel: "workflow",
    userId: `workflow:${job.name}`,
    workspacePath: ctx.workspacePath,
  });

  try {
    const sections: string[] = [];
    const directStepArtifacts: Array<Record<string, unknown>> = [];
    let blocked = false;
    let toolCallsExecuted = 0;
    let executedSteps = 0;

    for (const [index, step] of steps.entries()) {
      const allowedAgents = intersectAllowedAgents(ctx.allowedAgents, step.allowedAgents);
      if (step.allowedAgents?.length && allowedAgents?.length === 0) {
        throw new Error(`Workflow '${job.name}' step '${step.label}' is restricted to agents that are not available in the current scope.`);
      }

      // Append the workflow context (which carries the ORIGINAL request, i.e. the topic)
      // to EVERY step, not just the first. Later steps otherwise never learn the subject:
      // an image step would have no topic to search for and would depend on parsing the
      // research step's raw shared facts to guess subjects (fragile). Each step's own task
      // hard-clamps its scope, so the shared context is read as background/topic only.
      const stepTask = appendWorkflowContext(step.task, enrichedWorkflowContext);

      // A step scoped to exactly ONE leaf agent has no orchestration decision — run that
      // agent DIRECTLY (same shared session scope, so shared facts still flow between
      // steps) instead of a full orchestrator turn whose slow-model tool-free answer can
      // skip the work entirely (audit: deck_build never delegated to content_writer ->
      // no deck). Multi-agent / coordinator steps keep the runTurn orchestrator path.
      const directAgent = resolveSingleStepLeafAgent(allowedAgents);
      let stepResponse: string;
      let stepBlocked: boolean;
      if (directAgent) {
        const directIntro = `You are the "${directAgent}" specialist running ONE scoped step of a pipeline. Carry out this step's work YOURSELF with your own tools — you have no sub-agents and must not try to delegate.\n\n`;
        const directOpts = {
          agentName: directAgent,
          parentSessionId: session.id,
          workspacePath: ctx.workspacePath,
          allowedAgents,
          signal: ctx.signal,
          approvalCallback: ctx.approvalCallback,
          onProgress: ctx.onSubAgentProgress,
          humanInLoopSteps: mergeHumanInLoopSteps(ctx.humanInLoopSteps, step.humanInLoopSteps),
          onComputerAction: ctx.onComputerAction,
          onComputerScreenshot: ctx.onComputerScreenshot,
          onComputerSessionState: ctx.onComputerSessionState,
          maxIterationsOverride: ctx.maxIterationsOverride,
          turnTimeoutOverrideMs: ctx.turnTimeoutOverrideMs,
          swarmState: ctx.swarmState,
          onSwarmState: ctx.onSwarmState,
          _workflowExecutionStack: workflowExecutionStack,
        };
        const producedArtifact = (r: { artifacts?: unknown[] }): boolean => Array.isArray(r.artifacts) && r.artifacts.length > 0;

        let run = await runSubAgentWithStats({ ...directOpts, task: `${directIntro}${stepTask}` });
        toolCallsExecuted += run.stats.toolCount;

        // QA deliverable check: a step that MUST persist an output file but produced none
        // gets ONE corrective re-attempt with the failure folded in. A clean retry that
        // reminds the agent of valid tool-arg shapes beats giving a deterministic arg
        // rejection more wall-clock time (audit 3c46a4d4: deck_slides reported success with a
        // text answer after THREE rejected generate_presentation calls, so the deck + speaker
        // notes were never written yet the job claimed all 4 steps were done).
        if (step.expectArtifact && !producedArtifact(run)) {
          const correctiveTask = `${directIntro}${stepTask}\n\n[QA RE-ATTEMPT] Your previous attempt did NOT persist the required output file — no artifact was saved. Produce it now and make sure the artifact tool call SUCCEEDS before you stop: pass every array argument as a real JSON array (e.g. slides=[{…}], bullets=[…]) — never a quoted string; use only allowed enum values (an invalid theme is ignored, not rejected); embed any images as Markdown ![alt](images/<file>). Do not paste the file contents into your reply.`;
          const retry = await runSubAgentWithStats({ ...directOpts, task: correctiveTask });
          toolCallsExecuted += retry.stats.toolCount;
          if (producedArtifact(retry)) run = retry; // adopt the attempt that produced the file
        }

        stepResponse = run.output.trim() || `Step '${step.label}' produced no output.`;
        stepBlocked = run.stats.outcome === "failure" || workflowOutputIsBlocked(stepResponse);
        if (run.artifacts?.length) directStepArtifacts.push(...run.artifacts);
        // An artifact-required step that STILL produced no file is not a success — mark it
        // incomplete so the job reports honestly instead of implying the deliverable exists.
        if (step.expectArtifact && !producedArtifact(run)) {
          stepBlocked = true;
          stepResponse = `${stepResponse}\n\n_(This step was required to produce an output file but none was saved.)_`.trim();
        }
      } else {
        const result = await runTurn({
          session,
          userMessage: stepTask,
          approvalCallback: ctx.approvalCallback,
          signal: ctx.signal,
          allowedAgents,
          humanInLoopSteps: mergeHumanInLoopSteps(ctx.humanInLoopSteps, step.humanInLoopSteps),
          autoApprove: ctx.autoApprove,
          maxIterationsOverride: ctx.maxIterationsOverride,
          turnTimeoutOverrideMs: ctx.turnTimeoutOverrideMs,
          _workflowExecutionStack: workflowExecutionStack,
          onSubAgentProgress: ctx.onSubAgentProgress,
          onComputerAction: ctx.onComputerAction,
          onComputerScreenshot: ctx.onComputerScreenshot,
          onComputerSessionState: ctx.onComputerSessionState,
          onSwarmState: ctx.onSwarmState,
        });
        stepResponse = result.response.trim();
        stepBlocked = result.blocked || workflowOutputIsBlocked(result.response);
        toolCallsExecuted += result.toolCallsExecuted;
      }

      sections.push(`## ${step.label}\n\n${stepResponse}`.trim());
      executedSteps += 1;

      if (stepBlocked) {
        blocked = true;
        break;
      }
    }

    const response = sections.join("\n\n").trim();
    finalizeWorkflowSwarmState(
      ctx,
      workflowTaskId,
      blocked ? "blocked" : "completed",
      response || `Workflow ${job.name} ${blocked ? "blocked" : "completed"}.`,
    );

    // Surface the built artifacts (deck + notes + paper, saved images). Orchestrator
    // (runTurn) steps leave their delegate artifacts in this shared session, so the
    // collector finds them; directly-run leaf steps ran in their own sub-sessions, so
    // their artifacts are threaded explicitly. De-dup by outputPath across both.
    const collected = collectTurnArtifactAttachments(session);
    const seenPaths = new Set<string>();
    const artifacts: Array<Record<string, unknown>> = [];
    for (const artifact of [...directStepArtifacts, ...collected]) {
      const key = typeof artifact["outputPath"] === "string" ? (artifact["outputPath"] as string) : JSON.stringify(artifact);
      if (seenPaths.has(key)) continue;
      seenPaths.add(key);
      artifacts.push(artifact);
    }

    return {
      response,
      blocked,
      toolCallsExecuted,
      executedSteps,
      artifacts,
    };
  } finally {
    const workflowTask = ctx.swarmState?.tasks[workflowTaskId];
    if (workflowTask?.status === "running") {
      finalizeWorkflowSwarmState(ctx, workflowTaskId, "completed", `Workflow ${job.name} completed.`);
    }
    archiveSession(session.id);
  }
}

export interface WorkflowCandidateSummary {
  name: string;
  workflowType: "scene" | "job";
  description: string;
  score: number;
  semanticScore: number;
  matchedTerms: string[];
}

/**
 * Select genuine SEMANTIC standouts from a list ranked by semantic score (desc).
 *
 * The embedding similarity baseline is ~0.5 for *every* workflow against a free-form
 * request (audit session 7839e153: an audio-hardware request scored meeting_briefing,
 * onboarding, incident_response etc. all at 0.50–0.56), so a fixed floor cannot tell
 * a real match from the noise floor. A workflow only genuinely fits when its score is
 * a clear OUTLIER — well above the baseline AND clearly ahead of the runner-up. The
 * gap between #1 and #2 is the robust, pool-size-independent signal:
 *   - audio request (no shape asked): top 0.556, #2 0.548 → gap 0.008 → NO standout
 *   - explicit "make a sourced presentation": top 0.631, #2 0.566 → gap 0.065 → standout
 * Purely semantic — no keywords, no regex, no author-declared trigger patterns.
 */
export function selectStandoutSemanticMatches<T extends { semanticScore: number }>(
  rankedDesc: readonly T[],
  opts?: { absFloor?: number; gapMargin?: number },
): T[] {
  const absFloor = opts?.absFloor ?? 0.55;
  const gapMargin = opts?.gapMargin ?? 0.04;
  const top = rankedDesc[0];
  if (!top || top.semanticScore < absFloor) return [];
  // Walk down from the top accumulating the high cluster until the score drops by the
  // gap margin — that drop is the natural break between genuine matches and the ~0.5
  // baseline. (This admits a small cluster of equally-strong matches, not just #1.)
  const cluster: T[] = [top];
  let brokeAway = false;
  for (let i = 1; i < rankedDesc.length; i += 1) {
    if (rankedDesc[i - 1]!.semanticScore - rankedDesc[i]!.semanticScore >= gapMargin) {
      brokeAway = true;
      break;
    }
    cluster.push(rankedDesc[i]!);
  }
  // No break anywhere → the whole list is one flat band (no workflow stands out from
  // the baseline) → surface nothing. A break must exist below the cluster.
  return brokeAway ? cluster : [];
}

/**
 * Rank workflow catalog entries against a query — the engine behind the
 * `search_workflows` tool, exported so the staged-orchestration discovery prefetch
 * can surface candidate workflows up-front (in parallel with agent discovery)
 * without spending a separate slow tool round. Returns [] when nothing clears the
 * relevance floor. Never throws on an empty/garbage query (returns []).
 *
 * `semanticOutlier` mode (used by the auto-injected discovery capsule) ignores the
 * keyword score entirely and surfaces a workflow ONLY when its semantic score is a
 * clear standout (see selectStandoutSemanticMatches) — so the capsule never steers
 * the model toward a deliverable-shape workflow the request did not clearly call for
 * (audit 7839e153: a hardware-design request was wrongly routed into a slide-deck
 * job). It requires semantic search to be available and never falls back to keywords.
 * The plain `search_workflows` tool keeps broad keyword+semantic recall.
 */
export async function searchWorkflowCandidates(
  query: string,
  opts?: { workflowType?: "scene" | "job" | "any"; limit?: number; semanticOutlier?: boolean },
): Promise<WorkflowCandidateSummary[]> {
  const q = query.trim();
  if (!q) return [];
  const workflowType = opts?.workflowType === "scene" || opts?.workflowType === "job" ? opts.workflowType : "any";
  const limit = Math.max(1, Math.min(8, Math.floor(opts?.limit ?? 5) || 5));
  const entries = buildWorkflowCatalogEntries().filter((entry) => workflowType === "any" || entry.workflowType === workflowType);
  if (entries.length === 0) return [];
  const semanticScores = await computeSemanticWorkflowScores(q, entries);
  const semanticAvailable = semanticScores.size > 0;

  const scored = entries.map((entry) => {
    const keyword = scoreWorkflowKeywordMatch(q, entry);
    const semanticScore = semanticScores.get(entry.key) ?? 0;
    return {
      entry,
      keywordScore: keyword.score,
      semanticScore,
      combinedScore: combineWorkflowScores(keyword.score, semanticScore, semanticAvailable),
      matchedTerms: keyword.matchedTerms,
    } satisfies WorkflowSearchCandidate;
  });

  let selected: WorkflowSearchCandidate[];
  if (opts?.semanticOutlier) {
    // Direction-setting capsule: pure semantic, no keyword fallback. If embeddings
    // are unavailable, surface nothing rather than guessing.
    if (!semanticAvailable) return [];
    const bySemantic = [...scored].sort((a, b) => b.semanticScore - a.semanticScore);
    selected = selectStandoutSemanticMatches(bySemantic).slice(0, limit);
  } else {
    selected = scored
      .filter((candidate) => candidate.combinedScore >= 0.18)
      .sort(sortWorkflowSearchCandidates)
      .slice(0, limit);
  }

  return selected.map((candidate) => ({
    name: candidate.entry.name,
    workflowType: candidate.entry.workflowType,
    description: candidate.entry.description,
    score: candidate.combinedScore,
    semanticScore: candidate.semanticScore,
    matchedTerms: candidate.matchedTerms,
  }));
}

registerTool({
  name: "search_workflows",
  description: "Search reusable workflow catalog entries across scenes and jobs. Use this before ad hoc coordinator planning when the request may match a recurring workflow such as a research packet, paper, browser inspection, review, or broadcast.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural-language description of the workflow shape you want to find.",
      },
      workflowType: {
        type: "string",
        enum: ["any", "scene", "job"],
        description: "Optional workflow type filter. Default: any.",
      },
      limit: {
        type: "number",
        description: "Maximum number of matches to return. Default: 5.",
      },
    },
    required: ["query"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const query = String(args["query"] ?? "").trim();
    if (!query) {
      return { success: false, output: "", error: "query is required" };
    }

    const workflowType = args["workflowType"] === "scene" || args["workflowType"] === "job"
      ? args["workflowType"]
      : "any";
    const limit = Math.max(1, Math.min(8, Number(args["limit"] ?? 5) || 5));
    const entries = buildWorkflowCatalogEntries().filter((entry) => workflowType === "any" || entry.workflowType === workflowType);

    if (entries.length === 0) {
      return {
        success: true,
        output: "No workflow catalog entries are configured. Use agent orchestration directly until scenes or jobs are added.",
      };
    }

    const semanticScores = await computeSemanticWorkflowScores(query, entries);
    const semanticAvailable = semanticScores.size > 0;
    const candidates = entries
      .map((entry) => {
        const keyword = scoreWorkflowKeywordMatch(query, entry);
        const semanticScore = semanticScores.get(entry.key) ?? 0;
        return {
          entry,
          keywordScore: keyword.score,
          semanticScore,
          combinedScore: combineWorkflowScores(keyword.score, semanticScore, semanticAvailable),
          matchedTerms: keyword.matchedTerms,
        } satisfies WorkflowSearchCandidate;
      })
      .filter((candidate) => candidate.combinedScore >= 0.18)
      .sort(sortWorkflowSearchCandidates)
      .slice(0, limit);

    if (candidates.length === 0) {
      return {
        success: true,
        output: `No workflows matched "${query}" strongly enough. Fall back to search_agents or direct coordinator planning for this request shape.`,
        metadata: { workflowMatches: [], semanticAvailable },
      };
    }

    return {
      success: true,
      output: [
        `Workflow matches for "${query}":`,
        "",
        ...candidates.map(formatWorkflowCandidate),
        "",
        "NEXT ACTION: If one of these fits closely, call run_workflow with the returned workflow name and type instead of inventing a new coordinator plan.",
      ].join("\n"),
      metadata: {
        workflowMatches: candidates.map((candidate) => ({
          name: candidate.entry.name,
          workflowType: candidate.entry.workflowType,
          score: candidate.combinedScore,
          matchedTerms: candidate.matchedTerms,
        })),
        semanticAvailable,
      },
    };
  },
});

registerTool({
  name: "run_workflow",
  description: "Execute a reusable workflow catalog entry inline. Scenes run as one scoped turn, and jobs run their resolved steps in sequence inside a temporary workflow session.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Workflow name from search_workflows or the configured scenes/jobs catalog.",
      },
      workflowType: {
        type: "string",
        enum: ["auto", "scene", "job"],
        description: "Optional explicit workflow type. Default: auto.",
      },
      params: {
        type: "object",
        description: "Optional string parameters for workflow template substitution.",
        additionalProperties: { type: "string" },
      },
      context: {
        type: "string",
        description: "Optional extra workflow context or acceptance criteria to append to the first step.",
      },
    },
    required: ["name"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const name = String(args["name"] ?? "").trim();
    if (!name) {
      return { success: false, output: "", error: "name is required" };
    }

    const workflowType = args["workflowType"] === "scene" || args["workflowType"] === "job"
      ? args["workflowType"]
      : "auto";
    const params = normalizeStringMap(args["params"]);
    const workflowContext = typeof args["context"] === "string" ? String(args["context"]) : undefined;

    const { scene, job, ambiguousMatches, suggestedMatches } = resolveWorkflowReference(name, workflowType);

    if (workflowType === "auto" && scene && job) {
      return {
        success: false,
        output: "",
        error: `Workflow name '${name}' is ambiguous. Specify workflowType='scene' or workflowType='job'.`,
        metadata: {
          workflowMatches: buildWorkflowMatchMetadata(rankWorkflowReferenceCandidates(name, workflowType)),
        },
      };
    }

    if (!scene && !job) {
      if (ambiguousMatches && ambiguousMatches.length > 1) {
        const workflowMatches = buildWorkflowMatchMetadata(
          (suggestedMatches ?? []).filter((candidate) => ambiguousMatches.some((entry) => (
            entry.name === candidate.entry.name && entry.workflowType === candidate.entry.workflowType
          ))),
        );
        return {
          success: false,
          output: "",
          error: `Workflow name '${name}' is ambiguous. Matching workflows: ${ambiguousMatches.map((entry) => `${entry.name} [${entry.workflowType}]`).join(", ")}.`,
          metadata: workflowMatches.length > 0 ? { workflowMatches } : undefined,
        };
      }

      const workflowMatches = buildWorkflowMatchMetadata(suggestedMatches ?? []);
      // GRACEFUL, NOT AN ERROR (user directive: "not finding a workflow should not lead
      // to an error"). A missing workflow is a routing miss, not a system failure —
      // returning success:false tripped the whole failure cascade (tool_call_failed, the
      // stop/new-session intervention, [DELEGATION FAILED], warden failure count) and on
      // the slow local model that pushed it to fabricate a full answer instead of routing
      // on (audit bd3d60dc). Return SUCCESS with routing guidance so the model simply
      // delegates; the runtime keys on workflowNotFound to skip the "completed" framing.
      const closest = workflowMatches.length > 0
        ? ` Closest saved workflows: ${workflowMatches.map((match) => `${match.name} [${match.workflowType}]`).join(", ")}.`
        : "";
      return {
        success: true,
        output: `No saved workflow matches "${name}" — this is NOT an error, there is simply no reusable workflow for this request.${closest} Do NOT invent another workflow name or call run_workflow again. If one of the listed workflows CLEARLY matches the request, run that exact name; otherwise delegate to mission_coordinator (or answer the user directly).`,
        metadata: { workflowNotFound: true, ...(workflowMatches.length > 0 ? { workflowMatches } : {}) },
      };
    }

    const selectedWorkflowType = scene ? "scene" : "job";
    const selectedWorkflowName = scene?.name ?? job!.name;
    const selectedWorkflowKey = buildWorkflowExecutionKey(selectedWorkflowName, selectedWorkflowType);
    if (ctx._workflowExecutionStack?.includes(selectedWorkflowKey)) {
      const error = `Workflow ${selectedWorkflowName} [${selectedWorkflowType}] is already running in this execution stack. Do not re-enter the same workflow from inside itself.`;
      return {
        success: false,
        output: error,
        error,
        metadata: {
          workflowName: selectedWorkflowName,
          workflowType: selectedWorkflowType,
          blocked: true,
          recursiveWorkflow: true,
        },
      };
    }

    // Pre-validate that every scene referenced by the resolved job actually
    // exists.  resolveJobSteps throws "Job step references unknown scene: X"
    // when a scene is missing — without this guard, the throw bubbles up the
    // tool dispatcher and (until the executeTool try/catch was added) killed
    // the turn silently with no tool_call_failed event.  Surface the missing
    // names directly so the user knows which scenes to add to scenes: {}.
    if (job) {
      const missingScenes = job.steps
        .map((step) => step.scene)
        .filter((sceneName, index, arr) => arr.indexOf(sceneName) === index)
        .filter((sceneName) => !getScene(sceneName));
      if (missingScenes.length > 0) {
        return {
          success: false,
          output: "",
          error:
            `Workflow '${job.name}' [job] references ${missingScenes.length === 1 ? "a scene" : "scenes"} that ${missingScenes.length === 1 ? "is" : "are"} not defined in the current config: ${missingScenes.map((s) => `'${s}'`).join(", ")}. `
            + "Add the missing scene(s) to your starlingai.json under `scenes: { ... }`, or remove the job from your config. "
            + "Without the underlying scene definitions, the job cannot resolve its steps to executable tasks.",
          metadata: {
            workflowName: job.name,
            workflowType: "job",
            blocked: true,
            missingScenes,
            stepCount: job.steps.length,
          },
        };
      }
    }

    if (scene) {
      const result = await runSceneInline(scene, params, workflowContext, ctx);
      const output = `Workflow ${scene.name} [scene] ${result.blocked ? "blocked" : "completed"}${result.bootstrapAgent ? ` via ${result.bootstrapAgent} bootstrap` : ""}.\n\n${result.response}`;
      return {
        success: !result.blocked,
        output,
        error: result.blocked ? output : undefined,
        metadata: {
          workflowName: scene.name,
          workflowType: "scene",
          blocked: result.blocked,
          toolCallsExecuted: result.toolCallsExecuted,
          stepCount: 1,
          bootstrapAgent: result.bootstrapAgent,
          // Propagate scene-built artifacts (deck/images/paper) so the parent turn
          // surfaces them as clickable downloads and the auto-build doesn't re-fire.
          ...(result.artifacts && result.artifacts.length > 0 ? { artifacts: result.artifacts } : {}),
        },
      };
    }

    const result = await runJobInline(job!, params, workflowContext, ctx);
    const output = `Workflow ${job!.name} [job] ${result.blocked ? "blocked" : "completed"}.\n\n${result.response}`;
    return {
      success: !result.blocked,
      output,
      error: result.blocked ? output : undefined,
      metadata: {
        workflowName: job!.name,
        workflowType: "job",
        blocked: result.blocked,
        toolCallsExecuted: result.toolCallsExecuted,
        stepCount: job!.steps.length,
        executedSteps: result.executedSteps,
        // Propagate the build step's artifacts so the parent turn surfaces downloads
        // and the auto-build doesn't re-fire (see runJobInline).
        ...(result.artifacts && result.artifacts.length > 0 ? { artifacts: result.artifacts } : {}),
      },
    };
  },
});