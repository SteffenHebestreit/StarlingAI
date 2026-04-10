/**
 * Self-Improvement Orchestrator — detects capability gaps, designs tools,
 * develops them in the sandbox, and submits for approval.
 *
 * Bounded rules:
 *   ALLOWED:     new tools, new agents, prompts, routing metadata, sandbox tests,
 *                candidate manifests, embeddings/index metadata.
 *   DISALLOWED:  credentials, gateway auth, approval bypasses, tier weakening,
 *                host execution, Docker socket exposure, guardrail deactivation.
 *
 * Every tool must go through: design → sandbox → test → approve → deploy.
 *
 * Pipeline driver (startSelfImprovementDriver):
 *   Polls every DRIVER_POLL_INTERVAL_MS for "proposed" gaps and calls the LLM
 *   with buildToolProposalPrompt to generate a ToolProposal, then creates a
 *   ToolDevSession so the sandbox can build and test the tool.  This closes the
 *   previously missing link between "proposed" status and actual development.
 */
import { v4 as uuid } from "uuid";
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";
import { emitSwarmEvent } from "../swarm/bus.js";
import { getConfig } from "../config/loader.js";
import { getToolsAsLLMDefs } from "../tools/registry.js";
import { ephemeralPut, ephemeralQuery } from "../runtime/ephemeral-store/index.js";
import { getChatProvider, getEmbeddingProvider } from "../providers/index.js";
import {
  createToolDevSession,
  markApproved,
  markRejected,
  type ToolDevSession,
} from "./tool-dev-session.js";
import { deployApprovedTool, type DynamicToolDefinition } from "../tools/dynamic-tools.js";

const log = childLogger("self-improve");

// ── Driver constants ────────────────────────────────────────────────────────

/** How often the driver polls for proposed gaps and kicks off dev sessions. */
const DRIVER_POLL_INTERVAL_MS = 30_000; // 30 seconds

let _driverInterval: ReturnType<typeof setInterval> | null = null;

// ── Capability Gap Tracking ─────────────────────────────────────────────────

export interface CapabilityGap {
  id: string;
  description: string;
  exampleInput?: string;
  exampleOutput?: string;
  detectedAt: string;
  failureCount: number;
  failurePatterns: string[];
  status: "detected" | "proposed" | "developing" | "submitted" | "deployed" | "closed" | "rejected";
  devSessionId?: string;
  proposedToolName?: string;
  /** Successful invocations of the deployed tool since deployment. */
  successfulUses?: number;
  /** How many times the driver attempted (and failed) to parse an LLM proposal for this gap. */
  devAttemptCount?: number;
  /** ISO timestamp of the last driver development attempt. Used for exponential back-off. */
  lastDevAttemptAt?: string;
}

const _gaps = new Map<string, CapabilityGap>();

/** In-process embedding cache: gapId → embedding vector. */
const _gapEmbeddings = new Map<string, Float32Array>();

// ── Gap Detection ───────────────────────────────────────────────────────────

/**
 * Record a capability gap from an agent failure.
 * If enough similar failures accumulate, triggers a tool proposal.
 */
export async function recordCapabilityGap(opts: {
  description: string;
  exampleInput?: string;
  exampleOutput?: string;
  sessionId: string;
  agentName?: string;
}): Promise<CapabilityGap> {
  const config = getConfig();
  if (!config.selfImprovement.enabled) {
    throw new Error("Self-improvement is disabled");
  }

  // Check for an existing similar gap — semantic first, keyword fallback
  const existing = await findSimilarGap(opts.description);

  if (existing) {
    existing.failureCount++;
    existing.failurePatterns.push(opts.description.slice(0, 200));
    if (existing.failurePatterns.length > 20) existing.failurePatterns.shift();
    persistGap(existing);

    log.info(
      { gapId: existing.id, failureCount: existing.failureCount },
      "Capability gap failure count incremented",
    );

    // Check if threshold reached for proposal
    if (
      existing.failureCount >= config.selfImprovement.minFailuresBeforeProposal &&
      existing.status === "detected"
    ) {
      await maybePropose(existing, opts.sessionId);
    }

    return existing;
  }

  // New gap
  const gap: CapabilityGap = {
    id: uuid(),
    description: opts.description,
    exampleInput: opts.exampleInput,
    exampleOutput: opts.exampleOutput,
    detectedAt: new Date().toISOString(),
    failureCount: 1,
    failurePatterns: [opts.description.slice(0, 200)],
    status: "detected",
  };

  _gaps.set(gap.id, gap);
  persistGap(gap);

  emitSwarmEvent("capability_gap_detected", {
    sessionId: opts.sessionId,
    agentName: opts.agentName,
    data: { gapId: gap.id, description: opts.description },
  });

  logAudit("capability_gap_detected", { gapId: gap.id, description: opts.description }, {
    sessionId: opts.sessionId,
    severity: "info",
  });

  log.info({ gapId: gap.id, description: opts.description.slice(0, 100) }, "New capability gap detected");

  // Check immediate threshold (e.g. minFailures = 1)
  if (gap.failureCount >= config.selfImprovement.minFailuresBeforeProposal) {
    await maybePropose(gap, opts.sessionId);
  }

  return gap;
}

