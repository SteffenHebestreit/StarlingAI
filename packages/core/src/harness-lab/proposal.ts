/**
 * What a lab run hands a person: one pending config-assistant proposal per accepted candidate,
 * filed in the deployment's own proposal store, applied only from Settings → Config Assistant
 * ("Apply With Consent"). The lab never applies anything.
 *
 * Appended rules go in as "append"; a replaced span makes the whole prompt a "replace", which
 * carries the hash of the prompt it was measured against, so applying it after someone changed
 * that prompt is refused instead of undoing their change (stalePromptChange). No flow-memory entry
 * is written here: flow guidance reaches the prompts, and a proposal nobody approved must not.
 *
 * A proposal names the tasks it was won on (tags "task:<id>"): until someone decides on it, a later
 * run does not take those tasks as targets again (pendingLabTargets). A new proposal that covers
 * every change of an older pending one (the same prompts, and the same rules in other words, or a
 * replace measured on the same prompt) supersedes it: applying both would add one rule twice.
 */
import {
  createConversationConfigProposal,
  hasPromptTarget,
  listConversationConfigProposals,
  MAIN_ASSISTANT_PROMPT_TARGET,
  peerAgentRefusal,
  promptSha256,
  updateConversationConfigProposal,
  type ConversationConfigProposal,
  type ConversationPromptChange,
} from "../agent/config-assistant-proposals.js";
import { logAudit } from "../audit/logger.js";
import { getConfig } from "../config/loader.js";
import { applyEdits, ruleOverlap, type LabEdit } from "./edit-format.js";
import type { GateDecision } from "./gate.js";

export const LAB_ASSISTANT_AGENT = "harness_lab";
const TASK_TAG = "task:";
/** How far back the proposal store is read for the lab's own pending proposals. */
const PROPOSAL_SCAN_LIMIT = 500;

function pendingLabProposals(workspacePath: string): ConversationConfigProposal[] {
  return listConversationConfigProposals(workspacePath, PROPOSAL_SCAN_LIMIT)
    .filter((proposal) => proposal.status === "pending" && proposal.assistantAgent === LAB_ASSISTANT_AGENT);
}

/** The tasks a pending lab proposal was won on, each with the reason to skip it as a target. */
export function pendingLabTargets(workspacePath: string): Map<string, string> {
  const skip = new Map<string, string>();
  for (const proposal of pendingLabProposals(workspacePath)) {
    for (const tag of proposal.tags) {
      if (tag.startsWith(TASK_TAG) && !skip.has(tag.slice(TASK_TAG.length))) {
        skip.set(tag.slice(TASK_TAG.length), `has a pending lab proposal (${proposal.id}): decide on it first`);
      }
    }
  }
  return skip;
}

