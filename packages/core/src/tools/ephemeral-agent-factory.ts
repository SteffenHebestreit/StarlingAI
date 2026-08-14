/**
 * Ephemeral-agent / architect factory
 *
 * The cluster that designs and runs single-use ("ephemeral") sub-agents:
 *   - create_ephemeral_agent — the orchestrator-facing tool that takes a full
 *     inline agent spec and runs it once.
 *   - runArchitectFallback   — the last-resort routing path that asks the LLM to
 *     DESIGN a minimal ephemeral agent for a task, runs it, and conditionally
 *     auto-promotes it. Called at request time from
 *     executeDelegationWithFallback in ./sub-agent.ts (call-time only, so the
 *     factory → sub-agent re-import of runSubAgentWithStats stays ESM-safe).
 *
 * Extracted verbatim from ./sub-agent.ts (behaviour-preserving move). Shared
 * routing/capability helpers (isWebReachingToolName, looksLikeFailureResult,
 * looksLikeArtifactDeliverableMiss) remain in ./sub-agent.ts and are imported
 * back here; this module imports from ./sub-agent.ts one-directionally.
 */

import { registerTool, getAllTools, searchToolsByEmbedding, type ToolContext, type ToolResult } from "./registry.js";
import { runSubAgent, runSubAgentWithStats } from "../agent/sub-agent.js";
import { getConfig } from "../config/loader.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { readRecentOutcomes } from "../agent/outcomes.js";
import { getToolTier, ToolTier } from "../guardrails/tool-tiers.js";
import { promoteEphemeralAgent, PROMOTION_MIN_SUCCESSES, PROMOTION_MIN_SUCCESS_RATE } from "../agent/promoted-agents.js";
import { formatSharedContextForPrompt } from "../swarm/memory.js";
import { isWebReachingToolName, looksLikeFailureResult, looksLikeArtifactDeliverableMiss } from "./sub-agent.js";

const log = childLogger("tool:sub-agent");

// Tools the factory is allowed to grant to ephemeral agents (must exist in registry)
const GRANTABLE_TOOLS = new Set([
  "read_file", "list_files", "write_file", "edit_file", "create_dir", "delete_file",
  // Deliverable emitters an ad-hoc "turn X into a document/PDF" task needs — granting
  // these beats standing up a permanent agent for a one-off shape.
  "generate_document", "render_pdf",
  "memory_search", "memory_store", "record_lesson",
  "share_finding", "read_shared_facts",
  "parallel_delegate",
  "workspace_search",
  "web_search", "web_fetch",
  "list_knowledge_bases", "search_knowledge_base",
  // Native live-site inspection + read-only web audits, so a temporary agent
  // spun up for an ad-hoc "evaluate site X (optionally against knowledge base Y)"
  // task can actually inspect the running page — not just fetch its HTML. All
  // tier-0 read-only. (browser_navigate/snapshot are the gateway's own Playwright
  // wrappers; the mcp__playwright__* entries below are the separate MCP path.)
  "browser_navigate", "browser_snapshot", "browser_axe_audit", "lighthouse_audit",
  "shell_exec", "run_script",
  "mcp__playwright__browser_navigate", "mcp__playwright__browser_click",
  "mcp__playwright__browser_type", "mcp__playwright__browser_snapshot",
  "mcp__playwright__browser_screenshot",
  "mcp__code_sandbox__run_js", "mcp__code_sandbox__run_ts",
  "mcp__filesystem__read_file", "mcp__filesystem__list_directory",
  "computer_session_start", "computer_session_attach", "computer_session_stop",
  "computer_list_nodes", "computer_snapshot", "computer_click", "computer_type", "computer_hotkey",
  "computer_scroll", "computer_list_windows", "computer_focus_window",
  "computer_capture_region",
  "get_site_credentials", "site_fill_credentials", "computer_type_credential",
]);

const EXECUTION_TOOL_FAMILIES = {
  shell: new Set(["shell_exec", "run_script"]),
  browser: new Set([
    "mcp__playwright__browser_navigate",
    "mcp__playwright__browser_click",
    "mcp__playwright__browser_type",
    "mcp__playwright__browser_snapshot",
    "mcp__playwright__browser_screenshot",
  ]),
  code: new Set(["mcp__code_sandbox__run_js", "mcp__code_sandbox__run_ts"]),
  computer: new Set([
    "computer_session_start", "computer_click", "computer_type", "computer_type_credential",
    "computer_hotkey", "computer_scroll", "computer_focus_window",
  ]),
};

interface EphemeralToolSelectionContext {
  /** When provided, the validator checks tool-fit against the agent's stated
   *  intent: a research-shaped agent must include at least one
   *  RESEARCH_CAPABLE_TOOL_NAMES tool, otherwise reject with a clear error. */
  description?: string;
  systemPrompt?: string;
  task?: string;
}

