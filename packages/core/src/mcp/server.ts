/**
 * Outbound MCP server — exposes StarlingAI as an MCP endpoint so external
 * clients (Claude Desktop, Claude Code, Cursor, Zed, …) can call our tools,
 * sub-agents, and scenes the same way they call any other MCP server.
 *
 * Surface composition (driven by `config.mcp.expose`):
 *
 *   - Native tools           → exposed under their original names
 *                              (Tier 0/1 by default; Tier 2 only when the
 *                              operator opts in via `allowTier2` AND lists
 *                              the tool explicitly in `exposeTools`).
 *   - Sub-agents             → exposed as `agent__<name>` MCP tools whose
 *                              call signature is
 *                              `{ task: string, context?: string }`.
 *   - Scenes (workspace)     → exposed as `scene__<name>` MCP tools whose
 *                              call signature exposes the scene's declared
 *                              `params` plus optional `context`.
 *
 * Tier 3 / Tier 4 are NEVER advertised regardless of allowlist contents —
 * the same invariant federation enforces.  Per-call approval still applies
 * to Tier 2 calls, so an operator dashboard prompt fires before execution.
 *
 * The transport layer (HTTP/SSE for `/mcp`, stdio for the dedicated entry
 * point) lives in {@link ./server-http.ts} and {@link ../mcp-stdio.ts}.
 * This module is responsible only for surface assembly + request handlers.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";

import { getConfig } from "../config/loader.js";
import { getAllTools, executeTool, type ToolHandler } from "../tools/registry.js";
import { ToolTier, getToolTier } from "../guardrails/tool-tiers.js";
import { runSubAgentWithStats, type SubAgentRunResult } from "../agent/sub-agent.js";
import { userHasRole, type AuthRole } from "../gateway/auth.js";
import { listAllScenes, type SceneSummary } from "../credentials/scenes.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { PRODUCT } from "../product/index.js";

const log = childLogger("mcp:server");

const AGENT_TOOL_PREFIX = "agent__";
const SCENE_TOOL_PREFIX = "scene__";

interface AdvertisedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ExposeContext {
  /** Identity attached to audit entries — "http", "stdio", or a session id. */
  caller: string;
  /** Authenticated role. Mirrors the REST RBAC: viewers may call read-only tools
   *  but not mutating tools, sub-agent delegations, or scenes. Defaults to
   *  "operator" for trusted local (stdio / no-auth) callers. */
  role: AuthRole;
}

/** Operators may run mutating tools / sub-agents / scenes; viewers are read-only. Exported for testing. */
export function isMcpOperator(ctx: ExposeContext): boolean {
  return userHasRole({ username: ctx.caller, role: ctx.role }, "operator");
}

/** A sub-agent/scene run that did not finish cleanly must surface to the MCP client
 *  as a protocol error, not a bare successful result. Exported for testing. */
export function mcpSubAgentFailed(run: SubAgentRunResult): boolean {
  const outcome = run.stats.outcome;
  const terminal = run.stats.terminalState;
  return outcome === "failure" || (terminal !== undefined && terminal !== "completed");
}

/**
 * Server identity advertised to MCP clients.  Version mirrors the gateway
 * package version so operators can spot transport drift in dashboards.
 */
const SERVER_INFO = {
  name: "starlingai",
  version: "0.7.1",
} as const;

/**
 * Build a fresh `Server` wired to handle `tools/list` and `tools/call`.
 * Each transport (stdio, HTTP/SSE per-session) gets its own Server instance
 * so notifications and request queues stay isolated.
 */
export function createStarlingMcpServer(ctx: ExposeContext): Server {
  const server = new Server(SERVER_INFO, {
    capabilities: {
      tools: { listChanged: false },
    },
    instructions:
      `${PRODUCT.name} multi-agent swarm.  Tools include native swarm tools, ` +
      "sub-agent delegations (prefix `agent__`), and packaged scenes " +
      "(prefix `scene__`).  Tool tiers and human-in-the-loop gates are " +
      "enforced by the gateway — calls that require approval will pause " +
      "until an operator approves them in the StarlingAI dashboard.",
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = collectAdvertisedTools();
    logAudit("mcp_server_request", {
      method: "tools/list",
      caller: ctx.caller,
      toolCount: tools.length,
    });
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const callId = randomUUID();

    logAudit("mcp_server_request", {
      method: "tools/call",
      caller: ctx.caller,
      tool: name,
      callId,
    });

    try {
      const result = await dispatchExposedCall(name, args, ctx);
      logAudit("mcp_server_tool_called", {
        caller: ctx.caller,
        tool: name,
        callId,
        success: !result.isError,
      });
      return result;
    } catch (err) {
      logAudit("mcp_server_tool_rejected", {
        caller: ctx.caller,
        tool: name,
        callId,
        reason: err instanceof Error ? err.message : String(err),
      }, { severity: "warn" });
      return {
        isError: true,
        content: [
          { type: "text", text: `MCP call failed: ${err instanceof Error ? err.message : String(err)}` },
        ],
      };
    }
  });

  return server;
}

