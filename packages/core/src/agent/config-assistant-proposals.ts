import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isRuntimeSubAgent } from "../config/loader.js";
import { childLogger } from "../logger.js";

import { PRODUCT } from "../product/index.js";

const log = childLogger("agent:config-assistant-proposals");

const PROPOSALS_FILE = `${PRODUCT.stateDirName}/config_assistant_proposals.json`;

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
  /** The account that asked for it: its user-scope segment, never the raw user id. Absent with one
   *  operator, for a request with no user, and on proposals written before it existed. Under
   *  multi-user auth the request text goes back only to that account and to an admin
   *  (gateway/config-assistant-visibility.ts). */
  account?: string;
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

/** A config path as every reader here takes it: dot-separated, each segment trimmed, empty ones dropped. */
function pathSegments(path: string): string[] {
  return path.split(".").map((segment) => segment.trim()).filter(Boolean);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * An object value merged into the object already at its path: it sets what it names, `null` clears
 * a key, and what it leaves out stays. Replaced whole, a change copied from the assistant's
 * snapshot — which shows each agent only in part — dropped every field the snapshot never showed:
 * a `subAgents` map with one temperature changed took all 49 agents' systemPrompt and tools, and a
 * sub-agent's `model` lost its contextWindow (final review of the leftovers, 1). Arrays and scalars
 * still replace.
 */
function mergeChangeValue(existing: Record<string, unknown>, value: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null) delete merged[key];
    else if (isPlainRecord(entry) && isPlainRecord(merged[key])) merged[key] = mergeChangeValue(merged[key] as Record<string, unknown>, entry);
    else merged[key] = entry;
  }
  return merged;
}

export function applyObjectPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const segments = pathSegments(path);
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

  const leaf = segments[segments.length - 1]!;
  const existing = cursor[leaf];
  if (value === null) delete cursor[leaf];
  else if (isPlainRecord(value) && isPlainRecord(existing)) cursor[leaf] = mergeChangeValue(existing, value);
  else cursor[leaf] = value;
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
 * The agents a proposal writes into: each prompt change's, and the one a config change's
 * `subAgents.<name>` path names, read as applyObjectPath reads it. A change to `subAgents` itself
 * names every agent its value holds. Naming none, it went unchecked and could write a peer's agent
 * into the saved config, where it would outlive the peer (review of r6 leftovers, 3).
 */
export function proposalAgentNames(proposal: Pick<ConversationConfigProposal, "configChanges" | "promptChanges">): string[] {
  const configAgents = proposal.configChanges.flatMap((change) => {
    const segments = pathSegments(change.path);
    if (segments[0] !== "subAgents") return [];
    if (segments.length > 1) return [segments[1]!];
    // The whole map names the agents it writes. Not the ones it leaves out: the value is merged, so
    // it drops none, and counting those refused every whole-map change while any peer was bridged,
    // naming an agent the change never touched (round 2 of the leftovers review, LOW 1).
    const value = change.value;
    return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.keys(value) : [];
  });
  return [...proposal.promptChanges.map((change) => change.agentName), ...configAgents].filter((name): name is string => Boolean(name));
}

/**
 * Why a proposal may not change one of these agents, or undefined. An agent the A2A client bridged
 * in from a peer (a runtime sub-agent, laid over the loaded config and never saved) runs on the
 * peer, so its prompt and settings are not ours to change. Judged on the loaded config, a prompt
 * change aimed at one passed hasPromptTarget, and Apply wrote the saved config an agent of a prompt
 * alone, refused with an unclear "does not leave a valid config" (r5 A-security); a
 * `subAgents.<name>` config change met the same. Asked of the loader's own record of what it laid
 * over, not of the config on disk, so an agent deleted on disk is not called a peer's.
 */
export function peerAgentRefusal(names: Iterable<string | undefined>): string | undefined {
  for (const name of names) {
    if (name && isRuntimeSubAgent(name)) {
      return `Agent '${name}' is bridged in from an A2A peer and runs there, so its prompt and settings are the peer's to change, not ours.`;
    }
  }
  return undefined;
}

