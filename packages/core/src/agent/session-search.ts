/**
 * Session Intelligence — full-text search over past sessions with optional LLM
 * summarization. Lets the swarm recall "what did we do / decide weeks ago"
 * without rehydrating whole transcripts into the context window.
 *
 * Search is keyword/FTS-style and deterministic; summarization is an optional,
 * best-effort LLM pass (injectable for tests).
 */

import { getAllSessions, type AgentSession } from "./session.js";

const STOPWORDS = new Set<string>([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "how",
  "i", "if", "in", "is", "it", "me", "my", "of", "on", "or", "that", "the",
  "to", "was", "we", "what", "when", "with", "you", "did", "do", "does",
  "der", "die", "das", "und", "oder", "für", "fuer", "ist", "im", "von", "wie",
  "was", "wir", "mit", "zu", "zum", "zur", "den", "dem", "ein", "eine",
]);

export interface SessionSearchResult {
  id: string;
  channel: string;
  userId?: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  messageCount: number;
  score: number;
  matchedTerms: string[];
  /** Extractive snippet around the best-matching message. */
  snippet: string;
}

export interface SearchSessionsOptions {
  limit?: number;
  excludeSessionId?: string;
  includeArchived?: boolean;
  minMessages?: number;
}

export function searchSessions(query: string, opts: SearchSessionsOptions = {}): SessionSearchResult[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const limit = Math.max(1, Math.min(20, opts.limit ?? 5));
  const minMessages = opts.minMessages ?? 2;
  const includeArchived = opts.includeArchived ?? true;

  const results: SessionSearchResult[] = [];
  for (const session of getAllSessions({ includeArchived })) {
    if (opts.excludeSessionId && session.id === opts.excludeSessionId) continue;

    const messages = extractMessages(session);
    if (messages.length < minMessages) continue;

    const scored = scoreSession(messages, tokens);
    if (scored.score <= 0) continue;

    const recency = recencyBoost(session.getUpdatedAt());
    results.push({
      id: session.id,
      channel: session.channel,
      userId: session.userId,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.getUpdatedAt().toISOString(),
      archived: session.isArchived(),
      messageCount: messages.length,
      score: scored.score + recency,
      matchedTerms: scored.matchedTerms,
      snippet: scored.snippet,
    });
  }

  return results
    .sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
}

/**
 * Summarize a session's transcript. Uses the injected `complete` function when
 * available (LLM), otherwise falls back to a cheap extractive summary so the
 * caller always gets something useful.
 */
export async function summarizeSession(
  sessionId: string,
  complete?: (prompt: string) => Promise<string>,
): Promise<string | null> {
  const session = getAllSessions({ includeArchived: true }).find((s) => s.id === sessionId);
  if (!session) return null;

  const messages = extractMessages(session);
  if (messages.length === 0) return null;

  if (!complete) return extractiveSummary(messages);

  const transcript = messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n")
    .slice(0, 6_000);

  try {
    const prompt =
      `Summarize this past conversation in 2-4 sentences. Capture the user's goal, what was decided or produced, and any open follow-ups. Be concrete.\n\n${transcript}`;
    const out = (await complete(prompt)).trim();
    return out || extractiveSummary(messages);
  } catch {
    return extractiveSummary(messages);
  }
}

// ── Internals ─────────────────────────────────────────────────────────────────

interface SearchableMessage {
  role: "user" | "assistant";
  content: string;
}

function extractMessages(session: AgentSession): SearchableMessage[] {
  const out: SearchableMessage[] = [];
  for (const msg of session.getHistory()) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const content = coerceText((msg as { content?: unknown }).content);
    if (!content) continue;
    out.push({ role: msg.role, content });
  }
  return out;
}

function coerceText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : typeof (part as { text?: unknown })?.text === "string" ? (part as { text: string }).text : ""))
      .join(" ")
      .trim();
  }
  return "";
}

function scoreSession(
  messages: SearchableMessage[],
  tokens: string[],
): { score: number; matchedTerms: string[]; snippet: string } {
  const matched = new Set<string>();
  let score = 0;
  let bestMessage = "";
  let bestMessageHits = 0;

  for (const message of messages) {
    const lower = message.content.toLowerCase();
    let messageHits = 0;
    for (const token of tokens) {
      if (!lower.includes(token)) continue;
      matched.add(token);
      messageHits += 1;
      // User messages express intent — weight their matches a touch higher.
      score += message.role === "user" ? 0.14 : 0.1;
    }
    if (messageHits > bestMessageHits) {
      bestMessageHits = messageHits;
      bestMessage = message.content;
    }
  }

  if (matched.size === 0) return { score: 0, matchedTerms: [], snippet: "" };

  // Coverage bonus rewards sessions that hit more of the distinct query terms.
  const coverage = (matched.size / tokens.length) * 0.4;
  return {
    score: score + coverage,
    matchedTerms: [...matched],
    snippet: buildSnippet(bestMessage, tokens),
  };
}

function buildSnippet(text: string, tokens: string[]): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= 240) return single;

  const lower = single.toLowerCase();
  let anchor = -1;
  for (const token of tokens) {
    const idx = lower.indexOf(token);
    if (idx >= 0 && (anchor === -1 || idx < anchor)) anchor = idx;
  }
  if (anchor === -1) return `${single.slice(0, 239)}…`;

  const start = Math.max(0, anchor - 80);
  const end = Math.min(single.length, anchor + 160);
  return `${start > 0 ? "…" : ""}${single.slice(start, end).trim()}${end < single.length ? "…" : ""}`;
}

function extractiveSummary(messages: SearchableMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
  const parts: string[] = [];
  if (firstUser) parts.push(`Asked: ${truncate(firstUser.content, 200)}`);
  if (lastAssistant) parts.push(`Outcome: ${truncate(lastAssistant.content, 240)}`);
  return parts.join(" ") || truncate(messages[0]!.content, 240);
}

function tokenize(value: string): string[] {
  return [...new Set(
    value
      .toLowerCase()
      .replace(/[^a-z0-9\s]+/g, " ")
      .split(/\s+/)
      .filter((token) => (token.length >= 3 || /\d/.test(token)) && !STOPWORDS.has(token)),
  )];
}

function recencyBoost(updatedAt: Date): number {
  const ageDays = Math.max(0, (Date.now() - updatedAt.getTime()) / 86_400_000);
  return Math.max(0, 0.2 - Math.min(0.2, ageDays * 0.01));
}

function truncate(value: string, maxChars: number): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length <= maxChars ? single : `${single.slice(0, maxChars - 1)}…`;
}
