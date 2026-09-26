# Latency suite

The question this suite answers: where does a turn's time go, and which of it could a quick
categorization decision (the Laya sidecar, ~20 ms) or a change in the order of things take away?
Prompt processing is the suspect, but it is not the only cost, and it is not the largest one that
can be removed. On the 25 audited turns of September 2026, image rendering was 70% of wall time.
Of the remainder, model decode was about 40% and prefill about 27%, and one timed-out agent search
cost more than both routing classifiers together. So the suite measures every cost on the same
clock, and credits each second to one lever only.

Three layers, cheapest first. Each one says what the next one has to confirm.

| layer | command | needs | answers |
|---|---|---|---|
| 1 | `latency:report` | an audit log | where the time went on real turns; what each lever could remove, at most |
| 2 | `latency:probe` | the model server | what a call costs on the production path: prefill, cache reuse, queueing |
| 3 | `decisions:bench`, `routing:prerouter` | model server, Laya sidecar, labelled cases | how often Laya would decide, and how often it would be wrong |

No layer changes a default. A lever ships default-off, then runs in shadow mode, then passes a
pass^k run over full turns (`pnpm agents:evaluate … --via-gateway --repeat 3`, composed arm)
before it becomes the default.

---

## Layer 1: `latency:report` (offline, deterministic)

```
pnpm --filter @starlingai/core latency:report                        # the live log, .starlingai/audit.jsonl
pnpm --filter @starlingai/core latency:report --audit <a.jsonl> --audit <b.jsonl>
pnpm --filter @starlingai/core latency:report --coverage 0.6 --laya-ms 20 --json
```

It reads one or more audit logs, merges them, drops repeated row ids, and writes `report.json`
and `report.md` to `.starlingai/live-check/latency-report/<timestamp>/` (`--out` changes the
folder). It prints the Markdown, or the JSON with `--json`. Relative paths are taken from the
repo root. It calls nothing: no model, no config, no network. Exit codes: `0` a report over at
least one turn; `2` a usage mistake, or INCONCLUSIVE when the input held no turn; `3` an input
file missing or unreadable.

The logic is in `packages/core/src/agent/latency-attribution.ts`. Its test,
`src/tests/latency-attribution.test.ts`, runs on real rows (four turns of one session, scrubbed)
and is the `latency-attribution` pack in `eval/packs/packs.jsonc`, so CI runs it.

### How it reads the rows

- **Turn.** From the user's message (`message_received`) to the reply (`message_sent`), per
  session. The receptionist's verdict is a second `message_received` row and never opens a turn.
  A turn the front desk answered writes no `message_sent`, so its verdict row is its end. A
  sub-agent's rows (`sub:<parent>:<agent>:<ts>`) belong to its parent's open turn, including
  parents whose ids hold colons (`mcp:…`, `workflow:…`). Any other turn with no reply row ends at
  its last row, and the report counts those turns. A turn without a single model-call row is left
  out of every figure, and the scope section names its session. Builds before 2026-09-21 wrote
  model-call rows without a session.
- **Render and human time.** `generate_image` and `transform_image` are rendering. Time spent in
  the settings dialog (`user_input_requested` to `user_input_resolved`) is human time, even when
  it happens inside a render. **Non-render time** is wall time minus both. It is the fairer
  denominator for anything a routing decision could touch.
- **One call.** Each model call is split into prefill, decode and overhead:
  - from llama.cpp's `timings` (`promptN`, `cacheN`, `promptMs`, `predictedMs`) when the row
    carries them;
  - else, for stream calls, prefill is the time to first token;
  - else, for complete calls, decode is `completionTokens` at 56 tok/s and prefill is the rest,
    which then includes the per-call overhead.

  The call is then classed by the share of its prompt it re-processed: **cold** at 80% or more of
  a full prefill at 900 tok/s, **warm** at 10% or less, **partial** in between. Below 1,500
  prompt tokens and without timings, the class is **indeterminate**: a full cold prefill is then
  shorter than the 1–2 s every small call costs anyway, so cold and warm look alike.
