/**
 * Routing taxonomy (IDCM) — accessors and catalog hygiene.
 *
 * The taxonomy is one structured block carried by agents, scenes and jobs alike, so all
 * three compete in a single retrieval pass on the same axes. Its reason for existing is the
 * failure ADR-009 records: a single description vector embeds near the request's SUBJECT, so
 * "research the best image model" ranked the image GENERATOR above the researcher. A
 * description cannot separate what the request asks for from what it is about; two labelled
 * axes can — L1 is the execution mode (GATHER), L2 the domain of the work (research), and
 * "image" is only the topic.
 *
 * Nothing here decides routing. These are the reader and the hygiene checks; the fusion that
 * uses the labels lives with the router, and — by design — uses them as bounded boosts that
 * reorder an already-admitted candidate set, never as gates that admit or evict.
 */

import { createHash } from "node:crypto";
import type { JobConfig, RoutingTaxonomy, SceneConfig, SubAgentConfig } from "../config/schema.js";

/** Any catalog entry that can carry the taxonomy. */
export type TaxonomyBearing = Pick<SubAgentConfig, "routing" | "routingGenerated">
  & { description?: string; capabilities?: string[]; tags?: string[]; tools?: string[]; task?: string; allowedAgents?: string[] };

export interface ResolvedTaxonomy extends RoutingTaxonomy {
  /** "authored" when a human set it explicitly, "generated" when it came from the labeller. */
  source: "authored" | "generated";
  oneLiner?: string;
}

/**
 * The effective taxonomy for an entry: an AUTHORED block always wins.
 *
 * The split exists so the generated file can be regenerated wholesale without destroying a
 * human's deliberate correction — the failure mode of every "generated + hand-edited in
 * place" file.
 */
export function resolveRoutingTaxonomy(entry: TaxonomyBearing | undefined): ResolvedTaxonomy | undefined {
  if (!entry) return undefined;
  if (entry.routing) return { ...entry.routing, source: "authored" };
  if (entry.routingGenerated) {
    const { oneLiner, sourceHash: _sourceHash, labeledBy: _labeledBy, labeledAt: _labeledAt, ...taxonomy } = entry.routingGenerated;
    return { ...taxonomy, source: "generated", ...(oneLiner ? { oneLiner } : {}) };
  }
  return undefined;
}

/**
 * Hash of the catalog text a label was derived from.
 *
 * Labels are generated from an entry's own description/capabilities/tags/tools. When that
 * text changes the label may no longer describe the entry, and a silently stale label is
 * worse than a missing one: it keeps scoring, just wrongly. `tools` is included because it
 * is what `riskTier` and `surface` are derived from.
 */
export function taxonomySourceHash(entry: {
  description?: string;
  capabilities?: string[];
  tags?: string[];
  tools?: string[];
  steps?: unknown;
  task?: string;
  allowedAgents?: string[];
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      d: entry.description,
      c: entry.capabilities ?? [],
      t: entry.tags ?? [],
      tl: entry.tools ?? entry.steps ?? null,
      // A SCENE carries none of the fields above beyond its description: what it does lives
      // entirely in `task`, and which specialists it may use in `allowedAgents`. Without
      // these a scene could be rewritten end to end — gaining an outbound send, say, which
      // changes its real riskTier and surface — while its label kept validating.
      k: entry.task ?? null,
      a: entry.allowedAgents ?? null,
    }))
    .digest("hex")
    .slice(0, 16);
}

export interface TaxonomyLintFinding {
  entry: string;
  kind: "missing" | "stale" | "inconsistent";
  detail: string;
}

/**
 * Consistency checks that do NOT need an embedding backend, so they can gate every PR.
 *
 * These are the internal contradictions a labelling pass can produce, each of which would
 * quietly distort routing rather than fail loudly:
 *  - an entry with no label at all is invisible to every facet comparison,
 *  - a stale label describes an entry the catalog no longer has,
 *  - `completes` on a needs_coordination entry claims a coordinator finishes work alone,
 *    which is the single bit the "can one agent do this?" check reads,
 *  - a `completes` deliverable the entry does not even produce,
 *  - `cross_domain` paired with a real domain: the sentinel means "domain-agnostic", so the
 *    pairing is a contradiction rather than a refinement,
 *  - a scene or job that is not shaped as a workflow.
 */
