# Routing evaluation data

Two things are measured here, and neither can stand in for the other.

The **canary** guards the score *distribution*: whether the catalog still matches itself
above the admission floor. The **eval** guards *decisions*: whether the right entry is
retrieved, and whether the fusion picks the right branch once it has one. A regression can
hit either alone. The one that shipped in this repo left the ranking perfect and pushed
every absolute score under the floor, so 0 of 49 queries matched — invisible to any
decision eval, and the whole point of the canary.

---

## Routing eval

```
pnpm routing:eval                                # decision mode — offline, deterministic
pnpm routing:eval -- --mode live                 # real catalog + embeddings
pnpm routing:eval -- --mode live --triage        # ...and the real facet triage
pnpm routing:eval -- --cases <path> --json out.json
```

### Decision mode

`decision-cases.jsonl` supplies the candidates and the classifier verdict directly and runs
`fuseRouting` alone. No catalog, no backend, no network — so it runs in CI, as
`src/tests/routing-eval.test.ts`.

Each case names the invariant it guards and, in most cases, the incident that produced it.
Cases tagged `control` exist to prove their partner discriminates.

### Discriminance

A passing eval proves nothing on its own.

```
pnpm routing:eval:discriminance
```

reverts each fix the suite is supposed to guard, one at a time, in a byte-exact copy of
`routing-fusion.ts`, and checks that the case named for it fails while its control keeps
passing. A probe that breaks nothing means the case is decorative. A probe whose anchor no
longer matches any source text is reported as `STALE`, never silently skipped — that exact
failure has shipped in this repo before.

It rewrites a source file and restores it in a `finally`, refuses to start on a dirty
working tree, and is deliberately not part of CI.

### Live mode

Live cases are deployment-specific: they name entries in *your* catalog. Copy the example
and edit it.

```
cp eval/routing/live-cases.example.jsonl eval/routing/live-cases.jsonl
pnpm routing:eval -- --mode live
```

`live-cases.jsonl` is gitignored: it carries a deployment's own agent names and the kind of
thing its users actually type.

Live mode scores the **agent family only**. Scenes and jobs carry taxonomy labels but have
no scorer in production yet, so a live run says nothing about workflow retrieval.

Without `--triage` there is no verdict, so the fusion returns `legacy` by contract and
branch and source-sensitivity checks are skipped rather than scored against the absence of
a classifier. The run says how many it skipped.

### Run it where the reranker is

Routing blends `combinedScore * 0.7 + rerankScore * 0.3` and applies the 0.72 admission
floor to the RESULT. The reranker is a docker sidecar on an internal network: the gateway
reaches it, a developer machine does not.

So a run from a workstation scores a different pipeline from production, against the same
fixed gate. Both commands now print whether the reranker took part, and
`routing:canary --update` refuses to record a baseline from a run it sat out:

```
Reranker: enabled (tei), applied to 0/245 queries — last error: fetch failed
WARNING: the reranker is configured but never answered, so these scores are PRE-BLEND.
REFUSING to record a baseline from a run the reranker did not take part in.
```

`--allow-degraded` overrides it, and records the rerank state into the snapshot so the
mismatch is at least visible later. A pre-blend baseline is not comparable to a production
run; the floor-crossing check would compare two different systems and call it a regression.

### Running it against the real pipeline, from inside the network

The reranker is a docker sidecar on an internal network and the LAN model server is outside
it, so a run needs a container attached to BOTH. The gateway image carries linux
`node_modules` but no source, so the source is copied in:

```
IMG=$(docker inspect starlingai-gateway-1 --format '{{.Config.Image}}')
docker run -d --name sai-probe --network starlingai_starlingai-internal   --entrypoint sh "$IMG" -c 'sleep 3600'
docker network connect starlingai-app sai-probe          # LAN egress for the model server
docker cp packages/core/src  sai-probe:/app/packages/core/src
docker cp starlingai.json    sai-probe:/app/starlingai.json
docker cp eval               sai-probe:/app/eval

docker exec sai-probe sh -c 'export SAI_CONFIG_PATH=/app/starlingai.json;   cd /app/packages/core && ./node_modules/.bin/tsx src/agent/routing-canary-cli.ts   --update --snapshot /tmp/snap.json'
docker cp sai-probe:/tmp/snap.json eval/routing/canary-snapshot.json
docker rm -f sai-probe
```

