/**
 * Enforcement hooks: a fixed set of actions on tool calls, declared as config (enforcementHooks, from
 * workspace/hooks/*.jsonc), so a person or the harness lab can add one without any code running.
 *
 * - append_hint: once a watched tool has failed `after` times in a run (with an error matching
 *   `errorMatches`, when set), its failures carry a hint to the model. A recurring mistake (a wrong
 *   argument shape, a refused file name) gets the fix written next to the error the model reads.
 * - cap_tool: a watched tool runs at most `maxCalls` times per run; further calls are refused.
 * - verify_write: a watched tool that reports a written file has it checked at once; a write that did
 *   not land, or an emitted file without its form, becomes a failure the model sees and can repair.
 *
 * Applied by the tool registry around every call, the orchestrator's and every sub-agent's. A run is
 * a sub-agent's run (its own session id) or the orchestrator's turn. Every firing is audited.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import { logAudit } from "../audit/logger.js";
import { getConfig } from "../config/loader.js";
import type { EnforcementHook } from "../config/schema.js";
import { currentRequestContext } from "../runtime/request-context.js";
import type { ToolContext, ToolResult } from "./registry.js";
import { containedWorkspaceRealPath } from "./workspace-containment.js";

/** The orchestrator's name in a hook's `agents`. */
export const MAIN_AGENT_NAME = "main_assistant";
const MAX_RUNS_TRACKED = 2_000;
const MAX_VERIFY_BYTES = 8 * 1024 * 1024;

/** Every diagram type Mermaid knows, and any of its "-beta" ones. */
const MERMAID_TYPE_RE = /^\s*(?:graph|flowchart|sequenceDiagram|classDiagram(?:-v2)?|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|quadrantChart|requirementDiagram|gitGraph|C4(?:Context|Container|Component|Dynamic|Deployment)|mindmap|timeline|zenuml|kanban|[a-z]+-beta)\b/;

/** Tools that write a file from content the call carries: their check is that the content landed. */
const CONTENT_WRITERS: Readonly<Record<string, string>> = { write_file: "content", append_file: "content", edit_file: "new_string" };

/** Per run: calls of each watched tool that ran, failures per hook. */
const counts = new Map<string, Map<string, number>>();

function runKey(context: ToolContext): string {
  return `${context.sessionId}|${currentRequestContext()?.turnId ?? ""}|${agentOf(context)}`;
}

function agentOf(context: ToolContext): string {
  return context.currentAgentName ?? MAIN_AGENT_NAME;
}

function bump(key: string, counter: string): number {
  let run = counts.get(key);
  if (!run) {
    run = new Map();
    counts.set(key, run);
    while (counts.size > MAX_RUNS_TRACKED) counts.delete(counts.keys().next().value!);
  }
  const next = (run.get(counter) ?? 0) + 1;
  run.set(counter, next);
  return next;
}

function count(key: string, counter: string): number {
  return counts.get(key)?.get(counter) ?? 0;
}

export function resetEnforcementHooksForTests(): void {
  counts.clear();
  regexCache.clear();
}

const regexCache = new Map<string, RegExp | null>();
function errorPattern(source: string): RegExp | null {
  if (!regexCache.has(source)) {
    let compiled: RegExp | null;
    try { compiled = new RegExp(source, "i"); } catch { compiled = null; }
    regexCache.set(source, compiled);
  }
  return regexCache.get(source) ?? null;
}

/** The enabled hooks that watch `tool` for `agent`, in id order. */
export function hooksFor(tool: string, agent: string): Array<[string, EnforcementHook]> {
  const hooks = getConfig().enforcementHooks ?? {};
  return Object.entries(hooks)
    .filter(([, hook]) => hook.enabled !== false && hook.tools.includes(tool) && (!hook.agents || hook.agents.includes(agent)))
    .sort(([a], [b]) => a.localeCompare(b));
}

function fired(id: string, hook: EnforcementHook, tool: string, context: ToolContext, details: Record<string, unknown> = {}): void {
  logAudit("enforcement_hook_fired", { hook: id, action: hook.action, tool, agent: agentOf(context), ...details }, {
    sessionId: context.sessionId,
    severity: "info",
  });
}

