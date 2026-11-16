// Suite-wide test isolation, applied before any test module is imported.
//
// Why this exists: audit writes resolve their destination lazily, per write
// (audit/logger.ts enqueueWrite -> resolveAuditLogPath). With SAI_AUDIT_LOG
// unset that falls back to `resolve(process.cwd(), ".starlingai", "audit.jsonl")`
// — and because vitest runs from packages/core, every unisolated test appended
// to the real packages/core/.starlingai/audit.jsonl in the source tree. Only 19
// of ~291 test files set SAI_AUDIT_LOG or mocked the logger themselves, so the
// file had grown into the hundreds of KB of accumulated test events.
//
// Setting a temp default fixes the bulk of it, but ~14 test files `delete
// process.env["SAI_AUDIT_LOG"]` in their own cleanup, and every test shares one
// process (maxWorkers: 1) — so a single delete re-exposed the repo path for
// everything that ran afterwards. Re-asserting the default around each test
// closes that window without editing all 14 files.
//
// Tests that set SAI_AUDIT_LOG themselves still win: resolution happens per
// write, the hooks below only fill in a value when there is none, and this
// file's hooks run before each test file's own. No test asserts the
// process.cwd() fallback, so nothing depends on the variable being unset.
import childProcess from "node:child_process";
import fs, { mkdtempSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeEach } from "vitest";

const FALLBACK_AUDIT_LOG = join(mkdtempSync(join(tmpdir(), "sai-test-audit-")), "audit.jsonl");

function ensureAuditLogRedirected(): void {
  if (!process.env["SAI_AUDIT_LOG"]?.trim()) {
    process.env["SAI_AUDIT_LOG"] = FALLBACK_AUDIT_LOG;
  }
}

ensureAuditLogRedirected();
beforeEach(ensureAuditLogRedirected);
afterEach(ensureAuditLogRedirected);

// The same hole for user-scope state: with SAI_USER_MEMORY_PATH unset, user memory, the user
// model and the personality override resolve to ~/.starlingai/user-memory — the developer's REAL
// home directory. Eleven test files delete the variable in their cleanup, so any test after them
// that stored a user-scope record wrote it there (found 2026-10-05: a review probe's records
// landed in the home dir). Same remedy: a temp default, re-asserted around each test.
const FALLBACK_USER_MEMORY_DIR = mkdtempSync(join(tmpdir(), "sai-test-user-memory-"));

function ensureUserMemoryRedirected(): void {
  if (!process.env["SAI_USER_MEMORY_PATH"]?.trim()) {
    process.env["SAI_USER_MEMORY_PATH"] = FALLBACK_USER_MEMORY_DIR;
  }
}

ensureUserMemoryRedirected();
beforeEach(ensureUserMemoryRedirected);
afterEach(ensureUserMemoryRedirected);

// ── Network isolation ─────────────────────────────────────────────────────────
//
// The suite must give the same answer on a laptop next to a model cluster as on a CI
// runner with nothing around it. It did not: the default provider URL is
// host.docker.internal:1234, which Docker Desktop resolves to the developer's host, so a
// test whose code path happened to call the chat model (the routing restatement rescue,
// for one) reached a real LM Studio locally and failed fast with ENOTFOUND in CI. Locally
// that meant seconds-long, model-dependent tests; in CI, a different code path.
//
// SAI_TEST_LIVE=1 opts a run out of both measures below, for the steps that point a test
// at a real service on purpose (CI's Redis integration steps, a deliberate live smoke).
const LIVE = process.env["SAI_TEST_LIVE"] === "1";