// ─── Surface assembly ────────────────────────────────────────────────────────

function collectAdvertisedTools(): AdvertisedTool[] {
  const config = getConfig();
  const expose = config.mcp.expose;
  if (!expose.enabled) return [];

  const out: AdvertisedTool[] = [];

  // Native tools — Tier 0/1 by default, Tier 2 only when explicitly allowed
  const exposeToolSet = new Set(expose.exposeTools);
  for (const handler of getAllTools()) {
    if (handler.name.startsWith(AGENT_TOOL_PREFIX) || handler.name.startsWith(SCENE_TOOL_PREFIX)) {
      // Don't re-expose synthetic agent/scene tools that may have leaked in
      continue;
    }
    if (!toolTierAllowed(handler, exposeToolSet, expose.allowTier2)) continue;
    if (expose.exposeTools.length > 0 && !exposeToolSet.has(handler.name)) continue;
    out.push({
      name: handler.name,
      description: handler.description,
      inputSchema: ensureObjectSchema(handler.parameters),
    });
  }

  // Sub-agents — `agent__<name>` synthetic tools
  const exposeAgentSet = new Set(expose.exposeAgents);
  for (const [agentName, agentCfg] of Object.entries(config.subAgents ?? {})) {
    if (expose.exposeAgents.length > 0 && !exposeAgentSet.has(agentName)) continue;
    if (!agentCfg) continue;
    const synthName = `${AGENT_TOOL_PREFIX}${agentName}`;
    out.push({
      name: synthName,
      description:
        `Delegate work to the ${PRODUCT.name} sub-agent "${agentName}".  ` +
        (agentCfg.description ?? "Specialized swarm agent."),
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string", description: "Task description for the agent." },
          context: { type: "string", description: "Optional supporting context." },
        },
        required: ["task"],
      },
    });
  }

  // Scenes — `scene__<name>` synthetic tools.  Each declared `params` entry
  // becomes a scalar string property on the input schema so MCP clients can
  // see what the scene takes.
  const exposeSceneSet = new Set(expose.exposeScenes);
  for (const scene of listAllScenes()) {
    if (expose.exposeScenes.length > 0 && !exposeSceneSet.has(scene.name)) continue;
    out.push({
      name: `${SCENE_TOOL_PREFIX}${scene.name}`,
      description:
        `Run the ${PRODUCT.name} scene "${scene.name}".  ` +
        (scene.description || "Multi-step workflow."),
      inputSchema: sceneInputSchema(scene),
    });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function sceneInputSchema(scene: SceneSummary): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [paramName, param] of Object.entries(scene.params ?? {})) {
    properties[paramName] = {
      type: "string",
      description: param.description ?? `Scene parameter ${paramName}.`,
      ...(param.default !== undefined ? { default: param.default } : {}),
    };
    if (param.default === undefined) required.push(paramName);
  }
  properties["context"] = {
    type: "string",
    description: "Optional supporting context appended to the scene's task template.",
  };
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

function toolTierAllowed(
  handler: ToolHandler,
  exposeToolSet: ReadonlySet<string>,
  allowTier2: boolean,
): boolean {
  const tier = getToolTier(handler.name).tier;
  if (tier === ToolTier.ZERO_READ_ONLY || tier === ToolTier.ONE_WRITE) return true;
  if (tier === ToolTier.TWO_EXECUTE) {
    return allowTier2 && exposeToolSet.has(handler.name);
  }
  // Tier 3 (privileged) and Tier 4 (blocked) — never exposed.
  return false;
}

function ensureObjectSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === "object") return schema as Record<string, unknown>;
  return { type: "object", properties: {} };
}

