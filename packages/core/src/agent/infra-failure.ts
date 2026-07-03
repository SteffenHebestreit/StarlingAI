/**
 * Backend-unreachable breaker for live-state tool families (browser_*, computer_*).
 *
 * Live-state tools are exempt from the identical-call dedup cache by design (their
 * state legitimately changes between calls), so nothing stopped a sub-agent from
 * hammering a DEAD backend: session 8815a45e, browser_agent burned ~110s / 7
 * iterations re-issuing browser_navigate/browser_snapshot against an unresolvable
 * Playwright host — every call failing with the same `getaddrinfo ENOTFOUND
 * browser-vnc`. When the tool family's own transport is down, the Nth call adds
 * nothing the 1st didn't already establish.
 *
 * The signature is STRUCTURAL (OS/network errno tokens, no natural-language
 * matching): two consecutive failures of the same family with the same errno+target
 * signature mean the backend is unreachable for this run — further calls to the
 * family are short-circuited with an explicit blocker message. Distinct signatures
 * reset the streak, so probing different targets/protocols (VNC → RDP) or ordinary
 * in-page failures never trip it.
 */

/** Consecutive identical infra failures of one family before the family is blocked. */
export const INFRA_FAILURE_BLOCK_THRESHOLD = 2;

// Only errnos that are TERMINAL for the rest of a run — the target host/port genuinely cannot be
// reached and that will not change mid-run: a name that does not resolve, nothing listening on the
// port, no route to the host/network. TRANSIENT stream errors (ETIMEDOUT, ECONNRESET, EAI_AGAIN,
// EPIPE) are deliberately EXCLUDED — a live-but-momentarily-stalled backend returning two of those
// in a row must NOT be permanently short-circuited for the run (the breaker has no cooldown/probe),
// and the provider layer (lmstudio isRetryableStreamError) already classifies those as retryable.
const ERRNO_RE = /\b(ENOTFOUND|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH)\b(?:\s+([\w.:-]+))?/;

/**
 * Normalized "errno + target" signature for a network/transport failure, or null
 * when the error is not infra-shaped (element-not-found, validation, etc.).
 */
export function extractInfraFailureSignature(text: string | undefined | null): string | null {
  if (!text) return null;
  const m = ERRNO_RE.exec(text);
  if (!m?.[1]) return null;
  return m[2] ? `${m[1]} ${m[2]}` : m[1];
}

/**
 * The live-state tool family a tool belongs to, or null for tools already covered
 * by the idempotent dedup cache. Matches isLiveStateTool's prefixes.
 */
export function liveToolFamily(toolName: string): string | null {
  if (toolName.startsWith("browser_")) return "browser_";
  if (toolName.startsWith("computer_")) return "computer_";
  return null;
}

export interface InfraFailureStreak {
  signature: string;
  count: number;
}

/**
 * Fold one failed live-tool result into the family's streak. Returns the new streak
 * (same-signature failures increment; a different signature restarts at 1).
 */
export function updateInfraFailureStreak(
  prior: InfraFailureStreak | undefined,
  signature: string,
): InfraFailureStreak {
  if (prior && prior.signature === signature) {
    return { signature, count: prior.count + 1 };
  }
  return { signature, count: 1 };
}

export function buildInfraFamilyBlockedMessage(family: string, signature: string): string {
  return [
    `Tool family '${family}*' is unavailable for the rest of this run: its backend is unreachable`,
    `(${INFRA_FAILURE_BLOCK_THRESHOLD} consecutive calls failed with the same infrastructure error: ${signature}).`,
    "Do NOT call any tool of this family again this run — the error is environmental, not task-specific, and retrying cannot succeed.",
    "Report the blocker explicitly (which backend is down and the exact error) and continue with whatever can be done without it.",
  ].join(" ");
}
