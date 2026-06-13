/**
 * Deliverable-intent classification + answer-side honesty detectors.
 *
 * One home for the runtime's understanding of WHAT KIND of deliverable a turn asks
 * for (request side) and whether the final answer's completion claims are backed by
 * real produced artifacts (answer side). Extracted from runtime.ts (god-file seam):
 * every finalization gate — auto-build, relay suppression, false-completion guards,
 * fabrication guard — consumes THESE classifiers, so keeping them in one module makes
 * their interplay reviewable and stops each gate growing its own drifting regex.
 *
 * Design rules (hard-learned, see linked audits):
 *  - Structural + bilingual (EN/DE) shape matching only — verb+noun, deixis, markers.
 *    NEVER topic/domain keyword bags (feedback: workflows handle domain fit, not core).
 *  - Request-side classifiers must stay high-precision: they arm autopilots.
 *  - Answer-side detectors must be clause-scoped and negation-aware: they accuse the
 *    model of lying, and a false accusation rewrites a good answer.
 */

/**
 * Heuristic: the user's request asks to CREATE a concrete artifact/deliverable (a file,
 * website, presentation/deck, document, report, chart, app) — not merely to research or
 * answer a question. Mutation verb + artifact noun, EN + DE. Used to decide whether a
 * source-sensitive turn that only gathered evidence should auto-build the artifact in the
 * same turn. Topic-agnostic — verb+noun shape only.
 */
export function looksLikeArtifactCreationRequest(userMessage: string): boolean {
  const t = (userMessage ?? "").toLowerCase();
  const hasVerb = /\b(create|build|generate|make|write|produce|draft|compose|erstelle|erstellen|erstell|baue|bau|schreibe|schreib|generiere|generier|verfasse|verfass|erzeuge|erzeug|mach)\b/.test(t);
  if (!hasVerb) return false;
  return /\b(presentation|pr[äa]sentation|slides?|slide deck|deck|folien|foliensatz|website|web ?site|webseite|webpage|web ?page|landing ?page|microsite|site|app|web ?app|webapp|anwendung|applikation|document|dokument|report|bericht|paper|file|datei|html|reveal\.?js|dashboard|chart|diagram|diagramm|brochure|flyer|poster|pdf|docx|pptx)\b/.test(t);
}

/**
 * Pick the right BUILDER for the end-of-turn auto-build backstop by deliverable
 * type, mirroring the main-assistant routing rules. content_writer (the default)
 * owns static pages / decks / docs via generate_website; but an INTERACTIVE app
 * (a quiz/learning app, SPA, dashboard, calculator, game) must go to web_coder,
 * which writes real front-end code and whose prompt forbids the exact failure
 * content_writer hit — content_writer has no interactive-app tool, so it narrated
 * the whole app as one 21k-token markdown completion that timed out and wrote NO
 * file (audit b3b52be4: a "WebApp zum Lernen" auto-built by content_writer ran
 * 7 min, called only read_shared_facts). A DYNAMIC app that must be SERVED (a
 * running Node/Express server / live API) goes to backend_coder. Structural +
 * bilingual; the default stays content_writer so static deliverables (pages,
 * decks, documents) are unchanged.
 */
export function selectAutoBuildBuilderAgent(userMessage: string): "content_writer" | "web_coder" | "backend_coder" {
  const t = (userMessage ?? "").toLowerCase();
  const served =
    /\b(serve|deploy|backend|server|express|node\.?js|\brest\b|datenbank|database|ausliefern|bereitstellen)\b/.test(t)
    || /\b(run|starte?|start|laufen)\b[^.?!]{0,30}\b(app|server|backend|instance|instanz)\b/.test(t);
  if (served) return "backend_coder";
  const interactiveApp =
    /\b(app|web ?app|webapp|web-app|anwendung|applikation|spa|single[- ]page|interactive|interaktiv|dashboard|quiz|game|spiel|calculator|rechner|simulator|lernplattform|lern-?app|learning ?platform|learning ?app|fragekatalog|multiple[- ]?choice|flashcards?|karteikarten?)\b/.test(t);
  if (interactiveApp) return "web_coder";
  return "content_writer";
}

