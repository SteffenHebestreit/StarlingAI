/**
 * Container Entrypoint — runs inside the agent-worker Docker image.
 *
 * Reads a ContainerTaskPayload from stdin, executes the sub-agent loop,
 * and writes a ContainerTaskResult JSON line to stdout.
 *
 * Intentionally standalone — no gateway, no WS, no config file needed.
 * All configuration is passed in the stdin payload.
 */

import type { LLMMessage } from "../providers/lmstudio.js";
import { getToolsAsLLMDefs, executeTool, type ToolContext } from "../tools/registry.js";
import { isToolAllowed } from "../guardrails/tool-tiers.js";
import type { ContainerTaskPayload, ContainerTaskResult } from "./container-runner.js";
import { createChatProvider } from "../providers/index.js";

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function writeResult(result: ContainerTaskResult): void {
  process.stdout.write(JSON.stringify(result) + "\n");
}

async function main(): Promise<void> {
  const processStartedAt = Date.now();
  let payload: ContainerTaskPayload;
  try {
    const raw = await readStdin();
    payload = JSON.parse(raw) as ContainerTaskPayload;
  } catch (e) {
    writeResult({ success: false, error: `Failed to parse stdin payload: ${String(e)}` });
    process.exit(1);
  }

  // Emit periodic heartbeats to stderr so the runner can detect stuck containers.
  // The runner strips these lines before logging — they are not user-visible.
  const heartbeatTimer = setInterval(() => {
    process.stderr.write(`HEARTBEAT:${Date.now()}\n`);
  }, 15_000);
  heartbeatTimer.unref(); // don't block process exit

  process.stderr.write(`READY:${Date.now() - processStartedAt}\n`);

  const {
    agentName,
    task,
    context,
    parentSessionId,
    workspacePath,
    agentConfig,
    resolvedModelConfig,
    providerBaseUrl,
    providerApiKey,
  } = payload;

  const provider = createChatProvider(resolvedModelConfig, {
    providerId: resolvedModelConfig.primary.split("/")[0] || "lmstudio",
    baseUrl: providerBaseUrl,
    apiKey: providerApiKey,
  });

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  const systemPrompt = agentConfig.systemPrompt
    ? `${agentConfig.systemPrompt}\n\nToday's date: ${today}`
    : `You are a specialized AI sub-agent named "${agentName}". Complete the given task and return your result.\n\nToday's date: ${today}`;

  const tools = getToolsAsLLMDefs(agentConfig.tools);
  const subSessionId = `sub:${parentSessionId}:${agentName}:${Date.now()}`;

  const toolContext: ToolContext = {
    sessionId: subSessionId,
    workspacePath,
    approvalCallback: undefined,
  };

  const userContent = context ? `Context:\n${context}\n\nTask: ${task}` : task;
  const history: LLMMessage[] = [{ role: "user", content: userContent }];

  const maxIterations = agentConfig.maxIterations ?? 5;
  let iterations = 0;

  try {
    while (iterations < maxIterations) {
      const messages: LLMMessage[] = [
        { role: "system", content: systemPrompt },
        ...history,
      ];

      const response = await provider.complete(messages, tools);

      // NOTE: do NOT short-circuit on finishReason === "stop" — many quantized
      // models (LM Studio, Ollama) return finish_reason:"stop" even when they
      // include tool_calls in the same response. Only treat the turn as complete
      // when there are literally zero tool calls to process.
      if (response.tool_calls.length === 0) {
        const result = response.content ?? "(no response)";
        clearInterval(heartbeatTimer);
        writeResult({ success: true, result });
        return;
      }

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
        if (agentConfig.tools && !agentConfig.tools.includes(tc.name)) {
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

    clearInterval(heartbeatTimer);
    writeResult({
      success: false,
      error: `Reached max iterations (${maxIterations}) without a final answer`,
    });
  } catch (e) {
    clearInterval(heartbeatTimer);
    writeResult({ success: false, error: String(e) });
    process.exit(1);
  }
}

main().catch((e) => {
  writeResult({ success: false, error: String(e) });
  process.exit(1);
});
