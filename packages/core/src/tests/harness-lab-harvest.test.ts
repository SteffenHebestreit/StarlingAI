import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acceptInboxTask,
  ANONYMIZER_SYSTEM,
  commonVocabulary,
  draftToTask,
  harvestable,
  harvestFailures,
  knownDigests,
  leakScreen,
  listInbox,
  parseDraft,
  rejectInboxTask,
  servicesNeeded,
  turnDigest,
  turnMessages,
  turnPath,
  writeInboxTask,
  type HarvestStores,
  type HistoryMessage,
  type ScorecardRow,
} from "../harness-lab/harvest.js";
import { loadCorpus } from "../harness-lab/task-schema.js";

/**
 * Lab tasks from the turns that failed live: what is harvested, what the screen refuses, and that
 * nothing of an original turn leaves the process except to the local anonymizer.
 * Every name and figure here is invented.
 */

const failure = (over: Partial<ScorecardRow> = {}, data: Record<string, unknown> = {}): ScorecardRow => ({
  timestamp: "2026-10-21T09:00:05.000Z",
  sessionId: "s-live-1",
  userId: "oidc-a1b2c3",
  channel: "web",
  data: { learningOutcome: "failure", learningBasis: "qa_failed", delegationCount: 1, artifactCount: 0, ...data },
  ...over,
});

const ORIGINAL = "Schreib mir bitte eine Zusammenfassung der Quartalszahlen für die Brauerei Kranichstein, Umsatz 48210 Euro, und schick sie an kontakt@kranichstein-brau.de.";

describe("harvestable", () => {
  it("takes a live failure and names its basis", () => {
    expect(harvestable(failure())).toEqual({ ok: true, basis: "qa_failed" });
    expect(harvestable(failure({}, { learningBasis: "timeout" }))).toEqual({ ok: true, basis: "timeout" });
  });

  it.each([
    ["a success", failure({}, { learningOutcome: "success" }), "not a failure"],
    ["an eval turn", failure({ channel: "eval" }), "test channel eval"],
    ["a scene turn", failure({ channel: "scene" }), "test channel scene"],
    ["an e2e account", failure({ userId: "eval-19e81d52" }), "test principal"],
    ["a lab principal", failure({ userId: "harness-lab:run-1" }), "test principal"],
    ["a thrown turn", failure({}, { learningBasis: "error" }), "basis error (infrastructure)"],
  ])("leaves out %s", (_label, row, reason) => {
    expect(harvestable(row)).toEqual({ ok: false, reason });
  });

  it("takes a thrown turn when asked to", () => {
    expect(harvestable(failure({}, { learningBasis: "error" }), true)).toEqual({ ok: true, basis: "error" });
  });
});

describe("turnMessages", () => {
  const history: HistoryMessage[] = [
    { role: "user", content: "Wie spät ist es in Lissabon?", timestamp: "2026-10-21T08:50:00.000Z" },
    { role: "assistant", content: "10:50 Uhr.", timestamp: "2026-10-21T08:50:04.000Z" },
    { role: "user", content: ORIGINAL, timestamp: "2026-10-21T09:00:00.000Z" },
    { role: "user", content: "und bitte kurz", timestamp: "2026-10-21T09:00:02.000Z", metadata: { midTurn: true } },
    { role: "assistant", content: "…", timestamp: "2026-10-21T09:00:05.000Z" },
    { role: "user", content: "Danke!", timestamp: "2026-10-21T09:05:00.000Z" },
  ];

  it("finds the message that opened the turn, not a steering message inside it nor a later turn", () => {
    expect(turnMessages(history, "2026-10-21T09:00:05.000Z")).toEqual({ message: ORIGINAL, previous: "Wie spät ist es in Lissabon?" });
  });

  it("is null when no user message precedes the scorecard", () => {
    expect(turnMessages(history, "2026-10-21T08:00:00.000Z")).toBeNull();
    expect(turnMessages([], "2026-10-21T09:00:05.000Z")).toBeNull();
  });
});

