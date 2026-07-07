/**
 * Filtering docker-socket proxy — the ONLY container that touches
 * /var/run/docker.sock. The gateway talks to it over TCP
 * (DOCKER_HOST=tcp://docker-socket-proxy:2375). It default-DENIES every Engine
 * API endpoint except a minimal allow-list, INSPECTS /containers/create +
 * /exec bodies and refuses escape-shaped containers (host/socket/secret binds,
 * --privileged, host namespaces, dangerous caps, unconfined profiles), forwards
 * its OWN re-serialized canonical body (so JSON case/duplicate-key tricks fail
 * closed), and transparently splices the attach/exec-start HIJACK streams. Fails
 * CLOSED everywhere. No auth — reachability is the control (internal-only
 * network, never published).
 *
 * I/O runs at the RAW net layer (not http.Server): each connection carries exactly
 * ONE request — we read its head, route/inspect it, then splice the socket to the
 * daemon. `Connection: close` on every forwarded (non-hijack) request means the
 * daemon terminates each response, so we never relay a second, un-inspected request
 * over a kept-alive connection. Doing this at the byte layer also handles the
 * daemon's `101 UPGRADED` hijack identically to a normal response — no http.Server
 * 'upgrade' machinery, which does not interoperate with the docker CLI's Go hijack
 * client through a proxy. Pure security logic lives in filter.mjs (unit-tested).
 */
import net from "node:net";
import { parseAllowedPrefixes } from "./bind-policy.mjs";
import {
  normalizeApiPath, isPassRoute, isCreateRoute, isExecCreateRoute, isImagePullRoute,
  isAttachRoute, isExecStartRoute, sanitizeCreateBody, sanitizeExecBody,
  parseRequestHead, headerValue, buildRequestHead,
} from "./filter.mjs";

const SOCKET_PATH = process.env.DOCKER_SOCKET_PATH || "/var/run/docker.sock";
const LISTEN_PORT = Number(process.env.PROXY_PORT || 2375);
const MAX_BODY = 256 * 1024;
const MAX_HEAD = 64 * 1024;
const ALLOWED_BIND_PREFIXES = parseAllowedPrefixes(process.env.SAI_WORKSPACE_MOUNT_SOURCE, process.env.SAI_PROXY_ALLOWED_BIND_SOURCES);

const log = (o) => { try { process.stdout.write(JSON.stringify({ t: "docker-proxy", ...o }) + "\n"); } catch { /* ignore */ } };
const HEAD_SEP = Buffer.from("\r\n\r\n");

