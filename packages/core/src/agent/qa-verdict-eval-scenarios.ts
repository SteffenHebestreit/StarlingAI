/**
 * Scenarios for the QA verdict eval (scripts/qa-verdict-eval.ts): a turn as the runtime records it
 * (the user's message, the tool calls and their results), the plan's acceptance criteria, and
 * answers the verdict should pass (good) or fail (fabricated: a fact no tool returned; incomplete:
 * something the criteria ask for is missing). Every name, mail and figure is invented; nothing here
 * is read from a live system or a real mailbox.
 *
 * Built after a live session (2026-10-17) where the verdict failed a correct mail summary twice and
 * its invented flaw went into the reply; the mail scenarios keep that turn's shape, not its content.
 */
import { PLAN_CLOSING_ALL_RAN, PLAN_RESULTS_HEADING } from "./runtime-evidence-dump.js";
import type { SourceHistoryMessage } from "./qa-source-block.js";

export type QaEvalAnswerKind = "good" | "fabricated" | "incomplete";

export interface QaVerdictEvalScenario {
  name: string;
  criteria: string[];
  history: SourceHistoryMessage[];
  answers: Partial<Record<QaEvalAnswerKind, string>> & { good: string };
}

/** What a verdict should say about each kind of answer. */
export const EXPECTED_PASS: Readonly<Record<QaEvalAnswerKind, boolean>> = { good: true, fabricated: false, incomplete: false };

const call = (id: string, name: string): SourceHistoryMessage => ({ role: "assistant", content: null, tool_calls: [{ id, function: { name } }] });
const delegated = (id: string, agent: string, evidence: string): SourceHistoryMessage => ({
  role: "tool",
  tool_call_id: id,
  content: [
    `Delegated result from ${agent} — TASK COMPLETED.`,
    "IMPORTANT: Relay ALL specific details from the evidence below (names, numbers, values) in your answer. Do NOT paraphrase with different numbers or names. Do NOT add markers like '(truncated)' or '(abgeschnitten)'.",
    "Observed evidence:",
    `[${agent}]: ${evidence}`,
  ].join("\n"),
  metadata: { agentName: agent, delegationSucceeded: true },
});
const planReport = (id: string, step: string, agent: string, evidence: string): SourceHistoryMessage => ({
  role: "tool",
  tool_call_id: id,
  content: `Plan recorded (1 step, risk: low) and EXECUTED in this same call — every step has run.\n\nPlan: 1/1 step(s) completed.\n\nCOMPLETED:\n  - s1 (delegate) ${step}\n\n${PLAN_RESULTS_HEADING}\n\n[s1] ${step}\n[${agent}]: ${evidence}\n\n${PLAN_CLOSING_ALL_RAN}`,
  metadata: { planExecution: true, reportedResultIds: ["s1"] },
});

const MAILS = [
  "**1. Trello-Benachrichtigung – API // Billing (02.10.2026, 10:32 Uhr)** Jana Weber hat die Karte „API // Billing\" im Board OPS auf DONE verschoben. Automatische Benachrichtigung von Trello.",
  "**2. Reisekosten Workshop Hamburg (02.10.2026, 07:49 Uhr)** Jana Weber (Kennzeichnung „VERTRAULICH\") bittet dich, das Dokument auszufüllen und ihr zurückzusenden. Anhang: Reisekosten Workshop Hamburg 23–25 Sep 2026.pdf (403 KB) – vermutlich das Reisekostenformular für den Workshop vom 23. bis 25. September 2026.",
].join("\n\n");
const MAIL_GOOD = "**1. Trello (02.10.2026, 10:32 Uhr):** Jana Weber hat die Karte „API // Billing\" im Board OPS auf DONE verschoben – eine automatische Benachrichtigung.\n\n"
  + "**2. Reisekosten Workshop Hamburg (02.10.2026, 07:49 Uhr):** Jana Weber bittet dich, das angehängte Dokument auszufüllen und zurückzusenden (Kennzeichnung „VERTRAULICH\"). "
  + "Anhang: Reisekosten Workshop Hamburg 23–25 Sep 2026.pdf (403 KB), vermutlich das Reisekostenformular für den Workshop vom 23. bis 25. September 2026.";

const NODE = [
  "- Node.js 24 is the Active LTS line; it entered LTS on 2025-10-28 and is supported until 2028-04-30. Source: https://nodejs.org/en/about/previous-releases",
  "- Node.js 22 is in Maintenance LTS until 2027-04-30. Source: https://nodejs.org/en/about/previous-releases",
  "- Node.js 26 is the Current release line (not LTS). Source: https://nodejs.org/en/about/previous-releases",
].join("\n");
const NODE_GOOD = "Die aktuelle Active-LTS-Version ist **Node.js 24** (LTS seit 28.10.2025, Support bis 30.04.2028). Node.js 22 ist bis 30.04.2027 in Maintenance LTS, Node.js 26 ist die Current-Linie ohne LTS. Quelle: https://nodejs.org/en/about/previous-releases";

const PDF = "Saved attachment 1 of message 1231 (Reisekosten Workshop Hamburg 23–25 Sep 2026.pdf, application/pdf, 403 KB) to mail-attachments/work/INBOX-1231/Reisekosten_Workshop_Hamburg.pdf. "
  + "Content: Reisekostenabrechnung RK-2026-108, Workshop Hamburg, Zeitraum 23.09.2026–25.09.2026. Auszufüllen: Fahrtkosten, Unterkunft, Verpflegung; Unterschrift des Antragstellers.";
