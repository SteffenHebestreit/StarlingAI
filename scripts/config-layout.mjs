#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSourceFile = join(repoRoot, "starlingai.json");
const defaultConfigDir = join(repoRoot, "config");
const defaultWorkspaceDir = join(repoRoot, "workspace");
const defaultTargetFile = join(repoRoot, "starlingai.json");
// Legacy single-directory layout
const legacySourceDir = join(repoRoot, "starling_config");

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
      for (const shardPath of collectShardPaths(defaultWorkspaceDir)) {
        const shardRaw = JSON5.parse(readFileSync(shardPath, "utf8"));
        merged = deepMerge(merged, shardRaw);
      }
    }
  } else if (existsSync(legacySourceDir) && isDir(legacySourceDir)) {
    // Legacy single-directory layout
    console.warn("[config-layout] WARNING: Using legacy starling_config/ — migrate to config/ + workspace/ layout");
    for (const shardPath of collectShardPaths(legacySourceDir)) {
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
  writeShard(defaultWorkspaceDir, join("agents", "20-subagents-general.jsonc"), { subAgents: generalSubAgents });
  writeShard(defaultWorkspaceDir, join("agents", "30-subagents-pentest.jsonc"), { subAgents: pentestSubAgents });
  writeShard(defaultWorkspaceDir, join("scenes", "10-scenes.jsonc"), { scenes: source.scenes });

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

function collectShardPaths(sourceDir) {
  if (!existsSync(sourceDir)) return [];
  const shardPaths = [];

  const visit = (currentDir) => {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const nextPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        visit(nextPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = extname(entry.name).toLowerCase();
      if (extension !== ".json" && extension !== ".jsonc") continue;
      if (entry.name === "runtime.overrides.json") continue;
      shardPaths.push(nextPath);
    }
  };

  visit(sourceDir);
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
