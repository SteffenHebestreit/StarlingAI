/**
 * Turn Intent Classifier
 *
 * Centralises all per-turn keyword/regex heuristics that were previously
 * scattered across the top of runtime.ts.  The runtime calls
 * `buildDynamicTurnGuidance()` and `buildLanguageAndIdentityTurnGuidance()`
 * from here rather than resolving them inline, keeping the runtime file
 * focused on the execution loop.
 *
 * No LLM calls are made here — all classification is deterministic, fast,
 * and side-effect-free.
 */

import { getConfig } from "../config/loader.js";
import { loadMainAssistantPersonality } from "../personality/service.js";
import type { MainAssistantToolMode } from "./default-tools.js";
import { PRODUCT } from "../product/index.js";

// ── Intent term / pattern tables ─────────────────────────────────────────────

// NOTE: "jetzt" / "now" are deliberately EXCLUDED. They are the weakest, most
// ambiguous temporal words — overwhelmingly used in non-freshness contexts
// ("nicht jetzt danke", "now I see", "right now please") — so on their own they
// produced false freshnessSensitive hits that blocked the receptionist fast lane
// and dragged trivial turns onto the heavy path (audit 31b683e8: "nicht jetzt
// danke" → 21.7s). Genuinely fresh queries carry a stronger signal (heute,
// aktuell, latest, current, recent, today, news, a year). Keep this list to
// terms that are freshness-bearing on their own.
export const FRESHNESS_HINT_TERMS = [
  "aktuell", "aktuelle", "aktuellen", "heute", "live", "neueste", "neusten",
  "letzte ziehung", "letzten ziehung", "gewinnzahlen", "zahlen heute",
  "2025", "2026", "current", "currently", "fresh", "latest", "news",
  "recent", "recently", "today", "updated", "updates",
];

// Self-referential capability / meta questions about the assistant itself
// ("kannst du …?", "can you …?", "what can you do?"). These are answered from
// the system's own configuration and never need fresh web sources, so a weak
// temporal word like "jetzt"/"now" inside them must not flip freshnessSensitive
// — that would force delegated research and dead-end the turn into an empty
// answer. The capability phrasing must co-occur with a self-reference term.
export const SELF_CAPABILITY_QUESTION_PATTERNS = [
  /\b(kannst|k[öo]nntest)\s+du\b/,
  /\bbist\s+du\s+(in\s+der\s+lage|f[äa]hig)\b/,
  /\b(was|welche)\s+(kannst|kann)\s+du\b/,
  /\bcan\s+you\b/,
  /\bare\s+you\s+(able|capable)\b/,
  /\bwhat\s+can\s+you\s+do\b/,
];

export const SELF_CAPABILITY_REFERENCE_TERMS = [
  "eigene", "eigenen", "eigener", "dich selbst", "selbst verbessern",
  "skill", "skills", "fähigkeit", "faehigkeit", "fähigkeiten", "faehigkeiten",
  "fertigkeit", "fertigkeiten", "lernen", "erlernen", "dazulernen",
  "yourself", "your own", "your skills", "your abilities", "ability", "abilities",
  "learn new",
];

export const SOURCE_HINT_TERMS = [
  "beleg", "belege", "offizielle quelle", "offizielle quellen", "quelle", "quellen",
  "cite", "cites", "citation", "citations", "docs", "documentation", "official", "release notes",
  "repo", "repository", "roadmap", "source", "sources", "spec", "specification", "standard",
  "validate", "validated", "validation", "verify", "verified", "verification",
  "validiere", "validieren", "verifiziere", "verifizieren", "prüfe", "pruefe",
];

// An explicit "research …" / "recherchiere …" command is the user asking for
// real, sourced research — not a from-memory answer. Honor it as source-
// sensitive so the swarm verifies instead of stating stale pre-assumptions.
// Matched as a leading imperative (or an explicit "research online" phrase) so
// it does not fire on incidental mentions like "I did some research on X".
export const RESEARCH_COMMAND_PATTERNS = [
  /^\s*(please\s+|bitte\s+|kannst du\s+|could you\s+)?(research|recherchier\w*|recherche)\b/i,
  /\b(research online|recherchiere online|search the web and|look (it|this|that) up online)\b/i,
];

// Availability / release / regional-access questions about a named product,
// service, model, or title ("warum ist Fable 5 nicht mehr in Deutschland
// verfügbar", "is X available in the EU", "when is X released"). These depend on
// current external facts the model cannot know from memory — without a source
// signal the model answers from (often hallucinated) priors (audit 2f4f5fe6
// turn 3: a "why is Fable 5 not available" question produced a fabricated
// video-game answer with no delegation). Each pattern requires an interrogative
// framing next to an availability term so it does not fire on incidental
// mentions of the words.
export const AVAILABILITY_QUESTION_PATTERNS = [
  /\b(warum|wieso|weshalb|why)\b[\s\S]{0,80}\b(verf[üu]gbar|erh[äa]ltlich|available|released?|erschien\w*|gesperrt|blockiert|blocked|restricted)\b/,
  /\b(ist|sind|wird|wann|is|are|when|will)\b[\s\S]{0,80}\b(verf[üu]gbar|erh[äa]ltlich|available|released?|launch(?:ed|es|ing)?)\b/,
  /\b(verf[üu]gbar|erh[äa]ltlich|available)\b[\s\S]{0,30}\b(in|f[üu]r|outside|au[sß]erhalb)\b/,
  /\bavailability of\b/,
  /\bverf[üu]gbarkeit (von|der|des)\b/,
];

export const PRODUCT_RECOMMENDATION_PATTERNS = [
  /\b(product suggestions?|component suggestions?|part suggestions?|module suggestions?|product recommendations?|component recommendations?)\b/,
  /\b(produkt(?:e|vorschl[äa]ge|empfehlungen)|bauteil(?:e|vorschl[äa]ge|empfehlungen)|modul(?:e|vorschl[äa]ge|empfehlungen))\b/,
  /\b(best|beste|recommend|recommended|recommendation|suggest|suggestions?|empfehl(?:e|ung|ungen)|vorschl[äa]ge?)\b[\s\S]{0,120}\b(module|modules|sensor|sensors|microphone|microphones|mic|mics|mcu|esp32|lipo|usb-c|charging|charger|laderegler|spannungsregler|mikrofon|mikrofone|bauteil|bauteile)\b/,
  /\b(module|modules|sensor|sensors|microphone|microphones|mic|mics|mcu|esp32|lipo|usb-c|charging|charger|laderegler|spannungsregler|mikrofon|mikrofone|bauteil|bauteile)\b[\s\S]{0,120}\b(best|beste|recommend|recommended|recommendation|suggest|suggestions?|empfehl(?:e|ung|ungen)|vorschl[äa]ge?)\b/,
];

