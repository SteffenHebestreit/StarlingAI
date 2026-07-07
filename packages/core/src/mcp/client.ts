/**
 * MCP client factory.
 * Supports stdio, docker-run, docker-exec, HTTP transports, and raw TCP transports.
 */
import { execFile } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerConfig } from "../config/schema.js";
import { childLogger } from "../logger.js";

const log = childLogger("mcp:client");
const execFileAsync = promisify(execFile);

/**
 * Reject a docker-transport MCP server whose config would break container
 * isolation and hand it host-root / host-secret access. Fail CLOSED — an unsafe
 * mount or network turns a mere config entry into a full-host compromise
 * (mounting the docker socket = root-equivalent; mounting host root or the repo =
 * reading .env / credentials.enc; --network=host = the host's network stack).
 * Exported for testing.
 */
export function assertSafeMcpDockerConfig(config: { mounts?: string[]; network?: string }, serverName: string): void {
  const net = config.network?.trim().toLowerCase();
  if (net === "host" || net === "container:host") {
    throw new Error(`MCP server "${serverName}" is refused: network "${config.network}" would share the host network namespace.`);
  }
  for (const mount of config.mounts ?? []) {
    const source = String(mount).split(":")[0]?.trim() ?? "";
    const lower = source.toLowerCase().replace(/\\/g, "/");
    const forbidden =
      /docker\.sock/.test(lower) ||                                  // docker socket = host root
      lower === "/" || lower === "" ||                               // whole host FS
      /^\/(etc|root|home|var|proc|sys|boot|dev)(\/|$)/.test(lower) || // sensitive host dirs
      lower.startsWith("/var/run") ||                                // sockets (docker/podman/etc.)
      /(^|\/)\.env(\.|$)/.test(lower) ||                             // .env files
      /(^|\/)\.starlingai(\/|$)/.test(lower) ||                      // credentials.enc / state
      /credential/.test(lower);                                     // any credential store
    if (forbidden) {
      throw new Error(`MCP server "${serverName}" is refused: mount "${mount}" targets a sensitive host path (docker socket, host root, /etc, /var/run, .env, or credentials). Remove it or mount a dedicated data directory instead.`);
    }
  }
}

const MCP_CONTAINER_LABEL = "starlingai.managed=mcp";
const MCP_SERVER_LABEL_PREFIX = "starlingai.mcp.server=";
const MCP_CONTAINER_NAME_PREFIX = "starlingai-mcp-";
/** Cap the legacy HTTP transport's buffered response so a hostile endpoint can't OOM us. */
const LEGACY_HTTP_MAX_BODY_BYTES = 8 * 1024 * 1024;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpClientConnection {
  serverName: string;
  client: Client;
  tools: McpTool[];
  disconnect(): Promise<void>;
}

export async function connectMcpServer(
  serverName: string,
  config: McpServerConfig
): Promise<McpClientConnection> {
  const runtime = createDockerRuntime(serverName, config);
  const transport = buildTransport(serverName, config, runtime?.containerName);
  const client = new Client({ name: "starlingai", version: "0.1.0" }, { capabilities: {} });

  let tools: McpTool[];
  try {
    await client.connect(transport);
    // listTools() must be INSIDE the try: once connect() succeeds the transport is
    // live, so a listTools failure has to tear down the client AND the docker
    // container — otherwise both leak (a connected Server + a running container).
    const toolsResult = await client.listTools();
    tools = (toolsResult.tools ?? []).map(t => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
    }));
  } catch (err) {
    try { await client.close(); } catch { /* transport may not be open */ }
    if (runtime) await forceRemoveDockerContainer(runtime.containerName);
    throw err;
  }

  log.info({ serverName, toolCount: tools.length, tools: tools.map(t => t.name) }, "MCP server connected");

  return {
    serverName,
    client,
    tools,
    async disconnect() {
      try { await client.close(); } catch { /* ignore */ }
      if (runtime) {
        await forceRemoveDockerContainer(runtime.containerName);
      }
    },
  };
}

