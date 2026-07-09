#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import { PRODUCT } from "./product.mjs";
import { NON_CONFIG_WORKSPACE_ZONES } from "./config-zones.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSourceFile = join(repoRoot, PRODUCT.configFileName);
const defaultConfigDir = join(repoRoot, "config");
const defaultWorkspaceDir = join(repoRoot, "workspace");
const defaultTargetFile = join(repoRoot, PRODUCT.configFileName);
// Legacy single-directory layout
const legacySourceDir = join(repoRoot, "starling_config");

// Role-based sharding for general sub-agents (separation of concerns). `build` globs every
// shard so it is layout-agnostic; `split` uses this map to regenerate the role files. Any
// sub-agent not listed here is written to 99-uncategorized.jsonc so a round-trip never drops one.
const AGENT_ROLE_FILES = {
  "21-orchestration.jsonc": ["mission_coordinator", "web_task_coordinator", "devops_coordinator", "project_planner", "agent_factory"],
  "22-research-analysis.jsonc": ["researcher", "evidence_analyst", "data_analyst", "research_librarian", "document_intake", "log_analyst", "finance_analyst", "distance_specialist"],
  "23-authoring-content.jsonc": ["content_writer", "paper_author", "meeting_briefing_agent", "summarizer", "translator", "diagram_designer", "chart_designer", "image_creator", "image_sourcer"],
  "24-engineering.jsonc": ["coder", "code_analyst", "test_generator", "diff_reviewer", "integration_builder", "api_integrator", "git_developer", "sql_specialist"],
  "25-infra-ops.jsonc": ["shell_agent", "infrastructure_agent", "ops_triage"],
  "26-web-browser.jsonc": ["browser_agent", "vision_browser_analyst", "accessibility_tester", "computer_use_agent"],
  "27-quality-review.jsonc": ["qa_guard", "quality_supervisor", "source_verifier", "policy_compliance_reviewer", "contract_analyst"],
  "28-comms-productivity.jsonc": ["notification_agent", "mail_agent", "calendar_agent", "productivity_agent"],
  "29-platform.jsonc": ["swarm_maintainer", "tool_developer", "prompt_optimizer", "agent_architect"],
};

// Scenes and jobs are sharded by category the same way. Anything not listed falls into
// 90-uncategorized.jsonc so a split round-trip never drops a scene/job.
const SCENE_CATEGORY_FILES = {
  "10-research.jsonc": ["source_backed_paper", "verified_research_brief", "deep_research", "competitive_analysis", "security_audit"],
  "20-content-media.jsonc": ["content_creation", "release_notes_draft", "onboarding_packet", "meeting_briefing_packet", "deck_research", "deck_images", "deck_build", "validate_image"],
  "30-engineering-data.jsonc": ["code_review", "data_pipeline_review"],
  "40-ops-comms.jsonc": ["incident_response", "multi_channel_broadcast", "apply_jobs"],
  "40-capability-codev.jsonc": ["capture_capability"],
};
const JOB_CATEGORY_FILES = {
  "10-research.jsonc": ["deep_research_packet", "source_grounded_paper_packet", "research_visual_digest", "competitive_snapshot", "morning_briefing", "weekly_security_digest"],
  "20-content-media.jsonc": ["sourced_presentation", "content_pipeline", "onboarding_delivery"],
  "30-engineering-data.jsonc": ["scheduled_code_review", "data_quality_report", "database_analysis"],
  "40-ops-comms.jsonc": ["daily_ops_brief", "release_broadcast", "incident_postmortem"],
  "40-capability-codev.jsonc": ["co_develop_capability"],
};

