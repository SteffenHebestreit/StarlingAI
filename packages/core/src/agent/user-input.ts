/**
 * Structured user input — the contract a tool uses to put a question with a typed answer to the
 * person behind a turn, at any in-process depth.
 *
 * ask_user covers a free-text question from the orchestrator. A tool deep inside a specialist
 * (generate_image offering engine, size and a base picture) needs more: a payload the client
 * renders by kind, an answer the server validates before the tool sees it, and a result it can act
 * on in every case. So a request ALWAYS comes back with an outcome — "configured" with the checked
 * value, "auto" (use what you would have done anyway), or "cancelled" — and `reason` says why. A
 * surface with no one to ask (channels, scenes, federation, containers, --auto) answers "auto" /
 * "no_channel" at once, which is the tool's old behaviour.
 *
 * The broker that carries requests to the dashboard lives in user-input-broker.ts.
 */

import type { SessionSettings } from "./session.js";

/** Shortest and longest a request may wait for its answer. The model and the tools pick their own
 *  numbers; a two-second question cannot be answered and a two-hour one holds a whole turn. */
export const MIN_USER_INPUT_TIMEOUT_MS = 10_000;
export const MAX_USER_INPUT_TIMEOUT_MS = 900_000;
export const DEFAULT_USER_INPUT_TIMEOUT_MS = 120_000;

/** An answer is JSON the client built; a mask image is the largest thing one legitimately holds. */
export const DEFAULT_MAX_ANSWER_BYTES = 64 * 1024;
export const MAX_ANSWER_DEPTH = 8;

/**
 * A ToolResult metadata flag: the call did nothing because the person said no to it — a Skip in a
 * settings step. The result stays `success: false`, so the agent neither retries nor claims the
 * work, but it is the person's choice, not a failure of the work: the run record lists it apart
 * from the calls that failed, where a Skip used to read as a broken render.
 */
export const DECLINED_BY_USER_METADATA_KEY = "declinedByUser";

export function isDeclinedByUser(metadata: Record<string, unknown> | undefined): boolean {
  return metadata?.[DECLINED_BY_USER_METADATA_KEY] === true;
}

export function clampUserInputTimeoutMs(value: unknown, fallback = DEFAULT_USER_INPUT_TIMEOUT_MS): number {
  const n = typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  return Math.round(Math.max(MIN_USER_INPUT_TIMEOUT_MS, Math.min(MAX_USER_INPUT_TIMEOUT_MS, n)));
}

/** Why a request ended the way it did. */
export type UserInputReason =
  | "user"
  | "timeout"
  | "session_preference"
  | "no_channel"
  | "turn_aborted"
  | "user_skipped"
  | "disconnected_expired";

export interface UserInputFieldError {
  /** Dotted path into the answer ("settings.width"), or "inputId" / "answer" for the whole. */
  field: string;
  message: string;
}

/**
 * What a request's validator makes of a raw answer. A rejected answer keeps the request open, so the
 * person can correct it; an accepted one decides the outcome. "auto" and "cancelled" are the person
 * choosing not to configure (reason "user" / "user_skipped"); `value` may still carry side choices
 * such as "always auto from now on".
 */
export type UserInputValidation<T> =
  | { ok: true; outcome?: "configured"; value: T; summary?: string }
  | { ok: true; outcome: "auto" | "cancelled"; value?: T; summary?: string }
  | { ok: false; errors: UserInputFieldError[] };

/** A full-size image of something the payload only shows as a thumbnail. */
export interface UserInputPreview {
  dataUrl: string;
  width: number;
  height: number;
}