// Noun shared between the two ordering patterns. Includes English and German
// vocabulary plus learning-content artifacts (fragekatalog, quiz, lernkartei,
// vollsimulation, etc.) that previously slipped through and got
// misclassified as pure "search online" tasks.
const ARTIFACT_NOUN_SUBPATTERN = (
  "(?:downloadable|download|artifact|artifacts|artefakt|artefakte|datei|file|" +
  "html\\s?page|html-seite|static\\s+site|website|webseite|blog|" +
  "how[- ]?to|anleitung|guide|svg|diagramm|grafik|grafiken|" +
  // Learning / training deliverables (the German "kannst du mir einen
  // Fragekatalog erstellen" pattern that derailed routing on first attempt):
  "fragekatalog|fragenkatalog|katalog|quiz|quizze|vollsimulation|simulation|" +
  "lernmaterial|lernmaterialien|lernkartei|lernkarten|karteikarten|" +
  "uebung|uebungen|übung|übungen|uebungsfragen|übungsfragen|" +
  "study\\s+guide|exam\\s+questions|flash\\s?cards?|question\\s+catalog|" +
  "learning\\s+materials?|practice\\s+questions?)"
);
const ARTIFACT_VERB_SUBPATTERN = (
  "(?:generate|create|build|make|write|render|export|save|" +
  "erstell(?:e|en)?|generier(?:e|en)?|speicher(?:e|n)?|exportier(?:e|en)?|" +
  "schreib(?:e|en)?|bau(?:e|en)?)"
);

export const ARTIFACT_DELIVERABLE_PATTERNS = [
  new RegExp(`\\b${ARTIFACT_NOUN_SUBPATTERN}\\b[\\s\\S]{0,140}\\b${ARTIFACT_VERB_SUBPATTERN}\\b`),
  new RegExp(`\\b${ARTIFACT_VERB_SUBPATTERN}\\b[\\s\\S]{0,140}\\b${ARTIFACT_NOUN_SUBPATTERN}\\b`),
  /\b(artifact|artifacts|artefakt|artefakte)\b[\s\S]{0,80}\b(see|view|visible|anzeigen|sehen|sichtbar|download|downloadable)\b/,
];

export const WEB_LOOKUP_HINT_TERMS = [
  "suche online", "such online", "suche im internet", "online suchen", "recherchiere online",
  "recherchiere im internet", "im internet suchen", "search online", "search the web",
  "web search", "online search", "look it up", "look this up", "find online", "check online",
];

export const MAIL_HINT_TERMS = [
  "e-mail", "e-mails", "email", "emails", "mail", "mails", "testmail",
  "inbox", "mailbox", "mailboxes", "posteingang", "postfach",
  "draft", "drafts", "entwurf", "entwürfe", "reply", "replies", "antwort", "antworten",
];

export const MAIL_TASK_PATTERNS = [
  /\b(schreib|schreibe|verfass|verfasse|send|sende|versend|versende|draft|entwurf|reply|antworte?)\b[\s\S]{0,60}\b(e-?mail|emails?|mails?)\b/,
  /\b(lese|lies|zeige|fass zusammen|zusammenfassung|summary|summarize)\b[\s\S]{0,60}\b(e-?mail|emails?|mails?|inbox|posteingang)\b/,
];

export const COMPUTER_ACCESS_HINT_TERMS = [
  "use my computer", "access my computer", "my computer", "my pc", "my machine",
  "remote windows pc", "remote pc", "remote desktop", "rdp", "vnc",
  "work on it", "work on my", "control my computer", "connect to my pc",
  "local desktop", "local windows desktop", "lokalen desktop", "localen desktop", "lokaler desktop",
];

export const OWNED_COMPUTER_ACCESS_PATTERNS = [
  /\b(my|our)\s+(remote\s+)?(windows\s+|linux\s+|mac\s+|macos\s+)?(pc|computer|machine|workstation|desktop|laptop)\b/,
  /\b(access|control|connect to|use|work on)\s+(my|our)\s+(remote\s+)?(windows\s+|linux\s+|mac\s+|macos\s+)?(pc|computer|machine|workstation|desktop|laptop)\b/,
];

export const SERVER_ACCESS_HINT_TERMS = [
  "my server", "our server", "n8n-server", "ssh into", "ssh to", "ssh on",
  "docker container", "docker containers", "docker ps", "docker compose",
  "systemctl", "journalctl", "kubectl", "server logs", "container logs",
];

export const SERVER_ACCESS_PATTERNS = [
  /\b(on|into|to)\s+(my|our)\s+(?:linux\s+|ubuntu\s+|debian\s+)?(?:server|host|vm|vps|instance)\b/,
  /\b(ssh|docker|systemctl|journalctl|kubectl)\b[\s\S]{0,80}\b(server|host|vm|vps|instance|container|containers|n8n(?:-server)?)\b/,
  /\b(server|host|vm|vps|instance|n8n(?:-server)?)\b[\s\S]{0,80}\b(docker|container|containers|systemctl|journalctl|ssh|logs?)\b/,
];

export const LOCAL_SERVER_CONFIG_PATTERNS = [
  /\/etc\/wireguard\/\w+\.conf/,
  /\ballowedips\s*=/,
  /\blistenport\s*=/,
  /\bpostup\s*=/,
  /\bpostdown\s*=/,
  /\bpublickey\s*=/,
  /\bprivatekey\s*=/,
  /\biptables\b/,
  /\broot@[\w.-]+:/,
  /\bpfsense\b/,
  /\bwireguard\b/,
];

// ── Inline-content analytical detection ──────────────────────────────────────
// When a user pastes substantial technical content inline (configs, code,
// command output) AND asks for explanation/tutorial/analysis of THAT content,
// the right path is direct synthesis — NOT delegating to a specialist to fetch
// or inspect live data the user already provided.  The classic failure mode
// (debug session 7b90ea2c, May 2026) was: user pastes a complete WireGuard
// config plus pfSense settings and asks for a tutorial; runtime delegates to
// shell_agent to inspect the live system; the container crashes; user sees a
// generic "please try again" placeholder instead of the tutorial that could
// have been written from the inline content alone.

