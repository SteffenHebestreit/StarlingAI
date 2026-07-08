/**
 * Knowledge-base crawler — deterministic, bounded BFS over a documentation
 * site, ingesting each in-scope page into engram under the KB's `kb:<id>`
 * source token.
 *
 * Deliberately NOT agent-driven: fetching pages and following links is
 * mechanical work, so a plain loop is cheaper, politeness-bounded, and
 * reproducible; agents come in ABOVE this layer (create the KB, poll status,
 * then answer questions with search_knowledge_base).
 *
 * Safety rails, in order of application per URL:
 *   1. scope — same origin as a seed + under a seed's path prefix, widened by
 *      includePatterns, always vetoed by excludePatterns;
 *   2. robots.txt (per-KB opt-out) with a minimal User-agent group parser;
 *   3. the web_fetch SSRF guard (isPrivateHost + DNS re-check on every
 *      redirect hop) unless retrieval.knowledgeBases.allowPrivateHosts;
 *   4. budgets — maxPages / maxDepth / maxCrawlMs / maxPageBytes, per-host
 *      politeness delay, small fetch concurrency.
 *
 * A crawl runs in-process (fire-and-forget promise) and persists progress to
 * the KB registry every few pages, so the UI/tools can poll and a cooperative
 * cancel (flag in the record, or AbortController locally) takes effect at page
 * granularity. Crawls are idempotent — a crash/restart just means re-crawl:
 * page document ids are stable and unchanged pages are skipped by hash.
 */
import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { engramConfigured, engramIngest, engramDeleteDocument } from "./engram.js";
import {
  getKnowledgeBase,
  mutateKnowledgeBase,
  removeKnowledgeBaseRecord,
  kbSource,
  kbDocumentId,
  type KnowledgeBaseRecord,
  type KbCrawlStats,
  type CrawlStopReason,
} from "./knowledge-bases.js";

const log = childLogger("retrieval:kb-crawler");

// ── URL helpers (pure, exported for tests) ─────────────────────────────────────

/** Query params that never change page content — dropped during normalization. */
const TRACKING_PARAMS = new Set(["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid", "msclkid", "ref"]);

/** File extensions that are never documentation pages. (PDF is deliberately allowed.) */
const SKIP_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".avif", ".bmp",
  ".css", ".js", ".mjs", ".map", ".json", ".xml", ".rss", ".atom",
  ".zip", ".tar", ".gz", ".tgz", ".bz2", ".7z", ".rar",
  ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".mov", ".avi",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".exe", ".dmg", ".pkg", ".deb", ".rpm", ".msi", ".apk", ".jar", ".whl",
  ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", // office files: convertible but rarely crawl targets; keep the frontier lean
]);

/**
 * Canonical form of a URL for dedup + stable document ids: strip fragment and
 * tracking params, sort the remaining query, drop default ports. Returns null
 * for non-http(s) or unparseable URLs.
 */
export function normalizeUrl(raw: string, base?: string): string | null {
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  url.username = "";
  url.password = "";
  const params = [...url.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()));
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  return url.toString();
}

function pathExtension(url: URL): string {
  const path = url.pathname;
  const dot = path.lastIndexOf(".");
  if (dot < 0 || dot < path.lastIndexOf("/")) return "";
  return path.slice(dot).toLowerCase();
}

/** True when the URL's path extension marks a non-page asset. */
export function isSkippableAsset(normalizedUrl: string): boolean {
  try {
    return SKIP_EXTENSIONS.has(pathExtension(new URL(normalizedUrl)));
  } catch {
    return true;
  }
}

/**
 * Scope prefix of a seed URL: its directory. A seed ending in "/" is its own
 * prefix; otherwise the final path segment is dropped ("…/docs/index.html" →
 * "…/docs/"). Everything under a seed's prefix (same origin) is in scope.
 */
