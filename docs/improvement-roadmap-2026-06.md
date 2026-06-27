# StarlingAI Improvement Roadmap — June 2026

> Source: two adversarially-verified multi-agent audit passes (108 agents, ~5.1M tokens).
> **Pass A** = memory-management + orchestration hot-path + god-file (8 finders → 20 items).
> **Pass B** = the 14 remaining subsystems (14 finders → 42 items).
> Every item was confirmed against source by an independent skeptic reviewer; tempting-but-wrong ideas are in **§F Do-not-do**.
> IDs: `A#` = Pass A rank, `B#` = Pass B rank. `eval` = needs the pass^k gate + a default-off flag.

## Subsystem health map

| Subsystem | Health | Headline finding |
|---|---|---|
| memory (durable store) | notable-debt | supersession full-dir rescan/write, double-scoring, double-embedding, uncached blocking graphRerank |
| memory (consolidation) | notable-debt | **correctness bug**: substring dedup silently drops distinct facts |
| orchestration hot path | notable-debt | per-stage timings unmeasured; serial iter-0 retrievals; staged stages not effort-relaxable |
| god-file | notable-debt | runtime.ts 8.5k lines + tools/sub-agent.ts 289KB; clean pure-fn seams + a byte-identical dup |
| providers | notable-debt | one unguarded embed() call; degenerate-vector cache poisoning; 429 ignores Retry-After + no stream retry |
| tools-registry | minor-debt | ~80 full tool schemas re-sent every iteration (highest-frequency prompt tax); O(N×M) catalog scan |
| tools-impl | notable-debt | unbounded extractor reads (OOM); `fetchWithTimeout` ×8; ~10 copy-paste artifact epilogues; wasted web_fetch HEAD |
| gateway-channels | clean | no material issues (raw-body error-handler pattern tracked under interop) |
| interop (A2A/MCP/fed) | notable-debt | A2A body reader = unbounded-mem DoS + hang; bridged MCP dead on drop; legacy-jsonrpc empty-body break |
| db-persistence | minor-debt | QuestDB 1 POST/metric; vectorUpsertMany N serial inserts; engram list re-fetch/turn; hardcoded pool sizes |
| security | clean | no relaxation needed; security findings fold into interop/providers/tools-impl coverage guards |
| routing-intent | needs-attention | softRoutingEnforcement misses the dominant prompt; 2 divergent artifact classifiers; 6 bilingual-keyword bags |
| self-improve-skills | notable-debt | capability-gap driver never started (severed loop); skills re-parsed sync from disk every turn |
| computer-multimodal | minor-debt | vision call on byte-identical frames; no vision-by-hash cache; capture_region is a full-screen stub; serial TTS |
| jobs-async | notable-debt | workflows redo completed steps on recovery (dup side effects); SELECT+UPDATE/tool-call; ~1s job pickup |
| config-cli-runtime | notable-debt | triplicated shard-merge (build can emit loader-rejected config); double 277KB stringify; health probe blocks reload |
| web-frontend | notable-debt | O(n²) streaming markdown re-parse + per-token reflow; mermaid eager-bundled into landing; no transcript virtualization |
| mail-service | needs-attention | every op connect+TLS+LOGIN+full-LIST, no pool; mail_search full-RFC822 for previews; DraftStore lost-update |

---

## §A — Ship-now quick wins (S effort, low risk, no flag)

These are byte-identical / correctness / security guards validated by existing or one new vitest. No eval gate.

| ID | Title | Files | Win |
|---|---|---|---|
| B1 | Reject + never-cache degenerate (zero/empty) query embeddings | providers/embeddings.ts:1637/1593 | stops one transient zero-vector poisoning ALL retrieval for the TTL |
| B2 | Cap + error-guard the A2A inbound body reader | a2a/server.ts:327 | removes unbounded-mem DoS + indefinite hang on public surface |
| B3 | Bound extractor file reads + outputs (mbox/eml/ipynb/ics) | tools/extractors.ts, new io-limits.ts | removes OOM/context-blowout on large uploads |
| B4 | Batch QuestDB telemetry writes (dozens/turn → ~1) | observability/telemetry.ts | fewer sockets/ingest pressure |
| B5 | Single multi-row UNNEST INSERT for vectorUpsertMany | db/vector-store.ts:172 | RAG ingest O(chunks) round-trips → 1 |
| B6 | Fire-and-forget model-endpoint health probe in reload | index.ts:291 | removes up to 10s reload stall behind a dead endpoint |
| B13 | Legacy MCP transport: accept empty-body notification responses | mcp/client.ts:286 | unblocks a dead transport variant |
| B22 | Enforce plugin name===basename | plugin/loader.ts:350 | kills spurious plugin reload churn |
| B23.1 | Drop the web_fetch HEAD probe (Part 1, un-flagged) | tools/web.ts:275 | one serial timeout hop removed per fetch |
| B42.1 | Delete hardcoded PRODUCT_RECOMMENDATION component nouns | intent-classifier.ts:97 | de-overfit; existing test stays green |
| B27 | Anthropic 429/529 backoff: Retry-After + jitter + cover stream() | providers/anthropic.ts:558 | no synchronized retry storms on the streaming hot path |
| B15 | O(N+M) tool-catalog assembly (Set lookup + single walk) | tools/registry.ts:242, default-tools.ts | thousands of redundant string compares/turn; cleans the lean-catalog seam |
| A2 | Single-pass scoreRecord in searchMemoryRecords | memory/service.ts:200 | halves lexical scoring CPU per recall, byte-identical |
| A3 | TTL-memo the readRecentOutcomes chokepoint | agent/outcomes.ts:53 | ~30 redundant JSONL reads/route removed |
| A19 | Delete dead, throw-on-call graphDetectOutliers | memory/graph-service.ts:386 | −70 lines latent-broken code |
| A16 | Dedupe byte-identical looksLikeHallucinatedTruncationClaim | container-failure.ts (+runtime/sub-agent) | kills a drift hazard, smallest diff |

