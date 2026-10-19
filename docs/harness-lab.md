# Harness lab

The harness lab improves the swarm's prompts from execution evidence, offline, and hands every change to a person to approve. It rebuilds the useful core of Harness² (Recursive Agent Harnessing, arXiv 2610.14224) for a harness that is global: one prompt serves every turn, so an edit must win on the tasks it was made for and must not lose on others.

## What a run does

```
pnpm harness-lab run [--targets 4 | --targets id,id] [--with e2e-site] [--dry-run]
```

1. **Screen.** Every task in `eval/harness-lab/tasks/` runs once on the current prompts. The failing ones become targets.
2. **Propose → Probe → Compose, per target.**
   - The task runs twice more as reference; the worse run becomes a digest of numbered moments (M1, M2, …).
   - Two scoped editors propose at most two small edits each. INV covers how the agent works (procedure, tool use, delegation, completion). DOM covers what a practitioner knows (deliverable shape, sources, structure).
   - Every edit names the moment it answers. Edits that repeat the task's own words, figures or addresses are refused, because they would become wrong anchors for the next task.
   - Each candidate runs on the same task.
   - The composer keeps, shortens or drops each edit, one line of evidence per decision. Edits whose probes delivered nothing are dropped before it sees them.
3. **Select.** Base and candidate are compared pair by pair: first by the record (delivered, the task's checks, defects on the scorecard), then, only on a tie, by a selector. The selector is asked twice with the two outputs swapped, and only a consistent verdict counts.
4. **Gate.** The edits of the tasks that won are merged: at most three edits per prompt, at most 1200 characters of growth. They then run paired against the base on those targets and on a guard set of other tasks. Pairs that disagree are repeated, up to three times.
   - The gate accepts only if the targets win at least two more pairs than they lose, no target gets worse and no guard loses.
   - Alternatively it accepts on selector-only evidence: every target pair tied on the record, and the selector preferred the candidate consistently without ever preferring the base.
   - If more than 20% of the pairs cannot be scored, the run gives no verdict (exit code 3).
5. **Propose.** An accepted candidate becomes **one pending proposal** in Settings → Config Assistant. Apply it there, or don't.
   - An appended rule goes in as "append".
   - A replaced span makes the whole prompt a "replace". It carries the hash of the prompt it was measured against, so applying it after someone changed that prompt is refused.

The report is written to `report.md` / `report.json` under `--out` (default `.starlingai/harness-lab/<timestamp>/`), and every attempt's record to `runs/`.

## Isolation

The lab runs in a process of its own: on the host, or as a second process inside the gateway container (`node packages/core/dist/scripts/harness-lab.js run …`). It never runs inside the gateway.

- **Candidate prompts are in memory only.** A candidate's prompts are laid over the loaded config in memory (`applyLabPromptOverlay`). That process can write neither the compiled config nor the runtime overlay.
- **Shared stores are unset.** Redis, Postgres, Memgraph and QuestDB are switched off for the lab process. Its audit log and session store live under `--out`.
- **Each attempt is sandboxed in its own workspace.** Every attempt runs in a fresh scratch workspace, on the `eval` channel, as a synthetic principal. Eval traffic stays out of skill statistics, distillation, the outcome ledger and retrieval credit.
- **Tools that reach outside the scratch workspace are left out or stubbed.**
  - Left out: real infrastructure, desktops, mailboxes, credentials and the deployment's own config.
  - Stubbed: messages, schedules and writes to shared stores. The call and its arguments are recorded, but nothing runs.
  - `--auto` in a task message approves only tools that run in a sandbox of their own.
  - Add your own entries with `selfImprovement.harnessLab.toolPolicy`.

## Tasks

`pnpm harness-lab import --write` converts every E2E scenario a lab attempt can run as it is into `eval/harness-lab/tasks/e2e-seeds.jsonc`. It skips scenarios that need a browser, mail, a desktop, image or speech, several sessions, attachments, or actions during a turn. A task needing the E2E fixture site runs only with `--with e2e-site`.

A task uses the E2E turn checks (`expect`). Its `role` is "target", "guard" or "both". A task derived from a live turn must contain invented names and content, and runs only once `reviewed` is set.

## Configuration

`selfImprovement.harnessLab`:

| Key | Meaning |
|---|---|
| `enabled` | Default false. The CLI refuses to run while it is off. |
| `roles.{editor,composer,selector}` | `"<provider>/<model>"` for each lab role. Unset means the swarm's primary model, so the model server does not swap between a turn and the lab's call after it. |
| `enableThinking` | Reasoning on for the lab's own calls. |
| `toolPolicy.{stub,deny}` | Tools the lab stubs or leaves out, on top of its defaults. |

## Reading a report

- **Health → editor edits valid.** Below 50% means the editor model breaks the edit rules more often than not; give the editor role a stronger model.
- **Health → first position picked.** Above 70% means the selector's verdicts are position bias. Only the swap-consistent ones count, but few of them will remain.
- **Gate → selector-only evidence.** The record could not tell base and candidate apart, and the improvement rests on the selector's judgement. Read the edits before applying.
