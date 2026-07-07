/**
 * Output Guardian — Layer 3 of the guardrails system.
 * Scans LLM output for accidentally leaked secrets before sending to user.
 */
import { getGuardrails } from "./store.js";
import { getExtensionGuardrailHooks } from "../extension/index.js";

export interface OutputScanResult {
  safe: boolean;
  redacted?: string;
  detectedTypes?: string[];
}

interface SecretPattern {
  name: string;
  pattern: RegExp;
  redact: boolean; // true = replace with [REDACTED], false = block
}

const SECRET_PATTERNS: SecretPattern[] = [
  // API Keys
  { name: "openai_key", pattern: /sk-[A-Za-z0-9]{20,}/g, redact: true },
  { name: "anthropic_key", pattern: /sk-ant-[A-Za-z0-9-_]{20,}/g, redact: true },
  { name: "github_token", pattern: /ghp_[A-Za-z0-9]{36}/g, redact: true },
  { name: "github_app_token", pattern: /ghs_[A-Za-z0-9]{36}/g, redact: true },
  { name: "aws_key", pattern: /AKIA[A-Z0-9]{16}/g, redact: true },
  { name: "google_api", pattern: /AIza[0-9A-Za-z-_]{35}/g, redact: true },
  { name: "telegram_token", pattern: /\d{8,12}:[A-Za-z0-9_-]{35}/g, redact: true },
  { name: "jwt_token", pattern: /eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_.+/]*/g, redact: true },
  // Passwords in common formats
  { name: "password_kv", pattern: /(password|passwd|pwd|secret|api[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]{8,}["']?/gi, redact: true },
  // Private keys
  { name: "pem_private", pattern: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, redact: true },
  // Connection strings
  { name: "connection_string", pattern: /(postgres|postgresql|mysql|mongodb|redis):\/\/[^:]+:[^@]+@[^\s"']+/gi, redact: true },
  // Generic high-entropy strings (likely tokens)
  { name: "high_entropy_token", pattern: /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, redact: false }, // Don't auto-redact — too many false positives
];

// ── Known-value redaction ──────────────────────────────────────────────────
// The shape patterns above catch secrets by FORMAT, but many of our own secrets
// have no recognizable format — the JWT signing secret, SAI_MASTER_KEY, an SSH/RDP
// password, a provider key that isn't sk-*, an engram/searxng token. If an agent
// (sandboxed or in-process) ever obtains one — by reading a mounted .env, hitting
// an env-echoing endpoint, or a tool that surfaces config — it must never survive
// into history, the user reply, or logs. So we ALSO redact the literal VALUES of
// the process's own secret env vars. Exact-match against real secret values has
// effectively zero false-positive risk, so this runs unconditionally (even when
// the format scan is config-disabled): leaking our own credentials is never OK.

// Env-var NAMES whose value is a secret worth redacting. Value must also clear a
// minimum length so short/non-secret config (ports, "true", model ids) is untouched.
const SECRET_ENV_NAME_RE = /(SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|PRIVATE[_-]?KEY|API[_-]?KEY|APIKEY|ACCESS[_-]?KEY|_KEY$|CREDENTIAL|AUTH)/i;
const MIN_SECRET_VALUE_LEN = 8;
// Values that match a secret-looking env name but are obviously not secrets.
const NON_SECRET_VALUES = new Set(["true", "false", "none", "null", "undefined", "changeme", "disabled", "enabled", "default"]);

let _secretValuesCache: string[] | null = null;

/** Collect the literal secret values from process.env, longest-first so a
 *  substring secret never partially masks a longer one. Memoized — env is fixed
 *  for the process lifetime; call refreshSecretValueCache() if that changes. */
function collectSecretValues(): string[] {
  if (_secretValuesCache) return _secretValuesCache;
  const values = new Set<string>();
  for (const [name, value] of Object.entries(process.env)) {
    if (!value) continue;
    const v = value.trim();
    if (v.length < MIN_SECRET_VALUE_LEN) continue;
    if (NON_SECRET_VALUES.has(v.toLowerCase())) continue;
    if (SECRET_ENV_NAME_RE.test(name)) values.add(v);
  }
  _secretValuesCache = [...values].sort((a, b) => b.length - a.length);
  return _secretValuesCache;
}

/** Reset the memoized secret-value list (e.g. after a credential rotation). */
export function refreshSecretValueCache(): void {
  _secretValuesCache = null;
}

export function scanOutput(output: string): OutputScanResult {
  if (!output) return { safe: true };

  let result = output;
  const detected: string[] = [];

  if (getGuardrails().outputSecretScan) {
    for (const { name, pattern, redact } of SECRET_PATTERNS) {
      if (name === "high_entropy_token") continue; // Too many false positives on base64 data

      const matches = output.match(pattern);
      if (matches && matches.length > 0) {
        detected.push(name);
        if (redact) {
          result = result.replace(pattern, `[REDACTED:${name}]`);
        }
      }
    }
  }

  // Known-value redaction — ALWAYS on (leaking our own secrets is never allowed).
  for (const secret of collectSecretValues()) {
    if (result.includes(secret)) {
      detected.push("env_secret_value");
      result = result.split(secret).join("[REDACTED:secret]");
    }
  }

  // Extension-contributed output guardrails (e.g. a medical fork's PII
  // pseudonymizer) run after the built-in secret scan, each seeing the
  // previous stage's text. They can rewrite via `redacted` and block via
  // `allowed: false`; hook errors fail open. They run even when the built-in
  // secret scan is config-disabled — an extension's compliance redaction must
  // not silently vanish with an unrelated toggle.
  for (const { extension, hooks } of getExtensionGuardrailHooks()) {
    if (!hooks.checkOutput) continue;
    try {
      const hookResult = hooks.checkOutput(result);
      if (typeof hookResult.redacted === "string") {
        if (hookResult.redacted !== result) detected.push(`ext:${extension}`);
        result = hookResult.redacted;
      } else if (!hookResult.allowed) {
        detected.push(`ext:${extension}`);
        result = `[BLOCKED by ${extension} guardrail${hookResult.reason ? `: ${hookResult.reason}` : ""}]`;
      }
    } catch {
      // fail open
    }
  }

  if (detected.length > 0) {
    return {
      safe: false, // raw output is NOT safe — caller must use `redacted`
      redacted: result,
      detectedTypes: detected,
    };
  }

  return { safe: true };
}
