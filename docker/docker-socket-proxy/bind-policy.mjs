/**
 * Bind-source policy for the filtering docker-socket proxy.
 *
 * The daemon receives host bind mounts as `HostConfig.Binds` ("src:dst[:opts]")
 * or `HostConfig.Mounts` ([{Type:"bind",Source,...}]). A compromised gateway that
 * could bind the docker socket, host root, /etc, a secret file, or an SSH/cloud
 * credential dir would own the host. Policy: a HOST-PATH bind source is allowed
 * ONLY when it sits under an explicitly-configured workspace prefix (default
 * allow-list, fail closed) AND does not match a sensitive pattern (defense in
 * depth for secret files that may live under the workspace). A non-path source
 * (a named/anonymous volume) is allowed — attacker-minted local-bind volumes are
 * blocked separately by denying POST /volumes/create.
 *
 * Mirrors packages/core/src/tools/docker-safety.ts isSensitiveMountSource; kept in
 * parity by a unit test.
 */

/** Normalize a path for comparison: backslashes→slashes, collapse //, resolve
 *  . and .. segments, strip trailing slash, lowercase. Windows drive letters
 *  ("F:\x") become "f:/x". */
export function normPath(p) {
  const raw = String(p ?? "").trim().replace(/\\/g, "/");
  const parts = [];
  for (const seg of raw.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { parts.push(seg); continue; } // keep .. so an escaping source can't be normalized to look safe
    parts.push(seg);
  }
  const leading = raw.startsWith("/") ? "/" : "";
  return (leading + parts.join("/")).replace(/\/+$/, "").toLowerCase() || (leading || "");
}

// Secret files/dirs that must never be bound, even if they sit under the
// workspace prefix. Matched against the normalized source.
const SENSITIVE_PATTERNS = [
  /docker\.sock/,
  /(^|\/)\.env(\.|$)/,
  /(^|\/)\.starlingai(\/|$)/,
  /credential/,
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.aws(\/|$)/,
  /(^|\/)\.kube(\/|$)/,
  /(^|\/)\.docker(\/|$)/,
  /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.|$)/,
];

/** Absolute host path? (POSIX "/x" or Windows "C:\x" / "c:/x") */
export function isHostPath(src) {
  const s = String(src ?? "").trim();
  return s.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(s);
}

/**
 * Decide whether a bind SOURCE is allowed. `allowedPrefixes` is the caller's
 * configured workspace roots (raw strings; normalized here).
 */
export function isAllowedBindSource(src, allowedPrefixes) {
  const s = String(src ?? "").trim();
  if (!s) return false;                          // empty → deny
  if (!isHostPath(s)) return true;               // named/anonymous volume → allowed (volume-create is denied)
  const n = normPath(s);
  if (n.includes("..")) return false;            // any traversal → deny
  for (const re of SENSITIVE_PATTERNS) if (re.test(n)) return false; // secret path → deny even under workspace
  // Must sit under an allowed workspace prefix (fail closed otherwise).
  for (const prefixRaw of allowedPrefixes) {
    const p = normPath(prefixRaw);
    if (!p) continue;
    if (n === p || n.startsWith(p + "/")) return true;
  }
  return false;
}

/**
 * For a configured workspace prefix, also emit the form the Docker daemon may
 * actually receive. On Docker Desktop (Windows/WSL2) a Windows host path
 * `X:\dir` is presented to the Linux daemon as `/run/desktop/mnt/host/x/dir`
 * (mirrors scripts/sai.mjs resolveWorkspaceMount). Emitting both variants means
 * the allow-list matches regardless of which form the gateway's docker CLI put
 * in the create body — without a fragile manual socket tap. Both variants point
 * at the SAME workspace, so this widens nothing outside it. */
export function deriveWorkspacePrefixVariants(prefix) {
  const p = String(prefix ?? "").trim();
  if (!p) return [];
  const out = [p];
  const win = /^([a-zA-Z]):[\\/](.*)$/.exec(p);
  if (win) out.push(`/run/desktop/mnt/host/${win[1].toLowerCase()}/${win[2].replace(/\\/g, "/")}`);
  return out;
}

/** Parse the comma/newline-separated allow-prefix env into a clean list,
 *  expanding each entry to its daemon-path variants. */
export function parseAllowedPrefixes(...envValues) {
  const out = [];
  for (const v of envValues) {
    if (!v) continue;
    for (const part of String(v).split(/[,\n]/)) {
      const t = part.trim();
      if (t) for (const variant of deriveWorkspacePrefixVariants(t)) out.push(variant);
    }
  }
  return out;
}
