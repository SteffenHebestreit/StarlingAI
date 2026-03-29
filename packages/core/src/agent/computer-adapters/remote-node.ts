import { childLogger } from "../../logger.js";
import type { RemoteNodeAdapterConfig } from "../../config/computer-use-schema.js";
import type { ActionResult, ComputerAction, ComputerAdapter, WindowInfo } from "./base.js";
import type { ComputerSession, ComputerSessionSnapshot, DisplayTopology } from "../computer-session.js";
import type {
  ComputerNodeActionRequest,
  ComputerNodeActionResponse,
  ComputerNodeHealthResponse,
  ComputerNodeSnapshotResponse,
  ComputerNodeTopologyResponse,
  ComputerNodeWindowsResponse,
} from "../computer-node/protocol.js";

const log = childLogger("agent:computer-adapter:remote-node");

export class RemoteNodeComputerAdapter implements ComputerAdapter {
  readonly name = "remote_node";

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly authToken?: string;
  private session: ComputerSession | null = null;

  constructor(private readonly config: RemoteNodeAdapterConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.timeoutMs = config.timeoutMs;
    this.authToken = config.authToken?.trim() || undefined;
  }

  async initialize(session: ComputerSession): Promise<void> {
    this.session = session;
    const health = await this.request<ComputerNodeHealthResponse>("/health");
    if (!health.ok || !health.healthy) {
      throw new Error(`Remote node ${this.config.label} is unhealthy`);
    }
    log.info({ sessionId: session.id, label: this.config.label, baseUrl: this.baseUrl }, "Remote node adapter initialized");
  }

  async captureSnapshot(): Promise<ComputerSessionSnapshot> {
    this.assertInitialized();
    return this.request<ComputerNodeSnapshotResponse>("/snapshot");
  }

  async executeAction(action: ComputerAction): Promise<ActionResult> {
    this.assertInitialized();
    const body: ComputerNodeActionRequest = {
      sessionId: this.session!.id,
      action,
    };
    return this.request<ComputerNodeActionResponse>("/action", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async getDisplayTopology(): Promise<DisplayTopology> {
    this.assertInitialized();
    const response = await this.request<ComputerNodeTopologyResponse>("/display-topology");
    return response.topology;
  }

  async listWindows(): Promise<WindowInfo[]> {
    this.assertInitialized();
    const response = await this.request<ComputerNodeWindowsResponse>("/windows");
    return response.windows;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await this.request<ComputerNodeHealthResponse>("/health");
      return response.ok && response.healthy;
    } catch {
      return false;
    }
  }

  async cleanup(): Promise<void> {
    this.session = null;
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
        throw new Error(`Remote node request failed (${response.status}): ${detail}`);
      }
      return payload as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  private assertInitialized(): void {
    if (!this.session) {
      throw new Error("Remote node adapter is not initialized");
    }
  }
}