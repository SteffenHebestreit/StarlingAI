/**
 * A reply that names, as saved, a file this turn tried to write and did not.
 *
 * Harness-lab validation 2026-10-19: diagram_designer asked generate_mermaid_diagram for
 * diagramme/abhaengigkeiten.md, the tool refused the name, the agent did not retry, and its report,
 * relayed to the user, said the diagram was "erfolgreich erstellt und unter
 * diagramme/abhaengigkeiten.md gespeichert". The run had recorded the failure, with the file it was
 * meant to write (SubAgentToolFailure.target); the answer named exactly that file as done.
 *
 * The signal is structural and narrow: a write the turn itself attempted and that failed, a file
 * that does not exist, and a completion claim in the same answer. A file changed on another host
 * (no failed local write) or one an earlier turn made (it exists) is never flagged.
 */
import { namesOnlyAsNotDone } from "./deliverable-intent.js";
import { startsTurn, type TurnBoundaryMessage } from "./turn-boundary.js";

/** Tools whose `path` argument is the file they write (every artifact emitter names it `output_file`). */
const PATH_WRITING_TOOLS: ReadonlySet<string> = new Set(["write_file", "edit_file", "append_file", "create_file"]);

/** The workspace file a call meant to write, from its own arguments: a failure's `target`. */
export function failedWriteTarget(tool: string, args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const pick = (key: string) => {
    const value = args[key];
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 300) : undefined;
  };
  return pick("output_file") ?? (PATH_WRITING_TOOLS.has(tool) ? pick("path") ?? pick("file_path") : undefined);
}

type HistoryMessage = TurnBoundaryMessage & {
  role: string;
  content?: unknown;
  metadata?: Record<string, unknown>;
  tool_call_id?: string;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>;
};

function parseArgs(raw: unknown): Record<string, unknown> | undefined {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The files this turn's calls meant to write and did not: the delegations' recorded failures
 * (specialistToolFailures, with their target) and the orchestrator's own failed write calls.
 */
export function turnUnwrittenTargets(history: readonly HistoryMessage[]): string[] {
  const targets = new Set<string>();
  const failedCallIds = new Set<string>();
  let start = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (startsTurn(history[i]!)) { start = i; break; }
  }
  for (const message of history.slice(start)) {
    if (message.role !== "tool") continue;
    const failures = message.metadata?.["specialistToolFailures"];
    if (Array.isArray(failures)) {
      for (const failure of failures) {
        const f = failure as Record<string, unknown> | null;
        if (f && typeof f["target"] === "string" && f["target"].trim() && f["declinedByUser"] !== true) targets.add(f["target"].trim());
      }
    }
    if (message.tool_call_id && typeof message.content === "string" && /^Error:/.test(message.content.trim())) failedCallIds.add(message.tool_call_id);
  }
  for (const message of history.slice(start)) {
    for (const call of message.tool_calls ?? []) {
      if (!call.id || !failedCallIds.has(call.id)) continue;
      const target = failedWriteTarget(call.function?.name ?? "", parseArgs(call.function?.arguments));
      if (target) targets.add(target);
    }
  }
  return [...targets];
}

/**
 * The unwritten targets the answer names that do not exist (as given, or under generated/). A
 * target the answer only names as not done ("konnte nicht gespeichert werden") is left out.
 */
export function namedUnwrittenFiles(answer: string, targets: readonly string[], fileExists: (ref: string) => boolean): string[] {
  const text = answer.toLowerCase();
  return targets.filter((target) => {
    const path = target.replace(/^\.?\//, "");
    if (fileExists(path) || fileExists(`generated/${path}`)) return false;
    const base = path.split("/").pop() ?? path;
    const named = text.includes(path.toLowerCase())
      ? path
      : /\.\w{2,5}$/.test(base) && base.length >= 5 && text.includes(base.toLowerCase()) ? base : undefined;
    return named !== undefined && !namesOnlyAsNotDone(answer, named);
  });
}

/** The fixed banner for an answer that names unwritten files as saved (both languages, as its siblings). */
export function unwrittenFilesBanner(files: readonly string[]): string {
  const list = files.map((file) => `\`${file}\``).join(", ");
  return `> ⚠️ **Nicht gespeichert:** ${list} — der Versuch, diese Datei zu schreiben, ist in diesem Schritt fehlgeschlagen; sie existiert nicht. Was unten über sie steht, ist nicht erledigt.\n`
    + `> _Not saved: ${list} — writing it failed this turn and it does not exist; what is said about it below is not done._\n\n`;
}
