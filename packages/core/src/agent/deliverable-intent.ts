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
 *
 * An EXTERNAL-API CONNECTOR (wrap/integrate a third-party HTTP API — e.g. a geocoding
 * or POI service) also goes to backend_coder: it must run as a SERVED backend, which
 * has full network egress + npm install, NOT as a sandboxed self-dev tool snippet
 * (that sandbox is --network=none and cannot reach the API). The predicate is purely
 * structural (build-architecture nouns + integrate/wrap/query verbs near api/endpoint/
 * service), topic-agnostic — it encodes the "connectors are served backends" doctrine,
 * never a specific service.
 */
export function selectAutoBuildBuilderAgent(userMessage: string): "content_writer" | "web_coder" | "backend_coder" {
  const t = (userMessage ?? "").toLowerCase();
  const served =
    /\b(serve|deploy|backend|server|express|node\.?js|\brest\b|datenbank|database|ausliefern|bereitstellen)\b/.test(t)
    || /\b(run|starte?|start|laufen)\b[^.?!]{0,30}\b(app|server|backend|instance|instanz)\b/.test(t);
  const externalConnector =
    /\b(connector|integration|api[- ]?(client|proxy|wrapper|gateway|connector))\b/.test(t)
    || /\b(integrate|connect|wrap|query|call|fetch|pull|consume|proxy)\b[^.?!]{0,40}\b(api|endpoint|web ?service|webservice|third[- ]?party|external (?:service|api))\b/.test(t);
  if (served || externalConnector) return "backend_coder";
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

const ARTIFACT_NOUN_ALTERNATION =
  String.raw`presentation|pr[äa]sentation|slides?|slide deck|folien|foliensatz|deck|website|web ?site|webseite|webpage|web ?page|landing ?page|microsite|app|web ?app|webapp|anwendung|applikation|\w*plattform|\w*platform|document|dokument|report|bericht|paper|file|datei|index\.html|html|reveal\.?js|dashboard|chart|diagram|diagramm|brochure|flyer|poster|pdf|docx|pptx|artifact|artefakt`;
const ARTIFACT_NOUN_RE = new RegExp(String.raw`\b(${ARTIFACT_NOUN_ALTERNATION})\b`, "i");

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

// ── Completion-claim GRAMMAR (verified false positive 2026-10-05) ────────────────────────
// A completion verb next to an artifact noun is not yet a claim. "Bei PDF/A werden alle
// Schriften in das Dokument eingebettet" / "all fonts are embedded in the file" — a correct,
// tool-free answer to a PDF vs PDF/A question — was read as "I embedded it into the document"
// and suppressed: replaced with the canned "Ich habe in diesem Schritt nichts gebaut" denial or
// rerouted into a corrective build, or bannered "file NOT created". What separates a claim from
// prose about how things work is grammar, not vocabulary:
//   - first person in the perfect/past        "Ich habe … eingefügt", "I updated …"
//   - a COMPLETED passive                      "… wurden … eingefügt", "has been updated"
//   - a present state with completion deixis   "ist jetzt aktualisiert", "is now saved"
//   - a verbless headline ending on the verb   "✅ Präsentation aktualisiert", "Deck updated"
//   - a clause that OPENS on the completion verb "Updated the deck …", "Saved to report.pdf"
//   - the artifact as subject of a finished state      "Your deck is updated", "Die Präsentation
//                                                      ist fertig"
//   - availability with deixis or a file      "ist jetzt … verfügbar", "is ready: report.pdf"
//   - a completion adjective + a pointer      "Here is the updated presentation: …"
//   - pointing the user at a concrete deliverable FILE that does not exist  "Öffne `quiz.html`",
//     "Download it here: output/deck.html" — whatever the grammar
// A generic present passive ("werden … eingebettet", "are embedded") is none of these.
// An existing file excuses ONLY a pure pointer (no completion verb, no completion adjective):
// nothing was written THIS turn, so "the deck was saved as output/deck.html" is false even when
// an earlier turn left that file behind (adversarial review 2026-10-05).

/** English completion verbs (simple past = participle) — the predicate of "I updated …". */
const EN_COMPLETION_VERB = String.raw`(?:inserted|embedded|updated|created|saved|added|modified|written|wrote|generated|built|produced|deployed)`;
/** German completion participles — the clause-final predicate of "ich habe … eingefügt". */
const DE_COMPLETION_PARTICIPLE = String.raw`(?:eingef(?:ü|ue|u)gt|eingebettet|aktualisiert|erstellt|gespeichert|hinzugef(?:ü|ue|u)gt|ge(?:ä|ae)ndert|(?:ü|ue)berarbeitet|erg(?:ä|ae)nzt|integriert|eingebunden|ersetzt|gebaut|angelegt|fertiggestellt|bereitgestellt)`;
// Unicode-aware word edges: JS \b is ASCII-only (no edge before "überarbeitet"), and a bare
// substring match read "eingebetteten Schriften" (an adjective) as the participle. A "/" is no
// edge either: "generated/deck.html" is a folder, not the verb "generated".
const WORD_START = String.raw`(?<![\p{L}\d_/])`;
const WORD_END = String.raw`(?![\p{L}\d_/])`;
const EN_VERB = `${WORD_START}${EN_COMPLETION_VERB}${WORD_END}`;
const DE_VERB = `${WORD_START}${DE_COMPLETION_PARTICIPLE}${WORD_END}`;
const ANY_COMPLETION_VERB = `${WORD_START}(?:${EN_COMPLETION_VERB}|${DE_COMPLETION_PARTICIPLE})${WORD_END}`;
const ARTIFACT_FILE_EXT = "html?|pdf|docx?|pptx?|xlsx?|zip|csv|md|json|svg|png|jpe?g";

// German perfect: the participle closes the clause, so the window stops at a comma — a
// subordinate clause after the comma is not the speaker's claim.
const FIRST_PERSON_COMPLETION_RE = new RegExp(
  String.raw`${WORD_START}(?:i|we)(?:'ve|’ve|\s+have|\s+had)?(?:\s+(?:just|now|also|already|successfully|then|finally|completely|fully))*\s+${EN_VERB}`
  + String.raw`|${WORD_START}(?:ich|wir)\s+(?:habe|hab|haben|hatte|hatten)${WORD_END}[^,]{0,160}?${DE_VERB}`
  + String.raw`|${WORD_START}(?:habe|hab|haben|hatte|hatten)\s+(?:ich|wir)${WORD_END}[^,]{0,160}?${DE_VERB}`,
  "iu",
);
const COMPLETED_PASSIVE_RE = new RegExp(
  String.raw`${WORD_START}(?:wurde|wurden|worden)${WORD_END}[^,]{0,120}?${DE_VERB}`
  + String.raw`|${DE_VERB}\s+worden${WORD_END}`
  + String.raw`|${WORD_START}(?:was|were|has\s+been|have\s+been|had\s+been)\s+(?:\p{L}+ly\s+|now\s+|just\s+|also\s+|already\s+)?${EN_VERB}`,
  "iu",
);
const DEICTIC_STATE_CLAIM_RE = new RegExp(
  String.raw`${WORD_START}(?:ist|sind|is|are)${WORD_END}[^,]{0,60}?${WORD_START}(?:jetzt|nun|now|bereits|already|erfolgreich|successfully)${WORD_END}[^,]{0,60}?${ANY_COMPLETION_VERB}`,
  "iu",
);
// The participle is the clause's last word (or is followed only by where the file went:
// "→ output/deck.html", ": output/deck.html", "to report.pdf").
const HEADLINE_CLAIM_RE = new RegExp(
  String.raw`${ANY_COMPLETION_VERB}(?:\s*(?:→|->|:|–|—)?\s*(?:(?:to|in|at|as|under|unter|im|als|nach|auf)\s+)?[\x60"'„“*_\[(]*[\w./-]+\.(?:${ARTIFACT_FILE_EXT})[\x60"'“”*_\])]*)?[\s\p{P}\p{S}]*$`,
  "iu",
);
// A clause that opens (after a bullet, emoji or markup) on the completion verb and goes on to its
// object — "Updated the deck …", "Added the images to …", "Created report.pdf …", "Saved to
// report.pdf". The object must follow as a determiner, preposition or file, so an adjective use
// ("Embedded fonts are required in PDF/A") is not a claim.
const CLAUSE_INITIAL_COMPLETION_RE = new RegExp(
  String.raw`^[\s\p{P}\p{S}]*${ANY_COMPLETION_VERB}\s+(?:(?:the|a|an|your|this|these|those|all|its|their|die|der|das|den|dem|eine|einen|ein|deine|dein|ihre|alle|to|into|in|as|at|under|unter|im|als|nach|zu)${WORD_END}|[\x60"'„“*_\[(]*(?:[\w.-]+\/)*[\w-]{2,}\.(?:${ARTIFACT_FILE_EXT})\b)`,
  "iu",
);
// The artifact itself as the subject of a finished state: "Your deck is updated", "Die
// Präsentation ist fertig", "The website is live now". A determiner is required — "PDF/A files
// are ready for archiving" talks about a kind of file, not a deliverable.
const FINISHED_STATE = String.raw`${EN_COMPLETION_VERB}|${DE_COMPLETION_PARTICIPLE}|fertig|ready|done|complete|completed|finished|available|verf(?:ü|ue|u)gbar|bereit|einsatzbereit|vollst(?:ä|ae)ndig|live|online`;
const SUBJECT_STATE_CLAIM_RE = new RegExp(
  String.raw`${WORD_START}(?:your|the|this|our|my|dein|deine|die|der|das|ihre|eure|unsere|mein|meine)\s+(?:[\p{L}-]+\s+){0,2}?(?:${ARTIFACT_NOUN_ALTERNATION})\s+(?:is|are|ist|sind)\s+(?:(?:now|jetzt|nun|bereits|already|erfolgreich|successfully)\s+)?(?:${FINISHED_STATE})${WORD_END}`,
  "iu",
);
// A completion adjective on the artifact ("the updated presentation", "die aktualisierte
// Präsentation", "the new deck") together with a pointer to it (a file, "here", "find", …).
const COMPLETION_ADJECTIVE_RE = new RegExp(
  String.raw`${WORD_START}(?:updated|new|revised|finished|final|edited|modified|generated|created|aktualisierte[nmrs]?|neue[nmrs]?|(?:ü|ue)berarbeitete[nmrs]?|fertige[nmrs]?|erstellte[nmrs]?|generierte[nmrs]?)\s+(?:[\p{L}-]+\s+)?(?:${ARTIFACT_NOUN_ALTERNATION})${WORD_END}`,
  "iu",
);
const POINTER_WORD_RE = /(?<![\p{L}])(?:here|hier|herunterladen|download|attached|anbei|find|findest|finden|unten|below)(?![\p{L}])/iu;
// Deliverable file types a pointer can hand over (code/config files like package.json are not a
// deliverable the user is pointed at).
const POINTER_FILE_EXT = "html?|pdf|docx?|pptx?|xlsx?|zip|csv|svg|png|jpe?g";
const POINTER_FILE_RE = new RegExp(String.raw`(?<![\w./-])(?:[\w.-]+\/)*[\w-]{2,}\.(?:${POINTER_FILE_EXT})\b`, "gi");
// The clause tells the USER to make or change a file ("Save it as report.pdf", "Export the slides
// to deck.pdf", "Füge … in die index.html ein") — advice, not a delivery. Base forms of the
// completion/authoring verbs (a closed class: the completion verbs above in their base form).
const INSTRUCTION_START_RE = /^[\s\p{P}\p{S}]*(?:insert|embed|update|create|save|add|modify|write|generate|build|produce|deploy|name|call|rename|put|copy|move|edit|export|convert|upload|attach|füge|speichere|erstelle|erzeuge|schreibe|benenne|nenne|kopiere|verschiebe|bearbeite|exportiere)(?![\p{L}])/iu;
const EXEMPLIFY_RE = /(?<![\p{L}])(?:e\.g\.|z\.\s?b\.|for example|for instance|zum beispiel|beispielsweise|such as|etwa)(?![\p{L}])/iu;
const USER_OWNED_BEFORE_RE = /(?<![\p{L}])(?:your|dein|deine|deinen|deinem|ihre|ihren|eure|euren)\s+(?:[\w-]+\s+)?$/iu;
const FINITE_VERB_RE = /(?<![\p{L}])(?:is|are|was|were|be|been|has|have|had|can|could|will|would|should|must|may|might|do|does|did|wird|werden|wurde|wurden|ist|sind|war|waren|hat|haben|habe|kann|k(?:ö|oe)nnen|muss|m(?:ü|ue)ssen|soll|sollte|sollten|darf|d(?:ü|ue)rfen)(?![\p{L}])/iu;
const HEADLINE_MAX_WORDS = 6;
// Delivery phrasing without a completion verb (audit 1ac79471 turn 1: "Die Plattform ist
// jetzt … verfügbar" + "Öffne die Datei `cpsaf-learning-platform.html`" — a fabricated
// delivery with zero tools that the verb list alone missed). Predicate-anchored
// ("ist … verfügbar") so an honest OFFER ("ich bin bereit, die Datei zu erstellen")
// does not trip it, and deixis-anchored ("jetzt", "now", "hier", "in your workspace") so a
// general statement ("PDF/A files are ready for archiving") does not either.
const AVAILABILITY_CLAIM_RE =
  /\b(?:ist|sind|is|are|steht|stehen|liegt|liegen)\b(?:[^.!?\n]|\.(?=\S)){0,60}\b(?:verf[üu]gbar|einsatzbereit|bereit|fertig|available|ready)\b/i;
const DELIVERY_DEIXIS_RE = /(?<![\p{L}])(?:jetzt|nun|now|hier|here|bereits|already|sofort|workspace|download)(?![\p{L}])/iu;
// Pointers ("öffne index.html im Browser", "Download it here: output/deck.html") need a concrete
// FILENAME — NOT a bare device/program target: "öffne dein E-Mail-Programm im Browser" is everyday
// advice to the user, not a delivery claim, and `\bapp\b` matches inside hyphenated compounds like
// "E-Mail-App" (session 24826c33: an email-check answer was suppressed over exactly that
// phrasing). The bare word "file"/"Datei" does not count either ("open the file in Acrobat and
// check the fonts" is advice). See POINTER_FILE_RE below.
// A named file with its folder prefix ("generated/deck/index.html"), so the existence check
// sees the path the answer gave, not only its last segment.
const ARTIFACT_PATH_ALL_RE = new RegExp(String.raw`(?<![\w./-])(?:[\w.-]+\/)*[\w-]{2,}\.(?:${ARTIFACT_FILE_EXT})\b`, "gi");
const CLAIM_NEGATION_RE =
  /(\bnicht\b|\bkein|\bniemals\b|\bohne\b|\bnot\b|\bnever\b|couldn'?t|could ?not|cannot|can'?t|\bno\b|\bunable\b|konnte)/i;

/**
 * The answer ASSERTS, as a completed fact, that it created/updated/saved/inserted the
 * artifact — yet the caller only invokes this when NO artifact was produced this turn, so a
 * match means a FALSE "I updated the presentation" claim (audit 14661623 turn 2: the run
 * gathered image URLs, never rebuilt the deck, but said "Die Bilder wurden eingefügt …
 * URLs überprüft"). Clause-scoped so a negated, honest "I did NOT update the deck" is not
 * flagged. Structural + bilingual: a claim GRAMMAR (see above) AND a deliverable — an artifact
 * noun or a concrete filename — in the SAME clause, with no negation in that clause.
 *
 * `fileExists` (workspace-relative): a clause that only POINTS at files which really exist
 * ("Öffne report.pdf" for a file an earlier turn made) is a reference, not a fabricated
 * delivery. Existence excuses nothing else: a clause with completion grammar or a completion
 * adjective ("the deck was saved as output/deck.html", "open output/deck.html to see the UPDATED
 * presentation") claims work THIS turn, and nothing was written this turn.
 */
export function claimsArtifactWrittenButUnproduced(
  value: string,
  opts?: { fileExists?: (ref: string) => boolean },
): boolean {
  const text = value ?? "";
  if (!text.trim()) return false;
  const fileExists = opts?.fileExists ?? (() => false);
  for (const clause of claimClauses(text)) {
    if (!clause.trim() || CLAIM_NEGATION_RE.test(clause)) continue;
    const files = [...clause.matchAll(ARTIFACT_PATH_ALL_RE)].map((match) => match[0]);
    if (!ARTIFACT_NOUN_RE.test(clause) && files.length === 0) continue;

    // Completion grammar: a claim whether or not the named file exists.
    if (FIRST_PERSON_COMPLETION_RE.test(clause) || CLAUSE_INITIAL_COMPLETION_RE.test(clause)) return true;
    if (COMPLETED_PASSIVE_RE.test(clause) || DEICTIC_STATE_CLAIM_RE.test(clause) || SUBJECT_STATE_CLAIM_RE.test(clause)) return true;
    const words = clause.trim().split(/\s+/u).filter((word) => /[\p{L}\d]/u.test(word) && !/\.\w{2,5}$/u.test(word));
    if (words.length <= HEADLINE_MAX_WORDS && !FINITE_VERB_RE.test(clause) && HEADLINE_CLAIM_RE.test(clause.trim())) return true;
    const pointsAtFile = files.length > 0;
    if (AVAILABILITY_CLAIM_RE.test(clause) && (DELIVERY_DEIXIS_RE.test(clause) || pointsAtFile)) return true;
    if (COMPLETION_ADJECTIVE_RE.test(clause) && (pointsAtFile || POINTER_WORD_RE.test(clause))) return true;

    // A pure pointer: hands the user a deliverable file — a claim when that file does not exist.
    if (INSTRUCTION_START_RE.test(clause) || EXEMPLIFY_RE.test(clause)) continue;
    for (const pointer of clause.matchAll(POINTER_FILE_RE)) {
      if (USER_OWNED_BEFORE_RE.test(clause.slice(0, pointer.index))) continue;
      if (!fileExists(pointer[0])) return true;
    }
  }
  return false;
}

// A colon that introduces a file path or link keeps the clause together ("Here is the updated
// presentation: output/deck.html"); any other colon ends it.
const COLON_BEFORE_PATH_RE = new RegExp(String.raw`^\s*[\x60"'„“*_\[(]*(?:\/\/|(?:[\w.-]+\/)*[\w-]{2,}\.(?:${ARTIFACT_FILE_EXT})\b)`, "i");

/**
 * The answer's clauses, so a negated or questioning clause ("… wurde NICHT geändert") cannot trip
 * the claim. A period ends a clause only before whitespace or the end, so "quiz.html" stays one
 * token. A question contributes only what precedes its last comma/dash ("Ich habe die
 * Präsentation aktualisiert, soll ich sie auch exportieren?" still claims the update; "Soll ich
 * die Plattform bauen?" claims nothing).
 */
function claimClauses(text: string): string[] {
  const clauses: string[] = [];
  let start = 0;
  const push = (end: number, question: boolean): void => {
    const clause = text.slice(start, end);
    if (!question) { clauses.push(clause); return; }
    const lastBreak = Math.max(clause.lastIndexOf(","), clause.lastIndexOf("—"), clause.lastIndexOf("–"));
    if (lastBreak > 0) clauses.push(clause.slice(0, lastBreak));
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    let boundary = false;
    if (ch === "\n" || ch === ";") boundary = true;
    else if (ch === "." || ch === "!" || ch === "?") boundary = i + 1 >= text.length || /[\s"'”)*_]/.test(text[i + 1]!);
    else if (ch === ":") boundary = !COLON_BEFORE_PATH_RE.test(text.slice(i + 1, i + 200));
    if (!boundary) continue;
    push(i, ch === "?" || text.slice(Math.max(start, i - 2), i).includes("?"));
    start = i + 1;
  }
  push(text.length, false);
  return clauses;
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
  const cleaned = v.replace(/```[a-zA-Z0-9_+-]*\n[\s\S]*?```/g, (block) =>
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
