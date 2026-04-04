import { ToolTier, getToolTier, isToolAllowed } from "../guardrails/tool-tiers.js";
import type { LLMToolDef } from "../providers/lmstudio.js";

export interface ToolHandler {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Optional per-tool timeout in ms. When set, tool execution is aborted after this duration. */
  timeoutMs?: number;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}

export interface SwarmTaskAttempt {
  agentName: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt?: string;
  summary?: string;
  toolCount?: number;
  iterations?: number;
  toolNames?: string[];
}

export interface SwarmTaskState {
  id: string;
  title: string;
  status: "pending" | "running" | "completed" | "failed" | "blocked";
  dependsOn: string[];
  signature?: string;
  selectedAgent?: string;
  attempts: SwarmTaskAttempt[];
  output?: string;
  error?: string;
}

export interface SwarmState {
  objective: string;
  startedAt: string;
  updatedAt: string;
  tasks: Record<string, SwarmTaskState>;
}

export interface ToolContext {
  sessionId: string;
  workspacePath: string;
  approvalCallback?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
  onComputerAction?: (action: { computerSessionId: string; actionType: string; [key: string]: unknown }) => void;
  onComputerScreenshot?: (screenshot: { computerSessionId: string; dataUrl: string; width: number; height: number; [key: string]: unknown }) => void;
  onComputerSessionState?: (sessionState: { computerSessionId: string; state: string; [key: string]: unknown }) => void;
  /** When set by a scene, only these sub-agent names may be delegated to */
  allowedAgents?: string[];
  /**
   * Tool names that MUST pause for human approval regardless of tier defaults.
   * Enforced unconditionally — cannot be bypassed by config or tier settings.
   */
  humanInLoopSteps?: string[];
  /** When true, all tool approval prompts are automatically approved for this turn. */
  autoApprove?: boolean;
  /** Override sub-agent maxIterations for delegated tasks this turn. */
  maxIterationsOverride?: number;
  /** Override the per-turn timeout in ms for delegated tasks. 0 disables timeout inheritance. */
  turnTimeoutOverrideMs?: number;
  /** Shared turn-local swarm state for orchestration and recovery. */
  swarmState?: SwarmState;
  /** Optional live callback whenever swarm state changes during a turn. */
  onSwarmState?: (state: SwarmState) => void;
  /**
   * Abort signal from the parent turn — propagated to sub-agent delegations.
   * When aborted, delegation loops exit early and return a cancellation error.
   */
  signal?: AbortSignal;
  /**
   * Per-turn agent invocation counters for loop enforcement.
   * Tracks how many times each agent has been called this turn.
   * Internal — populated automatically on first delegation.
   */
  _turnAgentCounts?: Map<string, number>;
  /**
   * When set, this turn is a tool development session.
   * Iteration limits are lifted and the tool-dev-warden provides oversight instead.
   */
  _toolDevSessionId?: string;
}

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

const _registry = new Map<string, ToolHandler>();

export function registerTool(handler: ToolHandler): void {
  if (!isToolAllowed(handler.name)) {
    throw new Error(`Cannot register blocked tool: ${handler.name}`);
  }
  _registry.set(handler.name, handler);
}

export function unregisterTool(name: string): void {
  _registry.delete(name);
}

export function getTool(name: string): ToolHandler | undefined {
  return _registry.get(name);
}

export function getAllTools(): ToolHandler[] {
  return [..._registry.values()];
}

