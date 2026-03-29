/**
 * VNC Remote Computer Adapter — connects to any VNC server via RFB protocol.
 *
 * This adapter enables computer-use on ANY machine running a VNC server
 * (TigerVNC, RealVNC, TightVNC, etc.) — no custom StarlingAI node needed.
 * Works like a human using a VNC client: see the screen, click, type, scroll.
 *
 * Key design decisions (informed by Anthropic/OpenAI computer-use patterns):
 *   • Auto-screenshot after every action — the model always sees the result
 *   • Direct RFB protocol — no intermediate HTTP layer, lower latency
 *   • Reconnect with exponential backoff on transient failures
 *   • Clipboard access via RFB ClientCutText/ServerCutText
 *
 * Architecture:
 *   ┌─────────────────┐     RFB (TCP)     ┌──────────────────┐
 *   │  StarlingAI      │ ───────────────► │  Target Machine   │
 *   │  Gateway          │                  │  (VNC Server)     │
 *   │                  │ ◄──── framebuffer │  Any OS           │
 *   │  VncAdapter      │      + events     │  Any network      │
 *   └─────────────────┘                   └──────────────────┘
 */

import { childLogger } from "../../logger.js";
import type { RemoteAdapterConfig } from "../../config/computer-use-schema.js";
import type {
  ActionResult,
  ComputerAction,
  ComputerAdapter,
  WindowInfo,
} from "./base.js";
import type {
  ComputerSession,
  ComputerSessionSnapshot,
  DisplayTopology,
} from "../computer-session.js";
import { computeScreenshotHash } from "../computer-vision.js";
import { VncClient, resolveKeysym, encodeRgbaToPng } from "./vnc-protocol.js";
import { randomUUID } from "node:crypto";

const log = childLogger("agent:computer-adapter:vnc");

/** Time to wait after an input action for the screen to update (ms). */
const POST_ACTION_SETTLE_MS = 350;

/** Time between pointer-down and pointer-up for a click (ms). */
const CLICK_HOLD_MS = 50;

/** Scroll amount per step in VNC scroll wheel events. */
const SCROLL_STEPS_PER_100PX = 3;

