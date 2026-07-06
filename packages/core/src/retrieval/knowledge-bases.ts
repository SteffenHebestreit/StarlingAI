/**
 * Knowledge-base registry — the JSON manifest of named, workspace-shared
 * corpora crawled from documentation sites into engram.
 *
 * Each KB owns an engram source token `kb:<id>`; every crawled page is one
 * engram document with a STABLE id derived from (kb, normalized URL), so a
 * re-crawl replaces changed pages in place, unchanged pages are skipped by
 * content hash, and pages that disappeared from the site are deleted after a
 * complete crawl. engram remains the source of truth for the index; this
 * manifest carries what engram does not store: the crawl configuration, page
 * URLs (for citation), content hashes (change detection), and crawl status.
 *
 * Stored at `<workspace>/uploads/.knowledge-bases.json` — deliberately beside
 * the document registry so the same uploads cleanup / `down -v` lifecycle that
 * drops the engram graph clears the KB manifest too.
 *
 * Like document-registry.ts, writes are serialized per process with a promise
 * chain; concurrent writers in SEPARATE processes (gateway + standalone
 * scene-worker) can race, which is acceptable for this low-traffic manifest.
 * Cross-process crawl CANCELLATION works via the `cancelRequested` flag in the
 * record — the crawling process re-reads its record at each progress persist.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";

const log = childLogger("retrieval:knowledge-bases");

export const KB_SOURCE_PREFIX = "kb:";

/** engram source token for a knowledge base. */
export function kbSource(kbId: string): string {
  return `${KB_SOURCE_PREFIX}${kbId}`;
}

/** Stable engram document id for a crawled page (re-crawl replaces in place). */
export function kbDocumentId(kbId: string, normalizedUrl: string): string {
  const hash = createHash("sha256").update(normalizedUrl).digest("hex").slice(0, 24);
  return `kb-${kbId}-${hash}`;
}

export type KnowledgeBaseStatus = "idle" | "crawling" | "ready" | "failed";

export type CrawlStopReason = "completed" | "maxPages" | "timeout" | "cancelled" | "error";

/**
 * Visibility scope of a knowledge base — the same three-scope model as documents
 * and memory (retrieval/document-rag.ts DocumentScope):
 *   - session:   only the conversation that created it (ephemeral, per-chat)
 *   - user:      the creating user's personal corpus, across their chats
 *   - workspace: shared with everyone on the instance (the default)
 * The engram source token stays `kb:<id>` (unique per KB); isolation is enforced
 * at the registry-ACL layer (callerCanAccessKb) since every KB search targets
 * exactly one KB's source and the ambient union only includes accessible KBs.
 */
export type KbScope = "session" | "user" | "workspace";

/**
 * Per-KB "worker" template — the ephemeral agent that knows how to USE this
 * knowledge base. Managed alongside the knowledge itself (scoped the same way),
 * so "use this KB for task T" instantiates a single-use temporary agent from
 * this spec rather than relying on the orchestrator guessing which specialist to
 * route to. All fields optional; unset falls back to a sensible default worker
 * (KB retrieval + read-only web/site inspection). `tools` are filtered against
 * the ephemeral-agent grantable set at instantiation; the KB's own retrieval
 * tools are always granted regardless.
 */
export interface KbWorkerSpec {
  /** System-prompt instructions for the worker (how to apply this KB to a task). */
  instructions?: string;
  /** Extra tools the worker should have (beyond the always-granted KB retrieval tools). */
  tools?: string[];
  /** Model hints for the worker run. */
  model?: { primary?: string; temperature?: number; maxTokens?: number };
  maxIterations?: number;
  timeoutMs?: number;
}

export interface KbCrawlStats {
  startedAt: string;
  finishedAt?: string;
  /** Pages fetched this run (successful or not). */
  pagesVisited: number;
  /** Pages (re-)ingested into engram this run. */
  pagesIngested: number;
  /** Pages whose content hash was unchanged since the last crawl. */
  pagesSkippedUnchanged: number;
  /** Pages that failed to fetch/convert/ingest. */
  pagesFailed: number;
  /** Stale pages removed after a complete crawl (URL no longer reachable in scope). */
  pagesRemoved?: number;
  /** Frontier size when the run ended (>0 means the page/time budget cut it short). */
  queueRemaining?: number;
  /** URL being processed — progress signal for the UI while crawling. */
  currentUrl?: string;
  stopReason?: CrawlStopReason;
  error?: string;
}