Set `SAI_CONFIG_PATH` INSIDE the container. Setting it on `docker run` from Git Bash rewrites
`/app/...` into a Windows path and the run silently loads a zero-agent config.

### The measured baseline (2026-09-20)

Run inside the network, with the reranker answering 245 of 245 queries:

| measurement | value |
|---|---|
| canary probes passed | 233 of 245 |
| mean best self-score | 0.9468 |
| live eval recall@K | 13 of 22 |
| live eval, German | 12 of 19 passed, 4 admitted nothing |
| live eval, English | 1 of 3 passed |

The same canary from a developer machine, without the reranker, passes 209 of 245. That gap
is the reason a pre-blend run is graded INCONCLUSIVE rather than red.

Twelve canary probes fail at this baseline. All twelve were adjudicated and none is a catalog
defect: they are short abstract capability phrases ("tl;dr creation", "tool routing") that
several agents legitimately advertise, and every natural phrasing of the same request
retrieves the right agent first. They stay in, because capability probes are the only kind
sensitive enough to catch a uniform score drift.

So once a baseline exists, the canary's EXIT CODE comes from the diff, not from absolute
probe results. A permanently red canary is an ignored canary, and what this guards is drift:
an entry crossing the floor, the distribution shifting, or a new entry that retrieves nothing.

Nine live-eval cases still fail. Four are German requests that admit nothing at all; the rest
are genuine mis-routes, including one in English. They are left failing on purpose. Three
other cases were rewritten instead, because the QUERY was underspecified rather than the
routing wrong: "entries from the last seven days" legitimately reads as calendar entries.
Widening `acceptable` until the router's answer counts as correct is how an eval stops
measuring anything.

### Two things the report will tell you that are easy to misread

**A gated case is a miss, not an exclusion.** The previous benchmark in this repo ran at
`minConfidence: "low"` and measured ranking while the production gate is absolute. It could
not have observed the floor regression above. Gated cases stay in the denominator and the
gated rate is its own threshold.

**A lexically leaked case is a case to rewrite.** The eval compares each query against the
expected entry's own description, capabilities and tags. High overlap means the query was
probably written *from* the description, which makes it pass under a router that does
nothing but substring matching. Those ids are listed separately and a second pass rate is
computed without them.

A run that scores nothing reports `INCONCLUSIVE` and exits 2. It never reports a pass.

---

## Routing canary

`canary-snapshot.json` is the recorded baseline: each catalog entry's best self-match score,
the mean across the catalog, and the embedding model the scores were produced with.

It is not in the repo, because it can only be produced against a live embedding backend —
and a snapshot recorded from a different embedder is worse than none, since scores are not
comparable across models. The canary refuses to diff across a model change and asks for a
fresh baseline instead.

Record one, once, against your stack:

```
pnpm routing:canary -- --update
```

Then commit `canary-snapshot.json`. Until it exists the canary reports INCONCLUSIVE
(exit 2) rather than passing: its two strongest checks — an entry crossing the admission
floor, and the whole score distribution shifting — both need a baseline to compare to, and
those are precisely the pair that catches a regression whose ranking still looks fine.

Re-record deliberately, after a change you intended, and never from a run with failing
probes — the command warns when you do.

---

## Exit codes

`0` pass · `1` a check failed · `2` INCONCLUSIVE — the backend is unreachable, no baseline
exists, or nothing could be scored.

`pnpm` collapses any non-zero exit to `1`, so the distinction between "failed" and
"inconclusive" lives in the output, not the code. Run directly when a script needs to branch
on it:

```
pnpm --filter @starlingai/core exec tsx src/agent/routing-canary-cli.ts
pnpm --filter @starlingai/core exec tsx src/agent/routing-eval-cli.ts
```

Both commands print which catalog they loaded and how many agents they found, because
guarding the wrong catalog is a silent no-op — and that is exactly what happened when the
canary first shipped: it ran from `packages/core`, found the zero-agent stub sitting there,
and reported a missing embedding model.
