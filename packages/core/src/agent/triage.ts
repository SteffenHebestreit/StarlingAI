/**
 * Facet triage — ONE short classification call per escalated turn.
 *
 * WHAT IT REPLACES. The per-turn classifier has not classified anything since the
 * de-lexicalization: every routing flag it returns is a hardwired `false`, and ~25 sites
 * still branch on them. The one live semantic signal is a yes/no source-sensitivity judge.
 * So the swarm's actual router is 7,331 characters of hand-written intent→agent prose in the
 * always-on prompt — a table a human maintains, sent on every turn, that no test covers.
 *
 * WHAT IT IS. One routing-tier call with a FROZEN prefix that returns the request's position
 * in the IDCM taxonomy: mode, domain, deliverable, whether it splits into parts, whether one
 * unit could do it alone, whether it needs fresh external facts, and an English restatement.
 *
 * THREE PROPERTIES IT IS BUILT FOR, each of which was a measured failure before:
 *
 *  1. CATALOG-BLIND. The prompt never names an agent or workflow. So it starts in PARALLEL
 *     with the embedding shortlist instead of after it, it carries no position bias over a
 *     candidate list, its dynamic tail stays small, and — the point — its frozen prefix does
 *     not change when the catalog does.
 *
 *  2. BIT-COMPATIBLE WITH THE JUDGE IT REPLACES. `sourceSensitive` is defined with the
 *     upfront judge's own wording, because that verdict is the single switch that arms
 *     forced research downstream. A shadow run can then compare the two directly, and
 *     "agrees ≥95%" is a real gate rather than a vibe.
 *
 *  3. A FAILED CALL IS A FAILED CALL. Grammar-constrained JSON where the provider supports
 *     it; a prose reply is never salvaged by re-reading it as intent. One retry, then null —
 *     and null means the turn proceeds exactly as it does today.
 *
 * Nothing here decides anything. It reports labels; the fusion decides, and treats these as
 * bounded boosts over an already-admitted candidate set.
 */

import type { LLMMessage } from "../providers/lmstudio.js";
import type { RequestFacets } from "./routing-taxonomy.js";

/**
 * Version of the frozen prefix. Bump when the prompt text changes: the prefix is a KV-cache
 * key and a shadow comparison is only meaningful within one version.
 *
 * MEASURED, and deliberately NOT changed. On the first live run this wording produced an
 * English restatement on 9 of 15 German requests. That matters, because the restatement is
 * what a second retrieval pass would use to rescue a German query landing a few hundredths
 * under the 0.72 admission floor — a rescue available on 60% of turns rescues 60% of turns.
 *
 * Two rewordings were tried against the same 15 requests. Making it explicitly REQUIRED for
 * non-English input made it WORSE (3 of 15): ending the line on the empty-string case is
 * what the small model carries away. Putting the restatement last recovered 8 of 15 —
 * indistinguishable from the original at this sample size. So the prompt stands: bumping a
 * KV-cache-keyed frozen prefix for a change that does not measurably help is the blind
 * prompt-trim this project has already paid for three times.
 *
 * The ~60% ceiling is a property of the model, not of the wording, and it bounds what the
 * queryEn second pass can be worth. Fix it with a mechanism, not with more adjectives.
 */
export const TRIAGE_PROMPT_VERSION = "idcm-1";

export interface TriageVerdict {
  /** L1 of the REQUEST. `converse` means no specialist is needed. */
  mode: RequestFacets["mode"];
  /** L2 of the work required — one or two, never the topic. */
  domain: Array<Exclude<RequestFacets["domain"][number], "cross_domain">>;
  deliverable: NonNullable<RequestFacets["deliverable"]>;
  /** The request splits into parts needing different capabilities. */
  multi: boolean;
  /** Up to three parts when `multi`; each is one clause of the request. */
  parts: string[];
  /** One unit could plausibly complete the whole request end to end. */
  alone: boolean;
  /** The judge's contract, verbatim — see the prompt. */
  sourceSensitive: boolean;
  /** What the classifier would do, as a hint. The fusion is free to overrule it. */
  decision: "answer_direct" | "single_agent" | "workflow" | "coordinate" | "clarify";
  /** Goal/input slots the request leaves unstated. */
  missing: string[];
  /** The request restated in English, for a second retrieval pass. Empty when already English. */
  queryEn: string;
  language: "en" | "de" | "other";
  /** Self-reported confidence in [0,1]; scales every downstream bonus. */
  confidence: number;
}

