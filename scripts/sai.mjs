#!/usr/bin/env node
/**
 * StarlingAI CLI — unified entry point for project management.
 *
 * Usage:
 *   sai setup                              Check prerequisites, generate .env secrets
 *   sai start [--pentest] ...              Build config + start Docker services
 *   sai stop  [--volumes]                  Stop services (optionally wipe data)
 *   sai config build                       Merge config/ + workspace/ → starlingai.json
 *   sai config split [--from <file>]       Decompose monolithic config into two zones
 *   sai token [--user X] [--role X] [--ttl X]  Generate dashboard JWT
 *   sai health                             Check service health endpoints
 *   sai dev [gateway|web]                  Start development mode
 */
import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

const ok   = (msg) => console.log(`${GREEN}✓${RESET} ${msg}`);
const warn = (msg) => console.log(`${YELLOW}⚠${RESET} ${msg}`);
const fail = (msg) => { console.error(`${RED}✗${RESET} ${msg}`); process.exitCode = 1; };
const info = (msg) => console.log(`${CYAN}ℹ${RESET} ${msg}`);
const hdr  = (msg) => console.log(`\n${BOLD}${msg}${RESET}`);

// Resolve repo root (scripts/ lives one level below)
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(repoRoot);

const command = process.argv[2];
const subCommand = process.argv[3];
const restArgs = process.argv.slice(3);

switch (command) {
  case "setup":   await cmdSetup(); break;
  case "start":   await cmdStart(); break;
  case "stop":    await cmdStop(); break;
  case "config":  await cmdConfig(); break;
  case "token":   await cmdToken(); break;
  case "health":  await cmdHealth(); break;
  case "dev":     await cmdDev(); break;
  case "help": case "--help": case "-h": case undefined:
    printHelp(); break;
  default:
    fail(`Unknown command: ${command}`);
    printHelp();
}

// ─────────────────────────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────────────────────────

async function cmdSetup() {
  // Delegate to the existing setup script
  await run("node", ["scripts/setup.mjs"]);
}

