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

### The English-restatement second pass (an experiment, not a product feature)

```
pnpm routing:eval -- --mode live --triage --second-pass
```

Measured on 25 matched German/English pairs: seven German requests admitted NOTHING while
every one of their English twins cleared the 0.72 floor. The classifier already produces an
English restatement of a non-English request, so the obvious question is whether routing on
it rescues those turns.

This flag answers that question without shipping the mechanism. For a non-English case it
resolves a second time on the restatement and adds anything new, marked
`admittedByRawQuery: false` — which the fusion already refuses to let license a mechanical
dispatch, because the restatement comes from the same small model that produced the labels
and trusting both would be one signal counted twice.

The report splits the outcome three ways, and the distinction is the point:

| line | meaning |
|---|---|
| rescued | the raw query admitted nothing, the restatement found something |
| widened | the case already worked; the restatement only made the shortlist longer |
| still empty | neither pass found anything |

Only the first number justifies building the pass. Counting the second with it would inflate
the benefit with cases that never needed it.

One ceiling to keep in view: the classifier emits a restatement on about 9 of 15 German
requests. A rescue available on 60% of turns rescues 60% of turns, and two rewordings of the
prompt failed to move that (see `TRIAGE_PROMPT_VERSION` in `agent/triage.ts`).

### Run it where the reranker is

Routing blends `combinedScore * 0.7 + rerankScore * 0.3` and applies the 0.72 admission
floor to the RESULT. The reranker is a docker sidecar on an internal network: the gateway
reaches it, a developer machine does not.

Both commands print whether the reranker took part. Whether that matters depends on
`retrieval.reranker.blendMode`, and the distinction is worth getting right:

- **`"ordering"`, the default.** The reranker cannot change a number the canary records. The
  candidate set is cut to five BEFORE the rerank call, the blend only sets a sort key, and the
  reported score is the pre-blend one. A workstation run and a container run produce identical
  `scores` and identical `meanBestSelfScore` — verified by running both against the same
  baseline, mean shift -0.0001. Per-probe RANK does differ, which is why the exit code comes
  from the diff rather than from absolute probe results.
- **`"admission"`, the legacy pin.** The blend decides who is admitted and what score is
  reported, so a run without the reranker describes a system the deployment does not run.
  `routing:canary --update` refuses to record a baseline from it unless `--allow-degraded`
  is passed, and grading is INCONCLUSIVE rather than red.

The snapshot carries a `pipeline` stamp naming the GATE — `embedding_gated` or
`rerank_gated` — and `diffSnapshot` refuses to compare across a mismatch, the same contract
it already had for an embedding-model change. A baseline with no stamp counts as a mismatch.

The first version of that stamp recorded whether the reranker ANSWERED, which measured the
wrong thing in both directions: it blocked a valid workstation-to-container comparison, and
it let a `blendMode` flip — 71 admitted candidates against 25 on the same 22 queries — pass
as the same system. In one direction that comparison even exited 0, because the
survivor-only mean stayed inside the shift limit.

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

### The mode matrix (2026-09-20, 138 cases, inside the network)

| | baseline | legacy blend | + classifier | + restatement |
|---|---|---|---|---|
| recall@K | 87/138 | 76/138 | 87/138 | 107/138 |
| top-1 | 67/138 | 67/138 | 67/138 | 81/138 |
| found nothing | 29 | 29 | 29 | 9 |
| median ms/case | 108 | 87 | 3,306 | 3,417 |

The restatement pass rescues 20 cases and regresses none; German recall goes 58% to 81%. The
classifier's LABELS change the admitted set in 1 case of 138 and the top-1 choice in none, at
thirty times the latency — see section 13 of the plan doc before drawing a conclusion from
that. The legacy blend loses 11 cases and gains none.

To reproduce, run each mode in the container recipe below, varying only
`retrieval.reranker.blendMode` and the `--triage` / `--second-pass` flags.

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

### Recall@K and recall AT CAPSULE are different numbers

`recall@K` counts every admitted candidate: did retrieval find the entry at all.
`recall AT CAPSULE` counts what the orchestrator is actually handed — the discovery capsule,
at most four agents with meta-factory entries removed, built the way
`prefetchCapabilityCandidates` builds it.

The second is the one a gate belongs on. Measured on the 138-query corpus: 87/138 against
84/138 at the baseline, and 104/138 against 97/138 with the restatement pass. The gap widens
as retrieval improves, because more candidates compete for the same four slots. Reporting the
wider figure as the outcome is how an eval stops describing production.