describe("turnPath and servicesNeeded", () => {
  const rows = [
    { type: "sub_agent_started", timestamp: "t", sessionId: "sub:s:content_writer:1", data: { agentName: "content_writer" } },
    { type: "sub_agent_tool_call", timestamp: "t", sessionId: "sub:s:content_writer:1", data: { tool: "generate_document", phase: "start" } },
    { type: "sub_agent_tool_call", timestamp: "t", sessionId: "sub:s:content_writer:1", data: { tool: "generate_document", phase: "done", success: false } },
    { type: "tool_call_completed", timestamp: "t", sessionId: "s", data: { tool: "delegate_to_agent", success: true } },
    { type: "tool_call_failed", timestamp: "t", sessionId: "s", data: { tool: "web_search" } },
    { type: "sub_agent_started", timestamp: "t", sessionId: "s", data: { agentName: "<script>" } },
  ];

  it("lists the agents and tools the turn ran, and the tools that failed", () => {
    expect(turnPath(rows)).toEqual({
      agents: ["content_writer"],
      tools: ["delegate_to_agent", "generate_document", "web_search"],
      failedTools: ["generate_document", "web_search"],
    });
  });

  it("names the services the lab does not run", () => {
    expect(servicesNeeded({ agents: ["browser_agent"], tools: ["browser_navigate"] })).toEqual(["browser"]);
    expect(servicesNeeded({ agents: ["mail_agent"], tools: ["generate_image"] })).toEqual(["image", "mail"]);
    expect(servicesNeeded({ agents: ["diagram_designer", "coder"], tools: ["generate_mermaid_diagram", "run_code"] })).toEqual([]);
  });
});

describe("parseDraft", () => {
  const good = { title: "Quarterly summary for a brewery", message: "Fasse die Quartalszahlen der Brauerei Sonnenhang zusammen.", deliverable: { kind: "file", shape: "A one-page summary as a PDF." }, domain: "Reports", tags: ["Summary", "pdf", "x", "summary"] };

  it("reads a draft, normalizing its domain and tags", () => {
    expect(parseDraft(JSON.stringify(good))).toEqual({ draft: { ...good, domain: "reports", tags: ["summary", "pdf"] } });
  });

  it("passes on a decline", () => {
    expect(parseDraft('{"skip": "it is about the person\'s own bank account"}')).toEqual({ skip: "it is about the person's own bank account" });
  });

  it.each([
    ["no JSON", "I cannot do that."],
    ["no title", JSON.stringify({ ...good, title: "" })],
    ["a short message", JSON.stringify({ ...good, message: "hi" })],
    ["an unknown kind", JSON.stringify({ ...good, deliverable: { kind: "poem" } })],
  ])("refuses %s", (_label, content) => {
    expect(parseDraft(content)).toHaveProperty("malformed");
  });
});

describe("leakScreen", () => {
  const none = new Set<string>();

  it("passes a draft that invented everything", () => {
    expect(leakScreen("Fasse die Quartalszahlen der Brauerei Sonnenhang zusammen, Umsatz 31 950 Euro; Rückfragen an buero@example.com, Details auf https://sonnenhang.example/zahlen.", ORIGINAL, none).hard).toEqual([]);
  });

  it.each([
    ["a real e-mail address", "Schick es an info@sonnenhang-brau.de.", "an e-mail address outside example.com"],
    ["a real web address", "Siehe https://www.sonnenhang-brau.de/zahlen.", "a web address outside the reserved example hosts"],
    ["a phone number", "Ruf an unter 0761 4482 9917.", "a phone number"],
    ["an IBAN", "Überweise auf DE89 3704 0044 0532 0130 00.", "an IBAN"],
    ["a figure of the original", "Der Umsatz lag bei 48210 Euro.", "a figure from the original"],
    ["six words of the original in a row, a rare one among them", "Schreib mir bitte eine Zusammenfassung der Zahlen.", "a run of 6 words from the original, with a rare one"],
  ])("refuses %s", (_label, derived, finding) => {
    expect(leakScreen(derived, ORIGINAL, none).hard).toContain(finding);
  });

  it("lets a copied stock opening through when every word of it is common", () => {
    const common = commonVocabulary(["Schreib mir bitte eine Zusammenfassung der Notizen."]);
    expect(leakScreen("Schreib mir bitte eine Zusammenfassung der Zahlen für die Mühle Talgrund.", ORIGINAL, common).hard).toEqual([]);
  });

  it("lets small numbers and five words in a row through", () => {
    expect(leakScreen("Schreib mir bitte eine kurze Übersicht in 3 Punkten.", ORIGINAL, none).hard).toEqual([]);
  });

  it("lists the original's rarer words it shares, but not the common ones", () => {
    const common = commonVocabulary(["Erstelle eine Zusammenfassung der wichtigsten Punkte."]);
    const screen = leakScreen("Fasse die Quartalszahlen der Brauerei Kranichstein als Zusammenfassung zusammen.", ORIGINAL, common);
    expect(screen.hard).toEqual([]);
    expect(screen.shared).toEqual(["brauerei", "kranichstein", "quartalszahlen"]);
  });
});

