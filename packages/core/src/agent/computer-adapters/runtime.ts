import { Buffer } from "node:buffer";
import { childLogger } from "../../logger.js";
import { getConfig } from "../../config/loader.js";
import type { ComputerUseConfig, NodeEntry, RemoteAdapterConfig, SshAdapterConfig } from "../../config/computer-use-schema.js";
import { computerSessionManager, type ComputerSession, type ComputerSessionId, type ComputerSessionSnapshot, type DisplayTopology } from "../computer-session.js";
import { computeScreenshotHash } from "../computer-vision.js";
import { recordEvent, startRecording, stopRecording } from "../computer-recording.js";
import type { ActionResult, ComputerAction, ComputerAdapter, WindowInfo } from "./base.js";
import { VscodeComputerAdapter } from "./vscode.js";
import { RemoteNodeComputerAdapter } from "./remote-node.js";
import { VncComputerAdapter } from "./remote-vnc.js";
import { RdpComputerAdapter } from "./remote-rdp.js";
import { SshComputerAdapter } from "./remote-ssh.js";
import { RemoteBridgeComputerAdapter, createRemoteBridgeTarget } from "./remote-bridge.js";

const log = childLogger("agent:computer-adapter-runtime");
const activeAdapters = new Map<ComputerSessionId, ComputerAdapter>();
const autoHeartbeatTimers = new Map<ComputerSessionId, ReturnType<typeof setInterval>>();

const AUTO_HEARTBEAT_INTERVAL_MS = 12_000; // keep well inside the 45 s timeout

function getComputerUseConfig(): ComputerUseConfig {
  const config = getConfig();
  return (config as Record<string, unknown>)["computerUse"] as ComputerUseConfig;
}

function decodeDataUrl(dataUrl: string): Uint8Array {
  const match = /^data:[^;]+;base64,(.+)$/u.exec(dataUrl);
  if (!match) {
    throw new Error("Expected base64 data URL from computer adapter");
  }
  const encoded = match[1];
  if (!encoded) {
    throw new Error("Expected base64 payload in data URL from computer adapter");
  }
  return Buffer.from(encoded, "base64");
}

function buildSnapshotFromDataUrl(sessionId: string, dataUrl: string, width?: number, height?: number): ComputerSessionSnapshot {
  const bytes = decodeDataUrl(dataUrl);
  return {
    screenshotHash: computeScreenshotHash(bytes),
    timestamp: Date.now(),
    frameId: `${sessionId}-${Date.now()}`,
    dataUrl,
    width,
    height,
  };
}

function createAdapter(session: ComputerSession): ComputerAdapter {
  const config = getComputerUseConfig();

  // ── Named node resolution ─────────────────────────────────────────────────
  // If the session targets a named node, pull adapter config from nodes[nodeId]
  // instead of the single-entry adapters.* section.
  if (session.nodeId) {
    const node = config.nodes?.[session.nodeId];
    if (!node) {
      throw new Error(`Computer node '${session.nodeId}' is not configured in computerUse.nodes`);
    }
    return createAdapterFromNodeEntry(node);
  }

  // ── Legacy single-adapter resolution ──────────────────────────────────────
  switch (session.adapter) {
    case "local_vscode":
      return new VscodeComputerAdapter();
    case "remote_node": {
      const remoteNode = config.adapters.remote_node;
      if (!remoteNode) {
        throw new Error("computerUse.adapters.remote_node is not configured");
      }
      return new RemoteNodeComputerAdapter(remoteNode);
    }
    case "remote_vnc": {
      const vncCfg = config.adapters.remote_vnc;
      if (!vncCfg) {
        throw new Error("computerUse.adapters.remote_vnc is not configured — add host, port, and optional credentials");
      }
      if (config.remoteAccessService) {
        return new RemoteBridgeComputerAdapter(config.remoteAccessService, createRemoteBridgeTarget("remote_vnc", vncCfg));
      }
      return new VncComputerAdapter(vncCfg);
    }
    case "remote_rdp": {
      const rdpCfg = config.adapters.remote_rdp;
      if (!rdpCfg) {
        throw new Error("computerUse.adapters.remote_rdp is not configured — add host, port, and credentials");
      }
      if (config.remoteAccessService) {
        return new RemoteBridgeComputerAdapter(config.remoteAccessService, createRemoteBridgeTarget("remote_rdp", rdpCfg));
      }
      return new RdpComputerAdapter(rdpCfg);
    }
    case "remote_ssh": {
      const sshCfg = config.adapters.remote_ssh;
      if (!sshCfg) {
        throw new Error("computerUse.adapters.remote_ssh is not configured — add host, username, and credentials");
      }
      if (config.remoteAccessService) {
        return new RemoteBridgeComputerAdapter(config.remoteAccessService, createRemoteBridgeTarget("remote_ssh", sshCfg));
      }
      return new SshComputerAdapter(sshCfg);
    }
    default:
      throw new Error(`Computer adapter '${session.adapter}' is not implemented yet`);
  }
}

