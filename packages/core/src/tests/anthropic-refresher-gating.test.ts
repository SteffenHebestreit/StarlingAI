import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnthropicOAuthError,
  anthropicRefreshDisabledReason,
  isUnrecoverableOAuthFailure,
  resetAnthropicRefreshFailure,
  startAnthropicTokenRefresher,
  stopAnthropicTokenRefresher,
} from "../providers/anthropic-oauth.js";

/**
 * Observed on a live deployment: the gateway logged an Anthropic token-endpoint 400
 * every four minutes, indefinitely, on an install where Claude was not configured at
 * all — no active preset, no anthropic provider, no agent routed to it. Two independent
 * faults: the refresher started whenever a token file existed, and it never gave up on a
 * grant that answers `invalid_grant` permanently.
 */

vi.mock("../credentials/store.js", () => ({
  getCredential: vi.fn(() =>
    JSON.stringify({ accessToken: "a", refreshToken: "r", expiresAt: 0 }),
  ),
  setCredential: vi.fn(),
  deleteCredential: vi.fn(),
}));

describe("isUnrecoverableOAuthFailure", () => {
  it("treats a dead grant as permanent", () => {
    expect(isUnrecoverableOAuthFailure(new AnthropicOAuthError(400, "invalid_grant"))).toBe(true);
    expect(isUnrecoverableOAuthFailure(new AnthropicOAuthError(401, null))).toBe(true);
    expect(isUnrecoverableOAuthFailure(new AnthropicOAuthError(403, null))).toBe(true);
  });

  it("keeps retrying anything that might succeed later", () => {
    expect(isUnrecoverableOAuthFailure(new AnthropicOAuthError(500, null))).toBe(false);
    expect(isUnrecoverableOAuthFailure(new AnthropicOAuthError(429, "rate_limited"))).toBe(false);
    expect(isUnrecoverableOAuthFailure(new Error("socket hang up"))).toBe(false);
  });
});

describe("the background refresher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAnthropicRefreshFailure();
  });
  afterEach(() => {
    stopAnthropicTokenRefresher();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not call the token endpoint when Anthropic is not in use", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    startAnthropicTokenRefresher(() => false, 1000);
    await vi.advanceTimersByTimeAsync(5000);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("re-checks on every tick, so connecting Claude takes effect without a restart", async () => {
    let inUse = false;
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({ access_token: "new", refresh_token: "r2", expires_in: 3600 }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchSpy);

    startAnthropicTokenRefresher(() => inUse, 1000);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fetchSpy).not.toHaveBeenCalled();

    inUse = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("stops after a permanently refused grant instead of retrying forever", async () => {
    const fetchSpy = vi.fn(async () => new Response(
      JSON.stringify({ error: "invalid_grant" }), { status: 400 },
    ));
    vi.stubGlobal("fetch", fetchSpy);

    startAnthropicTokenRefresher(() => true, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(anthropicRefreshDisabledReason()).toBe("invalid_grant");

    // The whole point: no second, third, hundredth attempt.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("keeps trying through a transient server error", async () => {
    const fetchSpy = vi.fn(async () => new Response("upstream boom", { status: 503 }));
    vi.stubGlobal("fetch", fetchSpy);

    startAnthropicTokenRefresher(() => true, 1000);
    await vi.advanceTimersByTimeAsync(3000);

    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
    expect(anthropicRefreshDisabledReason()).toBeNull();
  });

  it("reports why it is disabled, so the state is visible rather than merely quiet", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "invalid_grant" }), { status: 400 },
    )));
    expect(anthropicRefreshDisabledReason()).toBeNull();

    startAnthropicTokenRefresher(() => true, 1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(anthropicRefreshDisabledReason()).toBe("invalid_grant");
    resetAnthropicRefreshFailure();
    expect(anthropicRefreshDisabledReason()).toBeNull();
  });
});
