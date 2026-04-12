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
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname } from "node:path";
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
import { resolvePathWithinWorkspace } from "./workspace-path.js";

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

type SharedFindingMetadata = {
  claim?: string;
  sourceTitle?: string;
  sourceUrl?: string;
  publisher?: string;
  publishedAt?: string;
  retrievedAt?: string;
  evidenceType?: string;
  accuracyScore?: number;
  trustworthinessScore?: number;
  corroborationScore?: number;
  validationStatus?: string;
  notes?: string;
};

type EvidenceLedgerFormat = "json" | "markdown";

type EvidenceEntry = {
  key: string;
  finding: string;
  claim: string;
  sourceTitle: string;
  sourceUrl: string;
  publisher?: string;
  publishedAt?: string;
  retrievedAt?: string;
  evidenceType: string;
  accuracyScore: number;
  trustworthinessScore: number;
  corroborationScore: number;
  validationStatus: string;
  notes?: string;
  supportingKeys?: string[];
};

const EVIDENCE_LEDGER_FORMATS = new Set<EvidenceLedgerFormat>(["json", "markdown"]);
const EVIDENCE_VALIDATION_STATUSES = new Set(["unverified", "tentative", "validated", "disputed"]);

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

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeUnitScore(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${fieldName} must be a number between 0 and 1`);
  }
  if (value < 0 || value > 1) {
    throw new Error(`${fieldName} must be between 0 and 1`);
  }
  return Number(value);
}

function normalizeEvidenceUrl(value: unknown, fieldName: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error(`${fieldName} is required`);

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${fieldName} must be a valid http(s) URL`);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${fieldName} must be a valid http(s) URL`);
  }

  return parsed.toString();
}

function normalizeEvidenceStatus(value: unknown): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) throw new Error("validationStatus is required");
  if (!EVIDENCE_VALIDATION_STATUSES.has(normalized)) {
    throw new Error("validationStatus must be one of: unverified, tentative, validated, disputed");
  }
  return normalized;
}

function normalizeEvidenceEntry(input: Record<string, unknown>, fallbackKey?: string): EvidenceEntry {
  const key = safeKey(String(input["key"] ?? fallbackKey ?? "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_"));
  const finding = String(input["finding"] ?? input["value"] ?? "").trim();
  const claim = String(input["claim"] ?? "").trim();
  const sourceTitle = String(input["sourceTitle"] ?? "").trim();
  const publisher = optionalString(input["publisher"]);
  const publishedAt = optionalString(input["publishedAt"]);
  const retrievedAt = optionalString(input["retrievedAt"]);
  const evidenceType = String(input["evidenceType"] ?? "").trim().toLowerCase();
  const notes = optionalString(input["notes"]);
  const supportingKeys = Array.isArray(input["supportingKeys"])
    ? input["supportingKeys"].map((entry) => safeKey(String(entry))).filter(Boolean)
    : undefined;

  if (!key) throw new Error("key is required");
  if (!finding) throw new Error("finding/value is required");
  if (!claim) throw new Error("claim is required");
  if (!sourceTitle) throw new Error("sourceTitle is required");
  if (!evidenceType) throw new Error("evidenceType is required");

  return {
    key,
    finding,
    claim,
    sourceTitle,
    sourceUrl: normalizeEvidenceUrl(input["sourceUrl"], "sourceUrl"),
    publisher,
    publishedAt,
    retrievedAt,
    evidenceType,
    accuracyScore: normalizeUnitScore(input["accuracyScore"], "accuracyScore"),
    trustworthinessScore: normalizeUnitScore(input["trustworthinessScore"], "trustworthinessScore"),
    corroborationScore: normalizeUnitScore(input["corroborationScore"], "corroborationScore"),
    validationStatus: normalizeEvidenceStatus(input["validationStatus"]),
    notes,
    supportingKeys,
  };
}

function formatEvidenceValue(entry: EvidenceEntry): string {
  return [
    entry.finding,
    "",
    "record_type: evidence",
    `claim: ${entry.claim}`,
    `source_title: ${entry.sourceTitle}`,
    `source_url: ${entry.sourceUrl}`,
    entry.publisher ? `publisher: ${entry.publisher}` : "",
    entry.publishedAt ? `published_at: ${entry.publishedAt}` : "",
    entry.retrievedAt ? `retrieved_at: ${entry.retrievedAt}` : "",
    `evidence_type: ${entry.evidenceType}`,
    `accuracy_score: ${entry.accuracyScore}`,
    `trustworthiness_score: ${entry.trustworthinessScore}`,
    `corroboration_score: ${entry.corroborationScore}`,
    `validation_status: ${entry.validationStatus}`,
    entry.supportingKeys && entry.supportingKeys.length > 0 ? `supporting_keys: ${entry.supportingKeys.join(", ")}` : "",
    entry.notes ? `notes: ${entry.notes}` : "",
  ].filter(Boolean).join("\n");
}

function normalizeEvidenceLedgerFormat(value: unknown): EvidenceLedgerFormat | null {
  const normalized = String(value ?? "json").trim().toLowerCase() as EvidenceLedgerFormat;
  return EVIDENCE_LEDGER_FORMATS.has(normalized) ? normalized : null;
}

function resolveEvidenceLedgerOutputPath(input: {
  requestedPath?: string;
  title?: string;
  format: EvidenceLedgerFormat;
  workspacePath: string;
}): { resolved: string; relativePath: string } {
  const extension = input.format === "json" ? ".json" : ".md";
  const fallbackName = safeKey(input.title || "validated_evidence_ledger") || "validated_evidence_ledger";
  const requestedPath = input.requestedPath?.trim() || `artifacts/reports/${fallbackName}${extension}`;
  const withExtension = extname(requestedPath)
    ? requestedPath
    : `${requestedPath}${extension}`;

  if (extname(withExtension).toLowerCase() !== extension) {
    throw new Error(`output_file must use the ${extension} extension for ${input.format} ledgers`);
  }

  return resolvePathWithinWorkspace(withExtension, input.workspacePath);
}

function renderEvidenceLedger(entrySet: EvidenceEntry[], format: EvidenceLedgerFormat, title: string): string {
  if (format === "json") {
    return JSON.stringify({
      title,
      generatedAt: new Date().toISOString(),
      entryCount: entrySet.length,
      entries: entrySet,
    }, null, 2);
  }

  const sections = entrySet.map((entry, index) => {
    const lines = [
      `## ${index + 1}. ${entry.key}`,
      `- Finding: ${entry.finding}`,
      `- Claim: ${entry.claim}`,
      `- Source: ${entry.sourceTitle}`,
      `- URL: ${entry.sourceUrl}`,
      entry.publisher ? `- Publisher: ${entry.publisher}` : "",
      entry.publishedAt ? `- Published: ${entry.publishedAt}` : "",
      entry.retrievedAt ? `- Retrieved: ${entry.retrievedAt}` : "",
      `- Evidence Type: ${entry.evidenceType}`,
      `- Validation Status: ${entry.validationStatus}`,
      `- Accuracy Score: ${entry.accuracyScore}`,
      `- Trustworthiness Score: ${entry.trustworthinessScore}`,
      `- Corroboration Score: ${entry.corroborationScore}`,
      entry.supportingKeys && entry.supportingKeys.length > 0 ? `- Supporting Keys: ${entry.supportingKeys.join(", ")}` : "",
      entry.notes ? `- Notes: ${entry.notes}` : "",
    ].filter(Boolean);
    return lines.join("\n");
  });

  return [`# ${title}`, "", ...sections].join("\n\n");
}

