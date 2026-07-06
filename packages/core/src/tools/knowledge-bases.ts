/**
 * Knowledge-base tools — build and query named corpora crawled from
 * documentation sites (wikis, standards, tutorials) into engram.
 *
 * The intended agent flow ("make this site our knowledge, then use it"):
 *   1. create_knowledge_base  — seeds + bounds; the crawl runs in the
 *      background and the tool returns immediately;
 *   2. list_knowledge_bases   — poll status until "ready" (also the discovery
 *      surface: what corpora exist, how fresh, how big);
 *   3. search_knowledge_base  — scoped retrieval returning excerpts WITH their
 *      source page URLs, so answers cite the site;
 *   4. manage_knowledge_base  — recrawl / cancel / delete.
 *
 * Everything no-ops gracefully when documentRag (engram) or
 * retrieval.knowledgeBases is disabled.
 */
import { getConfig } from "../config/loader.js";
import { registerTool, type ToolResult } from "./registry.js";
import { engramConfigured } from "../retrieval/engram.js";

function fail(error: string): ToolResult {
  return { success: false, output: "", error };
}

function kbUnavailableReason(): string | null {
  if (!getConfig().retrieval.knowledgeBases.enabled) return "Knowledge bases are disabled (retrieval.knowledgeBases.enabled).";
  if (!engramConfigured()) return "Document RAG is not enabled (retrieval.documentRag.enabled) — knowledge bases require the engram service.";
  return null;
}

function describeCrawl(lastCrawl?: import("../retrieval/knowledge-bases.js").KbCrawlStats): string {
  if (!lastCrawl) return "never crawled";
  const parts = [
    `${lastCrawl.pagesIngested} ingested`,
    `${lastCrawl.pagesSkippedUnchanged} unchanged`,
    `${lastCrawl.pagesFailed} failed`,
  ];
  const when = lastCrawl.finishedAt ?? lastCrawl.startedAt;
  const state = lastCrawl.finishedAt ? `finished ${when}` : `running since ${when}${lastCrawl.currentUrl ? `, at ${lastCrawl.currentUrl}` : ""}`;
  return `${state} (${lastCrawl.pagesVisited} pages visited: ${parts.join(", ")}${lastCrawl.stopReason ? `; stop: ${lastCrawl.stopReason}` : ""}${lastCrawl.error ? `; error: ${lastCrawl.error}` : ""})`;
}

// ── list_knowledge_bases ──────────────────────────────────────────────────────

registerTool({
  name: "list_knowledge_bases",
  description:
    "List the knowledge bases (crawled documentation sites) available for retrieval, with crawl status and size. Pass knowledge_base to get one KB's detail including crawl progress — use that to poll until a crawl you started is 'ready'.",
  embeddingDescription:
    "list show knowledge bases crawled documentation corpora wiki sites status crawl progress poll; Wissensdatenbanken anzeigen",
  parameters: {
    type: "object",
    properties: {
      knowledge_base: { type: "string", description: "Optional: a knowledge base id or name for detailed status." },
    },
    required: [],
  },
  async execute(args): Promise<ToolResult> {
    const unavailable = kbUnavailableReason();
    if (unavailable) return fail(unavailable);
    const { listKnowledgeBases, getKnowledgeBase, toSummary } = await import("../retrieval/knowledge-bases.js");
    const { isCrawlActive } = await import("../retrieval/kb-crawler.js");

    const idOrName = String(args["knowledge_base"] ?? "").trim();
    if (idOrName) {
      const kb = await getKnowledgeBase(idOrName, { isCrawlActive });
      if (!kb) return fail(`No knowledge base matches "${idOrName}". Call list_knowledge_bases without arguments to see what exists.`);
      const s = toSummary(kb);
      const lines = [
        `${s.name} (id: ${s.id}) — status: ${s.status}`,
        ...(s.description ? [s.description] : []),
        `Seeds: ${s.seedUrls.join(", ")}`,
        `Pages: ${s.pageCount} (${s.chunkCount} chunks) — bounds: ${s.maxPages} pages, depth ${s.maxDepth}`,
        `Ambient retrieval: ${s.ambientRetrieval ? "on (joins every turn's document context)" : "off (query explicitly via search_knowledge_base)"}`,
        `Last crawl: ${describeCrawl(s.lastCrawl)}`,
      ];
      return { success: true, output: lines.join("\n"), metadata: { id: s.id, status: s.status, pageCount: s.pageCount } };
    }

    const kbs = await listKnowledgeBases({ isCrawlActive });
    if (kbs.length === 0) {
      return {
        success: true,
        output: "No knowledge bases exist yet. Create one from a documentation site with create_knowledge_base.",
        metadata: { count: 0 },
      };
    }
    const lines = kbs.map((kb) => {
      const s = toSummary(kb);
      return `- ${s.name} (id: ${s.id}) — ${s.status}, ${s.pageCount} pages${s.description ? ` — ${s.description}` : ""}`;
    });
    return { success: true, output: `${kbs.length} knowledge base(s):\n${lines.join("\n")}`, metadata: { count: kbs.length } };
  },
});

