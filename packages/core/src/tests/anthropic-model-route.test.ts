/**
 * The Claude model-listing ROUTE: warm-on-first-read, and cache invalidation.
 *
 * An adversarial review of the first cut of this feature found its two worst
 * defects here, in the one file that had no test:
 *
 *   1. Nothing warmed the catalogue. The cache had exactly one writer — the
 *      manual refresh handler — so every gateway boot served the hand-maintained
 *      fallback until a human happened to click a button. The feature did not
 *      remove the staleness it was written to remove; it added an escape hatch.
 *   2. Nothing invalidated the catalogue. Disconnecting an account left its
 *      model list being served under a `source: "live"` label.
 *
 * Both are route-level behaviours, invisible to a provider-level test. So these
 * drive the real Hono app against a stub /v1/models.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";

const listedIds: string[] = [];
let upstreamStatus = 200;
let upstreamHits = 0;
let baseUrl = "";
/** The configured providers.anthropic.apiKey. Set to null for OAuth-only tests. */
let configApiKey: string | null = "sk-ant-api03-test";

vi.mock("../gateway/auth.js", () => ({
  verifyToken: vi.fn(async () => true),
  extractBearerToken: (header: string | undefined) => header?.replace(/^Bearer /, "") ?? null,
}));

const storedToken: { value: { accessToken: string; refreshToken: string; expiresAt: number } | null } = { value: null };

vi.mock("../providers/anthropic-oauth.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../providers/anthropic-oauth.js")>();
  return {
    ...original,
    loadStoredTokenSet: () => storedToken.value,
    storeTokenSet: vi.fn(),
    clearStoredTokenSet: () => { storedToken.value = null; },
    getValidAccessToken: async () => storedToken.value?.accessToken ?? null,
  };
});

vi.mock("../config/loader.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../config/loader.js")>();
  return {
    ...original,
    getConfig: vi.fn(() => {
      const base = original.getConfig();
      return {
        ...base,
        providers: {
          ...base.providers,
          anthropic: {
            ...(base.providers.anthropic ?? {}),
            baseUrl,
            ...(configApiKey ? { apiKey: configApiKey } : { apiKey: undefined }),
          },
        },
      };
    }),
    updateConfig: vi.fn((mutate: (raw: Record<string, unknown>) => void) => {
      mutate({});
      return original.getConfig();
    }),
  };
});

let server: http.Server;

