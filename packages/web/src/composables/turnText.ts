/**
 * The words a running turn is shown in, in the language the user writes in: German or English.
 *
 * A German request was answered in German under a list of English rows — "Delegated to
 * researcher", "Running web_search...", "Completed 3 tool calls. Latest: web_fetch." — and a tool
 * without a worded title showed its function name. Here every line the step stream, its header and
 * the live status line show has both wordings, and a tool or specialist is named in words.
 *
 * Free of Vue and of the store, so it can be exercised on its own.
 */

import { detectLanguage } from "../speech/speechText";

export type TurnLanguage = "de" | "en";

/** German for German, English for every other language (the rest of the page is English). */
export function turnLanguage(code: string | null | undefined): TurnLanguage {
  const value = code?.trim().toLowerCase() ?? "";
  // "de", "de-DE", "deutsch" — or the name a speech service or the runtime uses.
  return value.startsWith("de") || value === "german" ? "de" : "en";
}

/**
 * The language a turn is shown in: its request's, else the conversation's latest answer's (a
 * request like "ok" or "weiter" says nothing), else English.
 */
export function languageOfTurn(
  requestText: string | undefined,
  history: ReadonlyArray<{ id: string; role: string; content: string; language?: string }>,
): TurnLanguage {
  const own = requestText ? detectLanguage(requestText) : undefined;
  if (own) return turnLanguage(own);
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.role !== "assistant" || message.id === "streaming") continue;
    const language = message.language ?? detectLanguage(message.content);
    if (language) return turnLanguage(language);
  }
  return "en";
}

type Words = Readonly<Record<TurnLanguage, string>>;