`--min-capsule-recall` sets the threshold; the default is 0.75.

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

---

## Pre-router bench

```
pnpm --filter @starlingai/core routing:prerouter                        # every case, K = 8
pnpm --filter @starlingai/core routing:prerouter -- --train-out <file>  # also write training items
pnpm --filter @starlingai/core routing:prerouter -- --split test        # after fine-tuning on them
pnpm --filter @starlingai/core routing:prerouter -- --cases eval/routing/live-cases.jsonl --cases eval/routing/none-cases.example.jsonl
```

`--cases` may be given more than once: the files are read in order and scored as one corpus, and an
id used in two of them is refused. The last line adds `none-cases.example.jsonl` to the live cases: 79
synthetic messages (40 German, 39 English) whose right answer is no specialist. They fall into three kinds,
tagged:

- `direct-answer`: small talk, the assistant itself, a concept, a calculation, a short rewrite;
- `clarify`: the goal or the input is missing;
- `multi-step-chain`: two short steps for two different specialists.

Without them the "none" rows below are empty. Why 79: a flawless answerer on n none cases reaches a
Wilson lower bound of n / (n + 1.96²). Stage 1 waits for 0.95, which takes 73 cases, so with the 47 of
the first draft (at most 0.924) the stage would have failed on the count alone.

With the none cases in the corpus, the pooled **top-1** row moves with their share: they are easy by
design, and an answerer right on 78% of the 138 live cases and on every none case pools to 86%. So
stage 1's top-1 is the one on the gold-agent cases (its own row, "top-1 on gold-agent cases"), and the
none cases count only through the none recall. The gate simulation and the confidence curve never take
a "none" pick, so a none case enters them only as a specialist wrongly dispatched, and in the coverage's
denominator: coverage there falls with the none share, the error rate does not. `--limit` takes the first
n cases of the files in order, so a limited run with the live file first holds no none case.

On real turns the orchestrator's first call only routed in 17 of 19: a `search_agents`, one
delegation or a one-step plan, at 4.9-12.4 s a turn. This asks whether Laya, handed the
embedding capsule's candidates when the message arrives, could make that call instead: often
enough right, and sure enough when it is, that the round could be skipped.

