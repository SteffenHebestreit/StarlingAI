#!/usr/bin/env node
/**
 * pnpm e2e:env up|down|status [--json]
 *
 * The local test environment of the end-to-end evaluation suite (eval/e2e/): two synthetic
 * services from docker-compose.e2e.yml, run NEXT TO the running stack in the stack's own compose
 * project, plus the config that lets the swarm use them:
 *
 *   e2e-mail  GreenMail (SMTP/IMAP/REST) — the mailbox of the eval account
 *             config/mail/accounts.d/e2e.json5      eval@e2e.test for the mail-service, bound to the
 *                                                   "eval" user (re-read by the running service)
 *   e2e-site  nginx serving eval/e2e/site/ as http://www.nordlicht-werkzeuge.test/
 *             config/gateway/90-e2e.local.jsonc     guardrails.allowedPrivateHosts += that host name,
 *                                                   compiled by `sai config build` (hot-reloaded)
 *
 * up      starts both services (waits for healthy), writes both config files, rebuilds the config
 * down    deletes both config files, rebuilds the config, stops and removes both services
 * status  reports every piece, including whether the running gateway / mail-service images are
 *         new enough to honour the config (exit 1 while anything is missing)
 *
 * SAFETY: every compose command names the two e2e services explicitly and nothing else. This
 * script never runs `compose down`, never touches a stack service, network or volume, and writes
 * only its two own config files: config/mail/accounts.json (the operator's real accounts) is never
 * written or printed — it is read only where the config build itself merges it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import { collectShardPaths, deepMerge } from "./config-shards.mjs";
import { NON_CONFIG_WORKSPACE_ZONES } from "./config-zones.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rel = (path) => relative(repoRoot, path).split("\\").join("/");

const E2E_SERVICES = Object.freeze(["e2e-mail", "e2e-site"]);
const OVERLAY_COMPOSE_FILE = "docker-compose.e2e.yml";
const DEFAULT_PROJECT = "starlingai";

const SITE_HOST = "www.nordlicht-werkzeuge.test";
const EVAL_USER = "eval";
const EVAL_ACCOUNT_ID = "eval";
const HOST_PORTS = { mailApi: 18080, smtp: 13025, imap: 13143, site: 18081 };

const MAIL_OVERLAY_SOURCE = join(repoRoot, "eval", "e2e", "env", "mail-accounts.json5");
const MAIL_OVERLAY_DIR = join(repoRoot, "config", "mail", "accounts.d");
const MAIL_OVERLAY_FILE = join(MAIL_OVERLAY_DIR, "e2e.json5");
const GATEWAY_SHARD = join(repoRoot, "config", "gateway", "90-e2e.local.jsonc");
const COMPILED_CONFIG = join(repoRoot, "starlingai.json");

// Markers in the baked images: present once the running image carries the code this
// environment relies on (the user rebuilds images; this script never does).
const GATEWAY_DIST_FILE = "/app/packages/core/dist/tools/web.js";
const GATEWAY_DIST_MARKER = "allowedPrivateHosts";
const MAIL_DIST_FILE = "/app/packages/mail-service/dist/config.js";
const MAIL_DIST_MARKER = "SAI_MAIL_SERVICE_ACCOUNTS_DIR";

const [command = "status", ...flags] = process.argv.slice(2);
const asJson = flags.includes("--json");

// ── output ───────────────────────────────────────────────────────────────────
const say = (line = "") => { if (!asJson) console.log(line); };
const mark = (ok) => (ok === true ? "[ok]" : ok === false ? "[!!]" : "[--]");
function fail(message) {
  console.error(`e2e:env: ${message}`);
  process.exit(1);
}

// ── docker ───────────────────────────────────────────────────────────────────
function docker(args, { inherit = false } = {}) {
  const result = spawnSync("docker", args, { cwd: repoRoot, encoding: "utf8", stdio: inherit ? "inherit" : "pipe", windowsHide: true });
  if (result.error) return { ok: false, out: "", err: result.error.message };
  return { ok: result.status === 0, out: (result.stdout ?? "").trim(), err: (result.stderr ?? "").trim() };
}

function requireDocker() {
  const ping = docker(["version", "--format", "{{.Server.Version}}"]);
  if (!ping.ok) fail(`Docker is not reachable (${ping.err.split("\n")[0] || "docker version failed"}).`);
}

const samePath = (a, b) => {
  const norm = (p) => resolve(p).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b);
};

/**
 * The running stack, found by its gateway container: compose project name, the compose files it
 * was started with, and the gateway container. Falls back to the default project when no gateway
 * container of THIS checkout exists.
 */
