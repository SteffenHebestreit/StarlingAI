/**
 * MCP server registry.
 * - Connects to all configured MCP servers at startup
 * - Registers each MCP tool as a native StarlingAI tool (name: mcp__<server>__<tool>)
 * - Routes tool calls to the right MCP server
 * - Handles graceful shutdown
 */
import { cleanupConfiguredDockerMcpContainers, connectMcpServer, type McpClientConnection } from "./client.js";
import { registerTool, unregisterTool, warmToolEmbeddings } from "../tools/registry.js";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";
import { markRuntimeComponentAttempt, markRuntimeComponentFailure, markRuntimeComponentSuccess } from "../runtime/status.js";
import { withSpan, traceContextCarrier, genAi } from "../observability/tracing.js";
import { SpanKind } from "@opentelemetry/api";

const log = childLogger("mcp:registry");

const _connections = new Map<string, McpClientConnection>();
const _serverToolNames = new Map<string, string[]>();

export async function initMcpServers(): Promise<void> {
  await syncMcpServers();
}

export async function syncMcpServers(): Promise<void> {
  markRuntimeComponentAttempt("mcp");
  try {
    const config = getConfig();
    const servers = config.mcp?.servers ?? {};
    const desiredEntries = Object.entries(servers).filter(([, cfg]) => cfg.autoStart);
    const desiredNames = new Set(desiredEntries.map(([name]) => name));

    if (_connections.size === 0) {
      await cleanupConfiguredDockerMcpContainers(desiredEntries.map(([, cfg]) => cfg));
    }

    for (const name of [..._connections.keys()]) {
      if (!desiredNames.has(name)) {
        await teardownServer(name);
      }
    }

    if (desiredEntries.length === 0) {
      log.debug("No MCP servers configured");
      markRuntimeComponentSuccess("mcp", { connected: 0, failed: 0, servers: [] });
      return;
    }

    const results = await Promise.allSettled(
      desiredEntries.map(async ([name, cfg]) => {
          await teardownServer(name);
          const conn = await connectMcpServer(name, cfg);
          _connections.set(name, conn);
          const toolNames: string[] = [];
          for (const tool of conn.tools) {
            toolNames.push(_registerBridgedTool(name, tool.name, tool.description, tool.inputSchema, conn));
          }
          _serverToolNames.set(name, toolNames);
          return { name, toolCount: conn.tools.length };
        })
    );

    let ok = 0;
    let failed = 0;
    for (const r of results) {
      if (r.status === "fulfilled") {
        ok++;
        log.info({ server: r.value.name, tools: r.value.toolCount }, "MCP server ready");
      } else {
        failed++;
        log.error({ err: r.reason }, "MCP server failed to connect");
      }
    }

    log.info({ ok, failed }, "MCP servers initialized");
    if (failed > 0) {
      markRuntimeComponentSuccess("mcp", { connected: ok, failed, servers: [..._connections.keys()] }, { healthy: false, error: `${failed} MCP server(s) failed to connect` });
    } else {
      markRuntimeComponentSuccess("mcp", { connected: ok, failed, servers: [..._connections.keys()] });
    }

    // Incrementally warm embeddings for the freshly-bridged tools so the
    // reranker can route to them on the very next turn.  A no-op when the
    // embedding provider is unavailable.
    const newToolNames: string[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") {
        const names = _serverToolNames.get(r.value.name);
        if (names) newToolNames.push(...names);
      }
    }
    if (newToolNames.length > 0) {
      void warmToolEmbeddings(newToolNames).then((warm) => {
        if (warm.warmed > 0) {
          logAudit("tool_embeddings_warmed", {
            warmed: warm.warmed,
            skipped: warm.skipped,
            durationMs: warm.durationMs,
            source: "mcp_sync",
          });
        }
      }).catch(() => undefined);
    }
  } catch (err) {
    markRuntimeComponentFailure("mcp", err, { connected: _connections.size, servers: [..._connections.keys()] });
    throw err;
  }
}

export async function shutdownMcpServers(): Promise<void> {
  for (const name of [..._connections.keys()]) {
    await teardownServer(name);
  }
}

export function getMcpConnections(): ReadonlyMap<string, McpClientConnection> {
  return _connections;
}

// ─── Tool bridge ─────────────────────────────────────────────────────────────

