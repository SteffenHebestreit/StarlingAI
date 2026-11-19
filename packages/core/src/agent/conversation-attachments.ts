/**
 * The files a person attached in this conversation, with the workspace path each was stored at.
 *
 * The web chat sends a picture's analysis and the typed words; the path the upload route stored the
 * file at is only on the message's metadata. A specialist starts from the orchestrator's task, and
 * in session bf079002 that said "the picture is in the workspace": image_creator looked for
 * "IMG_0042.jpg" under generated/, at the workspace root and at two invented absolute
 * paths, found nothing, and drew new cars from scratch instead of editing the person's photo. So
 * the paths ride with every delegation (attachedFilesBlock), and a tool given only a file's name
 * finds the upload by it (attachmentNamed).
 *
 * The conversation is the chain from the run up to its chat, through sub-agent and workflow runs,
 * newest message first; a file uploaded twice under one name answers with the newer copy.
 */
import { basename } from "node:path";
import { defangFramingMarkers } from "../guardrails/framing-markers.js";
import { getSession } from "./session.js";
import { parentSessionOf } from "./session-ids.js";

const NESTED_RUN_PREFIXES = ["sub:", "workflow:"];
/** The timestamp the upload routes put in front of a stored name. */
const UPLOAD_STAMP_RE = /^\d{10,}-/;
/** How many a delegation is told about: the newest ones, which are the ones a request means. */
const BLOCK_MAX_FILES = 5;
const NAME_MAX_CHARS = 120;

export interface ConversationAttachment {
  /** The name the person's file had. */
  filename: string;
  /** Where the upload route stored it, relative to the workspace. */
  relativePath: string;
}

/** The conversation's attachments, newest first, one per stored path. */
export function conversationAttachments(sessionId: string, max = 32): ConversationAttachment[] {
  const found: ConversationAttachment[] = [];
  const seen = new Set<string>();
  let id: string | null = sessionId;
  for (let depth = 0; id && depth < 16 && found.length < max; depth += 1) {
    const history = getSession(id)?.getHistory() ?? [];
    for (let index = history.length - 1; index >= 0 && found.length < max; index -= 1) {
      const message = history[index];
      const attachments = message?.role === "user" ? message.metadata?.["attachments"] : undefined;
      if (!Array.isArray(attachments)) continue;
      for (const entry of attachments as unknown[]) {
        if (!entry || typeof entry !== "object") continue;
        const record = entry as Record<string, unknown>;
        const relativePath = typeof record["relativePath"] === "string" ? record["relativePath"].trim().replace(/\\/g, "/") : "";
        if (!relativePath || seen.has(relativePath) || found.length >= max) continue;
        seen.add(relativePath);
        const named = typeof record["filename"] === "string" ? record["filename"].trim() : "";
        found.push({ filename: named || basename(relativePath).replace(UPLOAD_STAMP_RE, ""), relativePath });
      }
    }
    const parent = parentSessionOf(id, NESTED_RUN_PREFIXES);
    id = parent === id ? null : parent;
  }
  return found;
}

/**
 * The newest attachment a bare name or a guessed path means: its last segment is the file's name,
 * or the name the upload route stored it under, with or without the stamp. Case is ignored.
 */
export function attachmentNamed(sessionId: string, path: string): ConversationAttachment | undefined {
  const wanted = basename(path.trim().replace(/\\/g, "/")).toLowerCase();
  if (!wanted) return undefined;
  return conversationAttachments(sessionId).find((attachment) => {
    const stored = basename(attachment.relativePath).toLowerCase();
    return attachment.filename.toLowerCase() === wanted || stored === wanted || stored.replace(UPLOAD_STAMP_RE, "") === wanted;
  });
}

/** One line naming a file, safe to put in a prompt: a name is the person's to choose, words and all. */
function attachmentLine(attachment: ConversationAttachment): string {
  const name = defangFramingMarkers(attachment.filename.replace(/[\r\n]+/g, " ").slice(0, NAME_MAX_CHARS));
  return `- ${name}: ${attachment.relativePath}`;
}

/**
 * The block a delegated specialist gets beside its task, or "" when the conversation has no
 * attachment or the task and context already carry every path it would name.
 */
export function attachedFilesBlock(sessionId: string, alreadyCarried: string): string {
  const attachments = conversationAttachments(sessionId, BLOCK_MAX_FILES);
  if (attachments.length === 0 || attachments.every((attachment) => alreadyCarried.includes(attachment.relativePath))) return "";
  return "\n\n[FILES THE USER ATTACHED IN THIS CONVERSATION — newest first. Open one by its workspace path; "
    + "a request about \"the picture\" or \"the file\" means the newest unless it says otherwise.]\n"
    + attachments.map(attachmentLine).join("\n");
}

/** What a failed read adds so the caller can retry with a real path, or "" without attachments. */
export function attachmentsHint(sessionId: string): string {
  const attachments = conversationAttachments(sessionId, BLOCK_MAX_FILES);
  if (attachments.length === 0) return "";
  return ` Files the user attached in this conversation (open one by this path): ${attachments
    .map((attachment) => `${attachment.filename.replace(/[\r\n]+/g, " ").slice(0, NAME_MAX_CHARS)} -> ${attachment.relativePath}`)
    .join("; ")}.`;
}
