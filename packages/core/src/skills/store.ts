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
 *   .starlingai/skills/<slug>/skill.history.json ← bounded mutation history for rollback
 *   .starlingai/skills/<slug>/{references,templates,scripts,assets}/... ← support files
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
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { childLogger } from "../logger.js";

const log = childLogger("skills:store");

const SKILLS_SUBDIR = ".starlingai/skills";
const SUPPORT_FILE_DIRS = new Set(["references", "templates", "scripts", "assets"]);
const HISTORY_FILE = "skill.history.json";
const MAX_HISTORY_ENTRIES = 50;

// Field caps keep injected prompts bounded and disk footprints predictable.
const MAX_NAME = 120;
const MAX_DESCRIPTION = 600;
const MAX_WHEN_TO_USE = 400;
const MAX_BODY = 8_000;
const MAX_LIST_ITEMS = 16;
const MAX_LIST_ITEM = 60;
const MAX_SUPPORT_FILE_CHARS = 100_000;
const MAX_SUPPORT_FILE_BYTES = 1_048_576;

// Naïve credential-pattern detector — refuse to persist a skill containing one.
const CREDENTIAL_RE = /(?:password|secret|token|api[_-]?key|bearer|authorization)\s*[:=]\s*\S+/i;

export type SkillStatus = "draft" | "active" | "stale" | "archived";
export type SkillOrigin = "manual" | "agent" | "distilled";
export type SkillSupportDir = "references" | "templates" | "scripts" | "assets";

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
  /** True when deterministic/background curation may retire/archive this skill. */
  curatorManaged: boolean;
  createdAt: string;
  updatedAt: string;
  views: number;
  uses: number;
  successes: number;
  failures: number;
  patches: number;
  lastViewedAt?: string;
  lastUsedAt?: string;
  lastPatchedAt?: string;
  sourceSessionId?: string;
  pinned: boolean;
  archivedAt?: string;
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
  /** Opt this skill into deterministic lifecycle curation. Defaults to distilled-only. */
  curatorManaged?: boolean;
  sourceSessionId?: string;
  /** Force a specific slug (e.g. when updating a known skill). */
  slug?: string;
}

export interface PatchSkillInput {
  /** Defaults to SKILL.md. Support files must live under references/, templates/, scripts/, or assets/. */
  filePath?: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export type SkillHistoryAction = "write_skill" | "patch" | "write_file" | "remove_file" | "rollback";

export interface SkillHistoryEntry {
  id: string;
  action: SkillHistoryAction;
  filePath: "SKILL.md" | string;
  createdAt: string;
  versionBefore: number;
  versionAfter: number;
  previousExists: boolean;
  nextExists: boolean;
  previousContent?: string;
  nextContent?: string;
  summary?: string;
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

export function listSkillHistory(workspacePath: string, slug: string): SkillHistoryEntry[] {
  return readSkillHistory(workspacePath, slug).slice().reverse();
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

  assertNoCredential(`${name}\n${description}\n${whenToUse}\n${body}`);

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
    curatorManaged: existing?.meta.curatorManaged ?? input.curatorManaged ?? (input.origin === "distilled"),
    createdAt: existing?.meta.createdAt ?? now,
    updatedAt: now,
    views: existing?.meta.views ?? 0,
    uses: existing?.meta.uses ?? 0,
    successes: existing?.meta.successes ?? 0,
    failures: existing?.meta.failures ?? 0,
    patches: existing?.meta.patches ?? 0,
    lastViewedAt: existing?.meta.lastViewedAt,
    lastUsedAt: existing?.meta.lastUsedAt,
    lastPatchedAt: existing?.meta.lastPatchedAt,
    sourceSessionId: existing?.meta.sourceSessionId ?? input.sourceSessionId,
    pinned: existing?.meta.pinned ?? false,
    archivedAt: status === "archived" ? (existing?.meta.archivedAt ?? now) : undefined,
    // Drop the cached embedding when content changes — service recomputes lazily.
    embedding: contentChanged ? undefined : existing?.meta.embedding,
  };

