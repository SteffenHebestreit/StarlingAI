import type { RemoteAdapterConfig, SshAdapterConfig } from "../../config/computer-use-schema.js";
import type { ActionResult, ComputerAction, WindowInfo } from "../computer-adapters/base.js";
import type { ComputerSessionSnapshot, DisplayTopology } from "../computer-session.js";

export type ComputerRemoteTargetSpec =
  | { adapter: "remote_vnc"; config: RemoteAdapterConfig }
  | { adapter: "remote_rdp"; config: RemoteAdapterConfig }
  | { adapter: "remote_ssh"; config: SshAdapterConfig };

export interface ComputerRemoteHealthResponse {
  ok: true;
  healthy: boolean;
  label: string;
  activeSessions: number;
}

export interface ComputerRemoteSessionStartRequest {
  sessionId: string;
  target: ComputerRemoteTargetSpec;
}

export interface ComputerRemoteSessionStartResponse {
  ok: true;
  sessionId: string;
  topology: DisplayTopology;
}

export interface ComputerRemoteSessionStopRequest {
  sessionId: string;
}

export interface ComputerRemoteSessionStopResponse {
  ok: true;
  sessionId: string;
}

export interface ComputerRemoteActionRequest {
  action: ComputerAction;
}

export interface ComputerRemoteActionResponse extends ActionResult {
  screenshotDataUrl?: string;
  screenshotWidth?: number;
  screenshotHeight?: number;
}

export interface ComputerRemoteWindowsResponse {
  windows: WindowInfo[];
}

export interface ComputerRemoteTopologyResponse {
  topology: DisplayTopology;
}

export interface ComputerRemoteSessionHealthResponse {
  ok: true;
  healthy: boolean;
  sessionId: string;
}

export interface ComputerRemoteSnapshotResponse extends ComputerSessionSnapshot {
  dataUrl?: string;
  width?: number;
  height?: number;
}