// ─── Call dispatch ───────────────────────────────────────────────────────────

async function dispatchExposedCall(
  name: string,
  args: Record<string, unknown>,
  ctx: ExposeContext,
): Promise<CallToolResult> {
  if (name.startsWith(AGENT_TOOL_PREFIX)) {
    return runAgentCall(name.slice(AGENT_TOOL_PREFIX.length), args, ctx);
  }
  if (name.startsWith(SCENE_TOOL_PREFIX)) {
    return runSceneCall(name.slice(SCENE_TOOL_PREFIX.length), args, ctx);
  }
  return runNativeToolCall(name, args, ctx);
}

async function runNativeToolCall(
  name: string,
  args: Record<string, unknown>,
  ctx: ExposeContext,
): Promise<CallToolResult> {
  const expose = getConfig().mcp.expose;
  if (!expose.enabled) {
    return errorResult("MCP server is disabled");
  }
  const exposeToolSet = new Set(expose.exposeTools);
  const handler = getAllTools().find((h) => h.name === name);
  if (!handler) return errorResult(`Tool '${name}' is not registered`);
  if (!toolTierAllowed(handler, exposeToolSet, expose.allowTier2)) {
    return errorResult(`Tool '${name}' is not exposed via MCP`);
  }
  if (expose.exposeTools.length > 0 && !exposeToolSet.has(name)) {
    return errorResult(`Tool '${name}' is not in mcp.expose.exposeTools`);
  }
  // RBAC: a read-only viewer may call Tier-0 tools but not mutating (Tier 1+) ones.
  if (getToolTier(name).tier !== ToolTier.ZERO_READ_ONLY && !isMcpOperator(ctx)) {
    return errorResult(`Tool '${name}' requires the operator role`);
  }

  const sessionId = `mcp:${ctx.caller}:${randomUUID()}`;
  const result = await executeTool(name, args, {
    sessionId,
    workspacePath: getConfig().workspacePath,
  });

  return {
    isError: !result.success,
    content: [
      { type: "text", text: result.success ? result.output : (result.error ?? "Tool failed without an error message") },
    ],
  };
}

async function runAgentCall(
  agentName: string,
  args: Record<string, unknown>,
  ctx: ExposeContext,
): Promise<CallToolResult> {
  const config = getConfig();
  const expose = config.mcp.expose;
  if (!expose.enabled) return errorResult("MCP server is disabled");
  // Delegations always run mutating swarm work → operator-only.
  if (!isMcpOperator(ctx)) return errorResult("Delegating to a sub-agent requires the operator role");
  if (expose.exposeAgents.length > 0 && !expose.exposeAgents.includes(agentName)) {
    return errorResult(`Agent '${agentName}' is not exposed via MCP`);
  }
  if (!config.subAgents?.[agentName]) {
    return errorResult(`Agent '${agentName}' is not configured`);
  }

  const task = typeof args["task"] === "string" ? args["task"] : "";
  const context = typeof args["context"] === "string" ? args["context"] : undefined;
  if (!task.trim()) return errorResult("`task` is required");

  const parentSessionId = `mcp:${ctx.caller}:${randomUUID()}`;
  const run = await runSubAgentWithStats({
    agentName,
    task,
    context,
    parentSessionId,
    workspacePath: config.workspacePath,
  });

  return {
    // A failed / timed-out / max-iterations run must not be reported as success.
    isError: mcpSubAgentFailed(run),
    content: [{ type: "text", text: run.output }],
  };
}

