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
 * How long the TRIAGE CALL may take before the rescue gives up and the caller reports the
 * original miss.
 *
 * Generous compared with the 2.5s prompt-assembly budget, because the situation is different:
 * this runs only after routing has already found nothing, so the turn's realistic
 * alternatives are a few seconds here or a delegation to the wrong agent. It is still bounded
 * — a hung routing tier must not turn "no agent matched" into a hung tool call.
 *
 * It was 6000, and measuring the shipped path against the live cluster showed that was too
 * tight to trust. On 28 corpus queries that retrieve nothing, the rescue succeeded 13 times
 * with END-TO-END times of 2.9, 2.9, 3.0, 3.0, 3.1, 3.3, 3.5, 3.5, 3.7, 3.7, 5.6, 6.2 and
 * 6.3 seconds — the last two already past this number, and that was an IDLE cluster. Triage
 * alone measured 2.6-3.9s there, and the same box runs a 140s image tier that measurably
 * slows concurrent work (an NPU job went 9.9s -> 14.9s under load). A budget sitting inside
 * the observed spread would silently stop rescuing under exactly the contention that makes
 * routing hard, and the failure would look like the feature not working rather than like a
 * timeout.
 *
 * 15s is about 4x the idle median and 2.5x the worst observed. It does NOT cover a cold
 * model load on the routing tier (measured at ~27s on this cluster for a model that was not
 * preloaded); that case loses one rescue and the next call finds the model resident, which
 * is the right trade against making every miss wait half a minute.
 */
const RESTATEMENT_RESCUE_BUDGET_MS = 15_000;

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
