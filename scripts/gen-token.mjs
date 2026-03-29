#!/usr/bin/env node
/**
 * Generate a StarlingAI dashboard JWT token.
 *
 * Usage:
 *   node scripts/gen-token.mjs                     # admin token (24h)
 *   node scripts/gen-token.mjs --user bob          # custom userId
 *   node scripts/gen-token.mjs --role viewer       # custom role
 *   node scripts/gen-token.mjs --ttl 7d            # custom expiry
 */
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// ── Parse args ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
};

const userId = get("--user") ?? "admin";
const role   = get("--role") ?? "admin";
const ttl    = get("--ttl")  ?? "24h";

// ── Resolve JWT secret (mirrors auth.ts logic) ───────────────────────────────
function loadDotEnvSecret() {
  // If SAI_JWT_SECRET isn't in the environment, try reading it from .env
  // so manual `node scripts/gen-token.mjs` calls produce valid tokens.
  if (process.env["SAI_JWT_SECRET"]) return;
  const envPath = resolve(process.cwd(), ".env");
  try {
    const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^SAI_JWT_SECRET=(.+)$/);
      if (m) { process.env["SAI_JWT_SECRET"] = m[1].trim(); return; }
    }
  } catch { /* .env not found — continue with other sources */ }
}
loadDotEnvSecret();

function getSecret() {
  const env = process.env["SAI_JWT_SECRET"];
  if (env && env.length >= 32) return env;

  const configSecret = readConfigJwtSecret();
  if (configSecret && configSecret.length >= 32) return configSecret;

  const secretPath = join(homedir(), ".starlingai", ".jwt_secret");
  try {
    const stored = readFileSync(secretPath, "utf8").trim();
    if (stored.length >= 32) return stored;
  } catch {
    // Not found — generate and persist
  }

  const generated = randomBytes(32).toString("hex");
  try {
    mkdirSync(join(homedir(), ".starlingai"), { recursive: true });
    writeFileSync(secretPath, generated, { mode: 0o600 });
    console.error(`ℹ  Generated new JWT secret → ${secretPath}`);
  } catch (err) {
    console.error("⚠  Could not persist JWT secret:", err.message);
  }
  return generated;
}

function readConfigJwtSecret() {
  const configPath = resolveConfigPath();
  try {
    const raw = readFileSync(configPath, "utf8");
    const match = raw.match(/["']jwtSecret["']\s*:\s*["']([^"']+)["']/);
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

function resolveConfigPath() {
  const explicit = process.env["SAI_CONFIG_PATH"];
  if (explicit && explicit.trim()) return resolve(explicit);
  return resolve(process.cwd(), "starlingai.json");
}

function parseTtlSeconds(value) {
  const match = /^([0-9]+)([smhd])?$/.exec(value.trim());
  if (!match) {
    throw new Error(`Unsupported TTL format: ${value}`);
  }

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2] ?? "s";
  const multiplier = unit === "s"
    ? 1
    : unit === "m"
      ? 60
      : unit === "h"
        ? 3600
        : 86400;

  return amount * multiplier;
}

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signHs256(data, secret) {
  return createHmac("sha256", secret)
    .update(data)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

// ── Sign ─────────────────────────────────────────────────────────────────────
const secret = getSecret();
const now = Math.floor(Date.now() / 1000);
const exp = now + parseTtlSeconds(ttl);

const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
const payload = base64UrlEncode(JSON.stringify({ sub: userId, role, iat: now, exp }));
const signature = signHs256(`${header}.${payload}`, secret);

console.log(`${header}.${payload}.${signature}`);
