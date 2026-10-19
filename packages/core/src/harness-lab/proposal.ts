/**
 * What a lab run hands a person: one pending config-assistant proposal per accepted candidate,
 * filed in the deployment's own proposal store, applied only from Settings → Config Assistant
 * ("Apply With Consent"). The lab never applies anything.
 *
 * Appended rules go in as "append"; a replaced span makes the whole prompt a "replace", which
 * carries the hash of the prompt it was measured against, so applying it after someone changed
 * that prompt is refused instead of undoing their change (stalePromptChange). No flow-memory entry
 * is written here: flow guidance reaches the prompts, and a proposal nobody approved must not.
 */
import {
  createConversationConfigProposal,
  hasPromptTarget,
  MAIN_ASSISTANT_PROMPT_TARGET,
  peerAgentRefusal,
  promptSha256,
  type ConversationConfigProposal,
  type ConversationPromptChange,
} from "../agent/config-assistant-proposals.js";
import { logAudit } from "../audit/logger.js";
import { getConfig } from "../config/loader.js";
import { applyEdits, type LabEdit } from "./edit-format.js";
import type { GateDecision } from "./gate.js";

export const LAB_ASSISTANT_AGENT = "harness_lab";

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

export type EmitResult = { proposal: ConversationConfigProposal } | { refused: string };

export function emitProposal(input: EmitInput): EmitResult {
  if (input.edits.length === 0) return { refused: "no edits to propose" };
  if (input.gate.verdict !== "accept") return { refused: `the gate did not accept the candidate (${input.gate.verdict})` };
  const promptEdits = input.edits.filter((edit) => edit.op !== "add_skill");
  if (promptEdits.length === 0) return { refused: "the accepted candidate only adds skills: add them on the Skills page from the report" };
  const config = getConfig();
  const missing = promptEdits.map((edit) => edit.target).find((target) => target !== MAIN_ASSISTANT_PROMPT_TARGET && !hasPromptTarget(config, target));
  if (missing) return { refused: `prompt target '${missing}' is not a configured agent` };
  const peer = peerAgentRefusal(promptEdits.map((edit) => edit.target));
  if (peer) return { refused: peer };

  const rationaleFor = (target: string) => promptEdits
    .filter((edit) => edit.target === target)
    .map((edit) => `${edit.id} (${edit.editor}/${edit.scope}, answers ${edit.moment}): ${edit.why}`)
    .join("\n");
  const promptChanges = buildPromptChanges(input.basePrompts, input.edits, rationaleFor);
  const gateLines = input.gate.tallies.map((t) => `${t.role} ${t.taskId}: ${t.wins} won, ${t.losses} lost, ${t.ties} tied${t.unscored ? `, ${t.unscored} unscored` : ""}${t.selectorWins + t.selectorLosses > 0 ? `; selector ${t.selectorWins}:${t.selectorLosses}` : ""}`);
  const proposal = createConversationConfigProposal(input.liveWorkspacePath, {
    status: "pending",
    mode: "prompt",
    request: `Harness lab run ${input.runId}: prompt edits that won on their target tasks without losing on the guard set.`,
    summary: `${promptEdits.length} edit(s) to ${promptChanges.map((c) => c.agentName).join(", ")} — ${input.gate.evidence} evidence. ${input.gate.reasons.join(" ")}`.slice(0, 1_200),
    assistantAgent: LAB_ASSISTANT_AGENT,
    ...(promptChanges.length === 1 ? { targetAgent: promptChanges[0]!.agentName } : {}),
    configChanges: [],
    promptChanges,
    validations: [...gateLines, ...input.composerRows.map((row) => `composer: ${row}`), ...(input.gate.signTestP !== null ? [`sign test p = ${input.gate.signTestP.toFixed(3)} (reported, not deciding)`] : [])],
    tags: ["harness-lab", `evidence:${input.gate.evidence}`],
  });
  logAudit("harness_lab_proposal_created", {
    proposalId: proposal.id,
    runId: input.runId,
    targets: promptChanges.map((c) => c.agentName),
    strategies: promptChanges.map((c) => c.strategy),
    evidence: input.gate.evidence,
  }, { severity: "info" });
  return { proposal };
}
