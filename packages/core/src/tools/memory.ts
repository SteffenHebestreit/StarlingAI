/**
 * Workspace-scoped persistent memory tools.
 *
 * Entries are stored as JSON files under <workspacePath>/.starlingai/memory/.
 * No external database required — the workspace directory acts as the store.
 *
 * memory_store  — write or overwrite an entry by key
 * memory_search — full-text substring search across keys, content, and tags
 */
import { randomUUID } from "node:crypto";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import { appendOutcome, readRecentOutcomes } from "../agent/outcomes.js";
import { appendAgentMessage, writeSharedFact, readAllFacts, searchSharedFacts } from "../swarm/memory.js";
import { emitSwarmEvent } from "../swarm/bus.js";
import { logAudit } from "../audit/logger.js";
import { isAgentMessagingSuppressed } from "../agent/warden.js";
import { readPromotedAgents } from "../agent/promoted-agents.js";
import { getConfig } from "../config/loader.js";
import { getEmbeddingProvider } from "../providers/index.js";
import { getSession } from "../agent/session.js";
import {
  compactUserMemoryRecords,
  compactWorkspaceMemoryRecords,
  promoteMemoryRecords,
  searchMemoryRecords,
  storeUserMemoryRecord,
  storeWorkspaceMemoryRecord,
  type DurableMemoryScope,
  type MemoryKind,
  type MemoryScope,
} from "../memory/service.js";
import {
  loadMainAssistantPersonality,
  updateMainAssistantPersonality,
  type MainAssistantPersonalityUpdate,
} from "../personality/service.js";

const log = childLogger("tool:memory");

/**
 * Publish a finding to the shared session memory.
 * Exported for use by the cron scheduler and other internal callers.
 */
export async function shareFinding(sessionId: string, key: string, value: string): Promise<void> {
  const parentSessionId = deriveSharedSessionId(sessionId);
  const sanitizedKey = key.trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 80);
  await writeSharedFact(parentSessionId, sanitizedKey, value.trim());
}

function deriveSharedSessionId(sessionId: string): string {
  const parts = sessionId.split(":");
  return parts.length >= 2 ? parts.slice(0, 2).join(":") : sessionId;
}

function deriveAgentName(sessionId: string): string {
  const parts = sessionId.split(":");
  return parts.length >= 3 ? parts[2]! : "orchestrator";
}

function resolveBroadcastTargets(fromAgent: string, args: Record<string, unknown>): string[] {
  const config = getConfig();
  const promotedAgents = readPromotedAgents(config.workspacePath);
  const allAgents = { ...promotedAgents, ...config.subAgents };
  const targetAgent = String(args["targetAgent"] ?? "").trim();
  const domain = String(args["domain"] ?? "").trim().toLowerCase();
  const tags = Array.isArray(args["tags"])
    ? args["tags"].map(String).map((tag) => tag.trim().toLowerCase()).filter(Boolean)
    : [];
  const exclude = new Set([
    fromAgent,
    ...(Array.isArray(args["excludeAgents"]) ? args["excludeAgents"] : []).map(String),
  ]);

  if (targetAgent) {
    return allAgents[targetAgent] && !exclude.has(targetAgent) ? [targetAgent] : [];
  }

  if (!domain && tags.length === 0) return [];

  return Object.entries(allAgents)
    .filter(([name, cfg]) => {
      if (exclude.has(name)) return false;
      if (domain && String(cfg.domain ?? "").trim().toLowerCase() !== domain) return false;
      if (tags.length > 0) {
        const keywords = new Set([
          ...(cfg.tags ?? []).map((entry) => entry.toLowerCase()),
          ...(cfg.capabilities ?? []).map((entry) => entry.toLowerCase()),
        ]);
        if (!tags.every((tag) => keywords.has(tag))) return false;
      }
      return true;
    })
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right));
}

function safeKey(raw: string): string {
  return raw.trim().replace(/[^a-z0-9_-]/gi, "_").slice(0, 100);
}

