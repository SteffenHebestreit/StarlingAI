import { executeTool, type ToolContext, type ToolResult } from "../tools/registry.js";

/** The turn's tool-call callbacks (turn-types.ts RunTurnOptions onToolCall / onToolResult). */
export interface ToolStepSink {
  onToolCall?: (toolCallId: string, name: string, args: Record<string, unknown>) => void;
  onToolResult?: (toolCallId: string, name: string, result: string, metadata?: Record<string, unknown>) => void;
}

/** What the page reads as the call's result: the output, or the error it failed with. */
function resultText(result: ToolResult): string {
  if (result.success) return result.output;
  return result.error?.trim() ? `Error: ${result.error}` : result.output;
}

/**
 * Runs a tool the runtime calls on its own — a corrective build, a reroute, an escalation, an
 * automatic research delegation — and announces it like any call the model makes, under
 * `toolCallId` (the id its history record uses too, so live and reload show the same step).
 *
 * Called straight through executeTool, such a call told the page nothing: a delegation got no row,
 * and the specialist's own calls arrived with no delegation to sit under.
 */
export async function executeVisibleTool(
  sink: ToolStepSink | undefined,
  toolCallId: string,
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
  execute: typeof executeTool = executeTool,
): Promise<ToolResult> {
  sink?.onToolCall?.(toolCallId, name, args);
  try {
    const result = await execute(name, args, context, { toolCallId });
    sink?.onToolResult?.(toolCallId, name, resultText(result), result.metadata);
    return result;
  } catch (error) {
    sink?.onToolResult?.(toolCallId, name, `Error: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}
