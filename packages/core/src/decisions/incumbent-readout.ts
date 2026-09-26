/**
 * A decision point's incumbent, read by its logits where config says so (decisions.readout).
 *
 * Every point's incumbent today is an LLM call whose written verdict a parser reads. This wraps
 * that call — at the incumbent closure, so decisions/decide.ts and its gate see an incumbent like
 * any other — and, per point:
 *
 *   - `off` (default): the parsed call alone, exactly as before.
 *   - `shadow`: the readout (decisions/logit-readout.ts) is asked beside the parsed call; the
 *     parsed answer decides and is returned as soon as it is there, the readout is never waited
 *     for, and when both have answered one row goes to the readout ledger and one `decision_readout`
 *     row to the audit. Nothing about the decision changes; the agreement becomes countable.
 *   - `on`: the readout's answer is the incumbent's. The parsed call still runs when the readout
 *     gives none, and for the answers only it can act on (`parsedFor`): its value is more than the
 *     choice — the receptionist's reply, the distillation's extracted facts.
 *
 * Laya's own mode is independent: decide() asks Laya and this incumbent as it always did. But
 * wherever decide() records the incumbent's answer as Laya's teacher — Laya configured and the
 * point's mode not `off`, `shadow` included — its ledger and its gate cannot yet tell which
 * incumbent answered, so `on` runs as `shadow` there (layaLearnsFromIncumbent). The readout
 * ledger's `incumbentVersion` says which incumbent decided each case.
 */
import { detectTextLanguage } from "../agent/text-language.js";
import { logAudit } from "../audit/logger.js";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import type { ChatProvider } from "../providers/lmstudio.js";
import { runWithCallAttribution } from "../runtime/request-context.js";
import { decide, decisionMode, type DecisionOutcome, type DecisionRequest } from "./decide.js";
import { languageBucket, type LanguageBucket } from "./gate.js";
import { layaConfigured } from "./laya-client.js";
import { appendReadoutLedgerRow } from "./ledger.js";
import { askReadout, DEFAULT_MIN_LETTER_MASS, MAX_TOP_LOGPROBS, type ReadoutResult } from "./logit-readout.js";
import type { DecisionPointId } from "./points.js";

const log = childLogger("decisions:readout");

/**
 * The readout's version as an incumbent. A change to what it asks or how it reads the answer is a
 * different incumbent: bump this, so rows of the two are never counted together.
 */
export const READOUT_INCUMBENT_VERSION = "readout-v1";

/** The parsed call's version tag in the readout ledger. */
export const PARSED_INCUMBENT_VERSION = "parsed";

export type ReadoutMode = "off" | "shadow" | "on";

export function readoutMode(point: string): ReadoutMode {
  const readout = getConfig().decisions?.readout;
  return readout?.points?.[point] ?? readout?.defaultMode ?? "off";
}

/**
 * Does decide() record this point's incumbent answer as Laya's teacher? It does wherever Laya is
 * configured and the point's mode is not `off` — `shadow` included, which writes the decision
 * ledger (whose `incumbent.choice` is what decisions:export turns into fine-tuning labels) and
 * counts the gate's agreement all the same. Neither says which incumbent answered, so a readout
 * deciding there would be counted as the parsed call: the labels would change under a gate whose
 * evidence was earned against the old ones, where the adoption plan (2026-09-26, C7) asks for a
 * new incumbent version tag. Until decide.ts keys both by incumbent version, `on` runs as
 * `shadow` on such a point. The deployed shard (config/gateway/45-decisions.jsonc) sets Laya's
 * default mode to adaptive, so a point needs its own Laya mode `off` for the readout to decide.
 */
export function layaLearnsFromIncumbent(point: DecisionPointId): boolean {
  return layaConfigured() && decisionMode(point).mode !== "off";
}

const warnedShadowed = new Set<string>();

/** The fitted temperature for a point and language; 1 when none was configured. */
export function readoutTemperature(point: string, language: LanguageBucket): number {
  const t = getConfig().decisions?.readout?.temperatures?.[point]?.[language];
  return typeof t === "number" && Number.isFinite(t) && t > 0 ? t : 1;
}

export interface ReadoutSpec {
  /** The model the parsed call runs on; without one the readout is never asked. */
  provider: Pick<ChatProvider, "complete"> | null | undefined;
  /** The parsed call's attribution name; the readout's provider rows carry it with `_readout`. */
  agentName?: string;
  /** Answers whose value only the parsed call can produce: in `on`, the parsed call runs for them. */
  parsedFor?: readonly string[];
  /** Cancels the readout, beside decide()'s own signal; default the request's `signal`. */
  signal?: AbortSignal;
}

type Recorded = {
  mode: "shadow" | "on";
  language: LanguageBucket;
  temperature: number;
  readout: ReadoutResult;
  parsed?: { key: string | undefined; ms: number };
  decidedBy: "readout" | "parsed";
};

