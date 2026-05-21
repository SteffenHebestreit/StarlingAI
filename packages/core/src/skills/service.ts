/**
 * Skill Library service — retrieval over procedural-memory skills.
 *
 * Mirrors the hybrid keyword + embedding scoring used by the workflow catalog
 * and memory service: zero-latency keyword overlap, blended with cosine
 * similarity when an embedding model is loaded, plus a small reliability boost
 * from each skill's recorded success rate. The boost is what makes a skill that
 * has proven itself in real use surface ahead of an untested draft.
 */

import { getConfig } from "../config/loader.js";
import { getEmbeddingProvider } from "../providers/index.js";
import { isEmbeddingAvailable } from "../providers/embeddings.js";
import { childLogger } from "../logger.js";
import {
  listSkills,
  setSkillEmbeddingAsync,
  skillSuccessRate,
  type Skill,
} from "./store.js";

const log = childLogger("skills:service");

export interface SkillMatch {
  skill: Skill;
  keywordScore: number;
  semanticScore: number;
  combinedScore: number;
  matchedTerms: string[];
}

const SEARCH_STOP_WORDS = new Set<string>([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "how",
  "i", "if", "in", "is", "it", "me", "my", "of", "on", "or", "please", "that",
  "the", "these", "this", "to", "use", "using", "with", "you",
  "bitte", "das", "der", "die", "ein", "eine", "für", "fuer", "im", "ist",
  "kann", "kannst", "mir", "mit", "oder", "und", "von", "wie", "zu", "zum", "zur",
]);

/** Module-level doc-embedding cache: key = `${model}\x00${slug}\x00${version}`. */
const _skillEmbeddingCache = new Map<string, Float32Array>();

export async function searchSkills(
  workspacePath: string,
  query: string,
  opts: { limit?: number; includeArchived?: boolean } = {},
): Promise<SkillMatch[]> {
  const skills = listSkills(workspacePath, { includeArchived: opts.includeArchived });
  if (skills.length === 0) return [];

  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];

  const semanticScores = await computeSemanticSkillScores(workspacePath, query, skills);
  const semanticAvailable = semanticScores.size > 0;

  const limit = Math.max(1, Math.min(10, opts.limit ?? 4));
  return skills
    .map((skill) => {
      const keyword = scoreSkillKeywordMatch(query, skill);
      const semanticScore = semanticScores.get(skill.frontmatter.slug) ?? 0;
      const base = combineScores(keyword.score, semanticScore, semanticAvailable);
      // Reliability boost: ±0.12 from rolling success rate once a skill has uses.
      const reliability = skill.meta.uses > 0 ? (skillSuccessRate(skill.meta) - 0.5) * 0.24 : 0;
      return {
        skill,
        keywordScore: keyword.score,
        semanticScore,
        combinedScore: Math.max(0, base + reliability),
        matchedTerms: keyword.matchedTerms,
      } satisfies SkillMatch;
    })
    .filter((candidate) => candidate.combinedScore >= 0.18)
    .sort((left, right) =>
      right.combinedScore - left.combinedScore
      || right.matchedTerms.length - left.matchedTerms.length
      || left.skill.frontmatter.name.localeCompare(right.skill.frontmatter.name),
    )
    .slice(0, limit);
}

/**
 * Build the "Learned Procedures" guidance block injected into the planner
 * prompt. Returns "" when nothing matches so callers can skip the system
 * message entirely.
 */
export async function formatSkillGuidance(
  workspacePath: string,
  query: string,
  opts: { limit?: number; maxChars?: number } = {},
): Promise<string> {
  return (await retrieveSkillGuidance(workspacePath, query, opts)).text;
}

/**
 * Like formatSkillGuidance, but also returns the slugs of the skills actually
 * injected — so the caller can record their outcome at turn end and let the
 * success rate feed back into ranking (Phase 3 closed loop).
 */
