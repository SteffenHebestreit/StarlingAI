import { ToolTier, getToolTier, isToolAllowed } from "../guardrails/tool-tiers.js";
import type { LLMToolDef } from "../providers/lmstudio.js";
import { computeQueryEmbedding, cosineSimilarity, isEmbeddingAvailable } from "../providers/embeddings.js";
import { withSpan } from "../observability/tracing.js";
import { runWithRequestContext } from "../runtime/request-context.js";

export interface ToolHandler {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Optional per-tool timeout in ms. When set, tool execution is aborted after this duration. */
  timeoutMs?: number;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
  /**
   * E20: Free-form description used only for embedding-based rerank.
   * When unset the reranker falls back to `description`.  Use this to add
   * paraphrases, synonyms, and example tasks that help route
   * semantically-close queries to the right tool even when the user's
   * wording doesn't match the canonical description.
   */
  embeddingDescription?: string;
  /** E20: Qualitative cost hint. "low" tools are preferred when semantic scores tie. */
  costHint?: "low" | "medium" | "high";
  /** E20: Qualitative latency hint. Same tie-break semantics as costHint. */
  latencyHint?: "low" | "medium" | "high";
}

export interface SwarmTaskAttempt {
  agentName: string;
  status: "running" | "completed" | "partial" | "failed";
  startedAt: string;
  finishedAt?: string;
  summary?: string;
  toolCount?: number;
  iterations?: number;
  toolNames?: string[];
  /** Token usage attributed to this attempt's sub-agent execution. */
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Wall-clock duration for the attempt (finishedAt − startedAt), in ms. */
  durationMs?: number;
  /** Terminal state from the sub-agent runner (e.g. "completed", "max_iterations", "timeout"). */
  terminalState?: string;
  /** True when the attempt exceeded one or more configured per-task soft budgets. */
  budgetExceeded?: boolean;
  /** Human-readable list of which budget(s) tripped (tokens / toolCalls / durationMs). */
  budgetBreaches?: string[];
}

export interface SwarmTaskState {
  id: string;
  title: string;
  status: "pending" | "running" | "completed" | "partial" | "failed" | "blocked";
  dependsOn: string[];
  signature?: string;
  selectedAgent?: string;
  attempts: SwarmTaskAttempt[];
  output?: string;
  error?: string;
  /**
   * Per-task budget rollup across all attempts.
   * Lazily maintained by the delegation pipeline so observability tools can
   * answer "what did this task cost?" without re-walking attempts each time.
   */
  totals?: {
    attempts: number;
    toolCount: number;
    iterations: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    durationMs: number;
  };
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
  /**
   * Authenticated user that owns this turn (the JWT subject / username), if any.
   * Undefined in single-user / token mode (auth disabled). Tools use it to gate
   * access to per-user resources (mail accounts, stored credentials, compute
   * nodes) via guardResourceAccess — undefined means "no multi-user scoping".
   */
  userId?: string;
  approvalCallback?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
  inputCallback?: (question: string, choices?: string[], timeoutMs?: number) => Promise<string>;
  onSubAgentProgress?: (event: {
    agentName: string;
    kind: "started" | "thinking" | "tool_start" | "tool_done" | "completed";
    iteration: number;
    toolName?: string;
    toolCallId?: string;
    args?: Record<string, unknown>;
    result?: string;
    metadata?: Record<string, unknown>;
    summary?: string;
  }) => void;
  onComputerAction?: (action: { computerSessionId: string; actionType: string; [key: string]: unknown }) => void;
  onComputerScreenshot?: (screenshot: { computerSessionId: string; dataUrl: string; width: number; height: number; [key: string]: unknown }) => void;
  onComputerSessionState?: (sessionState: { computerSessionId: string; state: string; [key: string]: unknown }) => void;
  /** Name of the currently running agent when invoked from a sub-agent context. */
  currentAgentName?: string;
  /** When set by a scene, only these sub-agent names may be delegated to */
  allowedAgents?: string[];
  /**
   * Tool names the current caller (orchestrator turn or sub-agent) is allowed to
   * use this turn. Set by the dispatch loop. Tools that fan out to other tools —
   * e.g. run_tool_pipeline — must honor this so they cannot reach tools outside
   * the caller's grant. Undefined means "not scoped" (no extra restriction).
   */
  allowedTools?: string[];
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
   * Optional per-agent repeat-cap overrides for deliberate coordinator fan-out.
   * Internal — used by orchestration tools to permit repeated specialists on partitioned work.
   */
  _turnAgentRepeatLimitOverrides?: Record<string, number>;
  /**
   * Optional total delegation budget override for explicit orchestration batches.
   * Internal — keeps planned fan-out from tripping the default turn budget.
   */
  _turnTotalDelegationLimitOverride?: number;
  /**
   * Active reusable workflow execution stack for nested workflow/self-reentry guards.
   * Internal — propagated by run_workflow into nested turns and delegations.
   */
  _workflowExecutionStack?: string[];
  /**
   * When set, this turn is a tool development session.
   * Iteration limits are lifted and the tool-dev-warden provides oversight instead.
   */
  _toolDevSessionId?: string;
}

