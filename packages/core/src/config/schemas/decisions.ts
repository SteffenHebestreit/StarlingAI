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
