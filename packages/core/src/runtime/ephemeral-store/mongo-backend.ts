/**
 * MongoDB backend for ephemeral store.
 *
 * Stores flexible JSON documents in the `agent_data` collection
 * with a TTL index on `expiresAt` for automatic expiration.
 */
import { childLogger } from "../../logger.js";
import type {
  EphemeralBackendDriver,
  EphemeralCleanupResult,
  EphemeralEntry,
  EphemeralQueryFilter,
} from "./types.js";

const log = childLogger("ephemeral:mongo");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _db: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _client: any = null;
let _initialized = false;

async function getCollection(): Promise<unknown | null> {
  if (_initialized) return _db?.collection("agent_data") ?? null;

  const url = process.env["MONGODB_URL"];
  if (!url) {
    _initialized = true;
    return null;
  }

  try {
    const { MongoClient } = await import("mongodb");
    _client = new MongoClient(url);
    await _client.connect();
    _db = _client.db();

    const col = _db.collection("agent_data");

    // Ensure TTL index for automatic expiration
    await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    // Compound index for lookups
    await col.createIndex({ namespace: 1, key: 1 }, { unique: true });
    // Partial indexes for filtered queries
    await col.createIndex({ sessionId: 1 }, { sparse: true });
    await col.createIndex({ agentName: 1 }, { sparse: true });

    _initialized = true;
    log.info("MongoDB ephemeral store connected");
    return col;
  } catch (err) {
    log.error({ err }, "Failed to initialize MongoDB ephemeral store");
    _client = null;
    _db = null;
    _initialized = true;
    return null;
  }
}

export const mongoBackend: EphemeralBackendDriver = {
  name: "mongo",

  async init(): Promise<boolean> {
    return (await getCollection()) !== null;
  },

  async put(entry: EphemeralEntry): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const col = (await getCollection()) as any;
    if (!col) throw new Error("MongoDB not available");

    const doc = {
      namespace: entry.namespace,
      key: entry.key,
      value: entry.value,
      createdAt: new Date(entry.createdAt),
      expiresAt: new Date(entry.expiresAt),
      sessionId: entry.sessionId ?? null,
      agentName: entry.agentName ?? null,
    };

    await col.replaceOne(
      { namespace: entry.namespace, key: entry.key },
      doc,
      { upsert: true },
    );
  },

  async get(namespace: string, key: string): Promise<EphemeralEntry | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const col = (await getCollection()) as any;
    if (!col) return null;

    const doc = await col.findOne({
      namespace,
      key,
      expiresAt: { $gt: new Date() },
    });

    return doc ? docToEntry(doc) : null;
  },

  async query(filter: EphemeralQueryFilter): Promise<EphemeralEntry[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const col = (await getCollection()) as any;
    if (!col) return [];

    const limit = filter.limit ?? 100;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query: Record<string, any> = {
      namespace: filter.namespace,
      expiresAt: { $gt: new Date() },
    };

    if (filter.keyPrefix) {
      query.key = { $regex: `^${escapeRegex(filter.keyPrefix)}` };
    }
    if (filter.sessionId) query.sessionId = filter.sessionId;
    if (filter.agentName) query.agentName = filter.agentName;

    const docs = await col
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();

    return docs.map(docToEntry);
  },

  async delete(namespace: string, key: string): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const col = (await getCollection()) as any;
    if (!col) return false;

    const result = await col.deleteOne({ namespace, key });
    return result.deletedCount > 0;
  },

  async cleanupExpired(): Promise<EphemeralCleanupResult> {
    // MongoDB TTL index handles most cleanup automatically.
    // This manual sweep catches edge cases (clock skew, index lag).
    const start = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const col = (await getCollection()) as any;
    if (!col) {
      return { backend: "mongo", deletedCount: 0, durationMs: 0, error: "not connected" };
    }

    try {
      const result = await col.deleteMany({ expiresAt: { $lte: new Date() } });
      return { backend: "mongo", deletedCount: result.deletedCount, durationMs: Date.now() - start };
    } catch (err) {
      return { backend: "mongo", deletedCount: 0, durationMs: Date.now() - start, error: String(err) };
    }
  },

  async close(): Promise<void> {
    if (_client) {
      try {
        await _client.close();
      } catch {
        // ignore
      }
    }
    _client = null;
    _db = null;
    _initialized = false;
  },
};

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function docToEntry(doc: any): EphemeralEntry {
  return {
    namespace: doc.namespace,
    key: doc.key,
    value: doc.value,
    createdAt: doc.createdAt instanceof Date ? doc.createdAt.toISOString() : String(doc.createdAt),
    expiresAt: doc.expiresAt instanceof Date ? doc.expiresAt.toISOString() : String(doc.expiresAt),
    sessionId: doc.sessionId ?? undefined,
    agentName: doc.agentName ?? undefined,
  };
}
