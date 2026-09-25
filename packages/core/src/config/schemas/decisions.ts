import { z } from "zod";

/**
 * How one decision point is decided.
 *
 * - `off`: the incumbent decides alone — the LLM call or rule that decides it today. Laya is not asked.
 * - `shadow`: the incumbent decides; Laya is asked alongside, and both answers go to the ledger.
 * - `adaptive`: Laya decides wherever the ledger shows it agrees with the incumbent. That is judged
 *   per decision point, language and answer, at the lowest confidence where the agreement's lower
 *   bound reaches `adaptive.targetAgreement` over at least `adaptive.minSamples` cases. Elsewhere
 *   the incumbent decides, so this starts out as `shadow` and hands over as evidence builds up.
 *   A share of the cases Laya would take (`adaptive.auditRate`) still goes to the incumbent, so the
 *   agreement keeps being measured after the handover.
 * - `laya`: Laya decides whenever its top probability reaches the point's `threshold`; otherwise
 *   the incumbent. For a measured threshold — `adaptive` finds one without guessing.
 */
export const DecisionModeSchema = z.enum(["off", "shadow", "adaptive", "laya"]);
export type DecisionMode = z.infer<typeof DecisionModeSchema>;

export const DecisionPointSettingsSchema = z.object({
  /** Overrides `defaultMode` for this point. */
  mode: DecisionModeSchema.optional(),
  /** For mode `laya`: the top probability from which Laya's answer is taken. */
  threshold: z.number().min(0.5).max(1).optional(),
});

/**
 * The Laya decision layer: a small local choice model, served by the `laya` sidecar, that answers
 * the swarm's yes/no and pick-one-of-N questions in milliseconds instead of an LLM call of seconds.
 * Every point keeps the decision it had (the incumbent) as its fallback and as the teacher Laya is
 * measured, and later fine-tuned, against.
 */
export const DecisionsSchema = z.object({
  /**
   * The sidecar, e.g. "http://laya:8080" inside the compose network. Empty: Laya is never asked,
   * whatever the modes say, so the default install behaves exactly as without this layer.
   */
  baseUrl: z.string().default(""),
  /** How long one answer may take before the incumbent's is used. */
  timeoutMs: z.number().int().min(50).max(15_000).default(1_500),
  /** The mode of every point without its own. */
  defaultMode: DecisionModeSchema.default("off"),
  /** Per decision point, keyed by its id (decisions/points.ts). */
  points: z.record(z.string(), DecisionPointSettingsSchema).default({}),
  adaptive: z.object({
    /** The lower bound (Wilson, 95%) the measured agreement must reach before Laya decides. */
    targetAgreement: z.number().min(0.5).max(1).default(0.9),
    /** The fewest measured cases a confidence level needs before it can qualify. */
    minSamples: z.number().int().min(5).max(10_000).default(30),
    /** The share of Laya's qualified cases the incumbent still decides, to keep measuring. */
    auditRate: z.number().min(0).max(1).default(0.1),
  }).default({}),
  /**
   * laya-browser beside the browser agent (decisions/browser-step.ts) — any agent holding browser_click.
   *
   * - `off`: not asked.
   * - `shadow`: before each click, typing, select or final answer of the model, the page is read the way laya-browser
   *   was trained to read it and laya-browser is asked what it would do. The model acts as always; both choices go
   *   to the audit and to `decisions/browser-ledger.jsonl`, compared element for element.
   * - `adaptive`: shadow, and laya-browser clicks and selects on its own wherever the comparisons show it agrees with
   *   the model — per operation and language, from the lowest confidence (its operation's and its element's, the
   *   lower of the two) at which the agreement's lower bound reaches `adaptive.targetAgreement` over at least
   *   `adaptive.minSamples` steps. `adaptive.auditRate` of those steps still go to the model, to keep measuring.
   *   Until a confidence qualifies it only compares, and does not read the page before the model's turn.
   * - `drive`: shadow, and laya-browser acts on its own whenever its operation and its element are both at
   *   `driveMinProbability` or above. Its probabilities are not calibrated: measured on real pages, right and wrong
   *   elements both came at 0.6–0.7, so a fixed threshold either never acts or acts wrongly — `adaptive` finds the
   *   level from the evidence.
   *
   * In both acting modes: never a form submit, a download, a link into another tab or to an internal host, typing
   * or finishing. Its steps are ordinary browser_click / browser_select_option calls of the run, marked as its own.
   */
  browser: z.object({
    mode: z.enum(["off", "shadow", "adaptive", "drive"]).default("off"),
    /** For mode `drive`, and for scrolling and waiting in place in either acting mode. */
    driveMinProbability: z.number().min(0.5).max(1).default(0.9),
    /** At most this many steps per run are laya-browser's own. */
    maxDrivenSteps: z.number().int().min(1).max(50).default(12),
    /** At most this many in a row before the model is asked again. */
    maxConsecutiveDriven: z.number().int().min(1).max(20).default(4),
    /** One step: the page read plus laya-browser's answer. ~20 ms on a GPU, ~2 s on a CPU. */
    timeoutMs: z.number().int().min(100).max(30_000).default(5_000),
    /**
     * laya-browser was trained on English goals only: translate the task once per run with the routing tier
     * before asking it.
     */
    translateGoal: z.boolean().default(true),
  }).default({}),
  ledger: z.object({
    /**
     * Record every decision Laya was asked about: the case, both answers, who decided. The
     * adaptive statistics are rebuilt from it at start, and it is the fine-tuning data.
     */
    enabled: z.boolean().default(true),
    /**
     * Where it is written. Default: `<state dir>/decisions/ledger.jsonl`, which a
     * `sai stop --volumes` leaves in place — it is training data, not session state.
     */
    path: z.string().optional(),
  }).default({}),
});
export type DecisionsConfig = z.infer<typeof DecisionsSchema>;