function detectStack() {
  const rows = docker(["ps", "-a", "--filter", "label=com.docker.compose.service=gateway", "--format",
    '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.Label "com.docker.compose.project.config_files"}}\t{{.State}}\t{{.Names}}']);
  for (const line of rows.ok ? rows.out.split("\n").filter(Boolean) : []) {
    const [project, workingDir, configFiles, state, name] = line.split("\t");
    if (!workingDir || !samePath(workingDir, repoRoot)) continue;
    const files = (configFiles ?? "").split(",").map((f) => f.trim()).filter((f) => f && existsSync(f));
    return { project, files: files.length ? files : [join(repoRoot, "docker-compose.yml")], running: state === "running", gateway: name };
  }
  return { project: DEFAULT_PROJECT, files: [join(repoRoot, "docker-compose.yml")], running: false, gateway: null };
}

/** `docker compose` over the stack's own files + the e2e overlay, in the stack's project. */
function compose(stack, args, opts) {
  const files = [...stack.files.filter((f) => !samePath(f, join(repoRoot, OVERLAY_COMPOSE_FILE))), join(repoRoot, OVERLAY_COMPOSE_FILE)];
  return docker(["compose", "-p", stack.project, ...files.flatMap((f) => ["-f", f]), "--profile", "e2e", ...args], opts);
}

function containerOf(project, service) {
  const r = docker(["ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=com.docker.compose.service=${service}`,
    "--format", "{{.Names}}\t{{.State}}\t{{.Status}}"]);
  const [name, state, status] = (r.ok ? r.out.split("\n")[0] ?? "" : "").split("\t");
  if (!name) return null;
  const health = /\((healthy|unhealthy|health: starting)\)/.exec(status ?? "")?.[1] ?? (state === "running" ? "no healthcheck" : "-");
  return { name, state, health };
}

// ── config ───────────────────────────────────────────────────────────────────
function readJson5(path) {
  return JSON5.parse(readFileSync(path, "utf8"));
}

/** The merged config/ + workspace/ shards, as `sai config build` merges them, minus `skip`. */
function mergeShards(skip) {
  const include = (path) => !samePath(path, skip);
  let merged = {};
  for (const path of collectShardPaths(join(repoRoot, "config"), { include })) merged = deepMerge(merged, readJson5(path));
  for (const path of collectShardPaths(join(repoRoot, "workspace"), { excludeZones: NON_CONFIG_WORKSPACE_ZONES, include })) merged = deepMerge(merged, readJson5(path));
  return merged;
}

function allowlistOf(config) {
  const list = config?.guardrails?.allowedPrivateHosts;
  return Array.isArray(list) ? list.map(String) : [];
}

/** Write `content` to `path` unless it already holds exactly that; true when written. */
function writeIfChanged(path, content) {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
  return true;
}

/** Dotted paths whose values differ between two configs (names only, never values). */
function changedPaths(before, after, path = "", out = []) {
  if (JSON.stringify(before) === JSON.stringify(after)) return out;
  const isObject = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (isObject(before) && isObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) changedPaths(before[key], after[key], path ? `${path}.${key}` : key, out);
  } else {
    out.push(path || "(root)");
  }
  return out;
}

