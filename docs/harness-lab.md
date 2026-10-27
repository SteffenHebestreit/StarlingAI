# Harness lab

The harness lab improves the swarm's prompts from execution evidence, offline, and hands every change to a person to approve. It rebuilds the useful core of Harness² (Recursive Agent Harnessing, arXiv 2610.14224) for a harness that is global: one prompt serves every turn, so an edit must win on the tasks it was made for and must not lose on others.

## What a run does

```
pnpm harness-lab run [--targets 4 | --targets id,id] [--with e2e-site] [--dry-run]
```

1. **Screen.** Every task in `eval/harness-lab/tasks/` runs once on the current prompts. The failing ones become targets, except a task a pending lab proposal was won on: until someone decides on that proposal, proposing for the task again would only repeat it.
2. **Propose → Probe → Compose, per target.**
   - The task runs three more times as reference (`--k-probe`, default 4 runs in all); the worst run becomes a digest of numbered moments (M1, M2, …).
   - Two scoped editors propose at most two small edits each. INV covers how the agent works (procedure, tool use, delegation, completion). DOM covers what a practitioner knows (deliverable shape, sources, structure).
   - Every edit names the moment it answers. Edits that repeat the task's own words, figures or addresses are refused, because they would become wrong anchors for the next task.
   - Each candidate runs on the same task, four times. Two were too few on the local models: an edit that fixed the task in one of two probes was rightly read as weak evidence.
   - The composer keeps, shortens or drops each edit, one line of evidence per decision. Edits whose probes delivered nothing are dropped before it sees them.
