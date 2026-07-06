/**
 * use_knowledge_base tool — the per-KB "worker" plumbing.
 *
 * Drives the registered tool over a real temp-workspace registry, with the
 * ephemeral runner (runEphemeralWorker) and the crawler (isCrawlActive) mocked
 * so no live model / network is needed. Asserts the tool's contract: the KB
 * retrieval tools are always granted, the default vs template tool sets are
 * chosen correctly, access is enforced (out-of-scope → not-found, no run), and
 * an empty / still-crawling KB short-circuits BEFORE spinning up a worker.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as loaderModule from "../config/loader.js";
import * as engram from "../retrieval/engram.js";
import type { ToolContext } from "../tools/registry.js";

// The runner is the seam: capture exactly what the tool asks it to run.
const runEphemeralWorkerMock = vi.hoisted(() =>
  vi.fn(async (_input: Record<string, unknown>) => ({ success: true, output: "worker did the thing", grantedTools: [] as string[], rejectedTools: [] as string[] })),
);
vi.mock("../tools/ephemeral-agent-factory.js", () => ({
  runEphemeralWorker: runEphemeralWorkerMock,
}));

// Crawler is dynamically imported by the tool only for its isCrawlActive predicate
// (stale-crawl normalization) — mock it so a "crawling" record stays crawling.
const isCrawlActiveMock = vi.hoisted(() => vi.fn(() => false));
vi.mock("../retrieval/kb-crawler.js", () => ({
  isCrawlActive: isCrawlActiveMock,
  startKbCrawl: vi.fn(async () => ({ ok: true })),
  cancelKbCrawl: vi.fn(async () => true),
  deleteKnowledgeBase: vi.fn(async () => ({ ok: true, documentsRemoved: 0, documentsFailed: 0 })),
}));

import { getTool } from "../tools/registry.js";
import "../tools/knowledge-bases.js"; // registers use_knowledge_base (+ siblings)
import { createKnowledgeBase, mutateKnowledgeBase, kbDocumentId } from "../retrieval/knowledge-bases.js";

// The tool's own always-granted / default worker tool sets (source of truth in
// tools/knowledge-bases.ts) — asserted verbatim.
const WORKER_ALWAYS_TOOLS = ["search_knowledge_base", "list_knowledge_bases"];
const WORKER_DEFAULT_TOOLS = ["search_knowledge_base", "list_knowledge_bases", "web_fetch", "browser_navigate", "browser_snapshot", "browser_axe_audit", "lighthouse_audit"];

let workspacePath: string;

beforeEach(() => {
  workspacePath = mkdtempSync(join(tmpdir(), "starlingai-kb-use-"));
  const realConfig = loaderModule.getConfig();
  vi.spyOn(loaderModule, "getConfig").mockReturnValue({
    ...realConfig,
    workspacePath,
    retrieval: {
      ...realConfig.retrieval,
      knowledgeBases: { ...realConfig.retrieval.knowledgeBases, enabled: true },
    },
  } as typeof realConfig);
  vi.spyOn(engram, "engramConfigured").mockReturnValue(true);
  isCrawlActiveMock.mockReset().mockReturnValue(false);
  runEphemeralWorkerMock.mockReset().mockResolvedValue({ success: true, output: "worker did the thing", grantedTools: [], rejectedTools: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(workspacePath, { recursive: true, force: true });
});

function useTool() {
  const h = getTool("use_knowledge_base");
  if (!h) throw new Error("use_knowledge_base not registered");
  return h;
}

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { sessionId: "kb-use-sess", workspacePath, ...over } as ToolContext;
}

/** Create a KB and mark it ready with one indexed page so use_knowledge_base runs. */
async function readyKb(input: Parameters<typeof createKnowledgeBase>[0]): Promise<string> {
  const res = await createKnowledgeBase(input);
  if (!res.ok) throw new Error(res.error);
  const now = new Date().toISOString();
  await mutateKnowledgeBase(res.value.id, (r) => {
    r.status = "ready";
    const url = "https://example.com/p";
    r.pages[url] = { documentId: kbDocumentId(r.id, url), url, contentHash: "h", chunkCount: 2, lastIngestedAt: now, lastSeenAt: now };
  });
  return res.value.id;
}

/** The single captured runEphemeralWorker input (first call). */
function runnerInput(): Record<string, unknown> {
  return runEphemeralWorkerMock.mock.calls[0]![0] as unknown as Record<string, unknown>;
}