export interface ToolResult {
  status?: "success" | "failure" | "needs_info";
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

// ── E20: Task-aware tool rerank ──────────────────────────────────────────
// Embedding cache keyed on `name::description::embeddingDescription` so
// dev-time edits to a tool's wording invalidate the cache automatically.

const _toolEmbeddingCache = new Map<string, Float32Array>();
const _toolEmbeddingInflight = new Map<string, Promise<Float32Array | null>>();
const HINT_WEIGHT: Record<"low" | "medium" | "high", number> = {
  low: 0.02,
  medium: 0,
  high: -0.015,
};

function _toolEmbeddingKey(h: ToolHandler): string {
  return `${h.name}::${h.description}::${h.embeddingDescription ?? ""}`;
}

function _toolEmbeddingText(h: ToolHandler): string {
  const paraphrase = h.embeddingDescription ?? "";
  return paraphrase
    ? `Tool: ${h.name}\nDescription: ${h.description}\nAlso: ${paraphrase}`
    : `Tool: ${h.name}\nDescription: ${h.description}`;
}

async function _getToolEmbedding(h: ToolHandler): Promise<Float32Array | null> {
  const key = _toolEmbeddingKey(h);
  const cached = _toolEmbeddingCache.get(key);
  if (cached) return cached;
  const inflight = _toolEmbeddingInflight.get(key);
  if (inflight) return inflight;
  const p = (async () => {
    const vec = await computeQueryEmbedding(_toolEmbeddingText(h));
    if (vec) _toolEmbeddingCache.set(key, vec);
    return vec;
  })();
  _toolEmbeddingInflight.set(key, p);
  try {
    return await p;
  } finally {
    _toolEmbeddingInflight.delete(key);
  }
}

/**
 * E20: Reorder the given tool definitions by semantic relevance to `task`.
 *
 * Non-destructive — tools with unavailable embeddings retain their input
 * order at the tail. Tie-breaks prefer lower `costHint` / `latencyHint`.
 * When embeddings are unavailable the input list is returned unchanged.
 */
export async function rerankToolsForTask(
  defs: LLMToolDef[],
  task: string,
): Promise<LLMToolDef[]> {
  if (!task || defs.length <= 1 || !isEmbeddingAvailable()) return defs;

  const queryVec = await computeQueryEmbedding(task);
  if (!queryVec) return defs;

  const scored = await Promise.all(
    defs.map(async (def, idx) => {
      const handler = _registry.get(def.name);
      if (!handler) return { def, score: -Infinity, idx };
      const vec = await _getToolEmbedding(handler);
      if (!vec) return { def, score: -Infinity, idx };
      const sim = cosineSimilarity(queryVec, vec);
      const costAdj = HINT_WEIGHT[handler.costHint ?? "medium"];
      const latAdj = HINT_WEIGHT[handler.latencyHint ?? "medium"];
      return { def, score: sim + costAdj + latAdj, idx };
    }),
  );

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.idx - b.idx;
  });
  return scored.map(s => s.def);
}

export function _clearToolEmbeddingCacheForTests(): void {
  _toolEmbeddingCache.clear();
  _toolEmbeddingInflight.clear();
}

/**
 * Semantic tool search — returns the top-N most relevant tool handlers for
 * a natural-language task description, using the cached per-tool embeddings
 * that `warmToolEmbeddings` pre-computes.  The shared path so callers
 * (the `search_tools` tool, future tool-routing logic, dashboard surfaces)
 * don't re-implement the same cosine-similarity walk and don't accidentally
 * re-embed the same tool text via the short-TTL query cache.
 *
 * Returns scored results so callers can apply a relevance threshold or
 * surface the score to operators.  Falls back to keyword matching when
 * the embedding provider is unavailable so unit tests + offline operators
 * still get useful output.
 */
