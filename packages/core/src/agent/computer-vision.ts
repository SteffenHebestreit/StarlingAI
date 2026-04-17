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
import { inflateSync } from "node:zlib";
import { encodeRgbaToPng } from "./computer-adapters/vnc-protocol.js";

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

// ── Screenshot resize pipeline ────────────────────────────────────────────────
// Resizes PNG screenshots to at most screenshotMaxWidth before sending to the
// vision model.  A 3840×1080 screenshot encoded as base64 can be 6–10 MB and
// push inference time past 60 s on a local GPU.  Downscaling to 1920 px wide
// preserves enough detail to read text and UI elements (≥ 85 % quality).

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/**
 * Reverse PNG row filters (types 0–4) and return raw pixel data as a flat
 * Buffer with `bpp` bytes per pixel (no filter bytes, no padding).
 */
function reversePngFilters(raw: Buffer, width: number, height: number, bpp: number): Buffer {
  const rowBytes = width * bpp;
  const out = Buffer.alloc(height * rowBytes);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + rowBytes);
    const filterType = raw[rowStart]!;
    const outOff = y * rowBytes;
    const prevOff = outOff - rowBytes;
    for (let x = 0; x < rowBytes; x++) {
      const raw_v = raw[rowStart + 1 + x]!;
      const left = x >= bpp ? out[outOff + x - bpp]! : 0;
      const up = y > 0 ? out[prevOff + x]! : 0;
      const upLeft = y > 0 && x >= bpp ? out[prevOff + x - bpp]! : 0;
      switch (filterType) {
        case 0: out[outOff + x] = raw_v; break;
        case 1: out[outOff + x] = (raw_v + left) & 0xff; break;
        case 2: out[outOff + x] = (raw_v + up) & 0xff; break;
        case 3: out[outOff + x] = (raw_v + Math.floor((left + up) / 2)) & 0xff; break;
        case 4: out[outOff + x] = (raw_v + paethPredictor(left, up, upLeft)) & 0xff; break;
        default: out[outOff + x] = raw_v;
      }
    }
  }
  return out;
}

/**
 * Bilinear downsample raw RGBA pixel data (Buffer of srcW*srcH*4 bytes).
 */
function bilinearResize(src: Buffer, srcW: number, srcH: number, dstW: number, dstH: number): Buffer {
  const dst = Buffer.alloc(dstW * dstH * 4);
  const xScale = srcW / dstW;
  const yScale = srcH / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    const sy = dy * yScale;
    const sy0 = Math.floor(sy);
    const sy1 = Math.min(sy0 + 1, srcH - 1);
    const fy = sy - sy0;
    for (let dx = 0; dx < dstW; dx++) {
      const sx = dx * xScale;
      const sx0 = Math.floor(sx);
      const sx1 = Math.min(sx0 + 1, srcW - 1);
      const fx = sx - sx0;
      const dstOff = (dy * dstW + dx) * 4;
      for (let c = 0; c < 4; c++) {
        const tl = src[(sy0 * srcW + sx0) * 4 + c]!;
        const tr = src[(sy0 * srcW + sx1) * 4 + c]!;
        const bl = src[(sy1 * srcW + sx0) * 4 + c]!;
        const br = src[(sy1 * srcW + sx1) * 4 + c]!;
        dst[dstOff + c] = Math.round(tl * (1 - fx) * (1 - fy) + tr * fx * (1 - fy) + bl * (1 - fx) * fy + br * fx * fy);
      }
    }
  }
  return dst;
}

/**
 * Decode a PNG, downscale to maxWidth (maintaining aspect ratio) if needed,
 * and re-encode.  Supports 8-bit RGB (colorType 2) and RGBA (colorType 6).
 * Returns the original buffer unchanged when no resize is needed or the PNG
 * uses an unsupported format.
 */
function resizeScreenshotForVision(
  png: Buffer,
  maxWidth: number,
): { bytes: Buffer; resized: boolean; srcW: number; srcH: number; dstW: number; dstH: number } {
  const noop = (srcW = 0, srcH = 0) => ({ bytes: png, resized: false, srcW, srcH, dstW: srcW, dstH: srcH });
  const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) { if (png[i] !== PNG_SIG[i]) return noop(); }

  let pos = 8;
  let srcW = 0; let srcH = 0; let colorType = 0; let bitDepth = 0;
  const idatChunks: Buffer[] = [];

  while (pos + 8 <= png.length) {
    const length = png.readUInt32BE(pos);
    const type = png.subarray(pos + 4, pos + 8).toString("ascii");
    const data = png.subarray(pos + 8, pos + 8 + length);
    pos += 4 + 4 + length + 4;
    if (type === "IHDR") {
      srcW = data.readUInt32BE(0);
      srcH = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
    } else if (type === "IDAT") {
      idatChunks.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
  }

  // Only handle 8-bit RGB and RGBA; skip indexed, grayscale, 16-bit, etc.
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) return noop(srcW, srcH);
  if (srcW <= maxWidth) return noop(srcW, srcH);

  const dstW = maxWidth;
  const dstH = Math.max(1, Math.round(srcH * (maxWidth / srcW)));
  const bpp = colorType === 6 ? 4 : 3;

  const raw = inflateSync(Buffer.concat(idatChunks));
  let rgba = reversePngFilters(raw, srcW, srcH, bpp);

  if (bpp === 3) {
    // RGB → RGBA
    const buf = Buffer.alloc(srcW * srcH * 4);
    for (let i = 0; i < srcW * srcH; i++) {
      buf[i * 4] = rgba[i * 3]!;
      buf[i * 4 + 1] = rgba[i * 3 + 1]!;
      buf[i * 4 + 2] = rgba[i * 3 + 2]!;
      buf[i * 4 + 3] = 255;
    }
    rgba = buf;
  }

  const resized = bilinearResize(rgba, srcW, srcH, dstW, dstH);
  return { bytes: encodeRgbaToPng(dstW, dstH, resized), resized: true, srcW, srcH, dstW, dstH };
}

async function callVision(bytes: Uint8Array, contentType: string, prompt: string): Promise<string> {
  const model = resolveVisionModel();
  if (!model) {
    throw new Error("No vision model configured — set computerUse.visionModel or multimodal.files.visionModel");
  }

  let finalBytes: Buffer = bytes instanceof Buffer ? bytes : Buffer.from(bytes);
  if (contentType === "image/png") {
    const config = getConfig();
    const cuConfig = (config as Record<string, unknown>)["computerUse"] as { screenshotMaxWidth?: number } | undefined;
    const maxWidth = cuConfig?.screenshotMaxWidth ?? 1920;
    try {
      const result = resizeScreenshotForVision(finalBytes, maxWidth);
      if (result.resized) {
        log.debug(
          { src: `${result.srcW}x${result.srcH}`, dst: `${result.dstW}x${result.dstH}` },
          "Resized screenshot for vision analysis",
        );
        finalBytes = result.bytes;
      }
    } catch (err) {
      // Malformed PNG / unsupported chunk → fall back to original bytes.
      log.debug({ err }, "PNG resize failed; sending original bytes to vision model");
    }
  }

  return analyzeImageBytes(finalBytes, contentType, model, prompt);
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