// 1. Service URLs inherited from the shell or a sourced .env. The loader overlays these
//    onto every test config (config/loader.ts mergeEnvOverrides), and the stores pick
//    their backend from them, so an ambient value silently swaps a hermetic in-process
//    path for a real one. Deleted once, before the test file loads: a test that sets one
//    itself still gets it.
const SERVICE_URL_VARS = new Set([
  "SAI_PRIMARY_MODEL_URL",
  "SAI_LMSTUDIO_URL",
  "SAI_LAYA_URL",
  "REDIS_URL",
  "DATABASE_URL",
  "QUESTDB_URL",
  "MEMGRAPH_URL",
  "SEARXNG_BASE_URL",
]);
const MULTIMODAL_URL_VAR = /^SAI_MULTIMODAL_\w+_URL$/;

if (!LIVE) {
  for (const name of Object.keys(process.env)) {
    if (SERVICE_URL_VARS.has(name) || MULTIMODAL_URL_VAR.test(name)) delete process.env[name];
  }
}

// 2. Outbound connections to anything but this machine. Scrubbing variables cannot catch
//    a default baked into a schema (the host.docker.internal one above), so connections
//    are checked where they all pass: net.Socket#connect, which net.connect, tls.connect,
//    http(s) agents, fetch (undici) and the Redis/Postgres clients all go through.
//    Loopback and local IPC stay open — many tests run real servers on 127.0.0.1.
//
//    A refused connection fails the way it already fails in CI, where host.docker.internal
//    does not resolve: ENOTFOUND for a hostname, EHOSTUNREACH for an IP literal. Both are
//    deliberately NOT ECONNREFUSED, which the chat provider retries (providers/lmstudio.ts),
//    so a blocked call costs nothing instead of a backoff.
const GUARDED = Symbol.for("starlingai.test.networkGuard");

function isLocalHost(host: string): boolean {
  const bare = host.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return bare === "localhost"
    || bare.endsWith(".localhost")
    || bare === "::1"
    || bare === "0.0.0.0"
    || bare === "::"
    || /^127\./.test(bare)
    || /^::ffff:127\./.test(bare);
}

/** The host a Socket#connect call targets, or `null` for a local IPC path. */
function connectHost(args: unknown[]): string | undefined | null {
  // net.connect() hands Socket#connect its already-normalized [options, listener] pair.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (first !== null && typeof first === "object") {
    const options = first as { host?: unknown; path?: unknown };
    if (typeof options.path === "string") return null;
    return typeof options.host === "string" ? options.host : undefined;
  }
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
    return typeof args[1] === "string" ? args[1] : undefined;
  }
  // connect(path[, listener]): a Unix socket or Windows named pipe.
  return typeof first === "string" ? null : undefined;
}

const socketPrototype = net.Socket.prototype as net.Socket & { [GUARDED]?: true };
if (!LIVE && !socketPrototype[GUARDED]) {
  const originalConnect = socketPrototype.connect;
  socketPrototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]): net.Socket {
    const host = connectHost(args);
    // null is local IPC; undefined is an absent host, which net defaults to localhost.
    if (host === null || host === undefined || host === "" || isLocalHost(host)) {
      return (originalConnect as (...connectArgs: unknown[]) => net.Socket).apply(this, args);
    }
    const literal = net.isIP(host.replace(/^\[(.*)\]$/, "$1")) !== 0;
    const code = literal ? "EHOSTUNREACH" : "ENOTFOUND";
    const syscall = literal ? "connect" : "getaddrinfo";
    const error = Object.assign(
      new Error(`${syscall} ${code} ${host} — blocked by the test network guard (tests reach this machine only; SAI_TEST_LIVE=1 lifts it)`),
      { code, syscall, hostname: host },
    );
    // Emitted on the next tick, like a real DNS or connect failure, so listeners the
    // caller attaches right after connect() returns still receive it.
    process.nextTick(() => this.destroy(error));
    return this;
  } as typeof socketPrototype.connect;
  socketPrototype[GUARDED] = true;
}

