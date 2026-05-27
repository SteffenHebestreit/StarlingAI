/**
 * Secret hygiene checks — surface weak or placeholder secrets at boot.
 *
 * The gateway reads sensitive material from process.env (loaded by compose
 * from .env). Misconfigured deployments tend to ship with the example
 * placeholders intact ("your-256-bit-..."), with the empty string, or with
 * something far below minimum entropy. The cred store and JWT signing both
 * fail late and loudly when that happens; surfacing the misconfig at startup
 * is much cheaper to notice. Pure warnings — never refuses to start, so an
 * operator can still boot for local debugging.
 */
import { childLogger } from "../logger.js";

const log = childLogger("secret-hygiene");

// Strings that betray a copy-paste from .env.example (case-insensitive).
// Each pattern must be unambiguous enough that a legitimately-generated random
// secret has effectively zero chance of containing it. Plain "example" was
// dropped because a base64 secret could include the substring by accident.
const PLACEHOLDER_FRAGMENTS = [
  "your-256-bit",
  "change-me",
  "changeme",
  "your-example",
  "example-secret",
  "example-key",
  "placeholder",
  "replace-with",
];

interface SecretSpec {
  envVar: string;
  /** Minimum byte length to clear the "way too short" bar. */
  minLength: number;
  /** Optional follow-up advice. */
  generateHint?: string;
}

const REQUIRED_SECRETS: SecretSpec[] = [
  {
    envVar: "SAI_MASTER_KEY",
    minLength: 32,
    generateHint: "openssl rand -base64 48",
  },
  {
    envVar: "SAI_JWT_SECRET",
    minLength: 32,
    generateHint: "openssl rand -base64 48",
  },
];

export interface SecretHygieneFinding {
  envVar: string;
  severity: "missing" | "short" | "placeholder";
  detail: string;
}

export function inspectSecrets(env: NodeJS.ProcessEnv = process.env): SecretHygieneFinding[] {
  const findings: SecretHygieneFinding[] = [];
  for (const spec of REQUIRED_SECRETS) {
    const value = env[spec.envVar]?.trim() ?? "";
    if (!value) {
      findings.push({
        envVar: spec.envVar,
        severity: "missing",
        detail: `${spec.envVar} is unset or empty${spec.generateHint ? ` — generate one with \`${spec.generateHint}\`` : ""}`,
      });
      continue;
    }
    if (value.length < spec.minLength) {
      findings.push({
        envVar: spec.envVar,
        severity: "short",
        detail: `${spec.envVar} is only ${value.length} chars (need ≥ ${spec.minLength})${spec.generateHint ? ` — \`${spec.generateHint}\`` : ""}`,
      });
      continue;
    }
    const lower = value.toLowerCase();
    if (PLACEHOLDER_FRAGMENTS.some((p) => lower.includes(p))) {
      findings.push({
        envVar: spec.envVar,
        severity: "placeholder",
        detail: `${spec.envVar} looks like a .env.example placeholder — replace it before exposing the gateway`,
      });
    }
  }
  return findings;
}

/**
 * Log any findings as warnings. Called once at startup; non-fatal so the
 * operator can still boot a half-configured dev box.
 */
export function logSecretHygiene(env: NodeJS.ProcessEnv = process.env): void {
  const findings = inspectSecrets(env);
  if (findings.length === 0) return;
  for (const f of findings) {
    log.warn({ envVar: f.envVar, severity: f.severity }, f.detail);
  }
  log.warn(
    { count: findings.length },
    "Secret hygiene check found weak/placeholder secrets — these expose JWT signing and the credential store. Rotate before exposing the gateway.",
  );
}