/** Before a call: the refusal of a capped tool, or null to let it run. */
export function enforceBeforeToolCall(tool: string, context: ToolContext): ToolResult | null {
  const key = runKey(context);
  for (const [id, hook] of hooksFor(tool, agentOf(context))) {
    if (hook.action !== "cap_tool") continue;
    if (count(key, `calls:${tool}`) < hook.maxCalls) continue;
    fired(id, hook, tool, context, { maxCalls: hook.maxCalls });
    return {
      success: false,
      output: "",
      error: `Tool '${tool}' has reached its limit of ${hook.maxCalls} call(s) in this run (enforcement hook ${id}).${hook.message ? ` ${hook.message}` : " Work with what the earlier calls returned."}`,
    };
  }
  return null;
}

/** What a written file's check found wrong, or null when it holds. */
export function writeProblem(tool: string, args: Record<string, unknown>, file: string): string | null {
  if (!existsSync(file)) return "it does not exist";
  const size = statSync(file).size;
  if (size === 0) return "it is empty";
  if (size > MAX_VERIFY_BYTES) return null;
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const contentArg = CONTENT_WRITERS[tool];
  if (contentArg) {
    // A file built in chunks is incomplete between them, so a writer is held to what it wrote, not to a form.
    const written = typeof args[contentArg] === "string" ? (args[contentArg] as string).replace(/\r\n/g, "\n") : "";
    return written && !text.includes(written) ? "the content the call wrote is not in it" : null;
  }
  switch (extname(file).toLowerCase()) {
    case ".json":
      try { JSON.parse(text); return null; } catch { return "it is not valid JSON"; }
    case ".svg":
      return /<svg[\s>]/i.test(text) && /<\/svg>\s*$/i.test(text.trim()) ? null : "it is not a complete SVG document";
    case ".mmd": {
      // %% comment or directive lines and front matter (--- … ---) may come before the diagram type, in
      // either order: the emitter puts its title and theme lines before a diagram that has front matter.
      const body = text.replace(/^(?:\s*%%.*\n)+/, "").replace(/^\s*---\n[\s\S]*?\n---\s*\n/, "").replace(/^(?:\s*%%.*\n)+/, "");
      return MERMAID_TYPE_RE.test(body) ? null : "it does not start with a Mermaid diagram type";
    }
    default:
      return null;
  }
}

/** After a call: the result, with a hint appended, or turned into a failure by a write check. */
export function enforceAfterToolCall(tool: string, args: Record<string, unknown>, context: ToolContext, result: ToolResult): ToolResult {
  const hooks = hooksFor(tool, agentOf(context));
  if (hooks.length === 0) return result;
  const key = runKey(context);
  if (hooks.some(([, hook]) => hook.action === "cap_tool")) bump(key, `calls:${tool}`);
  let out = result;
  // Write checks first: a write one of them turns into a failure is a failure a hint may answer.
  const ordered = [...hooks.filter(([, hook]) => hook.action === "verify_write"), ...hooks.filter(([, hook]) => hook.action !== "verify_write")];
  for (const [id, hook] of ordered) {
    if (hook.action === "verify_write" && out.success) {
      const outputPath = typeof out.metadata?.["outputPath"] === "string" ? out.metadata["outputPath"] as string : undefined;
      if (!outputPath) continue;
      const contained = containedWorkspaceRealPath(resolve(context.workspacePath, outputPath), context.workspacePath);
      if (!contained) continue;
      const problem = writeProblem(tool, args, contained.real);
      if (!problem) continue;
      fired(id, hook, tool, context, { file: outputPath, problem });
      out = {
        ...out,
        success: false,
        error: `${tool} reported writing ${outputPath}, but ${problem} (enforcement hook ${id}): the write did not land as intended; write it again.`,
      };
    }
    if (hook.action === "append_hint" && !out.success) {
      const errorText = `${out.error ?? ""}\n${out.output ?? ""}`;
      const pattern = hook.errorMatches ? errorPattern(hook.errorMatches) : undefined;
      if (pattern === null) continue;
      if (pattern && !pattern.test(errorText)) continue;
      if (bump(key, `failures:${id}`) < hook.after) continue;
      fired(id, hook, tool, context, { failures: count(key, `failures:${id}`) });
      out = { ...out, error: `${out.error ?? "The call failed."}\nHint (enforcement hook ${id}): ${hook.hint}` };
    }
  }
  return out;
}