/** `sai config build`, reporting which config paths it changed (the gateway hot-reloads the file). */
function buildConfig(expectedPath) {
  const before = existsSync(COMPILED_CONFIG) ? JSON.parse(readFileSync(COMPILED_CONFIG, "utf8")) : {};
  const result = spawnSync(process.execPath, [join(repoRoot, "scripts", "sai.mjs"), "config", "build"], { cwd: repoRoot, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) fail(`config build failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  const after = JSON.parse(readFileSync(COMPILED_CONFIG, "utf8"));
  const changed = changedPaths(before, after);
  const unexpected = changed.filter((p) => p !== expectedPath);
  say(`${mark(true)} ${rel(COMPILED_CONFIG)} rebuilt — changed: ${changed.length ? changed.join(", ") : "nothing"}`);
  if (unexpected.length) {
    say(`${mark(false)} the rebuild also compiled shard edits that were pending before this run: ${unexpected.slice(0, 12).join(", ")}${unexpected.length > 12 ? ", …" : ""}`);
  }
  return after;
}

function gatewayShardContent(hosts) {
  return [
    "// GENERATED by `pnpm e2e:env up` and deleted by `pnpm e2e:env down` — do not edit (gitignored).",
    "// Lets the agents' web tools reach the e2e fixture site (docker-compose.e2e.yml, service e2e-site),",
    "// which resolves to a private container address. Arrays REPLACE on merge, so this list repeats",
    "// every entry the other shards configure.",
    JSON.stringify({ guardrails: { allowedPrivateHosts: hosts } }, null, 2),
    "",
  ].join("\n");
}

/** Shards that merge AFTER ours and set the list themselves (they would override it). */
function laterShardsSettingAllowlist() {
  const all = [
    ...collectShardPaths(join(repoRoot, "config")),
    ...collectShardPaths(join(repoRoot, "workspace"), { excludeZones: NON_CONFIG_WORKSPACE_ZONES }),
  ];
  const ours = all.findIndex((p) => samePath(p, GATEWAY_SHARD));
  return all.slice(ours + 1).filter((p) => {
    try { return Array.isArray(readJson5(p)?.guardrails?.allowedPrivateHosts); } catch { return false; }
  }).map(rel);
}

// ── probes ───────────────────────────────────────────────────────────────────
async function httpOk(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

function distHasMarker(container, file, marker) {
  if (!container) return null;
  const r = docker(["exec", container, "grep", "-c", marker, file]);
  return r.ok && Number(r.out) > 0;
}

/** Accounts the mail-service shows the eval user ({ id, allowedUsers }). The token is expanded INSIDE the container. */
function mailAccountsForEval(container) {
  if (!container) return null;
  const r = docker(["exec", container, "sh", "-c",
    `curl -sf -m 5 -H "Authorization: Bearer $SAI_MAIL_SERVICE_TOKEN" -H "X-Sai-User: ${EVAL_USER}" http://127.0.0.1:5020/api/accounts`]);
  if (!r.ok) return null;
  try {
    const accounts = JSON.parse(r.out);
    return Array.isArray(accounts)
      ? accounts.map((a) => ({ id: String(a?.id ?? ""), allowedUsers: Array.isArray(a?.allowedUsers) ? a.allowedUsers.map(String) : [] }))
      : null;
  } catch {
    return null;
  }
}

function gatewayResolvesSite(container) {
  if (!container) return null;
  const r = docker(["exec", container, "node", "-e",
    `require("dns").lookup(${JSON.stringify(SITE_HOST)}, { all: true }, (e, a) => process.stdout.write(e ? "" : a.map((x) => x.address).join(",")))`]);
  return r.ok && r.out ? r.out : null;
}

async function collectStatus() {
  const stack = detectStack();
  const containers = Object.fromEntries(E2E_SERVICES.map((s) => [s, containerOf(stack.project, s)]));
  const mailService = containerOf(stack.project, "mail-service");
  const mailRunning = mailService?.state === "running" ? mailService.name : null;
  const gatewayRunning = stack.running ? stack.gateway : null;
  const evalAccounts = mailAccountsForEval(mailRunning);
  const evalAccountIds = evalAccounts ? evalAccounts.map((a) => a.id) : null;
  const compiled = existsSync(COMPILED_CONFIG) ? JSON.parse(readFileSync(COMPILED_CONFIG, "utf8")) : {};
  const status = {
    project: stack.project,
    stackRunning: stack.running,
    services: Object.fromEntries(E2E_SERVICES.map((s) => [s, containers[s] ? { container: containers[s].name, state: containers[s].state, health: containers[s].health } : null])),
    hostEndpoints: {
      mailApi: { url: `http://localhost:${HOST_PORTS.mailApi}`, up: await httpOk(`http://127.0.0.1:${HOST_PORTS.mailApi}/api/service/readiness`) },
      smtp: { host: "localhost", port: HOST_PORTS.smtp },
      imap: { host: "localhost", port: HOST_PORTS.imap },
      site: { url: `http://localhost:${HOST_PORTS.site}`, up: await httpOk(`http://127.0.0.1:${HOST_PORTS.site}/healthz`) },
    },
    siteUrlForAgents: `http://${SITE_HOST}/`,
    config: {
      mailOverlay: existsSync(MAIL_OVERLAY_FILE) ? rel(MAIL_OVERLAY_FILE) : null,
      gatewayShard: existsSync(GATEWAY_SHARD) ? rel(GATEWAY_SHARD) : null,
      compiledAllowsSite: allowlistOf(compiled).some((h) => h.toLowerCase() === SITE_HOST),
    },
    mailService: {
      running: Boolean(mailRunning),
      imageSupportsOverlay: distHasMarker(mailRunning, MAIL_DIST_FILE, MAIL_DIST_MARKER),
      evalAccountLoaded: evalAccountIds ? evalAccountIds.includes(EVAL_ACCOUNT_ID) : null,
      otherAccountsVisibleToEval: evalAccountIds ? evalAccountIds.filter((id) => id !== EVAL_ACCOUNT_ID).length : null,
      // Accounts eval can see that are not bound to it (allowedUsers without "eval"): the operator's
      // shared mail. The e2e harness refuses to run any scenario while this is not 0 (packages/core/src/e2e).
      sharedAccountsVisibleToEval: evalAccounts ? evalAccounts.filter((a) => !a.allowedUsers.some((u) => u.toLowerCase() === EVAL_USER)).length : null,
    },
    gateway: {
      running: Boolean(gatewayRunning),
      imageSupportsAllowlist: distHasMarker(gatewayRunning, GATEWAY_DIST_FILE, GATEWAY_DIST_MARKER),
      resolvesSite: gatewayResolvesSite(gatewayRunning),
    },
  };
  const healthy = (s) => s?.state === "running" && s.health === "healthy";
  status.ready = {
    mail: healthy(status.services["e2e-mail"]) && status.hostEndpoints.mailApi.up && Boolean(status.config.mailOverlay)
      && status.mailService.evalAccountLoaded === true && status.mailService.otherAccountsVisibleToEval === 0,
    site: healthy(status.services["e2e-site"]) && status.hostEndpoints.site.up && status.config.compiledAllowsSite
      && status.gateway.imageSupportsAllowlist === true && Boolean(status.gateway.resolvesSite),
  };
  return status;
}

function printStatus(s) {
  if (asJson) {
    console.log(JSON.stringify(s, null, 2));
    return;
  }
  const svc = (name) => {
    const c = s.services[name];
    return c ? `${c.container}: ${c.state}, ${c.health}` : "not created";
  };
  say(`\nE2E test environment — compose project "${s.project}" (stack ${s.stackRunning ? "running" : "NOT running"})`);
  say("\n  Mail (GreenMail)");
  say(`    ${mark(s.services["e2e-mail"]?.health === "healthy")} e2e-mail                  ${svc("e2e-mail")}`);
  say(`    ${mark(s.hostEndpoints.mailApi.up)} REST API                  ${s.hostEndpoints.mailApi.url}  (SMTP localhost:${HOST_PORTS.smtp}, IMAP localhost:${HOST_PORTS.imap})`);
  say(`    ${mark(Boolean(s.config.mailOverlay))} eval account file         ${s.config.mailOverlay ?? `missing (${rel(MAIL_OVERLAY_FILE)})`}`);
  say(`    ${mark(s.mailService.imageSupportsOverlay)} mail-service image        ${s.mailService.imageSupportsOverlay === false ? "predates the accounts overlay — rebuild the mail-service image" : s.mailService.running ? "reads config/mail/accounts.d" : "mail-service not running"}`);
  say(`    ${mark(s.mailService.evalAccountLoaded)} eval@e2e.test loaded      ${s.mailService.evalAccountLoaded === null ? "unknown" : s.mailService.evalAccountLoaded ? `yes (user "${EVAL_USER}")` : "no"}`);
  say(`    ${mark(s.mailService.otherAccountsVisibleToEval === null ? null : s.mailService.otherAccountsVisibleToEval === 0)} isolation                 ${s.mailService.otherAccountsVisibleToEval === null ? "unknown" : `${s.mailService.otherAccountsVisibleToEval} other account(s) visible to "${EVAL_USER}" (must be 0)`}`);
  say("\n  Website (nginx)");
  say(`    ${mark(s.services["e2e-site"]?.health === "healthy")} e2e-site                  ${svc("e2e-site")}`);
  say(`    ${mark(s.hostEndpoints.site.up)} host URL                  ${s.hostEndpoints.site.url}`);
  say(`    ${mark(Boolean(s.gateway.resolvesSite))} agents' URL               ${s.siteUrlForAgents}${s.gateway.resolvesSite ? ` (gateway resolves it to ${s.gateway.resolvesSite})` : " (not resolvable from the gateway)"}`);
  say(`    ${mark(s.config.compiledAllowsSite)} SSRF exemption            ${s.config.compiledAllowsSite ? `guardrails.allowedPrivateHosts has ${SITE_HOST}` : "not in the compiled config"}`);
  say(`    ${mark(s.gateway.imageSupportsAllowlist)} gateway image             ${s.gateway.imageSupportsAllowlist === false ? "predates guardrails.allowedPrivateHosts — rebuild the gateway image" : s.gateway.running ? "honours guardrails.allowedPrivateHosts" : "gateway not running"}`);
  say(`\n  Ready: mail ${s.ready.mail ? "yes" : "NO"}, site ${s.ready.site ? "yes" : "NO"}\n`);
}

// ── commands ─────────────────────────────────────────────────────────────────
async function up() {
  requireDocker();
  const stack = detectStack();
  if (!stack.running) fail("the stack is not running — start it first (pnpm sai start). The test services join its networks.");
  if (!existsSync(MAIL_OVERLAY_SOURCE)) fail(`missing ${rel(MAIL_OVERLAY_SOURCE)}`);

  say(`Starting ${E2E_SERVICES.join(" + ")} in compose project "${stack.project}" …`);
  const started = compose(stack, ["up", "-d", "--no-deps", "--wait", "--wait-timeout", "180", ...E2E_SERVICES], { inherit: !asJson });
  if (!started.ok) fail(`starting the test services failed${started.err ? `:\n${started.err}` : ""} — see: docker compose -p ${stack.project} logs ${E2E_SERVICES.join(" ")}`);

  // The eval mailbox: the running mail-service re-reads its overlay directory within seconds.
  const mailWritten = writeIfChanged(MAIL_OVERLAY_FILE, readFileSync(MAIL_OVERLAY_SOURCE, "utf8"));
  say(`${mark(true)} ${rel(MAIL_OVERLAY_FILE)} ${mailWritten ? "written" : "already in place"}`);

  // The SSRF exemption for the site: keep every entry the other shards configure (arrays replace).
  const configured = allowlistOf(mergeShards(GATEWAY_SHARD));
  const hosts = [...new Set([...configured, SITE_HOST])];
  const shardWritten = writeIfChanged(GATEWAY_SHARD, gatewayShardContent(hosts));
  say(`${mark(true)} ${rel(GATEWAY_SHARD)} ${shardWritten ? "written" : "already in place"} (allowedPrivateHosts: ${hosts.join(", ")})`);

  const current = existsSync(COMPILED_CONFIG) ? JSON.parse(readFileSync(COMPILED_CONFIG, "utf8")) : {};
  const compiledOk = (config) => {
    const list = allowlistOf(config).map((h) => h.toLowerCase());
    return hosts.every((h) => list.includes(h.toLowerCase()));
  };
  const compiled = shardWritten || !compiledOk(current) ? buildConfig("guardrails.allowedPrivateHosts") : current;
  if (!compiledOk(compiled)) {
    const later = laterShardsSettingAllowlist();
    fail(`the compiled config lacks ${SITE_HOST} in guardrails.allowedPrivateHosts${later.length ? ` — overridden by ${later.join(", ")}, which merge(s) later; add the host there` : ""}.`);
  }

  // Give the mail-service a moment to pick up the overlay (it re-reads at most every 2 s, on a request).
  let status = await collectStatus();
  for (let i = 0; i < 8 && status.mailService.imageSupportsOverlay !== false && status.mailService.evalAccountLoaded === false; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    status = await collectStatus();
  }
  printStatus(status);
  if (!status.ready.mail || !status.ready.site) {
    say("Not everything is ready yet; see the [!!] lines. Images are rebuilt by the user (pnpm sai start --build), never by this script.");
  }
}

async function down() {
  requireDocker();
  if (existsSync(MAIL_OVERLAY_FILE)) {
    rmSync(MAIL_OVERLAY_FILE);
    say(`${mark(true)} ${rel(MAIL_OVERLAY_FILE)} deleted`);
  }
  if (existsSync(MAIL_OVERLAY_DIR) && readdirSync(MAIL_OVERLAY_DIR).length === 0) rmdirSync(MAIL_OVERLAY_DIR);

  if (existsSync(GATEWAY_SHARD)) {
    rmSync(GATEWAY_SHARD);
    say(`${mark(true)} ${rel(GATEWAY_SHARD)} deleted`);
    buildConfig("guardrails.allowedPrivateHosts");
  }

  const stack = detectStack();
  if (E2E_SERVICES.some((s) => containerOf(stack.project, s))) {
    say(`Stopping and removing ${E2E_SERVICES.join(" + ")} (compose project "${stack.project}") …`);
    const removed = compose(stack, ["rm", "--stop", "--force", ...E2E_SERVICES], { inherit: !asJson });
    if (!removed.ok) fail(`removing the test services failed${removed.err ? `:\n${removed.err}` : ""}`);
  }
  const s = await collectStatus();
  const leftovers = [
    ...E2E_SERVICES.filter((name) => s.services[name]),
    ...(s.config.mailOverlay ? [s.config.mailOverlay] : []),
    ...(s.config.gatewayShard ? [s.config.gatewayShard] : []),
    ...(s.config.compiledAllowsSite ? ["guardrails.allowedPrivateHosts entry in starlingai.json"] : []),
  ];
  if (asJson) console.log(JSON.stringify({ down: leftovers.length === 0, leftovers, status: s }, null, 2));
  else if (leftovers.length === 0) say("\nE2E test environment is down: no test containers, no e2e config.");
  else printStatus(s);
  if (leftovers.length) fail(`still present: ${leftovers.join(", ")}`);
}

async function status() {
  requireDocker();
  const s = await collectStatus();
  printStatus(s);
  process.exitCode = s.ready.mail && s.ready.site ? 0 : 1;
}

const commands = { up, down, status };
if (!commands[command]) {
  console.log("Usage: pnpm e2e:env <up|down|status> [--json]   (see eval/e2e/ENVIRONMENT.md)");
  process.exit(command === "help" || command === "--help" ? 0 : 1);
}
await commands[command]();
