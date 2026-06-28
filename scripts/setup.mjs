#!/usr/bin/env node
/**
 * StarlingAI first-run setup (from source).
 *
 * Checks host prerequisites (Node / Docker / Compose / pnpm), then runs the SAME
 * guided wizard the Docker one-click launchers use — scripts/setup-wizard.mjs — for
 * model-backend selection (Anthropic / OpenAI-compatible / Ollama, with an endpoint
 * probe), secret generation, .env, config bootstrap, and the dashboard token. Keeping
 * one wizard means the from-source and one-click paths can't drift apart.
 */
import { execSync } from "node:child_process";

const BOLD = "\x1b[1m", GREEN = "\x1b[32m", YELLOW = "\x1b[33m";
const RED = "\x1b[31m", CYAN = "\x1b[36m", RESET = "\x1b[0m";
const log = (m = "") => console.log(m);
const ok = (m) => console.log(`${GREEN}✓${RESET} ${m}`);
const warn = (m) => console.log(`${YELLOW}⚠${RESET} ${m}`);
const fail = (m) => console.log(`${RED}✗${RESET} ${m}`);

log(`\n${BOLD}🐦 StarlingAI — setup (from source)${RESET}\n`);
log("Checking prerequisites...");

// Node 22+
const [major] = process.versions.node.split(".").map(Number);
if (major < 22) { fail(`Node.js 22+ required (found ${process.versions.node})`); process.exit(1); }
ok(`Node.js ${process.versions.node}`);

// Docker + Compose
try { ok(`Docker: ${execSync("docker --version", { encoding: "utf-8" }).trim()}`); }
catch { fail("Docker not found. Install Docker Desktop first: https://www.docker.com/products/docker-desktop/"); process.exit(1); }
try { execSync("docker compose version", { stdio: "ignore" }); ok("Docker Compose: available"); }
catch { fail("Docker Compose not found."); process.exit(1); }

// pnpm — prefer corepack (uses the version pinned in package.json "packageManager")
try { ok(`pnpm: ${execSync("pnpm --version", { encoding: "utf-8" }).trim()}`); }
catch {
  warn("pnpm not found — enabling via corepack...");
  try { execSync("corepack enable", { stdio: "inherit" }); ok("pnpm enabled via corepack"); }
  catch { fail("Could not enable pnpm. Install it manually: https://pnpm.io/installation"); process.exit(1); }
}

// ── Guided wizard — single source of truth for secrets + model backend + .env +
//    config bootstrap + login token (runs interactively against your terminal).
log("");
try { execSync("node scripts/setup-wizard.mjs", { stdio: "inherit" }); }
catch { fail("Setup wizard did not complete."); process.exit(1); }

// ── Next steps ─────────────────────────────────────────────────────────────
log(`\n${BOLD}Next:${RESET}`);
log(`  ${CYAN}pnpm install${RESET}     — install dependencies (first time only)`);
log(`  ${CYAN}pnpm sai start${RESET}   — build the merged config, build images, start the stack,`);
log(`                    wait for health, and print a dashboard login token`);
log(`\nPrefer ${CYAN}pnpm sai start${RESET} over a raw ${CYAN}docker compose up${RESET} — it builds config from the`);
log(`shards, preflights env \`$VAR\` refs, builds the agent-worker image, and waits for health.\n`);
