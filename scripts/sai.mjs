#!/usr/bin/env node
/**
 * StarlingAI CLI — unified entry point for project management.
 *
 * Usage:
 *   sai setup                              Check prerequisites, generate .env secrets
 *   sai start [--pentest] ...              Build config + start Docker services
 *   sai stop  [--volumes]                  Stop services (--volumes also wipes DB volumes incl. engram RAG, flat-file memory, and uploaded files)
 *   sai wipe  --yes                        Wipe runtime data in place (all DBs), keep containers
 *   sai config build                       Merge config/ + workspace/ → starlingai.json
 *   sai config split [--from <file>]       Decompose monolithic config into two zones
 *   sai token [--user X] [--role X] [--ttl X]  Generate dashboard JWT
 *   sai health                             Check service health endpoints
 *   sai dev [gateway|web]                  Start development mode
 */
import { execSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { PRODUCT } from "./product.mjs";

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

/**
 * Built-in command names. Extension commands are only ever consulted for a name
 * NOT in this set, so a fork can never shadow a core command — the same rule the
 * extension SDK applies to routes and tool tiers. Keep in sync with main()'s switch.
 */
const BUILTIN_COMMANDS = new Set([
  "setup", "start", "stop", "wipe", "config", "memory",
  "env-check", "token", "health", "dev", "help", "--help", "-h",
]);

/**
 * Discover fork-owned CLI subcommands at
 * `packages/core/src/extensions/<ext>/cli/<command>.{mjs,js,ts}`.
 *
 * Mirrors the extension loader's conventions (SAI_EXTENSIONS_DIR override,
 * "_"/"."-prefixed directories skipped, compiled output preferred over source)
 * so a fork adds a file instead of editing this upstream script.
 */
function discoverExtensionCommands() {
  const fromEnv = process.env["SAI_EXTENSIONS_DIR"]?.trim();
  const extensionsDir = fromEnv
    ? resolve(repoRoot, fromEnv)
    : resolve(repoRoot, "packages/core/src/extensions");
  if (!existsSync(extensionsDir)) return new Map();

  const found = new Map();
  for (const ext of readdirSync(extensionsDir)) {
    if (ext.startsWith("_") || ext.startsWith(".")) continue;
    const cliDir = resolve(extensionsDir, ext, "cli");
    if (!existsSync(cliDir) || !statSync(cliDir).isDirectory()) continue;

    for (const file of readdirSync(cliDir)) {
      const match = /^(.+)\.(mjs|js|ts)$/.exec(file);
      if (!match) continue;
      const [, name, ext2] = match;
      if (BUILTIN_COMMANDS.has(name)) {
        // Loud, not silent: otherwise a future upstream command with this name
        // would quietly start winning and the fork's command would vanish.
        warn(`Extension "${ext}" declares CLI command "${name}", which is built in — ignoring.`);
        continue;
      }
      const existing = found.get(name);
      // Compiled output wins over source, matching the extension loader.
      const rank = { mjs: 0, js: 1, ts: 2 }[ext2];
      if (!existing || rank < existing.rank) {
        found.set(name, { ext, path: resolve(cliDir, file), rank, isTs: ext2 === "ts" });
      }
    }
  }
  return found;
}

async function runExtensionCommand(entry) {
  // .ts needs tsx; compiled output runs on plain node.
  const runner = entry.isTs ? ["npx", "tsx"] : ["node"];
  await run([...runner, JSON.stringify(entry.path), ...restArgs]);
}

const command = process.argv[2];
const subCommand = process.argv[3];
const restArgs = process.argv.slice(3);

// Dispatch is invoked at the BOTTOM of this file (see `await main()`), not here.
// A top-level `await cmd…()` would run while module evaluation is still suspended,
// before the module-scope `const`s further down (e.g. MEMORY_FLATFILE_ZONES) have
// been initialized — those consts would be in their TDZ and any command that touches
// them throws "Cannot access 'X' before initialization". Running main() last
// guarantees every declaration in this module is initialized first.
async function main() {
  switch (command) {
    case "setup":   await cmdSetup(); break;
    case "start":   await cmdStart(); break;
    case "stop":    await cmdStop(); break;
    case "wipe":    await cmdWipe(); break;
    case "config":  await cmdConfig(); break;
    case "memory":  await cmdMemory(); break;
    case "env-check": await cmdEnvCheck(); break;
    case "token":   await cmdToken(); break;
    case "health":  await cmdHealth(); break;
    case "dev":     await cmdDev(); break;
    case "help": case "--help": case "-h": case undefined:
      printHelp(); break;
    default: {
      // Only reached for a name no built-in claimed, so an extension can never
      // shadow a core command.
      const extensionCommand = discoverExtensionCommands().get(command);
      if (extensionCommand) {
        await runExtensionCommand(extensionCommand);
        break;
      }
      fail(`Unknown command: ${command}`);
      printHelp();
    }
  }
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
      "computer-desktop":{ type: "boolean", default: false },
      rag:               { type: "boolean", default: false },
      all:               { type: "boolean", default: false },
    },
    strict: false,
  });

  const wantBuild   = values.build || values["no-cache"] || values.fresh;
  const noCache     = values["no-cache"] || values.fresh;
  const wipeVolumes = values.fresh;
  const pentest     = values.pentest || values.all;
  const desktop     = values["computer-desktop"] || values.all;
  const ragFlag     = values.rag || values.all;

  hdr(`${PRODUCT.name} — Starting up`);

  // Prerequisites
  ensureCommand("docker", "Docker not found. Install Docker Desktop first.");
  ensureCommand("docker compose version", "Docker Compose plugin not found.");
  ensureDockerDaemon();
  ok("Docker available (daemon reachable)");

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

  if (!existsSync(PRODUCT.configFileName)) { fail(`${PRODUCT.configFileName} not found after config build.`); return; }
  ok(`${PRODUCT.configFileName} generated`);

  // Preflight: warn loudly about config "$VAR" references that .env does not
  // satisfy, so a stored site/channel/webhook does not silently turn into
  // "not found" at runtime. Warn-only — optional integrations may be unset.
  await run("node", ["scripts/check-env-refs.mjs"]);

  // Workspace mount source (WSL path translation)
  process.env.SAI_WORKSPACE_MOUNT_SOURCE = resolveWorkspaceMount();

  // Compose file stack
  const composeFiles = ["-f", "docker-compose.yml"];

  // Document-RAG stack (engram + reranker) is behind the `rag` profile, OFF by
  // default so a plain start works on any machine (the reranker reserves an NVIDIA
  // GPU). Opt in with `sai start --rag` or persist SAI_ENABLE_RAG=1 in .env.
  const wantRag = ragFlag || /^(1|true|yes|on)$/i.test(process.env.SAI_ENABLE_RAG || "");
  const profileArgs = [];
  if (pentest) profileArgs.push("--profile", "pentest");
  if (desktop) profileArgs.push("--profile", "computer-desktop");
  if (wantRag) {
    profileArgs.push("--profile", "rag");
    // The reranker only gets the GPU when a host NVIDIA GPU is present (or forced
    // via SAI_GPU=1). Otherwise it runs on CPU. SAI_GPU=0 forces CPU.
    const gpuForced = /^(1|true|yes|on)$/i.test(process.env.SAI_GPU || "");
    const gpuOff = /^(0|false|no|off)$/i.test(process.env.SAI_GPU || "");
    const useGpu = gpuForced || (!gpuOff && hasNvidiaGpu());
    if (useGpu) {
      composeFiles.push("-f", "docker-compose.gpu.yml");
      ok("RAG enabled (engram + reranker) — GPU detected, reranker on GPU");
    } else {
      ok("RAG enabled (engram + reranker) — no GPU, reranker on CPU");
    }
  }

  const dc = (...args) => ["docker", "compose", ...composeFiles, ...profileArgs, ...args];

  // Wipe volumes + host flat-file state if --fresh (a true clean slate, mirroring
  // `sai stop --volumes`): `down -v` clears the DB volumes, but the flat-file
  // memory/skills/audit and uploaded files live on the host bind mount and survive
  // it, so sweep those too — otherwise --fresh silently leaves stale .starlingai data.
  if (wipeVolumes) {
    hdr("Wiping existing volumes...");
    try { execSync(dc("down", "-v").join(" "), { stdio: "inherit" }); } catch { /* ok */ }
    ok("Volumes wiped");
    hdr("Clearing flat-file agent state (memory, skills, learning history, audit log)...");
    wipeFlatFileMemory();
    hdr("Clearing uploaded attachment files (document-RAG source files)...");
    wipeUploadedFiles();
    ok("Clean slate: DB volumes, flat-file memory + audit log, and uploaded files removed (credentials preserved).");
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
      execSync(`docker image inspect ${PRODUCT.slug}/gateway:dev`, { stdio: "ignore" });
      execSync(`docker image inspect ${PRODUCT.slug}/agent-worker:dev`, { stdio: "ignore" });
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
  hdr(`${PRODUCT.name} is up`);
  console.log(`
  ${BOLD}Dashboard${RESET}     →  ${CYAN}http://localhost:3001${RESET}
  ${BOLD}Tutorials${RESET}     →  ${CYAN}http://localhost:3002${RESET}
  ${BOLD}Gateway API${RESET}   →  ${CYAN}http://localhost:8765/api${RESET}
  ${BOLD}Health${RESET}        →  ${CYAN}http://localhost:8765/healthz${RESET}

  ${BOLD}Useful commands:${RESET}
    sai stop                      Stop all services
    sai stop --volumes            Stop + wipe all data (DB volumes incl. engram RAG, flat-file memory/skills, uploaded files)
    sai start --build             Force rebuild
    sai start --pentest           Start with Kali pentest service
    sai health                    Check service health
    docker compose logs -f        Follow logs
`);
}

