/**
 * Memory Vault — a deterministic, idempotent Markdown mirror of StarlingAI's
 * durable memory, skills, and (best-effort) recent session summaries, laid out
 * as an Obsidian-style vault so a human can review, correct, edit, and git/iCloud
 * back up agent memory in a plain-Markdown tool they already trust.
 *
 * Design (why this and not a model-driven writer):
 *   The Hermes/Obsidian pattern is "Obsidian is the reviewable Markdown layer;
 *   memory and skills stay the execution context." We adopt the *review layer*
 *   but make the EXPORT deterministic code rather than letting the (slow, weak,
 *   local) model hand-maintain the vault — so it can't drift or be derailed
 *   mid-build. The IMPORT (re-ingest) closes the correction loop: edit a managed
 *   note's body, run import, and the durable store is updated.
 *
 * Ownership contract:
 *   Only notes carrying `starlingai_managed: true` frontmatter (which the
 *   exporter writes for every keyed durable record) are owned by the exporter:
 *   they are pruned when their source record is gone and re-ingested on import.
 *   Hand-authored notes, and the read-only `skills/` `sessions/` `tags/` mirrors
 *   (managed:false), are never re-ingested. Everything below the
 *   `%% starlingai:managed-footer %%` marker in a note is regenerated and
 *   ignored on import — users edit the body above it.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { childLogger } from "../logger.js";
import { readAllFacts } from "../swarm/memory.js";
import {
  listUserMemoryRecords,
  listWorkspaceMemoryRecords,
  storeUserMemoryRecord,
  storeWorkspaceMemoryRecord,
  type MemoryKind,
  type MemoryRecord,
} from "./service.js";
import { getSkill, listSkills, writeSkill } from "../skills/store.js";
import { PRODUCT } from "../product/index.js";

const log = childLogger("memory:vault");

export const DEFAULT_VAULT_SUBDIR = "vault";
export const OBSIDIAN_VAULT_SKILL_SLUG = "obsidian-vault";

/** Edits below this marker are regenerated each export and stripped on import. */
const MANAGED_FOOTER_MARKER = "%% starlingai:managed-footer";
const MANAGED_KINDS = new Set<MemoryKind>(["note", "fact", "preference", "lesson", "decision", "summary"]);

export interface VaultExportInput {
  workspacePath: string;
  /** Absolute, or relative to workspacePath. Defaults to `<workspace>/vault`. */
  vaultPath?: string;
  /** When set, that turn's shared facts are mirrored into the vault. */
  sessionId?: string;
  /** Mirror recent session summaries (best-effort; needs a live session store). Default true. */
  includeSessions?: boolean;
  /** Upper bound on session-summary notes. Default 25. */
  maxSessions?: number;
  /** Optional LLM summarizer for sessions; falls back to extractive when absent. */
  summarize?: (prompt: string) => Promise<string>;
  now?: () => Date;
}

export interface VaultExportResult {
  vaultPath: string;
  counts: {
    workspaceMemory: number;
    userMemory: number;
    skills: number;
    sessions: number;
    sharedFacts: number;
    tags: number;
  };
  /** Relative paths written this run. */
  written: string[];
  /** Relative paths of managed notes removed because their source record is gone. */
  pruned: string[];
}

export interface VaultImportInput {
  workspacePath: string;
  vaultPath?: string;
}

export interface VaultImportResult {
  created: number;
  updated: number;
  skipped: number;
  errors: string[];
}

// ── Frontmatter (de)serialization — minimal, decoupled from the skills store ──