/** JSON Schema handed to the provider so the shape is grammar-constrained, not requested. */
export const TRIAGE_RESPONSE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "mode", "domain", "deliverable", "multi", "parts", "alone",
    "source_sensitive", "decision", "missing", "query_en", "language", "confidence",
  ],
  properties: {
    mode: { type: "string", enum: ["converse", "GATHER", "PRODUCE", "ACT", "VERIFY", "ORCHESTRATE"] },
    domain: {
      type: "array", minItems: 0, maxItems: 2,
      items: {
        type: "string",
        enum: ["research", "software", "authoring", "data", "media", "device_control", "comms", "infra_ops", "security", "swarm_meta"],
      },
    },
    deliverable: {
      type: "string",
      enum: ["evidence", "prose_doc", "deck", "website", "code", "running_app", "chart", "diagram", "image", "data_table", "plan", "verdict", "message", "config_change", "none"],
    },
    multi: { type: "boolean" },
    parts: { type: "array", maxItems: 3, items: { type: "string" } },
    alone: { type: "boolean" },
    source_sensitive: { type: "boolean" },
    decision: { type: "string", enum: ["answer_direct", "single_agent", "workflow", "coordinate", "clarify"] },
    missing: { type: "array", maxItems: 3, items: { type: "string" } },
    query_en: { type: "string" },
    language: { type: "string", enum: ["en", "de", "other"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
};

/**
 * The frozen prefix. Byte-identical across every turn and session until the version bumps,
 * and catalog-independent so adding an agent never cools it.
 *
 * The taxonomy values carry their NOT-here clause, which is what makes coarse labelling
 * stable for a small model; the coordinate criteria are STRUCTURAL (domains touched, steps,
 * boundary crossings), never topical. No chain-of-thought is requested: a routing-tier call
 * that starts reasoning is the 8,000-token burn this codebase has already paid for once.
 */
export const TRIAGE_SYSTEM_PROMPT = `You label a user request for an assistant's router. Reply with JSON only — no prose, no explanation, no reasoning.

mode — what the request asks the assistant to DO (the verb, never the topic):
- converse: greeting, chit-chat, or a question answerable from stable general knowledge with no tool
- GATHER: find, read, diagnose or analyse information; the result is facts or findings
- PRODUCE: author a durable artifact (text, code, app, chart, image, deck, plan) from inputs
- ACT: cause an effect on an EXTERNAL system (send, deploy, mutate a repo/DB/host, drive a live browser or PC, call a live service)
- VERIFY: judge something that already exists against criteria and return a verdict
- ORCHESTRATE: the work spans several different capabilities and must be planned first
Running code in an isolated sandbox to produce a result is PRODUCE, not ACT — ACT means something outside changes.

domain — the capability the WORK needs, NOT the subject of the request. Pick one, or two when a second is materially required:
research, software, authoring, data, media, device_control, comms, infra_ops, security, swarm_meta
- research: finding and verifying external information on any topic, including reading advisories or docs
- software: writing, running, reviewing or version-controlling code; calling APIs
- authoring: audience-facing written deliverables
- data: structured/tabular data, databases, extracting from documents
- media: charts, diagrams, images — producing or interpreting visuals
- device_control: driving a live browser session or a real desktop
- comms: mail, calendar, outbound notifications
- infra_ops: servers, clusters, deployments, logs, incidents
- security: AUTHORIZED offensive security under a written scope (reading about vulnerabilities is research)
- swarm_meta: changing the assistant's own agents, prompts, tools or durable memory
"Research the best image model" is GATHER + research: the work is research, "image" is only the topic.
Leave domain empty only for converse.

deliverable — what the user ends up with. "none" when nothing is produced.

source_sensitive — true when answering correctly requires SPECIFIC checkable real-world facts: a named organisation, product, price, rate, statistic, law, version, or exactly how a particular real system works — including "which X is best / latest / recommended", comparisons, and anything whose answer changes over time. It stays true when the request is phrased as advice. It is FALSE for general principles, concepts, how something works in the abstract, the user's own pasted content, and requests about the assistant itself.

multi / parts — true when the request contains clauses needing different capabilities (e.g. research something AND then build something from it). List each clause in parts.

alone — true when ONE specialist or ONE prebuilt workflow could plausibly finish the whole request.

decision — the smallest path that would work:
- answer_direct: no tool needed and not source_sensitive
- single_agent: one specialist does all of it
- workflow: a prebuilt multi-step pipeline is exactly what was asked for
- coordinate: needs a plan first — the output crosses a specialist boundary, or takes many steps, or two of {two or more domains, independent sub-questions, open-ended research}
- clarify: a GOAL or required INPUT is missing and no sensible default exists. Never for a request that is merely broad.

missing — the unstated goal/input slots, if any.
query_en — the request restated in English in one sentence; empty string when it is already English.
language — en, de, or other.
confidence — 0 to 1, how sure you are of mode and domain.`;

export interface TriageInput {
  userMessage: string;
  /** Two lines of the prior turn, so a follow-up ("do that for the other one") is labelled
   *  against what it refers to. Structural: present whenever a prior assistant turn exists. */
  priorTurnDigest?: string;
}

/** Longest user text sent to the classifier. Beyond this the tail dominates the call and the
 *  extra text adds nothing: the labels are about what is being ASKED, not about the detail. */
const MAX_MESSAGE_CHARS = 1200;
const MAX_DIGEST_CHARS = 400;

export function buildTriageMessages(input: TriageInput): LLMMessage[] {
  const message = input.userMessage.trim().slice(0, MAX_MESSAGE_CHARS);
  const digest = input.priorTurnDigest?.trim().slice(0, MAX_DIGEST_CHARS);
  const tail = digest
    ? `Previous turn (for reference only — label the NEW request):\n${digest}\n\nNew request:\n${message}`
    : `Request:\n${message}`;
  return [
    { role: "system", content: TRIAGE_SYSTEM_PROMPT },
    { role: "user", content: tail },
  ];
}

const MODES = new Set(["converse", "GATHER", "PRODUCE", "ACT", "VERIFY", "ORCHESTRATE"]);
const DOMAINS = new Set([
  "research", "software", "authoring", "data", "media",
  "device_control", "comms", "infra_ops", "security", "swarm_meta",
]);
const DELIVERABLES = new Set([
  "evidence", "prose_doc", "deck", "website", "code", "running_app", "chart",
  "diagram", "image", "data_table", "plan", "verdict", "message", "config_change", "none",
]);
const DECISIONS = new Set(["answer_direct", "single_agent", "workflow", "coordinate", "clarify"]);

function asStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
    .slice(0, max);
}

/**
 * Parse a verdict, or return null.
 *
 * Strict on the two fields the fusion cannot work without (mode, decision) and forgiving on
 * the rest, because a partly-filled verdict still carries signal while a wrong one does not.
 * Unknown enum members are DROPPED rather than coerced: a model that invents a domain has
 * told us nothing about the real ones, and mapping its invention onto the nearest known value
 * would manufacture agreement out of a failure.
 */
export function parseTriageVerdict(raw: string | undefined | null): TriageVerdict | null {
  if (!raw) return null;
  const text = raw.trim();
  if (!text) return null;
  // Tolerate a fenced block or leading prose around the object; a model that wraps its JSON
  // has still answered. Anything with no object at all is a failed call.
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;

  const mode = typeof record["mode"] === "string" && MODES.has(record["mode"]) ? record["mode"] : null;
  const decision = typeof record["decision"] === "string" && DECISIONS.has(record["decision"]) ? record["decision"] : null;
  if (!mode || !decision) return null;

  // Filter THEN slice: slicing first let two invented labels ahead of a real one erase the
  // domain entirely, and a verdict with no domain silently loses every domain-dependent
  // signal downstream while still looking like a successful classification.
  const domain = asStringArray(record["domain"], 8).filter((value) => DOMAINS.has(value)).slice(0, 2);
  const deliverableRaw = record["deliverable"];
  const deliverable = typeof deliverableRaw === "string" && DELIVERABLES.has(deliverableRaw) ? deliverableRaw : "none";
  const languageRaw = record["language"];
  const language = languageRaw === "de" || languageRaw === "other" ? languageRaw : "en";
  const confidenceRaw = record["confidence"];
  const confidence = typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0.5;

  const parts = asStringArray(record["parts"], 3);
  return {
    mode: mode as TriageVerdict["mode"],
    domain: domain as TriageVerdict["domain"],
    deliverable: deliverable as TriageVerdict["deliverable"],
    // `multi` is only meaningful with parts to point at: a bare boolean would send a turn
    // to the coordinator with nothing to decompose.
    multi: record["multi"] === true && parts.length >= 2,
    parts,
    alone: record["alone"] === true,
    sourceSensitive: record["source_sensitive"] === true,
    decision: decision as TriageVerdict["decision"],
    missing: asStringArray(record["missing"], 3),
    queryEn: typeof record["query_en"] === "string" ? record["query_en"].trim().slice(0, 400) : "",
    language,
    confidence,
  };
}

/** The request-side facets the fusion scores against, derived from a verdict. */
export function verdictFacets(verdict: TriageVerdict): RequestFacets {
  return {
    mode: verdict.mode,
    domain: verdict.domain,
    ...(verdict.deliverable !== "none" ? { deliverable: verdict.deliverable } : {}),
  };
}

export interface TriageDeps {
  /** One completion on the routing tier. Injected so the module is testable without a provider. */
  complete: (messages: LLMMessage[], options: {
    maxTokens: number;
    controls: { enableThinking: boolean; reasoningEffort: "none" };
    responseFormat: { name: string; schema: Record<string, unknown>; strict?: boolean };
  }) => Promise<string>;
  /** Wall-clock bound. On expiry the turn proceeds without a verdict. */
  timeoutMs: number;
}

export interface TriageOutcome {
  verdict: TriageVerdict | null;
  /** Why there is no verdict — "no_provider" | "timeout" | "parse_failed" | "error". */
  failureReason?: string;
  attempts: number;
  elapsedMs: number;
}

/** Output ceiling. The verdict is ~60 tokens of JSON; the cap exists so a model that starts
 *  narrating cannot spend a turn's latency budget doing it. */
const TRIAGE_MAX_TOKENS = 220;

/**
 * Run the triage call with one retry, bounded by `timeoutMs`.
 *
 * The retry is for a MALFORMED reply, not for a slow one: the second attempt costs another
 * call on a shared backend, and a model that timed out once will time out again.
 */
export async function runTriage(input: TriageInput, deps: TriageDeps, now: () => number = Date.now): Promise<TriageOutcome> {
  const startedAt = now();
  const messages = buildTriageMessages(input);
  const options = {
    maxTokens: TRIAGE_MAX_TOKENS,
    // enable_thinking:false is a real off-switch on this backend, not a hint.
    controls: { enableThinking: false, reasoningEffort: "none" as const },
    responseFormat: { name: "routing_triage", schema: TRIAGE_RESPONSE_SCHEMA, strict: true },
  };

  let attempts = 0;
  let lastFailure = "parse_failed";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    attempts += 1;
    const remaining = deps.timeoutMs - (now() - startedAt);
    if (remaining <= 0) return { verdict: null, failureReason: "timeout", attempts, elapsedMs: now() - startedAt };
    let raw: string;
    try {
      raw = await Promise.race([
        deps.complete(messages, options),
        new Promise<string>((_resolve, reject) => setTimeout(() => reject(new Error("triage_timeout")), remaining)),
      ]);
    } catch (err) {
      lastFailure = err instanceof Error && err.message === "triage_timeout" ? "timeout" : "error";
      if (lastFailure === "timeout") break;
      continue;
    }
    const verdict = parseTriageVerdict(raw);
    if (verdict) return { verdict, attempts, elapsedMs: now() - startedAt };
    lastFailure = "parse_failed";
  }
  return { verdict: null, failureReason: lastFailure, attempts, elapsedMs: now() - startedAt };
}
