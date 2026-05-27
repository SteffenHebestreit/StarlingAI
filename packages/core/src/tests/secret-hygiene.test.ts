import { describe, expect, it } from "vitest";
import { inspectSecrets } from "../observability/secret-hygiene.js";

const STRONG_KEY = "QzXzDcSb3fvg1TZKFWxNfEuG-vjHONcDTodrdk-35IZ0JLDvDl0_7vAuYjc7dA4";
const STRONG_JWT = "1KE6nVm-bWsyVR8hAhHxUTsI6hGYGUQtYlS3TJITtLI_CB3cQEOuEFLzypneiuSS";

describe("inspectSecrets", () => {
  it("returns no findings when both secrets are strong and non-templatey", () => {
    expect(inspectSecrets({ SAI_MASTER_KEY: STRONG_KEY, SAI_JWT_SECRET: STRONG_JWT })).toEqual([]);
  });

  it("flags missing secrets", () => {
    const findings = inspectSecrets({ SAI_MASTER_KEY: "", SAI_JWT_SECRET: undefined });
    expect(findings.map((f) => f.severity)).toEqual(["missing", "missing"]);
    expect(findings[0]?.envVar).toBe("SAI_MASTER_KEY");
    expect(findings[1]?.envVar).toBe("SAI_JWT_SECRET");
  });

  it("flags secrets below the minimum length", () => {
    const findings = inspectSecrets({ SAI_MASTER_KEY: "too-short", SAI_JWT_SECRET: STRONG_JWT });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ envVar: "SAI_MASTER_KEY", severity: "short" });
    expect(findings[0]?.detail).toContain("9 chars");
  });

  it("flags .env.example placeholders even when long enough", () => {
    const findings = inspectSecrets({
      SAI_MASTER_KEY: "your-256-bit-master-key-for-credential-encryption",
      SAI_JWT_SECRET: STRONG_JWT,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ envVar: "SAI_MASTER_KEY", severity: "placeholder" });
  });

  it("flags change-me / replace-with templates", () => {
    const findings = inspectSecrets({
      SAI_MASTER_KEY: STRONG_KEY,
      SAI_JWT_SECRET: "replace-with-a-real-jwt-secret-please-now",
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ envVar: "SAI_JWT_SECRET", severity: "placeholder" });
  });

  it("does NOT flag a random secret that happens to contain the substring 'example' (post-tightening)", () => {
    // Regression: the pre-tightening list contained a bare "example" which
    // could false-positive against random secrets. Anchored patterns
    // ("your-example", "example-secret", "example-key") avoid that.
    const benignSecretContainingExample = `${STRONG_KEY}example_marketing_payload_8a3b`;
    const findings = inspectSecrets({
      SAI_MASTER_KEY: benignSecretContainingExample,
      SAI_JWT_SECRET: STRONG_JWT,
    });
    expect(findings).toEqual([]);
  });

  it("trims whitespace before evaluating length and emptiness", () => {
    expect(inspectSecrets({ SAI_MASTER_KEY: "   ", SAI_JWT_SECRET: STRONG_JWT }))
      .toEqual([expect.objectContaining({ envVar: "SAI_MASTER_KEY", severity: "missing" })]);
  });
});
