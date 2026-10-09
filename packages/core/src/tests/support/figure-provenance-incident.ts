/**
 * E2E 2026-10-07 (session 3c0c5ce1), as test data. The coder wrote primes.js, and all seven of its
 * sandbox runs failed or printed nothing. Its answer still gave a table with "8.393" primes summing
 * to "7.597.648.268" (the true values are 8392 and 1255204276), and the single-deliverable relay
 * shipped that answer word for word. fixtures/figure-provenance-incident.json holds the delegated
 * task, the nine tool calls as the audit recorded them and the 1016-character reply.
 *
 * Shared by the tests of the figure check, the sub-agent loop, the delegation frame and the turn.
 */
import { readFileSync } from "node:fs";

export interface RecordedResult {
  success: boolean;
  output: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface RecordedCall {
  tool: string;
  args: Record<string, unknown>;
  result: RecordedResult;
}

export interface FigureProvenanceIncident {
  source: string;
  userMessage: string;
  task: string;
  calls: RecordedCall[];
  reply: string;
}

export const INCIDENT: FigureProvenanceIncident = JSON.parse(
  readFileSync(new URL("../fixtures/figure-provenance-incident.json", import.meta.url), "utf8"),
) as FigureProvenanceIncident;

/** The two figures that nothing the run received or executed contained. */
export const INVENTED_FIGURES = ["8.393", "7.597.648.268"] as const;

/** The reply as the run hands it back now: both invented figures masked, nothing else touched. */
export const MASKED_REPLY = INVENTED_FIGURES.reduce((text, figure) => text.replace(figure, "[not observed]"), INCIDENT.reply);

/** What the run records: seven executions, four failed, three printed nothing, two figures masked. */
export const INCIDENT_EXECUTIONS = { attempted: 7, failed: 4, succeededWithOutput: 0, unobservedFigures: 2 };

/** The recorded result of a call, looked up by tool and arguments, as a fake tool returns it. */
export function recordedResult(tool: string, args: Record<string, unknown>): RecordedResult {
  const call = INCIDENT.calls.find((entry) => entry.tool === tool && JSON.stringify(entry.args) === JSON.stringify(args));
  if (!call) throw new Error(`no recorded ${tool} call with ${JSON.stringify(args)}`);
  return call.result;
}

/** The failed calls as a delegation's metadata carries them: the first line of each error. */
export function incidentToolFailures(agent = "coder"): Array<{ agent: string; tool: string; error: string }> {
  return INCIDENT.calls
    .filter((call) => !call.result.success)
    .map((call) => ({ agent, tool: call.tool, error: (call.result.error ?? "").split("\n")[0]!.trim() }));
}

/** The artifact the run's write_file recorded. */
export const INCIDENT_ARTIFACT = {
  ...INCIDENT.calls[0]!.result.metadata,
  sourceTool: "write_file",
  sourceAgent: "coder",
};
