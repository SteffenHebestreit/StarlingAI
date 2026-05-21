/**
 * Skill Library store — first-class procedural-memory artifacts.
 *
 * A "skill" is a named, versioned PROCEDURE (how to accomplish a recurring
 * task) — not code, and not an agent. It is stored as a portable `SKILL.md`
 * file: YAML frontmatter (name, description, version, whenToUse, agents, tools)
 * plus a Markdown body holding the step procedure and pitfalls.
 *
 * This is the swarm-writable, NON-PRIVILEGED self-improvement surface described
 * by the Bounded Self-Improvement principle (architecture.md §3.5): skills are
 * pure guidance. They cannot grant tools, alter tiers, or bypass approval — the
 * guardrail stack still governs every tool a skill suggests.
 *
 * Layout (workspace-scoped, mirroring flow_memory / trajectory_cache):
 *   .starlingai/skills/<slug>/SKILL.md          ← portable Markdown + frontmatter
 *   .starlingai/skills/<slug>/skill.meta.json   ← outcome stats + embedding
 *
 * Security:
 * - Credential-shaped content is rejected before persistence (same RE family as
 *   trajectory-cache), so secrets never leak into a reusable procedure.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { childLogger } from "../logger.js";

const log = childLogger("skills:store");

const SKILLS_SUBDIR = ".starlingai/skills";

// Field caps keep injected prompts bounded and disk footprints predictable.
const MAX_NAME = 120;
const MAX_DESCRIPTION = 600;
const MAX_WHEN_TO_USE = 400;
const MAX_BODY = 8_000;
const MAX_LIST_ITEMS = 16;
const MAX_LIST_ITEM = 60;

// Naïve credential-pattern detector — refuse to persist a skill containing one.
const CREDENTIAL_RE = /(?:password|secret|token|api[_-]?key|bearer|authorization)\s*[:=]\s*\S+/i;

export type SkillStatus = "draft" | "active" | "archived";
export type SkillOrigin = "manual" | "agent" | "distilled";

export interface SkillFrontmatter {
  /** Human-readable title. */
  name: string;
  /** Stable kebab-case identifier (folder name). */
  slug: string;
  description: string;
  version: number;
  status: SkillStatus;
  /** One-line trigger condition: when this procedure applies. */
  whenToUse: string;
  tags: string[];
  /** Specialist sub-agents the procedure typically routes through. */
  agents: string[];
  /** Tools the procedure typically relies on (advisory only — not a grant). */
  tools: string[];
}

export interface SkillMeta {
  slug: string;
  origin: SkillOrigin;
  createdAt: string;
  updatedAt: string;
  uses: number;
  successes: number;
  failures: number;
  lastUsedAt?: string;
  sourceSessionId?: string;
  /** Cached embedding of the search document (number[] for JSON). */
  embedding?: number[];
}

export interface Skill {
  frontmatter: SkillFrontmatter;
  body: string;
  meta: SkillMeta;
}

export interface WriteSkillInput {
  name: string;
  description: string;
  whenToUse?: string;
  /** Markdown body — the step-by-step procedure and pitfalls. */
  procedure: string;
  tags?: string[];
  agents?: string[];
  tools?: string[];
  status?: SkillStatus;
  origin?: SkillOrigin;
  sourceSessionId?: string;
  /** Force a specific slug (e.g. when updating a known skill). */
  slug?: string;
}

