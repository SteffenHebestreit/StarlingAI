/**
 * MCP server registry.
 * - Connects to all configured MCP servers at startup
 * - Registers each MCP tool as a native StarlingAI tool (name: mcp__<server>__<tool>)
 * - Routes tool calls to the right MCP server
 * - Handles graceful shutdown
 */
import { cleanupConfiguredDockerMcpContainers, connectMcpServer, type McpClientConnection } from "./client.js";
import { registerTool, unregisterTool, warmToolEmbeddings, type ToolResult } from "../tools/registry.js";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { logAudit } from "../audit/logger.js";
import { markRuntimeComponentAttempt, markRuntimeComponentFailure, markRuntimeComponentSuccess } from "../runtime/status.js";
import { withSpan, traceContextCarrier, genAi } from "../observability/tracing.js";
import { SpanKind } from "@opentelemetry/api";

const log = childLogger("mcp:registry");

const _connections = new Map<string, McpClientConnection>();
const _serverToolNames = new Map<string, string[]>();
/**
 * Moves on each time a server is torn down or bridged. Connecting a server takes a while (a
 * docker server starts a container first), and a sync, a shutdown or another reconnect can
 * change the server in that time; a reconnect reads this when its connection comes back, so it
 * can tell its connection is no longer wanted.
 */
const _serverEpoch = new Map<string, number>();

export async function initMcpServers(): Promise<void> {
  await syncMcpServers();
}

export async function syncMcpServers(): Promise<void> {
  cancelFailedServerRetry();
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
          await _bridgeServer(name, conn);
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
      scheduleFailedServerRetry();
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
  cancelFailedServerRetry();
  // A server that a reconnect is still connecting is not in _connections, so it is torn down
  // by name as well: that moves its epoch, and the reconnect closes what it opened instead of
  // bridging it after the shutdown.
  for (const name of new Set([..._connections.keys(), ..._serverEpoch.keys()])) {
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
    const bridged = {
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
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
          const reconnected = await reconnectAfterFailedCall(serverName);
          // The server came back with the tools it lists now, which need not include this one;
          // its tool is unregistered then, and the call is not retried on a server that no
          // longer offers it.
          if (reconnected && !reconnected.tools.some((tool) => tool.name === mcpToolName)) {
            return { success: false, output: "", error: `MCP call failed: ${String(err)}. After reconnecting, ${serverName} no longer offers ${mcpToolName}.` };
          }
          if (reconnected) {
            try { return await runCall(reconnected); }
            catch (retryErr) { return { success: false, output: "", error: `MCP call failed after reconnect: ${String(retryErr)}` }; }
          }
          return { success: false, output: "", error: `MCP call failed: ${String(err)}` };
        }
      },
    };
    registerTool({
      name: safeName,
      description: `[MCP:${serverName}] ${description}`,
      parameters: inputSchema,
      execute: (args) => serverName === "playwright"
        ? guardBrowserCall(mcpToolName, args, () => bridged.execute(args))
        : bridged.execute(args),
    });
    log.debug({ safeName, serverName, mcpToolName }, "Bridged MCP tool registered");
  } catch (err) {
    log.warn({ err, safeName }, "Could not register bridged MCP tool — check tool-tiers");
  }

  return safeName;
}

/**
 * The playwright server drives the gateway's shared browser, and its bridged tools reached it
 * unchecked: mcp__playwright__browser_navigate opened http://10.0.0.5/ as asked, and a page a
 * redirect or script had moved there came back in the answer. They now take the checks the
 * gateway's own browser tools take: the URL before a navigation, and the page an answer reports
 * (or, for an answer of the page that reports none, such as a screenshot, the tab's address read
 * now), which ends the call and sends the tab to about:blank when the guard refuses it.
 */
async function guardBrowserCall(mcpToolName: string, args: Record<string, unknown>, call: () => Promise<ToolResult>): Promise<ToolResult> {
  const { checkUrlSsrf, leaveRefusedPage, refusedBrowserAnswer } = await import("../tools/web.js");
  const url = args["url"];
  if (mcpToolName === "browser_navigate" && typeof url === "string" && url.trim()) {
    const blocked = await checkUrlSsrf(url);
    if (blocked) return { success: false, output: "", error: `Refusing to navigate the browser: ${blocked}.` };
  }
  const result = await call();
  if (!result.success) return result;
  const refused = await refusedBrowserAnswer([result.output]);
  if (!refused) return result;
  await leaveRefusedPage();
  return { success: false, output: "", error: `Refusing to show the page the browser is on: ${refused}. The browser was sent to about:blank.` };
}