Per case it resolves the capsule exactly as the discovery prefetch does, reads the embedding
ranking behind it, and asks the sidecar one question: "Which specialist should handle this
request?", over the top K agents (the capsule first, then the ranking; meta-factory agents
dropped) plus **none**, which leaves the turn to the orchestrator. Each agent is described by its
catalog description, cut to the 48 tokens Laya reads and shorter when many options would
overflow its 1024-token window (`--describe oneliner` uses the taxonomy one-liners instead, which
are the labeller's notes rather than descriptions). K is at most 19: the sidecar takes 20
options and one is none.

It calls the embedding endpoint on llama-swap and the Laya sidecar (`--laya-url`, default
`http://127.0.0.1:18080`), at concurrency 1, and nothing else. Reports go to
`.starlingai/live-check/pre-router-bench/<timestamp>/`: `report.md`, `report.json` with every
case, `questions.jsonl` with exactly what Laya was sent, and the run's own audit log.

### What it reports

| line | why it is there |
|---|---|
| capsule recall, option recall | whether a right agent was offered at all. Laya chooses among the options and cannot find a missing one, so these cap everything below |
| embedding top-1, always the majority label | what a pre-router costs without Laya, and what a classifier that learned the label skew would score |
| Laya top-1, on gold-agent cases, given a right option | its accuracy (pooled, gold none included), on the specialist cases alone (stage 1's), and where it had a chance |
| Laya says none when nothing right was offered | the only view this corpus gives of whether Laya knows when to hand a turn back |
| discordant pairs against the embedding | whether Laya's right answers are ones the embedding already had (exact McNemar p) |
| per-label accuracy, pick concentration | a classifier that answers one label for everything looks accurate on a skewed corpus |
| gate simulation | the share of turns whose routing round could be skipped, and the error rate among them |

The gate simulation mirrors `decisions/gate.ts`: the lowest level at which at least
`--min-samples` picks reach `--target` agreement by the Wilson lower bound. It is CROSS-FITTED:
the cases fall into two folds by a hash of their id (a different cut from the calibration/test
split), and each fold's level is set on the other fold's cases before it is applied, so no
skipped turn is judged by a threshold it helped choose. A none pick is never taken and never an
error; that turn simply costs what it costs today. Three versions run on the same cases:

- **Laya, per language**: the default headline.
- **Laya, per language and answer**: how production keys the gate. With 49 answers, no agent
  gathers 35 agreeing cases per language from a corpus this size (no agent is right for more than
  9 of the 138), so there is no coverage here even for a perfect Laya. That is the real cost of a
  49-way decision point, and it applies to the live ledger too. `--keying answer` makes this the
  verdict, which is then inconclusive.
- **An embedding-score threshold**: the pre-router that needs no sidecar, since the prefetch
  already computes the score. If it skips as many turns at the same error rate, Laya adds nothing.

The savings line is an estimate: skipped rounds × `--round-ms` (default 7.9 s, the p50 of the
orchestrator's first call on 10 image turns), minus Laya's p50 on every turn. Only correct skips are
credited. A wrong dispatch is counted separately, because its cost (a failed delegation, a
recovery round) is not measured here. The capsule is not charged, since the prompt build waits for
it today.

### What it cannot tell you

- **The none class, from the live cases alone.** Every live case expects a specialist. A case with
  `"expect": {"admitted": false}` and no agent named is scored as gold none. `none-cases.example.jsonl`
  holds such cases; without it, whether the answerer leaves those turns to the orchestrator is
  untested, and the report says so. `routing:eval` reads the same field differently, as "the embedding
  admits nothing", and a multi-step chain may well admit the specialists of its parts. So the none
  file is for the pre-router only; do not add it to a `routing:eval` run.
- **Follow-ups.** The cases are single messages. A "same agent as last turn" rule was right on 11
  of 12 real follow-ups, but it needs a session, so it is not a baseline here. A pre-router that
  skips the orchestrator must still pass on the context a follow-up leans on.
- **Qualifying at a 0.9 target at all.** A bucket needs at least 35 flawless picks (53 with one
  error). The 50 English cases fall into folds of 27 and 23, so English can never qualify from
  this corpus. The German folds hold 43 and 45 cases, so German qualifies only if nearly every
  confident pick is right. The test half alone holds 44 German cases (folds of 21 and 23) and 24
  English ones, so no bucket can qualify on it at all. The gate table's "largest bucket" column
  gives the most cases a perfect answerer could have gathered where a level was set. When no
  bucket could have reached the flawless count, the run is inconclusive (exit 2), not a failure:
  the case count decided it, not Laya. The confidence curve in the report shows how many cases
  each observed precision would need, which separates "too few cases" from "not precise enough".
- **Production's agreement.** Production counts agreement with the incumbent (the orchestrator's
  own routing). The bench counts agreement with the label, which is stricter where the orchestrator
  misroutes and more lenient where the label is generous.
- **Capsule order off the network.** On a workstation the reranker is unreachable. In the default
  `ordering` blend mode that changes the capsule's order, not its members. The report records
  whether the reranker answered.

### Fine-tuning round trip

`--train-out <file>` writes the calibration half (by a hash of the case id, so adding cases
moves no other case between halves) as typed-decisions training items, the format
`decisions:export` writes. The options appear under the letters `generic.to_laya` serves, the
gold is one-hot on the first right agent offered, and it is none when no right agent was offered.
Two traps when training on it:

- `app.train decision` refuses fewer than 200 training cases by default and holds out every fifth
  one again, so pass `--min-cases`.
- A promoted checkpoint answers EVERY decision point. Train into a separate `LAYA_LOCAL_DIR` (or
  pass `--no-promote` and serve the run from its own sidecar), so the production `current` is not
  replaced by a model tuned on one point.

Then serve the new checkpoint and re-run with `--split test`. Compare the test half across the
two runs, since it is the only population the new checkpoint has not seen. Compare its ACCURACY
rows, not its gate: the `test/de` and `test/en` columns of the `--split all` run against the `de`
and `en` columns of the `--split test` run (Laya top-1, Laya with a right agent offered, Laya
saying none when none was). Both runs use the same cases. The gate cannot qualify any bucket on
the test half's 68 cases, so a `--split test` run exits 2 whatever the checkpoint does, and the
"Laya, test half only" gate row is empty by construction. Whether the new checkpoint could skip
routing rounds needs more cases than this corpus has. A `--split all` run is valid only for a
checkpoint that was not trained on these cases.

Exit codes: `0` a pick qualified and held on the other fold, `1` none qualified or it did not
hold, `2` usage error, nothing scored (`--no-laya` included), or no bucket could have qualified even
with every pick right, `3` environment-suspect: embeddings or Laya unreachable, or the embedding
search or Laya failed on more than a tenth of the cases. A case the embedding search could not rank
is left out of every figure and named in the report, never scored as a routing miss.
