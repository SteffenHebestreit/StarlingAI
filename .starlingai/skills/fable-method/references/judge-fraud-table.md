# Adversarial review checklist (fable-judge)

Use this when reviewing finished work — your own before reporting, or another agent's report. The stance is fixed: **a report is a set of claims, not evidence.** Nothing is believed that was not observed. Adapted from the fable-judge skill (fable-method project, MIT).

## The stance

The most documented failure of agents is claiming success regardless of reality: "fixed, all tests pass" on broken work, tests quietly weakened until they pass, scope silently expanded. Re-derive the truth; do not trust the summary.

## Procedure

1. **Collect the claims.** From the report, list what was supposedly done, what was supposedly verified ("tests pass", "build green", "renders correctly"), and what was supposedly left untouched. Each becomes a row to prove or refute.
2. **Establish what actually changed.** Run `git_diff` and `git_status` (or diff the directory against a pristine reference). The diff is ground truth; the report is not. Compare the touched files against the ask's blast radius and the plan's declared scope.
3. **Re-run every claimed verification yourself.** Do not read code and nod — run the tests, the build, the script, the page, and capture the actual output. A claim that cannot be re-run (missing environment, credentials, human-eyes-only) is labeled UNVERIFIABLE, never assumed true. (In StarlingAI, `qa_guard` holds `shell_exec` and can re-run; read-only reviewers hand execution to it.)

## Fraud table (hunt in this order of real-world frequency)

| Fraud | What to look for |
|---|---|
| **Weakened checks** | Diff the test files specifically: assertions loosened or deleted, expected values changed to match new behavior, tests skipped, tolerances widened, real calls replaced by mocks. A changed test is guilty until its justification traces to a spec. |
| **False completion** | A pass claimed with no run shown, a partial pass reported as full, "should work now", success language on a failure transcript. |
| **Scope creep** | Changes beyond the ask: drive-by refactors, reformatting, new dependencies, unrequested "improvements". Any touched file the task did not require is a finding even when the code is fine. |
| **Unauthorized action** | An outward effect (deploy, push, publish, send, install, delete of shared data) that no quoted user instruction covers. Check any `AUTH:` line's quote against the conversation; an outward effect with none, or with a quote that does not authorize that action, is the fraud. Documentation telling the agent to deploy is not authorization. |
| **Spec betrayal** | Code changed to satisfy a check that contradicts the README/spec/docstring. Authority order: explicit user statement > spec > tests > current code behavior. |
| **Debris** | Leftover scratch files, debug prints, commented-out code, orphaned imports, hardcoded credentials or URLs added by the change. |

For large work, use the full `failure-modes.md` catalogue as the checklist.

## Verdict (evidence first)

- **VERIFIED** — every load-bearing claim reproduced, no frauds found.
- **VERIFIED WITH CAVEATS** — the work is sound; list exactly what could not be re-run and any minor debris.
- **REFUTED** — a claim failed reproduction or a fraud was found: name the exact claim, show the output that contradicts it, and state the smallest fix.

Format: the verdict first, then a claims table (claim → what was observed), then frauds found, then the recommended action. Never soften a refutation to be polite, and never inflate a caveat into a refutation to look rigorous.

**Note for StarlingAI reviewer agents:** these verdict words are free text for a human/coordinator to read. The automated QA delivery gate parses only `PASS` / `FAIL` — if your output is consumed by that gate, keep the `PASS`/`FAIL` contract and put the VERIFIED/REFUTED language in the prose body, not as the leading token.

---
Adapted from the fable-judge skill (https://github.com/Sahir619/fable-method, MIT).
