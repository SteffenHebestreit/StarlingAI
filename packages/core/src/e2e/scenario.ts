/**
 * END-TO-END SCENARIO CONTRACT — the format of eval/e2e/scenarios/**\/*.jsonc.
 *
 * A scenario drives REAL turns through the running gateway (WebSocket chat.send, the same path the
 * dashboard uses) as a dedicated local eval account, and judges what happened from three sources:
 *   1. the turn's final status and reply text,
 *   2. the audit events of the scenario's own sessions (the operator's audit stream carries every
 *      event of a session it owns, sub-agent runs included — gateway/rpc.ts mayWatchAuditEvent),
 *   3. HTTP API answers and test-environment state (mailbox, served fixtures).
 *
 * Every attempt runs in fresh sessions; a scenario repeated k times reports pass^k.
 * Data is synthetic: no scenario may carry personal data, real credentials or real mail addresses.
 */
import { z } from "zod";

/** A value an event field must have: exact, or one comparison. */
const FieldMatcher = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.object({ regex: z.string() }).strict(),
  z.object({ gte: z.number() }).strict(),
  z.object({ lte: z.number() }).strict(),
  z.object({ in: z.array(z.union([z.string(), z.number(), z.boolean()])) }).strict(),
  z.object({ exists: z.boolean() }).strict(),
]);

/**
 * Selects audit events. `type` is the audit event type (audit/schema.ts). `where` maps a dotted path
 * into the event (e.g. "data.agentName", "data.tool", "sessionId") to a matcher.
 */
export const EventMatcherSchema = z.object({
  type: z.string().min(1),
  where: z.record(z.string(), FieldMatcher).optional(),
}).strict();

/** An event that must occur between `min` (default 1) and `max` times. */
const EventExpectationSchema = EventMatcherSchema.extend({
  min: z.number().int().nonnegative().optional(),
  max: z.number().int().nonnegative().optional(),
}).strict();

const ReplyExpectationSchema = z.object({
  /** Every string must appear (case-insensitive). */
  includes: z.array(z.string()).optional(),
  /** At least one of these must appear (case-insensitive). */
  includesAny: z.array(z.string()).optional(),
  /** None may appear (case-insensitive). */
  excludes: z.array(z.string()).optional(),
  /** Every regular expression (JS syntax, flags "i") must match. */
  matches: z.array(z.string()).optional(),
  /** The reply's dominant language. */
  language: z.enum(["de", "en"]).optional(),
  minChars: z.number().int().nonnegative().optional(),
  maxChars: z.number().int().positive().optional(),
}).strict();

const TurnExpectationSchema = z.object({
  /** Final turn status as the gateway reports it. Default "ok". */
  status: z.enum(["ok", "error", "blocked"]).optional(),
  reply: ReplyExpectationSchema.optional(),
  /** Audit events of this turn (root session and every sub-agent run under it). */
  events: z.object({
    must: z.array(EventExpectationSchema).optional(),
    mustNot: z.array(EventMatcherSchema).optional(),
  }).strict().optional(),
  /** Tool calls seen in this turn (orchestrator and sub-agents). */
  tools: z.object({
    mustCall: z.array(z.string()).optional(),
    mustNotCall: z.array(z.string()).optional(),
    /** Upper bound per tool name. */
    maxCalls: z.record(z.string(), z.number().int().nonnegative()).optional(),
  }).strict().optional(),
  /** Sub-agents started in this turn. */
  agents: z.object({
    mustRun: z.array(z.string()).optional(),
    mustRunAny: z.array(z.string()).optional(),
    mustNotRun: z.array(z.string()).optional(),
    maxRuns: z.number().int().nonnegative().optional(),
  }).strict().optional(),
  /** Files the turn delivered as artifacts. */
  artifacts: z.object({
    minCount: z.number().int().nonnegative().optional(),
    /** Each regex must match at least one artifact path. */
    pathMatches: z.array(z.string()).optional(),
  }).strict().optional(),
  /** Wall time of the turn, send to final status. */
  durationMs: z.object({ max: z.number().int().positive() }).strict().optional(),
  /**
   * LLM rubric judge over the reply (runs only when every deterministic check passed). The judge
   * scores 0-10 against `rubric`; the attempt fails below `minScore`.
   */
  judge: z.object({ rubric: z.string().min(10), minScore: z.number().min(0).max(10) }).strict().optional(),
}).strict();

