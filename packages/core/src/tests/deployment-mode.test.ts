import { describe, expect, it } from "vitest";
import { evaluateDeploymentReadiness } from "../runtime/deployment-mode.js";

describe("deployment mode readiness", () => {
  it("keeps single-process development ready without distributed services", () => {
    const readiness = evaluateDeploymentReadiness({
      mode: "single_process",
      redisAvailable: false,
      postgresAvailable: false,
      authEnabled: false,
    });
    expect(readiness.ready).toBe(true);
    expect(readiness.dependencies.every((dependency) => !dependency.required)).toBe(true);
  });

  it("fails trusted cluster readiness when either durable coordination dependency is missing", () => {
    const readiness = evaluateDeploymentReadiness({
      mode: "trusted_cluster",
      redisAvailable: true,
      postgresAvailable: false,
      authEnabled: false,
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "redis", required: true, available: true }),
      expect.objectContaining({ name: "postgres", required: true, available: false }),
    ]));
  });

  it("requires authentication in untrusted multi-tenant mode", () => {
    const missingAuth = evaluateDeploymentReadiness({
      mode: "untrusted_multi_tenant",
      redisAvailable: true,
      postgresAvailable: true,
      authEnabled: false,
    });
    const ready = evaluateDeploymentReadiness({
      mode: "untrusted_multi_tenant",
      redisAvailable: true,
      postgresAvailable: true,
      authEnabled: true,
    });
    expect(missingAuth.ready).toBe(false);
    expect(missingAuth.dependencies).toContainEqual(expect.objectContaining({ name: "authentication", required: true, available: false }));
    expect(ready.ready).toBe(true);
  });
});