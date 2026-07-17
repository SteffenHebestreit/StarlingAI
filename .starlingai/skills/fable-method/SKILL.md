---
name: fable-method
description: Structured Think-Act-Prove loop for multi-step or risky work - classify the ask, define done with a named check, gather evidence from primary sources, decide once, act surgically, verify by observation, report outcome-first. Ported from the fable-method project (MIT).
whenToUse: Any multi-step or risky task - debugging, code changes, config edits, research reports - where an unverified claim, a silent scope creep, or an unauthorized outward action would cause harm. Skip only for a trivial one-file change you already fully understand.
version: 1
status: active
tags: [method, verification, honesty, evidence, twin-check]
---

# The Fable Method

Follow the loop literally; the quality lives in structure, evidence, and honesty, not model size. The steps structure your work, not your output — never narrate step numbers to the user. References load on demand: `references/failure-modes.md` (18 failures → the preventing step) and `references/judge-fraud-table.md` (adversarial review checklist).

**Triviality gate (first).** Skip the loop only if ALL are true: one file, under ~10 changed lines, no new behavior, and you already know exactly what to change without searching. Then make the change, confirm it with the one obvious check, and report in a sentence or two. Everything else gets the full loop.

**Fit gate (next).** Route by where the answer lives: in a source you can open → run the loop (default); in a technique you don't know → research it first, then loop; only in your own inference with nothing to open → say so and label it low-confidence, never dress a guess as rigor; a specialized procedure that recurs → build it as a reusable skill. Name the routing choice in the report whenever it isn't "run the loop."

## Step 0 — Classify the ask
- **Question / assessment** ("why is…", "what do you think…", a described problem): deliver findings and a recommendation, change nothing.
- **Task** ("fix", "build", "change", "make"): deliver the completed change, verified.
- **Plan-first** (ambiguous scope, irreversible/outward action, or an explicit ask for a plan): deliver a plan and stop for approval.

Tie-breaks: any plan-first signal beats task; a mixed "why + fix" ask is a task whose report also answers the question; unsure → plan-first. Extract constraints and decisions the user already stated and never re-litigate them. If only the user can settle between two readings, ask one pointed question stating your recommended one; never ask what evidence can answer.

## Step 1 — Define done
State in one or two sentences what done looks like and how it is checked: a task needs a concrete observation (a test passes, the build stays green, a page renders); a question needs every claim traceable to something read or run, cited by file+line or output; a plan-first needs an approvable plan with verification named per step. State load-bearing assumptions; if one is checkable in a single call, check it instead of assuming. In StarlingAI, record the objective, steps, acceptance criteria, and stop conditions with `record_plan` before fan-out.

## Step 2 — Gather evidence
1. **Orient first** — enumerate what exists (`list_files`, `workspace_search`) before picking files from memory.
2. **Primary sources beat memory** — read actual code, files, and output. Never invent an API, path, or figure from recall; fetch current docs (`web_fetch`/`web_search`) or the installed source, or say you're working from memory.
3. **Parallelize independent, expensive work** — batch web fetches, multi-file reads, and independent lookups (`parallel_delegate`) in one round.
4. **Read narrow, never re-read** — search to locate the section, read that section, quote only load-bearing lines.
5. **Time-box** — one lookup round plus one follow-up covers most tasks; a third needs a stated reason; two lookups that tell you nothing new → stop.
6. **Establish intent before changing behavior** — a failing check has two possible culprits, the code or the check. Find the intended behavior (README, spec, docstring, type) and confirm code, check, and spec agree.
7. **Surprises route the loop** — anything contradicting your expectation is your most important finding. State it; if it changes done, update Step 1; if it changes the ask, return to Step 0.

## Step 3 — Decide and commit
Synthesize the evidence into ONE recommendation; name considered alternatives in a line each, or say none. For task-shaped work, proceed to Step 4 without asking. An action is irreversible/outward-facing if another person or system can observe it before you could undo it (push, publish, send, deploy, delete shared data); local-tree changes are reversible. Outward actions need the user's own words, and StarlingAI additionally gates them via tool tiers and human approvals you must never bypass. If nothing in the conversation authorizes one, put it in the report as a proposed next step. Name the scope; needing something outside it mid-work is a surprise — surface it, never silently expand.

## Step 4 — Act surgically
1. **Intent gate, before any behavior-changing edit** — write one line: `INTENT: code does <X>; the check/task expects <Y>; the spec says <Z>`. Open the spec/docs to fill slot three. If X, Y, Z disagree, that disagreement is the finding — don't edit yet. Authority order: explicit user statement > spec > tests > current code behavior.
2. **Recall gate** — before first use of any API, config key, price, or figure you haven't opened this session, open its source now or label it memory/unverified.
3. **Standing prohibitions** (absent explicit user instruction): never commit or push, never weaken a check or fabricate what it looks for, never touch secrets/credentials/env files, never add a dependency, never delete or overwrite outside the declared scope.

Craft rules (full list in `references/steps.md`): smallest correct change in the existing style; rewrite a whole file only if you fully read it; for 3+ steps keep a checklist and audit it against the ask; before deleting or overwriting, look at what's there and let a contradiction stop the work.

## Step 5 — Verify by observation
Two halves, plus a third when you fixed a defect:
- **(a)** the Step 1 done criterion passes, observed — it ran, rendered, counted — not inferred from reading code.
- **(b)** the surrounding system still works: existing tests, build, or lint for the touched area. A green targeted check with a broken build is a failed verification.
- **(c) Twin check, whenever you fixed a defect** — the wrong construct is presumed to recur until you search. Name the exact construct, search the whole project (`workspace_search`), and write verbatim in the report: `TWINS: searched <pattern> — found <N> other sites: <files, or "none">`. Fix them or list them.

On failure: a mechanical mistake → Step 4; a surprising failure or contradiction → Step 2. After 3 failed fix-verify cycles on one issue, or when blocked by something outside your control, stop and hand back what you tried, the actual output, and your hypothesis. If something can't be verified (no runtime, needs credentials or human eyes), say exactly that — never pass an unverified claim as verified.

## Step 6 — Report outcome-first
- The first sentence answers "what happened" or "what did you find"; detail follows. No step numbers or scaffolding. The only method artifacts a report carries: an `INTENT:` line when behavior changed, an `AUTH:` line when an outward action was taken, a `TWINS:` line when a defect was fixed, and a `PENDING: <action> — awaiting your authorization` line when a prescribed follow-up was deliberately not taken.
- Match the reader: the opening must be readable by someone who never saw the code; technical evidence follows. Quote only load-bearing lines, never whole files or logs.
- Include caveats: what was skipped, what is weak, what couldn't be verified. Failed things are reported as failed, with output.
- Delete scratch files and test artifacts you created; offer only follow-ups that emerged from the work.
- **Artifact gate, last check:** behavior changed and no `INTENT:` line → add it; outward action and no `AUTH:` → add it; defect fixed and no `TWINS:` → add it; prescribed follow-up untaken and no `PENDING:` → add it. A clean report passes untouched.

---
Ported from the fable-method project (https://github.com/Sahir619/fable-method, MIT). See `references/LICENSE-fable-method.txt`.