describe("draftToTask", () => {
  const draft = { title: "Brewery summary", message: "Fasse die Zahlen der Brauerei Sonnenhang zusammen.", deliverable: { kind: "file" as const, shape: "A PDF." }, domain: "reports", tags: ["pdf"] };
  const digest = turnDigest("s-live-1", "2026-10-21T09:00:05.000Z");

  it("is an unreviewed failure-derived task, its source a digest, its checks only what the deliverable makes certain", () => {
    const task = draftToTask(draft, { digest, basis: "qa_failed" });
    expect(task).toMatchObject({
      id: `fd.qa-failed.${digest.slice(0, 8)}`,
      origin: "failure-derived",
      source: `turn:${digest.slice(0, 16)}`,
      tags: ["pdf", "failure-derived"],
      turns: [{ message: draft.message, expect: { artifacts: { minCount: 1 } } }],
    });
    expect(task.reviewed).toBeUndefined();
    expect(task.source).not.toContain("s-live-1");
    expect(draftToTask({ ...draft, deliverable: { kind: "site", shape: "" } }, { digest, basis: "x" }).turns[0]!.expect).toEqual({ artifacts: { minCount: 1, pathMatches: ["\\.html?$"] } });
    expect(draftToTask({ ...draft, deliverable: { kind: "answer", shape: "" } }, { digest, basis: "x" }).turns[0]!.expect).toBeUndefined();
  });
});

describe("harvestFailures", () => {
  const sessions: Record<string, HistoryMessage[]> = {
    "s-live-1": [{ role: "user", content: ORIGINAL, timestamp: "2026-10-21T09:00:00.000Z" }],
    "s-live-2": [{ role: "user", content: "Öffne die Seite der Gemeinde Talheim und lies mir die Öffnungszeiten vor.", timestamp: "2026-10-21T10:00:00.000Z" }],
    "s-live-3": [{ role: "user", content: "Erstelle eine Preisliste für das Café Mondschein als Tabelle.", timestamp: "2026-10-21T11:00:00.000Z" }],
  };
  const rows: ScorecardRow[] = [
    failure({ sessionId: "s-live-1", timestamp: "2026-10-21T09:00:05.000Z" }),
    failure({ sessionId: "s-live-2", timestamp: "2026-10-21T10:00:05.000Z" }),
    failure({ sessionId: "s-live-3", timestamp: "2026-10-21T11:00:05.000Z" }, { learningBasis: "artifact_verification_failed" }),
    failure({ sessionId: "s-gone", timestamp: "2026-10-21T12:00:05.000Z" }),
    failure({ sessionId: "s-eval", channel: "eval" }),
  ];
  const stores: HarvestStores = {
    failedScorecards: async () => rows,
    turnStart: async (sessionId) => `2026-10-21T${{ "s-live-1": "09", "s-live-2": "10", "s-live-3": "11" }[sessionId] ?? "12"}:00:00.000Z`,
    turnEvents: async (sessionId) => sessionId === "s-live-2"
      ? [{ type: "sub_agent_started", timestamp: "t", sessionId: "sub:s-live-2:browser_agent:1", data: { agentName: "browser_agent" } }]
      : [{ type: "sub_agent_started", timestamp: "t", sessionId: `sub:${sessionId}:content_writer:1`, data: { agentName: "content_writer" } }],
    sessionHistory: async (sessionId) => sessions[sessionId] ?? null,
  };
  const inputs: string[] = [];
  const complete = async (role: string, system: string, user: string) => {
    expect(role).toBe("anonymizer");
    expect(system).toBe(ANONYMIZER_SYSTEM);
    inputs.push(user);
    if (user.includes("Kranichstein")) {
      return JSON.stringify({ title: "Brewery figures", message: "Fasse die Quartalszahlen der Brauerei Sonnenhang zusammen und schick sie an buero@example.com.", deliverable: { kind: "file", shape: "A summary." }, domain: "reports", tags: ["summary"] });
    }
    // The café draft kept a real-looking address: the screen must refuse it.
    return JSON.stringify({ title: "Price list", message: "Bitte eine Preisliste für das Café Sternschnuppe, Kontakt info@sternschnuppe-cafe.de.", deliverable: { kind: "file", shape: "A table." }, domain: "food", tags: [] });
  };

  beforeEach(() => { inputs.length = 0; });

  it("derives a screened task from each harvestable turn, and says why it left out the rest", async () => {
    const result = await harvestFailures(stores, { sinceIso: "2026-10-01T00:00:00.000Z", limit: 5, known: new Set(), commonWords: new Set(), complete });
    expect(result.derived.map((d) => d.task.title)).toEqual(["Brewery figures"]);
    expect(result.derived[0]!.task.turns[0]!.message).toContain("Sonnenhang");
    expect(result.skipped.map((s) => s.reason)).toEqual([
      "needs browser, which the lab does not run",
      "refused by the leak screen: carries an e-mail address outside example.com",
      "session no longer stored",
      "test channel eval",
    ]);
    // The anonymizer saw the original, with what the turn ran and why it failed...
    expect(inputs[0]).toContain(ORIGINAL);
    expect(inputs[0]).toContain("agents content_writer");
    expect(inputs[0]).toContain("qa_failed");
    // ...and nothing of an original turn is in what the harvest hands back.
    const handedBack = JSON.stringify(result);
    for (const original of ["Kranichstein", "48210", "kranichstein-brau", "Talheim", "Mondschein", "sternschnuppe-cafe", "s-live-1"]) {
      expect(handedBack).not.toContain(original);
    }
  });

  it("skips a turn it harvested before, and stops at the limit", async () => {
    const known = new Set([turnDigest("s-live-1", "2026-10-21T09:00:05.000Z").slice(0, 16)]);
    const again = await harvestFailures(stores, { sinceIso: "2026-10-01T00:00:00.000Z", limit: 5, known, commonWords: new Set(), complete });
    expect(again.derived).toEqual([]);
    expect(again.skipped[0]).toEqual({ basis: "qa_failed", reason: "already harvested" });
    const one = await harvestFailures(stores, { sinceIso: "2026-10-01T00:00:00.000Z", limit: 1, known: new Set(), commonWords: new Set(), complete });
    expect(one.scanned).toBe(1);
  });
});

