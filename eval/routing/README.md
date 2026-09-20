# Routing evaluation data

`canary-snapshot.json` is the recorded baseline for the routing canary: each catalog
entry's best self-match score, the mean across the catalog, and the embedding model the
scores were produced with.

It is not in the repo yet, because it can only be produced against a live embedding
backend — and a snapshot recorded from a different embedder is worse than none, since
scores are not comparable across models. The canary refuses to diff across a model change
and asks for a fresh baseline instead.

Record one, once, against your stack:

```
pnpm routing:canary -- --update
```

Then commit `canary-snapshot.json`. Until it exists the canary reports INCONCLUSIVE
(exit 2) rather than passing: its two strongest checks — an entry crossing the admission
floor, and the whole score distribution shifting — both need a baseline to compare to,
and those are precisely the pair that catches a regression whose ranking still looks fine.

Re-record deliberately, after a change you intended, and never from a run with failing
probes — the command warns when you do.
## Exit codes

`0` pass · `1` a probe or snapshot check failed · `2` INCONCLUSIVE — the embedding backend
is unreachable, or no baseline exists yet.

`pnpm` collapses any non-zero exit to `1`, so the distinction between "failed" and
"inconclusive" lives in the output, not the code. Run it directly when a script needs to
branch on it:

```
pnpm --filter @starlingai/core exec tsx src/agent/routing-canary-cli.ts
```

The run always prints which catalog it loaded and how many agents it found, because
guarding the wrong catalog is a silent no-op — and that is exactly what happened when the
command first shipped: it ran from `packages/core`, found the zero-agent stub sitting there,
and reported a missing embedding model.