// Flat-file agent state that lives on the host bind mount (NOT in a docker
// volume), so `docker compose down -v` never removes it. `sai stop --volumes`,
// `sai start --fresh`, and `sai wipe` clear these for a true clean slate. The
// DB-backed memory (Redis session facts, MemGraph knowledge graph, Postgres agent
// store + embeddings, QuestDB research notes) is already gone with the volumes.
// The audit log (audit.jsonl) is wiped too. Only the credentials (credentials.enc
// + .salt, .jwt_secret, token) are PRESERVED so a clean slate does not force a
// re-auth / token re-mint — `rm -rf .starlingai` by hand for a full factory reset
// incl. credentials. State now centralizes at the repo-root .starlingai (the
// gateway's cwd zone, where audit + credentials live); the legacy workspace and
// packages/core zones are still swept to clear residue from older layouts.
const MEMORY_FLATFILE_TARGETS = [
  "memory",                            // durable memory store
  "skills",                            // learned procedural skills
  "flow_memory.ndjson",                // decision-flow memory
  "agent_outcomes.ndjson",             // per-agent outcome history
  "promoted_agents.json",              // promoted ephemeral agents
  "config_assistant_proposals.json",   // pending self-improvement proposals
  "audit.jsonl",                       // audit log — wiped for a clean slate (creds kept)
];
const MEMORY_FLATFILE_ZONES = [
  PRODUCT.stateDirName,                // gateway cwd zone
  `workspace/${PRODUCT.stateDirName}`, // workspace zone (durable memory store)
  `packages/core/${PRODUCT.stateDirName}`, // residue from running vitest / sai memory in packages/core
  `packages/core/workspace/${PRODUCT.stateDirName}`,
];

