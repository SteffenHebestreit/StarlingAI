# ADR-009: Product/model-selection questions must reach the researcher (upfront source-sensitivity classifier)

**Status:** accepted (implemented 2026-07-24)
**Date:** 2026-07-24
**Scope:** `v0.46.5`. A single-clause fix to the upfront source-sensitivity judge,
recorded because the failure it fixes is a non-obvious interaction between the
de-lexicalized routing and the LLM classifier that replaced it.

## Context

A live session (`d4eca79c`) asked *"can you research the best open-weights model
for image-creation that runs well on our Strix Halo / LM Studio"* and got a
**fabricated** answer (Flux/SDXL specs invented from memory). The audit showed:

- `delegationCount: 0`, no researcher sub-session — **the researcher never ran**,
  so no `web_search`/`web_fetch` ever fired.
- The orchestrator called `search_agents` three times (looping), each returning
  `image_creator` as the top match — the embedding matched the *topic* ("image
  generation models") over the *intent* ("research") — never delegated, hit
  `max_tool_iterations`, and wrote the answer itself.
- `guardrail_flagged{type: upfront_source_sensitive_clear}` — the classifier
  judged the request **not** source-sensitive.

Why the backstop didn't save it: the de-lex work (lean-base) intentionally
hardwired the `sourceSensitive` routing flag to `false`
([intent-classifier.ts:261](../../packages/core/src/agent/intent-classifier.ts))
— routing is meant to come from the LLM, not keyword tables. Its replacement is
the **upfront source-sensitivity classifier** (a routing-tier LLM judge). That
verdict is the single switch that arms everything downstream: a "yes" sets
`requiresDelegatedResearch` ([turn-setup.ts:119](../../packages/core/src/agent/turn-setup.ts)),
which forces orchestration-first **and** builds the research-fallback route whose
`enforceRequiredResearchFallbackRouteOnToolCall`
([research-fallback-routing.ts](../../packages/core/src/agent/research-fallback-routing.ts))
literally rewrites a looping `search_agents` call into
`delegate_to_agent(researcher)`. With a "clear" verdict, that whole backstop stays
disarmed and a weak local orchestrator is free to loop and fabricate.

The judge prompt ([ungrounded-claim-judge.ts](../../packages/core/src/agent/ungrounded-claim-judge.ts))
had a gap: its "no" list included *"advice / opinion"* and its "yes" list only
named *"how a specific system works / named org / price / law"* — with **no case
for "which real product/model/tool is best / compare them / latest"**. A small
model reads "best image model for my hardware" as advice → no.

## Decision

Widen the classifier's "yes" boundary to include **product / model / tool /
library / service / hardware selection and comparison** — "best / latest /
newest / top / recommended X for a use case", "compare", "which should I use" —
explicitly noting it holds even when phrased as a recommendation or using the
verb "research / find / look up / compare". Tighten the "no" side so
"advice / opinion" means *general principled* guidance that does not hinge on
which specific real product or version is current.

This is a **semantic boundary refinement, not a keyword table** — consistent with
the de-lex direction (the model applies the boundary in any language). It is
**fail-safe**: over-triggering only forces research on a borderline question,
which is the safe direction for a product-selection ask.

## Consequences

- An explicit "research the best X" request now classifies source-sensitive,
  which arms the existing research-fallback backstop, so the researcher is
  delegated to and actually performs `web_search`/`web_fetch` instead of the
  orchestrator fabricating from memory.
- **Eval note:** this is an LLM-judge prompt change on the routing-tier model; the
  unit test only pins the `VERDICT:` contract, so the verdict flip on the repro is
  validated by the pass^k eval / a live re-run, not a unit test.
- **Follow-up (not done here):** `search_agents` ranks `image_creator` for a
  research query — topic-over-intent embedding bias. The classifier fix mitigates
  the symptom (the loop is rewritten to `delegate(researcher)`), but hardening
  discovery ranking itself (intent-aware routing, or de-weighting a creation
  agent for a "research"-framed query) is a separate improvement.
