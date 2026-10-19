/**
 * Skill distiller — the "author from experience" half of the self-improvement
 * loop. After a successful multi-step turn, an LLM pass condenses the
 * trajectory (which agents ran, which tools, in what order, and the evidence
 * gathered) into a reusable, generalized SKILL.md draft.
 *
 * Distilled skills start as drafts and graduate to `active` only after they
 * succeed in real use (see store.recordSkillOutcome) — so a one-off lucky run
 * never hardens into permanent guidance without confirmation.
 *
 * A skill or patch must rest on the run: the digest numbers its steps, and a
 * proposal that cites none of them, or rates its own confidence low, is
 * declined (skill_distill_declined). Skipping is the expected answer for most
 * runs; one successful run is a single sample, and whether the procedure helps
 * is measured later against held-out turns (skills/lift.ts).
 *
 * Structure is split for testability:
 *   shouldDistill()      — pure gating predicate
 *   distillAndPersist()  — dedupe + LLM + write, with an injectable completion
 *   maybeDistillSkillFromTurn() — production wrapper reading config + provider
 */

import { getConfig } from "../config/loader.js";
import { getChatProvider } from "../providers/index.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { searchSkills } from "./service.js";
import { getSkill, patchSkill, writeSkill, SkillCredentialError, type Skill, type SkillEvidence } from "./store.js";
import type { SwarmState } from "../tools/registry.js";

const log = childLogger("skills:distiller");

const MIN_FINAL_ANSWER_CHARS = 120;
/** Skip distillation when an existing skill already covers this task shape. */
const DEDUPE_SCORE_THRESHOLD = 0.7;
/** In-process repeat guard so the same objective isn't re-distilled in a burst. */
const RECENT_TTL_MS = 10 * 60_000;
const _recentObjectives = new Map<string, number>();

export interface DistillTurnInput {
  workspacePath: string;
  sessionId: string;
  /** The user request / turn objective that this trajectory accomplished. */
  objective: string;
  finalAnswer: string;
  /** Number of delegations this turn — the primary "multi-step" signal. */
  delegationCount: number;
  sharedFindings: string[];
  swarmState?: SwarmState;
  /** Skills injected/loaded for this turn; patch these before creating a new skill. */
  loadedSkillSlugs?: string[];
  /** What made the turn a success (its scorecard's learningBasis): "qa_pass" or "no_verdict". */
  outcomeBasis?: string;
}

export interface DistillGate {
  enabled: boolean;
  autoAuthor: boolean;
  minStepsToAuthor: number;
}

export interface DistilledSkill {
  name: string;
  description: string;
  whenToUse: string;
  procedure: string;
  tags: string[];
  agents: string[];
  tools: string[];
  evidence: ProposalEvidence;
}

/** The steps of the run a proposal rests on, as the model cited them. */
export interface ProposalEvidence {
  steps: string[];
  why: string;
  confidence: "high" | "medium";
}

/** Why a well-formed proposal was not written. */
export type DistillDeclineReason = "no_evidence" | "low_confidence";

export type DistillParse =
  | { ok: true; skill: DistilledSkill }
  | { ok: false; reason: "skip" | "malformed" | DistillDeclineReason };

export type SkillUpdateProposal =
  | { action: "patch"; oldString: string; newString: string; filePath?: string; replaceAll?: boolean; evidence: ProposalEvidence }
  | { action: "skip"; reason?: string };

export type SkillUpdateParse =
  | { ok: true; proposal: SkillUpdateProposal }
  | { ok: false; reason: "malformed" | DistillDeclineReason };

/** Pure gating predicate — no config, no I/O. */
export function shouldDistill(input: DistillTurnInput, gate: DistillGate): boolean {
  if (!gate.enabled || !gate.autoAuthor) return false;
  if (!input.objective.trim()) return false;
  if (input.finalAnswer.trim().length < MIN_FINAL_ANSWER_CHARS) return false;
  if (input.delegationCount < gate.minStepsToAuthor) return false;
  return true;
}

