import { readFile } from "node:fs/promises";
import JSON5 from "json5";
import { z } from "zod";
import type { MailAccountConfig } from "./types.js";
import { log } from "./logger.js";

const DavCredentialsSchema = z.object({
  serverUrl: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
});

// Accepts a real boolean OR a boolean-ish string, so a `secure` supplied via an
// env reference (which always resolves to a string) still validates.
const Booleanish = z.preprocess((v) => {
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(s)) return true;
    if (["false", "0", "no", "off"].includes(s)) return false;
  }
  return v;
}, z.boolean());

// Port supplied literally (number) OR via an env reference (string) — coerce.
const Port = z.coerce.number().int().min(1).max(65535);

const MailAccountSchema = z.object({
  id: z.string().min(1),
  address: z.string().email(),
  displayName: z.string().min(1).optional(),
  // Usernames permitted to use this account. Empty = shared (all users). The
  // gateway enforces this against the authenticated user before any mail op.
  allowedUsers: z.array(z.string()).default([]),
  imap: z.object({
    host: z.string().min(1),
    port: Port.default(993),
    secure: Booleanish.default(true),
    user: z.string().min(1),
    pass: z.string().min(1),
  }),
  smtp: z.object({
    host: z.string().min(1),
    port: Port.default(587),
    secure: Booleanish.default(false),
    user: z.string().min(1),
    pass: z.string().min(1),
    from: z.string().min(1).optional(),
  }),
  caldav: DavCredentialsSchema.optional(),
  carddav: DavCredentialsSchema.optional(),
});

const MailServiceConfigSchema = z.object({
  // Zero accounts is valid — the service runs idle (mail is an optional feature).
  accounts: z.array(MailAccountSchema).default([]),
});

export interface MailServiceRuntimeConfig {
  accounts: MailAccountConfig[];
  port: number;
  host: string;
  dataPath: string;
  authToken?: string;
}

function resolveEnvToken(value: string): string {
  if (!value.startsWith("$")) return value;
  const envName = value.slice(1);
  const resolved = process.env[envName];
  if (!resolved || !resolved.trim()) {
    throw new Error(`Missing environment variable ${envName} referenced from mail account config`);
  }
  return resolved;
}

/**
 * Recursively replace every string value of the form `$ENV_VAR` with the value
 * of that environment variable. Runs on the RAW parsed JSON before schema
 * validation, so ANY attribute — not just credentials — can be supplied via env
 * (address, displayName, ports, secure flags, allowedUsers entries, …); the
 * schema then coerces env-supplied ports/booleans to their real types.
 */
function deepResolveEnv(value: unknown): unknown {
  if (typeof value === "string") return resolveEnvToken(value);
  if (Array.isArray(value)) return value.map(deepResolveEnv);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, deepResolveEnv(v)]),
    );
  }
  return value;
}

function resolveAccount(account: z.infer<typeof MailAccountSchema>): MailAccountConfig {
  // Env references were already resolved (deepResolveEnv) and types coerced by
  // the schema; this is now a pure structural map to the runtime shape.
  return {
    id: account.id,
    address: account.address,
    displayName: account.displayName,
    allowedUsers: account.allowedUsers,
    imap: { ...account.imap },
    smtp: { ...account.smtp },
    caldav: account.caldav ? { ...account.caldav } : undefined,
    carddav: account.carddav ? { ...account.carddav } : undefined,
  };
}

/**
 * Load and validate the mail service runtime config.
 *
 * Accounts are parsed from a JSON/JSON5 file at
 * `SAI_MAIL_SERVICE_CONFIG_PATH` (default `/config/mail/accounts.json`).
 * ANY string value of the form `$ENV_VAR` — anywhere in an account — is replaced
 * with that environment variable before validation (host, user, pass, address,
 * displayName, ports, secure flags, allowedUsers, dav credentials, …). A missing
 * or empty referenced variable throws.
 *
 * Runtime settings come from the process environment: `HOST`, `PORT`,
 * `SAI_MAIL_SERVICE_DATA_PATH`, and `SAI_MAIL_SERVICE_TOKEN`.
 */
export async function loadMailServiceConfig(): Promise<MailServiceRuntimeConfig> {
  const configPath = process.env["SAI_MAIL_SERVICE_CONFIG_PATH"] ?? "/config/mail/accounts.json";
  let accounts: MailAccountConfig[] = [];
  try {
    const raw = await readFile(configPath, "utf8");
    const resolved = deepResolveEnv(JSON5.parse(raw) as unknown);
    const parsed = MailServiceConfigSchema.parse(resolved);
    accounts = parsed.accounts.map(resolveAccount);
  } catch (err) {
    // Mail is optional: a MISSING accounts file means "not configured" — run idle
    // with zero accounts instead of crash-looping the container. A file that IS
    // present but malformed (bad JSON / schema / missing env-var ref) is a real
    // misconfiguration and still throws.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      log.warn({ configPath }, "No mail accounts config found — starting mail service idle (zero accounts)");
    } else {
      throw err;
    }
  }
  return {
    accounts,
    port: Number(process.env["PORT"] ?? 5020),
    host: process.env["HOST"] ?? "0.0.0.0",
    dataPath: process.env["SAI_MAIL_SERVICE_DATA_PATH"] ?? "/data/mail-service.json",
    authToken: process.env["SAI_MAIL_SERVICE_TOKEN"]?.trim() || undefined,
  };
}