/**
 * Tool Development Tools — start, test, and submit new tools.
 *
 * These tools provide agents with a structured pipeline to:
 * 1. Start a development session (tool_dev_start)
 * 2. Run tests against tool code (tool_dev_test)
 * 3. Submit for human approval (tool_dev_submit)
 *
 * All code execution happens in the Docker sandbox.
 * Iteration limits are lifted for tool development sessions.
 */
import { getTool, registerTool, type ToolContext, type ToolResult } from "./registry.js";
import {
  createToolDevSession,
  getToolDevSession,
  getActiveSessionCount,
  updateCode,
  recordTestResults,
  allTestsPassing,
  markAwaitingApproval,
} from "../agent/tool-dev-session.js";
import { runToolTests, validateToolCode } from "./tool-sandbox-runner.js";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { completeImprovement, markImprovementSubmitted, rejectImprovement } from "../agent/self-improve.js";

const log = childLogger("tool:tool-develop");
const SELF_DEVELOPED_TOOL_PREFIX = "selfdev__";

// ── tool_dev_start ──────────────────────────────────────────────────────────

registerTool({
  name: "tool_dev_start",
  description:
    "Start a new tool development session in the Docker sandbox. " +
    "This creates an isolated workspace where you can write, test, and iterate " +
    "on a new tool implementation. The session has no iteration limit — " +
    "you can debug and fix issues as many times as needed. " +
    "Returns a session ID to use with tool_dev_test and tool_dev_submit.",
  parameters: {
    type: "object",
    properties: {
      toolName: {
        type: "string",
        description:
          "Name for the new tool (snake_case, e.g. 'csv_to_json'). " +
          "Must be unique and not conflict with existing tools.",
      },
      description: {
        type: "string",
        description: "Clear description of what the tool does, for the LLM tool catalog.",
      },
      parametersSchema: {
        type: "object",
        description:
          "JSON Schema for the tool's input parameters. " +
          "Example: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] }",
      },
      code: {
        type: "string",
        description:
          "Initial TypeScript implementation. Must export an 'execute(args)' function " +
          "that takes a Record<string, unknown> and returns a string or object result.",
      },
    },
    required: ["toolName", "description", "parametersSchema", "code"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const config = getConfig();
    if (!config.toolDevelopment.enabled) {
      return { success: false, output: "", error: "Tool development is disabled. Set toolDevelopment.enabled = true in config." };
    }

    const maxSessions = config.toolDevelopment.maxConcurrentSessions;
    if (getActiveSessionCount() >= maxSessions) {
      return { success: false, output: "", error: `Maximum concurrent dev sessions reached (${maxSessions}). Wait for existing sessions to complete.` };
    }

    const toolName = String(args["toolName"] ?? "").trim();
    const description = String(args["description"] ?? "").trim();
    const parametersSchema = args["parametersSchema"] as Record<string, unknown> ?? {};
    const code = String(args["code"] ?? "").trim();

    if (!toolName) return { success: false, output: "", error: "toolName is required" };
    if (!/^[a-z][a-z0-9_]{1,48}$/.test(toolName)) {
      return { success: false, output: "", error: "toolName must be snake_case, 2-49 chars, start with letter" };
    }
    if (!description) return { success: false, output: "", error: "description is required" };
    if (!code) return { success: false, output: "", error: "code is required" };
    if (getTool(toolName) || getTool(`${SELF_DEVELOPED_TOOL_PREFIX}${toolName}`)) {
      return { success: false, output: "", error: `Tool name '${toolName}' is already in use` };
    }

    // Validate code structure in sandbox
    const validation = await validateToolCode(code, ctx);
    if (!validation.valid) {
      return {
        success: false,
        output: "",
        error: `Code validation failed:\n${validation.errors.map((e) => `- ${e}`).join("\n")}`,
      };
    }

    const session = createToolDevSession({
      toolName,
      description,
      parametersSchema,
      sessionId: ctx.sessionId,
    });

    updateCode(session.id, code);

    log.info({ devSessionId: session.id, toolName }, "tool_dev_start");

    return {
      success: true,
      output:
        `## Tool Development Session Started\n\n` +
        `**Session ID:** ${session.id}\n` +
        `**Tool:** ${toolName}\n` +
        `**Status:** developing\n\n` +
        `Code validated successfully. Next steps:\n` +
        `1. Use \`tool_dev_test\` to run test cases against your implementation\n` +
        `2. Iterate on the code if tests fail (no iteration limit)\n` +
        `3. Use \`tool_dev_submit\` when all tests pass to submit for approval`,
      metadata: { devSessionId: session.id, toolName },
    };
  },
});

// ── tool_dev_test ───────────────────────────────────────────────────────────

registerTool({
  name: "tool_dev_test",
  description:
    "Run test cases against a tool in development. Each test provides input and " +
    "optional expected output. Returns structured pass/fail results. " +
    "You can also update the tool code before running tests. " +
    "Keep iterating until all tests pass — there is no iteration limit.",
  parameters: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "Tool development session ID from tool_dev_start.",
      },
      code: {
        type: "string",
        description: "Updated tool code (optional — omit to test current code).",
      },
      testCases: {
        type: "array",
        items: {
          type: "object",
          properties: {
            input: {
              type: "object",
              description: "Input arguments to pass to the tool's execute function.",
            },
            expectedOutput: {
              type: "string",
              description: "Optional: substring that should appear in the output.",
            },
          },
          required: ["input"],
        },
        description: "Array of test cases to run.",
      },
    },
    required: ["sessionId", "testCases"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const sessionId = String(args["sessionId"] ?? "").trim();
    const code = args["code"] ? String(args["code"]).trim() : undefined;
    const testCases = args["testCases"] as Array<{ input: Record<string, unknown>; expectedOutput?: string }>;

    if (!sessionId) return { success: false, output: "", error: "sessionId is required" };

    const session = getToolDevSession(sessionId);
    if (!session) return { success: false, output: "", error: `No dev session found: ${sessionId}` };
    if (session.status !== "developing" && session.status !== "testing") {
      return { success: false, output: "", error: `Session is in ${session.status} state — cannot run tests` };
    }

    if (!testCases || testCases.length === 0) {
      return { success: false, output: "", error: "At least one test case is required" };
    }

    // Update code if provided
    if (code) {
      const validation = await validateToolCode(code, { ...ctx, _toolDevSessionId: sessionId });
      if (!validation.valid) {
        return {
          success: false,
          output: "",
          error: `Code validation failed:\n${validation.errors.map((e) => `- ${e}`).join("\n")}`,
        };
      }
      updateCode(sessionId, code);
    }

    // Run tests in sandbox
    const toolCode = code ?? session.code;
    const results = await runToolTests(toolCode, testCases, { ...ctx, _toolDevSessionId: sessionId });
    recordTestResults(sessionId, results);

    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;

    // Format results
    const lines = results.map((r, i) => {
      const status = r.passed ? "PASS" : "FAIL";
      let line = `### Test ${i + 1}: ${status} (${r.durationMs}ms)\n`;
      line += `**Input:** \`${JSON.stringify(r.input)}\`\n`;
      if (r.expectedOutput) line += `**Expected:** "${r.expectedOutput}"\n`;
      line += `**Output:** ${r.actualOutput.slice(0, 500)}\n`;
      if (r.error) line += `**Error:** ${r.error}\n`;
      return line;
    });

    const allPassed = failed === 0;

    return {
      success: true,
      output:
        `## Test Results: ${passed}/${results.length} passed\n\n` +
        lines.join("\n") +
        (allPassed
          ? "\n\n**All tests passed!** You can now submit with `tool_dev_submit`."
          : `\n\n**${failed} test(s) failed.** Update your code and run tests again. No iteration limit — take as many attempts as needed.`),
      metadata: {
        devSessionId: sessionId,
        passed,
        failed,
        total: results.length,
        allPassed,
        iteration: session.iterations,
      },
    };
  },
});