// VNC button masks
const VNC_BTN_LEFT = 1;
const VNC_BTN_MIDDLE = 2;
const VNC_BTN_RIGHT = 4;
const VNC_BTN_SCROLL_UP = 8;
const VNC_BTN_SCROLL_DOWN = 16;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class VncComputerAdapter implements ComputerAdapter {
  readonly name = "remote_vnc";

  private client: VncClient;
  private session: ComputerSession | null = null;
  private clipboardText = "";
  private reconnectAttempts: number;
  private reconnectDelayMs: number;

  constructor(private readonly config: RemoteAdapterConfig) {
    this.client = new VncClient();
    this.reconnectAttempts = config.reconnectAttempts;
    this.reconnectDelayMs = config.reconnectDelayMs;

    // Track clipboard from server
    this.client.on("clipboard", (text: string) => {
      this.clipboardText = text;
    });
  }

  async initialize(session: ComputerSession): Promise<void> {
    this.session = session;
    // Initial connection: fail fast (1 retry only, shorter timeout).
    // Full reconnectAttempts/reconnectDelayMs are reserved for mid-session reconnects.
    await this.connectWithRetry(1, 5_000, 8_000);
    log.info({
      sessionId: session.id,
      host: this.config.host,
      port: this.config.port,
      width: this.client.width,
      height: this.client.height,
      serverName: this.client.serverName,
    }, "VNC adapter initialized");
  }

  async captureSnapshot(): Promise<ComputerSessionSnapshot> {
    this.assertInitialized();
    await this.ensureConnected();

    const screenshot = await this.client.captureScreenshot();
    const hash = computeScreenshotHash(Buffer.from(screenshot.dataUrl.split(",")[1]!, "base64"));

    return {
      screenshotHash: hash,
      timestamp: Date.now(),
      frameId: `vnc-${randomUUID()}`,
      dataUrl: screenshot.dataUrl,
      width: screenshot.width,
      height: screenshot.height,
    };
  }

  async executeAction(action: ComputerAction): Promise<ActionResult> {
    this.assertInitialized();
    await this.ensureConnected();

    const start = Date.now();

    try {
      let output: string;
      switch (action.type) {
        case "click":
          output = await this.handleClick(action);
          break;
        case "type":
          output = await this.handleType(action);
          break;
        case "hotkey":
          output = await this.handleHotkey(action);
          break;
        case "scroll":
          output = await this.handleScroll(action);
          break;
        case "drag":
          output = await this.handleDrag(action);
          break;
        case "focus_window":
          output = `Window focus via VNC not directly supported — use computer_click on the taskbar or Alt+Tab hotkey.`;
          break;
        case "clipboard_read":
          output = this.clipboardText || "(clipboard empty or not synced)";
          break;
        case "clipboard_write":
          this.client.sendClipboardText(action.text);
          output = `Clipboard text sent (${action.text.length} chars)`;
          break;
        case "list_windows":
          output = "Window listing not available via VNC protocol — use computer_snapshot to see the screen.";
          break;
        case "wait_for":
          await sleep(Math.min(action.timeoutMs ?? 3000, 10_000));
          output = `Waited ${action.timeoutMs ?? 3000}ms.`;
          break;
        case "capture_region":
          output = "Region capture via VNC — use computer_snapshot for full screen.";
          break;
        case "upload_file":
        case "download_file":
          output = "File transfer not available via VNC protocol — use SSH for file operations.";
          break;
        default:
          output = `Unsupported VNC action: ${(action as { type: string }).type}`;
      }

      // Auto-screenshot after action (Anthropic/OpenAI pattern)
      await sleep(POST_ACTION_SETTLE_MS);
      let screenshotAfter: string | undefined;
      let screenshotWidth: number | undefined;
      let screenshotHeight: number | undefined;
      try {
        const ss = await this.client.captureScreenshot();
        screenshotAfter = ss.dataUrl;
        screenshotWidth = ss.width;
        screenshotHeight = ss.height;
      } catch (err) {
        log.warn({ error: err instanceof Error ? err.message : String(err) }, "Post-action screenshot failed");
      }

      return {
        success: true,
        output,
        screenshotAfter,
        durationMs: Date.now() - start,
        // Pass width/height through extended fields for runtime.ts to pick up
        ...(screenshotWidth ? { screenshotDataUrl: screenshotAfter, screenshotWidth, screenshotHeight } : {}),
      } as ActionResult & { screenshotDataUrl?: string; screenshotWidth?: number; screenshotHeight?: number };

    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  async getDisplayTopology(): Promise<DisplayTopology> {
    this.assertInitialized();
    return {
      monitors: [{
        id: 0,
        x: 0,
        y: 0,
        width: this.client.width,
        height: this.client.height,
        dpiScale: 1,
      }],
      primary: 0,
    };
  }

  async listWindows(): Promise<WindowInfo[]> {
    // VNC protocol doesn't support window enumeration.
    // The agent should rely on screenshots to see what's on screen.
    return [];
  }

  async isHealthy(): Promise<boolean> {
    return this.client.isConnected;
  }

  async cleanup(): Promise<void> {
    this.session = null;
    this.client.disconnect();
  }

  // ── Input Handlers ──────────────────────────────────────────────────────────

  private async handleClick(action: { x: number; y: number; button?: string; doubleClick?: boolean }): Promise<string> {
    const buttonMask = action.button === "right" ? VNC_BTN_RIGHT
      : action.button === "middle" ? VNC_BTN_MIDDLE
      : VNC_BTN_LEFT;

    // Move to position, press, release
    this.client.sendPointerEvent(action.x, action.y, 0);        // move
    await sleep(10);
    this.client.sendPointerEvent(action.x, action.y, buttonMask); // press
    await sleep(CLICK_HOLD_MS);
    this.client.sendPointerEvent(action.x, action.y, 0);          // release

    if (action.doubleClick) {
      await sleep(80);
      this.client.sendPointerEvent(action.x, action.y, buttonMask);
      await sleep(CLICK_HOLD_MS);
      this.client.sendPointerEvent(action.x, action.y, 0);
    }

    const clickType = action.doubleClick ? "double-click" : "click";
    const buttonName = action.button ?? "left";
    return `${buttonName} ${clickType} at (${action.x}, ${action.y})`;
  }

  private async handleType(action: { text: string; pressEnter?: boolean }): Promise<string> {
    // Type each character as key-down + key-up events
    for (const char of action.text) {
      const keysym = resolveKeysym(char);
      // Handle shifted characters
      const needsShift = isShiftedChar(char);
      if (needsShift) {
        this.client.sendKeyEvent(resolveKeysym("shift"), true);
        await sleep(5);
      }
      this.client.sendKeyEvent(keysym, true);
      await sleep(10);
      this.client.sendKeyEvent(keysym, false);
      if (needsShift) {
        await sleep(5);
        this.client.sendKeyEvent(resolveKeysym("shift"), false);
      }
      await sleep(15); // inter-key delay
    }

    if (action.pressEnter) {
      await sleep(30);
      const enterSym = resolveKeysym("enter");
      this.client.sendKeyEvent(enterSym, true);
      await sleep(30);
      this.client.sendKeyEvent(enterSym, false);
    }

    return `Typed ${action.text.length} characters${action.pressEnter ? " + Enter" : ""}`;
  }

  private async handleHotkey(action: { keys: string }): Promise<string> {
    // Parse "ctrl+shift+s" into individual keys
    const parts = action.keys.toLowerCase().split("+").map((k) => k.trim());
    const keysyms = parts.map((k) => resolveKeysym(k));

    // Press all keys down in order
    for (const sym of keysyms) {
      this.client.sendKeyEvent(sym, true);
      await sleep(15);
    }

    // Release in reverse order
    for (let i = keysyms.length - 1; i >= 0; i--) {
      this.client.sendKeyEvent(keysyms[i]!, false);
      await sleep(15);
    }

    return `Hotkey: ${action.keys}`;
  }

  private async handleScroll(action: { x: number; y: number; direction: string; amount?: number }): Promise<string> {
    const amount = action.amount ?? 100;
    const steps = Math.max(1, Math.round((amount / 100) * SCROLL_STEPS_PER_100PX));

    // Move cursor to position first
    this.client.sendPointerEvent(action.x, action.y, 0);
    await sleep(10);

    // VNC scroll uses button 4 (up) and 5 (down) = mask 8 and 16
    const isUp = action.direction === "up" || action.direction === "left";
    const scrollMask = isUp ? VNC_BTN_SCROLL_UP : VNC_BTN_SCROLL_DOWN;

    for (let i = 0; i < steps; i++) {
      this.client.sendPointerEvent(action.x, action.y, scrollMask);
      await sleep(20);
      this.client.sendPointerEvent(action.x, action.y, 0);
      await sleep(30);
    }

    return `Scrolled ${action.direction} ${steps} steps at (${action.x}, ${action.y})`;
  }

  private async handleDrag(action: { startX: number; startY: number; endX: number; endY: number }): Promise<string> {
    // Move to start, press, move to end, release
    this.client.sendPointerEvent(action.startX, action.startY, 0);
    await sleep(30);
    this.client.sendPointerEvent(action.startX, action.startY, VNC_BTN_LEFT);
    await sleep(50);

    // Interpolate intermediate points for smooth drag
    const dx = action.endX - action.startX;
    const dy = action.endY - action.startY;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const stepCount = Math.max(5, Math.round(distance / 20));

    for (let i = 1; i <= stepCount; i++) {
      const t = i / stepCount;
      const x = Math.round(action.startX + dx * t);
      const y = Math.round(action.startY + dy * t);
      this.client.sendPointerEvent(x, y, VNC_BTN_LEFT);
      await sleep(10);
    }

    await sleep(30);
    this.client.sendPointerEvent(action.endX, action.endY, 0);

    return `Dragged from (${action.startX}, ${action.startY}) to (${action.endX}, ${action.endY})`;
  }

  // ── Connection Management ───────────────────────────────────────────────────

  private async connectWithRetry(
    maxRetries?: number,
    baseDelay?: number,
    timeoutMs?: number,
  ): Promise<void> {
    const retries = maxRetries ?? this.reconnectAttempts;
    const delay = baseDelay ?? this.reconnectDelayMs;
    const connTimeout = timeoutMs ?? 15_000;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.client.connect({
          host: this.config.host,
          port: this.config.port,
          password: this.config.credentials,
          connectTimeoutMs: connTimeout,
        });
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < retries) {
          const backoff = delay * Math.pow(2, attempt);
          log.warn({ attempt: attempt + 1, delay: backoff, error: lastError.message }, "VNC connection failed, retrying");
          await sleep(backoff);
        }
      }
    }
    throw lastError ?? new Error("VNC connection failed");
  }

  private async ensureConnected(): Promise<void> {
    if (!this.client.isConnected) {
      log.info("VNC connection lost, reconnecting...");
      this.client = new VncClient();
      this.client.on("clipboard", (text: string) => { this.clipboardText = text; });
      await this.connectWithRetry();
    }
  }

  private assertInitialized(): void {
    if (!this.session) {
      throw new Error("VNC adapter is not initialized");
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Detect characters that require Shift on a US keyboard layout. */
function isShiftedChar(char: string): boolean {
  return /^[A-Z!@#$%^&*()_+{}|:"<>?~]$/.test(char);
}
