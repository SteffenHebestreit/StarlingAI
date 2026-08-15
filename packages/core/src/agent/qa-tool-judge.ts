/**
 * Tool-equipped, clean-context QA judge (orchestration.qaToolJudge — slice 2 of the
 * no-PASS-without-evidence work in qa-delivery-loop.ts).
 *
 * The QA delivery gate's default reviewer is a bare model call over the answer TEXT: it
 * cannot open the artifact it is certifying, so a truncated HTML app or a dead served URL
 * passes on confident prose. This judge runs the verdict as a FRESH-context sub-agent
 * (no parent history, no shared facts — it cannot inherit the builder's blind spots)
 * equipped with read-only inspection tools, and is instructed to OPEN each artifact
 * before issuing the verdict. The verdict contract is the evidence-bearing PASS from
 * qaEvidenceRequired ("PASS — evidence: <observed fact>"), parsed by parseQaVerdict.
 *
 * Fail-open like every QA arm: any runner error, empty output, or missing artifacts
 * means the caller falls back to the prose check — the judge can never block delivery.
 * The runner is injected (DI) so the pure pieces and the check wrapper are unit-testable
 * without module mocks; the runtime supplies a thin runSubAgent adapter.
 */
import { parseQaVerdict, type QaVerdict } from "./qa-delivery-loop.js";

/** A concrete artifact the judge can open: a workspace file or a served/external URL. */
export interface QaJudgeArtifactRef {
  kind: "file" | "url";
  /** Workspace-relative path (file) or full URL (url). */
  location: string;
  /**
   * True for a URL we merely CITED rather than produced — e.g. the source links
   * generate_chart_html attaches alongside a chart. A cited page answering 403/404
   * to a bare GET is routine and says nothing about our deliverable, so probes
   * report it softly. A URL we SERVE (serve_app) is our artifact: if it is dead the
   * app does not work, and that stays a hard failure.
   */
  external?: boolean;
}

/** Read-only inspection tools granted to the judge — nothing that can mutate or delegate. */
export const QA_TOOL_JUDGE_TOOLS = ["read_file", "list_files", "verify_app", "url_inspect"] as const;

/** Cap the refs handed to the judge so a many-artifact turn stays a bounded check. */
const MAX_JUDGE_ARTIFACT_REFS = 6;

/**
 * Extract the judge-openable artifact refs from a turn's artifact attachments
 * (collectTurnArtifactAttachments shape: filename/relativePath/externalUrl/...).
 * Pure: directories and attachments with neither a path nor a URL are skipped.
 */
export function collectJudgeableArtifactRefs(
  attachments: ReadonlyArray<Record<string, unknown>>,
): QaJudgeArtifactRef[] {
  const refs: QaJudgeArtifactRef[] = [];
  const seen = new Set<string>();
  for (const a of attachments) {
    if (a["isDirectory"] === true) continue;
    const relativePath = typeof a["relativePath"] === "string" ? a["relativePath"].trim() : "";
    const externalUrl = typeof a["externalUrl"] === "string" ? a["externalUrl"].trim() : "";
    const cited = a["artifactKind"] === "external_source" || a["sourceTool"] === "source_reference";
    const ref: QaJudgeArtifactRef | null = relativePath
      ? { kind: "file", location: relativePath }
      : externalUrl
        ? { kind: "url", location: externalUrl, ...(cited ? { external: true } : {}) }
        : null;
    if (!ref || seen.has(ref.location)) continue;
    seen.add(ref.location);
    refs.push(ref);
    if (refs.length >= MAX_JUDGE_ARTIFACT_REFS) break;
  }
  return refs;
}

/**
 * The judge's task text. Pure. Instructs it to inspect every artifact with its tools
 * BEFORE judging, and to use the evidence-bearing verdict contract so the caller's
 * requireEvidence gate applies uniformly (a tool judge that never opened anything
 * produces a bare PASS → downgraded to unverified by the same invariant).
 */
export function buildQaToolJudgeTask(
  answer: string,
  criteria: string[],
  refs: QaJudgeArtifactRef[],
): string {
  const refLines = refs.map((r) => (
    r.kind === "file"
      ? `- FILE: ${r.location} — open it with read_file and check it is complete and matches what the answer claims.`
      : `- URL: ${r.location} — probe it with verify_app (or url_inspect) and check it is live and matches what the answer claims.`
  ));
  return [
    "You are an independent QA verifier with inspection tools. Verify whether the delivered ANSWER satisfies EVERY acceptance criterion, by INSPECTING the actual deliverables — do not judge the prose on its own.",
    "",
    "Deliverable artifacts to inspect FIRST (use your tools on each before any verdict):",
    ...refLines,
    "",
    "Acceptance criteria:",
    ...criteria.map((c, i) => `${i + 1}. ${c}`),
    "",
    "ANSWER under review:",
    answer,
    "",
    // Fraud-check rows — the two frauds an artifact inspector is
    // uniquely positioned to catch. Verdict vocabulary stays strictly PASS/FAIL.
    "Fraud checks while inspecting: (1) SCOPE — files or changes beyond what the criteria asked for are a FAIL even when well-made; name the out-of-scope item. (2) DEBRIS — debug prints, TODO/placeholder text, commented-out code scraps, or leftover scratch files inside the deliverables are a FAIL; name the file.",
    "",
    "After inspecting, reply with ONLY a single-line verdict:",
    "PASS — evidence: <one concrete fact you OBSERVED with your tools (file content/size, probe status) that proves the criteria are met>",
    "or: FAIL: <one concise sentence naming each unmet criterion / concrete defect you observed>.",
    "Never PASS on the answer's own claims — only on what your tools showed you.",
  ].join("\n");
}

/** Minimal runner contract the runtime satisfies with a runSubAgent adapter. */
export interface QaToolJudgeRunner {
  (task: string, allowedTools: readonly string[]): Promise<string>;
}

/**
 * Run the tool judge and parse its verdict. Throws only what the runner throws —
 * the caller treats ANY throw/empty output as "fall back to the prose check".
 */
export async function runQaToolJudgeCheck(
  answer: string,
  criteria: string[],
  refs: QaJudgeArtifactRef[],
  runner: QaToolJudgeRunner,
): Promise<QaVerdict> {
  if (refs.length === 0) throw new Error("qa-tool-judge: no inspectable artifacts");
  const output = (await runner(buildQaToolJudgeTask(answer, criteria, refs), QA_TOOL_JUDGE_TOOLS)).trim();
  if (!output) throw new Error("qa-tool-judge: empty verdict");
  return parseQaVerdict(output);
}
