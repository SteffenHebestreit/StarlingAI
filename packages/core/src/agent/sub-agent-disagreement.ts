/**
 * Sub-agent disagreement-as-signal (orchestration.subAgentDisagreementVerify).
 *
 * After a parallel fan-out, conflicting slice outputs should be a SIGNAL to reconcile/
 * verify, not silently averaged. This module builds the cheap routing-tier check, parses
 * its verdict, and renders the marker the orchestrator sees. Pure parts are unit-testable;
 * the live check does ONE routing-tier completion and fails OPEN (no marker) on any error
 * so it can never block or break a turn.
 */
import { decideWithReadout } from "../decisions/incumbent-readout.js";
import { layaConfigured } from "../decisions/laya-client.js";
import { SLICES_DISAGREE } from "../decisions/points.js";
import { getChatProviderForTier } from "../providers/index.js";
import { runWithCallAttribution } from "../runtime/request-context.js";
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
  // Anchor to the LEADING verdict token — the classifier is told to reply with the verdict FIRST
  // ("AGREE" / "DISAGREE: …"). Matching "DISAGREE" anywhere false-positived on chatty local-model
  // replies like "AGREE — they do not disagree", spuriously injecting a reconcile marker. Anything
  // that does not lead with DISAGREE is treated as agree (fail-open, consistent with the module).
  const m = text.match(/^(?:verdict[:\s-]*)?DISAGREE\b\s*:?\s*(.*)/i);
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
  sessionId?: string,
): Promise<string | null> {
  try {
    if (outputs.length < 2) return null;
    const provider = getChatProviderForTier("routing");
    if (!provider && !layaConfigured()) return null;
    // Laya reads every output clipped so all of them fit its window together. Its "disagree" names
    // no conflict — the marker then asks the orchestrator to find it — while the routing tier's does.
    const perOutput = Math.max(200, Math.floor(2_400 / outputs.length));
    const outcome = await decideWithReadout<{ disagree: boolean; detail: string }>({
      point: SLICES_DISAGREE,
      state: { outputs: outputs.map((output) => ({ label: output.label, text: output.text.slice(0, perOutput) })) },
      languageOf: outputs.map((output) => output.text).join("\n").slice(0, 2_000),
      ...(sessionId ? { sessionId } : {}),
      ...(signal ? { signal } : {}),
      incumbent: async (decisionSignal) => {
        if (!provider) return undefined;
        // Labelled like the other routing-tier verdicts (review of the thinking-off verdicts, D4).
        const res = await runWithCallAttribution({ callSite: "routing_tier", agentName: "disagreement_check" }, () =>
          provider.complete(buildDisagreementCheckMessages(outputs), [], signal ? AbortSignal.any([signal, decisionSignal]) : decisionSignal));
        return parseDisagreementVerdict(res.content ?? "");
      },
      toKey: (verdict) => (verdict.disagree ? "disagree" : "agree"),
      fromKey: (key) => ({ disagree: key === "disagree", detail: "" }),
      // A readout's "disagree" names no conflict either, as Laya's does not.
      readout: { provider, agentName: "disagreement_check" },
    });
    return outcome.value?.disagree ? renderDisagreementMarker(outcome.value.detail) : null;
  } catch (err) {
    log.debug({ err }, "disagreement check failed — failing open (no marker)");
    return null;
  }
}
