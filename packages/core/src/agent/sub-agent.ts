/**
 * Sub-Agent Runner
 *
 * Executes a named sub-agent from config with its own model, system prompt, and
 * restricted tool set.  Called by the delegate_to_agent tool.
 *
 * Each sub-agent is isolated:
 *  - Fresh conversation history (no access to parent session)
 *  - Its own LMStudioProvider instance (potentially a different model)
 *  - A restricted tool list derived from its config
 *  - Audit entries tagged with the parent session ID so tracing works
 */

import { LMStudioProvider } from "../providers/lmstudio.js";
import type { LLMMessage } from "../providers/lmstudio.js";
import { getConfig } from "../config/loader.js";
import { getToolsAsLLMDefs, executeTool, type ToolContext } from "../tools/registry.js";
import { isToolAllowed } from "../guardrails/tool-tiers.js";
import { scanOutput } from "../guardrails/output.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { runSubAgentInContainer } from "./container-runner.js";
import { appendOutcome, computeAdaptiveSubAgentTimeoutMs } from "./outcomes.js";
import { acquireSlot, releaseSlot, DEFAULT_CONCURRENCY } from "../swarm/concurrency.js";

const log = childLogger("agent:sub-agent");

const DEFAULT_MAX_ITERATIONS = 5;

function normalizeSubAgentOutput(content: string | null | undefined): string {
  const normalized = typeof content === "string" ? content.trim() : "";
  return normalized.length > 0 ? normalized : "Sub-agent produced no final response.";
}

export interface SubAgentRunOptions {
  agentName: string;
  task: string;
  context?: string;
  parentSessionId: string;
  workspacePath: string;
  signal?: AbortSignal;
  approvalCallback?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
  humanInLoopSteps?: string[];
  /** Override the agent's configured maxIterations for this invocation. */
  maxIterationsOverride?: number;
  /** Inline config — bypasses config lookup (used by agent_factory for ephemeral agents) */
  inlineConfig?: import("../config/schema.js").SubAgentConfig;
}

export interface SubAgentExecutionStats {
  agentName: string;
  sessionId: string;
  promptChars: number;
  userContentChars: number;
  toolCount: number;
  iterations: number;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  maxIterations: number;
  model: string;
  capabilities: string[];
  containerColdStartMs?: number;
  containerBootstrapMs?: number;
  containerRuntimeMs?: number;
}

export interface SubAgentRunResult {
  output: string;
  stats: SubAgentExecutionStats;
}