export function seedScopePrefix(seedUrl: string): string {
  const url = new URL(seedUrl);
  url.hash = "";
  url.search = "";
  if (!url.pathname.endsWith("/")) {
    const cut = url.pathname.lastIndexOf("/") + 1;
    const lastSegment = url.pathname.slice(cut);
    // A file-like final segment ("…/docs/index.html") → drop it to its directory.
    // An extensionless segment ("…/docs") is itself a directory → keep it and add
    // a trailing slash, so the scope stays under that path rather than collapsing
    // to the whole origin (which would defeat "crawling stays under these paths").
    url.pathname = lastSegment.includes(".") ? url.pathname.slice(0, cut) : `${url.pathname}/`;
  }
  return url.toString();
}

export interface CrawlScopeRules {
  seedPrefixes: string[];
  seedOrigins: Set<string>;
  includePatterns: RegExp[];
  excludePatterns: RegExp[];
  sameOriginOnly: boolean;
}

export function buildScopeRules(kb: Pick<KnowledgeBaseRecord, "seedUrls" | "includePatterns" | "excludePatterns" | "sameOriginOnly">): CrawlScopeRules {
  return {
    seedPrefixes: kb.seedUrls.map(seedScopePrefix),
    seedOrigins: new Set(kb.seedUrls.map((s) => new URL(s).origin)),
    includePatterns: (kb.includePatterns ?? []).map((p) => new RegExp(p)),
    excludePatterns: (kb.excludePatterns ?? []).map((p) => new RegExp(p)),
    sameOriginOnly: kb.sameOriginOnly,
  };
}

/**
 * Scope check: excludePatterns veto; then a URL qualifies under a seed prefix
 * OR an includePattern; sameOriginOnly additionally restricts to seed origins.
 */
export function isUrlInScope(normalizedUrl: string, rules: CrawlScopeRules): boolean {
  if (rules.excludePatterns.some((re) => re.test(normalizedUrl))) return false;
  let origin: string;
  try {
    origin = new URL(normalizedUrl).origin;
  } catch {
    return false;
  }
  if (rules.sameOriginOnly && !rules.seedOrigins.has(origin)) return false;
  if (rules.seedPrefixes.some((prefix) => normalizedUrl.startsWith(prefix))) return true;
  return rules.includePatterns.some((re) => re.test(normalizedUrl));
}

// ── HTML helpers (pure, exported for tests) ────────────────────────────────────

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', copy: "©",
};

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

/** <title> → first <h1> → null. */
export function extractHtmlTitle(html: string): string | null {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
  if (!title) return null;
  const text = decodeEntities(title.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  return text || null;
}

/**
 * All followable link targets in an HTML page, resolved against the page URL
 * (honoring <base href>), normalized, deduped. rel=nofollow and non-http(s)
 * schemes are skipped. Regex-based on purpose — no DOM dependency, and
 * documentation pages are regular enough for it.
 */
export function extractLinks(html: string, pageUrl: string): string[] {
  // Links inside scripts/comments are noise: strip those regions first.
  const scanned = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const baseHref = /<base\b[^>]*\bhref\s*=\s*("([^"]*)"|'([^']*)')/i.exec(scanned);
  const base = normalizeUrl((baseHref?.[2] ?? baseHref?.[3] ?? "").trim() || pageUrl, pageUrl) ?? pageUrl;

  const out = new Set<string>();
  const anchorRe = /<a\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(scanned)) !== null) {
    const attrs = m[1]!;
    if (/\brel\s*=\s*("[^"]*nofollow[^"]*"|'[^']*nofollow[^']*')/i.test(attrs)) continue;
    const href = /\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const target = decodeEntities((href?.[2] ?? href?.[3] ?? href?.[4] ?? "").trim());
    if (!target || target.startsWith("#")) continue;
    if (/^(mailto|javascript|tel|data|ftp):/i.test(target)) continue;
    const normalized = normalizeUrl(target, base);
    if (normalized) out.add(normalized);
  }
  return [...out];
}

/**
 * Built-in HTML → text fallback for when the file-conversion service is down.
 * Keeps heading structure and list bullets so engram's chunker still sees
 * document shape; drops nav/boilerplate containers entirely.
 */