async function runSceneCall(
  sceneName: string,
  args: Record<string, unknown>,
  ctx: ExposeContext,
): Promise<CallToolResult> {
  const config = getConfig();
  const expose = config.mcp.expose;
  if (!expose.enabled) return errorResult("MCP server is disabled");
  // Scenes always run mutating swarm work → operator-only.
  if (!isMcpOperator(ctx)) return errorResult("Running a scene requires the operator role");
  if (expose.exposeScenes.length > 0 && !expose.exposeScenes.includes(sceneName)) {
    return errorResult(`Scene '${sceneName}' is not exposed via MCP`);
  }

  const scene = listAllScenes().find((s) => s.name === sceneName);
  if (!scene) return errorResult(`Scene '${sceneName}' is not configured`);

  // Render the scene's task template with the provided params.  Missing params fall
  // back to the scene's declared default; a no-default param that is omitted is
  // REJECTED (rather than leaving a literal {{param}} in the task) so the runtime
  // guard matches the advertised required-param schema.  Unknown args are ignored so
  // an MCP client cannot smuggle template variables.
  const params: Record<string, string> = {};
  const missingRequired: string[] = [];
  for (const [paramName, param] of Object.entries(scene.params ?? {})) {
    const provided = args[paramName];
    if (typeof provided === "string" && provided.length > 0) {
      params[paramName] = provided;
    } else if (param.default !== undefined) {
      params[paramName] = param.default;
    } else {
      missingRequired.push(paramName);
    }
  }
  if (missingRequired.length > 0) {
    return errorResult(`Scene '${sceneName}' is missing required param(s): ${missingRequired.join(", ")}`);
  }
  const renderedTask = renderTemplate(scene.task, params);
  const context = typeof args["context"] === "string" ? args["context"] : undefined;

  // Scenes typically bootstrap into the assistant orchestrator, but for the
  // MCP entry path we delegate to the configured `bootstrapAgent` if any,
  // falling back to the first allowed agent.  When neither is set we pick
  // `assistant` as a sensible default.
  const bootstrapAgent =
    pickSceneBootstrapAgent(scene, config.subAgents ?? {}) ?? "assistant";

  if (!config.subAgents?.[bootstrapAgent]) {
    return errorResult(
      `Scene '${sceneName}' has no bootstrap agent and no '${bootstrapAgent}' fallback`,
    );
  }

  const parentSessionId = `mcp:${ctx.caller}:scene:${sceneName}:${randomUUID()}`;
  const run = await runSubAgentWithStats({
    agentName: bootstrapAgent,
    task: renderedTask,
    context,
    parentSessionId,
    workspacePath: config.workspacePath,
    allowedAgents: scene.allowedAgents,
    humanInLoopSteps: scene.humanInLoopSteps,
  });

  return {
    isError: mcpSubAgentFailed(run),
    content: [{ type: "text", text: run.output }],
  };
}

function pickSceneBootstrapAgent(
  scene: SceneSummary,
  subAgents: Record<string, unknown>,
): string | null {
  if (scene.allowedAgents && scene.allowedAgents.length > 0) {
    for (const candidate of scene.allowedAgents) {
      if (subAgents[candidate]) return candidate;
    }
  }
  return null;
}

function renderTemplate(template: string, params: Record<string, string>): string {
  return template.replace(/\{\{(\w+)(?:\|([^}]*))?\}\}/g, (match, key: string, defaultVal?: string) => {
    if (key in params) return params[key] ?? "";
    if (defaultVal !== undefined) return defaultVal;
    return match;
  });
}

function errorResult(message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

// ─── Public helpers (used by REST + dashboard) ───────────────────────────────

export interface McpExposeSummary {
  enabled: boolean;
  http: { enabled: boolean; requireAuth: boolean };
  toolCount: number;
  agentCount: number;
  sceneCount: number;
  tools: string[];
  agents: string[];
  scenes: string[];
}

export function getMcpExposeSummary(): McpExposeSummary {
  const expose = getConfig().mcp.expose;
  const advertised = expose.enabled ? collectAdvertisedTools() : [];
  return {
    enabled: expose.enabled,
    http: { enabled: expose.http.enabled, requireAuth: expose.http.requireAuth },
    toolCount: advertised.filter((t) => !t.name.startsWith(AGENT_TOOL_PREFIX) && !t.name.startsWith(SCENE_TOOL_PREFIX)).length,
    agentCount: advertised.filter((t) => t.name.startsWith(AGENT_TOOL_PREFIX)).length,
    sceneCount: advertised.filter((t) => t.name.startsWith(SCENE_TOOL_PREFIX)).length,
    tools: advertised
      .filter((t) => !t.name.startsWith(AGENT_TOOL_PREFIX) && !t.name.startsWith(SCENE_TOOL_PREFIX))
      .map((t) => t.name),
    agents: advertised
      .filter((t) => t.name.startsWith(AGENT_TOOL_PREFIX))
      .map((t) => t.name.slice(AGENT_TOOL_PREFIX.length)),
    scenes: advertised
      .filter((t) => t.name.startsWith(SCENE_TOOL_PREFIX))
      .map((t) => t.name.slice(SCENE_TOOL_PREFIX.length)),
  };
}

export { log as mcpServerLog };
