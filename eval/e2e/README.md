# End-to-end evaluation

The e2e harness drives **real turns through the running gateway** — the same WebSocket `chat.send` the
dashboard uses — as two local test accounts, and judges what happened from three sources:

1. the turn's final status and reply,
2. the audit events of the scenario's own sessions (sub-agent runs and workflows included),
3. HTTP answers of the gateway and the state of the test environment (GreenMail mailbox, the fictional site).

Scenarios are JSON5 files under [`scenarios/`](scenarios/); the contract is
[`packages/core/src/e2e/scenario.ts`](../../packages/core/src/e2e/scenario.ts). Every attempt runs in fresh
sessions; a scenario repeated k times passes only when all k attempts pass (pass^k). Data is synthetic: no
personal data, real credentials or real mail addresses in any scenario or fixture.

## Set up (once)

1. The stack runs (`pnpm sai start`) with `auth.enabled: true`. Any provider works — OIDC included:
   `POST /api/auth/login` checks `auth.users` whatever `auth.provider` says.
2. Create the accounts — **you run this yourself**; it rebuilds `starlingai.json`, which the running gateway
   reloads:

   ```bash
   pnpm e2e:setup            # idempotent; prints no password
   pnpm e2e:setup --remove   # deletes everything below and rebuilds
   ```

   | File (all git-ignored) | Content |
   |---|---|
   | `config/gateway/31-e2e.local.jsonc` | `{ auth: { users: [eval (operator), eval-viewer (viewer)] } }` — bcrypt hashes from the gateway's own `hashPassword`; nothing else of `auth` is touched |
   | `eval/e2e/.credentials.local.json` | the plaintext passwords (32 random characters) the harness logs in with |
   | `config/mail/accounts.d/00-e2e-isolation.json5` | `{ accounts: [], isolatedUsers: ["eval", "eval-viewer"] }` — the mail-service withholds every **shared** mail account (one without `allowedUsers`) from both identities, so an eval turn never reaches your real mailboxes |

   Config arrays replace each other when shards merge, so setup **refuses, writing nothing,** while another
   shard (or `workspace/runtime/runtime.overrides.json`) defines `auth.users` — it says which file and how to
   add the two accounts by hand. It cannot see the gateway container's own runtime overlay
   (`/data/starlingai.runtime.json`): accounts created in the dashboard live there and would replace these —
   then every login answers 401. `SAI_CONFIG_PATH` (a config directory) / `SAI_WORKSPACE_CONFIG_PATH` point
   setup at another config tree; the build is then skipped (`sai config build` only builds this repo's `config/`).
3. The test environment for mail and site scenarios — GreenMail and the fictional company site:
   `pnpm e2e:env up` (see [ENVIRONMENT.md](ENVIRONMENT.md)).
4. Optional: an LLM judge for `expect.judge` (`E2E_JUDGE_URL`, `E2E_JUDGE_MODEL`, below).

## Run

```bash
pnpm e2e:validate                                   # static check of every scenario file (no gateway)
pnpm e2e:evaluate                                   # every scenario except templates
pnpm e2e:evaluate --group core --tag smoke          # in any listed group AND carrying any listed tag
pnpm e2e:evaluate --id steer-reaches-specialist     # by id (templates too: --id example-site-and-mail)
pnpm e2e:evaluate --repeat 3                        # pass^3 (a scenario's own `repeat` wins)
pnpm e2e:evaluate --concurrency 2                   # scenarios at once (default 1: the model backend is shared)
pnpm e2e:evaluate --baseline artifacts/evaluations/e2e/2026-10-07T09-00-00-000Z.json
pnpm e2e:evaluate --list                            # what would run
```

`--group`, `--tag` and `--id` repeat or take comma lists; relative paths are taken from where you ran pnpm.
`--out dir` writes the report elsewhere, `--scenarios dir` reads scenarios from another directory.
Ctrl+C cancels the running turns (`chat.cancel`) and writes the report; a second Ctrl+C quits at once.

**Durable memory is emptied before each attempt.** What a scenario stores (memory_store) reaches every
later turn of the account through the durable-facts capsule, so one scenario's facts would steer the next
(the memory scenario's German fact pulled an English question's reply into German, 2026-10-07). With
`--concurrency 1` (the default) the attempt's identity — and the identity of any turn with `as` — loses every
user- and workspace-scope memory entry, and its user model (`recall_context` serves it too), before the
attempt starts. A scenario therefore cannot rely on what an earlier one stored; one that needs a record
stores it itself (the viewer-isolation scenario: a turn as `eval`, then one `as: "eval-viewer"`).
Concurrent attempts share the account, so then nothing is reset. `--keep-memory` keeps it.

A delete cannot be undone, so the reset deletes only what is provably the eval account's own, and the
attempt's notes in the report say what it left and why:

- the gateway runs with auth on (`GET /api/auth/mode`, asked before every reset) — with auth off every
  account's memory is the shared single-operator store, and a token from before the switch still works;
- the identity logs in as its own eval account (`GET /api/auth/me`: `eval` → `eval`, `eval-viewer` →
  `eval-viewer`) — a credentials file may map it to any account;
- no other eval account lists the same entries — a gateway older than the per-user workspace routes
  (5fc9a8e) keeps workspace memory in one store for every account.

`eval-viewer`'s memory and user model cannot be emptied through the API: every mutating route is
operator-only, so its deletes are refused (`HTTP 403`, noted), while a viewer turn can still store memory.
A listing or a delete that fails is noted too.

A deleted entry's MemGraph node goes with it, so the "Critical Memory" block cannot inject it any more.
Nodes of entries deleted before that (2026-10-08) stay in the graph until removed by hand. For the eval
accounts, between runs, in Memgraph (the `memgraph` service): `MATCH (m:MemoryRecord) WHERE m.tenant IN
['eval', 'eval-viewer', 'eval-1bbd174404efbce9', 'eval-viewer-bddbb40019b93c64'] DETACH DELETE m` (user-scope
nodes carry the username, workspace-scope nodes the account's storage segment).

Nothing is reset while a turn the harness stopped on the account may still run (`chat.cancel` got no final
status, or the socket died during the send or mid-turn): what it stores after a reset would land in the
next attempt. The reset waits up to the cancel grace (30 s) for `session.get` to report the turn ended, and
is skipped with a note otherwise. Such turns outlive the run too: the run lock (below) lists every turn
not yet seen to end as it is sent, so a run that ends, quits at once on a second Ctrl+C or is killed
(TaskStop, `Stop-Process`, a closed terminal) leaves them there, and the next run's reset of that account
waits for them the same way. A turn whose session is gone (`sai wipe`) counts as
ended once the gateway has restarted since it was sent (`gateway.status` uptime). The run names the lock
it took such turns from; deleting that file forgets them.

**One run at a time.** Two `pnpm e2e:evaluate` runs share the gateway's eval accounts, and one's reset or
mail purge lands in the other's attempts. A run therefore refuses to start (exit code 2) while another run
uses the same gateway, from whichever checkout or credentials file. The lock is
`starlingai-e2e-run-<hash of the gateway URL>.json` in the system's temp directory (`localhost`, `127.0.0.1`
and `[::1]` count as one host); a lock whose process is gone (a crash or a kill) is taken over with the
turns it lists, and one that cannot be read counts as held — delete it if no run is left.

**Mail-isolation preflight (fail closed).** Before any scenario runs, the harness asks the running
mail-service — through `pnpm e2e:env status --json`, which calls `GET /api/accounts` inside its container
with `X-Sai-User: eval` — which accounts `eval` can see. Any account not bound to `eval` (its `allowedUsers`
lacks `eval`) is your shared mail: the run stops with exit code 2 ("eval can see N shared mail account(s) —
rebuild the mail-service image and run pnpm e2e:setup"). A mail-service container that is not running is
safe; one that runs but cannot be asked (Docker unreachable, no answer) stops the run as well.

Exit codes: `0` every scenario that ran passed · `1` a scenario failed · `2` usage error, invalid scenario
file, missing credentials, refused login, the mail preflight, or another run against the same gateway ·
`3` environment-suspect (everything was skipped, one service was down for ≥ 20 % of the selected scenarios,
≥ 25 % of the attempts ended on harness errors, or the stack's reranker was not healthy when the run began or
ended). Through `pnpm` a non-zero code may arrive as 1;
`node --import tsx packages/core/src/e2e/cli.ts …` keeps it.

### Services: skipped, never failed

A scenario whose required service is down is **skipped** with the reason. `gateway` is implied by any
turn/http step and `mail` by any mail step; list the rest in `requires`.

| Service | Up when |
|---|---|
| `gateway` | `GET /healthz` → 200 |
| `model`, `embeddings` | `/api/health/subsystems`: `primary_model` / `embeddings` = ok |
| `engram`, `laya` | `/api/health/subsystems`: ok **and** configured ("not configured" is ok to the gateway, down to a scenario that needs it) |
| `browser` | a playwright/browser MCP server `connected` (`/api/mcp/servers`) and `browser_vnc` ok |
| `image` | `/api/multimodal/status` `imageGeneration.ok` |
| `speech` | `/api/multimodal/status` `stt.ok` and `tts.ok` |
| `computer-desktop` | `/api/computer-sessions/config` `enabled` (configuration only) |
| `mail` | GreenMail `/api/service/readiness` and `pnpm e2e:env status` `ready.mail` (eval mailbox loaded, isolation verified) |
| `e2e-site` | the site answers below 500 and `ready.site` (the gateway resolves it, the SSRF exemption is compiled) |
| `web-search` | `GET $E2E_SEARXNG_URL/healthz` when set; otherwise no route reports SearXNG — **assumed up** |
| `sandbox` | `/api/health/subsystems`: `sandbox` = ok **and measured** — the gateway's canary ran a `docker run` through shell_exec (socket proxy included) and got back what it printed on stdout and on stderr. A failed run or lost output is down, and so are "not configured", "not checked yet" (no container is started while a turn runs; a verdict serves 5 minutes) and a gateway too old to report the check. An ok verdict counts only up to 15 minutes old by its `ageMs` (the gateway's clock): a gateway that is never idle keeps serving its last one |

## Reports

Every run writes `artifacts/evaluations/e2e/<timestamp>.json` and a Markdown summary next to it.

- **summary**: scenarios passed/failed/skipped; attempts passed, failed and errored; the **attempt pass rate**
  (attempts passed / attempts run) and **pass^k** (scenarios whose every attempt passed / scenarios run).
- **environment**: `suspect: true` with reasons when the run says more about the environment than the swarm:
  every scenario was skipped; one service was down for at least a fifth of the selected scenarios (the reason
  names it, and says so when it was up for an earlier scenario, i.e. went down during the run — the full run of
  2026-10-07 22:07 skipped 47 of 52 after the model endpoint died); a quarter of the attempts ended on harness
  errors; or the stack's reranker container (the `rag` profile) ran but Docker did not call it healthy when the
  run began or when it ended. Every turn's routing reranks through it, and its `/health` answers 200 only once
  its model has loaded and scored a probe input; a status that cannot tell counts as not healthy. The CLI says
  so at the start (`RERANKER NOT READY`), so a long run can be stopped. A stack without the reranker (no
  container, or one that is not running) is not suspect.
- **meta.provenance**: what the run ran on — the git HEAD, dirty flag and commit date of the checkout the
  harness ran from, with a digest of its uncommitted changes (diff, status and untracked files); the gateway
  container's image: its id, build time and the commit it was built from (labels `pnpm sai start` stamps);
  digests of the config files the gateway reads, the compiled `starlingai.json` and its runtime overlay (both
  through `pnpm e2e:env status --json`); and the models it answers with (`GET /api/models/preset`: the active
  preset, its primary model, the default primary and the preset's scope). Each part it could not read is
  recorded with the reason. When the image was built from another commit than HEAD (an image without the
  label: before HEAD was committed), the report and the CLI warn that the stack may not run the code under
  test.
- **scenarios[]**: status, skip reason, the probed services, and every **attempt**: outcome (`passed`,
  `failed` = an expectation failed, `error` = the harness/environment failed or the run was interrupted),
  duration, failures, notes, the sessions it created (open them in the dashboard's audit/debug export), and
  per step: the turn's request id, status, reply (secrets redacted), duration, how long its event window
  stayed open, audit-event type counts, tool calls (dispatched, refused, per caller), sub-agent runs,
  artifacts, WS message counts, the `during` actions and the judge.
- **baseline** (with `--baseline`): each scenario run in both reports, by its attempts (harness errors left
  out): **regressed** or **improved** only when the 95 % interval of the pass-rate difference excludes zero
  (3/3 → 0/3 does; 5/5 → 4/5 does not); otherwise **flaky** when it passed and failed within one run, or
  **inconclusive** when each run was uniform but they disagree (a k=1 flip, 1/1 → 0/1). A scenario whose
  attempts in one run all ended on a harness error has **no trial** there: no pass rate, so no estimate. At
  k=1 no single scenario can be decisive, so the **suite** is compared too: an exact sign test over the
  scenarios run with equally many attempts in both — far more lower than higher is a regression. Also new
  scenarios, ones not run now, and what differs between the two runs' builds: gateway image, compiled config
  (a flag flipped in a gitignored `*.local.jsonc` shard), runtime overlay and model (a preset switched on the
  dashboard), harness commit, and whether two dirty runs carried the same uncommitted changes. A part unknown
  in either run is listed as unknown. A config or model change is what an A/B run is for, so it is listed and
  nothing more; when either run carried the provenance warning above, the comparison is labelled
  **confounded**. The baseline never sets the exit code on its own: a scenario, or the suite, can only fall
  below its baseline by failing attempts now, and a failed scenario exits 1.

A failure names its step and the exact miss, e.g.
`step 2 turn "draft-reply": tools.mustNotCall mail_send_draft: expected no call, saw 1 (mail_agent×1)` or
`step 1 turn: events.must sub_agent_steering_injected: expected ≥1, saw 0`.

## Write a scenario

Start from the commented template [`scenarios/_example.jsonc`](scenarios/_example.jsonc): copy it to a new
file without the leading `_` (files starting with `_` are templates — validated, but run only by `--id`),
give it a new kebab-case `id` and keep what you need. One file holds one scenario or an array of them.
`pnpm e2e:validate` checks every file; so does CI (`packages/core/src/tests/e2e-scenarios-valid.test.ts`).

### Steps

| Kind | What it does |
|---|---|
| `turn` | `chat.send` into the attempt's current session (created on first use, channel `eval`). `as` runs the turn as another identity, in that identity's own session — e.g. store something as `eval`, then check as `eval-viewer` in the same attempt. `agent` appends `--agent <name>`; `effort` is the message's effort tier; `attachments` (paths under [`fixtures/`](fixtures/)) are uploaded into the session and attached as the web client does (images also get their vision analysis inlined); `timeoutMs` (default 10 min) cancels the turn when it passes. Inline flags work as in the dashboard — the harness answers no approval or question card, so add `--auto` where a turn must not wait for one. |
| `http` | A gateway request as the scenario identity, or `as`. `{sessionId}` in `path` is the scenario identity's current session. Without `expect.status` any 2xx passes; `bodyIncludes` is case-sensitive. |
| `wait` | Sleeps `ms`. Keeps the previous turn's event window open (below). |
| `newSession` | Later turns run in a fresh session of their identity. |
| `mail` | `clear` empties every GreenMail mailbox; `deliver` sends `message` over SMTP to the eval inbox; `expect` waits up to 30 s until at least `min` (default 1) messages to `to` (default the eval inbox) match every `subjectIncludes` / `bodyIncludes` (case-insensitive, body decoded), then checks `max`. Scenarios with mail steps never run beside each other. |

The attempt stops at the first failed step. `timeoutMs` of the scenario (default 15 min) bounds the whole
attempt; a turn still running at the deadline is cancelled.

### Turn expectations

| Field | Evaluated as |
|---|---|
| `status` | the final status (`ok` / `error` / `blocked`); **default `ok`**, also without `expect` |
| `reply.includes` / `includesAny` / `excludes` | case-insensitive substrings of the reply |
| `reply.matches` | JS regexes with flag `i` |
| `reply.language` | `de` / `en` by function-word counts (code and URLs left out; < 3 markers or no 60 % majority = undetermined → fails) |
| `reply.minChars` / `maxChars` | reply length |
| `events.must` | audit events of the turn matching `type` and every `where` path: at least `min` (default 1), at most `max` |
| `events.mustNot` | no matching event |
| `where` values | a literal (strict equality), `{regex}` (no flags), `{gte}` / `{lte}` (numbers), `{in: [...]}`, `{exists}` (`null` counts as present); against an array field a literal, regex or `in` matches when one element does |
| `tools.mustCall` / `mustNotCall` / `maxCalls` | **dispatched** calls: orchestrator `tool_call_requested`, sub-agent `sub_agent_tool_call` with phase `start`. Refused attempts (`tool_call_blocked`, `sub_agent_tool_blocked`, `tool_restriction_refused`, a sub-agent `done` without `start`) never count — the report lists them apart |
| `agents.mustRun` / `mustRunAny` / `mustNotRun` / `maxRuns` | `sub_agent_started` by `data.agentName` (the `stage`-carrying discovery note is not a run) |
| `artifacts.minCount` / `pathMatches` | files the turn delivered: attachments on its answer and the artifacts its tool calls recorded (`session.get`); regexes with flag `i` over each path |
| `durationMs.max` | send → final status |
| `judge` | an OpenAI-compatible model scores the reply against `rubric` 0–10; fails below `minScore`. Runs only after every other check passed; **skipped (not failed)** without `E2E_JUDGE_URL`/`E2E_JUDGE_MODEL`; an answer other than one line `SCORE: n`, or an unreachable judge, fails the attempt |

**The event window.** A turn's audit events are those of its session and every sub-agent run/workflow under
it, from the send until the **next step that is not a `wait`** starts — some are logged after the final
status (the intent readout runs post-delivery; scorecards and latency rows trail). Status, reply, artifacts
and duration are checked at the final status; `events`, `tools`, `agents` and then the judge when the window
closes. Follow a turn with `{ kind: "wait", ms: 20000 }` to assert post-turn events. After the last step the
window stays open `E2E_EVENT_GRACE_MS` (default 5000) past the final status; between steps at least 1.5 s.

### Mid-turn actions (`during`)

Each fires once, while the turn runs:
`{ when: { event: <matcher> } | { afterMs: n }, do: { steer: "text" } | { stop: true } }`.
`steer` posts to `/api/sessions/:id/steer` with the turn's request id; `stop` sends `chat.cancel`. An action
that never fired before the turn ended, or that the gateway did not take (`steered: false`,
`cancelled: false`), fails the turn.

## Environment variables

| Variable | Default | Use |
|---|---|---|
| `E2E_GATEWAY_URL` | `http://localhost:8765` | the gateway (WS at `/ws`; the token goes in the Authorization header) |
| `E2E_CREDENTIALS_PATH` | `eval/e2e/.credentials.local.json` | the accounts file |
| `E2E_EVENT_GRACE_MS` | `5000` | how long the last turn's event window stays open past its final status |
| `E2E_JUDGE_URL`, `E2E_JUDGE_MODEL`, `E2E_JUDGE_API_KEY` | — | the rubric judge (base URL or `…/chat/completions`) |
| `E2E_MAIL_API` | `http://localhost:18080` | GreenMail REST |
| `E2E_MAIL_SMTP` | API host, port `13025` | GreenMail SMTP as published on the host |
| `E2E_MAIL_INBOX` | `eval@e2e.test` | the eval mailbox |
| `E2E_SITE_URL` | `http://localhost:18081` | the e2e site from the host (agents use `http://www.nordlicht-werkzeuge.test/`) |
| `E2E_SEARXNG_URL` | — | probe SearXNG for `web-search` |

The harness lives in [`packages/core/src/e2e/`](../../packages/core/src/e2e/); its tests run a fake gateway
(`packages/core/src/tests/e2e-harness.test.ts`).