// 3. Inbound: the servers a test starts. The measures above keep a test from reaching out;
//    nothing kept the network from reaching in. Every createGateway().start() bound 0.0.0.0
//    (the listen address was hardcoded until gateway.host existed), so each gateway test put a
//    gateway on the LAN for its duration, on a port from a narrow, guessable range, signed with
//    a JWT secret written in this repository ("d".repeat(32) and the like). Node's listen()
//    without a host binds every interface as well (`::`). A bind to every interface is moved to
//    loopback, where every test connects anyway; a bind to any other non-loopback address (a LAN
//    IP, a hostname other than localhost) throws, so a test cannot expose a server on purpose
//    either. This holds under SAI_TEST_LIVE=1 too: a live run reaches out to real services, it
//    never needs to be reached.
//
//    An ambient SAI_GATEWAY_HOST (a developer's shell, a sourced .env) would be laid over every
//    test config by the loader, so it is deleted as well.
delete process.env["SAI_GATEWAY_HOST"];

const LISTEN_GUARDED = Symbol.for("starlingai.test.listenGuard");
const EVERY_INTERFACE = new Set(["", "0.0.0.0", "::", "[::]", "::0"]);

/** `host`, or a throw when it is neither every interface (rewritten by the caller) nor loopback. */
function loopbackListenHost(host: string): string {
  if (EVERY_INTERFACE.has(host)) return "127.0.0.1";
  if (isLocalHost(host)) return host;
  throw new Error(`listen ${host} — refused by the test listen guard (tests bind loopback only: 127.0.0.1, ::1 or localhost)`);
}

interface ListenOptions { host?: unknown; port?: unknown; fd?: unknown; handle?: unknown; _handle?: unknown }

/** listen()'s arguments with a bind to every interface moved to 127.0.0.1; anything else as given.
 *  The arguments are read the way net.Server#listen reads them (Node's lib/net.js), so whatever
 *  the guard passes on as an IPC path or an inherited handle, Node does not bind TCP for either. */
function loopbackListenArgs(args: unknown[]): unknown[] {
  const [first] = args;
  // listen() and listen(callback): no port, no host. (listen(undefined, host) is port 0 on host.)
  if (args.length === 0 || typeof first === "function") return [0, "127.0.0.1", ...args];
  if (first !== null && typeof first === "object") {
    const given = first as ListenOptions;
    // Node listens on `_handle || handle` in place of the object when either is set (an inherited
    // server, socket or raw TCP handle), and on `fd` only when it is a valid descriptor: neither
    // binds an interface. A null handle or an fd of -1 does not count.
    const options = (given._handle || given.handle || given) as ListenOptions;
    if (typeof options.fd === "number" && options.fd >= 0) return args;
    // Anything else with a `port` key binds TCP, an undefined or null port meaning any free one,
    // and Node decides that before it looks at `path`: { port, path } binds the port, not the
    // path. Without a port it is an IPC path, a raw TCP handle, or a call Node rejects.
    if (!("port" in options) || !(options.port == null || typeof options.port === "number" || typeof options.port === "string")) return args;
    // Any falsy host (missing, null, "", 0) is Node's unspecified address: every interface.
    if (!options.host) return [{ ...options, host: "127.0.0.1" }, ...args.slice(1)];
    // Node's own lookup rejects a host that is not a string.
    if (typeof options.host !== "string") return args;
    const host = loopbackListenHost(options.host);
    return host === options.host ? args : [{ ...options, host }, ...args.slice(1)];
  }
  // listen(path[, ...]): a Unix socket or a Windows named pipe. Node reads a string as a pipe name
  // only when it is not a number >= 0 (its isPipeName): " 8080" and "0x1F90" are ports.
  if (typeof first === "string" && !(Number(first) >= 0)) return args;
  // listen(port[, host][, backlog][, callback]); `ws` and others pass an undefined host.
  if (typeof args[1] === "string") return [first, loopbackListenHost(args[1]), ...args.slice(2)];
  if (args.length > 1 && args[1] == null) return [first, "127.0.0.1", ...args.slice(2)];
  return [first, "127.0.0.1", ...args.slice(1)];
}