export class SkillCredentialError extends Error {
  constructor() {
    super("Skill content contains credential-shaped text and was rejected");
    this.name = "SkillCredentialError";
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export function slugifySkillName(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return base || "skill";
}

export function skillsDir(workspacePath: string): string {
  return resolve(workspacePath, SKILLS_SUBDIR);
}

export function listSkills(
  workspacePath: string,
  opts: { includeArchived?: boolean } = {},
): Skill[] {
  const dir = skillsDir(workspacePath);
  if (!existsSync(dir)) return [];

  const skills: Skill[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  for (const slug of entries) {
    const skill = getSkill(workspacePath, slug);
    if (!skill) continue;
    if (!opts.includeArchived && skill.frontmatter.status === "archived") continue;
    skills.push(skill);
  }

  return skills.sort((left, right) => right.meta.updatedAt.localeCompare(left.meta.updatedAt));
}

export function getSkill(workspacePath: string, slug: string): Skill | null {
  const safe = slugifySkillName(slug);
  const skillFile = resolve(skillsDir(workspacePath), safe, "SKILL.md");
  if (!existsSync(skillFile)) return null;

  try {
    const raw = readFileSync(skillFile, "utf-8");
    const { frontmatter, body } = parseSkillFile(raw, safe);
    const meta = readSkillMeta(workspacePath, safe);
    return { frontmatter, body, meta };
  } catch (err) {
    log.warn({ err, slug: safe }, "Failed to read skill");
    return null;
  }
}

/**
 * Create a skill, or update an existing one (matched by slug). Content changes
 * bump the version; outcome stats and creation time are preserved across
 * updates. Rejects credential-shaped content.
 */
export function writeSkill(workspacePath: string, input: WriteSkillInput): Skill {
  const name = input.name.trim().slice(0, MAX_NAME);
  const slug = input.slug ? slugifySkillName(input.slug) : slugifySkillName(name);
  const description = input.description.trim().slice(0, MAX_DESCRIPTION);
  const whenToUse = (input.whenToUse?.trim() || description).slice(0, MAX_WHEN_TO_USE);
  const body = input.procedure.trim().slice(0, MAX_BODY);

  if (!name || !description || !body) {
    throw new Error("Skill requires a name, description, and procedure body");
  }

  // Defence in depth: never persist a procedure that embeds a secret.
  const composite = `${name}\n${description}\n${whenToUse}\n${body}`;
  if (CREDENTIAL_RE.test(composite)) {
    throw new SkillCredentialError();
  }

  const existing = getSkill(workspacePath, slug);
  const now = new Date().toISOString();

  const tags = normalizeList(input.tags);
  const agents = normalizeList(input.agents);
  const tools = normalizeList(input.tools);
  const status: SkillStatus = input.status ?? existing?.frontmatter.status ?? "draft";

  const contentChanged = !existing
    || existing.body !== body
    || existing.frontmatter.description !== description
    || existing.frontmatter.whenToUse !== whenToUse
    || !sameList(existing.frontmatter.agents, agents)
    || !sameList(existing.frontmatter.tools, tools)
    || !sameList(existing.frontmatter.tags, tags);

  const version = existing
    ? (contentChanged ? existing.frontmatter.version + 1 : existing.frontmatter.version)
    : 1;

  const frontmatter: SkillFrontmatter = {
    name,
    slug,
    description,
    version,
    status,
    whenToUse,
    tags,
    agents,
    tools,
  };

  const meta: SkillMeta = {
    slug,
    origin: existing?.meta.origin ?? input.origin ?? "manual",
    createdAt: existing?.meta.createdAt ?? now,
    updatedAt: now,
    uses: existing?.meta.uses ?? 0,
    successes: existing?.meta.successes ?? 0,
    failures: existing?.meta.failures ?? 0,
    lastUsedAt: existing?.meta.lastUsedAt,
    sourceSessionId: existing?.meta.sourceSessionId ?? input.sourceSessionId,
    // Drop the cached embedding when content changes — service recomputes lazily.
    embedding: contentChanged ? undefined : existing?.meta.embedding,
  };

  persistSkill(workspacePath, frontmatter, body, meta);
  return { frontmatter, body, meta };
}

/** Record the outcome of a skill that was retrieved and applied this turn. */
export function recordSkillOutcome(
  workspacePath: string,
  slug: string,
  outcome: "success" | "failure",
): void {
  const skill = getSkill(workspacePath, slug);
  if (!skill) return;

  skill.meta.uses += 1;
  if (outcome === "success") skill.meta.successes += 1;
  else skill.meta.failures += 1;
  skill.meta.lastUsedAt = new Date().toISOString();

  // A draft that has proven itself in real use graduates to active.
  if (skill.frontmatter.status === "draft" && skill.meta.successes >= 1) {
    skill.frontmatter.status = "active";
  }

  persistSkill(workspacePath, skill.frontmatter, skill.body, skill.meta);
}

export function setSkillEmbedding(workspacePath: string, slug: string, embedding: number[]): void {
  const skill = getSkill(workspacePath, slug);
  if (!skill) return;
  skill.meta.embedding = embedding;
  persistSkill(workspacePath, skill.frontmatter, skill.body, skill.meta);
}

// ── Async, non-blocking variants (hot path) ──────────────────────────────────
// Used from the turn-completion path and the retrieval search so we never do
// blocking disk I/O on the request critical path. They yield at the first read,
// and write only the meta sidecar (frontmatter is unchanged), avoiding a full
// SKILL.md rewrite — except outcome graduation (draft→active), which is rare.

async function readSkillAsync(workspacePath: string, slug: string): Promise<Skill | null> {
  const safe = slugifySkillName(slug);
  const dir = resolve(skillsDir(workspacePath), safe);
  let raw: string;
  try {
    raw = await readFile(resolve(dir, "SKILL.md"), "utf-8");
  } catch {
    return null;
  }
  const { frontmatter, body } = parseSkillFile(raw, safe);
  let meta: SkillMeta;
  try {
    meta = coerceSkillMeta(JSON.parse(await readFile(resolve(dir, "skill.meta.json"), "utf-8")) as Partial<SkillMeta>, safe);
  } catch {
    meta = fallbackMeta(safe);
  }
  return { frontmatter, body, meta };
}

async function persistSkillMetaAsync(workspacePath: string, meta: SkillMeta): Promise<void> {
  const dir = resolve(skillsDir(workspacePath), meta.slug);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "skill.meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
}

/** Async outcome recording — safe to call fire-and-forget from the hot path. */
export async function recordSkillOutcomeAsync(
  workspacePath: string,
  slug: string,
  outcome: "success" | "failure",
): Promise<void> {
  const skill = await readSkillAsync(workspacePath, slug);
  if (!skill) return;

  skill.meta.uses += 1;
  if (outcome === "success") skill.meta.successes += 1;
  else skill.meta.failures += 1;
  skill.meta.lastUsedAt = new Date().toISOString();

  if (skill.frontmatter.status === "draft" && skill.meta.successes >= 1) {
    // Graduation changes the frontmatter, so both files must be rewritten (rare).
    skill.frontmatter.status = "active";
    persistSkill(workspacePath, skill.frontmatter, skill.body, skill.meta);
    return;
  }
  await persistSkillMetaAsync(workspacePath, skill.meta);
}

/** Async embedding cache — writes only the meta sidecar, fire-and-forget. */
export async function setSkillEmbeddingAsync(
  workspacePath: string,
  slug: string,
  embedding: number[],
): Promise<void> {
  const skill = await readSkillAsync(workspacePath, slug);
  if (!skill) return;
  skill.meta.embedding = embedding;
  await persistSkillMetaAsync(workspacePath, skill.meta);
}

export function setSkillStatus(workspacePath: string, slug: string, status: SkillStatus): void {
  const skill = getSkill(workspacePath, slug);
  if (!skill) return;
  skill.frontmatter.status = status;
  skill.meta.updatedAt = new Date().toISOString();
  persistSkill(workspacePath, skill.frontmatter, skill.body, skill.meta);
}

export function deleteSkill(workspacePath: string, slug: string): void {
  const safe = slugifySkillName(slug);
  const dir = resolve(skillsDir(workspacePath), safe);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    log.warn({ err, slug: safe }, "Failed to delete skill");
  }
}

export function skillSuccessRate(meta: SkillMeta): number {
  if (meta.uses <= 0) return 0;
  return meta.successes / meta.uses;
}

// ── Persistence ──────────────────────────────────────────────────────────────

function persistSkill(
  workspacePath: string,
  frontmatter: SkillFrontmatter,
  body: string,
  meta: SkillMeta,
): void {
  const dir = resolve(skillsDir(workspacePath), frontmatter.slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "SKILL.md"), serializeSkillFile(frontmatter, body), "utf-8");
  writeFileSync(resolve(dir, "skill.meta.json"), `${JSON.stringify(meta, null, 2)}\n`, "utf-8");
}

function fallbackMeta(slug: string): SkillMeta {
  const now = new Date().toISOString();
  return { slug, origin: "manual", createdAt: now, updatedAt: now, uses: 0, successes: 0, failures: 0 };
}

function coerceSkillMeta(raw: Partial<SkillMeta>, slug: string): SkillMeta {
  const fallback = fallbackMeta(slug);
  return {
    slug,
    origin: raw.origin ?? "manual",
    createdAt: raw.createdAt ?? fallback.createdAt,
    updatedAt: raw.updatedAt ?? fallback.updatedAt,
    uses: typeof raw.uses === "number" ? raw.uses : 0,
    successes: typeof raw.successes === "number" ? raw.successes : 0,
    failures: typeof raw.failures === "number" ? raw.failures : 0,
    lastUsedAt: raw.lastUsedAt,
    sourceSessionId: raw.sourceSessionId,
    embedding: Array.isArray(raw.embedding) ? raw.embedding : undefined,
  };
}

function readSkillMeta(workspacePath: string, slug: string): SkillMeta {
  const metaFile = resolve(skillsDir(workspacePath), slug, "skill.meta.json");
  if (!existsSync(metaFile)) return fallbackMeta(slug);
  try {
    return coerceSkillMeta(JSON.parse(readFileSync(metaFile, "utf-8")) as Partial<SkillMeta>, slug);
  } catch {
    return fallbackMeta(slug);
  }
}

// ── SKILL.md (de)serialization ───────────────────────────────────────────────
// Minimal YAML-frontmatter subset, hand-rolled to match the codebase's
// dependency-free parsing convention. Supports `key: scalar`, inline arrays
// `key: [a, b]`, and block arrays (`  - item`). We control the write format;
// the reader is tolerant so hand-edited or externally authored SKILL.md files still load.

export function serializeSkillFile(frontmatter: SkillFrontmatter, body: string): string {
  const lines = [
    "---",
    `name: ${quoteScalar(frontmatter.name)}`,
    `slug: ${frontmatter.slug}`,
    `description: ${quoteScalar(frontmatter.description)}`,
    `version: ${frontmatter.version}`,
    `status: ${frontmatter.status}`,
    `whenToUse: ${quoteScalar(frontmatter.whenToUse)}`,
    `tags: ${serializeInlineList(frontmatter.tags)}`,
    `agents: ${serializeInlineList(frontmatter.agents)}`,
    `tools: ${serializeInlineList(frontmatter.tools)}`,
    "---",
    "",
    body.trim(),
    "",
  ];
  return lines.join("\n");
}

export function parseSkillFile(
  raw: string,
  slug: string,
): { frontmatter: SkillFrontmatter; body: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  let body = normalized.trim();
  let fmText = "";

  if (normalized.startsWith("---\n")) {
    const end = normalized.indexOf("\n---", 4);
    if (end !== -1) {
      fmText = normalized.slice(4, end);
      const afterMarker = normalized.indexOf("\n", end + 1);
      body = afterMarker !== -1 ? normalized.slice(afterMarker + 1).trim() : "";
    }
  }

  const fm = parseFrontmatterBlock(fmText);

  const name = (fm.scalar("name") || slug).slice(0, MAX_NAME);
  const description = (fm.scalar("description") || name).slice(0, MAX_DESCRIPTION);
  const versionRaw = Number.parseInt(fm.scalar("version") || "1", 10);
  const statusRaw = fm.scalar("status");
  const status: SkillStatus =
    statusRaw === "active" || statusRaw === "archived" || statusRaw === "draft"
      ? statusRaw
      : "active";

  const frontmatter: SkillFrontmatter = {
    name,
    slug,
    description,
    version: Number.isFinite(versionRaw) && versionRaw > 0 ? versionRaw : 1,
    status,
    whenToUse: (fm.scalar("whenToUse") || description).slice(0, MAX_WHEN_TO_USE),
    tags: normalizeList(fm.list("tags")),
    agents: normalizeList(fm.list("agents")),
    tools: normalizeList(fm.list("tools")),
  };

  return { frontmatter, body: body.slice(0, MAX_BODY) };
}

interface FrontmatterAccessor {
  scalar(key: string): string;
  list(key: string): string[];
}

function parseFrontmatterBlock(text: string): FrontmatterAccessor {
  const scalars = new Map<string, string>();
  const lists = new Map<string, string[]>();
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1]!;
    const rest = (match[2] ?? "").trim();

