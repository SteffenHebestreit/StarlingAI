/**
 * Unified pgvector store — the single semantic-retrieval backend.
 *
 * One Postgres table (`vector_embeddings`) holds embeddings for every
 * collection (skills, memory, RAG document chunks, …) with an HNSW cosine
 * index, replacing per-feature flat-file embeddings + in-process cosine scans.
 * This is what makes large collections (e.g. chunked long inputs / attachments
 * for retrieval-augmented prompting) scale instead of being held in memory.
 *
 * Requires the `vector` extension (the `pgvector/pgvector` image ships it).
 * Every operation degrades gracefully: if Postgres or the extension is
 * unavailable, search returns `null` and writes return `false` so callers fall
 * back to their previous behaviour without error.
 *
 * The embedding dimension is probed once from the active embedding model, so
 * the column matches whatever model is configured (nomic-embed = 768).
 */
import pg from "pg";
import { childLogger } from "../logger.js";
import { computeQueryEmbedding } from "../providers/embeddings.js";

const log = childLogger("db:vector-store");
const { Pool } = pg;

const TABLE = "vector_embeddings";
const MAX_K = 100;

let _pool: pg.Pool | null = null;
let _dim = 0;
let _ready = false;
let _initInflight: Promise<boolean> | null = null;
let _initFailedLogged = false;

export interface VectorHit {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  /** Cosine similarity in [0, 1] (1 - cosine distance). */
  score: number;
}

export interface VectorUpsert {
  collection: string;
  id: string;
  content: string;
  metadata?: Record<string, unknown>;
  /** Precomputed embedding; computed from `content` when omitted. */
  embedding?: Float32Array | number[];
}

/** True once the extension + table are ready and a dimension is known. */
export function isVectorStoreReady(): boolean {
  return _ready;
}

/** Probed embedding dimension (0 until ready). */
export function vectorStoreDimension(): number {
  return _dim;
}

function getPool(): pg.Pool | null {
  if (_pool) return _pool;
  const url = process.env["DATABASE_URL"];
  if (!url) return null;
  _pool = new Pool({ connectionString: url, max: 3 });
  return _pool;
}

/**
 * Initialize the extension, table, and indexes. Idempotent and re-attemptable —
 * if the embedding model is not ready yet at boot it returns false and a later
 * upsert/search call will retry. Safe to call from bootstrap.
 */
export async function initVectorStore(): Promise<boolean> {
  if (_ready) return true;
  if (_initInflight) return _initInflight;
  _initInflight = doInit().finally(() => { _initInflight = null; });
  return _initInflight;
}

async function doInit(): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;

  // The vector column is fixed-dimension, so we must know the model's output
  // size before creating the table. Probe the active embedding model.
  const probe = await computeQueryEmbedding("vector store dimension probe");
  if (!probe || probe.length === 0) {
    log.debug("Embedding model not ready; deferring pgvector init");
    return false;
  }
  _dim = probe.length;

  try {
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");

    // Self-heal on embedding-dimension change: if the table already exists with
    // a different vector dimension (e.g. the embedding model was swapped), drop
    // it so it is recreated at the current size. The stored vectors would be the
    // wrong dimension and unusable anyway.
    const existing = await pool.query<{ dim: number }>(
      `SELECT a.atttypmod AS dim
       FROM pg_attribute a JOIN pg_class c ON a.attrelid = c.oid
       WHERE c.relname = $1 AND a.attname = 'embedding' AND a.attnum > 0 AND NOT a.attisdropped`,
      [TABLE],
    );
    const existingDim = existing.rows[0]?.dim;
    if (typeof existingDim === "number" && existingDim > 0 && existingDim !== _dim) {
      log.warn({ existingDim, newDim: _dim }, "Embedding dimension changed — recreating vector_embeddings (old vectors dropped)");
      await pool.query(`DROP TABLE IF EXISTS ${TABLE}`);
    }

    await pool.query(
      `CREATE TABLE IF NOT EXISTS ${TABLE} (
         collection TEXT NOT NULL,
         id         TEXT NOT NULL,
         content    TEXT NOT NULL,
         metadata   JSONB NOT NULL DEFAULT '{}'::jsonb,
         embedding  vector(${_dim}) NOT NULL,
         created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
         PRIMARY KEY (collection, id)
       )`,
    );
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_vec_collection ON ${TABLE} (collection)`);
    // HNSW cosine index for fast approximate nearest-neighbour search.
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_vec_hnsw ON ${TABLE} USING hnsw (embedding vector_cosine_ops)`,
    );
    _ready = true;
    _initFailedLogged = false;
    log.info({ dim: _dim }, "pgvector store ready");
    return true;
  } catch (err) {
    if (!_initFailedLogged) {
      log.error({ err }, "pgvector init failed (extension/table) — semantic search will fall back");
      _initFailedLogged = true;
    }
    _ready = false;
    return false;
  }
}

function toVectorLiteral(v: Float32Array | number[]): string {
  return `[${Array.from(v).join(",")}]`;
}