const serverPrototype = net.Server.prototype as net.Server & { [LISTEN_GUARDED]?: true };
if (!serverPrototype[LISTEN_GUARDED]) {
  const originalListen = serverPrototype.listen;
  serverPrototype.listen = function guardedListen(this: net.Server, ...args: unknown[]): net.Server {
    return (originalListen as (...listenArgs: unknown[]) => net.Server).apply(this, loopbackListenArgs(args));
  } as typeof serverPrototype.listen;
  serverPrototype[LISTEN_GUARDED] = true;
}

// ── The default workspace ─────────────────────────────────────────────────────
//
// A config that leaves `workspacePath` unset gets the schema default `/workspace` (config/schema.ts),
// the workspace mount of the gateway image, and the state stores resolve under it: the agent outcomes
// ledger, checkpoints, approvals, the account registry, memory, skills, uploads. A test that left it
// unset, or handed a tool or session the literal "/workspace", read and wrote outside its own temp
// dirs, and what it saw depended on the machine:
//   - a Linux CI runner has no /workspace and cannot create one (EACCES under the root-owned /): the
//     test saw nothing there, or failed in CI only;
//   - on Windows `/workspace` is `<drive of the cwd>:\workspace`, created by the first test that wrote
//     there and from then on shared by every checkout and every run on that drive. Full runs left
//     ~44,000 agent outcomes and ~9,900 checkpoints in it, and "resolves agent routing through the
//     dashboard API" read those outcomes back as a researcher with a record of successes: it passed
//     alone and failed in full runs;
//   - in the gateway container it is the deployment's real workspace.
//
// So the default workspace looks to every test the way it looks on a CI runner, on every machine: a
// filesystem call on a path inside it (sync, callback, promise or stream, either path of a copy, link
// or rename) does not reach the disk. A read finds nothing (ENOENT; existsSync answers false), a write
// is refused (EACCES for a mkdir, ENOENT for any other), and a child process is not started there.
// That alone would let a test pass that writes its state into the void, since the code under test
// often swallows the error (the outcomes ledger and the other best-effort writers catch and log). So
// the guard also fails the test that made the call, in its afterEach, naming each call, path and
// caller. A test that needs a workspace gives its config, and any tool context or session, a temp dir.
//
// It stands down when the checkout itself lies inside /workspace (a container that mounts the
// repository there): the default workspace is then this checkout, which the suite works in anyway.
// A test that exercises the compose layout's paths on purpose mocks node:fs for them, as
// sandbox-isolation.test.ts and workspace-path.test.ts do.
const WORKSPACE_GUARD = Symbol.for("starlingai.test.workspaceGuard");

interface WorkspaceGuard {
  /** The guarded directory: the schema default `/workspace`, resolved the way the stores resolve it. */
  readonly root: string;
  /** Whether it is guarded (not when this checkout lies inside it). */
  readonly active: boolean;
  /** The calls that reached it since the last check: "<call> <path>", and the caller's frame below. */
  readonly touches: string[];
}

type PathCallForm = "callback" | "sync" | "promise";

/** The fs functions that take a path, with the indexes of their path arguments. Each is guarded in
 *  its callback (fs.x), Sync (fs.xSync) and promise (fs.promises.x) form, where Node has the form. */
const FS_PATH_ARGUMENTS: Record<string, number[]> = {
  access: [0], appendFile: [0], chmod: [0], chown: [0], copyFile: [0, 1], cp: [0, 1], exists: [0],
  lchown: [0], link: [0, 1], lstat: [0], lutimes: [0], mkdir: [0], mkdtemp: [0], open: [0],
  opendir: [0], readdir: [0], readFile: [0], readlink: [0], realpath: [0], rename: [0, 1], rm: [0],
  rmdir: [0], stat: [0], statfs: [0], symlink: [1], truncate: [0], unlink: [0], utimes: [0],
  writeFile: [0],
};
/** The ones with only one form. */
const FS_SINGLE_FORM: Record<string, PathCallForm> = {
  createReadStream: "sync", createWriteStream: "sync", watch: "sync", watchFile: "sync", openAsBlob: "promise",
};
const CHILD_PROCESS_STARTS = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"];

