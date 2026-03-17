# Sub-Agent Reference

<p align="center">
  <img src="../swarmLogo.svg" alt="StarlingAI logo" width="180" />
</p>

StarlingAI is a general-purpose agent swarm that tackles any task domain by composing specialized sub-agents. Agents are loaded from `starlingai.json` at runtime. The orchestrator discovers them through the hybrid routing layer, can restrict them per scene, can evaluate them through the built-in harness, and can create ephemeral agents on demand for tasks that no existing specialist covers.

The swarm's emergent behavior comes from how agents are discovered, composed, and iterated — not from hard-coded task pipelines.

See also: [Configuration Reference](configuration.md) · [Tool Tiers & Guardrails](tool-tiers.md)

## What A Sub-Agent Entry Contains

Each configured sub-agent can define:

- `description`
- `capabilities`
- `tags`
- `model`
- `systemPrompt`
- `tools`
- `maxIterations`
- `container`

The runtime exposes the current catalog through `GET /api/agents`.

## Routing Model

The orchestrator resolves agents through the hybrid routing layer used by `search_agents` and surfaced at `GET /api/agents/resolve`. This routing is domain-agnostic — the same mechanism works for research tasks, code analysis, browser automation, data processing, or any other domain where a specialist has been configured.

Current routing signals:

- keyword overlap from names, descriptions, capabilities, and tags
- embedding similarity when an embedding model is configured
- historical outcome weighting from prior runs (±12.5% boost/penalty)

The routing layer creates a **self-tuning swarm**: agents that consistently succeed are ranked higher; agents that fail are deprioritized. No manual intervention is needed — the swarm improves its specialist selection over time.

The resolve API returns:

- `results`: accepted candidates at or above the requested confidence floor
- `weakCandidates`: near matches below that floor
- `mode`: `keyword` or `hybrid`
- `gated`: whether stronger candidates were withheld by the requested threshold

`minConfidence` is one of `high`, `medium`, or `low`.

## Outcome Tracking

Delegations are written to the agent outcomes log and aggregated by `GET /api/agents/outcomes`.

That endpoint reports fields such as:

- `calls`
- `success`
- `failure`
- `partial`
- `successRate`
- `avgTokens`
- `avgIterations`
- `latestLesson`
- `lastSeen`

Those outcomes feed back into routing so repeatedly failing agents lose ranking weight over time.

## Scene Restrictions

Scenes can narrow which agents may be used for a run:

```jsonc
"scenes": {
  "apply_jobs": {
    "description": "Submit one ranked lead.",
    "task": "Run the application pipeline.",
    "allowedAgents": ["application_pipeline", "proposal_writer"]
  }
}
```

When a scene is launched, that `allowedAgents` list is passed into the runtime and sub-agent tools respect it for delegation and search.

## Ephemeral Agents

The runtime supports creating ephemeral agents on demand for tasks where no existing specialist is a good fit. These are not written back to `starlingai.json`; they are registered in memory for the life of the session or process.

The usual entry path is the `agent_factory` flow, which decides whether a one-off agent is warranted and then creates it with the minimum necessary tool set. This is a core swarm capability: the system can self-specialize by generating new agent types at runtime rather than requiring all specialists to be pre-configured.

### Emergent Architect Fallback

When all routing candidates score below the confidence floor, `runArchitectFallback` is called. The orchestrator LLM is prompted to design a purpose-built ephemeral agent (system prompt, tool selection from `GRANTABLE_TOOLS`, maxIterations), which is then validated and executed immediately.

### Auto-Promotion

After each successful ephemeral run, `maybePromoteEphemeral` checks the outcome history. If an ephemeral type accumulates ≥3 successes at >60% success rate, it is automatically written to `.starlingai/promoted_agents.json` and merged into the live routing index — no manual configuration required. Promoted agents are surfaced as `"auto-promoted"` in `list_agents` output and do not overwrite permanent config entries.

## Circuit Breaker

The routing layer automatically excludes agents that have been failing consistently. An agent is circuit-broken when its failure rate exceeds 60% over the last 10 delegations (minimum 3 samples). Tripped agents are suppressed in `resolveAgentRouting()` and displayed as `circuit_open` in `list_agents` and `search_agents` output.

The Warden reinforces the circuit breaker when it detects `repeated_failures`: it appends 3 synthetic failure outcomes to the tripped agent's history, accelerating suppression before the next routing decision.

## Warden Monitoring

The Warden agent runs as a background process subscribing to the live audit stream. It detects five anomaly classes:

| Class | Trigger | Action |
|---|---|---|
| `tool_storm` | >15 tool calls in 5 min | `warden_alert` (warn) |
| `repeated_failures` | Agent fails ≥3 times in 2 min | Reinforce circuit breaker + `warden_alert` (error) |
| `tool_escape_attempt` | Sub-agent has ≥3 blocked tool calls | Reinforce circuit breaker + `warden_alert` (error) |
| `rate_limit_flood` | Sender rate-limited ≥5 times in 1 min | `warden_alert` (warn) |
| `turn_slo_breach` | Turn exceeds `orchestratorTurnSloMs` or `subAgentTurnSloMs` | `warden_alert` (warn) |

All alerts appear in the JSONL audit log and the real-time WebSocket dashboard stream.

## Parallel Delegation

The orchestrator can run multiple specialists in parallel for decomposable work — a direct expression of the swarm principle that independent sub-tasks should run concurrently and be synthesized. The resulting swarm state is surfaced live over `agent.swarm` WebSocket events and persisted in the web dashboard's swarm run history.

This enables the emergent execution pattern from the starling swarm analogy: a researcher, an analyst, and a writer can each work independently, then their outputs are combined into something no single agent could produce alone.

## Collective Memory

Sub-agents within a session share a key–value fact store backed by Redis (with in-process fallback). Before each sub-agent call, any existing shared facts are injected into the `context` parameter. After each successful run, any `FACT: key = value` lines in the output are extracted and stored for subsequent agents.

The `read_shared_facts(query=...)` tool performs embedding-backed semantic lookup over the shared fact store, enabling fuzzy recall across larger knowledge sets. Non-containerized agents can publish findings mid-task via `share_finding(key, value)`.

## Autonomous Swarm Bidding

When a task is dispatched with `dispatchMode: "autonomous_bidding"`, the swarm bus emits a `task_announced` event and waits for a configurable window (default 125 ms) to collect `task_bid` offers from any registered bidder. Bids include confidence level and matched routing terms. The top-ranked bid wins the delegation. This is a first-pass implementation; fully independent long-running bidder processes are deferred.

## Evaluation Harness

Run evaluations with:

```bash
pnpm agents:evaluate
```

This uses the checked-in `agent-eval.jsonc` suite by default. To customize it, copy `agent-eval.example.jsonc` or `agent-eval.jsonc` to a new file and pass that path explicitly.

The current plan format is:

```jsonc
{
  "workspacePath": "/workspace",
  "outputPath": "./.starlingai/agent-eval-report.json",
  "cases": [
    {
      "name": "research-docs",
      "agentName": "researcher",
      "task": "Find the LM Studio documentation for function calling.",
      "context": "optional extra context",
      "workspacePath": "/workspace",
      "expectIncludes": ["LM Studio"],
      "expectExcludes": ["Sub-agent error:"],
      "maxDurationMs": 45000
    }
  ]
}
```

Important details:

- the root key is `cases`, not the older `plan`
- each case uses `agentName`, not `agent`
- expectations are `expectIncludes` and `expectExcludes`
- duration guard is `maxDurationMs`

The harness writes a JSON report and prints a concise summary with pass/fail counts and output previews.
