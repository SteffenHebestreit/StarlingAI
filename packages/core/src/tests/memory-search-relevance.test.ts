import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Memory search had no relevance floor. Every score starts at scopeWeight + recencyBoost (> 0), so
 * the `score > 0` gate kept everything: any non-empty store answered any query with its top-N
 * records, and memory_search printed them as "Found N memory entries". A record now has to match —
 * by word (word-level, both directions) or by meaning — but only when the semantic check could run:
 * without it a paraphrase shares no word with the query, so nothing is dropped and the caller is
 * told the answer is lexical only.
 */

vi.mock("../memory/graph-service.js", async () => {
  const actual = await vi.importActual<typeof import("../memory/graph-service.js")>("../memory/graph-service.js");
  return { ...actual, upsertMemoryToGraph: vi.fn(async () => undefined) };
});

/** The embedder's state for the next search: up, down, or failing on one of its two calls. */
const embedder = vi.hoisted(() => ({ up: true, queryFails: false, backfillFails: false }));

// Deterministic embeddings: one dimension per marker family, so text from the same family is
// parallel; each distinct text with no marker gets a dimension of its own, so two unrelated
// unmarked texts are orthogonal and never match "semantically" by accident (a hash bucket did
// collide: "meine kinder" landed on the same bucket as an unrelated record).
const FAMILIES = [/ferry|fähre|boat|sailing|harbour/g, /coffee|espresso|kaffee/g, /invoice|payment|rechnung/g];
const OWN_DIMENSIONS = 4096;
const ownDimension = vi.hoisted(() => new Map<string, number>());
function fakeEmbed(text: string): Float32Array {
  const t = text.toLowerCase();
  const v = new Float32Array(FAMILIES.length + OWN_DIMENSIONS);
  FAMILIES.forEach((re, i) => { v[i] = t.match(re)?.length ?? 0; });
  // The measured pair (tests/embedding-query-asymmetry.test.ts): wrapped query vs bare passage, cos 0.4118.
  if (t.includes("qqalpha")) { v[FAMILIES.length] = 1; return v; }
  if (t.includes("ppbeta")) { v[FAMILIES.length] = 0.4118; v[FAMILIES.length + 1] = Math.sqrt(1 - 0.4118 ** 2); return v; }
  if (v.every((x) => x === 0)) {
    if (!ownDimension.has(t)) ownDimension.set(t, 2 + (ownDimension.size % (OWN_DIMENSIONS - 2)));
    v[FAMILIES.length + ownDimension.get(t)!] = 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}
vi.mock("../providers/embeddings.js", async () => {
  const actual = await vi.importActual<typeof import("../providers/embeddings.js")>("../providers/embeddings.js");
  return {
    ...actual,
    isEmbeddingAvailable: () => embedder.up,
    computeQueryEmbedding: vi.fn(async (text: string) => fakeEmbed(text)),
    computeRetrievalQueryEmbedding: vi.fn(async (text: string) => {
      if (embedder.queryFails) throw new Error("embedder timed out");
      return fakeEmbed(text);
    }),
    computeTextEmbeddings: vi.fn(async (texts: string[]) => {
      if (embedder.backfillFails) throw new Error("embedder returned 503");
      return texts.map(fakeEmbed);
    }),
  };
});

const { searchMemoryRecords, searchMemoryRecordsWithStatus, promoteMemoryRecords, storeWorkspaceMemoryRecord, storeUserMemoryRecord, _clearDurableMemoryCaches } = await import("../memory/service.js");
const { appendOutcome } = await import("../agent/outcomes.js");
const { writeSharedFact, resetSharedMemoryForTests } = await import("../swarm/memory.js");

const dirs: string[] = [];
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "mem-relevance-"));
  dirs.push(dir);
  return dir;
}
// User-scope records go to a temp store, never the real ~/.starlingai.
let userMemoryDir: string;
const previousUserMemoryPath = process.env["SAI_USER_MEMORY_PATH"];
beforeAll(() => {
  userMemoryDir = mkdtempSync(join(tmpdir(), "mem-relevance-user-"));
  process.env["SAI_USER_MEMORY_PATH"] = userMemoryDir;
});
afterAll(() => {
  if (previousUserMemoryPath === undefined) delete process.env["SAI_USER_MEMORY_PATH"];
  else process.env["SAI_USER_MEMORY_PATH"] = previousUserMemoryPath;
  rmSync(userMemoryDir, { recursive: true, force: true });
});
beforeEach(() => {
  embedder.up = true;
  embedder.queryFails = false;
  embedder.backfillFails = false;
});
afterEach(async () => {
  await resetSharedMemoryForTests();
  _clearDurableMemoryCaches();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  rmSync(userMemoryDir, { recursive: true, force: true });
});

