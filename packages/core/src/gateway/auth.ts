import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";

const log = childLogger("gateway:auth");
const BCRYPT_ROUNDS = 12;

// Cached secret so we only hit the filesystem once per process
let _jwtSecret: Uint8Array | null = null;

// Rate limiting for auth failures — per IP
const failureCounts = new Map<string, { count: number; firstFailAt: number }>();
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 300_000; // 5 minutes
const MAX_TRACKED_IPS = 10_000; // Prevent OOM DoS by bounding map size
const JWT_SECRET_PATH = resolveJwtSecretPath();

// Periodically prune expired entries
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of failureCounts) {
    if (now - entry.firstFailAt > FAILURE_WINDOW_MS) {
      failureCounts.delete(ip);
    }
  }
}, FAILURE_WINDOW_MS).unref();

function getJwtSecret(): Uint8Array {
  if (_jwtSecret) return _jwtSecret;

  // 1. Prefer explicit env var (allows overriding in CI / production)
  const envSecret = process.env["SAI_JWT_SECRET"];
  if (envSecret && envSecret.length >= 32) {
    _jwtSecret = new TextEncoder().encode(envSecret);
    return _jwtSecret;
  }

  // 2. Respect validated config value when no env override is present
  const configSecret = getConfig().gateway.jwtSecret;
  if (configSecret && configSecret.length >= 32) {
    _jwtSecret = new TextEncoder().encode(configSecret);
    return _jwtSecret;
  }

  // 3. Fall back to persisted auto-generated secret file
  try {
    const stored = readFileSync(JWT_SECRET_PATH, "utf8").trim();
    if (stored.length >= 32) {
      _jwtSecret = new TextEncoder().encode(stored);
      return _jwtSecret;
    }
  } catch {
    // File doesn't exist yet — generate below
  }

  // 4. Generate a fresh cryptographically random secret and persist it
  const generated = randomBytes(32).toString("hex"); // 64-char hex
  try {
    mkdirSync(dirname(JWT_SECRET_PATH), { recursive: true });
    writeFileSync(JWT_SECRET_PATH, generated, { mode: 0o600 }); // owner-read-only
    log.info({ path: JWT_SECRET_PATH }, "Generated and saved new JWT secret");
  } catch (err) {
    log.warn({ err }, "Could not persist JWT secret — tokens will not survive restart");
  }
  _jwtSecret = new TextEncoder().encode(generated);
  return _jwtSecret;
}

export async function createToken(userId: string, claims?: Record<string, unknown>): Promise<string> {
  return new SignJWT({ sub: userId, ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(getJwtSecret());
}

export async function verifyToken(token: string): Promise<JWTPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    return payload;
  } catch {
    return null;
  }
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function checkAuthRateLimit(ip: string): { allowed: boolean; retriesRemaining: number } {
  const now = Date.now();
  const entry = failureCounts.get(ip);

  if (!entry || now - entry.firstFailAt > FAILURE_WINDOW_MS) {
    return { allowed: true, retriesRemaining: MAX_FAILURES };
  }

  if (entry.count >= MAX_FAILURES) {
    return { allowed: false, retriesRemaining: 0 };
  }

  return { allowed: true, retriesRemaining: MAX_FAILURES - entry.count };
}

export function recordAuthFailure(ip: string): void {
  const now = Date.now();
  const entry = failureCounts.get(ip);
  if (!entry || now - entry.firstFailAt > FAILURE_WINDOW_MS) {
    if (failureCounts.size >= MAX_TRACKED_IPS) {
      // Very crude eviction to prevent memory exhaustion
      const firstKey = failureCounts.keys().next().value;
      if (firstKey) failureCounts.delete(firstKey);
    }
    failureCounts.set(ip, { count: 1, firstFailAt: now });
  } else {
    entry.count++;
  }

  logAudit("auth_failure", { ip }, { severity: "warn" });
  log.warn({ ip }, "Auth failure recorded");
}

export function clearAuthFailures(ip: string): void {
  failureCounts.delete(ip);
}

/**
 * Extract bearer token from Authorization header.
 * Returns null if missing or malformed.
 */
export function extractBearerToken(authHeader: string | null | undefined): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ?? null;
}

export function resetAuthStateForTests(): void {
  _jwtSecret = null;
  failureCounts.clear();
}

function resolveJwtSecretPath(): string {
  const explicit = process.env["SAI_JWT_SECRET_PATH"];
  if (explicit?.trim()) return resolve(explicit.trim());

  const workspaceSecret = resolve(process.cwd(), ".starlingai", ".jwt_secret");
  const homeSecret = resolve(homedir(), ".starlingai", ".jwt_secret");

  if (existsSync(workspaceSecret)) return workspaceSecret;
  if (existsSync(homeSecret)) return homeSecret;
  return workspaceSecret;
}
