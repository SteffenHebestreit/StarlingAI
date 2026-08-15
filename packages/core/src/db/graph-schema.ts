/**
 * MemGraph schema bootstrap.
 *
 * Creates all label-property indexes and the vector index for MemoryRecord nodes.
 * Called once on startup from index.ts — idempotent (existing indexes are silently skipped).
 *
 * Index syntax uses MemGraph's native form: CREATE INDEX ON :Label(property)
 * Vector index uses MemGraph's vector search: CREATE VECTOR INDEX ... WITH CONFIG {...}
 */

import { isGraphDbAvailable, runCypher, toPlainRecords } from "./neo4j.js";
import { computeQueryEmbedding } from "../providers/embeddings.js";
import { childLogger } from "../logger.js";

const log = childLogger("db:graph-schema");

// ── Label-property indexes ────────────────────────────────────────────────────

const LABEL_INDEXES: Array<{ name: string; cypher: string }> = [
  { name: "MemoryRecord.id",           cypher: "CREATE INDEX ON :MemoryRecord(id)" },
  { name: "MemoryRecord.scope",        cypher: "CREATE INDEX ON :MemoryRecord(scope)" },
  { name: "MemoryRecord.kind",         cypher: "CREATE INDEX ON :MemoryRecord(kind)" },
  { name: "MemoryRecord.domain",       cypher: "CREATE INDEX ON :MemoryRecord(domain)" },
  { name: "MemoryRecord.topic",        cypher: "CREATE INDEX ON :MemoryRecord(topic)" },
  { name: "MemoryRecord.validTo",      cypher: "CREATE INDEX ON :MemoryRecord(validTo)" },
  { name: "MemoryRecord.communityId",  cypher: "CREATE INDEX ON :MemoryRecord(communityId)" },
  { name: "Agent.name",                cypher: "CREATE INDEX ON :Agent(name)" },
  { name: "Session.id",                cypher: "CREATE INDEX ON :Session(id)" },
  { name: "Topic.name",                cypher: "CREATE INDEX ON :Topic(name)" },
  { name: "Entity.name",               cypher: "CREATE INDEX ON :Entity(name)" },
];

// Vector index for embedding-based similarity search via the MAGE vector_search module.
//
// The dimension MUST match the active embedding model or every write is rejected and
// SIMILAR_TO edges are never built — silently, because graphBuildSimilarityLinks
// swallows the failure at debug level. This previously defaulted to a hard-coded 1536
// while the deployed model (Qwen3-Embedding-0.6B) emits 1024, and GRAPH_EMBEDDING_DIM
// was set nowhere, so the index was inert in every default deployment.
//
// So: probe the live model the way db/vector-store.ts does, and self-heal a
// dimension mismatch by dropping and recreating. GRAPH_EMBEDDING_DIM remains an
// explicit override for deployments that cannot reach the model at boot.
const VECTOR_INDEX_NAME = "memory_embedding";
const VECTOR_INDEX_CAPACITY = 10000;

/** Configured override, if any. Returns null when unset or not a positive integer. */
function configuredEmbeddingDim(): number | null {
  const raw = process.env["GRAPH_EMBEDDING_DIM"];
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Dimension of the existing index, or null if it does not exist / cannot be read. */
async function existingVectorIndexDim(): Promise<number | null> {
  try {
    const result = await runCypher("SHOW VECTOR INDEX INFO", {}, { autoCommit: true });
    if (!result) return null;
    for (const row of toPlainRecords(result)) {
      if (String(row["index_name"] ?? "") !== VECTOR_INDEX_NAME) continue;
      const dim = Number(row["dimension"]);
      return Number.isFinite(dim) && dim > 0 ? dim : null;
    }
  } catch (err) {
    log.debug({ err }, "Could not read existing vector index info");
  }
  return null;
}

/**
 * Create the MemoryRecord vector index at the active embedding dimension, dropping
 * a dimension-mismatched one first. No-ops (with a warning) when the dimension
 * cannot be determined — an index at a guessed dimension is worse than none, because
 * it fails invisibly.
 */
async function ensureVectorIndex(): Promise<void> {
  let dim = configuredEmbeddingDim();
  if (dim === null) {
    const probe = await computeQueryEmbedding("graph vector index dimension probe");
    if (probe && probe.length > 0) dim = probe.length;
  }
  if (dim === null) {
    log.warn(
      "Embedding model unreachable and GRAPH_EMBEDDING_DIM unset — skipping vector index. " +
      "Graph similarity (SIMILAR_TO) stays disabled until the next start with the model available.",
    );
    return;
  }

  const existing = await existingVectorIndexDim();
  if (existing !== null && existing !== dim) {
    log.warn({ existingDim: existing, newDim: dim }, "Graph vector index dimension changed — recreating");
    try {
      await runCypher(`DROP VECTOR INDEX ${VECTOR_INDEX_NAME}`, {}, { write: true, autoCommit: true });
    } catch (err) {
      log.warn({ err }, "Could not drop the mismatched vector index — leaving it in place");
      return;
    }
  } else if (existing === dim) {
    log.debug({ dim }, "Graph vector index already at the active embedding dimension");
    return;
  }

  try {
    await runCypher(
      `CREATE VECTOR INDEX ${VECTOR_INDEX_NAME}
       ON :MemoryRecord(embedding)
       WITH CONFIG {"dimension": ${dim}, "capacity": ${VECTOR_INDEX_CAPACITY}, "metric": "cos"}`,
      {}, { write: true, autoCommit: true },
    );
    log.info({ dim }, "Graph vector index ready");
  } catch (err) {
    const msg = String((err as Error).message ?? "").toLowerCase();
    if (msg.includes("already exists") || msg.includes("index exists")) {
      log.debug({ dim }, "Vector index already exists — skipped");
    } else {
      log.warn({ err }, "Vector index creation failed — similarity links will not be built");
    }
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

/**
 * Ensure all graph indexes exist. Safe to call multiple times — duplicate
 * index errors are caught and logged at DEBUG level.
 */
export async function initGraphSchema(): Promise<void> {
  if (!isGraphDbAvailable()) {
    log.debug("MemGraph not available — skipping schema init");
    return;
  }

  let created = 0;
  let skipped = 0;

  for (const { name, cypher } of LABEL_INDEXES) {
    try {
      await runCypher(cypher, {}, { write: true, autoCommit: true });
      created++;
      log.debug({ name }, "Graph index created");
    } catch (err) {
      const msg = String((err as Error).message ?? "").toLowerCase();
      if (msg.includes("already exists") || msg.includes("index exists") || msg.includes("constraint")) {
        skipped++;
        log.debug({ name }, "Graph index already exists — skipped");
      } else {
        log.warn({ err, name }, "Graph index creation failed");
      }
    }
  }

  // Never throws: a probe failure or a rejected DDL degrades to "no similarity
  // links", the same contract every other graph path already honours.
  await ensureVectorIndex();

  log.info({ created, skipped }, "MemGraph schema initialized");
}