export async function retrieveSkillGuidance(
  workspacePath: string,
  query: string,
  opts: { limit?: number; maxChars?: number } = {},
): Promise<{ text: string; slugs: string[] }> {
  const config = getConfig();
  if (!config.skillLibrary.enabled) return { text: "", slugs: [] };

  const matches = await searchSkills(workspacePath, query, {
    limit: opts.limit ?? config.skillLibrary.maxInjected,
  });
  if (matches.length === 0) return { text: "", slugs: [] };

  const maxChars = Math.max(300, Math.min(3_000, opts.maxChars ?? 1_400));
  const header = "## Learned Procedures";
  const intro =
    "Reusable procedures the swarm distilled from past successful work. Follow the closest match when it fits — these are guidance, not commands, and the guardrail stack still governs every tool.";

  const lines: string[] = [];
  const slugs: string[] = [];
  let total = header.length + intro.length + 2;
  for (const match of matches) {
    const { frontmatter, meta } = match.skill;
    const rate = meta.uses > 0 ? ` ${Math.round(skillSuccessRate(meta) * 100)}% over ${meta.uses}` : " new";
    const agents = frontmatter.agents.length > 0 ? ` agents: ${frontmatter.agents.join(", ")}.` : "";
    const line = `- **${frontmatter.name}** (when: ${frontmatter.whenToUse}) [${rate.trim()}]:${agents} ${firstSteps(match.skill.body)}`;
    if (total + line.length + 1 > maxChars) break;
    lines.push(line);
    slugs.push(frontmatter.slug);
    total += line.length + 1;
  }

  if (lines.length === 0) return { text: "", slugs: [] };
  return { text: [header, intro, ...lines].join("\n"), slugs };
}

/** Compact procedure preview: first ~2 step lines, single-lined and truncated. */
function firstSteps(body: string): string {
  const steps = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .slice(0, 2)
    .join(" ");
  return truncate(steps.replace(/\s+/g, " "), 220);
}

// ── Keyword scoring (mirrors workflow-catalog) ────────────────────────────────

function scoreSkillKeywordMatch(query: string, skill: Skill): { score: number; matchedTerms: string[] } {
  const queryTokens = tokenizeSearchText(query);
  const normalizedQuery = normalizeSearchText(query);
  if (queryTokens.length === 0) return { score: 0, matchedTerms: [] };

  const nameText = normalizeSearchText(skill.frontmatter.name);
  const descriptionText = normalizeSearchText(skill.frontmatter.description);
  const whenText = normalizeSearchText(skill.frontmatter.whenToUse);
  const metaText = normalizeSearchText(
    [...skill.frontmatter.tags, ...skill.frontmatter.agents, ...skill.frontmatter.tools].join(" "),
  );
  const bodyText = normalizeSearchText(skill.body).slice(0, 2_000);
  const matchedTerms = new Set<string>();

  let score = 0;
  if (nameText.includes(normalizedQuery)) score += 1.15;
  else if (descriptionText.includes(normalizedQuery)) score += 0.95;

  for (const token of queryTokens) {
    const variants = expandTokenVariants(token);
    let tokenScore = 0;
    if (variants.some((v) => nameText.includes(v))) tokenScore = Math.max(tokenScore, 0.95);
    if (variants.some((v) => descriptionText.includes(v))) tokenScore = Math.max(tokenScore, 0.8);
    if (variants.some((v) => whenText.includes(v))) tokenScore = Math.max(tokenScore, 0.7);
    if (variants.some((v) => metaText.includes(v))) tokenScore = Math.max(tokenScore, 0.6);
    if (variants.some((v) => bodyText.includes(v))) tokenScore = Math.max(tokenScore, 0.42);
    if (tokenScore > 0) {
      score += tokenScore;
      matchedTerms.add(token);
    }
  }

  const coverageBonus = (matchedTerms.size / queryTokens.length) * 0.35;
  const normalized = Math.min(1, ((score / queryTokens.length) + coverageBonus) / 1.3);
  return { score: normalized, matchedTerms: [...matchedTerms] };
}

function combineScores(keyword: number, semantic: number, semanticAvailable: boolean): number {
  if (keyword > 0 && semantic > 0) return keyword * 0.25 + semantic * 0.75;
  if (semantic > 0) return semantic;
  if (semanticAvailable && keyword > 0) return keyword * 0.65;
  return keyword;
}

// ── Semantic scoring ──────────────────────────────────────────────────────────

