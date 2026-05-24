#!/usr/bin/env node
/**
 * Env-reference preflight — catch the silent "$VAR resolved to nothing" class.
 *
 * StarlingAI config resolves secret references at runtime:
 *   "$ENV_VAR"   → process.env["ENV_VAR"]   (see credentials/sites.ts)
 *   "secret:key" → encrypted credential store
 * If a "$ENV_VAR" reference has no matching variable in .env, the gateway
 * silently resolves it to empty — a stored site/channel/webhook quietly turns
 * into "not found" with only a buried log warning. This script scans every
 * config shard for "$VAR" references and reports which are missing or empty in
 * .env, so the gap is visible BEFORE a workflow fails in production.
 *
 * Usage:
 *   node scripts/check-env-refs.mjs          # report (always exit 0)
 *   node scripts/check-env-refs.mjs --strict # exit 1 if any reference is unmet
 *
 * Note: this validates that referenced vars exist in .env. `secret:` references
 * (encrypted store) are listed separately and never counted as failures.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const strict = process.argv.includes("--strict");

// Directories whose .json/.jsonc shards resolve "$VAR" at runtime, plus the
// gitignored mail accounts file (operator secrets live there too).
const SCAN_DIRS = ["config", "workspace"];
const EXTRA_FILES = ["config/mail/accounts.json"];
const ENV_REF_RE = /"\$([A-Z_][A-Z0-9_]*)"/g;
const SECRET_REF_RE = /"secret:([^"]+)"/g;

function collectFiles(dir, out) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { collectFiles(full, out); continue; }
    if (entry.name.includes(".example.")) continue; // templates, not live config
    const ext = extname(entry.name).toLowerCase();
    if (ext === ".json" || ext === ".jsonc") out.push(full);
  }
}

/** Map of referenced env var → sorted list of files that reference it. */
function scanReferences() {
  const files = [];
  for (const dir of SCAN_DIRS) collectFiles(resolve(repoRoot, dir), files);
  for (const extra of EXTRA_FILES) {
    const full = resolve(repoRoot, extra);
    if (existsSync(full)) files.push(full);
  }

  const envRefs = new Map();
  const secretRefs = new Map();
  for (const file of files) {
    const text = readFileSync(file, "utf-8");
    const rel = relative(repoRoot, file).replace(/\\/g, "/");
    for (const match of text.matchAll(ENV_REF_RE)) {
      const list = envRefs.get(match[1]) ?? new Set();
      list.add(rel);
      envRefs.set(match[1], list);
    }
    for (const match of text.matchAll(SECRET_REF_RE)) {
      const list = secretRefs.get(match[1]) ?? new Set();
      list.add(rel);
      secretRefs.set(match[1], list);
    }
  }
  return { envRefs, secretRefs };
}

/** Parse .env into name → value (empty string when present but blank). */
function parseDotEnv() {
  const env = new Map();
  const file = resolve(repoRoot, ".env");
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, "utf-8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) env.set(match[1], match[2].trim());
  }
  return env;
}

function main() {
  const { envRefs, secretRefs } = scanReferences();
  const env = parseDotEnv();

  if (!existsSync(resolve(repoRoot, ".env"))) {
    console.warn("[check-env-refs] No .env file found — skipping (run scripts/setup.mjs first).");
    return;
  }

  const missing = [];
  const empty = [];
  const ok = [];
  for (const name of [...envRefs.keys()].sort()) {
    if (!env.has(name)) missing.push(name);
    else if (env.get(name) === "") empty.push(name);
    else ok.push(name);
  }

  console.log(`[check-env-refs] ${envRefs.size} env references across config; ${ok.length} set, ${empty.length} empty, ${missing.length} missing.`);

  if (missing.length > 0) {
    console.log("\n  MISSING from .env (config references a var that is not defined):");
    for (const name of missing) {
      console.log(`    - $${name}  ← ${[...envRefs.get(name)].sort().join(", ")}`);
    }
  }
  if (empty.length > 0) {
    console.log("\n  EMPTY in .env (defined but blank — resolves to nothing at runtime):");
    for (const name of empty) {
      console.log(`    - $${name}  ← ${[...envRefs.get(name)].sort().join(", ")}`);
    }
  }
  if (secretRefs.size > 0) {
    console.log(`\n  secret: references (resolved from the encrypted credential store, not .env): ${[...secretRefs.keys()].sort().join(", ")}`);
  }

  const unmet = missing.length + empty.length;
  if (unmet === 0) {
    console.log("\n[check-env-refs] OK — every config env reference is set in .env.");
    return;
  }
  console.log(`\n[check-env-refs] ${unmet} config secret(s) will resolve to empty at runtime. Set them in .env (or switch the reference to secret:<key>).`);
  if (strict) process.exitCode = 1;
}

main();
