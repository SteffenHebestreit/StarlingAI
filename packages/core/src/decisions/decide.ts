/**
 * One decision, by Laya or by its incumbent, as the point's mode says (config/schemas/decisions.ts).
 *
 * In `shadow` both are started at once; the incumbent's answer is used and Laya's only recorded.
 * In `adaptive` and `laya`, where Laya's answer could be taken — some answer of the point qualified
 * for this language and the checkpoint that answers, or mode `laya` — Laya is asked first and the
 * incumbent started only when its answer is not taken, or when it has not answered within
 * `decisions.layaFirstMs`; a taken answer never sends the incumbent at all. Measured 2026-09-26
 * (E5): an incumbent aborted right after it was sent made the next call on the same model 952 ms
 * slower, and the server discarded its prompt. Everywhere else both start at once, and a taken
 * answer aborts the incumbent as before. So no mode makes a decision slower than the incumbent
 * alone by more than the time Laya takes. Where Laya is asked first, layaFirstMs caps how long the
 * incumbent's START waits, not the decision: a Laya slower than the incumbent is still awaited, up
 * to decisions.timeoutMs, exactly as when both start at once.
 */
import { logAudit } from "../audit/logger.js";
import { detectTextLanguage } from "../agent/text-language.js";
import { getConfig } from "../config/loader.js";
import type { DecisionMode } from "../config/schemas/decisions.js";
import { childLogger } from "../logger.js";
import { languageBucket, layaMayDecide, modelsWithSamples, qualifiedLevel, recordAgreementSample, resetGateForTests, type GateSettings, type LanguageBucket } from "./gate.js";
import { askLaya, expectedLayaModel, layaCircuitOpen, layaConfigured, resetLayaClientForTests, type LayaAnswer } from "./laya-client.js";
import { appendLedgerRow, readLedgerRows } from "./ledger.js";
import type { DecisionPointDefinition, DecisionPointId } from "./points.js";

const log = childLogger("decisions");

/** Mode `laya` without a threshold of its own. */
export const DEFAULT_LAYA_THRESHOLD = 0.9;

export interface DecisionRequest<T> {
  point: DecisionPointDefinition;
  /** The facts of the case as Laya reads them — compact, within its window. */
  state: Record<string, unknown>;
  /** The text whose language decides which statistics apply: usually the user's message. */
  languageOf: string;
  /**
   * Today's decision. Where Laya is asked first it is not called at all when Laya's answer is taken;
   * where both start at once it gets a signal that aborts it then. `undefined` means it gave no
   * answer, which is not counted as agreement or disagreement.
   */
  incumbent: (signal: AbortSignal) => Promise<T | undefined>;
  /** The option key a decision of the incumbent corresponds to. */
  toKey: (value: T) => string;
  /** The decision an option key stands for. */
  fromKey: (key: string) => T;
  /**
   * The answers Laya may give on its own; default all. The others still go to the incumbent — for
   * an answer only the incumbent can act on, such as the receptionist's "small talk", whose reply
   * only the LLM can write. Laya is asked either way, so every answer keeps being measured.
   */
  layaMayTake?: readonly string[];
  sessionId?: string;
  /** The caller's own cancellation: aborts the question to Laya as well. */
  signal?: AbortSignal;
}

export interface DecisionOutcome<T> {
  value: T | undefined;
  decidedBy: "laya" | "incumbent";
  /** Laya's answer, when it was asked and answered in time. */
  laya?: LayaAnswer;
}

/** The mode a point runs in, and its fixed threshold for mode `laya`. */
export function decisionMode(point: DecisionPointId): { mode: DecisionMode; threshold: number } {
  const config = getConfig().decisions;
  const own = config?.points?.[point];
  return { mode: own?.mode ?? config?.defaultMode ?? "off", threshold: own?.threshold ?? DEFAULT_LAYA_THRESHOLD };
}

let seeding: Promise<void> | undefined;

/**
 * Rebuild the gate's statistics from the ledger, once per process. Started by the first decision
 * without being waited for: until it finishes, the gate knows less and so hands Laya less, never more.
 */
