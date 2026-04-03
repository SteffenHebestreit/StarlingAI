/**
 * Dynamic Tool Executor — runs self-developed tools safely in the Docker sandbox.
 *
 * Every invocation of a selfdev__ tool spawns a sandbox container.
 * Even after human approval, dynamic tool code never runs on the host.
 *
 * The executor wraps the tool code in a test harness, passes the args
 * as JSON on stdin, and captures structured output.
 */
import { childLogger } from "../logger.js";
import { executeTool, type ToolContext, type ToolResult } from "./registry.js";
import { getTool } from "./registry.js";

const log = childLogger("dynamic-tool-executor");

/**
 * Execute a dynamic tool's code in the Docker sandbox.
 *
 * @param code      The tool's TypeScript source (must define execute(args))
 * @param args      Arguments to pass to the tool
 * @param ctx       Tool execution context
 * @returns         Structured ToolResult
 */
export async function executeDynamicTool(
  code: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  // Build a self-contained script that:
  // 1. Defines the tool code
  // 2. Calls execute() with the provided args
  // 3. Outputs a JSON result
  const script = `
${code}

async function __run() {
  const args = ${JSON.stringify(args)};
  try {
    if (typeof execute !== 'function') {
      console.log(JSON.stringify({ success: false, error: "Tool does not define an execute function" }));
      process.exit(1);
    }
    const result = await execute(args);
    const output = typeof result === 'string' ? result : JSON.stringify(result);
    console.log(JSON.stringify({ success: true, output }));
  } catch (err) {
    console.log(JSON.stringify({ success: false, error: err.message || String(err) }));
    process.exit(1);
  }
}
__run();
  `.trim();

  // Try Docker MCP code-mode first
  const mcpCodeMode = getTool("mcp__MCP_DOCKER__code-mode");
  if (mcpCodeMode) {
    try {
      const result = await mcpCodeMode.execute(
        { code: script, language: "typescript" },
        ctx,
      );

      return parseExecutionResult(result.output, result.error);
    } catch (err) {
      log.warn({ err }, "Docker MCP code-mode unavailable, falling back to shell sandbox");
    }
  }

  // Fallback: shell_exec in sandbox
  const shellCommand = `
cat > /tmp/dynamic_tool.ts << 'DYNAMIC_TOOL_EOF'
${script}
DYNAMIC_TOOL_EOF
cd /tmp && npx tsx dynamic_tool.ts
  `.trim();

  const result = await executeTool("shell_exec", { command: shellCommand }, {
    ...ctx,
    autoApprove: true, // sandbox is already isolated
  });

  return parseExecutionResult(result.output, result.error);
}

function parseExecutionResult(stdout: string, error?: string): ToolResult {
  if (error && !stdout) {
    return { success: false, output: "", error };
  }

  const trimmed = stdout.trim();

  // Try to parse structured JSON output
  // Look for the last line that is valid JSON (in case there's console output before)
  const lines = trimmed.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.startsWith("{")) {
      try {
        const parsed = JSON.parse(line);
        if (typeof parsed === "object" && parsed !== null && "success" in parsed) {
          return {
            success: !!parsed.success,
            output: parsed.output ?? "",
            error: parsed.error,
            metadata: { source: "dynamic_tool" },
          };
        }
      } catch {
        // Not valid JSON, continue searching
      }
    }
  }

  // Fallback: raw output
  return {
    success: !error,
    output: trimmed.slice(0, 8000),
    error,
    metadata: { source: "dynamic_tool", rawOutput: true },
  };
}
