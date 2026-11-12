/**
 * The chat's own labels, in German or English.
 *
 * The step stream and the status line already speak the conversation's language
 * (composables/turnText.ts), and the starters the browser's — while the buttons and hints right
 * beside them were English only: "Womit soll ich anfangen?" above an English input, a German
 * answer with "Show more", "Restart" and "Copy" under it, a German step list that opened into an
 * English detail panel. This is the same two-language table for those labels.
 *
 * Which language: a message's labels follow the message (its bubble's language); the composer,
 * which belongs to no message, follows the browser, like the starters above it.
 */
import { turnLanguage, type TurnLanguage } from "./turnText";

const pick = (lang: TurnLanguage, en: string, de: string): string => (lang === "de" ? de : en);

/** The language for labels that belong to the page and not to one message. */
export function browserLanguage(): TurnLanguage {
  return turnLanguage(typeof navigator === "undefined" ? "en" : navigator.language);
}

export const chatText = {
  // ── A message's own actions ───────────────────────────────────────────────────────────────
  copy: (l: TurnLanguage) => pick(l, "⧉ Copy", "⧉ Kopieren"),
  copied: (l: TurnLanguage) => pick(l, "✓ Copied", "✓ Kopiert"),
  copyFailed: (l: TurnLanguage) => pick(l, "Copy failed", "Kopieren fehlgeschlagen"),
  copyTitle: (l: TurnLanguage) => pick(l, "Copy this message's text", "Text dieser Nachricht kopieren"),
  markdownTitle: (l: TurnLanguage) => pick(l, "Download as Markdown", "Als Markdown herunterladen"),
  pdfTitle: (l: TurnLanguage) => pick(l, "Export as PDF", "Als PDF exportieren"),
  restart: (l: TurnLanguage) => pick(l, "↩ Restart", "↩ Neu starten"),
  restartTitle: (l: TurnLanguage) => pick(l, "Restart the conversation from this message", "Unterhaltung ab dieser Nachricht neu starten"),
  resend: (l: TurnLanguage) => pick(l, "↻ Resend", "↻ Erneut senden"),
  resendTitle: (l: TurnLanguage) => pick(l, "Send this message again", "Diese Nachricht erneut senden"),
  showMore: (l: TurnLanguage) => pick(l, "Show more ▼", "Mehr anzeigen ▼"),
  showLess: (l: TurnLanguage) => pick(l, "Show less ▲", "Weniger anzeigen ▲"),
  showThinking: (l: TurnLanguage) => pick(l, "Show thinking", "Überlegungen anzeigen"),
  hideThinking: (l: TurnLanguage) => pick(l, "Hide thinking", "Überlegungen ausblenden"),
  enlarge: (l: TurnLanguage, name: string) => pick(l, `Enlarge ${name}`, `${name} vergrößern`),
  clickToEnlarge: (l: TurnLanguage) => pick(l, "Click to enlarge", "Zum Vergrößern klicken"),
  download: (l: TurnLanguage) => pick(l, "Download", "Herunterladen"),
  renderingDiagram: (l: TurnLanguage) => pick(l, "Rendering diagram…", "Diagramm wird gezeichnet…"),

  retry: (l: TurnLanguage) => pick(l, "↻ Ask again", "↻ Nochmal fragen"),
  retryTitle: (l: TurnLanguage) => pick(l, "Send the question this answer failed on once more", "Die Frage, an der diese Antwort gescheitert ist, noch einmal senden"),

  // ── The step detail panel ─────────────────────────────────────────────────────────────────
  ranInside: (l: TurnLanguage) => pick(l, "Ran inside", "Lief in"),
  tool: (l: TurnLanguage) => pick(l, "Tool", "Werkzeug"),
  took: (l: TurnLanguage) => pick(l, "Took", "Dauer"),
  outcome: (l: TurnLanguage) => pick(l, "Outcome", "Ergebnis"),
  now: (l: TurnLanguage) => pick(l, "Now", "Gerade"),
  arguments: (l: TurnLanguage) => pick(l, "Arguments", "Argumente"),
  result: (l: TurnLanguage) => pick(l, "Result", "Rückgabe"),
  details: (l: TurnLanguage) => pick(l, "Details", "Details"),
  copyBlock: (l: TurnLanguage) => pick(l, "Copy", "Kopieren"),
  copiedBlock: (l: TurnLanguage) => pick(l, "Copied", "Kopiert"),
  failedBlock: (l: TurnLanguage) => pick(l, "Failed", "Fehler"),
  running: (l: TurnLanguage) => pick(l, "running…", "läuft…"),
  skippedByYou: (l: TurnLanguage) => pick(l, "skipped by you", "von dir übersprungen"),
  failed: (l: TurnLanguage) => pick(l, "failed", "fehlgeschlagen"),
  noResult: (l: TurnLanguage) => pick(l, "no result", "kein Ergebnis"),
  done: (l: TurnLanguage) => pick(l, "done", "fertig"),
  firstCharacters: (l: TurnLanguage, count: number) => pick(l,
    `First ${count} characters — the rest is in the session transcript.`,
    `Die ersten ${count} Zeichen — der Rest steht im Sitzungsprotokoll.`),

  // ── The composer ──────────────────────────────────────────────────────────────────────────
  messagePlaceholder: (l: TurnLanguage, product: string, commands: boolean) => pick(l,
    `Message ${product}… (Enter to send, Shift+Enter for a new line${commands ? ", / for commands" : ""})`,
    `Nachricht an ${product}… (Enter sendet, Umschalt+Enter für eine neue Zeile${commands ? ", / für Befehle" : ""})`),
  steerPlaceholder: (l: TurnLanguage) => pick(l,
    "Steer the running turn — your message is queued and read at its next step…",
    "Laufende Aufgabe lenken — deine Nachricht wird beim nächsten Schritt gelesen…"),
  // Names the card's button by the label it has in this language (configure, below).
  cardPlaceholder: (l: TurnLanguage) => pick(l,
    "Waiting on the card above — use its Configure to change the engine or prompt…",
    "Wartet auf die Karte oben — über „Anpassen“ dort änderst du Engine oder Prompt…"),
  send: (l: TurnLanguage) => pick(l, "Send", "Senden"),
  steer: (l: TurnLanguage) => pick(l, "Steer", "Lenken"),
  stop: (l: TurnLanguage) => pick(l, "Stop", "Stopp"),
  stopping: (l: TurnLanguage) => pick(l, "Stopping…", "Wird gestoppt…"),
  stopTitle: (l: TurnLanguage) => pick(l, "Stop the current turn", "Laufende Aufgabe stoppen"),
  launcherTitle: (l: TurnLanguage, product: string) => pick(l,
    `Message ${product} (just start typing · drag to move)`,
    `Nachricht an ${product} (einfach lostippen · zum Verschieben ziehen)`),
  launcherLabel: (l: TurnLanguage) => pick(l, "Open message input", "Nachrichteneingabe öffnen"),
  newActivity: (l: TurnLanguage) => pick(l, "New activity", "Neue Aktivität"),
  newMessages: (l: TurnLanguage) => pick(l, "New messages", "Neue Nachrichten"),
  jumpToLatest: (l: TurnLanguage) => pick(l, "Jump to latest messages", "Zu den neuesten Nachrichten"),
  dropTitle: (l: TurnLanguage) => pick(l, "Drop to attach", "Zum Anhängen ablegen"),
  dropHint: (l: TurnLanguage) => pick(l,
    "Images queue for analysis · audio gets transcribed · documents go to your library and into this conversation",
    "Bilder werden analysiert · Audio wird transkribiert · Dokumente kommen in deine Bibliothek und in diese Unterhaltung"),

  // ── Above the conversation, and the banners that ask ─────────────────────────────────────
  loadOlder: (l: TurnLanguage) => pick(l, "Load older messages", "Ältere Nachrichten laden"),
  loadingOlder: (l: TurnLanguage) => pick(l, "Loading older messages…", "Ältere Nachrichten werden geladen…"),
  showOlder: (l: TurnLanguage, count: number) => pick(l,
    `Show ${count} older message${count === 1 ? "" : "s"}`,
    `${count} ältere Nachricht${count === 1 ? "" : "en"} anzeigen`),
  hideOlder: (l: TurnLanguage, count: number) => pick(l,
    `Hide ${count} older message${count === 1 ? "" : "s"}`,
    `${count} ältere Nachricht${count === 1 ? "" : "en"} ausblenden`),
  approvalRequired: (l: TurnLanguage) => pick(l, "Approval Required", "Freigabe erforderlich"),
  approve: (l: TurnLanguage) => pick(l, "Approve", "Freigeben"),
  deny: (l: TurnLanguage) => pick(l, "Deny", "Ablehnen"),
  question: (l: TurnLanguage) => pick(l, "Question", "Frage"),
  answerPlaceholder: (l: TurnLanguage) => pick(l, "Type your answer…", "Antwort eingeben…"),
  operatorAction: (l: TurnLanguage) => pick(l, "Operator Action Suggested", "Eingreifen empfohlen"),
  dismiss: (l: TurnLanguage) => pick(l, "Dismiss", "Schließen"),

  // ── A question a step waits on: the card under its row ───────────────────────────────────
  // The countdown reads like the row above it (turnText.waitingForYou): "Auto in" / "automatisch in".
  autoIn: (l: TurnLanguage, countdown: string) => pick(l, `Auto in ${countdown}`, `Automatisch in ${countdown}`),
  imageSettings: (l: TurnLanguage) => pick(l, "Image settings", "Bildeinstellungen"),
  auto: (l: TurnLanguage) => pick(l, "Auto", "Automatisch"),
  autoTitle: (l: TurnLanguage) => pick(l, "Render with the agent's settings", "Mit den Einstellungen des Agenten erzeugen"),
  configure: (l: TurnLanguage) => pick(l, "Configure…", "Anpassen…"),
  skip: (l: TurnLanguage) => pick(l, "Skip", "Überspringen"),
  skipTitle: (l: TurnLanguage) => pick(l, "Do not render this picture", "Dieses Bild nicht erzeugen"),
  alwaysAuto: (l: TurnLanguage) => pick(l, "Always Auto in this chat", "In diesem Chat immer automatisch"),
  alwaysAutoTitle: (l: TurnLanguage) => pick(l,
    "Renders in this chat stop asking and use the agent's settings",
    "In diesem Chat wird nicht mehr gefragt; es gelten die Einstellungen des Agenten"),
  cannotShowQuestion: (l: TurnLanguage) => pick(l,
    "This page cannot show the full question. The agent can go on with its own choice.",
    "Diese Seite kann die Frage nicht vollständig anzeigen. Der Agent kann mit seiner eigenen Wahl weitermachen."),
  continueWithDefaults: (l: TurnLanguage) => pick(l, "Continue with defaults", "Mit Standardwerten fortfahren"),

  // ── The voice bar ─────────────────────────────────────────────────────────────────────────
  voiceStop: (l: TurnLanguage) => pick(l, "Stop", "Stopp"),
  voiceDone: (l: TurnLanguage) => pick(l, "Done", "Fertig"),
  readFull: (l: TurnLanguage) => pick(l, "Read full answer", "Ganze Antwort vorlesen"),
  replay: (l: TurnLanguage) => pick(l, "Replay", "Nochmal"),
  showText: (l: TurnLanguage) => pick(l, "Show text", "Text anzeigen"),
  hideText: (l: TurnLanguage) => pick(l, "Hide text", "Text ausblenden"),
  endConversation: (l: TurnLanguage) => pick(l, "End conversation", "Gespräch beenden"),

  // ── The side panel ────────────────────────────────────────────────────────────────────────
  tabLive: (l: TurnLanguage) => pick(l, "Live", "Live"),
  tabSteps: (l: TurnLanguage) => pick(l, "Steps", "Schritte"),
  tabArtifacts: (l: TurnLanguage) => pick(l, "Artifacts", "Dateien"),
  openPanel: (l: TurnLanguage) => pick(l, "Open side panel", "Seitenleiste öffnen"),
  closePanel: (l: TurnLanguage) => pick(l, "Close side panel", "Seitenleiste schließen"),
  panelEmpty: (l: TurnLanguage) => pick(l, "Nothing to show here yet", "Hier gibt es noch nichts zu sehen"),

  // ── The composer's Options menu ───────────────────────────────────────────────────────────
  options: (l: TurnLanguage) => pick(l, "Options", "Optionen"),
  attachmentsAndVoice: (l: TurnLanguage) => pick(l, "Attachments & Voice", "Anhänge & Sprache"),
  whileTurnRuns: (l: TurnLanguage) => pick(l, "While a turn runs", "Während eine Aufgabe läuft"),
  spokenUpdates: (l: TurnLanguage) => pick(l, "Spoken updates + tones", "Gesprochene Updates + Töne"),
  tonesOnly: (l: TurnLanguage) => pick(l, "Tones only", "Nur Töne"),
  silentUntilAnswer: (l: TurnLanguage) => pick(l, "Silent until the answer", "Still bis zur Antwort"),
  scenes: (l: TurnLanguage) => pick(l, "Scenes", "Szenen"),
  jobs: (l: TurnLanguage) => pick(l, "Jobs", "Jobs"),
  effortForSession: (l: TurnLanguage) => pick(l, "Effort for this session", "Aufwand für diese Sitzung"),
  relaxesGates: (l: TurnLanguage) => pick(l, "relaxes quality gates", "lockert die Qualitätsprüfungen"),

  // ── Asking first ──────────────────────────────────────────────────────────────────────────
  restartConfirmTitle: (l: TurnLanguage) => pick(l, "Restart from this message?", "Ab dieser Nachricht neu starten?"),
  restartConfirmMessage: (l: TurnLanguage, later: number) => pick(l,
    `This removes it and the ${later} message${later === 1 ? "" : "s"} after it, here and on the gateway. Your question comes back into the input to edit and send again.`,
    `Das entfernt sie und die ${later} Nachricht${later === 1 ? "" : "en"} danach, hier und auf dem Gateway. Deine Frage kommt zum Bearbeiten zurück in die Eingabe.`),
  restartConfirmLabel: (l: TurnLanguage) => pick(l, "Restart here", "Hier neu starten"),
  resetConfirmTitle: (l: TurnLanguage) => pick(l, "Reset this session?", "Diese Sitzung zurücksetzen?"),
  resetConfirmMessage: (l: TurnLanguage, count: number) => pick(l,
    `This clears the conversation here and on the gateway — ${count} message${count === 1 ? "" : "s"}. Download it first if you want to keep it.`,
    `Das leert die Unterhaltung hier und auf dem Gateway — ${count} Nachricht${count === 1 ? "" : "en"}. Lade sie vorher herunter, wenn du sie behalten willst.`),
  resetConfirmLabel: (l: TurnLanguage) => pick(l, "Reset session", "Sitzung zurücksetzen"),
  cancel: (l: TurnLanguage) => pick(l, "Cancel", "Abbrechen"),
  cannotBeUndone: (l: TurnLanguage) => pick(l, "Cannot be undone", "Nicht umkehrbar"),
} as const;
