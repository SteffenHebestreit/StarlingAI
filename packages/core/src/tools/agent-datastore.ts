/**
 * Agent data store tools — read, write, and delete temporary data
 * across Redis and PostgreSQL backends.
 *
 * Agents use a logical namespace; the ephemeral store routes to the
 * correct backend automatically. All entries expire after 24 hours.
 */
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import {
  ephemeralPut,
  ephemeralGet,
  ephemeralQuery,
  ephemeralDelete,
  NAMESPACE_ROUTES,
} from "../runtime/ephemeral-store/index.js";
import { childLogger } from "../logger.js";

const log = childLogger("tool:agent-datastore");

const AVAILABLE_NAMESPACES = Object.keys(NAMESPACE_ROUTES);

const NAMESPACE_DESC =
  "Logical data namespace. Available namespaces: " +
  AVAILABLE_NAMESPACES.map((ns) => `"${ns}"`).join(", ") +
  '. Use "agent-kv" for general-purpose key-value storage.';

// ── agent_store_write ───────────────────────────────────────────────────────

registerTool({
  name: "agent_store_write",
  description:
    "Store temporary data in the agent data store. Entries automatically expire after 24 hours. " +
    "Data is routed to the appropriate backend (Redis or Postgres) based on namespace.",
  parameters: {
    type: "object",
    properties: {
      namespace: {
        type: "string",
        description: NAMESPACE_DESC,
      },
      key: {
        type: "string",
        description:
          "Unique key within the namespace. Use descriptive keys like 'session:<id>:result' or 'agent:<name>:draft'. Max 512 chars.",
      },
      value: {
        type: "string",
        description: "The data to store (JSON string recommended). Max 1MB.",
      },
    },
    required: ["namespace", "key", "value"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const namespace = String(args["namespace"] ?? "").trim();
    const key = String(args["key"] ?? "").trim();
    const value = String(args["value"] ?? "");

    if (!namespace) return { success: false, output: "", error: "namespace is required" };
    if (!key) return { success: false, output: "", error: "key is required" };
    if (key.length > 512) return { success: false, output: "", error: "key exceeds 512 character limit" };
    if (value.length > 1_048_576) return { success: false, output: "", error: "value exceeds 1MB limit" };

    try {
      await ephemeralPut({
        namespace,
        key,
        value,
        sessionId: ctx.sessionId,
      });

      log.info({ namespace, key, sessionId: ctx.sessionId, valueLen: value.length }, "agent_store_write");

      return {
        success: true,
        output: `Stored ${value.length} chars at ${namespace}:${key} (expires in 24h)`,
        metadata: { namespace, key, valueLength: value.length },
      };
    } catch (err) {
      log.error({ err, namespace, key }, "agent_store_write failed");
      return { success: false, output: "", error: `Write failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});

// ── agent_store_read ────────────────────────────────────────────────────────

registerTool({
  name: "agent_store_read",
  description:
    "Read temporary data from the agent data store. " +
    "Can retrieve a single entry by key or query multiple entries by prefix.",
  parameters: {
    type: "object",
    properties: {
      namespace: {
        type: "string",
        description: NAMESPACE_DESC,
      },
      key: {
        type: "string",
        description: "Exact key to retrieve. Omit to query by prefix.",
      },
      keyPrefix: {
        type: "string",
        description: "Key prefix for querying multiple entries (e.g. 'session:abc:'). Ignored if key is set.",
      },
      limit: {
        type: "number",
        description: "Max entries to return when querying by prefix (default 20, max 100).",
      },
    },
    required: ["namespace"],
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const namespace = String(args["namespace"] ?? "").trim();
    const key = args["key"] ? String(args["key"]).trim() : undefined;
    const keyPrefix = args["keyPrefix"] ? String(args["keyPrefix"]).trim() : undefined;
    const limit = Math.min(Number(args["limit"]) || 20, 100);

    if (!namespace) return { success: false, output: "", error: "namespace is required" };

    try {
      if (key) {
        const entry = await ephemeralGet(namespace, key);
        if (!entry) {
          return { success: true, output: `No entry found at ${namespace}:${key}`, metadata: { found: false } };
        }
        return {
          success: true,
          output: entry.value,
          metadata: {
            namespace: entry.namespace,
            key: entry.key,
            createdAt: entry.createdAt,
            expiresAt: entry.expiresAt,
            found: true,
          },
        };
      }

      // Query by prefix
      const entries = await ephemeralQuery({ namespace, keyPrefix, limit });
      if (entries.length === 0) {
        return {
          success: true,
          output: `No entries found in ${namespace}${keyPrefix ? ` with prefix "${keyPrefix}"` : ""}`,
          metadata: { count: 0 },
        };
      }

      const lines = entries.map(
        (e) => `**${e.key}** (${new Date(e.expiresAt).toISOString()}): ${e.value.slice(0, 200)}${e.value.length > 200 ? "..." : ""}`,
      );

      return {
        success: true,
        output: `## ${entries.length} entries in ${namespace}\n\n${lines.join("\n\n")}`,
        metadata: { count: entries.length },
      };
    } catch (err) {
      return { success: false, output: "", error: `Read failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});

// ── agent_store_delete ──────────────────────────────────────────────────────

registerTool({
  name: "agent_store_delete",
  description: "Delete a temporary data entry from the agent data store.",
  parameters: {
    type: "object",
    properties: {
      namespace: {
        type: "string",
        description: NAMESPACE_DESC,
      },
      key: {
        type: "string",
        description: "Key of the entry to delete.",
      },
    },
    required: ["namespace", "key"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const namespace = String(args["namespace"] ?? "").trim();
    const key = String(args["key"] ?? "").trim();

    if (!namespace) return { success: false, output: "", error: "namespace is required" };
    if (!key) return { success: false, output: "", error: "key is required" };

    try {
      const deleted = await ephemeralDelete(namespace, key);

      log.info({ namespace, key, deleted, sessionId: ctx.sessionId }, "agent_store_delete");

      return {
        success: true,
        output: deleted ? `Deleted ${namespace}:${key}` : `No entry found at ${namespace}:${key}`,
        metadata: { namespace, key, deleted },
      };
    } catch (err) {
      return { success: false, output: "", error: `Delete failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
});