// ── search_knowledge_base ─────────────────────────────────────────────────────

registerTool({
  name: "search_knowledge_base",
  description:
    "Search ONE named knowledge base (a crawled documentation site) and get the most relevant excerpts with their source page URLs. Use this to ground answers, audits, or evaluations in the indexed documentation — cite the page URLs. Use list_knowledge_bases to see what exists.",
  embeddingDescription:
    "search query knowledge base crawled documentation site wiki standards retrieve excerpts citations grounded; Wissensdatenbank durchsuchen",
  parameters: {
    type: "object",
    properties: {
      knowledge_base: { type: "string", description: "Knowledge base id or name." },
      query: { type: "string", description: "What to look for." },
      top_k: { type: "number", description: "How many excerpts to return (default from settings, max 20)." },
    },
    required: ["knowledge_base", "query"],
  },
  async execute(args): Promise<ToolResult> {
    const unavailable = kbUnavailableReason();
    if (unavailable) return fail(unavailable);
    const idOrName = String(args["knowledge_base"] ?? "").trim();
    const query = String(args["query"] ?? "").trim();
    if (!idOrName) return fail("knowledge_base is required");
    if (!query) return fail("query is required");

    const { getKnowledgeBase } = await import("../retrieval/knowledge-bases.js");
    const { isCrawlActive } = await import("../retrieval/kb-crawler.js");
    const kb = await getKnowledgeBase(idOrName, { isCrawlActive });
    if (!kb) return fail(`No knowledge base matches "${idOrName}". Call list_knowledge_bases to see what exists.`);
    if (Object.keys(kb.pages).length === 0) {
      return fail(
        kb.status === "crawling"
          ? `Knowledge base "${kb.id}" is still crawling and has no indexed pages yet — poll list_knowledge_bases until it is ready.`
          : `Knowledge base "${kb.id}" has no indexed pages (status: ${kb.status}). Start a crawl with manage_knowledge_base action=recrawl.`,
      );
    }

    const topK = Number.isFinite(Number(args["top_k"])) ? Number(args["top_k"]) : undefined;
    const { searchKnowledgeBase } = await import("../retrieval/document-rag.js");
    const { chunks, retrievalFailed, lowConfidence } = await searchKnowledgeBase(kb, query, topK);
    if (retrievalFailed) return fail("The knowledge-base store did not respond — retrieval failed this turn (this is NOT evidence the topic is absent). Retry, or check engram availability.");
    if (chunks.length === 0) {
      return {
        success: true,
        output: `No relevant excerpts found in "${kb.name}" for this query. The corpus holds ${Object.keys(kb.pages).length} pages — try different phrasing, or crawl more of the site (higher max_pages/depth).`,
        metadata: { hits: 0, kbId: kb.id },
      };
    }

    const blocks = chunks.map((c, i) => {
      const label = c.title?.trim() || c.documentId.slice(0, 8);
      return `[${i + 1}] ${label}${c.url ? `\n${c.url}` : ""}\n(score ${c.score.toFixed(3)})\n${c.text.trim()}`;
    });
    const confidenceNote = lowConfidence
      ? "\n\nNote: retrieval confidence for this query was LOW — treat these excerpts as possibly-relevant leads and verify against the cited pages before relying on specifics."
      : "";
    return {
      success: true,
      output: `Top ${chunks.length} excerpt(s) from "${kb.name}":\n\n${blocks.join("\n\n---\n\n")}${confidenceNote}`,
      metadata: { hits: chunks.length, kbId: kb.id, lowConfidence },
    };
  },
});

// ── create_knowledge_base ─────────────────────────────────────────────────────

