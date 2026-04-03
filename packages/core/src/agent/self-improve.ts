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
 */
import { v4 as uuid } from "uuid";
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";
import { emitSwarmEvent } from "../swarm/bus.js";
import { getConfig } from "../config/loader.js";
import { getToolsAsLLMDefs } from "../tools/registry.js";
import { ephemeralPut, ephemeralQuery } from "../runtime/ephemeral-store/index.js";
import {
  markApproved,
  markRejected,
  type ToolDevSession,
} from "./tool-dev-session.js";
import { deployApprovedTool, type DynamicToolDefinition } from "../tools/dynamic-tools.js";

const log = childLogger("self-improve");

// ── Capability Gap Tracking ─────────────────────────────────────────────────

export interface CapabilityGap {
  id: string;
  description: string;
  exampleInput?: string;
  exampleOutput?: string;
  detectedAt: string;
  failureCount: number;
  failurePatterns: string[];
  status: "detected" | "proposed" | "developing" | "submitted" | "deployed" | "rejected";
  devSessionId?: string;
  proposedToolName?: string;
}

const _gaps = new Map<string, CapabilityGap>();

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

  // Check for an existing similar gap by keyword overlap
  const existing = findSimilarGap(opts.description);

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

// ── Load persisted gaps on startup ──────────────────────────────────────────

export async function loadPersistedGaps(): Promise<void> {
  try {
    const entries = await ephemeralQuery({ namespace: "capability-gaps", limit: 100 });
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

function findSimilarGap(description: string): CapabilityGap | undefined {
  const words = extractKeywords(description);
  let bestMatch: CapabilityGap | undefined;
  let bestScore = 0;

  for (const gap of _gaps.values()) {
    if (gap.status === "deployed" || gap.status === "rejected") continue;

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

function persistGap(gap: CapabilityGap): void {
  ephemeralPut({
    namespace: "capability-gaps",
    key: gap.id,
    value: JSON.stringify(gap),
  }).catch((err) => {
    log.warn({ err, gapId: gap.id }, "Failed to persist capability gap");
  });
}
