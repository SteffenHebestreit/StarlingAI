import { describe, expect, it } from "vitest";
import {
  extractInfraFailureSignature,
  liveToolFamily,
  updateInfraFailureStreak,
  buildInfraFamilyBlockedMessage,
  INFRA_FAILURE_BLOCK_THRESHOLD,
} from "../agent/infra-failure.js";

/**
 * Backend-unreachable breaker (regression: session 8815a45e, 2026-07-02). browser_agent
 * burned ~110s / 7 iterations re-issuing browser_navigate/browser_snapshot against a dead
 * Playwright backend — every call failing with `getaddrinfo ENOTFOUND browser-vnc`. Live-state
 * tools are dedup-exempt by design, so this family-level breaker is the only thing that stops
 * the hammering.
 */
describe("infra-failure breaker", () => {
  it("extracts errno+target signatures from real failure texts (structural, no keywords)", () => {
    expect(extractInfraFailureSignature(
      "### Error Error: getaddrinfo ENOTFOUND browser-vnc Call log: - <ws preparing> retrieving websocket url from http://browser-vnc:9222",
    )).toBe("ENOTFOUND browser-vnc");
    expect(extractInfraFailureSignature(
      "Remote access service request failed (500): connect ECONNREFUSED 10.10.0.2:5900 Troubleshooting: ...",
    )).toBe("ECONNREFUSED 10.10.0.2:5900");
    expect(extractInfraFailureSignature("connect EHOSTUNREACH 10.10.0.2")).toBe("EHOSTUNREACH 10.10.0.2");
  });

  it("does NOT trip on TRANSIENT stream errnos — a live-but-stalled backend must not be permanently blocked", () => {
    // ETIMEDOUT/ECONNRESET/EAI_AGAIN/EPIPE are recoverable: two in a row must NOT terminally
    // short-circuit the family for the whole run (the breaker has no cooldown/probe).
    expect(extractInfraFailureSignature("read ETIMEDOUT")).toBeNull();
    expect(extractInfraFailureSignature("Error: read ECONNRESET browser-vnc")).toBeNull();
    expect(extractInfraFailureSignature("getaddrinfo EAI_AGAIN registry.example")).toBeNull();
    expect(extractInfraFailureSignature("write EPIPE")).toBeNull();
  });

  it("returns null for non-infra failures so ordinary errors never trip the breaker", () => {
    expect(extractInfraFailureSignature("Element ref e12 not found in the current snapshot")).toBeNull();
    expect(extractInfraFailureSignature("RDP adapter requires credentials in 'username:password' format.")).toBeNull();
    expect(extractInfraFailureSignature("No credentials found for 'freelancermap.de'.")).toBeNull();
    expect(extractInfraFailureSignature(undefined)).toBeNull();
    expect(extractInfraFailureSignature("")).toBeNull();
  });

  it("maps only live-state tools to a family", () => {
    expect(liveToolFamily("browser_navigate")).toBe("browser_");
    expect(liveToolFamily("browser_snapshot")).toBe("browser_");
    expect(liveToolFamily("computer_session_start")).toBe("computer_");
    expect(liveToolFamily("web_fetch")).toBeNull();
    expect(liveToolFamily("get_site_credentials")).toBeNull();
  });

  it("same-signature failures accumulate to the threshold; a different signature resets", () => {
    let streak = updateInfraFailureStreak(undefined, "ENOTFOUND browser-vnc");
    expect(streak.count).toBe(1);
    streak = updateInfraFailureStreak(streak, "ENOTFOUND browser-vnc");
    expect(streak.count).toBe(INFRA_FAILURE_BLOCK_THRESHOLD);
    // Probing a DIFFERENT target/protocol restarts the streak (VNC → RDP is legitimate).
    const reset = updateInfraFailureStreak(streak, "ECONNREFUSED 10.10.0.2:3389");
    expect(reset.count).toBe(1);
    expect(reset.signature).toBe("ECONNREFUSED 10.10.0.2:3389");
  });

  it("blocked message names the family, the signature, and forbids retries", () => {
    const msg = buildInfraFamilyBlockedMessage("browser_", "ENOTFOUND browser-vnc");
    expect(msg).toContain("browser_*");
    expect(msg).toContain("ENOTFOUND browser-vnc");
    expect(msg).toContain("Do NOT call");
  });
});
