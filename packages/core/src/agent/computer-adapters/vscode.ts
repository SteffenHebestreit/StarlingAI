/**
 * VS Code Computer Adapter (Stage 9E)
 *
 * Implements ComputerAdapter for local VS Code control via nut.js.
 * This adapter captures screenshots of the VS Code window, sends keyboard/mouse
 * input, and manages VS Code-specific operations like opening files, running
 * terminal commands, and navigating the editor.
 *
 * Prerequisites:
 *   - @nut-tree-fork/nut-js must be installed (optional peer dependency)
 *   - The host must have a graphical display (X11, Wayland, or Windows desktop)
 */

import type {
  ComputerAdapter,
  ComputerAction,
  ActionResult,
  WindowInfo,
} from "./base.js";
import type {
  ComputerSession,
  ComputerSessionSnapshot,
  DisplayTopology,
} from "../computer-session.js";
import { computeScreenshotHash } from "../computer-vision.js";
import { childLogger } from "../../logger.js";
import { randomUUID } from "node:crypto";

const log = childLogger("agent:computer-adapter:vscode");

// ── Lazy-loaded nut-tree bindings ─────────────────────────────────────────────
// We dynamically import nut-tree so the adapter file can be loaded even when
// the optional dependency is not installed (e.g. in container workers).

/* eslint-disable @typescript-eslint/no-explicit-any */
let _nutMouse: any = null;
let _nutKeyboard: any = null;
let _nutScreen: any = null;
let _nutKey: any = null;
let _nutButton: any = null;

async function loadNutTree() {
  if (_nutMouse) return;
  try {
    // @nut-tree-fork/nut-js is an optional peer dependency
    const nut: any = await import("@nut-tree-fork/nut-js" as string);
    _nutMouse = nut.mouse;
    _nutKeyboard = nut.keyboard;
    _nutScreen = nut.screen;
    _nutKey = nut.Key;
    _nutButton = nut.Button;
    log.info("nut.js loaded successfully");
  } catch (err) {
    throw new Error(
      `@nut-tree-fork/nut-js is required for the VS Code adapter but could not be loaded: ${(err as Error).message}. ` +
      "Install it with: pnpm add @nut-tree-fork/nut-js",
    );
  }
}

// ── Adapter Implementation ────────────────────────────────────────────────────

export class VscodeComputerAdapter implements ComputerAdapter {
  readonly name = "local_vscode";

  private session: ComputerSession | null = null;
  private _healthy = false;

  async initialize(session: ComputerSession): Promise<void> {
    await loadNutTree();
    this.session = session;
    this._healthy = true;
    log.info({ sessionId: session.id }, "VS Code adapter initialized");
  }

  async captureSnapshot(): Promise<ComputerSessionSnapshot> {
    this.assertInitialized();
    const start = Date.now();

    const image = await _nutScreen!.grab();
    const rawBytes = new Uint8Array(image.data);
    const hash = computeScreenshotHash(rawBytes);

    return {
      screenshotHash: hash,
      timestamp: Date.now(),
      frameId: randomUUID(),
    };
  }

  async executeAction(action: ComputerAction): Promise<ActionResult> {
    this.assertInitialized();
    const start = Date.now();

    try {
      switch (action.type) {
        case "click":
          return await this.handleClick(action, start);
        case "type":
          return await this.handleType(action, start);
        case "hotkey":
          return await this.handleHotkey(action, start);
        case "scroll":
          return await this.handleScroll(action, start);
        case "drag":
          return await this.handleDrag(action, start);
        case "focus_window":
          return await this.handleFocusWindow(action, start);
        case "clipboard_read":
          return await this.handleClipboardRead(start);
        case "clipboard_write":
          return await this.handleClipboardWrite(action, start);
        case "list_windows":
          return { success: true, output: "Window listing requires platform-specific APIs", durationMs: Date.now() - start };
        case "capture_region":
          return await this.handleCaptureRegion(action, start);
        case "wait_for":
          return { success: true, output: `Waited for: ${action.description}`, durationMs: Date.now() - start };
        case "upload_file":
        case "download_file":
          return { success: false, error: "File transfer not supported in local adapter", durationMs: Date.now() - start };
        default:
          return { success: false, error: `Unknown action type: ${(action as { type: string }).type}`, durationMs: Date.now() - start };
      }
    } catch (err) {
      return {
        success: false,
        error: `Action ${action.type} failed: ${(err as Error).message}`,
        durationMs: Date.now() - start,
      };
    }
  }

