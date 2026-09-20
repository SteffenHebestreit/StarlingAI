# Intent detection, routing and prompt diet — research and plan

Status: PHASES A-B PARTIALLY IMPLEMENTED on `develop` (see section 12 for exactly what is built and what is not). Everything behavioural ships default-off. Written 2026-09-19 from a 17-agent codebase/literature survey, four independent designs, three judge reviews, a two-way taxonomy merge, a synthesis and four adversarial critiques. Every number below is either measured on the live deployment (2026-09-16/17), measured against the built registry, or marked as an estimate.

## 0. Summary

Today the swarm decides "who does this" with a 7,331-char hand-written routing table that sits in the always-on prompt, plus a 12,826-char orchestration module that is never injected, plus a 36-tool block of 36,715 chars that is re-derived on every iteration. The mechanical router that already exists (`resolveAgentRouting`) is invisible in production: on the five live turns every delegation was model-named, `search_agents` was called zero times, and no routing score was logged.

The plan replaces that with a small pipeline that runs before the first orchestrator call:

1. **Structural pre-gates** (no LLM): explicit agent directive, workflow-step turns, plan continuation, pending clarify, attachments, pasted content, URLs, autonomous mode.
2. **Mechanical shortlist** (one bare embedding round-trip, no LLM): agents, workflows and skills scored on their existing scales, admitted at their existing floors, compared in one "fit" space.
3. **One short facet call** on the routing tier (frozen ~1,800-char prefix, JSON-constrained, thinking off, catalog-blind so it runs in parallel with the shortlist): emits the request's L1 execution mode, L2 domain, deliverable, multi-part split, "can one unit do it alone", source-sensitivity (the current judge's definition, verbatim), an English restatement, and a decision hint.
4. **Pure fusion**: the facet labels re-order the admitted candidates and licence a dispatch; they never admit anything below a floor and never evict anything above it. Adaptive K by score margin. Ordered decision rules whose last rule is always today's loop with the search tools present, so no turn dead-ends.
5. **Branches**: answer directly / one specialist / one workflow / coordinate with a plan seed / clarify; decompose on failure, never on prediction.

The prompt becomes two byte-stable shapes (LEAN, COORDINATE), a user-role session block, and a per-turn route brief at the tail. Coordinators receive exactly the shortlist as soft data in their run block, on a per-agent head that no longer changes per user or per day.

Measured wins the plan is built around (corrected by the byte and performance review):

| Quantity | Today | After the plan | Slice |
|---|---|---|---|
| Cold prefills per forced orchestration turn (tool-array churn) | 3 | ≤1 | S2 |
| Main tool block on the wire | 36 tools / 36,715 chars | LEAN 12 / 12,608 (−66%), COORDINATE 18 / ~20,050 (−45%) | S7 |
| Always-on head | 16,219 (flips at midnight, per user) | ~16,160 byte-stable (S6) → ~10,900 (S11) | S6, S11 |
| Per-turn tail (iteration 0) | p50 ~4,400 | ~1,850 direct / ~2,350 specialist / ~3,390 coordinate (incl. the ~1,050-char recall digest) | S5 |
| First call, system + tools, turn 1 | 57,360 (70,186 with module) | lean ~26,200 (−54%), coordinate ~36,800 (−36%; −48% vs module case) | S7, S11 |
| First call at turn 5 (38k-char history) | ~31.8k tokens | ~21.4k tokens (−33%) | S7, S11 |
| Routing-tier calls before the first orchestrator call | receptionist (0/5 hits) + judge (serial) | one facet call, parallel with the shortlist | S5 |
| Orchestrator calls on a single-specialist turn | 2–3 (search/plan/dispatch + synthesis) | 1 forced dispatch (thinking off) + synthesis; 0 + synthesis under mechanical dispatch | S5, S10 |
| mission_coordinator head + context | 16,119, per user, per day | ~6,000, byte-identical per agent (−27% on the wire at iteration 0) | S8, S11 |

Decisions only you can make are listed in section 10.

## 1. What the goal is, and what cost each lever targets

The north star (your words across sessions): quick but validated answers, no unnecessary tool or agent calls, cross-agent knowledge sharing, situational updates on long turns. For this initiative you added: shrink the system prompts drastically; manage most of the capability surface mechanically or with a few short LLM calls; a decision tree that first asks whether one agent or one workflow fits well enough to do the task alone and only otherwise coordinates and plans; candidate selection as a merge of embedding matching and a keyword-hierarchy match done by an LLM; a general hierarchy that agents and workflows are categorised by.

Three different costs hide behind "shrink the prompt", and the plan states which lever targets which:

- **Cold prefills.** On the cluster an identical 4.7k-token prefix re-prefills in 0.41–0.44 s; 40 chars prepended at the head costs 41.8 s; the same tool schemas reordered cost 47.2 s. Cold prefills happen on the first turn, at midnight (the date is baked into the head), on every tool-array mutation (10→8→34 within one forced turn), on every module regex flip, and after evictions. Byte **stability** removes most of them. This is the dominant lever on the local backend.
- **Per-token price and instruction load.** On the Claude preset (100% of the measured live traffic) every byte is billed; on any backend a 20k-token instruction prompt competes with the task for attention. Byte **shrink** targets this, and it is staged last because 0 of 3 previous blind prompt trims survived a reliability A/B.
- **Per-iteration tail re-prefill.** Everything after the history is re-prefilled on every iteration (the 454.7 s "which city?" turn was 84% prefill). Tail **shrink** and append-only delivery of shared findings target this.

The June 2026 note "S2 lean planning prompt — disproven, promptCache already caches the 24.7K" was right about warm iterations and silent about everything else. It is superseded, not contradicted.

## 2. What we found (measured)

### 2.1 The prompt today

Full base prompt 29,047 chars = LEAN base 16,219 (always sent) + orchestration MODULE 12,826 (Swarm Rules 3,438, Tool Use Discipline 5,841, Agent Discovery 426, Tool Discovery 908, Orchestration Strategy 2,210). With `splitOrchestrationPrompt=true` in deployment the module was injected on 0 of 5 live turns: its gate reads classifier flags that are hardwired false since the de-lexicalisation, and only two artifact/guide regexes can trigger it. Yet 4 of 5 turns still planned and delegated. The tools make delegation happen, not the prose.

Inside the LEAN base: `## Main Assistant Custom Instructions` 7,331 chars (`workspace/agents/00-platform.jsonc`) is a hand-written intent-to-agent routing table (ATOMIC & SINGLE-DOMAIN ROUTING, WORKFLOWS, RESEARCH/MULTI-AREA, SELF-IMPROVEMENT) — the de-facto router on every turn. Core Principles 4,710; personality 2,381 (read from a per-user file); Response Format 500; Proactive Memory 936; Security 206. The date appears twice in two time zones (head and temporal message), so every prefix goes cold around midnight; an outcomes ledger is appended to the base whenever an agent crosses two adverse outcomes in six hours.

Per-turn tail at iteration 0, p50 ~4,400 chars: language/identity 494–772 (echoes 280 chars of the user message), PLAN FIRST 895/983, context digest 340–1,160 (the 820-char "nothing is preloaded" marker plus a 228-char pointer on turns with no durable facts), effort addendum 349 / 0 / 481 / 651 by tier (injected once), freshness-honesty 442, discovery capsule 0–1,372. The prompt-budget trimmer is inert under lean mode: only the capsule and the plan nudge are droppable.

Tool block: 36 tools = 36,715 chars (~12k tokens), constant, not logged by `prompt_section_sizes`, ≈64% of system+tools bytes. Re-derived every iteration (runtime.ts:2282–2343): post-no-match filter, forced-orchestration cut-down, post-delegation widening. Largest schemas: create_ephemeral_agent 3,047 (embeds the 1,040-char GRANTABLE list), record_plan 2,692, assistant_personality_update 2,166, run_task_graph 2,068, skill_manage 2,076. Four tool-less sites still send `[]` (synthesis, two QA verdicts, length continuation); only the continuation replays the turn's messages.

Coordinator sub-agents get a 24-agent alphabetically truncated inline catalog (4,449 chars) that omits researcher, paper_author, quality_supervisor, summarizer and web_coder, plus a 1,492-char tool inventory and "search agents first" lines. mission_coordinator's own prompt is 10,178 chars. Paragraph classification of the four config prompts plus the module (40,390 chars): CORE 3,243 / MECHANIZABLE 19,305 / CONDITIONAL 4,980 / REDUNDANT 12,862. The prompts contradict each other (customInstructions: "do NOT call search_agents first"; Swarm Rules: "prefer search_agents").

### 2.2 Intent detection today

`buildDynamicTurnGuidance` is no longer a classifier: every routing flag is a hardwired `false` (intent-classifier.ts:260–269); only three structural detectors survive (URL present, substantial pasted content, durable-memory statement). About 25 read sites still branch on the dead flags and are inert. The only live semantic classifier is the upfront source-sensitivity judge (routing tier, 2,194-char prompt, `VERDICT: yes|no`), issued serially before the prefetch starts, skipped on attachment turns, and its verdict is the single switch that arms forced research. Deliverable shape is decided by EN/DE verb+noun regex piles in `deliverable-intent.ts` with ~12 consumers. The receptionist fast lane hit 0 of 5 live turns: under a model preset `getChatProviderForTier('routing')` returns null and the lane silently does not run.

### 2.3 Routing today

`resolveAgentRouting` is the single mechanical router behind search_agents, list_agents, un-named delegation, bidding, the discovery capsule and the resolve route. In semantic mode the keyword score, outcome boost and outcome multiplier are all disabled, so the "hybrid" is mutually exclusive, not merged; `computeHybridRoutingScore` has an unreachable branch; bidder-worker carries a second keyword-only scorer. The 0.72 floor is applied twice: on the raw rescaled score and again on the 0.7/0.3 min-max rerank blend, so with the reranker on, the lowest of the top-5 is always dropped. The embedding document per agent is name + description + capabilities + tags + tools + tool-derived keywords + an 800-char systemPrompt excerpt; the query is embedded bare (the Qwen3 instruct prefix pushed agents below the floor in e1151d8). Workflow scores are raw cosine (different scale), with a standout rule (≥0.55 raw and a 0.04 gap); scenes have no tags and 0/23 declare triggers; `normalizeSearchText` strips umlauts. `skillMatchThreshold` 0.75 sits above the 0.72 floor, so a candidate in [0.72, 0.75) is labelled high-confidence yet routed to an ephemeral.

The catalog's structured fields are effectively empty: `domain` on 4/49 (a free string; the schema comment claims an enum it does not enforce), `role` on 8/49, neither read by routing; `capabilities` (367 distinct strings) and `tags` (410, some German, some brand names) paraphrase each other.

### 2.4 Observability and evaluation today

`provider_model_call` rows carry no sessionId (all 435 live rows NULL). Routing scores are logged only from `search_agents`, which was never called. The receptionist's escalate reason is dropped. No routing-accuracy eval executes: `routing-accuracy.test.ts` (53 cases + 6 German) is `it.skip`, runs against a fixture, and requests `minConfidence: 'low'` so it could not see a floor regression; the documented `pnpm agents:evaluate` command is broken three ways (cwd, plan shadowing, config path); every gateway eval case is sent as `<task> --agent <name>`, which rpc.ts strips and converts into a hard one-agent grant, so the composed routing path is never exercised.

### 2.5 The live sample

Only one session (5 turns, all claude-opus-5) exists in the audit store; the local backend has zero rows in the window. Per turn: 2–6 orchestrator calls, 21–203 sub-agent calls, turn durations 961–5,243 s that are 52–91% delegation time, first model response 15–78 s (the first call generated for 13–74 s on a 20–37k-token prompt), first call started 1.5–3.8 s after the message with the discovery prefetch as the largest pre-call phase (0.5–2.6 s; empty prefetches were the slow ones). 0 of 4 completed turns passed QA. All percentiles are over n=4–5 and are a worked example, not a distribution.

## 3. Research consensus (17 sources per topic; full syntheses in the session scratchpad)

