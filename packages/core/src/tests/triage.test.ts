/**
 * Facet triage — prompt shape, parser contract, and call behaviour.
 *
 * The parser is where a routing regression hides quietly: a lenient parser manufactures a
 * confident verdict out of a malformed reply, and every bonus downstream then scales a
 * fiction. So the tests below are mostly about what the parser REFUSES.
 */
import { describe, expect, it, vi } from "vitest";
import {
  TRIAGE_PROMPT_VERSION,
  TRIAGE_RESPONSE_SCHEMA,
  TRIAGE_SYSTEM_PROMPT,
  buildTriageMessages,
  parseTriageVerdict,
  runTriage,
  verdictFacets,
} from "../agent/triage.js";

const validVerdict = {
  mode: "GATHER",
  domain: ["research"],
  deliverable: "evidence",
  multi: false,
  parts: [],
  alone: true,
  source_sensitive: true,
  decision: "single_agent",
  missing: [],
  query_en: "",
  language: "en",
  confidence: 0.82,
};

describe("the frozen prefix", () => {
  it("names no catalog entry, so adding an agent never cools its cache", () => {
    // Catalog-blindness is what lets this call run in PARALLEL with the shortlist and keeps
    // the prefix stable across catalog edits. A real agent name appearing here would undo
    // both at once, silently.
    for (const name of ["researcher", "mission_coordinator", "content_writer", "web_coder", "mail_agent"]) {
      expect(TRIAGE_SYSTEM_PROMPT).not.toContain(name);
    }
  });

  it("asks for JSON only and never for reasoning", () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain("JSON only");
    expect(TRIAGE_SYSTEM_PROMPT.toLowerCase()).toContain("no reasoning");
    expect(TRIAGE_SYSTEM_PROMPT.toLowerCase()).not.toContain("step by step");
  });

  it("carries the intent-over-subject rule that the taxonomy exists for", () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain("only the topic");
  });

  it("states the coordinate criteria structurally, not by topic", () => {
    expect(TRIAGE_SYSTEM_PROMPT).toContain("crosses a specialist boundary");
    expect(TRIAGE_SYSTEM_PROMPT).toContain("two or more domains");
  });

  it("is versioned, because a shadow comparison only holds within one prompt version", () => {
    expect(TRIAGE_PROMPT_VERSION).toMatch(/^[a-z0-9-]+$/);
  });

  it("puts the whole taxonomy in the SYSTEM message and only the request in the user turn", () => {
    const messages = buildTriageMessages({ userMessage: "find me the best rate" });
    expect(messages).toHaveLength(2);
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toBe(TRIAGE_SYSTEM_PROMPT);
    expect(messages[1]!.role).toBe("user");
    expect(messages[1]!.content).toContain("find me the best rate");
  });

  it("includes a prior-turn digest as reference, clearly marked as not the thing to label", () => {
    const messages = buildTriageMessages({ userMessage: "now the other one", priorTurnDigest: "asked about the Berlin office" });
    expect(messages[1]!.content).toContain("Berlin office");
    expect(messages[1]!.content).toContain("label the NEW request");
  });

  it("bounds the dynamic tail so a pasted document cannot become the classifier's prompt", () => {
    const messages = buildTriageMessages({ userMessage: "x".repeat(10_000), priorTurnDigest: "y".repeat(5_000) });
    expect((messages[1]!.content as string).length).toBeLessThan(2_000);
  });
});

