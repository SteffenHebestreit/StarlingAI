#!/usr/bin/env node
/**
 * Generate a StarlingAI dashboard JWT token.
 *
 * Usage:
 *   node scripts/gen-token.mjs                     # admin token (24h)
 *   node scripts/gen-token.mjs --user bob           # custom userId
 *   node scripts/gen-token.mjs --role viewer        # custom role
 *   node scripts/gen-token.mjs --ttl 7d             # custom expiry
 */
import { SignJWT } from "jose";
import JSON5 from "json5";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
    const parsed = JSON5.parse(readFileSync(configPath, "utf8"));
    const jwtSecret = parsed?.gateway?.jwtSecret;
    return typeof jwtSecret === "string" ? jwtSecret.trim() : undefined;
  } catch {
    return undefined;
  }
}

function resolveConfigPath() {
  const explicit = process.env["SAI_CONFIG_PATH"];
  if (explicit && explicit.trim()) return resolve(explicit);
  return resolve(process.cwd(), "starlingai.json");
}

// ── Sign ─────────────────────────────────────────────────────────────────────
const secret = getSecret();
const key    = new TextEncoder().encode(secret);

const token = await new SignJWT({ sub: userId, role })
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime(ttl)
  .sign(key);

console.log(token);
