#!/usr/bin/env node
/**
 * StarlingAI first-run setup script.
 * Generates secrets, checks prerequisites, creates .env
 */
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const ENV_FILE = ".env";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

function log(msg) { console.log(msg); }
function ok(msg) { console.log(`${GREEN}✓${RESET} ${msg}`); }
function warn(msg) { console.log(`${YELLOW}⚠${RESET} ${msg}`); }
function fail(msg) { console.log(`${RED}✗${RESET} ${msg}`); }
function info(msg) { console.log(`${CYAN}ℹ${RESET} ${msg}`); }

log(`\n${BOLD}🦞 StarlingAI Setup${RESET}\n`);

// ── Check prerequisites ───────────────────────────────────────────────────
log("Checking prerequisites...");

// Node.js version
const nodeVersion = process.versions.node;
const [major] = nodeVersion.split(".").map(Number);
if (major < 22) {
  fail(`Node.js 22+ required (found ${nodeVersion})`);
  process.exit(1);
}
ok(`Node.js ${nodeVersion}`);

// Docker
try {
  const dockerVersion = execSync("docker --version", { encoding: "utf-8" }).trim();
  ok(`Docker: ${dockerVersion}`);
} catch {
  fail("Docker not found. Install Docker Desktop first.");
  process.exit(1);
}

// Docker Compose
try {
  execSync("docker compose version", { encoding: "utf-8" });
  ok("Docker Compose: available");
} catch {
  fail("Docker Compose not found.");
  process.exit(1);
}

// pnpm
try {
  const pnpmVersion = execSync("pnpm --version", { encoding: "utf-8" }).trim();
  ok(`pnpm: ${pnpmVersion}`);
} catch {
  warn("pnpm not found — installing...");
  execSync("npm install -g pnpm@10.6.0", { stdio: "inherit" });
}

// LM Studio check
log("\nChecking LM Studio...");
try {
  const response = await fetch("http://localhost:1234/v1/models", {
    signal: AbortSignal.timeout(5000),
  });
  if (response.ok) {
    const data = await response.json();
    const models = data.data ?? [];
    if (models.length > 0) {
      ok(`LM Studio connected — ${models.length} model(s) loaded`);
      info(`  Active model: ${models[0]?.id ?? "unknown"}`);
    } else {
      warn("LM Studio reachable but no models loaded. Load a model before starting StarlingAI.");
    }
  } else {
    warn("LM Studio returned non-200 response. Make sure it's running.");
  }
} catch {
  warn("LM Studio not reachable at localhost:1234.");
  warn("Start LM Studio and load a Qwen model before running `docker compose up`.");
}

// ── Generate or load .env ─────────────────────────────────────────────────
log("\nConfiguring environment...");

let env = {};
if (existsSync(ENV_FILE)) {
  const existing = readFileSync(ENV_FILE, "utf-8");
  for (const line of existing.split("\n")) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) env[match[1]] = match[2];
  }
  info(".env already exists — preserving existing secrets");
}

// Generate secrets only if missing
let changed = false;

if (!env.SAI_JWT_SECRET || env.SAI_JWT_SECRET.length < 32) {
  env.SAI_JWT_SECRET = randomBytes(48).toString("base64url");
  ok("Generated SAI_JWT_SECRET");
  changed = true;
}

if (!env.SAI_MASTER_KEY || env.SAI_MASTER_KEY.length < 32) {
  env.SAI_MASTER_KEY = randomBytes(48).toString("base64url");
  ok("Generated SAI_MASTER_KEY (credential store encryption)");
  changed = true;
}

if (!env.POSTGRES_PASSWORD) {
  env.POSTGRES_PASSWORD = randomBytes(24).toString("base64url");
  ok("Generated POSTGRES_PASSWORD");
  changed = true;
}

if (changed) {
  const envContent = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n";
  writeFileSync(ENV_FILE, envContent, { mode: 0o600 });
  ok(`Secrets written to ${ENV_FILE}`);
} else {
  info("Secrets already configured — no changes needed");
}

// ── Summary ───────────────────────────────────────────────────────────────
log(`\n${BOLD}Setup complete!${RESET}\n`);
log("Next steps:");
log(`  1. ${CYAN}Ensure LM Studio is running${RESET} with a Qwen model loaded at localhost:1234`);
log(`  2. ${CYAN}pnpm install${RESET}          — install dependencies`);
log(`  3. ${CYAN}docker compose up -d --build${RESET}   — start all services`);
log(`  4. ${CYAN}pnpm token${RESET} or ${CYAN}./scripts/gen-token.sh${RESET}   — generate a dashboard JWT`);
log(`  5. Open ${CYAN}http://localhost:3001${RESET} — web dashboard\n`);
log(`The setup script only prepares local secrets in ${CYAN}.env${RESET}; dashboard login tokens are generated separately.\n`);
