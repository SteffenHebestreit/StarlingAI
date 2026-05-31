// Topic-agnostic verification focus. The previous implementation matched a
// table of project-specific keyword buckets (microphone / i2s / lipo /
// credit-card / OTA …) overfit to one past ESP32-mic build, which then injected
// WRONG domain hints into unrelated research (e.g. "microphone and component
// suitability verification" on a 3D-printing-LLM task — session 44ea5c21).
// A single generic focus is always correct and never contaminates the slice
// with a mistaken topic guess.
const GENERIC_VERIFICATION_FOCUS =
  "gather and confirm every concrete entity in this slice — products, part numbers, vendors/manufacturers, "
  + "interfaces/protocols, specifications, prices, quantities, dates, and URLs — from official or vendor "
  + "sources, and report anything you could not confirm as unverified";

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

export function buildCanonicalSourceSensitiveDelegationTask(parentTask: string, label?: string, focus?: string): string {
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
    "Research the parent task below: use web_search and web_fetch to open official manufacturer, vendor, standards, and datasheet pages and gather the requested specifications, interfaces, datasheet values, prices, and component sourcing.",
    label ? `SOURCE-SENSITIVE DELEGATION ${label}:` : "SOURCE-SENSITIVE DELEGATION:",
    "The parent task below is the canonical request. Search user-supplied identifiers exactly as given; do not treat coordinator-added manufacturer, product, interface, version, quantity, price, date, URL, or specification claims as confirmed unless they appear in this parent task or in completed tool evidence.",
    "State a concrete fact only after an official or vendor source confirms it; if evidence is missing, report uncertainty instead of filling gaps.",
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
  if (!isContextlessValidationFollowUp(current)) return current;
  if (!priorUserRequest && !priorAssistantAnswer) return current;

  const parts = [
    current,
    "",
    "This follow-up refers to the previous answer in this conversation; it does not restate the topic. Research and validate THAT topic using fresh web sources.",
  ];
  if (priorUserRequest) parts.push(`Original topic to research: "${priorUserRequest.trim().slice(0, 400)}"`);
  if (priorAssistantAnswer) {
    parts.push(
      "",
      "Prior answer to validate and update against current web evidence (correct anything stale, wrong, or unverified — do not merely restate it):",
      priorAssistantAnswer.trim().slice(0, 1500),
    );
  }
  return parts.join("\n");
}

export function buildSourceSensitiveOriginalRequestTask(userMessage: string, label?: string, focus?: string): string {
  return [
    // See buildCanonicalSourceSensitiveDelegationTask: lead with web-research / gather
    // framing so embedding routing picks researcher (the primary gatherer) over
    // source_verifier (a draft checker); the SOURCE-SENSITIVE marker line is preserved
    // verbatim for the detectors and the verification discipline is unchanged.
    "WEB RESEARCH TASK — gather fresh sourced evidence from official primary sources.",
    "Research the request below: use web_search and web_fetch to open official manufacturer, vendor, standards, and datasheet pages and gather the requested specifications, interfaces, datasheet values, prices, and component sourcing.",
    label ? `SOURCE-SENSITIVE DELEGATION ${label}:` : "SOURCE-SENSITIVE DELEGATION:",
    "The user's original request below is the only canonical task. Search user-supplied identifiers exactly as given; do not copy coordinator-added assumptions into searches or final claims, and treat every product name, part number, vendor, interface, price, date, URL, quantity, and specification as unconfirmed until a completed tool result or shared finding confirms it.",
    "State a concrete fact only after an official or vendor source confirms it; if evidence contradicts an assumption in the request, the evidence wins, and if evidence is missing, report it as unverified rather than filling the gap.",
    "",
    "Original user request:",
    userMessage.trim(),
    ...formatCoordinatorFocusLines(focus),
  ].join("\n");
}