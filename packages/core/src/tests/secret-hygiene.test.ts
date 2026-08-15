import { describe, expect, it } from "vitest";
import { inspectSecrets, logSecretHygiene } from "../observability/secret-hygiene.js";

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

describe("logSecretHygiene", () => {
  it("warns on weak secrets and is a no-op when all are strong (never throws)", () => {
    // Pure warning path — must not throw regardless of findings, so a
    // half-configured dev box can still boot.
    expect(() => logSecretHygiene({ SAI_MASTER_KEY: "", SAI_JWT_SECRET: "short" })).not.toThrow();
    expect(() => logSecretHygiene({ SAI_MASTER_KEY: STRONG_KEY, SAI_JWT_SECRET: STRONG_JWT })).not.toThrow();
  });
});

describe("output redaction — identifiers are not secret VALUES", () => {
  it("does not redact an access-key ID's value out of ordinary output", async () => {
    const { scanOutput, refreshSecretValueCache } = await import("../guardrails/output.js");

    // Reproduces the real deployment: SAI_S3_ACCESS_KEY_ID = "starlingai". Redaction
    // is a blind substring replace, so before the identifier exclusion this rewrote
    // every occurrence of the product's own name to [REDACTED:secret] — corrupting
    // prose, .starlingai/ paths, and (as observed) `echo hello_starlingai`.
    const prevId = process.env["SAI_S3_ACCESS_KEY_ID"];
    const prevSecret = process.env["SAI_S3_SECRET_ACCESS_KEY"];
    process.env["SAI_S3_ACCESS_KEY_ID"] = "starlingai";
    process.env["SAI_S3_SECRET_ACCESS_KEY"] = "sk-live-abcdefghijklmnop";
    refreshSecretValueCache();
    try {
      const text = "Command: echo hello_starlingai — wrote .starlingai/report.md";
      const out = scanOutput(text);
      expect(out.redacted ?? text).toContain("hello_starlingai");
      expect(out.redacted ?? text).not.toContain("[REDACTED:secret]");

      // The PAIRED secret is still redacted — the exclusion must not widen the hole.
      const leaked = scanOutput("key is sk-live-abcdefghijklmnop");
      expect(leaked.redacted ?? "").toContain("[REDACTED:secret]");
      expect(leaked.redacted ?? "").not.toContain("sk-live-abcdefghijklmnop");
    } finally {
      if (prevId === undefined) delete process.env["SAI_S3_ACCESS_KEY_ID"]; else process.env["SAI_S3_ACCESS_KEY_ID"] = prevId;
      if (prevSecret === undefined) delete process.env["SAI_S3_SECRET_ACCESS_KEY"]; else process.env["SAI_S3_SECRET_ACCESS_KEY"] = prevSecret;
      refreshSecretValueCache();
    }
  });
});