async function cmdStart() {
  const { values } = parseArgs({
    args: restArgs,
    options: {
      build:             { type: "boolean", default: false },
      "no-cache":        { type: "boolean", default: false },
      fresh:             { type: "boolean", default: false },
      pentest:           { type: "boolean", default: false },
      "strix-halo":     { type: "boolean", default: false },
      "computer-desktop":{ type: "boolean", default: false },
      all:               { type: "boolean", default: false },
    },
    strict: false,
  });

  const wantBuild   = values.build || values["no-cache"] || values.fresh;
  const noCache     = values["no-cache"] || values.fresh;
  const wipeVolumes = values.fresh;
  const pentest     = values.pentest || values.all;
  const strixHalo   = values["strix-halo"];
  const desktop     = values["computer-desktop"] || values.all;

  hdr("StarlingAI — Starting up");

  // Prerequisites
  ensureCommand("docker", "Docker not found. Install Docker Desktop first.");
  ensureCommand("docker compose version", "Docker Compose plugin not found.");
  ok("Docker available");

  // First-run .env
  if (!existsSync(".env")) {
    warn(".env not found — running first-time setup...");
    await run("node", ["scripts/setup.mjs"]);
  }
  loadDotEnv();

  for (const key of ["SAI_JWT_SECRET", "SAI_MASTER_KEY", "POSTGRES_PASSWORD"]) {
    if (!process.env[key]) { fail(`${key} missing from .env — run: sai setup`); return; }
  }
  ok(".env secrets present");

  // Build config
  hdr("Building configuration...");
  await run("node", ["scripts/config-layout.mjs", "build"]);

  if (!existsSync("starlingai.json")) { fail("starlingai.json not found after config build."); return; }
  ok("starlingai.json generated");

  // Workspace mount source (WSL path translation)
  process.env.SAI_WORKSPACE_MOUNT_SOURCE = resolveWorkspaceMount();

  // Compose file stack
  const composeFiles = ["-f", "docker-compose.yml"];
  if (strixHalo && existsSync("docker-compose.strix-halo.yml")) {
    composeFiles.push("-f", "docker-compose.strix-halo.yml");
  } else if (strixHalo) {
    warn("docker-compose.strix-halo.yml not found; continuing without Strix Halo overrides.");
  }

  const profileArgs = [];
  if (pentest) profileArgs.push("--profile", "pentest");
  if (desktop) profileArgs.push("--profile", "computer-desktop");

  const dc = (...args) => ["docker", "compose", ...composeFiles, ...profileArgs, ...args];

  // Wipe volumes if --fresh
  if (wipeVolumes) {
    hdr("Wiping existing volumes...");
    try { execSync(dc("down", "-v").join(" "), { stdio: "inherit" }); } catch { /* ok */ }
    ok("Volumes wiped");
  }

  // Build images
  if (wantBuild) {
    hdr(`Building images${noCache ? " (no cache)" : ""}...`);
    const buildArgs = noCache ? ["--no-cache"] : [];
    await run(dc("build", ...buildArgs));
    // Build-only profile services (e.g. agent-worker) are skipped by the default
    // build pass because they're profile-gated. Build them explicitly so the
    // gateway can spawn them on demand.
    await run(["docker", "compose", ...composeFiles, "--profile", "build-only", "build", ...buildArgs]);
    ok("Images built");
  } else {
    try {
      execSync("docker image inspect starlingai/gateway:dev", { stdio: "ignore" });
      execSync("docker image inspect starlingai/agent-worker:dev", { stdio: "ignore" });
    } catch {
      hdr("First run — building images...");
      await run(dc("build"));
      await run(["docker", "compose", ...composeFiles, "--profile", "build-only", "build"]);
      ok("Images built");
    }
  }

  // Start
  hdr("Starting services...");
  await run(dc("up", "-d"));
  ok("Containers started");

  // Health check
  await waitForHealth();

  // Generate and show token
  hdr("Dashboard login token");
  try {
    const token = execSync("node scripts/gen-token.mjs", { encoding: "utf-8" }).trim();
    if (token) {
      console.log(`\n  ${BOLD}Copy this token into the dashboard login modal:${RESET}`);
      console.log(`  ${CYAN}${token}${RESET}\n`);
    }
  } catch {
    info("Generate a token manually: sai token");
  }

  // Summary
  hdr("StarlingAI is up");
  console.log(`
  ${BOLD}Dashboard${RESET}     →  ${CYAN}http://localhost:3001${RESET}
  ${BOLD}Tutorials${RESET}     →  ${CYAN}http://localhost:3002${RESET}
  ${BOLD}Gateway API${RESET}   →  ${CYAN}http://localhost:8765/api${RESET}
  ${BOLD}Health${RESET}        →  ${CYAN}http://localhost:8765/healthz${RESET}

  ${BOLD}Useful commands:${RESET}
    sai stop                      Stop all services
    sai stop --volumes            Stop + wipe all data
    sai start --build             Force rebuild
    sai start --pentest           Start with Kali pentest service
    sai health                    Check service health
    docker compose logs -f        Follow logs
`);
}

async function cmdStop() {
  const { values } = parseArgs({
    args: restArgs,
    options: {
      volumes: { type: "boolean", default: false },
      "strix-halo": { type: "boolean", default: false },
    },
    strict: false,
  });

  const composeFiles = ["-f", "docker-compose.yml"];
  if (values["strix-halo"] && existsSync("docker-compose.strix-halo.yml")) {
    composeFiles.push("-f", "docker-compose.strix-halo.yml");
  } else if (values["strix-halo"]) {
    warn("docker-compose.strix-halo.yml not found; continuing without Strix Halo overrides.");
  }
  const allProfiles = ["--profile", "pentest", "--profile", "computer-desktop"];

  hdr("Stopping StarlingAI...");
  const downArgs = values.volumes ? ["down", "-v"] : ["down"];
  await run(["docker", "compose", ...composeFiles, ...allProfiles, ...downArgs]);

  if (values.volumes) {
    ok("All containers, networks, and volumes removed.");
  } else {
    ok("All containers and networks removed. Data volumes preserved.");
  }
}

async function cmdConfig() {
  if (subCommand === "build") {
    await run("node", ["scripts/config-layout.mjs", "build"]);
  } else if (subCommand === "split") {
    const sourceArg = restArgs[1] || undefined;
    const args = ["scripts/config-layout.mjs", "split"];
    if (sourceArg) args.push(sourceArg);
    await run("node", args);
  } else {
    fail("Usage: sai config <build|split>");
  }
}

async function cmdToken() {
  loadDotEnv();
  // Pass through all args after "token"
  await run("node", ["scripts/gen-token.mjs", ...restArgs]);
}

async function cmdHealth() {
  hdr("Service Health");
  const endpoints = [
    ["Gateway",   "http://localhost:8765/healthz"],
    ["Web UI",    "http://localhost:3001"],
    ["Tutorials", "http://localhost:3002"],
  ];

  for (const [name, url] of endpoints) {
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (resp.ok) ok(`${name} (${url})`);
      else warn(`${name} responded with ${resp.status}`);
    } catch {
      warn(`${name} not reachable (${url})`);
    }
  }
}