/**
 * List all tracked capability gaps.
 */
export function listCapabilityGaps(): CapabilityGap[] {
  return [..._gaps.values()];
}

/** Reset all in-memory state — for tests only. */
export function resetSelfImprovementForTests(): void {
  _gaps.clear();
  _gapEmbeddings.clear();
  stopSelfImprovementDriver();
}

/**
 * Get a specific gap by ID.
 */
export function getCapabilityGap(id: string): CapabilityGap | undefined {
  return _gaps.get(id);
}

// ── Tool Proposal ───────────────────────────────────────────────────────────

/**
 * Design a tool specification to fill a capability gap.
 *
 * This generates the tool name, description, parameters schema, and
 * a starter implementation using LLM-generated code.
 *
 * Returns a tool proposal that can be used to start a dev session.
 */
export interface ToolProposal {
  gapId: string;
  toolName: string;
  description: string;
  parametersSchema: Record<string, unknown>;
  starterCode: string;
  testCases: Array<{ input: Record<string, unknown>; expectedOutput?: string }>;
  rationale: string;
}

/**
 * Generate a tool proposal from a capability gap.
 *
 * Uses the existing tool registry as context so the LLM knows
 * what capabilities already exist and doesn't duplicate them.
 */
export function buildToolProposalPrompt(gap: CapabilityGap): string {
  const existingTools = getToolsAsLLMDefs();
  const toolList = existingTools
    .map((t) => `- ${t.name}: ${t.description}`)
    .join("\n");

  return `You are a tool architect for the StarlingAI agent platform.

## Capability Gap
${gap.description}

${gap.exampleInput ? `**Example Input:** ${gap.exampleInput}` : ""}
${gap.exampleOutput ? `**Example Output:** ${gap.exampleOutput}` : ""}

**Failure patterns (${gap.failureCount} occurrences):**
${gap.failurePatterns.slice(-5).map((p) => `- ${p}`).join("\n")}

## Existing Tools (do NOT duplicate)
${toolList}

## Requirements
Design a NEW tool that fills this gap. Respond with valid JSON:

\`\`\`json
{
  "toolName": "snake_case_name",
  "description": "Clear description for the LLM tool catalog",
  "parametersSchema": {
    "type": "object",
    "properties": { ... },
    "required": [ ... ]
  },
  "starterCode": "TypeScript code that exports an execute(args) function",
  "testCases": [
    { "input": { ... }, "expectedOutput": "expected substring in output" }
  ],
  "rationale": "Why this tool is needed and how it fills the gap"
}
\`\`\`

## Constraints
- Tool must define an \`execute(args: Record<string, unknown>)\` function
- No direct filesystem access (use sandbox APIs)
- No process.env access (use credential tools)
- No child_process, eval(), or Function constructor
- Keep it focused — one tool per gap, not a Swiss Army knife
- Include at least 2 test cases
- Name must be snake_case, 2-49 chars, start with a letter`;
}

// ── Self-Improvement Pipeline ───────────────────────────────────────────────

/**
 * Complete self-improvement cycle for an approved tool.
 * Called after human approval resolves.
 */
export function completeImprovement(
  session: ToolDevSession,
  approvedBy: string = "human",
): void {
  const def: DynamicToolDefinition = {
    name: session.toolName,
    description: session.description,
    parameters: session.parametersSchema,
    code: session.code,
    version: 1,
    approvedAt: new Date().toISOString(),
    approvedBy,
    testResults: session.testResults,
    devSessionId: session.id,
  };

  // Deploy the tool
  deployApprovedTool(def);
  markApproved(session.id);
  updateGapStatusForSession(session.id, "deployed");

  logAudit("self_improvement_completed", {
    toolName: session.toolName,
    devSessionId: session.id,
    iterations: session.iterations,
    approvedBy,
  }, {
    sessionId: session.sessionId,
    severity: "info",
  });

  log.info(
    { toolName: session.toolName, devSessionId: session.id },
    "Self-improvement cycle completed — tool deployed",
  );
}

