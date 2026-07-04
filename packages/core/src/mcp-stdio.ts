/**
 * Stdio entrypoint for the StarlingAI MCP server.
 *
 * Operators wire this into external tooling like so:
 *
 *   claude mcp add starlingai -- node /path/to/dist/mcp-stdio.js
 *
 * Or for Cursor / Claude Desktop, register the same command in the client's
 * MCP server config.  The process loads the same StarlingAI runtime the
 * gateway uses (config + tool registry + sub-agents), then connects the
 * MCP `Server` to a stdio transport instead of the HTTP/SSE listener.
 *
 * This entrypoint is intentionally minimal: we initialize JUST what the MCP
 * surface needs (config + audit + the core tool registrations).  Heavier
 * subsystems (channels, scene worker, federation, swarm bus) are skipped so
 * a stdio invocation doesn't accidentally hold network sockets open.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig, getConfig } from "./config/loader.js";
import { initTracing, shutdownTracing } from "./observability/tracing.js";
import { initMcpServers, shutdownMcpServers } from "./mcp/registry.js";
import { loadDynamicTools, shutdownDynamicTools } from "./tools/dynamic-tools.js";
import { loadPlugins } from "./plugin/loader.js";
import { warmToolEmbeddings } from "./tools/registry.js";
import { createStarlingMcpServer } from "./mcp/server.js";
import { childLogger } from "./logger.js";
import { PRODUCT } from "./product/index.js";

const log = childLogger("mcp-stdio");

async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.mcp.expose.enabled) {
    process.stderr.write(
      "[starlingai] mcp.expose.enabled is false — refusing to launch the stdio MCP server.\n" +
        "Set `mcp.expose.enabled = true` in starlingai.json (and restart) to enable.\n",
    );
    process.exit(2);
  }

  // Tracing first so subsequent loaders inherit the context.  No-op when
  // disabled so we don't pay export cost on a stdio launch.
  await initTracing(config.tracing);

  // Bridge any configured external MCP clients so their tools land in the
  // registry before we advertise our surface.  Safe to run side-by-side
  // with the gateway; both processes connect to the same configured
  // servers, but each MCP server can handle multiple clients.
  await initMcpServers();

  // Load self-developed dynamic tools (read-only at startup; no watcher).
  loadDynamicTools();

  // Load plugin SDK packages.  Errors are logged but don't abort startup.
  if (config.plugins?.enabled !== false) {
    try {
      await loadPlugins();
    } catch (err) {
      log.warn({ err }, "Plugin loader failed during stdio bootstrap");
    }
  }

  // Pre-warm so the first ListTools request is fast.
  await warmToolEmbeddings().catch(() => undefined);

  // stdio is a local, trusted entry point (the operator launched it) → operator role.
  const server = createStarlingMcpServer({ caller: "stdio", role: "operator" });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  log.info({ instanceId: config.federation?.instanceId ?? "primary" }, `${PRODUCT.name} MCP stdio server ready`);

  const shutdown = async (signal: string) => {
    log.info({ signal }, "MCP stdio server shutting down");
    try { await server.close(); } catch { /* ignore */ }
    try { await transport.close(); } catch { /* ignore */ }
    try { await shutdownMcpServers(); } catch { /* ignore */ }
    try { shutdownDynamicTools(); } catch { /* ignore */ }
    try { await shutdownTracing(); } catch { /* ignore */ }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // The MCP client closes stdin when it's done; mirror that into a clean
  // shutdown so we don't leak the runtime.
  process.stdin.on("end", () => void shutdown("stdin_end"));
}

void main().catch((err) => {
  process.stderr.write(`[starlingai-mcp] startup failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});

// Reference unused config type so this entrypoint can be type-checked even
// if `getConfig` is later inlined; keeps imports symmetric with main().
void getConfig;