- **Hierarchy shape.** No flat list works past a few dozen candidates; every mature system uses coarse-to-fine organisation plus faceted metadata. Execution mode (gather / produce / act / verify / orchestrate) is the most reusable top level (O*NET's four activity groups, the Automative/Augmentative and Asking/Doing splits in usage studies); domain is the usual second level (~10 values); deliverable, modality, risk tier and execution shape are orthogonal facets used as filters or boosts, never tree branches. Keep every choice set at 5–10 options. Separate INTENT from SUBJECT so "research the best image model" lands on gather/research, not on image generation (ADR-009).
- **Retrieval.** Plain dense retrieval over tool/agent descriptions is a weak baseline (best general embedders ~34 nDCG@10 on ToolRet); the largest single lever is closing the vocabulary gap on both sides (synthetic user queries per entry, intent extraction from the query). Facet agreement fused as a boost onto kNN beats hard gating. Adaptive shortlist size (1–2 easy, up to ~7 hard) beats a fixed K. Systems that give the model a small shortlist (3–5) report large accuracy gains and 85% fewer tool tokens.
- **Classification.** One short JSON-constrained call with a small label set on a 7–30B model is accurate enough when the label space is small and the definitions carry "NOT here" clauses; multi-hop tree walks compound level-1 errors and cost 3–43 calls; keep a union across branches so a wrong facet is recoverable.
- **Prompt layout.** Frozen prefix per role, late-bound everything else; session facts in the first user message; never edit or reorder the tool array mid-turn; loaded bodies are append-only; treat KV hit rate as a first-class metric.
- **When to coordinate.** Multi-agent gains +80% on decomposable work and loses up to 70% on sequential planning; the signal is structural (domains touched, independent sub-tasks, tools fitting one specialist, step count, side effects, execution feedback); decompose on failure beats always-plan; a cheap front classifier captures most of the oracle gain.
- **Evaluation.** Ranking-only evals are blind to absolute-floor regressions; 300–500 labelled items with acceptable sets detect ≥5-point paired deltas; log-mined labels are survivor-biased; per-language margins must be reported separately.

## 4. The taxonomy

Two taxonomists built the hierarchy independently (one top-down from the research, one bottom-up from the catalog) and converged on the same skeleton: 43/49 agents had an identical L1 before merge, 65/88 entries overall. The merge resolved the two systematic disagreements on principles both already used elsewhere: ACT means an EXTERNAL side effect (running code in the no-network sandbox is PRODUCE with `risk_tier=sandbox_exec`), and a job's L1 is its terminal content scene's L1.

### L1 — execution mode (what the request asks the swarm to DO)

| L1 | Definition | NOT here |
|---|---|---|
| **GATHER** | Acquire, read, diagnose, or analyse information; the output is facts/evidence/findings/computed figures handed downstream, not a finished audience artifact and no external system is changed. Includes fresh research, reading logs/code/files/screenshots, reconciling evidence, and computing KPIs. | NOT authoring a polished deliverable for an audience (PRODUCE); NOT changing an external system (ACT); NOT judging an existing artifact against criteria (VERIFY). Rendering findings into a chart is PRODUCE; analysing/reconciling them is GATHER. |
| **PRODUCE** | Author a new durable artifact from supplied or gathered inputs: prose, a paper/brief/packet, code, an app, a chart/diagram/image, a deck, or a plan. A builder that runs its own output in a sandbox to compute or prove it is still PRODUCE; the value is the created artifact. | NOT merely finding/analysing info (GATHER); NOT executing a side effect on an EXTERNAL system (ACT); NOT judging an existing artifact (VERIFY). Running code in a no-network sandbox to return a value is PRODUCE, not ACT. |
| **ACT** | Cause an effect on an EXTERNAL system: send, deploy, mutate a repo/DB/infra/desktop, call/consume a live service, drive a live browser or PC, exploit a scoped target, or persist a durable record. The defining trait is a side effect OUTSIDE the sandbox. | NOT read-only inspection of an external system (GATHER); NOT producing a workspace/sandbox artifact with no external change (PRODUCE); NOT judging (VERIFY). Verifying by running tests stays VERIFY; running code to CHANGE or OPERATE an external system is ACT. |
| **VERIFY** | Judge an existing thing against explicit criteria and return a verdict/gap-list/pass-fail; changes nothing durable, even if it must run tests to decide. The deliverable is a judgement and a rerun-or-ship decision, not a new artifact. | NOT creating the thing being judged (PRODUCE); NOT gathering fresh facts for their own sake (GATHER); NOT applying a fix or shipping (ACT). qa_guard running a suite is VERIFY; source_verifier fetching a URL to CHECK a citation is VERIFY, not GATHER. |
| **ORCHESTRATE** | Decompose a multi-capability outcome across several specialists and sequence/merge them, or drive a scoped multi-phase engagement. Catalog entries here delegate to others; the deliverable is a coordinated outcome, not content the coordinator writes itself. | NOT a single-domain task one specialist can finish (GATHER/PRODUCE/ACT/VERIFY with execution_shape=single_agent); NOT merely writing a plan document (that is PRODUCE/plan -- project_planner). The request classifier signals this via multi=true + execution_shape rather than emitting ORCHESTRATE directly. |
| **converse** | CLASSIFIER-ONLY, ZERO catalog members. The general assistant handles a greeting, chit-chat, or a direct answer with no specialist and no tool; also the never-empty abstain/clarify target when nothing clears the floor. | NOT any request that needs external data (GATHER), a durable artifact (PRODUCE), an external effect (ACT), a judgement (VERIFY), or coordination (ORCHESTRATE). No catalog entry is ever tagged converse. |

### L2 — capability domain (the domain of the WORK, never the topic)

| L2 | Definition | NOT here |
|---|---|---|
| **research** | Finding, retrieving, verifying, and reconciling external information on ANY topic: web/source discovery, docs/standards/release-notes/advisories/CVEs (desk research), evidence consolidation, live current-facts lookup. The subject is irrelevant to this label. | NOT producing/finding visuals about a topic (media); NOT authorized offensive probing (security -- reading advisories/CVEs is research); NOT reading the local codebase (software) or data files (data). 'research the best image model' is research, NOT media. |
| **software** | Program code and engineering: writing/executing code, code analysis at rest, version control, test execution, diff/PR review, API integration/consumption, and building StarlingAI-external apps/tools. | NOT prose/docs about software (authoring); NOT operating servers/clusters or deploying (infra_ops); NOT structured-data analytics (data); NOT editing the swarm's own config/tools (swarm_meta). |
| **authoring** | Audience-facing written deliverables: marketing/editorial copy, formal cited papers/reports, briefings/handoff packets, summaries, onboarding/meeting packets, and content decks/websites. | NOT the research that feeds it (research); NOT hand-coded application source (software); NOT charts/diagrams/generated images (media); NOT the verdict on a draft (verify). |
| **data** | Structured/tabular data and records: CSV/JSON/XLSX/metrics analytics, live SQL databases, binary-document intake/extraction, and durable case/matter record-keeping. | NOT rendering the numbers as a chart (media); NOT prose interpreting them (authoring); NOT live-infra metrics for incident triage (infra_ops); NOT arbitrary code execution (software). |
| **media** | Visual assets and their interpretation: charts/tables, structural diagrams (Mermaid), generated or sourced images/SVG/QR, and reading screenshots/snapshots. | NOT computing the numbers behind a chart (data); NOT researching a topic that happens to be about images (research -- 'research the best image model' is research); NOT driving the live browser that shows the page (device_control). |
| **device_control** | Driving a live interactive session on a browser OR a real computer: navigation, forms, clicks, keyboard/mouse, screen. The surface facet (browser vs desktop_host) splits the two. | NOT interpreting the captured visuals afterwards (media); NOT calling an HTTP API headlessly (software); NOT mutating backend infra (infra_ops). |
| **comms** | Person-to-person channels: mailbox triage/compose/send, calendar and contacts, and outbound notifications/broadcasts across Telegram/Slack/Discord/email. | NOT drafting the long-form content that gets sent (authoring); NOT internal share_finding between agents; NOT case-history records (data). This is send/organise/schedule/notify over a channel. |
| **infra_ops** | Servers, clusters and operations: provisioning/Terraform/Ansible/k8s/helm, deployment and rollback, incident diagnosis, log analysis, and one-off shell/SSH commands on real/remote infrastructure. | NOT application source or git/repo ops (software); NOT structured-data files (data); NOT desktop control (device_control); NOT desk-research about a security advisory (research). |
| **security** | AUTHORIZED offensive security under a written scope: reconnaissance, web/network auditing, exploit validation, and pentest-specific reporting/QA. | NOT desk research about advisories/CVEs (research); NOT general policy/approval review of an ordinary action (verify/cross_domain); NOT reading server logs (infra_ops); NOT general code review (software). |
| **swarm_meta** | The assistant's own machinery and durable memory as the subject: creating/editing agents, scenes, jobs, prompts, and tools, plus long-running process/case memory. Classifier-emittable. | NOT general software the user asked to be built (software); this changes or remembers the ASSISTANT/its records itself. NOT domain-agnostic coordination of an external task (cross_domain). |
| **cross_domain** | CATALOG-ONLY SENTINEL, the request classifier does NOT emit it. Domain-agnostic coordinators, planners, and cross-cutting reviewers that apply to ANY subject; they are reached via L1 (ORCHESTRATE/PRODUCE-plan/VERIFY) + execution_shape, not by domain match. | NOT a domain-scoped entry: devops coordination is infra_ops, pentest coordination is security, live-web coordination is research, swarm self-editing is swarm_meta. |

### Facets (filters and boosts, never tree branches)

**deliverable** — What the entry primarily returns; the strongest boost for L1 and the sharpest separator of same-L2 siblings. Matched against named-artifact words in the query via embeddings (no word list). A retrieval boost, never a tree branch.

- `evidence`: Facts/findings/citations/screenshots/command output handed downstream; no shipped artifact.
- `prose_doc`: Audience-facing written document: article, paper, brief, report, summary, briefing, packet.
- `deck`: Slide deck (e.g. reveal.js) with optional speaker notes.
- `website`: Multi-page static/content website or microsite (client-side).
- `code`: Source code, a built tool, or a computed result value from executing code in a sandbox.
- `running_app`: A live, served, verified web app/service (built and run to prove it works).
- `chart`: Rendered data chart or table over numbers.
- `diagram`: Structural/relationship diagram (flowchart, sequence, mindmap; e.g. Mermaid).
- `image`: Raster/vector image, illustration, logo, QR, or a sourced/verified image URL.
- `data_table`: Structured/tabular output or extracted machine-readable content.
- `plan`: A phased task breakdown / project plan document.
- `verdict`: A pass/fail/risk judgement, gap-list, or review report.
- `message`: An outbound message/notification/relayed answer to a channel.
- `config_change`: A durable mutation: swarm config, infra state, calendar entry, git/PR, live DB, or persisted record.
- `none`: No fixed artifact (a coordinator merges others' outputs) or a variable deliverable decided by the request.

**input_modality** — What the entry primarily consumes; pre-filters and boosts candidates on structural signals (attachment count, URL present, codebase/diff). Multi-valued in practice; the primary value is tagged.

- `text`: Natural-language prompt and/or prior turns and plaintext only.
- `url`: A web URL to fetch or drive (a strong structural signal).
- `file_upload`: An uploaded binary attachment: PDF/DOCX/XLSX/eml/ics/image/audio/video.
- `structured_data`: CSV/JSON/XLSX/metrics as the primary input.
- `image`: An inline image/screenshot/snapshot to interpret.
- `codebase`: The workspace repo, files at rest, or a diff/PR/ref range.
- `live_system`: A running host, cluster, service, live DB, browser session, desktop, or scoped target.
- `none`: Starts from the request alone; creation or coordination with no external input to read.

**risk_tier** — The MAXIMUM external impact the entry can reach = the security/approval signal AND a routing filter. Advisory to routing; it NEVER replaces the strict hard gates (approval/tier/scope/sandbox/redaction) and is never a tree branch (house rule 2).

- `read_only`: No external mutation; observes, judges, or produces local judgements/findings only.
- `sandbox_exec`: Runs code in an isolated no-network sandbox; no durable external change (records that an entry executes without moving its L1).
- `reversible_write`: Writes local workspace files, drafts, or artifacts (incl. git-reversible swarm config) that are easily discarded.
- `external_send`: Emits messages/mail/notifications outward to people or channels.
- `mutating_external`: Mutates external systems (infra/repos/DBs/desktops), calls state-changing APIs, drives a live browser/PC, or runs exploits; typically approval-gated.

**execution_shape** — The fit-vs-coordinate decision made explicit -- can one unit finish the request end-to-end, or is coordination needed? The gate between the two branches of the user's decision tree. (Agents carry this as a top-level field; scenes/jobs carry it here as workflow.)

- `single_tool`: A single grantable tool could satisfy it (no agent needed) -- the cheapest rung.
- `single_agent`: One specialist agent can complete the whole scoped request alone.
- `workflow`: A pre-built scene/job already encodes the full plan; running it short-circuits planning.
- `needs_coordination`: Spans multiple specialists/phases or dependent cross-specialist hand-offs; hand a coordinator ONLY the shortlisted candidates.

**surface** — The physical environment the work touches; gates tools/approvals and splits same-domain siblings (e.g. browser vs desktop, sandbox vs workspace). Orthogonal to deliverable (a place, not an artifact type).

- `local_sandbox`: Isolated no-network code/exec sandbox on the platform.
- `workspace`: The user's workspace files on the platform (incl. rendered artifact output).
- `external_network`: The public internet / external HTTP endpoints / a remote live DB.
- `browser`: A driven Playwright browser session.
- `desktop_host`: A remote/local PC via VNC/RDP.
- `remote_infra`: Remote servers/clusters via SSH/kubectl/cloud APIs or the pentest target range.
- `user_channel`: A user comms channel (mail/calendar/Slack/Telegram/Discord).
- `swarm_internal`: Swarm-internal: config, durable process/case memory, meta-orchestration, self-improvement.


### Assignment rules (the label-generator rubric)

- L1 = the DOMINANT execution mode of the OUTCOME, decided by the verb of what is asked, never the subject nouns.
- INTENT over SUBJECT (ADR-009): L2 is the capability-domain of the WORK, not the topic. 'research the best image model' = GATHER+research (image is the topic); 'make me an image' = PRODUCE+media. A topic never promotes a domain into L2.
- Mechanism stays off the L1 axis; ACT is defined by an EXTERNAL side effect, not by 'it runs code'. Running code in an isolated sandbox to return a value = PRODUCE (coder, tool_developer) or VERIFY when the output is a verdict (qa_guard); running/sending/deploying/mutating an EXTERNAL system = ACT (git_developer, exploit_agent, infrastructure_agent). risk_tier=sandbox_exec records the run without moving L1.
- GATHER vs PRODUCE tie-break: output = facts/evidence/findings/computed figures for downstream use -> GATHER (incl. analysing existing evidence, reading logs/code, computing KPIs, reconciling a ledger). Output = a composed audience artifact (prose paper, deck, site, chart, plan) -> PRODUCE.
- VERIFY overrides PRODUCE/GATHER whenever the job is to judge an EXISTING thing against criteria and change nothing durable -- even if it must run code to decide.
- ORCHESTRATE only for entries that DECOMPOSE across multiple specialists or drive a multi-phase engagement; a planner that only writes a plan is PRODUCE/plan (project_planner). The request classifier signals coordination via multi=true + execution_shape and should rarely emit orchestrate directly.
- Coordinators carry the domain they coordinate (devops_coordinator->infra_ops, pentest_coordinator->security, web_task_coordinator->research); mission_coordinator, project_planner and the domain-agnostic reviewers (quality_supervisor, policy_compliance_reviewer) carry cross_domain (a catalog-only sentinel the classifier does not emit).
- swarm_meta (the swarm's own machinery/memory) IS classifier-emittable and is kept DISTINCT from cross_domain (domain-agnostic coordination); the two are not folded into one 'platform' bucket.
- One primary L1 and 1-2 L2 per entry; a second L2 only when a distinct secondary domain is materially EXERCISED (report_writer_agent=security+authoring; deck_slides=authoring+media). L2 order is cosmetic -- retrieval indexes the SET.
- A workflow's L1 = the L1 of its TERMINAL content-producing scene; a broadcast/notify tail does NOT flip L1 and does NOT add a comms L2 (the send is captured by risk_tier=external_send + surface=user_channel). multi_channel_broadcast the SCENE is itself ACT/comms.
- Research/analysis workflow line: a findings brief/dossier/snapshot/digest whose dominant work is acquire+verify = GATHER (verified_research_brief, deep_research, competitive_analysis, security_audit, incident_response, data_pipeline_review); a composed paper/deck/site/packet = PRODUCE even when research feeds it (source_backed_paper, content_creation, sourced_presentation).
- Facets are boosts/filters, never branches, and MUST be additive to the semantic score: agent-routing.ts:91-95 returns the raw semantic score iff >=0.72 (the calibrated floor, agent-routing.ts:24) else 0 -- a facet must never impose a second floor nor inherit the 0.72 gap or the skillMatchThreshold 0.75 gap. deliverable boosts on named-artifact words, input_modality on attachment/URL/codebase, surface gates capability, risk_tier gates approval (advisory; hard gates stay strict).
- execution_shape is the fit-check: single_tool/single_agent/workflow at high confidence with agreeing facets and multi=false -> DIRECT DISPATCH (minimal prompt, no coordinator); needs_coordination OR multi=true OR no single full-coverage hit -> hand a coordinator ONLY the shortlisted candidate cards, never the full roster. A matching workflow competes with agents in the same retrieval pass and short-circuits planning on a full-coverage hit.
- Never dead-end: when nothing clears the floor, the request classifier emits converse (no catalog member) -> general assistant with recall_context, never an empty answer.
- English structural labels only; non-English/brand/mechanism tokens are matched by the embedding arm, never added to the taxonomy (house rule 1). The {l1,l2,facets} block must be ADDED to buildAgentSearchDocument (embeddings.ts:213-229) for agents and authored fresh onto scenes/jobs (which have no tags today); role/domain are unread by routing and must be re-derived from the new L1 set.

### Agents (49)

| Agent | L1 | L2 | Shape | Deliverable | Risk | Conf | Note |
|---|---|---|---|---|---|---|---|
| mission_coordinator | ORCHESTRATE | cross_domain | needs_coordination | none | read_only | high | General cross-domain execution coordinator; the default needs_coordination target. Longest prompt (10,178). Ov |
| web_task_coordinator | ORCHESTRATE | research | needs_coordination | message | read_only | low | Thin freshness-only relay (delegates 1-2 live retrievals, no synthesis); borderline single_agent GATHER; tags  |
| project_planner | PRODUCE | cross_domain | single_agent | plan | reversible_write | medium | role=planner; phase-1 map: 'produces a plan document; does not execute specialists'. PRODUCE(plan) so 'just gi |
| researcher | GATHER | research | single_agent | evidence | read_only | high | The only fresh-discovery web researcher; shares web tools with source_verifier(audits) and image_sourcer(image |
| evidence_analyst | GATHER | research+data | single_agent | evidence | reversible_write | medium | Reconciles already-collected evidence into a confirmed/tentative ledger for downstream writers. Hardest GATHER |
| summarizer | PRODUCE | authoring | single_agent | prose_doc | reversible_write | high | Faithful condensation/TL;DR that authors a readable restatement (vs evidence_analyst which organizes evidence) |
| content_writer | PRODUCE | authoring | single_agent | prose_doc | reversible_write | high | Also builds content websites (deliverable=website) and reveal.js decks (deliverable=deck); overlaps web_coder  |
| coder | PRODUCE | software | single_agent | code | sandbox_exec | medium | Runs short JS/TS in an isolated no-network sandbox to return a computed result (map: 'executes... returns resu |
| web_coder | PRODUCE | software | single_agent | website | reversible_write | high | Hand-writes multi-file client-side front-ends (SPAs/dashboards); client-only. Overlaps content_writer (files v |
| backend_coder | PRODUCE | software | single_agent | running_app | sandbox_exec | high | Builds+serves a live container locally and returns a URL for verification. PRODUCE(running_app) -- the serve i |
| code_analyst | GATHER | software | single_agent | evidence | read_only | high | Reads code at rest, never runs it; distinct from diff_reviewer(diff) and qa_guard(runs). |
| git_developer | ACT | software | single_agent | config_change | mutating_external | high | Mutating git/GitHub ops (commit/push/PR/release), approval-gated. Distinct from diff_reviewer(read) and devops |
| shell_agent | ACT | infra_ops | single_agent | evidence | mutating_external | medium | One-off shell/SSH commands, reports raw output; can mutate so ACT. L2 could be software for local build runs.  |
| quality_supervisor | VERIFY | cross_domain | single_agent | verdict | read_only | high | Domain-agnostic acceptance gate (completeness/consistency/grounding, rerun-vs-ship); role=reviewer. Explicitly |
| qa_guard | VERIFY | software | single_agent | verdict | sandbox_exec | high | Verifies by RUNNING the test suite; deliverable=verdict so VERIFY not ACT; risk_tier=sandbox_exec records the  |
| diff_reviewer | VERIFY | software | single_agent | verdict | read_only | high | Read-only diff/PR merge verdict. Reviewer-shaped but NOT tagged role=reviewer in config (lint). Distinct from  |
| pentest_coordinator | ORCHESTRATE | security | needs_coordination | none | mutating_external | high | Scope-gated engagement orchestrator; requires written authorization. role=coordinator. Unreachable by any scen |
| recon_agent | GATHER | security | single_agent | evidence | mutating_external | high | Active surface mapping under authorized scope: GATHER intent, but active probing so risk_tier=mutating_externa |
| web_auditor_agent | GATHER | security | single_agent | evidence | mutating_external | high | Authorized web-app auditing (findings=GATHER; active testing so risk=mutating_external). Brand tags nikto/sqlm |
| network_auditor_agent | GATHER | security | single_agent | evidence | mutating_external | high | Authorized non-web protocol auditing (SMB/FTP/SSH/RDP/DNS/TLS), approval-gated checks. Brand tag hydra (lint). |
| exploit_agent | ACT | security | single_agent | evidence | mutating_external | high | Validates vulns by RUNNING exploits against the target (mandatory per-module approval). Intent is validation b |
| report_writer_agent | PRODUCE | security+authoring | single_agent | prose_doc | reversible_write | high | Aggregates pentest findings into a CVSS-ordered report; distinct from general content_writer/paper_author. |
| pentest_qa_validator | VERIFY | security | single_agent | verdict | read_only | high | Pentest finding-validation gate before reporting (false positives/CVSS/evidence/coverage). role=reviewer. |
| browser_agent | ACT | device_control | single_agent | evidence | mutating_external | high | Drives a live browser (navigate/click/submit/login); also captures snapshots (secondary GATHER) that vision_br |
| vision_browser_analyst | GATHER | media | single_agent | evidence | read_only | medium | Reads captured browser snapshots and publishes exact page evidence; capability is visual interpretation -> med |
| computer_use_agent | ACT | device_control | single_agent | evidence | mutating_external | high | Controls a local/remote desktop via VNC/RDP (keyboard/mouse/screen); domain=desktop in config. Brand/mechanism |
| infrastructure_agent | ACT | infra_ops | single_agent | config_change | mutating_external | high | Mutates external clusters/servers (Terraform/Ansible/k8s/helm). Distinct from ops_triage(read) and devops_coor |
| ops_triage | GATHER | infra_ops | single_agent | evidence | read_only | high | Read-only incident diagnosis; hands the fix to infrastructure_agent/devops_coordinator. Broader than log_analy |
| devops_coordinator | ORCHESTRATE | infra_ops | needs_coordination | none | mutating_external | high | CI/CD release coordinator; owns promote+rollback. role=coordinator. Unreachable by any scene. |
| mail_agent | ACT | comms | single_agent | message | external_send | high | Mailbox triage/search/organize/draft/reply+send (send approval-gated); domain=communication. Distinct from not |
| calendar_agent | ACT | comms | single_agent | config_change | mutating_external | high | CalDAV/CardDAV calendar+contacts mutations; domain=communication. Tags carry provider brand names nextcloud/fa |
| notification_agent | ACT | comms | single_agent | message | external_send | high | One-way outbound dispatcher (Telegram/Slack/Discord/alert-email); sole agent in multi_channel_broadcast, the t |
| swarm_maintainer | ACT | swarm_meta | single_agent | config_change | reversible_write | high | WRITES durable swarm config (agents/scenes/jobs/prompts), workspaceAccess=full (map: 'executes -- writes durab |
| tool_developer | PRODUCE | swarm_meta+software | single_agent | code | sandbox_exec | high | Builds+tests pure-compute no-network TS tools and SUBMITS for approval (map) -- hands off an artifact, does no |
| prompt_optimizer | VERIFY | swarm_meta | single_agent | verdict | read_only | high | Advisory prompt-quality reviewer; proposes the smallest wording change, does not implement (swarm_maintainer d |
| data_analyst | GATHER | data | single_agent | data_table | reversible_write | medium | Computes aggregations/KPIs/anomalies over already-collected files, no live DB (map: 'produces computed figures |
| log_analyst | GATHER | infra_ops | single_agent | evidence | read_only | high | Parses log TEXT (journald/nginx/stack traces/container logs) for error clusters/timelines; narrower than ops_t |
| document_intake | GATHER | data | single_agent | data_table | reversible_write | high | Extracts exact text/tables/metadata from binary attachments (PDF/DOCX/XLSX/audio/video/eml/ics); first step fo |
| paper_author | PRODUCE | authoring | single_agent | prose_doc | reversible_write | high | Formal source-grounded cited docs from an evidence ledger; never fabricates refs. Distinct from content_writer |
| meeting_briefing_agent | PRODUCE | authoring | single_agent | prose_doc | reversible_write | high | Action-oriented briefing/handoff packet (status/facts/risks/decisions/owners/next actions); distinct from summ |
| diagram_designer | PRODUCE | media | single_agent | diagram | reversible_write | high | Mermaid structural diagrams (flowchart/sequence/timeline/graph/mindmap); distinct from chart_designer(numbers) |
| chart_designer | PRODUCE | media | single_agent | chart | reversible_write | high | Renders already-verified NUMBERS as HTML charts/tables; does not compute (data_analyst does); input_modality=s |
| image_creator | PRODUCE | media | single_agent | image | reversible_write | high | Generates visuals from a prompt (diffusion raster/SVG/QR); creation from scratch, distinct from image_sourcer( |
| image_sourcer | GATHER | media | single_agent | image | reversible_write | high | Finds+verifies free-license image URLs (images only). media NOT research so 'research the best image model' do |
| api_integrator | ACT | software | single_agent | evidence | mutating_external | medium | Calls existing HTTP/REST/GraphQL endpoints to test/consume (can POST); ACT (operates a live service), read-hea |
| sql_specialist | ACT | data | single_agent | data_table | mutating_external | medium | Connects to a LIVE Postgres/MySQL/MariaDB (queries/schema/migrations/EXPLAIN); ACT (can mutate), read-heavy so |
| source_verifier | VERIFY | research | single_agent | verdict | read_only | high | Audits an existing draft's claims/citations (fetches URLs to CHECK, not to gather) -> VERIFY. Shares web tools |
| policy_compliance_reviewer | VERIFY | cross_domain | single_agent | verdict | read_only | high | Screens a planned action/output for policy+approval risk (destructive ops/credentials/egress/privacy); domain- |
| process_memory_keeper | ACT | data | single_agent | config_change | mutating_external | low | Persists+queries long-running matters in the ProcessMem MCP store (cases/disputes/correspondence). ACT (durabl |

### Scenes (23)

| Scene | L1 | L2 | Deliverable | Risk | Conf | Note |
|---|---|---|---|---|---|---|
| source_backed_paper | PRODUCE | authoring+research | prose_doc | reversible_write | high | Evidence-grounded paper/report with verified citations -- a composed authored artifact. Used by 3 jobs. |
| verified_research_brief | GATHER | research | prose_doc | read_only | medium | Concise fact-checked findings brief with named sources+uncertainties; dominant work = acquire+verify (thin aut |
| deep_research | GATHER | research | prose_doc | read_only | medium | Source-backed dossier; internally drives mission_coordinator (the one scene that is an orchestrator) but expos |
| competitive_analysis | GATHER | research | prose_doc | read_only | medium | Decision-oriented comparison brief across competitors; dominant work = research+comparison -> GATHER. |
| content_creation | PRODUCE | authoring | prose_doc | reversible_write | high | Research+draft audience-ready content (blog/newsletter/copy/docs). |
| code_review | VERIFY | software | verdict | read_only | high | Merge-readiness report over recent changes (diff_reviewer/code_analyst/qa_guard). |
| reviewed_deliverable | PRODUCE | cross_domain | none | reversible_write | medium | Builds ANY deliverable (content OR code) then runs a reviewer panel with one bounded revision; domain-agnostic |
| verified_app_build | PRODUCE | software | running_app | sandbox_exec | high | Builds a runnable app and PROVES it works by executing it (expectArtifact). PRODUCE(running_app) -- the delive |
| security_audit | GATHER | research | prose_doc | read_only | high | DESK research on advisories/CVEs -> risk digest (researcher/evidence_analyst); NOT the offensive pentest swarm |
| incident_response | GATHER | infra_ops | prose_doc | read_only | high | Read-only triage + root-cause -> internal incident summary; the work is diagnosis (findings), the summary is a |
| multi_channel_broadcast | ACT | comms | message | external_send | high | The universal send-it-out tail scene (9 jobs); its whole purpose IS the send, so ACT/comms (unlike the jobs th |
| release_notes_draft | PRODUCE | software+authoring | prose_doc | reversible_write | high | Drafts release notes from repo history (git_developer reads history, content_writer drafts) -- the deliverable |
| onboarding_packet | PRODUCE | authoring | prose_doc | reversible_write | high | Structured onboarding packet for a topic/project/new hire. |
| meeting_briefing_packet | PRODUCE | authoring | prose_doc | reversible_write | high | Meeting brief/handoff from attached material + prior findings; includes policy_compliance_reviewer. Not used b |
| deck_research | GATHER | research | evidence | read_only | high | Step 1 of the deck pipeline (researcher only); scope-fenced in prose (facts only, no images/build). |
| deck_images | GATHER | media | image | reversible_write | high | Step 2 (image_sourcer only): source+verify+locally save real free-license images. |
| deck_paper | PRODUCE | authoring+media | prose_doc | reversible_write | high | Step 3; builds the cited paper from ONLY already-verified facts+images (expectArtifact). |
| deck_slides | PRODUCE | authoring+media | deck | reversible_write | high | Step 4; builds the reveal.js deck + speaker notes from verified facts+images (expectArtifact). |
| validate_image | VERIFY | media | verdict | read_only | high | Per-URL VERIFIED/REJECTED/UNVERIFIED verdicts; strict 'never web_search or invent' protocol. Not used by any j |
| apply_jobs | ACT | device_control | config_change | mutating_external | high | Browser-assisted freelance application submission (browser_agent); the only scene with webhookKey+approvalChan |
| data_pipeline_review | GATHER | data | prose_doc | read_only | medium | Inspects files OR live DB for quality/completeness/anomalies -> data-quality report; GATHER (analysis/findings |
| capture_capability | ACT | swarm_meta | config_change | reversible_write | high | Captures a built+verified capability as durable machinery via swarm_maintainer. Only scene using swarm_maintai |
| profile_fit_assessment | PRODUCE | authoring | prose_doc | reversible_write | medium | Assesses the USER's own CV vs a role -> structured fit deliverable; grounds on injected [USER PROFILE], do NOT |

### Jobs (16)

| Job | L1 | L2 | Deliverable | Risk | Conf | Note |
|---|---|---|---|---|---|---|
| deep_research_packet | GATHER | research | prose_doc | read_only | high | 1 step (deep_research). Triggers: api + slack /deep-research. |
| source_grounded_paper_packet | PRODUCE | authoring+research | prose_doc | reversible_write | high | 1 step (source_backed_paper). NO triggers; search_workflows/LLM only. |
| competitive_snapshot | GATHER | research | prose_doc | read_only | high | 1 step (competitive_analysis). Triggers: api + slack /competitive. |
| morning_briefing | GATHER | research | prose_doc | external_send | medium | 2 steps (deep_research -> broadcast). Follows deep_research=GATHER; the broadcast tail is captured by risk_tie |
| weekly_security_digest | GATHER | research | prose_doc | external_send | high | 2 steps (security_audit desk-research -> broadcast); NOT offensive security (no security L2). Triggers: api +  |
| daily_ops_brief | PRODUCE | authoring+research | prose_doc | external_send | medium | 2 steps (source_backed_paper -> broadcast). L1 follows its terminal content scene source_backed_paper=PRODUCE  |
| incident_postmortem | PRODUCE | infra_ops+authoring | prose_doc | external_send | medium | 3 steps (incident_response -> source_backed_paper -> broadcast). Terminal content scene source_backed_paper AU |
| release_broadcast | PRODUCE | software+authoring | prose_doc | external_send | high | 2 steps (release_notes_draft -> broadcast). Triggers: api + slack /release (default HEAD~20..HEAD). |
| research_visual_digest | GATHER | research+media | prose_doc | reversible_write | high | 1 step (deep_research with includeVisuals); brief + one high-signal Mermaid. Follows deep_research=GATHER, med |
| sourced_presentation | PRODUCE | authoring+media | deck | reversible_write | high | 4 steps (deck_research->deck_images->deck_paper->deck_slides); terminal deck_slides=PRODUCE. The ONLY job with |
| content_pipeline | PRODUCE | authoring | prose_doc | external_send | high | 2 steps (content_creation -> broadcast). Triggers: api + slack /content (default blog-post). |
| onboarding_delivery | PRODUCE | authoring | prose_doc | external_send | high | 2 steps (onboarding_packet -> broadcast). Triggers: api + slack /onboard. |
| scheduled_code_review | VERIFY | software | verdict | external_send | high | 2 steps (code_review -> broadcast). The VERIFY deliverable survives the broadcast tail. Triggers: api + slack  |
| data_quality_report | GATHER | data | prose_doc | external_send | high | 2 steps (data_pipeline_review -> broadcast). Follows data_pipeline_review=GATHER. Triggers: api only. |
| database_analysis | GATHER | data | prose_doc | external_send | high | 2 steps (data_pipeline_review -> broadcast); shares the scene with data_quality_report. Triggers: api + slack  |
| co_develop_capability | ACT | swarm_meta+software | config_change | reversible_write | medium | 3 steps (reviewed_deliverable x2 -> capture_capability), resumable. Terminal step capture_capability PERSISTS  |

### Ambiguities carried as low-confidence seeds

- evidence_analyst GATHER vs PRODUCE -- the closest call: the phase-1 map and proposal B read it produce (it emits a reconciled ledger); classified GATHER because the ledger is organized facts-for-downstream, not an audience artifact (parallels data_analyst). Resolve by ablating the deliverable facet in the routing eval.
- data_analyst GATHER vs PRODUCE -- computes KPIs/anomalies (map: 'produces computed figures'); classified GATHER per rule 4 (computing figures); a 'give me the KPIs' request could read as a deliverable.
- coder / backend_coder / tool_developer / verified_app_build ACT vs PRODUCE -- all run/serve in a no-network sandbox; classified PRODUCE with risk_tier=sandbox_exec because none mutates an EXTERNAL system; a request emphasizing 'run this and act on the result' could re-rank toward ACT via risk_tier.
- project_planner PRODUCE(plan) vs ORCHESTRATE -- deliverable is a plan document and it does not dispatch specialists (map + role=planner); chose PRODUCE so 'just give me a plan' is a single_agent dispatch, not forced coordination; the handoff to mission_coordinator is a separate step.
- The research-deliverable workflow family (verified_research_brief/deep_research/competitive_analysis vs source_backed_paper/content_creation) -- the GATHER(findings brief) vs PRODUCE(composed artifact) line turns on how thick the authoring wrapper is; the two proposals split systematically here (A GATHER, B produce). Settle with a labelled routing eval.
- deep_research is itself an orchestrator internally (drives mission_coordinator) but is exposed as one GATHER workflow -- the one scene that is an orchestrator; note for the fit-check so it is not double-coordinated.
- data_pipeline_review GATHER vs VERIFY vs PRODUCE -- inspects for quality issues (verify-like) and emits a report (produce-like); chose GATHER (analysis/findings); settle by eval.
- profile_fit_assessment PRODUCE vs VERIFY -- assesses the user's CV against a role and emits a structured deliverable; chose PRODUCE (a deliverable for the user, not a gate verdict).
- web_task_coordinator ORCHESTRATE vs GATHER -- a very thin 1-2-hop relay with no synthesis; kept ORCHESTRATE (it delegates) but low confidence; could collapse into researcher or a grantable tool.
- process_memory_keeper L2 -- no clean home; folded into data; a dedicated 'memory' domain would hold only this one agent today (low confidence).
- ACT vs GATHER for active security probing (recon/web/network auditors) and for api_integrator/sql_specialist -- touching an external system to probe/consume; classified by intent (GATHER for the auditors that acquire findings; ACT for api_integrator/sql_specialist that OPERATE a live service) with risk_tier=mutating_external recording the side-effect capability; a pure-read request re-ranks near GATHER via risk_tier.
- converse has zero catalog members by design (the never-empty abstain/smalltalk target); it lives at the request classifier, not as a catalog branch -- if a future chit-chat persona agent is added it becomes the first member.
- incident_postmortem / daily_ops_brief L1 -- both run source_backed_paper (PRODUCE) as their terminal content scene, so PRODUCE by rule 10, overriding A's GATHER; but their subject (incident/ops) makes the GATHER reading defensible if the paper is treated as a thin findings wrapper. Flagged for eval.

### Catalog lint (becomes swarm_validate checks)

- Non-English tags violate house rule 1: image_sourcer carries German (bild, bilder, foto, lizenzfrei, gemeinfrei) + source names (wikimedia/commons). Drop from tags; the embedding arm carries the multilingual load, never a word list.
- Brand/mechanism tags (keyword-overfit): calendar_agent (nextcloud/fastmail/icloud), computer_use_agent (lm-studio/vscode/vnc/rdp/ip-address), web_auditor_agent (nikto/sqlmap/gobuster), network_auditor_agent (hydra), infrastructure_agent (terraform/ansible/prometheus/grafana/proxmox), web_task_coordinator (news/weather/scores/lottery/stocks = pure topic keywords). Replace with l1/l2/facets; keep brand/topic detail in the free-text description for the embedder only.
- role/domain are set but UNREAD by routing (grep of agent-routing.ts + embeddings.ts finds neither reference; role on 8/49 using only 3 of 6 values, domain on 4/49 and its one live value 'desktop' is outside the schema comment's claimed enum, which z.string() does not enforce). Populating l1/l2 for all 49 is the prerequisite for mechanical routing; the reviewer-shaped agents diff_reviewer, source_verifier, code_analyst, policy_compliance_reviewer, prompt_optimizer are NOT tagged role=reviewer -- re-derive the reviewer set from the new L1=VERIFY assignment.
- Redundant discovery fields: capabilities (367 distinct free strings) and tags (410 distinct) paraphrase each other and both feed the same embedding doc (buildAgentSearchDocument). Collapse to one {l1,l2,facets} block + a short free description; drop the tag pile.
- Scenes have NO tags field (SceneConfig) and 0/23 declare triggers; only 1 job (sourced_presentation) declares catalogTriggers. The {l1,l2,facets} block must be AUTHORED FRESH onto all 23 scenes + 16 jobs (a schema addition) and ADDED to buildAgentSearchDocument (embeddings.ts:213-229) for agents -- this is the prerequisite for letting workflows compete with agents in one index.
- Sibling collisions needing sharper NOT-here clauses, all within a shared L2: VERIFY/software qa_guard(runs) vs diff_reviewer(diff) vs code_analyst(tree) vs quality_supervisor(any deliverable, cross_domain); PRODUCE/media chart_designer(numbers) vs diagram_designer(structure) vs image_creator(generate) and GATHER/media image_sourcer(find); PRODUCE/authoring content_writer(marketing/site/deck) vs paper_author(cited) vs meeting_briefing_agent(packet) vs summarizer(distill) vs report_writer_agent(pentest); software builders coder(sandbox compute) vs web_coder(client files) vs backend_coder(serves) vs tool_developer(pure-compute tool); comms mail_agent(threaded) vs notification_agent(one-way); infra_ops ops_triage(read) vs infrastructure_agent(mutate) vs log_analyst(log text) vs shell_agent(one-off); data data_analyst(files) vs sql_specialist(live DB). They share tools/embedding text; the deliverable + input_modality + surface + risk_tier facets must separate them.
- Description/name collisions that mis-route a name-keyed matcher: security_audit SCENE + weekly_security_digest JOB are DESK research (researcher/evidence_analyst, L2=research) and are entirely disjoint from the offensive pentest swarm (pentest_coordinator + 5 agents, L2=security) which no scene/job references; daily_ops_brief is a source_backed_paper (research) pipeline despite the 'ops' name. Add sharp NOT-here clauses or rename (e.g. security_advisory_digest vs pentest_engagement).
- Reachability: 23/49 agents are in NO scene's allowedAgents (all 6 pentest members + pentest_coordinator, web_task_coordinator, project_planner, shell_agent, computer_use_agent, infrastructure_agent, devops_coordinator, mail_agent, calendar_agent, tool_developer, prompt_optimizer, diagram_designer, chart_designer, image_creator, api_integrator, process_memory_keeper, vision_browser_analyst). Scenes are NOT a cover of the agent set, so the redesign MUST keep a direct-delegation (single_agent) path for these -- a workflow-only shortlist would strand them.
- Threshold mismatch: skillMatchThreshold 0.75 > the 0.72 semantic floor (agent-routing.ts:24), so a candidate in [0.72,0.75) is labelled high-confidence yet routed to an ephemeral. Facet gating must be ADDITIVE to the semantic score (agent-routing.ts:91-95 returns raw semantic iff >=0.72 else 0) and must NOT inherit the 0.72 or 0.75 gap as a second floor.
- Job steps can only call scenes (JobStepSchema = {scene,label,params}); every job is a linear scene pipeline and 9/16 end in multi_channel_broadcast. A coordinator handed a job gets a fixed pipeline, not a task graph -- execution_shape=workflow must signal this rigidity so the fit-check does not over-promise composability.
- deck pipeline fences scope in PROSE not structure (deck_research/deck_images/deck_paper/deck_slides carry 'do NOT source images / do NOT research facts here' because the 4 scenes share shared-facts state); the per-step deliverable facet (evidence -> image -> prose_doc -> deck) could make these phase boundaries structural.

### Merge statistics

- **L1/facet skeleton**: Both proposals independently rebuilt the SAME research-consensus skeleton -- L1 execution mode {GATHER,PRODUCE,ACT,VERIFY,ORCHESTRATE} x L2 capability domain + the SAME 5 orthogonal facet axes (deliverable, input_modality, risk, execution_shape, surface). The axes were adopted verbatim; only value granularity/naming differed.
- **agents L1 identical**: 43/49 (88%). The only splits: coder, backend_coder, tool_developer, evidence_analyst, data_analyst (mechanism-vs-intent) and project_planner (plan-vs-coordinate).
- **agents L2 overlap**: 49/49 primary-domain overlap after name-normalisation (A device_control == B automation; A infra_ops == B infra; A swarm_meta+cross_domain == B platform).
- **scenes L1 identical**: 16/23 (70%). The 7 splits are all the research/analysis GATHER-vs-PRODUCE line plus verified_app_build ACT-vs-PRODUCE.
- **jobs L1 identical**: 6/16 (38%) -- the lowest-agreement group, entirely the systematic GATHER-vs-PRODUCE split on research/analysis pipelines and co_develop_capability's ACT-vs-PRODUCE.
- **overall L1 identical**: 65/88 catalog entries (74%) shared an identical L1 before merge.
- **catalog_lint consensus**: Both independently flagged the same defects: German/brand/mechanism tags, role/domain set-but-unread, redundant capabilities+tags, the security_audit-vs-pentest routing collision, the daily_ops_brief naming smell, 23/49 agents unreachable-by-scene, and scenes carrying no tags/triggers.
- **shared design invariants**: Both enforce INTENT-over-SUBJECT (ADR-009), facets as additive boosts not branches, the calibrated 0.72 floor untouched, English-only structural labels, workflows competing with agents in one index, and a never-empty abstain.

### Draft classifier prompt (frozen prefix of the facet call; 1199 chars)

```text
Label the LATEST user request for a swarm router. Output ONLY JSON: {"mode":"","domain":[],"multi":false,"conf":0.0}. No prose, no reasoning.

mode = what the request asks the swarm to DO (the verb, NOT the topic):
- gather: find/read/diagnose/analyse; output = facts/evidence
- produce: author an artifact (doc, code, app, chart, image, deck, plan) from inputs
- act: cause an EXTERNAL effect (send, deploy, mutate, drive a browser/desktop); running code in a sandbox for a value is produce, not act
- verify: judge existing work vs criteria, return a verdict, change nothing
- orchestrate: spans 2+ domains or needs a plan across specialists
- converse: greeting/chit-chat/direct answer, no specialist; fallback when nothing fits

domain (0-2; the WORK's capability, NOT the nouns): research, software, authoring, data, media, device_control, comms, infra_ops, security, swarm_meta. Empty for converse.

Rules:
- domain by the work: "research the best image model" = gather+research (image is the topic).
- security = authorized offensive pentest only; advisories/CVEs = research.
- multi=true for 2+ domains or modes.
- running tests to judge = verify; unsure/nothing fits -> converse, domain=[].
```

Schema placement: agents, scenes and jobs (and later skills) all carry the same block, so they compete in one index and one brief:

```jsonc
"routing": {                       // authored, enum-validated, optional; always wins
  "mode": "GATHER",                // L1
  "domain": ["research"],          // L2, 1-2 values
  "deliverable": ["evidence"],
  "completes": ["evidence"],       // deliverables the entry finishes ALONE (the fit-check bit)
  "inputModality": ["text", "url"],
  "riskTier": "read_only",
  "executionShape": "single_agent",
  "surface": ["external_network"]
},
"notFor": "one sentence: the sibling this is NOT",
"examples": ["3-5 English utterances"]   // embedding-only; moved out of the description bags
// scenes/jobs additionally: entryAgent, requiredParams[], requiresEvidence
```

`routingGenerated` (same fields plus `oneLiner`, `sourceHash`, `labeledBy`, `labeledAt`) is produced by an opt-in build step seeded from the table above, cached by content hash, written to a separate generated shard, and never overrides an authored block. The legacy free-string `domain` and `role` are migrated and then removed via `configRemovals`.

## 5. The design

Name: Triage Lane, Frozen Shapes. Spine: the migration-first design (ranked first by two of three judges, second by the third); grafts from the other three where the judges named them; every correction from the four critiques folded in below.

### 5.1 Decision tree

**N0 — structural pre-gates (no LLM, <5 ms).** Deterministic and language-independent:
- Empty message → nothing.
- Explicit agent directive: rpc.ts already parses `--agent <name>`, strips it and sets a one-element `allowedAgents` grant. N0 reads that grant (or a threaded `forceAgent` opt), dispatches mechanically and skips N3. The runtime never sees the suffix, so N0 must not look for it in the message.
- `channel === 'workflow'` (a scene/job step): never re-triage.
- Plan continuation with pending steps: resume on the same shape, no routing calls.
- Pending clarify from the prior turn: merge the reply, forbid re-asking.
- `autonomous = opts.autoApprove === true` (`--auto`): a clarify is never acceptable; missing goal/input slots proceed with a stated assumption.
- Structural flags carried into N3/N4: `hasTurnAttachments`, `documentGrounded` (from prepareDocumentRag), `inlineAnalyticalContent`, `containsActionableUrl`, `reusePriorDelegateEvidenceForFollowUp`, `priorAssistantTurnExists`, durable-memory statement, assistant naming (`extractAssistantName`).

**N1 — receptionist fast lane (exists).** Unchanged now, with two fixes: a call-site preset fallback (the same memo pattern runtime.ts:1947–1950 already uses) so the lane actually fires on the Claude preset, and the escalate reason logged. `confidenceAttempt` stays off; its documented precondition (task intent detected semantically at intake) is met by N3 and folded in at S12 (section 10, decision 11).

**N2 — mechanical shortlist (no LLM; runs in parallel with N3).** One bare query embedding (no instruct prefix). Agents via `resolveAgentRouting` with the 0.72 floor applied to the PRE-rerank rescaled score; the rerank blend re-orders inside the admitted set only and no longer decides admission (this loosens today's double floor; the admitted-set size is measured in P3). Workflows via `searchWorkflowCandidates` in standout mode (unchanged rule; reported rescaled so the brief shows one scale). Skills on their own floor when present. A direct `searchByEmbedding` top-8 supplies sub-floor names for orientation lines only. The reranker runs once on the merged admitted set, never inside N3b. Target ≤0.8 s (the empty-prefetch slowness is logged and fixed in S0); hard cap 2.5 s → empty shortlist, never a dead end.

**N3 — facet triage call (routing tier; parallel with N2).** Frozen prefix ~1,800 chars: instructions ("classify, JSON only, no reasoning"), the L1/L2 enums with NOT-here clauses, the structural coordinate criteria, the upfront judge's `source_sensitive` definition verbatim (so the shadow gate has a bit-compatible baseline), the JSON schema. Dynamic tail: the message (≤1,200 chars) plus a two-line prior-turn digest whenever a prior assistant turn exists (structural, not length-gated). No tools, no history, no catalog rows (catalog-blind, hence parallel and free of position bias). Controls: `enable_thinking:false`, `max_tokens 160`, `response_format json_schema` with enums on llama.cpp (new provider option); on the Anthropic path one forced tool `route_request` with enum parameters (new `toolChoice` variant). Output: `{mode, domain[], deliverable, multi, parts[], alone, source_sensitive, decision, confidence, missing[], query_en, language, refersToPrior}`. Issued UNCONDITIONALLY, including attachment/document turns (the judge is skipped there because its verdict is unwanted, not because it is expensive); the structural flags decide in N4 what the verdict may do. Cap set from S0's measured p95 of the triage's own shape per station (≥4.5 s; a routing call measured 2.1 s alone and 4.06 s with four in flight); on timeout or two parse failures the turn continues in legacy mode ON THE SHAPE IT WOULD OTHERWISE HAVE USED. A prose reply is a failed call and is never continued.

**N3b — conditional second mechanical pass (no LLM).** When `language ≠ en`, or cos(e_raw, e_en) < 0.9, or `refersToPrior`: embed `query_en` once and re-score; per entry `s = max(s(q_raw), s(q_en))` before the floor test (max never pulls a good native match down; the boundary normalisation the house rule asks for). When `multi`: one kNN per part (≤3), admission per part on the same floor, union by reciprocal-rank fusion. Bounded to kNN re-scores without the reranker, ≤0.3 s. `normalizeDelegationToEnglish` can skip its extra call when `query_en` exists.

**N4 — fusion and decision (pure function, <5 ms).**
1. Family scores on their own scales; floors first; nothing below a family floor is ever admitted, nothing above it is ever evicted by a facet (no rescue, no signed penalty — both were rejected by the judges as effective floor changes).
2. Unified fit for admitted entries: `fit_e = clamp((s_e − τ_e) / (1 − τ_e), 0, 1)`, τ_A = 0.72, τ_W = 0.775 rescaled, τ_S = 0.72 initially; per-entry τ_e may only tighten, fitted by `sai routing fit` and committed with the embedding model id.
3. Facet bonus in fit units, confidence-scaled: +0.10 mode compatible (equal, or gather~verify for read-only checks, produce~act for the coder family; ORCHESTRATE entries get the mode term whenever `multi`, `decision == coordinate` or the structural coordinate criteria hold), +0.15 domain overlap (`cross_domain` entries are a wildcard), +0.05 deliverable match. Surface/modality mismatch withholds the bonus, never subtracts. Maximum +0.30 fit ≈ +0.084 rescaled. The fusion unit test must show accuracy DROPS on the ADR-009 fixture when the bonus is zeroed (including German conceptual in-domain questions).
4. Adaptive K: margin m = fit'₁ − fit'₂; K = 1 if m ≥ 0.20, 2 if m ≥ 0.10, else the cluster above fit'₁ − 0.15 capped at 5 (7 when multi). When nothing is admitted the brief lists the top-3 sub-floor names marked "below floor — orientation only", never dispatchable.
5. Decision rules, first match wins (order corrected by the routing-regression review so a strong topical embedding match can never override a direct-answer verdict):
   1. F null (timeout / two parse failures / no provider) → LEGACY: today's capsule + PLAN FIRST on the shape the turn would otherwise use.
   2. N0 directive → mechanical dispatch of the named agent (N3 was skipped).
   3. `documentGrounded` or `inlineAnalyticalContent` or `reusePriorDelegateEvidenceForFollowUp` → answer_direct with `source_sensitive := false` and clarify forbidden (the judge's own skip conditions, carried over structurally); tools stay on the wire.
   4. ANSWER_DIRECT when `decision == answer_direct` and not `source_sensitive` and mode ∈ {converse, gather} and no URL/attachment flag — regardless of any agent's score. Soft: the LEAN loadout keeps delegate_to_agent, run_workflow and both search tools.
   5. WORKFLOW iff a standout workflow is admitted AND `deliverable ∈ deliverables_w` (mandatory; a catalog-blind "workflow" vote is never a licence on its own) AND mode compatible AND every param without a default is present or derivable AND `riskTier ∉ {external_send, mutating_external}` AND `user_channel ∉ surface`. Mechanical only under the S9 flag; otherwise a brief row (soft).
   6. COORDINATE iff (`multi` AND the per-part admitted sets differ in top-1 agent or domain, or any part is source-sensitive) OR `decision == coordinate` OR the structural coordinate criteria hold (output crosses a specialist boundary, ≥8 steps, or two of {≥2 domains, ≥2 independent sub-questions, open-ended research}) OR the best-fit entry has `executionShape = needs_coordination`. Small compound requests whose parts land on the same specialist stay single-agent with the parts listed in the brief and N6 as the safety net.
   7. SINGLE_AGENT iff K == 1 (or m ≥ 0.10) AND `alone` AND mode compatible AND domain match AND the top-1 is admitted by `q_raw` (a max-merge may re-order the brief but never licence a dispatch on its own).
   8. CLARIFY iff a goal/input slot is missing AND confidence ≥ 0.6 AND no strong top-1 (s < 0.80) AND not `autonomous` AND not the turn after an ask; constraint/context gaps proceed with a stated assumption.
   9. GENERAL: today's loop with the search tools present (LEAN unless the structural coordinate criteria hold).
6. Emits `RoutedDecision` (branch, target, shortlist with scores and fit, agreement class AGREE-STRONG / AGREE-WEAK / DISAGREE / NONE between the kNN top-1 and the facet-implied target, structural flags), the rendered brief, and `upfrontSourceSensitive := F.source_sensitive` into the judge's slot (turn-setup.ts:119–124). A deliverable shim derived from `F.deliverable` plus the structural flags replaces `deliverable-intent.ts` for all ~12 consumers (runtime.ts:2302/2942/4219–4225/4670/4720; turn-finalize-guards.ts:374/679–681/754/765–767/854; the module gate), not only the module gate.

**N4b — confirm call (deferred, flag-gated).** A second routing-tier JSON call over ≤5 cards in catalog order with {A..E, coordinate, clarify, none}, fired only in the ambiguous band (fit'₁ ∈ [0.10, 0.25) with m < 0.10, no standout, not multi). Built only if S5's audit rows show that band on >15% of escalated turns.

**N5 — branch execution.**
- answer_direct: LEAN shape, brief "answer directly; the specialists listed remain available", no PLAN FIRST; the post-draft honesty guards stay; a guard rejection re-runs on the same shape with the enforcement string, widening to COORDINATE only when the guard demands orchestration (one logged rescue prefill).
- single_agent, brief mode (S5): brief line "RESOLVED ROUTE: delegate_to_agent(<target>) once, then synthesize"; when `source_sensitive` the first call is forced (`tool_choice:required`, thinking off, `max_tokens ≤400`) on the SAME array with call-site refusal of non-orchestration names (the sub-agent `blockedToolReasons` pattern); otherwise `tool_choice:auto` (soft). Mechanical mode (S10): the runtime writes a minimal TurnPlan through the `fromSeed` path (one delegate step, acceptance criteria from the deliverable facet, riskTier high when `riskTier ∈ {mutating_external, external_send}` or source-sensitive) so riskGatedQA and the QA delivery loop keep their input, then dispatches without an orchestrator call; ACT/external-send targets are excluded from mechanical dispatch.
- workflow: the existing forced `run_workflow` rewrite keyed on the RoutedDecision (rule 5) instead of author-declared triggers; nested scene/job turns unchanged.
- coordinate: COORDINATE shape (head + the module's CONDITIONAL slice, 18 tools); brief carries the shortlist, workflow rows and a plan seed; `record_plan(fromSeed:true)` → `execute_plan` as today; forcing by `tool_choice:required` plus call-site refusal (record_plan refused once a plan exists, execute_plan before), never by filtering the array. A delegation to mission_coordinator / web_task_coordinator / devops_coordinator / pentest_coordinator (domain-matched when admitted) carries the CoordinatorBundle (section 5.4).
- clarify: one `ask_user` offering the top-2 readings, worded in the user's language; late asks count as eval failures.

**N6 — decompose on failure (ADaPT), backstops.** Structural only: specialist outcome ≠ success, or two no-progress checks, or artifact wanted but absent → arm `[ESCALATE TO COORDINATION]` with the failed step's result and the shortlist, switch to the COORDINATE shape for the rest of the turn (one sanctioned, logged cold prefill), capped once per turn. Existing honesty guards, autoResearchOnRefusal, evidence backstops and forced synthesis unchanged. Mid-turn steering re-runs N2+N4 mechanically over message + steering and re-renders the brief; N3 is never re-run mid-turn.

### 5.2 German and other languages

No word lists anywhere in the routed path. German reaches English cards through the multilingual embedding, the `query_en` second query merged by max, and the facet model reading German natively. The primary embedding document keeps today's bilingual example bags until the canary proves the enrichment vector carries them (copy, do not move). The per-language score margin is a first-class eval metric and the 0.72 floor is never tuned per language.

Word-list gates that survive today and are scheduled for deletion or re-keying (S4b/S12): `shouldRequireWorkflowExecutionAfterSearch` and the `workflow_run_forced_after_search` rewrite (keyword overlap decides a forced workflow); `taskRequiresExternalResearch`'s verb/noun regexes (agent-routing.ts:626–673) → the `source_sensitive` facet plus `agentGathersDirectly`; the three follow-up detectors in `source-sensitive-delegation.ts` (105/132/158) → `refersToPrior` plus the prior-turn digest; the `deliverable-intent.ts` piles → the deliverable shim. Kept for now and declared: the durable-memory/naming patterns in intent-classifier.ts (persistence, not routing; candidate for a `durable_statement` facet later).

### 5.3 Prompt layout

| Layer | Content | Size | Stable across |
|---|---|---|---|
| HEAD (system[0]) | identity; Core Principles (needs its own paragraph classification before any trim — it is not in the 40k classified corpus); customInstructions core (DIRECT ANSWER FIRST, EVIDENCE DISCIPLINE, SECURITY, REPORTING ≈ 3,200; the routing table, WORKFLOWS, RESEARCH/MULTI-AREA and SELF-IMPROVEMENT paragraphs = 4,061 chars leave); personality (verbatim; per-user under auth); Response Format; Proactive Memory; Security; generated `## Capability Map` (~1,300, hash-stamped: L1/L2 groups → entry names, one line each, no descriptions); plan/tool protocol (~1,050) | 16,219 → ~16,160 (S6) → ~10,900 (S11) | turns, sessions, days; per (user profile) under auth |
| MODULE slice (system[1], COORDINATE shape only) | Swarm Rules + Tool Use Discipline + Orchestration Strategy trimmed to their CONDITIONAL class (2,126; the CORE 513 folds into the protocol above, counted once) | 12,826 → 2,126 | all coordinate-shape turns |
| TOOLS | LEAN 12 / COORDINATE 18, canonical registry order, deterministic serialisation, never mutated in-turn | 36,715 → 12,608 / ~20,050 | all turns of a shape |
| SESSION BLOCK (history[0], role USER, fenced, `metadata.sessionBlock`) | date in one zone, language directive, workspace, user segment. NOT the effort line: effort is resolved per message (rpc.ts:583–588) and changed mid-session live, so it stays in the tail. Compaction pins two leading user messages when the block is present (`pinnedHead = 2`) so the original request is not displaced. | ~250 | a session (rewrites once per day) |
| HISTORY | unchanged; `[SHARED FINDINGS AVAILABLE]` delivered append-only as a tool-result/user message when it changes, with a one-line tail pointer (today a ≤4,000-char tail block re-prefilled every post-delegation iteration) | grows | append-only |
| TAIL brief (last before generation) | `[ROUTE]` branch, target, confidence, mode/domain/deliverable, agreement class; ≤5 agent rows (name [fit] — ≤110-char one-liner; `notFor` bounded to 60 chars or omitted from rows) in CATALOG order; ≤3 workflow rows with param status; one plan sentence; effort line; conditional lines (freshness only when source-sensitive; structural notes); recall digest | 4,400 → ~1,850 / ~2,350 / ~3,390 by branch (a K=5 fixture is rendered and measured in S5 before the cap is quoted) | per turn by design |
| TRIAGE prefix (own request) | instructions + enums + criteria + judge definition + schema | ~1,800 frozen + ≤1,200 dynamic | all turns until the taxonomy version changes |
| Coordinator head (per agent) | systemPrompt trimmed to CORE + CONDITIONAL (+ the identifier-verbatim rule if kept: 1,308–2,052) + static tool inventory; date, workspace and roster move into the history[0] run block | 16,119 → ~6,000 head+context | missions, users, days |

Two other cache fixes from the performance review: on the local backend `forceSynthesis` is run as [turn head] + turn tools under `tool_choice:none` + history + trailing instruction (today it rebuilds the same base prompt as a separate cold shape; `leanSynthesisPrompt` remains the preset lever); on the Anthropic path a `cache_control` breakpoint moves with the last message so multi-iteration turns read history at the cached rate (today only tools and the last system block are cached).

Loadouts and the local cache: a LEAN↔COORDINATE switch between consecutive turns re-prefills head + tools + the entire history, while a warm 36-tool block costs ~0.5 s to re-send. So the S2 "freeze" rung (36 tools, never mutated) is the local default; branch loadouts are session-monotonic (LEAN → COORDINATE once, never back) and are enabled by default only where per-token billing makes shrink pay (the Claude preset), after an S2-vs-S7 A/B on cold-prefilled tokens per session.

### 5.4 Coordinator handoff

A CoordinatorBundle travels on `ToolContext.routedDecision` (set once per turn next to `allowedAgents`/`loadableTools`) so it reaches a coordinator whether it is delegated by the coordinate branch, by an `execute_plan` step, by `parallel_delegate`, or by the QA-loop escalation:
1. `routedAgents` (≤8): fused shortlist ∪ allowedAgents of matched workflows ∪ a generated per-domain support set (research → researcher, source_verifier, evidence_analyst, summarizer, paper_author; code deliverables → qa_guard; source-sensitive → source_verifier). SOFT: it feeds only `buildSubAgentAgentDiscoveryGuidance` and renders ≤8 catalog lines into the history[0] run block. `ToolContext.allowedAgents` is untouched because it is a hard gate (tools/sub-agent.ts:774–777, :3606) and `search_agents` is grant-filtered (:869, :3193); a hard grant would dead-end a mission whose shortlist was wrong. An out-of-list delegation is allowed and logged as `routing_scope_exceeded`.
2. `routedWorkflows` (≤3) with param status, rendered as reuse-step suggestions.
3. Tools: the agent's configured list verbatim (19 for mission_coordinator), reranked once by its own description, never narrowed per mission; `search_workflows`/`run_workflow` stripped only for `channel === 'workflow'` runs (replaces the prose workflow-in-workflow guard).
4. A `[ROUTING BRIEF]`, a generated `RUN BUDGET` line from the effective effort tier (replaces the stale "8 iterations / 12 min / 2 slices" prose), and `maxParallelSlices` enforced in code on every fan-out call.
5. A plan seed: objective = `query_en` + output-language directive; one reuse step per matched workflow and one delegate step per routed agent, `parallelGroup` when parts/domains differ, `dependsOn` when a part references another; acceptance criteria from the deliverable facet; riskTier from the risk facet. `record_plan` gains `fromSeed:true` so the coordinator confirms or edits instead of authoring from prose.

### 5.5 Never-dead-end guarantee

Every branch keeps a delegation tool and both search tools on the wire; every mechanical branch has a structural failure path back to the coordinate branch (once); the last decision rule is today's loop; legacy mode runs on the shape the turn would have used; a failed facet call is a null verdict, never a continued prose reply.

## 6. Byte and call accounting (corrected)

Bases: the "today" column is the live measurement; the "after" column is measured against the built registry where possible (tool schemas) and itemised where it is an estimate (prompt text). The 114 tok/s cold-prefill rate quoted in earlier notes is the deepseek-era probe; the qwen station measured 13,700 tokens cold in 21.83 s (1.6 ms/tok). Absolute seconds are therefore only quoted from S0's per-station measurements; the relative claims stand on either base.

| Item | Today | After |
|---|---|---|
| customInstructions section | 7,331 | ~3,200 (the four kept blocks sum to 3,217; the routing paragraphs 4,061 leave) |
| create_ephemeral_agent schema | 3,047 | ~2,090 (moving the 1,040-char GRANTABLE list; further cuts to the 2,623-char parameters block are separate, canary-checked trims) |
| effort addendum | low 349 / medium 0 / high 481 / max 651, once per turn | unchanged, stays in the tail |
| mission_coordinator prompt | 10,178 | CORE 151 + CONDITIONAL 1,157 (+744 identifier rule) + runtime-facts line ≈ 2,100–2,700 |
| Deferred tools (not on the wire; reachable as `execute_plan` direct steps via `ctx.loadableTools`, already honoured at plan-executor.ts:208–210) | on the wire | 17 tools / 15,065 chars removed from every first call |
| Instruction load | 40,390 classified | ~8.2k retained + ~4.4k generated (map, protocol, brief, run block) |
| Coordinator on the wire | 16,119 head+context + 21,504 tools | ~6,000 + 21,504 (−27% at iteration 0; near 0 after the first delegated result lands — the lever is the byte-identical per-agent head) |

LLM calls per turn class (routing-tier calls in parentheses), with the post-draft semantic ungrounded judge and the receptionist counted:

| Class | Today | After S5 | After S10 |
|---|---|---|---|
| small talk | (receptionist, when it runs) | (receptionist) | same |
| answer_direct | (judge) + 1–2 orchestrator + (post-draft judge) | (facet ‖ shortlist) + 1 orchestrator + (post-draft judge, skippable when `source_sensitive=false` at high confidence after a shadow-measured agreement gate) | same |
| single_agent | (judge) + 2–3 orchestrator (2–3 cold) + specialist | (facet) + 1 thinking-off dispatch (warm) + specialist + 1 synthesis | (facet) + 0 + specialist + 1 synthesis |
| workflow | (judge) + 2 orchestrator + nested | (facet) + 0 orchestrator before run_workflow + nested + 1 synthesis | same |
| coordinate | (judge) + 2–6 orchestrator (2–3 cold) + coordinator loop with search rounds | (facet) + 2 orchestrator (record_plan fromSeed, execute_plan) on one warm shape + coordinator with the bundle | same |
| clarify | a mid-execution question or a guess | (facet) + 1 short orchestrator call issuing ask_user | same |
| legacy (facet null) | — | exactly today's path on the same shape | same |
| Claude preset | judge and receptionist do not run at all | same counts; the preset fallback adds +1–3 s of pre-call latency the baseline never paid — stated as a budget and measured in S4; on API-hosted presets the receptionist runs concurrently with N2/N3 and aborts them on a handled reply |

Pre-call critical path: today receptionist (serial) → judge (serial, awaited before the prefetch starts) → prefetch 0.5–2.6 s. After: receptionist (serial on the local backend) → max(N2, N3 + N3b). The overlap alone is a real local win the synthesis under-claimed.

## 7. Implementation plan

Rules for every slice: default-off flag with a named read site; shadow before on; pass^k (`--via-gateway --repeat 3`, composed arm) before default-on; a discriminance proof (revert the change and watch the named test fail); `pnpm -s docs:reference` staged with every commit; the "off" branch removed one release after default-on.

### Phase A — see it (S0–S2)

**S0 Observability + probes (no flag; 1–2 days).** `sessionId`/`agentName`/`callSite`/upstream station id on `provider_model_call` via RequestContext (today both emitters pass only `{severity}`); `agent_routing_evaluated` on every prefetch and un-named delegation (surface field), including empty prefetches with elapsed ms; `prompt_section_sizes` completed (toolSchemasChars, toolCount, module, brief/capsule, effort, freshness, enforcement, sharedFindings, headHash, toolsHash); new events `routing_shortlist_evaluated`, `routing_triage_decided`, `routing_shadow_evaluated`, `routing_scope_exceeded`, `routing_dispatch_mechanical`; receptionist escalate reason on `message_received`; llama.cpp timings (prompt_n, cached tokens) when exposed; a two-call probe settling where the chat template renders the tool block relative to the folded system text (two repo comments disagree); a latency probe of the triage's own shape (600-token warm prefix + 400-token tail + 160-token JSON) on both qwen stations. Gate: provider rows join to turns; a routing score row appears on an escalated live turn; the join returns 0 rows on a pre-slice log.

**S1 Eval scaffolding (no flag; 3–5 days incl. labelling).** Label-free routing canary against the GENERATED config at `minConfidence 'high'`: per entry, its own description/capability/tag phrases + 2 paraphrases + German translations must self-match top-1 with s ≥ 0.77 and `gated=false`; a committed per-entry score snapshot; fail on mean shift >0.02 or any floor crossing (this would have caught e1151d8). Un-skip `routing-accuracy.test.ts` against the live config at 'high'. New plan kind `routing` (offline, no agent runs): top-1, recall@5, Completeness@5 on multi items, MRR, gated-rate on in-scope = 0, abstention P/R on direct items, per-agent and per-language slices with beta-binomial intervals. Golden set v1 `eval/routing/golden.jsonl` (300–500 items: ≥8 per agent, ≥5 per workflow, ~150 direct, ~150 coordinate, ≥30 clarify, ≥30% German translated in a separate back-checked step, ≥20% verified sibling hard negatives incl. the four cross_domain agents and the four coordinators, German conceptual in-domain questions for the answer_direct class). Fix `agents:evaluate` (cwd, shadowing, config path); the routing-live pack declares `arm: "composed"` on every case and the runner refuses a pinned case in that pack. Head-hash and tools-array-identity unit tests (identity across two dates and two users WITH identical personality profiles; a profile edit is the only per-user difference). Gate: canary green on the current catalog with the snapshot committed; golden v1 baseline published; routing-live pass^3 baseline recorded.

**S2 "Freeze" rung (`orchestration.stableToolBlock='freeze'`; 2–3 days).** Today's 36 tools as one array never mutated in-turn; forcing via `tool_choice:required` + call-site refusal with the same error text; the length-continuation call keeps the tools under `tool_choice:none`; `forceSynthesis` on the local backend reuses the turn head + tools + history (warm) instead of rebuilding the base as a cold shape; `[SHARED FINDINGS AVAILABLE]` delivered append-only; Anthropic last-message cache breakpoint. Gate: cold-prefill rows per forced turn 3 → ≤1; the memory_store-loop case (be828e39) still delegates within two iterations; routing-live no flips.

### Phase B — route it (S3–S5)

**S3 Taxonomy in the catalog (`routing.enrichedRankingVector`, default off; ~1 week).** Schema: `routing`/`routingGenerated`/`notFor`/`examples`/`completes` on agents; `routing`/`entryAgent`/`requiredParams`/`requiresEvidence` on scenes and jobs; correct the false `domain` enum comment. Label generator `sai config build --label-routing` (opt-in; never runs in CI; the default build FAILS on a stale `sourceHash` rather than keeping stale labels silently) seeded from the section-4 table, cached by content hash, written to a generated shard numbered in the upstream range, under an allowlisted directory (the root-layout gate). Hand-check the five coordinators and seven reviewer-shaped agents. Runtime-created entries (promoted agents, API- or skill-graduated scenes, maintainer-authored agents) are labelled and their vectors precomputed on the hooks the embedding index already uses (startup / reload / promotion) with invalidation on `saveScene`/`saveJob`/`deleteScene` — a load-time-only precompute would regress today's query-time discovery. A second ranking-only vector per entry (oneLiner + notFor + examples + facet lines) cached by content hash and embedding model id; the primary document is untouched so the floor keeps its calibration (it embeds an 800-char systemPrompt excerpt, so S11 prompt rewrites are canary-gated too). Catalog lint into `swarm_validate`: German/brand tags, missing NOT-here clauses on sibling clusters (cosine >0.90), unread `role`/`domain`, security_audit-vs-pentest naming, daily_ops_brief naming, agents unreachable by any scene. Gate: canary unchanged with the flag off and 100% with it on; L1/L2 generated-label accuracy ≥0.9 on the golden set.

**S4 Facet triage in shadow (`orchestration.routingTriage='shadow'`, `receptionist.presetFallback`; 4–5 days).** `agent/triage.ts`; `responseFormat` plumbing in the lmstudio provider and the forced-tool variant in the Anthropic provider; call-site preset fallback for the triage and the receptionist; the triage issued unconditionally with the structural flags attached; the judge still decides; per-turn agreement logged for `source_sensitive` (vs the judge), the implied target (vs the model's first named delegation), and `deliverable` (vs the deliverable-intent regexes). Gate: `source_sensitive` agreement ≥95% on clean sessions with no false negatives on the c88851e8 class; parse failure <2%; triage p50 ≤ the S0-measured floor of its own shape; the lane provably runs under the Claude preset with the pre-call latency budget stated and met; `q_raw`-vs-`q_en` top-1 disagreement rate reported.

**S4b Dead-code deletion (no flag; 2–4 days).** Delete, do not migrate: the ten hardwired-false flags and their ~25 read sites (runtime.ts:1580–1584, 1631–1637, 1865; turn-setup.ts:119–124; turn-finalize-guards.ts:413–414; evidence-reuse-nudge.ts:29–41; recall-context.ts:53–61; the module gate's dead operand), `trustModelRouting`, `suppressAgentCatalogTool`, the unreachable `computeHybridRoutingScore` branch, the n8n approved-run path, `search_tools` in orchestration_only (its loadable set is empty), the after-search keyword workflow force, bidder-worker's keyword scorer (after a compose-file grep confirms nothing spawns it), and the vacuous tests named in the eval map. Gate: typecheck + full suite + routing-live baseline unchanged (every removed branch is ANDed with a constant false or unreachable); docs/reference restaged.

**S5 Triage ON + fusion + brief (`orchestration.routingTriage='on'`; ~1 week).** The verdict feeds `requiresDelegatedResearch`; `agent/routing-fusion.ts` (pure) implements section 5.1 including the corrected rule order, the `--auto` predicate and the structural-flag rules; `formatTurnBrief` replaces the capsule, PLAN FIRST, the language echo and the always-on freshness line; the deliverable shim serves all ~12 deliverable-intent consumers; the module gate reads `branch === 'coordinate'`; `[ROUTE]` rendered from a K=5 fixture and measured before its cap is set; the post-draft ungrounded judge skippable behind a shadow-measured agreement gate. Gate: P3 decision confusion + fitted thresholds with calibration error; P4 ablations show the bonus, `query_en` and RRF each move the paired metric; abstention P/R on direct items is a release gate; routing-live pass^3 no flips, over-/under-delegation not worse, tokens per turn down; coordinate turns now receive the module.

### Phase C — freeze it (S6–S8)

**S6 Session block + head stabilisation (`agents.performance.sessionBlock`, `agents.performance.subAgentRunContext`; 3 days).** User-role fenced block at history[0] with `pinnedHead = 2`; no date, temporal message or outcomes ledger in the head; the effort line stays in the tail; sub-agent "Today's date" / "Current workspace" / roster into the run block; personality per section 10 decision 2. Gate: main head hash identical across two days and two users with the same profile (unit + live); coordinator head hash identical across missions; compaction keeps both the block and the original request verbatim; cold rows per station ≤1 per shape/agent; routing-live no flips.

**S7 Branch loadouts (`orchestration.stableToolBlock='loadouts'`; 3–4 days).** LEAN 12 / COORDINATE 18 chosen once per turn, session-monotonic; deferred tools via `execute_plan` direct steps; create_ephemeral_agent's GRANTABLE list into its result text; loadouts for `hybrid` (∪ the DIRECT set) and `delegate_only` (∩ its allowlist) specified or the freeze rung declared terminal for those modes; a naming/persona turn keeps a one-call path (`assistant_personality_update` on LEAN, or a mechanical direct call keyed on `extractAssistantName`). Gate: an S2-vs-S7 A/B on cold-prefilled tokens per session on the local backend decides the local default; ≤2 distinct shapes per session; capability-awareness eval 100% (loads or plans instead of refusing); Claude-preset tokens per turn down ≥40%; routing-live no flips.

**S8 Scoped coordinator handoff (`orchestration.scopedCoordinatorHandoff`; 3–4 days).** Section 5.4 with the bundle threaded on ToolContext; `maxParallelSlices` enforced in code; workflow-channel tool strip. Gate: Completeness@grant ≥0.9 on coordinate cases (agents actually used ⊆ routedAgents or found via one search); `search_agents` calls per coordinate turn down; the deep_research scene eval unchanged; coordinator cold rows per mission = 0 after the first.

### Phase D — dispatch it (S9–S10)

**S9 Mechanical branches (`orchestration.mechanicalDispatch.workflow`, `orchestration.routingClarifyPolicy`, `orchestration.decomposeOnFailure`; 3–4 days).** Agree-gated workflow dispatch (rule 5) through the forced `run_workflow` rewrite; directive dispatch on the parsed rpc grant; clarify policy; ADaPT escalation; steering → brief refresh; `skillMatchThreshold` reconciled (the un-named delegation path consults the turn's RoutedDecision first, or the workspace lowers the threshold to the floor). Gate: workflow precision 100% on golden standout items; ask-rate on fully specified items ≤2%, clarify precision ≥80%, no turn asks twice, zero asks on `--auto`; escalation precision ≥70%; no dead-ends.

**S10 Mechanical single-agent dispatch (`orchestration.mechanicalDispatch.singleAgent`; 3–5 days).** Thresholds 0.80 / margin 0.05 / full facet agreement / confidence 0.7, top-1 admitted by `q_raw`; the minimal seeded TurnPlan written before dispatch; ACT and external-send targets excluded; a routed delegation counts as `_turnDelegationCount > 0` so the old compliance nets do not re-force; per-entry τ_e fitted (`sai routing fit`). Gate: dispatch precision ≥0.95 on single_agent golden items; time-to-first-delegation down by one orchestrator call; under-delegation unchanged; a two-week sessionId-hashed A/B on re-delegation count and corrective follow-ups.

### Phase E — shrink it (S11–S12)

**S11 Prompt text, last (`agents.performance.generatedCapabilityMap` for the map; text A/B'd via `*.local.jsonc`; 1–2 weeks with 2–3 iterations budgeted).** `## Capability Map` rendered; customInstructions loses the four routing paragraphs (4,061 chars); Core Principles classified first, then trimmed to its CORE + CONDITIONAL classes; the module trimmed to CONDITIONAL; Tool Discovery / Agent Discovery replaced by the map; mission_coordinator, then web_task_coordinator, then swarm_maintainer prompts cut to CORE + CONDITIONAL plus the generated runtime-facts line, one agent at a time. Gate per text change: routing-live pass^3 no flips + the assessment-traps pack + capability-awareness 100% + canary (the primary embedding document contains a prompt excerpt).

**S12 Default-on sweep and follow-ups (defaults flip only).** Flip `routingTriage`, `stableToolBlock`, `scopedCoordinatorHandoff`, `sessionBlock`, `subAgentRunContext`, `generatedCapabilityMap` after their gates; receptionist `confidenceAttempt` per decision 11; confirm-call decision from S5's band statistics; `catalogTriggers` and the after-search force retired; live deployment verified by grepping the baked dist inside the container, not the config file.

Deferred, not scheduled (no read site until data exists): learned router / embedding-MLP thresholds from logged decisions; Anthropic `defer_loading` + `tool_reference`; a schema-as-data `run_tool` dispatcher; skill rows in the brief (skills are dormant in production); job step kinds for agents/tools (job steps can only call scenes today).

## 8. Evaluation plan

- **P0 Observability first** (S0): every routing decision, shortlist score, verdict and provider call joinable by sessionId and station.
- **P1 Routing canary** (S1): label-free, seconds, on every PR touching embeddings.ts / agent-routing.ts / workflow-catalog.ts / the label generator / workspace shards; a hard gate on S3 lint-driven edits and every S11 prompt rewrite.
- **P2 Golden set** (S1): v1 300–500 items with acceptable sets and cluster ids; v2 ≥1,000 for 3-point sensitivity; labels from log mining + two LLM judges with written justifications + human adjudication (α ≥ 0.8 on a 200-item human gold slice); synthetic personas per entry with verified sibling hard negatives; German by separate translation with back-check.
- **P3 Offline routing plan** (S1+): shortlist recall@5, Completeness@5, MRR, gated-rate on in-scope = 0, abstention P/R, per-agent/per-language slices with proper intervals, decision confusion, calibration error of the verbalised confidence, admitted-set size per turn (the double-floor change), level-1 vs leaf accuracy for the hierarchy.
- **P4 Ablation ladder** (S3–S5): kNN only; + ranking vector; + facet bonus (β=0 vs fitted); + `query_en` max-merge; + per-part RRF; + agreement-class wording; + confirm call. A component with no paired delta is not shipped.
- **P5 Routing-live pack** (S1 baseline, every slice): 60–80 composed-arm cases (20 direct, 20 single-agent, 20 coordinate, 10 workflow, 10 clarify; half German; case classes for document-grounded turns, `--auto`, follow-ups, explicit directives), `--via-gateway --repeat 3`, graded from `turn_scorecard` and audit rows, not answer text: over-delegation P(delegation | direct), under-delegation, coordination recall, wrong-agent rate, tokens per turn, prefill share, time-to-first-delegation, search calls per turn, empty-answer rate = 0.
- **P6 Cache metrics as gates** (S2+): cold-prefill rows and cold-prefilled tokens per turn, per role, per station; shape switches per session; head hash identical across days and same-profile users; coordinator cold rows per mission; on the Anthropic path `cache_read_input_tokens / input_tokens` per role and shape.
- **P7 Shadow → A/B** (S4+): agreement rates, blind-judged disagreement samples weekly, then sessionId-hashed A/B on re-delegation count, forced-synthesis rate, turn tokens, p95 latency, corrective follow-ups.
- **P8 Router prompt checks**: JSON-validity rate (prose = failed call), p50/p95 latency of the triage's own shape on both stations, position-bias shuffle on any candidate-listing call, cost per 1,000 turns on the Claude preset.
- **P9 Drift monitors** after default-on: weekly gated/zero-shortlist rate per language (alert on >10% step or a 30-day slope; ≥3 of 20 consecutive gated calls), PSI on the top-1 agent distribution (>0.2), verdict-mix PSI, monthly clustering of low-fit queries to surface missing capabilities, never-retrieved entries.

## 9. What the adversarial review changed

Claims in the synthesis that were refuted and how the plan absorbs them:

- "customInstructions 7,331 → 1,300" — the kept blocks sum to 3,217; the head target is ~10,900, not ~9,000. Corrected everywhere.
- "create_ephemeral_agent 3,047 → 900 by moving the GRANTABLE list" — the list is 1,040 chars; the real result is ~2,090 and COORDINATE ~20,050 (−45%). Corrected.
- "effort addendum 0/651/1,306/2,131" — measured 349/0/481/651, injected once. Corrected in the constraints digest and here.
- "mission_coordinator → 3,200" — CORE + CONDITIONAL is 1,308 (+744 if the identifier rule stays). Corrected.
- "The session block is per-session constant, so the effort line belongs there" — effort is resolved per message and changed mid-session live; it stays in the tail.
- "A system-note session block at history[0]" — leading system messages are folded into the head (lmstudio.ts:1117–1131); the block is user-role, and compaction pins two leading user messages.
- "`--agent <name>` is an N0 directive the runtime sees" — rpc.ts strips it and sets a hard one-agent grant; N0 reads the grant; the pinned eval arm is exempt and the routing pack uses the composed arm.
- "The triage replaces the judge one-for-one in its slot" — the judge is skipped on attachment, follow-up-reuse and computer-access turns; the triage is issued unconditionally and the structural flags decide in N4.
- "Rule 5 single_agent before rule 7 answer_direct" — a strong topical match would have forced delegation on in-domain conceptual questions; the verdict's answer_direct is tested first.
- "Workflow dispatch when standout OR verdict says workflow" — deliverable agreement is mandatory and side-effecting workflows are never mechanically dispatched (the 7839e153 deck hijack class).
- "cross_domain and ORCHESTRATE entries compete fairly" — they never received the facet bonus; cross_domain is a wildcard and ORCHESTRATE gets the mode term on multi/coordinate.
- "Branch loadouts are a Phase-C latency win locally" — a shape switch re-prefills the whole history while a warm 36-tool block costs ~0.5 s; freeze is the local default, loadouts are session-monotonic and preset-gated pending an A/B.
- "3 s triage cap" — below the measured floor under load; the cap comes from S0 per-station measurements and legacy runs on the same shape.
- "Synthesis and QA calls build their own heads" — the synthesis head is the same base prompt; it is re-shaped to reuse the turn's warm prefix locally.
- "Workflow vectors precomputed at config load" — would hide runtime-saved scenes; precompute rides the index hooks with invalidation.
- "The head is byte-stable across users" — the personality block is per-user under auth; the invariant is per (user profile).
- "Mechanical dispatch removes no input the QA gates need" — riskGatedQA and the QA delivery loop read the plan; a minimal seeded plan is written before every mechanical dispatch.
- "No word lists remain on the routed path" — five survive; they are listed in section 5.2 with their disposition.

Two judge-level corrections applied to every design: `ToolContext.allowedAgents` is a hard gate, so the coordinator's shortlist is soft data; a min-max reranker over ≤5 candidates always maps the worst to 0, so rerank never decides admission.

## 10. Decisions for you

1. **German handling.** A (recommended): English-only cards; `query_en` from the facet call merged by max as a second query; per-language margin reported. B: A plus 3–5 generated German utterances per entry in the ranking-only vector. C: remove the German examples now in 48/49 descriptions (rejected: coverage loss with no replacement).
2. **Personality block (2,381 chars, your text, per-user file).** Recommended: keep verbatim in the head; under multi-user auth accept one warm head per user profile. Alternative: move it into the user-role session block when auth is on (the head becomes user-independent; the block re-prefills history once per session).
3. **Effort line placement.** Stays in the tail (corrected from the synthesis: effort is per message).
4. **Routing lane on the Claude preset.** Recommended: call-site fallback ON behind a flag after S4's gate, with the +1–3 s pre-call budget measured; the receptionist runs concurrently with N2/N3 on API-hosted presets. Alternative: mechanical-only under presets (no facet signal, no shadow data on the deployed backend).
5. **Mechanical single-agent dispatch (S10).** Recommended: ship gated, last, at tight thresholds with a two-week A/B — it is what your decision tree asked for. Alternative: never mechanical for agents; brief mode only.
6. **Confirm call (N4b).** Recommended: build only if S5 shows the ambiguous band on >15% of escalated turns.
7. **Taxonomy seeds with two contested calls.** Recommended: accept project_planner = PRODUCE(plan, single_agent) and the findings-brief workflows (verified_research_brief, deep_research, competitive_analysis) = GATHER; let the deliverable-facet ablation settle the straddles.
8. **Dead-code scope (S4b).** Recommended: delete all listed items (behaviour provably identical), after the compose-file grep for the bidder-worker.
9. **web_task_coordinator.** Its authored role (freshness-only lookups) cannot win under the taxonomy as labelled (ORCHESTRATE/needs_coordination/low confidence). Recommended: relabel GATHER/research/single_agent now and keep the routing test expectations; consider retiring it into researcher later. Alternative: retire now and delete the customInstructions line and the six test expectations together.
10. **Freeze vs loadouts on the local backend.** Recommended: freeze as the local default; loadouts session-monotonic and default-on for the Claude preset; decide the local default from the S2-vs-S7 A/B on cold-prefilled tokens per session.
11. **Receptionist fold.** Recommended for S12: keep N1 as is now; later fold the receptionist into the triage's `converse` mode (one small call for every non-smalltalk turn instead of two) once the shadow data shows the converse verdict is reliable.
12. **Core Principles trim (4,710 chars).** It was not in the classified corpus; a paragraph classification is needed before any trim target is set. Recommended: classify in S11, trim only CONDITIONAL/REDUNDANT paragraphs, eval-gated like every other text change.

## 11. Pointers

- Code: `packages/core/src/agent/{turn-system-prompt,session,turn-prepare,turn-setup,intent-classifier,receptionist,discovery-prefetch,deliverable-intent,sub-agent,sub-agent-prompt-guidance,default-tools,turn-plan}.ts`; `packages/core/src/tools/{agent-routing,sub-agent,workflow-catalog,registry,ephemeral-agent-factory,plan-executor}.ts`; `packages/core/src/providers/{embeddings,lmstudio,anthropic,index}.ts`; `packages/core/src/config/schema.ts`; `workspace/{agents,scenes,jobs}/*.jsonc`; `config/gateway/{10-gateway,40-orchestration}.jsonc`.
- Prior design docs this supersedes in part: `docs/staged-orchestration.md` (S2 lean planning prompt, S4 capsule), ADR-009.
- Session artefacts (scratchpad, may be gone): `phase1/*.json` (11 codebase maps, 6 research syntheses), `phase2/*.json` (4 designs, 3 judge reports, 2 taxonomies + merge, synthesis, 4 critiques), `CONSTRAINTS.md`.

## 12. Implementation status (updated 2026-09-20)

Ten commits on `develop`: `99bbbdc`, `dfb9b15`, `cbd3116`, `53e3e99`, `76aa67a`, `7ab2f68`,
`3bac1ae`, `a1f3047`, plus the eval slice below. Core suite
3691 passing; the one failure is `gateway.integration > resolves agent routing`, which fails
identically at the parent commit (known local-only). Lint clean, typecheck clean, and the
config feature-registry gate reports zero unreferenced fields.

### Built

| Slice | What landed | Flag / default |
|---|---|---|
| S0 | `sessionId`/`agentName`/`callSite` on `provider_model_call` via the request context; `agent_routing_evaluated` at the discovery prefetch and the un-named delegation path (with `surface`, the scored top-5 and elapsed time, including empty prefetches); `prompt_section_sizes` extended with the tool block, module, capsule, effort, enforcement, shared findings and a head/tail/history split; the receptionist's escalate reason recorded | none (always on) |
| S1 | Routing canary with a committed-snapshot diff (`pnpm routing:canary`, `--update`, `--json`); exits 2 as INCONCLUSIVE when the embedding backend is unreachable | none (a command) |
| S2 | `orchestration.stableToolBlock="freeze"` — the turn's tool array is byte-identical across every iteration; the discovery-withheld and forced-orchestration narrowings move to call-site refusal, logged as `tool_restriction_refused` | `off` |
| S3 | The IDCM taxonomy on the schema for agents, scenes and jobs; seed labels for all 88 entries in `workspace/{agents,scenes,jobs}/59-routing.generated.jsonc`; `resolveRoutingTaxonomy`, `lintTaxonomy` (a CI gate against the real catalog) and `facetAgreement` | authored `routing` overrides generated |
| S4 | `agent/triage.ts` (catalog-blind classification call, frozen versioned prefix, strict parser, grammar-constrained output) wired into the turn; `routing_triage_decided` carries the verdict and its agreement with the judge; a routing-tier preset fallback so the lane runs under a model preset at all | `orchestration.routingTriage: "off"` \| `"shadow"` |
| P1/P3 | `agent/routing-eval.ts` + `pnpm routing:eval`: a DECISION mode that is offline and deterministic (24 committed cases, run in CI) and a LIVE mode against the real catalog and embedding backend. A gated case counts as a miss, a run that scores nothing is INCONCLUSIVE rather than green, and a query that echoes its target's own catalog text is flagged as lexically leaked. `pnpm routing:eval:discriminance` reverts each guarded fix in turn and fails if the case named for it survives | none (commands) |
| S5 (partial) | `agent/routing-fusion.ts` — fit-space unification, capped confidence-scaled facet bonus, adaptive K, the full ordered branch rule set, `needsCoordination`, `workflowDispatchable`. PURE AND UNWIRED: nothing calls it in a turn yet | n/a |

### Not built

- The `"on"` value of `routingTriage`: the fusion exists but no turn consumes a `RoutedDecision`. The brief, the branch-driven prompt shapes and the loadouts are S5-S7 and are untouched.
- Everything in phases C, D and E: the session block, branch loadouts, the scoped coordinator handoff, mechanical dispatch, and every prompt-text change. The always-on head is byte-for-byte what it was.
- The routing-live pack (P5) and a golden set drawn from REAL traffic (P2). `eval/routing/live-cases.example.jsonl` is a starting point written from agent names, not from a run: every expectation in it is a hypothesis until `--mode live` is run against a stack.
- `notFor`, `entryAgent` and `requiresEvidence` were removed from the schema after the feature-registry gate flagged them: their consumers belong to later slices, and a field with no reader is an inert flag.

### What to do next, in order

1. Run `pnpm routing:eval` — it needs nothing but this repo, and it is the cheapest way to confirm the fusion still behaves before touching a deployment.
2. Run `pnpm routing:canary -- --update` against the live stack to record the first snapshot. Until it exists there is no baseline, and the canary reports INCONCLUSIVE rather than passing. It prints the catalog it loaded and its agent count; if that is not the 49-agent one, stop and run `pnpm config:build`.
3. Set `orchestration.routingTierPresetFallback: true` FIRST if the deployment runs a model preset. Under a preset the tier resolver returns null, so the upfront judge and the receptionist never execute — and the shadow gate is defined on agreement with that judge. Without this, every row reports `judgeComparable: false` and the gate has no data. It is a real behaviour change: the judge starts arming forced research on turns where it has been silent.
4. Turn on `orchestration.routingTriage: "shadow"` and collect a few hundred turns. The S4 gate is computable from `routing_triage_decided` alone: `sourceSensitiveAgrees` over rows with `judgeComparable: true` (use `judgeStatus` to see why the others were excluded — `not_started`, `no_answer`, `verdict_unwanted`), the parse-failure rate from `ok`, and latency from `elapsedMs`.
5. A/B `stableToolBlock: "freeze"` against `"off"` on cold-prefill rows per turn, now that `provider_model_call` rows join to their turn and carry `callSite`.
6. Copy `live-cases.example.jsonl` to `live-cases.jsonl`, correct it against what a live run actually produces, and keep it as the retrieval gate.
7. Only then wire the fusion (`routingTriage: "on"`), because its bonus weights and thresholds should be fitted against the shadow data rather than guessed. The decision suite is where each weight change has to prove it did not break a rule.

### What the adversarial review changed after the first five commits

A six-lens review over the implementation produced 84 findings; 70 were adversarially
verified and 25 survived. Three would have quietly defeated the mechanism they belonged to,
and all three are fixed in `7ab2f68`:

- The input-modality bonus could never fire: mode + domain + deliverable summed to exactly
  the cap. Its test passed on alphabetical tie-break order.
- Labels alone could buy a mechanical dispatch: the gate read the FUSED score while the
  bonus could exceed it, so an agent sitting on the admission floor qualified. The gate now
  reads raw embedding headroom.
- The freeze rung DELETED the discovery narrowing rather than moving it, because the
  call-site allowlist was derived from the un-narrowed array.

Also fixed: a failed judge was recorded as a real `false` verdict (the gate would have been
measuring backend outages); the tool wrapper dropped the request context, so model calls
inside tool handlers still produced NULL-session rows; the triage ran unlabelled, unbound to
the turn's abort signal, and on already-routed workflow steps; margin was computed on a
clamped value, so enabling the classifier suppressed dispatches; a scene's staleness hash
ignored `task`; and the canary loaded a zero-agent stub and blamed the operator's backend
(`3bac1ae`).

Fourteen verification agents died on a session limit, so fourteen findings remain unverified;
the distinct ones among them were checked by hand and are either fixed above or refuted.

### What the decision suite found

Building it surfaced one behaviour worth stating rather than leaving implicit: **K is cut
before rule 5 sees the shortlist**, so a decisively-ahead but undispatchable workflow does
not hand the dispatch to a much weaker one behind it. That is the conservative direction and
it is now pinned by `decisive-undispatchable-leader-does-not-hand-off`, next to the case
that pins the opposite behaviour when the two are close.

The discriminance harness also caught three cases of mine that passed for the wrong reason:
the saturated-pair case only guarded the margin basis and not the sort basis (clamping cannot
invert an order, only flatten it into a tie, so the stronger candidate now sorts last
alphabetically); the deck-hijack case carried a verdict that never voted `workflow`, so the
bypass it was meant to catch was inert; and the external-send case also declared a user
channel, so either gate alone covered for the other. All three are fixed, and each guarded
mechanism now has a case that fails when only that mechanism is reverted.

### Decisions from section 10 that the implementation already settled

- **#4 (routing lane under a preset)** — implemented as the call-site fallback, because without it the S4 shadow gate is unmeasurable on the deployment that carries the traffic.
- **#10 (freeze vs loadouts locally)** — `freeze` shipped first, as the reviews recommended; loadouts are not built, so the A/B in step 3 decides the local default with no code to unwind.
- **#12 (Core Principles trim)** — untouched. No prompt text changed in any of these commits.

The other decisions in section 10 remain open and none of them is blocked by what is built.

## 13. First live measurement (2026-09-20)

Everything above was designed against logs and code. This is the first time the routing path
was measured against the live catalog and a reachable embedding backend, and two things came
out of it that the design did not anticipate in this form.

### The reranker decides admission, and a developer-machine run does not have one

`resolveAgentRouting` blends `combinedScore * 0.7 + rerankScore * 0.3` and applies the
0.72 floor to the RESULT. The reranker is a docker sidecar on an internal network. It is
reachable from the gateway — its log shows `POST /rerank 200` from the gateway's own
address — and unreachable from a developer machine.

So every canary and eval run from a workstation scores a DIFFERENT pipeline from production,
against the same fixed gate, and neither report said so. The canary would have recorded one
as the committed baseline for the other, and its floor-crossing check would then have been
comparing two different systems and calling the difference a regression.

Fixed: `getRerankerRunStatus()` reports attempts, applications, circuit-open skips and the
last error. The canary and the eval print it, and `routing:canary --update` now REFUSES to
record a baseline from a run the reranker did not take part in unless `--allow-degraded`
is passed. The snapshot records the rerank state alongside the scores.

### German paraphrases land just under a gate their English twins clear

25 matched German/English query pairs, same catalog, language the only variable. Scores are
on the routing scale, `(cos + 1) / 2`, against the 0.72 floor. These are PRE-BLEND numbers.

| Request | German | English |
|---|---|---|
| where do we decide whether a delegation may run twice | 0.6918 | 0.7859 |
| what does the smallest model cost per million tokens | 0.6726 | 0.7788 |
| when do we both have two free hours next week | 0.6561 | 0.7337 |
| i need someone in the swarm for translations | 0.7116 | 0.8146 |
| how do i get all entries from the last seven days | 0.6996 | 0.7833 |
| which module decides how long a delegated run may take | 0.7055 | 0.7937 |
| who runs this in production today and what did it cost | 0.6779 | 0.7340 |

Seven of 25 German queries admitted NOTHING. All seven English twins admitted. Where both
admitted, the means were close (0.7892 against 0.8216), so this is not "German scores lower
everywhere" — it is bimodal. A German request either works about as well as its English twin
or it falls off a cliff, and which one it does is decided by a few hundredths.

The clearest single case: "ich braeuchte jemanden im schwarm fuer uebersetzungen" put
`swarm_maintainer` — the correct agent — at 0.7115. The gate is 0.72. The turn got nothing.

This is the `queryEn` second retrieval pass in §5.2 earning its place, and the measurement
says what it is worth: all seven collapses are recovered by the English restatement.

### The log could not have told anyone this was happening

`computeHybridRoutingScore` zeroes any sub-floor semantic score and the ranking then filters
`> 0`. So a query where 49 agents scored 0.71 produced the same audit row as a query nothing
matched: `resultCount 0, weakCount 0, gated false`. That is exactly the e1151d8 shape, and it
is why that incident was invisible until production broke.

Two further consequences, both structural rather than incidental:

- `weakCandidates` can never hold an EMBEDDING near miss. Without the reranker it is always
  empty in semantic mode; with it, only a rerank-induced drop can populate it.
- The branch in `sub-agent.ts` that fires on "only weak candidates" — the one that records a
  capability gap and tells the model which agents were close — is therefore unreachable for an
  embedding near miss. Every semantic miss takes the "nothing matched at all" path instead.

Fixed, as telemetry only: `AgentRoutingResolution.nearMisses` carries the top three sub-floor
embedding matches, and `agent_routing_evaluated` logs them. It is populated ONLY when the
ranking came back empty, because on a healthy turn there are always agents under the gate and
listing them would put three names on every row that nobody would act on. Nothing branches on
it: results, `weakCandidates` and every downstream decision are unchanged. Whether the
"only weak candidates" branch should be made reachable is a behaviour change, and it should be
decided on shadow data rather than on this reading.

### The reranker was deciding admission, and it was deciding it by RANK

The worst finding of the run, and the one an independent review caught rather than me.

`rerankViaTei` MIN-MAX normalises the model's logits. That discards their absolute meaning
and substitutes the candidate's RANK inside the shortlist: the worst always receives exactly
0, the best exactly 1. The old code fed that number into `combinedScore * 0.7 + rerankScore
* 0.3` and compared the result against the fixed 0.72 floor. Two things follow by arithmetic:

| candidate | best possible blended score | outcome |
|---|---|---|
| the reranker's LAST pick | 0.7 x 1.0 + 0 = 0.70 | below the floor, always |
| the reranker's FIRST pick | 0.7 x 0.72 + 0.3 = 0.804 | above the floor, always |

So an agent the embedding scored 1.0 was rejected for being the reranker's last pick, and an
agent scraping the floor was admitted for being its first. And because the embedding term
only varies across [0.72, 1.0] after its own floor while the rerank term is stretched across
the full [0, 1], the nominal 70/30 blend behaved closer to 30/70 in the reranker's favour.

Fixed as §5 N2 already specified: admission is decided by the embedding score, the blend is
kept as the sort key, and the reported score is the pre-blend one so it agrees with the floor
and with `confidenceLabel`. `retrieval.reranker.blendMode: "admission"` restores the old
behaviour for a deployment that has tuned around the old numbers. The change is monotone —
it can only add back candidates the embedding already admitted.

Note this does NOT affect document RAG, which ranks with the reranker but does not gate on an
absolute threshold.

### The canary was calling a ranking problem a floor problem

`searchByEmbedding(raw, provider, 8)` cuts to the top 8 BEFORE the floor is ever consulted,
so an entry can be missing from a result for two opposite reasons. The canary reported both
as "not admitted".

Re-running with the distinction restored changed the reading of every one of the eight
failures. All eight scored ABOVE the floor, between 0.7300 and 0.7851, and were cut by the
ranking:

| entry | probe | score | why it was missing |
|---|---|---|---|
| summarizer | tl;dr creation | 0.7851 | rank 10 |
| report_writer_agent | finding aggregation and dedup | 0.7709 | rank 10 |
| swarm_maintainer | tool routing | 0.7605 | rank 11 |
| data_analyst | json data inspection | 0.7592 | rank 6 |
| meeting_briefing_agent | handoff packets | 0.7551 | rank 6 |
| recon_agent | service enumeration | 0.7539 | rank 6 |
| devops_coordinator | rollback decision-making | 0.7515 | rank 24 |
| devops_coordinator | environment promotion | 0.7300 | rank 25 |

An independent adjudication of all ten canary findings confirmed ZERO of them as catalog
defects. They are short abstract noun phrases ("tl;dr creation", "tool routing") that several
agents legitimately advertise, and every natural phrasing of the same request retrieves the
right agent at rank 1. One adjudicator checked six phrasings of a summarizer request, in both
languages, and got summarizer first every time between 0.7779 and 0.8965.

The capability probes stay as they are. They are the only probe kind sensitive enough to
catch a uniform score drift: at a -0.01 shift ten capability probes fire and zero description
probes do. A canary tuned until it is green measures nothing.

### The classifier's English restatement fires on about 60% of German turns

The facet triage ran live for the first time: 0 parse failures in 27 calls, median latency
3.0s, p90 3.3s, comfortably inside the 8s timeout. Language labelling was perfect, 15 of 15.

But `queryEn` — the restatement a second retrieval pass would use to rescue the German
collapses above — appeared on only 9 of 15 German requests. Two rewordings were measured
against the same 15. Making it explicitly REQUIRED for non-English input made it WORSE (3 of
15): ending the line on the empty-string case is what the small model carries away. Putting
the restatement last gave 8 of 15, indistinguishable from the original.

So the prompt was left at `idcm-1`. The ~60% ceiling looks like a property of the model
rather than of the wording, and it bounds what the queryEn second pass can be worth. Bumping
a KV-cache-keyed frozen prefix for a change that does not measurably help is the blind
prompt-trim this project has already paid for three times.

### The rerank fix, measured on the real pipeline

A throwaway container from the gateway image, attached to the internal network and to the
LAN-egress network, can reach BOTH the reranker and the model server. That is the first run
in this project that scores what production scores. The recipe is in eval/routing/README.md.

The decisive comparison is the ADMITTED SET, not the self-probe. Same 22 live queries, same
catalog, one config value apart:

| | blendMode "ordering" | blendMode "admission" (legacy) |
|---|---|---|
| candidates admitted, total | 71 | 25 |
| recall hits | 11 | 9 |
| cases passed | 11 | 9 |

The legacy blend discarded 65% of the candidates the embedding had admitted, and it
discarded the right ones:

| request | agent lost to the legacy blend |
|---|---|
| build a sign-up page | web_coder |
| move three services to a new queue | devops_coordinator, project_planner |
| check a site for exposure | browser_agent |
| show the numbers as a chart | diagram_designer |

**The canary could not see this, and that is worth stating plainly.** On self-probes the
legacy mode scores slightly BETTER (235 of 245 against 233, mean 0.9627 against 0.9468),
because a self-probe puts the correct agent at the top of the reranker's list, which is
exactly where the defect does no harm. A metric can be sharper and still be blind to the
failure you are chasing.

### A routing miss now has somewhere to go

The measurement left one thing unfixed and it is the one a user would feel. When routing
admits nobody, `search_agents` answers:

> No agents matched "X". Delegate without an agentName so autonomous routing can bid on the
> original task, or use create_ephemeral_agent only if this is a brand-new capability not
> covered by ANY existing specialist.

That message is usually wrong about its own premise. Measured: 7 of 25 German requests
admitted nothing while the correct agent sat a few hundredths under the gate, so the model is
invited to invent a specialist that already exists.

`orchestration.surfaceRoutingNearMisses` (default off) appends the closest sub-floor matches
with their scores, and names the bar that actually applied — the 0.72 semantic admission
floor, NOT the requested confidence level. Sub-floor scores are zeroed before `minConfidence`
is consulted, so printing "below the medium bar" beside a 0.71 would be nonsense: medium's
own threshold is 0.45.

Nothing is admitted by this. The candidates stay out of `results`, the delegation stays the
model's decision, and the wording says the scores were below the bar. It replaces "nothing
exists" with "nothing cleared the bar, and here is what came closest". The near misses are
written to the tool's metadata whether or not the flag is on, so the flag's effect is
measurable from the log rather than only from the model's behaviour.

### What this run could not establish

- Production routing telemetry does not exist yet. `agent_routing_evaluated` ships in
  `99bbbdc`, which is not in the running image, so the audit log has no routing rows to
  analyse. Measuring the real distribution needs that commit deployed.
- Every number above is pre-blend. The reranker can move a candidate in either direction
  across the gate, so the German collapses may be worse or better in production.
- The canary's capability probes are short abstract noun phrases ("tl;dr creation",
  "tool routing", "handoff packets") and carry 32 of the 36 probe failures, while description
  probes carry 2. Whether that is a catalog finding or a probe-design artefact is open.
