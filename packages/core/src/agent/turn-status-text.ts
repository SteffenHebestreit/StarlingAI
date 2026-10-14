/**
 * The runtime's narration lines — the status a turn shows between its steps — in German and in
 * English, chosen per turn by localizedFixedText (reply-language.ts). They were English sentences
 * under a German conversation, one carried both languages joined by " / ", and one was German only.
 */

export type StatusForms = { de: string; en: string };

export const TURN_STATUS = {
  routing: {
    de: "Ich wähle den passenden Spezialisten, bevor ich die Antwort schreibe.",
    en: "Selecting the required specialist path before drafting the answer.",
  },
  reviewing: {
    de: "Ich sichte die Ergebnisse und bereite die Antwort vor.",
    en: "Reviewing completed tool results and preparing the final response.",
  },
  steering: {
    de: "Ich nehme deine Nachricht mit auf …",
    en: "Folding in your mid-turn message…",
  },
  loopStop: {
    de: "Ich höre mit wiederholten Aufrufen auf und schreibe die Antwort aus den gesammelten Belegen.",
    en: "Stopping repeated tool calls and writing the answer from gathered evidence.",
  },
  questionStop: {
    de: "Ich höre mit weiteren Aufrufen auf und bereite die nötige Rückfrage vor.",
    en: "Stopping extra tool calls and preparing the required user-facing question.",
  },
  finalSynthesis: {
    de: "Ich schreibe die Antwort aus den bisher gesammelten Belegen.",
    en: "Writing the final response from the evidence gathered so far.",
  },
  maintenanceRoute: {
    de: "Das ist eine Wartungsanfrage für StarlingAI — ich gebe sie direkt an den Swarm-Maintainer.",
    en: "This is a StarlingAI maintenance request, so I am routing it to the swarm maintainer instead of workflow discovery.",
  },
  artifactRetry: {
    de: "Der Entwurf hat das verlangte Ergebnis nicht erstellt — ich versuche es mit dem passenden Spezialisten erneut.",
    en: "The draft skipped artifact creation, so I am retrying with the required specialist workflow.",
  },
  researchRetry: {
    de: "Der Entwurf hat die nötige Recherche ausgelassen — ich versuche es mit einem Spezialisten erneut.",
    en: "The draft skipped required research orchestration, so I am retrying with a specialist agent.",
  },
  autoResearch: {
    de: "Der Entwurf hat keine Recherche ausgeführt — ich hole jetzt belegte Quellen über einen Spezialisten.",
    en: "The draft ran no research — fetching sourced evidence via a research specialist now.",
  },
  discoveryFallback: {
    de: "Die Spezialistensuche hat nichts Passendes gefunden — ich nehme stattdessen einen Recherche-Spezialisten.",
    en: "Agent discovery returned no usable match, so I am falling back to a required research specialist instead of searching again.",
  },
  qaArtifact: {
    de: "Der QA-Check verlangt das angeforderte Artefakt — ich lasse es jetzt vom passenden Spezialisten erstellen.",
    en: "The QA check requires the requested artifact — having the right specialist build it now.",
  },
} as const satisfies Record<string, StatusForms>;
