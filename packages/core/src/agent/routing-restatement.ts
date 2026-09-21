/**
 * Retry a failed routing pass on an English restatement of the request.
 *
 * WHY. The catalog is written in English and the embedding is scored against it, so a German
 * request lands a few hundredths lower than its English twin — close enough to fall under the
 * 0.72 admission floor while meaning exactly the same thing. Measured on a 138-query corpus
 * (88 DE / 50 EN) against the live pipeline, routing the classifier's English restatement
 * after an empty first pass rescued 20 queries outright: raw recall 87 -> 107, and recall at
 * the discovery capsule 84 -> 97, with ZERO cases regressing.
 *
 * The numbers that shaped this design, because each one closed off an option:
 *
 *  - Restating EVERY non-English query costs 74 calls and buys nothing extra. All 20 rescues
 *    came from queries the raw pass left empty; the 49 "widened" cases were already passing
 *    and contributed 0 additional recall. So the trigger is a failed pass, not a language.
 *  - The classifier's LABELS are inert on retrieval — the admitted set changed in 1 case of
 *    138 and the top result in 0. Only the restatement moves the number, so only the
 *    restatement is used here.
 *  - The whole path costs p50 3.5s against the discovery prefetch's 2.5s budget, which
 *    resolves to an empty capsule on timeout. That is why this belongs on the TOOL path,
 *    where the model has already paid for a call and the alternative is being told nothing,
 *    and not in the turn's prompt-assembly race.
 *
 * Language is never detected. The rescue fires on a failed pass whatever the language, and
 * a restatement that comes back equivalent to the original simply skips the second retrieval
 * — a structural check that costs nothing and needs no per-language rules.
 */
import { runTriage } from "./triage.js";
import { resolveRoutingTierProvider } from "./routing-tier-provider.js";
import { runWithCallAttribution } from "../runtime/request-context.js";

/**
 * How long the rescue may take before it gives up and the caller reports the original miss.
 *
 * Generous compared with the 2.5s prompt-assembly budget, because the situation is different:
 * this runs only after routing has already found nothing, so the turn's realistic
 * alternatives are a few seconds here or a delegation to the wrong agent. It is still bounded
 * — a hung routing tier must not turn "no agent matched" into a hung tool call.
 */
const RESTATEMENT_RESCUE_BUDGET_MS = 6000;

/** Lowercase, strip punctuation, collapse whitespace — enough to tell "same request" apart. */
function normalizeForComparison(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export interface RestatementRescueResult<TResolution> {
  /** The English restatement the rescue routed on. */
  restatement: string;
  resolution: TResolution;
}

export interface RestatementRescueOptions<TResolution> {
  /** Re-run retrieval on the restatement. Injected so this module never imports the router. */
  resolve: (query: string) => Promise<TResolution>;
  /** True when the resolution is worth returning; a second empty pass is not a rescue. */
  admitted: (resolution: TResolution) => boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/**
 * Returns the restatement and its resolution, or null when the rescue does not apply.
 *
 * Null means "carry on and report the original miss" in every case: triage declined or timed
 * out, the restatement was equivalent to the request, or the second pass admitted nothing
 * either. The caller's existing failure message is always still correct.
 */
export async function attemptRestatementRescue<TResolution>(
  rawQuery: string,
  options: RestatementRescueOptions<TResolution>,
): Promise<RestatementRescueResult<TResolution> | null> {
  const provider = resolveRoutingTierProvider();
  const outcome = await runWithCallAttribution(
    { callSite: "routing_tier", agentName: "restatement_rescue" },
    () => runTriage({ userMessage: rawQuery }, {
      timeoutMs: options.timeoutMs ?? RESTATEMENT_RESCUE_BUDGET_MS,
      complete: async (messages, completeOptions) => (await provider.complete(messages, [], options.signal, {
        maxTokens: completeOptions.maxTokens,
        controls: completeOptions.controls,
        responseFormat: completeOptions.responseFormat,
      })).content ?? "",
    }),
  );

  const restatement = outcome.verdict?.queryEn?.trim() ?? "";
  if (!restatement) return null;
  // Already in the catalog's language, or close enough that retrieval would score it the
  // same. Re-running it would spend an embedding round-trip to reproduce the miss.
  if (normalizeForComparison(restatement) === normalizeForComparison(rawQuery)) return null;

  const resolution = await options.resolve(restatement);
  return options.admitted(resolution) ? { restatement, resolution } : null;
}