/**
 * Dedupe against existing skills, ask the model to distill a reusable
 * procedure, and persist it as a draft. Gating is assumed already checked.
 * `complete` is injectable for tests.
 */
export async function distillAndPersist(
  input: DistillTurnInput,
  complete: (prompt: string) => Promise<string>,
): Promise<DistilledSkill | null> {
  const objective = input.objective.trim();

  // In-process repeat guard.
  const key = objective.toLowerCase().slice(0, 200);
  const now = Date.now();
  const last = _recentObjectives.get(key);
  if (last && now - last < RECENT_TTL_MS) return null;
  _recentObjectives.set(key, now);
  pruneRecent(now);

  const trajectory = buildTrajectoryDigest(input);
  if (!trajectory) return null;
  const stepIds = digestStepIds(trajectory);
  const basis = input.outcomeBasis ?? "no_verdict";

  const updateCandidate = await findPatchCandidate(input, objective);
  if (updateCandidate) {
    const slug = updateCandidate.frontmatter.slug;
    try {
      const raw = await complete(buildSkillUpdatePrompt(objective, trajectory, input.finalAnswer, updateCandidate, basis));
      const parsed = parseSkillUpdateProposal(raw, stepIds);
      if (!parsed.ok) {
        auditDecline(input, "patch", parsed.reason, slug);
        return null;
      }
      if (parsed.proposal.action === "skip") {
        auditDecline(input, "patch", "skip", slug);
        return null;
      }
      const { evidence, oldString, newString, filePath, replaceAll } = parsed.proposal;
      const patched = patchSkill(input.workspacePath, slug, {
        oldString,
        newString,
        filePath,
        replaceAll,
        summary: `Patched from session ${input.sessionId} (${basis}; ${evidence.steps.join(", ")}): ${evidence.why}`.slice(0, 500),
      });
      logAudit("skill_patched", {
        slug: patched.frontmatter.slug,
        name: patched.frontmatter.name,
        filePath: filePath ?? "SKILL.md",
        sourceSessionId: input.sessionId,
        basis,
        evidenceSteps: evidence.steps,
        confidence: evidence.confidence,
      }, { sessionId: input.sessionId, severity: "info" });
      log.info({ slug: patched.frontmatter.slug }, "Patched an existing skill from a successful trajectory");
      return null;
    } catch (err) {
      log.debug({ err, slug }, "Skill update proposal failed — skipping duplicate authoring");
      return null;
    }
  }

  let parsed: DistillParse;
  try {
    const raw = await complete(buildDistillPrompt(objective, trajectory, input.finalAnswer, basis));
    parsed = parseDistilledSkill(raw, stepIds);
  } catch (err) {
    log.debug({ err }, "Skill distillation LLM call failed — skipping");
    return null;
  }
  if (!parsed.ok) {
    auditDecline(input, "new", parsed.reason);
    return null;
  }
  const proposal = parsed.skill;
  const learnedFrom: SkillEvidence = { basis, ...proposal.evidence };

  try {
    const skill = writeSkill(input.workspacePath, {
      name: proposal.name,
      description: proposal.description,
      whenToUse: proposal.whenToUse,
      procedure: proposal.procedure,
      tags: proposal.tags,
      agents: proposal.agents,
      tools: proposal.tools,
      origin: "distilled",
      curatorManaged: true,
      status: "draft",
      sourceSessionId: input.sessionId,
      learnedFrom,
    });
    logAudit("skill_distilled", {
      slug: skill.frontmatter.slug,
      name: skill.frontmatter.name,
      delegationCount: input.delegationCount,
      sourceSessionId: input.sessionId,
      basis,
      evidenceSteps: learnedFrom.steps,
      confidence: learnedFrom.confidence,
    }, { sessionId: input.sessionId, severity: "info" });
    log.info({ slug: skill.frontmatter.slug }, "Distilled a new skill from a successful trajectory");
    return proposal;
  } catch (err) {
    if (err instanceof SkillCredentialError) {
      log.debug("Distilled skill rejected — credential-shaped content");
      return null;
    }
    log.debug({ err }, "Failed to persist distilled skill");
    return null;
  }
}

