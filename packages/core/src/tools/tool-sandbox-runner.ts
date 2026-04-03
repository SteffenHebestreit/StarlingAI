/**
 * Tool Sandbox Runner — executes tool code in the Docker MCP sandbox.
 *
 * Wraps mcp__MCP_DOCKER__code_mode (or falls back to shell sandbox)
 * for writing, testing, and validating tool implementations.
 *
 * All code execution happens in isolated Docker containers — never on host.
 */
import { childLogger } from "../logger.js";
import { getTool, executeTool, type ToolContext, type ToolResult } from "./registry.js";
import type { TestRun } from "../agent/tool-dev-session.js";
import { heartbeatSession, recordContainerSpawn } from "../agent/tool-dev-session.js";

const log = childLogger("tool-sandbox-runner");

// ── Sandbox code execution ──────────────────────────────────────────────────

/**
 * Execute arbitrary code in the Docker sandbox.
 * Tries Docker MCP first, falls back to shell sandbox.
 */
export async function runInSandbox(
  code: string,
  language: "typescript" | "javascript" | "python",
  ctx: ToolContext,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const devSessionId = ctx._toolDevSessionId;
  if (devSessionId) {
    recordContainerSpawn(devSessionId);
    heartbeatSession(devSessionId);
  }

  try {
  // Try Docker MCP code-mode first
  const mcpCodeMode = getTool("mcp__MCP_DOCKER__code-mode");
  if (mcpCodeMode) {
    try {
      const result = await mcpCodeMode.execute(
        {
          code,
          language,
        },
        ctx,
      );

      if (result.success) {
        return { stdout: result.output, stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: result.error ?? result.output, exitCode: 1 };
    } catch (err) {
      log.warn({ err }, "Docker MCP code-mode failed, falling back to shell sandbox");
    }
  }

  // Fallback: Use the shell_exec tool (which runs in Docker sandbox)
  const shellTool = getTool("shell_exec");
  if (!shellTool) {
    throw new Error("No sandbox execution backend available (neither Docker MCP nor shell_exec)");
  }

  const ext = language === "python" ? "py" : "ts";
  const runner = language === "python" ? "python3" : "npx tsx";

  // Write code to temp file and execute
  const wrappedCode = `
cat > /tmp/tool_test.${ext} << 'TOOL_CODE_EOF'
${code}
TOOL_CODE_EOF
cd /tmp && ${runner} tool_test.${ext}
  `.trim();

  const result = await executeTool("shell_exec", { command: wrappedCode }, {
    ...ctx,
    autoApprove: true, // sandbox is already isolated
  });

  if (result.success) {
    return { stdout: result.output, stderr: "", exitCode: 0 };
  }
  return { stdout: "", stderr: result.error ?? result.output, exitCode: 1 };
  } finally {
    if (devSessionId) {
      heartbeatSession(devSessionId);
    }
  }
}

// ── Tool testing harness ────────────────────────────────────────────────────

/**
 * Run a test harness against tool code in the sandbox.
 *
 * Generates a test runner that:
 * 1. Imports/evaluates the tool code
 * 2. Calls it with each test case input
 * 3. Compares actual output to expected output
 * 4. Returns structured TestRun results
 */
export async function runToolTests(
  toolCode: string,
  testCases: Array<{ input: Record<string, unknown>; expectedOutput?: string }>,
  ctx: ToolContext,
): Promise<TestRun[]> {
  const results: TestRun[] = [];

  for (const tc of testCases) {
    const start = Date.now();

    // Generate a self-contained test script that evaluates the tool code
    // and calls its execute function with the test input
    const testScript = `
// Tool code (embedded)
${toolCode}

// Test execution
async function runTest() {
  const input = ${JSON.stringify(tc.input)};
  try {
    // The tool code should export or define an 'execute' function
    if (typeof execute !== 'function') {
      console.error('ERROR: Tool code must define an execute(args) function');
      process.exit(1);
    }
    const result = await execute(input);
    console.log(JSON.stringify({ success: true, output: typeof result === 'string' ? result : JSON.stringify(result) }));
  } catch (err) {
    console.log(JSON.stringify({ success: false, error: err.message || String(err) }));
  }
}
runTest();
    `.trim();

    try {
      const { stdout, stderr, exitCode } = await runInSandbox(testScript, "typescript", ctx);

      let passed = false;
      let actualOutput = stdout.trim();
      let error: string | undefined;

      if (exitCode !== 0) {
        error = stderr || `Exit code: ${exitCode}`;
        actualOutput = stderr || stdout;
      } else {
        // Try to parse structured output
        try {
          const parsed = JSON.parse(actualOutput);
          if (parsed.success) {
            actualOutput = parsed.output ?? "";
            if (tc.expectedOutput) {
              passed = actualOutput.includes(tc.expectedOutput);
              if (!passed) error = `Expected output to contain: "${tc.expectedOutput}"`;
            } else {
              passed = true;
            }
          } else {
            error = parsed.error ?? "Unknown execution error";
            passed = false;
          }
        } catch {
          // Raw output — check expected if provided
          if (tc.expectedOutput) {
            passed = actualOutput.includes(tc.expectedOutput);
            if (!passed) error = `Expected output to contain: "${tc.expectedOutput}"`;
          } else {
            passed = exitCode === 0;
          }
        }
      }

      results.push({
        input: tc.input,
        expectedOutput: tc.expectedOutput,
        actualOutput: actualOutput.slice(0, 2000),
        passed,
        error,
        durationMs: Date.now() - start,
      });
    } catch (err) {
      results.push({
        input: tc.input,
        expectedOutput: tc.expectedOutput,
        actualOutput: "",
        passed: false,
        error: `Sandbox execution failed: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - start,
      });
    }
  }

  return results;
}

/**
 * Validate that tool code has the expected structure:
 * - Defines an execute function
 * - Has valid parameter handling
 * - Does not import forbidden modules
 */
export async function validateToolCode(
  toolCode: string,
  ctx: ToolContext,
): Promise<{ valid: boolean; errors: string[] }> {
  const errors: string[] = [];

  // Static checks
  if (!toolCode.includes("execute")) {
    errors.push("Tool code must define an 'execute' function");
  }

  // Forbidden patterns
  const forbidden = [
    { pattern: /require\s*\(\s*['"]child_process['"]/, msg: "child_process import forbidden" },
    { pattern: /require\s*\(\s*['"]fs['"]/, msg: "Direct fs import forbidden — use sandbox file APIs" },
    { pattern: /process\.env/, msg: "Direct process.env access forbidden — use credential tool" },
    { pattern: /eval\s*\(/, msg: "eval() forbidden" },
    { pattern: /Function\s*\(/, msg: "Function constructor forbidden" },
  ];

  for (const { pattern, msg } of forbidden) {
    if (pattern.test(toolCode)) {
      errors.push(msg);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  // Dynamic validation: try to parse and execute a syntax check in sandbox
  const syntaxCheckScript = `
${toolCode}
if (typeof execute !== 'function') {
  console.error('No execute function found');
  process.exit(1);
}
console.log('VALID');
  `.trim();

  try {
    const { stdout, exitCode } = await runInSandbox(syntaxCheckScript, "typescript", ctx);
    if (exitCode !== 0 || !stdout.includes("VALID")) {
      errors.push("Tool code failed syntax/structure validation in sandbox");
    }
  } catch (err) {
    errors.push(`Sandbox validation failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { valid: errors.length === 0, errors };
}