// Derive the CURRENT on-disk placement of entries under `wrapper` across the shards in
// workspace/<subdir>/, as {filename: [keys]}. `split` uses this so it reproduces the
// hand-maintained layout instead of the drift-prone hardcoded maps above — which now only
// seed a FRESH migration from a flat config where no shards exist yet. Returns null when no
// shard currently defines any such entry (→ fall back to the seed map).
function deriveShardPlacement(subdir, wrapper) {
  const dir = join(defaultWorkspaceDir, subdir);
  if (!existsSync(dir) || !isDir(dir)) return null;
  const placement = {};
  for (const name of readdirSync(dir)) {
    if (!/\.(jsonc?|json5)$/.test(name)) continue;
    try {
      const obj = JSON5.parse(readFileSync(join(dir, name), "utf8"));
      const keys = Object.keys(obj?.[wrapper] ?? {});
      if (keys.length) placement[name] = keys;
    } catch { /* skip an unparseable shard */ }
  }
  return Object.keys(placement).length ? placement : null;
}

// The shard file that currently holds a top-level `wrapper` block (e.g. the platform `agents`
// block); `fallback` when no shard has it yet (fresh migration).
function deriveWrapperFile(subdir, wrapper, fallback) {
  const dir = join(defaultWorkspaceDir, subdir);
  if (existsSync(dir) && isDir(dir)) {
    for (const name of readdirSync(dir)) {
      if (!/\.(jsonc?|json5)$/.test(name)) continue;
      try { if (JSON5.parse(readFileSync(join(dir, name), "utf8"))?.[wrapper]) return name; } catch { /* skip */ }
    }
  }
  return fallback;
}

// Shard a flat {name: def} map into category files under `subdir`, with a `wrapper` top-level
// key; unmapped entries → 90-uncategorized.jsonc. Mirrors how `build` reassembles every shard.
function writeCategoryShards(subdir, wrapper, entries, categoryFiles) {
  const mapped = new Set(Object.values(categoryFiles).flat());
  for (const [file, names] of Object.entries(categoryFiles)) {
    const bucket = {};
    for (const name of names) if (name in entries) bucket[name] = entries[name];
    writeShard(defaultWorkspaceDir, join(subdir, file), { [wrapper]: bucket });
  }
  const rest = {};
  for (const [name, value] of Object.entries(entries)) if (!mapped.has(name)) rest[name] = value;
  if (Object.keys(rest).length) writeShard(defaultWorkspaceDir, join(subdir, "90-uncategorized.jsonc"), { [wrapper]: rest });
}

const command = process.argv[2] ?? "build";

