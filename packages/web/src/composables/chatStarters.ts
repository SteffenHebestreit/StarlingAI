/**
 * What an empty chat offers to start with. A click puts the beginning of a sentence into the input
 * for the user to finish, nothing is sent: a turn can run for minutes, and no click should start
 * one the user has not read. Only what every installation can do is offered. Mail or a calendar
 * would read as a promise on an installation that has neither connected, and this page cannot tell.
 *
 * Free of Vue and of the store, so it can be exercised on its own.
 */
import { languageCode } from "../speech/speechText";

export interface ChatStarter {
  label: string;
  /** Goes into the input as it stands: it ends in a space, where the user carries on typing. */
  prompt: string;
}

export interface ChatStarters {
  lead: string;
  items: readonly ChatStarter[];
}

const STARTERS: Record<"de" | "en", ChatStarters> = {
  de: {
    lead: "Womit soll ich anfangen?",
    items: [
      { label: "Etwas recherchieren", prompt: "Recherchiere, was es Neues gibt zu " },
      { label: "Text schreiben", prompt: "Schreibe einen kurzen Text über " },
      { label: "Zahlen als Diagramm", prompt: "Mach aus diesen Zahlen ein Diagramm: " },
      { label: "Präsentation bauen", prompt: "Erstelle eine kurze Präsentation über " },
      { label: "Skript schreiben", prompt: "Schreibe ein kleines Skript, das " },
    ],
  },
  en: {
    lead: "What shall I start with?",
    items: [
      { label: "Look something up", prompt: "Find out what's new about " },
      { label: "Write a text", prompt: "Write a short text about " },
      { label: "Turn numbers into a chart", prompt: "Make a chart from these numbers: " },
      { label: "Build a presentation", prompt: "Create a short presentation about " },
      { label: "Write a script", prompt: "Write a small script that " },
    ],
  },
};

/** The starters for a browser language ("de-AT"): English for anything without its own. */
export function chatStarters(browserLanguage: string | null | undefined): ChatStarters {
  return languageCode(browserLanguage) === "de" ? STARTERS.de : STARTERS.en;
}

/** What decides whether the chat is empty in the sense of "nothing has happened here yet". */
export interface StarterConditions {
  connected: boolean;
  /** A session's messages on their way: an empty page then says nothing about the session. */
  transcriptLoading: boolean;
  /** A turn is running. */
  turnRunning: boolean;
  /** A question waits for an answer, and it is the input surface until it has one. */
  questionOpen: boolean;
  messageCount: number;
  /** The input is up: the user is at it, and on a phone it would cover the starters. */
  composerOpen: boolean;
  /** Something waits in the input, dictated perhaps. A click on a starter would replace it. */
  composerHasContent: boolean;
}

export function startersVisible(chat: StarterConditions): boolean {
  return chat.connected
    && !chat.transcriptLoading
    && !chat.turnRunning
    && !chat.questionOpen
    && chat.messageCount === 0
    && !chat.composerOpen
    && !chat.composerHasContent;
}
