export function stripUntrustedDelegationContext(args: Record<string, unknown>): Record<string, unknown> {
  if (!("context" in args)) return args;
  const nextArgs = { ...args };
  delete nextArgs["context"];
  return nextArgs;
}

/**
 * Derive a usable delegation task string from the raw arguments of a tool call
 * that named a sub-agent as if it were a tool (e.g. `researcher({query:"…"})`).
 * Returns null when the arguments carry no real task — a parse-error sentinel,
 * an empty object, or only non-string fields — so the caller rejects the call
 * instead of fabricating a task by stringifying the argument object. That
 * fabrication previously leaked `{"_parse_error":true,"_raw":""}` straight into
 * a delegation as the task (audit a3828367: an empty `web_task_coordinator()`
 * call), bypassing the delegate tool's own "task is required" guard.
 * Field names are matched, not content, so this stays language-independent.
 */
export function deriveDelegationTaskFromArgs(args: Record<string, unknown> | undefined): string | null {
  if (!args || typeof args !== "object" || "_parse_error" in args) return null;
  for (const key of ["task", "query", "prompt", "input", "message", "objective", "request", "instruction"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  // No conventional task field — only stringify when there is genuine string
  // content to carry; refuse empty or all-non-string argument objects.
  const hasStringContent = Object.values(args).some(v => typeof v === "string" && v.trim());
  return hasStringContent ? JSON.stringify(args) : null;
}