registerTool({
  name: "create_knowledge_base",
  description:
    "Create a knowledge base by recursively crawling a documentation website (e.g. a wiki, a standard like the W3C accessibility docs, a product manual) into the retrieval store. Give seed URLs; the crawler follows in-scope links (same site, under the seed paths) up to max_pages/max_depth. Returns immediately — the crawl runs in the background; poll list_knowledge_bases until status is 'ready', then query it with search_knowledge_base.",
  embeddingDescription:
    "create build knowledge base crawl website documentation wiki recursively index site ingest corpus; Wissensdatenbank erstellen Webseite crawlen indexieren",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Human-readable name (also used to derive the id)." },
      seed_urls: { type: "array", items: { type: "string" }, description: "Start URLs. Crawling stays on these sites, under these paths." },
      description: { type: "string", description: "What this corpus is for — helps later discovery." },
      id: { type: "string", description: "Optional slug id (lowercase, digits, hyphens). Derived from name when omitted." },
      max_pages: { type: "number", description: "Page budget for the crawl (default from settings)." },
      max_depth: { type: "number", description: "Link depth from the seeds (default from settings)." },
      include_patterns: { type: "array", items: { type: "string" }, description: "Optional regexes that WIDEN the crawl scope beyond the seed paths." },
      exclude_patterns: { type: "array", items: { type: "string" }, description: "Optional regexes for URLs to never crawl." },
    },
    required: ["name", "seed_urls"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const unavailable = kbUnavailableReason();
    if (unavailable) return fail(unavailable);
    const { createKnowledgeBase } = await import("../retrieval/knowledge-bases.js");
    const { startKbCrawl } = await import("../retrieval/kb-crawler.js");

    const created = await createKnowledgeBase({
      name: String(args["name"] ?? ""),
      seedUrls: Array.isArray(args["seed_urls"]) ? (args["seed_urls"] as string[]) : [],
      ...(args["description"] ? { description: String(args["description"]) } : {}),
      ...(args["id"] ? { id: String(args["id"]) } : {}),
      ...(Number.isFinite(Number(args["max_pages"])) ? { maxPages: Number(args["max_pages"]) } : {}),
      ...(Number.isFinite(Number(args["max_depth"])) ? { maxDepth: Number(args["max_depth"]) } : {}),
      ...(Array.isArray(args["include_patterns"]) ? { includePatterns: args["include_patterns"] as string[] } : {}),
      ...(Array.isArray(args["exclude_patterns"]) ? { excludePatterns: args["exclude_patterns"] as string[] } : {}),
      ...(ctx.userId ? { createdBy: ctx.userId } : {}),
    });
    if (!created.ok) return fail(created.error);

    const kb = created.value;
    const started = await startKbCrawl(kb.id);
    if (!started.ok) {
      return {
        success: true,
        output: `Knowledge base "${kb.name}" (id: ${kb.id}) was created, but the crawl could not start: ${started.error}. Start it later with manage_knowledge_base action=recrawl.`,
        metadata: { id: kb.id, crawlStarted: false },
      };
    }
    return {
      success: true,
      output:
        `Knowledge base "${kb.name}" (id: ${kb.id}) created — crawling ${kb.seedUrls.join(", ")} in the background ` +
        `(up to ${kb.maxPages} pages, depth ${kb.maxDepth}). Poll list_knowledge_bases with knowledge_base="${kb.id}" until status is "ready", ` +
        `then query it with search_knowledge_base. Crawls of large sites can take several minutes.`,
      metadata: { id: kb.id, crawlStarted: true, maxPages: kb.maxPages, maxDepth: kb.maxDepth },
    };
  },
});

// ── manage_knowledge_base ─────────────────────────────────────────────────────

registerTool({
  name: "manage_knowledge_base",
  description:
    "Manage a knowledge base: 'recrawl' re-indexes the site (unchanged pages are skipped, removed pages are pruned), 'cancel' stops a running crawl (already-indexed pages are kept), 'delete' removes the KB and all its indexed pages permanently.",
  embeddingDescription:
    "recrawl refresh update cancel delete remove knowledge base crawled site corpus maintenance; Wissensdatenbank aktualisieren löschen",
  parameters: {
    type: "object",
    properties: {
      knowledge_base: { type: "string", description: "Knowledge base id or name." },
      action: { type: "string", enum: ["recrawl", "cancel", "delete"], description: "What to do." },
    },
    required: ["knowledge_base", "action"],
  },
  async execute(args): Promise<ToolResult> {
    const unavailable = kbUnavailableReason();
    if (unavailable) return fail(unavailable);
    const idOrName = String(args["knowledge_base"] ?? "").trim();
    const action = String(args["action"] ?? "").trim();
    if (!idOrName) return fail("knowledge_base is required");

    const { getKnowledgeBase } = await import("../retrieval/knowledge-bases.js");
    const { startKbCrawl, cancelKbCrawl, deleteKnowledgeBase, isCrawlActive } = await import("../retrieval/kb-crawler.js");
    const kb = await getKnowledgeBase(idOrName, { isCrawlActive });
    if (!kb) return fail(`No knowledge base matches "${idOrName}".`);

    switch (action) {
      case "recrawl": {
        const started = await startKbCrawl(kb.id);
        return started.ok
          ? { success: true, output: `Re-crawl of "${kb.name}" (id: ${kb.id}) started in the background. Poll list_knowledge_bases until it is "ready".`, metadata: { id: kb.id } }
          : fail(started.error);
      }
      case "cancel": {
        const cancelled = await cancelKbCrawl(kb.id);
        return cancelled
          ? { success: true, output: `Cancellation requested for the crawl of "${kb.name}" — it stops at the next page boundary; already-indexed pages are kept.`, metadata: { id: kb.id } }
          : fail(`No crawl is running for "${kb.id}".`);
      }
      case "delete": {
        const result = await deleteKnowledgeBase(kb.id);
        if (!result.ok) return fail(result.error ?? "delete failed");
        return {
          success: true,
          output: `Deleted knowledge base "${kb.name}" (id: ${kb.id}) — ${result.documentsRemoved} indexed page(s) removed${result.documentsFailed ? `, ${result.documentsFailed} could not be removed from the store (engram unavailable?)` : ""}.`,
          metadata: { id: kb.id, documentsRemoved: result.documentsRemoved, documentsFailed: result.documentsFailed },
        };
      }
      default:
        return fail(`Unknown action "${action}" — use recrawl, cancel, or delete.`);
    }
  },
});
