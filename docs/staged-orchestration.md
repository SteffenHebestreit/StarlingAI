# Staged orchestration — layered small-prompt pipeline

> Status: **design** (June 2026). Tracks the decomposition of the monolithic
> orchestrator prompt into staged agents that each carry a small, role-specific
> prompt. Every behavioural slice ships behind a default-off flag and is
> `pass^k`-gated before it can become the default (see CONTRIBUTING → reliability
> eval). This is the architectural form of the prompt-diet / latency work.

## Why

Today every orchestrator LLM call carries one ~24.7K-token main-assistant system
prompt (`session.systemPrompt`, sent on every iteration at
[runtime.ts](../packages/core/src/agent/runtime.ts) `buildSystemMessages`). It
bundles *every* role: receptionist rules, routing, swarm rules, tool-use
discipline, orchestration strategy, synthesis, memory, and security. On a slow
local model that is ~25–28 s of **prefill per call**, and an `--auto` turn makes
several calls (plan → post-tool iterations → synthesis). Splitting the monolith
so each stage gets only the directive it needs cuts per-call prefill and makes
each stage's job legible.

## Target pipeline

```
Receptionist (tiny prompt, routing-tier model)
  ├─ trivial → answer now                              [EXISTS: receptionist.ts]
  └─ <ESCALATE> →
       Discovery: search_agents + search_workflows (+ skills) in PARALLEL
                                                        [tools EXIST; parallel handoff = gap]
         → Coordinator (plan-only prompt): ordered MAIN steps, each with
           parallel SUBSTEPS                            [mission_coordinator + record_plan + run_task_graph EXIST]
             → Execute: sub-agents (own small prompts); a parallelGroup runs
               concurrently, main steps in order        [EXISTS]
                 → QA gate (check prompt): answer vs the plan's acceptance criteria
                     ├─ pass → deliver
                     └─ flaws → back to Coordinator to plan fixes; loop until
                       QA passes (bounded rounds)        [riskGatedQA EXISTS; formalise as the gate]
```

## What exists vs. the gap

| Stage | Today | Gap |
|---|---|---|
| Receptionist | `receptionist.ts`: deterministic gate + few-hundred-token micro-call; trivial→answer, else `<ESCALATE>` | none |
| Discovery | `search_agents` / `search_workflows` / `search_skills` tools | fire them in parallel on escalation and hand the candidate set to the coordinator |
| Coordinator | the 24.7K main assistant plans + delegates | run it as a **distinct small-prompt stage** (plan-making + execution only) |
| Plan shape | `record_plan` (steps, `parallelGroup`, `dependsOn`), `run_task_graph` | already supports ordered main-steps + parallel substeps |
| Execute | sub-agents have their own small prompts (~5K, not 24.7K) | none |
| QA gate | `riskGatedQA` verify-and-repair vs acceptance criteria | formalise as the **delivery gate** with bounded loopback to the coordinator |

**The gap is prompt decomposition + stage routing, not new capabilities.** The
capabilities are all present; they are just multiplexed through one oversized
prompt.

## Incremental build order (each slice: default-off flag → `pass^k` → default-on)

- **S1 — lean synthesis prompt.** The final synthesis call is terminal (it does
  not route or delegate), yet it re-sends the full routing/swarm/tool-discipline
  prompt. Give it a compact "synthesise the gathered evidence into the final
  answer that meets the plan's acceptance criteria; copy facts exactly; never
  claim truncation" prompt. Biggest, safest single-call prefill win. Gate:
  `pass^k` on a multi-section builder case + answer-completeness.
- **S2 — lean planning prompt.** The planning/routing call keeps routing + swarm
  rules but drops synthesis / response-format / personality boilerplate.
- **S3 — QA delivery gate with bounded coordinator loopback.** Promote
  `riskGatedQA` to an explicit gate: on fail, hand the flaws back to the
  coordinator for a fix plan; cap the rounds.
- **S4 — parallel discovery prefetch on escalation.** On receptionist escalate,
  prefetch agent/workflow candidates in parallel and inject a compact candidate
  capsule so the coordinator plans in fewer round-trips.

## Guardrails (non-negotiable)

- **Every slice is `pass^k`-gated before default-on.** Project history: 0/3 blind
  prompt trims survived a reliability A/B; only proven changes land. A flag that
  nothing reads is not added until its slice lands (no dead flags).
- **No overfitting** to one prompt or topic — general signals only.
- **Security/safety never moves between stages.** Each stage keeps the output
  guardrail scan and the tier gates; decomposition is about *latency and clarity*,
  not relaxing protection.
