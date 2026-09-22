/**
 * Defang the framing markers that checkToolOutput (guardrails/input.ts) blocks on, for text that
 * is about to be re-emitted inside something the orchestrator will read back as tool output.
 *
 * checkToolOutput BLOCKS rather than neutralizes, which is right for the orchestrator's controlled
 * tools. But some text is quoted on purpose: execute_plan hands delegated results back, and a
 * specialist is shown the user's own words. Text that merely quotes an HTML-ish role tag would then
 * replace a whole report with "Tool output blocked by guardrails". This keeps the content and
 * rewrites only the exact tokens, as input.ts's note on untrusted content asks.
 *
 * A module of its own, not an export of input.ts: several runtime tests replace input.ts with a
 * two-function mock, and a pure string helper should not stop working under them.
 */
export function defangFramingMarkers(text: string): string {
  return text
    .replace(/<(\s*\/?\s*)(system|assistant|human|user|tool_result)\b/gi, "&lt;$1$2")
    .replace(/\[(function_results?)\]/gi, "[$1 ]");
}