export function getToolsAsLLMDefs(allowedTools?: string[]): LLMToolDef[] {
  let tools = [..._registry.values()];
  if (allowedTools) {
    tools = tools.filter(t => allowedTools.includes(t.name));
  }
  return tools.map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

/**
 * Repair a tool call whose name was mangled by the model.
 * Some models emit `tool_name(arg=val, …)` as the function name instead of
 * using the structured name + arguments fields.  Detect the pattern of a `(`
 * inside the name and split it back apart so downstream validation sees the
 * correct tool name.
 */
export function normalizeToolCall(tc: { name: string; arguments: Record<string, unknown> }): void {
  const parenIdx = tc.name.indexOf("(");
  if (parenIdx < 0) return;

  const realName = tc.name.slice(0, parenIdx).trim();
  if (!realName) return;

  const argsGood = tc.arguments && !("_parse_error" in tc.arguments) && Object.keys(tc.arguments).length > 0;

  if (!argsGood) {
    const tail = tc.name.slice(parenIdx + 1);
    const closeParen = tail.lastIndexOf(")");
    const raw = (closeParen >= 0 ? tail.slice(0, closeParen) : tail).trim();

    if (raw) {
      // Attempt 1: wrap in braces and parse as JSON
      try {
        const parsed = JSON.parse(`{${raw}}`);
        if (typeof parsed === "object" && parsed !== null) {
          tc.arguments = parsed as Record<string, unknown>;
        }
      } catch {
        // Attempt 2: Python-style kwargs  key="val", key=True, key=123
        const obj: Record<string, unknown> = {};
        const re = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(true|false|null|\d+(?:\.\d+)?))/gi;
        let m: RegExpExecArray | null;
        while ((m = re.exec(raw)) !== null) {
          const key = m[1]!;
          const strVal = m[2] ?? m[3];
          const lit = m[4];
          if (strVal !== undefined) { obj[key] = strVal; }
          else if (lit !== undefined) {
            const lo = lit.toLowerCase();
            if (lo === "true") obj[key] = true;
            else if (lo === "false") obj[key] = false;
            else if (lo === "null") obj[key] = null;
            else obj[key] = Number(lit);
          }
        }
        if (Object.keys(obj).length > 0) tc.arguments = obj;
      }
    }
  }

  tc.name = realName;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<ToolResult> {
  const def = getToolTier(name);

  if (def.tier === ToolTier.FOUR_BLOCKED) {
    return { success: false, output: "", error: `Tool '${name}' is blocked by security policy` };
  }

  const handler = _registry.get(name);
  if (!handler) {
    // Suggest tools that share the same prefix (e.g. "browser") so the LLM can self-correct
    const prefix = name.split("_")[0] ?? "";
    const similar = prefix
      ? [..._registry.keys()].filter(n => n.startsWith(prefix + "_") || n === prefix).sort()
      : [];
    const hint = similar.length > 0 ? ` Similar available tools: ${similar.join(", ")}.` : "";
    return { success: false, output: "", error: `Tool '${name}' is not registered.${hint}` };
  }

  // Tier 2+ require sandbox — enforce here
  if (def.requiresSandbox) {
    // Sandbox enforcement happens inside the shell/browser tool implementations
    // We mark the context so the tool knows it MUST sandbox
    context = { ...context, workspacePath: context.workspacePath };
  }

  // Per-call approval:
  //  1. Tier-level default (requiresPerCallApproval), OR
  //  2. Scene-declared humanInLoopSteps — ENFORCED UNCONDITIONALLY, cannot be bypassed
  const sceneRequiresApproval = context.humanInLoopSteps?.includes(name) ?? false;
  const requiresApproval = def.requiresPerCallApproval || sceneRequiresApproval;

  if (requiresApproval) {
    if (context.approvalCallback) {
      const approved = await context.approvalCallback(name, args);
      if (!approved) {
        return { success: false, output: "", error: `Tool '${name}' execution denied by user` };
      }
    } else {
      // No approval channel available — block the call rather than silently skip the gate
      return { success: false, output: "", error: `Tool '${name}' requires human approval but no approval channel is available` };
    }
  }

  // Per-tool timeout enforcement
  if (handler.timeoutMs && handler.timeoutMs > 0) {
    const timeoutPromise = new Promise<ToolResult>((resolve) => {
      const timer = setTimeout(() => {
        resolve({ success: false, output: "", error: `Tool '${name}' timed out after ${handler.timeoutMs}ms` });
      }, handler.timeoutMs!);
      timer.unref();
    });
    return Promise.race([handler.execute(args, context), timeoutPromise]);
  }

  return handler.execute(args, context);
}
