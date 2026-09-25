/**
 * The decision points Laya may answer: what each one asks and which answers it has.
 *
 * Laya reads the question, each option's description and a JSON "state" (the facts of the case)
 * in one window of about 1024 tokens, and scores every option. Each option is cut to 48 tokens, so
 * the options stay short and the detail goes into the question. The wording follows the prompt of
 * the incumbent — the LLM call or rule the point replaces — so both are asked the same thing and
 * their agreement means something. The option keys are what the ledger and the statistics record:
 * renaming one starts that point's measurement over.
 */

export interface DecisionPointDefinition {
  readonly id: DecisionPointId;
  /** What is decided, in plain English, as Laya reads it. */
  readonly question: string;
  /** Each answer's key and what it means. */
  readonly options: Readonly<Record<string, string>>;
}

export type DecisionPointId =
  | "fast_lane"
  | "source_sensitive"
  | "ungrounded_draft"
  | "slices_disagree"
  | "goal_met"
  | "finding_relevant"
  | "run_drifting";

function point(id: DecisionPointId, question: string, options: Record<string, string>): DecisionPointDefinition {
  return Object.freeze({ id, question, options: Object.freeze(options) });
}

/** Receptionist: small talk it can answer itself, or a task for the full assistant (agent/receptionist.ts). */
export const FAST_LANE = point(
  "fast_lane",
  "An AI assistant has a quick front desk for small talk; everything else goes to the full assistant with its tools and specialists. "
  + "Decide whether the user's message is small talk the front desk can answer in one or two short sentences from what it knows about itself, "
  + "or a task. Anything that asks to do, find, create, check, compute or look up something is a task, however short.",
  {
    small_talk: "Small talk: greeting, thanks, goodbye, how are you, what is your name, what can you do.",
    task: "A task or real question: do, find, create, check, compute, explain or look up something.",
  },
);

/** Up-front source-sensitivity judge: research before drafting? (agent/ungrounded-claim-judge.ts). */
export const SOURCE_SENSITIVE = point(
  "source_sensitive",
  "Before any answer is written, decide whether answering this message well requires specific, checkable real-world facts that "
  + "must be looked up rather than recalled: a named organisation, company, product or brand; a price, fee, rate or statistic; a law "
  + "or rule; a date or current event; how a particular real system, scheme, service or place works; or which real product or version "
  + "is best, latest or recommended. Judge the subject, not the phrasing: a general concept that works the same everywhere does not count.",
  {
    yes: "Yes: it depends on specific real-world facts that must be verified or may have changed.",
    no: "No: general knowledge, a concept in principle, reasoning, writing, code, small talk, or the user's own content.",
  },
);

/** Post-draft judge: does a tool-free draft lean on unsourced external facts? (agent/ungrounded-claim-judge.ts). */
export const UNGROUNDED_DRAFT = point(
  "ungrounded_draft",
  "The assistant wrote this draft answer from memory, without any search or lookup this turn. Decide whether the draft states specific, "
  + "checkable claims about the external world as established fact: a named real organisation, company, product or brand, a price or "
  + "amount, a rate or statistic, a law or regulation, a date, or how a particular real system or place works. When genuinely unsure, "
  + "answer no.",
  {
    yes: "Yes: it relies on specific external facts that would need a source.",
    no: "No: general knowledge, a definition, reasoning, advice, a calculation, code, small talk, or the user's own content.",
  },
);

/** Parallel slices: do independent results for one task contradict each other? (agent/sub-agent-disagreement.ts). */
export const SLICES_DISAGREE = point(
  "slices_disagree",
  "Several sub-agents answered the same task independently. Decide whether their answers materially conflict: contradictory facts, "
  + "figures, conclusions or recommendations, as opposed to merely differing in wording, detail or coverage.",
  {
    agree: "Consistent: no contradiction, only differences in wording, detail or coverage.",
    disagree: "Conflicting: they contradict each other on a fact, figure, conclusion or recommendation.",
  },
);

/** Sub-agent oversight: is the evidence already enough to answer? (agent/sub-agent.ts assessOversightGoalMet). */
export const GOAL_MET = point(
  "goal_met",
  "A worker agent is gathering evidence for a task. Given the task's acceptance criteria and the evidence gathered so far, decide whether "
  + "the goal is already met well enough to write the final answer now, so the worker should stop gathering.",
  {
    done: "Done: the evidence already covers every acceptance criterion.",
    continue: "Continue: at least one criterion is clearly not covered yet.",
  },
);

/**
 * Shared-fact distillation: does fetched content hold anything relevant to the research objective?
 * (agent/sub-agent.ts distillFindingForSharedFacts). Only "irrelevant" can be Laya's alone — relevant
 * content still needs the model, the only one that can extract it.
 */
export const FINDING_RELEVANT = point(
  "finding_relevant",
  "A research step fetched this content for an objective. Decide whether it contains anything relevant to the objective: concrete "
  + "facts, figures, dates, names, prices, specifications or source links about it. Navigation menus, cookie or login banners, site "
  + "chrome, errors and content about other subjects do not count.",
  {
    relevant: "Relevant: it holds at least one fact, figure, name, date, price or source that serves the objective.",
    irrelevant: "Nothing relevant: only page chrome, banners, errors or content about something else.",
  },
);

/**
 * Sub-agent semantic progress judge: is a long run still moving toward its objective?
 * (agent/progress-verifier.ts). Only "on_track" can be Laya's alone — "drifting" winds a run down.
 */
export const RUN_DRIFTING = point(
  "run_drifting",
  "A long-running agent works toward an objective. Given the objective and a digest of its recent activity, decide whether the "
  + "activity is still moving toward the objective — not whether it is finished, polished or fast. Only clearly working on the wrong "
  + "thing, being stuck repeating itself or contradicting the objective counts as drifting; when in doubt it is on track.",
  {
    on_track: "On track: the recent activity serves the objective, even if slowly or indirectly.",
    drifting: "Drifting: clearly working on the wrong thing, stuck repeating itself, or contradicting the objective.",
  },
);

export const DECISION_POINTS: Readonly<Record<DecisionPointId, DecisionPointDefinition>> = Object.freeze({
  fast_lane: FAST_LANE,
  source_sensitive: SOURCE_SENSITIVE,
  ungrounded_draft: UNGROUNDED_DRAFT,
  slices_disagree: SLICES_DISAGREE,
  goal_met: GOAL_MET,
  finding_relevant: FINDING_RELEVANT,
  run_drifting: RUN_DRIFTING,
});
