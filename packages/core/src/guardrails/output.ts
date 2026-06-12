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