## §B — Bigger no-flag wins (M/L effort, low–med risk, no eval gate)

| ID | Title | Win |
|---|---|---|
| A1 | **Per-stage turn timing (`phaseTimingsMs`+`untrackedMs`)** | the meta-unblocker — makes S3/S4 live-eval measurable; de-risks A7/A9/A10/B24/B37 |
| A13 | **Fix session-consolidation substring false-drop (correctness)** | stops silent loss of distinct facts |
| A4 | Embed durable content once, fan out to flat-file + graph | halves embed calls/write; unifies graph vs search vector |
| A5 | Supersession off a pre-write cache snapshot, not a disk rescan | O(records) read → O(superseded) write |
| A6 | Precompute tokenSets in O(n²) compaction grouping | removes a multi-hundred-ms stall every 50th write |
| A7 | Parallelize iter-0 memory+skill+prefetch retrievals | collapses 2–3 serial embedding round-trips off TTFB |
| A8 | Timeout + TTL-cache graphRerank/graphL0Layer | removes 1–2 serial MemGraph round-trips/turn (timeout default-on; L0 cache flag) |
| A17 | Warden SLO breach → dominant-phase attribution | depends on A1 |
| B2.5 | Hard-timeout + bounded retry on the embeddings provider call | bounds the one unguarded provider call |
| B7 | Frame-coalesce streaming render + scroll-follow (kill O(n²)+reflow) | smooth streaming on mid/low-end devices |
| B8 | Dynamic-import mermaid (+split hljs) out of the landing chunk | smaller first-paint, faster TTI |
| B9 | DraftStore in-memory authoritative + write serialization | removes lost-update class + N reads/search |
| B12 | Lazy reconnect for bridged MCP connections (med) | MCP tools self-heal after a server restart |
| B14 | Cache parsed skills (SKILL.md) off the hot path | removes O(N) sync disk reads/turn — keep meta fresh |
| B18 | Connect the capability-gap driver + bound the _gaps Map | repairs the severed self-improve loop (no-op while default-off) |
| B19 | Collapse per-tool-call progress write to one merge + throttle | halves round-trips, ~5–20× fewer writes for swarm jobs |
| B20+B21 | Memoized config-reload diff + skip no-op artifact serialize | stops double 277KB stringify on every self-edit |
| B25 | Wire computer_capture_region to crop the framebuffer (kills stub) | region payloads ≪ full frame; less data exposure |
| B26 | Wake the job worker on enqueue | removes ~1s job pickup latency + idle DB polling |
| B28 | Engram doc-list TTL cache (med) | drops a serial round-trip + unbounded payload/RAG turn |
| B29 | Half-open probe + flap damping for the failover breaker (med) | caps wasted requests to dead endpoints; damps thrash |
| B30 | Bounded-concurrency TTS chunk synthesis (med) | long-text TTS sum(chunks) → sum/concurrency |
| B32 | Shared artifact-write mechanic (narrow no-op dedup) | ~6 overwrite guards → one |
| B33 | Consolidate fetchWithTimeout 8→1 + split escapeHtml content/attr | smaller timeout/SSRF surface (hand-rewrite call sites!) |
| B38 | Unify triplicated config shard-merge (closes build/loader zone gap) | **strengthens a security guardrail** |
| B40 | Surface DB pool sizes (+ef_search) as durable config | removes hidden pgvector max:3 concurrency ceiling |
| B41 | Memoize buildDynamicTurnGuidance + hoist per-term RegExps | one redundant classifier pass + per-term regex compiles removed |
| A15 | Extract evidence-dump cluster → runtime-evidence-dump.ts | god-file −330 lines; import+re-export |
| B31 | Resumable workflow jobs (skip completed steps on recovery) (L) | correctness: removes duplicate side effects on restart |

## §C — Eval-gated behavioral changes (need deploy + pass^k + default-off flag)