registerTool({
  name: "memory_store",
  description:
    "Persist a piece of information in the durable memory store. " +
    "Use a descriptive, stable key (e.g. 'project_goals', 'client_preferences'). " +
    "Overwrites any previous entry with the same key. " +
    "Use scope='workspace' for repo-local memory and scope='user' for durable cross-workspace preferences or habits.",
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
      kind: {
        type: "string",
        enum: ["note", "fact", "preference", "lesson", "decision", "summary"],
        description: "Optional durable memory kind for retrieval quality (default: note).",
      },
      subject: {
        type: "string",
        description: "Optional human-readable subject line used during retrieval. Defaults to the key.",
      },
      scope: {
        type: "string",
        enum: ["workspace", "user"],
        description: "Durable destination scope. Use 'user' for cross-workspace preferences or long-lived personal defaults.",
      },
    },
    required: ["key", "content"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const key = safeKey(String(args["key"] ?? ""));
    const content = String(args["content"] ?? "").trim();
    const tags = Array.isArray(args["tags"]) ? args["tags"].map(String) : [];
    const kind = String(args["kind"] ?? "").trim().toLowerCase() as MemoryKind | "";
    const subject = String(args["subject"] ?? "").trim();
    const scope = String(args["scope"] ?? "workspace").trim().toLowerCase() as DurableMemoryScope | "";

    if (!key) return { success: false, output: "", error: "key is required" };
    if (!content) return { success: false, output: "", error: "content is required" };
    if (scope !== "workspace" && scope !== "user") return { success: false, output: "", error: "scope must be 'workspace' or 'user'" };

    try {
      const entry = (scope === "user" ? storeUserMemoryRecord : storeWorkspaceMemoryRecord)(ctx.workspacePath, {
        key,
        content,
        tags,
        kind: kind || undefined,
        subject: subject || undefined,
      });
      return {
        success: true,
        output: `${scope === "user" ? "User" : "Workspace"} memory stored: '${entry.key ?? key}' as ${entry.kind} (${content.length} chars)`,
        metadata: { key: entry.key ?? key, kind: entry.kind, subject: entry.subject, scope: entry.scope },
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
    "Search memory across user-global, workspace, session-shared facts, and agent lessons/flow memory. " +
    "Matches against subject, content, tags, and memory kind. " +
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
      scopes: {
        type: "array",
        items: { type: "string", enum: ["workspace", "user", "session", "agent"] },
        description: "Optional scope filter. Defaults to all scopes.",
      },
      kinds: {
        type: "array",
        items: { type: "string", enum: ["note", "fact", "preference", "lesson", "decision", "summary"] },
        description: "Optional memory kind filter.",
      },
      targetAgent: {
        type: "string",
        description: "Optional agent name filter when searching agent-specific memory.",
      },
    },
    required: ["query"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = String(args["query"] ?? "").trim().toLowerCase();
    const limit = Math.min(50, Math.max(1, Number(args["limit"] ?? 10)));
    const scopes = Array.isArray(args["scopes"])
      ? args["scopes"].map(String).filter((value): value is MemoryScope => value === "workspace" || value === "user" || value === "session" || value === "agent")
      : undefined;
    const kinds = Array.isArray(args["kinds"])
      ? args["kinds"].map(String).filter((value): value is MemoryKind => ["note", "fact", "preference", "lesson", "decision", "summary"].includes(value))
      : undefined;
    const targetAgent = String(args["targetAgent"] ?? "").trim() || undefined;

    if (!query) return { success: false, output: "", error: "query is required" };

    try {
      const results = await searchMemoryRecords(ctx.workspacePath, query, {
        limit,
        scopes,
        kinds,
        sessionId: deriveSharedSessionId(ctx.sessionId),
        targetAgent,
      });

      if (results.length === 0) {
        return { success: true, output: `No memories found matching '${query}'.`, metadata: { count: 0 } };
      }

      const formatted = results
        .map((r) =>
          `**[${r.scope}/${r.kind}] ${r.subject}**${r.tags.length ? ` [${r.tags.join(", ")}]` : ""} _(${r.updatedAt.slice(0, 10)})_\n${r.content.substring(0, 500)}${r.content.length > 500 ? "…" : ""}`
        )
        .join("\n\n---\n\n");

      return {
        success: true,
        output: `Found ${results.length} memory entry(ies) for '${query}':\n\n${formatted}`,
        metadata: { count: results.length, scopes: scopes ?? ["workspace", "user", "session", "agent"] },
      };
    } catch (err) {
      log.error({ err, query }, "memory_search failed");
      return { success: false, output: "", error: `Search failed: ${String(err)}` };
    }
  },
});

registerTool({
  name: "assistant_personality_view",
  description:
    "Read the persistent main-assistant personality profile. " +
    "Use this when the user asks about your persona, tone, or long-lived style, or before making a durable personality adjustment.",
  parameters: {
    type: "object",
    properties: {},
  },
  async execute(): Promise<ToolResult> {
    const profile = loadMainAssistantPersonality();
    const lines = [
      `Revision: ${profile.revision}`,
      `Updated: ${profile.updatedAt} by ${profile.updatedBy}`,
      profile.reason ? `Reason: ${profile.reason}` : "",
      "",
      `Identity: ${profile.identity.core}`,
      profile.voice.tone.length ? `Tone: ${profile.voice.tone.join(" | ")}` : "",
      profile.voice.style.length ? `Style: ${profile.voice.style.join(" | ")}` : "",
      profile.collaboration.defaults.length ? `Collaboration Defaults: ${profile.collaboration.defaults.join(" | ")}` : "",
      profile.collaboration.avoidances.length ? `Avoidances: ${profile.collaboration.avoidances.join(" | ")}` : "",
      profile.voice.quirks.length ? `Quirks: ${profile.voice.quirks.join(" | ")}` : "",
      profile.growth.notes.length ? `Growth Notes: ${profile.growth.notes.join(" | ")}` : "",
    ].filter(Boolean);

    return {
      success: true,
      output: lines.join("\n"),
      metadata: profile,
    };
  },
});

registerTool({
  name: "assistant_personality_update",
  description:
    "Update the persistent main-assistant personality profile. " +
    "This changes long-lived voice guidance only. Never use it to alter safety rules, honesty rules, or authorization boundaries.",
  parameters: {
    type: "object",
    properties: {
      identity: {
        type: "string",
        description: "Optional replacement for the core identity statement.",
      },
      tone: {
        type: "array",
        items: { type: "string" },
        description: "Optional tone list. Replaces the current list unless append=true.",
      },
      style: {
        type: "array",
        items: { type: "string" },
        description: "Optional style list. Replaces the current list unless append=true.",
      },
      defaults: {
        type: "array",
        items: { type: "string" },
        description: "Optional durable collaboration defaults. Replaces the current list unless append=true.",
      },
      avoidances: {
        type: "array",
        items: { type: "string" },
        description: "Optional things the assistant should consistently avoid. Replaces the current list unless append=true.",
      },
      quirks: {
        type: "array",
        items: { type: "string" },
        description: "Optional quirks list. Replaces the current list unless append=true.",
      },
      growthNotes: {
        type: "array",
        items: { type: "string" },
        description: "Optional durable growth notes. Replaces the current list unless append=true.",
      },
      append: {
        type: "boolean",
        description: "When true, append provided arrays to existing ones with deduplication instead of replacing them.",
        default: false,
      },
      reset: {
        type: "boolean",
        description: "When true, start from the default personality before applying any provided fields.",
        default: false,
      },
      reason: {
        type: "string",
        description: "Short note explaining why this durable personality change is useful.",
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    try {
      const profile = updateMainAssistantPersonality(args as MainAssistantPersonalityUpdate, "assistant");
      return {
        success: true,
        output: `Main assistant personality updated to revision ${profile.revision}. Identity: ${profile.identity.core}`,
        metadata: profile,
      };
    } catch (error) {
      log.error({ error }, "assistant_personality_update failed");
      return { success: false, output: "", error: error instanceof Error ? error.message : String(error) };
    }
  },
});

registerTool({
  name: "memory_promote",
  description:
    "Promote high-value session facts, agent lessons, or workspace notes into durable workspace or user-global memory, with deduplication and tag merging. " +
    "Use workspace for repo-local memory and user for cross-workspace habits, preferences, or defaults.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Query used to select the memory entries to promote.",
      },
      limit: {
        type: "number",
        description: "Maximum number of candidate entries to promote (default 5, max 20).",
        default: 5,
      },
      scopes: {
        type: "array",
        items: { type: "string", enum: ["workspace", "session", "agent"] },
        description: "Optional source scopes to promote from. Defaults depend on destination scope.",
      },
      kind: {
        type: "string",
        enum: ["note", "fact", "preference", "lesson", "decision", "summary"],
        description: "Optional destination kind override for promoted records.",
      },
      targetAgent: {
        type: "string",
        description: "Optional agent filter when promoting from agent memory.",
      },
      destinationScope: {
        type: "string",
        enum: ["workspace", "user"],
        description: "Durable destination scope. Defaults to workspace.",
      },
    },
    required: ["query"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = String(args["query"] ?? "").trim();
    const limit = Math.min(20, Math.max(1, Number(args["limit"] ?? 5)));
    const scopes = Array.isArray(args["scopes"])
      ? args["scopes"].map(String).filter((value): value is MemoryScope => value === "workspace" || value === "session" || value === "agent")
      : undefined;
    const kind = String(args["kind"] ?? "").trim().toLowerCase() as MemoryKind | "";
    const targetAgent = String(args["targetAgent"] ?? "").trim() || undefined;
    const destinationScope = String(args["destinationScope"] ?? "workspace").trim().toLowerCase() as DurableMemoryScope | "";

    if (!query) return { success: false, output: "", error: "query is required" };
    if (destinationScope !== "workspace" && destinationScope !== "user") {
      return { success: false, output: "", error: "destinationScope must be 'workspace' or 'user'" };
    }

    try {
      const result = await promoteMemoryRecords(ctx.workspacePath, query, {
        sessionId: deriveSharedSessionId(ctx.sessionId),
        scopes,
        targetAgent,
        destinationKind: kind || undefined,
        destinationScope,
        maxPromotions: limit,
      });

      const promotedLines = result.promoted.map((record) => `- promoted **${record.subject}** as ${record.kind}`);
      const mergedLines = result.merged.map((record) => `- merged into **${record.subject}** as ${record.kind}`);
      const lines = [...promotedLines, ...mergedLines];

      return {
        success: true,
        output: lines.length > 0
          ? `${result.destinationScope === "user" ? "User" : "Workspace"} memory promotion completed.\n\n${lines.join("\n")}`
          : `${result.destinationScope === "user" ? "User" : "Workspace"} memory promotion completed, but no matching entries were promoted.`,
        metadata: {
          promoted: result.promoted.length,
          merged: result.merged.length,
          skipped: result.skipped,
          destinationScope: result.destinationScope,
        },
      };
    } catch (err) {
      log.error({ err, query }, "memory_promote failed");
      return { success: false, output: "", error: `Promotion failed: ${String(err)}` };
    }
  },
});

registerTool({
  name: "memory_compact",
  description:
    "Compact durable workspace or user-global memory by merging duplicate records and consolidating tags. " +
    "Use dryRun=true first when you want to inspect the impact before rewriting the durable store.",
  parameters: {
    type: "object",
    properties: {
      dryRun: {
        type: "boolean",
        description: "When true, report what would be compacted without rewriting files.",
      },
      scope: {
        type: "string",
        enum: ["workspace", "user"],
        description: "Durable scope to compact. Defaults to workspace.",
      },
    },
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const scope = String(args["scope"] ?? "workspace").trim().toLowerCase() as DurableMemoryScope | "";
      if (scope !== "workspace" && scope !== "user") {
        return { success: false, output: "", error: "scope must be 'workspace' or 'user'" };
      }
      const result = (scope === "user" ? compactUserMemoryRecords : compactWorkspaceMemoryRecords)(ctx.workspacePath, {
        dryRun: args["dryRun"] === true,
      });
      return {
        success: true,
        output: `${scope === "user" ? "User" : "Workspace"} memory compaction ${result.dryRun ? "previewed" : "completed"}. Kept: ${result.kept}. Removed: ${result.removed}. Merged groups: ${result.merged}.`,
        metadata: {
          kept: result.kept,
          removed: result.removed,
          merged: result.merged,
          dryRun: result.dryRun,
          scope: result.scope,
        },
      };
    } catch (err) {
      log.error({ err }, "memory_compact failed");
      return { success: false, output: "", error: `Compaction failed: ${String(err)}` };
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
  name: "send_agent_message",
  description:
    "Send a direct message to another agent in the current swarm session, or broadcast to matching agents by domain/tags. " +
    "Use this when another specialist needs a concise handoff, warning, or fact before its next delegated turn.",
  parameters: {
    type: "object",
    properties: {
      targetAgent: {
        type: "string",
        description: "Exact agent name that should receive the message on its next turn",
      },
      domain: {
        type: "string",
        description: "Optional domain filter for broadcasts",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Optional capability/tag filters for broadcasts. All tags must match.",
      },
      excludeAgents: {
        type: "array",
        items: { type: "string" },
        description: "Optional agent names to exclude from a broadcast.",
      },
      message: {
        type: "string",
        description: "Short message to deliver (max 1200 chars)",
      },
    },
    required: ["message"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const message = String(args["message"] ?? "").trim();

    if (!message) return { success: false, output: "", error: "message is required" };

    const sharedSessionId = deriveSharedSessionId(ctx.sessionId);
    const fromAgent = deriveAgentName(ctx.sessionId);
    if (isAgentMessagingSuppressed(sharedSessionId, fromAgent)) {
      return {
        success: false,
        output: "",
        error: `Direct messaging for agent '${fromAgent}' is temporarily suppressed by Warden due to message flooding.`,
      };
    }

    const recipients = resolveBroadcastTargets(fromAgent, args);
    if (recipients.length === 0) {
      return {
        success: false,
        output: "",
        error: "No matching target agents found. Provide targetAgent, or use domain/tags for a broadcast.",
      };
    }

    const timestamp = new Date().toISOString();
    for (const recipient of recipients) {
      await appendAgentMessage({
        sessionId: sharedSessionId,
        id: randomUUID(),
        fromAgent,
        toAgent: recipient,
        content: message,
        ts: timestamp,
      });
    }

    const isBroadcast = recipients.length > 1 || !String(args["targetAgent"] ?? "").trim();
    emitSwarmEvent(isBroadcast ? "agent_broadcast" : "agent_message", {
      sessionId: sharedSessionId,
      agentName: fromAgent,
      data: {
        recipients,
        recipientCount: recipients.length,
        domain: args["domain"],
        tags: Array.isArray(args["tags"]) ? args["tags"] : [],
        preview: message.slice(0, 120),
      },
    });
    logAudit("agent_message_sent", {
      fromAgent,
      recipients,
      recipientCount: recipients.length,
      broadcast: isBroadcast,
      domain: args["domain"],
      tags: Array.isArray(args["tags"]) ? args["tags"] : [],
    }, { sessionId: sharedSessionId, severity: "info" });

    return {
      success: true,
      output: recipients.length === 1
        ? `Direct message queued for agent "${recipients[0]}".`
        : `Broadcast queued for ${recipients.length} agents: ${recipients.join(", ")}.`,
      metadata: { fromAgent, recipients, sessionId: sharedSessionId },
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
    const parentSessionId = deriveSharedSessionId(ctx.sessionId);

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
    const parentSessionId = deriveSharedSessionId(ctx.sessionId);
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

// ── session_status ────────────────────────────────────────────────────────────

registerTool({
  name: "session_status",
  description:
    "Get metadata about the current session: session ID, channel, creation time, turn count, " +
    "message count, and age. Read-only — useful for context-aware decisions.",
  parameters: {
    type: "object",
    properties: {},
  },
  async execute(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const parentSessionId = deriveSharedSessionId(ctx.sessionId);
    const session = getSession(parentSessionId);
    if (!session) {
      return {
        success: true,
        output: `Session ${parentSessionId} — no metadata available (sub-agent context).`,
        metadata: { sessionId: parentSessionId },
      };
    }

    const now = new Date();
    const ageMs = now.getTime() - session.createdAt.getTime();
    const ageMinutes = Math.round(ageMs / 60_000);

    const lines = [
      `**Session ID:** ${session.id}`,
      `**Channel:** ${session.channel}`,
      `**Created:** ${session.createdAt.toISOString()}`,
      `**Age:** ${ageMinutes} minute${ageMinutes === 1 ? "" : "s"}`,
      `**Turns:** ${session.getTurnCount()}`,
    ];

    return {
      success: true,
      output: lines.join("\n"),
      metadata: {
        sessionId: session.id,
        channel: session.channel,
        createdAt: session.createdAt.toISOString(),
        ageMinutes,
        turnCount: session.getTurnCount(),
      },
    };
  },
});
