/**
 * Computer-use vision pipeline (Stage 9C)
 *
 * Wraps the existing multimodal `analyzeImageBytes` to provide
 * computer-use-specific screenshot analysis capabilities:
 *
 *   - analyzeScreenshot:        Describe what's on screen
 *   - compareSnapshots:         Diff two screenshots for changes
 *   - detectDialog:             Check for dialogs/modals/popups
 *   - detectProgressIndicator:  Check for loading spinners / progress bars
 *   - detectCredentialPrompt:   Check for login/password dialogs
 *   - buildComputerVisionPrompt: Build enriched prompt for agent turn
 */

import { analyzeImageBytes } from "../tools/multimodal.js";
import { getConfig } from "../config/loader.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { createHash } from "node:crypto";

const log = childLogger("agent:computer-vision");

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ScreenshotAnalysis {
  description: string;
  hash: string;
  timestamp: number;
}

export interface SnapshotDiff {
  changed: boolean;
  summary: string;
}

export interface DialogDetection {
  detected: boolean;
  dialogType: "modal" | "alert" | "confirm" | "prompt" | "popup" | "none";
  title: string;
  summary: string;
}

export interface CredentialPromptDetection {
  detected: boolean;
  promptType: "login" | "password" | "mfa" | "uac" | "sudo" | "none";
  summary: string;
}

export interface ProgressDetection {
  detected: boolean;
  progressType: "spinner" | "progress_bar" | "loading_text" | "indeterminate" | "none";
  estimatedPercent: number | null;
  summary: string;
}

export type ScreenshotAnalysisFocus = "lmstudio_loaded_models";

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveVisionModel(): string {
  const config = getConfig();
  const cuConfig = (config as Record<string, unknown>)["computerUse"] as Record<string, unknown> | undefined;
  const cuModel = cuConfig?.["visionModel"] as string | undefined;
  if (cuModel) return cuModel;
  if (config.multimodal.files.visionModel) return config.multimodal.files.visionModel;
  // Fall back to the agent's primary model — most modern LLMs handle vision.
  const primary = config.agents.defaults.model.primary;
  if (primary) {
    log.warn("No explicit visionModel configured — falling back to primary model %s. Set computerUse.visionModel for best results.", primary);
    return primary;
  }
  return "";
}

export function computeScreenshotHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}

async function callVision(bytes: Uint8Array, contentType: string, prompt: string): Promise<string> {
  const model = resolveVisionModel();
  if (!model) {
    throw new Error("No vision model configured — set computerUse.visionModel or multimodal.files.visionModel");
  }
  return analyzeImageBytes(bytes, contentType, model, prompt);
}

export function normalizeScreenshotAnalysisFocus(focusHint?: string): ScreenshotAnalysisFocus | null {
  const normalized = focusHint?.trim().toLowerCase() ?? "";
  if (!normalized) return null;
  if (/(lm\s*studio|loaded models?|model list|models loaded|geladene modelle|geladene models|welche models)/iu.test(normalized)) {
    return "lmstudio_loaded_models";
  }
  return null;
}

function buildDefaultScreenshotPrompt(): string {
  return "You are analyzing a computer screenshot for a desktop automation agent. " +
    "STEP 1 — IDENTIFY ALL APPLICATIONS: Name every visible application window by its EXACT title bar text or recognizable branding (e.g. 'LM Studio', 'Visual Studio Code', 'OBS Studio', 'Task Manager', 'Chrome'). Do NOT use generic labels like 'monitoring dashboard' or 'settings panel' — always use the application's actual name if ANY branding, logo, or title text is visible. " +
    "STEP 2 — READ ALL TEXT: Transcribe every piece of readable text on screen — window titles, menu items, labels, status bars, model names, file names, version numbers, IP addresses, and error messages. " +
    "STEP 3 — DESCRIBE LAYOUT: Describe the full screen layout including left, right, top, bottom, and any secondary-monitor content: all visible windows, dialogs, menus, buttons, text fields, icons, taskbar items, and system tray. " +
    "For each CLICKABLE element (buttons, input fields, icons, tabs, links), estimate its approximate pixel coordinates as (x, y) from the top-left corner. " +
    "For text input fields, note whether they appear focused (have a cursor/highlight) and what visible text or placeholder they contain. " +
    "For chat or messaging UIs, identify the latest visible user message, latest assistant message, whether the input contains draft text, and whether the input appears empty after a send. " +
    "If text was just submitted and now appears in the conversation while the input is empty or cleared, explicitly say that the message appears submitted. " +
    "Be precise and concise. Format key findings as: ELEMENT_TYPE 'label' at approximately (x, y).";
}