| ID | Title | Flag | Win |
|---|---|---|---|
| A9 | effort-tier-relax qaDeliveryLoop + discoveryPrefetch | effort overlay | restores "low effort = cheaper" |
| A10 | Skip qaDeliveryLoop round-0 when riskGatedQA verified clean | qaDeliveryLoopSkipVerifiedRound0 | −1 redundant slow-model call/turn |
| A11 | Normalize parallel_delegate slices to English | normalizeDelegationToEnglish | routing parity across delegation tools |
| A12 | Score-gap-bounded shortlist before graphRerank | memory.boundedGraphRerank | search latency flat as store grows |
| A14 | Always-on injection skip for graphRerank | graphRerankAlwaysOnInjection | drops graph hop from the cheap 4-item block |
| B10 | Skip per-action vision LLM call on byte-identical frames | computerUse.skipVisionOnUnchangedFrame | large per-task latency cut, lossless |
| B11 | Cache vision analysis by screenshotHash | computerUse.visionCacheEnabled | dedup verify-after-action (keep Warden fresh) |
| B24 | Tool-rerank threshold gate (skip embed on small toolsets) | orchestration.toolRerankMinTools | −1 embed round-trip on ~40/49 agents |
| B34 | Route softRoutingEnforcement through the dominant prompt | softRoutingEnforcement | makes the half-wired flag actually work |
| B35 | Shared artifact-vocabulary base for the 2 intent classifiers | unifiedArtifactVocabulary | de-drift (behavior-neutral unless firing changes) |
| B36 | Async A2A tasks (submitted→working→completed), TWO-SIDED | a2a.asyncTasks | no proxy-timeout on slow delegations |
| B37 | **Lean orchestrator tool-catalog** (static split + mid-turn schema injection) | orchestration.leanToolCatalog | ~50% per-iteration tool-schema prompt cut — biggest product-wide token lever |
| B42.2 | Migrate bilingual-keyword detectors → English-only structural (XL) | intentTagClassifier | removes largest overfit surface (do LAST, one intent at a time) |

## §D — Harness throughput (not eval-gated, flag-gated default-off)

- **A18 / B-meta — Parallelize the pass^k eval gate** (bounded k-attempt concurrency, `evalConcurrency`). Cuts gate wall-clock ~2–3×, de-frictioning *the* gate that every §C item depends on. Exclude per-attempt durations from the latency-spike signal under concurrency; artifact-gated cases stay sequential or get cloned workspaces.

## §E — Security hardening (coverage/correctness only — never relaxation)

- A2A inbound body reader: cap + error/aborted handlers (B2).
- Degenerate query embeddings cached & served (data-integrity) (B1).
- Extractors read entire files unbounded, bypassing the 1MB guard (B3).
- Config build-vs-loader zone-skip asymmetry — build can emit a config the loader's security guard would refuse (B38).
- Resumable workflows MUST NOT skip a completed humanInLoop/approval step without a persisted marker (B31).
- Lean tool-catalog MUST keep pentest tier gating intact — withhold schemas, never weaken tier checks (B37).
- Vision-by-hash cache stays scoped to analyzeScreenshot — Warden credential/dialog detectors stay fresh (B11).
- DAV/IMAP client caches keyed by account-id/credential-fingerprint, NEVER by user (B16).
- COMPUTER/SERVER/PENTEST routing detectors are security-adjacent — migrate last, benign-vs-pentest as an explicit eval guardrail (B42).

## §F — Do-not-do (verified-and-rejected — don't revisit)

- Make memory writes async to "unblock the loop" — sub-ms writes, contract break (A).
- Add a min-score floor to scoped-memory injection — default lean path never calls it (A).
- Gate discovery-prefetch on `detectedDynamicGuidance===null` as a direct-knowledge proxy — keyword-overfit-by-proxy (A).
- Extract the workflow-catalog as a 600-line seam — couples live control flow, decreases cohesion (A).
- English script/function-word pre-filter to skip normalization — banned keyword overfit (A).
- Fixed N=limit×3 rerank shortlist — breaks ranking parity; only the score-gap shortlist is safe (A).
- Keyword/marker history-compaction digest — banned overfit; use structural signals only (A).
- Memoize getCollapsedHistory — self-invalidating, zero benefit (A).
- Set `artifactSensitive = wantsArtifact` — conflates a soft nudge with a costly autopilot (B35).
- "Move intent decisions downstream of normalization" — architecturally impossible (B42).
- Find/replace `fetchWithTimeout` — divergent arg order silently transposes timeout/init on the SSRF path (B33).
- Collapse escapeHtml to one fn — content (3-char) vs attribute (5-char) is security-relevant (B33).
- Server-only A2A async flip — bundled client is one-shot, returns empty for every internal delegation (B36).
- Prune tools out of allowedToolNameSet — named-but-dropped tool hits the hard not_in_turn block (B37/B24).
- Compiled-artifact write initial-load-only — updateConfig needs it to propagate overlay edits (B21).
- Engram doc-list event-only invalidation — cross-process mutation → stale-scope leak; use short TTL (B28).
- Delete the capability-gap driver as scaffolding — connect it (no-op default-off) instead (B18).
- Single shared warm ImapFlow client/account — head-of-line blocking; use a bounded lease pool (B16).
- Re-propose skill-lift/holdout or per-turn distillation "optimizations" — already shipped/implemented (B).
