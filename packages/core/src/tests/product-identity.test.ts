import { describe, expect, it } from "vitest";
import {
  PRODUCT,
  resolveProductFile,
  reloadProduct,
  productEnv,
  homeStateDir,
  cwdStateDir,
  stateDirUnder,
  existingStateFile,
} from "../product/index.js";

// Pure product-identity path/env helpers (used everywhere for state-dir resolution). No I/O beyond
// existence probes on paths that do not exist, so these are safe to exercise directly.
describe("product identity helpers", () => {
  it("joins home/cwd/base state dirs under the product state-dir name", () => {
    expect(homeStateDir("plugins")).toContain(PRODUCT.stateDirName);
    expect(homeStateDir("plugins").endsWith("plugins")).toBe(true);
    expect(cwdStateDir("skills")).toContain(PRODUCT.stateDirName);
    const under = stateDirUnder("/base-xyz", "sub", "leaf");
    expect(under).toContain(PRODUCT.stateDirName);
    expect(under.endsWith("leaf")).toBe(true);
  });

  it("existingStateFile returns the canonical path when nothing exists on disk", () => {
    const p = existingStateFile("/nonexistent-base-abc123", "nofile.json");
    expect(p).toContain(PRODUCT.stateDirName);
    expect(p.endsWith("nofile.json")).toBe(true);
  });

  it("productEnv reads a product-prefixed env var, else undefined", () => {
    const key = `${PRODUCT.envPrefix}_COVTEST_VAR`;
    process.env[key] = "hit";
    try {
      expect(productEnv("COVTEST_VAR")).toBe("hit");
    } finally {
      delete process.env[key];
    }
    expect(productEnv("DEFINITELY_UNSET_COVTEST_VAR")).toBeUndefined();
  });

  it("resolveProductFile returns a path or null; reloadProduct mutates the live identity in place", () => {
    const f = resolveProductFile();
    expect(f === null || typeof f === "string").toBe(true);
    const id = reloadProduct();
    expect(id).toBe(PRODUCT); // in-place mutation → same live object
    expect(typeof id.name).toBe("string");
    expect(typeof id.stateDirName).toBe("string");
  });
});
