/**
 * Dialectic user model — an evolving, *reasoned* profile of the individual user.
 * Distinct from:
 *   - the assistant personality (how the assistant sounds — personality/service)
 *   - durable memory facts (discrete things the user stated — memory/service)
 *
 * This holds the agent's working THEORY of the user: their goals, expertise,
 * working style, communication preferences, and the open questions it is still
 * resolving. It is hypotheses the agent revises over time, not raw transcript.
 *
 * Stored alongside the assistant personality under the user-memory state dir so
 * it persists across sessions and is per-operator.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { childLogger } from "../logger.js";

import { PRODUCT } from "../product/index.js";

const log = childLogger("user-model");

const USER_MODEL_FILENAME = "user-model.json";
const SCHEMA_VERSION = 1;
const MAX_ITEMS = 10;

const ListItem = z.string().trim().min(1).max(280);

export const UserModelEditableSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),
  goals: z.array(ListItem).max(MAX_ITEMS).default([]),
  expertise: z.array(ListItem).max(MAX_ITEMS).default([]),
  workingStyle: z.array(ListItem).max(MAX_ITEMS).default([]),
  communication: z.array(ListItem).max(MAX_ITEMS).default([]),
  /** Dialectic edge: hypotheses the agent is still testing about the user. */
  openQuestions: z.array(ListItem).max(MAX_ITEMS).default([]),
});

export type UserModelEditable = z.infer<typeof UserModelEditableSchema>;

export const UserModelProfileSchema = UserModelEditableSchema.extend({
  revision: z.number().int().min(1),
  updatedAt: z.string().datetime(),
  updatedBy: z.enum(["user", "assistant", "system"]),
});

export type UserModelProfile = z.infer<typeof UserModelProfileSchema>;

type UserModelField = "goals" | "expertise" | "workingStyle" | "communication" | "openQuestions";

export interface UserModelUpdate {
  goals?: string[];
  expertise?: string[];
  workingStyle?: string[];
  communication?: string[];
  openQuestions?: string[];
  /** Append to existing lists instead of replacing them. */
  append?: boolean;
  reset?: boolean;
}

const EMPTY_EDITABLE: UserModelEditable = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  goals: [],
  expertise: [],
  workingStyle: [],
  communication: [],
  openQuestions: [],
});

function storePath(): string {
  const baseDir = process.env["SAI_USER_MEMORY_PATH"]?.trim()
    ? resolve(process.env["SAI_USER_MEMORY_PATH"])
    : resolve(homedir(), PRODUCT.stateDirName, "state");
  return resolve(baseDir, USER_MODEL_FILENAME);
}

function cloneEmpty(): UserModelEditable {
  return {
    schemaVersion: SCHEMA_VERSION,
    goals: [],
    expertise: [],
    workingStyle: [],
    communication: [],
    openQuestions: [],
  };
}

function normalizeList(values: readonly string[], limit = MAX_ITEMS): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

function withMetadata(
  editable: UserModelEditable,
  meta: { revision: number; updatedBy: UserModelProfile["updatedBy"] },
): UserModelProfile {
  return UserModelProfileSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    goals: normalizeList(editable.goals),
    expertise: normalizeList(editable.expertise),
    workingStyle: normalizeList(editable.workingStyle),
    communication: normalizeList(editable.communication),
    openQuestions: normalizeList(editable.openQuestions),
    revision: meta.revision,
    updatedAt: new Date().toISOString(),
    updatedBy: meta.updatedBy,
  });
}

export function getDefaultUserModel(): UserModelProfile {
  return withMetadata(cloneEmpty(), { revision: 1, updatedBy: "system" });
}

export function loadUserModel(): UserModelProfile {
  const file = storePath();
  if (!existsSync(file)) return getDefaultUserModel();
  try {
    return UserModelProfileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    log.warn({ error, file }, "Failed to read user model; using default");
    return getDefaultUserModel();
  }
}

function persist(profile: UserModelProfile): void {
  const file = storePath();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(profile, null, 2), "utf8");
}

export function updateUserModel(
  update: UserModelUpdate,
  actor: UserModelProfile["updatedBy"] = "assistant",
): UserModelProfile {
  const current = update.reset ? getDefaultUserModel() : loadUserModel();

  const fields: UserModelField[] = ["goals", "expertise", "workingStyle", "communication", "openQuestions"];
  const hasAny = fields.some((field) => update[field] !== undefined);
  if (!update.reset && !hasAny) {
    throw new Error("No user-model fields were provided");
  }

  const next: UserModelEditable = {
    schemaVersion: SCHEMA_VERSION,
    goals: mergeField(current.goals, update.goals, update.append),
    expertise: mergeField(current.expertise, update.expertise, update.append),
    workingStyle: mergeField(current.workingStyle, update.workingStyle, update.append),
    communication: mergeField(current.communication, update.communication, update.append),
    openQuestions: mergeField(current.openQuestions, update.openQuestions, update.append),
  };

  const profile = withMetadata(next, {
    revision: current.revision + 1,
    updatedBy: actor,
  });
  persist(profile);
  return profile;
}

function mergeField(current: readonly string[], next: readonly string[] | undefined, append?: boolean): string[] {
  if (!next) return [...current];
  return append ? [...current, ...next] : [...next];
}

export function resetUserModelForTests(): void {
  const file = storePath();
  if (existsSync(file)) {
    try { writeFileSync(file, "", "utf8"); } catch { /* ignore */ }
  }
}

/**
 * Build the prompt guidance block. Returns "" when the model is still empty.
 * Bounded to keep the per-turn context lean: at most `perSection` items per
 * field and an overall character cap (the full model stays available via
 * user_model_view).
 */
export function formatUserModelGuidance(opts: { perSection?: number; maxChars?: number } = {}): string {
  const perSection = Math.max(1, Math.min(MAX_ITEMS, opts.perSection ?? 3));
  const maxChars = Math.max(200, Math.min(1_500, opts.maxChars ?? 600));
  const profile = loadUserModel();

  const sections: string[] = [];
  pushSection(sections, "Goals", profile.goals, perSection);
  pushSection(sections, "Expertise", profile.expertise, perSection);
  pushSection(sections, "Working style", profile.workingStyle, perSection);
  pushSection(sections, "Communication", profile.communication, perSection);
  pushSection(sections, "Open questions", profile.openQuestions, perSection);

  if (sections.length === 0) return "";

  const header = "## User Model";
  const intro = "Working understanding of this user (hypotheses, refined across sessions). Adapt to it; update via user_model_update; never override explicit instructions, safety, or honesty.";

  const lines: string[] = [];
  let total = header.length + intro.length + 2;
  for (const line of sections) {
    if (total + line.length + 1 > maxChars) break;
    lines.push(line);
    total += line.length + 1;
  }
  if (lines.length === 0) return "";

  return [header, intro, ...lines].join("\n");
}

function pushSection(sections: string[], title: string, values: string[], perSection: number): void {
  if (values.length === 0) return;
  sections.push(`${title}: ${values.slice(0, perSection).join("; ")}`);
}
