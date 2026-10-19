/**
 * A lab attempt as numbered moments (M1, M2, …) for the editors and the composer: what the user
 * asked, each call the orchestrator and its specialists made with what came back, every verdict
 * the turn recorded, each check that failed, and the reply. An edit must name the moment it
 * answers; one that cannot is speculation (harness-lab/edit-format.ts rejects it).
 */
import type { AuditEventLike } from "../e2e/gateway-client.js";
import type { LabRunRecord } from "./turn-runner.js";

const PREVIEW = 300;
const DEFAULT_MAX_CHARS = 12_000;

export interface Digest {
  text: string;
  /** Every moment id the text names, a collapsed range's members included. */
  moments: Set<string>;
}

function clip(value: unknown, max = PREVIEW): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function str(data: Record<string, unknown>, key: string): string {
  const value = data[key];
  return typeof value === "string" ? value : "";
}

/** The line one audit row contributes, or null for rows that say nothing an editor can act on. */
function eventLine(event: AuditEventLike, orchestratorResults: Map<string, string[]>): string | null {
  const data = event.data ?? {};
  switch (event.type) {
    case "tool_call_requested": {
      const tool = str(data, "tool");
      const result = orchestratorResults.get(tool)?.shift();
      return `orchestrator → ${tool}(${clip(data["args"], 200)})${result !== undefined ? ` ⇒ ${clip(result)}` : ""}`;
    }
    case "tool_call_blocked":
      return `orchestrator ✗ ${str(data, "tool")} refused: ${clip(data["reason"], 120)}`;
    case "sub_agent_started":
      return `delegated to ${str(data, "agentName")}: ${clip(data["task"], 200)}`;
    case "sub_agent_tool_call": {
      if (str(data, "phase") === "start") return `${str(data, "agentName")} → ${str(data, "tool")}(${clip(data["args"], 200)})`;
      const failed = data["success"] === false;
      const detail = failed ? str(data, "error") : str(data, "resultPreview");
      return `${str(data, "agentName")} ${failed ? "✗" : "⇐"} ${str(data, "tool")}${detail ? `: ${clip(detail)}` : ""}`;
    }
    case "sub_agent_tool_blocked":
      return `${str(data, "agentName")} ✗ ${str(data, "tool")} refused: ${clip(data["reason"], 120)}`;
    case "sub_agent_completed":
      return `${str(data, "agentName")} finished: ${str(data, "outcome") || "?"}${str(data, "terminalState") ? ` (${str(data, "terminalState")})` : ""}`;
    case "flow_verification_passed": {
      const flaws = Array.isArray(data["qaFlaws"]) ? (data["qaFlaws"] as unknown[]).map((f) => clip(f, 200)).join(" | ") : "";
      return `QA verdict: ${str(data, "status") || "?"}${flaws ? ` — flaws: ${flaws}` : ""}`;
    }
    case "guardrail_flagged":
      return `guard flagged: ${clip(data["type"] ?? data["details"] ?? data, 160)}`;
    case "warden_alert":
    case "progress_verifier_intervened":
      return `${event.type.replace(/_/g, " ")}: ${clip(data, 160)}`;
    default:
      return null;
  }
}

/**
 * The attempt's moments as text. Repeated identical lines collapse into one range
 * ("M20–M27 8× …"); past `maxChars` the middle of the attempt is cut, never its start or end.
 */
export function buildDigest(record: LabRunRecord, opts: { maxChars?: number } = {}): Digest {
  const lines: string[] = [];
  for (const [index, turn] of record.turns.entries()) {
    lines.push(`[user, turn ${index + 1}] ${clip(turn.message, 600)}`);
    const results = new Map<string, string[]>();
    for (const call of turn.toolCalls) {
      if (call.result === undefined) continue;
      results.set(call.name, [...(results.get(call.name) ?? []), call.result]);
    }
    for (const event of turn.events) {
      const line = eventLine(event, results);
      if (line) lines.push(line);
    }
    if (turn.scorecard) {
      lines.push(`turn recorded: ${turn.scorecard.outcomeStatus}${turn.scorecard.partialOrFailureReason ? ` (${turn.scorecard.partialOrFailureReason})` : ""}`);
    }
    if (turn.status !== "ok") lines.push(`turn ended ${turn.status}${turn.error ? `: ${clip(turn.error, 200)}` : ""}`);
    for (const failure of turn.checkFailures) lines.push(`[check failed] ${clip(failure, 240)}`);
    lines.push(`[reply] ${clip(turn.reply, 800)}`);
  }
  for (const call of record.stubbedCalls) lines.push(`[stubbed, not run] ${call.tool}(${clip(call.args, 160)})`);

  const moments = new Set<string>();
  const out: string[] = [];
  let n = 0;
  for (let i = 0; i < lines.length;) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j += 1;
    const first = n + 1;
    n += j - i;
    for (let m = first; m <= n; m += 1) moments.add(`M${m}`);
    out.push(j - i > 1 ? `M${first}–M${n} ${j - i}× ${lines[i]}` : `M${first} ${lines[i]}`);
    i = j;
  }

  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  let text = out.join("\n");
  if (text.length > maxChars) {
    const head: string[] = [];
    const tail: string[] = [];
    let budget = maxChars - 60;
    for (let i = 0, k = out.length - 1; i <= k && budget > 0;) {
      const take = head.length <= tail.length ? out[i++]! : out[k--]!;
      budget -= take.length + 1;
      if (budget < 0) break;
      if (head.length <= tail.length) head.push(take); else tail.unshift(take);
    }
    text = [...head, `… ${out.length - head.length - tail.length} moments cut …`, ...tail].join("\n");
    // Ids of cut lines are no longer citable.
    const shown = new Set<string>();
    for (const line of [...head, ...tail]) {
      const range = /^M(\d+)(?:–M(\d+))?/.exec(line);
      if (!range) continue;
      const from = Number(range[1]);
      const to = Number(range[2] ?? range[1]);
      for (let m = from; m <= to; m += 1) shown.add(`M${m}`);
    }
    return { text, moments: shown };
  }
  return { text, moments };
}
