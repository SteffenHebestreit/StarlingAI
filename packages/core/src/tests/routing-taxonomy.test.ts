/**
 * Routing taxonomy — accessor, catalog lint, and facet agreement.
 *
 * The catalog section runs against the REAL generated config, so it is a live gate on the
 * shipped labels rather than on a fixture: an unlabelled agent, a label gone stale against an
 * edited description, or an internally contradictory one fails here, offline, on every PR.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  facetAgreement,
  lintTaxonomy,
  modesCompatible,
  resolveRoutingTaxonomy,
  taxonomySourceHash,
} from "../agent/routing-taxonomy.js";
import { RoutingTaxonomyGeneratedSchema } from "../config/schema.js";
import type { JobConfig, RoutingTaxonomy, SceneConfig, SubAgentConfig } from "../config/schema.js";

const baseTaxonomy: RoutingTaxonomy = {
  mode: "GATHER",
  domain: ["research"],
  deliverable: ["evidence"],
  completes: ["evidence"],
  inputModality: ["url"],
  riskTier: "read_only",
  executionShape: "single_agent",
  surface: ["external_network"],
};

describe("resolveRoutingTaxonomy", () => {
  it("prefers an authored block over the generated one", () => {
    const resolved = resolveRoutingTaxonomy({
      routing: { ...baseTaxonomy, mode: "VERIFY" },
      routingGenerated: { ...baseTaxonomy, mode: "GATHER", sourceHash: "abc" },
    });
    expect(resolved?.mode).toBe("VERIFY");
    expect(resolved?.source).toBe("authored");
  });

  it("falls back to the generated block and strips its provenance from the taxonomy", () => {
    const resolved = resolveRoutingTaxonomy({
      routingGenerated: { ...baseTaxonomy, oneLiner: "does the thing", sourceHash: "abc", labeledBy: "x", labeledAt: "y" },
    });
    expect(resolved?.source).toBe("generated");
    expect(resolved?.oneLiner).toBe("does the thing");
    expect(resolved).not.toHaveProperty("sourceHash");
    expect(resolved).not.toHaveProperty("labeledBy");
  });

  it("returns undefined for an unlabelled entry rather than inventing a default", () => {
    // A default would make an unlabelled entry score as though it agreed with something.
    expect(resolveRoutingTaxonomy({})).toBeUndefined();
  });
});

describe("lintTaxonomy", () => {
  it("flags an entry with no label", () => {
    const findings = lintTaxonomy({ subAgents: { ghost: { description: "x" } as never } });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe("missing");
  });

  it("flags a label that went stale against an edited description", () => {
    const entry = { description: "original text", capabilities: [], tags: [], tools: [] };
    const hash = taxonomySourceHash(entry);
    const fresh = lintTaxonomy({ subAgents: { a: { ...entry, routingGenerated: { ...baseTaxonomy, sourceHash: hash } } as never } });
    expect(fresh).toHaveLength(0);

    const edited = lintTaxonomy({
      subAgents: { a: { ...entry, description: "rewritten text", routingGenerated: { ...baseTaxonomy, sourceHash: hash } } as never },
    });
    expect(edited.map((finding) => finding.kind)).toEqual(["stale"]);

    // DISCRIMINANCE: an AUTHORED block is a human's deliberate statement and is never
    // called stale — otherwise every override would light up the moment its text changed.
    const authored = lintTaxonomy({
      subAgents: { a: { ...entry, description: "rewritten text", routing: baseTaxonomy, routingGenerated: { ...baseTaxonomy, sourceHash: hash } } as never },
    });
    expect(authored).toHaveLength(0);
  });

  it("flags a coordinator that claims to complete a deliverable alone", () => {
    const findings = lintTaxonomy({
      subAgents: {
        coord: {
          description: "x",
          routing: { ...baseTaxonomy, executionShape: "needs_coordination", deliverable: ["prose_doc"], completes: ["prose_doc"] },
        } as never,
      },
    });
    expect(findings.map((finding) => finding.detail).join(" ")).toContain("needs_coordination but claims to complete");
  });

  it("flags completes that is not among the entry's own deliverables", () => {
    const findings = lintTaxonomy({
      subAgents: { a: { description: "x", routing: { ...baseTaxonomy, deliverable: ["evidence"], completes: ["deck"] } } as never },
    });
    expect(findings.map((finding) => finding.detail).join(" ")).toContain('completes "deck"');
  });

  it("flags cross_domain combined with a specific domain", () => {
    const findings = lintTaxonomy({
      subAgents: { a: { description: "x", routing: { ...baseTaxonomy, domain: ["cross_domain", "research"] } } as never },
    });
    expect(findings.map((finding) => finding.detail).join(" ")).toContain("domain-agnostic sentinel");
  });

  it("flags a scene that is not shaped as a workflow", () => {
    const findings = lintTaxonomy({
      scenes: { s: { description: "x", task: "y", routing: { ...baseTaxonomy, executionShape: "single_agent" } } as never },
    });
    expect(findings.map((finding) => finding.detail).join(" ")).toContain("always a workflow");
  });
});

describe("the shipped catalog", () => {
  // Read the GENERATED config at the repo root, not getConfig(): under vitest that resolves
  // to packages/core/starlingai.json, which declares ZERO agents — the first version of this
  // suite "passed" over an empty set. A gate that cannot fail is worse than no gate, so the
  // catalog is loaded explicitly and its size is asserted before anything else.
  const catalogUrl = new URL("../../../../starlingai.json", import.meta.url);
  let raw: string;
  try {
    raw = readFileSync(catalogUrl, "utf8");
  } catch {
    // The compiled catalog is GENERATED and gitignored. CI builds it before the test
    // steps; locally it is produced by `pnpm config:build`. Say so, rather than failing
    // with an opaque ENOENT that reads like a broken test.
    throw new Error(
      "The generated catalog (starlingai.json at the repo root) is missing. Run `pnpm config:build` first — "
      + "this gate validates the SHIPPED labels and has nothing to check without it.",
    );
  }
  const catalog = JSON.parse(raw) as {
    subAgents: Record<string, SubAgentConfig>;
    scenes: Record<string, SceneConfig>;
    jobs: Record<string, JobConfig>;
  };

  it("is the real catalog, not an empty stub", () => {
    expect(Object.keys(catalog.subAgents).length).toBeGreaterThanOrEqual(40);
    expect(Object.keys(catalog.scenes).length).toBeGreaterThanOrEqual(20);
    expect(Object.keys(catalog.jobs).length).toBeGreaterThanOrEqual(10);
  });

  it("labels every agent, scene and job", () => {
    const unlabelled = [
      ...Object.keys(catalog.subAgents).filter((name) => !resolveRoutingTaxonomy(catalog.subAgents[name])).map((n) => `agent ${n}`),
      ...Object.keys(catalog.scenes).filter((name) => !resolveRoutingTaxonomy(catalog.scenes[name] as never)).map((n) => `scene ${n}`),
      ...Object.keys(catalog.jobs).filter((name) => !resolveRoutingTaxonomy(catalog.jobs[name] as never)).map((n) => `job ${n}`),
    ];
    expect(unlabelled).toEqual([]);
  });

  it("has no stale or internally contradictory labels", () => {
    const findings = lintTaxonomy(catalog);
    expect(findings.map((finding) => `${finding.entry}: ${finding.kind} — ${finding.detail}`)).toEqual([]);
  });

  it("parses every label against the schema, so an invalid enum cannot ship", () => {
    const invalid: string[] = [];
    for (const [name, entry] of Object.entries(catalog.subAgents)) {
      const parsed = RoutingTaxonomyGeneratedSchema.safeParse(entry.routingGenerated);
      if (!parsed.success) invalid.push(`${name}: ${parsed.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
    }
    expect(invalid).toEqual([]);
  });

  it("keeps the coordinators coordinating and the researcher gathering", () => {
    // Spot checks with real names: they are what caught the empty-catalog vacuity above.
    expect(resolveRoutingTaxonomy(catalog.subAgents["mission_coordinator"])?.executionShape).toBe("needs_coordination");
    const researcher = resolveRoutingTaxonomy(catalog.subAgents["researcher"]);
    expect(researcher?.mode).toBe("GATHER");
    expect(researcher?.domain).toContain("research");
    // The sandbox coder family is PRODUCE, not ACT: it mutates nothing external. This is
    // the merge's most-contested call, pinned so a re-label has to argue with a test.
    expect(resolveRoutingTaxonomy(catalog.subAgents["coder"])?.mode).toBe("PRODUCE");
    expect(resolveRoutingTaxonomy(catalog.subAgents["coder"])?.riskTier).toBe("sandbox_exec");
    // …while an agent that really does touch an external system is ACT.
    expect(resolveRoutingTaxonomy(catalog.subAgents["mail_agent"])?.mode).toBe("ACT");
  });
});

describe("facetAgreement", () => {
  const researcher: RoutingTaxonomy = baseTaxonomy;
  const imageCreator: RoutingTaxonomy = {
    ...baseTaxonomy, mode: "PRODUCE", domain: ["media"], deliverable: ["image"], completes: ["image"],
  };

  it("separates intent from subject — the ADR-009 case", () => {
    // "research the best image model for our hardware": the WORK is research; "image" is
    // only the topic. The generator embeds near that topic, which is how it out-ranked the
    // researcher in production; the facets are what pull it back.
    const request = { mode: "GATHER", domain: ["research"] } as const;
    expect(facetAgreement(request, researcher)).toBeGreaterThan(facetAgreement(request, imageCreator));

    // And the converse request must prefer the generator, or the axis is just a constant.
    const makeImage = { mode: "PRODUCE", domain: ["media"], deliverable: "image" } as const;
    expect(facetAgreement(makeImage, imageCreator)).toBeGreaterThan(facetAgreement(makeImage, researcher));
  });

  it("treats cross_domain as a wildcard, not as a mismatch", () => {
    const coordinator: RoutingTaxonomy = { ...baseTaxonomy, mode: "ORCHESTRATE", domain: ["cross_domain"], deliverable: ["none"], completes: [], executionShape: "needs_coordination" };
    const scoped: RoutingTaxonomy = { ...baseTaxonomy, mode: "ORCHESTRATE", domain: ["infra_ops"], deliverable: ["none"], completes: [], executionShape: "needs_coordination" };
    const request = { mode: "GATHER", domain: ["research"] } as const;
    // The cross-domain coordinator applies to a research request; the infra one does not.
    // DISCRIMINANCE: scoring the sentinel as a plain mismatch would push every
    // domain-agnostic coordinator and reviewer below every specialist on every request.
    expect(facetAgreement(request, coordinator)).toBeGreaterThan(facetAgreement(request, scoped));
  });

  it("never lets a coordinator's mode read as a flat mismatch", () => {
    // A classifier reports what the USER wants done; coordination is a decision about how.
    const request = { mode: "PRODUCE", domain: ["software"] } as const;
    const coordinator: RoutingTaxonomy = { ...baseTaxonomy, mode: "ORCHESTRATE", domain: ["software"], deliverable: ["none"], completes: [], executionShape: "needs_coordination" };
    const unrelated: RoutingTaxonomy = { ...baseTaxonomy, mode: "ORCHESTRATE", domain: ["comms"], deliverable: ["none"], completes: [], executionShape: "needs_coordination" };
    expect(facetAgreement(request, coordinator)).toBeGreaterThan(facetAgreement(request, unrelated));
  });

  it("keeps mode compatibility narrow and asymmetric where it matters", () => {
    expect(modesCompatible("GATHER", "VERIFY")).toBe(true);
    expect(modesCompatible("PRODUCE", "ACT")).toBe(true);
    // A greeting matches no catalog entry: `converse` is the abstain label.
    expect(modesCompatible("converse", "GATHER")).toBe(false);
    // Coordination is never satisfied by a leaf specialist's mode.
    expect(modesCompatible("ORCHESTRATE", "PRODUCE")).toBe(false);
  });

  it("is bounded to [0,1] so the fusion bonus cannot be inflated by a lucky label", () => {
    const perfect = { mode: "GATHER", domain: ["research"], deliverable: "evidence" } as const;
    expect(facetAgreement(perfect, researcher)).toBeLessThanOrEqual(1);
    expect(facetAgreement(perfect, researcher)).toBeGreaterThan(0.9);
    expect(facetAgreement({ mode: "converse", domain: [] }, researcher)).toBe(0);
  });
});