    if (rest.startsWith("[") && rest.endsWith("]")) {
      lists.set(key, splitInlineList(rest));
      continue;
    }

    if (rest === "") {
      // Possible block list on following indented `- item` lines.
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+/.test(lines[j]!)) {
        items.push(stripQuotes(lines[j]!.replace(/^\s*-\s+/, "").trim()));
        j++;
      }
      if (items.length > 0) {
        lists.set(key, items);
        i = j - 1;
        continue;
      }
      scalars.set(key, "");
      continue;
    }

    scalars.set(key, stripQuotes(rest));
  }

  return {
    scalar: (key) => scalars.get(key) ?? "",
    list: (key) => lists.get(key) ?? [],
  };
}

function serializeInlineList(values: string[]): string {
  if (values.length === 0) return "[]";
  return `[${values.map((value) => quoteScalar(value)).join(", ")}]`;
}

function splitInlineList(value: string): string[] {
  return value
    .slice(1, -1)
    .split(",")
    .map((item) => stripQuotes(item.trim()))
    .filter(Boolean);
}

function quoteScalar(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  return `"${cleaned.replace(/"/g, '\\"')}"`;
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"');
  }
  return trimmed;
}

function normalizeList(values: string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values ?? []) {
    const value = String(raw).trim().slice(0, MAX_LIST_ITEM);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= MAX_LIST_ITEMS) break;
  }
  return out;
}

function sameList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}
