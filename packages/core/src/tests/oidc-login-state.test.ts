import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The store that carries a sign-in's PKCE verifier across the identity provider's redirect.
 *
 * GET /api/auth/oidc/login is public, and every call stashed an entry for ten minutes in a store
 * with no size limit, walking the whole store first to drop the expired ones. Anyone could grow it
 * without bound, and each further call cost a scan of everything stashed: memory and CPU that grew
 * with the request rate, on the event loop. The store is now capped (the oldest pending sign-in is
 * dropped past the cap) and swept from the front only. The route test drives the REAL login route;
 * only the identity provider's discovery is replaced, by a login URL with a fresh state.
 */

vi.mock("../gateway/oidc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/oidc.js")>();
  let n = 0;
  return {
    ...actual,
    buildLoginUrl: async () => {
      const state = `route-state-${++n}`;
      return { url: `https://idp.example.test/auth?state=${state}`, codeVerifier: `verifier-${n}`, state };
    },
  };
});

const TTL_MS = 600_000;
const FILE_DIR = mkdtempSync(join(tmpdir(), "starlingai-oidc-login-state-"));
const CONFIG_PATH = join(FILE_DIR, "starlingai.json");
let mods: Awaited<ReturnType<typeof loadModules>>;

async function loadModules() {
  writeFileSync(CONFIG_PATH, JSON.stringify({
    gateway: { jwtSecret: "s".repeat(40) },
    workspacePath: FILE_DIR,
    auth: {
      enabled: true,
      provider: "oidc",
      oidc: { issuer: "https://idp.example.test/realms/sai", clientId: "sai", roleMapping: { defaultRole: "viewer" } },
      users: [],
    },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = CONFIG_PATH;
  process.env["SAI_MUTABLE_CONFIG_PATH"] = CONFIG_PATH;
  const oidc = await import("../gateway/oidc.js");
  const { registerAuthRoutes } = await import("../gateway/auth-routes.js");
  const loader = await import("../config/loader.js");
  return { oidc, registerAuthRoutes, loader };
}

beforeAll(async () => {
  mods = await loadModules();
});

afterEach(() => {
  vi.useRealTimers();
  mods.oidc._resetOidcForTests();
});

afterAll(() => {
  mods.loader.resetConfigForTests();
  delete process.env["SAI_CONFIG_PATH"];
  delete process.env["SAI_MUTABLE_CONFIG_PATH"];
  rmSync(FILE_DIR, { recursive: true, force: true });
});

describe("the OIDC login-state store", () => {
  it("holds at most MAX_PENDING_LOGIN_STATES sign-ins, dropping the oldest", () => {
    const { oidc } = mods;
    const cap = oidc.MAX_PENDING_LOGIN_STATES;
    for (let i = 0; i <= cap; i++) oidc.stashLoginState(`s${i}`, `v${i}`);

    expect(oidc._pendingLoginStatesForTests()).toBe(cap);
    expect(oidc.takeLoginState("s0")).toBeNull(); // the oldest made room
    expect(oidc.takeLoginState("s1")).toBe("v1");
    expect(oidc.takeLoginState(`s${cap}`)).toBe(`v${cap}`);
  });

  it("stays bounded however often the public login route is called", async () => {
    const { oidc, registerAuthRoutes } = mods;
    const app = new Hono();
    registerAuthRoutes(app);
    const cap = oidc.MAX_PENDING_LOGIN_STATES;

    let redirects = 0;
    for (let i = 0; i < cap + 25; i++) {
      const res = await app.request("/api/auth/oidc/login");
      if (res.status === 302) redirects++;
    }

    expect(redirects).toBe(cap + 25);
    expect(oidc._pendingLoginStatesForTests()).toBe(cap);
    // The newest sign-in still finishes; the first one started was dropped.
    expect(oidc.takeLoginState(`route-state-${cap + 25}`)).toBe(`verifier-${cap + 25}`);
    expect(oidc.takeLoginState("route-state-1")).toBeNull();
  });

  it("drops expired sign-ins and keeps the live ones", () => {
    const { oidc } = mods;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    oidc.stashLoginState("old-1", "v-old-1");
    oidc.stashLoginState("old-2", "v-old-2");
    vi.setSystemTime(TTL_MS / 2);
    oidc.stashLoginState("live", "v-live");
    vi.setSystemTime(TTL_MS + 1); // the first two are past the TTL, "live" is not
    oidc.stashLoginState("new", "v-new");

    expect(oidc._pendingLoginStatesForTests()).toBe(2);
    expect(oidc.takeLoginState("old-1")).toBeNull();
    expect(oidc.takeLoginState("live")).toBe("v-live");
    expect(oidc.takeLoginState("new")).toBe("v-new");
  });

  it("moves a state stashed again to the back, so it does not hide expired sign-ins from the sweep", () => {
    const { oidc } = mods;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    oidc.stashLoginState("again", "v1");
    vi.setSystemTime(60_000);
    oidc.stashLoginState("stale", "v-stale");
    vi.setSystemTime(TTL_MS / 2);
    oidc.stashLoginState("again", "v2"); // fresh again: it must not stay at the front
    vi.setSystemTime(60_000 + TTL_MS + 1); // "stale" has expired, "again" (re-stashed) has not
    oidc.stashLoginState("trigger", "v-trigger");

    expect(oidc._pendingLoginStatesForTests()).toBe(2);
    expect(oidc.takeLoginState("again")).toBe("v2");
    expect(oidc.takeLoginState("trigger")).toBe("v-trigger");
  });
});
