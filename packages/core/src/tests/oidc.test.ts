import { describe, it, expect } from "vitest";
import { mapRole } from "../gateway/oidc.js";
import { OidcConfigSchema } from "../config/schema.js";

function cfg(roleMapping: Record<string, unknown>) {
  return OidcConfigSchema.parse({
    issuer: "https://keycloak.example.com/realms/starlingai",
    clientId: "starlingai",
    roleMapping,
  });
}

describe("oidc role mapping", () => {
  it("maps the MOST-privileged listed IdP role (admin > operator > viewer)", () => {
    const c = cfg({ admin: ["sai-admin"], operator: ["sai-op"], viewer: ["sai-view"] });
    expect(mapRole(c, ["sai-view", "sai-admin"])).toBe("admin");   // admin wins over viewer
    expect(mapRole(c, ["sai-op", "sai-view"])).toBe("operator");   // operator wins over viewer
    expect(mapRole(c, ["sai-view"])).toBe("viewer");
  });

  it("falls back to defaultRole when no IdP role matches, else rejects (null)", () => {
    expect(mapRole(cfg({ operator: ["x"], defaultRole: "viewer" }), ["unmapped"])).toBe("viewer");
    expect(mapRole(cfg({ operator: ["x"] }), ["unmapped"])).toBeNull(); // no match, no default → reject
    expect(mapRole(cfg({ admin: ["a"] }), [])).toBeNull();             // no roles at all → reject
  });

  it("does not grant a role just because the mapping list is empty", () => {
    // An empty admin list must never match — only explicit role names grant access.
    const c = cfg({ admin: [], operator: ["sai-op"], viewer: [] });
    expect(mapRole(c, ["sai-op"])).toBe("operator");
    expect(mapRole(c, ["anything"])).toBeNull();
  });
});

describe("oidc A2A audience requirement (prevents audience confusion)", () => {
  const base = { issuer: "https://kc.example.com/realms/sai", clientId: "sai", roleMapping: {} };

  it("rejects a config that enables A2A without an audience", () => {
    // Without an audience, ANY realm-signed token (incl. a human's) would authorize A2A —
    // so enabling a2a without an audience must fail config validation.
    expect(() => OidcConfigSchema.parse({ ...base, a2a: { enabled: true } })).toThrow(/audience is required/i);
    expect(() => OidcConfigSchema.parse({ ...base, a2a: { enabled: true, audience: "  " } })).toThrow(/audience is required/i);
  });

  it("accepts A2A with an audience, and A2A disabled with none", () => {
    expect(() => OidcConfigSchema.parse({ ...base, a2a: { enabled: true, audience: "sai-a2a" } })).not.toThrow();
    expect(() => OidcConfigSchema.parse({ ...base, a2a: { enabled: false } })).not.toThrow();
    expect(() => OidcConfigSchema.parse(base)).not.toThrow(); // a2a omitted entirely
  });
});
