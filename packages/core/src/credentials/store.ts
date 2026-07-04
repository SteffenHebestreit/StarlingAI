/**
 * AES-256-GCM encrypted credential store.
 * All secrets are encrypted at rest — never stored in plaintext.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { childLogger } from "../logger.js";

import { PRODUCT } from "../product/index.js";

const log = childLogger("credentials");
const STORE_PATH = resolveStorePath();
const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 16;
const AUTH_TAG_LEN = 16;
const SALT_LEN = 32;

let _key: Buffer | null = null;

function deriveKey(masterKey: string, salt: Buffer): Buffer {
  return scryptSync(masterKey, salt, KEY_LEN) as Buffer;
}

function getMasterKey(): string {
  const key = process.env["SAI_MASTER_KEY"];
  if (!key || key.length < 32) {
    throw new Error("SAI_MASTER_KEY env var must be set (min 32 chars) for credential store");
  }
  return key;
}

function getOrCreateSalt(): Buffer {
  const saltPath = STORE_PATH + ".salt";
  if (existsSync(saltPath)) {
    return readFileSync(saltPath);
  }
  const salt = randomBytes(SALT_LEN);
  mkdirSync(dirname(saltPath), { recursive: true });
  writeFileSync(saltPath, salt, { mode: 0o600 });
  return salt;
}

function getKey(): Buffer {
  if (_key) return _key;
  const salt = getOrCreateSalt();
  _key = deriveKey(getMasterKey(), salt);
  return _key;
}

function encrypt(plaintext: string): Buffer {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: [iv (16)] [tag (16)] [ciphertext]
  return Buffer.concat([iv, tag, enc]);
}

function decrypt(data: Buffer): string {
  const key = getKey();
  const iv = data.subarray(0, IV_LEN);
  const tag = data.subarray(IV_LEN, IV_LEN + AUTH_TAG_LEN);
  const ciphertext = data.subarray(IV_LEN + AUTH_TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

type CredentialStore = Record<string, string>;

// In-memory cache: load once, invalidate on write
let _cache: CredentialStore | null = null;
// True when the on-disk store EXISTS but could not be decrypted (wrong key / rotated
// salt). We still serve reads as empty, but must NEVER overwrite the file (that would
// destroy the recoverable ciphertext = every stored credential).
let _loadFailed = false;

function loadStore(): CredentialStore {
  if (_cache) return _cache;
  if (!existsSync(STORE_PATH)) {
    _cache = {};
    return _cache;
  }
  try {
    const raw = readFileSync(STORE_PATH);
    _cache = JSON.parse(decrypt(raw)) as CredentialStore;
    _loadFailed = false;
    return _cache;
  } catch (err) {
    _loadFailed = true;
    log.error({ err }, "Failed to decrypt credential store — refusing to overwrite existing ciphertext");
    _cache = {};
    return _cache;
  }
}

function saveStore(store: CredentialStore): void {
  // Fail closed: if the file exists but never decrypted, a write here would wipe ALL
  // other credentials. Back up the ciphertext and refuse instead of destroying it.
  if (_loadFailed && existsSync(STORE_PATH)) {
    const backup = `${STORE_PATH}.corrupt-${Date.now()}`;
    try { if (!existsSync(backup)) writeFileSync(backup, readFileSync(STORE_PATH), { mode: 0o600 }); } catch { /* best effort */ }
    throw new Error(
      `Credential store could not be decrypted (wrong SAI_MASTER_KEY or missing/rotated .salt). ` +
      `Refusing to overwrite ${STORE_PATH} to avoid destroying existing credentials. ` +
      `A backup was written to ${backup}. Restore the correct key/salt, then retry.`,
    );
  }
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  const encrypted = encrypt(JSON.stringify(store));
  writeFileSync(STORE_PATH, encrypted, { mode: 0o600 });
  _cache = store;
  _loadFailed = false;
}

export function setCredential(name: string, value: string): void {
  const store = loadStore();
  store[name] = value;
  saveStore(store);
  log.info({ name }, "Credential stored");
}

export function getCredential(name: string): string | undefined {
  // Check env first (Docker secrets / env injection takes priority). The readable
  // slug alone is LOSSY — "a-b", "a_b", "a.b" all collapse to SAI_SECRET_A_B and would
  // alias to one env var (returning the wrong credential), so append a short hash of
  // the exact name to keep distinct names from colliding.
  const slug = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  const suffix = createHash("sha256").update(name).digest("hex").slice(0, 8);
  const envKey = `SAI_SECRET_${slug}_${suffix}`;
  if (process.env[envKey]) return process.env[envKey];

  const store = loadStore();
  return store[name];
}

export function deleteCredential(name: string): void {
  const store = loadStore();
  delete store[name];
  saveStore(store);
}

export function listCredentialNames(): string[] {
  return Object.keys(loadStore());
}

function resolveStorePath(): string {
  const explicit = process.env["SAI_CRED_STORE"];
  if (explicit?.trim()) return resolve(explicit);

  const workspaceStore = resolve(process.cwd(), PRODUCT.stateDirName, "credentials.enc");
  const homeStore = resolve(homedir(), PRODUCT.stateDirName, "credentials.enc");

  if (existsSync(workspaceStore)) return workspaceStore;
  if (existsSync(homeStore)) return homeStore;
  return workspaceStore;
}