describe("memory search requires a match when the semantic check runs", () => {
  it("returns nothing for a query no record matches, by word or by meaning", async () => {
    const ws = workspace();
    storeWorkspaceMemoryRecord(ws, { key: "coffee", subject: "Coffee machine", content: "Descale the espresso machine monthly.", kind: "note" });
    storeWorkspaceMemoryRecord(ws, { key: "invoices", subject: "Invoice run", content: "Payments go out on the 3rd.", kind: "decision" });

    const result = await searchMemoryRecordsWithStatus(ws, "harbour opening hours", { scopes: ["workspace"] });
    expect(result.semanticRan).toBe(true);
    expect(result.records.map((r) => r.key)).toEqual([]);
  });

  it("does not count a stopword as a match", async () => {
    const ws = workspace();
    storeWorkspaceMemoryRecord(ws, { key: "kaffee", subject: "Kaffeemaschine", content: "Das Modell der Kaffeemaschine ist wichtig.", kind: "note" });
    storeWorkspaceMemoryRecord(ws, { key: "protokoll", subject: "Berichtsprotokoll", content: "Das Protokoll geht an das Team.", kind: "decision" });

    const hits = await searchMemoryRecords(ws, "das protokoll", { scopes: ["workspace"] });
    expect(hits.map((r) => r.key)).toEqual(["protokoll"]);
  });

  it("keeps a paraphrase that matches only by meaning", async () => {
    const ws = workspace();
    storeWorkspaceMemoryRecord(ws, { key: "sailing", subject: "Sailing schedule", content: "The island sailing leaves at 07:40.", kind: "fact" });
    storeWorkspaceMemoryRecord(ws, { key: "coffee", subject: "Coffee machine", content: "Descale the espresso machine monthly.", kind: "note" });

    const hits = await searchMemoryRecords(ws, "Wann fährt die Fähre ab", { scopes: ["workspace"] });
    expect(hits.map((r) => r.key)).toEqual(["sailing"]);
  });

  it("keeps a passage at the repo's measured cosine for a near-verbatim relevant pair (0.4118)", async () => {
    const ws = workspace();
    storeWorkspaceMemoryRecord(ws, { key: "anchor", subject: "Ppbeta", content: "Ppbeta passage.", kind: "fact" });

    const hits = await searchMemoryRecords(ws, "Qqalpha", { scopes: ["workspace"] });
    expect(hits.map((r) => r.key)).toEqual(["anchor"]);
  });

  it("embeds unmatched records even when many word matches compete for the 24-text batch", async () => {
    const ws = workspace();
    const sessionId = `relevance-${Date.now()}`;
    // 30 word matches without stored vectors would fill the whole backfill on their own.
    for (let i = 0; i < 30; i++) await writeSharedFact(sessionId, `depart_${i}`, `depart note ${i}`);
    await writeSharedFact(sessionId, "island_sailing", "The island sailing leaves at 07:40.");

    const embeddings = await import("../providers/embeddings.js");
    const batch = vi.mocked(embeddings.computeTextEmbeddings);
    batch.mockClear();
    const hits = await searchMemoryRecords(ws, "when does the boat depart", { scopes: ["session"], sessionId, limit: 50 });
    expect(hits.map((r) => r.subject)).toContain("island_sailing");
    expect(batch.mock.calls.map((call) => (call[0] as string[]).length)).toEqual([24]);
  });

  it("finds a target agent's lessons however many other agents' outcomes came after them", async () => {
    const ws = workspace();
    appendOutcome(ws, {
      ts: "2026-09-01T10:00:00.000Z", agent: "idle_agent", task: "Harbour lookup", outcome: "failure", iterations: 3, totalTokens: 900,
      lesson: "Check the harbour timetable page before searching the web.",
    });
    for (let i = 0; i < 70; i++) {
      appendOutcome(ws, {
        ts: `2026-09-02T10:${String(i % 60).padStart(2, "0")}:00.000Z`, agent: "busy_agent", task: `Task ${i}`, outcome: "success",
        iterations: 1, totalTokens: 100, lesson: `Harbour note ${i}.`,
      });
    }

    const hits = await searchMemoryRecords(ws, "harbour timetable", { scopes: ["agent"], targetAgent: "idle_agent", kinds: ["lesson"] });
    expect(hits.map((r) => r.content)).toContain("Check the harbour timetable page before searching the web.");
  });
});

