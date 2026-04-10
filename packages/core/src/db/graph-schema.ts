/**
 * MemGraph schema bootstrap.
 *
 * Creates all label-property indexes and the vector index for MemoryRecord nodes.
 * Called once on startup from index.ts — idempotent (existing indexes are silently skipped).
 *
 * Index syntax uses MemGraph's native form: CREATE INDEX ON :Label(property)
 * Vector index uses MemGraph's vector search: CREATE VECTOR INDEX ... WITH CONFIG {...}
 */

import { isNeo4jAvailable, runCypher } from "./neo4j.js";
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

// Vector index for embedding-based similarity search via MAGE vector_search module.
// Dimension must match the embedding model in use (1536 = standard OpenAI / LMStudio default).
// Override with GRAPH_EMBEDDING_DIM env var.
const EMBEDDING_DIM = parseInt(process.env["GRAPH_EMBEDDING_DIM"] ?? "1536", 10);
const VECTOR_INDEX_NAME = "memory_embedding";
const VECTOR_INDEX_CYPHER = `
  CREATE VECTOR INDEX ${VECTOR_INDEX_NAME}
  ON :MemoryRecord(embedding)
  WITH CONFIG {"dimension": ${EMBEDDING_DIM}, "capacity": 10000, "metric": "cos"}
`;

// ── Bootstrap ─────────────────────────────────────────────────────────────────

/**
 * Ensure all graph indexes exist. Safe to call multiple times — duplicate
 * index errors are caught and logged at DEBUG level.
 */
export async function initGraphSchema(): Promise<void> {
  if (!isNeo4jAvailable()) {
    log.debug("MemGraph not available — skipping schema init");
    return;
  }

  let created = 0;
  let skipped = 0;

  for (const { name, cypher } of LABEL_INDEXES) {
    try {
      await runCypher(cypher, {}, { write: true });
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

  try {
    await runCypher(VECTOR_INDEX_CYPHER, {}, { write: true });
    created++;
    log.debug({ name: VECTOR_INDEX_NAME }, "Vector index created");
  } catch (err) {
    const msg = String((err as Error).message ?? "").toLowerCase();
    if (msg.includes("already exists") || msg.includes("index exists")) {
      skipped++;
      log.debug({ name: VECTOR_INDEX_NAME }, "Vector index already exists — skipped");
    } else {
      log.warn({ err }, "Vector index creation failed — vector similarity links will not be built");
    }
  }

  log.info({ created, skipped }, "MemGraph schema initialized");
}