function wipeFlatFileMemory() {
  let removed = 0;
  for (const zone of MEMORY_FLATFILE_ZONES) {
    for (const target of MEMORY_FLATFILE_TARGETS) {
      const rel = `${zone}/${target}`;
      const abs = resolve(repoRoot, rel);
      // Safety: never delete anything outside the repo root.
      if (!abs.startsWith(repoRoot)) continue;
      if (!existsSync(abs)) continue;
      try {
        rmSync(abs, { recursive: true, force: true });
        ok(`Removed ${rel}`);
        removed += 1;
      } catch (err) {
        warn(`Could not remove ${rel} — ${(err?.message || "error").slice(0, 120)}`);
      }
    }
  }
  if (removed === 0) info("No flat-file memory found on disk (already clean).");
}

// Files attached to chats are persisted under the workspace `uploads/` bind mount
// (NOT a docker volume), then ingested into the engram document-RAG store. The
// engram store itself lives in the engram-data volume (removed by
// `down -v`), but these original files survive on the host — wipe them too so a
// clean slate doesn't leave orphaned document content behind.
const UPLOAD_ZONES = [
  "workspace/uploads",
  "packages/core/workspace/uploads", // test/dev residue
];

function wipeUploadedFiles() {
  let removed = 0;
  for (const rel of UPLOAD_ZONES) {
    const abs = resolve(repoRoot, rel);
    if (!abs.startsWith(repoRoot)) continue; // never delete outside the repo
    if (!existsSync(abs)) continue;
    try {
      rmSync(abs, { recursive: true, force: true });
      ok(`Removed ${rel}`);
      removed += 1;
    } catch (err) {
      warn(`Could not remove ${rel} — ${(err?.message || "error").slice(0, 120)}`);
    }
  }
  if (removed === 0) info("No uploaded attachment files found on disk (already clean).");
}