/** Production entry point — fire-and-forget from the turn-completion path. */
export async function maybeDistillSkillFromTurn(input: DistillTurnInput): Promise<void> {
  const sl = getConfig().skillLibrary;
  if (!shouldDistill(input, sl)) return;

  await distillAndPersist(input, async (prompt) => {
    const provider = getChatProvider();
    const response = await provider.complete([{ role: "user", content: prompt }], []);
    return response.content ?? "";
  });
}

function auditDecline(
  input: DistillTurnInput,
  kind: "new" | "patch",
  reason: "skip" | "malformed" | DistillDeclineReason,
  slug?: string,
): void {
  logAudit("skill_distill_declined", {
    kind,
    reason,
    ...(slug ? { slug } : {}),
    basis: input.outcomeBasis ?? "no_verdict",
    sourceSessionId: input.sessionId,
  }, { sessionId: input.sessionId, severity: "info" });
}

// ── Trajectory digest ─────────────────────────────────────────────────────────

/**
 * The run as numbered steps: delegations S1…, evidence F1…. A proposal cites these ids as
 * its evidence (parseDistilledSkill), so each line keeps its id at the start.
 */
export function buildTrajectoryDigest(input: DistillTurnInput): string | null {
  const lines: string[] = [];

  const tasks = input.swarmState ? Object.values(input.swarmState.tasks) : [];
  const meaningful = tasks.filter((task) => task.status === "completed" || task.status === "partial");
  for (const [i, task] of meaningful.entries()) {
    const agent = task.selectedAgent
      ?? task.attempts.find((attempt) => attempt.agentName)?.agentName
      ?? "specialist";
    const toolNames = [...new Set(task.attempts.flatMap((attempt) => attempt.toolNames ?? []))]
      .slice(0, 8);
    const tools = toolNames.length > 0 ? ` (tools: ${toolNames.join(", ")})` : "";
    const partial = task.status === "partial" ? " [partial]" : "";
    lines.push(`[S${i + 1}] ${task.title} → ${agent}${tools}${partial}`);
  }

  if (lines.length === 0 && input.sharedFindings.length === 0) return null;

  const sections = [`Delegations (${meaningful.length}):`, ...lines];
  if (input.sharedFindings.length > 0) {
    sections.push(
      "",
      `Evidence gathered (${input.sharedFindings.length} findings):`,
      ...input.sharedFindings.slice(0, 6).map((finding, i) => `[F${i + 1}] ${finding.slice(0, 200)}`),
    );
  }
  return sections.join("\n");
}

/** The step ids a digest offers as evidence. */
export function digestStepIds(digest: string): Set<string> {
  return new Set([...digest.matchAll(/^\[([SF]\d+)\]/gm)].map((m) => m[1]!));
}

function describeBasis(basis: string): string {
  return basis === "qa_pass"
    ? "A QA review checked the final answer against the task's acceptance criteria and passed it, citing evidence."
    : "The turn completed without a recorded defect, but nothing checked the answer. Weigh it as a single unconfirmed run.";
}

const EVIDENCE_RULES = `- Rest every addition on this run: cite the ids of the steps it comes from ([S…] delegations, [F…] evidence). If you cannot name the step that made the difference, the addition is speculation: skip.
- Never capture facts about this task (names, figures, URLs, dates, conclusions): stored as a procedure they become wrong anchors for the next task.
- Calibrate: "be thorough" is too generic to help, and a procedure that fits only this task never applies again. Rate your confidence honestly; "low" is not written.`;