function formatSharedFindingValue(value: string, metadata: SharedFindingMetadata): string {
  const trimmedValue = value.trim();
  const lines = [trimmedValue];
  const metadataLines: string[] = [];

  const pushLine = (label: string, entry: string | number | undefined): void => {
    if (entry === undefined) return;
    const text = String(entry).trim();
    if (!text) return;
    metadataLines.push(`${label}: ${text}`);
  };

  pushLine("claim", metadata.claim);
  pushLine("source_title", metadata.sourceTitle);
  pushLine("source_url", metadata.sourceUrl);
  pushLine("publisher", metadata.publisher);
  pushLine("published_at", metadata.publishedAt);
  pushLine("retrieved_at", metadata.retrievedAt);
  pushLine("evidence_type", metadata.evidenceType);
  pushLine("accuracy_score", metadata.accuracyScore);
  pushLine("trustworthiness_score", metadata.trustworthinessScore);
  pushLine("corroboration_score", metadata.corroborationScore);
  pushLine("validation_status", metadata.validationStatus);
  pushLine("notes", metadata.notes);

  if (metadataLines.length === 0) return trimmedValue;
  lines.push("", ...metadataLines);
  return lines.join("\n");
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
    "Use share_evidence instead of this tool for source-backed research findings that must carry required provenance, validation state, and trust scores. " +
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
      claim: {
        type: "string",
        description: "Optional exact claim or fact statement that this finding supports",
      },
      sourceTitle: {
        type: "string",
        description: "Optional source title for source-backed findings",
      },
      sourceUrl: {
        type: "string",
        description: "Optional canonical source URL for source-backed findings",
      },
      publisher: {
        type: "string",
        description: "Optional publisher, maintainer, or organization behind the source",
      },
      publishedAt: {
        type: "string",
        description: "Optional publication or last-updated date exactly as observed",
      },
      retrievedAt: {
        type: "string",
        description: "Optional retrieval date for the source-backed finding",
      },
      evidenceType: {
        type: "string",
        description: "Optional evidence type such as primary, official, secondary, observed, or derived",
      },
      accuracyScore: {
        type: "number",
        description: "Optional accuracy score from 0 to 1 for this finding",
      },
      trustworthinessScore: {
        type: "number",
        description: "Optional trustworthiness score from 0 to 1 for the source",
      },
      corroborationScore: {
        type: "number",
        description: "Optional corroboration score from 0 to 1 based on independent confirmation",
      },
      validationStatus: {
        type: "string",
        description: "Optional validation state such as unverified, validated, tentative, or disputed",
      },
      notes: {
        type: "string",
        description: "Optional short note about caveats, disagreements, or why the score is not perfect",
      },
    },
    required: ["key", "value"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const key = String(args["key"] ?? "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 80);
    const rawValue = String(args["value"] ?? "").trim();
    const metadata: SharedFindingMetadata = {
      claim: typeof args["claim"] === "string" ? String(args["claim"]).trim() : undefined,
      sourceTitle: typeof args["sourceTitle"] === "string" ? String(args["sourceTitle"]).trim() : undefined,
      sourceUrl: typeof args["sourceUrl"] === "string" ? String(args["sourceUrl"]).trim() : undefined,
      publisher: typeof args["publisher"] === "string" ? String(args["publisher"]).trim() : undefined,
      publishedAt: typeof args["publishedAt"] === "string" ? String(args["publishedAt"]).trim() : undefined,
      retrievedAt: typeof args["retrievedAt"] === "string" ? String(args["retrievedAt"]).trim() : undefined,
      evidenceType: typeof args["evidenceType"] === "string" ? String(args["evidenceType"]).trim() : undefined,
      accuracyScore: typeof args["accuracyScore"] === "number" ? Number(args["accuracyScore"]) : undefined,
      trustworthinessScore: typeof args["trustworthinessScore"] === "number" ? Number(args["trustworthinessScore"]) : undefined,
      corroborationScore: typeof args["corroborationScore"] === "number" ? Number(args["corroborationScore"]) : undefined,
      validationStatus: typeof args["validationStatus"] === "string" ? String(args["validationStatus"]).trim() : undefined,
      notes: typeof args["notes"] === "string" ? String(args["notes"]).trim() : undefined,
    };
    const value = formatSharedFindingValue(rawValue, metadata);

    if (!key) return { success: false, output: "", error: "key is required" };
    if (!rawValue) return { success: false, output: "", error: "value is required" };

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
  name: "share_evidence",
  description:
    "Publish a source-backed evidence record to the session's shared memory with required provenance, validation state, and trust scores. " +
    "Use this for research findings, citations, factual claims, benchmarks, and sourced statistics that downstream agents may draft from.",
  parameters: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description: "Short snake_case identifier for this evidence record",
      },
      value: {
        type: "string",
        description: "Concise finding text or observed fact value",
      },
      claim: {
        type: "string",
        description: "Exact claim supported by the source",
      },
      sourceTitle: {
        type: "string",
        description: "Exact source title",
      },
      sourceUrl: {
        type: "string",
        description: "Canonical http(s) source URL",
      },
      publisher: {
        type: "string",
        description: "Publisher, maintainer, or organization behind the source",
      },
      publishedAt: {
        type: "string",
        description: "Publication or last-updated date exactly as observed",
      },
      retrievedAt: {
        type: "string",
        description: "Retrieval date for the source-backed evidence",
      },
      evidenceType: {
        type: "string",
        description: "Evidence type such as official, primary, secondary, observed, or derived",
      },
      accuracyScore: {
        type: "number",
        description: "Accuracy score from 0 to 1",
      },
      trustworthinessScore: {
        type: "number",
        description: "Trustworthiness score from 0 to 1",
      },
      corroborationScore: {
        type: "number",
        description: "Corroboration score from 0 to 1",
      },
      validationStatus: {
        type: "string",
        description: "One of: unverified, tentative, validated, disputed",
      },
      notes: {
        type: "string",
        description: "Optional caveat or short reviewer note",
      },
      supportingKeys: {
        type: "array",
        items: { type: "string" },
        description: "Optional shared-fact keys that corroborate this evidence entry",
      },
    },
    required: [
      "key",
      "value",
      "claim",
      "sourceTitle",
      "sourceUrl",
      "evidenceType",
      "accuracyScore",
      "trustworthinessScore",
      "corroborationScore",
      "validationStatus",
    ],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    let entry: EvidenceEntry;
    try {
      entry = normalizeEvidenceEntry(args);
    } catch (err) {
      return { success: false, output: "", error: String(err instanceof Error ? err.message : err) };
    }

    const parentSessionId = deriveSharedSessionId(ctx.sessionId);
    const value = formatEvidenceValue(entry);

    await writeSharedFact(parentSessionId, entry.key, value);
    log.info({ key: entry.key, parentSessionId }, "Shared evidence published");

    return {
      success: true,
      output: `Evidence published to shared session memory: '${entry.key}' from ${entry.sourceTitle}`,
      metadata: {
        key: entry.key,
        parentSessionId,
        recordType: "evidence",
        validationStatus: entry.validationStatus,
        sourceUrl: entry.sourceUrl,
      },
    };
  },
});

