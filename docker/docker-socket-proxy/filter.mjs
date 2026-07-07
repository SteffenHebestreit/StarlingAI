/**
 * Pure request-filtering logic for the docker-socket proxy (no I/O — unit-tested).
 * server.mjs wires these into the HTTP server + hijack tunnel.
 */
import { isAllowedBindSource } from "./bind-policy.mjs";

/** Strip the /v1.NN API-version prefix and canonicalize the path for routing. */
export function normalizeApiPath(rawPath) {
  let p = String(rawPath || "/").split("?")[0];
  p = p.replace(/^\/v\d+\.\d+/, "");
  const parts = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { parts.pop(); continue; }
    parts.push(seg);
  }
  return "/" + parts.join("/");
}

const ID = "[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}";
const EXECID = "[0-9a-fA-F]{64}";

// Hop-by-hop headers + framing headers we always regenerate; never relayed verbatim.
const STRIP_REQUEST_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authorization", "proxy-connection",
  "te", "trailer", "transfer-encoding", "upgrade", "content-length",
]);

/** Parse an HTTP/1.1 request head (the text before the blank line) into
 *  { method, rawPath, headers:[[name,value],…] }. Header names keep original case;
 *  callers compare case-insensitively via headerValue(). */
export function parseRequestHead(headText) {
  const lines = String(headText).split("\r\n");
  const start = (lines[0] || "").split(" ");
  const method = (start[0] || "GET").toUpperCase();
  const rawPath = start[1] || "/";
  const headers = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const ci = line.indexOf(":");
    if (ci === -1) continue;
    headers.push([line.slice(0, ci).trim(), line.slice(ci + 1).trim()]);
  }
  return { method, rawPath, headers };
}

/** Case-insensitive header lookup over the [[name,value]] list. */
export function headerValue(headers, name) {
  const n = name.toLowerCase();
  for (const [k, v] of headers) if (k.toLowerCase() === n) return v;
  return undefined;
}

/**
 * Rebuild a canonical request head for a NON-hijack request forwarded to the
 * daemon: strips hop-by-hop/framing headers, forces `Connection: close` (one
 * request per connection so every request is inspected — no keep-alive pipelining
 * past the proxy), and sets Content-Length/Content-Type when a body is attached.
 * Hijack requests (attach/exec-start) are NOT rebuilt — their original head is
 * replayed verbatim so the daemon still sees Connection: Upgrade / Upgrade: tcp.
 */
export function buildRequestHead(method, rawPath, headers, { contentLength = null, contentType = null } = {}) {
  const out = [`${method} ${rawPath} HTTP/1.1`];
  for (const [k, v] of headers) {
    const lk = k.toLowerCase();
    if (STRIP_REQUEST_HEADERS.has(lk)) continue;
    if (contentType != null && lk === "content-type") continue;
    out.push(`${k}: ${v}`);
  }
  out.push("Connection: close");
  if (contentType != null) out.push(`Content-Type: ${contentType}`);
  if (contentLength != null) out.push(`Content-Length: ${contentLength}`);
  return out.join("\r\n") + "\r\n\r\n";
}

const PASS_ROUTES = [
  ["HEAD", /^\/_ping$/], ["GET", /^\/_ping$/],
  ["GET", /^\/version$/],
  ["GET", /^\/containers\/json$/],
  ["GET", new RegExp(`^/containers/${ID}/json$`)],
  ["GET", new RegExp(`^/containers/${ID}/logs$`)],
  ["GET", new RegExp(`^/exec/${EXECID}/json$`)],
  ["GET", new RegExp(`^/images/${ID}/json$`)],
  ["GET", /^\/images\/json$/],
  ["POST", new RegExp(`^/containers/${ID}/start$`)],
  ["POST", new RegExp(`^/containers/${ID}/wait$`)],
  ["POST", new RegExp(`^/containers/${ID}/stop$`)],
  ["POST", new RegExp(`^/containers/${ID}/kill$`)],
  ["POST", new RegExp(`^/containers/${ID}/resize$`)],
  ["POST", new RegExp(`^/exec/${EXECID}/resize$`)],
  ["DELETE", new RegExp(`^/containers/${ID}$`)],
];

export const isPassRoute = (method, p) => PASS_ROUTES.some(([m, re]) => m === method && re.test(p));
export const isCreateRoute = (method, p) => method === "POST" && /^\/containers\/create$/.test(p);
export const isExecCreateRoute = (method, p) => method === "POST" && new RegExp(`^/containers/${ID}/exec$`).test(p);
export const isImagePullRoute = (method, p) => method === "POST" && /^\/images\/create$/.test(p);
export const isAttachRoute = (method, p) => method === "POST" && new RegExp(`^/containers/${ID}/attach$`).test(p);
export const isExecStartRoute = (method, p) => method === "POST" && new RegExp(`^/exec/${EXECID}/start$`).test(p);

