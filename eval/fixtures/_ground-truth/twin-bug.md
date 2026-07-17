# Ground truth — twin-bug-sweep

**Kept outside every fixture workspace** so the agent under test cannot read the answer key (the case's `workspacePath` is `eval/fixtures/twin-bug`, and this file is a sibling of that directory).

The fixture code lives under `twin-bug/generated/` — a non-`full` agent (code_analyst) is re-rooted there and cannot see files at the workspace root (see `../README.md`).

## The defect
`generated/invoices.py:invoice_total` computes `int(subtotal + tax)`. `int()` truncates the fractional part toward zero instead of rounding, so a true total of 60.99 is reported as 60 — totals come out up to a cent low.

## The twin
The **same** `int(subtotal + tax)` truncation exists in `generated/receipts.py:receipt_total`. The task only names `invoices.py`, so an agent that fixes/diagnoses only the named file misses the twin.

## Pass criterion
`code_analyst` (updated in Phase 4 with the twin sweep) must diagnose the truncation AND search the workspace for the same construct, then name the second site. The hard assertion is `expectIncludes: ["receipts.py"]` — the twin was found and reported. A run that names the bug but never searches (never mentions `receipts.py`, or claims no other sites) is the failure this fixture catches.

The prompt asks the agent to report this as a structured artifact line:

```
TWINS: searched int(subtotal + tax) — found 1 other site: receipts.py
```

**Observed on qwen3.6-35b-a3b:** the agent reliably reads both files and reports the twin (`receipts.py`) in prose, but does not always emit the exact `TWINS:` prefix. Format adherence is model-dependent; a stronger model hits it. So the assertion checks the behavior (twin named), and the `TWINS:` format is the aspirational target, not the gate — asserting the literal `TWINS:` token would measure format compliance of the local model rather than whether the sweep happened.

## Known limitation
Judging is substring matching on the report text; the harness does not diff the working tree. It confirms the agent *reported* the twin, not that a downstream fix touched both files.