/** One readout ledger row and one audit row. Never throws. */
function record<T>(request: DecisionRequest<T>, entry: Recorded): void {
  try {
    const readoutKey = entry.readout.ok ? entry.readout.answer.choice : undefined;
    const parsedKey = entry.parsed?.key;
    const agree = readoutKey !== undefined && parsedKey !== undefined ? readoutKey === parsedKey : undefined;
    const incumbentVersion = entry.decidedBy === "readout" ? READOUT_INCUMBENT_VERSION : PARSED_INCUMBENT_VERSION;
    const readout = entry.readout.ok
      ? {
          choice: entry.readout.answer.choice,
          top: entry.readout.answer.top,
          probabilities: entry.readout.answer.probabilities,
          logScores: entry.readout.answer.logScores,
          mass: entry.readout.answer.mass,
          temperature: entry.readout.answer.temperature,
          ms: entry.readout.answer.ms,
        }
      : { miss: entry.readout.reason, ms: entry.readout.ms, ...(entry.readout.topToken !== undefined ? { topToken: entry.readout.topToken } : {}) };
    void appendReadoutLedgerRow({
      ts: new Date().toISOString(),
      point: request.point.id,
      language: entry.language,
      state: request.state,
      mode: entry.mode,
      incumbentVersion,
      readoutVersion: READOUT_INCUMBENT_VERSION,
      decidedBy: entry.decidedBy,
      readout,
      ...(entry.parsed ? { parsed: { choice: parsedKey ?? null, ms: entry.parsed.ms } } : {}),
      ...(agree !== undefined ? { agree } : {}),
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    });
    // The audit row carries no case text: ids, answers and numbers only.
    logAudit("decision_readout", {
      point: request.point.id,
      mode: entry.mode,
      language: entry.language,
      incumbentVersion,
      decidedBy: entry.decidedBy,
      readoutVersion: READOUT_INCUMBENT_VERSION,
      readout: entry.readout.ok
        ? { choice: entry.readout.answer.choice, top: Math.round(entry.readout.answer.top * 1000) / 1000, mass: Math.round(entry.readout.answer.mass * 1000) / 1000, temperature: entry.temperature, ms: entry.readout.answer.ms }
        : { miss: entry.readout.reason, ms: entry.readout.ms },
      ...(entry.parsed ? { parsed: { choice: parsedKey ?? null, ms: entry.parsed.ms } } : {}),
      ...(agree !== undefined ? { agree } : {}),
    }, { ...(request.sessionId ? { sessionId: request.sessionId } : {}), severity: "info" });
  } catch (err) {
    log.debug({ err, point: request.point.id }, "Could not record a readout");
  }
}

/**
 * The request's incumbent, with the readout beside it or in its place as the point's readout mode
 * says. The returned closure is what decide() calls; it gets decide()'s abort signal, which
 * cancels the readout too once Laya's answer is taken.
 */
export function incumbentWithReadout<T>(request: DecisionRequest<T>, spec: ReadoutSpec): (signal: AbortSignal) => Promise<T | undefined> {
  return async (decisionSignal) => {
    const configured = readoutMode(request.point.id);
    const provider = spec.provider;
    if (configured === "off" || !provider) return request.incumbent(decisionSignal);
    const mode = configured === "on" && layaLearnsFromIncumbent(request.point.id) ? "shadow" : configured;
    if (mode !== configured && !warnedShadowed.has(request.point.id)) {
      warnedShadowed.add(request.point.id);
      log.warn({ point: request.point.id }, "decisions.readout is on, but Laya learns from this point's incumbent: the readout runs as shadow until the ledger keys its rows by incumbent version");
    }
    const keyOf = (value: T | undefined): string | undefined => {
      if (value === undefined) return undefined;
      try {
        return request.toKey(value);
      } catch {
        return undefined;
      }
    };
    const language = languageBucket(detectTextLanguage(request.languageOf)?.code);
    const temperature = readoutTemperature(request.point.id, language);
    const settings = getConfig().decisions?.readout;
    const own = spec.signal ?? request.signal;
    const signal = own ? AbortSignal.any([own, decisionSignal]) : decisionSignal;
    const ask = (): Promise<ReadoutResult> => runWithCallAttribution(
      { callSite: "routing_tier", agentName: `${spec.agentName ?? request.point.id}_readout` },
      () => askReadout(provider, request.point, request.state, {
        signal,
        temperature,
        topLogprobs: settings?.topLogprobs ?? MAX_TOP_LOGPROBS,
        minMass: settings?.minLetterMass ?? DEFAULT_MIN_LETTER_MASS,
      }),
    );

    if (mode === "shadow") {
      const started = Date.now();
      const readout = ask();
      const parsedRun = request.incumbent(decisionSignal).then((value) => ({ value, ms: Date.now() - started }));
      // Recorded once both are in; the decision waits for the parsed call only.
      void Promise.allSettled([parsedRun, readout]).then(([parsed, answer]) => {
        if (parsed.status !== "fulfilled" || answer.status !== "fulfilled") return;
        record(request, {
          mode, language, temperature, readout: answer.value, parsed: { key: keyOf(parsed.value.value), ms: parsed.value.ms }, decidedBy: "parsed",
        });
      });
      return (await parsedRun).value;
    }

    const readout = await ask();
    // decide() took Laya's answer while the readout ran: the parsed call it would fall back to is
    // no longer wanted, and one sent now only occupies the model the turn's next call waits for.
    // Today `on` only runs where decide() never aborts (layaLearnsFromIncumbent); this keeps it so
    // once decide.ts keys its rows by incumbent version and `on` runs beside Laya.
    if (decisionSignal.aborted) return undefined;
    if (readout.ok && !(spec.parsedFor ?? []).includes(readout.answer.choice)) {
      record(request, { mode, language, temperature, readout, decidedBy: "readout" });
      return request.fromKey(readout.answer.choice);
    }
    // No readout answer, or one only the parsed call can act on: today's call decides, and where
    // both answered the pair is one more agreement sample.
    const started = Date.now();
    const value = await request.incumbent(decisionSignal);
    record(request, { mode, language, temperature, readout, parsed: { key: keyOf(value), ms: Date.now() - started }, decidedBy: "parsed" });
    return value;
  };
}

/** decide() with the incumbent wrapped by the readout: the call sites' one-line switch. */
export function decideWithReadout<T>(request: DecisionRequest<T> & { readout: ReadoutSpec }): Promise<DecisionOutcome<T>> {
  const { readout, ...decision } = request;
  return decide<T>({ ...decision, incumbent: incumbentWithReadout(decision, readout) });
}