/** A host/container/ns namespace value that would share the host's namespace or
 *  join another container's — the escape shape for Pid/Ipc/Uts/Userns/Cgroup/Network modes. */
const HOST_NS_VALUE = (v) => /^host$/i.test(v) || /^container:/i.test(v) || /^ns:/i.test(v);

/** Split a `SRC:DST[:OPTS]` bind string into {src, opts}, correctly handling
 *  Windows drive-letter sources/targets whose colon is NOT a field separator
 *  (`C:\foo:/dst:ro`). A naive split(":") would take "C" as the source and let
 *  `C:\Windows` or `F:\...\.env` slip through as a harmless "volume name". */
export function splitBindEntry(b) {
  const s = String(b);
  const takePath = (str) => {
    const drive = /^([A-Za-z]:[\\/][^:]*)(?::([\s\S]*))?$/.exec(str);
    if (drive) return [drive[1], drive[2] ?? ""];
    const i = str.indexOf(":");
    return i < 0 ? [str, ""] : [str.slice(0, i), str.slice(i + 1)];
  };
  const [src, afterSrc] = takePath(s);
  const [, opts] = takePath(afterSrc); // afterSrc = DST[:OPTS]; drop DST, keep OPTS
  return { src, opts };
}

/** Fold an object's own keys to a lowercase-keyed map (last-write-wins, mirroring
 *  Go's case-insensitive JSON). Non-objects → null. */
export function foldKeys(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const out = {};
  for (const k of Object.keys(obj)) out[k.toLowerCase()] = obj[k];
  return out;
}

/**
 * Validate + rebuild a canonical HostConfig; throws a refusal reason.
 *
 * Model: DENY-LIST the enumerable container-escape vectors (validating by the
 * dangerous VALUE, not mere presence, so the many benign default fields the
 * docker CLI/SDK always send — ContainerIDFile, ShmSize, Ulimits, empty Devices,
 * … — pass untouched), and PASS every other field through. A default-deny-unknown-
 * key model is stronger in principle but breaks every real `docker run` (the CLI
 * populates dozens of benign HostConfig defaults and each Docker release adds
 * more). The parser-differential protection is preserved by rebuilding the config
 * from the case-FOLDED map (one lowercase key per field, last-write-wins, exactly
 * as Go unmarshals) so the daemon parses precisely the values we validated.
 * CapDrop:["ALL"] is force-injected.
 */