  const previousContent = existing && contentChanged ? readSkillMainFile(workspacePath, slug) : undefined;
  const nextContent = serializeSkillFile(frontmatter, body);
  persistSkill(workspacePath, frontmatter, body, meta);
  if (existing && contentChanged && previousContent !== undefined) {
    appendSkillHistory(workspacePath, slug, {
      action: "write_skill",
      filePath: "SKILL.md",
      versionBefore: existing.frontmatter.version,
      versionAfter: frontmatter.version,
      previousExists: true,
      nextExists: true,
      previousContent,
      nextContent,
      summary: "Updated skill procedure/frontmatter",
    });
  }
  return { frontmatter, body, meta };
}

export function listSkillSupportFiles(workspacePath: string, slug: string): string[] {
  const safe = slugifySkillName(slug);
  const skillDir = resolve(skillsDir(workspacePath), safe);
  const files: string[] = [];
  for (const dirName of SUPPORT_FILE_DIRS) {
    collectSupportFiles(resolve(skillDir, dirName), dirName, files);
  }
  return files.sort();
}

export function writeSkillSupportFile(
  workspacePath: string,
  slug: string,
  filePath: string,
  fileContent: string,
): Skill {
  validateSupportFileContent(filePath, fileContent);
  const { skill, target } = resolveSupportFileTarget(workspacePath, slug, filePath);
  const existing = existsSync(target) ? readFileSync(target, "utf-8") : undefined;
  atomicWriteTextSync(target, fileContent);
  if (existing !== fileContent) {
    appendSkillHistory(workspacePath, skill.frontmatter.slug, {
      action: "write_file",
      filePath: normalizeSupportPath(filePath),
      versionBefore: skill.frontmatter.version,
      versionAfter: skill.frontmatter.version,
      previousExists: existing !== undefined,
      nextExists: true,
      previousContent: existing,
      nextContent: fileContent,
      summary: existing === undefined ? "Created support file" : "Updated support file",
    });
    bumpSkillPatch(workspacePath, skill, true);
  }
  return getSkill(workspacePath, skill.frontmatter.slug) ?? skill;
}

export function readSkillSupportFile(workspacePath: string, slug: string, filePath: string): string {
  const { target, relativePath } = resolveSupportFileTarget(workspacePath, slug, filePath);
  if (!existsSync(target)) throw new Error(`Support file not found: ${relativePath}`);
  return readFileSync(target, "utf-8");
}

export function removeSkillSupportFile(workspacePath: string, slug: string, filePath: string): Skill {
  const { skill, target, relativePath } = resolveSupportFileTarget(workspacePath, slug, filePath);
  if (!existsSync(target)) throw new Error(`Support file not found: ${relativePath}`);
  const existing = readFileSync(target, "utf-8");
  unlinkSync(target);
  appendSkillHistory(workspacePath, skill.frontmatter.slug, {
    action: "remove_file",
    filePath: relativePath,
    versionBefore: skill.frontmatter.version,
    versionAfter: skill.frontmatter.version,
    previousExists: true,
    nextExists: false,
    previousContent: existing,
    summary: "Removed support file",
  });
  bumpSkillPatch(workspacePath, skill, true);
  return getSkill(workspacePath, skill.frontmatter.slug) ?? skill;
}

export function patchSkill(workspacePath: string, slug: string, input: PatchSkillInput): Skill {
  if (!input.oldString) throw new Error("oldString is required");
  if (input.newString === undefined || input.newString === null) throw new Error("newString is required");

  const safe = slugifySkillName(slug);
  const skill = getSkill(workspacePath, safe);
  if (!skill) throw new Error(`Skill not found: ${safe}`);

  const target = input.filePath
    ? resolveSupportFileTarget(workspacePath, safe, input.filePath).target
    : resolve(skillsDir(workspacePath), safe, "SKILL.md");
  if (!existsSync(target)) throw new Error(`File not found: ${input.filePath ?? "SKILL.md"}`);

  const raw = readFileSync(target, "utf-8");
  const matchCount = countOccurrences(raw, input.oldString);
  if (matchCount === 0) throw new Error("oldString was not found");
  if (matchCount > 1 && input.replaceAll !== true) {
    throw new Error("oldString matched more than once; set replaceAll=true or include more context");
  }

  const next = input.replaceAll === true
    ? raw.split(input.oldString).join(input.newString)
    : raw.replace(input.oldString, input.newString);
  assertNoCredential(next);

  if (input.filePath) {
    const relativePath = normalizeSupportPath(input.filePath);
    validateSupportFileContent(relativePath, next);
    atomicWriteTextSync(target, next);
    appendSkillHistory(workspacePath, skill.frontmatter.slug, {
      action: "patch",
      filePath: relativePath,
      versionBefore: skill.frontmatter.version,
      versionAfter: skill.frontmatter.version,
      previousExists: true,
      nextExists: true,
      previousContent: raw,
      nextContent: next,
      summary: "Patched support file",
    });
    bumpSkillPatch(workspacePath, skill, true);
    return getSkill(workspacePath, safe) ?? skill;
  }

  if (!next.replace(/^\uFEFF/, "").startsWith("---\n")) {
    throw new Error("Patch would remove required SKILL.md frontmatter");
  }
  const parsed = parseSkillFile(next, safe);
  if (!parsed.body.trim()) throw new Error("Patch would leave SKILL.md without a body");
  parsed.frontmatter.version = skill.frontmatter.version + 1;
  const patchedMeta = markSkillPatched(skill.meta, new Date().toISOString(), true);
  persistSkill(workspacePath, parsed.frontmatter, parsed.body, patchedMeta);
  appendSkillHistory(workspacePath, safe, {
    action: "patch",
    filePath: "SKILL.md",
    versionBefore: skill.frontmatter.version,
    versionAfter: parsed.frontmatter.version,
    previousExists: true,
    nextExists: true,
    previousContent: raw,
    nextContent: serializeSkillFile(parsed.frontmatter, parsed.body),
    summary: "Patched SKILL.md",
  });
  return getSkill(workspacePath, safe) ?? { frontmatter: parsed.frontmatter, body: parsed.body, meta: patchedMeta };
}

export function rollbackSkillHistory(workspacePath: string, slug: string, historyId?: string): Skill {
  const safe = slugifySkillName(slug);
  const skill = getSkill(workspacePath, safe);
  if (!skill) throw new Error(`Skill not found: ${safe}`);

  const entries = readSkillHistory(workspacePath, safe);
  const entry = historyId
    ? entries.find((item) => item.id === historyId)
    : entries.slice().reverse().find((item) => item.previousExists || item.filePath !== "SKILL.md");
  if (!entry) throw new Error(historyId ? `History entry not found: ${historyId}` : "No rollback history is available");

  if (entry.filePath === "SKILL.md") {
    if (!entry.previousExists || entry.previousContent === undefined) throw new Error("Cannot roll back SKILL.md creation without prior content");
    assertNoCredential(entry.previousContent);
    const before = readSkillMainFile(workspacePath, safe);
    const parsed = parseSkillFile(entry.previousContent, safe);
    if (!parsed.body.trim()) throw new Error("History entry would leave SKILL.md without a body");
    parsed.frontmatter.version = skill.frontmatter.version + 1;
    const restored = serializeSkillFile(parsed.frontmatter, parsed.body);
    const patchedMeta = markSkillPatched(skill.meta, new Date().toISOString(), true);
    persistSkill(workspacePath, parsed.frontmatter, parsed.body, patchedMeta);
    appendSkillHistory(workspacePath, safe, {
      action: "rollback",
      filePath: "SKILL.md",
      versionBefore: skill.frontmatter.version,
      versionAfter: parsed.frontmatter.version,
      previousExists: before !== undefined,
      nextExists: true,
      previousContent: before,
      nextContent: restored,
      summary: `Rolled back ${entry.id}`,
    });
    return getSkill(workspacePath, safe) ?? { frontmatter: parsed.frontmatter, body: parsed.body, meta: patchedMeta };
  }

  const { target, relativePath } = resolveSupportFileTarget(workspacePath, safe, entry.filePath);
  const before = existsSync(target) ? readFileSync(target, "utf-8") : undefined;
  if (entry.previousExists) {
    if (entry.previousContent === undefined) throw new Error("History entry has no previous support-file content");
    validateSupportFileContent(relativePath, entry.previousContent);
    atomicWriteTextSync(target, entry.previousContent);
  } else if (existsSync(target)) {
    unlinkSync(target);
  }
  appendSkillHistory(workspacePath, safe, {
    action: "rollback",
    filePath: relativePath,
    versionBefore: skill.frontmatter.version,
    versionAfter: skill.frontmatter.version,
    previousExists: before !== undefined,
    nextExists: entry.previousExists,
    previousContent: before,
    nextContent: entry.previousContent,
    summary: `Rolled back ${entry.id}`,
  });
  bumpSkillPatch(workspacePath, skill, true);
  return getSkill(workspacePath, safe) ?? skill;
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

export function recordSkillViewed(workspacePath: string, slug: string): void {
  const skill = getSkill(workspacePath, slug);
  if (!skill) return;
  skill.meta.views += 1;
  skill.meta.lastViewedAt = new Date().toISOString();
  persistSkillMeta(workspacePath, skill.meta);
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

export async function recordSkillViewedAsync(workspacePath: string, slug: string): Promise<void> {
  const skill = await readSkillAsync(workspacePath, slug);
  if (!skill) return;
  skill.meta.views += 1;
  skill.meta.lastViewedAt = new Date().toISOString();
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

export function setSkillStatus(workspacePath: string, slug: string, status: SkillStatus): boolean {
  const skill = getSkill(workspacePath, slug);
  if (!skill) return false;
  if (status === "archived" && skill.meta.pinned) return false;
  const now = new Date().toISOString();
  skill.frontmatter.status = status;
  skill.meta.updatedAt = now;
  skill.meta.archivedAt = status === "archived" ? (skill.meta.archivedAt ?? now) : undefined;
  persistSkill(workspacePath, skill.frontmatter, skill.body, skill.meta);
  return true;
}

export function setSkillPinned(workspacePath: string, slug: string, pinned: boolean): boolean {
  const skill = getSkill(workspacePath, slug);
  if (!skill) return false;
  skill.meta.pinned = pinned;
  skill.meta.updatedAt = new Date().toISOString();
  persistSkillMeta(workspacePath, skill.meta);
  return true;
}

export function deleteSkill(workspacePath: string, slug: string): boolean {
  const safe = slugifySkillName(slug);
  const skill = getSkill(workspacePath, safe);
  if (skill?.meta.pinned) return false;
  const dir = resolve(skillsDir(workspacePath), safe);
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch (err) {
    log.warn({ err, slug: safe }, "Failed to delete skill");
    return false;
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
  atomicWriteTextSync(resolve(dir, "SKILL.md"), serializeSkillFile(frontmatter, body));
  persistSkillMeta(workspacePath, meta);
}

function persistSkillMeta(workspacePath: string, meta: SkillMeta): void {
  const dir = resolve(skillsDir(workspacePath), meta.slug);
  mkdirSync(dir, { recursive: true });
  atomicWriteTextSync(resolve(dir, "skill.meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
}

function fallbackMeta(slug: string): SkillMeta {
  const now = new Date().toISOString();
  return {
    slug,
    origin: "manual",
    curatorManaged: false,
    createdAt: now,
    updatedAt: now,
    views: 0,
    uses: 0,
    successes: 0,
    failures: 0,
    patches: 0,
    pinned: false,
  };
}

function coerceSkillMeta(raw: Partial<SkillMeta>, slug: string): SkillMeta {
  const fallback = fallbackMeta(slug);
  return {
    slug,
    origin: raw.origin ?? "manual",
    curatorManaged: typeof raw.curatorManaged === "boolean" ? raw.curatorManaged : raw.origin === "distilled",
    createdAt: raw.createdAt ?? fallback.createdAt,
    updatedAt: raw.updatedAt ?? fallback.updatedAt,
    views: typeof raw.views === "number" ? raw.views : 0,
    uses: typeof raw.uses === "number" ? raw.uses : 0,
    successes: typeof raw.successes === "number" ? raw.successes : 0,
    failures: typeof raw.failures === "number" ? raw.failures : 0,
    patches: typeof raw.patches === "number" ? raw.patches : 0,
    lastViewedAt: raw.lastViewedAt,
    lastUsedAt: raw.lastUsedAt,
    lastPatchedAt: raw.lastPatchedAt,
    sourceSessionId: raw.sourceSessionId,
    pinned: raw.pinned === true,
    archivedAt: raw.archivedAt,
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

function readSkillMainFile(workspacePath: string, slug: string): string | undefined {
  const file = resolve(skillsDir(workspacePath), slugifySkillName(slug), "SKILL.md");
  try {
    return readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
}

function readSkillHistory(workspacePath: string, slug: string): SkillHistoryEntry[] {
  const safe = slugifySkillName(slug);
  const file = resolve(skillsDir(workspacePath), safe, HISTORY_FILE);
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.map((item) => coerceHistoryEntry(item)).filter((item): item is SkillHistoryEntry => item !== null);
  } catch {
    return [];
  }
}

function appendSkillHistory(
  workspacePath: string,
  slug: string,
  entry: Omit<SkillHistoryEntry, "id" | "createdAt">,
): SkillHistoryEntry {
  const safe = slugifySkillName(slug);
  const next: SkillHistoryEntry = {
    id: `hist_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    ...entry,
  };
  const entries = [...readSkillHistory(workspacePath, safe), next].slice(-MAX_HISTORY_ENTRIES);
  const dir = resolve(skillsDir(workspacePath), safe);
  atomicWriteTextSync(resolve(dir, HISTORY_FILE), `${JSON.stringify(entries, null, 2)}\n`);
  return next;
}

function coerceHistoryEntry(value: unknown): SkillHistoryEntry | null {
  if (!isRecord(value)) return null;
  const id = typeof value["id"] === "string" ? value["id"] : "";
  const action = typeof value["action"] === "string" ? value["action"] as SkillHistoryAction : "patch";
  const filePath = typeof value["filePath"] === "string" ? value["filePath"] : "SKILL.md";
  const createdAt = typeof value["createdAt"] === "string" ? value["createdAt"] : new Date(0).toISOString();
  if (!id || !filePath) return null;
  return {
    id,
    action,
    filePath,
    createdAt,
    versionBefore: typeof value["versionBefore"] === "number" ? value["versionBefore"] : 1,
    versionAfter: typeof value["versionAfter"] === "number" ? value["versionAfter"] : 1,
    previousExists: value["previousExists"] === true,
    nextExists: value["nextExists"] !== false,
    previousContent: typeof value["previousContent"] === "string" ? value["previousContent"] : undefined,
    nextContent: typeof value["nextContent"] === "string" ? value["nextContent"] : undefined,
    summary: typeof value["summary"] === "string" ? value["summary"] : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNoCredential(content: string): void {
  if (CREDENTIAL_RE.test(content)) throw new SkillCredentialError();
}

function validateSupportFileContent(filePath: string, content: string): void {
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > MAX_SUPPORT_FILE_BYTES) {
    throw new Error(`Support file ${filePath} is too large (${bytes} bytes, max ${MAX_SUPPORT_FILE_BYTES})`);
  }
  if (content.length > MAX_SUPPORT_FILE_CHARS) {
    throw new Error(`Support file ${filePath} is too large (${content.length} chars, max ${MAX_SUPPORT_FILE_CHARS})`);
  }
  assertNoCredential(content);
}

function resolveSupportFileTarget(
  workspacePath: string,
  slug: string,
  filePath: string,
): { skill: Skill; target: string; relativePath: string } {
  const safe = slugifySkillName(slug);
  const skill = getSkill(workspacePath, safe);
  if (!skill) throw new Error(`Skill not found: ${safe}`);

  const relativePath = normalizeSupportPath(filePath);
  const skillDir = resolve(skillsDir(workspacePath), safe);
  const target = resolve(skillDir, relativePath);
  const rel = relative(skillDir, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("Support file path escapes the skill directory");
  }
  return { skill, target, relativePath };
}

function normalizeSupportPath(filePath: string): string {
  const normalized = filePath.trim().replace(/\\/g, "/");
  if (!normalized) throw new Error("filePath is required");
  if (normalized.includes("\0")) throw new Error("filePath contains an invalid null byte");
  if (normalized.startsWith("/") || isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized)) {
    throw new Error("Support file path must be relative to the skill directory");
  }

  const parts = normalized.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.length < 2) throw new Error("Support file path must include a directory and filename");
  if (parts.some((part) => part === "..")) throw new Error("Path traversal is not allowed in support file paths");
  if (!SUPPORT_FILE_DIRS.has(parts[0]!)) {
    throw new Error(`Support file must live under one of: ${[...SUPPORT_FILE_DIRS].sort().join(", ")}`);
  }
  return parts.join("/");
}

function collectSupportFiles(dir: string, prefix: string, files: string[]): void {
  if (!existsSync(dir)) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = resolve(dir, entry);
    try {
      const stat = statSync(path);
      if (stat.isDirectory()) {
        collectSupportFiles(path, `${prefix}/${entry}`, files);
      } else if (stat.isFile()) {
        files.push(`${prefix}/${entry}`);
      }
    } catch {
      // Ignore unreadable support entries.
    }
  }
}

function countOccurrences(value: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (true) {
    const found = value.indexOf(needle, index);
    if (found === -1) return count;
    count++;
    index = found + needle.length;
  }
}

function bumpSkillPatch(workspacePath: string, skill: Skill, dropEmbedding: boolean): void {
  const next = markSkillPatched(skill.meta, new Date().toISOString(), dropEmbedding);
  persistSkillMeta(workspacePath, next);
}

function markSkillPatched(meta: SkillMeta, now: string, dropEmbedding: boolean): SkillMeta {
  return {
    ...meta,
    updatedAt: now,
    patches: meta.patches + 1,
    lastPatchedAt: now,
    embedding: dropEmbedding ? undefined : meta.embedding,
  };
}

function atomicWriteTextSync(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = resolve(dirname(filePath), `.${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  try {
    writeFileSync(tmp, content, "utf-8");
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // best-effort cleanup only
    }
    throw err;
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
    statusRaw === "active" || statusRaw === "archived" || statusRaw === "draft" || statusRaw === "stale"
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