export interface KbPageRecord {
  documentId: string;
  url: string;
  title?: string;
  /** sha256 of the ingested markdown — re-crawl change detection. */
  contentHash: string;
  chunkCount?: number;
  lastIngestedAt: string;
  /** Last crawl run that saw this URL (stale pages are pruned after a complete run). */
  lastSeenAt: string;
}

export interface KnowledgeBaseRecord {
  /** Slug id — also the engram source suffix (`kb:<id>`). */
  id: string;
  name: string;
  description?: string;
  seedUrls: string[];
  /** Crawl bounds (clamped to retrieval.knowledgeBases caps at write time). */
  maxPages: number;
  maxDepth: number;
  /** Regex allow-list widening the default seed-prefix scope (any match = in scope). */
  includePatterns?: string[];
  /** Regex deny-list — a matching URL is never crawled (wins over everything). */
  excludePatterns?: string[];
  /** Restrict the crawl to the seed URLs' origins (default true). When false,
   *  includePatterns MUST be non-empty — otherwise the frontier is unbounded. */
  sameOriginOnly: boolean;
  respectRobots: boolean;
  /** Opt this KB into every turn's [DOCUMENT CONTEXT] retrieval union. Default
   *  false: KBs are queried explicitly (search_knowledge_base) to keep ambient
   *  turn context lean. */
  ambientRetrieval: boolean;
  /** Visibility scope (default "workspace" — legacy records written before scoping
   *  have no field and are treated as workspace). Governs who can see/search/manage it. */
  scope?: KbScope;
  /** Owning user (set when scope === "user") — access is restricted to this user. */
  ownerId?: string;
  /** Owning session (set when scope === "session") — access is restricted to this conversation. */
  sessionId?: string;
  /** The ephemeral agent that works with this KB (see KbWorkerSpec). */
  worker?: KbWorkerSpec;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  status: KnowledgeBaseStatus;
  /** Cooperative cross-process cancel — the crawler polls this at each progress persist. */
  cancelRequested?: boolean;
  lastCrawl?: KbCrawlStats;
  /** normalized URL → page record. */
  pages: Record<string, KbPageRecord>;
}

/** Summary shape for lists (pages map elided — it can hold hundreds of entries). */
export interface KnowledgeBaseSummary {
  id: string;
  name: string;
  description?: string;
  seedUrls: string[];
  status: KnowledgeBaseStatus;
  ambientRetrieval: boolean;
  scope: KbScope;
  ownerId?: string;
  hasWorker: boolean;
  pageCount: number;
  chunkCount: number;
  maxPages: number;
  maxDepth: number;
  createdAt: string;
  updatedAt: string;
  lastCrawl?: KbCrawlStats;
}

/** Identity used for KB access control (mirrors documents' callerManageableSources). */
export interface KbAccessContext {
  userId?: string;
  sessionId?: string;
}

/**
 * True when the caller may see/search/manage this KB. Workspace KBs are visible
 * to everyone; user KBs only to their owner; session KBs only to the owning
 * conversation. In single-user mode (no auth) userId is undefined and user KBs
 * created without an owner remain visible — matching the documents model where
 * the flat instance-wide view applies when auth is disabled.
 */
export function callerCanAccessKb(kb: Pick<KnowledgeBaseRecord, "scope" | "ownerId" | "sessionId">, ctx: KbAccessContext): boolean {
  switch (kb.scope ?? "workspace") { // legacy records (no scope) are workspace-shared
    case "workspace":
      return true;
    case "user":
      return !kb.ownerId || kb.ownerId === ctx.userId;
    case "session":
      return !!ctx.sessionId && kb.sessionId === ctx.sessionId;
    default:
      return false;
  }
}

/** Filter a list of KBs to those the caller may access. */
export function filterAccessibleKbs<T extends Pick<KnowledgeBaseRecord, "scope" | "ownerId" | "sessionId">>(kbs: T[], ctx: KbAccessContext): T[] {
  return kbs.filter((kb) => callerCanAccessKb(kb, ctx));
}

