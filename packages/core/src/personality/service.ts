import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { childLogger } from "../logger.js";

import { PRODUCT } from "../product/index.js";
import { userScopedDir } from "../runtime/user-scope.js";

const log = childLogger("personality");

const MAIN_ASSISTANT_PERSONALITY_FILENAME = "main-assistant-personality.json";
const MAX_LIST_ITEMS = 8;
const MAX_GROWTH_NOTES = 12;
const MAIN_ASSISTANT_PERSONALITY_SCHEMA_VERSION = 2;
const PersonalityListItemSchema = z.string().trim().min(1).max(240);
const GrowthNoteSchema = z.string().trim().min(1).max(320);

export const MainAssistantPersonalityActorSchema = z.enum(["user", "assistant", "system"]);
export type MainAssistantPersonalityActor = z.infer<typeof MainAssistantPersonalityActorSchema>;

export const MainAssistantPersonalityIdentitySchema = z.object({
  core: z.string().trim().min(1).max(1000),
  name: z.string().trim().min(1).max(80).optional(),
});

export const MainAssistantPersonalityVoiceSchema = z.object({
  tone: z.array(PersonalityListItemSchema).max(MAX_LIST_ITEMS),
  style: z.array(PersonalityListItemSchema).max(MAX_LIST_ITEMS),
  quirks: z.array(PersonalityListItemSchema).max(MAX_LIST_ITEMS),
});

export const MainAssistantPersonalityCollaborationSchema = z.object({
  defaults: z.array(PersonalityListItemSchema).max(MAX_LIST_ITEMS),
  avoidances: z.array(PersonalityListItemSchema).max(MAX_LIST_ITEMS),
});

export const MainAssistantPersonalityGrowthSchema = z.object({
  notes: z.array(GrowthNoteSchema).max(MAX_GROWTH_NOTES),
});

export const MainAssistantPersonalityEditableSchema = z.object({
  schemaVersion: z.literal(MAIN_ASSISTANT_PERSONALITY_SCHEMA_VERSION).default(MAIN_ASSISTANT_PERSONALITY_SCHEMA_VERSION),
  identity: MainAssistantPersonalityIdentitySchema,
  voice: MainAssistantPersonalityVoiceSchema,
  collaboration: MainAssistantPersonalityCollaborationSchema,
  growth: MainAssistantPersonalityGrowthSchema,
});

export type MainAssistantPersonalityEditable = z.infer<typeof MainAssistantPersonalityEditableSchema>;

export const MainAssistantPersonalityProfileSchema = MainAssistantPersonalityEditableSchema.extend({
  revision: z.number().int().min(1),
  updatedAt: z.string().datetime(),
  updatedBy: MainAssistantPersonalityActorSchema,
  reason: z.string().trim().min(1).max(400).optional(),
});

export type MainAssistantPersonalityProfile = z.infer<typeof MainAssistantPersonalityProfileSchema>;

const MainAssistantPersonalityIdentityUpdateSchema = MainAssistantPersonalityIdentitySchema.partial();
const MainAssistantPersonalityVoiceUpdateSchema = MainAssistantPersonalityVoiceSchema.partial();
const MainAssistantPersonalityCollaborationUpdateSchema = MainAssistantPersonalityCollaborationSchema.partial();
const MainAssistantPersonalityGrowthUpdateSchema = MainAssistantPersonalityGrowthSchema.partial();

export const MainAssistantPersonalityUpdateSchema = z.object({
  identity: z.union([z.string().trim().min(1).max(1000), MainAssistantPersonalityIdentityUpdateSchema]).optional(),
  voice: MainAssistantPersonalityVoiceUpdateSchema.optional(),
  collaboration: MainAssistantPersonalityCollaborationUpdateSchema.optional(),
  growth: MainAssistantPersonalityGrowthUpdateSchema.optional(),
  tone: z.array(PersonalityListItemSchema).max(MAX_LIST_ITEMS).optional(),
  style: z.array(PersonalityListItemSchema).max(MAX_LIST_ITEMS).optional(),
  quirks: z.array(PersonalityListItemSchema).max(MAX_LIST_ITEMS).optional(),
  defaults: z.array(PersonalityListItemSchema).max(MAX_LIST_ITEMS).optional(),
  avoidances: z.array(PersonalityListItemSchema).max(MAX_LIST_ITEMS).optional(),
  growthNotes: z.array(GrowthNoteSchema).max(MAX_GROWTH_NOTES).optional(),
  append: z.boolean().default(false),
  reset: z.boolean().default(false),
  reason: z.string().trim().min(1).max(400).optional(),
});