function deny(client, code, reason, method, path) {
  log({ decision: "DENY", method, path, reason, code });
  const body = JSON.stringify({ message: `docker-socket-proxy refused: ${reason}` });
  try {
    client.write(`HTTP/1.1 ${code} Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    client.end();
  } catch { try { client.destroy(); } catch { /* ignore */ } }
}

/**
 * Open a daemon connection, write the initial bytes (request head [+ body / raw
 * head]), then splice. `bidirectional` is true only for hijacks (container stdio /
 * exec stream); for normal requests the request is already fully forwarded, so we
 * relay ONLY daemon→client and never client→daemon (prevents a pipelined,
 * un-inspected second request from reaching the daemon).
 */
function toDaemon(client, initialWrites, bidirectional) {
  const daemon = net.connect({ path: SOCKET_PATH, allowHalfOpen: true });
  const kill = () => { try { client.destroy(); } catch { /* ignore */ } try { daemon.destroy(); } catch { /* ignore */ } };
  daemon.on("error", kill);
  client.on("error", kill);
  daemon.on("connect", () => {
    for (const w of initialWrites) if (w && w.length) daemon.write(w);
    daemon.pipe(client);
    daemon.on("end", () => { try { client.end(); } catch { /* ignore */ } });
    if (bidirectional) {
      client.pipe(daemon);
      client.on("end", () => { try { daemon.end(); } catch { /* ignore */ } });
    }
  });
}

function handleRequest(client, method, rawPath, headers, rawHead, rest) {
  const p = normalizeApiPath(rawPath);

  // Hijack streams: replay the ORIGINAL head verbatim (keeps Connection: Upgrade /
  // Upgrade: tcp) and splice both directions raw.
  if (isAttachRoute(method, p) || isExecStartRoute(method, p)) {
    log({ decision: "TUNNEL", method, path: p });
    return toDaemon(client, [rawHead, rest], true);
  }

  // create / exec-create: buffer the (bounded) JSON body, inspect + rebuild canonical.
  if (isCreateRoute(method, p) || isExecCreateRoute(method, p)) {
    const cl = Number(headerValue(headers, "content-length") || 0);
    if (cl > MAX_BODY) return deny(client, 413, "create/exec body too large", method, p);
    let body = Buffer.from(rest);
    const finish = () => {
      let obj;
      try { obj = JSON.parse(body.toString("utf8") || "{}"); }
      catch { return deny(client, 400, "create/exec body is not valid JSON", method, p); }
      let canonical;
      try { canonical = isCreateRoute(method, p) ? sanitizeCreateBody(obj, ALLOWED_BIND_PREFIXES) : sanitizeExecBody(obj); }
      catch (err) { return deny(client, 403, err instanceof Error ? err.message : String(err), method, p); }
      const outBody = Buffer.from(JSON.stringify(canonical), "utf8");
      const head = buildRequestHead(method, rawPath, headers, { contentLength: outBody.length, contentType: "application/json" });
      log({ decision: "ALLOW", method, path: p });
      toDaemon(client, [Buffer.from(head, "latin1"), outBody], false);
    };
    if (body.length >= cl) return finish();
    const onBody = (c) => {
      body = Buffer.concat([body, c]);
      if (body.length > MAX_BODY) { client.removeListener("data", onBody); return deny(client, 413, "create/exec body too large", method, p); }
      if (body.length >= cl) { client.removeListener("data", onBody); finish(); }
    };
    client.on("data", onBody);
    return;
  }

  // image pull: allow a registry pull (fromImage) but never a tarball import (fromSrc).
  if (isImagePullRoute(method, p)) {
    const q = rawPath.split("?")[1] || "";
    if (/(^|&)fromSrc=/i.test(q)) return deny(client, 403, "image import (fromSrc) not allowed", method, p);
    if (!/(^|&)fromImage=/i.test(q)) return deny(client, 403, "images/create requires fromImage (pull only)", method, p);
    log({ decision: "ALLOW", method, path: p });
    return toDaemon(client, [Buffer.from(buildRequestHead(method, rawPath, headers), "latin1"), rest], false);
  }

  if (isPassRoute(method, p)) {
    log({ decision: "PASS", method, path: p });
    return toDaemon(client, [Buffer.from(buildRequestHead(method, rawPath, headers), "latin1"), rest], false);
  }

  return deny(client, 403, "endpoint not on allow-list", method, p);
}

const server = net.createServer((client) => {
  client.setNoDelay(true);
  let buf = Buffer.alloc(0);
  let routed = false;
  const onHead = (chunk) => {
    if (routed) return;
    buf = Buffer.concat([buf, chunk]);
    const idx = buf.indexOf(HEAD_SEP);
    if (idx === -1) {
      if (buf.length > MAX_HEAD) { routed = true; client.removeListener("data", onHead); deny(client, 431, "request head too large", "?", "?"); }
      return;
    }
    routed = true;
    client.removeListener("data", onHead);
    const rawHead = buf.slice(0, idx + HEAD_SEP.length);
    const rest = buf.slice(idx + HEAD_SEP.length);
    let parsed;
    try { parsed = parseRequestHead(buf.slice(0, idx).toString("latin1")); }
    catch { return deny(client, 400, "malformed request head", "?", "?"); }
    handleRequest(client, parsed.method, parsed.rawPath, parsed.headers, rawHead, rest);
  };
  client.on("data", onHead);
  client.on("error", () => { try { client.destroy(); } catch { /* ignore */ } });
});

server.on("error", (err) => { log({ event: "server-error", message: err.message }); });
server.listen(LISTEN_PORT, "0.0.0.0", () => log({ event: "listening", port: LISTEN_PORT, socket: SOCKET_PATH, allowedBindPrefixes: ALLOWED_BIND_PREFIXES }));
