/**
 * Sub-agent disagreement-as-signal (orchestration.subAgentDisagreementVerify).
 *
 * After a parallel fan-out, conflicting slice outputs should be a SIGNAL to reconcile/
 * verify, not silently averaged. This module builds the cheap routing-tier check, parses
 * its verdict, and renders the marker the orchestrator sees. Pure parts are unit-testable;
 * the live check does ONE routing-tier completion and fails OPEN (no marker) on any error
 * so it can never block or break a turn.
 */
import { getChatProviderForTier } from "../providers/index.js";
import type { LLMMessage } from "../providers/lmstudio.js";
import { childLogger } from "../logger.js";

const log = childLogger("agent:sub-agent-disagreement");

/** Only worth a check when at least two slices actually produced an answer to compare. */
export function shouldCheckSubAgentDisagreement(opts: { enabled: boolean; succeeded: number }): boolean {
  return opts.enabled === true && opts.succeeded >= 2;
}

export function buildDisagreementCheckMessages(outputs: ReadonlyArray<{ label: string; text: string }>): LLMMessage[] {
  const body = outputs
    .map((o, i) => `### Output ${i + 1} — ${o.label}\n${o.text.slice(0, 1500)}`)
    .join("\n\n");
  return [
    {
      role: "system",
      content:
        "You compare answers produced INDEPENDENTLY by several sub-agents for the same task. "
        + "Decide whether they materially CONFLICT — contradictory facts, figures, conclusions, or "
        + "recommendations — as opposed to merely differing in wording, detail, or coverage. "
        + "Reply on ONE line: exactly 'AGREE' if they are consistent, or 'DISAGREE: <the specific "
        + "conflict in a few words>' if they contradict each other.",
    },
    { role: "user", content: body },
  ];
}

export function parseDisagreementVerdict(raw: string): { disagree: boolean; detail: string } {
  const text = (raw ?? "").trim();
  const m = text.match(/\bDISAGREE\b\s*:?\s*(.*)/i);
  if (m) return { disagree: true, detail: (m[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 240) };
  return { disagree: false, detail: "" };
}

export function renderDisagreementMarker(detail: string): string {
  return (
    "[SUB-AGENT DISAGREEMENT — the parallel slices produced conflicting results"
    + (detail ? `: ${detail}` : "")
    + ". Do NOT silently merge them: determine which is correct (re-verify the conflicting point if "
    + "needed) and give the resolved answer, or surface the discrepancy to the user explicitly.]"
  );
}

/**
 * Run the live disagreement check over successful slice outputs. Returns the marker to
 * prepend when they conflict, or null (no marker) when they agree, the check is disabled,
 * there is no routing tier, or anything errors (fail-open).
 */
export async function checkSubAgentDisagreement(
  outputs: ReadonlyArray<{ label: string; text: string }>,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    if (outputs.length < 2) return null;
    const provider = getChatProviderForTier("routing");
    if (!provider) return null;
    const res = await provider.complete(buildDisagreementCheckMessages(outputs), [], signal);
    const verdict = parseDisagreementVerdict(res.content ?? "");
    return verdict.disagree ? renderDisagreementMarker(verdict.detail) : null;
  } catch (err) {
    log.debug({ err }, "disagreement check failed — failing open (no marker)");
    return null;
  }
}