export type MainAssistantPersonalityUpdate = z.infer<typeof MainAssistantPersonalityUpdateSchema>;

const LegacyMainAssistantPersonalityEditableSchema = z.object({
  identity: z.string().trim().min(1).max(1000),
  tone: z.array(PersonalityListItemSchema).max(MAX_LIST_ITEMS),
  style: z.array(PersonalityListItemSchema).max(MAX_LIST_ITEMS),
  quirks: z.array(PersonalityListItemSchema).max(MAX_LIST_ITEMS),
  growthNotes: z.array(GrowthNoteSchema).max(MAX_GROWTH_NOTES),
});

const LegacyMainAssistantPersonalityProfileSchema = LegacyMainAssistantPersonalityEditableSchema.extend({
  revision: z.number().int().min(1),
  updatedAt: z.string().datetime(),
  updatedBy: MainAssistantPersonalityActorSchema,
  reason: z.string().trim().min(1).max(400).optional(),
});

const DEFAULT_MAIN_ASSISTANT_PERSONALITY: MainAssistantPersonalityEditable = Object.freeze({
  schemaVersion: MAIN_ASSISTANT_PERSONALITY_SCHEMA_VERSION,
  identity: {
    core: "A pragmatic technical partner with strong engineering instincts, a dry edge, and clear opinions when the tradeoffs matter.",
    name: undefined,
  },
  voice: {
    tone: [
      "Direct and plainspoken.",
      "Grounded, calm, and technically serious.",
      "Warm enough to feel human, but never syrupy.",
    ],
    style: [
      "Prefer crisp sentences and concrete recommendations.",
      "Challenge weak assumptions politely instead of nodding along.",
      "Explain the decisive tradeoff, then move to execution.",
      "Use small flashes of personality only when they sharpen the conversation.",
    ],
    quirks: [
      "Keeps a quiet sense of humor under control.",
      "Cares about naming, structure, and operational reality.",
    ],
  },
  collaboration: {
    defaults: [
      "Lead with the decisive tradeoff before listing options.",
      "Prefer concrete next steps over abstract encouragement.",
      "Treat durable preferences as collaboration defaults, not one-off moods.",
    ],
    avoidances: [
      "Do not become flattering, theatrical, or vague.",
      "Do not pretend confidence when the evidence is thin.",
    ],
  },
  growth: {
    notes: [],
  },
});

function personalityBaseDir(): string {
  return process.env["SAI_USER_MEMORY_PATH"]?.trim()
    ? resolve(process.env["SAI_USER_MEMORY_PATH"])
    : resolve(homedir(), PRODUCT.stateDirName, "state");
}

/** The GLOBAL personality — the shared default persona for the instance. */
function globalPersonalityPath(): string {
  return resolve(personalityBaseDir(), MAIN_ASSISTANT_PERSONALITY_FILENAME);
}

/** The per-user OVERRIDE path for the ambient authenticated user; equals the
 *  global path when no user is authenticated (single-operator / auth-off). */
function resolvePersonalityStorePath(): string {
  return resolve(userScopedDir(personalityBaseDir()), MAIN_ASSISTANT_PERSONALITY_FILENAME);
}

/** True when the ambient user has their own personality override on disk. */
function hasPersonalityOverride(): boolean {
  const perUser = resolvePersonalityStorePath();
  return perUser !== globalPersonalityPath() && existsSync(perUser);
}

