import { afterEach, describe, expect, it } from "vitest";
import {
  _resetRoutePoliciesForTests,
  decideRoutePolicyChain,
  evaluateRoutePolicy,
  findRoutePolicy,
  policyAdmitsRole,
  registerRoutePolicies,
  routePolicyChain,
  routePolicyForbiddenMessage,
  type RoutePolicy,
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

describe("deny-roles policies", () => {
  const caller = (role: string) => ({ role });

  it("passes an anonymous caller on to the route's own auth and refuses only the listed roles", () => {
    const policy: RoutePolicy = { pattern: "/api/*", denyRoles: ["guest"] };
    expect(evaluateRoutePolicy(policy, null)).toBe("pass");
    expect(evaluateRoutePolicy(policy, caller("guest"))).toBe("forbidden");
    expect(evaluateRoutePolicy(policy, caller("viewer"))).toBe("pass");
    expect(evaluateRoutePolicy(policy, caller("admin"))).toBe("pass");
    expect(routePolicyForbiddenMessage(policy, "guest")).toBe("Not permitted for role guest");
  });

  it("denies exactly the listed role: the built-in chain is not inherited either way", () => {
    expect(evaluateRoutePolicy({ pattern: "/x", denyRoles: ["viewer"] }, caller("operator"))).toBe("pass");
    expect(evaluateRoutePolicy({ pattern: "/x", denyRoles: ["admin"] }, caller("viewer"))).toBe("pass");
    expect(policyAdmitsRole({ denyRoles: ["viewer"] }, "viewer")).toBe(false);
    expect(policyAdmitsRole({ denyRoles: ["viewer"] }, "operator")).toBe(true);
  });

  it("keeps the roles form as it was: no caller is unauthorized, an unlisted role forbidden", () => {
    const policy: RoutePolicy = { pattern: "/api/admin/*", roles: ["operator"] };
    expect(evaluateRoutePolicy(policy, null)).toBe("unauthorized");
    expect(evaluateRoutePolicy(policy, caller("viewer"))).toBe("forbidden");
    expect(evaluateRoutePolicy(policy, caller("operator"))).toBe("allow");
    expect(evaluateRoutePolicy(policy, caller("admin"))).toBe("allow");
    expect(evaluateRoutePolicy(policy, caller("guest"))).toBe("forbidden");
    expect(evaluateRoutePolicy({ pattern: "/x", roles: [] }, caller("admin"))).toBe("forbidden");
    expect(routePolicyForbiddenMessage(policy, "viewer")).toBe("Requires role: operator");
  });

  it("refuses a policy with both forms or neither, and registers none of the batch", () => {
    const both = { pattern: "/api/x", roles: ["admin"], denyRoles: ["viewer"] } as unknown as RoutePolicy;
    const neither = { pattern: "/api/y" } as unknown as RoutePolicy;
    const notAList = { pattern: "/api/z", denyRoles: "viewer" } as unknown as RoutePolicy;
    expect(() => registerRoutePolicies("test", [{ pattern: "/api/ok", roles: ["admin"] }, both])).toThrow(/exactly one of/);
    expect(() => registerRoutePolicies("test", [neither])).toThrow(/exactly one of/);
    expect(() => registerRoutePolicies("test", [notAList])).toThrow(/list of role names/);
    expect(findRoutePolicy("GET", "/api/ok")).toBeNull();
    expect(findRoutePolicy("GET", "/api/x")).toBeNull();
  });
});

describe("the policies that decide a request", () => {
  const caller = (role: string) => ({ role });
  const decide = (method: string, path: string, who: { role: string } | null) =>
    decideRoutePolicyChain(routePolicyChain(method, path), () => (who ? [who] : []));

  it("passes a caller a deny policy does not name on to the next matching policy", () => {
    // As at boot: an extension's deny catch-all registers first, core's own roles policy after it.
    registerRoutePolicies("fork", [{ pattern: "/api/*", denyRoles: ["guest"] }]);
    registerRoutePolicies("core", [{ method: "POST", pattern: "/api/knowledge-bases", roles: ["operator"] }]);
    expect(decide("POST", "/api/knowledge-bases", caller("guest"))).toMatchObject({ verdict: "forbidden", policy: { source: "fork" } });
    // Without the chain the deny policy ended the search, and a fork role core's policy refuses got in.
    expect(decide("POST", "/api/knowledge-bases", caller("doctor"))).toMatchObject({ verdict: "forbidden", policy: { source: "core" } });
    expect(decide("POST", "/api/knowledge-bases", caller("admin"))).toMatchObject({ verdict: "allow", policy: { source: "core" } });
    expect(decide("POST", "/api/knowledge-bases", null)).toMatchObject({ verdict: "unauthorized", policy: { source: "core" } });
    // A route only the deny policy covers: whoever it does not name reaches the route's own auth.
    expect(decide("GET", "/api/sessions", caller("doctor"))).toEqual({ verdict: "pass", policy: null, caller: null });
    expect(decide("GET", "/api/sessions", null)).toEqual({ verdict: "pass", policy: null, caller: null });
    // findRoutePolicy still reports the first match.
    expect(findRoutePolicy("POST", "/api/knowledge-bases")?.source).toBe("fork");
  });

  it("lets the first matching roles policy decide; a deny policy behind it is not consulted", () => {
    registerRoutePolicies("fork", [
      { pattern: "/api/patients/*", roles: ["doctor", "guest"] },
      { pattern: "/api/*", denyRoles: ["guest"] },
    ]);
    expect(routePolicyChain("GET", "/api/patients/1").map((policy) => policy.pattern)).toEqual(["/api/patients/*"]);
    expect(decide("GET", "/api/patients/1", caller("guest")).verdict).toBe("allow");
    expect(decide("GET", "/api/other", caller("guest")).verdict).toBe("forbidden");
  });

  it("an empty deny list drops the deny policies after it, never a roles policy", () => {
    registerRoutePolicies("fork", [
      { pattern: "/api/product", denyRoles: [] },
      { pattern: "/api/*", denyRoles: ["guest"] },
    ]);
    expect(routePolicyChain("GET", "/api/product")).toEqual([]);
    expect(decide("GET", "/api/product", caller("guest")).verdict).toBe("pass");
    expect(decide("GET", "/api/sessions", caller("guest")).verdict).toBe("forbidden");
    registerRoutePolicies("core", [{ pattern: "/api/product", roles: ["admin"] }]);
    expect(decide("GET", "/api/product", caller("viewer"))).toMatchObject({ verdict: "forbidden", policy: { source: "core" } });
    expect(decide("GET", "/api/product", caller("admin")).verdict).toBe("allow");
  });

  it("refuses a request when any caller it presents is refused", () => {
    registerRoutePolicies("fork", [{ pattern: "/ws", denyRoles: ["guest"] }]);
    const chain = routePolicyChain("GET", "/ws");
    expect(decideRoutePolicyChain(chain, () => [caller("operator"), caller("guest")])).toMatchObject({ verdict: "forbidden", caller: { role: "guest" } });
    expect(decideRoutePolicyChain(chain, () => [caller("operator"), caller("viewer")]).verdict).toBe("pass");
  });

  it("matches a path given as decoded segments, a segment holding a slash staying one segment", () => {
    registerRoutePolicies("fork", [{ pattern: "/a2a/agents/:name", roles: ["admin"] }]);
    expect(routePolicyChain("POST", ["a2a", "agents", "a/b"])).toHaveLength(1);
    expect(routePolicyChain("POST", ["a2a", "agents", "a", "b"])).toHaveLength(0);
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
