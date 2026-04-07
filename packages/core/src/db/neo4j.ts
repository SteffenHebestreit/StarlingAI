/**
 * Neo4j connection singleton.
 *
 * Used by tools/graph.ts for all graph read/write operations.
 * Connects lazily on first use; gracefully unavailable if NEO4J_URL is unset.
 */
import neo4j, { type Driver, type Session, type QueryResult } from "neo4j-driver";
import { childLogger } from "../logger.js";

const log = childLogger("db:neo4j");

let _driver: Driver | null = null;
let _available = false;

export function getNeo4jDriver(): Driver | null {
  if (_driver) return _driver;

  const url = process.env["NEO4J_URL"];
  const user = process.env["NEO4J_USER"] ?? "neo4j";
  const password = process.env["NEO4J_PASSWORD"];

  if (!url || !password) return null;

  try {
    _driver = neo4j.driver(url, neo4j.auth.basic(user, password), {
      maxConnectionPoolSize: 20,
      connectionAcquisitionTimeout: 5000,
      connectionTimeout: 5000,
      logging: { level: "warn", logger: (level, message) => log.warn({ level }, message) },
    });
    _available = true;
    log.info({ url }, "Neo4j driver created");
    return _driver;
  } catch (err) {
    log.warn({ err }, "Failed to create Neo4j driver");
    return null;
  }
}

export function isNeo4jAvailable(): boolean {
  return _available && _driver !== null;
}

/** Run a Cypher query. Returns null if Neo4j is unavailable. */
export async function runCypher(
  cypher: string,
  params: Record<string, unknown> = {},
  opts: { write?: boolean } = {},
): Promise<QueryResult | null> {
  const driver = getNeo4jDriver();
  if (!driver) return null;

  const session: Session = driver.session({
    defaultAccessMode: opts.write ? neo4j.session.WRITE : neo4j.session.READ,
  });

  try {
    const result = opts.write
      ? await session.executeWrite(tx => tx.run(cypher, params))
      : await session.executeRead(tx => tx.run(cypher, params));
    return result;
  } catch (err) {
    log.error({ err, cypher: cypher.slice(0, 200) }, "Cypher query failed");
    throw err;
  } finally {
    await session.close();
  }
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
  }
}