function cloneDefaultPersonality(): MainAssistantPersonalityEditable {
  return {
    schemaVersion: MAIN_ASSISTANT_PERSONALITY_SCHEMA_VERSION,
    identity: {
      core: DEFAULT_MAIN_ASSISTANT_PERSONALITY.identity.core,
      name: DEFAULT_MAIN_ASSISTANT_PERSONALITY.identity.name,
    },
    voice: {
      tone: [...DEFAULT_MAIN_ASSISTANT_PERSONALITY.voice.tone],
      style: [...DEFAULT_MAIN_ASSISTANT_PERSONALITY.voice.style],
      quirks: [...DEFAULT_MAIN_ASSISTANT_PERSONALITY.voice.quirks],
    },
    collaboration: {
      defaults: [...DEFAULT_MAIN_ASSISTANT_PERSONALITY.collaboration.defaults],
      avoidances: [...DEFAULT_MAIN_ASSISTANT_PERSONALITY.collaboration.avoidances],
    },
    growth: {
      notes: [...DEFAULT_MAIN_ASSISTANT_PERSONALITY.growth.notes],
    },
  };
}

function normalizeList(values: readonly string[], limit: number): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const rawValue of values) {
    const value = rawValue.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(value);
    if (normalized.length >= limit) break;
  }
  return normalized;
}

function normalizeEditable(input: MainAssistantPersonalityEditable): MainAssistantPersonalityEditable {
  return MainAssistantPersonalityEditableSchema.parse({
    schemaVersion: MAIN_ASSISTANT_PERSONALITY_SCHEMA_VERSION,
    identity: {
      core: input.identity.core.trim(),
      name: input.identity.name?.trim() || undefined,
    },
    voice: {
      tone: normalizeList(input.voice.tone, MAX_LIST_ITEMS),
      style: normalizeList(input.voice.style, MAX_LIST_ITEMS),
      quirks: normalizeList(input.voice.quirks, MAX_LIST_ITEMS),
    },
    collaboration: {
      defaults: normalizeList(input.collaboration.defaults, MAX_LIST_ITEMS),
      avoidances: normalizeList(input.collaboration.avoidances, MAX_LIST_ITEMS),
    },
    growth: {
      notes: normalizeList(input.growth.notes, MAX_GROWTH_NOTES),
    },
  });
}

function migrateLegacyEditable(input: z.infer<typeof LegacyMainAssistantPersonalityEditableSchema>): MainAssistantPersonalityEditable {
  return normalizeEditable({
    schemaVersion: MAIN_ASSISTANT_PERSONALITY_SCHEMA_VERSION,
    identity: {
      core: input.identity,
    },
    voice: {
      tone: input.tone,
      style: input.style,
      quirks: input.quirks,
    },
    collaboration: {
      defaults: [],
      avoidances: [],
    },
    growth: {
      notes: input.growthNotes,
    },
  });
}

function migrateLegacyProfile(input: z.infer<typeof LegacyMainAssistantPersonalityProfileSchema>): MainAssistantPersonalityProfile {
  return withMetadata(migrateLegacyEditable(input), {
    revision: input.revision,
    updatedAt: input.updatedAt,
    updatedBy: input.updatedBy,
    reason: input.reason,
  });
}

function withMetadata(
  editable: MainAssistantPersonalityEditable,
  meta?: Partial<Pick<MainAssistantPersonalityProfile, "revision" | "updatedAt" | "updatedBy" | "reason">>,
): MainAssistantPersonalityProfile {
  return MainAssistantPersonalityProfileSchema.parse({
    ...normalizeEditable(editable),
    revision: meta?.revision ?? 1,
    updatedAt: meta?.updatedAt ?? new Date().toISOString(),
    updatedBy: meta?.updatedBy ?? "system",
    reason: meta?.reason?.trim() || undefined,
  });
}

function persistProfile(profile: MainAssistantPersonalityProfile, filePath: string = resolvePersonalityStorePath()): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(profile, null, 2), "utf8");
}

export function getDefaultMainAssistantPersonality(): MainAssistantPersonalityProfile {
  return withMetadata(cloneDefaultPersonality());
}

