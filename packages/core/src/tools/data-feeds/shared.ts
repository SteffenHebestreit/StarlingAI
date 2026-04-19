import { resolve as dnsResolve } from "node:dns/promises";
import { isPrivateHost } from "../web.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = "StarlingAI-DataFeeds/1.0 (+https://github.com/starlingai)";

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
  if (!opts.trusted) {
    await assertSafeUrl(url);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": DEFAULT_USER_AGENT, Accept: "application/json, text/*;q=0.9", ...opts.headers },
      signal: controller.signal,
    });
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

async function assertSafeUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`URL scheme must be http or https: ${url}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (isPrivateHost(host)) {
    throw new Error(`Refusing to fetch private/internal host: ${host}`);
  }
  try {
    const addrs = await dnsResolve(host);
    if (addrs.some((addr) => isPrivateHost(addr))) {
      throw new Error(`Host ${host} resolves to a private address — refusing to fetch`);
    }
  } catch (err) {
    // Re-throw our explicit refusal; tolerate DNS-unavailable for IP literals.
    if (err instanceof Error && err.message.startsWith("Host ")) throw err;
  }
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