export function lintTaxonomy(catalog: {
  subAgents?: Record<string, SubAgentConfig>;
  scenes?: Record<string, SceneConfig>;
  jobs?: Record<string, JobConfig>;
}): TaxonomyLintFinding[] {
  const findings: TaxonomyLintFinding[] = [];

  const check = (
    kind: "agent" | "scene" | "job",
    name: string,
    entry: TaxonomyBearing & { steps?: unknown },
  ): void => {
    const label = `${kind} ${name}`;
    const taxonomy = resolveRoutingTaxonomy(entry);
    if (!taxonomy) {
      findings.push({ entry: label, kind: "missing", detail: "no routing or routingGenerated block" });
      return;
    }
    if (entry.routingGenerated?.sourceHash && !entry.routing) {
      const expected = taxonomySourceHash(entry);
      if (expected !== entry.routingGenerated.sourceHash) {
        findings.push({
          entry: label,
          kind: "stale",
          detail: `catalog text changed since labelling (hash ${entry.routingGenerated.sourceHash} → ${expected}); re-label or set an authored routing block`,
        });
      }
    }
    if (taxonomy.executionShape === "needs_coordination" && taxonomy.completes.length > 0) {
      findings.push({
        entry: label,
        kind: "inconsistent",
        detail: `needs_coordination but claims to complete ${taxonomy.completes.join(", ")} alone`,
      });
    }
    for (const completed of taxonomy.completes) {
      if (!taxonomy.deliverable.includes(completed)) {
        findings.push({
          entry: label,
          kind: "inconsistent",
          detail: `completes "${completed}" which is not among its deliverables (${taxonomy.deliverable.join(", ") || "none"})`,
        });
      }
    }
    if (taxonomy.domain.includes("cross_domain") && taxonomy.domain.length > 1) {
      findings.push({
        entry: label,
        kind: "inconsistent",
        detail: "cross_domain is a domain-agnostic sentinel and cannot be combined with a specific domain",
      });
    }
    if ((kind === "scene" || kind === "job") && taxonomy.executionShape !== "workflow") {
      findings.push({
        entry: label,
        kind: "inconsistent",
        detail: `executionShape "${taxonomy.executionShape}" — a scene/job is always a workflow`,
      });
    }
  };

  for (const [name, entry] of Object.entries(catalog.subAgents ?? {})) check("agent", name, entry);
  for (const [name, entry] of Object.entries(catalog.scenes ?? {})) check("scene", name, entry as TaxonomyBearing);
  for (const [name, entry] of Object.entries(catalog.jobs ?? {})) check("job", name, entry as TaxonomyBearing & { steps?: unknown });
  return findings;
}

// ── Facet agreement ───────────────────────────────────────────────────────────

/** The request-side labels a classifier produces. Deliberately a subset of the entry-side
 *  taxonomy: a request has an intent and a domain, not an execution shape or a risk tier. */
export interface RequestFacets {
  mode: RoutingTaxonomy["mode"] | "converse";
  /** Readonly so a caller can pass a literal tuple without a copy. */
  domain: readonly RoutingTaxonomy["domain"][number][];
  deliverable?: RoutingTaxonomy["deliverable"][number];
}

/**
 * Modes that a request-side label may satisfy from an entry-side label.
 *
 * Compatibility is asymmetric and deliberately narrow. Two pairs are allowed because the
 * catalog's own straddles live there: a read-only check reads as GATHER or VERIFY depending
 * on whether the asker wants findings or a verdict, and the sandbox coder family PRODUCEs by
 * running code, which reads as ACT to anyone describing the mechanism rather than the result.
 */
const MODE_COMPATIBILITY: Record<string, ReadonlySet<string>> = {
  GATHER: new Set(["GATHER", "VERIFY"]),
  VERIFY: new Set(["VERIFY", "GATHER"]),
  PRODUCE: new Set(["PRODUCE", "ACT"]),
  ACT: new Set(["ACT", "PRODUCE"]),
  ORCHESTRATE: new Set(["ORCHESTRATE"]),
  converse: new Set<string>(),
};

export function modesCompatible(requestMode: RequestFacets["mode"], entryMode: RoutingTaxonomy["mode"]): boolean {
  return MODE_COMPATIBILITY[requestMode]?.has(entryMode) ?? false;
}

/**
 * How well an entry's labels agree with the request's, in [0, 1].
 *
 * Weights follow the hierarchical-classification evidence: domain is the most discriminative
 * single facet, mode carries the intent axis embeddings lack, deliverable is a tiebreak. Two
 * sentinels are treated as wildcards rather than mismatches, because a classifier never emits
 * them and scoring them as disagreement would systematically penalise exactly the entries a
 * hard request needs — the domain-agnostic coordinators and reviewers.
 */
export function facetAgreement(request: RequestFacets, entry: RoutingTaxonomy): number {
  let score = 0;
  if (modesCompatible(request.mode, entry.mode)) {
    score += request.mode === entry.mode ? 0.4 : 0.25;
  } else if (entry.mode === "ORCHESTRATE") {
    // A coordinator is never the request's own verb: the classifier reports what the USER
    // wants done, and coordination is a decision about HOW. Neutral, not a mismatch.
    score += 0.2;
  }
  if (entry.domain.includes("cross_domain")) {
    score += 0.3; // domain-agnostic: applies to any domain rather than to none
  } else if (request.domain.some((domain) => entry.domain.includes(domain))) {
    score += 0.45;
  }
  if (request.deliverable && entry.deliverable.includes(request.deliverable)) {
    score += 0.15;
  }
  return Math.min(1, score);
}
