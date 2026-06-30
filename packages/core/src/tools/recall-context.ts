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
import { buildDynamicTurnGuidance } from "../agent/intent-classifier.js";
import { retrieveDocumentContext } from "../retrieval/document-rag.js";
import { childLogger } from "../logger.js";

const log = childLogger("tool:recall-context");

type Section = "user" | "facts" | "memory" | "sessions" | "skills" | "documents";
const ALL_SECTIONS: Section[] = ["user", "facts", "memory", "sessions", "skills", "documents"];

function truncate(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/**
 * Task-conditional retrieval scope. When the caller does not pin `include`, the
 * detected intent (via the shared turn classifier — no new heuristics) decides
 * which tiers lead and how the per-section budget is allocated, so retrieval is
 * focused on what the task class actually needs instead of a flat dump. Every
 * tier still appears (each self-skips when empty), so nothing is hidden and the
 * model can always override via `include`.
 */
function deriveRecallPlan(query: string): { intent: string; priority: Set<Section>; order: Section[] } {
  let guidance: ReturnType<typeof buildDynamicTurnGuidance> = null;
  try { guidance = buildDynamicTurnGuidance(query); } catch { guidance = null; }

  if (guidance?.swarmMaintenanceSensitive) {
    // Maintaining StarlingAI itself: prior decisions, learned procedures, and
    // past maintenance sessions matter most; the dialectic user model rarely does.
    return { intent: "maintenance", priority: new Set(["memory", "skills", "sessions"]), order: ["memory", "skills", "sessions", "facts", "user", "documents"] };
  }
  if (guidance?.sourceSensitive || guidance?.freshnessSensitive) {
    // Research/validation: long-term findings, this session's gathered evidence,
    // attached source documents, prior research sessions, and research procedures lead.
    return { intent: "research", priority: new Set(["memory", "facts", "documents", "sessions", "skills"]), order: ["memory", "documents", "facts", "sessions", "skills", "user"] };
  }
  // General: the user model, attached documents (e.g. an uploaded CV/profile), and
  // durable memory lead; all tiers carry full budget. Documents are placed second so a
  // question about the user's own background surfaces an attached CV prominently.
  return { intent: "general", priority: new Set(ALL_SECTIONS), order: ["user", "documents", "facts", "memory", "sessions", "skills"] };
}

registerTool({
  name: "recall_context",
  description:
    "Pull a compact planning-context pack for a task in one call: the user model, this session's "
    + "working-memory shared facts, relevant long-term memories, recent related sessions, learned "
    + "skills, and excerpts from documents attached to this conversation (e.g. an uploaded CV or "
    + "profile). Call this before a non-trivial delegation/routing decision — or before answering any "
    + "question about the USER'S OWN background, skills, experience, or fit — so the answer is grounded "
    + "in what is already known instead of guessing or claiming you have no information.",
  embeddingDescription:
    "gather context before planning or delegating; what do we already know about this; user preferences "
    + "and prior decisions; recall memory user model sessions facts skills for a task; hydrate planning context; "
    + "the user's own background skills experience CV resume profile projects from attached documents",
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
        description: "Which sections to include. Default: all (user, facts, memory, sessions, skills, documents).",
      },
    },
    required: ["query"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = String(args["query"] ?? "").trim();
    if (!query) return { success: false, output: "", error: "query is required" };

    const limit = Math.max(1, Math.min(10, Number(args["limit"] ?? 5) || 5));
    const explicitInclude = Array.isArray(args["include"]) && args["include"].length > 0;
    const requested = new Set<Section>(
      explicitInclude
        ? (args["include"] as unknown[]).map(String).filter((value): value is Section => (ALL_SECTIONS as string[]).includes(value))
        : ALL_SECTIONS,
    );
    if (requested.size === 0) ALL_SECTIONS.forEach((section) => requested.add(section));

    // Task-conditional scope (only when the caller didn't pin `include`): the
    // detected intent sets the section order and concentrates the per-section
    // budget on the tiers the task class needs. Non-priority tiers still appear
    // at a reduced limit, so nothing is hidden.
    const plan = deriveRecallPlan(query);
    const order: Section[] = explicitInclude ? ALL_SECTIONS : plan.order;
    const limitFor = (section: Section): number =>
      explicitInclude || plan.priority.has(section) ? limit : Math.min(3, limit);

    const sharedSessionId = deriveSharedSessionId(ctx.sessionId);
    const sectionMap = new Map<Section, string>();
    const meta: Record<string, unknown> = { recallIntent: explicitInclude ? "explicit" : plan.intent };

    if (requested.has("user")) {
      try {
        const guidance = formatUserModelGuidance().trim();
        meta["userModel"] = guidance.length > 0;
        if (guidance) sectionMap.set("user", `## User model\n${guidance}`);
      } catch (err) {
        log.debug({ err }, "recall_context: user model failed");
      }
    }

    if (requested.has("facts")) {
      try {
        const embeddingModel = getConfig().agents.defaults.model.embeddingModel;
        const facts = await searchSharedFacts(sharedSessionId, query, {
          maxResults: limitFor("facts"),
          provider: embeddingModel ? getEmbeddingProvider() : undefined,
          embeddingModel,
        });
        meta["sharedFacts"] = facts.length;
        if (facts.length > 0) {
          sectionMap.set("facts",
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
        const records = await searchMemoryRecords(ctx.workspacePath, query, { limit: limitFor("memory"), sessionId: sharedSessionId });
        meta["memories"] = records.length;
        if (records.length > 0) {
          sectionMap.set("memory",
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
        const matches = searchSessions(query, { limit: limitFor("sessions"), excludeSessionId: ctx.sessionId });
        meta["sessions"] = matches.length;
        if (matches.length > 0) {
          sectionMap.set("sessions",
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
        const { text, slugs } = await retrieveSkillGuidance(ctx.workspacePath, query, { limit: limitFor("skills"), maxChars: 800 });
        meta["skills"] = slugs.length;
        if (text.trim()) sectionMap.set("skills", `## Relevant skills\n${text.trim()}`);
      } catch (err) {
        log.debug({ err }, "recall_context: skill recall failed");
      }
    }

    if (requested.has("documents")) {
      // Documents attached to this conversation (engram RAG) — scoped to the
      // current session + the signed-in user's corpus. This is how an uploaded
      // CV / profile / project list becomes visible to a "would I be a good fit"
      // question. No-op (returns []) when engram is unconfigured or nothing is in
      // scope, so this section self-skips exactly like the others.
      try {
        const chunks = await retrieveDocumentContext(query, {
          sessionId: ctx.sessionId,
          ...(ctx.userId ? { userId: ctx.userId } : {}),
        });
        meta["documents"] = chunks.length;
        if (chunks.length > 0) {
          sectionMap.set("documents",
            "## Attached documents (e.g. an uploaded CV / profile)\n"
            + chunks.slice(0, limitFor("documents")).map((chunk) => {
              const label = chunk.title?.trim() || chunk.documentId.slice(0, 8);
              return `- **${label}**: ${truncate(chunk.text, 220)}`;
            }).join("\n"),
          );
        }
      } catch (err) {
        log.debug({ err }, "recall_context: document retrieval failed");
      }
    }

    const ordered = order.filter((section) => sectionMap.has(section)).map((section) => sectionMap.get(section)!);
    const output = [
      `# Planning context for: "${truncate(query, 120)}"`,
      "",
      ...(ordered.length > 0 ? ordered : ["_No stored context matched this task yet — plan from the request directly._"]),
    ].join("\n\n");

    return { success: true, output, metadata: meta };
  },
});