/** Mid-turn interaction: when the trigger fires during the turn, do the action once. */
const DuringActionSchema = z.object({
  when: z.union([
    z.object({ event: EventMatcherSchema }).strict(),
    z.object({ afterMs: z.number().int().nonnegative() }).strict(),
  ]),
  do: z.union([
    /** Add a message to the running turn (POST /api/sessions/:id/steer). */
    z.object({ steer: z.string().min(1) }).strict(),
    /** Stop the running turn (chat.cancel). */
    z.object({ stop: z.literal(true) }).strict(),
  ]),
}).strict();

/** Identities the harness logs in as. Accounts are created by `pnpm e2e:setup`. */
export const IdentitySchema = z.enum(["eval", "eval-viewer"]);

const TurnStepSchema = z.object({
  kind: z.literal("turn"),
  id: z.string().optional(),
  /**
   * Run this turn as another identity, in that identity's own session. Lets one attempt store
   * something as eval and check, right after, that eval-viewer cannot get at it.
   */
  as: IdentitySchema.optional(),
  message: z.string().min(1),
  /** Force a specific agent (the dashboard's `--agent <name>` override). Omit to let the swarm route. */
  agent: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "max"]).optional(),
  /** Fixture files (paths under eval/e2e/fixtures/) uploaded and attached to this message. */
  attachments: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  during: z.array(DuringActionSchema).optional(),
  expect: TurnExpectationSchema.optional(),
}).strict();

const HttpStepSchema = z.object({
  kind: z.literal("http"),
  id: z.string().optional(),
  as: IdentitySchema.optional(),
  method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]),
  /** Gateway path, e.g. "/api/knowledge-bases". `{sessionId}` is replaced with the scenario identity's current session. */
  path: z.string().startsWith("/"),
  body: z.unknown().optional(),
  expect: z.object({
    status: z.union([z.number().int(), z.array(z.number().int())]).optional(),
    bodyIncludes: z.array(z.string()).optional(),
  }).strict().optional(),
}).strict();

const WaitStepSchema = z.object({ kind: z.literal("wait"), ms: z.number().int().positive() }).strict();

/** Later turns run in a fresh session of their identity (cross-session behaviour, e.g. memory). */
const NewSessionStepSchema = z.object({ kind: z.literal("newSession") }).strict();

/** Test-environment mailbox (GreenMail): put a message into the eval inbox, or check what arrived. */
const MailStepSchema = z.object({
  kind: z.literal("mail"),
  action: z.enum(["deliver", "expect", "clear"]),
  /** deliver: the synthetic message. */
  message: z.object({
    from: z.string(),
    subject: z.string(),
    text: z.string(),
  }).strict().optional(),
  /** expect: a message to the given recipient whose subject/body match. */
  match: z.object({
    to: z.string().optional(),
    subjectIncludes: z.array(z.string()).optional(),
    bodyIncludes: z.array(z.string()).optional(),
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().nonnegative().optional(),
  }).strict().optional(),
}).strict();

export const StepSchema = z.discriminatedUnion("kind", [
  TurnStepSchema,
  HttpStepSchema,
  WaitStepSchema,
  NewSessionStepSchema,
  MailStepSchema,
]);

/** Services a scenario needs; the runner skips (not fails) a scenario whose service is down. */
export const ServiceSchema = z.enum([
  "gateway", "model", "embeddings", "web-search", "browser", "sandbox", "engram", "image",
  "mail", "e2e-site", "computer-desktop", "laya", "speech",
]);

export const ScenarioSchema = z.object({
  /** Unique, kebab-case; also the report key. */
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(3),
  /** Feature group: new | guards | core | api | <family>. */
  group: z.string().min(1),
  tags: z.array(z.string()).optional(),
  /** What the scenario protects, and why — a regression it was written for, if any. */
  description: z.string().optional(),
  requires: z.array(ServiceSchema).optional(),
  identity: IdentitySchema.optional(),
  /** Whole-attempt ceiling; default 15 minutes. */
  timeoutMs: z.number().int().positive().optional(),
  /** Overrides the CLI --repeat for this scenario. */
  repeat: z.number().int().positive().optional(),
  steps: z.array(StepSchema).min(1),
}).strict();

export type E2EScenario = z.infer<typeof ScenarioSchema>;
export type E2EStep = z.infer<typeof StepSchema>;
export type E2ETurnStep = z.infer<typeof TurnStepSchema>;
export type E2EHttpStep = z.infer<typeof HttpStepSchema>;
export type E2EMailStep = z.infer<typeof MailStepSchema>;
export type E2ETurnExpectation = z.infer<typeof TurnExpectationSchema>;
export type E2EEventMatcher = z.infer<typeof EventMatcherSchema>;
export type E2EIdentity = z.infer<typeof IdentitySchema>;
export type E2EService = z.infer<typeof ServiceSchema>;