export function buildDistillPrompt(objective: string, trajectory: string, finalAnswer: string, basis = "no_verdict"): string {
  return `You are a procedure librarian for the StarlingAI agent swarm. A multi-step task just completed successfully. Decide whether the run teaches a REUSABLE procedure (a "skill") the swarm should follow next time a task of the same shape appears. Most runs do not, and skipping is the expected answer.

## Completed objective
${objective.slice(0, 800)}

## How the outcome was judged
${describeBasis(basis)}

## What the swarm actually did
${trajectory.slice(0, 2000)}

## Final answer (excerpt)
${finalAnswer.slice(0, 800)}

## Your job
Write a GENERALIZED procedure — not a transcript. Strip one-off specifics (exact URLs, names, values, dates). Capture the repeatable shape: the order of steps, which specialist agents to delegate to, which tools matter, and the pitfalls to avoid.

Respond with ONLY valid JSON:

\`\`\`json
{
  "name": "Short Title Case name",
  "description": "One paragraph: what this procedure accomplishes.",
  "whenToUse": "One sentence: the shape of situation it applies to, not this task's subject.",
  "procedure": "Markdown numbered steps with the agents/tools and pitfalls.",
  "tags": ["topic", "tags"],
  "agents": ["specialist_agent_names"],
  "tools": ["tool_names"],
  "evidence": {"steps": ["S1", "S3"], "why": "One sentence: what in those steps made the run work."},
  "confidence": "high | medium | low"
}
\`\`\`

## Constraints
- NEVER include secrets, credentials, passwords, tokens, or API keys.
${EVIDENCE_RULES}
- Do not capture transient setup failures or negative claims like "tool X is broken". Capture the durable fix or retry pattern instead.
- Keep the procedure under ~1500 characters and genuinely reusable.
- If the task was trivial, too one-off to generalize, or no step stands out, respond with: {"skip": true}`;
}

export function buildSkillUpdatePrompt(
  objective: string,
  trajectory: string,
  finalAnswer: string,
  existing: Skill,
  basis = "no_verdict",
): string {
  return `You are maintaining StarlingAI's procedural Skill Library. A multi-step task succeeded and an existing skill appears to cover this class of work. Patch the existing skill only if the run revealed a durable missing step, pitfall, routing rule, verification habit, or user-corrected workflow. Most runs do not, and skipping is the expected answer.

## Completed objective
${objective.slice(0, 800)}

## How the outcome was judged
${describeBasis(basis)}

## Existing skill to update
Slug: ${existing.frontmatter.slug}
Name: ${existing.frontmatter.name}
When to use: ${existing.frontmatter.whenToUse}

SKILL.md body:
${existing.body.slice(0, 2200)}

## What the swarm actually did
${trajectory.slice(0, 2000)}

## Final answer (excerpt)
${finalAnswer.slice(0, 800)}

## Your job
Prefer a targeted patch over creating a new skill. Add one concise missing step, pitfall, or verification rule. If the skill is already sufficient, skip.

Respond with ONLY valid JSON, one of:

\`\`\`json
{"action":"patch","oldString":"exact text from SKILL.md","newString":"replacement text","replaceAll":false,"evidence":{"steps":["S2"],"why":"One sentence: what in that step the skill was missing."},"confidence":"high | medium | low"}
\`\`\`

or

\`\`\`json
{"action":"skip","reason":"already covered"}
\`\`\`

## Constraints
- oldString must be copied exactly from the existing SKILL.md body or frontmatter.
- NEVER include secrets, credentials, passwords, tokens, or API keys.
${EVIDENCE_RULES}
- Do not persist transient setup failures, missing local binaries, unconfigured credentials, or negative claims like "tool X is broken". Capture the durable recovery pattern instead.
- Keep the patch compact and reusable for future similar work.`;
}

