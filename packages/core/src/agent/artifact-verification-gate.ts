/**
 * Artifact verification gate — verify every file this turn produced, and when one is
 * broken, rebuild it rather than shipping it.
 *
 * Two things distinguish this from the artifact probes that already ran inside the QA
 * delivery gate:
 *
 *  1. IT IS TRIGGERED BY AN ARTIFACT EXISTING, NOT BY A PLAN EXISTING. The QA delivery
 *     gate is a no-op without a plan carrying acceptance criteria
 *     (turn-finalize-guards.ts), so the most ordinary artifact turn there is — "update
 *     my CV and give me a PDF" — never had its output checked at all.
 *
 *  2. ITS REPAIR CAN ACTUALLY REPAIR. The QA loop's improve() is a text rewrite driven
 *     by a synthesis call with an EMPTY tool array (runtime.ts). Against a corrupt PDF
 *     that is not merely unlikely to work, it is structurally incapable of working: no
 *     amount of re-wording the chat answer changes the bytes on disk. Repair here is a
 *     delegation that can re-run the producing tool.
 *
 * Bounded and fail-open by construction: probes are deterministic and time-capped, the
 * repair is capped at a small number of attempts, and any error anywhere degrades to
 * shipping the artifact with an honest caveat. It never blocks delivery and never loops.
 *
 * Terminal policy: a file that still fails after the repair budget is spent is STILL
 * delivered — 40 KB of partial work is worth more than nothing, and deleting the user's
 * only copy is the worse failure — but it is delivered with a caveat naming the file and
 * the defect, and the turn is recorded as partial. Silently shipping a broken deliverable
 * is the one outcome this gate exists to prevent.
 */
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { effectiveOrchestration } from "../runtime/effort-context.js";
import { executeTool, type ToolContext } from "../tools/registry.js";
import { probeArtifacts, summarizeProbeFailures, type ArtifactProbeReport } from "./artifact-probes.js";
import { collectJudgeableArtifactRefs } from "./qa-tool-judge.js";
import type { AgentSession } from "./session.js";

const log = childLogger("agent:artifact-verification");

export type ArtifactVerificationStatus =
  | "not_requested"   // flag off
  | "not_applicable"  // the turn produced no inspectable artifact
  | "pass"            // every artifact checked out
  | "unverifiable"    // nothing proven broken, but something could not be checked
  | "repaired"        // was broken, a rebuild fixed it
  | "fail";           // still broken after the repair budget

export interface ArtifactVerificationOutcome {
  status: ArtifactVerificationStatus;
  /** "<file>: <defect>; …" for the failing artifacts. Empty unless status is fail/repaired. */
  failures: string;
  probedCount: number;
  repairAttempts: number;
}

export interface ArtifactVerificationDeps {
  session: AgentSession;
  signal: AbortSignal;
  toolContext: ToolContext;
  collectTurnArtifactAttachments: (session: AgentSession) => Array<Record<string, unknown>>;
  incrementDelegationCount: () => void;
}

/**
 * The rebuild instruction. Deliberately names the file, the defect, and the fact that
 * the file on disk is unusable — a repair agent told only "QA failed" re-words the chat
 * answer, which is exactly the dead end this gate replaces. No topic words, no
 * artifact-kind branching: the diagnostic comes from the probe receipts.
 */
export function buildRepairTask(failures: string): string {
  return "ARTIFACT REPAIR — a file you produced this turn is CORRUPT or INCOMPLETE on disk. "
    + "An automated integrity check opened it and it failed:\n\n"
    + failures
    + "\n\nThe file as written is NOT usable — this is a problem with the bytes on disk, not with the wording of the answer, "
    + "so re-writing or re-explaining the response will not fix it. Re-produce the file by calling the tool that generates it again, "
    + "writing to the SAME path. If the content was long, split the build into smaller calls rather than re-emitting the whole "
    + "document in one call, which is the usual cause of a truncated write. "
    + "Do not report success unless the tool call that rebuilt the file actually succeeded.";
}

/** User-facing caveat for an artifact that could not be repaired. Honest and specific. */
export function buildFailureCaveat(failures: string): string {
  return `\n\n---\n\n⚠️ **Automated file check failed.** ${failures}\n\n`
    + "The file was still saved so no work is lost, but it may not open correctly. "
    + "Ask me to rebuild it, or to deliver the content in the chat instead.";
}