if (command === "split") {
  const rest = process.argv.slice(3);
  const force = rest.includes("--force");
  const sourceArg = rest.find((a) => !a.startsWith("--"));
  splitTwoZone(resolve(sourceArg ?? defaultSourceFile), { force });
} else if (command === "build") {
  buildTwoZone();
} else {
  console.error("Usage: node scripts/config-layout.mjs <split [--force] [source-file]|build>");
  process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Build: merge config/ + workspace/ (or legacy starling_config/) → starlingai.json
// ---------------------------------------------------------------------------

function buildTwoZone() {
  let merged = {};

  if (existsSync(defaultConfigDir) && isDir(defaultConfigDir)) {
    // Two-zone layout
    for (const shardPath of collectShardPaths(defaultConfigDir)) {
      const shardRaw = JSON5.parse(readFileSync(shardPath, "utf8"));
      merged = deepMerge(merged, shardRaw);
    }
    if (existsSync(defaultWorkspaceDir) && isDir(defaultWorkspaceDir)) {
      for (const shardPath of collectShardPaths(defaultWorkspaceDir, { excludeZones: NON_CONFIG_WORKSPACE_ZONES })) {
        const shardRaw = JSON5.parse(readFileSync(shardPath, "utf8"));
        merged = deepMerge(merged, shardRaw);
      }
    }
  } else if (existsSync(legacySourceDir) && isDir(legacySourceDir)) {
    // Legacy single-directory layout
    console.warn("[config-layout] WARNING: Using legacy starling_config/ — migrate to config/ + workspace/ layout");
    for (const shardPath of collectShardPaths(legacySourceDir, { excludeZones: NON_CONFIG_WORKSPACE_ZONES })) {
      const shardRaw = JSON5.parse(readFileSync(shardPath, "utf8"));
      merged = deepMerge(merged, shardRaw);
    }
  } else {
    console.error("[config-layout] No config/ directory found. Run 'config split' first or create config/ + workspace/ manually.");
    process.exitCode = 1;
    return;
  }

  mkdirSync(dirname(defaultTargetFile), { recursive: true });
  writeFileSync(defaultTargetFile, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  console.log(`[config-layout] Built ${relative(repoRoot, defaultTargetFile)}`);
}

// ---------------------------------------------------------------------------
// Split: decompose starlingai.json → config/ + workspace/
// ---------------------------------------------------------------------------

function splitTwoZone(sourceFile, { force = false } = {}) {
  const source = JSON5.parse(readFileSync(sourceFile, "utf8"));

  // GUARD: `split` is a lossy one-time migration — writeShard re-emits plain JSON, so it
  // STRIPS every JSONC comment, and it overwrites config/ + workspace/ wholesale. Refuse to
  // clobber an existing hand-maintained two-zone layout unless --force is given.
  const layoutExists = isDir(defaultConfigDir) && isDir(join(defaultWorkspaceDir, "agents"));
  if (layoutExists && !force) {
    console.error(
      "[config-layout] Refusing to overwrite the existing config/ + workspace/ layout.\n" +
      "  `split` is a lossy one-time migration: it re-emits plain JSON (STRIPS every JSONC\n" +
      "  comment) and reshards the whole tree from starlingai.json.\n" +
      "  - To EDIT config: change the shard files directly, then `sai config build`.\n" +
      "  - To force a re-split anyway (you WILL lose all JSONC comments; agent working\n" +
      "    data — tools/, generated/, uploads/, .starlingai/, runtime/ — is preserved):\n" +
      "    `sai config split --force`.",
    );
    process.exitCode = 1;
    return;
  }

  // Derive shard placements from the CURRENT layout (before the wipe below) so a forced
  // re-split reproduces the hand-maintained structure; the hardcoded maps only seed a fresh
  // migration from a flat config where no shards exist yet.
  const agentsBlockFile = deriveWrapperFile("agents", "agents", "00-platform.jsonc");
  const agentPlacement = deriveShardPlacement("agents", "subAgents") ?? AGENT_ROLE_FILES;
  const scenePlacement = deriveShardPlacement("scenes", "scenes") ?? SCENE_CATEGORY_FILES;
  const jobPlacement = deriveShardPlacement("jobs", "jobs") ?? JOB_CATEGORY_FILES;

  // Wipe config/ (safe — user-managed, no runtime state)
  rmSync(defaultConfigDir, { recursive: true, force: true });

  // config/ zone — infrastructure (agent cannot touch)
  writeShard(defaultConfigDir, join("providers", "10-providers.jsonc"), { providers: source.providers });
  writeShard(defaultConfigDir, join("gateway", "10-gateway.jsonc"), { gateway: source.gateway });
  writeShard(defaultConfigDir, join("gateway", "20-guardrails.jsonc"), { guardrails: source.guardrails });
  writeShard(defaultConfigDir, join("channels", "10-channels.jsonc"), { channels: source.channels });
  writeShard(defaultConfigDir, join("multimodal", "10-multimodal.jsonc"), { multimodal: source.multimodal });
  writeShard(defaultConfigDir, join("integrations", "10-integrations.jsonc"), {
    integrations: source.integrations,
    webhooks: source.webhooks,
    sites: source.sites,
    approvalChannels: source.approvalChannels,
    workspacePath: source.workspacePath,
  });
  writeShard(defaultConfigDir, join("tooling", "10-platform.jsonc"), {
    retrieval: source.retrieval,
    computerUse: source.computerUse,
    infrastructure: source.infrastructure,
    pentest: source.pentest,
    mcp: source.mcp,
  });

  // Catch-all: any top-level config key not explicitly sharded above (e.g. auth,
  // orchestration, a2a, receptionist, accounts, and any future additions) → a misc infra
  // shard, so `split` NEVER silently drops a config section. `build` globs it like any other.
  const HANDLED_TOP_KEYS = new Set([
    "providers", "gateway", "guardrails", "channels", "multimodal",
    "integrations", "webhooks", "sites", "approvalChannels", "workspacePath",
    "retrieval", "computerUse", "infrastructure", "pentest", "mcp",
    "agents", "subAgents", "scenes", "jobs",
  ]);
  const leftover = {};
  for (const [k, v] of Object.entries(source)) {
    if (!HANDLED_TOP_KEYS.has(k) && v !== undefined) leftover[k] = v;
  }
  if (Object.keys(leftover).length) {
    writeShard(defaultConfigDir, join("misc", "90-uncategorized.jsonc"), leftover);
  }

  // workspace/ zone — agent-mutable. Remove ONLY the config-shard zones this split
  // rewrites (agents/scenes/jobs), NOT the whole workspace: a forced re-split must never
  // destroy agent-mutable WORKING DATA that is its only copy — deployed dynamic-tool
  // bundles (tools/), generated artifacts, uploads, the skill library + durable memory
  // (.starlingai/), runtime overrides, and workspace docs. None of that is reconstructible
  // from starlingai.json, so wiping it was an irreversible data loss the guard framed as
  // "you only lose comments".
  const CONFIG_SHARD_ZONES = ["agents", "scenes", "jobs"];
  for (const zone of CONFIG_SHARD_ZONES) {
    rmSync(join(defaultWorkspaceDir, zone), { recursive: true, force: true });
  }

  // Platform agents block → its current shard (00-platform.jsonc by default).
  writeShard(defaultWorkspaceDir, join("agents", agentsBlockFile), { agents: source.agents });
  // Sub-agents / scenes / jobs → their derived (current-layout) shards; unmapped → 90-uncategorized.
  writeCategoryShards("agents", "subAgents", source.subAgents ?? {}, agentPlacement);
  writeCategoryShards("scenes", "scenes", source.scenes ?? {}, scenePlacement);
  writeCategoryShards("jobs", "jobs", source.jobs ?? {}, jobPlacement);

  // runtime/ is no longer wiped, so runtime.overrides.json survives on its own; just
  // ensure the dir exists for a fresh migration (flat config → two-zone, no workspace yet).
  mkdirSync(join(defaultWorkspaceDir, "runtime"), { recursive: true });

  console.log(`[config-layout] Split into ${relative(repoRoot, defaultConfigDir)}/ + ${relative(repoRoot, defaultWorkspaceDir)}/`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeShard(targetDir, relativePath, payload) {
  // Filter out undefined values
  const cleaned = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v !== undefined) cleaned[k] = v;
  }
  if (Object.keys(cleaned).length === 0) return;

  const fullPath = join(targetDir, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${JSON.stringify(cleaned, null, 2)}\n`, "utf8");
}

function collectShardPaths(sourceDir, { excludeZones = [] } = {}) {
  if (!existsSync(sourceDir)) return [];
  const shardPaths = [];
  const skipZones = new Set(excludeZones);

  const visit = (currentDir, depth) => {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const nextPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        // SECURITY: skip depth-0 working zones (generated/, uploads/, tools/) so
        // an agent-written or uploaded data.json with a top-level "agents" key
        // cannot merge into the compiled config. Mirrors the runtime loader's
        // NON_CONFIG_WORKSPACE_ZONES guard, closing the build-vs-loader gap.
        if (depth === 0 && skipZones.has(entry.name)) continue;
        visit(nextPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = extname(entry.name).toLowerCase();
      if (extension !== ".json" && extension !== ".jsonc") continue;
      if (entry.name === "runtime.overrides.json") continue;
      shardPaths.push(nextPath);
    }
  };

  visit(sourceDir, 0);
  return shardPaths.sort((left, right) => relative(sourceDir, left).localeCompare(relative(sourceDir, right)));
}

function deepMerge(base, overlay) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const baseValue = merged[key];
    if (isPlainObject(baseValue) && isPlainObject(value)) {
      merged[key] = deepMerge(baseValue, value);
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDir(path) {
  try { return statSync(path).isDirectory(); } catch { return false; }
}