async function cmdStop() {
  const { values } = parseArgs({
    args: restArgs,
    options: {
      volumes: { type: "boolean", default: false },
    },
    strict: false,
  });

  const composeFiles = ["-f", "docker-compose.yml"];
  const allProfiles = ["--profile", "pentest", "--profile", "computer-desktop", "--profile", "rag"];

  hdr(`Stopping ${PRODUCT.name}...`);
  ensureDockerDaemon();
  const downArgs = values.volumes ? ["down", "-v"] : ["down"];
  await run(["docker", "compose", ...composeFiles, ...allProfiles, ...downArgs]);

  if (values.volumes) {
    // `down -v` cleared the DB-backed memory (Redis session facts, MemGraph
    // knowledge graph, Postgres agent store + pgvector embeddings, QuestDB research
    // notes) AND the document-RAG store (engram's engram-data volume) +
    // the reranker model cache. The flat-file durable memory + learned skills and
    // the uploaded attachment files survive on the host bind mount, so wipe those
    // here for a real clean slate.
    hdr("Clearing flat-file agent memory (memory store, skills, learning history)...");
    wipeFlatFileMemory();
    hdr("Clearing uploaded attachment files (document-RAG source files)...");
    wipeUploadedFiles();
    ok("Clean slate: containers, networks, DB volumes (incl. engram RAG + reranker cache), flat-file memory + audit log, and uploaded files removed.");
    info(`Preserved: credentials, JWT secret, dashboard token — delete ${PRODUCT.stateDirName} by hand for a full factory reset.`);
  } else {
    ok("All containers and networks removed. Data volumes preserved.");
  }
}