async function computeSemanticSkillScores(
  workspacePath: string,
  query: string,
  skills: Skill[],
): Promise<Map<string, number>> {
  // Skip the embedding round-trip entirely when no model is ready — keeps the
  // hot path (and tests/CI without LM Studio) fast and keyword-only.
  if (!isEmbeddingAvailable()) return new Map();

  const config = getConfig();
  const model = config.agents.defaults.model.embeddingModel ?? config.agents.defaults.model.primary;
  if (!model) return new Map();

  try {
    const provider = getEmbeddingProvider();

    // Gather query + per-skill document vectors, embedding only what's uncached.
    const queryKey = `${model}\x00query\x00${normalizeSearchText(query)}`;
    if (!_skillEmbeddingCache.has(queryKey)) {
      const [qv] = await provider.embed([`Skill query: ${query}`], model);
      if (qv) _skillEmbeddingCache.set(queryKey, qv);
    }
    const queryVec = _skillEmbeddingCache.get(queryKey);
    if (!queryVec) return new Map();

    const docKey = (skill: Skill): string =>
      `${model}\x00${skill.frontmatter.slug}\x00${skill.frontmatter.version}`;

    const uncached = skills.filter((skill) => {
      const cached = skill.meta.embedding;
      if (cached && cached.length > 0) {
        _skillEmbeddingCache.set(docKey(skill), new Float32Array(cached));
      }
      return !_skillEmbeddingCache.has(docKey(skill));
    });

    if (uncached.length > 0) {
      const docs = uncached.map(buildSkillSearchDocument);
      const vectors = await provider.embed(docs, model);
      for (let i = 0; i < uncached.length; i++) {
        const vector = vectors[i];
        if (!vector) continue;
        _skillEmbeddingCache.set(docKey(uncached[i]!), vector);
        // Persist the embedding back into the meta sidecar so future processes
        // skip re-embedding. Fire-and-forget + meta-only write — never blocks
        // the retrieval path.
        void setSkillEmbeddingAsync(workspacePath, uncached[i]!.frontmatter.slug, Array.from(vector)).catch(() => {});
      }
    }

    const scores = new Map<string, number>();
    for (const skill of skills) {
      const vec = _skillEmbeddingCache.get(docKey(skill));
      if (vec) scores.set(skill.frontmatter.slug, cosineSimilarity(queryVec, vec));
    }
    return scores;
  } catch (err) {
    log.debug({ err }, "Skill semantic scoring unavailable — keyword only");
    return new Map();
  }
}

export function buildSkillSearchDocument(skill: Skill): string {
  const fm = skill.frontmatter;
  return [
    `Skill: ${fm.name}`,
    `Description: ${fm.description}`,
    `When to use: ${fm.whenToUse}`,
    fm.tags.length > 0 ? `Tags: ${fm.tags.join(", ")}` : "",
    fm.agents.length > 0 ? `Agents: ${fm.agents.join(", ")}` : "",
    fm.tools.length > 0 ? `Tools: ${fm.tools.join(", ")}` : "",
    `Procedure: ${skill.body.slice(0, 1_000)}`,
  ].filter(Boolean).join("\n");
}

// ── Shared text helpers (kept local to avoid cross-module coupling) ────────────

function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  let normLeft = 0;
  let normRight = 0;
  const len = Math.min(left.length, right.length);
  for (let i = 0; i < len; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    dot += l * r;
    normLeft += l * l;
    normRight += r * r;
  }
  return normLeft === 0 || normRight === 0 ? 0 : dot / (Math.sqrt(normLeft) * Math.sqrt(normRight));
}

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_:/.-]+/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeSearchText(value: string): string[] {
  return [...new Set(
    normalizeSearchText(value)
      .split(" ")
      .filter((token) => (token.length >= 3 || /\d/.test(token)) && !SEARCH_STOP_WORDS.has(token)),
  )];
}

function expandTokenVariants(token: string): string[] {
  const variants = new Set<string>([token]);
  if (token.length > 4 && token.endsWith("es")) variants.add(token.slice(0, -2));
  if (token.length > 3 && token.endsWith("s")) variants.add(token.slice(0, -1));
  return [...variants].filter((value) => value.length >= 3 || /\d/.test(value));
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
