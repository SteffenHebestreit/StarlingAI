import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { childLogger } from "../logger.js";

const log = childLogger("agent:config-assistant-proposals");

const PROPOSALS_FILE = ".starlingai/config_assistant_proposals.json";

export type ConversationProposalStatus = "pending" | "applied" | "rejected";
export type ConversationFeedbackOutcome = "success" | "failure" | "partial" | "rejected";
export const MAIN_ASSISTANT_PROMPT_TARGET = "main_assistant";

export interface ConversationConfigChange {
  path: string;
  value: unknown;
  reason: string;
}

export interface ConversationPromptChange {
  agentName: string;
  strategy: "replace" | "append";
  prompt: string;
  rationale: string;
}

export interface ConversationProposalFeedback {
  ts: string;
  outcome: ConversationFeedbackOutcome;
  lesson?: string;
  notes?: string;
}

export interface ConversationConfigProposal {
  id: string;
  ts: string;
  status: ConversationProposalStatus;
  mode: "setup" | "enhancement" | "prompt";
  request: string;
  summary: string;
  assistantAgent: string;
  targetAgent?: string;
  configChanges: ConversationConfigChange[];
  promptChanges: ConversationPromptChange[];
  validations: string[];
  tags: string[];
  lesson?: string;
  appliedAt?: string;
  feedbackHistory: ConversationProposalFeedback[];
}

export function listConversationConfigProposals(workspacePath: string, limit = 50): ConversationConfigProposal[] {
  return readAllConversationConfigProposals(workspacePath)
    .sort((left, right) => right.ts.localeCompare(left.ts))
    .slice(0, limit);
}

export function getConversationConfigProposal(workspacePath: string, id: string): ConversationConfigProposal | null {
  return readAllConversationConfigProposals(workspacePath).find((proposal) => proposal.id === id) ?? null;
}

export function createConversationConfigProposal(
  workspacePath: string,
  input: Omit<ConversationConfigProposal, "id" | "ts" | "feedbackHistory"> & {
    id?: string;
    ts?: string;
    feedbackHistory?: ConversationProposalFeedback[];
  },
): ConversationConfigProposal {
  const proposals = readAllConversationConfigProposals(workspacePath);
  const proposal: ConversationConfigProposal = {
    ...input,
    id: input.id ?? randomUUID(),
    ts: input.ts ?? new Date().toISOString(),
    feedbackHistory: input.feedbackHistory ?? [],
  };
  proposals.push(proposal);
  writeAllConversationConfigProposals(workspacePath, proposals);
  return proposal;
}

export function updateConversationConfigProposal(
  workspacePath: string,
  id: string,
  updater: (proposal: ConversationConfigProposal) => ConversationConfigProposal,
): ConversationConfigProposal | null {
  const proposals = readAllConversationConfigProposals(workspacePath);
  const index = proposals.findIndex((proposal) => proposal.id === id);
  if (index === -1) return null;

  const updated = updater(proposals[index]!);
  proposals[index] = updated;
  writeAllConversationConfigProposals(workspacePath, proposals);
  return updated;
}

export function appendConversationConfigProposalFeedback(
  workspacePath: string,
  id: string,
  feedback: Omit<ConversationProposalFeedback, "ts"> & { ts?: string },
): ConversationConfigProposal | null {
  return updateConversationConfigProposal(workspacePath, id, (proposal) => ({
    ...proposal,
    feedbackHistory: [
      ...proposal.feedbackHistory,
      {
        ts: feedback.ts ?? new Date().toISOString(),
        outcome: feedback.outcome,
        lesson: feedback.lesson?.trim() || undefined,
        notes: feedback.notes?.trim() || undefined,
      },
    ],
  }));
}

export function applyObjectPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".").map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) return;

  let cursor: Record<string, unknown> = root;
  for (let index = 0; index < segments.length - 1; index++) {
    const segment = segments[index]!;
    const next = cursor[segment];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }

  cursor[segments[segments.length - 1]!] = value;
}

export function applyPromptChange(root: Record<string, unknown>, change: ConversationPromptChange): void {
  if (change.agentName === MAIN_ASSISTANT_PROMPT_TARGET) {
    const agents = (root["agents"] as Record<string, unknown> | undefined) ?? {};
    root["agents"] = agents;
    const mainAssistant = (agents["mainAssistant"] as Record<string, unknown> | undefined) ?? {};
    const currentPrompt = typeof mainAssistant["customInstructions"] === "string"
      ? mainAssistant["customInstructions"] as string
      : "";
    agents["mainAssistant"] = {
      ...mainAssistant,
      customInstructions: change.strategy === "append" && currentPrompt.trim()
        ? `${currentPrompt.trim()}\n\n${change.prompt.trim()}`
        : change.prompt.trim(),
    };
    return;
  }

  const subAgents = (root["subAgents"] as Record<string, unknown> | undefined) ?? {};
  root["subAgents"] = subAgents;
  const currentAgent = (subAgents[change.agentName] as Record<string, unknown> | undefined) ?? {};
  const currentPrompt = typeof currentAgent["systemPrompt"] === "string" ? currentAgent["systemPrompt"] as string : "";
  subAgents[change.agentName] = {
    ...currentAgent,
    systemPrompt: change.strategy === "append" && currentPrompt.trim()
      ? `${currentPrompt.trim()}\n\n${change.prompt.trim()}`
      : change.prompt.trim(),
  };
}

export function hasPromptTarget(root: { subAgents?: Record<string, unknown> }, target: string | undefined): boolean {
  if (!target) return true;
  if (target === MAIN_ASSISTANT_PROMPT_TARGET) return true;
  return Boolean(root.subAgents?.[target]);
}

/**
 * Only paths under the workspace zone (agents, subAgents, scenes) are mutable.
 * Everything else — providers, gateway, guardrails, channels, infrastructure,
 * multimodal, integrations, webhooks, sites, mcp, computerUse, etc. — is protected.
 * Additionally, credential-like segments are always blocked as a safety net.
 */
const MUTABLE_TOP_LEVEL_KEYS = new Set(["agents", "subagents", "scenes"]);

export function isProtectedConfigPath(path: string): boolean {
  const normalized = path.trim().toLowerCase();
  if (!normalized) return true;

  // Credential-like segments are always blocked
  if (/(secret|password|token|apikey|api_key|privatekey|private_key|credential|credentials)/i.test(normalized)) {
    return true;
  }

  // Only allow changes under the mutable workspace keys
  const topKey = normalized.split(".")[0]!;
  return !MUTABLE_TOP_LEVEL_KEYS.has(topKey);
}

function readAllConversationConfigProposals(workspacePath: string): ConversationConfigProposal[] {
  const file = resolve(workspacePath, PROPOSALS_FILE);
  if (!existsSync(file)) return [];

  try {
    const raw = readFileSync(file, "utf-8");
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw) as ConversationConfigProposal[];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    log.warn({ err }, "Failed to read config assistant proposals");
    return [];
  }
}

function writeAllConversationConfigProposals(workspacePath: string, proposals: ConversationConfigProposal[]): void {
  try {
    const dir = resolve(workspacePath, ".starlingai");
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(workspacePath, PROPOSALS_FILE), `${JSON.stringify(proposals, null, 2)}\n`, "utf-8");
  } catch (err) {
    log.warn({ err }, "Failed to persist config assistant proposals");
  }
}