async function cmdWipe() {
  const { values } = parseArgs({
    args: restArgs,
    options: { yes: { type: "boolean", default: false } },
    strict: false,
  });
  loadDotEnv();

  hdr(`Wipe ${PRODUCT.name} runtime data (containers stay up; config + credentials untouched)`);
  info("Clears: Redis (sessions/swarm/ephemeral), Postgres (audit, agent data, scene jobs, vector embeddings = pgvector RAG), QuestDB (telemetry + research notes), MemGraph (knowledge graph), engram (document-RAG store) + its uploaded source files, and the audit-log mirror.");
  if (!values.yes) {
    warn("This permanently deletes that data. Re-run to proceed:  pnpm sai wipe --yes");
    warn("For a full clean slate (volumes + flat-file memory/skills) use:  pnpm sai stop --volumes");
    return;
  }
  ensureDockerDaemon();

  const dcExec = (label, service, shellCmd) => {
    try {
      execSync(`docker compose exec -T ${service} ${shellCmd}`, { stdio: ["ignore", "pipe", "pipe"] });
      ok(label);
    } catch (err) {
      const detail = (err.stderr?.toString() || err.message || "").split("\n").find(Boolean) || "unavailable";
      warn(`${label} — skipped (${detail.slice(0, 120)})`);
    }
  };

  // Redis — sessions, swarm shared memory, locks, ephemeral KV.
  dcExec("Redis flushed", "redis", "redis-cli FLUSHALL");

  // Postgres — split into two TRUNCATEs so a missing pgvector table (deferred
  // init) does not abort wiping the always-present core tables.
  dcExec(
    "Postgres core tables truncated",
    "postgres",
    `psql -U starlingai -d starlingai -c "TRUNCATE TABLE audit_events, agent_data_store, scene_jobs RESTART IDENTITY"`,
  );
  dcExec(
    "Postgres vector store truncated",
    "postgres",
    `psql -U starlingai -d starlingai -c "TRUNCATE TABLE vector_embeddings RESTART IDENTITY"`,
  );

  // QuestDB — routed through the gateway, which has network access + an HTTP
  // client; dropped tables are recreated on the next write.
  for (const tbl of ["llm_usage", "tool_latency", "sub_agent_run", "research_notes"]) {
    dcExec(`QuestDB ${tbl} dropped`, "gateway", `sh -lc "wget -qO- 'http://questdb:9000/exec?query=DROP%20TABLE%20IF%20EXISTS%20${tbl}' || curl -s 'http://questdb:9000/exec?query=DROP%20TABLE%20IF%20EXISTS%20${tbl}'"`);
  }

  // MemGraph — drop every node + relationship.
  dcExec("MemGraph cleared", "memgraph", `sh -lc "echo 'MATCH (n) DETACH DELETE n;' | mgconsole"`);

  // engram — under the embedded engramdb backend (STORE_BACKEND=engramdb) the store
  // is an in-process vector+BM25+graph snapshotted to a single pickle at ENGRAMDB_PATH
  // inside the engram-data volume — there is NO engram-neo4j service. (The old
  // cypher-shell wipe targeted that non-existent service, so dcExec always swallowed
  // the error and engram was silently never cleared.) Delete the snapshot and restart
  // engram so it reloads an empty store; the in-memory store would otherwise re-snapshot
  // the still-populated data back to disk. If engram isn't running (the `rag` profile is
  // off by default) both steps skip cleanly — there is nothing to clear.
  const engramDbPath = process.env.ENGRAM_ENGRAMDB_PATH || "/data/engramdb.pkl";
  dcExec("engram store snapshot removed", "engram", `sh -lc "rm -f '${engramDbPath}'"`);
  try {
    execSync("docker compose restart engram", { stdio: ["ignore", "pipe", "pipe"] });
    ok("engram document-RAG store cleared (reloaded empty)");
  } catch (err) {
    const detail = (err.stderr?.toString() || err.message || "").split("\n").find(Boolean) || "not running";
    warn(`engram document-RAG store — reload skipped (${detail.slice(0, 120)})`);
  }

  // On-disk audit-log mirror on the gateway data volume.
  dcExec("Audit log mirror cleared", "gateway", `sh -lc ": > /data/audit.jsonl"`);

  // Uploaded attachment files (document-RAG source files) on the workspace bind mount.
  hdr("Clearing uploaded attachment files...");
  wipeUploadedFiles();

  hdr("Runtime data wiped.");
  info("Schemas are recreated lazily on next use; no restart required.");
}

async function cmdConfig() {
  if (subCommand === "build") {
    await run("node", ["scripts/config-layout.mjs", "build"]);
  } else if (subCommand === "split") {
    // Forward any source file + flags (e.g. --force) to the layout script.
    const args = ["scripts/config-layout.mjs", "split", ...restArgs.slice(1)];
    await run("node", args);
  } else {
    fail("Usage: sai config <build|split>");
  }
}