function storePath(): string {
  return join(getConfig().workspacePath, "uploads", ".knowledge-bases.json");
}

interface KbStoreFile {
  version: 1;
  kbs: KnowledgeBaseRecord[];
}

async function readStore(): Promise<KnowledgeBaseRecord[]> {
  try {
    const raw = await readFile(storePath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<KbStoreFile>;
    return Array.isArray(parsed.kbs) ? parsed.kbs : [];
  } catch {
    return []; // missing/corrupt → empty
  }
}

async function writeStore(kbs: KnowledgeBaseRecord[]): Promise<void> {
  const path = storePath();
  await mkdir(dirname(path), { recursive: true });
  const body: KbStoreFile = { version: 1, kbs };
  // Atomic write: the crawler rewrites this file once per ingested page plus
  // every ~2s of progress, so a crash mid-write is a real window. Write to a
  // temp file then rename (atomic on POSIX; MoveFileEx replace on Windows) so a
  // torn write can never truncate the manifest — readStore's catch maps a
  // corrupt file to [], which would silently drop every knowledge base.
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  await rename(tmp, path);
  invalidateAmbientKbCache(); // ambient snapshot below must never outlive a write
}

// Serialize read-modify-write within this process (document-registry pattern).
let _chain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = _chain.then(fn, fn) as Promise<T>;
  _chain = run.then(() => undefined, () => undefined);
  return run;
}

export function toSummary(kb: KnowledgeBaseRecord): KnowledgeBaseSummary {
  const pages = Object.values(kb.pages ?? {});
  return {
    id: kb.id,
    name: kb.name,
    ...(kb.description ? { description: kb.description } : {}),
    seedUrls: kb.seedUrls,
    status: kb.status,
    ambientRetrieval: kb.ambientRetrieval,
    scope: kb.scope ?? "workspace",
    ...(kb.ownerId ? { ownerId: kb.ownerId } : {}),
    hasWorker: !!kb.worker && (!!kb.worker.instructions || (kb.worker.tools?.length ?? 0) > 0),
    pageCount: pages.length,
    chunkCount: pages.reduce((n, p) => n + (p.chunkCount ?? 0), 0),
    maxPages: kb.maxPages,
    maxDepth: kb.maxDepth,
    createdAt: kb.createdAt,
    updatedAt: kb.updatedAt,
    ...(kb.lastCrawl ? { lastCrawl: kb.lastCrawl } : {}),
  };
}

const KB_SCOPES: KbScope[] = ["session", "user", "workspace"];
const MAX_WORKER_TOOLS = 20;
const MAX_WORKER_INSTRUCTIONS = 8000;

/** Validate + normalize a worker template. Returns undefined for an empty spec. */
function validateWorker(worker: unknown): KbResult<KbWorkerSpec | undefined> {
  if (worker === undefined || worker === null) return { ok: true, value: undefined };
  if (typeof worker !== "object") return { ok: false, error: "worker must be an object" };
  const w = worker as Record<string, unknown>;
  const spec: KbWorkerSpec = {};
  if (w["instructions"] !== undefined) {
    const instr = String(w["instructions"] ?? "").trim();
    if (instr.length > MAX_WORKER_INSTRUCTIONS) return { ok: false, error: `worker.instructions exceeds ${MAX_WORKER_INSTRUCTIONS} characters` };
    if (instr) spec.instructions = instr;
  }
  if (w["tools"] !== undefined) {
    if (!Array.isArray(w["tools"])) return { ok: false, error: "worker.tools must be an array of tool names" };
    const tools = [...new Set(w["tools"].map((t) => String(t ?? "").trim()).filter(Boolean))];
    if (tools.length > MAX_WORKER_TOOLS) return { ok: false, error: `worker.tools may have at most ${MAX_WORKER_TOOLS} entries` };
    if (tools.length) spec.tools = tools;
  }
  if (w["maxIterations"] !== undefined) {
    const n = Number(w["maxIterations"]);
    if (Number.isFinite(n)) spec.maxIterations = Math.min(10, Math.max(1, Math.trunc(n)));
  }
  if (w["timeoutMs"] !== undefined) {
    const n = Number(w["timeoutMs"]);
    if (Number.isFinite(n)) spec.timeoutMs = Math.min(600_000, Math.max(60_000, Math.trunc(n)));
  }
  if (w["model"] !== undefined && w["model"] !== null) {
    if (typeof w["model"] !== "object") return { ok: false, error: "worker.model must be an object" };
    const m = w["model"] as Record<string, unknown>;
    const model: KbWorkerSpec["model"] = {};
    if (typeof m["primary"] === "string" && m["primary"].trim()) model.primary = m["primary"].trim();
    if (typeof m["temperature"] === "number") model.temperature = m["temperature"];
    if (typeof m["maxTokens"] === "number") model.maxTokens = m["maxTokens"];
    if (Object.keys(model).length) spec.model = model;
  }
  return { ok: true, value: Object.keys(spec).length ? spec : undefined };
}

