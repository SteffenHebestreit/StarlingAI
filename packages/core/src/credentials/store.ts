/**
 * AES-256-GCM encrypted credential store.
 * All secrets are encrypted at rest — never stored in plaintext.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, dirname } from "node:path";
import { childLogger } from "../logger.js";

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

function loadStore(): CredentialStore {
  if (_cache) return _cache;
  if (!existsSync(STORE_PATH)) {
    _cache = {};
    return _cache;
  }
  try {
    const raw = readFileSync(STORE_PATH);
    _cache = JSON.parse(decrypt(raw)) as CredentialStore;
    return _cache;
  } catch (err) {
    log.error({ err }, "Failed to decrypt credential store — starting empty");
    _cache = {};
    return _cache;
  }
}

function saveStore(store: CredentialStore): void {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  const encrypted = encrypt(JSON.stringify(store));
  writeFileSync(STORE_PATH, encrypted, { mode: 0o600 });
  _cache = store;
}

export function setCredential(name: string, value: string): void {
  const store = loadStore();
  store[name] = value;
  saveStore(store);
  log.info({ name }, "Credential stored");
}

export function getCredential(name: string): string | undefined {
  // Check env first (Docker secrets / env injection takes priority)
  const envKey = `SAI_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
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

  const workspaceStore = resolve(process.cwd(), ".starlingai", "credentials.enc");
  const homeStore = resolve(homedir(), ".starlingai", "credentials.enc");

  if (existsSync(workspaceStore)) return workspaceStore;
  if (existsSync(homeStore)) return homeStore;
  return workspaceStore;
}
