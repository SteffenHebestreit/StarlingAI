import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";

const log = childLogger("retrieval:reranker");

export interface RerankerCandidate {
  id: string;
  title: string;
  content: string;
}

export async function rerankCandidates(
  query: string,
  candidates: RerankerCandidate[],
): Promise<Map<string, number> | null> {
  const reranker = getConfig().retrieval.reranker;
  if (!reranker.enabled || candidates.length < 2) return null;

  const limited = candidates.slice(0, reranker.topK);
  const payload = {
    query,
    candidates: limited.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      content: candidate.content.slice(0, 2000),
    })),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), reranker.timeoutMs);

  try {
    const response = await fetch(`${reranker.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${reranker.apiKey}`,
      },
      body: JSON.stringify({
        model: reranker.model,
        temperature: 0,
        max_tokens: 800,
        messages: [
          {
            role: "system",
            content:
              "You are a retrieval reranker. Rank candidates by relevance to the query. Return JSON only with the shape {\"results\":[{\"id\":string,\"score\":number}]}. Scores must be between 0 and 1 and results must be sorted descending.",
          },
          {
            role: "user",
            content: JSON.stringify(payload),
          },
        ],
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      log.warn({ status: response.status }, "Reranker request failed — keeping base routing order");
      return null;
    }

    const body = await response.json() as {
      choices?: Array<{ message?: { content?: string | null } }>;
    };

    const raw = body.choices?.[0]?.message?.content?.trim();
    if (!raw) return null;

    const parsed = JSON.parse(raw) as { results?: Array<{ id?: string; score?: number }> };
    const scores = new Map<string, number>();
    for (const item of parsed.results ?? []) {
      if (!item?.id || typeof item.score !== "number") continue;
      scores.set(item.id, Math.max(0, Math.min(1, item.score)));
    }

    return scores.size > 0 ? scores : null;
  } catch (error) {
    log.warn({ error }, "Reranker unavailable — keeping base routing order");
    return null;
  } finally {
    clearTimeout(timer);
  }
}