// ── tool_dev_submit ─────────────────────────────────────────────────────────

registerTool({
  name: "tool_dev_submit",
  description:
    "Submit a tested tool for human approval and deployment. " +
    "All tests must pass before submission. Once approved, the tool " +
    "will be automatically deployed as 'selfdev__<toolName>' and " +
    "made available to all agents without a rebuild.",
  parameters: {
    type: "object",
    properties: {
      sessionId: {
        type: "string",
        description: "Tool development session ID.",
      },
    },
    required: ["sessionId"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const sessionId = String(args["sessionId"] ?? "").trim();
    const config = getConfig();

    if (!sessionId) return { success: false, output: "", error: "sessionId is required" };

    const session = getToolDevSession(sessionId);
    if (!session) return { success: false, output: "", error: `No dev session found: ${sessionId}` };
    if (session.status === "approved") {
      return { success: false, output: "", error: `Session ${sessionId} has already been approved and deployed.` };
    }
    if (session.status === "rejected") {
      return { success: false, output: "", error: `Session ${sessionId} was already rejected.` };
    }
    if (session.status === "terminated" || session.status === "stuck") {
      return { success: false, output: "", error: `Session ${sessionId} is ${session.status} and cannot be submitted.` };
    }

    // Gate: all tests must pass
    if (!allTestsPassing(sessionId)) {
      const failed = session.testResults.filter((t) => !t.passed).length;
      return {
        success: false,
        output: "",
        error: `Cannot submit: ${failed} test(s) still failing. Fix the code and run tool_dev_test again.`,
      };
    }

    if (session.status === "awaiting_approval") {
      return { success: false, output: "", error: "Already submitted for approval — waiting for human review." };
    }

    const approvalPayload = {
      sessionId,
      toolName: session.toolName,
      dynamicToolName: `${SELF_DEVELOPED_TOOL_PREFIX}${session.toolName}`,
      description: session.description,
      parametersSchema: session.parametersSchema,
      codePreview: session.code.slice(0, 4000),
      testResults: session.testResults.map((t) => ({
        input: t.input,
        expectedOutput: t.expectedOutput,
        passed: t.passed,
        durationMs: t.durationMs,
        error: t.error,
      })),
      iterations: session.iterations,
    };

    if (config.toolDevelopment.requireApproval) {
      if (!ctx.approvalCallback) {
        return {
          success: false,
          output: "",
          error: "Tool submission requires human approval but no approval channel is available. Configure approvalChannel in toolDevelopment config.",
        };
      }

      markAwaitingApproval(sessionId, `pending:${sessionId}`);
      markImprovementSubmitted(sessionId);

      log.info({ devSessionId: sessionId, toolName: session.toolName }, "tool_dev_submit — awaiting approval");

      const approved = await ctx.approvalCallback("tool_dev_submit", approvalPayload);
      if (!approved) {
        rejectImprovement(session, "human");
        return {
          success: false,
          output: "",
          error: `Deployment of selfdev__${session.toolName} was denied during approval.`,
          metadata: {
            devSessionId: sessionId,
            toolName: session.toolName,
            status: "rejected",
          },
        };
      }

      completeImprovement(session, "human");
      return {
        success: true,
        output:
          `## Tool Approved And Deployed\n\n` +
          `**Tool:** \`${SELF_DEVELOPED_TOOL_PREFIX}${session.toolName}\`\n` +
          `**Tests:** ${session.testResults.length} passed\n` +
          `**Iterations:** ${session.iterations}\n\n` +
          `The tool is now registered live and available without a rebuild.`,
        metadata: {
          devSessionId: sessionId,
          toolName: session.toolName,
          status: "approved",
        },
      };
    }

    completeImprovement(session, "auto");

    return {
      success: true,
      output:
        `## Tool Auto-Approved And Deployed\n\n` +
        `**Tool:** \`${SELF_DEVELOPED_TOOL_PREFIX}${session.toolName}\`\n` +
        `Auto-approval is enabled, so the tool was deployed immediately.`,
      metadata: {
        devSessionId: sessionId,
        toolName: session.toolName,
        status: "approved",
      },
    };
  },
});
