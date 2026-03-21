/**
 * Workspace-scoped persistent memory tools.
 *
 * Entries are stored as JSON files under <workspacePath>/.starlingai/memory/.
 * No external database required — the workspace directory acts as the store.
 *
 * memory_store  — write or overwrite an entry by key
 * memory_search — full-text substring search across keys, content, and tags
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import { appendOutcome, readRecentOutcomes } from "../agent/outcomes.js";
import { writeSharedFact, readAllFacts, searchSharedFacts } from "../swarm/memory.js";
import { getConfig } from "../config/loader.js";
import { getEmbeddingProvider } from "../providers/index.js";

const log = childLogger("tool:memory");
const MEMORY_SUBDIR = ".starlingai/memory";

function memoryDir(workspacePath: string): string {
  return resolve(workspacePath, MEMORY_SUBDIR);
}

function ensureDir(workspacePath: string): string {
  const dir = memoryDir(workspacePath);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function safeKey(raw: string): string {
  return raw.trim().replace(/[^a-z0-9_-]/gi, "_").slice(0, 100);
}

interface MemoryEntry {
  key: string;
  content: string;
  tags: string[];
  storedAt: string;
  updatedAt: string;
}

registerTool({
  name: "memory_store",
  description:
    "Persist a piece of information in the workspace memory store. " +
    "Use a descriptive, stable key (e.g. 'project_goals', 'client_preferences'). " +
    "Overwrites any previous entry with the same key. " +
    "Memory survives across sessions within this workspace.",
  parameters: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "Unique identifier for this memory entry (letters, numbers, underscores, hyphens)",
      },
      content: {
        type: "string",
        description: "The information to store",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Optional tags for categorisation (e.g. ['client', 'deadline'])",
      },
    },
    required: ["key", "content"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const key = safeKey(String(args["key"] ?? ""));
    const content = String(args["content"] ?? "").trim();
    const tags = Array.isArray(args["tags"]) ? args["tags"].map(String) : [];

    if (!key) return { success: false, output: "", error: "key is required" };
    if (!content) return { success: false, output: "", error: "content is required" };

    try {
      const dir = ensureDir(ctx.workspacePath);
      const existing: Partial<MemoryEntry> = existsSync(join(dir, `${key}.json`))
        ? JSON.parse(readFileSync(join(dir, `${key}.json`), "utf-8"))
        : {};
      const entry: MemoryEntry = {
        key,
        content,
        tags,
        storedAt: existing.storedAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(join(dir, `${key}.json`), JSON.stringify(entry, null, 2), "utf-8");
      return {
        success: true,
        output: `Memory stored: '${key}' (${content.length} chars)`,
        metadata: { key },
      };
    } catch (err) {
      log.error({ err, key }, "memory_store failed");
      return { success: false, output: "", error: `Failed to store memory: ${String(err)}` };
    }
  },
});

registerTool({
  name: "memory_search",
  description:
    "Search the workspace memory store for entries matching a keyword. " +
    "Matches against entry key, content, and tags. " +
    "Returns up to `limit` results (default 10).",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Search term — matched as a case-insensitive substring",
      },
      limit: {
        type: "number",
        description: "Maximum results to return (default 10, max 50)",
        default: 10,
      },
    },
    required: ["query"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = String(args["query"] ?? "").trim().toLowerCase();
    const limit = Math.min(50, Math.max(1, Number(args["limit"] ?? 10)));

    if (!query) return { success: false, output: "", error: "query is required" };

    const dir = memoryDir(ctx.workspacePath);
    if (!existsSync(dir)) {
      return { success: true, output: "No memories stored yet in this workspace.", metadata: { count: 0 } };
    }

    try {
      const files = readdirSync(dir).filter(f => f.endsWith(".json"));
      const results: MemoryEntry[] = [];

      for (const file of files) {
        if (results.length >= limit) break;
        try {
          const entry = JSON.parse(readFileSync(resolve(dir, file), "utf-8")) as MemoryEntry;
          const haystack = `${entry.key} ${entry.content} ${(entry.tags ?? []).join(" ")}`.toLowerCase();
          if (haystack.includes(query)) results.push(entry);
        } catch { /* skip corrupted entries */ }
      }

      if (results.length === 0) {
        return { success: true, output: `No memories found matching '${query}'.`, metadata: { count: 0 } };
      }

      const formatted = results
        .map(r =>
          `**${r.key}**${r.tags.length ? ` [${r.tags.join(", ")}]` : ""} _(${r.updatedAt.slice(0, 10)})_\n${r.content.substring(0, 500)}${r.content.length > 500 ? "…" : ""}`
        )
        .join("\n\n---\n\n");

      return {
        success: true,
        output: `Found ${results.length} memory entry(ies) for '${query}':\n\n${formatted}`,
        metadata: { count: results.length },
      };
    } catch (err) {
      log.error({ err, query }, "memory_search failed");
      return { success: false, output: "", error: `Search failed: ${String(err)}` };
    }
  },
});