export async function searchToolsByEmbedding(
  query: string,
  topN = 8,
  handlers?: ToolHandler[],
): Promise<{ name: string; description: string; score: number; mode: "embedding" | "keyword" | "empty" }[]> {
  const candidates = handlers ?? [..._registry.values()];
  if (candidates.length === 0 || !query.trim()) return [];

  if (isEmbeddingAvailable()) {
    const queryVec = await computeQueryEmbedding(query);
    if (queryVec) {
      const scored = await Promise.all(
        candidates.map(async (handler) => {
          const vec = await _getToolEmbedding(handler);
          if (!vec) return null;
          const sim = cosineSimilarity(queryVec, vec);
          const costAdj = HINT_WEIGHT[handler.costHint ?? "medium"];
          const latAdj = HINT_WEIGHT[handler.latencyHint ?? "medium"];
          return {
            name: handler.name,
            description: handler.description,
            score: sim + costAdj + latAdj,
            mode: "embedding" as const,
          };
        }),
      );
      const ranked = scored
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
        .sort((a, b) => b.score - a.score)
        .slice(0, topN);
      if (ranked.length > 0) return ranked;
    }
  }

  // Keyword fallback — token-overlap with description + embeddingDescription.
  const q = query.toLowerCase().trim();
  const queryTokens = q.split(/\s+/).filter((t) => t.length > 2);
  const ranked = candidates
    .map((handler) => {
      const text = `${handler.name} ${handler.description} ${handler.embeddingDescription ?? ""}`.toLowerCase();
      let score = 0;
      if (text.includes(q)) score = 1;
      else if (queryTokens.length > 0) {
        const hits = queryTokens.filter((token) => text.includes(token)).length;
        score = hits / queryTokens.length;
      }
      return {
        name: handler.name,
        description: handler.description,
        score,
        mode: "keyword" as const,
      };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);

  return ranked;
}

/**
 * Pre-warm embeddings for the given tools (or every registered tool when
 * `toolNames` is omitted).  Used at gateway startup after MCP / plugin /
 * dynamic-tool loaders complete so the first `rerankToolsForTask` call in a
 * live turn doesn't pay the full embedding-batch latency.  Called again
 * incrementally whenever a new external surface (MCP server, plugin) brings
 * fresh tools into the registry.
 *
 * Cheap when embeddings are unavailable (returns immediately) and idempotent
 * (anything cached is skipped).  Failures inside individual embedding calls
 * are swallowed — a missing vector just means that tool falls back to input
 * order in the reranker, which is the same behavior we'd see lazily.
 */
export async function warmToolEmbeddings(
  toolNames?: string[],
): Promise<{ warmed: number; skipped: number; durationMs: number }> {
  const startedAt = Date.now();
  if (!isEmbeddingAvailable()) {
    return { warmed: 0, skipped: 0, durationMs: 0 };
  }

  const targets: ToolHandler[] = toolNames
    ? toolNames.map((n) => _registry.get(n)).filter((h): h is ToolHandler => !!h)
    : [..._registry.values()];

  let warmed = 0;
  let skipped = 0;
  await Promise.all(
    targets.map(async (handler) => {
      const key = _toolEmbeddingKey(handler);
      if (_toolEmbeddingCache.has(key)) {
        skipped += 1;
        return;
      }
      const vec = await _getToolEmbedding(handler);
      if (vec) warmed += 1;
    }),
  );

  return { warmed, skipped, durationMs: Date.now() - startedAt };
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
      let approved: boolean;
      try {
        approved = await context.approvalCallback(name, args);
      } catch (err) {
        // The approval callback may reject for two reasons:
        //   1. Timeout (no user response within the window) — message includes "timed out"
        //   2. Explicit user denial — message includes "denied by user"
        // Propagate the rejection message directly so interventions.ts can classify it.
        return {
          success: false,
          output: "",
          error: err instanceof Error ? err.message : `Tool '${name}' approval failed`,
        };
      }
      if (!approved) {
        return { success: false, output: "", error: `Tool '${name}' execution denied by user` };
      }
    } else {
      // No approval channel available — block the call rather than silently skip the gate
      return { success: false, output: "", error: `Tool '${name}' requires human approval but no approval channel is available` };
    }
  }

  // Span the tool call so traces show how a turn fanned out across tools.
  // Attributes intentionally exclude args (privacy + payload size); the
  // result is summarized via success / error length only.
  return withSpan(
    `tool ${name}`,
    {
      "starlingai.tool.name": name,
      "starlingai.tool.tier": def.tier,
      "starlingai.session.id": context.sessionId,
      ...(context.currentAgentName ? { "starlingai.agent.name": context.currentAgentName } : {}),
    },
    async (span) => {
      // Per-tool timeout enforcement.
      //
      // Wrap handler.execute in try/catch so a thrown exception (e.g.
      // run_workflow → resolveStep → getScene returning null → throw)
      // becomes a normal ToolResult failure instead of bubbling out of
      // the executor.  Without this catch the runtime's per-iteration
      // dispatch in agent/runtime.ts would re-throw, the turn would die
      // silently, and the audit pipeline would never log
      // tool_call_failed (audit session 5b7a67ba, May 2026).
      let result: ToolResult;
      const runHandler = async (): Promise<ToolResult> => {
        try {
          // Make the owning user available to downstream clients (e.g. the
          // mail-service HTTP client) for per-user resource access control,
          // without threading userId through every call.
          return await runWithRequestContext({ userId: context.userId }, () => handler.execute(args, context));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            success: false,
            output: "",
            error: `Tool '${name}' threw an exception: ${message}`,
          };
        }
      };
      if (handler.timeoutMs && handler.timeoutMs > 0) {
        const timeoutPromise = new Promise<ToolResult>((resolve) => {
          const timer = setTimeout(() => {
            resolve({ success: false, output: "", error: `Tool '${name}' timed out after ${handler.timeoutMs}ms` });
          }, handler.timeoutMs!);
          timer.unref();
        });
        result = await Promise.race([runHandler(), timeoutPromise]);
      } else {
        result = await runHandler();
      }
      span.setAttribute("starlingai.tool.success", result.success);
      if (!result.success && result.error) {
        span.setAttribute("starlingai.tool.error", result.error.slice(0, 240));
      }
      return result;
    },
  );
}