function buildLmStudioLoadedModelsPrompt(): string {
  return "You are analyzing a screenshot of LM Studio with focus on the Loaded Models list. " +
    "First confirm whether LM Studio is visible and state the app title/version exactly as shown. " +
    "Then transcribe the Loaded Models section exactly. For EACH visible loaded-model row, extract: status chip text, full model name exactly as shown, any variant/quantization suffix, size, parallel value, and visible action buttons such as Eject. " +
    "Also report the 'Reachable at' endpoint exactly if visible and the currently selected model in the right sidebar if visible. " +
    "Do not summarize vaguely. Do not omit rows. Do not rename models. " +
    "Format the answer as: APP, ENDPOINT, then one bullet per loaded model using exact visible text.";
}

export function buildScreenshotPrompt(prompt?: string, focusHint?: string): string {
  if (prompt?.trim()) return prompt;
  const focus = normalizeScreenshotAnalysisFocus(focusHint);
  if (focus === "lmstudio_loaded_models") {
    return buildLmStudioLoadedModelsPrompt();
  }
  return buildDefaultScreenshotPrompt();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Analyze a screenshot, returning a description and hash.
 */
export async function analyzeScreenshot(
  bytes: Uint8Array,
  contentType = "image/png",
  prompt?: string,
  focusHint?: string,
): Promise<ScreenshotAnalysis> {
  const hash = computeScreenshotHash(bytes);
  const effectivePrompt = buildScreenshotPrompt(prompt, focusHint);

  const description = await callVision(bytes, contentType, effectivePrompt);

  logAudit("computer_screenshot_analyzed", {
    hash,
    descriptionLength: description.length,
  });

  return { description, hash, timestamp: Date.now() };
}

/**
 * Compare two screenshots and describe what changed.
 */
export async function compareSnapshots(
  beforeBytes: Uint8Array,
  afterBytes: Uint8Array,
  contentType = "image/png",
): Promise<SnapshotDiff> {
  const beforeHash = computeScreenshotHash(beforeBytes);
  const afterHash = computeScreenshotHash(afterBytes);

  if (beforeHash === afterHash) {
    return { changed: false, summary: "Screenshots are identical (same hash)." };
  }

  // Analyze the "after" with context about the "before"
  const beforeDesc = await callVision(
    beforeBytes,
    contentType,
    "Briefly describe this computer screenshot in 2-3 sentences, focusing on layout, windows, and key content.",
  );

  const prompt =
    `You are comparing two computer screenshots. The BEFORE state was: "${beforeDesc}". ` +
    "Now analyze this AFTER screenshot and describe ONLY what changed between the two states. " +
    "Be specific: new windows, closed dialogs, changed text, moved elements, new content. " +
    "If nothing meaningful changed, say so.";

  const summary = await callVision(afterBytes, contentType, prompt);

  return { changed: true, summary };
}

/**
 * Detect whether the screenshot shows a dialog, modal, or popup.
 */
export async function detectDialog(
  bytes: Uint8Array,
  contentType = "image/png",
): Promise<DialogDetection> {
  const prompt =
    "Analyze this screenshot and determine if there is a dialog, modal, alert, confirm box, " +
    "or popup visible. Respond in exactly this format:\n" +
    "DETECTED: yes/no\n" +
    "TYPE: modal/alert/confirm/prompt/popup/none\n" +
    "TITLE: <dialog title if visible, or 'none'>\n" +
    "SUMMARY: <one sentence describing the dialog>";

  const raw = await callVision(bytes, contentType, prompt);
  return parseDialogResponse(raw);
}

/**
 * Detect whether the screenshot shows a credential/login prompt.
 * Used by the Warden to trigger `computer_credential_prompt_loop` alerts.
 */
export async function detectCredentialPrompt(
  bytes: Uint8Array,
  contentType = "image/png",
): Promise<CredentialPromptDetection> {
  const prompt =
    "Analyze this screenshot and determine if it shows a credential prompt: login form, " +
    "password dialog, MFA/2FA code entry, Windows UAC elevation prompt, or sudo/su password prompt. " +
    "Respond in exactly this format:\n" +
    "DETECTED: yes/no\n" +
    "TYPE: login/password/mfa/uac/sudo/none\n" +
    "SUMMARY: <one sentence>";

  const raw = await callVision(bytes, contentType, prompt);
  return parseCredentialResponse(raw);
}

/**
 * Detect loading/progress indicators in the screenshot.
 */
export async function detectProgressIndicator(
  bytes: Uint8Array,
  contentType = "image/png",
): Promise<ProgressDetection> {
  const prompt =
    "Analyze this screenshot and determine if there is a loading indicator, progress bar, " +
    "spinner, or 'loading' text visible. Respond in exactly this format:\n" +
    "DETECTED: yes/no\n" +
    "TYPE: spinner/progress_bar/loading_text/indeterminate/none\n" +
    "PERCENT: <estimated percentage 0-100 if a progress bar is visible, or 'null'>\n" +
    "SUMMARY: <one sentence>";

  const raw = await callVision(bytes, contentType, prompt);
  return parseProgressResponse(raw);
}

/**
 * Build an enriched prompt for the agent's next computer-use turn.
 * Combines the screenshot analysis with task context.
 */
export function buildComputerVisionPrompt(
  screenshotAnalysis: ScreenshotAnalysis,
  taskContext: string,
  previousActions?: string[],
): string {
  const parts = [
    "## Current Computer Screen State",
    screenshotAnalysis.description,
    "",
    "## Task",
    taskContext,
  ];

  if (previousActions?.length) {
    parts.push("", "## Recent Actions");
    for (const action of previousActions.slice(-5)) {
      parts.push(`- ${action}`);
    }
  }

  parts.push(
    "",
    "## Instructions",
    "Based on the current screen state, decide the next action to take toward completing the task. " +
    "Use the computer_* tools to interact with the screen. Take one step at a time. " +
    "After each action, take a new snapshot to verify the result before proceeding.",
  );

  return parts.join("\n");
}

// ── Response parsers ──────────────────────────────────────────────────────────

function extractField(raw: string, field: string): string {
  const regex = new RegExp(`${field}:\\s*(.+)`, "i");
  const match = raw.match(regex);
  return match?.[1]?.trim() ?? "";
}

function parseDialogResponse(raw: string): DialogDetection {
  const detected = extractField(raw, "DETECTED").toLowerCase() === "yes";
  const typeRaw = extractField(raw, "TYPE").toLowerCase();
  const validTypes = ["modal", "alert", "confirm", "prompt", "popup", "none"] as const;
  const dialogType = validTypes.includes(typeRaw as typeof validTypes[number])
    ? (typeRaw as DialogDetection["dialogType"])
    : "none";
  const title = extractField(raw, "TITLE") || "none";
  const summary = extractField(raw, "SUMMARY") || raw.slice(0, 200);

  return { detected, dialogType, title, summary };
}

function parseCredentialResponse(raw: string): CredentialPromptDetection {
  const detected = extractField(raw, "DETECTED").toLowerCase() === "yes";
  const typeRaw = extractField(raw, "TYPE").toLowerCase();
  const validTypes = ["login", "password", "mfa", "uac", "sudo", "none"] as const;
  const promptType = validTypes.includes(typeRaw as typeof validTypes[number])
    ? (typeRaw as CredentialPromptDetection["promptType"])
    : "none";
  const summary = extractField(raw, "SUMMARY") || raw.slice(0, 200);

  return { detected, promptType, summary };
}

function parseProgressResponse(raw: string): ProgressDetection {
  const detected = extractField(raw, "DETECTED").toLowerCase() === "yes";
  const typeRaw = extractField(raw, "TYPE").toLowerCase();
  const validTypes = ["spinner", "progress_bar", "loading_text", "indeterminate", "none"] as const;
  const progressType = validTypes.includes(typeRaw as typeof validTypes[number])
    ? (typeRaw as ProgressDetection["progressType"])
    : "none";
  const percentRaw = extractField(raw, "PERCENT");
  const estimatedPercent = percentRaw && percentRaw !== "null" ? parseInt(percentRaw, 10) : null;
  const summary = extractField(raw, "SUMMARY") || raw.slice(0, 200);

  return {
    detected,
    progressType,
    estimatedPercent: Number.isNaN(estimatedPercent) ? null : estimatedPercent,
    summary,
  };
}