const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Derive a slug id from a display name ("W3C Accessibility Docs" → "w3c-accessibility-docs"). */
export function slugifyKbId(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacritics after NFKD
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  return ID_RE.test(slug) ? slug : "";
}

export interface CreateKnowledgeBaseInput {
  id?: string;
  name: string;
  description?: string;
  seedUrls: string[];
  maxPages?: number;
  maxDepth?: number;
  includePatterns?: string[];
  excludePatterns?: string[];
  sameOriginOnly?: boolean;
  respectRobots?: boolean;
  ambientRetrieval?: boolean;
  /** Visibility scope (default "workspace"). session requires sessionId; user requires ownerId. */
  scope?: KbScope;
  /** Owner identity, used to stamp ownership for user-scoped KBs (and attribution). */
  ownerId?: string;
  /** Session identity, used to stamp ownership for session-scoped KBs. */
  sessionId?: string;
  /** Per-KB worker template. */
  worker?: KbWorkerSpec;
  createdBy?: string;
}

export type KbResult<T> = { ok: true; value: T } | { ok: false; error: string };

function validateSeedUrls(seedUrls: unknown): KbResult<string[]> {
  if (!Array.isArray(seedUrls) || seedUrls.length === 0) return { ok: false, error: "at least one seed URL is required" };
  if (seedUrls.length > 20) return { ok: false, error: "at most 20 seed URLs are supported" };
  const cleaned: string[] = [];
  for (const raw of seedUrls) {
    const s = String(raw ?? "").trim();
    let url: URL;
    try {
      url = new URL(s);
    } catch {
      return { ok: false, error: `invalid seed URL: ${s || "(empty)"}` };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, error: `seed URL must be http(s): ${s}` };
    }
    cleaned.push(url.toString());
  }
  return { ok: true, value: [...new Set(cleaned)] };
}

// Bounds on caller-supplied scope regexes. These patterns are compiled and run
// against every discovered URL, and create_knowledge_base is a no-approval
// tier-1 tool any agent can call — so cap count and length to blunt accidental
// or adversarial catastrophic-backtracking (ReDoS) input.
const MAX_PATTERNS = 25;
const MAX_PATTERN_LENGTH = 300;

function validatePatterns(patterns: unknown, label: string): KbResult<string[] | undefined> {
  if (patterns === undefined || patterns === null) return { ok: true, value: undefined };
  if (!Array.isArray(patterns)) return { ok: false, error: `${label} must be an array of regex strings` };
  const cleaned = patterns.map((p) => String(p ?? "").trim()).filter((p) => p.length > 0);
  if (cleaned.length > MAX_PATTERNS) return { ok: false, error: `${label} may have at most ${MAX_PATTERNS} entries` };
  for (const p of cleaned) {
    if (p.length > MAX_PATTERN_LENGTH) return { ok: false, error: `${label} entry exceeds ${MAX_PATTERN_LENGTH} characters: ${p.slice(0, 40)}…` };
    try {
      new RegExp(p);
    } catch {
      return { ok: false, error: `${label} contains an invalid regex: ${p}` };
    }
  }
  return { ok: true, value: cleaned.length > 0 ? cleaned : undefined };
}