describe("use_knowledge_base", () => {
  it("runs the DEFAULT worker (KB retrieval + web/site tools) when the KB has no template", async () => {
    const id = await readyKb({ name: "Docs KB", seedUrls: ["https://example.com/"] });
    const res = await useTool().execute({ knowledge_base: id, task: "audit https://target.example against the docs" }, ctx());

    expect(res.success).toBe(true);
    expect(runEphemeralWorkerMock).toHaveBeenCalledTimes(1);
    const input = runnerInput();
    expect(input["agentName"]).toBe(`kb_${id}_worker`);
    expect(input["requestedTools"]).toEqual(WORKER_DEFAULT_TOOLS);
    expect(input["alwaysGrantTools"]).toEqual(WORKER_ALWAYS_TOOLS);
    // default instructions ground the worker in THIS KB's id
    expect(input["systemPrompt"]).toContain(`search_knowledge_base (knowledge_base="${id}")`);
    expect(input["systemPrompt"]).toContain(`Knowledge base id for search_knowledge_base: "${id}"`);
    expect(res.output).toContain('Worker result (grounded in "Docs KB")');
  });

  it("uses the TEMPLATE's tools (still unioned with KB retrieval) + instructions + model/limits", async () => {
    const id = await readyKb({
      name: "Custom KB",
      seedUrls: ["https://example.com/"],
      worker: { instructions: "Only cite the standard.", tools: ["browser_axe_audit"], maxIterations: 3, timeoutMs: 120_000, model: { temperature: 0.2 } },
    });
    const res = await useTool().execute({ knowledge_base: id, task: "check the page" }, ctx());

    expect(res.success).toBe(true);
    const input = runnerInput();
    // KB retrieval tools are ALWAYS unioned in first; the default web tools are NOT added when a template lists tools
    expect(input["requestedTools"]).toEqual([...WORKER_ALWAYS_TOOLS, "browser_axe_audit"]);
    expect(input["alwaysGrantTools"]).toEqual(WORKER_ALWAYS_TOOLS);
    expect((input["systemPrompt"] as string).startsWith("Only cite the standard.")).toBe(true);
    expect(input["maxIterations"]).toBe(3);
    expect(input["timeoutMs"]).toBe(120_000);
    expect(input["model"]).toEqual({ temperature: 0.2 });
  });

  it("enforces access: an out-of-scope session KB returns not-found and never runs the worker", async () => {
    const id = await readyKb({ name: "Private KB", seedUrls: ["https://example.com/"], scope: "session", sessionId: "owner-sess" });

    const denied = await useTool().execute({ knowledge_base: id, task: "do it" }, ctx({ sessionId: "intruder-sess" }));
    expect(denied.success).toBe(false);
    expect(denied.error).toMatch(/No knowledge base matches/); // same shape as truly-absent — no existence disclosure
    expect(runEphemeralWorkerMock).not.toHaveBeenCalled();

    // the owning session CAN use it
    const ok = await useTool().execute({ knowledge_base: id, task: "do it" }, ctx({ sessionId: "owner-sess" }));
    expect(ok.success).toBe(true);
    expect(runEphemeralWorkerMock).toHaveBeenCalledTimes(1);
    // Regression (review): the owning session must be threaded to the worker as
    // kbAccessSessionId, so the worker (which runs under a rewritten sub-session)
    // can still reach the session-scoped KB it was built for.
    expect(runnerInput()["kbAccessSessionId"]).toBe("owner-sess");
  });

  it("short-circuits (no worker run) when the KB has no indexed pages", async () => {
    const created = await createKnowledgeBase({ name: "Empty KB", seedUrls: ["https://example.com/"] });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const out = await useTool().execute({ knowledge_base: created.value.id, task: "do it" }, ctx());
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/no indexed pages/);
    expect(runEphemeralWorkerMock).not.toHaveBeenCalled();
  });

  it("short-circuits with the crawling message while a crawl is still live", async () => {
    const created = await createKnowledgeBase({ name: "Crawling KB", seedUrls: ["https://example.com/"] });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await mutateKnowledgeBase(created.value.id, (r) => { r.status = "crawling"; });
    isCrawlActiveMock.mockReturnValue(true); // keep it "crawling" (else it normalizes to failed)

    const out = await useTool().execute({ knowledge_base: created.value.id, task: "do it" }, ctx());
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/still crawling/);
    expect(runEphemeralWorkerMock).not.toHaveBeenCalled();
  });

  it("surfaces a worker run failure without claiming success", async () => {
    const id = await readyKb({ name: "Fail KB", seedUrls: ["https://example.com/"] });
    runEphemeralWorkerMock.mockResolvedValueOnce({ success: false, output: "model unreachable", grantedTools: [], rejectedTools: [] });
    const out = await useTool().execute({ knowledge_base: id, task: "do it" }, ctx());
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/worker could not run: model unreachable/);
  });

  it("appends a note and passes through metadata when the worker skips ungrantable tools", async () => {
    const id = await readyKb({ name: "Note KB", seedUrls: ["https://example.com/"] });
    runEphemeralWorkerMock.mockResolvedValueOnce({ success: true, output: "ok", grantedTools: WORKER_ALWAYS_TOOLS, rejectedTools: ["nonexistent_tool"] });
    const out = await useTool().execute({ knowledge_base: id, task: "do it" }, ctx());
    expect(out.success).toBe(true);
    expect(out.output).toContain("nonexistent_tool");
    expect(out.metadata?.["rejectedTools"]).toEqual(["nonexistent_tool"]);
  });

  it("is unavailable (no run) when documentRag/engram is not configured", async () => {
    vi.spyOn(engram, "engramConfigured").mockReturnValue(false);
    const out = await useTool().execute({ knowledge_base: "whatever", task: "do it" }, ctx());
    expect(out.success).toBe(false);
    expect(out.error).toMatch(/Document RAG is not enabled/);
    expect(runEphemeralWorkerMock).not.toHaveBeenCalled();
  });
});
