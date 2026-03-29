import { childLogger } from "../../logger.js";
import type { RemoteAccessServiceConfig, RemoteAdapterConfig, SshAdapterConfig } from "../../config/computer-use-schema.js";
import type { ActionResult, ComputerAction, ComputerAdapter, WindowInfo } from "./base.js";
import type { ComputerSession, ComputerSessionSnapshot, DisplayTopology } from "../computer-session.js";
import type {
  ComputerRemoteActionRequest,
  ComputerRemoteActionResponse,
  ComputerRemoteHealthResponse,
  ComputerRemoteSessionHealthResponse,
  ComputerRemoteSessionStartRequest,
  ComputerRemoteSessionStartResponse,
  ComputerRemoteSessionStopResponse,
  ComputerRemoteSnapshotResponse,
  ComputerRemoteTargetSpec,
  ComputerRemoteTopologyResponse,
  ComputerRemoteWindowsResponse,
} from "../computer-remote/protocol.js";

const log = childLogger("agent:computer-adapter:remote-bridge");

export class RemoteBridgeComputerAdapter implements ComputerAdapter {
  readonly name: string;

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly authToken?: string;
  private session: ComputerSession | null = null;
  private topology: DisplayTopology | null = null;

  constructor(
    private readonly service: RemoteAccessServiceConfig,
    private readonly target: ComputerRemoteTargetSpec,
  ) {
    this.name = target.adapter;
    this.baseUrl = service.baseUrl.replace(/\/$/, "");
    this.timeoutMs = service.timeoutMs;
    this.authToken = service.authToken?.trim() || undefined;
  }

  async initialize(session: ComputerSession): Promise<void> {
    this.session = session;
    const started = await this.request<ComputerRemoteSessionStartResponse>("/sessions/start", {
      method: "POST",
      body: JSON.stringify({ sessionId: session.id, target: this.target } satisfies ComputerRemoteSessionStartRequest),
    });
    this.topology = started.topology;
    log.info({ sessionId: session.id, adapter: this.target.adapter, service: this.service.label }, "Remote bridge session started");
  }

  async captureSnapshot(): Promise<ComputerSessionSnapshot> {
    this.assertInitialized();
    return this.request<ComputerRemoteSnapshotResponse>(`/sessions/${this.session!.id}/snapshot`);
  }

  async executeAction(action: ComputerAction): Promise<ActionResult> {
    this.assertInitialized();
    return this.request<ComputerRemoteActionResponse>(`/sessions/${this.session!.id}/action`, {
      method: "POST",
      body: JSON.stringify({ action } satisfies ComputerRemoteActionRequest),
    });
  }

  async getDisplayTopology(): Promise<DisplayTopology> {
    this.assertInitialized();
    if (this.topology) return this.topology;
    const response = await this.request<ComputerRemoteTopologyResponse>(`/sessions/${this.session!.id}/display-topology`);
    this.topology = response.topology;
    return response.topology;
  }

  async listWindows(): Promise<WindowInfo[]> {
    this.assertInitialized();
    const response = await this.request<ComputerRemoteWindowsResponse>(`/sessions/${this.session!.id}/windows`);
    return response.windows;
  }

  async isHealthy(): Promise<boolean> {
    try {
      if (this.session) {
        const response = await this.request<ComputerRemoteSessionHealthResponse>(`/sessions/${this.session.id}/health`);
        return response.healthy;
      }
      const response = await this.request<ComputerRemoteHealthResponse>("/health");
      return response.healthy;
    } catch {
      return false;
    }
  }

  async cleanup(): Promise<void> {
    if (!this.session) return;
    try {
      await this.request<ComputerRemoteSessionStopResponse>("/sessions/stop", {
        method: "POST",
        body: JSON.stringify({ sessionId: this.session.id }),
      });
    } catch (error) {
      log.warn({ sessionId: this.session.id, error }, "Remote bridge session stop failed during cleanup");
    } finally {
      this.session = null;
      this.topology = null;
    }
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref();

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          ...(this.authToken ? { authorization: `Bearer ${this.authToken}` } : {}),
          ...(init?.headers ?? {}),
        },
        signal: controller.signal,
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = typeof payload?.error === "string" ? payload.error : response.statusText;
        throw new Error(`Remote access service request failed (${response.status}): ${detail}`);
      }
      return payload as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private assertInitialized(): void {
    if (!this.session) {
      throw new Error("Remote bridge adapter is not initialized");
    }
  }
}

export function createRemoteBridgeTarget(adapter: "remote_vnc" | "remote_rdp", config: RemoteAdapterConfig): ComputerRemoteTargetSpec;
export function createRemoteBridgeTarget(adapter: "remote_ssh", config: SshAdapterConfig): ComputerRemoteTargetSpec;
export function createRemoteBridgeTarget(
  adapter: "remote_vnc" | "remote_rdp" | "remote_ssh",
  config: RemoteAdapterConfig | SshAdapterConfig,
): ComputerRemoteTargetSpec {
  if (adapter === "remote_ssh") {
    return { adapter, config: config as SshAdapterConfig };
  }
  return { adapter, config: config as RemoteAdapterConfig };
}