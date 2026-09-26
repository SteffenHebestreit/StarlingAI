/**
 * What a turn remembers about its delegated runs that looped (orchestration.loopAwareDelegation).
 *
 * The loop brake and the busy-stall supervisor set `loopEnforced` on a run's result, and the
 * warden's emergency stop sets `wardenStop` (agent/sub-agent.ts). Those fields end at the delegation
 * that ran the agent. The consequences of a loop live elsewhere: at the orchestrator's frame, at a
 * later dispatch of the same agent, at the artifact gate that decides how to repair the file the
 * looping run left, and at the max-effort oversight's churn signal. A nested run (a content_writer
 * under a mission_coordinator's task graph) is two delegations away from all of them.
 *
 * So every delegation records its run here, in ONE list per turn (ToolContext._turnLoopRuns, shared
 * by reference with every nested delegation, like _turnAgentCounts), and the consumers read it.
 * Session c297c5ea is the shape: content_writer runs looped on one grep for up to 199 iterations,
 * the orchestrator was told "Proceed with any dependent tools", three more builders ran on the same
 * deck, and the artifact gate's fresh mission_coordinator ran 1,990 s against a 720 s timeout.
 *
 * Recording is always on (it changes nothing a model reads); every consumer is behind the flag.
 * INVARIANT: a leaf module.
 */
import { defangFramingMarkers } from "../guardrails/framing-markers.js";

/** One delegated run the loop brake acted on, or the warden stopped. */
export interface TurnLoopRecord {
  /** The agent whose run it was. */
  agent: string;
  /** The agent re-decomposes and re-delegates (a *_coordinator); the artifact gate never picks it as a builder. */
  coordinator: boolean;
  /** SubAgentLoopEnforced, when the loop brake or the busy-stall supervisor acted. */
  loop?: { tool: string; target: string; repeats: number; via: string; endedRun: boolean };
  /** SubAgentWardenStop, when the warden's emergency stop ended the run. */
  wardenStop?: { alert: string };
  /** The run's own outcome (stats.outcome): "success", "partial", "failure". */
  outcome?: string;
  /** Workspace paths of the files the run produced. */
  paths: string[];
}

/** Longest target shown to a model; the brake already clips it to LOOP_TARGET_MAX_CHARS (160). */
const NOTE_TARGET_MAX_CHARS = 160;

/** One line, no role or framing markers: a target is model-chosen text and may carry either. */
export function loopTargetLine(value: string, maxChars = NOTE_TARGET_MAX_CHARS): string {
  const flat = defangFramingMarkers(value.replace(/[\s\p{Cc}]+/gu, " ")).trim();
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 3).trimEnd()}...`;
}

/** The run looped or was stopped, and did not succeed: a looped partial, which is churn, not progress. */
export function isLoopedPartial(record: TurnLoopRecord): boolean {
  return Boolean(record.loop || record.wardenStop) && record.outcome !== "success";
}

/** (e) How many of this turn's delegated runs came back as looped partials. */
export function countLoopedPartials(records: readonly TurnLoopRecord[] | undefined): number {
  return (records ?? []).filter(isLoopedPartial).length;
}

/**
 * (b) The note a new run of `agent` gets in its context when an earlier run of the same agent in
 * this turn looped: the calls it repeated, keyed on tool + target, so a rewording of the task does
 * not hide it and a different call does not trigger it. Null when there is nothing to say.
 */
export function buildPriorLoopNote(records: readonly TurnLoopRecord[] | undefined, agent: string): string | null {
  const byCall = new Map<string, { tool: string; target: string; repeats: number }>();
  for (const record of records ?? []) {
    if (record.agent !== agent || !record.loop) continue;
    const key = `${record.loop.tool}\u0000${record.loop.target}`;
    const seen = byCall.get(key);
    if (!seen || record.loop.repeats > seen.repeats) {
      byCall.set(key, { tool: record.loop.tool, target: record.loop.target, repeats: record.loop.repeats });
    }
  }
  if (byCall.size === 0) return null;
  const lines = [...byCall.values()].map((entry) => `- ${loopTargetLine(entry.tool, 80)} ${loopTargetLine(entry.target)} (x${entry.repeats})`);
  return "[PRIOR LOOP THIS TURN] An earlier run of this agent in this turn kept repeating these calls and "
    + "got the same result every time; repeating them will not change it. Take a different approach.\n"
    + lines.join("\n");
}

function normalizeRef(ref: string): string {
  return ref.trim().replace(/\\/g, "/").replace(/^\.?\//, "");
}

function sameFile(a: string, b: string): boolean {
  const left = normalizeRef(a);
  const right = normalizeRef(b);
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

/**
 * The files one probe receipt's target is about. A page's unfinished asset is reported as
 * "<page> → <ref>" (artifact-probes.ts probeReferencedAssets), which is neither file's path: read
 * whole, it matched no producer, so a deck whose looping builder left its script unfinished was
 * repaired as if nothing had looped. It names the page and the asset, resolved against the page's
 * folder.
 */
function receiptFiles(target: string): string[] {
  const arrow = target.indexOf(" → ");
  if (arrow < 0) return [target];
  const page = normalizeRef(target.slice(0, arrow));
  const folder = page.includes("/") ? page.slice(0, page.lastIndexOf("/")) : "";
  const parts: string[] = [];
  for (const segment of `${folder}/${normalizeRef(target.slice(arrow + 3))}`.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment && segment !== ".") parts.push(segment);
  }
  return [page, parts.join("/")];
}

/**
 * (d) The runs this turn that produced one of `brokenTargets` and looped (the brake acted) or were
 * stopped by the warden. Empty when the broken files came from runs that did neither.
 */
export function loopedProducersOf(
  brokenTargets: readonly string[],
  records: readonly TurnLoopRecord[] | undefined,
): TurnLoopRecord[] {
  const brokenFiles = brokenTargets.flatMap(receiptFiles);
  if (brokenFiles.length === 0) return [];
  return (records ?? []).filter((record) =>
    Boolean(record.loop || record.wardenStop)
    && record.paths.some((path) => brokenFiles.some((target) => sameFile(path, target))));
}