/**
 * The word gate. A one-way substring test missed inflections, compounds and key names, and counted
 * two-letter words inside longer ones as matches.
 */
describe("memory search matches by word, in both directions", () => {
  const keysFor = async (ws: string, query: string, opts: Record<string, unknown> = {}): Promise<string[]> =>
    (await searchMemoryRecords(ws, query, { scopes: ["workspace"], ...opts })).map((r) => r.key ?? "");

  it("matches inflections, compound parts, key names and the kind", async () => {
    const ws = workspace();
    storeWorkspaceMemoryRecord(ws, { key: "q4_due", subject: "Deadline", content: "Release candidate on 12 December.", kind: "decision" });
    storeWorkspaceMemoryRecord(ws, { key: "ruege", subject: "Mängelrüge", content: "Versendet am 3. März.", kind: "fact" });
    storeWorkspaceMemoryRecord(ws, { key: "alpha", subject: "Projekt Alpha / Status", content: "Grün, im Plan.", kind: "note" });
    storeWorkspaceMemoryRecord(ws, { key: "family", subject: "Kind", content: "Eins, geht zur Schule.", kind: "fact" });
    storeWorkspaceMemoryRecord(ws, { key: "dark_mode", subject: "Appearance", content: "Dark everywhere.", kind: "preference" });
    storeWorkspaceMemoryRecord(ws, { key: "vendor_contact", subject: "Supplier", content: "Call Ana on Mondays.", kind: "fact" });
    storeWorkspaceMemoryRecord(ws, { key: "team_kim_phone", subject: "Phone", content: "0170 555 1234.", kind: "fact" });
    storeWorkspaceMemoryRecord(ws, { key: "account", subject: "Benutzerkonto", content: "Gesperrt seit Montag.", kind: "fact" });
    storeWorkspaceMemoryRecord(ws, { key: "cjk_note", subject: "浴室のレイアウト", content: "浴室のレイアウトについて何度も伝えました。", kind: "fact" });

    expect(await keysFor(ws, "deadlines")).toEqual(["q4_due"]);
    expect(await keysFor(ws, "Mängelrügen")).toEqual(["ruege"]);
    expect(await keysFor(ws, "Projektstatus")).toEqual(["alpha"]);
    expect(await keysFor(ws, "meine Kinder")).toEqual(["family"]);
    expect(await keysFor(ws, "preferences", { kinds: ["preference"] })).toEqual(["dark_mode"]);
    expect(await keysFor(ws, "vendor contact")).toEqual(["vendor_contact"]);
    expect(await keysFor(ws, "kim")).toEqual(["team_kim_phone"]);   // a short key part, "_" as a separator
    expect(await keysFor(ws, "Nutzer")).toEqual(["account"]);        // a part inside a compound
    expect(await keysFor(ws, "浴室")).toEqual(["cjk_note"]);          // a script without spaces
  });

  it("does not count a short word inside a longer one", async () => {
    const ws = workspace();
    storeWorkspaceMemoryRecord(ws, { key: "golive", subject: "Go-Live", content: "Projekt Go-Live im November.", kind: "decision" });
    storeWorkspaceMemoryRecord(ws, { key: "theme", subject: "UI theme", content: "Dark UI theme everywhere.", kind: "preference" });

    expect(await keysFor(ws, "wann ist der Nutzer im Urlaub")).toEqual([]);
    expect(await keysFor(ws, "What do you know about me?")).toEqual([]);
  });
});

