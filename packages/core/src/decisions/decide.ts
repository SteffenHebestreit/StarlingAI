/**
 * One decision, by Laya or by its incumbent, as the point's mode says (config/schemas/decisions.ts).
 *
 * Both are started at once. In `shadow` the incumbent's answer is used and Laya's only recorded.
 * In `adaptive` and `laya` Laya's answer usually arrives first (milliseconds against the seconds of
 * an LLM call); if it may be taken, the incumbent is aborted and never waited for, and otherwise the
 * incumbent's answer is used as it would have been. So no mode ever makes a decision slower than
 * the incumbent alone, except by the time Laya takes when it is asked and not taken.
 */
import { logAudit } from "../audit/logger.js";
import { detectTextLanguage } from "../agent/text-language.js";
import { getConfig } from "../config/loader.js";
import type { DecisionMode } from "../config/schemas/decisions.js";
import { childLogger } from "../logger.js";
import { languageBucket, layaMayDecide, recordAgreementSample, resetGateForTests, type LanguageBucket } from "./gate.js";
import { askLaya, layaConfigured, resetLayaClientForTests, type LayaAnswer } from "./laya-client.js";
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
   * Today's decision. It gets a signal that aborts it once Laya's answer is taken; `undefined`
   * means it gave no answer, which is not counted as agreement or disagreement.
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
      ...(laya ? { laya: { choice: laya.choice, top: laya.top, probabilities: laya.probabilities, ms: laya.ms, ...(laya.model ? { model: laya.model } : {}) } } : {}),
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

export async function decide<T>(request: DecisionRequest<T>): Promise<DecisionOutcome<T>> {
  const { mode, threshold } = decisionMode(request.point.id);
  if (mode === "off" || !layaConfigured()) {
    return { value: await request.incumbent(NEVER_ABORTED), decidedBy: "incumbent" };
  }
  void seedDecisionGate();
  const language = languageBucket(detectTextLanguage(request.languageOf)?.code);
  const layaAnswer = askLaya(request.point, request.state, request.signal);
  const incumbentAbort = new AbortController();
  const incumbentStarted = Date.now();
  const incumbentRun = request.incumbent(incumbentAbort.signal).then((value) => ({ value, ms: Date.now() - incumbentStarted }));
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
      result = await incumbentRun;
    } catch (err) {
      void layaAnswer.then((laya) => settle(request as DecisionRequest<unknown>, { mode, language, laya, decidedBy: "incumbent" }));
      throw err;
    }
    void layaAnswer.then((laya) => settle(request as DecisionRequest<unknown>, {
      mode, language, laya, incumbent: { key: keyOf(result.value), ms: result.ms }, decidedBy: "incumbent",
    }));
    return { value: result.value, decidedBy: "incumbent" };
  }

  const laya = await layaAnswer;
  const adaptive = getConfig().decisions.adaptive;
  const layaQualifies = laya !== null
    && (request.layaMayTake?.includes(laya.choice) ?? true)
    && (mode === "laya" ? laya.top >= threshold : layaMayDecide(request.point.id, language, laya.choice, laya.top, adaptive, laya.model, request.point.protect));
  // A share of the cases Laya would take still goes to the incumbent in adaptive mode: without
  // them the agreement could not be measured once Laya decides, and drift would go unseen.
  const audited = mode === "adaptive" && layaQualifies && Math.random() < adaptive.auditRate;
  if (laya && layaQualifies && !audited) {
    incumbentAbort.abort();
    incumbentRun.catch(() => { /* aborted on purpose: Laya decided */ });
    settle(request as DecisionRequest<unknown>, { mode, language, laya, decidedBy: "laya" });
    return { value: request.fromKey(laya.choice), decidedBy: "laya", laya };
  }
  const result = await incumbentRun;
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
