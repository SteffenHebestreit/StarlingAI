import { readFile } from "node:fs/promises";
import JSON5 from "json5";
import { z } from "zod";
import type { MailAccountConfig } from "./types.js";

const DavCredentialsSchema = z.object({
  serverUrl: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
});

const MailAccountSchema = z.object({
  id: z.string().min(1),
  address: z.string().email(),
  displayName: z.string().min(1).optional(),
  imap: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(993),
    secure: z.boolean().default(true),
    user: z.string().min(1),
    pass: z.string().min(1),
  }),
  smtp: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(587),
    secure: z.boolean().default(false),
    user: z.string().min(1),
    pass: z.string().min(1),
    from: z.string().min(1).optional(),
  }),
  caldav: DavCredentialsSchema.optional(),
  carddav: DavCredentialsSchema.optional(),
});

const MailServiceConfigSchema = z.object({
  accounts: z.array(MailAccountSchema).min(1),
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

function resolveAccount(account: z.infer<typeof MailAccountSchema>): MailAccountConfig {
  return {
    id: account.id,
    address: account.address,
    displayName: account.displayName,
    imap: {
      host: resolveEnvToken(account.imap.host),
      port: account.imap.port,
      secure: account.imap.secure,
      user: resolveEnvToken(account.imap.user),
      pass: resolveEnvToken(account.imap.pass),
    },
    smtp: {
      host: resolveEnvToken(account.smtp.host),
      port: account.smtp.port,
      secure: account.smtp.secure,
      user: resolveEnvToken(account.smtp.user),
      pass: resolveEnvToken(account.smtp.pass),
      from: account.smtp.from ? resolveEnvToken(account.smtp.from) : undefined,
    },
    caldav: account.caldav ? {
      serverUrl: resolveEnvToken(account.caldav.serverUrl),
      username: resolveEnvToken(account.caldav.username),
      password: resolveEnvToken(account.caldav.password),
    } : undefined,
    carddav: account.carddav ? {
      serverUrl: resolveEnvToken(account.carddav.serverUrl),
      username: resolveEnvToken(account.carddav.username),
      password: resolveEnvToken(account.carddav.password),
    } : undefined,
  };
}

/**
 * Load and validate the mail service runtime config.
 *
 * Accounts are parsed from a JSON/JSON5 file at
 * `SAI_MAIL_SERVICE_CONFIG_PATH` (default `/config/mail/accounts.json`).
 * Any string value starting with `$` is treated as an env-var reference and
 * resolved against `process.env` — a missing or empty variable throws.
 *
 * Runtime settings come from the process environment: `HOST`, `PORT`,
 * `SAI_MAIL_SERVICE_DATA_PATH`, and `SAI_MAIL_SERVICE_TOKEN`.
 */
export async function loadMailServiceConfig(): Promise<MailServiceRuntimeConfig> {
  const configPath = process.env["SAI_MAIL_SERVICE_CONFIG_PATH"] ?? "/config/mail/accounts.json";
  const raw = await readFile(configPath, "utf8");
  const parsed = MailServiceConfigSchema.parse(JSON5.parse(raw) as unknown);
  const accounts = parsed.accounts.map(resolveAccount);
  return {
    accounts,
    port: Number(process.env["PORT"] ?? 5020),
    host: process.env["HOST"] ?? "0.0.0.0",
    dataPath: process.env["SAI_MAIL_SERVICE_DATA_PATH"] ?? "/data/mail-service.json",
    authToken: process.env["SAI_MAIL_SERVICE_TOKEN"]?.trim() || undefined,
  };
}