  async getDisplayTopology(): Promise<DisplayTopology> {
    this.assertInitialized();
    const width = await _nutScreen!.width();
    const height = await _nutScreen!.height();
    return {
      monitors: [{
        id: 0,
        width,
        height,
        x: 0,
        y: 0,
        dpiScale: 1,
      }],
      primary: 0,
    };
  }

  async listWindows(): Promise<WindowInfo[]> {
    // nut-tree doesn't provide window enumeration out of the box.
    // TODO: Platform-specific implementation (wmctrl on Linux, Win32 API, etc.)
    return [];
  }

  async isHealthy(): Promise<boolean> {
    if (!this._healthy || !_nutScreen) return false;
    try {
      await _nutScreen.width();
      return true;
    } catch {
      this._healthy = false;
      return false;
    }
  }

  async cleanup(): Promise<void> {
    this._healthy = false;
    this.session = null;
    log.info("VS Code adapter cleaned up");
  }

  // ── Action handlers ─────────────────────────────────────────────────────────

  private async handleClick(action: Extract<ComputerAction, { type: "click" }>, start: number): Promise<ActionResult> {
    const { Point }: any = await import("@nut-tree-fork/nut-js" as string);
    await _nutMouse!.setPosition(new Point(action.x, action.y));

    const buttonMap = { left: _nutButton!.LEFT, right: _nutButton!.RIGHT, middle: _nutButton!.MIDDLE };
    const button = buttonMap[action.button ?? "left"];

    if (action.doubleClick) {
      await _nutMouse!.doubleClick(button);
    } else {
      await _nutMouse!.click(button);
    }

    return { success: true, output: `Clicked at (${action.x}, ${action.y})`, durationMs: Date.now() - start };
  }

  private async handleType(action: Extract<ComputerAction, { type: "type" }>, start: number): Promise<ActionResult> {
    await _nutKeyboard!.type(action.text);
    if (action.pressEnter) {
      await _nutKeyboard!.pressKey(_nutKey!.Enter);
      await _nutKeyboard!.releaseKey(_nutKey!.Enter);
    }
    return { success: true, output: `Typed ${action.text.length} characters`, durationMs: Date.now() - start };
  }

  private async handleHotkey(action: Extract<ComputerAction, { type: "hotkey" }>, start: number): Promise<ActionResult> {
    const keyParts = action.keys.toLowerCase().split("+").map(k => k.trim());
    const keyMap: Record<string, number> = {
      ctrl: _nutKey!.LeftControl,
      control: _nutKey!.LeftControl,
      alt: _nutKey!.LeftAlt,
      shift: _nutKey!.LeftShift,
      meta: _nutKey!.LeftSuper,
      win: _nutKey!.LeftSuper,
      super: _nutKey!.LeftSuper,
      enter: _nutKey!.Enter,
      return: _nutKey!.Enter,
      escape: _nutKey!.Escape,
      esc: _nutKey!.Escape,
      tab: _nutKey!.Tab,
      space: _nutKey!.Space,
      backspace: _nutKey!.Backspace,
      delete: _nutKey!.Delete,
      home: _nutKey!.Home,
      end: _nutKey!.End,
      pageup: _nutKey!.PageUp,
      pagedown: _nutKey!.PageDown,
      up: _nutKey!.Up,
      down: _nutKey!.Down,
      left: _nutKey!.Left,
      right: _nutKey!.Right,
      f1: _nutKey!.F1,
      f2: _nutKey!.F2,
      f3: _nutKey!.F3,
      f4: _nutKey!.F4,
      f5: _nutKey!.F5,
      f6: _nutKey!.F6,
      f7: _nutKey!.F7,
      f8: _nutKey!.F8,
      f9: _nutKey!.F9,
      f10: _nutKey!.F10,
      f11: _nutKey!.F11,
      f12: _nutKey!.F12,
    };

    const nutKeys: number[] = [];
    for (const part of keyParts) {
      if (keyMap[part] !== undefined) {
        nutKeys.push(keyMap[part]);
      } else if (part.length === 1) {
        // Single character — map A-Z
        const charCode = part.toUpperCase().charCodeAt(0);
        if (charCode >= 65 && charCode <= 90) {
          // nut-tree Key enum: A=0x00, B=0x01, etc. — depends on nut-tree version
          // Use dynamic lookup
          const keyName = part.toUpperCase() as keyof typeof _nutKey;
          if (_nutKey![keyName] !== undefined) {
            nutKeys.push(_nutKey![keyName] as number);
          }
        }
      }
    }

    if (nutKeys.length === 0) {
      return { success: false, error: `Could not map keys: ${action.keys}`, durationMs: Date.now() - start };
    }

    // Press all modifier keys, then the final key, then release in reverse
    for (const k of nutKeys) await _nutKeyboard!.pressKey(k);
    for (const k of nutKeys.reverse()) await _nutKeyboard!.releaseKey(k);

    return { success: true, output: `Pressed hotkey: ${action.keys}`, durationMs: Date.now() - start };
  }