function validateEphemeralToolSelection(
  tools: string[],
  opts?: { allowZeroTools?: boolean } & EphemeralToolSelectionContext,
): string[] {
  const issues: string[] = [];

  if (tools.length === 0 && !opts?.allowZeroTools) {
    issues.push("Ephemeral agents must have at least one valid tool.");
  }

  const usesComputerTools = tools.some(t => EXECUTION_TOOL_FAMILIES.computer.has(t));
  const toolCap = usesComputerTools ? 10 : 6;

  if (tools.length > toolCap) {
    issues.push(`Ephemeral agents may grant at most ${toolCap} tools. Keep them narrowly specialized.`);
  }

  const privilegedTools = tools.filter((toolName) => getToolTier(toolName).tier >= ToolTier.TWO_EXECUTE);
  if (privilegedTools.length > 5) {
    issues.push(`Ephemeral agents may grant at most 5 execution-capable tools, got ${privilegedTools.length}.`);
  }

  const selectedFamilies = Object.entries(EXECUTION_TOOL_FAMILIES)
    .filter(([, familyTools]) => tools.some((toolName) => familyTools.has(toolName)))
    .map(([family]) => family);

  if (selectedFamilies.length > 1) {
    issues.push(`Ephemeral agents cannot mix multiple execution families (${selectedFamilies.join(", ")}). Split the mission into focused agents instead.`);
  }

  if (tools.includes("parallel_delegate") && privilegedTools.length > 1) {
    issues.push("Ephemeral coordinator agents using parallel_delegate cannot also hold additional execution-heavy tools.");
  }

  // ── Tool-fit validation (STRUCTURAL, language-free) ─────────────────────
  // The old check keyword-matched the spec text (datasheet/mouser/pricing/aktuell…)
  // to guess "this is a research agent" — deleted (de-lexicalization): the architect is
  // trusted to pick the tools a task needs. We keep ONE structural guard: if the TASK
  // references a URL the agent must fetch but it holds NO web-reaching tool, it will
  // dead-loop on a page it can't open. Keyed on the URL's presence only, no topic lexicon.
  const task = opts?.task ?? "";
  if (/\bhttps?:\/\/[^\s<>"'`)\]]+/i.test(task) && !tools.some(isWebReachingToolName)) {
    issues.push(
      "This ephemeral agent's task references a URL to fetch, but the granted tool list contains no "
      + "web-reaching tool (web_search, web_fetch, url_inspect, or a browser_* tool). Re-spawn with one of those.",
    );
  }

  return issues;
}

interface ArchitectEphemeralSpec {
  agentName?: unknown;
  description?: unknown;
  systemPrompt?: unknown;
  tools?: unknown;
  maxIterations?: unknown;
  model?: unknown;
}

function getEphemeralGenerationSettings() {
  const config = getConfig();
  return config.agents.ephemeralGeneration;
}

function extractFirstJsonObject(content: string): string {
  const start = content.indexOf("{");
  if (start === -1) {
    throw new SyntaxError("No JSON object found in architect response");
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < content.length; index += 1) {
    const char = content[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
      continue;
    }

    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return content.slice(start, index + 1);
      }
    }
  }

  throw new SyntaxError("Unterminated JSON object in architect response");
}

function parseArchitectSpec(content: string): ArchitectEphemeralSpec {
  const trimmed = content.trim();
  const jsonStr = extractFirstJsonObject(trimmed);
  return JSON.parse(jsonStr) as ArchitectEphemeralSpec;
}

function buildArchitectPrompt(task: string, previousContext?: string): string {
  const toolList = [...GRANTABLE_TOOLS].join(", ");
  const defaultModel = getConfig().agents.defaults.model.primary;
  return [
    "You are an agent architect. Design a minimal, focused ephemeral agent to complete the given task.",
    "Return valid JSON only. Do not include markdown fences or commentary.",
    "",
    `Available tools: ${toolList}`,
    `Default model: ${defaultModel}`,
    "",
    "Rules:",
    "- Choose at most 4 tools (up to 6 for computer-use tasks).",
    "- If the task can be completed purely from the provided task text and context, tools may be an empty array [].",
    "- Do NOT mix execution families: shell (shell_exec, run_script), browser (mcp__playwright__*), and code (mcp__code_sandbox__*) are separate families — pick at most one.",
    "- If the task requires fetching data from the web using browser tools (mcp__playwright__*), ALWAYS also include web_search so the agent can discover valid URLs before navigating. Never invent placeholder or example URLs.",
    "- Keep systemPrompt concise (under 200 words). State the role, key rules, and a tool budget.",
    "- maxIterations must be between 3 and 8 for non-computer tasks. For computer-use tasks (tools starting with computer_), use 10-15 iterations because each screen interaction needs snapshot+action+verify cycles.",
    "- For computer-use agents: include 'Do NOT call the same tool with identical arguments twice in a row' in the systemPrompt. The session is already started — begin with computer_list_windows, not computer_session_start.",
    "- Choose a model appropriate for the task. Use a single string model id in model.primary when you want to override the default.",
    "",
    "Schema:",
    "{",
    '  "agentName": "<snake_case_name>",',
    '  "description": "<one line>",',
    '  "systemPrompt": "<instructions>",',
    '  "tools": ["<tool1>", "<tool2>"],',
    '  "maxIterations": 5,',
    '  "model": { "primary": "<optional model id override>", "temperature": 0.1, "maxTokens": 6144 }',
    "}",
    "",
    `Task: ${task.slice(0, 1200)}`,
    ...(previousContext ? ["", "Context from previous attempts (use these real URLs and facts — do NOT invent placeholder URLs):", previousContext] : []),
  ].join("\n");
}