registerTool({
  name: "export_evidence_ledger",
  description:
    "Write a normalized validated evidence ledger artifact to the workspace and publish its path to shared session memory. " +
    "Use this after source verification so downstream agents can draft from one explicit validated ledger instead of scattered raw facts.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Optional artifact title",
      },
      format: {
        type: "string",
        enum: ["json", "markdown"],
        default: "json",
        description: "Output format for the evidence ledger",
      },
      output_file: {
        type: "string",
        description: "Workspace-relative output path for the ledger artifact",
      },
      overwrite: {
        type: "boolean",
        description: "When false, fail instead of overwriting an existing file",
        default: true,
      },
      entries: {
        type: "array",
        description: "Normalized evidence entries to persist in the validated ledger",
        items: {
          type: "object",
          properties: {
            key: { type: "string" },
            finding: { type: "string" },
            value: { type: "string" },
            claim: { type: "string" },
            sourceTitle: { type: "string" },
            sourceUrl: { type: "string" },
            publisher: { type: "string" },
            publishedAt: { type: "string" },
            retrievedAt: { type: "string" },
            evidenceType: { type: "string" },
            accuracyScore: { type: "number" },
            trustworthinessScore: { type: "number" },
            corroborationScore: { type: "number" },
            validationStatus: { type: "string" },
            notes: { type: "string" },
            supportingKeys: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: [
            "key",
            "claim",
            "sourceTitle",
            "sourceUrl",
            "evidenceType",
            "accuracyScore",
            "trustworthinessScore",
            "corroborationScore",
            "validationStatus",
          ],
        },
      },
    },
    required: ["entries"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const format = normalizeEvidenceLedgerFormat(args["format"]);
    if (!format) return { success: false, output: "", error: "format must be either 'json' or 'markdown'" };

    if (!Array.isArray(args["entries"]) || args["entries"].length === 0) {
      return { success: false, output: "", error: "entries must be a non-empty array" };
    }

    let entries: EvidenceEntry[];
    try {
      entries = args["entries"].map((entry, index) => {
        if (!entry || typeof entry !== "object") {
          throw new Error(`entries[${index}] must be an object`);
        }
        return normalizeEvidenceEntry(entry as Record<string, unknown>);
      });
    } catch (err) {
      return { success: false, output: "", error: String(err instanceof Error ? err.message : err) };
    }

    const overwrite = Boolean(args["overwrite"] ?? true);
    const title = optionalString(args["title"]) ?? "Validated Evidence Ledger";

    let resolvedOutput: { resolved: string; relativePath: string };
    try {
      resolvedOutput = resolveEvidenceLedgerOutputPath({
        requestedPath: optionalString(args["output_file"]),
        title,
        format,
        workspacePath: ctx.workspacePath,
      });
    } catch (err) {
      return { success: false, output: "", error: String(err instanceof Error ? err.message : err) };
    }

    try {
      if (!overwrite) {
        await stat(resolvedOutput.resolved);
        return { success: false, output: "", error: `Refusing to overwrite existing file: ${resolvedOutput.relativePath}` };
      }
    } catch {
      // File does not exist yet.
    }

    const content = renderEvidenceLedger(entries, format, title);

    try {
      await mkdir(dirname(resolvedOutput.resolved), { recursive: true });
      await writeFile(resolvedOutput.resolved, content, "utf8");
    } catch (err) {
      return { success: false, output: "", error: `Failed to write evidence ledger: ${String(err)}` };
    }

    const parentSessionId = deriveSharedSessionId(ctx.sessionId);
    await writeSharedFact(parentSessionId, "validated_evidence_ledger_path", resolvedOutput.relativePath);
    await writeSharedFact(parentSessionId, "validated_evidence_ledger_format", format);

    return {
      success: true,
      output: `Evidence ledger saved to ${resolvedOutput.relativePath} as ${format}.`,
      metadata: {
        artifactKind: "evidence_ledger",
        outputPath: resolvedOutput.relativePath,
        format,
        entryCount: entries.length,
        contentType: format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
        previewMode: format === "json" ? "text" : "markdown",
      },
    };
  },
});

registerTool({
  name: "read_shared_facts",
  description:
    "Read all shared facts published by other agents in this swarm session. " +
    "Use this at the start of a task to avoid duplicating work already done by a sibling agent. " +
    "Returns all key/value pairs stored via share_finding, share_evidence, or FACT: lines in previous agent outputs, including any source metadata, validation states, ledger paths, and trust scores captured with the finding.",
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