export function seedDecisionGate(): Promise<void> {
  seeding ??= readLedgerRows()
    .then((rows) => {
      let seeded = 0;
      for (const row of rows) {
        if (!row.laya || !row.incumbent) continue;
        recordAgreementSample(row.point, row.language, row.laya.choice, row.laya.top, row.laya.choice === row.incumbent.choice, row.laya.model ?? "", row.incumbent.choice);
        seeded += 1;
      }
      if (seeded > 0) log.info({ seeded }, "Decision gate rebuilt from the ledger");
    })
    .catch((err: unknown) => {
      log.warn({ err }, "Could not rebuild the decision gate from the ledger");
    });
  return seeding;
}

interface Settled {
  mode: DecisionMode;
  language: LanguageBucket;
  laya: LayaAnswer | null;
  incumbent?: { key: string | undefined; ms: number };
  decidedBy: "laya" | "incumbent";
}

/** Count the agreement, write the ledger row and the audit row. Never throws. */
function settle(request: DecisionRequest<unknown>, settled: Settled): void {
  try {
    const { laya, incumbent } = settled;
    const incumbentKey = incumbent?.key;
    const agree = laya && incumbentKey !== undefined ? laya.choice === incumbentKey : undefined;
    if (laya && incumbentKey !== undefined) {
      recordAgreementSample(request.point.id, settled.language, laya.choice, laya.top, agree === true, laya.model, incumbentKey);
    }
    void appendLedgerRow({
      ts: new Date().toISOString(),
      point: request.point.id,
      language: settled.language,
      state: request.state,
      mode: settled.mode,
      ...(laya ? {
        laya: {
          choice: laya.choice, top: laya.top, probabilities: laya.probabilities, ms: laya.ms,
          ...(laya.model ? { model: laya.model } : {}),
          ...(laya.truncatedTokens !== undefined ? { truncatedTokens: laya.truncatedTokens } : {}),
        },
      } : {}),
      ...(incumbentKey !== undefined ? { incumbent: { choice: incumbentKey, ms: incumbent!.ms } } : {}),
      decidedBy: settled.decidedBy,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    });
    logAudit("decision_point", {
      point: request.point.id,
      mode: settled.mode,
      decidedBy: settled.decidedBy,
      language: settled.language,
      ...(laya ? { laya: { choice: laya.choice, top: Math.round(laya.top * 1000) / 1000, ms: laya.ms } } : { laya: null }),
      ...(incumbent ? { incumbent: { choice: incumbentKey ?? null, ms: incumbent.ms } } : {}),
      ...(agree !== undefined ? { agree } : {}),
    }, { ...(request.sessionId ? { sessionId: request.sessionId } : {}), severity: "info" });
  } catch (err) {
    log.debug({ err, point: request.point.id }, "Could not record a decision");
  }
}

const NEVER_ABORTED = new AbortController().signal;

/**
 * Could Laya's answer be taken here, before it is known? Mode `laya` takes any answer at its threshold.
 * In `adaptive`, some answer Laya may take must have a qualified level for this language and the
 * version expected to answer — the one this point's last answer counted for, or before the first
 * answer of the process any version with evidence. A version that turns out different only costs
 * the one wait.
 */
function layaCouldDecide(request: DecisionRequest<unknown>, mode: DecisionMode, language: LanguageBucket, adaptive: GateSettings): boolean {
  if (mode === "laya") return true;
  const expected = expectedLayaModel(request.point);
  const answers = request.layaMayTake ?? Object.keys(request.point.options);
  return answers.some((answer) => (expected !== null ? [expected] : modelsWithSamples(request.point.id, language, answer))
    .some((model) => qualifiedLevel(request.point.id, language, answer, adaptive, model, request.point.protect) !== null));
}

const HEAD_START_OVER = Symbol("laya head start over");

/** Laya's answer, or HEAD_START_OVER once `ms` have passed without one (the timer is cleared either way). */
function withinHeadStart<A>(answer: Promise<A>, ms: number): Promise<A | typeof HEAD_START_OVER> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const over = new Promise<typeof HEAD_START_OVER>((resolve) => {
    timer = setTimeout(() => resolve(HEAD_START_OVER), ms);
  });
  return Promise.race([answer, over]).finally(() => clearTimeout(timer));
}