async function requestArchitectSpec(task: string, ctx: ToolContext, previousContext?: string): Promise<ArchitectEphemeralSpec | null> {
  const settings = getEphemeralGenerationSettings();
  const architectAgentName = settings.architectAgentName;
  const architectPrompt = buildArchitectPrompt(task, previousContext);

  try {
    const response = await runSubAgent({
      agentName: architectAgentName,
      task: architectPrompt,
      parentSessionId: ctx.sessionId,
      workspacePath: ctx.workspacePath,
      userId: ctx.userId,
      signal: ctx.signal,
      approvalCallback: ctx.approvalCallback,
      humanInLoopSteps: ctx.humanInLoopSteps,
      maxIterationsOverride: ctx.maxIterationsOverride,
      _workflowExecutionStack: ctx._workflowExecutionStack,
    });
    return parseArchitectSpec(response);
  } catch (error) {
    logAudit(
      "architect_fallback_failed",
      { reason: "architect_agent_error", architectAgentName, err: String(error) },
      { sessionId: ctx.sessionId, severity: "warn" },
    );
    return null;
  }
}

function normalizeArchitectModel(model: unknown): import("../config/schema.js").SubAgentConfig["model"] {
  if (!model) return undefined;
  if (typeof model === "string" && model.trim()) {
    return { primary: model.trim() };
  }
  if (typeof model !== "object") return undefined;
  const raw = model as Record<string, unknown>;
  const primary = typeof raw.primary === "string" && raw.primary.trim() ? raw.primary.trim() : undefined;
  const temperature = typeof raw.temperature === "number" ? raw.temperature : undefined;
  const maxTokens = typeof raw.maxTokens === "number" ? raw.maxTokens : undefined;
  if (!primary && temperature === undefined && maxTokens === undefined) return undefined;
  return {
    ...(primary ? { primary } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };
}

/**
 * After a successful ephemeral run, check whether this agent type has proven
 * reliable enough to be promoted to the permanent catalog.
 */
function maybePromoteEphemeral(
  agentName: string,
  workspacePath: string,
  cfg: import("../config/schema.js").SubAgentConfig,
): void {
  const outcomes = readRecentOutcomes(workspacePath, 100);
  const relevant = outcomes.filter(o => o.agent === agentName);
  const successes = relevant.filter(o => o.outcome === "success").length;
  if (successes < PROMOTION_MIN_SUCCESSES) return;
  const successRate = successes / relevant.length;
  if (successRate < PROMOTION_MIN_SUCCESS_RATE) return;
  // Strip "ephemeral:" prefix for the promoted catalog name
  const promotedName = agentName.replace(/^ephemeral:/, "");
  // Don't overwrite an existing permanent agent
  const config = getConfig();
  if (config.subAgents[promotedName]) return;
  promoteEphemeralAgent(workspacePath, promotedName, cfg);
}

/**
 * Last-resort routing path: ask the LLM to design a minimal ephemeral agent
 * tailored to the task, run it, and conditionally auto-promote it.
 *
 * Returns null if the LLM call or spec validation fails so the caller can
 * handle the hard-failure case gracefully.
 */
/** Partition a requested tool list into the grantable ones and the rejected ones. */
export function partitionGrantableTools(names: string[]): { tools: string[]; rejected: string[] } {
  const seen = new Set<string>();
  const tools: string[] = [];
  const rejected: string[] = [];
  for (const n of names) {
    const name = String(n ?? "").trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    if (GRANTABLE_TOOLS.has(name)) tools.push(name);
    else rejected.push(name);
  }
  return { tools, rejected };
}

/**
 * Instantiate and run a single-use ephemeral "worker" agent from an explicit
 * spec (used by use_knowledge_base to run a KB's per-KB worker template — no LLM
 * architect step, no routing). Requested tools are filtered to the grantable
 * set; `alwaysGrantTools` are unioned in first so the caller can guarantee core
 * tools (e.g. a KB's retrieval tools). Runs in-process (container disabled) so
 * gateway-bound tools (Playwright, web, KB retrieval) resolve. Returns the run
 * result; never throws for a normal agent failure.
 */
export async function runEphemeralWorker(input: {
  agentName: string;
  task: string;
  context?: string;
  systemPrompt: string;
  requestedTools: string[];
  alwaysGrantTools?: string[];
  model?: { primary?: string; temperature?: number; maxTokens?: number };
  maxIterations?: number;
  timeoutMs?: number;
  /** Owning conversation session for KB scope checks — threaded onto the worker's
   * ToolContext so a session-scoped KB is reachable from inside the worker (whose
   * own sessionId is a rewritten per-run sub-session id). */
  kbAccessSessionId?: string;
  ctx: ToolContext;
}): Promise<{ success: boolean; output: string; grantedTools: string[]; rejectedTools: string[] }> {
  const requested = [...(input.alwaysGrantTools ?? []), ...input.requestedTools];
  const { tools, rejected } = partitionGrantableTools(requested);
  if (tools.length === 0) {
    return { success: false, output: "the worker has no grantable tools", grantedTools: [], rejectedTools: rejected };
  }

  const agentName = `ephemeral:${String(input.agentName || "kb_worker").trim().replace(/\W+/g, "_").slice(0, 64)}`;
  const maxIter = Math.min(10, Math.max(1, input.maxIterations ?? 6));
  const resolvedTimeoutMs = input.timeoutMs !== undefined ? Math.min(600_000, Math.max(60_000, input.timeoutMs)) : undefined;

  // Validate model.primary against configured models (reject hallucinated ids).
  let modelPrimary: string | undefined;
  if (input.model?.primary) {
    const cfg = getConfig();
    const configured = new Set<string>([cfg.agents.defaults.model.primary]);
    if (cfg.agents.defaults.model.fallback) configured.add(cfg.agents.defaults.model.fallback);
    for (const a of Object.values(cfg.subAgents)) {
      if (a.model?.primary) configured.add(a.model.primary);
      if (a.model?.fallback) configured.add(a.model.fallback);
    }
    if (configured.has(input.model.primary)) modelPrimary = input.model.primary;
  }
  const hasModel = modelPrimary || input.model?.temperature !== undefined || input.model?.maxTokens !== undefined;

  const inlineConfig = {
    description: input.agentName,
    capabilities: [],
    tags: [],
    systemPrompt: input.systemPrompt,
    tools,
    maxIterations: maxIter,
    model: hasModel ? {
      ...(modelPrimary ? { primary: modelPrimary } : {}),
      ...(input.model?.temperature !== undefined ? { temperature: input.model.temperature } : {}),
      ...(input.model?.maxTokens !== undefined ? { maxTokens: input.model.maxTokens } : {}),
    } : undefined,
    ...(resolvedTimeoutMs !== undefined ? { turnTimeoutMs: resolvedTimeoutMs } : {}),
    container: { disabled: true, enabled: false, image: "starlingai/agent-worker:dev", memoryMb: 512, cpus: 0.5, timeoutMs: 60_000 },
  };

  let runResult;
  try {
    runResult = await runSubAgentWithStats({
      agentName,
      task: input.task,
      ...(input.context ? { context: input.context } : {}),
      parentSessionId: input.ctx.sessionId,
      workspacePath: input.ctx.workspacePath,
      ...(input.ctx.userId ? { userId: input.ctx.userId } : {}),
      ...(input.kbAccessSessionId ? { kbAccessSessionId: input.kbAccessSessionId } : {}),
      ...(input.ctx.signal ? { signal: input.ctx.signal } : {}),
      ...(input.ctx.approvalCallback ? { approvalCallback: input.ctx.approvalCallback } : {}),
      ...(input.ctx.humanInLoopSteps ? { humanInLoopSteps: input.ctx.humanInLoopSteps } : {}),
      inlineConfig,
      ...(input.ctx._workflowExecutionStack ? { _workflowExecutionStack: input.ctx._workflowExecutionStack } : {}),
    });
  } catch (err) {
    return { success: false, output: `worker run error: ${err instanceof Error ? err.message : String(err)}`, grantedTools: tools, rejectedTools: rejected };
  }

  // Derive success from the run outcome instead of hardcoding true, mirroring
  // runArchitectFallback — otherwise a worker that errors, times out, hits the
  // iteration cap, or returns nothing is mislabeled as a grounded success (the
  // caller's `if (!success)` guard would be dead code).
  const out = (runResult.output ?? "").trim();
  const terminalState = runResult.stats?.terminalState;
  const outcome = runResult.stats?.outcome;
  const success =
    out.length > 0 &&
    outcome !== "failure" &&
    (terminalState === undefined || terminalState === "completed" || (terminalState === "max_iterations" && !looksLikeFailureResult(out)));

  return { success, output: out || "the worker produced no output", grantedTools: tools, rejectedTools: rejected };
}

export async function runArchitectFallback(task: string, ctx: ToolContext): Promise<ToolResult | null> {
  const config = getConfig();
  const settings = getEphemeralGenerationSettings();
  if (!settings.enabled) {
    return null;
  }

  // Gather shared context from prior attempts so the ephemeral agent knows
  // about URLs, facts, and partial results already discovered.
  const sharedCtx = await formatSharedContextForPrompt(ctx.sessionId, { agentName: "architect" });
  const spec = await requestArchitectSpec(task, ctx, sharedCtx ?? undefined);
  if (!spec) {
    return null;
  }

  const agentName = String(spec.agentName ?? "architect_agent")
    .trim()
    .replace(/\W+/g, "_")
    .slice(0, 64);
  const systemPrompt = String(spec.systemPrompt ?? "").trim();
  const description = String(spec.description ?? agentName);
  const rawTools = Array.isArray(spec.tools) ? spec.tools.map(String) : [];
  const tools = rawTools.filter(t => GRANTABLE_TOOLS.has(t));
  // Always let an architect-fallback ephemeral publish to (and read from) the shared-facts
  // store so its findings reach the parent and sibling agents. The architect routinely omits
  // share_finding from its tool pick, so the ephemeral's explicit shares were hard-blocked as
  // not_in_agent_tools and its evidence never propagated to the parent's build/synthesis gate
  // (audit 9b5196ad: ephemeral researcher → starved build, no app).
  for (const sharingTool of ["share_finding", "read_shared_facts"]) {
    if (GRANTABLE_TOOLS.has(sharingTool) && !tools.includes(sharingTool)) tools.push(sharingTool);
  }
  const usesComputerTools = tools.some(t => EXECUTION_TOOL_FAMILIES.computer.has(t));
  const iterCap = usesComputerTools ? 20 : 8;
  const iterFloor = usesComputerTools ? 8 : 1;
  const maxIterations = Math.min(iterCap, Math.max(iterFloor, Number(spec.maxIterations ?? (usesComputerTools ? 12 : 5)) || 5));
  const model = normalizeArchitectModel(spec.model);

  const policyIssues = validateEphemeralToolSelection(tools, { allowZeroTools: true });
  if (policyIssues.length > 0 || !systemPrompt) {
    logAudit(
      "architect_fallback_rejected",
      { agentName, policyIssues, missingSystemPrompt: !systemPrompt },
      { sessionId: ctx.sessionId, severity: "warn" },
    );
    return null;
  }

  const inlineConfig: import("../config/schema.js").SubAgentConfig = {
    description,
    capabilities: [],
    tags: [],
    systemPrompt,
    tools,
    maxIterations,
    model,
    // Architect-spawned agents run in-process so they can reach gateway-bound
    // tools (web_search via SearXNG, Playwright browser, MCP tools). The
    // agent-worker container image cannot satisfy these dependencies and would
    // return "container error: unknown". Disable containerization unconditionally.
    container: { disabled: true, enabled: false, image: "starlingai/agent-worker:dev", memoryMb: 512, cpus: 0.5, timeoutMs: 60_000 },
  };

  const ephemeralName = `ephemeral:${agentName}`;

  logAudit(
    "architect_fallback_started",
    { agentName: ephemeralName, tools, maxIterations, model: model?.primary ?? null, architectAgentName: settings.architectAgentName },
    { sessionId: ctx.sessionId },
  );

  let result: string;
  let terminalState: string | undefined;
  try {
    // Inject shared facts into the ephemeral agent's context so it can use
    // URLs, partial results, and evidence discovered by earlier agents.
    const ephemeralSharedCtx = await formatSharedContextForPrompt(ctx.sessionId, { agentName: ephemeralName });
    const runResult = await runSubAgentWithStats({
      agentName: ephemeralName,
      task,
      context: ephemeralSharedCtx ?? undefined,
      parentSessionId: ctx.sessionId,
      workspacePath: ctx.workspacePath,
      userId: ctx.userId,
      allowedAgents: ctx.allowedAgents,
      signal: ctx.signal,
      approvalCallback: ctx.approvalCallback,
      humanInLoopSteps: ctx.humanInLoopSteps,
      swarmState: ctx.swarmState,
      onSwarmState: ctx.onSwarmState,
      _turnAgentCounts: ctx._turnAgentCounts,
      _turnAgentRepeatLimitOverrides: ctx._turnAgentRepeatLimitOverrides,
      _turnTotalDelegationLimitOverride: ctx._turnTotalDelegationLimitOverride,
      _workflowExecutionStack: ctx._workflowExecutionStack,
      inlineConfig,
    });
    result = runResult.output;
    terminalState = runResult.stats.terminalState;
  } catch (err) {
    logAudit(
      "architect_fallback_failed",
      { agentName: ephemeralName, reason: "run_error", err: String(err) },
      { sessionId: ctx.sessionId, severity: "warn" },
    );
    return null;
  }

  let parsedOutcome: any = null;
  const tagMatch = result.match(/<final_answer\s+status="([^"]+)">([\s\S]*?)<\/final_answer>/i);
  if (tagMatch) {
    parsedOutcome = { status: tagMatch[1]!.toLowerCase(), data: tagMatch[2]!.trim() };
  }

  const success = terminalState === undefined || terminalState === "completed"
    ? (parsedOutcome ? parsedOutcome.status !== "failure" && parsedOutcome.status !== "needs_info" : !looksLikeFailureResult(result))
    : (terminalState === "max_iterations" && result.length > 0 && !looksLikeFailureResult(result));

  if (parsedOutcome) {
    result = parsedOutcome.data || result;
  }

  logAudit(
    "architect_fallback_completed",
    { agentName: ephemeralName, success, resultLength: result.length, terminalState: terminalState ?? null },
    { sessionId: ctx.sessionId },
  );

  if (success) {
    maybePromoteEphemeral(ephemeralName, ctx.workspacePath, inlineConfig);
  }

  return {
    success,
    output: success ? `[${ephemeralName}]: ${result}` : result,
    error: success ? undefined : `Architect-designed agent '${agentName}' could not complete the task.`,
    metadata: {
      agentName: ephemeralName,
      architect: true,
      tools,
      promoted: success && config.subAgents[agentName] === undefined,
    },
  };
}