describe("the inbox", () => {
  let root = "";
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "sai-harvest-inbox-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const entry = () => {
    const digest = turnDigest("s-live-1", "2026-10-21T09:00:05.000Z");
    const task = draftToTask({ title: "Brewery figures", message: "Fasse die Zahlen der Brauerei Sonnenhang zusammen.", deliverable: { kind: "file", shape: "A summary." }, domain: "reports", tags: [] }, { digest, basis: "qa_failed" });
    return { task, shared: ["brauerei"], basis: "qa_failed", digest };
  };

  it("holds a task the lab does not run until it is accepted, then moves it into the corpus as reviewed", () => {
    const inbox = join(root, "inbox");
    const tasks = join(root, "tasks");
    const { task, shared, basis } = entry();
    writeInboxTask(inbox, { task, shared, basis }, "2026-10-21T13:00:00.000Z");
    // In the inbox, and even if the inbox were the corpus, an unreviewed failure-derived task does not run.
    expect(loadCorpus(inbox).tasks).toEqual([]);
    const [listed] = listInbox(inbox);
    expect(listed).toMatchObject({ id: task.id, title: "Brewery figures" });
    expect(listed!.notes.join("\n")).toContain('"brauerei"');

    acceptInboxTask(inbox, tasks, task.id, "reviewer", "2026-10-21T14:00:00.000Z");
    expect(existsSync(listed!.file)).toBe(false);
    const corpus = loadCorpus(tasks);
    expect(corpus.tasks.map((t) => t.id)).toEqual([task.id]);
    expect(corpus.tasks[0]!.reviewed).toEqual({ by: "reviewer", at: "2026-10-21T14:00:00.000Z" });
    expect(knownDigests([inbox, tasks]).has(task.source!.slice("turn:".length))).toBe(true);
  });

  it("drops a rejected task and remembers its turn", () => {
    const inbox = join(root, "inbox");
    const { task, shared, basis } = entry();
    writeInboxTask(inbox, { task, shared, basis }, "2026-10-21T13:00:00.000Z");
    rejectInboxTask(inbox, task.id);
    expect(listInbox(inbox)).toEqual([]);
    expect(readFileSync(join(inbox, "rejected.txt"), "utf8").trim()).toBe(task.source!.slice("turn:".length));
    expect(knownDigests([inbox]).has(task.source!.slice("turn:".length))).toBe(true);
  });

  it("refuses an id that is not one, or not in the inbox", () => {
    expect(() => rejectInboxTask(join(root, "inbox"), "../tasks/x")).toThrow(/not a task id/);
    expect(() => acceptInboxTask(join(root, "inbox"), join(root, "tasks"), "fd.none.00000000", "r")).toThrow(/no task/);
  });
});
