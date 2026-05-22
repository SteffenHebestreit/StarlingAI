/**
 * recall_context (Tier 0) — one-call planning-context pack.
 *
 * Aggregates the durable + working memory subsystems into a single compact
 * digest so the planner can hydrate context just-in-time before a delegation
 * decision, instead of the system prompt always carrying user-model / memory /
 * skill blocks every turn. Pulls, scoped to the task `query`:
 *   - the evolving user model (goals, expertise, working style),
 *   - this session's working-memory shared facts (short-term),
 *   - relevant long-term memory records (RAG),
 *   - recent related past sessions,
 *   - relevant learned skills.
 *
 * Each section degrades independently — a failing subsystem (e.g. embeddings
 * offline) is skipped, never failing the whole pull. Read-only, no approval.
 */

import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { deriveSharedSessionId } from "./memory.js";
import { getConfig } from "../config/loader.js";
import { getEmbeddingProvider } from "../providers/index.js";
import { searchMemoryRecords } from "../memory/service.js";
import { formatUserModelGuidance } from "../user-model/service.js";
import { searchSessions } from "../agent/session-search.js";
import { searchSharedFacts } from "../swarm/memory.js";
import { retrieveSkillGuidance } from "../skills/service.js";
import { childLogger } from "../logger.js";

const log = childLogger("tool:recall-context");

type Section = "user" | "facts" | "memory" | "sessions" | "skills";
const ALL_SECTIONS: Section[] = ["user", "facts", "memory", "sessions", "skills"];

function truncate(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

registerTool({
  name: "recall_context",
  description:
    "Pull a compact planning-context pack for a task in one call: the user model, this session's "
    + "working-memory shared facts, relevant long-term memories, recent related sessions, and learned "
    + "skills. Call this before a non-trivial delegation/routing decision so task wording and agent "
    + "choice are informed by what is already known — instead of guessing or re-researching.",
  embeddingDescription:
    "gather context before planning or delegating; what do we already know about this; user preferences "
    + "and prior decisions; recall memory user model sessions facts skills for a task; hydrate planning context",
  costHint: "low",
  latencyHint: "medium",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The task or topic to gather context for (usually the user's request).",
      },
      limit: {
        type: "number",
        description: "Max items per section. Default 5, max 10.",
      },
      include: {
        type: "array",
        items: { type: "string", enum: ALL_SECTIONS },
        description: "Which sections to include. Default: all (user, facts, memory, sessions, skills).",
      },
    },
    required: ["query"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = String(args["query"] ?? "").trim();
    if (!query) return { success: false, output: "", error: "query is required" };

    const limit = Math.max(1, Math.min(10, Number(args["limit"] ?? 5) || 5));
    const requested = new Set<Section>(
      Array.isArray(args["include"])
        ? args["include"].map(String).filter((value): value is Section => (ALL_SECTIONS as string[]).includes(value))
        : ALL_SECTIONS,
    );
    if (requested.size === 0) ALL_SECTIONS.forEach((section) => requested.add(section));

    const sharedSessionId = deriveSharedSessionId(ctx.sessionId);
    const sections: string[] = [];
    const meta: Record<string, unknown> = {};

    if (requested.has("user")) {
      try {
        const guidance = formatUserModelGuidance().trim();
        meta["userModel"] = guidance.length > 0;
        if (guidance) sections.push(`## User model\n${guidance}`);
      } catch (err) {
        log.debug({ err }, "recall_context: user model failed");
      }
    }

    if (requested.has("facts")) {
      try {
        const embeddingModel = getConfig().agents.defaults.model.embeddingModel;
        const facts = await searchSharedFacts(sharedSessionId, query, {
          maxResults: limit,
          provider: embeddingModel ? getEmbeddingProvider() : undefined,
          embeddingModel,
        });
        meta["sharedFacts"] = facts.length;
        if (facts.length > 0) {
          sections.push(
            "## Working memory (this session)\n"
            + facts.map((fact) => `- **${fact.key}**: ${truncate(fact.value, 200)}`).join("\n"),
          );
        }
      } catch (err) {
        log.debug({ err }, "recall_context: shared facts failed");
      }
    }

    if (requested.has("memory")) {
      try {
        const records = await searchMemoryRecords(ctx.workspacePath, query, { limit, sessionId: sharedSessionId });
        meta["memories"] = records.length;
        if (records.length > 0) {
          sections.push(
            "## Relevant long-term memory\n"
            + records.map((record) => `- [${record.scope}/${record.kind}] ${record.subject}: ${truncate(record.content, 180)}`).join("\n"),
          );
        }
      } catch (err) {
        log.debug({ err }, "recall_context: long-term memory failed");
      }
    }

    if (requested.has("sessions")) {
      try {
        const matches = searchSessions(query, { limit, excludeSessionId: ctx.sessionId });
        meta["sessions"] = matches.length;
        if (matches.length > 0) {
          sections.push(
            "## Recent related sessions\n"
            + matches.map((match) => {
              const when = new Date(match.updatedAt).toISOString().slice(0, 10);
              return `- ${match.id.slice(0, 12)} [${match.channel}, ${when}]: ${truncate(match.snippet ?? "", 160)}`;
            }).join("\n"),
          );
        }
      } catch (err) {
        log.debug({ err }, "recall_context: session search failed");
      }
    }

    if (requested.has("skills")) {
      try {
        const { text, slugs } = await retrieveSkillGuidance(ctx.workspacePath, query, { limit, maxChars: 800 });
        meta["skills"] = slugs.length;
        if (text.trim()) sections.push(`## Relevant skills\n${text.trim()}`);
      } catch (err) {
        log.debug({ err }, "recall_context: skill recall failed");
      }
    }

    const output = [
      `# Planning context for: "${truncate(query, 120)}"`,
      "",
      ...(sections.length > 0 ? sections : ["_No stored context matched this task yet — plan from the request directly._"]),
    ].join("\n\n");

    return { success: true, output, metadata: meta };
  },
});
