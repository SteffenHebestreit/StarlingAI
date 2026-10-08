import { checkUrlSsrf } from "../web.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = "StarlingAI-DataFeeds/1.0 (+https://github.com/starlingai)";
/** Redirects a caller-supplied URL is followed through, each target checked first: as many as url_inspect follows. */
const MAX_REDIRECTS = 5;
/** The statuses fetch follows as redirects with redirect "follow". */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface FetchJsonOptions {
  /** Per-request timeout. Default 10 s. */
  timeoutMs?: number;
  /** Additional headers (User-Agent default is already supplied). */
  headers?: Record<string, string>;
  /** Optional caller-controlled abort signal. */
  signal?: AbortSignal;
  /** When true, skip the SSRF guard (for trusted built-in provider URLs). Default false. */
  trusted?: boolean;
}

export interface FetchTextOptions extends FetchJsonOptions {
  /** Maximum response body size in bytes. Default 512 KB. */
  maxBytes?: number;
}

/**
 * Fetch + JSON-parse a URL.
 *
 * Built-in providers may pass `trusted: true` because their URLs are hardcoded.
 * For tools that accept a user-supplied URL (e.g. read_rss_feed), leave `trusted`
 * false so the SSRF guard rejects loopback / RFC1918 / cloud-metadata targets.
 */
export async function fetchJson<T = unknown>(url: string, opts: FetchJsonOptions = {}): Promise<T> {
  const text = await fetchText(url, opts);
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new Error(`Failed to parse JSON from ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function fetchText(url: string, opts: FetchTextOptions = {}): Promise<string> {
  // A caller's URL was checked once (its host, IPv4 records only, the operator's allowlist
  // ignored) and fetch then followed redirects on its own, so a public feed URL that redirected
  // into the private network was fetched and its items returned. web_fetch's guard, with
  // guardrails.allowedPrivateHosts, now decides the URL and every redirect target before it is
  // requested.
  if (!opts.trusted) {
    const refused = await checkUrlSsrf(url);
    if (refused) throw new Error(`Refusing to fetch ${url}: ${refused}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const init: RequestInit = {
      headers: { "User-Agent": DEFAULT_USER_AGENT, Accept: "application/json, text/*;q=0.9", ...opts.headers },
      signal: controller.signal,
    };
    const response = opts.trusted ? await fetch(url, init) : await fetchFollowingCheckedRedirects(url, init);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} from ${url}`);
    }
    const max = opts.maxBytes ?? 512 * 1024;
    const text = await response.text();
    if (text.length > max) return text.slice(0, max);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** fetch for a URL the guard let through, each redirect followed by hand once its target passes the guard too. */
async function fetchFollowingCheckedRedirects(url: string, init: RequestInit): Promise<Response> {
  let current = url;
  let response = await fetch(current, { ...init, redirect: "manual" });
  for (let redirects = 0; REDIRECT_STATUSES.has(response.status) && response.headers.has("location"); redirects++) {
    if (redirects >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`);
    const next = new URL(response.headers.get("location")!, current).toString();
    const refused = await checkUrlSsrf(next);
    if (refused) throw new Error(`Refusing to follow the redirect from ${current}: ${refused}`);
    current = next;
    response = await fetch(current, { ...init, redirect: "manual" });
  }
  return response;
}

// ─── Tiny TTL cache ─────────────────────────────────────────────────────────

interface CacheEntry<T> { value: T; expiresAt: number; }

export class TtlCache<T> {
  private store = new Map<string, CacheEntry<T>>();
  constructor(private readonly defaultTtlMs: number) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs?: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs) });
  }

  clear(): void {
    this.store.clear();
  }
}

// ─── Tiny per-key min-interval rate limiter ─────────────────────────────────

const _lastCallAt = new Map<string, number>();

/** Block until at least `minIntervalMs` has passed since the last call for `key`. */
export async function rateLimit(key: string, minIntervalMs: number): Promise<void> {
  const last = _lastCallAt.get(key) ?? 0;
  const wait = last + minIntervalMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  _lastCallAt.set(key, Date.now());
}