export async function decide<T>(request: DecisionRequest<T>): Promise<DecisionOutcome<T>> {
  const { mode, threshold } = decisionMode(request.point.id);
  if (mode === "off" || !layaConfigured()) {
    return { value: await request.incumbent(NEVER_ABORTED), decidedBy: "incumbent" };
  }
  void seedDecisionGate();
  const language = languageBucket(detectTextLanguage(request.languageOf)?.code);
  const adaptive = getConfig().decisions.adaptive;
  const headStartMs = getConfig().decisions.layaFirstMs ?? 0;
  // Laya first only where its answer could be taken and the breaker would let it be asked: elsewhere
  // nothing is aborted anyway, and waiting would only add Laya's time (adoption plan 2026-09-26, C6).
  const layaFirst = mode !== "shadow" && headStartMs > 0 && !layaCircuitOpen()
    && layaCouldDecide(request as DecisionRequest<unknown>, mode, language, adaptive);
  const layaAnswer = askLaya(request.point, request.state, request.signal);
  const incumbentAbort = new AbortController();
  let incumbentRun: Promise<{ value: T | undefined; ms: number }> | undefined;
  const startIncumbent = (): Promise<{ value: T | undefined; ms: number }> => {
    if (!incumbentRun) {
      const started = Date.now();
      incumbentRun = request.incumbent(incumbentAbort.signal).then((value) => ({ value, ms: Date.now() - started }));
      // Its failure is the caller's, through the await below; until decide() gets there (it may still
      // be waiting on Laya) the rejection is not unhandled, which the gateway would log as an error.
      incumbentRun.catch(() => { /* surfaced where it is awaited, or aborted on purpose */ });
    }
    return incumbentRun;
  };
  if (!layaFirst) void startIncumbent();
  const keyOf = (value: T | undefined): string | undefined => {
    if (value === undefined) return undefined;
    try {
      return request.toKey(value);
    } catch {
      return undefined;
    }
  };

  if (mode === "shadow") {
    let result: { value: T | undefined; ms: number };
    try {
      result = await startIncumbent();
    } catch (err) {
      void layaAnswer.then((laya) => settle(request as DecisionRequest<unknown>, { mode, language, laya, decidedBy: "incumbent" }));
      throw err;
    }
    void layaAnswer.then((laya) => settle(request as DecisionRequest<unknown>, {
      mode, language, laya, incumbent: { key: keyOf(result.value), ms: result.ms }, decidedBy: "incumbent",
    }));
    return { value: result.value, decidedBy: "incumbent" };
  }

  let laya: LayaAnswer | null;
  if (layaFirst) {
    const early = await withinHeadStart(layaAnswer, headStartMs);
    if (early === HEAD_START_OVER) {
      // Laya is slower than it should be: the incumbent starts now, and Laya may still be taken
      // when it answers in time — at the cost of an abort, as when both start at once.
      void startIncumbent();
      laya = await layaAnswer;
    } else {
      laya = early;
    }
  } else {
    laya = await layaAnswer;
  }
  const layaQualifies = laya !== null
    && (request.layaMayTake?.includes(laya.choice) ?? true)
    && (mode === "laya" ? laya.top >= threshold : layaMayDecide(request.point.id, language, laya.choice, laya.top, adaptive, laya.model, request.point.protect));
  // A share of the cases Laya would take still goes to the incumbent in adaptive mode: without
  // them the agreement could not be measured once Laya decides, and drift would go unseen.
  const audited = mode === "adaptive" && layaQualifies && Math.random() < adaptive.auditRate;
  if (laya && layaQualifies && !audited) {
    if (incumbentRun) {
      incumbentAbort.abort();
      incumbentRun.catch(() => { /* aborted on purpose: Laya decided */ });
    }
    settle(request as DecisionRequest<unknown>, { mode, language, laya, decidedBy: "laya" });
    return { value: request.fromKey(laya.choice), decidedBy: "laya", laya };
  }
  const result = await startIncumbent();
  settle(request as DecisionRequest<unknown>, {
    mode, language, laya, incumbent: { key: keyOf(result.value), ms: result.ms }, decidedBy: "incumbent",
  });
  return { value: result.value, decidedBy: "incumbent", ...(laya ? { laya } : {}) };
}

/** Test-only: forget the gate's samples, the breaker and the seeding. */
export function resetDecisionsForTests(): void {
  resetGateForTests();
  resetLayaClientForTests();
  seeding = undefined;
}
