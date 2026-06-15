import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";

const log = childLogger("retrieval:reranker");

export interface RerankerCandidate {
  id: string;
  title: string;
  content: string;
}

/**
 * Rerank candidates by relevance to `query`, returning a map of candidate id →
 * score in [0, 1], or `null` when reranking is disabled/unavailable (callers
 * then keep their base ordering). Two backends:
 *
 *  - "tei": a cross-encoder rerank endpoint (HuggingFace text-embeddings-inference
 *    or Infinity) that serves bge-reranker-v2-m3 properly. `POST {baseUrl}/rerank`
 *    with `{query, texts}` → `[{index, score}]`. This is what engram uses too,
 *    so a single TEI sidecar backs both.
 *  - "llm": an OpenAI-compatible chat model scores candidates as JSON. Slower and
 *    coarser but needs no dedicated reranker model.
 *
 * Never throws — any failure degrades to `null`.
 */
export async function rerankCandidates(
  query: string,
  candidates: RerankerCandidate[],
): Promise<Map<string, number> | null> {
  const reranker = getConfig().retrieval.reranker;
  if (!reranker.enabled || candidates.length < 2) return null;

  const limited = candidates.slice(0, reranker.topK);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), reranker.timeoutMs);

  try {
    return reranker.mode === "llm"
      ? await rerankViaLlm(query, limited, reranker, controller.signal)
      : await rerankViaTei(query, limited, reranker, controller.signal);
  } catch (error) {
    log.warn({ error, mode: reranker.mode }, "Reranker unavailable — keeping base routing order");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

type RerankerConfig = ReturnType<typeof getConfig>["retrieval"]["reranker"];

/**
 * Cross-encoder rerank via the TEI / Infinity `/rerank` contract:
 *   request:  { query, texts: string[] }
 *   response: [{ index: number, score: number }, ...]  (TEI)
 *             or { results: [{ index, relevance_score }] }  (Infinity/Cohere-style)
 * Scores are model-dependent (logits for raw TEI), so they are min-max
 * normalized into [0, 1] for a stable contract with callers.
 */
async function rerankViaTei(
  query: string,
  candidates: RerankerCandidate[],
  reranker: RerankerConfig,
  signal: AbortSignal,
): Promise<Map<string, number> | null> {
  const texts = candidates.map((c) => `${c.title}\n${c.content}`.slice(0, 2000));
  const response = await fetch(`${reranker.baseUrl.replace(/\/$/, "")}/rerank`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(reranker.apiKey ? { Authorization: `Bearer ${reranker.apiKey}` } : {}),
    },
    body: JSON.stringify({ query, texts, model: reranker.model }),
    signal,
  });

  if (!response.ok) {
    log.warn({ status: response.status }, "TEI reranker request failed — keeping base routing order");
    return null;
  }

  const body = await response.json() as
    | Array<{ index?: number; score?: number; relevance_score?: number }>
    | { results?: Array<{ index?: number; score?: number; relevance_score?: number }> };
  const rows = Array.isArray(body) ? body : (body.results ?? []);
  if (rows.length === 0) return null;

  const raw: Array<{ id: string; score: number }> = [];
  for (const row of rows) {
    if (typeof row?.index !== "number") continue;
    const candidate = candidates[row.index];
    if (!candidate) continue;
    const score = typeof row.score === "number" ? row.score
      : typeof row.relevance_score === "number" ? row.relevance_score
      : undefined;
    if (typeof score !== "number" || !Number.isFinite(score)) continue;
    raw.push({ id: candidate.id, score });
  }
  if (raw.length === 0) return null;

  // Normalize to [0, 1] so callers get a consistent scale regardless of whether
  // the endpoint returned sigmoid probabilities or raw logits.
  const scores = raw.map((r) => r.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const span = max - min;
  const out = new Map<string, number>();
  for (const { id, score } of raw) {
    out.set(id, span > 1e-9 ? (score - min) / span : 1);
  }
  return out.size > 0 ? out : null;
}

/** LLM-as-reranker via OpenAI-compatible chat completions with JSON output. */
async function rerankViaLlm(
  query: string,
  candidates: RerankerCandidate[],
  reranker: RerankerConfig,
  signal: AbortSignal,
): Promise<Map<string, number> | null> {
  const payload = {
    query,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      title: candidate.title,
      content: candidate.content.slice(0, 2000),
    })),
  };

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
    signal,
  });

  if (!response.ok) {
    log.warn({ status: response.status }, "LLM reranker request failed — keeping base routing order");
    return null;
  }

  const body = await response.json() as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };

  const rawContent = body.choices?.[0]?.message?.content?.trim();
  if (!rawContent) return null;

  const parsed = JSON.parse(rawContent) as { results?: Array<{ id?: string; score?: number }> };
  const scores = new Map<string, number>();
  for (const item of parsed.results ?? []) {
    if (!item?.id || typeof item.score !== "number") continue;
    scores.set(item.id, Math.max(0, Math.min(1, item.score)));
  }

  return scores.size > 0 ? scores : null;
}
