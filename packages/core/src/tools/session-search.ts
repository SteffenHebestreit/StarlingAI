/**
 * search_sessions (Tier 0) — cross-session recall. Full-text search over past
 * conversations, with optional LLM summarization so the swarm can reference
 * earlier work without rehydrating whole transcripts into context.
 */

import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { getChatProvider } from "../providers/index.js";
import { searchSessions, summarizeSession } from "../agent/session-search.js";
import { childLogger } from "../logger.js";

const log = childLogger("tool:session-search");

/** Cap LLM summaries per call so a broad search can't fan out into many calls. */
const MAX_SUMMARIES = 3;

registerTool({
  name: "search_sessions",
  description:
    "Recall past conversations by keyword. Use when the user references earlier work. Returns matching "
    + "sessions with snippets; set summarize=true for short LLM summaries of the top matches.",
  embeddingDescription:
    "recall a previous conversation; what did we discuss earlier; find a past session; cross-session memory; "
    + "earlier decision or deliverable; conversation history search",
  costHint: "low",
  latencyHint: "medium",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What to recall from past conversations.",
      },
      limit: {
        type: "number",
        description: "Maximum number of matching sessions to return. Default: 5.",
      },
      summarize: {
        type: "boolean",
        description: "When true, include a short LLM summary of the top matches. Default: false (snippets only).",
      },
    },
    required: ["query"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const query = String(args["query"] ?? "").trim();
    if (!query) return { success: false, output: "", error: "query is required" };

    const limit = Math.max(1, Math.min(20, Number(args["limit"] ?? 5) || 5));
    const summarize = args["summarize"] === true;

    const matches = searchSessions(query, { limit, excludeSessionId: ctx.sessionId });
    if (matches.length === 0) {
      return {
        success: true,
        output: `No past sessions matched "${query}".`,
        metadata: { sessionMatches: [] },
      };
    }

    let summaries = new Map<string, string>();
    if (summarize) {
      const complete = async (prompt: string): Promise<string> => {
        const provider = getChatProvider();
        const response = await provider.complete([{ role: "user", content: prompt }], []);
        return response.content ?? "";
      };
      const top = matches.slice(0, MAX_SUMMARIES);
      const results = await Promise.all(
        top.map(async (match) => {
          try {
            return [match.id, await summarizeSession(match.id, complete)] as const;
          } catch (err) {
            log.debug({ err, sessionId: match.id }, "session summary failed");
            return [match.id, null] as const;
          }
        }),
      );
      summaries = new Map(results.filter((entry): entry is [string, string] => Boolean(entry[1])));
    }

    const blocks = matches.map((match) => {
      const when = new Date(match.updatedAt).toISOString().slice(0, 10);
      const head = `**${match.id.slice(0, 12)}** [${match.channel}, ${when}, ${match.messageCount} msgs] — matched: ${match.matchedTerms.join(", ")}`;
      const detail = summaries.get(match.id) ?? match.snippet;
      return `${head}\n${detail}`;
    });

    return {
      success: true,
      output: [`Past sessions matching "${query}":`, "", ...blocks].join("\n\n"),
      metadata: {
        sessionMatches: matches.map((match) => ({
          id: match.id,
          score: match.score,
          channel: match.channel,
          updatedAt: match.updatedAt,
          matchedTerms: match.matchedTerms,
        })),
      },
    };
  },
});