// Per-server reconnect throttle so a flapping server can't trigger a reconnect storm.
const _reconnectThrottle = new Map<string, number>();
const MCP_RECONNECT_THROTTLE_MS = 10_000;

/**
 * The server connected again after a call to it failed: when mcp.autoReconnect is on, once per
 * MCP_RECONNECT_THROTTLE_MS per server. Null when it was not tried or did not connect. Every
 * caller of a server goes through here, the bridged mcp__<server>__* tools and the gateway's own
 * browser tools alike (tools/multimodal.ts callPlaywrightTool).
 */
export async function reconnectAfterFailedCall(serverName: string): Promise<McpClientConnection | null> {
  if (!getConfig().mcp?.autoReconnect) return null;
  const last = _reconnectThrottle.get(serverName) ?? 0;
  if (Date.now() - last < MCP_RECONNECT_THROTTLE_MS) return null;
  _reconnectThrottle.set(serverName, Date.now());
  return reconnectServer(serverName);
}

/**
 * Reconnect a SINGLE bridged server (not the whole fleet) after a failed call.
 *
 * The teardown unregisters the server's mcp__<server>__* tools, and the reconnect used to set only
 * the new connection: agents lost those tools until the next sync or a gateway restart. A
 * reconnect that succeeds now bridges the server again as a sync does, with the tools the server
 * lists now and the browser guard on the playwright ones. One that does not succeed leaves the
 * server torn down, with none of its tools registered: the connect failed, the config no longer
 * starts the server, or a sync, a shutdown or another reconnect changed the server while this
 * one was connecting, in which case the new connection is closed. When this reconnect's connection
 * comes back first and a sync that tore the server down is still connecting, the sync's bridge
 * replaces and closes it when the sync's own connection comes back.
 */
async function reconnectServer(name: string, why = "after a failed tool call"): Promise<McpClientConnection | null> {
  await teardownServer(name);
  const epoch = _serverEpoch.get(name);
  const cfg = getConfig().mcp?.servers?.[name];
  if (!cfg?.autoStart) return null;
  let conn: McpClientConnection;
  try {
    conn = await connectMcpServer(name, cfg);
  } catch (err) {
    log.warn({ err, server: name }, "MCP server reconnect failed");
    return null;
  }
  if (_serverEpoch.get(name) !== epoch || !getConfig().mcp?.servers?.[name]?.autoStart) {
    try {
      await conn.disconnect();
    } catch (err) {
      log.warn({ err, server: name }, "Error disconnecting MCP server");
    }
    log.info({ server: name }, "MCP server changed while it was reconnecting; the new connection was closed");
    return null;
  }
  await _bridgeServer(name, conn);
  log.info({ server: name, tools: conn.tools.length }, `MCP server reconnected ${why}`);
  return conn;
}

/**
 * A server that failed to connect is tried again, alone, after 30 s, then twice as long each time up to
 * 5 min, until it connects or a sync or a shutdown takes over. The gateway used to connect its servers
 * at boot and on an mcp config reload only, so a server whose host came up after the gateway — a
 * companion stack started next to a running gateway (2026-10-12) — stayed failed, its tools missing,
 * until the gateway was recreated. Each attempt is reconnectServer's, so a sync that changes the
 * server meanwhile wins, and the servers already connected are not touched.
 */
const MCP_RETRY_BASE_MS = 30_000;
const MCP_RETRY_MAX_MS = 300_000;
let _retryTimer: ReturnType<typeof setTimeout> | undefined;
let _retryRound = 0;

function cancelFailedServerRetry(): void {
  if (_retryTimer) clearTimeout(_retryTimer);
  _retryTimer = undefined;
  _retryRound = 0;
}