/**
 * The single-deliverable relay is a latency shortcut: when one delegation returns a complete,
 * presentable deliverable, ship it directly instead of paying for a second synthesis pass. It
 * must NOT fire when the user asked to BUILD an interactive/served app (web_coder/backend_coder
 * class) but NO real artifact was produced this turn — the relayed text is then research plus a
 * *concept*, not the built app, and relaying it short-circuits the auto-build backstop (audit
 * 9ad34ef9: a "WebApp" turn relayed the researcher's fact-sheet + concept and built nothing).
 * Scoped to app/served deliverables so plain reports/decks (fine inline) still relay.
 */
export function shouldSuppressRelayForUnbuiltApp(userMessage: string, producedArtifactCount: number): boolean {
  return (
    producedArtifactCount === 0
    && looksLikeArtifactCreationRequest(userMessage)
    && selectAutoBuildBuilderAgent(userMessage) !== "content_writer"
  );
}

/**
 * Broader sibling of {@link looksLikeArtifactCreationRequest}: the user asks for a substantial
 * COMPOSED written deliverable — a build guide, how-to, BOM / parts list, wiring or connection
 * layout, schematic help, buying guide, or cost plan — even when they never say "create a
 * file". On the slow backend these turns otherwise research and then ship raw facts because
 * the verb+file-noun classifier above does not match (audit da8fc547: "give me product
 * suggestions + a layout how to connect everything + a cost plan" shipped raw datasheet
 * reflow-oven temperatures instead of the build guide the researcher had already drafted).
 * High-precision: a deliverable noun AND a produce/help request, EN + DE, topic-agnostic.
 * Used ONLY to widen the end-of-turn auto-build trigger (gated behind source-sensitive +
 * ≥3 curated facts + no-artifact-produced), never the false-completion guards.
 */
export function looksLikeComposedGuideRequest(userMessage: string): boolean {
  const t = (userMessage ?? "").toLowerCase();
  const deliverable =
    /\b(build guide|how[- ]?to|step[- ]?by[- ]?step|bill of materials|\bbom\b|parts? list|wiring|connection layout|pinout|schematic|kicad|cost plan|cost breakdown|buying guide|bauanleitung|anleitung|st[üu]ckliste|verkabelung|schaltplan|kostenplan|kostenaufstellung|einkaufsliste)\b/;
  const layoutHowTo = /\blayout\b[^.?!]{0,40}\b(connect|wire|wiring|together|verbinden|zusammen)\b/;
  if (!deliverable.test(t) && !layoutHowTo.test(t)) return false;
  const askToProduce =
    /\b(give me|provide|need|how (?:do|can|should) i|help me|put\b[^.?!]{0,30}\btogether|brauche|wie (?:baue|verbinde|schlie[ßs]e|setze)|hilfe|zusammen ?(?:bauen|setzen|f[üu]gen)|create|build|design|draft|write|plan|erstelle?|erstell|baue?|bau|entwirf|entwerfe|plane?)\b/;
  return askToProduce.test(t);
}

const ARTIFACT_NOUN_RE =
  /\b(presentation|pr[äa]sentation|slides?|slide deck|folien|foliensatz|deck|website|web ?site|webseite|webpage|web ?page|landing ?page|microsite|app|web ?app|webapp|anwendung|applikation|\w*plattform|\w*platform|document|dokument|report|bericht|paper|file|datei|index\.html|html|reveal\.?js|dashboard|chart|diagram|diagramm|brochure|flyer|poster|pdf|docx|pptx|artifact|artefakt)\b/i;

/** A concrete artifact FILENAME named in the answer (e.g. `cpsaf-learning-platform.html`) —
 * as strong a deliverable signal as an artifact noun (audit 1ac79471 turn 1: a zero-tool
 * answer told the user to open a named .html file that never existed). */
const ARTIFACT_FILENAME_RE = /\b[\w-]{2,}\.(?:html?|pdf|docx?|pptx?|xlsx?|zip|csv|md|json|svg|png|jpe?g)\b/i;

/**
 * Broader than {@link looksLikeArtifactCreationRequest}: the turn asks to CREATE *or* CHANGE
 * a concrete artifact (update / edit / insert into / add to / embed in / replace). Used to
 * scope the false-completion guard so a "füge die Bilder in die Präsentation ein" (modify)
 * request is covered, not just "erstelle eine Präsentation" (create). Topic-agnostic.
 */