registerTool({
  name: "create_ephemeral_agent",
  description: [
    "Design and immediately run a purpose-built single-use agent for a task that no configured agent covers.",
    "Provide the agent's full spec inline: system prompt, tool list, model, and the task to run.",
    "The agent is ephemeral — it runs once and is discarded.",
    "Use this when semantic agent discovery returns no suitable high-confidence specialist for the original task.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      agentName: {
        type: "string",
        description: "Descriptive name for logging (e.g. 'judicative_researcher', 'tax_law_analyst')",
      },
      description: {
        type: "string",
        description: "One-line description of what this agent does",
      },
      systemPrompt: {
        type: "string",
        description: "Full system prompt for the agent — include role, domain expertise, and RULES for tool use limits",
      },
      tools: {
        type: "array",
        items: { type: "string" },
        description: `Tools to grant. Allowed values: ${[...GRANTABLE_TOOLS].join(", ")}`,
      },
      model: {
        type: "object",
        description: "Optional model override. primary MUST be an exact configured model identifier (e.g. \"lmstudio/qwen/qwen3.6-35b-a3b\" or \"lmstudio/qwen/qwen3.5-9b\") — do NOT invent model names. Omit model entirely to use the system default.",
        properties: {
          primary: { type: "string" },
          temperature: { type: "number" },
          maxTokens: { type: "number" },
        },
      },
      maxIterations: {
        type: "number",
        description: "Max tool-call iterations before the agent is forced to stop (default: 5, max: 10)",
      },
      timeoutMs: {
        type: "number",
        description: "Wall-clock timeout in milliseconds for the ephemeral agent run (minimum: 60000, maximum: 600000). Defaults to 60 s if omitted. Use 300000 for research tasks with multiple web_search iterations.",
      },
      task: {
        type: "string",
        description: "The task or question for the ephemeral agent to complete",
      },
      context: {
        type: "string",
        description: "Optional background context to pass to the agent",
      },
    },
    required: ["agentName", "systemPrompt", "tools", "task"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const agentName = String(args["agentName"] ?? "").trim().replace(/\W+/g, "_").slice(0, 64);
    const task = String(args["task"] ?? "").trim();
    const context = args["context"] ? String(args["context"]) : undefined;
    const systemPrompt = String(args["systemPrompt"] ?? "").trim();

    if (!agentName || !task || !systemPrompt) {
      return { success: false, output: "", error: "agentName, systemPrompt, and task are required" };
    }

    // Validate and filter tool list
    const requestedTools = Array.isArray(args["tools"]) ? args["tools"].map(String) : [];
    const description = String(args["description"] ?? "").trim();
    const toolSearchQuery = [task, description, systemPrompt].filter(Boolean).join("\n");
    let semanticToolMatches: string[] = [];
    try {
      const grantableHandlers = getAllTools().filter((handler) => GRANTABLE_TOOLS.has(handler.name));
      const rankedTools = await searchToolsByEmbedding(toolSearchQuery, 10, grantableHandlers);
      semanticToolMatches = rankedTools.map((match) => match.name).filter(Boolean).slice(0, 8);
      logAudit("agent_routing_evaluated", {
        query: toolSearchQuery.slice(0, 500),
        mode: rankedTools[0]?.mode ?? "empty",
        resultCount: semanticToolMatches.length,
        topResult: semanticToolMatches[0] ?? null,
        surface: "ephemeral_tool_selection",
      }, { sessionId: ctx.sessionId, severity: "info", channel: "tool-routing" });
    } catch (err) {
      log.debug({ err, agentName }, "Ephemeral semantic tool search failed — falling back to grantable-tool validation");
    }
    // Tool selection for ephemeral agents is driven purely by the semantic
    // tool search above (searchToolsByEmbedding over the task/description/prompt).
    // The keyword-based web_search/web_fetch injection was removed.
    let tools = requestedTools.filter(t => GRANTABLE_TOOLS.has(t));
    const rejected = requestedTools.filter(t => !GRANTABLE_TOOLS.has(t));

    // Auto-recover the bare "tools omitted entirely" case instead of dead-ending the
    // turn: the model called create_ephemeral_agent with no tools array (audit 9a6a8c7f
    // turn 3 — the website builder was rejected, the turn then collapsed). We already
    // computed the routing layer's best-fit grantable tools; grant the top few so the
    // build can proceed. Only when NOTHING was requested — an explicit list that all got
    // rejected is a real mistake and still surfaces the unknown-tool error below.
    if (requestedTools.length === 0 && tools.length === 0 && semanticToolMatches.length > 0) {
      tools = semanticToolMatches.slice(0, 4);
      logAudit("ephemeral_tools_autofilled", {
        agentName,
        grantedTools: tools,
        reason: "tools_array_omitted_routing_matches_applied",
      }, { sessionId: ctx.sessionId, severity: "info", channel: "agent-factory" });
    }

    if (rejected.length > 0) {
      logAudit("ephemeral_agent_rejected", {
        agentName,
        requestedTools,
        rejectedTools: rejected,
        suggestedTools: semanticToolMatches,
        reason: "unknown_tools_rejected_after_semantic_tool_search",
      }, { sessionId: ctx.sessionId, severity: "warn", channel: "agent-factory" });
      return {
        success: false,
        output: "",
        error: `Unknown tool(s) requested: ${rejected.join(", ")}. Use search_tools/semantic tool discovery and choose only existing tools. Suggested tools for this task: ${semanticToolMatches.join(", ") || "none"}.`,
        metadata: { agentName, rejectedTools: rejected, suggestedTools: semanticToolMatches },
      };
    }

    const policyIssues = validateEphemeralToolSelection(tools, {
      description,
      systemPrompt,
      task,
    });
    if (policyIssues.length > 0) {
      logAudit("ephemeral_agent_rejected", {
        agentName,
        requestedTools,
        grantedTools: tools,
        rejectedTools: rejected,
        reasons: policyIssues,
        suggestedTools: semanticToolMatches,
      }, { sessionId: ctx.sessionId, severity: "warn", channel: "agent-factory" });

      // When the model omitted the tools field entirely, the bare
      // "must have at least one valid tool" reject is unactionable — the
      // model has no way to know what to add. Splice in the semantic
      // routing matches we already computed so the next attempt has a
      // concrete starting list. Session 6b3f2123 showed this exact dead
      // end: routing identified write_file as the top match, but the
      // error never surfaced it.
      const suggestionHint = requestedTools.length === 0 && semanticToolMatches.length > 0
        ? ` You omitted the tools array. Reissue with tools: [${semanticToolMatches.slice(0, 4).map((t) => `"${t}"`).join(", ")}] — the routing layer ranked these as the best fit for your task.`
        : "";

      return {
        success: false,
        output: "",
        error: policyIssues.join(" ") + suggestionHint,
        metadata: { agentName, rejectedTools: rejected, grantedTools: tools, suggestedTools: semanticToolMatches },
      };
    }

    // Build model config
    const modelOverride = args["model"] && typeof args["model"] === "object"
      ? args["model"] as Record<string, unknown>
      : {};

    // Validate model.primary against configured models — reject hallucinated identifiers.
    // The LLM may invent model names from training knowledge (e.g. "qwen/qwen3.5-235b-a22b").
    // If the primary doesn't match a configured model, strip it and fall back to default.
    if (modelOverride["primary"] && typeof modelOverride["primary"] === "string") {
      const requestedPrimary = modelOverride["primary"].trim();
      const cfg = getConfig();
      const configuredModels = new Set<string>();
      configuredModels.add(cfg.agents.defaults.model.primary);
      if (cfg.agents.defaults.model.fallback) configuredModels.add(cfg.agents.defaults.model.fallback);
      for (const agentCfg of Object.values(cfg.subAgents)) {
        if (agentCfg.model?.primary) configuredModels.add(agentCfg.model.primary);
        if (agentCfg.model?.fallback) configuredModels.add(agentCfg.model.fallback);
      }
      if (!configuredModels.has(requestedPrimary)) {
        logAudit("ephemeral_model_override_rejected", {
          agentName,
          requestedPrimary,
          reason: "not_a_configured_model",
          configuredModels: [...configuredModels],
        }, { sessionId: ctx.sessionId, severity: "warn", channel: "agent-factory" });
        delete modelOverride["primary"];
      }
    }

    const maxIter = Math.min(10, Math.max(1, Number(args["maxIterations"] ?? 5) || 5));
    // Honour an explicit timeoutMs from the caller (min 60 s, max 10 min).
    // The leaf-agent default of 60 s is far too short for research tasks with
    // multiple web_search iterations — callers should pass 300000 for those.
    const rawTimeoutMs = typeof args["timeoutMs"] === "number" ? args["timeoutMs"] : undefined;
    const resolvedTimeoutMs = rawTimeoutMs !== undefined
      ? Math.min(600_000, Math.max(60_000, rawTimeoutMs))
      : undefined;

    const inlineConfig = {
      description: String(args["description"] ?? agentName),
      capabilities: [],
      tags: [],
      systemPrompt,
      tools,
      maxIterations: maxIter,
      model: Object.keys(modelOverride).length > 0 ? {
        primary: modelOverride["primary"] ? String(modelOverride["primary"]) : undefined,
        temperature: typeof modelOverride["temperature"] === "number" ? modelOverride["temperature"] : undefined,
        maxTokens: typeof modelOverride["maxTokens"] === "number" ? modelOverride["maxTokens"] : undefined,
      } : undefined,
      ...(resolvedTimeoutMs !== undefined ? { turnTimeoutMs: resolvedTimeoutMs } : {}),
      // Ephemeral agents run in-process: the agent-worker container cannot reach
      // gateway-bound tools (web_search, Playwright, MCP). Disable containerization
      // so tool calls resolve through the live gateway runtime instead.
      container: { disabled: true, enabled: false, image: "starlingai/agent-worker:dev", memoryMb: 512, cpus: 0.5, timeoutMs: 60_000 },
    };

    const ephemeralName = `ephemeral:${agentName}`;

    const runResult = await runSubAgentWithStats({
      agentName: ephemeralName,
      task,
      context,
      parentSessionId: ctx.sessionId,
      workspacePath: ctx.workspacePath,
      userId: ctx.userId,
      signal: ctx.signal,
      approvalCallback: ctx.approvalCallback,
      humanInLoopSteps: ctx.humanInLoopSteps,
      inlineConfig,
      _workflowExecutionStack: ctx._workflowExecutionStack,
      // Note: ephemeral agents have their own maxIter baked into inlineConfig; ctx.maxIterationsOverride is intentionally not forwarded here.
    });
    const result = runResult.output;
    const ephemeralStats = runResult.stats
      ? { toolCount: runResult.stats.toolCount, toolNames: runResult.stats.toolNames }
      : undefined;

    // Same narrative-only guard delegate_to_agent applies. Without it,
    // session 31612733 (2026-05-28) had the model emit a 14 KB unclosed
    // <tool_call> block as TEXT (never actually called write_file), and this
    // path returned success: true with the hallucination as the output — the
    // orchestrator dutifully told the user "Die Lernwebsite wurde erfolgreich
    // erstellt" when no file existed.
    const ephemeralCfg = { tools };
    const narrativeOnly = looksLikeArtifactDeliverableMiss(task, ephemeralStats, ephemeralCfg as never);
    if (narrativeOnly) {
      const expectedTools = tools.filter((name) =>
        /^(?:write_file|edit_file|generate_|bundle_artifact|shell_exec|send_|post_|browser_)/.test(name)
      );
      const expectedHint = expectedTools.length > 0
        ? ` Expected the agent to call one of: ${expectedTools.slice(0, 4).join(", ")}.`
        : "";
      return {
        success: false,
        output: "",
        error: `Ephemeral agent '${ephemeralName}' returned a narrative-only result (granted artifact tools but never invoked one).${expectedHint} The deliverable was NOT produced. Do NOT report success — restate the task as a single direct write_file invocation, or delegate to a configured specialist.`,
        metadata: {
          agentName: ephemeralName,
          grantedTools: tools,
          rejectedTools: rejected,
          narrativeOnly: true,
          toolNames: ephemeralStats?.toolNames ?? [],
        },
      };
    }

    const note = rejected.length > 0 ? ` [Note: tools ${rejected.join(", ")} were rejected as not grantable]` : "";
    return {
      success: true,
      output: `[ephemeral:${agentName}]: ${result}${note}`,
      metadata: { agentName: ephemeralName, grantedTools: tools, rejectedTools: rejected },
    };
  },
});