export function rejectImprovement(
  session: ToolDevSession,
  rejectedBy: string = "human",
): void {
  markRejected(session.id);
  updateGapStatusForSession(session.id, "rejected");

  logAudit("tool_dev_session_terminated", {
    devSessionId: session.id,
    toolName: session.toolName,
    reason: "approval_denied",
    rejectedBy,
  }, {
    sessionId: session.sessionId,
    severity: "warn",
  });

  log.info(
    { toolName: session.toolName, devSessionId: session.id, rejectedBy },
    "Self-improvement deployment rejected",
  );
}

export function markImprovementSubmitted(sessionId: string): void {
  updateGapStatusForSession(sessionId, "submitted");
}

// ── Pipeline Driver ─────────────────────────────────────────────────────────

/**
 * Start the background driver that picks up "proposed" capability gaps and
 * drives them into active ToolDevSessions via LLM-generated proposals.
 * Safe to call multiple times — idempotent.
 */
export function startSelfImprovementDriver(): void {
  if (_driverInterval) return;

  _driverInterval = setInterval(() => {
    processProposedGaps().catch((err) => {
      log.warn({ err }, "Self-improvement driver iteration failed");
    });
  }, DRIVER_POLL_INTERVAL_MS);
  _driverInterval.unref();

  log.info({ pollIntervalMs: DRIVER_POLL_INTERVAL_MS }, "Self-improvement driver started");
}

/** Stop the background driver. */
export function stopSelfImprovementDriver(): void {
  if (_driverInterval) {
    clearInterval(_driverInterval);
    _driverInterval = null;
  }
}

/** Exposed for tests — trigger one driver sweep synchronously. */
export async function processSelfImprovementDriverNow(): Promise<void> {
  await processProposedGaps();
}

/** Max back-off delay between driver retries for a single gap (1 hour). */
const MAX_DEV_BACKOFF_MS = 60 * 60_000;

async function processProposedGaps(): Promise<void> {
  const config = getConfig();
  if (!config.selfImprovement?.enabled) return;

  // Only process one gap per tick to avoid LLM request storms.
  // Skip gaps whose exponential back-off window has not yet elapsed.
  const now = Date.now();
  const proposedGap = [..._gaps.values()].find((g) => {
    if (g.status !== "proposed") return false;
    const attempts = g.devAttemptCount ?? 0;
    if (attempts === 0) return true;
    const backoffMs = Math.min(Math.pow(2, attempts) * DRIVER_POLL_INTERVAL_MS, MAX_DEV_BACKOFF_MS);
    const lastAttempt = g.lastDevAttemptAt ? Date.parse(g.lastDevAttemptAt) : 0;
    return now - lastAttempt >= backoffMs;
  });
  if (!proposedGap) return;

  log.info({ gapId: proposedGap.id }, "Driver found proposed gap — starting tool development");

  try {
    await startToolDevelopmentForGap(proposedGap);
  } catch (err) {
    log.warn({ err, gapId: proposedGap.id }, "Failed to start tool development for gap — will retry");
    // Revert to proposed so the driver retries on the next poll
    proposedGap.status = "proposed";
    persistGap(proposedGap);
  }
}

async function startToolDevelopmentForGap(gap: CapabilityGap): Promise<void> {
  // Claim the gap immediately to prevent double-processing by parallel ticks
  gap.status = "developing";
  gap.devAttemptCount = (gap.devAttemptCount ?? 0) + 1;
  gap.lastDevAttemptAt = new Date().toISOString();
  persistGap(gap);

  const prompt = buildToolProposalPrompt(gap);

  const provider = getChatProvider();
  const response = await provider.complete(
    [{ role: "user", content: prompt }],
    [],
  );

  const proposal = parseToolProposal(gap.id, response.content ?? "");
  if (!proposal) {
    log.warn({ gapId: gap.id, devAttemptCount: gap.devAttemptCount }, "LLM returned unparseable tool proposal — reverting gap to proposed with back-off");
    gap.status = "proposed";
    persistGap(gap);
    return;
  }

  const session = createToolDevSession({
    toolName: proposal.toolName,
    description: proposal.description,
    parametersSchema: proposal.parametersSchema,
    sessionId: `selfimprove:${gap.id}`,
    agentName: "self_improve",
    starterCode: proposal.starterCode || undefined,
    plannedTestCases: proposal.testCases.length > 0 ? proposal.testCases : undefined,
  });

  gap.devSessionId = session.id;
  gap.proposedToolName = proposal.toolName;
  persistGap(gap);

  emitSwarmEvent("tool_dev_session_started", {
    data: {
      devSessionId: session.id,
      toolName: proposal.toolName,
      gapId: gap.id,
      rationale: proposal.rationale,
    },
  });

  logAudit("self_improvement_dev_started", {
    gapId: gap.id,
    devSessionId: session.id,
    toolName: proposal.toolName,
    rationale: proposal.rationale.slice(0, 200),
  }, { sessionId: `selfimprove:${gap.id}`, severity: "info" });

  log.info(
    { gapId: gap.id, devSessionId: session.id, toolName: proposal.toolName },
    "Tool development session started for capability gap",
  );
}

