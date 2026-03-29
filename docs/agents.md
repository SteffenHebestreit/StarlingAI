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

Typical built-in patterns include keeping a broadly capable main assistant with direct tools while also configuring narrower specialists for the same capability. For example, image generation can be exposed directly on the main assistant through `generate_image` and also through a dedicated `image_creator` sub-agent that focuses on prompt crafting and visual iteration.

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
    "description": "Run a browser-assisted application workflow for one approved lead.",
    "task": "Use web_task_coordinator to review one approved lead and delegate browser submission only after stored credentials exist and secure credential fill has been approved.",
    "allowedAgents": ["web_task_coordinator", "browser_agent", "researcher", "summarizer"]
  }
}
```

When a scene is launched, that `allowedAgents` list is passed into the runtime and sub-agent tools respect it for delegation and search.

For credentialed browser scenes, let the browser specialist use `get_site_credentials` for metadata, then place the approval gate on `site_fill_credentials`. For desktop login flows, gate `computer_type_credential` instead.

## Ephemeral Agents

The runtime supports creating ephemeral agents on demand for tasks where no existing specialist is a good fit. These are not written back to `starlingai.json`; they are registered in memory for the life of the session or process.

The usual entry path is the `agent_factory` flow, which decides whether a one-off agent is warranted and then creates it with the minimum necessary tool set. This is a core swarm capability: the system can self-specialize by generating new agent types at runtime rather than requiring all specialists to be pre-configured.

### Emergent Architect Fallback

When the best routed or autonomously bid specialist scores below `agents.ephemeralGeneration.skillMatchThreshold` (default `0.75`), `runArchitectFallback` is called. A dedicated `agent_architect` specialist writes the ephemeral agent spec: description, system prompt, tool selection from `GRANTABLE_TOOLS`, model override, and maxIterations. That spec is then validated and executed immediately on the original task.

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
| `repeated_identical_output` | Same tool returns identical output ≥3 times in a row | `warden_alert` (warn) — runtime also injects a loop-break notice into the LLM context |

All alerts appear in the JSONL audit log and the real-time WebSocket dashboard stream.

## Parallel Delegation

The orchestrator can run multiple specialists in parallel for decomposable work — a direct expression of the swarm principle that independent sub-tasks should run concurrently and be synthesized. The resulting swarm state is surfaced live over `agent.swarm` WebSocket events and persisted in the web dashboard's swarm run history.

This enables the emergent execution pattern from the starling swarm analogy: a researcher, an analyst, and a writer can each work independently, then their outputs are combined into something no single agent could produce alone.

## Recommended Future Stack

For source-backed papers, technical reports, and any workflow where fabricated citations are unacceptable, use this chain:

- `citation_researcher` to gather authoritative sources with URL and date metadata
- `paper_author` to draft only from collected evidence
- `source_verifier` to reject unsupported claims and invented references before final output
- `prompt_optimizer` when a specialist keeps looping, overusing tools, or inventing unsupported details
- `incident_responder` when provider, gateway, or model-id failures need fast diagnosis

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

## Main Assistant Live Eval

The checked-in agent harness above evaluates sub-agents directly. For runtime behavior that lives in the main assistant turn loop, such as dynamic web-search guidance, use the live gateway evaluator instead:

```bash
pnpm runtime-guidance:evaluate
```

This reads [runtime-guidance-eval.example.jsonc](c:\Users\steffen\Documents\starlingAI\runtime-guidance-eval.example.jsonc), sends each prompt through `/api/chat/stream`, and records whether the assistant actually invoked tools like `web_search`.

The live-eval plan format is:

```jsonc
{
  "gatewayBaseUrl": "http://127.0.0.1:8765",
  "outputPath": "./.starlingai/live-check/runtime-guidance-eval-report.json",
  "cases": [
    {
      "name": "official-docs-natural",
      "message": "Find the official Model Context Protocol specification and repo. Keep it short.",
      "expectToolIncludes": ["web_search"],
      "expectTextIncludes": ["Model Context Protocol"],
      "maxDurationMs": 45000
    },
    {
      "name": "timeless-control",
      "message": "Explain how binary search works in one paragraph.",
      "expectToolExcludes": ["web_search", "web_fetch"],
      "maxDurationMs": 20000
    }
  ]
}
```

The report includes the observed tool calls, stream event types, response preview, and per-case pass/fail reasons.

---

## Penetration Testing Agents

StarlingAI includes a Kali Linux-based pentest swarm activated with the `pentest` Docker Compose profile. The toolchain enforces a mandatory authorization workflow before any active scanning begins.

### Pre-flight workflow (enforced by `pentest_coordinator`)

```
1. Ask user for written authorization confirmation
2. Ask user for authorized target scope (IPs / CIDRs / hostnames)
3. Ask user for authorization reference (ticket, contract, letter)
4. Call pentest_set_scope  →  unlocks active scanning tools
5. Delegate phases to specialist agents
6. Generate report via report_writer_agent
```

### Agent catalog

| Agent | Role | Key tools |
|---|---|---|
| `pentest_coordinator` | Orchestrates the full engagement | `pentest_set_scope`, delegation tools |
| `recon_agent` | Port scanning and CVE lookup | `nmap_scan`, `searchsploit_query` |
| `web_auditor_agent` | Web app vulnerability assessment | `nikto_scan`, `gobuster_scan`, `sqlmap_scan` |
| `network_auditor_agent` | Network service and credential testing | `nmap_scan`, `hydra_attack` |
| `exploit_agent` | Metasploit exploitation (explicit approval per exploit) | `metasploit_exec` |
| `report_writer_agent` | Collects findings and writes the report | `pentest_report` |

### Tool tiers for pentest tools

| Tool | Tier | Requires approval |
|---|---|---|
| `searchsploit_query` | 0 (read-only, offline) | No |
| `pentest_report` | 1 (write to workspace) | No |
| All active scanning tools | 3 (privileged) | Yes — per call |

Scope is also validated server-side in the `kali-pentest` service — a target not in the authorized scope is rejected even if the tool tier approval was granted.

> **Full documentation:** [docs/pentest.md](pentest.md)