function lines(prompt: string): string[] {
  return prompt.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** Whether `newer` makes `older` redundant: every change of the older one is in the newer one. */
export function coversChange(newer: readonly ConversationPromptChange[], older: ConversationPromptChange): boolean {
  return newer.some((change) => {
    if (change.agentName !== older.agentName) return false;
    if (older.strategy === "replace") return change.strategy === "replace" && change.baseSha256 !== undefined && change.baseSha256 === older.baseSha256;
    const newerLines = lines(change.prompt);
    return lines(older.prompt).every((line) => newerLines.some((other) => other === line || ruleOverlap(other, line) !== null));
  });
}

/** Mark the older pending lab proposals `proposal` covers as superseded (rejected, with a note); their ids. */
export function supersedeCoveredProposals(workspacePath: string, proposal: ConversationConfigProposal): string[] {
  const superseded: string[] = [];
  for (const older of pendingLabProposals(workspacePath)) {
    if (older.id === proposal.id || older.promptChanges.length === 0) continue;
    if (!older.promptChanges.every((change) => coversChange(proposal.promptChanges, change))) continue;
    updateConversationConfigProposal(workspacePath, older.id, (current) => ({
      ...current,
      status: "rejected",
      tags: [...current.tags, `superseded-by:${proposal.id}`],
      feedbackHistory: [...current.feedbackHistory, {
        ts: new Date().toISOString(),
        outcome: "rejected",
        notes: `Superseded by harness-lab proposal ${proposal.id}, which makes the same changes.`,
      }],
    }));
    superseded.push(older.id);
  }
  return superseded;
}

export function buildPromptChanges(basePrompts: Record<string, string>, allEdits: readonly LabEdit[], rationaleFor: (target: string) => string): ConversationPromptChange[] {
  // Skills are not config: a person adds an accepted one on the Skills page (the report holds its SKILL.md).
  const edits = allEdits.filter((edit) => edit.op !== "add_skill");
  const targets = [...new Set(edits.map((edit) => edit.target))];
  const after = applyEdits(basePrompts, edits);
  return targets.map((target) => {
    const own = edits.filter((edit) => edit.target === target);
    if (own.every((edit) => edit.op === "append_rule")) {
      return { agentName: target, strategy: "append" as const, prompt: own.map((edit) => edit.text).join("\n"), rationale: rationaleFor(target) };
    }
    return {
      agentName: target,
      strategy: "replace" as const,
      prompt: after[target] ?? basePrompts[target] ?? "",
      rationale: rationaleFor(target),
      baseSha256: promptSha256(basePrompts[target]),
    };
  });
}

export interface EmitInput {
  liveWorkspacePath: string;
  runId: string;
  basePrompts: Record<string, string>;
  edits: LabEdit[];
  /** The composer's decisions, as printed rows. */
  composerRows: string[];
  gate: GateDecision;
}

export type EmitResult = { proposal: ConversationConfigProposal; superseded: string[] } | { refused: string };

export function emitProposal(input: EmitInput): EmitResult {
  if (input.edits.length === 0) return { refused: "no edits to propose" };
  if (input.gate.verdict !== "accept") return { refused: `the gate did not accept the candidate (${input.gate.verdict})` };
  const promptEdits = input.edits.filter((edit) => edit.op !== "add_skill" && edit.op !== "add_hook");
  const hookEdits = input.edits.filter((edit) => edit.op === "add_hook" && edit.hook && edit.hookId);
  if (promptEdits.length === 0 && hookEdits.length === 0) return { refused: "the accepted candidate only adds skills: add them on the Skills page from the report" };
  const config = getConfig();
  const missing = promptEdits.map((edit) => edit.target).find((target) => target !== MAIN_ASSISTANT_PROMPT_TARGET && !hasPromptTarget(config, target));
  if (missing) return { refused: `prompt target '${missing}' is not a configured agent` };
  const peer = peerAgentRefusal(promptEdits.map((edit) => edit.target));
  if (peer) return { refused: peer };

  const rationaleFor = (target: string) => promptEdits
    .filter((edit) => edit.target === target)
    .map((edit) => `${edit.id} (${edit.editor}/${edit.scope}, answers ${edit.moment}): ${edit.why}`)
    .join("\n");
  const promptChanges = buildPromptChanges(input.basePrompts, input.edits.filter((edit) => edit.op !== "add_hook"), rationaleFor);
  // A hook goes in as a config change under enforcementHooks, applied like any other with consent.
  const configChanges = hookEdits.map((edit) => ({
    path: `enforcementHooks.${edit.hookId}`,
    value: edit.hook,
    reason: `${edit.id} (${edit.editor}/${edit.scope}, answers ${edit.moment}): ${edit.why || edit.text}`,
  }));
  const gateLines = input.gate.tallies.map((t) => `${t.role} ${t.taskId}: ${t.wins} won, ${t.losses} lost, ${t.ties} tied${t.unscored ? `, ${t.unscored} unscored` : ""}${t.selectorWins + t.selectorLosses > 0 ? `; selector ${t.selectorWins}:${t.selectorLosses}` : ""}`);
  const proposal = createConversationConfigProposal(input.liveWorkspacePath, {
    status: "pending",
    mode: "prompt",
    request: `Harness lab run ${input.runId}: prompt edits that won on their target tasks without losing on the guard set.`,
    summary: `${[
      promptEdits.length > 0 ? `${promptEdits.length} edit(s) to ${promptChanges.map((c) => c.agentName).join(", ")}` : "",
      hookEdits.length > 0 ? `${hookEdits.length} enforcement hook(s) (${hookEdits.map((e) => e.hookId).join(", ")})` : "",
    ].filter(Boolean).join(" and ")} — ${input.gate.evidence} evidence. ${input.gate.reasons.join(" ")}`.slice(0, 1_200),
    assistantAgent: LAB_ASSISTANT_AGENT,
    ...(promptChanges.length === 1 ? { targetAgent: promptChanges[0]!.agentName } : {}),
    configChanges,
    promptChanges,
    validations: [...gateLines, ...input.composerRows.map((row) => `composer: ${row}`), ...(input.gate.signTestP !== null ? [`sign test p = ${input.gate.signTestP.toFixed(3)} (reported, not deciding)`] : [])],
    tags: [
      "harness-lab",
      `evidence:${input.gate.evidence}`,
      ...[...new Set(input.gate.tallies.filter((t) => t.role === "target").map((t) => t.taskId))].map((id) => `${TASK_TAG}${id}`),
    ],
  });
  const superseded = supersedeCoveredProposals(input.liveWorkspacePath, proposal);
  logAudit("harness_lab_proposal_created", {
    proposalId: proposal.id,
    runId: input.runId,
    targets: [...promptChanges.map((c) => c.agentName), ...hookEdits.map((e) => `hook:${e.hookId}`)],
    strategies: promptChanges.map((c) => c.strategy),
    evidence: input.gate.evidence,
    ...(superseded.length > 0 ? { superseded } : {}),
  }, { severity: "info" });
  return { proposal, superseded };
}
