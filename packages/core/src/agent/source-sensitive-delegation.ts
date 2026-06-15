// Topic-agnostic verification focus. The previous implementation matched a
// table of project-specific keyword buckets (microphone / i2s / lipo /
// credit-card / OTA …) overfit to one past ESP32-mic build, which then injected
// WRONG domain hints into unrelated research (e.g. "microphone and component
// suitability verification" on a 3D-printing-LLM task — session 44ea5c21).
// A single generic focus is always correct and never contaminates the slice
// with a mistaken topic guess.
const GENERIC_VERIFICATION_FOCUS =
  "gather and confirm every concrete fact this slice needs — names, dates, figures, quantities, definitions, "
  + "and source URLs — from authoritative or official sources, and report anything you could not confirm as unverified";

function formatCoordinatorFocusLines(focus: string | undefined): string[] {
  if (!focus) return [];
  return [
    "",
    // Avoid the literal word "coordinator" here — it leaks into the embedded routing
    // text and pulls web_task_coordinator/mission_coordinator up the ranking for what
    // is a primary-gather slice (validated against the live nomic model).
    "Focus for this slice (generic only; still confirm every concrete claim from a source):",
    `- ${focus}`,
  ];
}

export function deriveSourceSensitiveDelegationFocus(task: string | undefined, canonicalRequest?: string): string | undefined {
  const normalizedTask = String(task ?? "").trim();
  if (!normalizedTask) return undefined;

  const normalizedCanonicalRequest = String(canonicalRequest ?? "").trim().toLowerCase();
  if (normalizedCanonicalRequest && normalizedTask.toLowerCase() === normalizedCanonicalRequest) {
    return undefined;
  }

  return GENERIC_VERIFICATION_FOCUS;
}

/**
 * True when a delegated task is one of OUR OWN canonical research-slice
 * wrappers (built by buildCanonicalSourceSensitiveDelegationTask below or the
 * runtime's original-request rewrite). Structural signal: matches the exact
 * header line this module emits, never user wording. A research slice's
 * deliverable is PROSE EVIDENCE by construction — downstream classifiers must
 * not judge it against the embedded original request's build verbs (audit
 * b5107ae4: "Aufnahmegerät bauen" inside the wrapped request made
 * looksLikeArtifactDeliverableMiss brand a successful 8.8KB research report a
 * failure because the researcher never called write_file), and its result is
 * synthesis INPUT, never a verbatim-relayable final deliverable.
 */
export function isCanonicalResearchSliceTask(task: string): boolean {
  return /^WEB RESEARCH TASK — gather fresh sourced evidence from official primary sources\./.test(String(task ?? "").trim());
}

