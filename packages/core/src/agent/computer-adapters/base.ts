/**
 * Computer Adapter — base interface shared by all computer-use adapters.
 *
 * Each adapter implementation (local_vscode, local_desktop, remote_vnc,
 * remote_rdp, ephemeral_vm) implements this interface so the tool layer
 * stays adapter-agnostic.
 */

import type {
  ComputerSession,
  ComputerSessionSnapshot,
  DisplayTopology,
} from "../computer-session.js";

// ── Action Types ──────────────────────────────────────────────────────────────

export interface ClickAction {
  type: "click";
  x: number;
  y: number;
  button?: "left" | "right" | "middle";
  doubleClick?: boolean;
  monitor?: number;
}

export interface TypeAction {
  type: "type";
  text: string;
  pressEnter?: boolean;
}

export interface HotkeyAction {
  type: "hotkey";
  keys: string; // e.g. "ctrl+s", "alt+tab"
}

export interface ScrollAction {
  type: "scroll";
  x: number;
  y: number;
  direction: "up" | "down" | "left" | "right";
  amount?: number;
  monitor?: number;
}

export interface DragAction {
  type: "drag";
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  monitor?: number;
}

export interface WaitForAction {
  type: "wait_for";
  description: string;
  timeoutMs?: number;
}

export interface FocusWindowAction {
  type: "focus_window";
  titlePattern: string;
}

export interface ClipboardReadAction {
  type: "clipboard_read";
}

export interface ClipboardWriteAction {
  type: "clipboard_write";
  text: string;
}

export interface UploadFileAction {
  type: "upload_file";
  localPath: string;
  targetPath?: string;
}

export interface DownloadFileAction {
  type: "download_file";
  remotePath: string;
  localPath?: string;
}

export interface CaptureRegionAction {
  type: "capture_region";
  x: number;
  y: number;
  width: number;
  height: number;
  monitor?: number;
}

export interface ListWindowsAction {
  type: "list_windows";
}

export type ComputerAction =
  | ClickAction
  | TypeAction
  | HotkeyAction
  | ScrollAction
  | DragAction
  | WaitForAction
  | FocusWindowAction
  | ClipboardReadAction
  | ClipboardWriteAction
  | UploadFileAction
  | DownloadFileAction
  | CaptureRegionAction
  | ListWindowsAction;

// ── Result Types ──────────────────────────────────────────────────────────────

export interface ActionResult {
  success: boolean;
  output?: string;
  /** Base64-encoded PNG screenshot taken after the action completed. */
  screenshotAfter?: string;
  /** Hash of the screenshot for loop detection. */
  screenshotHash?: string;
  error?: string;
  durationMs: number;
}

export interface WindowInfo {
  title: string;
  processName: string;
  bounds: { x: number; y: number; width: number; height: number };
  isFocused: boolean;
}

// ── Adapter Interface ─────────────────────────────────────────────────────────

export interface ComputerAdapter {
  /** Human-readable adapter name (e.g. "local_vscode", "remote_vnc"). */
  readonly name: string;

  /** Initialize the adapter for a given session. Called once after session creation. */
  initialize(session: ComputerSession): Promise<void>;

  /** Capture the current screen state. */
  captureSnapshot(): Promise<ComputerSessionSnapshot>;

  /** Execute a computer action and return the result (with optional post-action screenshot). */
  executeAction(action: ComputerAction): Promise<ActionResult>;

  /** Get the display topology (monitors, resolution, DPI). */
  getDisplayTopology(): Promise<DisplayTopology>;

  /** List open windows. */
  listWindows(): Promise<WindowInfo[]>;

  /** Check if the adapter connection is still healthy. */
  isHealthy(): Promise<boolean>;

  /** Clean up resources (close connections, stop processes). */
  cleanup(): Promise<void>;
}