/** Create an adapter instance from a named node entry. */
function createAdapterFromNodeEntry(node: NodeEntry): ComputerAdapter {
  const config = getComputerUseConfig();
  switch (node.adapter) {
    case "remote_vnc":
      if (config.remoteAccessService) {
        return new RemoteBridgeComputerAdapter(config.remoteAccessService, createRemoteBridgeTarget("remote_vnc", node as unknown as RemoteAdapterConfig));
      }
      return new VncComputerAdapter(node as unknown as RemoteAdapterConfig);
    case "remote_rdp":
      if (config.remoteAccessService) {
        return new RemoteBridgeComputerAdapter(config.remoteAccessService, createRemoteBridgeTarget("remote_rdp", node as unknown as RemoteAdapterConfig));
      }
      return new RdpComputerAdapter(node as unknown as RemoteAdapterConfig);
    case "remote_ssh":
      if (config.remoteAccessService) {
        return new RemoteBridgeComputerAdapter(config.remoteAccessService, createRemoteBridgeTarget("remote_ssh", node as unknown as SshAdapterConfig));
      }
      return new SshComputerAdapter(node as unknown as SshAdapterConfig);
    case "remote_node":
      return new RemoteNodeComputerAdapter(node as unknown as import("../../config/computer-use-schema.js").RemoteNodeAdapterConfig);
    default:
      throw new Error(`Unsupported node adapter type: ${(node as { adapter: string }).adapter}`);
  }
}

function stopAutoHeartbeat(sessionId: ComputerSessionId): void {
  const timer = autoHeartbeatTimers.get(sessionId);
  if (timer) {
    clearInterval(timer);
    autoHeartbeatTimers.delete(sessionId);
  }
}

function startAutoHeartbeat(sessionId: ComputerSessionId): void {
  stopAutoHeartbeat(sessionId);
  const timer = setInterval(() => {
    computerSessionManager.heartbeat(sessionId);
  }, AUTO_HEARTBEAT_INTERVAL_MS);
  timer.unref();
  autoHeartbeatTimers.set(sessionId, timer);
}

async function cleanupAdapter(sessionId: ComputerSessionId): Promise<void> {
  stopAutoHeartbeat(sessionId);
  const adapter = activeAdapters.get(sessionId);
  if (!adapter) return;
  activeAdapters.delete(sessionId);
  try {
    await adapter.cleanup();
  } catch (error) {
    log.warn({ sessionId, error }, "Computer adapter cleanup failed");
  }
  await stopRecording(sessionId).catch((error) => {
    log.warn({ sessionId, error }, "Stopping computer recording failed");
  });
}

computerSessionManager.on("session:stopped", (sessionId) => {
  void cleanupAdapter(sessionId);
});

export async function initializeComputerSessionAdapter(session: ComputerSession): Promise<DisplayTopology> {
  const adapter = createAdapter(session);
  await adapter.initialize(session);
  activeAdapters.set(session.id, adapter);
  startAutoHeartbeat(session.id);

  if (session.recordingEnabled) {
    await startRecording(session.id, session.adapter);
  }

  return adapter.getDisplayTopology();
}

export async function captureComputerSessionSnapshot(sessionId: ComputerSessionId): Promise<ComputerSessionSnapshot> {
  const adapter = getComputerAdapter(sessionId);
  const snapshot = await adapter.captureSnapshot();
  computerSessionManager.updateSnapshot(sessionId, snapshot);
  await recordEvent(sessionId, "screenshot", {
    screenshotHash: snapshot.screenshotHash,
    width: snapshot.width,
    height: snapshot.height,
  });
  return snapshot;
}

export async function executeComputerSessionAction(
  sessionId: ComputerSessionId,
  action: ComputerAction,
): Promise<ActionResult & { snapshot?: ComputerSessionSnapshot }> {
  const adapter = getComputerAdapter(sessionId);
  await recordEvent(sessionId, "action", { actionType: action.type, action });
  const result = await adapter.executeAction(action);
  computerSessionManager.heartbeat(sessionId);

  let snapshot: ComputerSessionSnapshot | undefined;
  const dataUrl = (result as ActionResult & { screenshotDataUrl?: string }).screenshotDataUrl ?? result.screenshotAfter;
  const width = (result as ActionResult & { screenshotWidth?: number }).screenshotWidth;
  const height = (result as ActionResult & { screenshotHeight?: number }).screenshotHeight;
  if (dataUrl) {
    snapshot = buildSnapshotFromDataUrl(sessionId, dataUrl, width, height);
    computerSessionManager.updateSnapshot(sessionId, snapshot);
    await recordEvent(sessionId, "screenshot", {
      screenshotHash: snapshot.screenshotHash,
      width: snapshot.width,
      height: snapshot.height,
    });
  }

  await recordEvent(sessionId, "action_result", {
    actionType: action.type,
    success: result.success,
    error: result.error,
  });

  return { ...result, ...(snapshot ? { snapshot } : {}) };
}

export async function listComputerSessionWindows(sessionId: ComputerSessionId): Promise<WindowInfo[]> {
  return getComputerAdapter(sessionId).listWindows();
}

export function getComputerAdapter(sessionId: ComputerSessionId): ComputerAdapter {
  const adapter = activeAdapters.get(sessionId);
  if (!adapter) {
    throw new Error(`No live computer adapter for session '${sessionId}'`);
  }
  return adapter;
}

export async function resetComputerAdapterRuntimeForTests(): Promise<void> {
  for (const sessionId of autoHeartbeatTimers.keys()) {
    stopAutoHeartbeat(sessionId);
  }
  const sessionIds = [...activeAdapters.keys()];
  for (const sessionId of sessionIds) {
    await cleanupAdapter(sessionId);
  }
  activeAdapters.clear();
}