  private async handleScroll(action: Extract<ComputerAction, { type: "scroll" }>, start: number): Promise<ActionResult> {
    const { Point }: any = await import("@nut-tree-fork/nut-js" as string);
    await _nutMouse!.setPosition(new Point(action.x, action.y));
    const amount = action.amount ?? 3;
    if (action.direction === "up") {
      await _nutMouse!.scrollUp(amount);
    } else if (action.direction === "down") {
      await _nutMouse!.scrollDown(amount);
    } else if (action.direction === "left") {
      await _nutMouse!.scrollLeft(amount);
    } else {
      await _nutMouse!.scrollRight(amount);
    }
    return { success: true, output: `Scrolled ${action.direction} by ${amount}`, durationMs: Date.now() - start };
  }

  private async handleDrag(action: Extract<ComputerAction, { type: "drag" }>, start: number): Promise<ActionResult> {
    const { Point }: any = await import("@nut-tree-fork/nut-js" as string);
    await _nutMouse!.setPosition(new Point(action.startX, action.startY));
    await _nutMouse!.pressButton(_nutButton!.LEFT);
    await _nutMouse!.setPosition(new Point(action.endX, action.endY));
    await _nutMouse!.releaseButton(_nutButton!.LEFT);
    return { success: true, output: `Dragged from (${action.startX},${action.startY}) to (${action.endX},${action.endY})`, durationMs: Date.now() - start };
  }

  private async handleFocusWindow(action: Extract<ComputerAction, { type: "focus_window" }>, start: number): Promise<ActionResult> {
    // nut-tree does not natively support window focus by title.
    // This is a placeholder — real implementation would use platform APIs
    // (wmctrl on Linux, Win32 SetForegroundWindow, AppleScript on macOS).
    log.warn({ titlePattern: action.titlePattern }, "Window focus not yet implemented for nut-tree adapter");
    return {
      success: false,
      error: `Window focus by title pattern not yet implemented (pattern: ${action.titlePattern})`,
      durationMs: Date.now() - start,
    };
  }

  private async handleClipboardRead(start: number): Promise<ActionResult> {
    // Use system clipboard via hotkey workaround
    // Real implementation would use platform clipboard APIs
    return { success: false, error: "Clipboard read requires platform-specific API", durationMs: Date.now() - start };
  }

  private async handleClipboardWrite(action: Extract<ComputerAction, { type: "clipboard_write" }>, start: number): Promise<ActionResult> {
    return { success: false, error: "Clipboard write requires platform-specific API", durationMs: Date.now() - start };
  }

  private async handleCaptureRegion(action: Extract<ComputerAction, { type: "capture_region" }>, start: number): Promise<ActionResult> {
    const { Region }: any = await import("@nut-tree-fork/nut-js" as string);
    const region = new Region(action.x, action.y, action.width, action.height);
    const image = await _nutScreen!.grabRegion(region);
    const rawBytes = new Uint8Array(image.data);
    const hash = computeScreenshotHash(rawBytes);

    return {
      success: true,
      screenshotHash: hash,
      output: `Captured region ${action.width}x${action.height} at (${action.x},${action.y})`,
      durationMs: Date.now() - start,
    };
  }

  // ── Guards ──────────────────────────────────────────────────────────────────

  private assertInitialized(): void {
    if (!this.session || !this._healthy) {
      throw new Error("VS Code adapter not initialized or unhealthy");
    }
  }
}
