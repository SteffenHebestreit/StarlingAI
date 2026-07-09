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
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { engramConfigured } from "../retrieval/engram.js";
import { callerCanAccessKb, type KbAccessContext } from "../retrieval/knowledge-bases.js";

function fail(error: string): ToolResult {
  return { success: false, output: "", error };
}

/** Scope identity for KB access control, derived from the tool context. An
 *  ephemeral KB worker carries the originating conversation session in
 *  kbAccessSessionId (its own sessionId is a rewritten per-run sub-session that
 *  would never match a session-scoped KB), so prefer it when present. */
function accessCtx(ctx: ToolContext): KbAccessContext {
  const sessionId = ctx.kbAccessSessionId ?? ctx.sessionId;
  return { ...(ctx.userId ? { userId: ctx.userId } : {}), ...(sessionId ? { sessionId } : {}) };
}

function kbUnavailableReason(): string | null {
  if (!getConfig().retrieval.knowledgeBases.enabled) return "Knowledge bases are disabled (retrieval.knowledgeBases.enabled).";
  if (!engramConfigured()) return "Document RAG is not enabled (retrieval.documentRag.enabled) — knowledge bases require the engram service.";
  return null;
}

/**
 * Knowledge-base MUTATIONS (create / recrawl / cancel / delete) are operator-only,
 * matching the REST routes (roles:["operator"]) and the MCP write-tier gate — so the
 * chat tool surface can't bypass the boundary the other two surfaces enforce (a viewer
 * could otherwise ask the orchestrator to crawl or permanently delete a shared KB).
 * Returns a refusal ToolResult when the caller is below operator rank under active
 * multi-user auth; null (allow) when auth is off or no role was threaded (channel/token
 * turns), preserving single-operator back-compat. roleRank is resolved lazily to keep
 * this leaf tool module off the gateway import graph at load time.
 */