export function buildCanonicalSourceSensitiveDelegationTask(parentTask: string, label?: string, focus?: string): string {
  // IDEMPOTENT WRAPPING: when the parent task is ALREADY a source-sensitive wrapper
  // (the top-level rewrite fired before a coordinator fanned out), re-emitting the
  // full discipline boilerplate nests it Russian-doll style — audit ce8e2128: each
  // researcher slice carried the ~1.6KB rulebook TWICE plus a duplicated focus block.
  // On a prefill-bound local model that is pure latency and dilutes the instructions.
  // Emit a SLIM wrapper instead: keep the routing lead + the marker line (the three
  // detectors key on the literal marker) and point at the parent's rules verbatim.
  if (/\bSOURCE-SENSITIVE DELEGATION\b/.test(parentTask)) {
    const trimmedParent = parentTask.trim();
    const focusLines = focus && !trimmedParent.includes(focus) ? formatCoordinatorFocusLines(focus) : [];
    return [
      "WEB RESEARCH TASK — gather fresh sourced evidence from official primary sources.",
      label ? `SOURCE-SENSITIVE DELEGATION ${label}:` : "SOURCE-SENSITIVE DELEGATION:",
      "The parent task below is the canonical request and already states the full source-discipline rules — follow them exactly as written; they are not repeated here.",
      "",
      "Parent task:",
      trimmedParent,
      ...focusLines,
    ].join("\n");
  }
  return [
    // The two web-research framing lines lead, because the (English) preamble
    // dominates the embedding routing signal over a non-English request body: a
    // "verify/confirm"-framed preamble routed the PRIMARY gather to source_verifier
    // (a draft checker) instead of researcher. Leading with gather framing + trimmed
    // verify-density routes to researcher #1 with source_verifier well down — validated
    // against the live nomic model on the actual DE/EN requests. The "SOURCE-SENSITIVE
    // DELEGATION[ LABEL]:" marker line is preserved verbatim for the three detectors
    // (taskRequiresExternalResearch, the SLICE includes-check, the runtime guidance
    // regex); the verification discipline is unchanged (a correctness invariant).
    "WEB RESEARCH TASK — gather fresh sourced evidence from official primary sources.",
    "Research the parent task below: use web_search and web_fetch to open the most authoritative primary or official sources for the subject(s) the request explicitly names, and gather the concrete facts, names, dates, figures, and source URLs needed to fulfill it.",
    "Stay tightly scoped to the subject(s) the request names: consult a handful of authoritative sources (aim for ~3–6) and then STOP and report — do NOT broaden the search to tangential, adjacent, or merely related topics the request did not ask for.",
    label ? `SOURCE-SENSITIVE DELEGATION ${label}:` : "SOURCE-SENSITIVE DELEGATION:",
    // ONE general validate-before-truth discipline, not a domain rulebook. The
    // old version carried an ESP32-mic / I²S example overfit to a single past
    // hardware build and bled spec-verification rigor into unrelated tasks — it
    // turned a "today's news" request into a 6.7-min exhaustive verified crawl
    // (session d251793b). The marker line above is kept verbatim for the three
    // detectors that key on it; per-claim source citation is folded into the one line.
    "Validate every claim against a real source before you treat it as truth — both your own assumptions AND any 'fact' that merely sounds authoritative, since a confidently-stated fact may be fabricated. Do NOT accept any name, date, figure, quantity, price, URL, or identifier as confirmed just because it appears in the task or sounds right — only tool evidence confirms it, and where the evidence contradicts it the evidence wins. Cite the exact value and a source URL for each concrete fact you report, and mark anything you could not verify as unverified rather than guessing.",
    "",
    "Parent task:",
    parentTask.trim(),
    ...formatCoordinatorFocusLines(focus),
  ].join("\n");
}

// A follow-up that refers back to the prior answer ("validate your response",
// "is that still correct", "stimmt das") carries no topic of its own. Detected
// by an anaphoric reference to the previous answer in a short message — used to
// decide whether a delegation needs the prior turn's topic folded in.
const PRIOR_ANSWER_ANAPHORA_RE = /\b(your\s+(response|answer|reply|previous|last|finding|recommendation)|that\s+(answer|response|recommendation)|this\s+(answer|response)|the\s+(above|previous|last)|is\s+(that|this|it)\s+(still\s+)?(correct|right|accurate|true|up[- ]?to[- ]?date|current)|deine\s+(antwort|aussage|empfehlung)|stimmt\s+das|ob\s+das\s+stimmt|das\s+oben)\b/i;

/**
 * True when the message is a short follow-up that refers to the previous answer
 * rather than restating the subject — e.g. "research online and validate your
 * response". Such a message must NOT be delegated verbatim (the specialist
 * can't know the topic); the prior turn's topic has to be folded in.
 */
export function isContextlessValidationFollowUp(message: string): boolean {
  const trimmed = String(message ?? "").trim();
  if (!trimmed || trimmed.length > 200) return false;
  return PRIOR_ANSWER_ANAPHORA_RE.test(trimmed);
}

