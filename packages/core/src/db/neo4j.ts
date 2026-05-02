/**
 * MemGraph connection singleton (Bolt protocol via neo4j-driver).
 *
 * MemGraph speaks Bolt identically to Neo4j, so the same driver is used.
 * Env vars: MEMGRAPH_URL (preferred) or NEO4J_URL (fallback for compat).
 * Auth is optional — MemGraph runs without credentials by default; set
 * MEMGRAPH_PASSWORD if your instance has auth enabled.
 *
 * Used by tools/graph.ts and memory/graph-service.ts for all graph operations.
 */
import neo4j, { type Driver, type Session, type QueryResult } from "neo4j-driver";
import { childLogger } from "../logger.js";

const log = childLogger("db:graph");

let _driver: Driver | null = null;
let _available = false;

export function getNeo4jDriver(): Driver | null {
  if (_driver) return _driver;

  const url = process.env["MEMGRAPH_URL"] ?? process.env["NEO4J_URL"];
  const user = process.env["MEMGRAPH_USER"] ?? process.env["NEO4J_USER"] ?? "";
  const password = process.env["MEMGRAPH_PASSWORD"] ?? process.env["NEO4J_PASSWORD"] ?? "";

  if (!url) return null;

  try {
    _driver = neo4j.driver(url, neo4j.auth.basic(user, password), {
      maxConnectionPoolSize: 20,
      connectionAcquisitionTimeout: 5000,
      connectionTimeout: 5000,
      logging: { level: "warn", logger: (level, message) => log.warn({ level }, message) },
    });
    _available = true;
    log.info({ url }, "MemGraph driver created");
    return _driver;
  } catch (err) {
    log.warn({ err }, "Failed to create MemGraph driver");
    return null;
  }
}

export function isNeo4jAvailable(): boolean {
  // Lazy-init: callers (initGraphSchema, /api/graph/*, the runtime status
  // probe) ask "is MemGraph available?" before any Cypher query.  Without
  // an eager driver attempt here, `_available` stays `false` forever — the
  // schema bootstrap short-circuits, no graph operation ever runs, and the
  // dashboard reports "MemGraph offline" even when MEMGRAPH_URL is wired.
  if (!_driver) getNeo4jDriver();
  return _available && _driver !== null;
}

/**
 * Run a Cypher query. Returns null if Neo4j is unavailable.
 *
 * `opts.autoCommit` runs the query through `session.run()` directly,
 * bypassing the managed-transaction wrapper. Required for DDL on MemGraph
 * (CREATE INDEX, CREATE VECTOR INDEX, …) — MemGraph rejects index
 * manipulation inside multicommand transactions, which is what
 * `executeWrite`/`executeRead` opens. Plain Neo4j accepts both modes.
 */
export async function runCypher(
  cypher: string,
  params: Record<string, unknown> = {},
  opts: { write?: boolean; autoCommit?: boolean } = {},
): Promise<QueryResult | null> {
  const driver = getNeo4jDriver();
  if (!driver) return null;

  const session: Session = driver.session({
    defaultAccessMode: opts.write ? neo4j.session.WRITE : neo4j.session.READ,
  });

  // Bolt sends JS numbers as floats by default.  MemGraph (and Neo4j)
  // rejects float values for clauses that require integers — most commonly
  // `LIMIT $n` ("Limit on number of returned elements must be an integer").
  // Coerce any safe-integer parameter to a Bolt Integer here so call sites
  // can keep using plain JS numbers without per-query wrapping.
  const coerced = coerceIntParams(params);

  try {
    if (opts.autoCommit) {
      return await session.run(cypher, coerced);
    }
    const result = opts.write
      ? await session.executeWrite(tx => tx.run(cypher, coerced))
      : await session.executeRead(tx => tx.run(cypher, coerced));
    return result;
  } catch (err) {
    log.error({ err, cypher: cypher.slice(0, 200) }, "Cypher query failed");
    throw err;
  } finally {
    await session.close();
  }
}

function coerceIntParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(params)) {
    if (typeof val === "number" && Number.isFinite(val) && Number.isInteger(val)) {
      out[key] = neo4j.int(val);
    } else if (Array.isArray(val)) {
      out[key] = val.map((item) =>
        typeof item === "number" && Number.isFinite(item) && Number.isInteger(item)
          ? neo4j.int(item)
          : item,
      );
    } else {
      out[key] = val;
    }
  }
  return out;
}

/** Convert a Neo4j QueryResult to plain JS objects. */
export function toPlainRecords(result: QueryResult): Record<string, unknown>[] {
  return result.records.map(record => {
    const obj: Record<string, unknown> = {};
    for (const key of record.keys) {
      const val = record.get(key);
      obj[key as string] = convertNeo4jValue(val);
    }
    return obj;
  });
}

function convertNeo4jValue(val: unknown): unknown {
  if (val === null || val === undefined) return val;
  // Neo4j integers (neo4j.Integer)
  if (neo4j.isInt(val as Parameters<typeof neo4j.isInt>[0])) return (val as { toNumber(): number }).toNumber();
  // Node
  if (typeof val === "object" && val !== null && "labels" in val && "properties" in val) {
    return { _labels: (val as { labels: string[] }).labels, ...(val as { properties: Record<string, unknown> }).properties };
  }
  // Relationship
  if (typeof val === "object" && val !== null && "type" in val && "properties" in val && "startNodeElementId" in val) {
    return { _type: (val as { type: string }).type, ...(val as { properties: Record<string, unknown> }).properties };
  }
  // Array
  if (Array.isArray(val)) return val.map(convertNeo4jValue);
  return val;
}

export async function closeNeo4j(): Promise<void> {
  if (_driver) {
    await _driver.close();
    _driver = null;
    _available = false;
    log.info("MemGraph driver closed");
  }
}
