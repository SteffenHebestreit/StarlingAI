import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPromotedAgents,
  writePromotedAgents,
  promoteEphemeralAgent,
  unpromoteAgent,
  PROMOTION_MIN_SUCCESSES,
  PROMOTION_MIN_SUCCESS_RATE,
} from "../agent/promoted-agents.js";
import type { SubAgentConfig } from "../config/schema.js";

import { PRODUCT } from "../product/index.js";

const makeConfig = (overrides: Partial<SubAgentConfig> = {}): SubAgentConfig => ({
  description: "Test agent",
  capabilities: ["testing"],
  tags: ["test"],
  tools: ["read_file"],
  maxIterations: 3,
  ...overrides,
});

describe("promoted-agents store", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-promoted-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty object when no promotion file exists", () => {
    expect(readPromotedAgents(tempDir)).toEqual({});
  });

  it("round-trips agents through write/read", () => {
    const cfg = makeConfig();
    writePromotedAgents(tempDir, { my_agent: cfg });
    const result = readPromotedAgents(tempDir);
    expect(result["my_agent"]).toBeDefined();
    expect(result["my_agent"]?.description).toBe("Test agent");
  });

  it("promotes an ephemeral agent and persists it", () => {
    const cfg = makeConfig({ description: "Browser login specialist" });
    promoteEphemeralAgent(tempDir, "browser_login", cfg);
    const stored = readPromotedAgents(tempDir);
    expect(stored["browser_login"]).toBeDefined();
  });

  it("does not overwrite an already promoted agent", () => {
    const original = makeConfig({ description: "Original" });
    const updated = makeConfig({ description: "Updated" });
    promoteEphemeralAgent(tempDir, "my_agent", original);
    promoteEphemeralAgent(tempDir, "my_agent", updated);
    const stored = readPromotedAgents(tempDir);
    expect(stored["my_agent"]?.description).toBe("Original");
  });

  it("can unpromote an agent", () => {
    const cfg = makeConfig();
    promoteEphemeralAgent(tempDir, "my_agent", cfg);
    unpromoteAgent(tempDir, "my_agent");
    expect(readPromotedAgents(tempDir)["my_agent"]).toBeUndefined();
  });

  it("unpromote is a no-op for agents not in the store", () => {
    expect(() => unpromoteAgent(tempDir, "non_existent")).not.toThrow();
  });

  it("returns empty object if the file contains invalid JSON", () => {
    const dir = join(tempDir, PRODUCT.stateDirName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "promoted_agents.json"), "not json", "utf-8");
    expect(readPromotedAgents(tempDir)).toEqual({});
  });
});

describe("promotion constants", () => {
  it("minimum successes is at least 3", () => {
    expect(PROMOTION_MIN_SUCCESSES).toBeGreaterThanOrEqual(3);
  });

  it("minimum success rate is at least 60%", () => {
    expect(PROMOTION_MIN_SUCCESS_RATE).toBeGreaterThanOrEqual(0.6);
  });
});
