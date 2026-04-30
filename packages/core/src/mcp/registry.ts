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
        // Re-fetch connection in case of reconnect
        const live = _connections.get(serverName) ?? conn;
        try {
          const result = await live.client.callTool({
            name: mcpToolName,
            arguments: args,
          });

          const output = (result.content as Array<{ type: string; text?: string }>)
            .map(c => (c.type === "text" ? (c.text ?? "") : JSON.stringify(c)))
            .join("\n");

          return { success: true, output, metadata: { mcpServer: serverName, mcpTool: mcpToolName } };
        } catch (err) {
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