export function looksLikeArtifactMutationRequest(userMessage: string): boolean {
  if (looksLikeArtifactCreationRequest(userMessage)) return true;
  const t = (userMessage ?? "").toLowerCase();
  const hasMutateVerb =
    /\b(update|updated|edit|modify|change|revise|adjust|insert|add|append|embed|replace|fix|aktualisiere?|aktualisier|ändere?|änder|bearbeite?|bearbeit|überarbeite?|überarbeit|ergänze?|ergänz|einf[üu]gen|einf[üu]ge|f[üu]ge|hinzuf[üu]gen|hinzuf[üu]ge|einbette?|einbinden|einbinde|ersetze?|ersetz)\b/.test(t);
  if (!hasMutateVerb) return false;
  return ARTIFACT_NOUN_RE.test(t);
}

/**
 * The answer ASSERTS, as a completed fact, that it created/updated/saved/inserted the
 * artifact — yet the caller only invokes this when NO artifact was produced this turn, so a
 * match means a FALSE "I updated the presentation" claim (audit 14661623 turn 2: the run
 * gathered image URLs, never rebuilt the deck, but said "Die Bilder wurden eingefügt …
 * URLs überprüft"). Clause-scoped so a negated, honest "I did NOT update the deck" is not
 * flagged. Structural + bilingual; needs a completion verb AND an artifact noun in the SAME
 * clause, with no negation in that clause.
 */