registerTool({
  name: "record_lesson",
  description:
    "Record a lesson learned from this task execution. " +
    "Use this when you discover something important about how to succeed or fail at a type of task — " +
    "e.g. 'SearXNG works better with shorter keyword queries', or 'freelancermap.de requires JS rendering'. " +
    "The lesson is attached to your agent name and injected into the orchestrator's context in future sessions.",
  parameters: {
    type: "object",
    properties: {
      lesson: {
        type: "string",
        description: "A concise, actionable lesson (1-2 sentences max). State what failed and what to do instead.",
      },
      outcome: {
        type: "string",
        enum: ["success", "failure", "partial"],
        description: "Whether the current task ended in success, failure, or partial result",
      },
    },
    required: ["lesson", "outcome"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const lesson = String(args["lesson"] ?? "").trim();
    const outcome = (args["outcome"] === "success" || args["outcome"] === "partial") ? args["outcome"] : "failure";

    if (!lesson) return { success: false, output: "", error: "lesson is required" };

    // Derive agent name from sessionId (sub:parentId:agentName:timestamp)
    const parts = ctx.sessionId.split(":");
    const agentName = parts.length >= 3 ? parts[2]! : "unknown";

    // Read the most recent outcome for this agent and attach the lesson
    const recents = readRecentOutcomes(ctx.workspacePath, 20);
    const latest = [...recents].reverse().find(o => o.agent === agentName);

    appendOutcome(ctx.workspacePath, {
      ts: new Date().toISOString(),
      agent: agentName,
      task: latest?.task ?? "(lesson recorded explicitly)",
      outcome,
      iterations: latest?.iterations ?? 0,
      totalTokens: latest?.totalTokens ?? 0,
      lesson,
    });

    log.info({ agentName, outcome, lesson }, "Lesson recorded");
    return {
      success: true,
      output: `Lesson recorded for agent "${agentName}": "${lesson}"`,
      metadata: { agentName, outcome },
    };
  },
});

registerTool({
  name: "share_finding",
  description:
    "Publish a key finding to the session's shared memory so other agents in this swarm session can read it. " +
    "Use this for facts that other agents will need: resolved hostnames, fetched credentials, computed values, " +
    "API responses that shouldn't be re-fetched, or conclusions another agent should build on. " +
    "Format: share a concise key (snake_case) and the finding value. " +
    "Example: key='resolved_base_url', value='https://api.example.com/v2'",
  parameters: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "Short snake_case identifier for this finding (e.g. 'user_email', 'api_base_url')",
      },
      value: {
        type: "string",
        description: "The finding value — keep concise (max 2000 chars)",
      },
    },
    required: ["key", "value"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const key = String(args["key"] ?? "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 80);
    const value = String(args["value"] ?? "").trim();

    if (!key) return { success: false, output: "", error: "key is required" };
    if (!value) return { success: false, output: "", error: "value is required" };

    // Derive parent session ID from sub-agent sessionId (format: sub:parentId:agentName:ts)
    const parts = ctx.sessionId.split(":");
    const parentSessionId = parts.length >= 2 ? parts.slice(0, 2).join(":") : ctx.sessionId;

    await writeSharedFact(parentSessionId, key, value);
    log.info({ key, parentSessionId }, "Shared finding published");

    return {
      success: true,
      output: `Finding published to shared session memory: '${key}' = "${value.slice(0, 120)}${value.length > 120 ? "…" : ""}"`,
      metadata: { key, parentSessionId },
    };
  },
});

registerTool({
  name: "read_shared_facts",
  description:
    "Read all shared facts published by other agents in this swarm session. " +
    "Use this at the start of a task to avoid duplicating work already done by a sibling agent. " +
    "Returns all key/value pairs stored via share_finding or FACT: lines in previous agent outputs.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Optional semantic or keyword query to return only the most relevant shared facts.",
      },
      maxResults: {
        type: "number",
        description: "Maximum number of shared facts to return when query is provided (default 5, max 10).",
        default: 5,
      },
    },
    required: [],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const parts = ctx.sessionId.split(":");
    const parentSessionId = parts.length >= 2 ? parts.slice(0, 2).join(":") : ctx.sessionId;
    const query = String(args["query"] ?? "").trim();

    const config = getConfig();
    const embeddingModel = config.agents.defaults.model.embeddingModel;

    if (query) {
      const matches = await searchSharedFacts(parentSessionId, query, {
        maxResults: Number(args["maxResults"] ?? 5),
        provider: embeddingModel ? getEmbeddingProvider() : undefined,
        embeddingModel,
      });

      if (matches.length === 0) {
        return {
          success: true,
          output: `No shared facts matched \"${query}\" for this session.`,
          metadata: { count: 0, query },
        };
      }

      const formattedMatches = matches
        .map((match) => `**${match.key}** (${Math.round(match.score * 100)}%): ${match.value}`)
        .join("\n");
      return {
        success: true,
        output: `## Shared Session Facts matching \"${query}\" (${matches.length})\n\n${formattedMatches}`,
        metadata: { count: matches.length, query },
      };
    }

    const facts = await readAllFacts(parentSessionId);
    const entries = Object.entries(facts);

    if (entries.length === 0) {
      return {
        success: true,
        output: "No shared facts available yet for this session.",
        metadata: { count: 0 },
      };
    }

    const formatted = entries.map(([k, v]) => `**${k}**: ${v}`).join("\n");
    return {
      success: true,
      output: `## Shared Session Facts (${entries.length})\n\n${formatted}`,
      metadata: { count: entries.length },
    };
  },
});