function scheduleFailedServerRetry(): void {
  if (_retryTimer) clearTimeout(_retryTimer);
  const delay = Math.min(MCP_RETRY_MAX_MS, MCP_RETRY_BASE_MS * 2 ** _retryRound);
  _retryRound += 1;
  _retryTimer = setTimeout(() => {
    _retryTimer = undefined;
    void retryFailedServers().catch((err) => log.warn({ err }, "MCP retry of failed servers failed"));
  }, delay);
  _retryTimer.unref?.();
}

/** The configured autoStart servers that have no connection. */
function unconnectedServers(): string[] {
  return Object.entries(getConfig().mcp?.servers ?? {})
    .filter(([name, cfg]) => cfg.autoStart && !_connections.has(name))
    .map(([name]) => name);
}

async function retryFailedServers(): Promise<void> {
  const missing = unconnectedServers();
  if (missing.length === 0) {
    _retryRound = 0;
    return;
  }
  const toolNames: string[] = [];
  for (const name of missing) {
    const conn = await reconnectServer(name, "on retry after it failed to connect");
    if (conn) toolNames.push(...(_serverToolNames.get(name) ?? []));
  }
  const failed = unconnectedServers().length;
  const state = { connected: _connections.size, failed, servers: [..._connections.keys()] };
  if (failed > 0) {
    markRuntimeComponentSuccess("mcp", state, { healthy: false, error: `${failed} MCP server(s) failed to connect` });
    scheduleFailedServerRetry();
  } else {
    markRuntimeComponentSuccess("mcp", state);
    _retryRound = 0;
  }
  if (toolNames.length > 0) {
    void warmToolEmbeddings(toolNames).then((warm) => {
      if (warm.warmed > 0) {
        logAudit("tool_embeddings_warmed", { warmed: warm.warmed, skipped: warm.skipped, durationMs: warm.durationMs, source: "mcp_retry" });
      }
    }).catch(() => undefined);
  }
}

/**
 * Makes `conn` the server's connection and registers the tools it lists as mcp__<server>__*.
 *
 * A sync bridges the server as soon as its connect comes back, and in that time a reconnect, or
 * another sync, may have bridged the server already. That connection used to be overwritten and
 * never closed, so a docker server's container kept running, and a tool that only it listed stayed
 * registered. Now the connection already there is replaced in one step: its tools are unregistered
 * before this connection's are registered, and it is closed afterwards.
 */
async function _bridgeServer(name: string, conn: McpClientConnection): Promise<void> {
  const replaced = _connections.get(name);
  for (const toolName of _serverToolNames.get(name) ?? []) {
    unregisterTool(toolName);
  }
  _connections.set(name, conn);
  const toolNames: string[] = [];
  for (const tool of conn.tools) {
    toolNames.push(_registerBridgedTool(name, tool.name, tool.description, tool.inputSchema, conn));
  }
  _serverToolNames.set(name, toolNames);
  _serverEpoch.set(name, (_serverEpoch.get(name) ?? 0) + 1);
  if (replaced && replaced !== conn) {
    try {
      await replaced.disconnect();
      log.info({ server: name }, "MCP server's earlier connection closed; a newer one replaced it");
    } catch (err) {
      log.warn({ err, server: name }, "Error disconnecting MCP server");
    }
  }
}

async function teardownServer(name: string): Promise<void> {
  _serverEpoch.set(name, (_serverEpoch.get(name) ?? 0) + 1);
  const conn = _connections.get(name);
  if (conn) {
    try {
      await conn.disconnect();
      log.info({ server: name }, "MCP server disconnected");
    } catch (err) {
      log.warn({ err, server: name }, "Error disconnecting MCP server");
    }
    // Closing takes a while (a docker server's container is removed), and a sync can bridge the
    // server in that time. This teardown then removed that newer connection and its tools, leaving
    // the connection open with nothing holding it. The bridge has already replaced this connection
    // and unregistered its tools, and another teardown that took it out has done the same, so
    // what the server has now is left alone.
    if (_connections.get(name) !== conn) return;
    _connections.delete(name);
  }

  const toolNames = _serverToolNames.get(name) ?? [];
  for (const toolName of toolNames) {
    unregisterTool(toolName);
  }
  _serverToolNames.delete(name);
}