export async function createKnowledgeBase(input: CreateKnowledgeBaseInput): Promise<KbResult<KnowledgeBaseRecord>> {
  const cfg = getConfig().retrieval.knowledgeBases;
  const name = String(input.name ?? "").trim();
  if (!name) return { ok: false, error: "name is required" };

  // Explicit id (must be a valid slug) → name slug → hash fallback. The fallback
  // means a name in a non-Latin script or of only symbols (which slugifies to "")
  // still yields a usable id instead of a dead-end 400 the caller can't fix.
  let id: string;
  if (input.id) {
    id = String(input.id).trim().toLowerCase();
    if (!ID_RE.test(id)) return { ok: false, error: "id must be a slug: lowercase letters, digits, hyphens (max 63 chars)" };
  } else {
    id = slugifyKbId(name) || `kb-${createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
  }

  const seeds = validateSeedUrls(input.seedUrls);
  if (!seeds.ok) return seeds;
  const include = validatePatterns(input.includePatterns, "includePatterns");
  if (!include.ok) return include;
  const exclude = validatePatterns(input.excludePatterns, "excludePatterns");
  if (!exclude.ok) return exclude;

  const sameOriginOnly = input.sameOriginOnly !== false;
  if (!sameOriginOnly && !include.value?.length) {
    return { ok: false, error: "sameOriginOnly=false requires non-empty includePatterns — otherwise the crawl frontier is unbounded" };
  }

  const worker = validateWorker(input.worker);
  if (!worker.ok) return worker;

  const scope: KbScope = input.scope && KB_SCOPES.includes(input.scope) ? input.scope : "workspace";
  if (scope === "session" && !input.sessionId) return { ok: false, error: "session-scoped knowledge bases require a sessionId" };
  if (scope === "user" && !input.ownerId) return { ok: false, error: "user-scoped knowledge bases require an authenticated user (ownerId)" };

  const now = new Date().toISOString();
  const record: KnowledgeBaseRecord = {
    id,
    name,
    ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    seedUrls: seeds.value,
    maxPages: Math.min(Math.max(1, input.maxPages ?? cfg.defaultMaxPages), cfg.maxPagesCap),
    maxDepth: Math.min(Math.max(0, input.maxDepth ?? cfg.defaultMaxDepth), cfg.maxDepthCap),
    ...(include.value ? { includePatterns: include.value } : {}),
    ...(exclude.value ? { excludePatterns: exclude.value } : {}),
    sameOriginOnly,
    respectRobots: input.respectRobots !== false,
    ambientRetrieval: input.ambientRetrieval === true,
    scope,
    ...(scope === "user" && input.ownerId ? { ownerId: input.ownerId } : {}),
    ...(scope === "session" && input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(worker.value ? { worker: worker.value } : {}),
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
    createdAt: now,
    updatedAt: now,
    status: "idle",
    pages: {},
  };

  return withLock(async () => {
    const kbs = await readStore();
    if (kbs.some((k) => k.id === id)) return { ok: false as const, error: `a knowledge base with id "${id}" already exists` };
    kbs.push(record);
    await writeStore(kbs);
    log.info({ kbId: id, seeds: record.seedUrls.length }, "knowledge base created");
    return { ok: true as const, value: record };
  });
}

/**
 * A KB left in "crawling" with no live crawl in THIS process was interrupted
 * (restart/crash). Reported as failed so the UI/tools never show a phantom
 * in-progress crawl; crawls are idempotent, so the fix is simply a re-crawl.
 * Only normalizes when the caller passes the live-crawl predicate — reads from
 * a process that never crawls (standalone worker) must not clobber the
 * gateway's active run.
 */
function normalizeStale(kb: KnowledgeBaseRecord, isCrawlActive?: (kbId: string) => boolean): KnowledgeBaseRecord {
  if (kb.status !== "crawling" || !isCrawlActive || isCrawlActive(kb.id)) return kb;
  return {
    ...kb,
    status: "failed",
    lastCrawl: {
      ...(kb.lastCrawl ?? { startedAt: kb.updatedAt, pagesVisited: 0, pagesIngested: 0, pagesSkippedUnchanged: 0, pagesFailed: 0 }),
      stopReason: "error",
      error: "crawl interrupted (process restarted) — start a re-crawl",
    },
  };
}

export async function listKnowledgeBases(opts?: { isCrawlActive?: (kbId: string) => boolean }): Promise<KnowledgeBaseRecord[]> {
  return (await readStore()).map((kb) => normalizeStale(kb, opts?.isCrawlActive));
}

/** Look up by id, or by case-insensitive exact name as a convenience for agents. */
export async function getKnowledgeBase(
  idOrName: string,
  opts?: { isCrawlActive?: (kbId: string) => boolean },
): Promise<KnowledgeBaseRecord | undefined> {
  const needle = idOrName.trim();
  if (!needle) return undefined;
  const kbs = await readStore();
  const found =
    kbs.find((k) => k.id === needle.toLowerCase()) ??
    kbs.find((k) => k.name.toLowerCase() === needle.toLowerCase());
  return found ? normalizeStale(found, opts?.isCrawlActive) : undefined;
}

/** Fields an operator may change after creation (crawl bounds re-clamped). */
export interface UpdateKnowledgeBaseInput {
  name?: string;
  description?: string;
  seedUrls?: string[];
  maxPages?: number;
  maxDepth?: number;
  includePatterns?: string[] | null;
  excludePatterns?: string[] | null;
  sameOriginOnly?: boolean;
  respectRobots?: boolean;
  ambientRetrieval?: boolean;
  /** Change visibility scope. session→needs sessionId; user→needs ownerId (passed alongside). */
  scope?: KbScope;
  ownerId?: string;
  sessionId?: string;
  /** Replace the worker template (null clears it). */
  worker?: KbWorkerSpec | null;
}

export async function updateKnowledgeBase(id: string, patch: UpdateKnowledgeBaseInput): Promise<KbResult<KnowledgeBaseRecord>> {
  const cfg = getConfig().retrieval.knowledgeBases;
  return withLock(async () => {
    const kbs = await readStore();
    const kb = kbs.find((k) => k.id === id);
    if (!kb) return { ok: false as const, error: `knowledge base "${id}" not found` };

    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name) return { ok: false as const, error: "name cannot be empty" };
      kb.name = name;
    }
    if (patch.description !== undefined) {
      const d = String(patch.description).trim();
      if (d) kb.description = d;
      else delete kb.description;
    }
    if (patch.seedUrls !== undefined) {
      const seeds = validateSeedUrls(patch.seedUrls);
      if (!seeds.ok) return seeds;
      kb.seedUrls = seeds.value;
    }
    if (patch.maxPages !== undefined) kb.maxPages = Math.min(Math.max(1, patch.maxPages), cfg.maxPagesCap);
    if (patch.maxDepth !== undefined) kb.maxDepth = Math.min(Math.max(0, patch.maxDepth), cfg.maxDepthCap);
    if (patch.includePatterns !== undefined) {
      const include = validatePatterns(patch.includePatterns ?? undefined, "includePatterns");
      if (!include.ok) return include;
      if (include.value) kb.includePatterns = include.value;
      else delete kb.includePatterns;
    }
    if (patch.excludePatterns !== undefined) {
      const exclude = validatePatterns(patch.excludePatterns ?? undefined, "excludePatterns");
      if (!exclude.ok) return exclude;
      if (exclude.value) kb.excludePatterns = exclude.value;
      else delete kb.excludePatterns;
    }
    if (patch.sameOriginOnly !== undefined) kb.sameOriginOnly = patch.sameOriginOnly;
    if (patch.respectRobots !== undefined) kb.respectRobots = patch.respectRobots;
    if (patch.ambientRetrieval !== undefined) kb.ambientRetrieval = patch.ambientRetrieval;
    if (patch.worker !== undefined) {
      if (patch.worker === null) delete kb.worker;
      else {
        const worker = validateWorker(patch.worker);
        if (!worker.ok) return worker;
        if (worker.value) kb.worker = worker.value;
        else delete kb.worker;
      }
    }
    if (patch.scope !== undefined) {
      if (!KB_SCOPES.includes(patch.scope)) return { ok: false as const, error: `scope must be one of ${KB_SCOPES.join(", ")}` };
      // Re-stamp ownership for the new scope; clear the stamps that no longer apply.
      if (patch.scope === "session") {
        const sid = patch.sessionId ?? kb.sessionId;
        if (!sid) return { ok: false as const, error: "session scope requires a sessionId" };
        kb.scope = "session"; kb.sessionId = sid; delete kb.ownerId;
      } else if (patch.scope === "user") {
        const oid = patch.ownerId ?? kb.ownerId;
        if (!oid) return { ok: false as const, error: "user scope requires an ownerId" };
        kb.scope = "user"; kb.ownerId = oid; delete kb.sessionId;
      } else {
        kb.scope = "workspace"; delete kb.ownerId; delete kb.sessionId;
      }
    }

    if (!kb.sameOriginOnly && !kb.includePatterns?.length) {
      return { ok: false as const, error: "sameOriginOnly=false requires non-empty includePatterns" };
    }

    kb.updatedAt = new Date().toISOString();
    await writeStore(kbs);
    return { ok: true as const, value: kb };
  });
}

/** Apply a mutation to one record under the write lock (crawler status/progress writes). */
export async function mutateKnowledgeBase(
  id: string,
  mutate: (kb: KnowledgeBaseRecord) => void,
): Promise<KnowledgeBaseRecord | undefined> {
  return withLock(async () => {
    const kbs = await readStore();
    const kb = kbs.find((k) => k.id === id);
    if (!kb) return undefined;
    mutate(kb);
    kb.updatedAt = new Date().toISOString();
    await writeStore(kbs);
    return kb;
  });
}

/** Remove the record. The caller (kb-crawler deleteKnowledgeBaseCorpus) deletes the engram documents. */
export async function removeKnowledgeBaseRecord(id: string): Promise<KnowledgeBaseRecord | undefined> {
  return withLock(async () => {
    const kbs = await readStore();
    const idx = kbs.findIndex((k) => k.id === id);
    if (idx < 0) return undefined;
    const [removed] = kbs.splice(idx, 1);
    await writeStore(kbs);
    log.info({ kbId: id }, "knowledge base removed");
    return removed;
  });
}

// Ambient-source cache: retrieval-path reads happen per turn, so keep a
// short-TTL snapshot of the ready+ambient KB descriptors instead of re-reading
// the manifest file on every turn. Descriptors (not just source tokens) are
// cached because the per-turn access filter (scope/owner/session) is applied
// per CALL — two callers in the same TTL window can see different in-scope KBs.
// Busted on every local write (inside writeStore); the TTL covers writes from
// OTHER processes.
interface AmbientKbDescriptor { id: string; scope: KbScope; ownerId?: string; sessionId?: string }
const AMBIENT_TTL_MS = 5_000;
let _ambientCache: { storedAt: number; descriptors: AmbientKbDescriptor[] } | null = null;

export function invalidateAmbientKbCache(): void {
  _ambientCache = null;
}

/**
 * Source tokens of KBs opted into ambient per-turn retrieval (status ready)
 * that THIS caller may access. Workspace ambient KBs join every turn; a user's
 * ambient KB only joins their own turns; a session's ambient KB only that
 * conversation's turns.
 */
export async function ambientKbSources(ctx: KbAccessContext = {}): Promise<string[]> {
  const kbCfg = getConfig().retrieval.knowledgeBases;
  if (!kbCfg.enabled) return [];
  let descriptors = _ambientCache && Date.now() - _ambientCache.storedAt <= AMBIENT_TTL_MS ? _ambientCache.descriptors : null;
  if (!descriptors) {
    const kbs = await readStore();
    descriptors = kbs
      .filter((k) => k.ambientRetrieval && k.status === "ready")
      .map((k) => ({ id: k.id, scope: k.scope ?? "workspace", ...(k.ownerId ? { ownerId: k.ownerId } : {}), ...(k.sessionId ? { sessionId: k.sessionId } : {}) }));
    _ambientCache = { storedAt: Date.now(), descriptors };
  }
  return descriptors.filter((d) => callerCanAccessKb(d, ctx)).map((d) => kbSource(d.id));
}
