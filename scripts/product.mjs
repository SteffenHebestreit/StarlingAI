/**
 * Product identity for repo scripts — the .mjs twin of
 * packages/core/src/product (which serves the TypeScript runtime). Reads the
 * fork-owned product.json at the repo root, falling back to StarlingAI
 * defaults, so scripts stay identity-clean in forks
 * (docs/fork-boilerplate-plan.md WS1).
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULTS = {
  name: "StarlingAI",
  slug: "starlingai",
  tagline: "Guarded Agent Swarm",
  stateDirName: ".starlingai",
  configFileName: "starlingai.json",
  exampleConfigFileName: "starlingai.example.json",
  envPrefix: "STARLINGAI",
  legacyStateDirNames: [],
  legacyEnvPrefixes: [],
};

export const PRODUCT = (() => {
  try {
    const file = join(repoRoot, "product.json");
    if (existsSync(file)) return { ...DEFAULTS, ...JSON.parse(readFileSync(file, "utf8")) };
  } catch (err) {
    console.warn(`[product] failed to read product.json: ${err} — using defaults`);
  }
  return { ...DEFAULTS };
})();
