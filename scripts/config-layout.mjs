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
  const sourceFile = resolve(process.argv[3] ?? defaultSourceFile);
  splitTwoZone(sourceFile);
} else if (command === "build") {
  buildTwoZone();
} else {
  console.error("Usage: node scripts/config-layout.mjs <split|build> [source-file]");
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

function splitTwoZone(sourceFile) {
  const source = JSON5.parse(readFileSync(sourceFile, "utf8"));

  const pentestNames = new Set([
    "pentest_coordinator",
    "recon_agent",
    "web_auditor_agent",
    "network_auditor_agent",
    "exploit_agent",
    "report_writer_agent",
  ]);
  const generalSubAgents = {};
  const pentestSubAgents = {};
  for (const [name, value] of Object.entries(source.subAgents ?? {})) {
    if (pentestNames.has(name)) pentestSubAgents[name] = value;
    else generalSubAgents[name] = value;
  }

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

  // workspace/ zone — agent-mutable
  // Preserve runtime.overrides.json if it exists
  const overridesPath = join(defaultWorkspaceDir, "runtime", "runtime.overrides.json");
  const existingOverrides = existsSync(overridesPath) ? readFileSync(overridesPath, "utf8") : null;

  rmSync(defaultWorkspaceDir, { recursive: true, force: true });

  writeShard(defaultWorkspaceDir, join("agents", "10-core-agents.jsonc"), { agents: source.agents });
  // General sub-agents → role-based shards (see AGENT_ROLE_FILES); unmapped → 99-uncategorized.
  const mappedNames = new Set(Object.values(AGENT_ROLE_FILES).flat());
  for (const [file, names] of Object.entries(AGENT_ROLE_FILES)) {
    const bucket = {};
    for (const name of names) if (name in generalSubAgents) bucket[name] = generalSubAgents[name];
    writeShard(defaultWorkspaceDir, join("agents", file), { subAgents: bucket });
  }
  const uncategorized = {};
  for (const [name, value] of Object.entries(generalSubAgents)) {
    if (!mappedNames.has(name)) uncategorized[name] = value;
  }
  writeShard(defaultWorkspaceDir, join("agents", "99-uncategorized.jsonc"), { subAgents: uncategorized });
  writeShard(defaultWorkspaceDir, join("agents", "30-subagents-pentest.jsonc"), { subAgents: pentestSubAgents });
  writeCategoryShards("scenes", "scenes", source.scenes ?? {}, SCENE_CATEGORY_FILES);
  writeCategoryShards("jobs", "jobs", source.jobs ?? {}, JOB_CATEGORY_FILES);

  // Restore runtime.overrides.json or create empty runtime/ dir
  mkdirSync(join(defaultWorkspaceDir, "runtime"), { recursive: true });
  if (existingOverrides) {
    writeFileSync(overridesPath, existingOverrides, "utf8");
  }

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