export async function cleanupConfiguredDockerMcpContainers(configs: McpServerConfig[]): Promise<void> {
  const dockerConfigs = configs.filter((cfg): cfg is Extract<McpServerConfig, { transport: "docker" }> => cfg.transport === "docker");
  if (dockerConfigs.length === 0) return;

  const removed = new Set<string>();

  for (const cfg of dockerConfigs) {
    for (const containerId of await listContainersByImage(cfg.image)) {
      if (removed.has(containerId)) continue;
      await forceRemoveDockerContainer(containerId);
      removed.add(containerId);
    }
  }

  for (const containerId of await listManagedMcpContainers()) {
    if (removed.has(containerId)) continue;
    await forceRemoveDockerContainer(containerId);
    removed.add(containerId);
  }

  if (removed.size > 0) {
    log.info({ removed: removed.size }, "Removed stale MCP docker containers");
  }
}

// ─── Transport builders ───────────────────────────────────────────────────────

function buildTransport(serverName: string, config: McpServerConfig, containerName?: string): Transport {
  switch (config.transport) {
    case "stdio":
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env ? { ...process.env, ...config.env } as Record<string, string> : undefined,
      });

    case "docker": {
      // Fail closed on isolation-breaking mounts/network before we ever docker run.
      assertSafeMcpDockerConfig(config, serverName);
      // Spawn a fresh container and pipe stdio to MCP
      const dockerArgs = [
        "run", "--rm", "-i",
        ...(containerName ? ["--name", containerName] : []),
        "--label", MCP_CONTAINER_LABEL,
        "--label", `${MCP_SERVER_LABEL_PREFIX}${serverName}`,
        ...(config.network ? [`--network=${config.network}`] : ["--network=none"]),
        ...Object.entries(config.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
        ...(config.mounts ?? []).flatMap(m => ["-v", m]),
        ...(config.addHosts ?? []).flatMap(h => ["--add-host", h]),
        config.image,
        ...(config.args ?? []),
      ];
      return new StdioClientTransport({ command: "docker", args: dockerArgs });
    }

    case "docker-exec": {
      // Connect to an already-running container via docker exec
      return new StdioClientTransport({
        command: "docker",
        args: ["exec", "-i", config.container, ...(config.args.length ? config.args : [])],
      });
    }

    case "http":
      if (config.protocol === "legacy-jsonrpc") {
        return new LegacyHttpJsonRpcClientTransport(new URL(config.url), config.headers);
      }
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: config.headers ? { headers: config.headers } : undefined,
      });

    case "tcp":
      return new TcpClientTransport(config.host, config.port);

    default:
      throw new Error(`Unknown MCP transport: ${(config as McpServerConfig).transport}`);
  }
}

function createDockerRuntime(serverName: string, config: McpServerConfig): { containerName: string } | null {
  if (config.transport !== "docker") return null;
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    containerName: `${MCP_CONTAINER_NAME_PREFIX}${sanitizeDockerName(serverName)}-${suffix}`,
  };
}

function sanitizeDockerName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "server";
}

async function listContainersByImage(image: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "ps", "-aq",
      "--filter", `ancestor=${image}`,
    ]);
    return stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  } catch (err) {
    log.warn({ err, image }, "Failed to list MCP containers by image");
    return [];
  }
}

async function listManagedMcpContainers(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("docker", [
      "ps", "-aq",
      "--filter", `label=${MCP_CONTAINER_LABEL}`,
    ]);
    return stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  } catch (err) {
    log.warn({ err }, "Failed to list managed MCP containers");
    return [];
  }
}

async function forceRemoveDockerContainer(containerRef: string): Promise<void> {
  try {
    await execFileAsync("docker", ["rm", "-f", containerRef]);
  } catch (err) {
    log.debug({ err, containerRef }, "MCP container already absent or could not be removed");
  }
}

// ─── Raw TCP transport (for Docker Desktop socat bridge) ─────────────────────

/**
 * MCP-over-TCP: newline-delimited JSON-RPC messages over a raw TCP socket.
 * Used to connect to Docker Desktop's `socat TCP-LISTEN:<port> EXEC:docker mcp gateway run` bridge.
 */