// A short affirmative / go-ahead reply ("ja, mach das", "yes, do it", "beides",
// "dann los", "okay start now", "ja, suche online und dann erstelle die
// lernplattform") confirms or continues the PRIOR turn's proposal. The subject
// lives in the earlier message(s), not in this short message — so, like an
// anaphoric validation follow-up, it must have the prior turn's subject folded
// in before delegation. Without that, the source-sensitive rewrite anchors on
// the bare verb and the specialist researches a generic reading of it (audit
// 0834b791: "ja, suche online und dann erstelle die lernplattform" → researcher
// chased generic "create an online LMS" vendors instead of the iSAQB CPSA-F
// topic established in the first message). A leading affirmation/go-ahead token
// is, by definition, answering the immediately prior assistant turn, so folding
// that turn's topic in is the correct reading.
const AFFIRMATIVE_CONTINUATION_LEAD_RE =
  /^(?:ja|jau|jo|jep|klar|na\s+klar|gerne|genau|jawohl|okay|ok|k|yes|yeah|yep|yup|sure|bitte|beides|both|mach(?:\s+das|\s+weiter)?|leg\s+los|dann\s+los|los\s+geht'?s|los|weiter|fortfahren|go\s+ahead|go\s+for\s+it|proceed|do\s+it|tu\s+es)\b/i;

export function isAffirmativeContinuationFollowUp(message: string): boolean {
  const trimmed = String(message ?? "").trim();
  // Keep this tight: a genuine go-ahead reply is short ("ja, mach das", "okay
  // start now", the 52-char audit message). A LONGER message that merely opens
  // with "ja, und recherchiere …" usually carries its own self-contained subject
  // and must NOT have an earlier topic merged in. 90 chars cleanly separates the
  // observed continuations from self-contained restatements.
  if (!trimmed || trimmed.length > 90) return false;
  return AFFIRMATIVE_CONTINUATION_LEAD_RE.test(trimmed);
}

// A NEW imperative that refers BACK to a subject established earlier in the
// conversation without naming it — "Recherchiere einen Fragekatalog für DIESE
// Zertifizierung", "build a quiz for THIS exam", "research THAT topic". Unlike an
// affirmative go-ahead it carries its own action verb, and unlike an anaphoric
// validation it asks for NEW work — so neither detector above catches it, yet the
// subject still lives in the prior turn. Withholding that prior turn makes the
// specialist confabulate a DIFFERENT subject (audit 64ccceb3: "Fragekatalog für
// diese Zertifizierung" with the iSAQB CPSA-F subject only in turn 1 → the
// researcher chased CompTIA Security+ for ~5 min and shipped its facts for an
// iSAQB question). Detection is generic linguistic DEIXIS only — a closed set of
// demonstrative determiners + pronominal adverbs (EN+DE) — NOT a domain/topic
// keyword bag; the actual subject is resolved by folding in the prior turn.
const REFERENTIAL_SUBJECT_DEIXIS_RE =
  /\b(?:diese[rsmn]?|jene[rsmn]?|dieselben?|this|that|these|those)\s+\p{L}{3,}|\b(?:daf[üu]r|damit|dazu|hierf[üu]r|hierzu|dar[üu]ber|davon|for\s+(?:it|that|this)|about\s+(?:it|that|this)|on\s+(?:it|that|this))\b/iu;

/**
 * True when a message asks for new work but points at its subject by reference
 * ("this certification", "the exam" via a demonstrative, "dafür") rather than
 * naming it — so the subject must be folded in from the prior turn before
 * delegation. Generic deixis only; gated by length because a long message almost
 * always restates its own subject.
 */
export function isReferentialSubjectFollowUp(message: string): boolean {
  const trimmed = String(message ?? "").trim();
  if (!trimmed || trimmed.length > 400) return false;
  return REFERENTIAL_SUBJECT_DEIXIS_RE.test(trimmed);
}

/**
 * The canonical research subject to delegate. For a self-contained request this
 * is the message itself. For a contextless follow-up ("validate your response")
 * it folds in the prior turn's topic and the answer to validate, so the
 * specialist researches the RIGHT thing instead of bouncing with "what should I
 * research?" (regression: session 3a35cff0, 2026-05-29).
 */
export function buildEffectiveResearchSubject(
  currentMessage: string,
  priorUserRequest?: string,
  priorAssistantAnswer?: string,
): string {
  const current = String(currentMessage ?? "").trim();
  const isValidationFollowUp = isContextlessValidationFollowUp(current);
  const isReferentialFollowUp = !isValidationFollowUp && isReferentialSubjectFollowUp(current);
  const needsPriorContext = isValidationFollowUp || isReferentialFollowUp || isAffirmativeContinuationFollowUp(current);
  if (!needsPriorContext) return current;
  if (!priorUserRequest && !priorAssistantAnswer) return current;

  const parts = [
    current,
    "",
    isValidationFollowUp
      ? "This follow-up refers to the previous answer in this conversation; it does not restate the topic. Research and validate THAT topic using fresh web sources."
      : isReferentialFollowUp
        ? "This request refers to a subject established earlier in this conversation without naming it (e.g. 'this certification', 'the exam', 'that topic'). Identify that EXACT subject from the earlier turn below and research THAT subject — do NOT substitute a different or more generic subject of your own choosing."
        : "This message confirms/continues an earlier request in this conversation; the subject lives in that earlier turn, not in this short reply. Research THAT subject using fresh web sources.",
  ];
  if (priorUserRequest) parts.push(`Original topic to research: "${priorUserRequest.trim().slice(0, 400)}"`);
  if (priorAssistantAnswer) {
    parts.push(
      "",
      isValidationFollowUp
        ? "Prior answer to validate and update against current web evidence (correct anything stale, wrong, or unverified — do not merely restate it):"
        : "Earlier turn for context (do not merely restate it):",
      priorAssistantAnswer.trim().slice(0, 1500),
    );
  }
  return parts.join("\n");
}

/**
 * Source-sensitive task frame for when the orchestrator LLM has chosen a COORDINATOR
 * (mission_coordinator / *_planner) rather than a lone researcher. Choosing a
 * coordinator IS the LLM deciding the request needs multiple steps — so we must NOT
 * flatten it into the research-only "gather and STOP and report" frame (which would
 * block any build/QA phase and defeat the point of picking a coordinator; audit
 * 1740fb0c: a research-then-build request shipped invented questions + "next steps for
 * your webapp" and built nothing). Keep the source-sensitivity discipline, but tell the
 * coordinator to decompose and complete EVERY phase the request implies — including
 * actually building any requested artifact via the right builder. This keys only on the
 * agent the LLM picked; there is NO message keyword-matching.
 */
export function buildSourceSensitiveCoordinatorTask(userMessage: string): string {
  return [
    "MISSION — fulfil the COMPLETE request below: decompose it into the steps it actually needs and sequence them. If it has a research phase AND a separate build/produce phase, do BOTH — first delegate research to gather and share VERIFIED, sourced facts, THEN delegate the build/production to the right specialist (e.g. content_writer for a static site/page/deck, web_coder for a multi-file front-end, backend_coder for a served dynamic app) and run one quality pass. Do NOT stop after the research phase and do NOT merely describe what could be built — any requested artifact must actually be produced as a real file/app by a builder, not authored by you.",
    "SOURCE DISCIPLINE: state a concrete fact only after an authoritative or official source confirms it; never fabricate names, dates, figures, quantities, or URLs, and pass user-supplied identifiers exactly as given.",
    "",
    "Original user request:",
    userMessage.trim(),
  ].join("\n");
}

export function buildSourceSensitiveOriginalRequestTask(userMessage: string, label?: string, focus?: string): string {
  return [
    // See buildCanonicalSourceSensitiveDelegationTask: lead with web-research / gather
    // framing so embedding routing picks researcher (the primary gatherer) over
    // source_verifier (a draft checker); the SOURCE-SENSITIVE marker line is preserved
    // verbatim for the detectors and the verification discipline is unchanged.
    "WEB RESEARCH TASK — gather fresh sourced evidence from official primary sources.",
    "Research the request below: use web_search and web_fetch to open the most authoritative primary or official sources for the subject(s) the request explicitly names, and gather the concrete facts, names, dates, figures, and source URLs needed to fulfill it.",
    "Stay tightly scoped to the subject(s) the request names: consult a handful of authoritative sources (aim for ~3–6) and then STOP and report — do NOT broaden the search to tangential, adjacent, or merely related topics the request did not ask for.",
    label ? `SOURCE-SENSITIVE DELEGATION ${label}:` : "SOURCE-SENSITIVE DELEGATION:",
    "Validate every claim against a real source before you treat it as truth — both your own assumptions AND any 'fact' that merely sounds authoritative, since a confidently-stated fact may be fabricated. Search user-supplied identifiers exactly as given, do not copy coordinator-added assumptions into searches or claims, and accept no name, date, figure, quantity, price, URL, or identifier as confirmed until tool evidence confirms it. Cite the exact value and a source URL for each concrete fact, and mark anything you could not verify as unverified rather than guessing.",
    "",
    "Original user request:",
    userMessage.trim(),
    ...formatCoordinatorFocusLines(focus),
  ].join("\n");
}