/** Store or overwrite one embedding. Returns false when the store is unavailable. */
export async function vectorUpsert(entry: VectorUpsert): Promise<boolean> {
  if (!_ready && !(await initVectorStore())) return false;
  const pool = getPool();
  if (!pool) return false;

  const vec = entry.embedding ?? await computeQueryEmbedding(entry.content);
  if (!vec || vec.length !== _dim) return false;

  try {
    await pool.query(
      `INSERT INTO ${TABLE} (collection, id, content, metadata, embedding)
       VALUES ($1, $2, $3, $4::jsonb, $5::vector)
       ON CONFLICT (collection, id)
       DO UPDATE SET content = $3, metadata = $4::jsonb, embedding = $5::vector, created_at = NOW()`,
      [entry.collection, entry.id, entry.content, JSON.stringify(entry.metadata ?? {}), toVectorLiteral(vec)],
    );
    return true;
  } catch (err) {
    log.warn({ err, collection: entry.collection, id: entry.id }, "vector upsert failed");
    return false;
  }
}

/** Batch upsert. Returns the number of rows written. */
export async function vectorUpsertMany(entries: VectorUpsert[]): Promise<number> {
  let written = 0;
  for (const entry of entries) {
    if (await vectorUpsert(entry)) written += 1;
  }
  return written;
}

/**
 * Nearest-neighbour search within a collection. Returns hits ordered by
 * descending similarity, or `null` when the store is unavailable (so the caller
 * can fall back). An empty array means the store is available but had no match.
 */
export async function vectorSearch(
  collection: string,
  query: string | Float32Array | number[],
  opts: { k?: number; filter?: Record<string, unknown>; minScore?: number } = {},
): Promise<VectorHit[] | null> {
  if (!_ready && !(await initVectorStore())) return null;
  const pool = getPool();
  if (!pool) return null;

  const vec = typeof query === "string" ? await computeQueryEmbedding(query) : query;
  if (!vec || vec.length !== _dim) return null;

  const k = Math.max(1, Math.min(MAX_K, opts.k ?? 8));
  const literal = toVectorLiteral(vec);

  const params: unknown[] = [collection, literal];
  let where = "collection = $1";
  if (opts.filter && Object.keys(opts.filter).length > 0) {
    params.push(JSON.stringify(opts.filter));
    where += ` AND metadata @> $${params.length}::jsonb`;
  }
  params.push(k);

  try {
    const { rows } = await pool.query(
      `SELECT id, content, metadata, 1 - (embedding <=> $2::vector) AS score
       FROM ${TABLE}
       WHERE ${where}
       ORDER BY embedding <=> $2::vector
       LIMIT $${params.length}`,
      params,
    );
    const minScore = opts.minScore ?? 0;
    return rows
      .map((row): VectorHit => ({
        id: String(row.id),
        content: String(row.content ?? ""),
        metadata: (row.metadata as Record<string, unknown>) ?? {},
        score: Number(row.score),
      }))
      .filter((hit) => hit.score >= minScore);
  } catch (err) {
    log.warn({ err, collection }, "vector search failed");
    return null;
  }
}

/** Delete one entry. */
export async function vectorDelete(collection: string, id: string): Promise<boolean> {
  if (!_ready) return false;
  const pool = getPool();
  if (!pool) return false;
  try {
    const { rowCount } = await pool.query(`DELETE FROM ${TABLE} WHERE collection = $1 AND id = $2`, [collection, id]);
    return (rowCount ?? 0) > 0;
  } catch (err) {
    log.warn({ err, collection, id }, "vector delete failed");
    return false;
  }
}

/** Delete an entire collection (or all entries matching an id prefix). Returns rows removed. */
export async function vectorDeleteCollection(collection: string, idPrefix?: string): Promise<number> {
  if (!_ready) return 0;
  const pool = getPool();
  if (!pool) return 0;
  try {
    const { rowCount } = idPrefix
      ? await pool.query(`DELETE FROM ${TABLE} WHERE collection = $1 AND id LIKE $2`, [collection, `${idPrefix}%`])
      : await pool.query(`DELETE FROM ${TABLE} WHERE collection = $1`, [collection]);
    return rowCount ?? 0;
  } catch (err) {
    log.warn({ err, collection }, "vector collection delete failed");
    return 0;
  }
}

/** Count entries (optionally within one collection). */
export async function vectorCount(collection?: string): Promise<number> {
  if (!_ready) return 0;
  const pool = getPool();
  if (!pool) return 0;
  try {
    const { rows } = collection
      ? await pool.query(`SELECT count(*)::int AS n FROM ${TABLE} WHERE collection = $1`, [collection])
      : await pool.query(`SELECT count(*)::int AS n FROM ${TABLE}`);
    return Number(rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

/** Graceful shutdown. */
export async function closeVectorStore(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
  _ready = false;
  _dim = 0;
}

/** Test-only state reset. */
export function _resetVectorStoreForTests(): void {
  _pool = null;
  _ready = false;
  _dim = 0;
  _initInflight = null;
  _initFailedLogged = false;
}