/**
 * Extract and validate a ToolProposal from an LLM completion string.
 * Supports both ```json ... ``` fenced blocks and raw JSON objects.
 */
function parseToolProposal(gapId: string, content: string): ToolProposal | null {
  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/i) ?? content.match(/(\{[\s\S]*\})/);
  if (!jsonMatch || !jsonMatch[1]) return null;

  try {
    const raw = JSON.parse(jsonMatch[1]) as Record<string, unknown>;

    const toolName = typeof raw["toolName"] === "string" ? raw["toolName"].trim() : "";
    const description = typeof raw["description"] === "string" ? raw["description"].trim() : "";
    const parametersSchema = raw["parametersSchema"] && typeof raw["parametersSchema"] === "object" && !Array.isArray(raw["parametersSchema"])
      ? raw["parametersSchema"] as Record<string, unknown>
      : null;
    const starterCode = typeof raw["starterCode"] === "string" ? raw["starterCode"] : "";
    const rationale = typeof raw["rationale"] === "string" ? raw["rationale"] : "";
    const testCases = Array.isArray(raw["testCases"])
      ? (raw["testCases"] as unknown[]).filter(
          (entry): entry is { input: Record<string, unknown>; expectedOutput?: string } =>
            typeof entry === "object" && entry !== null && "input" in entry,
        )
      : [];

    if (!toolName || !description || !parametersSchema) return null;

    // Validate tool name: snake_case, 2–49 chars, letter start
    if (!/^[a-z][a-z0-9_]{1,48}$/.test(toolName)) {
      log.warn({ toolName, gapId }, "Proposed tool name is invalid — discarding proposal");
      return null;
    }

    return { gapId, toolName, description, parametersSchema, starterCode, testCases, rationale };
  } catch {
    return null;
  }
}

// ── Load persisted gaps on startup ──────────────────────────────────────────

export async function loadPersistedGaps(): Promise<void> {
  try {
    const entries = await ephemeralQuery({ namespace: "capability-gaps", limit: 10_000 });
    for (const entry of entries) {
      try {
        const gap = JSON.parse(entry.value) as CapabilityGap;
        _gaps.set(gap.id, gap);
      } catch {
        // skip corrupt
      }
    }
    log.info({ count: _gaps.size }, "Loaded persisted capability gaps");
  } catch (err) {
    log.warn({ err }, "Failed to load persisted capability gaps");
  }
}

// ── Internal ────────────────────────────────────────────────────────────────

/**
 * Find an existing gap similar to the given description.
 * Tries semantic cosine similarity first (requires embedding model).
 * Falls back to keyword-overlap Jaccard when embeddings are unavailable.
 */