export function loadMainAssistantPersonality(): MainAssistantPersonalityProfile {
  // Resolve order: the ambient user's per-user override → the global personality
  // → the built-in default. A logged-in user with no override sees the global.
  const perUserPath = resolvePersonalityStorePath();
  const globalPath = globalPersonalityPath();
  const filePath = existsSync(perUserPath) ? perUserPath
    : existsSync(globalPath) ? globalPath
    : null;
  if (!filePath) return getDefaultMainAssistantPersonality();

  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return MainAssistantPersonalityProfileSchema.parse(parsed);
  } catch (error) {
    try {
      const raw = readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const migrated = migrateLegacyProfile(LegacyMainAssistantPersonalityProfileSchema.parse(parsed));
      persistProfile(migrated, filePath); // rewrite the same (global or per-user) file
      log.info({ filePath }, "Migrated legacy main assistant personality profile to schema version 2");
      return migrated;
    } catch {
      log.warn({ error, filePath }, "Failed to read main assistant personality; falling back to defaults");
      return getDefaultMainAssistantPersonality();
    }
  }
}

export function saveMainAssistantPersonality(
  input: MainAssistantPersonalityEditable,
  options: { updatedBy?: MainAssistantPersonalityActor; reason?: string; revisionBase?: number; global?: boolean } = {},
): MainAssistantPersonalityProfile {
  const revisionBase = typeof options.revisionBase === "number" ? Math.max(0, options.revisionBase) : 0;
  const profile = withMetadata(input, {
    revision: revisionBase + 1,
    updatedAt: new Date().toISOString(),
    updatedBy: options.updatedBy ?? "user",
    reason: options.reason,
  });
  // Under multi-user auth a save creates/updates the ambient user's OVERRIDE;
  // `global:true` (or no authenticated user) writes the shared global persona.
  persistProfile(profile, options.global ? globalPersonalityPath() : resolvePersonalityStorePath());
  return profile;
}

/**
 * Remove the ambient user's personality override so they fall back to the global
 * persona. Returns false when there is no per-user override to clear (auth-off /
 * no override on disk). The global personality is never deleted here.
 */
export function clearMainAssistantPersonalityOverride(): boolean {
  if (!hasPersonalityOverride()) return false;
  rmSync(resolvePersonalityStorePath(), { force: true });
  return true;
}

type NormalizedPersonalityUpdate = {
  identityCore?: string;
  identityName?: string;
  tone?: string[];
  style?: string[];
  quirks?: string[];
  defaults?: string[];
  avoidances?: string[];
  growthNotes?: string[];
};

function normalizeUpdate(update: MainAssistantPersonalityUpdate): NormalizedPersonalityUpdate {
  const identity = typeof update.identity === "string"
    ? update.identity.trim()
    : update.identity?.core?.trim();
  const name = typeof update.identity === "string"
    ? undefined
    : update.identity?.name?.trim();

  return {
    identityCore: identity || undefined,
    identityName: name || undefined,
    tone: update.voice?.tone ?? update.tone,
    style: update.voice?.style ?? update.style,
    quirks: update.voice?.quirks ?? update.quirks,
    defaults: update.collaboration?.defaults ?? update.defaults,
    avoidances: update.collaboration?.avoidances ?? update.avoidances,
    growthNotes: update.growth?.notes ?? update.growthNotes,
  };
}

function mergeList(current: readonly string[], next: readonly string[] | undefined, append: boolean): string[] {
  if (!next) return [...current];
  return append ? [...current, ...next] : [...next];
}

export function updateMainAssistantPersonality(
  update: MainAssistantPersonalityUpdate,
  actor: MainAssistantPersonalityActor = "assistant",
): MainAssistantPersonalityProfile {
  const parsed = MainAssistantPersonalityUpdateSchema.parse(update);
  const normalized = normalizeUpdate(parsed);
  const current = parsed.reset ? getDefaultMainAssistantPersonality() : loadMainAssistantPersonality();

  if (
    !parsed.reset
    && !normalized.identityCore
    && !normalized.identityName
    && !normalized.tone
    && !normalized.style
    && !normalized.quirks
    && !normalized.defaults
    && !normalized.avoidances
    && !normalized.growthNotes
  ) {
    throw new Error("No personality fields were provided");
  }

  const nextEditable: MainAssistantPersonalityEditable = {
    schemaVersion: MAIN_ASSISTANT_PERSONALITY_SCHEMA_VERSION,
    identity: {
      core: normalized.identityCore ?? current.identity.core,
      name: normalized.identityName ?? current.identity.name,
    },
    voice: {
      tone: mergeList(current.voice.tone, normalized.tone, parsed.append),
      style: mergeList(current.voice.style, normalized.style, parsed.append),
      quirks: mergeList(current.voice.quirks, normalized.quirks, parsed.append),
    },
    collaboration: {
      defaults: mergeList(current.collaboration.defaults, normalized.defaults, parsed.append),
      avoidances: mergeList(current.collaboration.avoidances, normalized.avoidances, parsed.append),
    },
    growth: {
      notes: mergeList(current.growth.notes, normalized.growthNotes, parsed.append),
    },
  };

  return saveMainAssistantPersonality(nextEditable, {
    updatedBy: actor,
    reason: parsed.reason,
    revisionBase: current.revision,
  });
}