async function cmdDev() {
  const target = subCommand ?? "gateway";
  const filterMap = { gateway: "@starlingai/core", web: "@starlingai/web" };
  const filter = filterMap[target];
  if (!filter) { fail(`Unknown dev target: ${target}. Use: gateway, web`); return; }
  await run("pnpm", ["--filter", filter, "dev"]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function printHelp() {
  console.log(`
${BOLD}StarlingAI CLI${RESET}

${BOLD}Usage:${RESET} sai <command> [options]

${BOLD}Commands:${RESET}
  setup                              Check prerequisites, generate .env secrets
  start [flags]                      Build config + start Docker services
    --build                            Force rebuild images
    --no-cache                         Rebuild without Docker cache
    --fresh                            Wipe volumes + rebuild (clean slate)
    --pentest                          Include Kali pentest service
    --strix-halo                       Include Strix Halo ROCm compose overrides
    --speech                           Include ASR/TTS speech services
    --computer-desktop                 Include VNC desktop container
    --all                              Include all remaining optional services
  stop  [--volumes] [--strix-halo]   Stop services (--volumes wipes data)
  config build                       Merge config/ + workspace/ → starlingai.json
  config split [source.json]         Decompose into two-zone layout
  token [--user X] [--role X]        Generate dashboard JWT
  health                             Check service health endpoints
  dev [gateway|web]                  Start development mode
`);
}

function ensureCommand(cmd, errMsg) {
  try { execSync(cmd, { stdio: "ignore" }); }
  catch { fail(errMsg); process.exit(1); }
}

function loadDotEnv() {
  if (!existsSync(".env")) return;
  const lines = readFileSync(".env", "utf-8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}

function resolveWorkspaceMount() {
  const cwd = process.cwd();
  // WSL path translation
  const wslMatch = cwd.match(/^\/mnt\/([a-zA-Z])\/(.*)/);
  if (wslMatch) {
    return `/run/desktop/mnt/host/${wslMatch[1].toLowerCase()}/${wslMatch[2]}`;
  }
  const gitBashMatch = cwd.match(/^\/([a-zA-Z])\/(.*)/);
  if (gitBashMatch) {
    return `/run/desktop/mnt/host/${gitBashMatch[1].toLowerCase()}/${gitBashMatch[2]}`;
  }
  return cwd;
}

async function waitForHealth() {
  hdr("Waiting for services to become healthy...");
  const endpoints = [
    "http://localhost:8765/healthz",
    "http://localhost:3001",
    "http://localhost:3002",
  ];

  const maxWait = 180_000;
  const interval = 5_000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    let allOk = true;
    for (const url of endpoints) {
      try {
        const resp = await fetch(url, { signal: AbortSignal.timeout(3000) });
        if (!resp.ok) allOk = false;
      } catch { allOk = false; }
    }
    if (allOk) break;
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, interval));
  }
  console.log();

  const names = ["Gateway", "Web UI", "Tutorials"];
  for (let i = 0; i < endpoints.length; i++) {
    try {
      const resp = await fetch(endpoints[i], { signal: AbortSignal.timeout(3000) });
      if (resp.ok) ok(names[i]);
      else warn(`${names[i]} not yet responding`);
    } catch {
      warn(`${names[i]} not yet responding`);
    }
  }
}

/**
 * Run a command. Accepts either:
 *   run("cmd", ["arg1", "arg2"])
 *   run(["cmd", "arg1", "arg2"])
 */
function run(cmdOrParts, args) {
  let parts;
  if (Array.isArray(cmdOrParts)) {
    parts = cmdOrParts;
  } else if (Array.isArray(args)) {
    parts = [cmdOrParts, ...args];
  } else {
    parts = [cmdOrParts];
  }
  // Use a single shell string to avoid Node DEP0190 warning
  // and ensure arguments are passed correctly on all platforms
  const shellCmd = parts.join(" ");
  return new Promise((resolve, reject) => {
    const child = spawn(shellCmd, [], { stdio: "inherit", shell: true });
    child.on("close", (code) => {
      if (code !== 0) {
        process.exitCode = code ?? 1;
        reject(new Error(`Command exited with code ${code}: ${shellCmd}`));
      } else {
        resolve();
      }
    });
    child.on("error", reject);
  });
}