/** Patterns that indicate the user pasted technical state inline. */
export const INLINE_TECHNICAL_CONTENT_PATTERNS = [
  /```[\s\S]{40,}?```/,                              // fenced code block with content
  /(?:^|\n)\s*(?:root|admin|user)?@?[\w.-]*[:#$>]\s+\S/, // shell prompt + command
  /(?:^|\n)\s*\[[\w-]+\][^\n]*\n[^\n]*=\s*\S/,        // INI-style section + key=value
  /\b(?:postup|postdown|allowedips|listenport|publickey|privatekey|persistentkeepalive)\s*=/i, // WireGuard
  /\b(?:server\s*\{|location\s+[/\w]+\s*\{|upstream\s+\w+\s*\{)/i,  // nginx blocks
  /\b(?:\[Service\]|\[Install\]|\[Unit\])\s*\n[\w]+=/,            // systemd unit
  /\b(?:apiVersion|kind|metadata|spec):\s*\S/,                    // k8s YAML
  /(?:^|\n)\s*\w[\w-]*\s*=\s*\S+(?:\n\s*\w[\w-]*\s*=\s*\S+){4,}/, // 5+ key=value lines
];

/** Patterns that indicate the user wants explanation, analysis, modification,
 *  or tutorial-style guidance about the content they provided. */
export const ANALYTICAL_REQUEST_PATTERNS = [
  /\b(explain|analyze|analyse|review|walk(?:\s+me)?\s+through|tutorial|how\s+(?:does|do)|what\s+(?:does|do)|what\s+should|what\s+must|why\s+(?:does|do)|fix\s+(?:this|the))\b/i,
  /\berkl[äa]r/i,                          // erklären, erklärt, erkläre
  /\banalysier/i,                          // analysiere, analysieren
  /\btutorial\b/i,
  /\banleitung\b/i,
  /\bwie\s+funktioniert\b/i,
  /\bwas\s+(?:macht|tut|bedeutet|bewirkt)\b/i,
  /\bwas\s+muss\s+ich\s+(?:anpassen|[äa]ndern|machen|tun|konfigurieren|hinzuf[üu]gen)\b/i,
  /\bwas\s+(?:soll|sollte)\s+ich\b/i,
  /\bwie\s+(?:kann|soll|muss)\s+ich\b/i,
  /\b(?:erstell|erzeug|generier)(?:e|en|t)?\s+(?:mir|uns)?\s*(?:ein|einen|eine)?\s*(?:tutorial|anleitung|guide|how[- ]?to)\b/i,
];

/** Detect substantial pasted technical content. Each pattern is strict
 *  enough on its own (a fenced code block requires 40+ chars of body, a
 *  multi-line key=value block requires 5+ pairs, etc.) that any match
 *  represents real pasted state.  A small message-length floor of 200
 *  chars filters out single-line "the error was: foo=bar" cases that
 *  the user is just describing rather than pasting wholesale. */
export function hasSubstantialInlineTechnicalContent(message: string): boolean {
  if (message.length < 200) return false;
  return INLINE_TECHNICAL_CONTENT_PATTERNS.some((pattern) => pattern.test(message));
}

/** Detect that the request is for explanation / analysis / tutorial /
 *  modification of provided content (vs. fetching new external state). */
export function looksLikeAnalyticalRequest(message: string): boolean {
  return ANALYTICAL_REQUEST_PATTERNS.some((pattern) => pattern.test(message));
}

export const PENTEST_HINT_TERMS = [
  "pentest", "pentesting", "penetration test", "penetration testing", "security test", "security assessment", "vulnerability", "vuln", "scan",
  "nmap", "nikto", "sqlmap", "exploit", "cve", "audit", "hardening",
];

export const PENTEST_METHODOLOGY_PATTERNS = [
  /\b(how would you|how do you|what plan|which plan|what schema|which schema|what methodology|which methodology|what workflow|which workflow)\b[\s\S]{0,80}\b(pentest|pentesting|penetration test|penetration testing|security assessment)\b/,
  /\b(pentest|pentesting|penetration test|penetration testing|security assessment|pentest-agent|pentest agent|pentest_coordinator)\b[\s\S]{0,80}\b(plan|schema|methodology|workflow|playbook|steps|phases|prompt)\b/,
  /\b(check|inspect|review|read|analyze|ask)\b[\s\S]{0,80}\b(pentest[_ -]?agent|pentest[_ -]?coordinator|prompt)\b/,
  /\b(do not want to do the pentest|don't want to do the pentest|not asking you to do the pentest|wanna know what schema it follows)\b/,
];

export const SWARM_MAINTENANCE_HINT_TERMS = [
  "agent set", "agent-set", "agents-set", "main agent", "main-agent", "sub agent", "sub-agent", "subagent",
  "tool set", "tool-set", "toolset", "workspace/agents", "workspace/scenes", "workspace/jobs",
  "config assistant", "self tune", "self-tune", "system prompt", "prompt optimizer",
  "routing prompt", "workflow definition", "scene definition", "job definition", "swarm", "starlingai itself",
];

export const SWARM_MAINTENANCE_PATTERNS = [
  /\b(implement|add|update|improve|change|modify|wire|integrate|refine|fix)\b[\s\S]{0,100}\b(agent|agents|sub-?agents?|toolset|tool set|tools|prompt|system prompt|routing|main agent|main-assistant|swarm)\b/,
  /\b(toolset|tool set|agent set|agents-set|main agent|main-agent|workspace\/agents|config assistant)\b[\s\S]{0,100}\b(implement|update|improve|change|modify|fix|wire|integrate)\b/,
  /\b(create|add|generate|build|define|author)\b[\s\S]{0,100}\b(new\s+)?(scene|scenes|job|jobs|worflow|worflows|workflow|workflows|playbook|playbooks)\b/,
  /\b(edit|update|modify|change|fix|refine|improve)\b[\s\S]{0,100}\b(scene|scenes|job|jobs|worflow|worflows|workflow|workflows|playbook|playbooks)\b/,
  /\b(erstell(?:e|en|t)?|erzeuge?|generier(?:e|en|t)?|baue?|füge|fuege|lege\s+an|anlegen)\b[\s\S]{0,100}\b(neuen?\s+|neue\s+|neues\s+)?(scene|scenes|job|jobs|worflow|worflows|workflow|workflows|playbook|playbooks)\b/,
  /\b(neuen?|neue|neues)\b[\s\S]{0,40}\b(scene|scenes|job|jobs|worflow|worflows|workflow|workflows|playbook|playbooks)\b/,
  /\b(why|check why|investigate why)\b[\s\S]{0,120}\b(does not want to implement|won't implement|refuses to implement|cannot implement|can not implement)\b/,
  /\b(not asking you to use the system|asking you to improve the system|improve starlingai|update starlingai|maintain the swarm)\b/,
];

export const WORKFLOW_HINT_TERMS = [
  "catalog", "catalogue", "chain", "job", "jobs", "playbook", "playbooks",
  "reusable", "reuse", "scene", "scenes", "worflow", "worflows", "workflow", "workflows",
];

export const WORKFLOW_ACTION_TERMS = [
  "chain", "combine", "execute", "find", "launch", "list", "orchestrate",
  "reuse", "run", "search", "show", "start", "trigger", "use",
];

export const WORKFLOW_DELIVERABLE_HINT_TERMS = [
  "api", "brief", "broadcast", "compare", "comparison", "diagram", "dossier",
  "inspection", "packet", "paper", "report", "research", "review", "suite",
  "test", "tests", "visual",
];

export const WORKFLOW_REQUEST_PATTERNS = [
  /\b(search|find|list|show|inspect|check)\b[\s\S]{0,80}\b(scene|scenes|job|jobs|workflow|workflows|playbook|playbooks|catalog|catalogue)\b/,
  /\b(run|execute|start|launch|trigger|use|reuse|chain|combine|orchestrate)\b[\s\S]{0,80}\b(scene|scenes|job|jobs|workflow|workflows|playbook|playbooks)\b/,
  /\b(scene|scenes|job|jobs|workflow|workflows|playbook|playbooks)\b[\s\S]{0,80}\b(run|execute|start|launch|trigger|use|reuse|chain|combine|orchestrate)\b/,
  /\b(specific|existing|available|reusable)\b[\s\S]{0,40}\b(scene|job|workflow|playbook)\b/,
  /\bchain\b[\s\S]{0,40}\b(them|these|workflows?|jobs?|scenes?)\b/,
];

// (Removed: WORKFLOW_DISCOVERY_STOP_WORDS.) The previous workflow-catalog detector
// scored token overlap between the user message and a concatenated scene/job
// blob, requiring an ever-growing stop-word list to suppress noise (German
// pronouns, infra config keys, shell command names, ...). The new detector in
// runtime.ts uses opt-in regex triggers per scene/job, so the noise-token
// suppression list is no longer needed.


export const AMBIGUOUS_SHORT_LANGUAGE_TOKENS = new Set([
  "ahoi",
  "aloha",
  "bonjour",
  "ciao",
  "hello",
  "hey",
  "hi",
  "hallo",
  "moin",
  "ok",
  "okay",
  "servus",
  "yo",
]);

// ── Durable-memory persistence detection ─────────────────────────────────────
// Statements that establish something meant to OUTLIVE this session — naming
// the assistant, lasting preferences, standing instructions. Models tend to
// acknowledge such turns conversationally and persist nothing until the user
// adds an explicit "remember that" (observed live: "dein Name ist ab jetzt
// Luna" → name acknowledged but not stored until told to remember it). These
// patterns trigger guidance to persist in the SAME turn.
const ASSISTANT_NAMING_PATTERNS: readonly RegExp[] = [
  /\bdein name (?:ist|sei|lautet|wird)\b/,
  /\bdu hei(?:ß|ss)t (?:ab )?(?:jetzt|sofort|nun)\b/,
  // Verb-subject inversion: "Ab jetzt heißt du Luna" (the most common phrasing —
  // previously unmatched, so the turn only got generic durable-memory guidance).
  /\bhei(?:ß|ss)t du\b/,
  /\bich (?:nenne|taufe) dich\b/,
  /\b(?:werde|will) dich .{1,40}? nennen\b/,
  /\byour name is(?: now)?\b/,
  /\bi(?:'ll| will) call you\b/,
  /\byou are (?:now )?called\b/,
  // "ab jetzt bist du Luna" / "du bist (jetzt) Luna" — the German "you ARE X"
  // rename form (audit a6668324: `ab jetzt bist du "Luna"` was acknowledged but
  // never persisted). Broad here, but harmless: assistantNamingSensitive AND the
  // deterministic persist both gate on extractAssistantName, which requires a
  // QUOTED name for this form (German capitalizes every noun, so an unquoted
  // "du bist Entwickler" must NOT read as a rename).
  /\bbist du\b/,
  /\bdu bist\b/,
];

// Capturing variants used to extract the actual name for deterministic
// persistence (see extractAssistantName). Each captures the name token in $1.
const ASSISTANT_NAMING_CAPTURE_PATTERNS: readonly RegExp[] = [
  /\bhei(?:ß|ss)t\s+du\s+["“”'»]?\s*([\p{L}][\p{L}\p{M}\d_-]{1,39})/iu,
  /\bdu\s+hei(?:ß|ss)t(?:\s+(?:ab|jetzt|sofort|nun))*\s+["“”'»]?\s*([\p{L}][\p{L}\p{M}\d_-]{1,39})/iu,
  /\bdein\s+name\s+(?:ist|sei|lautet|wird)(?:\s+(?:ab|jetzt|nun))*\s+["“”'»]?\s*([\p{L}][\p{L}\p{M}\d_-]{1,39})/iu,
  /\b(?:nenne|taufe)\s+dich(?:\s+ab\s+jetzt)?\s+["“”'»]?\s*([\p{L}][\p{L}\p{M}\d_-]{1,39})/iu,
  /\byour\s+name\s+is(?:\s+now)?\s+["“”'«]?\s*([\p{L}][\p{L}\p{M}\d_-]{1,39})/iu,
  /\bi(?:'ll|\s+will)\s+call\s+you\s+["“”'«]?\s*([\p{L}][\p{L}\p{M}\d_-]{1,39})/iu,
  /\byou\s+are\s+(?:now\s+)?called\s+["“”'«]?\s*([\p{L}][\p{L}\p{M}\d_-]{1,39})/iu,
  // "ab jetzt bist du \"Luna\"" / "du bist (jetzt) \"Luna\"" — QUOTE REQUIRED.
  // Unlike "heißt du X" (where the verb unambiguously introduces a name), German
  // "du bist X" + noun-capitalization is ambiguous, so only an explicitly quoted
  // name counts as a rename here.
  /\b(?:du\s+)?bist\s+(?:du\s+)?(?:ab\s+|jetzt\s+|sofort\s+|nun\s+)*["“”'«»]\s*([\p{L}][\p{L}\p{M}\d_-]{1,39})/iu,
];

// Common words that follow a naming phrase but are NOT names — guards the
// extractor against e.g. "heißt du wirklich so?" capturing "wirklich".
const NON_NAME_TOKENS = new Set([
  "wirklich", "eigentlich", "so", "denn", "nicht", "jetzt", "now", "not", "really",
  "ab", "der", "die", "das", "ein", "eine", "the", "a", "an", "you", "du", "wie",
]);

/**
 * Extract the assistant name from an explicit naming command, or undefined.
 * Conservative: the name must be quoted OR capitalized (a proper-noun signal),
 * and not a known filler word. Used by the runtime to persist the name
 * deterministically — local models tend to *acknowledge* a rename ("saved!")
 * without ever calling assistant_personality_update (audit b71523fb: "Ab jetzt
 * heißt du Luna" → claimed saved, toolCalls=0, nothing persisted).
 */
export function extractAssistantName(message: string): string | undefined {
  const text = message.trim();
  for (const re of ASSISTANT_NAMING_CAPTURE_PATTERNS) {
    const match = re.exec(text);
    const captured = match?.[1];
    if (!captured) continue;
    const quoted = /["“”'«»]/.test(match![0]);
    const name = captured.replace(/["“”'»«]+$/u, "").trim();
    if (name.length < 2) continue;
    if (NON_NAME_TOKENS.has(name.toLowerCase())) continue;
    // Require a proper-noun signal: quoted in the message, or capitalized.
    if (!quoted && !/^\p{Lu}/u.test(name)) continue;
    return name.charAt(0).toUpperCase() + name.slice(1);
  }
  return undefined;
}
const DURABLE_PREFERENCE_PATTERNS: readonly RegExp[] = [
  /\b(?:ab jetzt|ab sofort|von nun an|in zukunft|zuk(?:ü|u)nftig|k(?:ü|u)nftig)\b/,
  /\b(?:from now on|going forward|for future reference)\b/,
  /\bich bevorzuge\b/,
  /\bi prefer\b/,
  /\bmerke? dir\b/,
  /\bremember (?:that|this|my)\b/,
];

// ── DynamicTurnGuidance ───────────────────────────────────────────────────────

export interface DynamicTurnGuidance {
  prompt: string;
  sourceSensitive: boolean;
  freshnessSensitive: boolean;
  mailSensitive?: boolean;
  computerAccessSensitive?: boolean;
  serverAccessSensitive?: boolean;
  pentestSensitive?: boolean;
  pentestMethodologySensitive?: boolean;
  swarmMaintenanceSensitive?: boolean;
  artifactSensitive?: boolean;
  /** User pasted substantial technical content inline AND asked for
   *  explanation/analysis/tutorial — runtime should bias toward direct
   *  synthesis rather than delegating to fetch live state. */
  inlineAnalyticalContent?: boolean;
  /** The user stated something durable (lasting preference, standing
   *  instruction, naming) that should be persisted THIS turn without
   *  waiting for an explicit "remember this". */
  durableMemorySensitive?: boolean;
  /** Subset of durableMemorySensitive: the user is naming/renaming the
   *  assistant itself → assistant_personality_update, not memory_store. */
  assistantNamingSensitive?: boolean;
}

/**
 * Classify a user message and build prompt guidance injected into the system
 * prompt for the current turn.  Returns null when no guidance is needed
 * (generic message with no detectable intent signals).
 */
/**
 * Word-START aware membership test. Requires a leading word boundary so short
 * terms don't match mid-word — e.g. "now" must not match "know"/"known", "live"
 * must not match "delivery"/"alive", "new" must not match "knew"/"renew" — while
 * still allowing trailing suffixes so German declensions are caught ("aktuell"
 * matches "aktuellen", "neueste" matches "neuesten"). Multi-word phrases are
 * matched verbatim.
 */
function includesTermAtWordStart(normalized: string, terms: readonly string[]): boolean {
  return terms.some((term) => {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}`, "u").test(normalized);
  });
}

export function buildDynamicTurnGuidance(userMessage: string, toolMode: MainAssistantToolMode = getConfig().agents.mainAssistant.toolMode): DynamicTurnGuidance | null {
  const normalized = userMessage.trim().toLowerCase();
  if (!normalized) return null;

  const freshnessSensitiveByTerm = includesTermAtWordStart(normalized, FRESHNESS_HINT_TERMS);
  // Self-referential capability question — suppresses freshness so a weak
  // "jetzt"/"now" cannot force delegated research for a meta question.
  const selfCapabilityQuestion =
    SELF_CAPABILITY_QUESTION_PATTERNS.some((pattern) => pattern.test(normalized))
    && SELF_CAPABILITY_REFERENCE_TERMS.some((term) => normalized.includes(term));
  // Split the source-sensitive signal into the two intents it actually
  // conflates: explicit verification (cite/validate/verify, product
  // recommendations needing evidence) vs. a simple "look it up" request.
  // Both still need web access, but only the verification half should
  // force the SOURCE-SENSITIVE DELEGATION routing prefix that routes
  // tasks to source_verifier-class agents.
  const sourceVerificationByTerm = SOURCE_HINT_TERMS.some((term) => normalized.includes(term))
    || PRODUCT_RECOMMENDATION_PATTERNS.some((pattern) => pattern.test(normalized))
    || RESEARCH_COMMAND_PATTERNS.some((pattern) => pattern.test(normalized));
  // A URL in the request is a language-independent STRUCTURAL signal that external
  // content must be FETCHED: the orchestrator (no direct web tools in this mode) must
  // route to a web-capable specialist to read it, not dead-end with "I can't access
  // websites" and ask the user to paste it (audit 021d67c3: "erstelle ein Preisangebot
  // zu dieser Anzeige: <freelancermap URL>" matched ZERO keyword patterns → null guidance
  // → direct refusal). Keyed on the URL's presence, not on any topic/intent lexicon. The
  // inlineReview suppression below still applies when the user PASTED the content.
  const containsActionableUrl = /\bhttps?:\/\/[^\s<>"'`)\]]+/i.test(userMessage);
  const webLookupByTerm = WEB_LOOKUP_HINT_TERMS.some((term) => normalized.includes(term)) || containsActionableUrl;
  // Availability/release/regional-access questions need current external facts.
  // Suppressed when the subject is the assistant itself ("are you available",
  // "bist du verfügbar") so a meta/small-talk question is not forced into web
  // research. \byou\b does not match "your", so "is your product available …"
  // stays a real availability question.
  const selfAvailabilityQuestion =
    /\b(you|du|dir|euch|ihr)\b[\s\S]{0,20}\b(available|verf[üu]gbar|free|da|zeit|time)\b/.test(normalized)
    || /\b(available|verf[üu]gbar|free)\b[\s\S]{0,12}\b(you|du)\b/.test(normalized);
  const availabilityQuestion = !selfCapabilityQuestion && !selfAvailabilityQuestion
    && AVAILABILITY_QUESTION_PATTERNS.some((pattern) => pattern.test(normalized));
  const sourceSensitiveByTerm = sourceVerificationByTerm || webLookupByTerm || availabilityQuestion;
  const mailSensitive = MAIL_HINT_TERMS.some((term) => normalized.includes(term))
    || MAIL_TASK_PATTERNS.some((pattern) => pattern.test(normalized));
  const localServerConfigEvidence = LOCAL_SERVER_CONFIG_PATTERNS.some((pattern) => pattern.test(normalized));
  const serverAccessSensitive = SERVER_ACCESS_HINT_TERMS.some((term) => normalized.includes(term))
    || SERVER_ACCESS_PATTERNS.some((pattern) => pattern.test(normalized))
    || localServerConfigEvidence;
  const computerAccessSensitive = !serverAccessSensitive && (
    COMPUTER_ACCESS_HINT_TERMS.some((term) => normalized.includes(term))
    || OWNED_COMPUTER_ACCESS_PATTERNS.some((pattern) => pattern.test(normalized))
  );
  const pentestSensitive = PENTEST_HINT_TERMS.some((term) => normalized.includes(term));
  const pentestMethodologySensitive = pentestSensitive
    && PENTEST_METHODOLOGY_PATTERNS.some((pattern) => pattern.test(normalized));
  const swarmMaintenanceSensitive = SWARM_MAINTENANCE_HINT_TERMS.some((term) => normalized.includes(term))
    || SWARM_MAINTENANCE_PATTERNS.some((pattern) => pattern.test(normalized));
  const artifactSensitive = ARTIFACT_DELIVERABLE_PATTERNS.some((pattern) => pattern.test(normalized));
  // A naming turn is durable-memory-sensitive only when a name is actually being
  // ASSIGNED (a command), not merely asked about. "wie heißt du?" matches the
  // `heißt du` pattern too, but it's a QUESTION — no memory write, and the
  // receptionist capsule already carries the assistant name, so it must stay
  // fast-lane-eligible. Gating on extractAssistantName (the same signal the
  // deterministic persist keys on) cleanly separates command from question:
  // a command yields an extractable name, a question yields none (audit
  // acdd6cda: "Hi; wie heißt du?" took 21.8s on the full path because this flag
  // fired and skipped the fast lane).
  const assistantNamingSensitive = ASSISTANT_NAMING_PATTERNS.some((pattern) => pattern.test(normalized))
    && extractAssistantName(userMessage) !== undefined;
  const durableMemorySensitive = assistantNamingSensitive
    || DURABLE_PREFERENCE_PATTERNS.some((pattern) => pattern.test(normalized));
  // ── Inline-content analytical detection ──────────────────────────────────
  // Use the original userMessage (case-preserving) for the technical-content
  // patterns since some matchers (`[Interface]`, `[Service]`, fenced code
  // blocks) depend on case / leading delimiters that survive the lowercase
  // normalization but are clearer to reason about against the raw text.
  const inlineAnalyticalContent =
    hasSubstantialInlineTechnicalContent(userMessage)
    && looksLikeAnalyticalRequest(userMessage)
    // Don't fire when the user explicitly asked for verification / source
    // checks — those genuinely need delegation to fetch external truth.
    && !sourceSensitiveByTerm
    && !WEB_LOOKUP_HINT_TERMS.some((term) => normalized.includes(term));
  const localServerConfigReview = serverAccessSensitive
    && !sourceSensitiveByTerm
    && !WEB_LOOKUP_HINT_TERMS.some((term) => normalized.includes(term))
    && localServerConfigEvidence;
  // Either review path overrides freshness/source sensitivity — the user
  // already pasted the state, we don't need to fetch fresh sources.
  const inlineReview = localServerConfigReview || inlineAnalyticalContent;
  // Research-then-create: an artifact-creation request that asked the agent
  // to "search online" / "look it up" but did NOT ask for explicit
  // verification, citation, or product recommendation. Keeping
  // sourceSensitive=true here routes the whole job through source_verifier,
  // which has no creation tools and BLOCKS — observed live in session
  // 006ca6bf turn 1 ("kannst du mir einen Fragekatalog … erstellen? Suche
  // online …"). Relax so the bidding system can pick an
  // artifact-and-research-capable agent (mission_coordinator, researcher +
  // content_writer chain, etc.) instead.
  const researchThenCreate = artifactSensitive && webLookupByTerm && !sourceVerificationByTerm;
  const freshnessSensitive = (inlineReview || selfCapabilityQuestion) ? false : freshnessSensitiveByTerm;
  const sourceSensitive = (inlineReview || researchThenCreate) ? false : sourceSensitiveByTerm;

  const flags = { freshnessSensitive, sourceSensitive, mailSensitive, computerAccessSensitive, serverAccessSensitive, pentestMethodologySensitive, swarmMaintenanceSensitive, artifactSensitive, inlineAnalyticalContent, durableMemorySensitive };
  if (!Object.values(flags).some(Boolean)) return null;

  const reasons: string[] = [];
  if (freshnessSensitive) reasons.push("freshness-sensitive");
  if (sourceSensitive) reasons.push("source-sensitive");
  if (mailSensitive) reasons.push("mail-task");
  if (computerAccessSensitive && !pentestSensitive) reasons.push("owned-computer-access");
  if (serverAccessSensitive && !pentestSensitive) reasons.push("server-admin-access");
  if (pentestMethodologySensitive) reasons.push("pentest-methodology");
  if (swarmMaintenanceSensitive) reasons.push("swarm-maintenance");
  if (artifactSensitive) reasons.push("artifact-deliverable");
  if (inlineAnalyticalContent) reasons.push("inline-analytical-content");
  if (durableMemorySensitive) reasons.push("durable-memory");

  const delegateMode = toolMode !== "hybrid";
  const promptParts: string[] = [];

  if (reasons.length > 0) {
    promptParts.push(`This turn is ${reasons.join(" and ")}.`);
  }

  if (durableMemorySensitive) {
    promptParts.push(
      assistantNamingSensitive
        ? "The user is giving YOU (the assistant) a name or changing it. That IS an explicitly requested durable personality change: call assistant_personality_update in THIS turn to set the preferred assistant name, then answer using that name. Do NOT wait for the user to say 'remember this'."
        : "The user just stated something durable — a lasting preference, standing instruction, or fact meant to apply beyond this session. Persist it in THIS turn with memory_store (kind 'preference' or 'fact'; scope 'user' for cross-workspace personal preferences when a user is signed in, otherwise 'workspace') alongside your answer. Do NOT wait for an explicit 'remember this'.",
      "Acknowledge what you saved in one short clause of your reply instead of asking whether to save it.",
      "If on reflection the statement only concerns the current task and is not durable, skip the store and just answer.",
    );
  }

  if (computerAccessSensitive && !pentestSensitive) {
    promptParts.push(
      "The user is asking you to access or operate their own computer or remote workstation, not to run a security assessment.",
      "Do not route this request to pentest_set_scope, nmap_scan, or other pentest tools unless the user explicitly asks for scanning, vulnerability testing, or exploitation.",
      "You MUST use the delegate_to_agent tool with agentName='computer_use_agent' to handle all computer-use and VS Code interaction tasks. Pass the full user request as the task, including any specific targets like window titles, input fields, or text to type. If the user mentions a specific IP or hostname, include it in the task context so the agent can match it to a configured node or create an ad-hoc connection.",
      "Do NOT attempt to call computer_* or vscode_* tools directly — they are NOT in your tool set. Do NOT call 'computer_use_agent' as a tool name — it is an agent, not a tool. Use delegate_to_agent(agentName='computer_use_agent', task='...') instead.",
      "The computer_use_agent has access to computer_list_nodes which discovers pre-configured machines. If the user asks for a specific machine by IP, hostname, or description, include that in the delegation context. The agent will match it to a node or create an ad-hoc connection.",
      "If the user asks for their local desktop or local Windows desktop, include in the task context that the computer_use_agent should prefer adapter 'remote_node' rather than 'local_vscode' unless the user explicitly asked to control the VS Code workbench itself.",
      "If delegation to computer_use_agent returns a partial or incomplete result, you may retry delegation ONCE with a more specific task description. Do NOT fall back to calling computer_* tools directly — they are NOT in your tool set and will fail.",
      "CRITICAL: If the computer_use_agent has already failed or been exhausted for this turn, do NOT retry it again. Synthesize from whatever partial results you have and tell the user what happened.",
      "Do NOT delegate a desktop/remote-PC/screenshot task to browser_agent, researcher, or any other non-computer-use agent. Only computer_use_agent can interact with the user's desktop. If it failed, report the failure honestly instead of routing to an agent that cannot see the desktop.",
      "Ignore prior pentest-related tool results unless the user explicitly switches back to security testing.",
    );
  }

  if (inlineAnalyticalContent) {
    // Fires BEFORE the server/computer access blocks so the "answer
    // directly from inline content" guidance reaches the model first.
    // Common case: user pastes a complete config + asks for a tutorial /
    // walkthrough / "what should I change" — the wrong path is to
    // delegate to a sub-agent that re-fetches the same state from a
    // live system.  Direct synthesis from the inline content is the
    // right answer.
    promptParts.push(
      "The user has pasted substantial technical content (configuration, code, command output, structured state) directly into their message.",
      "Their request is to explain, analyze, modify, or produce a tutorial / walkthrough about THAT inline content — NOT to inspect a remote system or fetch external state.",
      "Answer directly from the inline content using your knowledge of the relevant technology. Treat the pasted content as the authoritative current state for this turn.",
      "Do NOT delegate to shell_agent, ops_triage, browser_agent, computer_use_agent, or any specialist that would fetch the same state the user already provided.",
      "Do NOT delegate to researcher / web_task_coordinator / mission_coordinator to look up the underlying technology unless the user explicitly asked for source citations, official documentation, or external verification.",
      "Code execution or file inspection tools are still OK if you need to validate a draft snippet or run a small computation, but the goal is direct synthesis from the inline content.",
      "If the user explicitly switches focus mid-turn to live state ('but is the iptables rule actually loaded right now?', 'check if the service is running'), THEN delegation is appropriate. Until then, write the answer.",
    );
  }

  if (serverAccessSensitive && !pentestSensitive && !inlineAnalyticalContent) {
    promptParts.push(
      "The user is asking for access to a headless server, SSH host, VM, or container runtime, not for remote desktop control.",
      "Requests involving SSH, Docker, containers, systemd, journalctl, kubectl, logs, or server status are infrastructure tasks, not computer-use tasks.",
      "Do NOT route this request to computer_use_agent unless the user explicitly asks for desktop or UI interaction on that machine.",
      "For straightforward remote command execution such as 'docker ps', 'systemctl status', 'journalctl', 'df -h', or similar SSH commands, use delegate_to_agent with agentName='shell_agent'.",
      "For diagnosing service failures, unhealthy containers, deployment issues, or log-driven runtime problems on a server, use delegate_to_agent with agentName='ops_triage'.",
      "If the user names a host or IP for SSH/server work, include that host in the delegation context and keep the task in the server/CLI path rather than the desktop/computer-use path.",
      "Use pentest tools only if the user explicitly asks for a security assessment or vulnerability testing.",
    );
  }

  if (mailSensitive) {
    promptParts.push(
      "The user is asking for mailbox access, inbox triage, draft preparation, or sending email.",
      "Do NOT answer that you cannot access email or send mail if the mail_agent is available. This system has a dedicated mail_agent for those tasks.",
      "You MUST use the delegate_to_agent tool with agentName='mail_agent' for reading recent emails, searching inboxes, preparing drafts, and mailbox triage.",
      "If the user asks to send an email, route the task to mail_agent so it can prepare the draft first. Sending itself must go through mail_send_draft and requires explicit per-call approval; do not claim sending is impossible.",
      "If the target account is ambiguous, have mail_agent inspect the available mail accounts or ask one concise clarification question.",
    );
  }

  if (artifactSensitive) {
    promptParts.push(
      "The user is asking for a durable downloadable or viewable artifact, not just inline text.",
      delegateMode
        ? "You MUST use an orchestration tool to route the artifact creation to a specialist. For HTML pages, how-to blogs, documentation pages, or static websites, prefer delegate_to_agent with agentName='content_writer'. For standalone diagrams or SVGs, prefer image_generator when that is the exact deliverable."
        : "Use a visible artifact-producing tool such as generate_document, generate_website, generate_svg, or export_workspace_artifact instead of pasting the full artifact source into chat. Only use write_file inside a delegated specialist that actually has write_file in its provided tool schema.",
      "Do NOT paste a full HTML/SVG/document artifact as the main chat response. The chat response should be a concise summary plus the saved artifact path or download card details.",
      "If the artifact depends on prior discussion context, pass the relevant context into the specialist task so it can build the file from the established design rather than restarting the conversation.",
    );
  }

  if (pentestMethodologySensitive) {
    promptParts.push(
      "The user is asking about the pentest plan, methodology, configured workflow, or pentest-agent behavior. This is NOT a request to start a live pentest engagement.",
      "Do NOT ask for authorization, target scope, asset-owner confirmation, or testing windows unless the user explicitly switches to running a real engagement.",
      delegateMode
        ? "Use delegation to inspect or explain the configured pentest workflow. Prefer pentest_coordinator in maintenance mode, or another specialist that can inspect local config and docs, instead of treating this as a live assessment request."
        : "Inspect the local pentest definitions and docs first. Prefer reading workspace/agents/30-subagents-pentest.jsonc and starlingai.example.json before answering.",
      "Summarize the actual configured phases, approval gates, and specialist handoffs. If a previous answer incorrectly asked for authorization for a methodology question, say that plainly and then give the plan.",
      "Do not call pentest_set_scope, nmap_scan, nikto_scan, sqlmap_scan, metasploit_exec, pentest_exec, or other active pentest tools for this kind of request.",
    );
  }

  if (swarmMaintenanceSensitive) {
    promptParts.push(
      "The user is asking you to improve StarlingAI itself: prompts, agents, tool routing, workspace behavior, or swarm configuration.",
      "Treat this as swarm maintenance inside the current repository, not as an external deployment-only request.",
      delegateMode
        ? "You MUST use the delegate_to_agent tool with agentName='swarm_maintainer' immediately when that agent exists. Pass the full user request as the task."
        : "Inspect the local workspace definitions first and handle the change directly when your tool set allows it.",
      delegateMode
        ? "Do NOT call search_agents, list_agents, search_workflows, or run_workflow first for this class of request when swarm_maintainer exists. The specialist is already known, and scene/job changes are authoring work rather than workflow execution."
        : "Do not waste time on agent or workflow discovery for this class of request.",
      delegateMode
        ? "Prefer swarm_maintainer for the full request; use prompt_optimizer for narrowly prompt-only work and integration_builder or qa_guard only when a more specific implementation specialist is clearly better."
        : "Inspect the local workspace definitions first. Prefer reading workspace/agents/*, workspace/scenes/*, and starlingai.example.json before answering.",
      "Do NOT claim that you cannot modify the toolset or agent set when the requested change is achievable through repository edits under workspace/ or other writable project files.",
      "Protected infrastructure paths under config/ still require proposal-only handling or a clearly scoped manual step; do not rewrite that boundary.",
      "If the request is to change prompts or routing behavior, make the smallest concrete repo change instead of stopping at a conceptual design.",
      "After implementing or proposing the change, summarize exactly what changed and what still needs build, apply, or approval steps.",
    );
  }

  if (freshnessSensitive || sourceSensitive) {
    promptParts.push(
      delegateMode
        ? "Do not answer from memory. Delegate immediately to a suitable specialist agent for any web lookup, freshness-sensitive fact, or browser-dependent step."
        : "Use direct web tools before answering if they are available.",
      "A tool-free answer is invalid unless prior tool results already contain the necessary evidence for this exact request.",
      delegateMode
        ? "First DECIDE whether fulfilling this request takes more than one step — e.g. gather sourced facts AND THEN build or produce a separate deliverable from them (a website, web app, document, slide deck, chart), or research plus analysis plus synthesis. If it is genuinely multi-step, delegate to mission_coordinator (it sequences research → build → one quality pass and hands the build to the right builder); do NOT send a multi-step build request to a lone researcher, which can only gather facts and will leave the deliverable unbuilt. Use delegate_to_agent to a single specialist only for a genuinely single-step request."
        : "Start with web_search. Use web_fetch only if the search snippets are insufficient.",
      delegateMode
        ? "For broad current-source deliverables like comprehensive guides, comparisons, audits, hardware/product recommendations, verified component lists, or step-by-step reports, prefer mission_coordinator. Reserve web_task_coordinator for live single-shot lookups such as news, weather, scores, lottery numbers, stock quotes, or browser-heavy workflows."
        : "For broad current-source deliverables like comprehensive guides, comparisons, audits, hardware/product recommendations, verified component lists, or step-by-step reports, gather evidence from multiple sources before drafting the answer. If you choose to delegate, prefer mission_coordinator over a web-only coordinator when that specialist exists.",
      delegateMode
        ? "If the deliverable is a source-grounded paper, brief, report, or merged written artifact that needs drafting plus a quality gate, prefer mission_coordinator over a lone researcher or a web-only coordinator. Reserve web_task_coordinator for retrieval- or browser-heavy web workflows."
        : "If the deliverable is a source-grounded paper, brief, report, or merged written artifact that needs drafting plus a quality gate, plan the research, drafting, and review phases explicitly instead of treating it as a single lookup.",
      "For live factual values such as lottery numbers, prices, scores, exchange rates, dates, or schedules, copy the exact value and its associated date from the freshest tool result. Do not substitute prior knowledge or older values.",
      delegateMode
        ? "If a page is JS-driven, route it through a browser specialist. If another agent needs the extracted evidence, ensure the browser specialist publishes key facts with share_finding so downstream agents can read them via read_shared_facts."
        : "If a page appears JS-driven or incomplete in web_fetch, use browser_navigate and then browser_snapshot or browser_wait_for to inspect the rendered page.",
      delegateMode
        ? "Do not stop after a browser snapshot. Route the snapshot findings to an evidence-analysis or summarization specialist when interpretation is required."
        : "Do not claim that a site is unreadable due to JavaScript or dynamic loading unless browser tools were attempted and still failed to reveal the needed data.",
      "Prefer official specifications, repositories, release notes, and vendor documentation over commentary.",
      "If the gathered evidence is incomplete, say that clearly and ask a concise follow-up question only when missing information blocks a correct answer.",
    );
  }

  return {
    prompt: promptParts.join(" "),
    sourceSensitive,
    freshnessSensitive,
    mailSensitive,
    computerAccessSensitive,
    serverAccessSensitive,
    pentestSensitive,
    pentestMethodologySensitive,
    swarmMaintenanceSensitive,
    artifactSensitive,
    inlineAnalyticalContent,
    durableMemorySensitive,
    assistantNamingSensitive,
  };
}

// ── Language / identity guidance ──────────────────────────────────────────────

export function buildLanguageAndIdentityTurnGuidance(userMessage: string): string {
  const profile = loadMainAssistantPersonality();
  const compactMessage = userMessage.trim().replace(/\s+/g, " ").slice(0, 280);
  const languageInstruction = compactMessage.length > 0
    ? buildLanguageInstructionForTurn(compactMessage)
    : "Reply in German.";
  const behaviorInstruction = shouldDefaultToGermanForMessage(compactMessage)
    ? "For short or greeting-only openings, reply with one short, polite sentence and move directly to helping. Do not use small talk. Do not introduce yourself or mention your name unless the user explicitly asks."
    : "Be polite, brief, and efficient. Avoid small talk, filler, and unnecessary pleasantries. Do not introduce yourself or mention your name unless the user explicitly asks. The user already knows they are speaking to the assistant.";
  const nameInstruction = profile.identity.name
    ? `If the user explicitly asks for your name or what to call you, use ${JSON.stringify(profile.identity.name)} as your assistant name. Do not call yourself ${JSON.stringify(PRODUCT.name)} in conversation unless the user is explicitly asking about the product or platform name.`
    : `Do not use the platform name ${JSON.stringify(PRODUCT.name)} as your personal name in conversation. If the user did not ask for your name, reply without naming yourself.`;
  return `Language and identity for this turn: ${languageInstruction} ${behaviorInstruction} ${nameInstruction}`;
}

export function shouldDefaultToGermanForMessage(userMessage: string): boolean {
  const compactMessage = userMessage.trim().toLowerCase().replace(/\s+/g, " ");
  if (!compactMessage) return true;

  const letterCount = Array.from(compactMessage).filter((char) => /\p{L}/u.test(char)).length;
  if (letterCount < 3) return true;

  // Single-word or very short messages that are ambiguous greetings
  const tokens = compactMessage.split(/\s+/);
  if (tokens.length <= 2 && tokens.every((token) => AMBIGUOUS_SHORT_LANGUAGE_TOKENS.has(token))) {
    return true;
  }

  return false;
}

export function buildLanguageInstructionForTurn(userMessage: string): string {
  const compactMessage = userMessage.trim().replace(/\s+/g, " ").slice(0, 280);
  if (!compactMessage) return "Reply in German.";
  if (shouldDefaultToGermanForMessage(compactMessage)) {
    return `The user's latest message is ${JSON.stringify(compactMessage)}. Treat this message as language-ambiguous because it is too short or only a generic greeting. Reply in German even if the wording could also look like a short English greeting.`;
  }
  return `The user's latest message is ${JSON.stringify(compactMessage)}. Reply in the same language as that message. If the message becomes mixed or ambiguous after all, reply in German.`;
}

// ── Soft routing enforcement ──────────────────────────────────────────────────

/**
 * Reframe a hard, imperative routing-enforcement prompt as a strong but
 * overridable hint. Used when `agents.performance.softRoutingEnforcement` is on
 * to realize the trust-the-LLM direction (soft hints, not hard gates) for the
 * *routing-class* enforcement prompts (maintenance / workflow-catalog /
 * search-no-match). Anti-hallucination and correctness enforcement bypass this
 * and stay hard.
 *
 * Centralizing the softening here means future routing tuning is a single
 * transform rather than scattered edits across the per-intent prompt builders.
 */
/**
 * Whether a research request genuinely spans several distinct areas/deliverables
 * (a hardware build = BOM + power + layout + sourcing; a trip = activities +
 * transport + lodging). Only then does a coordinator earn its extra hop — the
 * Anthropic/Cognition consensus is that multi-agent only wins when the task
 * decomposes into independent threads. Single-domain lookups/validations go
 * straight to one specialist. Conservative: short asks are always single-domain.
 */
export function looksMultiDomainResearch(text: string): boolean {
  const raw = String(text ?? "");
  if (raw.trim().length < 300) return false;
  const questionCount = (raw.match(/\?/g) ?? []).length;
  const substantiveLines = raw.split(/\n/).map((l) => l.trim()).filter((l) => l.length > 20).length;
  const conjunctions = (raw.toLowerCase().match(/\b(and|sowie|plus|au[ßs]erdem|additionally|as well as|also|außerdem)\b/g) ?? []).length;
  return questionCount >= 3 || substantiveLines >= 5 || conjunctions >= 4;
}

export function toSoftRoutingHint(text: string): string {
  if (!text.trim()) return text;
  const soft = text
    .replace(/\bYou MUST\b/g, "You should strongly prefer to")
    .replace(/\byou MUST\b/g, "you should strongly prefer to")
    .replace(/\bMUST\b/g, "should")
    .replace(/\b(Do|DO) NOT\b/g, "prefer not to")
    .replace(/\bdo NOT\b/g, "prefer not to")
    .replace(/\bNEVER\b/g, "avoid")
    .replace(/\bSTOP\b/g, "consider stopping")
    .replace(/\s+this turn\b/g, "");
  return `Routing hint (advisory — follow unless you have a clear reason not to):\n${soft}`;
}