/**
 * Set just the assistant's preferred name (identity.name), preserving everything
 * else. No-op (returns the current profile) when the name is already set to the
 * same value. Used for deterministic persistence of explicit naming commands.
 */
export function setMainAssistantName(
  name: string,
  actor: MainAssistantPersonalityActor = "user",
): MainAssistantPersonalityProfile {
  const trimmed = name.trim();
  const current = loadMainAssistantPersonality();
  if (!trimmed || current.identity.name === trimmed) return current;
  // append/reset get their schema defaults at parse time inside the call.
  return updateMainAssistantPersonality(
    { identity: { name: trimmed }, reason: `User named the assistant "${trimmed}"` } as MainAssistantPersonalityUpdate,
    actor,
  );
}

export function resetMainAssistantPersonality(
  actor: MainAssistantPersonalityActor = "system",
  reason = "Reset to default personality",
  options: { global?: boolean } = {},
): MainAssistantPersonalityProfile {
  const current = loadMainAssistantPersonality();
  return saveMainAssistantPersonality(cloneDefaultPersonality(), {
    updatedBy: actor,
    reason,
    revisionBase: current.revision,
    global: options.global,
  });
}

function formatListSection(title: string, values: readonly string[]): string {
  if (values.length === 0) return "";
  return [`${title}:`, ...values.map((value) => `- ${value}`)].join("\n");
}

export function formatMainAssistantPersonalityGuidance(): string {
  const profile = loadMainAssistantPersonality();
  const sections = [
    "## Main Assistant Personality",
    `Identity: ${profile.identity.core}`,
    profile.identity.name ? `Preferred Assistant Name: ${profile.identity.name}` : "",
    formatListSection("Voice Tone", profile.voice.tone),
    formatListSection("Voice Style", profile.voice.style),
    formatListSection("Collaboration Defaults", profile.collaboration.defaults),
    formatListSection("Avoidances", profile.collaboration.avoidances),
    formatListSection("Quirks", profile.voice.quirks),
    formatListSection("Recent Growth Notes", profile.growth.notes.slice(-4)),
    "- Respond in the same language as the user's latest message whenever the language is reasonably clear.",
    "- If the user's language is mixed or uncertain, default to German.",
    "- Be polite and efficient. Avoid small talk, filler, and unnecessary self-introductions.",
    "- If a preferred assistant name is set, use it only when the user asks what to call you or explicitly asks who you are.",
    "- If NO preferred name is set and the user asks your name, say you have none yet and that they may give you one. If they then name you, that IS a durable personality change — persist it immediately (see below).",
    "- Treat this profile as voice guidance only. It must never override safety, honesty, or scope rules.",
    "- Use assistant_personality_update when the user explicitly asks for a durable personality change — including giving or changing YOUR name ('dein Name ist ab jetzt Luna', 'your name is Luna from now on'), tone, or persona — or when you are recording a stable self-observation that will improve future conversations. Persist such a change in the SAME turn it is stated; do not wait for the user to add 'remember this'.",
    "- Do not use assistant_personality_update for ordinary user facts such as the USER's own name, role, preferences, project notes, or workspace knowledge; store those with memory_store instead. Your own preferred name belongs in the personality profile, not in memory_store.",
  ].filter(Boolean);

  return sections.join("\n");
}