describe("parseTriageVerdict", () => {
  it("accepts a well-formed verdict", () => {
    const verdict = parseTriageVerdict(JSON.stringify(validVerdict));
    expect(verdict).toMatchObject({ mode: "GATHER", decision: "single_agent", sourceSensitive: true, confidence: 0.82 });
  });

  it("accepts JSON wrapped in a fenced block or trailing prose", () => {
    expect(parseTriageVerdict("```json\n" + JSON.stringify(validVerdict) + "\n```")).not.toBeNull();
    expect(parseTriageVerdict("Sure! " + JSON.stringify(validVerdict) + " Hope that helps.")).not.toBeNull();
  });

  it("returns null for prose — a failed call is not re-read as intent", () => {
    // On this backend a forced call answering in prose is a FAILED call. Salvaging it
    // would turn a failure into a confident-looking label.
    expect(parseTriageVerdict("This looks like a research request about pricing.")).toBeNull();
    expect(parseTriageVerdict("")).toBeNull();
    expect(parseTriageVerdict(undefined)).toBeNull();
    expect(parseTriageVerdict("{ not json }")).toBeNull();
  });

  it("returns null when mode or decision is missing or invented", () => {
    // These two are what the fusion branches on; a default would be a fabricated decision.
    expect(parseTriageVerdict(JSON.stringify({ ...validVerdict, mode: undefined }))).toBeNull();
    expect(parseTriageVerdict(JSON.stringify({ ...validVerdict, mode: "INVESTIGATE" }))).toBeNull();
    expect(parseTriageVerdict(JSON.stringify({ ...validVerdict, decision: "delegate_everything" }))).toBeNull();
  });

  it("drops an invented domain instead of snapping it to the nearest real one", () => {
    // Coercion would manufacture agreement out of a failure: the model that says
    // "devops" has told us nothing about whether it meant infra_ops.
    const verdict = parseTriageVerdict(JSON.stringify({ ...validVerdict, domain: ["devops", "research"] }));
    expect(verdict!.domain).toEqual(["research"]);
  });

  it("requires parts before it believes multi — a coordinator needs something to decompose", () => {
    expect(parseTriageVerdict(JSON.stringify({ ...validVerdict, multi: true, parts: [] }))!.multi).toBe(false);
    expect(parseTriageVerdict(JSON.stringify({ ...validVerdict, multi: true, parts: ["research it", "build it"] }))!.multi).toBe(true);
  });

  it("clamps confidence and defaults it rather than trusting a wild value", () => {
    expect(parseTriageVerdict(JSON.stringify({ ...validVerdict, confidence: 42 }))!.confidence).toBe(1);
    expect(parseTriageVerdict(JSON.stringify({ ...validVerdict, confidence: -3 }))!.confidence).toBe(0);
    expect(parseTriageVerdict(JSON.stringify({ ...validVerdict, confidence: "high" }))!.confidence).toBe(0.5);
  });

  it("treats a missing source_sensitive as FALSE, and only an explicit true as true", () => {
    // Defaulting it true would force research on every turn whose verdict was partial.
    expect(parseTriageVerdict(JSON.stringify({ ...validVerdict, source_sensitive: undefined }))!.sourceSensitive).toBe(false);
    expect(parseTriageVerdict(JSON.stringify({ ...validVerdict, source_sensitive: "yes" }))!.sourceSensitive).toBe(false);
  });

  it("constrains the schema handed to the provider to the same enums it parses", () => {
    const properties = TRIAGE_RESPONSE_SCHEMA["properties"] as Record<string, { enum?: string[] }>;
    expect(properties["mode"]!.enum).toContain("converse");
    expect(properties["decision"]!.enum).toEqual(["answer_direct", "single_agent", "workflow", "coordinate", "clarify"]);
    // The grammar must not admit a value the parser would then drop.
    expect(properties["domain"]).toBeDefined();
  });
});

describe("verdictFacets", () => {
  it("omits deliverable when nothing is produced, so it cannot score as a match", () => {
    const facets = verdictFacets(parseTriageVerdict(JSON.stringify({ ...validVerdict, deliverable: "none" }))!);
    expect(facets.deliverable).toBeUndefined();
    expect(facets.mode).toBe("GATHER");
  });
});

describe("runTriage", () => {
  const input = { userMessage: "what is the current base rate" };

  it("returns the verdict on a clean first call", async () => {
    const complete = vi.fn(async () => JSON.stringify(validVerdict));
    const outcome = await runTriage(input, { complete, timeoutMs: 5000 });
    expect(outcome.verdict?.mode).toBe("GATHER");
    expect(outcome.attempts).toBe(1);
  });

  it("sends thinking off, a small ceiling and the JSON grammar", async () => {
    const calls: unknown[][] = [];
    const complete = vi.fn(async (...args: unknown[]) => { calls.push(args); return JSON.stringify(validVerdict); });
    await runTriage(input, { complete: complete as never, timeoutMs: 5000 });
    const options = calls[0]![1] as {
      maxTokens: number;
      controls: { enableThinking: boolean; reasoningEffort: string };
      responseFormat: { name: string };
    };
    // A routing-tier call with thinking ON burned 8,000 tokens and 150 s of a 208 s turn
    // once already; this is the switch that prevents it.
    expect(options.controls).toEqual({ enableThinking: false, reasoningEffort: "none" });
    expect(options.maxTokens).toBeLessThanOrEqual(256);
    expect(options.responseFormat.name).toBe("routing_triage");
  });

  it("retries ONCE on a malformed reply, then gives up", async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce("I think this is research.")
      .mockResolvedValueOnce(JSON.stringify(validVerdict));
    const outcome = await runTriage(input, { complete, timeoutMs: 5000 });
    expect(outcome.verdict).not.toBeNull();
    expect(outcome.attempts).toBe(2);

    const alwaysProse = vi.fn(async () => "still prose");
    const failed = await runTriage(input, { complete: alwaysProse, timeoutMs: 5000 });
    expect(failed.verdict).toBeNull();
    expect(failed.failureReason).toBe("parse_failed");
    // Bounded: a classifier that cannot answer must not keep a turn waiting.
    expect(alwaysProse).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a timeout — the second call would time out too", async () => {
    const complete = vi.fn(() => new Promise<string>(() => { /* never resolves */ }));
    const outcome = await runTriage(input, { complete, timeoutMs: 20 });
    expect(outcome.verdict).toBeNull();
    expect(outcome.failureReason).toBe("timeout");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("reports an error without throwing into the turn", async () => {
    const complete = vi.fn(async () => { throw new Error("backend down"); });
    const outcome = await runTriage(input, { complete, timeoutMs: 5000 });
    expect(outcome.verdict).toBeNull();
    expect(outcome.failureReason).toBe("error");
  });
});