function installWorkspaceGuard(): WorkspaceGuard {
  const root = resolve("/workspace");
  const foldCase = process.platform === "win32" || process.platform === "darwin";
  const comparable = (path: string): string => (foldCase ? path.toLowerCase() : path);
  const under = (path: string, rootPath: string): boolean => {
    const [key, rootKey] = [comparable(path), comparable(rootPath)];
    return key === rootKey || key.startsWith(rootKey + sep);
  };
  // On Windows "/workspace" follows the cwd's drive, and a test may change drives (auth.test.ts
  // changes into a temp dir on the system drive), so the cwd's own is guarded as well.
  const inside = (path: string): boolean => under(path, root) || under(path, resolve("/workspace"));
  const touches: string[] = [];
  if (under(process.cwd(), root)) return { root, active: false, touches };

  /** The default-workspace path an argument names, or null. */
  const guardedPath = (value: unknown): string | null => {
    let path: string;
    try {
      if (typeof value === "string") path = value;
      else if (value instanceof URL) path = value.protocol === "file:" ? fileURLToPath(value) : "";
      else if (value instanceof Uint8Array) path = Buffer.from(value).toString();
      else return null;
    } catch {
      return null;
    }
    // Cheap first: nearly every call the suite makes names no "workspace" at all.
    if (!/workspace/i.test(path)) return null;
    const full = resolve(path);
    return inside(full) ? full : null;
  };
  const record = (call: string, path: string): void => {
    const caller = new Error().stack?.split("\n").slice(1)
      .find((line) => /^\s*at /.test(line) && !line.includes("vitest.setup") && !line.includes("(node:"))?.trim();
    touches.push(caller ? `${call} ${path}\n      ${caller}` : `${call} ${path}`);
  };
  const refusal = (code: "ENOENT" | "EACCES", syscall: string, path: string): NodeJS.ErrnoException =>
    Object.assign(
      new Error(`${code}: ${syscall} '${path}': the default workspace, kept from tests by the workspace guard in src/tests/vitest.setup.ts (give the test's config a temp workspacePath)`),
      { code, syscall, path },
    );
  /** What the call does instead: what it would do on a runner with no /workspace. */
  const refuse = (base: string, form: PathCallForm, args: unknown[], path: string): unknown => {
    const last = args[args.length - 1];
    const callback = form === "callback" && typeof last === "function" ? last as (...result: unknown[]) => void : undefined;
    if (base === "exists") {
      if (callback) process.nextTick(callback, false);
      return form === "sync" ? false : form === "promise" ? Promise.resolve(false) : undefined;
    }
    const forced = base === "rm" && (args[1] as { force?: unknown } | null | undefined)?.force === true;
    const error = forced ? null : refusal(base === "mkdir" || base === "mkdtemp" ? "EACCES" : "ENOENT", base, path);
    if (form === "promise") return error ? Promise.reject(error) : Promise.resolve();
    if (callback) {
      process.nextTick(callback, error);
      return undefined;
    }
    if (error) throw error;
    return undefined;
  };
  type Owner = Record<string | symbol, unknown>;
  const guardFs = (owner: Owner, name: string | symbol, base: string, form: PathCallForm, indexes: number[], label: string): void => {
    const original = owner[name];
    if (typeof original !== "function") return;
    const guarded = function guardedFsCall(this: unknown, ...args: unknown[]): unknown {
      let path: string | null = null;
      for (const index of indexes) if ((path = guardedPath(args[index])) !== null) break;
      if (path === null) return Reflect.apply(original, this, args);
      record(label, path);
      return refuse(base, form, args, path);
    } as unknown as Owner;
    // realpath.native and exists' own promisified form hang off the function; a promisified form
    // names itself as its own (promisify() of it returns it).
    const hanging = original as unknown as Owner;
    if (typeof hanging["native"] === "function") {
      guarded["native"] = hanging["native"];
      guardFs(guarded, "native", base, form, indexes, `${label}.native`);
    }
    if (hanging[promisify.custom] === original) {
      guarded[promisify.custom] = guarded;
    } else if (typeof hanging[promisify.custom] === "function") {
      guarded[promisify.custom] = hanging[promisify.custom];
      guardFs(guarded, promisify.custom, base, "promise", indexes, `${label} (promisified)`);
    }
    owner[name] = guarded;
  };

  const fsModule = fs as unknown as Owner;
  const fsPromises = fs.promises as unknown as Owner;
  for (const [name, indexes] of Object.entries(FS_PATH_ARGUMENTS)) {
    guardFs(fsModule, name, name, "callback", indexes, `fs.${name}`);
    guardFs(fsModule, `${name}Sync`, name, "sync", indexes, `fs.${name}Sync`);
    guardFs(fsPromises, name, name, "promise", indexes, `fs.promises.${name}`);
  }
  for (const [name, form] of Object.entries(FS_SINGLE_FORM)) guardFs(fsModule, name, name, form, [0], `fs.${name}`);
  guardFs(fsPromises, "watch", "watch", "sync", [0], "fs.promises.watch");

  /** The default-workspace cwd of a process start, in whichever argument carries the options. */
  const guardedCwd = (args: unknown[]): string | null => {
    const options = args.find((arg) => arg !== null && typeof arg === "object" && !Array.isArray(arg) && "cwd" in arg);
    return options ? guardedPath((options as { cwd?: unknown }).cwd) : null;
  };
  const childProcessModule = childProcess as unknown as Owner;
  for (const name of CHILD_PROCESS_STARTS) {
    const original = childProcessModule[name];
    if (typeof original !== "function") continue;
    const wrap = (start: (...args: unknown[]) => unknown, promised: boolean) =>
      function guardedStart(this: unknown, ...args: unknown[]): unknown {
        const cwd = guardedCwd(args);
        if (cwd === null) return Reflect.apply(start, this, args);
        record(`child_process.${name} (cwd)`, cwd);
        const error = refusal("ENOENT", `spawn ${name}`, cwd);
        if (promised) return Promise.reject(error);
        throw error;
      };
    const guarded = wrap(original as (...args: unknown[]) => unknown, false) as unknown as Owner;
    // exec and execFile carry their own promisified form, which promisify() hands out instead.
    const custom = (original as unknown as Owner)[promisify.custom];
    if (typeof custom === "function") guarded[promisify.custom] = wrap(custom as (...args: unknown[]) => unknown, true);
    childProcessModule[name] = guarded;
  }
  // `import { readFileSync } from "node:fs"` reads the ESM facade, which keeps its own copies.
  syncBuiltinESMExports();
  return { root, active: true, touches };
}

const guardHolder = globalThis as typeof globalThis & { [WORKSPACE_GUARD]?: WorkspaceGuard };
const workspaceGuard = guardHolder[WORKSPACE_GUARD] ??= installWorkspaceGuard();

/** Fails `who` for every call that reached the default workspace since the last check. */
function failOnWorkspaceTouches(who: string): void {
  if (workspaceGuard.touches.length === 0) return;
  const touches = [...new Set(workspaceGuard.touches.splice(0))];
  throw new Error([
    `${who} reached the default workspace ${workspaceGuard.root}, which the workspace guard (src/tests/vitest.setup.ts) keeps every test out of:`,
    ...touches.map((touch) => `  - ${touch}`),
    "Give the test's config a temp workspacePath, and hand its tool contexts and sessions that directory too.",
  ].join("\n"));
}

beforeEach(() => failOnWorkspaceTouches("Code that ran before this test (an import, a beforeAll hook, or work an earlier test left running)"));
afterEach(() => failOnWorkspaceTouches("This test (or its beforeEach/afterEach hooks)"));
afterAll(() => failOnWorkspaceTouches("Code that ran after the file's last test (an afterAll hook, or work a test left running)"));
