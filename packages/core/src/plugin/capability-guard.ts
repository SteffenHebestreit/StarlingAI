/**
 * SEC-105 (ADR-007): plugin capability guard — network egress.
 *
 * Runs INSIDE the isolated worker, installed before the plugin's module code
 * imports. Wraps the global `fetch` to a deny-by-default host allowlist drawn
 * from the plugin manifest's `capabilities.network`: a plugin that declared no
 * network capability cannot fetch at all, and one that declared hosts can reach
 * only those exact hosts.
 *
 * HONEST SCOPE — this is DEFENSE IN DEPTH, not a hard boundary. It gates the
 * common `fetch` egress path (the overwhelmingly likely exfil channel for a
 * misbehaving-but-not-hostile plugin, and a real reduction in attack surface),
 * but a determined plugin can bypass it via `node:http`/`node:net` directly.
 * True network isolation is the container tier (docker-socket-proxy /
 * network namespace) reserved for `untrusted_multi_tenant`, per ADR-007. The
 * digest-pinned trust gate already establishes that only operator-approved code
 * runs here; this narrows what that approved code can reach by accident.
 */

export class PluginCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginCapabilityError";
  }
}

/** Extract the lowercased hostname from a fetch input (string, URL, or Request-like). */
function hostOf(input: unknown): string | null {
  try {
    if (typeof input === "string") return new URL(input).hostname.toLowerCase();
    if (input instanceof URL) return input.hostname.toLowerCase();
    if (input && typeof input === "object" && typeof (input as { url?: unknown }).url === "string") {
      return new URL((input as { url: string }).url).hostname.toLowerCase();
    }
  } catch { return null; }
  return null;
}

export interface NetworkGuardHandle {
  /** Restore the original fetch (tests / teardown). */
  restore: () => void;
}

/**
 * Install the network guard over `target.fetch` (defaults to globalThis).
 * `allowedHosts` are exact hostnames the plugin declared; an empty list denies
 * all fetch. A blocked call throws PluginCapabilityError before any request is
 * made. A non-parseable URL is denied (fail closed).
 */
export function installNetworkGuard(
  allowedHosts: string[],
  target: { fetch?: typeof fetch } = globalThis as unknown as { fetch?: typeof fetch },
): NetworkGuardHandle {
  const allow = new Set(allowedHosts.map((h) => h.trim().toLowerCase()).filter(Boolean));
  const original = target.fetch;

  const guarded = ((input: unknown, init?: unknown) => {
    const host = hostOf(input);
    if (host === null) {
      return Promise.reject(new PluginCapabilityError("plugin fetch blocked: unparseable request URL (network capability is deny-by-default)"));
    }
    if (!allow.has(host)) {
      const declared = allow.size > 0 ? `declared hosts: ${[...allow].join(", ")}` : "no network capability declared";
      return Promise.reject(new PluginCapabilityError(`plugin fetch to '${host}' blocked — ${declared}. Add it to the manifest's capabilities.network to allow it.`));
    }
    if (!original) return Promise.reject(new PluginCapabilityError("fetch is unavailable in this worker runtime"));
    return original(input as RequestInfo | URL, init as RequestInit | undefined);
  }) as unknown as typeof fetch;

  target.fetch = guarded;
  return {
    restore: () => { target.fetch = original; },
  };
}