/**
 * Only paths under the workspace zone (agents, subAgents, scenes) are mutable.
 * Everything else — providers, gateway, guardrails, channels, infrastructure,
 * multimodal, integrations, webhooks, sites, mcp, computerUse, etc. — is protected.
 * Additionally, credential-like segments are always blocked as a safety net.
 *
 * A segment is credential-like when its name ENDS in a credential word (apiKey, botToken,
 * jwtSecret, secretAccessKey). Matched anywhere in the name, "token" caught maxTokens, a knob the
 * assistant's own snapshot lists: such a proposal was shown as applyable and then refused.
 */
const MUTABLE_TOP_LEVEL_KEYS = new Set(["agents", "subagents", "scenes"]);
const CREDENTIAL_SEGMENT = /(?:secret|password|token|api_?key|private_?key|access_?key|credentials?)$/i;

/** A field named as a credential: apiKey, botToken, jwtSecret, secretAccessKey — not maxTokens. */
export function isCredentialFieldName(name: string): boolean {
  return CREDENTIAL_SEGMENT.test(name);
}

export function isProtectedConfigPath(path: string): boolean {
  // Read as applyObjectPath reads it (pathSegments): split raw, "agents. subAgents" and
  // "agents..subAgents" passed this check and were written as agents.subAgents all the same
  // (final review of the leftovers, 2).
  const segments = pathSegments(path.toLowerCase());
  if (segments.length === 0) return true;

  // Credential-like segments are always blocked
  if (segments.some(isCredentialFieldName)) {
    return true;
  }

  // Only allow changes under the mutable workspace keys
  if (isMisplacedSubAgentPath(segments)) return true;
  return !MUTABLE_TOP_LEVEL_KEYS.has(segments[0]!);
}

/**
 * Sub-agents live at the top level. The assistant's snapshot once showed them under
 * agents.subAgents, so it drafted changes there: applied without error, read by nothing, and the
 * agent kept its settings (round 2 of the leftovers review, 2).
 */
function isMisplacedSubAgentPath(lowerSegments: string[]): boolean {
  return lowerSegments[0] === "agents" && lowerSegments[1] === "subagents";
}

/**
 * Why a config change is left out of a proposal and refused at apply, in words the person can act
 * on; undefined when it may be applied. Told "a protected path", the person read a sub-agent change
 * under the wrong path as sub-agent settings being off limits (final review of the leftovers, 4).
 */
export function configChangeRefusal(change: { path: string; value: unknown }): string | undefined {
  if (isMisplacedSubAgentPath(pathSegments(change.path.toLowerCase()))) {
    return `'${change.path}' is not where sub-agents live: their settings are at subAgents.<name>, so this change would do nothing.`;
  }
  if (isProtectedConfigChange(change)) return `'${change.path}' is a protected path or sets a credential.`;
  return undefined;
}

function carriesCredentialField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(carriesCredentialField);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([key, entry]) => isCredentialFieldName(key) || carriesCredentialField(entry));
}

/**
 * A change drafting leaves out and the apply route refuses — one predicate for both, so a draft
 * never offers what Apply will refuse. It is checked again at apply because the proposals file
 * sits in the workspace, where more than the drafter can write. And the value counts too —
 * `subAgents.x.model` set to `{ apiKey: … }` names no credential in its path.
 */
export function isProtectedConfigChange(change: { path: string; value: unknown }): boolean {
  return isProtectedConfigPath(change.path) || carriesCredentialField(change.value);
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
    const dir = resolve(workspacePath, PRODUCT.stateDirName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(workspacePath, PROPOSALS_FILE), `${JSON.stringify(proposals, null, 2)}\n`, "utf-8");
  } catch (err) {
    log.warn({ err }, "Failed to persist config assistant proposals");
  }
}