- **Before the first orchestrator call.** Message arrival to the start of the orchestrator's first
  call, split into the routing-tier calls (receptionist, source judge), the discovery prefetch,
  document RAG, and the rest (prompt building, and on older rows the stream's wait for headers).

### Levers

Each lever returns the stretches of a turn it could remove, with a weight: 1 for a restructuring,
`--coverage` for a classifier that would first have to be trusted. The default coverage of 1 is
an upper bound. The real value per point, language and class comes from layer 3.

| lever | kind | claims |
|---|---|---|
| `laya_gate_calls` | classifier | every routing-tier judge that decides a Laya point, minus Laya's 20 ms. A receptionist that answered itself is not claimed, because Laya may only say "task" there. |
| `pre_router_dispatch` | classifier | the span from the first orchestrator call to the dispatch, on turns whose first dispatch starts one sub-agent (a delegation or a one-step plan) after nothing but agent search or planning. The gate calls before it are not claimed again. |
| `plan_round_fold` | restructure | the orchestrator round after a response that did nothing but `record_plan` |
| `subagent_prewarm` | restructure | a sub-agent's cold first call: its prefill above a warm 1.5 s |
| `agent_search_wait` | restructure | `search_agents` / `list_agents` beyond a warm reranker's 3.7 s |
| `qa_verdict_candidate` | classifier | QA verdicts that passed, less Laya's 20 ms. A verdict followed by an improve call failed and is not claimed. This is a candidate point, not an existing one. |
| `vision_structuring` | restructure | a vision call's decode beyond a ~64-token structured answer; only rows with call site `vision` |
| `loop_brake` | restructure | a sub-agent run's time from its first loop row (`sub_agent_tool_loop_enforced` or `_detected`) to its end. An upper bound: the stopped run's synthesis and detections that were not loops are claimed too. |

**Each second counts once.** The combined saving counts every instant of a turn once, at the
largest weight any lever claims for it, never the sum. Two levers claiming the same second at
weights 1 and 0.5 remove one second, not one and a half. The report also prints what adding the
levers up would give, how much of that is double counted, and each pair of levers that claims the
same seconds (on the September turns, the pre-router's span holds both the agent-search timeout
and the plan round).

Two limits of that rule. It counts shared seconds once, but it does not model levers that shrink
each other's room: a prewarm hides a sub-agent's prefill behind the routing before the dispatch,
and with the pre-router and Laya's gate calls also taken, less of that routing is left. And a
claim is the interval a call ran, so a judge that ran beside other work the turn still waited for
(document RAG beside the source judge) is claimed in full.

### How to read it

1. **Data scope first.** Turns, sessions, date range, sub-agents seen, and what was left out. Below
   30 turns the report says THIN DATA, and it means it: every figure is then an anecdote.
   Topics and languages are not in the audit, so the report cannot tell you whether the turns
   cover more than one kind of work. The sub-agents seen are the nearest hint.
2. **Where the time goes.** Shares of wall time and of non-render time. Prefill and decode are
   estimates until the rows carry `timings` (the notes say how many do).
3. **Levers.** Per lever: turns affected, total, mean per turn over all turns, mean per affected
   turn, share of wall and of non-render time. The combined row is the one to quote.
4. **Decision points.** How often each judge ran per turn and what it cost. "Laya could take"
   counts the calls whose answer Laya is allowed to give.
5. **Measured inputs for layer 3.** `--frequency` for `decisions:bench` and `--round-ms` for
   `routing:prerouter`, taken from these turns instead of assumed. Points `decisions:bench` has
   no cases for yet (goal_met, run_drifting, …) are listed beside the flag, not in it, because
   the bench refuses them.
6. **Turns.** One row per turn with its outcome from the scorecard (completed, partial, QA),
   so a turn that was fast only because it failed does not pass for a fast turn. A one-line
   timeline follows per turn.
7. **Call sites.** Count, p50/p90 duration, p50 TTFT and prompt tokens, and cold/partial/warm per
   call site and agent. Calls without a session (the cache warm-keeper) are listed apart. They
   are on no turn's critical path, but they share the model server with the turns.

The rows can hold the user's words. The report copies no string from a row except identifiers
(agent, tool and call-site names, statuses) and message lengths, and a test enforces this with
canary strings. Keep real audit logs out of git all the same: `.starlingai/` is ignored.

---

## Layer 2: `latency:probe` (live, the model server only)

```
pnpm --filter @starlingai/core latency:probe --reps 3 --turn-ms <wall ms per turn, from layer 1>
pnpm --filter @starlingai/core latency:probe --experiments E1 --reps 1        # smoke run
```

Layer 1 can only infer what a call spent on its prompt. Layer 2 sends calls built with the
production message builders (receptionist, source judge, the orchestrator's head) around
synthetic user text, and reads llama-server's own `timings`. Its experiments are E1 (what one
decision call costs) to E7 (what a tool-subset switch costs); the script's header lists them and
every flag. It answers:

- Is the ~0.7–2 s every small call costs fixed overhead, or prompt processing that caching could
  remove? Look at `prompt_n` against `cache_n`, and `queue = wall − prompt_ms − predicted_ms`,
  with the prompt varied at its end, mid-system, and after the history.
- Does running the receptionist, the judge and the prefetch side by side save time, or does each
  call get slower? Look at the same small call with 1, 2 and 4 in flight, and which station
  answered.
- Wherever Laya is not asked first (shadow, a point that has not qualified, `decisions.layaFirstMs`
  0), `decide()` starts the incumbent call and Laya together and aborts the incumbent when Laya
  decides. Does the aborted request still occupy a slot or evict the orchestrator's cached
  prefix? (E5, 2026-09-26: the next head call was 952 ms slower, which is why a qualified point
  now asks Laya first.)

Measure on the PRODUCTION PATH: the llama-swap address in `.env` (`SAI_PRIMARY_MODEL_URL`) with
the model selector `qwen`, never a station's own address or model id. The selector spreads calls
over two stations with separate caches, and a probe that bypasses it measures something
production never does. Probe runs load the shared model server. Run them one at a time, and not
while someone is using the stack.

---

## Layer 3: `decisions:bench` and `routing:prerouter` (live, labelled cases)

```
pnpm --filter @starlingai/core decisions:bench --points fast_lane,source_sensitive \
  --laya-url http://127.0.0.1:18080 --frequency <from layer 1>
pnpm --filter @starlingai/core routing:prerouter --laya-url http://127.0.0.1:18080 --round-ms <from layer 1>
```

The flags are in each script's header. `decisions:bench` asks each labelled case
(`eval/decisions/`, German and English) of both the incumbent and Laya, one after the other in
alternating order. It compares both with the gold label and with each other,
replays the adaptive gate, and projects the seconds saved. `routing:prerouter` asks whether Laya,
given the discovery capsule's candidates at message arrival, picks the specialist the turn
needed. That is the decision `pre_router_dispatch` assumes.

How to read them:

- **Agreement is not accuracy.** The gate hands Laya a decision once Laya agrees with the
  incumbent often enough. That measures how precise Laya's answer is against the incumbent, not
  whether it finds the rare class. On the September turns the source judge said "clear" 25 of 25
  times, so a Laya that always says "no" would qualify and miss every real positive. Read the
  per-class recall against the gold labels, next to the always-majority baseline. A point is
  worth handing over only where Laya beats that baseline on the rare class.
- **German and English separately.** The gate keeps them apart, and Laya is weakest in German.
  A figure pooled over both languages hides that.
- **The qualifying bar is higher than it looks.** The gate uses the Wilson lower bound at 0.9:
  30 of 30 agreeing cases give 0.886 and do not qualify. It takes about 38 flawless cases per
  point, language, answer and checkpoint (35 for the bound, and the level must also have
  qualified without the newest 3), any level above the lowest waits for 200 cases, and every new
  checkpoint starts again (decisions/gate.ts).
- **The headline number** is: frequency per turn (layer 1) × coverage at the qualifying level
  (layer 3) × (incumbent ms − Laya ms), as a share of whole-turn wall time. Pass layer 1's
  measured `--frequency` and `--round-ms` so the projection rests on real turns. Never add a
  layer-3 projection to layer 1's combined figure: layer 1 already counts that lever's seconds.

---

## Data caveats

- **Thin and one-sided.** The audited turns of September 2026 are 25 turns in 11 sessions, from
  one user, all image generation (`image_creator` is the only sub-agent seen). Nothing here yet
  says anything about research, coding, browser or small-talk turns, or about English: the fast
  lane never answered, and the source judge never said "yes".
- **Stack wipes delete the audit.** The live log and its Postgres mirror only go back to the last
  wipe. Copy `.starlingai/audit.jsonl` somewhere before a wipe if the turns matter. The report
  merges several files and drops repeated rows.
- **Two clocks for stream calls.** Before 2026-09-26, a stream call's duration started when the
  response headers arrived, while a complete call's started at the send. Rows timed from the send
  carry `headersMs`. The report says how many rows used each clock, and the two are not
  comparable.
- **Estimates until `timings` land.** Without llama.cpp's `timings` on the row, a queue on a busy
  server reads as prefill, and a complete call's overhead sits inside "prefill".
- **Not audited as model calls.** Embeddings (discovery prefetch, `search_agents`, tool rerank)
  run on the same server and show up only as tool, phase or gap time. `analyze_image` wrote no
  model-call row before 2026-09-26. The report lists such runs and their seconds, and claims
  nothing for them.
- **Stub-provider eval runs** (sessions `eval-*`, ~100 prompt tokens, 0–5 ms per call) are not
  real latency. Leave their audit files out of the input.
- **Upper bounds.** A lever's figure is what it would remove if it worked perfectly. Whether the
  answer stays as good is a separate question, for layer 3 and pass^k. Where Laya is asked
  first (a point that has qualified, `decisions.layaFirstMs`), a taken answer never sends the
  incumbent's request. Everywhere else `decide()` starts both, and there a Laya decision saves
  wall time, not load on the model server.

## Files

| path | what |
|---|---|
| `packages/core/src/agent/latency-attribution.ts` | turn grouping, call estimates, levers, the combined saving, the Markdown |
| `packages/core/src/scripts/latency-report.ts` | the `latency:report` CLI |
| `packages/core/src/tests/latency-attribution.test.ts` | the tests; pack `latency-attribution` |
| `packages/core/src/tests/fixtures/latency-audit-sample.jsonl` | real rows of session 6ece6f2a (2026-09-25, four turns) and the session-less rows of that hour; every string that could hold user or model text replaced by a placeholder of the same length |