describe("memory search without the semantic check", () => {
  const sailing = { key: "sailing", subject: "Island ferry", content: "The island sailing leaves at 07:40.", kind: "fact" as const };

  for (const [label, setUp] of [
    ["no embedder", () => { embedder.up = false; }],
    ["the query embedding fails", () => { embedder.queryFails = true; }],
  ] as const) {
    it(`applies no floor and says so when ${label}`, async () => {
      const ws = workspace();
      storeWorkspaceMemoryRecord(ws, { ...sailing });
      setUp();

      const result = await searchMemoryRecordsWithStatus(ws, "Wann fährt die Fähre ab", { scopes: ["workspace"] });
      expect(result.semanticRan).toBe(false);
      expect(result.records.map((r) => r.key)).toEqual(["sailing"]);
      expect(result.unmatchedIds).toEqual([result.records[0]!.id]);
    });
  }

  it("applies no floor when the embedding backfill fails", async () => {
    const ws = workspace();
    const sessionId = `relevance-backfill-${Date.now()}`;
    await writeSharedFact(sessionId, "island_ferry", "The island sailing leaves at 07:40.");
    embedder.backfillFails = true;

    const result = await searchMemoryRecordsWithStatus(ws, "Wann fährt die Fähre ab", { scopes: ["session"], sessionId });
    expect(result.semanticRan).toBe(false);
    expect(result.records.map((r) => r.subject)).toEqual(["island_ferry"]);
  });

  it("ranks word matches before unmatched records", async () => {
    const ws = workspace();
    const sessionId = `relevance-rank-${Date.now()}`;
    // A session fact's scope weight (0.45) beats a workspace record with one content-word match
    // (0.30 + 0.14): ranked by score alone, the unrelated fact came first.
    await writeSharedFact(sessionId, "lunch", "Pasta on Fridays.");
    storeWorkspaceMemoryRecord(ws, { key: "ferry", subject: "Timetable", content: "The ferry leaves at 07:40.", kind: "fact" });
    embedder.up = false;

    const result = await searchMemoryRecordsWithStatus(ws, "ferry departure", { scopes: ["workspace", "session"], sessionId });
    expect(result.records.map((r) => r.subject)).toEqual(["Timetable", "lunch"]);
  });

  it("never promotes a record that matched neither by word nor by meaning", async () => {
    const ws = workspace();
    const sessionId = `relevance-promote-${Date.now()}`;
    await writeSharedFact(sessionId, "lunch", "Pasta on Fridays.");
    embedder.up = false;

    const result = await promoteMemoryRecords(ws, "ferry departure", { sessionId, scopes: ["session"] });
    expect(result.promoted.length + result.merged.length).toBe(0);
  });

  it("memory_search says lexical only and marks what did not match", async () => {
    const ws = workspace();
    storeWorkspaceMemoryRecord(ws, { ...sailing });
    embedder.up = false;
    await import("../tools/memory.js");
    const { getTool } = await import("../tools/registry.js");

    const r = await getTool("memory_search")!.execute({ query: "Wann fährt die Fähre ab", scopes: ["workspace"] }, { sessionId: "s-lexical", workspacePath: ws });
    expect(r.success).toBe(true);
    expect(r.output).toContain("Lexical only — semantic search unavailable");
    expect(r.output).toContain("not evidence that nothing is stored");
    expect(r.output).toContain("**[workspace/fact] Island ferry** (no word match)");
    expect(r.metadata?.["semanticRan"]).toBe(false);
  });
});

describe("the user-profile prefetch does not claim an empty profile it did not establish", () => {
  it("says the user has stored records when none matched the question", async () => {
    const ws = workspace();
    storeUserMemoryRecord(ws, { key: "appearance", subject: "Appearance", content: "Prefers dark mode.", kind: "preference" });
    const { buildUserProfileEvidence } = await import("../agent/user-profile-prefetch.js");

    const evidence = await buildUserProfileEvidence(ws, "Was weißt du über mich?", "s-profile");
    expect(evidence).not.toMatch(/found NOTHING/);
    expect(evidence).toContain("The user DOES have 1 stored memory record(s)");
    expect(evidence).toContain("do NOT tell the user you have no stored information");
  });
});