export function claimsArtifactWrittenButUnproduced(value: string): boolean {
  const text = value ?? "";
  if (!text.trim()) return false;
  const claimVerb =
    /(eingef[üu]gt|eingebettet|aktualisiert|erstellt|gespeichert|hinzugef[üu]gt|geändert|überarbeitet|ergänzt|integriert|eingebunden|ersetzt|gebaut|angelegt|fertiggestellt|bereitgestellt|inserted|embedded|updated|created|saved|added|modified|written|generated|built|produced|deployed)/i;
  // Delivery phrasing without a completion verb (audit 1ac79471 turn 1: "Die Plattform ist
  // jetzt … verfügbar" + "Öffne die Datei `cpsaf-learning-platform.html`" — a fabricated
  // delivery with zero tools that the verb list alone missed). Predicate-anchored
  // ("ist … verfügbar") so an honest OFFER ("ich bin bereit, die Datei zu erstellen")
  // does not trip it.
  const availabilityClaim =
    /\b(?:ist|sind|is|are|steht|stehen|liegt|liegen)\b[^.!?\n]{0,60}\b(?:verf[üu]gbar|einsatzbereit|bereit|fertig|available|ready)\b/i;
  // (?:^|\s…) instead of a leading \b: JS \b is ASCII-only and never matches before "Öffne".
  // Anchored to a FILE object — the word datei/file or a concrete filename ("öffne
  // index.html im Browser") — NOT a bare device/program target: "öffne dein
  // E-Mail-Programm im Browser" is everyday advice to the user, not a delivery claim,
  // and `\bapp\b` matches inside hyphenated compounds like "E-Mail-App" (session
  // 24826c33: an email-check answer was suppressed over exactly that phrasing).
  const openImperative = /(?:^|[\s*_>`"'(])(?:öffne|öffnen sie|open)\b[^.!?\n]{0,50}(?:\b(?:datei|file)\b|[\w-]{2,}\.(?:html?|pdf|docx?|pptx?|xlsx?|zip|csv|md|json|svg|png|jpe?g)\b)/i;
  const negation =
    /(\bnicht\b|\bkein|\bniemals\b|\bohne\b|\bnot\b|\bnever\b|couldn'?t|could ?not|cannot|can'?t|\bno\b|\bunable\b|konnte)/i;
  // Split into clauses so a negated clause ("… wurde NICHT geändert") can't trip the claim.
  for (const clause of text.split(/[.!?\n;:]+/)) {
    const delivers = claimVerb.test(clause) || availabilityClaim.test(clause) || openImperative.test(clause);
    const namesArtifact = ARTIFACT_NOUN_RE.test(clause) || ARTIFACT_FILENAME_RE.test(clause);
    if (delivers && namesArtifact && !negation.test(clause)) return true;
  }
  return false;
}

/**
 * The answer hands the user a link/path that ONLY a real tool execution can mint:
 *   - `/api/app/<id>`        → a served app (backend_coder + serve_app)
 *   - `/api/workspace/file`  → a workspace file download
 *   - a markdown link to a `generated/…` workspace artifact
 * In a turn that ran ZERO tools and produced ZERO artifacts, any of these is
 * fabricated — the model invented a finished deliverable with no work behind it
 * (audit 45d5bae9: claimed a 120-question iSAQB platform and handed over
 * `/api/app/3807`; toolIterations 0, delegationCount 0, no artifact). Structural,
 * topic-agnostic; a concrete numeric app id keeps the served-app match high-precision.
 */
export function looksLikeFabricatedToolDeliveryLink(text: string): boolean {
  const t = text ?? "";
  return /\/api\/app\/\d+/.test(t)
    || /\/api\/workspace\/file\b/.test(t)
    || /\]\(\s*\/?generated\//i.test(t);
}

/**
 * Heuristic: the answer INLINES a full artifact (a complete HTML document, or a large
 * fenced code block carrying the whole deliverable) instead of it being a real workspace
 * file. On a source-sensitive artifact-creation turn that produced NO artifact, this is the
 * model hand-writing the deliverable from training data and passing it off as the result
 * (audit 453a263e: after the build was stopped, synthesis pasted a multi-KB reveal.js deck
 * — fabricated, falsely "verified"). Structural only: full-document markers or a big code
 * fence; format-agnostic, no topic terms. The caller scopes this to the no-artifact case.
 */
export function looksLikeInlinedArtifactFabrication(value: string): boolean {
  const v = value ?? "";
  if (v.length < 1500) return false;
  // A complete HTML/XML document inlined into the answer.
  if (/<!DOCTYPE\s+html/i.test(v) && /<\/html>/i.test(v)) return true;
  if (/```[a-z]*\s*<!DOCTYPE\s+html/i.test(v)) return true;
  if (/```[a-z]*\s*<html[\s>]/i.test(v)) return true;
  // The whole deliverable pasted as one large fenced code block rather than written to a file.
  const fences = v.match(/```[\s\S]*?```/g);
  if (fences && fences.some((f) => f.length >= 1500)) return true;
  return false;
}

/**
 * The answer inlines a FULL HTML APPLICATION DOCUMENT (fenced or raw `<!DOCTYPE html>` /
 * `<html>` markers, ≥1500 chars) — the model hand-writing the whole app into chat instead
 * of a real file being built. Tighter than {@link looksLikeInlinedArtifactFabrication}:
 * deliberately NO generic big-fence clause, because a large fenced *snippet* in a zero-tool
 * turn can be a legitimate inline answer ("show me example code"), while a full HTML
 * document never is — it is unrunnable chat text, usually truncated by the completion cap
 * (audit 3b7d59a8: 11.4KB inline app, finishReason "length", cut off mid-CSS; the
 * runaway_inline_artifact flag fired but nothing rerouted, so the user got the dead wall).
 * Works on truncated dumps: the fenced-doctype clauses need no closing tag.
 */
export function looksLikeInlinedAppDocument(value: string): boolean {
  const v = value ?? "";
  if (v.length < 1500) return false;
  if (/```[a-z]*\s*<!DOCTYPE\s+html/i.test(v)) return true;
  if (/```[a-z]*\s*<html[\s>]/i.test(v)) return true;
  return /<!DOCTYPE\s+html/i.test(v) && /<\/html>/i.test(v);
}

/**
 * Extract a full inline HTML application document from a builder's prose result, so the
 * runtime can HARVEST it into a real file. Audit 0ac7d3fc: the corrective build "succeeded"
 * but wrote no file — its timeout synthesis pasted the complete app (15KB `<!DOCTYPE html>`
 * fence) into its RESULT text instead. The content exists; turning it into the artifact is
 * deterministic work the runtime can do itself. Prefers a fenced ```html document, falls
 * back to a raw document; returns null below 1.5KB (not an app). Truncated documents are
 * still returned (a cut-off file beats no file) — the caller flags incompleteness via
 * {@link looksLikeCompleteHtmlDocument}.
 */
export function extractInlineHtmlDocument(value: string): string | null {
  const v = value ?? "";
  if (v.length < 1500) return null;
  const fenced = v.match(/```(?:html)?\s*\n?(<!DOCTYPE\s+html[\s\S]*?)(?:```|$)/i)
    ?? v.match(/```(?:html)?\s*\n?(<html[\s>][\s\S]*?)(?:```|$)/i);
  const raw = fenced?.[1] ?? v.match(/(<!DOCTYPE\s+html[\s\S]*)$/i)?.[1] ?? null;
  if (!raw) return null;
  // If a closing tag exists, cut cleanly after it (drops trailing prose/fences).
  const closeIdx = raw.search(/<\/html>/i);
  const doc = closeIdx >= 0 ? raw.slice(0, closeIdx + "</html>".length) : raw;
  return doc.trim().length >= 1500 ? doc.trim() : null;
}

/** True when the document has a closing </html> — used to flag harvested truncation honestly. */
export function looksLikeCompleteHtmlDocument(value: string): boolean {
  return /<\/html>/i.test(value ?? "");
}

/**
 * Remove large fenced code blocks (>=1500 chars) from a user-facing confirmation message.
 * Used after a corrective build, where the built file is ALREADY attached as a download:
 * the slow model sometimes pastes a multi-KB code block (often a *different*, fabricated
 * version than the file actually written — audit ce8e2128), which is pure noise and looks
 * broken. Short snippets stay; each stripped block leaves a one-line marker. Format-agnostic.
 */
export function stripLargeCodeFences(value: string): string {
  const v = value ?? "";
  if (!v) return v;
  const cleaned = v.replace(/```[a-zA-Z0-9_+\-]*\n[\s\S]*?```/g, (block) =>
    block.length >= 1500 ? "_(Code in der angehängten Datei — hier nicht eingefügt. / Code is in the attached file, not inlined here.)_" : block,
  );
  return cleaned.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The turn's deliverable intent, classified ONCE per turn. Every finalization gate
 * (auto-build, relay suppression, false-completion guards) should consume this single
 * object instead of re-running its own classifier combination — that keeps the gates'
 * interplay coherent by construction (the two-autopilot conflicts of v0.30/v0.31 were
 * exactly N gates classifying the same message independently and disagreeing).
 */
export interface DeliverableIntent {
  /** The request asks to create a concrete artifact (verb + artifact noun). */
  readonly wantsArtifact: boolean;
  /** Broader: create OR modify an artifact (covers "füge … ein" mutations). */
  readonly wantsArtifactMutation: boolean;
  /** The request asks for a composed written guide (BOM, how-to, cost plan, …). */
  readonly wantsComposedGuide: boolean;
  /** Which specialist the auto-build backstop should use for this deliverable. */
  readonly builder: "content_writer" | "web_coder" | "backend_coder";
  /** True when the deliverable is an interactive/served APP (not a static page/doc). */
  readonly isAppBuild: boolean;
  /**
   * The request NAMES a concrete artifact (noun or filename) at all — no verb required,
   * so need-phrased build requests ("Ich brauche eine Lernplattform …") still count.
   * Weaker than wantsArtifact; used to scope the ANSWER-side fabrication detectors to
   * turns that could plausibly be about an artifact, so a plain lookup question
   * ("Schau mal ob ich neue Emails habe") can never have its answer suppressed over
   * the answer's own wording (session 24826c33).
   */
  readonly mentionsArtifact: boolean;
}

export function classifyDeliverableIntent(userMessage: string): DeliverableIntent {
  const builder = selectAutoBuildBuilderAgent(userMessage);
  return {
    wantsArtifact: looksLikeArtifactCreationRequest(userMessage),
    wantsArtifactMutation: looksLikeArtifactMutationRequest(userMessage),
    wantsComposedGuide: looksLikeComposedGuideRequest(userMessage),
    builder,
    isAppBuild: builder !== "content_writer",
    mentionsArtifact: ARTIFACT_NOUN_RE.test(userMessage ?? "") || ARTIFACT_FILENAME_RE.test(userMessage ?? ""),
  };
}
