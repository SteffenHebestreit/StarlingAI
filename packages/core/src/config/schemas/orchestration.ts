import { z } from "zod";

// ─── Orchestration tuning ─────────────────────────────────────────────────────
// Hardware-dependent limits that previously required code edits. All values
// overlay the built-in defaults — omit a key to keep the default.
export const OrchestrationSchema = z.object({
  /** Max simultaneous parallel research slices dispatched by a source-sensitive
   *  coordinator.  Set to 2 for a single local GPU, 3-4 for multi-GPU or
   *  API-based backends.  Built-in default: 2. */
  maxParallelSlices: z.number().int().min(1).max(8).default(2),
  /** Maximum sub-agent delegation nesting depth. The orchestrator is depth 0;
   *  its sub-agents depth 1; their sub-agents depth 2; and so on. A sub-agent
   *  at or beyond this depth may not delegate further — it must gather evidence
   *  with its own tools and synthesize. Bounds the delegation tree so a complex
   *  task can't nest into a runaway cascade. Built-in default: 3. */
  maxDelegationDepth: z.number().int().min(1).max(8).default(3),
  /** When true, the orchestrator is nudged to record a short structured plan
   *  (record_plan) before fanning out on a complex/multi-agent turn — a soft
   *  checkpoint that QA checks against and the operator dock can surface for
   *  high-stakes approval. Trivial turns still answer directly. Default: true. */
  planFirst: z.boolean().default(true),
  /** When true, high-stakes turns (sourced factual claims, approval-gated
   *  actions, or a plan the orchestrator flagged high-risk) get an automatic
   *  verification pass that checks the answer against the plan's acceptance
   *  criteria and repairs it if it falls short. Low-stakes/chat turns skip QA
   *  entirely. Source-sensitive turns reuse the existing evidence backstop.
   *  Default: true. */
  riskGatedQA: z.boolean().default(true),
  /** Plan-driven continuation (audit 763394da). The post-orchestration disposition
   *  defaults to "synthesize" after the FIRST successful delegation and never
   *  consults the recorded plan — so a multi-deliverable request (e.g. "1) paper
   *  2) slides 3) speaker notes") that recorded a 4-step plan shipped only the
   *  paper and dropped the rest. When true, a turn that recorded a plan with ≥2
   *  steps keeps orchestrating (a [CONTINUE PLAN] directive naming the remaining
   *  deliverables) until every planned step has an actual completed tool result
   *  this turn, instead of synthesizing after step 1. Bounded by the per-turn
   *  delegate cap and only extends on SUCCESS (never after a failure), so it
   *  cannot loop. Purely structural (plan step count vs delegations run); no
   *  topic/keywords. Default OFF — it changes when a turn stops orchestrating, so
   *  it stays gated until a pass^k eval confirms it doesn't over-run single-
   *  deliverable turns. */
  planDrivenContinuation: z.boolean().default(false),
  /** Autonomous-mode anti-refusal (audit 763394da). `--auto` sets autoApprove
   *  (auto-approve tool calls) but does NOT tell the model "execute autonomously,
   *  don't ask" — so an --auto multi-step build was met with a clarifying question
   *  + "I can't create files" refusal AND a false "I gathered and verified"
   *  claim with zero tool calls. When true, an autoApprove turn that must
   *  orchestrate (a recorded plan, or a required-research/required-artifact task)
   *  and tries to answer tool-free is rejected once and forced to emit the first
   *  tool call (reusing the routing-nudge/forceToolChoice path) instead of
   *  dead-ending in a question/refusal. Structural (autoApprove flag + must-
   *  orchestrate + zero tool calls); no topic/keywords. Default OFF — behavioral,
   *  pass^k-gated. */
  autonomousModeAntiRefusal: z.boolean().default(false),
  /** Runtime oversight: when true, a sub-agent gathering evidence is checked at
   *  evidence boundaries against the turn's recorded plan acceptance criteria using
   *  the cheap routing-tier model; once the goal is already satisfied it is
   *  authoritatively finalized (the existing strip+synthesis path) instead of
   *  grinding through more sources. Goal-aware, not a per-task source cap; a
   *  routing-tier miss/error falls through to the byte/time ladder. Default: true. */
  oversight: z.boolean().default(true),
  /** Final-response completion QA gate. When true, before shipping the final answer the
   *  runtime verifies that an interactive/served app the user asked to BUILD was actually
   *  produced as a file; if not, it runs ONE bounded corrective build (the right builder)
   *  and ships the built artifact instead of a concept/description. Bounded to a single
   *  corrective iteration per turn. Default: true. */
  finalResponseQaGate: z.boolean().default(true),
  /** When true, a source- OR freshness-sensitive turn that delegated SUCCESSFULLY
   *  (so the failure-path evidence backstop never fired) has its final answer
   *  cross-checked against the curated shared findings: if the answer references
   *  none of the verified tokens, it is re-synthesized grounded in those findings
   *  before shipping. This is the universal grounding gate (step 5) — it catches the
   *  "ships a training-data answer while verified facts sit in shared findings" case.
   *  The cross-check is deterministic; the extra synthesis call only fires on the
   *  unanchored-answer path, so clean turns are unaffected. Default ON. */
  qaEvidenceAnchoring: z.boolean().default(true),
  /** When true, the orchestrator's system prompt gains a short HONESTY directive:
   *  never claim the answer is based on CURRENT / LIVE / RECENT / EXTERNAL data unless
   *  it was actually retrieved via a tool THIS turn — if currency materially matters,
   *  route to a research specialist instead of asserting from parametric memory. Targets
   *  the "direct answer dressed up as fresh-data grounding" failure (a freshness-sensitive
   *  question answered with 0 tool calls that still opens "based on current market
   *  data…"). General + language-independent (no topic keywords). Default OFF — it's a
   *  tuned-prompt behavioural nudge, so it stays gated until a pass^k eval confirms it
   *  doesn't suppress legitimate direct answers. */
  freshnessHonestyGuard: z.boolean().default(false),
  /** Citation-honesty guard: on a sourceSensitive turn that ran NO real web/research
   *  execution (no delegation, no SUCCESSFUL workflow, no direct web tool, no shared
   *  findings) but whose answer carries URL citations or "verified against N sources"
   *  claims, strip the fabricated citations (markdown links → plain label, bare URLs
   *  removed, the explicit verification claim neutralized) and prepend the honest
   *  unverified caveat — so no invented 404 link or false "verified" claim ever ships
   *  (audit 1303e254). Structural (URL detection is language-free); never empties the
   *  answer. Default OFF — gated until a pass^k eval confirms it doesn't strip the
   *  citations of a genuinely-researched answer. */
  citationHonestyGuard: z.boolean().default(false),
  /** Proactive complement to citationHonestyGuard: when the user's message STRUCTURALLY
   *  carries an http(s) URL (they handed the assistant a page to read) and the model tries
   *  to answer tool-free, FORCE a real fetch — reuse the research-enforcement nudge →
   *  auto-delegate → grounded-synthesis path so the page is actually read before answering,
   *  instead of the model inventing its contents (live session 29796f86: a fabricated job
   *  posting from a link that was never fetched). Trigger is fully structural (URL regex +
   *  the no-real-research tool-call gate) — no topic/language keywords. Restores the honesty
   *  enforcement the de-lex stripped when it hardwired sourceSensitive off. Default OFF,
   *  pass^k-gated (forcing a fetch on every pasted link can over-fire on "here's a link for
   *  later" messages). */
  urlFetchEnforcement: z.boolean().default(false),
  /** Answer-side honesty backstop for a turn where real research RAN but failed/returned partial
   *  (forced-synthesis fired, a delegation failed, or a partial-delegation was detected) and the
   *  draft is NOT anchored to the recovered evidence: re-synthesize from that evidence, or — if no
   *  evidence exists — replace the training-data draft with an honest "research did not complete"
   *  message instead of shipping unverified specifics. The de-lex hardwired sourceSensitive off,
   *  which killed this backstop; restored here from STRUCTURAL failure-signals only (no keywords).
   *  Default OFF (it can replace an answer) — pass^k-gated. */
  failedResearchHonestyBackstop: z.boolean().default(false),
  /** The GENERAL sibling of urlFetchEnforcement (the de-lex hardwired sourceSensitive/freshnessSensitive
   *  off, which killed the general force-real-research invariant — only the URL sub-path was restored).
   *  When true: an orchestration_only turn that answers tool-free (zero delegation/workflow/web-tool/
   *  shared-finding this turn) with a SUBSTANTIAL, specifics-dense draft (looksLikeUnsourcedSpecificClaims
   *  — a structural count of number+unit / currency / percent / year / date / part-code tokens, ≥4
   *  distinct over a 400-char floor; NO topic/language keyword table) is reciting current/external
   *  state from training memory as fact. Reject once and force a real research delegation via the intact
   *  nudge → autoResearchOnRefusal → grounded-synthesis path (never dead-ends; a released draft still
   *  gets the unverified caveat). Restores audits fe496ec5 ("news von heute" invented bulletin) /
   *  bdbace34 (fabricated specs). Default OFF — it can convert a legitimate direct answer into a
   *  delegation (latency), so pass^k-gated. */
  ungroundedFactualAnswerGuard: z.boolean().default(false),
  /** SEMANTIC tier of ungroundedFactualAnswerGuard. The structural counter above only catches
   *  NUMBER-dense drafts; it is blind to prose/named-entity fabrication — a wrong operator/
   *  institution, a mis-stated law, or a confidently-wrong account of how a PARTICULAR real system
   *  works carries zero fact-shape tokens (audit 57c99128: a tool-free "how does the Danish deposit
   *  system work" answer named the wrong operator with no numbers the counter could see, so the guard
   *  never fired). When true, on a substantial tool-free ungrounded draft that the structural tier did
   *  NOT already flag, a cheap routing-tier LLM judge (ungrounded-claim-judge.ts) reads the question +
   *  draft and decides whether it asserts SPECIFIC unverified external-world facts; if so it reuses the
   *  same reject → autoResearchOnRefusal → grounded-synthesis path (never dead-ends). Bounded: fires
   *  ONLY when the structural tier passed AND the draft clears the same 400-char floor, uses the routing
   *  (cheap) tier, and fail-SAFE falls back to structural-only on any judge error/parse miss. This is
   *  the semantic "validate the assumptions" signal the de-lex removed with the sourceSensitive flag —
   *  reasons about the draft in ANY language, no keyword table. Default OFF — adds one routing-tier call
   *  per risky tool-free draft AND can convert a legitimate direct answer into a delegation (latency), so
   *  pass^k-gated alongside ungroundedFactualAnswerGuard. */
  semanticUngroundedFactualGuard: z.boolean().default(false),
  /** UP-FRONT source-sensitivity classifier. The two ungrounded guards above are POST-DRAFT: the
   *  model drafts a tool-free answer, it streams to the user, and only THEN is it rejected and
   *  research forced — so the user sees "answer, then research" (audit a75e1c26 follow-up). When
   *  this is true, a cheap routing-tier classifier (ungrounded-claim-judge.ts,
   *  buildSourceSensitiveQuestionJudgeMessages) reads the QUESTION before the first model call; a
   *  positive verdict sets the sourceSensitive signal so requiresDelegatedResearch fires, which BOTH
   *  suppresses the throwaway draft AND forces the model to orchestrate research FIRST — i.e.
   *  "research, then answer". This is the proper re-arming of the sourceSensitive routing flag the
   *  de-lex hardwired off. Bounded/fail-safe: one routing-tier call per orchestration_only turn,
   *  skipped for a reuse-prior-evidence follow-up, a computer-access turn, or a document-RAG-grounded
   *  turn; on any classifier error it falls back to the post-draft guards. Primary mechanism for the
   *  source-sensitive case (prevents the draft instead of catching it after); pairs with
   *  semanticUngroundedFactualGuard as a post-draft BACKSTOP for questions this classifier misses —
   *  running both is belt-and-suspenders, at the cost of a 2nd routing call on a drafted turn. Default OFF
   *  — it adds a routing hop to every orchestration turn (including ones that don't need research) and
   *  can convert a legitimate direct answer into a delegation, so pass^k-gated. */
  upfrontSourceSensitiveClassifier: z.boolean().default(false),
  /** Only ever show the user the VALIDATED response — never the intermediate tool-free draft. With
   *  the honesty guards able to reject a draft and replace it with researched synthesis, streaming
   *  the iteration-0 draft token-by-token shows the user an answer that may be discarded ("answer,
   *  then research"). When true, the first response on an orchestration_only turn is BUFFERED, not
   *  streamed: a draft that passes the guards is still delivered whole as the final message; a
   *  rejected one never reaches the user, who sees only the researched/validated answer. The model
   *  may still draft internally (cheap on the local model) and the draft is NOT used to seed the
   *  research — the research task is built from the user's QUESTION and synthesis is grounded in the
   *  gathered evidence, so the (possibly wrong) draft cannot bias the result. Trade-off: quick direct
   *  answers no longer stream token-by-token — they appear at once after the turn resolves. Default
   *  OFF (it changes the streaming UX for every orchestration turn); enable alongside the honesty
   *  guards when "show only the validated answer" is the desired behaviour. */
  suppressUnvalidatedDraftStreaming: z.boolean().default(false),
  /** Terminal fabrication guard: a turn that RESEARCHED (produced ≥1 curated shared fact) but
   *  produced NO artifact file, and whose answer INLINES a full HTML application document
   *  (looksLikeInlinedAppDocument — the never-legit-inline structural signal), is the model
   *  hand-writing the whole deliverable from training data and passing it off as the built,
   *  "verified" result (audit 453a263e: a fabricated reveal.js deck after the build was stopped).
   *  Replace it with the honest curated-facts fallback (real findings + sources, stating the file
   *  was not built this turn). The de-lex hardwired sourceSensitive off, killing the guard; revived
   *  here on PURELY STRUCTURAL signals — curated-facts count + zero attachments + a full inlined
   *  HTML document — with NO bilingual wantsArtifact keyword gate. Default OFF (it replaces an
   *  answer) — pass^k-gated. */
  inlineArtifactFabricationGuard: z.boolean().default(false),
  /** Sub-agent-level force-real-research (mirror of ungroundedFactualAnswerGuard, one layer down).
   *  A researcher SUB-agent that has gathered essentially zero evidence this run (cumulative useful
   *  bytes < 120, zero substantive evidence items, no share_finding) yet is about to answer is
   *  fabricating a researched-looking answer with no retrieval. Force it to actually delegate/search
   *  first. The de-lex hardwired the old sourceSensitiveTask gate off, killing this; restored here on
   *  the EXISTING structural evidence-starvation signals PLUS a capability check — the sub-agent must
   *  actually hold web/research tools (web_search/web_fetch/url_inspect/browser_*), so a write-only
   *  renderer (a coder rendering a spec) is never forced to research. No topic/language keyword table.
   *  Default OFF — it can force an extra delegation, so pass^k-gated. */
  subAgentPreEvidenceResearchForce: z.boolean().default(false),
  /** Universal grounding gate: a turn that delegated research SUCCESSFULLY can still ship a
   *  training-data answer while the verified findings sit unused in shared facts (audit fe496ec5).
   *  The de-lex hardwired the old sourceSensitive/freshnessSensitive gate off, killing the anchoring
   *  repair inside riskGatedQA. When true, re-arm it on PURELY STRUCTURAL turn-state — real
   *  orchestration ran this turn AND produced curated shared facts the answer does not reference
   *  (the cheap deterministic answerNeedsEvidenceAnchoringRepair; no keyword table, no sourceSensitive
   *  read) — running independent of the plan-derived risk tier so a plan-less research turn is covered.
   *  When off, control falls through to the acceptance-criteria arm exactly as before. Default OFF (it
   *  can re-synthesize an answer) — pass^k-gated.
   *
   *  EVALUATED 2026-07-18 over 30 labelled (evidence, answer) pairs
   *  (tests/fixtures/anchoring-corpus.json; 15 de / 15 en, 18 grounded / 12 ungrounded,
   *  every label re-derived by an independent relabeller). The first measurement
   *  disqualified the flag outright and located the fault in the shared detector:
   *
   *      before the condition-2 fix   ALL  FP=15/18 (83%)  FN= 1/12 ( 8%)  accuracy 47%
   *      after  the condition-2 fix   ALL  FP= 2/18 (11%)  FN= 2/12 (17%)  accuracy 87%
   *                                   de   FP= 1/9  (11%)  FN= 2/6  (33%)  accuracy 80%
   *                                   en   FP= 1/9  (11%)  FN= 0/6  ( 0%)  accuracy 93%
   *
   *  (FP = an already-grounded answer is discarded and re-synthesized. Never firing at
   *  all scores 60%, so 47% was worse than useless and 87% is a real gain.)
   *
   *  The fault was NOT this flag's wiring but looksEvidenceAnchored's condition 2, which
   *  treated every hyphenated token as a falsifiable spec needing a verbatim evidence
   *  match. Ordinary prose hyphenates in both languages ("half-hour", "13-inch",
   *  "user-replaceable", "wartungs-release"), and locale date reformatting
   *  ("20.02.2025" vs evidence "2025-02-20") looked like invention. Condition 2 now
   *  checks only identifier-shaped segments (letters AND digits, e.g. "i2s", "usb4")
   *  and accepts date-shaped tokens whose parts all appear in the evidence. That fix
   *  also benefits failedResearchHonestyBackstop, which is ENABLED and calls the same
   *  detector to decide whether an answer may stand.
   *
   *  STILL DEFAULT OFF pending a live pass^k. The residual 11% FP means roughly one in
   *  nine good answers is still re-synthesized, and the corpus is 30 pairs of written
   *  (not live-captured) answers. The remaining FNs are prose-only fabrications that
   *  carry no identifier token at all — structurally outside a token-matching detector,
   *  and the job of semanticUngroundedFactualGuard rather than this flag.
   *
   *  MODEL-DEPENDENCE (measured, not assumed). The trigger is a PURE deterministic
   *  function — regex and string matching, no LLM — so for a given (answer, evidence)
   *  pair its verdict never varies by model; only the PROSE STYLE of answers varies.
   *  The corpus was written by a STRONG model, not the local one, and still scored 83%
   *  FP before the fix, with all 15 false positives driven by hyphenated prose tokens
   *  (those that fired averaged 5.2 such tokens; the 3 that passed averaged 1.0). A more
   *  capable model writes MORE compound adjectives, so it would have RAISED that rate,
   *  not lowered it — a better model was never going to rescue the old detector.
   *
   *  What genuinely does vary by model is the flag's value and its cost:
   *    - value: a weaker model fabricates more often, so there is more for the guard to
   *      catch (the flag is worth most exactly where its repair is worst);
   *    - cost : a wrong repair is re-synthesized by the SAME model, so on a weak local
   *      model a false positive is likelier to be a quality regression, whereas a strong
   *      model may rewrite it about as well.
   *
   *  Re-measure per deployment with tests/anchoring-corpus-measure.test.ts — ideally
   *  swapping in answers produced by that deployment's own model — after any change to
   *  evidence-anchoring.ts, before flipping the default. */
  evidenceAnchoringOnGatheredEvidence: z.boolean().default(false),
  /** #5 (citation-honesty tightening): the URL-not-fetched caveat's 400-char floor lets a SHORT
   *  fabricated page summary slip (a ~300-char answer that asserts the page's content but stays under
   *  the floor). When true, ALSO fire the caveat on a shorter answer (≥150 chars) that structurally
   *  ASSERTS specifics (answerAssertsSpecifics: ≥2 fact-shape tokens) — the honest short "couldn't
   *  fetch it, shall I?" carries none and stays clear. Non-destructive (prepend-only). Modifies the
   *  ENABLED citationHonestyGuard, so default OFF / pass^k-gated. */
  urlNotFetchedShortAnswerGuard: z.boolean().default(false),
  /** #6 (citation-honesty tightening): hadRealResearch counts SESSION-scoped shared facts, so a prior
   *  turn's evidence blanket-passes THIS turn's fabricated URL citations. When true, the citation-strip
   *  decision requires TURN-scoped research (delegation / successful workflow / direct web tool /
   *  share_finding THIS turn) — a stale session fact no longer authorises this turn's links. Structural.
   *  Modifies the ENABLED citationHonestyGuard (can strip more), so default OFF / pass^k-gated. */
  citationTurnScopedResearch: z.boolean().default(false),
  /** #8 (evidence-anchoring tightening): looksEvidenceAnchored's condition-1 bar is min(3, anchors) —
   *  a long draft sharing only 3 generic tokens with the evidence is judged "anchored" even if it is
   *  mostly fabricated prose reusing a few evidence nouns. When true, scale the required shared-token
   *  count with draft length (3 + floor(len/1500)) so "demonstrably used the evidence" is proportional
   *  to answer size. Purely structural (no keyword table). Feeds the enabled failedResearchHonestyBackstop
   *  (can trigger more re-synthesis), so default OFF / pass^k-gated. */
  evidenceAnchoringLengthScaled: z.boolean().default(false),
  /** S1 of staged orchestration (docs/staged-orchestration.md): when true, the
   *  TERMINAL forced-synthesis call (forceSynthesis — invoked with no tools, so it
   *  cannot route or delegate) uses a compact synthesis-only system prompt
   *  (identity + language + format + grounding/full-coverage/no-truncation rules)
   *  instead of the full ~24.7K orchestrator prompt, cutting that call's prefill on
   *  slow local models. Default OFF until pass^k confirms synthesis quality is
   *  unchanged; flip per-session via effort or globally once validated. */
  leanSynthesisPrompt: z.boolean().default(false),
  /** Final stage of staged orchestration (docs/staged-orchestration.md): when true,
   *  after all existing correctness gates have refined the answer, a bounded QA
   *  delivery loop verifies the FINAL answer against the turn plan's acceptance
   *  criteria and — if a criterion is unmet — hands the concrete flaws back for one
   *  improvement pass, repeating until the QA check passes or qaDeliveryLoopMaxRounds
   *  is reached (then the best answer so far ships). Generalises the one-shot
   *  riskGatedQA verify-and-repair into the "loop back until the QA agent says it's
   *  fine" gate the user asked for. Only fires when a plan with acceptance criteria
   *  exists and the answer is substantial, so chat/plan-less turns pay nothing. Fails
   *  OPEN (no criteria, a thrown check, or an empty improvement ships the current
   *  answer — never blocks delivery). Each round costs extra LLM calls on a slow local
   *  model, so default OFF until pass^k confirms the quality lift is worth the latency. */
  qaDeliveryLoop: z.boolean().default(false),
  /** Max improvement rounds for the QA delivery loop (each round = one check + one
   *  improve call). Bounded low because every round is extra slow-model latency. */
  qaDeliveryLoopMaxRounds: z.number().int().min(1).max(4).default(2),
  /** When true, the QA delivery loop escalates to the COORDINATOR after a cheap
   *  re-synthesis round has already failed the re-check — handing the flaws back to
   *  mission_coordinator to make a plan and do NEW work (re-research / re-build),
   *  the user's "send it back to the coordinator to make a plan to improve … until
   *  the qa-agent says it's fine" step. The trigger is structural (a rewrite didn't
   *  move the verdict), not topic-based. Still bounded by qaDeliveryLoopMaxRounds and
   *  fails open. Default OFF: a coordinator delegation is a full extra sub-agent run,
   *  so it stays gated until pass^k shows the quality lift beats the latency. Requires
   *  qaDeliveryLoop. */
  qaDeliveryLoopEscalateToCoordinator: z.boolean().default(false),
  /** Evidence-demanding reviewer prompt for the QA delivery gate. The parser always marks bare or
   *  malformed reviewer output UNVERIFIED; when this is true, the prompt additionally requires a
   *  concrete tool-result/artifact ground for PASS. Delivery still fails open, but only an
   *  evidence-backed PASS can be presented as QA-confirmed. Default OFF because it changes the
   *  reviewer prompt and should be pass^k-evaluated before broad activation. Requires qaDeliveryLoop. */
  qaEvidenceRequired: z.boolean().default(false),
  /** Strict tri-state QA surfacing (QPR-002). The verdict parser ALWAYS computes the tri-state
   *  truth (pass/fail/unverified — bare or malformed reviewer output is never a verified pass);
   *  this flag controls whether that truth reaches the DELIVERY: when true, an unverified verdict
   *  ships with an explicit unverified caveat instead of being presented as QA-passed. When false
   *  (legacy), delivery behaves as before the tri-state contract (bare PASS ships uncaveated) while
   *  the scorecard still records the truthful status. Default OFF per the rollout policy — enable
   *  per deployment once its pass^5 baseline is committed (see eval/baselines/). Requires qaDeliveryLoop. */
  qaStrictVerdicts: z.boolean().default(false),
  /** Deterministic artifact probes before the QA verdict (QA-304): parse JSON,
   *  structurally check HTML (truncation/unclosed tags), hash every artifact,
   *  health-check served URLs — all WITHOUT a model call. A failing probe is an
   *  objective FAIL with reproducible receipts; passing receipts ground the
   *  verdict. Default OFF per rollout policy; requires qaDeliveryLoop. */
  qaDeterministicProbes: z.boolean().default(false),
  /** Verify EVERY artifact the turn produced, triggered by an artifact existing rather
   *  than by a plan existing. The qaDeterministicProbes above only run inside the QA
   *  delivery gate, which is a no-op without a plan carrying acceptance criteria — so
   *  the most ordinary artifact turn ("update my CV and give me a PDF") shipped its
   *  file completely unchecked. This gate opens each file and validates it against the
   *  format its extension claims (see artifact-validators.ts), then caveats anything
   *  broken or uncheckable. Deterministic and model-free, so it is default-ON: there is
   *  no tuned prompt to regress, and the alternative is shipping corrupt files silently. */
  verifyArtifacts: z.boolean().default(true),
  /** On a verification FAILURE, delegate a bounded rebuild instead of only caveating.
   *  Costs a real sub-agent run per failing turn, which is why the schema default is OFF
   *  per rollout policy — enable per deployment. Without it the gate still detects and
   *  reports the breakage, it just does not try to fix it. Requires verifyArtifacts. */
  verifyArtifactsRepair: z.boolean().default(false),
  /** How many rebuild delegations a single turn may spend on broken artifacts. Each is a
   *  fresh sub-agent run, so per-run write caps reset and cannot deadlock the retry. */
  verifyArtifactsMaxRepairAttempts: z.number().int().min(1).max(3).default(1),
  /** Tool-equipped, clean-context QA judge (slice 2 of the evidence work). When the delivery
   *  gate runs on a turn that produced inspectable artifacts (files / served URLs), the verdict
   *  comes from a FRESH-context sub-agent holding read-only inspection tools (read_file,
   *  verify_app, url_inspect) that must OPEN each artifact before judging — instead of a bare
   *  model call rating the answer's prose (which certifies truncated apps and dead URLs on
   *  confident narration). Uses the qaEvidenceRequired verdict contract; falls back to the
   *  prose check on any error and never blocks delivery. Default OFF (adds one bounded
   *  sub-agent run per QA'd artifact turn on the slow local stack); pass^k before default-on.
   *  Requires qaDeliveryLoop. */
  qaToolJudge: z.boolean().default(false),
  /** Deliverable self-consistency gate (audit 17f53ed0). The acceptance-criteria QA gates
   *  (riskGatedQA / qaDeliveryLoop) only run on plan-bearing turns and check GROUNDING +
   *  criteria coverage — neither checks whether the deliverable's OWN figures and arithmetic
   *  cohere. A single research delegation that synthesizes a deliverable records no plan, so
   *  a self-contradictory answer ships unchecked (a price quote recommending 10k for ~10
   *  weeks while itself stating a 90–120 €/h market rate ≈ 37 €/h — the user corrected it 3×).
   *  When true, a substantive deliverable the acceptance-criteria gates did NOT cover gets one
   *  bounded consistency check: do its own numbers/arithmetic agree, and do they contradict
   *  any figure/constraint the user explicitly stated? Concrete contradictions → a bounded
   *  fix-only repair. Structural trigger (length + no acceptance-criteria QA ran), not
   *  topic/keywords; fails OPEN. Default OFF — it adds one synthesis-tier check call per
   *  substantive plan-less turn on the slow local model, so it stays gated until pass^k. */
  deliverableConsistencyQa: z.boolean().default(false),
  /** Max consistency repair rounds (each = one check + one fix call). Low — a consistency
   *  fix is usually one shot, and every round is extra slow-model latency. */
  deliverableConsistencyQaMaxRounds: z.number().int().min(1).max(3).default(1),
  /** When true, the one bounded corrective build RESUMES a partial deliverable instead
   *  of regenerating it. If an earlier build attempt THIS turn left a file that genuinely
   *  looks cut off mid-document (artifactFileLooksTruncated: HTML missing </html>, JSON that
   *  won't parse), the corrective build is told to read that file and FINISH it in place via
   *  write_file mode:"append" / edit_file — adding only the missing remainder — rather than
   *  re-emitting the whole thing (which wastes the work already on disk and risks the same
   *  cut-off). Trigger is structural file-incompleteness, not the deliverable's topic; a
   *  complete-but-wrong file still gets a fresh rebuild. Default OFF until live eval confirms
   *  the resume reliably terminates the document. Requires finalResponseQaGate. */
  resumePartialOnCorrectiveBuild: z.boolean().default(false),
  /** write_file within-turn regeneration nudge (filesystem.ts). When a builder hits the
   *  completion-token limit mid-write it often RE-EMITS the whole file from the top via
   *  mode:"overwrite" instead of appending the remainder (run 663ac153: a ~21-item block
   *  re-emitted 3× — ~58k tokens / ~636s wasted). When true, write_file tracks per-turn
   *  per-path overwrites (ToolContext._turnWriteChurnTracker); on the 2nd+ overwrite of an
   *  existing ≥500-byte file whose new content shares a ≥90% prefix at near-identical size
   *  (structural regeneration signal — no content/topic heuristics), it appends a SOFT nudge
   *  to the tool output suggesting mode:"append" for incremental builds. Never blocks or
   *  fails a write (work is never lost); the size/prefix gates keep legitimate full rewrites
   *  clear. Default OFF until pass^k confirms no false nudges. */
  detectWriteChurnOverwrite: z.boolean().default(false),
  /** Staged artifact builds — MECHANICAL half (sub-agent.ts). A write-capable specialist
   *  handed a whole-artifact spec tries to emit the whole artifact in ONE completion, which
   *  does not land on this hardware: a live probe against the serving model showed a 46-char
   *  task reasoning 109 chars and calling its tool in ~4 s, while a 2,400-char 8-group build
   *  spec produced 60,385 chars of reasoning, ZERO tool calls, and was guillotined by the
   *  provider stream cap (run f08195d2 — 20,129 completion tokens, resultLength 37). Thinking
   *  cannot be disabled on this endpoint (every documented switch measured inert) and
   *  tool_choice:"required" makes it worse, so the only controlling variable is TASK SIZE IN
   *  ONE COMPLETION. When true, the runner classifies such runs structurally (agent holds BOTH
   *  write_file and edit_file AND the task exceeds STAGED_BUILD_TASK_CHAR_THRESHOLD — capability
   *  + size only, never topic words), emits a staged_artifact_build_detected audit record, and
   *  reports the files a cut-off build actually left on disk in its partial output instead of
   *  discarding them. Purely additive: no prompt text, no routing, no tool-list change — so it
   *  ships default ON. The prompt half is a separate flag below. */
  stagedArtifactBuilds: z.boolean().default(true),
  /** Staged artifact builds — PROMPT half (sub-agent.ts system-prompt assembly). When true, a
   *  run classified by `stagedArtifactBuilds` above also receives a staged-build directive in
   *  its system prompt at iteration 0: pass 0 writes a minimal but VALID skeleton with a unique
   *  anchor comment per stub via write_file, each later pass fills exactly ONE stub via
   *  edit_file against that anchor, and a final read_file verifies the artifact closes. Names
   *  only capabilities that exist (write_file overwrite/append, edit_file's exact unique-match
   *  replacement, read_file, grep_files) — there is no range/line patch tool. This CHANGES
   *  TUNED PROMPT TEXT, so it is pass^k-eval-gated and defaults OFF; it is inert unless
   *  stagedArtifactBuilds is also true. */
  stagedArtifactBuildDirective: z.boolean().default(false),
  /** Cross-agent artifact-reuse directive (sub-agent.ts formatArtifactReferencesForSharedContext).
   *  Artifacts a sub-agent produces this turn are already surfaced to LATER delegated agents inside
   *  the shared partial-results context, but as a PASSIVE "Artifacts generated by this result" list —
   *  so agents re-AUTHOR the same content instead of reusing it (run 663ac153: ~50 questions written
   *  3× across agents). When true, that list becomes an explicit directive — "READ (read_file) and
   *  REUSE/EXTEND these instead of re-authoring" — turning the already-surfaced artifact registry into
   *  an actionable reuse instruction. Structural (artifact paths), no topic/keyword tables; advisory
   *  only (an agent may still author a genuinely new variant). Default OFF until pass^k eval. */
  crossAgentArtifactReuse: z.boolean().default(false),
  /** run_task_graph failure visibility for the honesty backstop (runtime.ts
   *  classifyPostOrchestrationDisposition). A task graph that returns failed/blocked nodes emits
   *  "Task graph finished with incomplete status" and carries {completed,failed,blocked} metadata —
   *  but the classifier only matched the success string "Task graph completed", so a FAILED graph was
   *  invisible (disposition → none) and the failed-research honesty backstop never armed; the turn
   *  then synthesized a confident from-memory answer as if the research had succeeded (run e3cf6c22).
   *  When true, the classifier recognizes an incomplete graph and, when any node failed or was blocked,
   *  classifies the turn as a delegation failure so the backstop re-anchors / adds the honest note.
   *  Structural (metadata arrays + harness status string, no topic/keywords). Default OFF until pass^k
   *  eval confirms it doesn't over-fire on graphs that failed only a non-essential node. */
  taskGraphFailureDisposition: z.boolean().default(false),
  /** Durable task-graph node reuse (swarm/task-graph-ledger.ts). run_task_graph node state is
   *  in-memory only, so a turn that dies mid-graph loses every COMPLETED node and a retry re-runs
   *  the whole graph — including expensive research/build nodes that already succeeded. When true,
   *  each completed node's distilled result + artifact refs are recorded in a per-session ledger
   *  (Redis slot, session TTL) keyed by a structural node hash (id + task text + sorted deps); a
   *  re-issued graph satisfies hash-matching nodes from the ledger without re-executing them
   *  (strictly conservative — reuse can only SKIP re-execution, never double-fire a side-effectful
   *  node; a re-plan that changes a node's task text invalidates its entry naturally). Downstream
   *  context still flows from the original run's shared facts. Default OFF until pass^k eval
   *  (behavioral: a retried graph now reuses prior results instead of re-running). */
  durableTaskGraph: z.boolean().default(false),
  /** Clamp a sub-agent's turn timeout to the PARENT turn's remaining budget (sub-agent.ts). A leaf
   *  agent's timeout derives from its own config / the gateway timeout, ignoring how much of the parent
   *  turn is left — so a researcher was handed 600s under a 120s low-effort turn, planned for 10 min,
   *  and was then guillotined with nothing usable (run e3cf6c22). When true, a delegated sub-agent's
   *  hard timeout (and soft wrap-up deadline) is capped at max(floor, parentDeadline − now), threaded as
   *  an absolute epoch-ms deadline (ToolContext._turnDeadlineMs) that propagates through nested
   *  delegations. A clamp can only REDUCE a timeout, so the sub-agent starts wrapping up in time to
   *  deliver a usable partial. Unbounded (0) budgets are left alone. Default OFF until pass^k eval. */
  clampSubAgentTimeoutToParent: z.boolean().default(false),
  /** Exclude delegation-WAIT time from the parent turn's budget (runtime.ts + gateway/rpc.ts). The
   *  turn timeout is meant to bound the ORCHESTRATOR's own work — but it was a flat wall-clock that
   *  also counted the time the parent sat BLOCKED awaiting a delegated child, so a turn timed out
   *  because its children did legitimate work (run e3cf6c22: a 120s turn spent ~48s just waiting for
   *  researchers). When true, each delegation tool's blocked duration pushes BOTH timeout layers'
   *  deadlines out (the runtime abort AND the gateway hard timeout), so the tier budget measures the
   *  parent's own active time; children are bounded by their own effort-scaled budgets. Never past an
   *  absolute wall-clock ceiling (a hung/unbound child can't run forever); max effort (no base
   *  timeout) is unaffected. Default ON — the correct orchestration timing model; flip false to revert
   *  to the flat wall-clock. */
  excludeDelegationWaitFromTurnBudget: z.boolean().default(true),
  /** Max-effort turn oversight (turn-oversight.ts). At `max` effort agents run unbounded
   *  and the final-QA gate + never-empty watchdog are OFF, so a turn that keeps
   *  re-delegating a dying build can churn for minutes and deliver nothing. When true, a
   *  structural progress check samples the WHOLE turn each window; if it is churning or
   *  stalled, a small bounded oversight-agent judge decides on_track | redirect | stuck
   *  and the runtime injects ONE corrective directive so the turn re-plans (e.g. resume a
   *  truncated partial via append instead of regenerating). If a redirect was already
   *  tried and the turn is STILL not progressing, the runtime forces the best-available
   *  delivery so max ALWAYS finishes (the never-empty floor). Fail-open: any judge error
   *  resolves to on_track. Only fires at `max` effort. Default OFF until live eval on the
   *  user's stack confirms the oversight rescues stuck turns without derailing healthy
   *  long runs. */
  maxEffortTurnOversight: z.boolean().default(false),
  /** Per-delegation language normalization (delegation-language.ts): "work internally in
   *  English; deliver in the user's language." When true, a delegated TASK in another
   *  language is translated to English (one bounded routing-tier call) before routing +
   *  running the sub-agent, with an output-language directive appended so the deliverable
   *  still comes back in the user's language. Makes routing/tool-arg matching language-
   *  independent (the agent catalog is English-only) without bilingual keyword regexes.
   *  The `context` evidence block is left verbatim (citation fidelity). Fail-open: any
   *  translation error leaves the task unchanged. Default OFF — it adds one LLM hop per
   *  non-English delegation on the shared GPU, so it stays gated until live eval shows the
   *  routing/quality lift beats the latency. */
  normalizeDelegationToEnglish: z.boolean().default(false),
  /** Reuse-don't-re-research (audit 17f53ed0): a follow-up that REFINES a deliverable
   *  already produced this session ("make a proper offer", "tighten it up") otherwise
   *  makes the orchestrator re-run the FULL research mission whose evidence is still
   *  sitting in the conversation — a 15-minute web re-fetch in the audit. When true, a
   *  turn that (a) already has substantial delegated evidence in this session's history
   *  and (b) introduces no new URL to fetch gets a lean one-line nudge to reuse that
   *  evidence and refine from it, delegating fresh research ONLY for facts the existing
   *  evidence does not cover. Structural trigger (prior-evidence-exists + no-new-URL),
   *  not a keyword regex; a soft nudge with an explicit escape clause, so the model still
   *  researches when the request genuinely needs new external facts. Default OFF until
   *  live eval confirms it cuts the redundant-research latency without starving
   *  genuinely-new follow-ups. */
  reuseSessionEvidenceOnRefinement: z.boolean().default(false),
  /** Honesty floor for source-sensitive synthesis on PARTIAL evidence. When the
   *  research delegation for a source-sensitive turn came back partial / cancelled /
   *  below the substance floor, the normal "[SYNTHESIS REQUIRED] … copy the exact
   *  names and numbers from the evidence" directive OVERSELLS the thin evidence and
   *  the model fills the gaps from training data — fabricating specifics (specs,
   *  interfaces, ratings, part numbers) and presenting them as confirmed (audit
   *  0dc158ad: claimed an analog MEMS mic has an I2S interface). When true, that turn
   *  instead gets an honesty directive: assert a concrete fact only if it is verbatim
   *  in the evidence, mark everything else UNVERIFIED, never invent a value. Trigger is
   *  PURELY STRUCTURAL — real orchestration ran this turn AND it came back junk/partial
   *  (findRecentJunkDelegationResult, delegation-outcome metadata; no keyword table) — and
   *  only fires on the failure condition, so it cannot regress a good-evidence turn. The
   *  de-lex hardwired the old sourceSensitive gate off, killing this guard; restored here
   *  structurally. Default OFF (it was dead — flipped from a now-meaningless default-on) —
   *  it changes the synthesis directive, so pass^k-gated like the sibling honesty guards. */
  honestSynthesisOnPartialEvidence: z.boolean().default(false),
  /** Discovery prefetch (staged orchestration S4 — docs/staged-orchestration.md):
   *  when true, an escalated turn (one the receptionist fast-lane declined) runs
   *  agent discovery + workflow discovery CONCURRENTLY up-front and injects a compact,
   *  droppable "[CAPABILITY CANDIDATES]" capsule into the coordinator's first call —
   *  so it can plan without first spending one or more slow orchestrator search_agents
   *  / search_workflows tool rounds. The capsule is a soft head start, not a hard gate
   *  (the model may still search for something more specific). Costs one up-front
   *  embedding round-trip + a few hundred prompt tokens per escalated turn, so it only
   *  pays off when it actually removes a slower discovery round. Default OFF until
   *  pass^k confirms a net latency/quality win. */
  discoveryPrefetch: z.boolean().default(false),
  /** Proactive user-profile prefetch. When true, an iteration-0 turn that the classifier
   *  flagged userOwnFacts (a question about the user's OWN background/skills/experience/
   *  fit) AND that has no durable memory capsule runs a BOUNDED, concurrent best-effort
   *  retrieval over the user's memory records + attached documents (an uploaded CV/profile),
   *  and injects either a "[USER PROFILE EVIDENCE]" block or an authoritative confirmed-empty
   *  marker — so the model answers from a REAL lookup result instead of fabricating or
   *  admitting blindly (the toolCalls=0 "I have no info about you" failure). Fires ONLY on the
   *  narrow self-referential class, so trivial/general turns pay zero added latency; a hard
   *  latency cap degrades to the confirmed-empty marker if the embed backend is slow. Default
   *  OFF until pass^k confirms no regression. */
  userProfilePrefetch: z.boolean().default(false),
  /** QUORUM EARLY-SYNTHESIS (vLLM "ReMoM"). When true, parallel_delegate stops blocking on
   *  the slowest slice: once a quorum of SUCCESSFUL slices has returned (ceil(quorumFraction *
   *  N)), the remaining stragglers get a short grace window and are then ABORTED, and synthesis
   *  proceeds on the quorum. Partial evidence the stragglers already published via share_finding
   *  is preserved. If fewer than the quorum succeed, it waits for all (no premature abandon).
   *  Default OFF restores today's Promise.all (wait-for-all) exactly; pass^k before default-on. */
  quorumEarlySynthesis: z.boolean().default(false),
  /** Fraction of dispatched slices that must SUCCEED to form the quorum (K = ceil(fraction*N)).
   *  Only consulted when quorumEarlySynthesis is on. 0.6 → 2-of-3, 3-of-5. */
  quorumFraction: z.number().min(0.34).max(1).default(0.6),
  /** Grace window (ms) granted to in-flight stragglers AFTER the quorum is reached before they
   *  are aborted. Only consulted when quorumEarlySynthesis is on. */
  quorumStragglerGraceMs: z.number().int().min(0).max(120_000).default(8_000),
  /** DISAGREEMENT-AS-SIGNAL (vLLM "Fusion"). When true, after a parallel fan-out in which ≥2
   *  slices succeeded, a cheap routing-tier classifier checks whether their outputs CONFLICT;
   *  on disagreement it prepends a "[SUB-AGENT DISAGREEMENT]" marker (+ metadata flag) to the
   *  aggregated result so the orchestrator reconciles/verifies in synthesis instead of silently
   *  averaging conflicting answers. No-op (no added latency) when the slices agree. Default OFF
   *  until pass^k confirms the check is worth its one extra routing-tier call. */
  subAgentDisagreementVerify: z.boolean().default(false),
  /** B24 — toolset size ABOVE which the per-turn tool-rerank embedding kicks in. A small
   *  toolset doesn't need semantic reranking (all tools fit the model's attention), so we
   *  skip the embedding round-trip for it. Default 6 preserves the long-standing hardcoded
   *  threshold; raise it (e.g. 12) to skip the rerank embed for more agents, trading rerank
   *  coverage for one fewer embed round-trip per delegated turn. Behaviour-preserving at the
   *  default, so the higher values are the eval-gated knob. */
  toolRerankMinTools: z.number().int().min(1).default(6),
  /** Synthesis-headroom reserve (ms) carved out of the parent turn budget when a
   *  delegated sub-agent inherits that budget as its OWN hard timeout. A sub-agent's
   *  timeout is currently the FULL parent budget, so one slow node can consume 100% of
   *  the turn and leave the orchestrator zero time to synthesize+deliver — the gateway
   *  watchdog then archives the session and returns an error instead of the answer
   *  (audit b6f8336e: a 19.6-min research graph ate a 20-min turn; the finished answer
   *  was dropped). When > 0, a sub-agent gets at most (parentBudget − reserve) (floored
   *  at 60 s), guaranteeing the parent keeps `reserve` ms to finalize. Default 0 =
   *  identity (today's behavior); set e.g. 90000 to reserve a 90 s synthesis margin. */
  subAgentSynthesisReserveMs: z.number().int().min(0).max(600_000).default(0),
  /** Opt-in semantic layer of the max-effort progress verifier. At max effort a
   *  long-running sub-agent is granted unbounded budget silently (no operator dock);
   *  a STRUCTURAL stall guard (no new tokens AND no new tool calls across windows)
   *  always watches it. When this is true, an additional bounded LLM judge also reads
   *  the objective + recent activity each window and winds the run down if it is
   *  "drifting" (busy but working toward the wrong goal) — the part structure can't
   *  see. Default false: the judge is an LLM-behavior change that contends for the
   *  local GPU, so it stays gated until eval'd on a live stack (pass^k). */
  progressVerifierSemantic: z.boolean().default(false),
  /** When true, a source-sensitive turn where the model refuses to delegate (answers
   *  tool-free from training data even after the delegation nudge) does NOT ship the
   *  unverified draft — the runtime auto-runs ONE research delegation and synthesizes
   *  from the gathered findings, falling back to the caveated draft only if that yields
   *  nothing. Enforces the source-sensitive correctness invariant without dead-ending.
   *  Costs one research delegation on the refusal path. */
  autoResearchOnRefusal: z.boolean().default(true),
  /** When true, before a sub-agent auto-shares a large tool result, a one-shot
   *  distillation pass is given the agent's OBJECTIVE plus the raw found content and
   *  extracts only the objective-relevant facts/figures/URLs — instead of storing the
   *  heuristic extract verbatim. This keeps shared findings dense and shrinks the
   *  context the final synthesis must read (audit 003f5aeb: raw scraped page chrome
   *  was filling shared facts and leaking into answers). Skipped for small/clean
   *  findings (under distillSharedFactsMinChars); on any distillation failure the
   *  heuristic extract is kept (never drops evidence).
   *  Curate for QUALITY, not budget: skipping distillation does not save compute, it
   *  DEFERS and amplifies it — every uncurated finding (raw page chrome included) bloats
   *  the shared-facts context that the build/synthesis step and every later
   *  read_shared_facts must process (audit 65f46046: an uncurated 28KB / ~117K-token
   *  build prompt that a per-finding distill would have shrunk). A small objective-scoped
   *  distill up-front is a net compute WIN. Default on. */
  distillSharedFacts: z.boolean().default(true),
  /** Only auto-share findings whose heuristic extract is at least this many chars are
   *  routed through the distillation pass; shorter findings are already compact (and
   *  pure chrome is caught by the low-value gate), so they are stored as-is. Built-in
   *  default: 200. */
  distillSharedFactsMinChars: z.number().int().min(120).max(4000).default(200),
  /** Safety ceiling on distillation passes per sub-agent run — NOT a compute-saving
   *  budget (uncurated findings cost more downstream than the distill call saves, so we
   *  curate every eligible web finding). Set high enough to cover a research-heavy run;
   *  beyond it, extra findings fall back to the heuristic extract. Built-in default: 100. */
  distillSharedFactsMaxPerRun: z.number().int().min(1).max(500).default(100),
  /** When true, a source-sensitive turn whose ORIGINAL request asked to create a concrete
   *  artifact (file/website/presentation/document/report) and that gathered curated
   *  findings but never produced the artifact (research alone consumed the turn on a slow
   *  backend) auto-runs ONE content_writer build from the gathered facts before shipping —
   *  so the deliverable lands in the same turn instead of dead-ending at a "research done,
   *  confirm to build" message. Mirrors autoResearchOnRefusal. Costs one build delegation
   *  on that path (the turn runs longer: research + build). Falls back to the honest
   *  research-gathered message if the build produces nothing. Default on. */
  autoBuildAfterResearch: z.boolean().default(true),
  /** When true, while a turn still MUST orchestrate (source-sensitive / required-research
   *  / required-artifact / workflow) and has NOT yet delegated, the runtime forces the
   *  model to emit a tool call (tool_choice="required") instead of letting it spend minutes
   *  drafting a tool-free prose answer that the guardrail then rejects and re-runs (audit
   *  5d51862f: ~2 min wasted on a discarded draft before delegation). Released automatically
   *  once a delegation/workflow has run so the model can synthesize, and only forces before
   *  the routing-nudge fallback. Default on. */
  forceToolChoiceWhenOrchestrationRequired: z.boolean().default(true),
  /** When true, a turn whose ONLY orchestration was a single successful delegation that
   *  returned a complete, presentable deliverable surfaces that deliverable directly instead
   *  of running a SECOND full synthesis pass over it on the main assistant — which on the slow
   *  local model doubles turn latency and sometimes diverges from the specialist's conclusion
   *  (audit 5d51862f: coordinator picked ESP32-C61, the re-synthesized answer shipped a
   *  different MCU). Only fires for exactly one successful long-deliverable delegation whose
   *  evidence is clean (not a raw dump); multi-delegation turns still synthesize. Default on. */
  relaySingleDeliverable: z.boolean().default(true),
  /** When true, a message the user sends WHILE a turn is running is folded into
   *  that turn as steering at the next tool-loop iteration (instead of only being
   *  able to Stop). The runtime drains a per-turn queue before each model call and
   *  appends it as an authoritative user message. Default on; opt-out disables the
   *  drain so such messages are ignored mid-turn. */
  midTurnSteering: z.boolean().default(true),
  /** When true, a high-stakes or wide plan pauses for human approval in the
   *  operator dock before the orchestrator executes it. Off by default until the
   *  dock plan card is confirmed end-to-end. */
  planApproval: z.boolean().default(false),
  /** Durable human-approval DECISION cache (async channels only). Every HITL approval is
   *  normally an in-memory Promise resolver, so a gateway restart (deploy/reboot) while a
   *  slack/webhook approval is outstanding auto-denies and the scene worker re-prompts on
   *  the step re-run. When true, a scene/job approval routed through an async channel
   *  (slack / outbound_webhook) that is DECIDED before a restart has its decision cached to
   *  the on-disk state dir, keyed by a stable idempotency key (job + step + tool + args) —
   *  and ONLY the boolean decision: no pending record, channel secret, or callback token
   *  ever touches disk. After a restart, the step re-run reuses that pre-restart decision
   *  exactly ONCE instead of re-prompting; a second identical gated call re-prompts. What
   *  this does NOT do: a callback that arrives AFTER a restart is lost (its pending id is
   *  gone) and the re-run re-prompts — decisions are only honoured if they were made before
   *  the restart. Bounded + fail-closed: an unanswered request still auto-denies at its
   *  timeout, denials/timeouts are never cached, and a cached decision expires (24h).
   *  Trivial webchat (ask_user) approvals keep the cheap in-memory await, unchanged.
   *  Default OFF — behavioural, opt-in. */
  durableApprovals: z.boolean().default(false),
  /** Per-call caps for regular researcher sub-agents.
   *  Keys are tool names; values override the built-in defaults.
   *  Built-in: web_search=14, web_fetch=16, write_file=3, … */
  subAgentToolCaps: z.record(z.string(), z.number().int().min(1).max(500)).default({}),
  /** Per-call caps specifically for the mission_coordinator sub-agent.
   *  Coordinator overrides layer on top of subAgentToolCaps overrides.
   *  Built-in: delegate_to_agent=6, swarm_delegate=6, web_search=20, web_fetch=25. */
  coordinatorToolCaps: z.record(z.string(), z.number().int().min(1).max(500)).default({}),
  /** Per-turn caps for the main orchestrator agent (not sub-agents).
   *  Built-in: delegate_to_agent=5, computer_click=8, computer_type=6, … */
  perTurnCaps: z.record(z.string(), z.number().int().min(1).max(500)).default({}),
});
export type OrchestrationConfig = z.infer<typeof OrchestrationSchema>;