// Tools without a worded title of their own (turnSteps.ts stepTitle), as a reader names them.
// Phrased to read right both while the step runs and once it is done.
const TOOL_LABELS: Readonly<Record<string, Words>> = {
  web_search: { en: "Web search", de: "Websuche" },
  web_fetch: { en: "Read a web page", de: "Webseite lesen" },
  web_table: { en: "Read a table from the web", de: "Tabelle aus dem Web lesen" },
  fetch_image: { en: "Fetch an image", de: "Bild abrufen" },
  wikipedia_lookup: { en: "Wikipedia lookup", de: "In Wikipedia nachschlagen" },
  get_news_headlines: { en: "News headlines", de: "Nachrichten abrufen" },
  read_rss_feed: { en: "Read a news feed", de: "Newsfeed lesen" },
  get_weather: { en: "Weather", de: "Wetter abfragen" },
  get_fx_rate: { en: "Exchange rate", de: "Wechselkurs abfragen" },
  get_crypto_price: { en: "Crypto price", de: "Kryptokurs abfragen" },
  read_file: { en: "Read a file", de: "Datei lesen" },
  write_file: { en: "Write a file", de: "Datei schreiben" },
  edit_file: { en: "Edit a file", de: "Datei bearbeiten" },
  delete_file: { en: "Delete a file", de: "Datei löschen" },
  create_dir: { en: "Create a folder", de: "Ordner anlegen" },
  list_files: { en: "List files", de: "Dateien auflisten" },
  glob_files: { en: "Find files", de: "Dateien finden" },
  grep_files: { en: "Search in files", de: "In Dateien suchen" },
  workspace_search: { en: "Search the workspace", de: "Arbeitsbereich durchsuchen" },
  extract_file_content: { en: "Read a document", de: "Dokument lesen" },
  spreadsheet_read: { en: "Read a spreadsheet", de: "Tabelle lesen" },
  spreadsheet_write: { en: "Write a spreadsheet", de: "Tabelle schreiben" },
  memory_search: { en: "Search memory", de: "Gedächtnis durchsuchen" },
  recall_context: { en: "Recall context", de: "Kontext abrufen" },
  memory_store: { en: "Remember", de: "Merken" },
  rag_search: { en: "Search documents", de: "Dokumente durchsuchen" },
  search_documents: { en: "Search documents", de: "Dokumente durchsuchen" },
  search_knowledge_base: { en: "Search the knowledge base", de: "Wissensbasis durchsuchen" },
  ingest_document: { en: "Add a document", de: "Dokument aufnehmen" },
  shell_exec: { en: "Run a command", de: "Befehl ausführen" },
  run_script: { en: "Run a script", de: "Skript ausführen" },
  ssh_exec: { en: "Run a remote command", de: "Befehl per SSH ausführen" },
  http_request: { en: "HTTP request", de: "HTTP-Anfrage" },
  sql_query: { en: "Database query", de: "Datenbankabfrage" },
  run_test_suite: { en: "Run tests", de: "Tests ausführen" },
  browser_navigate: { en: "Open a page in the browser", de: "Seite im Browser öffnen" },
  browser_snapshot: { en: "Read the browser page", de: "Browserseite lesen" },
  browser_click: { en: "Click in the browser", de: "Im Browser klicken" },
  browser_type: { en: "Type in the browser", de: "Im Browser tippen" },
  browser_select_option: { en: "Choose an option in the browser", de: "Option im Browser wählen" },
  browser_wait_for: { en: "Wait for the page", de: "Auf die Seite warten" },
  browser_screenshot: { en: "Browser screenshot", de: "Browser-Bildschirmfoto" },
  verify_page: { en: "Check the page", de: "Seite prüfen" },
  verify_app: { en: "Check the app", de: "App prüfen" },
  serve_app: { en: "Start the app", de: "App starten" },
  analyze_image: { en: "Look at the image", de: "Bild ansehen" },
  transcribe_audio: { en: "Transcribe audio", de: "Audio transkribieren" },
  synthesize_speech: { en: "Speak text", de: "Sprache erzeugen" },
  generate_document: { en: "Create a document", de: "Dokument erstellen" },
  generate_docx: { en: "Create a Word document", de: "Word-Dokument erstellen" },
  generate_pptx: { en: "Create a presentation", de: "Präsentation erstellen" },
  generate_presentation: { en: "Create a presentation", de: "Präsentation erstellen" },
  generate_pdf: { en: "Create a PDF", de: "PDF erstellen" },
  generate_website: { en: "Build a website", de: "Website bauen" },
  generate_chart_html: { en: "Create a chart", de: "Diagramm erstellen" },
  generate_mermaid_diagram: { en: "Create a diagram", de: "Diagramm erstellen" },
  generate_svg: { en: "Create a graphic", de: "Grafik erstellen" },
  generate_qr_code: { en: "Create a QR code", de: "QR-Code erstellen" },
  send_email: { en: "Send an email", de: "E-Mail senden" },
  mail_search: { en: "Search mail", de: "E-Mails durchsuchen" },
  mail_read: { en: "Read an email", de: "E-Mail lesen" },
  mail_list_unread: { en: "Unread mail", de: "Ungelesene E-Mails" },
  mail_save_attachment: { en: "Save a mail attachment", de: "E-Mail-Anhang speichern" },
  calendar_list_events: { en: "Read the calendar", de: "Kalender lesen" },
  calendar_create_event: { en: "Create an appointment", de: "Termin anlegen" },
  contacts_search: { en: "Search contacts", de: "Kontakte durchsuchen" },
  schedule_task: { en: "Schedule a task", de: "Aufgabe planen" },
  datetime_arithmetic: { en: "Date calculation", de: "Datumsrechnung" },
  load_tool: { en: "Load a tool", de: "Werkzeug laden" },
  search_tools: { en: "Look for a tool", de: "Werkzeug suchen" },
  list_agents: { en: "List specialists", de: "Spezialisten auflisten" },
  create_ephemeral_agent: { en: "Create a specialist", de: "Spezialisten anlegen" },
  delegate_to_remote_agent: { en: "Ask a remote agent", de: "Entfernten Agenten fragen" },
};

