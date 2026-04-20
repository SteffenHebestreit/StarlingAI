/**
 * Site credential management.
 *
 * Two sources, merged at lookup time (config file takes precedence):
 *   1. `config.sites` — declared in starlingai.json; password is a ref, not literal
 *   2. Encrypted credential store — managed via REST API / dashboard at runtime
 *
 * Password ref formats (in config):
 *   "$ENV_VAR"       → process.env["ENV_VAR"]
 *   "secret:key"     → encrypted store lookup for "key"
 *   "literal"        → used as-is; a warning is logged (dev use only)
 */
import { getCredential, setCredential, deleteCredential, listCredentialNames } from "./store.js";
import { getConfig } from "../config/loader.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";

const log = childLogger("credentials:sites");

// Credential store key prefixes for API-managed site entries
const SITE_USERNAME_KEY  = (host: string) => `site:${host}:username`;
const SITE_PASSWORD_KEY  = (host: string) => `site:${host}:password`;
const SITE_LOGIN_URL_KEY = (host: string) => `site:${host}:loginUrl`;
const SITE_SELECTORS_KEY = (host: string) => `site:${host}:selectors`;
const SITE_NOTES_KEY     = (host: string) => `site:${host}:notes`;
const SITE_URLS_KEY      = (host: string) => `site:${host}:urls`;

export interface ResolvedSiteCredential {
  hostname: string;
  username: string;
  password: string;
  loginUrl?: string;
  urls?: Record<string, string>;
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  notes?: string;
  source: "config" | "store";
}

export interface StoredSiteCredentialRecord {
  hostname: string;
  username: string;
  password: string;
  loginUrl?: string;
  urls?: Record<string, string>;
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  notes?: string;
}

// ─── Resolve credentials for a hostname ──────────────────────────────────────

export function resolveSiteCredential(
  hostname: string,
  sessionId?: string
): ResolvedSiteCredential | null {
  const host = normalizeHost(hostname);

  // 1. Check config file (higher precedence)
  const config = getConfig();
  const configMatch = findConfiguredSite(hostname, config.sites);
  if (configMatch) {
    const [matchedHost, configEntry] = configMatch;
    const password = resolvePasswordRef(configEntry.password, matchedHost);
    if (!password) {
      log.warn({ host: matchedHost }, "Site credential in config but password could not be resolved");
      return null;
    }
    logAudit("credential_accessed", { hostname: matchedHost, source: "config" }, { sessionId });
    return {
      hostname: matchedHost,
      username: configEntry.username,
      password,
      loginUrl: configEntry.loginUrl,
      urls: configEntry.urls,
      usernameSelector: configEntry.usernameSelector,
      passwordSelector: configEntry.passwordSelector,
      submitSelector: configEntry.submitSelector,
      notes: configEntry.notes,
      source: "config",
    };
  }

  // 2. Check runtime credential store (API-managed)
  const stored = getStoredSiteCredentialRecord(host);
  if (stored) {
    const resolvedUsername = resolveStoredCredentialRef(stored.username, stored.hostname, "username");
    const resolvedPassword = resolveStoredCredentialRef(stored.password, stored.hostname, "password");
    if (!resolvedUsername || !resolvedPassword) {
      log.warn({ host: stored.hostname }, "Stored site credential could not be fully resolved");
      return null;
    }

    logAudit("credential_accessed", { hostname: stored.hostname, source: "store" }, { sessionId });
    return {
      ...stored,
      username: resolvedUsername,
      password: resolvedPassword,
      source: "store",
    };
  }

  return null;
}

export function hasConfigSiteCredential(hostname: string): boolean {
  return findConfiguredSite(hostname, getConfig().sites) !== null;
}

// ─── CRUD for API-managed site credentials ────────────────────────────────────

export interface SiteCredentialInput {
  username: string;
  password: string;
  loginUrl?: string;
  urls?: Record<string, string>;
  usernameSelector?: string;
  passwordSelector?: string;
  submitSelector?: string;
  notes?: string;
}