function extractJson(content: string): Record<string, unknown> | null {
  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/i) ?? content.match(/(\{[\s\S]*\})/);
  if (!jsonMatch || !jsonMatch[1]) return null;
  try {
    const raw = JSON.parse(jsonMatch[1]) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * The evidence a proposal cites, kept only when it names steps the digest has. Ids are compared
 * case-insensitively and may come bracketed ("[S2]"); an id the run does not have is dropped.
 */
function parseEvidence(
  raw: Record<string, unknown>,
  stepIds: ReadonlySet<string>,
): ProposalEvidence | DistillDeclineReason {
  const evidence = raw["evidence"] && typeof raw["evidence"] === "object" ? raw["evidence"] as Record<string, unknown> : {};
  const steps = [...new Set(toStringArray(evidence["steps"])
    .map((s) => s.replace(/[[\]\s]/g, "").toUpperCase())
    .filter((s) => stepIds.has(s)))];
  const why = typeof evidence["why"] === "string" ? evidence["why"].trim().slice(0, 300) : "";
  if (steps.length === 0 || !why) return "no_evidence";
  const confidence = typeof raw["confidence"] === "string" ? raw["confidence"].trim().toLowerCase() : "";
  if (confidence === "high" || confidence === "medium") return { steps, why, confidence };
  // Unrated counts as low: the model did not commit to the claim.
  return "low_confidence";
}

export function parseDistilledSkill(content: string, stepIds: ReadonlySet<string>): DistillParse {
  const raw = extractJson(content);
  if (!raw) return { ok: false, reason: "malformed" };
  if (raw["skip"] === true) return { ok: false, reason: "skip" };

  const name = typeof raw["name"] === "string" ? raw["name"].trim() : "";
  const description = typeof raw["description"] === "string" ? raw["description"].trim() : "";
  const procedure = typeof raw["procedure"] === "string" ? raw["procedure"].trim() : "";
  const whenToUse = typeof raw["whenToUse"] === "string" ? raw["whenToUse"].trim() : description;

  if (!name || !description || procedure.length < 40) return { ok: false, reason: "malformed" };
  const evidence = parseEvidence(raw, stepIds);
  if (typeof evidence === "string") return { ok: false, reason: evidence };

  return {
    ok: true,
    skill: {
      name,
      description,
      whenToUse,
      procedure,
      tags: toStringArray(raw["tags"]),
      agents: toStringArray(raw["agents"]),
      tools: toStringArray(raw["tools"]),
      evidence,
    },
  };
}

export function parseSkillUpdateProposal(content: string, stepIds: ReadonlySet<string>): SkillUpdateParse {
  const raw = extractJson(content);
  if (!raw) return { ok: false, reason: "malformed" };

  if (raw["skip"] === true || raw["action"] === "skip") {
    return { ok: true, proposal: { action: "skip", reason: typeof raw["reason"] === "string" ? raw["reason"] : undefined } };
  }
  if (raw["action"] !== "patch") return { ok: false, reason: "malformed" };
  const oldString = typeof raw["oldString"] === "string" ? raw["oldString"] : "";
  const newString = typeof raw["newString"] === "string" ? raw["newString"] : "";
  if (!oldString) return { ok: false, reason: "malformed" };
  const evidence = parseEvidence(raw, stepIds);
  if (typeof evidence === "string") return { ok: false, reason: evidence };
  return {
    ok: true,
    proposal: {
      action: "patch",
      oldString,
      newString,
      filePath: typeof raw["filePath"] === "string" && raw["filePath"].trim() ? raw["filePath"].trim() : undefined,
      replaceAll: raw["replaceAll"] === true,
      evidence,
    },
  };
}

async function findPatchCandidate(input: DistillTurnInput, objective: string): Promise<Skill | null> {
  for (const slug of input.loadedSkillSlugs ?? []) {
    const skill = getSkill(input.workspacePath, slug);
    if (skill && skill.frontmatter.status !== "archived") return skill;
  }
  try {
    const existing = await searchSkills(input.workspacePath, objective, { limit: 1 });
    if (existing[0] && existing[0].combinedScore >= DEDUPE_SCORE_THRESHOLD) return existing[0].skill;
  } catch {
    // Search failure is non-fatal — proceed with fresh distillation.
  }
  return null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 16);
}

function pruneRecent(now: number): void {
  if (_recentObjectives.size < 256) return;
  for (const [key, ts] of _recentObjectives) {
    if (now - ts >= RECENT_TTL_MS) _recentObjectives.delete(key);
  }
}