/**
 * Registers a bridged MCP tool as a native StarlingAI tool.
 * Tool name format: mcp__<serverName>__<toolName>
 * e.g.  mcp__playwright__browser_navigate, mcp__docker_gateway__node_code_sandbox
 */
function _registerBridgedTool(
  serverName: string,
  mcpToolName: string,
  description: string,
  inputSchema: Record<string, unknown>,
  conn: McpClientConnection
): string {
  // Sanitize: only allow alphanumeric + underscore in the compound name
  const safeName = `mcp__${serverName.replace(/[^a-z0-9_]/gi, "_")}__${mcpToolName.replace(/[^a-z0-9_]/gi, "_")}`;

  try {
    registerTool({
      name: safeName,
      description: `[MCP:${serverName}] ${description}`,
      parameters: inputSchema,
      async execute(args) {
        const runCall = async (connection: McpClientConnection) =>
          // Wrap the remote call in its own span so an external MCP server's
          // latency is visible in the trace even if it ignores `_meta`, and
          // propagate W3C trace context via `params._meta` (the same mechanism
          // MCP itself uses for progress tokens) so a trace-aware MCP server can
          // stitch its spans into ours. `traceContextCarrier()` returns undefined
          // when tracing is off, so nothing is added on the default path.
          withSpan(
            "mcp.tools/call",
            {
              "mcp.server.name": serverName,
              "mcp.tool.name": mcpToolName,
              ...genAi.toolAttributes(mcpToolName),
            },
            async () => {
              const meta = traceContextCarrier();
              const result = await connection.client.callTool({
                name: mcpToolName,
                arguments: args,
                ...(meta ? { _meta: meta } : {}),
              });
              const output = (result.content as Array<{ type: string; text?: string }>)
                .map(c => (c.type === "text" ? (c.text ?? "") : JSON.stringify(c)))
                .join("\n");
              return { success: true as const, output, metadata: { mcpServer: serverName, mcpTool: mcpToolName } };
            },
            SpanKind.CLIENT,
          );
        // Re-fetch connection in case of reconnect
        const live = _connections.get(serverName) ?? conn;
        try {
          return await runCall(live);
        } catch (err) {
          // One lazy reconnect + retry when the server dropped (config-gated, throttled),
          // so a restarted MCP server self-heals instead of every call staying dead.
          if (getConfig().mcp?.autoReconnect) {
            const last = _reconnectThrottle.get(serverName) ?? 0;
            if (Date.now() - last >= MCP_RECONNECT_THROTTLE_MS) {
              _reconnectThrottle.set(serverName, Date.now());
              const reconnected = await reconnectServer(serverName);
              if (reconnected) {
                try { return await runCall(reconnected); }
                catch (retryErr) { return { success: false, output: "", error: `MCP call failed after reconnect: ${String(retryErr)}` }; }
              }
            }
          }
          return { success: false, output: "", error: `MCP call failed: ${String(err)}` };
        }
      },
    });
    log.debug({ safeName, serverName, mcpToolName }, "Bridged MCP tool registered");
  } catch (err) {
    log.warn({ err, safeName }, "Could not register bridged MCP tool — check tool-tiers");
  }

  return safeName;
}

// Per-server reconnect throttle so a flapping server can't trigger a reconnect storm.
const _reconnectThrottle = new Map<string, number>();
const MCP_RECONNECT_THROTTLE_MS = 10_000;

/** Reconnect a SINGLE bridged server (not the whole fleet) after a failed call. */
async function reconnectServer(name: string): Promise<McpClientConnection | null> {
  const cfg = getConfig().mcp?.servers?.[name];
  if (!cfg) return null;
  await teardownServer(name);
  try {
    const conn = await connectMcpServer(name, cfg);
    _connections.set(name, conn);
    log.info({ server: name }, "MCP server reconnected after a failed tool call");
    return conn;
  } catch (err) {
    log.warn({ err, server: name }, "MCP server reconnect failed");
    return null;
  }
}

async function teardownServer(name: string): Promise<void> {
  const conn = _connections.get(name);
  if (conn) {
    try {
      await conn.disconnect();
      log.info({ server: name }, "MCP server disconnected");
    } catch (err) {
      log.warn({ err, server: name }, "Error disconnecting MCP server");
    }
    _connections.delete(name);
  }

  const toolNames = _serverToolNames.get(name) ?? [];
  for (const toolName of toolNames) {
    unregisterTool(toolName);
  }
  _serverToolNames.delete(name);
}