/** Caveat for artifacts that could not be checked at all — weaker claim, still honest. */
export function buildUnverifiableCaveat(detail: string): string {
  return `\n\n---\n\nℹ️ **Note:** ${detail} Please open it to confirm it is what you expect.`;
}

async function probeCurrentArtifacts(deps: ArtifactVerificationDeps): Promise<{ report: ArtifactProbeReport; refCount: number }> {
  // Re-collected from the LIVE session every time, so a repair that wrote to a new
  // path is inspected rather than the superseded original.
  const refs = collectJudgeableArtifactRefs(deps.collectTurnArtifactAttachments(deps.session));
  if (refs.length === 0) {
    return { report: { status: "not_applicable", receipts: [], probedCount: 0 }, refCount: 0 };
  }
  const report = await probeArtifacts(refs, { workspacePath: deps.session.getWorkspacePath() });
  return { report, refCount: refs.length };
}

/**
 * Verify this turn's artifacts; attempt a bounded rebuild of any that are broken.
 * Never throws — every failure path degrades to a status the caller can caveat.
 */
export async function runArtifactVerificationGate(deps: ArtifactVerificationDeps): Promise<ArtifactVerificationOutcome> {
  const orchestration = effectiveOrchestration();
  if (!orchestration.verifyArtifacts) {
    return { status: "not_requested", failures: "", probedCount: 0, repairAttempts: 0 };
  }
  if (deps.signal.aborted) {
    return { status: "not_applicable", failures: "", probedCount: 0, repairAttempts: 0 };
  }

  let probedCount = 0;
  let repairAttempts = 0;
  try {
    const first = await probeCurrentArtifacts(deps);
    probedCount = first.report.probedCount;

    if (first.report.status === "not_applicable") {
      return { status: "not_applicable", failures: "", probedCount: 0, repairAttempts: 0 };
    }
    if (first.report.status === "pass") {
      return { status: "pass", failures: "", probedCount, repairAttempts: 0 };
    }
    if (first.report.status === "unverifiable") {
      const detail = first.report.receipts.find((r) => r.status === "unverifiable")?.detail ?? "an artifact could not be checked";
      return { status: "unverifiable", failures: detail, probedCount, repairAttempts: 0 };
    }

    // ── Hard failure: something on disk is genuinely broken. ──
    let failures = summarizeProbeFailures(first.report);
    logAudit("artifact_verification_failed", { failures, probedCount }, { sessionId: deps.session.id, severity: "warn" });

    const maxAttempts = orchestration.verifyArtifactsRepair
      ? Math.max(0, orchestration.verifyArtifactsMaxRepairAttempts)
      : 0;
    if (maxAttempts === 0) {
      return { status: "fail", failures, probedCount, repairAttempts: 0 };
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (deps.signal.aborted) break;
      repairAttempts = attempt;
      const repaired = await attemptRepair(deps, failures);
      if (!repaired) break;

      const recheck = await probeCurrentArtifacts(deps);
      probedCount = recheck.report.probedCount;
      if (recheck.report.status === "pass" || recheck.report.status === "unverifiable") {
        logAudit("flow_verification_repaired", { reason: "artifact_rebuilt", attempts: attempt, probedCount }, { sessionId: deps.session.id, severity: "info" });
        return { status: "repaired", failures, probedCount, repairAttempts: attempt };
      }
      failures = summarizeProbeFailures(recheck.report);
    }

    logAudit("artifact_verification_unrepaired", { failures, probedCount, repairAttempts }, { sessionId: deps.session.id, severity: "error" });
    return { status: "fail", failures, probedCount, repairAttempts };
  } catch (err) {
    // Verification is a safety net, never a new failure mode. If it breaks, say so and move on.
    log.warn({ err }, "artifact verification gate errored — delivering without a verdict");
    return { status: "unverifiable", failures: "the automated file check could not run this turn", probedCount, repairAttempts };
  }
}

/** One bounded rebuild delegation. Returns false when the delegation could not run. */
async function attemptRepair(deps: ArtifactVerificationDeps, failures: string): Promise<boolean> {
  try {
    const result = await executeTool(
      "delegate_to_agent",
      { agentName: "mission_coordinator", task: buildRepairTask(failures) },
      { ...deps.toolContext, allowDelegationAfterOperatorStop: true },
    );
    deps.incrementDelegationCount();
    if (!result.success) {
      log.warn({ error: result.error }, "artifact repair delegation failed");
      return false;
    }
    return true;
  } catch (err) {
    log.warn({ err }, "artifact repair delegation threw");
    return false;
  }
}