export async function runSubAgentWithStats(opts: SubAgentRunOptions): Promise<SubAgentRunResult> {
  const config = getConfig();
  const agentCfg = opts.inlineConfig ?? config.subAgents[opts.agentName];
  const runStartedAt = Date.now();

  if (!agentCfg) {
    return {
      output: `Sub-agent '${opts.agentName}' is not defined in config.subAgents`,
      stats: {
        agentName: opts.agentName,
        sessionId: `sub:${opts.parentSessionId}:${opts.agentName}:missing`,
        promptChars: 0,
        userContentChars: opts.task.length + (opts.context?.length ?? 0),
        toolCount: 0,
        iterations: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        maxIterations: DEFAULT_MAX_ITERATIONS,
        model: "",
        capabilities: [],
      },
    };
  }

  const defaultTimeoutMs = agentCfg.turnTimeoutMs ?? config.agents.performance?.subAgentTurnSloMs ?? 60_000;
  const adaptiveTimeout = agentCfg.turnTimeoutMs === undefined
    ? computeAdaptiveSubAgentTimeoutMs(opts.agentName, opts.workspacePath, defaultTimeoutMs)
    : null;
  const turnTimeoutMs = agentCfg.turnTimeoutMs ?? adaptiveTimeout?.timeoutMs;
  const timeoutAbort = turnTimeoutMs ? new AbortController() : undefined;
  const timeoutHandle = timeoutAbort
    ? setTimeout(() => timeoutAbort.abort(), turnTimeoutMs)
    : undefined;
  const signal = opts.signal && timeoutAbort
    ? AbortSignal.any([opts.signal, timeoutAbort.signal])
    : opts.signal ?? timeoutAbort?.signal;

  try {
    const subSessionId = `sub:${opts.parentSessionId}:${opts.agentName}:${Date.now()}`;

    logAudit(
      "sub_agent_started",
      {
        agentName: opts.agentName,
        task: opts.task.slice(0, 120),
        capabilities: agentCfg.capabilities,
        tags: agentCfg.tags,
        ...(turnTimeoutMs ? { timeoutMs: turnTimeoutMs } : {}),
        ...(adaptiveTimeout ? {
          adaptiveTimeoutMs: adaptiveTimeout.timeoutMs,
          adaptiveTimeoutBaselineMs: adaptiveTimeout.baselineMs,
          adaptiveTimeoutSamples: adaptiveTimeout.sampleSize,
        } : {}),
      },
      { sessionId: subSessionId, userId: undefined, channel: `sub-agent:${opts.agentName}` }
    );

    // Merge defaults with per-agent overrides
    const modelConfig = { ...config.agents.defaults.model, ...(agentCfg.model ?? {}) };

    const lmsCfg = config.providers.lmstudio;
    const lmsBaseUrl = modelConfig.baseUrl ?? lmsCfg?.baseUrl ?? "http://host.docker.internal:1234/v1";
    const lmsApiKey  = modelConfig.apiKey  ?? lmsCfg?.apiKey  ?? "lm-studio";

    // ── Dispatch to container runner if configured ───────────────────────────
    if (agentCfg.container?.enabled) {
      const maxConcurrent = agentCfg.maxConcurrent ?? DEFAULT_CONCURRENCY;
      await acquireSlot(opts.agentName, maxConcurrent, opts.parentSessionId);
      let containerRun;
      try {
        log.info({ agentName: opts.agentName, maxConcurrent }, "Dispatching to containerized sub-agent");
        containerRun = await runSubAgentInContainer({ ...opts, signal }, agentCfg, modelConfig, lmsBaseUrl, lmsApiKey);
      } finally {
        releaseSlot(opts.agentName);
      }
      logAudit(
        "sub_agent_completed",
        {
          agentName: opts.agentName,
          containerized: true,
          resultLength: containerRun.output.length,
          ...containerRun.metrics,
        },
        { sessionId: subSessionId }
      );
      return {
        output: containerRun.output,
        stats: {
          agentName: opts.agentName,
          sessionId: subSessionId,
          promptChars: 0,
          userContentChars: opts.task.length + (opts.context?.length ?? 0),
          toolCount: 0,
          iterations: 0,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          maxIterations: agentCfg.maxIterations ?? DEFAULT_MAX_ITERATIONS,
          model: modelConfig.primary ?? "",
          capabilities: agentCfg.capabilities ?? [],
          containerColdStartMs: containerRun.metrics.containerColdStartMs,
          containerBootstrapMs: containerRun.metrics.containerBootstrapMs,
          containerRuntimeMs: containerRun.metrics.containerRuntimeMs,
        },
      };
    }

    const provider = new LMStudioProvider(lmsBaseUrl, lmsApiKey, modelConfig);

    // Build system prompt
    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    });
    const systemPrompt = agentCfg.systemPrompt
      ? `${agentCfg.systemPrompt}\n\nAgent name: ${opts.agentName}\nCurrent workspace: ${opts.workspacePath}\nToday's date: ${today}`
      : `You are a specialized AI sub-agent named "${opts.agentName}". Complete the given task and return your result.\n\nAgent name: ${opts.agentName}\nCurrent workspace: ${opts.workspacePath}\nToday's date: ${today}`;

    // Get available tools for this agent
    const tools = getToolsAsLLMDefs(agentCfg.tools);

    const toolContext: ToolContext = {
      sessionId: subSessionId,
      workspacePath: opts.workspacePath,
      approvalCallback: opts.approvalCallback,
      humanInLoopSteps: opts.humanInLoopSteps,
      signal,
    };

    // Build initial message
    const userContent = opts.context
      ? `Context:\n${opts.context}\n\nTask: ${opts.task}`
      : opts.task;

    const history: LLMMessage[] = [{ role: "user", content: userContent }];

    const maxIterations = opts.maxIterationsOverride ?? agentCfg.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    let iterations = 0;
    let toolCount = 0;
    const usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    const buildStats = (): SubAgentExecutionStats => ({
      agentName: opts.agentName,
      sessionId: subSessionId,
      promptChars: systemPrompt.length,
      userContentChars: userContent.length,
      toolCount,
      iterations,
      usage: { ...usage },
      maxIterations,
      model: modelConfig.primary,
      capabilities: agentCfg.capabilities ?? [],
    });

    while (iterations < maxIterations) {
      if (signal?.aborted) {
        if (timeoutAbort?.signal.aborted && turnTimeoutMs) {
          appendOutcome(opts.workspacePath, {
            ts: new Date().toISOString(),
            agent: opts.agentName,
            task: opts.task.slice(0, 200),
            outcome: "failure",
            iterations,
            totalTokens: usage.totalTokens,
            durationMs: Date.now() - runStartedAt,
            timeoutMs: turnTimeoutMs,
            error: `timeout (${turnTimeoutMs}ms) reached`,
          });
          return { output: `Sub-agent '${opts.agentName}' timed out after ${turnTimeoutMs}ms`, stats: buildStats() };
        }
        return { output: "Sub-agent task was cancelled", stats: buildStats() };
      }

      const messages: LLMMessage[] = [
        { role: "system", content: systemPrompt },
        ...history,
      ];

      let response;
      try {
        response = await provider.complete(messages, tools, signal);
      } catch (err) {
        if (timeoutAbort?.signal.aborted && turnTimeoutMs) {
          appendOutcome(opts.workspacePath, {
            ts: new Date().toISOString(),
            agent: opts.agentName,
            task: opts.task.slice(0, 200),
            outcome: "failure",
            iterations,
            totalTokens: usage.totalTokens,
            durationMs: Date.now() - runStartedAt,
            timeoutMs: turnTimeoutMs,
            error: `timeout (${turnTimeoutMs}ms) reached`,
          });
          return { output: `Sub-agent '${opts.agentName}' timed out after ${turnTimeoutMs}ms`, stats: buildStats() };
        }
        if (opts.signal?.aborted) {
          return { output: "Sub-agent task was cancelled", stats: buildStats() };
        }
        log.error({ err, agentName: opts.agentName }, "Sub-agent LLM call failed");
        appendOutcome(opts.workspacePath, {
          ts: new Date().toISOString(),
          agent: opts.agentName,
          task: opts.task.slice(0, 200),
          outcome: "failure",
          iterations,
          totalTokens: usage.totalTokens,
          durationMs: Date.now() - runStartedAt,
          timeoutMs: turnTimeoutMs,
          error: String(err).slice(0, 200),
        });
        return { output: `Sub-agent error: ${String(err)}`, stats: buildStats() };
      }

      usage.promptTokens += response.usage.promptTokens;
      usage.completionTokens += response.usage.completionTokens;
      usage.totalTokens += response.usage.totalTokens;

      // No tool calls — final answer
      if (response.tool_calls.length === 0) {
        let result = normalizeSubAgentOutput(response.content);

        // Scan for secrets before returning to parent session
        const outputScan = scanOutput(result);
        if (!outputScan.safe && outputScan.redacted) {
          logAudit(
            "output_redacted",
            { agentName: opts.agentName, types: outputScan.detectedTypes },
            { sessionId: subSessionId, severity: "warn" }
          );
          result = outputScan.redacted;
        }

        history.push({ role: "assistant", content: result });

        logAudit(
          "sub_agent_completed",
          {
            agentName: opts.agentName,
            iterations,
            resultLength: result.length,
            promptChars: systemPrompt.length,
            userContentChars: userContent.length,
            toolCount,
            usage,
            model: modelConfig.primary,
            durationMs: Date.now() - runStartedAt,
            ...(adaptiveTimeout ? {
              adaptiveTimeoutMs: adaptiveTimeout.timeoutMs,
              adaptiveTimeoutBaselineMs: adaptiveTimeout.baselineMs,
              adaptiveTimeoutSamples: adaptiveTimeout.sampleSize,
            } : {}),
          },
          { sessionId: subSessionId }
        );

        // Detect likely failure patterns from the output text
        const looksLikeFail = /no results|not found|unable to|failed to|error:/i.test(result.slice(0, 300));
        appendOutcome(opts.workspacePath, {
          ts: new Date().toISOString(),
          agent: opts.agentName,
          task: opts.task.slice(0, 200),
          outcome: looksLikeFail ? "partial" : "success",
          iterations,
          totalTokens: usage.totalTokens,
          durationMs: Date.now() - runStartedAt,
          timeoutMs: turnTimeoutMs,
        });

        log.info({ agentName: opts.agentName, iterations }, "Sub-agent completed");
        return { output: result, stats: buildStats() };
      }

      // Process tool calls
      history.push({
        role: "assistant",
        content: response.content,
        tool_calls: response.tool_calls.map(tc => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      });

      const toolResults: LLMMessage[] = [];

      for (const tc of response.tool_calls) {
        if (signal?.aborted) break;
        toolCount++;

        // Enforce tool allow-list
        if (agentCfg.tools && !agentCfg.tools.includes(tc.name)) {
          log.warn({ agentName: opts.agentName, tool: tc.name }, "Sub-agent attempted disallowed tool");
          logAudit(
            "sub_agent_tool_blocked",
            { agentName: opts.agentName, tool: tc.name, reason: "not_in_agent_tools" },
            { sessionId: subSessionId, severity: "warn" }
          );
          toolResults.push({
            role: "tool",
            content: `Tool '${tc.name}' is not in this agent's allowed tool set.`,
            tool_call_id: tc.id,
          });
          continue;
        }

        if (!isToolAllowed(tc.name)) {
          toolResults.push({
            role: "tool",
            content: `Tool '${tc.name}' is blocked by security policy.`,
            tool_call_id: tc.id,
          });
          continue;
        }

        logAudit(
          "sub_agent_tool_call",
          { agentName: opts.agentName, tool: tc.name },
          { sessionId: subSessionId }
        );

        const result = await executeTool(tc.name, tc.arguments, toolContext);

        toolResults.push({
          role: "tool",
          content: result.success ? result.output : `Error: ${result.error ?? "unknown"}`,
          tool_call_id: tc.id,
        });
      }

      history.push(...toolResults);
      iterations++;
    }

    logAudit(
      "sub_agent_max_iterations",
      { agentName: opts.agentName, iterations, toolCount, usage, model: modelConfig.primary },
      { sessionId: subSessionId, severity: "warn" }
    );

    // Force a final synthesis pass — send the conversation history back to the
    // LLM with NO tools so it cannot make more tool calls and must produce a
    // plain-text answer from whatever it has gathered so far.
    if (!signal?.aborted) {
      try {
        const synthMessages: LLMMessage[] = [
          {
            role: "system",
            content: systemPrompt +
              "\n\nYou have exhausted your tool-call budget. " +
              "DO NOT call any more tools. " +
              "Synthesize everything you have gathered so far and return your final answer now.",
          },
          ...history,
        ];
        const synthResponse = await provider.complete(synthMessages, [], signal);
        usage.promptTokens += synthResponse.usage.promptTokens;
        usage.completionTokens += synthResponse.usage.completionTokens;
        usage.totalTokens += synthResponse.usage.totalTokens;

        if (synthResponse.tool_calls.length === 0) {
          let result = normalizeSubAgentOutput(synthResponse.content);
          const outputScan = scanOutput(result);
          if (!outputScan.safe && outputScan.redacted) {
            logAudit(
              "output_redacted",
              { agentName: opts.agentName, types: outputScan.detectedTypes },
              { sessionId: subSessionId, severity: "warn" }
            );
            result = outputScan.redacted;
          }
          appendOutcome(opts.workspacePath, {
            ts: new Date().toISOString(),
            agent: opts.agentName,
            task: opts.task.slice(0, 200),
            outcome: "partial",
            iterations,
            totalTokens: usage.totalTokens,
            durationMs: Date.now() - runStartedAt,
            timeoutMs: turnTimeoutMs,
          });
          log.info({ agentName: opts.agentName, iterations }, "Sub-agent synthesized after max iterations");
          return { output: result, stats: buildStats() };
        }
      } catch (synthErr) {
        log.warn({ synthErr, agentName: opts.agentName }, "Synthesis pass after max iterations failed");
      }
    }

    appendOutcome(opts.workspacePath, {
      ts: new Date().toISOString(),
      agent: opts.agentName,
      task: opts.task.slice(0, 200),
      outcome: "partial",
      iterations,
      totalTokens: usage.totalTokens,
      durationMs: Date.now() - runStartedAt,
      timeoutMs: turnTimeoutMs,
      error: `max_iterations (${maxIterations}) reached`,
    });

    return {
      output: `Sub-agent '${opts.agentName}' reached the maximum number of tool-call iterations (${maxIterations}). Partial result may be incomplete.`,
      stats: buildStats(),
    };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export async function runSubAgent(opts: SubAgentRunOptions): Promise<string> {
  const result = await runSubAgentWithStats(opts);
  return result.output;
}