export function saveSiteCredential(hostname: string, input: SiteCredentialInput): void {
  const host = normalizeHost(hostname);
  setCredential(SITE_USERNAME_KEY(host), input.username);
  setCredential(SITE_PASSWORD_KEY(host), input.password);
  if (input.loginUrl) {
    setCredential(SITE_LOGIN_URL_KEY(host), input.loginUrl);
  } else {
    deleteCredential(SITE_LOGIN_URL_KEY(host));
  }
  if (input.urls && Object.keys(input.urls).length > 0) {
    setCredential(SITE_URLS_KEY(host), JSON.stringify(input.urls));
  } else {
    deleteCredential(SITE_URLS_KEY(host));
  }
  if (input.usernameSelector || input.passwordSelector || input.submitSelector) {
    setCredential(SITE_SELECTORS_KEY(host), JSON.stringify({
      username: input.usernameSelector,
      password: input.passwordSelector,
      submit: input.submitSelector,
    }));
  } else {
    deleteCredential(SITE_SELECTORS_KEY(host));
  }
  if (input.notes) {
    setCredential(SITE_NOTES_KEY(host), input.notes);
  } else {
    deleteCredential(SITE_NOTES_KEY(host));
  }
  log.info({ host }, "Site credential saved to store");
}

export function deleteSiteCredential(hostname: string): void {
  const host = normalizeHost(hostname);
  deleteCredential(SITE_USERNAME_KEY(host));
  deleteCredential(SITE_PASSWORD_KEY(host));
  deleteCredential(SITE_LOGIN_URL_KEY(host));
  deleteCredential(SITE_URLS_KEY(host));
  deleteCredential(SITE_SELECTORS_KEY(host));
  deleteCredential(SITE_NOTES_KEY(host));
  log.info({ host }, "Site credential deleted from store");
}

export function getStoredSiteCredentialRecord(hostname: string): StoredSiteCredentialRecord | null {
  const host = normalizeHost(hostname);
  const storedHost = findStoredSiteHost(host);
  const lookupHost = storedHost ?? host;
  const username = getCredential(SITE_USERNAME_KEY(lookupHost));
  const password = getCredential(SITE_PASSWORD_KEY(lookupHost));
  if (!username || !password) return null;

  const selectors = parseJsonRecord(getCredential(SITE_SELECTORS_KEY(lookupHost)));
  const urls = parseJsonRecord(getCredential(SITE_URLS_KEY(lookupHost)));
  return {
    hostname: lookupHost,
    username,
    password,
    loginUrl: getCredential(SITE_LOGIN_URL_KEY(lookupHost)) ?? undefined,
    urls: Object.keys(urls).length > 0 ? urls : undefined,
    usernameSelector: selectors["username"],
    passwordSelector: selectors["password"],
    submitSelector: selectors["submit"],
    notes: getCredential(SITE_NOTES_KEY(lookupHost)) ?? undefined,
  };
}

export interface SiteCredentialSummary {
  hostname: string;
  username: string;
  loginUrl?: string;
  urls?: Record<string, string>;
  notes?: string;
  source: "config" | "store";
}