beforeEach(async () => {
  listedIds.length = 0;
  upstreamStatus = 200;
  upstreamHits = 0;
  server = http.createServer((_req, res) => {
    upstreamHits += 1;
    res.writeHead(upstreamStatus, { "content-type": "application/json" });
    res.end(JSON.stringify(upstreamStatus === 200
      ? {
        data: listedIds.map((id) => ({
          type: "model", id, display_name: id, created_at: "2026-01-01T00:00:00Z",
          max_input_tokens: 1_000_000, max_tokens: 128_000, capabilities: null,
        })),
        has_more: false, first_id: null, last_id: null,
      }
      : { type: "error", error: { type: "permission_error", message: "not permitted" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  storedToken.value = null;
  configApiKey = "sk-ant-api03-test";
  // The catalogue cache and the attempted-flag live in the route module's own
  // scope. Re-importing per test is what gives each one a cold gateway; without
  // it every test after the first inherits the previous test's warm cache and
  // asserts nothing.
  vi.resetModules();
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A cold gateway: fresh module instance, therefore an empty catalogue cache. */
async function makeApp(): Promise<Hono> {
  const { registerModelPresetRoutes } = await import("../gateway/model-preset-routes.js");
  const app = new Hono();
  registerModelPresetRoutes(app);
  return app;
}

async function getModel(app: Hono) {
  const res = await app.request("/api/models/anthropic/model", {
    headers: { Authorization: "Bearer test-token" },
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

async function postRefresh(app: Hono) {
  const res = await app.request("/api/models/anthropic/model/refresh", {
    method: "POST",
    headers: { Authorization: "Bearer test-token" },
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe("GET /api/models/anthropic/model — warm on first read", () => {
  it("asks Anthropic on the first read instead of waiting for a button press", async () => {
    listedIds.push("claude-opus-5", "claude-sonnet-5");
    const app = await makeApp();

    const { body } = await getModel(app);

    expect(upstreamHits).toBe(1);
    expect(body.source).toBe("live");
    expect((body.choices as Array<{ id: string }>).map((c) => c.id)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
  });

  it("does not re-ask on every dashboard open once it has an answer", async () => {
    listedIds.push("claude-opus-5");
    const app = await makeApp();

    await getModel(app);
    await getModel(app);
    await getModel(app);

    expect(upstreamHits).toBe(1);
  });

  it("tries once and then stops when listing is not permitted, rather than on every open", async () => {
    // An inference-scoped subscription token 403s here every single time. The
    // whole point of the attempted-flag is that this does not become an upstream
    // call per dashboard visit.
    upstreamStatus = 403;
    const app = await makeApp();

    const first = await getModel(app);
    await getModel(app);
    await getModel(app);

    expect(first.body.source).toBe("builtin");
    expect(upstreamHits).toBe(1);
  });

  it("still answers with a usable list when Anthropic refuses", async () => {
    upstreamStatus = 403;
    const app = await makeApp();

    const { status, body } = await getModel(app);

    expect(status).toBe(200);
    expect((body.choices as unknown[]).length).toBeGreaterThan(0);
    expect(body.refreshedAt).toBeNull();
  });
});

describe("cache invalidation on credential change", () => {
  it("stops serving a disconnected account's catalogue once no credential is left", async () => {
    // The defect this pins: disconnect cleared the token but left the catalogue,
    // so the picker kept offering one account's entitlements under a freshness
    // label carrying the date that account fetched.
    configApiKey = null; // subscription only, so disconnecting leaves nothing
    storedToken.value = { accessToken: "sk-ant-oat01-a", refreshToken: "r", expiresAt: Date.now() + 3_600_000 };
    listedIds.push("claude-opus-5", "claude-fable-5-1");
    const app = await makeApp();

    const warmed = await getModel(app);
    expect(warmed.body.source).toBe("live");

    await app.request("/api/models/anthropic/oauth/disconnect", {
      method: "POST",
      headers: { Authorization: "Bearer test-token" },
    });

    const after = await getModel(app);
    expect(after.body.source).toBe("builtin");
    expect(after.body.refreshedAt).toBeNull();
  });

  it("re-lists under the remaining credential rather than reusing the disconnected account's catalogue", async () => {
    // With an API key ALSO configured, disconnecting a subscription is a
    // credential change, not a credential loss — the right behaviour is to ask
    // again under what is left. A live re-fetch is the observable proof the
    // cache was actually dropped rather than re-served.
    storedToken.value = { accessToken: "sk-ant-oat01-a", refreshToken: "r", expiresAt: Date.now() + 3_600_000 };
    listedIds.push("claude-opus-5", "claude-fable-5-1");
    const app = await makeApp();

    await getModel(app);
    expect(upstreamHits).toBe(1);

    // What the API key is entitled to, which is not what the subscription saw.
    listedIds.length = 0;
    listedIds.push("claude-haiku-4-5");

    await app.request("/api/models/anthropic/oauth/disconnect", {
      method: "POST",
      headers: { Authorization: "Bearer test-token" },
    });

    const after = await getModel(app);
    expect(upstreamHits).toBe(2);
    expect((after.body.choices as Array<{ id: string }>).map((c) => c.id)).toEqual(["claude-haiku-4-5"]);
  });
});

describe("POST /api/models/anthropic/model/refresh", () => {
  it("re-asks Anthropic even when the catalogue is already warm", async () => {
    listedIds.push("claude-opus-5");
    const app = await makeApp();
    await getModel(app);
    expect(upstreamHits).toBe(1);

    listedIds.push("claude-sonnet-5");
    const { body } = await postRefresh(app);

    expect(upstreamHits).toBe(2);
    expect((body.choices as Array<{ id: string }>).map((c) => c.id)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
  });

  it("keeps the catalogue on screen when a later refresh fails, and says so", async () => {
    // The first cut returned source:"live" with a cached list while the warning
    // said "Showing the built-in list" — telling the user the opposite of what
    // the same response rendered.
    listedIds.push("claude-opus-5");
    const app = await makeApp();
    await getModel(app);

    upstreamStatus = 403;
    const { body } = await postRefresh(app);

    expect(body.source).toBe("live");
    expect(body.stale).toBe(true);
    expect((body.choices as Array<{ id: string }>).map((c) => c.id)).toEqual(["claude-opus-5"]);
    expect(String(body.warning)).not.toMatch(/showing the built-in list/i);
  });
});