export function sanitizeHostConfig(hcRaw, allowedBindPrefixes) {
  const hc = foldKeys(hcRaw);
  if (hc === null) throw new Error("HostConfig is not an object");
  const clean = {};
  for (const lk of Object.keys(hc)) {
    const val = hc[lk];
    switch (lk) {
      case "privileged":
        if (val === true) throw new Error("Privileged is not permitted");
        break;
      case "binds": {
        if (val != null) {
          if (!Array.isArray(val)) throw new Error("Binds must be an array");
          for (const b of val) {
            const { src, opts } = splitBindEntry(b);
            if (/(^|,)r?shared(,|$)/.test(opts)) throw new Error(`Binds propagation shared: ${b}`);
            if (!isAllowedBindSource(src, allowedBindPrefixes)) throw new Error(`Binds source not allowed: ${src}`);
          }
        }
        break;
      }
      case "mounts": {
        if (val != null) {
          if (!Array.isArray(val)) throw new Error("Mounts must be an array");
          for (const mRaw of val) {
            const m = foldKeys(mRaw);
            if (!m) throw new Error("Mount entry not an object");
            const type = String(m.type ?? "bind").toLowerCase();
            if (!["bind", "volume", "tmpfs"].includes(type)) throw new Error(`Mount type not allowed: ${type}`);
            if (type === "bind") {
              if (!isAllowedBindSource(m.source, allowedBindPrefixes)) throw new Error(`Mount bind source not allowed: ${m.source}`);
              const bo = foldKeys(m.bindoptions);
              if (bo && /r?shared/i.test(String(bo.propagation ?? ""))) throw new Error("Mount propagation shared");
            }
            if (type === "volume") {
              const vo = foldKeys(m.volumeoptions);
              const dc = vo && foldKeys(vo.driverconfig);
              if (dc) {
                const optStr = JSON.stringify(foldKeys(dc.options) ?? {}).toLowerCase();
                if (/"o":"[^"]*bind|"device"|"type":"none"/.test(optStr)) throw new Error("Mount volume is a disguised host bind");
              }
            }
          }
        }
        break;
      }
      case "networkmode": {
        if (HOST_NS_VALUE(String(val ?? ""))) throw new Error(`NetworkMode not allowed: ${val}`);
        break;
      }
      case "pidmode": case "ipcmode": case "utsmode": case "usernsmode": case "cgroupnsmode": {
        if (HOST_NS_VALUE(String(val ?? ""))) throw new Error(`HostConfig.${lk} not allowed: ${val}`);
        break;
      }
      case "capadd":
        // The gateway runs every container cap-drop ALL and never adds a capability,
        // so reject ANY non-empty CapAdd outright. This is naming-agnostic — it can't
        // be bypassed by the `CAP_` prefix the CLI/daemon may add (CAP_SYS_ADMIN) or
        // by a capability missing from a denylist. Empty/absent CapAdd is fine.
        if (Array.isArray(val) ? val.length > 0 : val != null) throw new Error("CapAdd is not permitted (containers run cap-drop ALL)");
        break;
      case "capabilities": // v1.40+ full-capability set — bypasses CapAdd/CapDrop entirely.
        if (val != null) throw new Error("HostConfig.capabilities (full-set override) is not permitted");
        break;
      case "securityopt": {
        if (Array.isArray(val)) { for (const o of val) if (!/^no-new-privileges(:true)?$/.test(String(o).toLowerCase())) throw new Error(`SecurityOpt not allowed: ${o}`); }
        else if (val != null) throw new Error("SecurityOpt must be an array");
        break;
      }
      case "cgroupparent":
        if (val != null && String(val).trim() !== "") throw new Error("HostConfig.cgroupparent is not permitted");
        break;
      case "devices": case "devicecgrouprules": case "devicerequests":
        if (Array.isArray(val) && val.length > 0) throw new Error(`HostConfig.${lk} is not permitted`);
        break;
      case "sysctls":
        if (val != null && typeof val === "object" && Object.keys(val).length > 0) throw new Error("HostConfig.sysctls is not permitted");
        break;
      case "maskedpaths": case "readonlypaths": // present ⇒ an override that can UNMASK /proc protections.
        if (val != null) throw new Error(`HostConfig.${lk} override is not permitted`);
        break;
      case "runtime": {
        const r = String(val ?? "").trim().toLowerCase();
        if (r && r !== "runc") throw new Error(`HostConfig.runtime not allowed: ${val}`);
        break;
      }
      default: break; // benign field — pass through unchanged
    }
    clean[lk] = val;
  }
  if (!Array.isArray(clean.capdrop) || !clean.capdrop.some((c) => String(c).toLowerCase() === "all")) clean.capdrop = ["ALL"];
  return clean;
}

const TOP_CANON = new Map([
  "Hostname", "Domainname", "User", "AttachStdin", "AttachStdout", "AttachStderr",
  "Tty", "OpenStdin", "StdinOnce", "Env", "Cmd", "Entrypoint", "Image", "Labels",
  "Volumes", "WorkingDir", "ExposedPorts", "StopSignal", "StopTimeout", "Healthcheck",
  "MacAddress", "Shell", "ArgsEscaped", "OnBuild", "NetworkDisabled",
].map((k) => [k.toLowerCase(), k]));

/** Validate a full create body; returns the canonical body to forward. Throws a refusal reason. */
export function sanitizeCreateBody(bodyObj, allowedBindPrefixes) {
  if (!bodyObj || typeof bodyObj !== "object") throw new Error("create body not an object");
  const top = foldKeys(bodyObj);
  const out = {};
  for (const lk of Object.keys(top)) {
    if (lk === "hostconfig" || lk === "networkingconfig") continue;
    out[TOP_CANON.get(lk) || lk] = top[lk];
  }
  const hc = top.hostconfig != null ? sanitizeHostConfig(top.hostconfig, allowedBindPrefixes) : {};
  // sanitizeHostConfig force-injects capdrop; ensure it too when HostConfig was absent.
  if (!Array.isArray(hc.capdrop) || !hc.capdrop.some((c) => String(c).toLowerCase() === "all")) hc.capdrop = ["ALL"];
  out.HostConfig = hc;
  if (top.networkingconfig != null) {
    const eps = foldKeys(foldKeys(top.networkingconfig)?.endpointsconfig);
    if (eps) for (const name of Object.keys(eps)) if (/^host$/i.test(name) || /^container:/i.test(name)) throw new Error(`Endpoint network not allowed: ${name}`);
    out.NetworkingConfig = top.networkingconfig;
  }
  return out;
}

/** Validate an exec-create (ExecConfig) body: reject Privileged / root User override. */
export function sanitizeExecBody(bodyObj) {
  const b = foldKeys(bodyObj);
  if (!b) throw new Error("exec body not an object");
  if (b.privileged === true) throw new Error("exec Privileged not allowed");
  if (b.user != null && String(b.user).trim() !== "") throw new Error("exec User override not allowed");
  return bodyObj;
}
