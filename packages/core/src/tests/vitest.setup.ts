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
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";

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