/** "browser_select_option" → "Browser select option": a name as words, when nothing better is known. */
export function humanizeName(name: string): string {
  const words = name.replace(/[_\-.]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
  return words ? words[0]!.toUpperCase() + words.slice(1) : name;
}

/** What a tool is called in a row. An MCP tool can carry its server's prefix ("server__browser_click"). */
export function toolLabel(name: string, lang: TurnLanguage): string {
  const bare = name.split(/__|\./).pop() ?? name;
  return TOOL_LABELS[bare]?.[lang] ?? humanizeName(bare);
}

/** A specialist as a reader names it: "content_writer" → "Content writer". */
export function agentLabel(name: string): string {
  return humanizeName(name);
}

function plural(lang: TurnLanguage, count: number, en: [string, string], de: [string, string]): string {
  const [one, many] = lang === "de" ? de : en;
  return `${count} ${count === 1 ? one : many}`;
}

/** Every other line of the step stream, by language. */
export const turnText = {
  delegatedTo: (lang: TurnLanguage, agent: string) => lang === "de" ? `An ${agentLabel(agent)} übergeben` : `Delegated to ${agentLabel(agent)}`,
  delegatedToSpecialist: (lang: TurnLanguage) => lang === "de" ? "An einen Spezialisten übergeben" : "Delegated to a specialist",
  delegatedInParallel: (lang: TurnLanguage) => lang === "de" ? "Parallel an Spezialisten übergeben" : "Delegated in parallel",
  ranTaskGraph: (lang: TurnLanguage) => lang === "de" ? "Aufgabengraph ausgeführt" : "Ran a task graph",
  ranWorkflow: (lang: TurnLanguage) => lang === "de" ? "Ablauf ausgeführt" : "Ran a workflow",
  plannedAndRan: (lang: TurnLanguage, count: number) => lang === "de"
    ? `${plural(lang, count, ["step", "steps"], ["Schritt", "Schritte"])} geplant und ausgeführt`
    : `Planned and ran ${plural(lang, count, ["step", "steps"], ["Schritt", "Schritte"])}`,
  ranThePlan: (lang: TurnLanguage) => lang === "de" ? "Plan ausgeführt" : "Ran the plan",
  planned: (lang: TurnLanguage, count: number) => lang === "de"
    ? `${plural(lang, count, ["step", "steps"], ["Schritt", "Schritte"])} geplant`
    : `Planned ${plural(lang, count, ["step", "steps"], ["Schritt", "Schritte"])}`,
  plannedTheWork: (lang: TurnLanguage) => lang === "de" ? "Arbeit geplant" : "Planned the work",
  lookedForSpecialist: (lang: TurnLanguage) => lang === "de" ? "Passenden Spezialisten gesucht" : "Looked for the right specialist",
  editedRegion: (lang: TurnLanguage) => lang === "de" ? "Bildbereich bearbeitet" : "Edited a region of the image",
  editedImage: (lang: TurnLanguage) => lang === "de" ? "Bild bearbeitet" : "Edited the image",
  generatedImage: (lang: TurnLanguage) => lang === "de" ? "Bild erzeugt" : "Generated an image",
  transformedImage: (lang: TurnLanguage) => lang === "de" ? "Bild umgewandelt" : "Transformed the image",
  askedYou: (lang: TurnLanguage) => lang === "de" ? "Dir eine Frage gestellt" : "Asked you a question",
  specialistWorked: (lang: TurnLanguage, agent?: string) => agent
    ? (lang === "de" ? `${agentLabel(agent)} hat daran gearbeitet` : `${agentLabel(agent)} worked on it`)
    : (lang === "de" ? "Ein Spezialist hat daran gearbeitet" : "A specialist worked on it"),

  noResult: (lang: TurnLanguage) => lang === "de" ? "kein Ergebnis gemeldet" : "no result reported",
  skippedByYou: (lang: TurnLanguage) => lang === "de" ? "Von dir übersprungen" : "Skipped by you",
  cached: (lang: TurnLanguage) => lang === "de" ? "aus dem Zwischenspeicher" : "cached",
  notRun: (lang: TurnLanguage) => lang === "de" ? "nicht ausgeführt" : "not run",
  done: (lang: TurnLanguage) => lang === "de" ? "fertig" : "done",
  failed: (lang: TurnLanguage) => lang === "de" ? "fehlgeschlagen" : "failed",
  tier: (lang: TurnLanguage, tier: string) => lang === "de" ? `Stufe ${tier}` : `${tier} tier`,
  yourSettings: (lang: TurnLanguage) => lang === "de" ? "deine Einstellungen" : "your settings",
  noMatch: (lang: TurnLanguage) => lang === "de" ? "kein Treffer" : "no match",
  planRun: (lang: TurnLanguage, done: number, total: number, failed?: number) => lang === "de"
    ? `${done}/${total} erledigt${failed ? ` · ${failed} fehlgeschlagen` : ""}`
    : `${done}/${total} done${failed ? ` · ${failed} failed` : ""}`,
  stepCount: (lang: TurnLanguage, count: number) => plural(lang, count, ["step", "steps"], ["Schritt", "Schritte"]),
  risk: (lang: TurnLanguage, risk: string) => lang === "de" ? `Risiko ${risk}` : `risk ${risk}`,
  files: (lang: TurnLanguage, count: number) => plural(lang, count, ["file", "files"], ["Datei", "Dateien"]),

  usually: (lang: TurnLanguage, duration: string) => lang === "de" ? `meist ~${duration}` : `usually ~${duration}`,
  // 40 steps at 1024x1024 measured 322-335 s (2026-10-26); "2-3 min" was the 20-step figure.
  qualityTierUsually: (lang: TurnLanguage) => lang === "de" ? "Qualitätsstufe — meist ~5 min" : "quality tier — usually ~5 min",
  afterEarlierRender: (lang: TurnLanguage, duration: string) => lang === "de"
    ? `, sobald ein früheres Bild fertig ist (~${duration})`
    : `, once the engine finishes an earlier render (~${duration})`,

  headerSteps: (lang: TurnLanguage, count: number) => plural(lang, count, ["step", "steps"], ["Schritt", "Schritte"]),
  headerNotes: (lang: TurnLanguage, count: number) => plural(lang, count, ["note", "notes"], ["Notiz", "Notizen"]),
  headerFailed: (lang: TurnLanguage, count: number) => lang === "de" ? `${count} fehlgeschlagen` : `${count} failed`,

  statusRunning: (lang: TurnLanguage) => lang === "de" ? "läuft" : "running",
  statusFailed: (lang: TurnLanguage) => lang === "de" ? "fehlgeschlagen" : "failed",
  statusNoResult: (lang: TurnLanguage) => lang === "de" ? "kein Ergebnis" : "no result",
  statusSkipped: (lang: TurnLanguage) => lang === "de" ? "von dir übersprungen" : "skipped by you",
  statusDone: (lang: TurnLanguage) => lang === "de" ? "fertig" : "done",

  waitingForImageSettings: (lang: TurnLanguage) => lang === "de" ? "Wartet auf deine Bildeinstellungen" : "Waiting for your image settings",
  waitingForAnswer: (lang: TurnLanguage) => lang === "de" ? "Wartet auf deine Antwort" : "Waiting for your answer",
  waitingForYou: (lang: TurnLanguage, countdown?: string) => lang === "de"
    ? `wartet auf dich${countdown ? ` · automatisch in ${countdown}` : ""}`
    : `waiting for you${countdown ? ` · Auto in ${countdown}` : ""}`,
  insideAgent: (lang: TurnLanguage, agent: string) => lang === "de" ? `in ${agentLabel(agent)}` : `inside ${agentLabel(agent)}`,
  waitedForAnswer: (lang: TurnLanguage, duration: string) => lang === "de" ? `${duration} auf deine Antwort gewartet` : `waited ${duration} for your answer`,
  clickForDetails: (lang: TurnLanguage) => lang === "de" ? "für Details klicken" : "click for details",

  // The live status line, under the rows.
  working: (lang: TurnLanguage) => lang === "de" ? "Ich bin dran …" : "Working on it…",
  runningTool: (lang: TurnLanguage, tool: string) => `${toolLabel(tool, lang)} …`,
  nextStep: (lang: TurnLanguage) => lang === "de" ? "Überlege den nächsten Schritt …" : "Working out the next step…",
  plan: (lang: TurnLanguage, counts: { running: number; pending: number; done: number; partial: number; failed: number }) => {
    const parts = lang === "de"
      ? [counts.running && `${counts.running} laufen`, counts.pending && `${counts.pending} offen`, counts.done && `${counts.done} erledigt`,
        counts.partial && `${counts.partial} teilweise`, counts.failed && `${counts.failed} fehlgeschlagen`]
      : [counts.running && `${counts.running} running`, counts.pending && `${counts.pending} pending`, counts.done && `${counts.done} done`,
        counts.partial && `${counts.partial} partial`, counts.failed && `${counts.failed} failed`];
    const shown = parts.filter((part): part is string => Boolean(part));
    return shown.length ? `${lang === "de" ? "Plan" : "Plan"}: ${shown.join(" · ")}` : null;
  },

  stillWorking: (lang: TurnLanguage) => lang === "de" ? "Läuft noch …" : "Still working on it…",
  stillOnServer: (lang: TurnLanguage) => lang === "de"
    ? "Läuft noch auf dem Server — die Antwort erscheint hier, sobald sie fertig ist."
    : "Still running on the server — its answer appears here when it finishes.",
  reconnected: (lang: TurnLanguage) => lang === "de"
    ? "Wieder verbunden — der Lauf geht auf dem Server weiter. Die Antwort erscheint hier, sobald sie fertig ist."
    : "Reconnected — this turn is still running on the server. Its answer appears here when it finishes.",
  stalledDelegated: (lang: TurnLanguage) => lang === "de"
    ? "Die Arbeit läuft noch, aber der Server bestätigt den Lauf nicht mehr. Ich beobachte das, bevor ich neu verbinde."
    : "Work is still in progress, but the backend has stopped confirming that this run is active. Watching closely before recovery.",
  stalled: (lang: TurnLanguage) => lang === "de"
    ? "Seit einer Weile kommt kein Fortschritt mehr, und der Server bestätigt den Lauf nicht mehr."
    : "No progress signal has arrived recently, and the backend no longer confirms the run as active.",
  stillGenerating: (lang: TurnLanguage) => lang === "de"
    ? "Der Server arbeitet noch an der Antwort. Ich warte auf den nächsten Schritt."
    : "The backend is still generating this response. Keeping the turn open while waiting for the next progress event.",
  reconnecting: (lang: TurnLanguage) => lang === "de"
    ? "Für diesen Lauf kam kein Fortschritt mehr. Ich verbinde neu, um ihn wieder aufzunehmen."
    : "No progress signal was received for this turn. Reconnecting to recover the active session.",

  // A specialist's sign of life, on its delegation's row (agent.heartbeat).
  heartbeat: (lang: TurnLanguage, activity: string, chars?: number) => {
    if (activity === "composing") {
      const amount = chars ? ` (${chars.toLocaleString(lang === "de" ? "de-DE" : "en-US")} ${lang === "de" ? "Zeichen" : "chars"})` : "";
      return lang === "de" ? `schreibt …${amount}` : `writing…${amount}`;
    }
    if (activity === "steering") return lang === "de" ? "hat deine Nachricht aufgenommen" : "picked up your message";
    return lang === "de" ? "plant den nächsten Schritt …" : "planning the next step…";
  },
  specialistStarted: (lang: TurnLanguage, agent: string) => lang === "de" ? `${agentLabel(agent)} legt los …` : `${agentLabel(agent)} started…`,
  specialistFinished: (lang: TurnLanguage, agent: string) => lang === "de" ? `${agentLabel(agent)} ist fertig` : `${agentLabel(agent)} finished`,

  // A turn the user stopped: their choice, not a failure.
  stoppedBadge: (lang: TurnLanguage) => lang === "de" ? "⏹ Von dir angehalten" : "⏹ Stopped by you",
  stoppedNote: (lang: TurnLanguage) => lang === "de"
    ? "Angehalten. Was bis dahin erledigt war, steht oben."
    : "Stopped. What was done until then is listed above.",
} as const;
