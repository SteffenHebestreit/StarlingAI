/**
 * Every scenario file under eval/e2e/scenarios must load: the contract (src/e2e/scenario.ts), unique
 * ids, compiling regexes, fixtures that exist, sound min/max pairs. CI validates scenarios with this;
 * locally, `pnpm e2e:validate` prints the same problems.
 */
import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { loadScenarios } from "../e2e/loader.js";
import { resolveE2EPaths } from "../e2e/paths.js";

describe("e2e scenario files", () => {
  const paths = resolveE2EPaths();

  it("all validate", () => {
    expect(existsSync(paths.scenariosDir), `${paths.scenariosDir} is missing`).toBe(true);
    const { scenarios, issues } = loadScenarios(paths.scenariosDir, paths.fixturesDir);
    expect(issues.map((issue) => `${issue.file}: ${issue.message}`)).toEqual([]);
    // At least the commented example, so a broken loader cannot pass by loading nothing.
    expect(scenarios.some((entry) => entry.template && entry.scenario.id === "example-site-and-mail")).toBe(true);
  });
});