function fmScalar(value: string): string {
  if (value === "") return '""';
  if (/[:#[\]{}",\n]/.test(value) || /^\s|\s$/.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

function fmList(values: string[]): string {
  return `[${values.map((v) => fmScalar(v)).join(", ")}]`;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return t;
}

function parseList(rest: string): string[] {
  const t = rest.trim();
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((x) => unquote(x)).filter(Boolean);
  }
  return t ? [unquote(t)] : [];
}

interface ParsedNote {
  fm: Record<string, string>;
  tags: string[];
  /** Body with the managed footer stripped, trimmed. */
  body: string;
}

function parseNote(raw: string): ParsedNote {
  const normalized = raw.replace(/\r\n/g, "\n");
  let body = normalized.trim();
  let fmText = "";

  if (normalized.startsWith("---\n")) {
    const end = normalized.indexOf("\n---", 4);
    if (end !== -1) {
      fmText = normalized.slice(4, end);
      const after = normalized.indexOf("\n", end + 1);
      body = after !== -1 ? normalized.slice(after + 1) : "";
    }
  }

  const fm: Record<string, string> = {};
  let tags: string[] = [];
  for (const line of fmText.split("\n")) {
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    const rest = m[2] ?? "";
    if (key === "tags") {
      tags = parseList(rest);
      continue;
    }
    fm[key] = unquote(rest);
  }

  const footerIdx = body.indexOf(MANAGED_FOOTER_MARKER);
  if (footerIdx !== -1) body = body.slice(0, footerIdx);
  return { fm, tags, body: body.trim() };
}

// ── Filename helpers ──────────────────────────────────────────────────────────

function slugify(s: string): string {
  // Preserve underscores so a note filename mirrors its durable key
  // (keys are [a-z0-9_-]); other separators collapse to a hyphen.
  const base = s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9_]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 80);
  return base || "untitled";
}

/** Deterministic, collision-free filename within a directory's used-set. */
function uniqueName(used: Set<string>, base: string, id: string): string {
  let name = base;
  if (used.has(name)) name = `${base}-${slugify(id).slice(0, 8)}`;
  let n = 2;
  while (used.has(name)) name = `${base}-${n++}`;
  used.add(name);
  return name;
}

function resolveVaultPath(workspacePath: string, vaultPath?: string): string {
  if (!vaultPath) return resolve(workspacePath, DEFAULT_VAULT_SUBDIR);
  return isAbsolute(vaultPath) ? vaultPath : resolve(workspacePath, vaultPath);
}

// ── Note rendering ────────────────────────────────────────────────────────────

function renderMemoryNote(rec: MemoryRecord): string {
  const managed = Boolean(rec.key); // only keyed records are safely re-ingestable
  const subject = rec.subject || rec.key || rec.id;
  const lines = [
    "---",
    `starlingai_managed: ${managed}`,
    `starlingai_id: ${fmScalar(rec.id)}`,
    `starlingai_scope: ${rec.scope}`,
    `starlingai_key: ${fmScalar(rec.key || rec.id)}`,
    `kind: ${rec.kind}`,
    `subject: ${fmScalar(subject)}`,
    `ownerType: ${rec.ownerType}`,
    `ownerId: ${fmScalar(rec.ownerId)}`,
    `source: ${fmScalar(rec.source)}`,
    `createdAt: ${fmScalar(rec.createdAt)}`,
    `updatedAt: ${fmScalar(rec.updatedAt)}`,
    `tags: ${fmList(rec.tags)}`,
    "---",
    "",
    rec.content.trim(),
    "",
  ];
  const tagLinks = rec.tags.map((t) => `[[tags/${slugify(t)}|#${t}]]`).join(" · ");
  lines.push(
    `${MANAGED_FOOTER_MARKER} — regenerated each export; edit the body ABOVE this line, then run memory_import %%`,
  );
  if (tagLinks) lines.push(`**Tags:** ${tagLinks}`);
  lines.push("[[README|← Memory vault index]]", "");
  return lines.join("\n");
}

function renderReadonlyNote(
  frontmatter: Record<string, string | string[] | boolean>,
  body: string,
): string {
  const lines = ["---", "starlingai_managed: false"];
  for (const [k, v] of Object.entries(frontmatter)) {
    if (Array.isArray(v)) lines.push(`${k}: ${fmList(v)}`);
    else if (typeof v === "boolean") lines.push(`${k}: ${v}`);
    else lines.push(`${k}: ${fmScalar(v)}`);
  }
  lines.push("---", "", body.trim(), "", "[[README|← Memory vault index]]", "");
  return lines.join("\n");
}