class TcpClientTransport implements Transport {
  /** Cap a single unterminated line so a server can't grow buf without bound → OOM. */
  private static readonly MAX_BUFFER_BYTES = 16 * 1024 * 1024;
  private socket?: Socket;
  private buf = "";

  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;

  constructor(private readonly host: string, private readonly port: number) {}

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = createConnection({ host: this.host, port: this.port });
      this.socket = sock;

      sock.once("connect", () => resolve());
      sock.once("error", reject);

      sock.setEncoding("utf8");
      sock.on("data", (chunk: string) => {
        this.buf += chunk;
        if (this.buf.length > TcpClientTransport.MAX_BUFFER_BYTES) {
          const err = new Error(`MCP TCP receive buffer exceeded ${TcpClientTransport.MAX_BUFFER_BYTES} bytes without a newline delimiter`);
          this.buf = "";
          this.onerror?.(err);
          sock.destroy(err); // triggers the "close" handler → onclose cleanup
          return;
        }
        const lines = this.buf.split("\n");
        this.buf = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const msg = JSON.parse(trimmed) as JSONRPCMessage;
            this.onmessage?.(msg);
          } catch {
            // ignore malformed lines
          }
        }
      });

      sock.on("close", () => this.onclose?.());
      sock.on("error", err => this.onerror?.(err));
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(message) + "\n";
      this.socket?.write(data, "utf8", err => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    this.socket?.destroy();
  }
}

class LegacyHttpJsonRpcClientTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onerror?: (error: Error) => void;
  onclose?: () => void;
  sessionId?: string;

  constructor(
    private readonly url: URL,
    private readonly headers?: Record<string, string>,
  ) {}

  async start(): Promise<void> {
    // No long-lived connection required for legacy request/response JSON-RPC.
  }

  async send(message: JSONRPCMessage): Promise<void> {
    // Bound a hung request (the SDK's own 60s timeout can't abort THIS leaked fetch)
    // and cap the buffered body so a hostile/broken endpoint can't OOM the process.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("legacy MCP request timeout")), 55_000);
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(this.headers ?? {}),
          ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      });

      const nextSessionId = response.headers.get("Mcp-Session-Id")?.trim();
      if (nextSessionId) {
        this.sessionId = nextSessionId;
      }

      const declared = Number(response.headers.get("content-length") ?? "");
      if (Number.isFinite(declared) && declared > LEGACY_HTTP_MAX_BODY_BYTES) {
        throw new Error(`Legacy MCP endpoint response body too large (Content-Length ${declared} > ${LEGACY_HTTP_MAX_BODY_BYTES})`);
      }
      const bodyText = await response.text();
      if (bodyText.length > LEGACY_HTTP_MAX_BODY_BYTES) {
        throw new Error(`Legacy MCP endpoint response exceeded ${LEGACY_HTTP_MAX_BODY_BYTES} bytes`);
      }
      if (!bodyText.trim()) {
        // A compliant empty body is valid only for a JSON-RPC *notification* (a
        // message with no id), which legitimately gets a 202/204 with no payload
        // (e.g. notifications/initialized right after init). A non-2xx empty body,
        // or an empty body for an id-bearing request, is still an error.
        if (!response.ok) {
          throw new Error(`Legacy MCP endpoint returned HTTP ${response.status} with an empty body`);
        }
        const sent = message as { method?: unknown; id?: unknown };
        const isNotification = typeof sent.method === "string" && sent.id === undefined;
        if (isNotification) return;
        throw new Error(`Legacy MCP endpoint returned an empty response with HTTP ${response.status}`);
      }

      let payload: JSONRPCMessage;
      try {
        payload = JSON.parse(bodyText) as JSONRPCMessage;
      } catch (error) {
        throw new Error(error instanceof Error ? `Legacy MCP endpoint returned invalid JSON: ${error.message}` : "Legacy MCP endpoint returned invalid JSON");
      }

      this.onmessage?.(payload);
    } catch (error) {
      const wrapped = error instanceof Error ? error : new Error(String(error));
      this.onerror?.(wrapped);
      throw wrapped;
    } finally {
      clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    this.onclose?.();
  }
}