export function htmlToMarkdownFallback(html: string): string {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(nav|header|footer|aside|noscript|svg|form)\b[\s\S]*?<\/\1>/gi, "");
  s = s
    .replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, inner: string) => {
      const text = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      return text ? `\n\n${"#".repeat(Number(level))} ${text}\n\n` : "\n";
    })
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|section|article|tr|table|ul|ol|blockquote|pre)>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<td[^>]*>|<th[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(s)
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── robots.txt (minimal parser, exported for tests) ───────────────────────────

export interface RobotsRules {
  /** [allow, pathPrefixPattern] pairs from the applicable User-agent group(s). */
  rules: Array<{ allow: boolean; pattern: string }>;
}

/**
 * Parse the User-agent groups applying to `agentToken` (falling back to `*`).
 * Longest-match wins, Allow beats Disallow on equal length — the de-facto
 * standard resolution. `*` wildcards and `$` anchors in rule paths supported.
 */
export function parseRobots(body: string, agentToken: string): RobotsRules {
  const token = agentToken.toLowerCase();
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; pattern: string }> }> = [];
  let current: { agents: string[]; rules: Array<{ allow: boolean; pattern: string }> } | null = null;
  let lastWasAgent = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === "user-agent") {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === "allow" || field === "disallow") {
      lastWasAgent = false;
      if (current) current.rules.push({ allow: field === "allow", pattern: value });
    } else {
      lastWasAgent = false;
    }
  }

  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && token.includes(a)));
  const applicable = specific.length > 0 ? specific : groups.filter((g) => g.agents.includes("*"));
  return { rules: applicable.flatMap((g) => g.rules) };
}

function robotsPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped.endsWith("\\$") ? escaped.slice(0, -2) + "$" : escaped}`);
}

/** Longest-match-wins robots decision for a URL path (+query). Empty rules → allowed. */
export function isAllowedByRobots(rules: RobotsRules, url: string): boolean {
  let target: string;
  try {
    const u = new URL(url);
    target = u.pathname + u.search;
  } catch {
    return false;
  }
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of rules.rules) {
    if (!rule.pattern) {
      // "Disallow:" (empty) = allow everything — a zero-length allow match.
      if (!best) best = { allow: true, length: 0 };
      continue;
    }
    if (robotsPatternToRegExp(rule.pattern).test(target)) {
      const length = rule.pattern.replace(/\*/g, "").length;
      if (!best || length > best.length || (length === best.length && rule.allow && !best.allow)) {
        best = { allow: rule.allow, length };
      }
    }
  }
  return best ? best.allow : true;
}

// ── guarded fetch ─────────────────────────────────────────────────────────────

async function hostIsBlocked(host: string): Promise<boolean> {
  // Lazy import: web.ts registers tools as an import side effect; keep that out
  // of module-load order here (same pattern as document-rag → multimodal).
  const { isPrivateHost } = await import("../tools/web.js");
  const h = host.toLowerCase();
  if (isPrivateHost(h)) return true;
  try {
    const records = await dnsLookup(h, { all: true });
    if (records.some((r) => isPrivateHost(r.address))) return true;
  } catch {
    /* DNS failure — allow through (IP literal / unavailable resolver), matching web_fetch */
  }
  return false;
}

interface CrawlFetchResult {
  ok: boolean;
  status: number;
  contentType: string;
  /** Fully-downloaded body (empty for redirects, which are followed internally). */
  bytes: Uint8Array;
  /** True when the body was truncated because it exceeded maxBytes mid-stream. */
  oversize: boolean;
  /** URL after redirects (normalized) — scope + dedup are re-applied to it. */
  finalUrl: string;
}

/** Sentinel thrown when the streaming read exceeds the byte cap; caller treats it as a skip. */
class OversizeError extends Error {}

/**
 * fetch() with the web_fetch SSRF discipline: manual redirects, host re-check
 * per hop (skippable via allowPrivateHosts for internal-wiki instances),
 * http(s)-only, crawler User-Agent. The per-page timeout AND the crawl-level
 * abort signal cover the ENTIRE transfer including the body read — the body is
 * streamed inside the guarded window and capped at maxBytes so a slow-trickle
 * or oversized response cannot wedge a worker forever (review finding: a body
 * read outside the timeout window blocked the crawl indefinitely and leaked a
 * concurrency slot). Returns the downloaded bytes rather than a live Response.
 */
async function crawlFetch(url: string, opts: { timeoutMs: number; maxBytes: number; userAgent: string; allowPrivateHosts: boolean; signal: AbortSignal }): Promise<CrawlFetchResult> {
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    const parsed = new URL(current); // caller passes normalized http(s) URLs
    if (!opts.allowPrivateHosts && (await hostIsBlocked(parsed.hostname))) {
      throw new Error(`blocked private/internal host: ${parsed.hostname}`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    const onOuterAbort = () => controller.abort();
    opts.signal.addEventListener("abort", onOuterAbort, { once: true });
    try {
      const res = await fetch(current, {
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": opts.userAgent, Accept: "text/html,application/xhtml+xml,application/pdf,text/plain,text/markdown;q=0.9,*/*;q=0.5" },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
        // Drain/cancel the redirect body so the connection is freed, then follow.
        try { await res.body?.cancel(); } catch { /* ignore */ }
        const next = normalizeUrl(res.headers.get("location")!, current);
        if (!next) throw new Error("redirect to a non-http(s) target");
        current = next;
        continue;
      }
      const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
      // Declared-length fast reject (when present) before streaming a byte.
      const declared = Number(res.headers.get("content-length") ?? 0);
      if (declared > opts.maxBytes) {
        try { await res.body?.cancel(); } catch { /* ignore */ }
        return { ok: res.ok, status: res.status, contentType, bytes: new Uint8Array(0), oversize: true, finalUrl: current };
      }
      // Stream the body inside the guarded window, aborting as soon as the cap is passed.
      let bytes = new Uint8Array(0);
      let oversize = false;
      if (res.body) {
        const reader = res.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              total += value.byteLength;
              if (total > opts.maxBytes) {
                oversize = true;
                controller.abort();
                throw new OversizeError();
              }
              chunks.push(value);
            }
          }
        } catch (err) {
          if (!(err instanceof OversizeError)) throw err;
        } finally {
          try { reader.releaseLock(); } catch { /* ignore */ }
        }
        if (!oversize) {
          bytes = new Uint8Array(total);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        }
      }
      return { ok: res.ok, status: res.status, contentType, bytes, oversize, finalUrl: current };
    } finally {
      clearTimeout(timer);
      opts.signal.removeEventListener("abort", onOuterAbort);
    }
  }
  throw new Error("too many redirects");
}

// ── crawl manager ─────────────────────────────────────────────────────────────

interface ActiveCrawl {
  controller: AbortController;
  startedAt: number;
  /** Resolves when runCrawl (and its status finalization) has fully settled —
   *  awaited by deleteKnowledgeBase so no in-flight ingest lands post-delete. */
  done: Promise<void>;
}

const activeCrawls = new Map<string, ActiveCrawl>();

export function isCrawlActive(kbId: string): boolean {
  return activeCrawls.has(kbId);
}

export type StartCrawlResult = { ok: true } | { ok: false; error: string };

/**
 * Start a crawl for a KB in the background. Returns immediately; progress and
 * completion are persisted to the KB registry (poll via list/get).
 */
export async function startKbCrawl(kbId: string): Promise<StartCrawlResult> {
  const cfg = getConfig().retrieval.knowledgeBases;
  if (!cfg.enabled) return { ok: false, error: "knowledge bases are disabled (retrieval.knowledgeBases.enabled)" };
  if (!engramConfigured()) return { ok: false, error: "document RAG (engram) is not enabled — knowledge bases require it" };
  if (activeCrawls.has(kbId)) return { ok: false, error: "a crawl is already running for this knowledge base" };
  if (activeCrawls.size >= cfg.maxConcurrentCrawls) {
    return { ok: false, error: `crawl limit reached (${cfg.maxConcurrentCrawls} concurrent) — try again when a running crawl finishes` };
  }

  // Reserve the slot SYNCHRONOUSLY (before the first await) so two concurrent
  // starts for this KB — e.g. the REST route and an agent tool firing at once —
  // cannot both pass the .has()/size checks (single-threaded, but the checks
  // and the set() straddled an await). A placeholder controller is swapped for
  // the real one once the KB resolves.
  let resolveDone: () => void = () => {};
  const donePromise = new Promise<void>((resolve) => { resolveDone = resolve; });
  const controller = new AbortController();
  activeCrawls.set(kbId, { controller, startedAt: Date.now(), done: donePromise });

  const kb = await getKnowledgeBase(kbId);
  if (!kb) {
    activeCrawls.delete(kbId);
    resolveDone();
    return { ok: false, error: `knowledge base "${kbId}" not found` };
  }
  // getKnowledgeBase also resolves by name; re-key the reservation to the
  // canonical id (and bail if a crawl is already active under that id).
  if (kb.id !== kbId) {
    activeCrawls.delete(kbId);
    if (activeCrawls.has(kb.id)) {
      resolveDone();
      return { ok: false, error: "a crawl is already running for this knowledge base" };
    }
    activeCrawls.set(kb.id, { controller, startedAt: Date.now(), done: donePromise });
  }
  // A stale "crawling" status (interrupted run) is fine to restart over; a LIVE
  // one in another process is indistinguishable, so trust cancelRequested +
  // stable doc ids to keep even that pathological overlap idempotent.

  const startedAt = new Date().toISOString();
  await mutateKnowledgeBase(kb.id, (record) => {
    record.status = "crawling";
    delete record.cancelRequested;
    record.lastCrawl = { startedAt, pagesVisited: 0, pagesIngested: 0, pagesSkippedUnchanged: 0, pagesFailed: 0 };
  });

  void runCrawl(kb.id, controller.signal)
    .catch((err) => {
      log.error({ err, kbId: kb.id }, "crawl crashed");
      return mutateKnowledgeBase(kb.id, (record) => {
        record.status = "failed";
        if (record.lastCrawl) {
          record.lastCrawl.finishedAt = new Date().toISOString();
          record.lastCrawl.stopReason = "error";
          record.lastCrawl.error = err instanceof Error ? err.message : String(err);
        }
      });
    })
    .finally(() => {
      activeCrawls.delete(kb.id);
      resolveDone();
    });

  return { ok: true };
}

/**
 * Request cancellation: aborts the local run and sets the cooperative flag so
 * a crawl owned by ANOTHER process stops at its next progress checkpoint.
 */
export async function cancelKbCrawl(kbId: string): Promise<boolean> {
  const active = activeCrawls.get(kbId);
  if (active) active.controller.abort();
  const kb = await mutateKnowledgeBase(kbId, (record) => {
    if (record.status === "crawling") record.cancelRequested = true;
  });
  return Boolean(active) || kb?.status === "crawling";
}

/**
 * Delete a KB: cancel any running crawl, hard-delete every crawled page from
 * engram (KB documents have exactly one source, so this never touches other
 * scopes), then drop the record. Engram deletions are best-effort — engram
 * being down must not leave the KB undeletable; stragglers are reported.
 */
export async function deleteKnowledgeBase(kbId: string): Promise<{ ok: boolean; error?: string; documentsRemoved: number; documentsFailed: number }> {
  const kb = await getKnowledgeBase(kbId);
  if (!kb) return { ok: false, error: `knowledge base "${kbId}" not found`, documentsRemoved: 0, documentsFailed: 0 };

  await cancelKbCrawl(kb.id);
  // Wait for an in-process crawl to actually stop before deleting, so a page
  // still mid-ingest cannot land in engram AFTER we clear the corpus (bounded
  // so a wedged crawl can't make delete hang forever). Then re-read the record
  // to catch any pages the crawl added between cancel and stop.
  const active = activeCrawls.get(kb.id);
  if (active) {
    await Promise.race([active.done, new Promise((resolve) => setTimeout(resolve, 30_000))]);
  }
  const fresh = await getKnowledgeBase(kb.id);

  let removed = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  const pages = Object.values(fresh?.pages ?? kb.pages ?? {});
  for (const page of pages) {
    if (await engramDeleteDocument(page.documentId)) {
      removed += 1;
      consecutiveFailures = 0;
    } else {
      failed += 1;
      consecutiveFailures += 1;
      if (consecutiveFailures >= 10) {
        // engram is clearly down/hung — don't grind through hundreds of doomed
        // deletes. The record still goes away; orphaned chunks can be cleaned
        // by a future re-create + delete or an engram wipe.
        failed += pages.length - removed - failed;
        log.warn({ kbId: kb.id, removed, failed }, "aborting engram cleanup after repeated failures");
        break;
      }
    }
  }
  await removeKnowledgeBaseRecord(kb.id);
  log.info({ kbId: kb.id, removed, failed }, "knowledge base deleted");
  return { ok: true, documentsRemoved: removed, documentsFailed: failed };
}

// ── the crawl itself ──────────────────────────────────────────────────────────

interface FrontierItem {
  url: string;
  depth: number;
}

async function runCrawl(kbId: string, signal: AbortSignal): Promise<void> {
  const cfg = getConfig().retrieval.knowledgeBases;
  const loaded = await getKnowledgeBase(kbId);
  if (!loaded) return;
  const kb: KnowledgeBaseRecord = loaded; // re-bind so closures below see the narrowed type

  const rules = buildScopeRules(kb);
  const source = kbSource(kb.id);
  const deadline = Date.now() + cfg.maxCrawlMs;

  const stats: KbCrawlStats = {
    startedAt: new Date().toISOString(),
    pagesVisited: 0,
    pagesIngested: 0,
    pagesSkippedUnchanged: 0,
    pagesFailed: 0,
  };

  const frontier: FrontierItem[] = [];
  const seen = new Set<string>();
  const seenThisRun = new Map<string, { documentId: string }>();
  // Pages that FAILED to fetch/convert/ingest this run. Exempted from orphan
  // cleanup so a transient error (rate-limit, downed conversion service) on a
  // re-crawl never hard-deletes a still-valid page (review finding).
  const failedThisRun = new Set<string>();
  // Post-redirect final URLs already being processed by a peer worker — closes
  // the concurrency>=2 window where two frontier URLs redirect to the same page.
  const inFlightUrls = new Set<string>();
  // Frontier hard cap: pathological pages can emit thousands of in-scope links.
  const frontierCap = Math.max(kb.maxPages * 5, 500);

  for (const seed of kb.seedUrls) {
    const normalized = normalizeUrl(seed);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      frontier.push({ url: normalized, depth: 0 });
    }
  }

  const robotsCache = new Map<string, RobotsRules | null>();
  async function robotsFor(origin: string): Promise<RobotsRules | null> {
    if (robotsCache.has(origin)) return robotsCache.get(origin) ?? null;
    let parsed: RobotsRules;
    try {
      const result = await crawlFetch(`${origin}/robots.txt`, {
        timeoutMs: Math.min(cfg.pageTimeoutMs, 10_000),
        maxBytes: 512_000, // robots.txt is tiny; cap defensively
        userAgent: cfg.userAgent,
        allowPrivateHosts: cfg.allowPrivateHosts,
        signal,
      });
      if (result.ok && !result.oversize) {
        parsed = parseRobots(new TextDecoder("utf-8", { fatal: false }).decode(result.bytes), cfg.userAgent);
      } else {
        // 4xx (incl. 404) = no restrictions; 5xx = be conservative, treat as unknown-allowed too.
        parsed = { rules: [] };
      }
    } catch {
      parsed = { rules: [] }; // unreachable robots — do not block the crawl
    }
    robotsCache.set(origin, parsed);
    return parsed;
  }

  // Per-host politeness: minimum interval between request STARTS to one host.
  const lastRequestAt = new Map<string, number>();
  async function politenessGate(host: string): Promise<void> {
    while (true) {
      const now = Date.now();
      const last = lastRequestAt.get(host) ?? 0;
      const waitMs = last + cfg.requestDelayMs - now;
      if (waitMs <= 0) {
        lastRequestAt.set(host, now);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 250)));
      if (signal.aborted) return;
    }
  }

  let cancelRequested = false;
  let lastPersist = 0;
  async function persistProgress(force = false): Promise<void> {
    const now = Date.now();
    if (!force && now - lastPersist < 2000) return;
    lastPersist = now;
    const record = await mutateKnowledgeBase(kb.id, (r) => {
      r.lastCrawl = { ...stats, queueRemaining: frontier.length };
    });
    if (record?.cancelRequested) cancelRequested = true;
  }

  function stopReasonNow(): CrawlStopReason | null {
    if (signal.aborted || cancelRequested) return "cancelled";
    if (Date.now() > deadline) return "timeout";
    if (stats.pagesVisited >= kb.maxPages) return "maxPages";
    return null;
  }

  async function processPage(item: FrontierItem): Promise<void> {
    const pageUrl = item.url;
    stats.currentUrl = pageUrl;
    // Best-known registry key for this page (updated to the post-redirect URL
    // once known) so a thrown failure marks the RIGHT key as failed-not-removed.
    let attemptedKey = pageUrl;

    try {
      const origin = new URL(pageUrl).origin;
      if (kb.respectRobots) {
        const robots = await robotsFor(origin);
        if (robots && !isAllowedByRobots(robots, pageUrl)) return; // no fetch → no page-budget spend
      }
      if (signal.aborted) return;

      await politenessGate(new URL(pageUrl).hostname);
      if (signal.aborted) return;
      stats.pagesVisited += 1;

      const result = await crawlFetch(pageUrl, {
        timeoutMs: cfg.pageTimeoutMs,
        maxBytes: cfg.maxPageBytes,
        userAgent: cfg.userAgent,
        allowPrivateHosts: cfg.allowPrivateHosts,
        signal,
      });
      const finalUrl = result.finalUrl;
      attemptedKey = finalUrl;
      // A transient failure must not later be read as "page removed from the
      // site" — mark it so orphan cleanup spares the previously-indexed page.
      if (!result.ok) {
        stats.pagesFailed += 1;
        failedThisRun.add(finalUrl);
        return;
      }
      if (result.oversize) return; // too large — skip (not a failure, not a removal)
      // Redirects can land off-scope (login pages, canonical hosts) or on an
      // already-crawled/in-flight page. Re-apply scope; dedup on the FINAL URL
      // unconditionally (a directly-fetched URL can also be another URL's
      // redirect target within the same run), and reserve it against peers.
      if (finalUrl !== pageUrl && !isUrlInScope(finalUrl, rules)) return;
      if (seenThisRun.has(finalUrl) || inFlightUrls.has(finalUrl)) return;
      inFlightUrls.add(finalUrl);
      seen.add(finalUrl);

      const buffer = result.bytes;
      const contentType = result.contentType;
      let markdown = "";
      let title: string | null = null;

      if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
        const html = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
        title = extractHtmlTitle(html);

        // Enqueue in-scope links BEFORE conversion so a conversion failure
        // doesn't orphan the page's outbound links.
        if (item.depth < kb.maxDepth) {
          for (const link of extractLinks(html, finalUrl)) {
            if (seen.has(link) || frontier.length >= frontierCap) continue;
            if (!isUrlInScope(link, rules) || isSkippableAsset(link)) continue;
            seen.add(link);
            frontier.push({ url: link, depth: item.depth + 1 });
          }
        }

        const { extractDocumentBytesToMarkdown } = await import("../tools/multimodal.js");
        markdown = (await extractDocumentBytesToMarkdown(buffer, "page.html", "text/html")).trim();
        if (!markdown) markdown = htmlToMarkdownFallback(html);
      } else if (contentType.includes("application/pdf") || (buffer.byteLength >= 5 && buffer.slice(0, 5).every((b, i) => "%PDF-".charCodeAt(i) === b))) {
        const { extractDocumentBytesToMarkdown } = await import("../tools/multimodal.js");
        markdown = (await extractDocumentBytesToMarkdown(buffer, "page.pdf", "application/pdf")).trim();
      } else if (contentType.includes("text/plain") || contentType.includes("text/markdown")) {
        markdown = new TextDecoder("utf-8", { fatal: false }).decode(buffer).trim();
      } else {
        return; // not an ingestible content type
      }

      if (!markdown) {
        stats.pagesFailed += 1;
        failedThisRun.add(finalUrl);
        return;
      }

      const pageKey = finalUrl;
      const documentId = kbDocumentId(kb.id, pageKey);
      const pageTitle = title ?? new URL(pageKey).pathname;
      const text = `# ${pageTitle}\n\nSource URL: ${pageKey}\nKnowledge base: ${kb.name}\n\n${markdown}`;
      const contentHash = createHash("sha256").update(text).digest("hex");
      const now = new Date().toISOString();

      const existing = kb.pages[pageKey];
      if (existing && existing.contentHash === contentHash) {
        stats.pagesSkippedUnchanged += 1;
        seenThisRun.set(pageKey, { documentId });
        await mutateKnowledgeBase(kb.id, (r) => {
          const page = r.pages[pageKey];
          if (page) page.lastSeenAt = now;
        });
        return;
      }

      const ingested = await engramIngest({ text, source, title: pageTitle, documentId });
      if (!ingested) {
        stats.pagesFailed += 1;
        failedThisRun.add(pageKey);
        return;
      }
      stats.pagesIngested += 1;
      seenThisRun.set(pageKey, { documentId });
      await mutateKnowledgeBase(kb.id, (r) => {
        r.pages[pageKey] = {
          documentId: ingested.documentId,
          url: pageKey,
          title: pageTitle,
          contentHash,
          chunkCount: ingested.chunkCount,
          lastIngestedAt: now,
          lastSeenAt: now,
        };
      });
    } catch (err) {
      if (!signal.aborted) {
        stats.pagesFailed += 1;
        failedThisRun.add(attemptedKey); // spare the prior-run page from orphan cleanup
        log.debug({ err, url: pageUrl, kbId: kb.id }, "page crawl failed");
      }
    }
  }

  // Small worker pool over the shared frontier. Workers idle-wait briefly when
  // the queue is empty but a peer is still mid-page (it may push new links).
  let inFlight = 0;
  let stopReason: CrawlStopReason | null = null;
  async function worker(): Promise<void> {
    while (true) {
      stopReason = stopReason ?? stopReasonNow();
      if (stopReason) return;
      const item = frontier.shift();
      if (!item) {
        if (inFlight === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      inFlight += 1;
      try {
        await processPage(item);
      } finally {
        inFlight -= 1;
      }
      await persistProgress();
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, cfg.concurrency) }, () => worker()));
  stopReason = stopReason ?? "completed";

  // Orphan cleanup — ONLY after a run that exhausted the frontier: a partial
  // run (budget/cancel) simply didn't visit the rest, and deleting those pages
  // would shred the corpus. A page that was VISITED but failed this run
  // (failedThisRun) is likewise spared — a transient 5xx / rate-limit / downed
  // conversion service is not evidence the page was removed from the site.
  let pagesRemoved = 0;
  if (stopReason === "completed") {
    const fresh = await getKnowledgeBase(kb.id);
    const known = Object.values(fresh?.pages ?? {});
    for (const page of known) {
      if (seenThisRun.has(page.url) || failedThisRun.has(page.url)) continue;
      if (await engramDeleteDocument(page.documentId)) {
        pagesRemoved += 1;
        await mutateKnowledgeBase(kb.id, (r) => {
          delete r.pages[page.url];
        });
      }
    }
  }

  delete stats.currentUrl;
  stats.finishedAt = new Date().toISOString();
  stats.stopReason = stopReason;
  stats.pagesRemoved = pagesRemoved;
  const failedHard = stats.pagesIngested === 0 && stats.pagesSkippedUnchanged === 0 && stats.pagesVisited > 0;

  await mutateKnowledgeBase(kb.id, (record) => {
    record.status = stopReason === "cancelled"
      ? (Object.keys(record.pages).length > 0 ? "ready" : "idle")
      : failedHard ? "failed" : "ready";
    delete record.cancelRequested;
    record.lastCrawl = { ...stats, queueRemaining: frontier.length };
    if (failedHard) record.lastCrawl.error = "no page could be fetched and ingested — check seed URLs, robots policy, and engram availability";
  });

  log.info(
    { kbId: kb.id, visited: stats.pagesVisited, ingested: stats.pagesIngested, unchanged: stats.pagesSkippedUnchanged, failed: stats.pagesFailed, removed: pagesRemoved, stopReason },
    "crawl finished",
  );
}
