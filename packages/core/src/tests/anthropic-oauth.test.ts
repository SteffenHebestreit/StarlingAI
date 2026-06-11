import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  generatePkce,
  generateOAuthState,
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  refreshAccessToken,
  ANTHROPIC_OAUTH_CLIENT_ID,
  ANTHROPIC_OAUTH_REDIRECT_URI,
} from "../providers/anthropic-oauth.js";

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("anthropic OAuth PKCE", () => {
  it("generates a verifier and a matching S256 challenge", () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier).not.toContain("=");
    const expected = base64Url(createHash("sha256").update(verifier).digest());
    expect(challenge).toBe(expected);
  });

  it("produces unique verifiers and states", () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier);
    expect(generateOAuthState()).not.toBe(generateOAuthState());
  });

  it("builds an authorize URL with the Claude Code client, manual-code flow and S256", () => {
    const url = new URL(buildAuthorizeUrl("CHALLENGE", "STATE"));
    expect(url.origin + url.pathname).toBe("https://claude.ai/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(ANTHROPIC_OAUTH_CLIENT_ID);
    expect(url.searchParams.get("code")).toBe("true");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(ANTHROPIC_OAUTH_REDIRECT_URI);
    expect(url.searchParams.get("code_challenge")).toBe("CHALLENGE");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("STATE");
    expect(url.searchParams.get("scope")).toContain("user:inference");
  });
});

describe("anthropic OAuth token exchange", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function okJson(body: unknown) {
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
  }

  it("splits a code#state paste and posts the PKCE verifier", async () => {
    fetchMock.mockReturnValue(okJson({ access_token: "sk-ant-oat01-x", refresh_token: "sk-ant-ort01-y", expires_in: 3600 }));

    const before = Date.now();
    const set = await exchangeAuthorizationCode("THECODE#THESTATE", "fallback-state", "VERIFIER");

    expect(set.accessToken).toBe("sk-ant-oat01-x");
    expect(set.refreshToken).toBe("sk-ant-ort01-y");
    expect(set.expiresAt).toBeGreaterThanOrEqual(before + 3600_000);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://platform.claude.com/v1/oauth/token");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.grant_type).toBe("authorization_code");
    expect(body.code).toBe("THECODE");
    expect(body.state).toBe("THESTATE"); // state parsed from the paste wins
    expect(body.code_verifier).toBe("VERIFIER");
    expect(body.client_id).toBe(ANTHROPIC_OAUTH_CLIENT_ID);
  });

  it("falls back to the expected state when the paste has no #state", async () => {
    fetchMock.mockReturnValue(okJson({ access_token: "a", refresh_token: "b", expires_in: 60 }));
    await exchangeAuthorizationCode("BARECODE", "expected-state", "V");
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body);
    expect(body.code).toBe("BARECODE");
    expect(body.state).toBe("expected-state");
  });

  it("keeps the prior refresh token when a refresh response omits one", async () => {
    fetchMock.mockReturnValue(okJson({ access_token: "new-access", expires_in: 3600 }));
    const set = await refreshAccessToken("old-refresh");
    expect(set.accessToken).toBe("new-access");
    expect(set.refreshToken).toBe("old-refresh");
  });

  it("throws a redacted error on a non-2xx token response", async () => {
    fetchMock.mockReturnValue(Promise.resolve({ ok: false, status: 400, text: () => Promise.resolve("secret-token-leak") }));
    await expect(exchangeAuthorizationCode("c", "s", "v")).rejects.toThrow(/HTTP 400/);
    await expect(exchangeAuthorizationCode("c", "s", "v")).rejects.not.toThrow(/secret-token-leak/);
  });

  it("rejects a token response missing required fields", async () => {
    fetchMock.mockReturnValue(okJson({ access_token: "only-access" }));
    await expect(exchangeAuthorizationCode("c", "s", "v")).rejects.toThrow(/missing access_token or refresh_token/);
  });
});