3. **Select.** Base and candidate are compared pair by pair: first by the record (delivered, the task's checks, defects on the scorecard), then, only on a tie, by a selector. The selector is asked twice with the two outputs swapped, and only a consistent verdict counts.
4. **Gate.** The edits of the tasks that won are merged: at most three edits per prompt, at most 1200 characters of growth, and of two appended rules that say the same thing in other words only the shorter one. They then run paired against the base on those targets and on a guard set of other tasks. Pairs that disagree are repeated, up to three times.
   - The gate accepts only if the targets win at least two more pairs than they lose, no target gets worse and no guard loses.
   - Alternatively it accepts on selector-only evidence: every target pair tied on the record, and the selector preferred the candidate consistently without ever preferring the base.
   - If more than 20% of the pairs cannot be scored, the run gives no verdict (exit code 3).
5. **Propose.** An accepted candidate becomes **one pending proposal** in Settings → Config Assistant. Apply it there, or don't.
   - An appended rule goes in as "append".
   - A replaced span makes the whole prompt a "replace". It carries the hash of the prompt it was measured against, so applying it after someone changed that prompt is refused.
   - A new proposal that makes every change of an older pending lab proposal supersedes it: the older one is closed as rejected, with a note naming the newer one.

The report is written to `report.md` / `report.json` under `--out` (default `.starlingai/harness-lab/<timestamp>/`), and every attempt's record to `runs/`.

## Skills and the experience library

**Skill candidates.** An editor may propose `add_skill`: a multi-step procedure that is loaded only on turns matching its trigger.
- A skill candidate is written into the candidate arm's scratch workspace only, never into the live library: draft skills are injected as soon as they exist.
- Every attempt starts from a copy of the live library taken when the lab starts, so the base arm runs with the skills a live turn finds.
- An accepted skill is not part of the config proposal. The report holds its `SKILL.md`; add it on the Skills page.

**Hook candidates.** Where a fix belongs to a tool rather than a prompt, the INV editor may propose `add_hook`: one enforcement hook (`append_hint`, `cap_tool` or `verify_write`, see `packages/core/src/tools/enforcement-hooks.ts`).
- It must watch a tool the run called and name a moment of it, like any edit.
- A hint must not carry the task's own facts, a pattern must compile, and a cap leaves the tool at least one call: taking a tool away is a person's decision.
- The candidate arm runs with the hook laid over the deployment's hooks, in the lab process's memory only.
- An accepted hook goes into the proposal as a config change under `enforcementHooks.<id>`, applied with consent like the prompt edits beside it. The report shows it as JSON.

**Experience library.** After each task the reflector writes at most one lesson, or none when the runs show no reusable contrast.
- A lesson has: a cue (the shape of situation, never the task's facts), the component it concerns, the lesson itself, the evidence rows it rests on, and a confidence. "High" confidence is kept only for a task won on the record.
- Once the gate has decided, each lesson gets a verdict: "helped" (the gate accepted), "hurt" (the candidate lost pairs or a guard), "no effect", or "confounded".
- Lessons are stored in `harness-lab/library/entries.jsonl` under the deployment's state directory, with an `INDEX.md` for people.
- The editors of the next run see the index, the task's own domain first, as examples. An edit that reuses an entry names it in `fromEntry` and still cites a moment of its own run.
- A dry run writes no lessons.

## Isolation

The lab runs in a process of its own: on the host, or as a second process inside the gateway container (`node packages/core/dist/scripts/harness-lab.js run …`). It never runs inside the gateway.

- **Candidate prompts are in memory only.** A candidate's prompts are laid over the loaded config in memory (`applyLabPromptOverlay`). That process can write neither the compiled config nor the runtime overlay.
- **Shared stores are unset.** Redis, Postgres, Memgraph and QuestDB are switched off for the lab process. Its audit log and session store live under `--out`.
- **Each attempt is sandboxed in its own workspace.** Every attempt runs in a fresh scratch workspace, on the `eval` channel, as a synthetic principal. Eval traffic stays out of skill statistics, distillation, the outcome ledger and retrieval credit.
  - The scratch workspaces live under `generated/.harness-lab/<run>/` while the run lasts, because the code sandbox may bind nothing under `.starlingai` (the socket proxy refuses it: state and secrets live there). When the run stops, finished, paused or failed, they move to `<out>/scratch/` and `generated/` is left as it was.
- **Tools that reach outside the scratch workspace are left out or stubbed.**
  - Left out: real infrastructure, desktops, mailboxes, credentials and the deployment's own config.
  - Stubbed: messages, schedules and writes to shared stores. The call and its arguments are recorded, but nothing runs.
  - `--auto` in a task message approves only tools that run in a sandbox of their own.
  - Add your own entries with `selfImprovement.harnessLab.toolPolicy`.

## Tasks

`pnpm harness-lab import --write` converts every E2E scenario a lab attempt can run as it is into `eval/harness-lab/tasks/e2e-seeds.jsonc`. It skips scenarios that need a browser, mail, a desktop, image or speech, several sessions, attachments, or actions during a turn. A task needing the E2E fixture site runs only with `--with e2e-site`.

A task uses the E2E turn checks (`expect`). Its `role` is "target", "guard" or "both". A task derived from a live turn must contain invented names and content, and runs only once `reviewed` is set.

### Tasks from failed live turns

```
pnpm harness-lab harvest [--since 14d] [--limit 5] [--include-errors] [--dry-run]
pnpm harness-lab review [--accept <id> [--by <name>] | --reject <id>]
```

`harvest` reads the turns the live swarm itself recorded as failures (`turn_scorecard` with `learningOutcome: "failure"`). It needs the Postgres audit and the Redis session store, so it runs inside the gateway container, where it opens both read-only. Test traffic (the `eval`, `scene` and `test` channels, the E2E and lab accounts) is left out, and so are thrown turns, which are mostly the model or a service being down (`--include-errors` keeps them).

For each failed turn the lab's local anonymizer (`roles.anonymizer`) writes a synthetic task:
- It keeps the kind of request, the deliverable, the capabilities it needed and the language.
- It invents every name, figure and address. Web and mail addresses are only on reserved example hosts, and there are no phone or account numbers.
- It declines a request about the person's own private records.

A screen then refuses a task that still carries an outside address, a phone number, an IBAN, a figure of three or more digits from the original, or six words of it in a row. The original's rarer words the task shares are listed for the reviewer, never refused: they are often just the subject ("invoice").

A turn that needed a browser, a mailbox, a desktop, images or speech is skipped, because the lab does not run those.

What passes lands in `eval/harness-lab/inbox/`, which git ignores: the lab runs nothing from there. `review` lists it.
- `--accept` moves a task into `eval/harness-lab/tasks/`, stamped as reviewed.
- `--reject` drops it and remembers its turn, so a later harvest does not derive it again.

The original text reaches the local model only. It is never written to a file, a log or the report, and a task remembers its turn only as a digest.

## Nightly runs

```
sai start --harness-lab        # or --all, or SAI_ENABLE_HARNESS_LAB=1 in .env
```

The stack runs the nightly lab itself, in a container of its own: the `harness-lab` service. It uses the gateway's image, environment and mounts, but not its process, port or health check. It needs no timer on the host and nobody logged on, and it runs whenever the stack runs. Every day at `SAI_HARNESS_LAB_AT` (default `02:30`), a clock in `SAI_HARNESS_LAB_TZ` (an IANA zone such as `Europe/Berlin`, default `UTC`), it runs one night. A night missed while the stack was down is not made up. Its output goes to the container's log and to `.starlingai/harness-lab/nightly.log`. To run a night now:

```
docker exec -d starlingai-harness-lab-1 node packages/core/dist/scripts/harness-lab-timer.js --once --log /workspace/.starlingai/harness-lab/nightly.log
```

On a host without the service, `node scripts/harness-lab-nightly.mjs [--budget 4h] [--quiet 10m] [--no-harvest]` runs the same night inside the gateway container, for a timer on the host (Windows Task Scheduler, cron). The gateway's own cron never runs it. A lock (`timer.lock` in the nightly root) keeps two nights from running at once, whoever started them; a night that finds it held is skipped (exit 5).

A night first harvests the last two days' failed turns into the inbox, then runs `harness-lab nightly`. That is `run` with three additions:
- **It gives way to live use.** Before every new attempt it reads the end of the live audit log, and waits while someone sent a message within the quiet window. Lab turns and live turns share the model server.
- **It has a time budget.** Once the budget is spent, the run stops before its next new attempt (exit code 4).
- **The next night goes on with that run.** Every attempt and lab model call is recorded under the run's directory, keyed by what went in. Replayed in order, the records give the editors the same input, so they propose the same edits, and the run continues where it stopped. Nothing recorded against older prompts or another core version is served again.

Any `run` on an `--out` that holds an earlier run continues it the same way. The host timer's registration commands are in the wrapper's header. Nightly runs and their `state.json` live under `.starlingai/harness-lab/nightly/` in the deployment's workspace.

## Configuration

`selfImprovement.harnessLab`:

| Key | Meaning |
|---|---|
| `enabled` | Default false. The CLI refuses to run while it is off. |
| `roles.{editor,composer,selector,reflector,anonymizer}` | `"<provider>/<model>"` for each lab role. Unset means the swarm's primary model, so the model server does not swap between a turn and the lab's call after it. The anonymizer reads live turns: keep it on a local model. |
| `enableThinking` | Reasoning on for the lab's own calls. |
| `toolPolicy.{stub,deny}` | Tools the lab stubs or leaves out, on top of its defaults. |

## Reading a report

- **Health → editor edits valid.** Below 50% means the editor model breaks the edit rules more often than not; give the editor role a stronger model.
- **Health → first position picked.** Above 70% means the selector's verdicts are position bias. Only the swap-consistent ones count, but few of them will remain.
- **Gate → selector-only evidence.** The record could not tell base and candidate apart, and the improvement rests on the selector's judgement. Read the edits before applying.