async function cmdMemory() {
  if (subCommand !== "export" && subCommand !== "import") {
    fail("Usage: sai memory <export|import> [--vault <path>] [--no-sessions]");
    return;
  }
  const workspace = process.env.SAI_WORKSPACE_CONFIG_PATH?.trim()
    ? resolve(process.env.SAI_WORKSPACE_CONFIG_PATH)
    : resolve(repoRoot, "workspace");
  // restArgs = [subCommand, ...flags]; pass the flags through to the tsx CLI.
  const passThrough = restArgs.slice(1);
  await run("pnpm", [
    "--filter", "@starlingai/core", "exec",
    "tsx", "src/cli/memory-vault.ts", subCommand,
    "--workspace", workspace,
    ...passThrough,
  ]);
}

async function cmdEnvCheck() {
  hdr("Env reference check");
  // Pass through flags (e.g. --strict) after "env-check".
  await run("node", ["scripts/check-env-refs.mjs", ...restArgs]);
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
    --rag                              Include document-RAG stack (engram + reranker);
                                       uses the GPU when one is present, else CPU.
                                       Persist with SAI_ENABLE_RAG=1 in .env
    --pentest                          Include Kali pentest service
    --computer-desktop                 Include VNC desktop container
    --all                              Include all remaining optional services
  stop  [--volumes]                  Stop services (--volumes wipes DB volumes incl. engram RAG, flat-file memory, uploaded files)
  wipe  --yes                        Wipe runtime DATA in place (Redis, Postgres
                                     incl. pgvector, QuestDB, MemGraph, audit log)
                                     while containers keep running; config kept
  config build                       Merge config/ + workspace/ → starlingai.json
  config split [source.json]         Decompose into two-zone layout
  memory export [--vault <path>]     Mirror durable memory → Obsidian-style Markdown vault
    [--no-sessions]                    (skip recent-session summaries)
  memory import [--vault <path>]     Re-ingest edited managed vault notes into the store
  env-check [--strict]               Report config $VAR refs not satisfied by .env
  token [--user X] [--role X]        Generate dashboard JWT
  health                             Check service health endpoints
  dev [gateway|web]                  Start development mode
`);

  // A fork's own commands, so `sai help` documents the whole CLI it actually has.
  const extensionCommands = discoverExtensionCommands();
  if (extensionCommands.size > 0) {
    console.log(`${BOLD}Extension commands:${RESET}`);
    for (const [name, entry] of [...extensionCommands].sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`  ${name.padEnd(35)}Provided by the "${entry.ext}" extension`);
    }
    console.log("");
  }
}

function ensureCommand(cmd, errMsg) {
  try { execSync(cmd, { stdio: "ignore" }); }
  catch { fail(errMsg); process.exit(1); }
}

// `ensureCommand("docker", …)` only proves the CLI binary exists — it never contacts
// the daemon, so with Docker Desktop stopped the preflight prints "✓ Docker available"
// and the run dies minutes later inside `docker compose` with a raw npipe stack trace.
// `docker info` actually round-trips to the engine, so a stopped daemon fails HERE,
// immediately, with an actionable message.
function ensureDockerDaemon() {
  try { execSync("docker info --format {{.ServerVersion}}", { stdio: "ignore" }); }
  catch {
    fail("Docker daemon is not reachable — start Docker Desktop, wait until the engine shows 'running', then retry.");
    process.exit(1);
  }
}

// Best-effort host NVIDIA-GPU probe so `sai start --rag` only adds the GPU overlay
// (docker-compose.gpu.yml) when a GPU is actually present — otherwise the reranker's
// device reservation would abort the whole `up` on a GPU-less machine. nvidia-smi
// exists wherever the NVIDIA driver is installed (Linux + Windows/Docker Desktop).
function hasNvidiaGpu() {
  try { execSync("nvidia-smi -L", { stdio: "ignore" }); return true; }
  catch { return false; }
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

// Run the dispatcher only after every module-scope declaration above is initialized.
// Catch instead of letting the rejection escape: the child's own stderr already showed
// the real error (stdio: inherit), so the Node-internal stack trace is pure noise — and
// an explicit exit code makes `sai stop && sai start` chains short-circuit reliably.
await main().catch((err) => {
  fail(err?.message ?? String(err));
  process.exit(typeof process.exitCode === "number" && process.exitCode !== 0 ? process.exitCode : 1);
});