const PDF_GOOD = "Das PDF ist die Reisekostenabrechnung RK-2026-108 für den Workshop in Hamburg, Zeitraum 23.–25.09.2026. Auszufüllen sind Fahrtkosten, Unterkunft und Verpflegung, dazu deine Unterschrift.";

const CALENDAR = [
  "Events Mon 2026-10-19 to Sun 2026-10-25 (calendar Work):",
  "- Tue 2026-10-20 09:30–10:00 Sprint planning (Teams)",
  "- Wed 2026-10-21 14:00–15:00 Vendor call with Northwind",
  "- Fri 2026-10-23 11:00–12:30 Quarterly review, room 2.14",
].join("\n");
const CALENDAR_GOOD = "Next week you have three meetings: sprint planning on Tuesday 20 October, 09:30–10:00 (Teams); the Northwind vendor call on Wednesday 21 October, 14:00–15:00; and the quarterly review on Friday 23 October, 11:00–12:30 in room 2.14.";

const DISK = "df -h output on host atlas:\nFilesystem  Size  Used  Avail  Use%  Mounted on\n/dev/nvme0n1p2  476G  391G  85G  83%  /\n/dev/sda1  1.8T  1.2T  600G  67%  /data";
const DISK_GOOD = "Auf **atlas** ist `/` zu 83 % belegt (85 GB von 476 GB frei), `/data` zu 67 % (600 GB von 1,8 TB frei).";

const NO_RESULTS = "mail_search query \"from:telekom rechnung\":\nwork/INBOX: 0 matched; the mailbox holds 570.\nNo messages matched the query.";

export const QA_VERDICT_EVAL_SCENARIOS: readonly QaVerdictEvalScenario[] = [
  {
    name: "mail_summary",
    criteria: ["Zusammenfassung der letzten beiden E-Mails auf Deutsch", "Inhaltlich korrekt und vollständig wiedergegeben"],
    history: [
      { role: "user", content: "check mal meine letzten beiden emails und gib mir eine zusammenfassung" },
      call("p1", "record_plan"),
      planReport("p1", "Neueste E-Mails abrufen und zusammenfassen", "mail_agent", MAILS),
    ],
    answers: {
      good: MAIL_GOOD,
      fabricated: MAIL_GOOD.replace("vermutlich das Reisekostenformular für den Workshop vom 23. bis 25. September 2026.", "eine Rechnung über 412,50 EUR, zahlbar bis 15.10.2026."),
      incomplete: MAIL_GOOD.split("\n\n**2.")[0]!,
    },
  },
  {
    name: "research_node_lts",
    criteria: ["Nennt die aktuelle Node.js-LTS-Version mit Support-Ende", "Angaben mit Quelle belegt"],
    history: [
      { role: "user", content: "welche node version ist gerade lts und wie lange noch?" },
      call("d1", "delegate_to_agent"),
      delegated("d1", "researcher", NODE),
    ],
    answers: {
      good: NODE_GOOD,
      fabricated: NODE_GOOD.replace("bis 30.04.2028", "bis 31.12.2029"),
      incomplete: "Die aktuelle Active-LTS-Version ist **Node.js 24**.",
    },
  },
  {
    name: "attachment_pdf",
    criteria: ["Inhalt des PDF-Anhangs wiedergegeben", "Inhaltlich korrekt"],
    history: [
      { role: "user", content: "können wir die pdf öffnen und lesen" },
      call("d1", "delegate_to_agent"),
      delegated("d1", "mail_agent", PDF),
    ],
    answers: {
      good: PDF_GOOD,
      fabricated: PDF_GOOD.replace("Auszufüllen sind Fahrtkosten, Unterkunft und Verpflegung, dazu deine Unterschrift.", "Ein Betrag von 286 EUR ist bereits eingetragen; du musst nur noch unterschreiben."),
      incomplete: "Das PDF ist ein Formular.",
    },
  },
  {
    name: "calendar_week",
    criteria: ["Lists every appointment next week with day and time", "Matches the calendar"],
    history: [
      { role: "user", content: "what meetings do I have next week?" },
      call("d1", "delegate_to_agent"),
      delegated("d1", "calendar_agent", CALENDAR),
    ],
    answers: {
      good: CALENDAR_GOOD,
      fabricated: CALENDAR_GOOD.replace("14:00–15:00", "16:00–17:00"),
      incomplete: CALENDAR_GOOD.replace("; and the quarterly review on Friday 23 October, 11:00–12:30 in room 2.14.", "."),
    },
  },
  {
    name: "disk_usage",
    criteria: ["Nennt Belegung und freien Platz jedes Dateisystems", "Zahlen stimmen mit der Ausgabe überein"],
    history: [
      { role: "user", content: "wie voll sind die platten auf atlas?" },
      call("d1", "delegate_to_agent"),
      delegated("d1", "shell_agent", DISK),
    ],
    answers: {
      good: DISK_GOOD,
      fabricated: DISK_GOOD.replace("`/data` zu 67 % (600 GB", "`/data` zu 91 % (160 GB"),
      incomplete: "Auf **atlas** ist `/` zu 83 % belegt (85 GB von 476 GB frei).",
    },
  },
  {
    name: "no_results",
    criteria: ["Sagt, ob Rechnungen der Telekom im Postfach sind"],
    history: [
      { role: "user", content: "hab ich rechnungen von der telekom bekommen?" },
      call("d1", "delegate_to_agent"),
      delegated("d1", "mail_agent", NO_RESULTS),
    ],
    answers: {
      good: "Nein – im Posteingang (570 Nachrichten) gibt es keine Mail der Telekom; die Suche fand 0 Treffer.",
      fabricated: "Ja, zwei Rechnungen der Telekom: September über 39,95 € und Oktober über 41,20 €.",
    },
  },
];