function writeNote(vaultPath: string, relPath: string, content: string, written: string[]): void {
  const abs = join(vaultPath, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  written.push(relPath.replace(/\\/g, "/"));
}

/** Remove managed notes in `relDir` whose starlingai_id is not in `liveIds`. */
function pruneManaged(vaultPath: string, relDir: string, liveIds: Set<string>, pruned: string[]): void {
  const abs = join(vaultPath, relDir);
  if (!existsSync(abs)) return;
  for (const file of readdirSync(abs)) {
    if (!file.endsWith(".md")) continue;
    const full = join(abs, file);
    let parsed: ParsedNote;
    try {
      parsed = parseNote(readFileSync(full, "utf8"));
    } catch {
      continue;
    }
    if (parsed.fm["starlingai_managed"] !== "true") continue;
    const id = parsed.fm["starlingai_id"];
    if (id && !liveIds.has(id)) {
      rmSync(full, { force: true });
      pruned.push(`${relDir}/${file}`);
    }
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

export async function exportMemoryVault(input: VaultExportInput): Promise<VaultExportResult> {
  const vaultPath = resolveVaultPath(input.workspacePath, input.vaultPath);
  const now = (input.now ?? (() => new Date()))();
  const written: string[] = [];
  const pruned: string[] = [];

  mkdirSync(vaultPath, { recursive: true });

  const workspaceRecords = listWorkspaceMemoryRecords(input.workspacePath);
  const userRecords = listUserMemoryRecords(input.workspacePath);

  // Memory notes (the correctable layer), one file per record, deterministic names.
  const tagMembers = new Map<string, string[]>(); // tagSlug -> wikilink targets
  const liveByScope: Record<"workspace" | "user", Set<string>> = {
    workspace: new Set(),
    user: new Set(),
  };

  for (const scope of ["workspace", "user"] as const) {
    const records = scope === "workspace" ? workspaceRecords : userRecords;
    const used = new Set<string>();
    for (const rec of records) {
      const base = slugify(rec.key || rec.subject || rec.id);
      const name = uniqueName(used, base, rec.id);
      const rel = `memory/${scope}/${name}.md`;
      writeNote(vaultPath, rel, renderMemoryNote(rec), written);
      liveByScope[scope].add(rec.id);
      const target = `memory/${scope}/${name}`;
      const subject = rec.subject || rec.key || rec.id;
      for (const tag of rec.tags) {
        const ts = slugify(tag);
        const list = tagMembers.get(ts) ?? [];
        list.push(`- [[${target}|${subject}]]`);
        tagMembers.set(ts, list);
      }
    }
  }

  // Prune managed notes whose source record disappeared.
  pruneManaged(vaultPath, "memory/workspace", liveByScope.workspace, pruned);
  pruneManaged(vaultPath, "memory/user", liveByScope.user, pruned);

  // Tag index notes (the lightweight knowledge-graph layer / backlinks).
  for (const [tagSlug, members] of [...tagMembers.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const body = [`# #${tagSlug}`, "", ...members].join("\n");
    writeNote(vaultPath, `tags/${tagSlug}.md`, renderReadonlyNote({ starlingai_kind: "tag-index" }, body), written);
  }

  // Skills — already first-class SKILL.md; mirror as read-only review notes.
  let skillCount = 0;
  try {
    const skills = listSkills(input.workspacePath);
    const used = new Set<string>();
    for (const skill of skills) {
      const name = uniqueName(used, slugify(skill.frontmatter.slug || skill.frontmatter.name), skill.frontmatter.slug);
      const body = [
        `# ${skill.frontmatter.name}`,
        "",
        `> ${skill.frontmatter.description}`,
        "",
        `**When to use:** ${skill.frontmatter.whenToUse}`,
        "",
        skill.body.trim(),
        "",
        `_Source of truth: \`${PRODUCT.stateDirName}/skills/${skill.frontmatter.slug}/SKILL.md\` — edit there, not here._`,
      ].join("\n");
      writeNote(
        vaultPath,
        `skills/${name}.md`,
        renderReadonlyNote(
          {
            starlingai_kind: "skill",
            slug: skill.frontmatter.slug,
            status: skill.frontmatter.status,
            tags: skill.frontmatter.tags,
          },
          body,
        ),
        written,
      );
      skillCount++;
    }
  } catch (err) {
    log.warn({ err }, "skills mirror skipped");
  }

  // Recent session summaries — best-effort (needs a live session store).
  let sessionCount = 0;
  if (input.includeSessions !== false) {
    try {
      const { getAllSessions } = await import("../agent/session.js");
      const { summarizeSession } = await import("../agent/session-search.js");
      const max = Math.max(1, input.maxSessions ?? 25);
      const all = getAllSessions({ includeArchived: true })
        .slice()
        .sort((a, b) => b.getUpdatedAt().getTime() - a.getUpdatedAt().getTime())
        .slice(0, max);
      const used = new Set<string>();
      for (const session of all) {
        const summary = await summarizeSession(session.id, input.summarize);
        if (!summary) continue;
        const name = uniqueName(used, slugify(session.id), session.id);
        const body = [`# Session ${session.id}`, "", summary.trim()].join("\n");
        writeNote(
          vaultPath,
          `sessions/${name}.md`,
          renderReadonlyNote(
            {
              starlingai_kind: "session-summary",
              sessionId: session.id,
              channel: session.channel,
              updatedAt: session.getUpdatedAt().toISOString(),
            },
            body,
          ),
          written,
        );
        sessionCount++;
      }
    } catch (err) {
      log.debug({ err }, "session summaries unavailable (no live session store)");
    }
  }

  // The current turn's shared facts, when a session is in scope.
  let sharedFactCount = 0;
  if (input.sessionId) {
    try {
      const facts = await readAllFacts(input.sessionId);
      const entries = Object.entries(facts);
      if (entries.length > 0) {
        const body = [
          `# Shared facts — session ${input.sessionId}`,
          "",
          ...entries.map(([k, v]) => `- **${k}:** ${v}`),
        ].join("\n");
        writeNote(
          vaultPath,
          `sessions/shared-facts-${slugify(input.sessionId)}.md`,
          renderReadonlyNote({ starlingai_kind: "shared-facts", sessionId: input.sessionId }, body),
          written,
        );
        sharedFactCount = entries.length;
      }
    } catch (err) {
      log.debug({ err }, "shared facts unavailable");
    }
  }

  // Index / hub note.
  const readme = [
    "# StarlingAI Memory Vault",
    "",
    "A **reviewable Markdown mirror** of this workspace's durable memory, skills, and recent sessions —",
    "the same idea as pointing an agent at an Obsidian vault, but exported deterministically so the",
    "(slow, local) model can never derail it.",
    "",
    "## How to use it",
    "",
    "- Notes under `memory/` with `starlingai_managed: true` are the **correctable** facts. Edit the body",
    "  **above** the `%% starlingai:managed-footer %%` line, then run `memory_import` (or `sai memory import`)",
    "  to apply your edits back to the live durable store.",
    "- `tags/`, `skills/`, and `sessions/` are **read-only mirrors**, regenerated on every export.",
    "- Re-run `memory_export` (or `sai memory export`) any time to refresh; deletions in the store are pruned here.",
    "",
    "## Contents",
    "",
    `- Workspace memory: ${workspaceRecords.length}`,
    `- User memory: ${userRecords.length}`,
    `- Skills: ${skillCount}`,
    `- Sessions: ${sessionCount}`,
    `- Tag indexes: ${tagMembers.size}`,
    "",
    `_Generated ${now.toISOString()} by StarlingAI memory_export._`,
  ].join("\n");
  writeNote(vaultPath, "README.md", renderReadonlyNote({ starlingai_kind: "index" }, readme), written);

  log.info(
    { vaultPath, written: written.length, pruned: pruned.length },
    "memory vault exported",
  );

  return {
    vaultPath,
    counts: {
      workspaceMemory: workspaceRecords.length,
      userMemory: userRecords.length,
      skills: skillCount,
      sessions: sessionCount,
      sharedFacts: sharedFactCount,
      tags: tagMembers.size,
    },
    written,
    pruned,
  };
}

// ── Import (the correction loop) ──────────────────────────────────────────────

export function importMemoryVault(input: VaultImportInput): VaultImportResult {
  const vaultPath = resolveVaultPath(input.workspacePath, input.vaultPath);
  const result: VaultImportResult = { created: 0, updated: 0, skipped: 0, errors: [] };

  const existingKeys: Record<"workspace" | "user", Set<string>> = {
    workspace: new Set(listWorkspaceMemoryRecords(input.workspacePath).map((r) => r.key || r.id)),
    user: new Set(listUserMemoryRecords(input.workspacePath).map((r) => r.key || r.id)),
  };

  for (const scope of ["workspace", "user"] as const) {
    const dir = join(vaultPath, "memory", scope);
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".md")) continue;
      const full = join(dir, file);
      let parsed: ParsedNote;
      try {
        parsed = parseNote(readFileSync(full, "utf8"));
      } catch (err) {
        result.errors.push(`${scope}/${file}: ${String(err)}`);
        continue;
      }

      if (parsed.fm["starlingai_managed"] !== "true") {
        result.skipped++;
        continue;
      }
      const key = parsed.fm["starlingai_key"];
      const content = parsed.body.trim();
      if (!key || !content) {
        result.skipped++;
        continue;
      }
      const kindRaw = parsed.fm["kind"] as MemoryKind | undefined;
      const kind = kindRaw && MANAGED_KINDS.has(kindRaw) ? kindRaw : undefined;
      const subject = parsed.fm["subject"] || undefined;

      try {
        const writer = scope === "user" ? storeUserMemoryRecord : storeWorkspaceMemoryRecord;
        writer(input.workspacePath, { key, content, tags: parsed.tags, kind, subject });
        if (existingKeys[scope].has(key)) result.updated++;
        else result.created++;
      } catch (err) {
        result.errors.push(`${scope}/${file}: ${String(err)}`);
      }
    }
  }

  log.info(
    { vaultPath, created: result.created, updated: result.updated, skipped: result.skipped, errors: result.errors.length },
    "memory vault imported",
  );
  return result;
}

// ── Thin Obsidian skill bootstrap ─────────────────────────────────────────────

/**
 * Seed the `obsidian-vault` skill the first time the user opts into the vault, so
 * the agent knows the review/correction loop. Idempotent: never overwrites an
 * existing (possibly user-edited) skill. Returns true when it created the skill.
 */
export function seedObsidianVaultSkill(workspacePath: string): boolean {
  if (getSkill(workspacePath, OBSIDIAN_VAULT_SKILL_SLUG)) return false;
  const procedure = [
    "# Obsidian memory vault — review & correction loop",
    "",
    "The vault is a deterministic Markdown mirror of durable memory, skills, and recent sessions.",
    "Use it when the user wants to **review, audit, edit, correct, or back up** agent memory as Markdown",
    "(e.g. in Obsidian), or asks to *sync / refresh the memory vault*.",
    "",
    "## Steps",
    "",
    "1. **Surface for review** — call `memory_export` (optionally with `vaultPath`). It writes/refreshes",
    "   `<workspace>/vault/` (or the given path): `memory/` (correctable notes), `tags/`, `skills/`,",
    "   `sessions/`. Report the counts and where it landed.",
    "2. **Let the user edit** — they edit the body of any `memory/**` note ABOVE the",
    "   `%% starlingai:managed-footer %%` line. Frontmatter and everything below the marker are",
    "   regenerated and ignored.",
    "3. **Apply corrections** — call `memory_import` to re-ingest edited `starlingai_managed: true` notes",
    "   back into the durable store (matched by `starlingai_key`). Report created/updated/skipped.",
    "",
    "## Pitfalls",
    "",
    "- `skills/`, `sessions/`, `tags/` are read-only mirrors — edits there are NOT re-ingested. Skills are",
    "  corrected via the skill tools; their source of truth is `" + PRODUCT.stateDirName + "/skills/<slug>/SKILL.md`.",
    "- Only keyed durable records are re-ingestable (managed). Keyless captures are mirrored read-only.",
    "- Re-export is idempotent and prunes notes whose source record was deleted — safe to run any time.",
    "- The export is deterministic code; do NOT hand-write vault notes with file tools to 'maintain' it.",
  ].join("\n");

  try {
    writeSkill(workspacePath, {
      name: "Obsidian memory vault review loop",
      slug: OBSIDIAN_VAULT_SKILL_SLUG,
      description:
        "Review, edit, correct, and back up agent durable memory as Obsidian-style Markdown via memory_export / memory_import.",
      whenToUse:
        "User wants to review/audit/edit/correct/back up agent memory as Markdown or in Obsidian, or sync the memory vault.",
      procedure,
      tags: ["memory", "obsidian", "vault", "review", "audit"],
      tools: ["memory_export", "memory_import"],
      origin: "manual",
      status: "active",
    });
    return true;
  } catch (err) {
    log.warn({ err }, "failed to seed obsidian-vault skill");
    return false;
  }
}
