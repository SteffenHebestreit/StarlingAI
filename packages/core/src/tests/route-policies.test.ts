import { afterEach, describe, expect, it } from "vitest";
import {
  _resetRoutePoliciesForTests,
  findRoutePolicy,
  policyAdmitsRole,
  registerRoutePolicies,
} from "../gateway/route-policies.js";
import { roleRank, userHasRole } from "../gateway/auth.js";
import { _recordLoadedExtension, _resetExtensionsForTests } from "../extension/index.js";

afterEach(() => {
  _resetRoutePoliciesForTests();
  _resetExtensionsForTests();
});

describe("route policy matching", () => {
  it("matches exact paths and respects the method filter", () => {
    registerRoutePolicies("test", [
      { method: "POST", pattern: "/api/knowledge/refresh", roles: ["admin"] },
    ]);
    expect(findRoutePolicy("POST", "/api/knowledge/refresh")?.roles).toEqual(["admin"]);
    expect(findRoutePolicy("GET", "/api/knowledge/refresh")).toBeNull();
    expect(findRoutePolicy("POST", "/api/knowledge/status")).toBeNull();
  });

  it("matches :param segments exactly one segment deep", () => {
    registerRoutePolicies("test", [{ pattern: "/api/sites/:hostname", roles: ["admin"] }]);
    expect(findRoutePolicy("DELETE", "/api/sites/example.com")).not.toBeNull();
    expect(findRoutePolicy("DELETE", "/api/sites")).toBeNull();
    expect(findRoutePolicy("DELETE", "/api/sites/a/b")).toBeNull();
  });

  it("matches trailing wildcards including the empty remainder", () => {
    registerRoutePolicies("test", [{ pattern: "/api/admin/*", roles: ["admin"] }]);
    expect(findRoutePolicy("GET", "/api/admin/users")).not.toBeNull();
    expect(findRoutePolicy("GET", "/api/admin/users/42/sessions")).not.toBeNull();
    expect(findRoutePolicy("GET", "/api/adminx")).toBeNull();
  });

  it("first registered match wins", () => {
    registerRoutePolicies("first", [{ pattern: "/api/x/*", roles: ["a"] }]);
    registerRoutePolicies("second", [{ pattern: "/api/x/y", roles: ["b"] }]);
    expect(findRoutePolicy("GET", "/api/x/y")?.roles).toEqual(["a"]);
  });

  it("rejects patterns that do not start with a slash", () => {
    expect(() => registerRoutePolicies("test", [{ pattern: "api/x", roles: [] }])).toThrow(/must start/);
  });

  it("ignores query strings when matching", () => {
    registerRoutePolicies("test", [{ pattern: "/api/knowledge/status", roles: ["mfa"] }]);
    expect(findRoutePolicy("GET", "/api/knowledge/status?verbose=1")).not.toBeNull();
  });
});

describe("policyAdmitsRole", () => {
  it("admits higher built-in roles through a policy that lists a lower one", () => {
    expect(policyAdmitsRole({ roles: ["operator"] }, "admin")).toBe(true);
    expect(policyAdmitsRole({ roles: ["operator"] }, "operator")).toBe(true);
    expect(policyAdmitsRole({ roles: ["viewer"] }, "operator")).toBe(true);
    expect(policyAdmitsRole({ roles: ["operator"] }, "viewer")).toBe(false);
    expect(policyAdmitsRole({ roles: ["admin"] }, "operator")).toBe(false);
    expect(policyAdmitsRole({ roles: [] }, "admin")).toBe(false);
  });

  it("never lets an extension role inherit, in either direction", () => {
    expect(policyAdmitsRole({ roles: ["patient"] }, "viewer")).toBe(false);
    expect(policyAdmitsRole({ roles: ["operator"] }, "doctor")).toBe(false);
    expect(policyAdmitsRole({ roles: ["doctor"] }, "doctor")).toBe(true);
    expect(policyAdmitsRole({ roles: ["doctor"] }, "admin")).toBe(false);
  });
});

describe("role ranks with extension roles", () => {
  it("ranks built-ins and fails closed on unknown roles", () => {
    expect(roleRank("operator")).toBeGreaterThan(roleRank("viewer"));
    expect(roleRank("nonexistent")).toBe(-1);
    expect(userHasRole({ username: "x", role: "operator" }, "nonexistent")).toBe(false);
  });

  it("uses extension registry ranks for fork roles", () => {
    _recordLoadedExtension(
      { name: "med", version: "1", toolNames: [], auditEvents: [], roles: [
        { name: "patient", description: "p", rank: 10 },
        { name: "doctor", description: "d", rank: 80 },
      ], loadedAt: "", source: "test" },
      { name: "med", version: "1", roles: [
        { name: "patient", description: "p", rank: 10 },
        { name: "doctor", description: "d", rank: 80 },
      ] },
    );
    expect(userHasRole({ username: "d", role: "doctor" }, "operator")).toBe(true);
    expect(userHasRole({ username: "p", role: "patient" }, "operator")).toBe(false);
    expect(userHasRole({ username: "p", role: "patient" }, "viewer")).toBe(true);
  });
});
