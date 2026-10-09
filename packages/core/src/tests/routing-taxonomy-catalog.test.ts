/**
 * `lintTaxonomy` against the REAL catalog, which is what it was written for.
 *
 * It had no caller outside its own unit test, where it runs on synthetic fixtures — while
 * section 12 of docs/intent-routing-redesign.md described it as "a CI gate against the real
 * catalog". That gate did not exist. An adversarial review of a design that would promote
 * these labels from a capped bonus to a FILTER found it, and named wiring it a prerequisite
 * rather than a follow-up: a stale label that only nudges a ranking is a nuisance, but a
 * stale label that decides what the turn sees is a silent wrong answer.
 *
 * The checks that matter here are staleness and reachability. `sourceHash` records the
 * catalog text a generated label was derived from, so a description edit that nobody
 * re-labelled is detectable rather than silent.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { lintTaxonomy, resolveRoutingTaxonomy } from "../agent/routing-taxonomy.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CATALOG_PATH = join(REPO_ROOT, "starlingai.json");

type Catalog = {
  subAgents?: Record<string, never>;
  scenes?: Record<string, never>;
  jobs?: Record<string, never>;
};

function loadCatalog(): Catalog {
  return JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as Catalog;
}

describe("the generated catalog's routing taxonomy", () => {
  it("is the real catalog, not a stub", () => {
    const catalog = loadCatalog();
    // Under vitest a bare getConfig() resolves packages/core/starlingai.json, which declares
    // ZERO agents — a gate that ran against that would pass by having nothing to check.
    expect(Object.keys(catalog.subAgents ?? {}).length).toBeGreaterThanOrEqual(40);
    expect(Object.keys(catalog.scenes ?? {}).length).toBeGreaterThan(0);
    expect(Object.keys(catalog.jobs ?? {}).length).toBeGreaterThan(0);
  });

  it("carries a taxonomy on every entry", () => {
    const catalog = loadCatalog();
    const unlabelled: string[] = [];
    for (const [kind, coll] of [["agent", catalog.subAgents], ["scene", catalog.scenes], ["job", catalog.jobs]] as const) {
      for (const [name, entry] of Object.entries(coll ?? {})) {
        if (!resolveRoutingTaxonomy(entry)) unlabelled.push(`${kind} ${name}`);
      }
    }
    // An unlabelled entry is invisible to anything that selects by cell, so it would be
    // silently unroutable by a taxonomy filter rather than merely unranked.
    expect(unlabelled).toEqual([]);
  });

  it("has no STALE label — the catalog text still matches what was labelled", () => {
    const catalog = loadCatalog();
    const stale = lintTaxonomy(catalog).filter((finding) => finding.kind === "stale");
    // Regenerate with the labeller, or pin an authored `routing` block, which always wins.
    expect(stale.map((finding) => `${finding.entry}: ${finding.detail}`)).toEqual([]);
  });

  it("has no INCONSISTENT label", () => {
    const catalog = loadCatalog();
    const inconsistent = lintTaxonomy(catalog).filter((finding) => finding.kind === "inconsistent");
    expect(inconsistent.map((finding) => `${finding.entry}: ${finding.detail}`)).toEqual([]);
  });

  it("CATCHES a stale label — the control that proves the gate above is not vacuous", () => {
    // Every assertion above passes today. That is only meaningful if a real staleness would
    // fail them, so this edits one description the way a maintainer would and checks that the
    // lint notices. Without it, a lint that silently stopped computing hashes would look
    // exactly like a clean catalog.
    const catalog = loadCatalog();
    type Labelled = { description?: string; routing?: unknown; routingGenerated?: { sourceHash?: string } };
    const generated = Object.entries(catalog.subAgents ?? {})
      .map(([name, entry]) => [name, entry as unknown as Labelled] as const)
      .find(([, entry]) => entry.routingGenerated?.sourceHash && !entry.routing);
    expect(generated, "no generated-label agent to test staleness against").toBeDefined();
    const [name, entry] = generated!;

    const edited = {
      subAgents: {
        [name]: { ...entry, description: `${entry.description ?? ""} Now it also files expenses.` },
      },
    } as unknown as Catalog;

    const stale = lintTaxonomy(edited).filter((finding) => finding.kind === "stale");
    expect(stale).toHaveLength(1);
    expect(stale[0]!.entry).toContain(name);
  });

  it("reports the whole lint, so a new finding kind cannot slip past the three above", () => {
    const catalog = loadCatalog();
    const findings = lintTaxonomy(catalog);
    // The assertions above name three kinds. If `lintTaxonomy` grows a fourth, this is what
    // notices — the alternative is a gate that quietly stops checking the new thing.
    expect(
      findings.map((finding) => `[${finding.kind}] ${finding.entry}: ${finding.detail}`),
    ).toEqual([]);
  });
});