export function listSiteCredentials(): SiteCredentialSummary[] {
  const results: SiteCredentialSummary[] = [];
  const seen = new Set<string>();

  // From config file
  const config = getConfig();
  for (const [host, entry] of Object.entries(config.sites)) {
    seen.add(normalizeHost(host));
    results.push({ hostname: normalizeHost(host), username: entry.username, loginUrl: entry.loginUrl, urls: entry.urls, notes: entry.notes, source: "config" });
  }

  // From encrypted store
  for (const key of listCredentialNames()) {
    if (!key.startsWith("site:") || !key.endsWith(":username")) continue;
    const host = key.slice("site:".length, -":username".length);
    if (seen.has(host)) continue;
    const username = getCredential(SITE_USERNAME_KEY(host)) ?? "";
    const urls = parseJsonRecord(getCredential(SITE_URLS_KEY(host)));
    results.push({
      hostname: host,
      username,
      loginUrl: getCredential(SITE_LOGIN_URL_KEY(host)) ?? undefined,
      urls: Object.keys(urls).length > 0 ? urls : undefined,
      notes: getCredential(SITE_NOTES_KEY(host)) ?? undefined,
      source: "store",
    });
  }

  return results;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeHost(raw: string): string {
  try {
    // Handle full URLs gracefully
    if (raw.includes("://")) return new URL(raw).hostname.toLowerCase();
  } catch { /* fall through */ }
  return raw.toLowerCase().replace(/^www\./, "");
}

function findConfiguredSite(
  hostname: string,
  sites: Record<string, ReturnType<typeof getConfig>["sites"][string]>
): [string, ReturnType<typeof getConfig>["sites"][string]] | null {
  const host = normalizeHost(hostname);
  const exact = sites[host] ?? sites[hostname];
  if (exact) return [normalizeHost(host), exact];

  const alias = findHostAlias(host, Object.keys(sites));
  if (!alias) return null;

  return [alias, sites[alias]!];
}

function findStoredSiteHost(hostname: string): string | null {
  const usernameHosts = listCredentialNames()
    .filter((key) => key.startsWith("site:") && key.endsWith(":username"))
    .map((key) => key.slice("site:".length, -":username".length));

  return findHostAlias(hostname, usernameHosts);
}

function findHostAlias(hostname: string, candidates: string[]): string | null {
  const host = normalizeHost(hostname);
  if (candidates.includes(host)) return host;

  // Handle stored keys that still carry a www. prefix (saved by older code).
  const wwwMatch = candidates.find(c => normalizeHost(c) === host);
  if (wwwMatch) return wwwMatch;

  // Allow short aliases like "n8n" to match configured hosts such as "n8n.k2o".
  if (!host.includes(".")) {
    const prefixMatches = candidates
      .map((candidate) => normalizeHost(candidate))
      .filter((candidate) => candidate.startsWith(`${host}.`))
      .sort((left, right) => left.length - right.length);
    if (prefixMatches.length === 1) return prefixMatches[0]!;
  }

  const hostWithoutTld = stripTopLevelDomain(host);
  if (hostWithoutTld) {
    const tldMatches = candidates
      .map((candidate) => ({ raw: candidate, normalized: normalizeHost(candidate) }))
      .filter(({ normalized }) => stripTopLevelDomain(normalized) === hostWithoutTld);

    const uniqueMatches = [...new Map(tldMatches.map(({ normalized, raw }) => [normalized, raw])).values()]
      .sort((left, right) => normalizeHost(left).length - normalizeHost(right).length);

    if (uniqueMatches.length === 1) return uniqueMatches[0]!;
  }

  return null;
}

function stripTopLevelDomain(hostname: string): string | null {
  const labels = normalizeHost(hostname).split(".").filter(Boolean);
  if (labels.length < 2) return null;
  return labels.slice(0, -1).join(".");
}

function resolveStoredCredentialRef(
  value: string,
  host: string,
  field: "username" | "password",
): string | undefined {
  if (value.startsWith("$")) {
    const envKey = value.slice(1);
    const envValue = process.env[envKey];
    if (!envValue) {
      log.warn({ host, field, envKey }, "Env var for stored site credential is not set");
    }
    return envValue;
  }

  if (value.startsWith("secret:")) {
    const key = value.slice("secret:".length);
    const secretValue = getCredential(key);
    if (!secretValue) {
      log.warn({ host, field, key }, "Named secret for stored site credential not found in credential store");
    }
    return secretValue;
  }

  return value;
}

function resolvePasswordRef(ref: string, host: string): string | undefined {
  // $ENV_VAR
  if (ref.startsWith("$")) {
    const envKey = ref.slice(1);
    const val = process.env[envKey];
    if (!val) log.warn({ host, envKey }, "Env var for site password is not set");
    return val;
  }
  // secret:key
  if (ref.startsWith("secret:")) {
    const key = ref.slice("secret:".length);
    const val = getCredential(key);
    if (!val) log.warn({ host, key }, "Named secret for site password not found in credential store");
    return val;
  }
  // Literal (dev use only)
  if (process.env["NODE_ENV"] !== "production") return ref;
  log.warn({ host }, "Plain-text password in config is not allowed in production — use $ENV or secret: prefix");
  return ref; // still return it, but warn loudly
}

function parseJsonRecord(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, value]) => typeof value === "string" && value.length > 0)
        .map(([key, value]) => [key, value as string])
    );
  } catch (err) {
    log.warn({ err }, "Invalid JSON stored for site credential metadata");
    return {};
  }
}