export async function requireOperator(ctx: ToolContext): Promise<ToolResult | null> {
  if (getConfig().auth?.enabled !== true) return null;
  if (!ctx.userRole) return null;
  const { roleRank } = await import("../gateway/auth.js");
  if (roleRank(ctx.userRole) >= roleRank("operator")) return null;
  return fail(`Managing knowledge bases (create, recrawl, cancel, delete) requires the operator role — your role is "${ctx.userRole}". Use search_knowledge_base / list_knowledge_bases to read existing ones, or ask an operator.`);
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
  async execute(args, ctx): Promise<ToolResult> {
    const unavailable = kbUnavailableReason();
    if (unavailable) return fail(unavailable);
    const { listKnowledgeBases, getKnowledgeBase, toSummary } = await import("../retrieval/knowledge-bases.js");
    const { isCrawlActive } = await import("../retrieval/kb-crawler.js");
    const who = accessCtx(ctx);

    const idOrName = String(args["knowledge_base"] ?? "").trim();
    if (idOrName) {
      const kb = await getKnowledgeBase(idOrName, { isCrawlActive });
      // Same not-found shape whether it is absent or out-of-scope (no existence disclosure).
      if (!kb || !callerCanAccessKb(kb, who)) return fail(`No knowledge base matches "${idOrName}". Call list_knowledge_bases without arguments to see what exists.`);
      const s = toSummary(kb);
      const lines = [
        `${s.name} (id: ${s.id}) — status: ${s.status} — scope: ${s.scope}`,
        ...(s.description ? [s.description] : []),
        `Seeds: ${s.seedUrls.join(", ")}`,
        `Pages: ${s.pageCount} (${s.chunkCount} chunks) — bounds: ${s.maxPages} pages, depth ${s.maxDepth}`,
        `Ambient retrieval: ${s.ambientRetrieval ? "on (joins every turn's document context)" : "off (query explicitly via search_knowledge_base)"}`,
        `Worker: ${s.hasWorker ? "custom template configured (use_knowledge_base runs it)" : "default (KB retrieval + web/site inspection)"}`,
        `Last crawl: ${describeCrawl(s.lastCrawl)}`,
      ];
      return { success: true, output: lines.join("\n"), metadata: { id: s.id, status: s.status, scope: s.scope, pageCount: s.pageCount } };
    }

    const kbs = (await listKnowledgeBases({ isCrawlActive })).filter((kb) => callerCanAccessKb(kb, who));
    if (kbs.length === 0) {
      return {
        success: true,
        output: "No knowledge bases available to you yet. Create one from a documentation site with create_knowledge_base.",
        metadata: { count: 0 },
      };
    }
    const lines = kbs.map((kb) => {
      const s = toSummary(kb);
      return `- ${s.name} (id: ${s.id}) — ${s.status}, ${s.pageCount} pages, ${s.scope} scope${s.description ? ` — ${s.description}` : ""}`;
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
  async execute(args, ctx): Promise<ToolResult> {
    const unavailable = kbUnavailableReason();
    if (unavailable) return fail(unavailable);
    const idOrName = String(args["knowledge_base"] ?? "").trim();
    const query = String(args["query"] ?? "").trim();
    if (!idOrName) return fail("knowledge_base is required");
    if (!query) return fail("query is required");

    const { getKnowledgeBase } = await import("../retrieval/knowledge-bases.js");
    const { isCrawlActive } = await import("../retrieval/kb-crawler.js");
    const kb = await getKnowledgeBase(idOrName, { isCrawlActive });
    if (!kb || !callerCanAccessKb(kb, accessCtx(ctx))) return fail(`No knowledge base matches "${idOrName}". Call list_knowledge_bases to see what exists.`);
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
      scope: { type: "string", enum: ["session", "user", "workspace"], description: "Visibility: session (this chat), user (your library), or workspace (shared, default)." },
      worker_instructions: { type: "string", description: "Optional: instructions for the temporary 'worker' agent that use_knowledge_base spins up to apply this KB to a task." },
      worker_tools: { type: "array", items: { type: "string" }, description: "Optional: extra tools the worker should have (beyond the always-granted KB retrieval tools), e.g. browser_axe_audit, browser_navigate." },
    },
    required: ["name", "seed_urls"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const unavailable = kbUnavailableReason();
    if (unavailable) return fail(unavailable);
    const denied = await requireOperator(ctx);
    if (denied) return denied;
    const { createKnowledgeBase } = await import("../retrieval/knowledge-bases.js");
    const { startKbCrawl } = await import("../retrieval/kb-crawler.js");

    const scope = ["session", "user", "workspace"].includes(String(args["scope"] ?? "")) ? String(args["scope"]) as "session" | "user" | "workspace" : "workspace";
    const workerInstructions = args["worker_instructions"] ? String(args["worker_instructions"]) : undefined;
    const workerTools = Array.isArray(args["worker_tools"]) ? (args["worker_tools"] as string[]) : undefined;
    const worker = workerInstructions || workerTools ? { ...(workerInstructions ? { instructions: workerInstructions } : {}), ...(workerTools ? { tools: workerTools } : {}) } : undefined;

    const created = await createKnowledgeBase({
      name: String(args["name"] ?? ""),
      seedUrls: Array.isArray(args["seed_urls"]) ? (args["seed_urls"] as string[]) : [],
      ...(args["description"] ? { description: String(args["description"]) } : {}),
      ...(args["id"] ? { id: String(args["id"]) } : {}),
      ...(Number.isFinite(Number(args["max_pages"])) ? { maxPages: Number(args["max_pages"]) } : {}),
      ...(Number.isFinite(Number(args["max_depth"])) ? { maxDepth: Number(args["max_depth"]) } : {}),
      ...(Array.isArray(args["include_patterns"]) ? { includePatterns: args["include_patterns"] as string[] } : {}),
      ...(Array.isArray(args["exclude_patterns"]) ? { excludePatterns: args["exclude_patterns"] as string[] } : {}),
      scope,
      ...(ctx.userId ? { ownerId: ctx.userId } : {}),
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(worker ? { worker } : {}),
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
  async execute(args, ctx): Promise<ToolResult> {
    const unavailable = kbUnavailableReason();
    if (unavailable) return fail(unavailable);
    const denied = await requireOperator(ctx);
    if (denied) return denied;
    const idOrName = String(args["knowledge_base"] ?? "").trim();
    const action = String(args["action"] ?? "").trim();
    if (!idOrName) return fail("knowledge_base is required");

    const { getKnowledgeBase } = await import("../retrieval/knowledge-bases.js");
    const { startKbCrawl, cancelKbCrawl, deleteKnowledgeBase, isCrawlActive } = await import("../retrieval/kb-crawler.js");
    const kb = await getKnowledgeBase(idOrName, { isCrawlActive });
    if (!kb || !callerCanAccessKb(kb, accessCtx(ctx))) return fail(`No knowledge base matches "${idOrName}".`);

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

// ── use_knowledge_base ────────────────────────────────────────────────────────

// Tools the worker ALWAYS gets, regardless of its template, so it can actually
// query the KB. A KB with no worker template also gets the read-only web/site
// inspection defaults so "evaluate site X against this KB" works out of the box.
const WORKER_ALWAYS_TOOLS = ["search_knowledge_base", "list_knowledge_bases"];
const WORKER_DEFAULT_TOOLS = ["search_knowledge_base", "list_knowledge_bases", "web_fetch", "browser_navigate", "browser_snapshot", "browser_axe_audit", "lighthouse_audit"];

registerTool({
  name: "use_knowledge_base",
  description:
    "Apply a knowledge base to a task by spinning up a single-use temporary agent — the KB's own 'worker' — that is granted the KB's retrieval tools (and any extra tools configured on the KB) and runs your task grounded in that knowledge, citing source pages. Use this for 'use knowledge base X to do Y' (e.g. 'use w3c-accessibility to audit https://example.com'): it is more reliable than delegating to a general specialist because the worker is purpose-configured for this KB.",
  embeddingDescription:
    "use apply knowledge base to evaluate audit analyze a target with a temporary worker agent grounded in the corpus; Wissensdatenbank anwenden auswerten",
  parameters: {
    type: "object",
    properties: {
      knowledge_base: { type: "string", description: "Knowledge base id or name." },
      task: { type: "string", description: "What the worker should do, grounded in this KB (include any target URL/subject)." },
    },
    required: ["knowledge_base", "task"],
  },
  async execute(args, ctx): Promise<ToolResult> {
    const unavailable = kbUnavailableReason();
    if (unavailable) return fail(unavailable);
    const idOrName = String(args["knowledge_base"] ?? "").trim();
    const task = String(args["task"] ?? "").trim();
    if (!idOrName) return fail("knowledge_base is required");
    if (!task) return fail("task is required");

    const { getKnowledgeBase } = await import("../retrieval/knowledge-bases.js");
    const { isCrawlActive } = await import("../retrieval/kb-crawler.js");
    const kb = await getKnowledgeBase(idOrName, { isCrawlActive });
    if (!kb || !callerCanAccessKb(kb, accessCtx(ctx))) return fail(`No knowledge base matches "${idOrName}". Call list_knowledge_bases to see what exists.`);
    if (Object.keys(kb.pages).length === 0) {
      return fail(
        kb.status === "crawling"
          ? `Knowledge base "${kb.id}" is still crawling and has no indexed pages yet — poll list_knowledge_bases until it is ready.`
          : `Knowledge base "${kb.id}" has no indexed pages (status: ${kb.status}); crawl it first (manage_knowledge_base action=recrawl).`,
      );
    }

    const worker = kb.worker;
    const requestedTools = worker?.tools?.length ? [...WORKER_ALWAYS_TOOLS, ...worker.tools] : WORKER_DEFAULT_TOOLS;
    const systemPrompt =
      (worker?.instructions?.trim() ||
        `You are a single-use worker for the "${kb.name}" knowledge base. Ground everything you do in that knowledge base: call search_knowledge_base (knowledge_base="${kb.id}") for the relevant material before making claims, and cite the source page URLs it returns. If the task is to evaluate or audit a live target, inspect it with your granted tools (e.g. browser_axe_audit / browser_navigate / web_fetch) and map each concrete finding back to the knowledge base with a cited source URL. Be honest about what you could not verify; never invent findings.`) +
      `\n\n(Knowledge base id for search_knowledge_base: "${kb.id}".)`;

    const { runEphemeralWorker } = await import("./ephemeral-agent-factory.js");
    const run = await runEphemeralWorker({
      agentName: `kb_${kb.id}_worker`,
      task,
      context: `Knowledge base: ${kb.name} (id: ${kb.id})${kb.description ? ` — ${kb.description}` : ""}. Pages indexed: ${Object.keys(kb.pages).length}.`,
      systemPrompt,
      requestedTools,
      alwaysGrantTools: WORKER_ALWAYS_TOOLS,
      ...(worker?.model ? { model: worker.model } : {}),
      ...(worker?.maxIterations ? { maxIterations: worker.maxIterations } : {}),
      ...(worker?.timeoutMs ? { timeoutMs: worker.timeoutMs } : {}),
      // Thread the ORIGINATING session so the worker can reach a session-scoped
      // KB (its own sub-session id would never match kb.sessionId). Safe: the
      // caller already passed the access check above, and this only re-grants the
      // caller's own session scope, never another's.
      ...(accessCtx(ctx).sessionId ? { kbAccessSessionId: accessCtx(ctx).sessionId } : {}),
      ctx,
    });
    if (!run.success) return fail(`The knowledge-base worker could not run: ${run.output}`);

    const note = run.rejectedTools.length > 0 ? `\n\n[Note: worker tools ${run.rejectedTools.join(", ")} were not grantable and were skipped.]` : "";
    return {
      success: true,
      // Anti-embellishment: the worker already inspected the target and grounded
      // in the KB, so the orchestrator must RELAY these findings, not re-derive or
      // add to them. Without this, an orchestrator was observed to fabricate
      // specific violations on top of a worker's honest "0 violations" result.
      output:
        `Worker result (grounded in "${kb.name}") — relay these findings to the user as-is; do NOT add, infer, or invent any finding the worker did not report, and do NOT claim files were written that the worker did not create:\n\n${run.output}${note}`,
      metadata: { kbId: kb.id, grantedTools: run.grantedTools, rejectedTools: run.rejectedTools },
    };
  },
});