export interface UserInputRequest<T = unknown> {
  /** Which card the client renders ("image_settings", …): lowercase, digits and underscores. */
  kind: string;
  title: string;
  /**
   * JSON the client renders. Never put a filesystem path here: ids only, resolved server-side.
   * A function is called only once someone will really be asked, so a payload that costs work
   * (thumbnails of earlier pictures) is never built for a chat set to Auto or a run with nobody
   * to ask; if it throws, the outcome is "auto" / "no_channel".
   */
  payload: Record<string, unknown> | (() => Promise<Record<string, unknown>>);
  /** How long the card waits before the tool proceeds on its own; clamped to 10 s – 15 min. */
  timeoutMs?: number;
  /** The deadline a person gets once they open the full form (userInput.hold); same clamp. */
  holdTimeoutMs?: number;
  /** Raise for answers that carry an image (a painted mask). */
  maxAnswerBytes?: number;
  validate(answer: unknown): UserInputValidation<T> | Promise<UserInputValidation<T>>;
  /** Serves userInput.preview. Return null for an id this request never offered. */
  preview?(candidateId: string): Promise<UserInputPreview | null> | UserInputPreview | null;
  /** A standing choice the person made for this chat, read from its root session: true means do not
   *  ask, and the outcome is "auto" / "session_preference". */
  autoIf?(settings: SessionSettings): boolean;
}

export type UserInputOutcome<T = unknown> =
  | { outcome: "configured"; value: T; summary?: string; waitedMs: number; rootSessionId: string }
  | {
    outcome: "auto";
    reason: "user" | "timeout" | "session_preference" | "no_channel" | "disconnected_expired";
    value?: T;
    summary?: string;
    waitedMs: number;
    /** Absent only for "no_channel": there was no chat to name. */
    rootSessionId?: string;
  }
  | {
    outcome: "cancelled";
    reason: "turn_aborted" | "user_skipped";
    value?: T;
    summary?: string;
    waitedMs: number;
    rootSessionId?: string;
  };

/** Carried in the request context of an interactive turn and everything it runs in-process. */
export interface UserInputChannel {
  /** The chat session the person is looking at — never a sub-agent or workflow session. */
  rootSessionId: string;
  /** The gateway request id of the turn; the client matches its events on it. */
  turnId: string;
  mode: "interactive" | "unattended";
}

/** Data of the agent.user_input_needed event, and of each session.get openUserInputs entry. */
export interface UserInputNeededEvent {
  requestId: string;
  sessionId: string;
  inputId: string;
  kind: string;
  title: string;
  toolCallId?: string;
  sourceAgent?: string;
  payload: Record<string, unknown>;
  timeoutMs: number;
  expiresAt: string;
}

/** Data of the agent.user_input_resolved event. */
export interface UserInputResolvedEvent {
  requestId: string;
  sessionId: string;
  inputId: string;
  outcome: "configured" | "auto" | "cancelled";
  reason?: UserInputReason;
  summary?: string;
}

/**
 * Strict shape of an image carried as a data URL. Such a string is decoded as an image by the tool
 * that asked for it and never reaches a model as text, so it skips the prompt-injection scan: the
 * scan's own base64 and repetition rules would reject every mask (a mostly-transparent PNG encodes
 * as long runs of "A").
 */
const IMAGE_DATA_URL_RE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

export function isImageDataUrl(value: string): boolean {
  return IMAGE_DATA_URL_RE.test(value);
}

/**
 * The limits every answer meets before a tool's own validator sees it: a byte ceiling, a nesting
 * ceiling, and the input guardrail on every text leaf. Answers become the user's words for the
 * specialists that run afterwards, so they get what a typed message gets.
 */
export function checkUserInputAnswer(
  answer: unknown,
  maxBytes: number,
  checkText: (text: string) => { allowed: boolean; reason?: string },
): UserInputFieldError[] {
  if (answer === undefined) return [{ field: "answer", message: "required" }];
  let serialized: string;
  try {
    serialized = JSON.stringify(answer);
  } catch {
    return [{ field: "answer", message: "not JSON" }];
  }
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    return [{ field: "answer", message: `too large (limit ${maxBytes} bytes)` }];
  }
  const errors: UserInputFieldError[] = [];
  const walk = (value: unknown, path: string, depth: number): void => {
    if (errors.length > 0) return;
    if (depth > MAX_ANSWER_DEPTH) {
      errors.push({ field: path || "answer", message: "nested too deeply" });
      return;
    }
    if (typeof value === "string") {
      if (isImageDataUrl(value)) return;
      const verdict = checkText(value);
      if (!verdict.allowed) errors.push({ field: path || "answer", message: verdict.reason ?? "rejected by the input guardrail" });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) walk(item, path ? `${path}.${key}` : key, depth + 1);
    }
  };
  walk(answer, "", 0);
  return errors;
}
