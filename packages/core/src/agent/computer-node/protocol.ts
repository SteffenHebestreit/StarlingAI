import type { ComputerAction, ActionResult, WindowInfo } from "../computer-adapters/base.js";
import type { ComputerSessionSnapshot, DisplayTopology } from "../computer-session.js";

export interface ComputerNodeHealthResponse {
  ok: true;
  healthy: boolean;
  label: string;
  platform: NodeJS.Platform;
}

export interface ComputerNodeActionRequest {
  sessionId: string;
  action: ComputerAction;
}

export interface ComputerNodeActionResponse extends ActionResult {
  screenshotDataUrl?: string;
  screenshotWidth?: number;
  screenshotHeight?: number;
}

export interface ComputerNodeSnapshotResponse extends ComputerSessionSnapshot {
  dataUrl: string;
  width: number;
  height: number;
}

export interface ComputerNodeWindowsResponse {
  windows: WindowInfo[];
}

export interface ComputerNodeTopologyResponse {
  topology: DisplayTopology;
}