async function findSimilarGap(description: string): Promise<CapabilityGap | undefined> {
  const candidates = [..._gaps.values()].filter(
    (g) => g.status !== "deployed" && g.status !== "closed" && g.status !== "rejected",
  );
  if (candidates.length === 0) return undefined;

  // ── Semantic path ──────────────────────────────────────────────────────────
  try {
    const config = getConfig();
    const model = config.agents?.defaults?.model?.embeddingModel ?? config.agents?.defaults?.model?.primary;
    if (model) {
      const provider = getEmbeddingProvider();

      // Embed the incoming description
      const [incomingVec] = await provider.embed([description], model);
      if (incomingVec && incomingVec.length > 0) {
        // Embed any gap that isn't cached yet
        const uncached = candidates.filter((g) => !_gapEmbeddings.has(g.id));
        if (uncached.length > 0) {
          const vecs = await provider.embed(uncached.map((g) => g.description), model);
          for (let i = 0; i < uncached.length; i++) {
            const vec = vecs[i];
            if (vec && vec.length > 0) _gapEmbeddings.set(uncached[i]!.id, vec);
          }
        }

        let bestGap: CapabilityGap | undefined;
        let bestScore = 0;
        for (const gap of candidates) {
          const vec = _gapEmbeddings.get(gap.id);
          if (!vec) continue;
          const score = cosineSimilarity(incomingVec, vec);
          if (score > 0.82 && score > bestScore) {
            bestScore = score;
            bestGap = gap;
          }
        }
        if (bestGap) return bestGap;
      }
    }
  } catch {
    // Embedding unavailable — fall through to keyword similarity
  }

  // ── Keyword fallback ───────────────────────────────────────────────────────
  const words = extractKeywords(description);
  let bestMatch: CapabilityGap | undefined;
  let bestScore = 0;

  for (const gap of candidates) {
    const gapWords = extractKeywords(gap.description);
    const overlap = words.filter((w) => gapWords.includes(w)).length;
    const score = overlap / Math.max(words.length, gapWords.length, 1);
    if (score > 0.4 && score > bestScore) {
      bestScore = score;
      bestMatch = gap;
    }
  }

  return bestMatch;
}

function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  let normLeft = 0;
  let normRight = 0;
  for (let i = 0; i < left.length; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    dot += l * r;
    normLeft += l * l;
    normRight += r * r;
  }
  return normLeft === 0 || normRight === 0 ? 0 : dot / (Math.sqrt(normLeft) * Math.sqrt(normRight));
}

function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .filter((w) => !STOP_WORDS.has(w));
}

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had",
  "her", "was", "one", "our", "out", "has", "have", "been", "some",
  "with", "this", "that", "from", "they", "will", "would", "there",
  "their", "what", "about", "which", "when", "make", "like", "could",
  "into", "than", "then", "them", "just", "only", "also", "very",
  "tool", "agent", "need", "does", "doesn", "available",
]);

async function maybePropose(gap: CapabilityGap, sessionId: string): Promise<void> {
  const config = getConfig();

  // Check concurrent proposal limit
  const activeProposals = [..._gaps.values()].filter(
    (g) => g.status === "proposed" || g.status === "developing" || g.status === "submitted",
  ).length;

  if (activeProposals >= config.selfImprovement.maxConcurrentProposals) {
    log.info(
      { gapId: gap.id, activeProposals },
      "Max concurrent proposals reached — deferring",
    );
    return;
  }

  gap.status = "proposed";
  persistGap(gap);

  logAudit("capability_gap_proposal", { gapId: gap.id, description: gap.description, failureCount: gap.failureCount }, {
    sessionId,
    severity: "info",
  });

  log.info({ gapId: gap.id }, "Capability gap promoted to proposal status");
}

function updateGapStatusForSession(
  sessionId: string,
  status: CapabilityGap["status"],
): void {
  for (const gap of _gaps.values()) {
    if (gap.devSessionId !== sessionId) continue;
    gap.status = status;
    persistGap(gap);
  }
}

/**
 * Called after a successful selfdev__ tool invocation to track gap closure.
 * Once a deployed tool's success count reaches the configured threshold,
 * emits a "gap_confirmed_closed" audit event.
 */
export function recordSelfdevToolSuccess(toolName: string): void {
  const config = getConfig();
  const CLOSE_THRESHOLD = config.selfImprovement.gapClosureConfirmationCount ?? 5;
  for (const gap of _gaps.values()) {
    if (gap.proposedToolName !== toolName || gap.status !== "deployed") continue;
    gap.successfulUses = (gap.successfulUses ?? 0) + 1;
    if (gap.successfulUses >= CLOSE_THRESHOLD) {
      gap.status = "closed";
      logAudit("gap_confirmed_closed", {
        gapId: gap.id,
        toolName,
        successfulUses: gap.successfulUses,
        description: gap.description,
      }, { severity: "info" });
      log.info({ gapId: gap.id, toolName, successfulUses: gap.successfulUses }, "Capability gap confirmed closed by post-deployment feedback");
    }
    persistGap(gap);
    return;
  }
}

function persistGap(gap: CapabilityGap): void {
  ephemeralPut({
    namespace: "capability-gaps",
    key: gap.id,
    value: JSON.stringify(gap),
  }).catch((err) => {
    log.warn({ err, gapId: gap.id }, "Failed to persist capability gap");
  });
}
