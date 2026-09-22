/**
 * One assistant turn as a chronological stream of steps — what the chat renders.
 *
 * The turn used to render as a pile of detail blocks in the bubble head, then as one summary
 * line with a link to the rest. Neither showed the FLOW: what happened, in what order, and
 * how each step came out. This is the stream a reader follows while a turn runs — one line
 * per step, filling in with its outcome as it finishes — with the full detail one click away
 * in the side panel instead of inline.
 *
 * Deliberately free of Vue and of the store, so the derivation can be exercised on its own.
 */

export type StepStatus = "running" | "done" | "failed" | "stopped";

export interface TurnStep {
  id: string;
  /** A tool call, or a narration line the runtime emitted between them. */
  kind: "tool" | "note";
  /** Tool name for a tool step; the runtime phase for a note. */
  name: string;
  /** The specialist a delegated tool call ran inside. Absent for the orchestrator's own calls. */
  agent?: string;
  /** 1 when the call ran inside a delegated specialist — rendered nested under its delegation. */
  depth: 0 | 1;
  status: StepStatus;
  /** Epoch ms; 0 when unknown (a step reconstructed from a reloaded transcript). */
  startedAt: number;
  endedAt?: number;
  /** Known duration when there are no timestamps — reconstructed steps carry the tool's own figure. */
  durationMs?: number;
  args?: Record<string, unknown>;
  result?: string;
  metadata?: Record<string, unknown>;
  /** The latest progress line from inside a running delegation. */
  progress?: string;
  /**
   * Who a delegation went to, learned from its progress events. A delegation's arguments do not
   * always name the specialist — the orchestrator can omit `agentName` and let the runtime pick
   * — so without this the row would say "a specialist" until the result arrived.
   */
  target?: string;
  /** The sentence itself, for a note. */
  text?: string;
}

/** One specialist run as the swarm recorded it — kept structural so there is no store import. */
interface SourceAttempt {
  agentName: string;
  status: string;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  toolNames?: string[];
}

/** The minimum of a chat message this module needs — kept structural so it has no store import. */
export interface StepSource {
  /** Namespaces reconstructed step ids, which would otherwise repeat across messages. */
  id?: string;
  steps?: TurnStep[];
  toolCalls?: Array<{ id?: string; name: string; args: Record<string, unknown>; result?: string; metadata?: Record<string, unknown> }>;
  swarmState?: { tasks?: Record<string, { attempts?: SourceAttempt[] }> };
}

const DELEGATING_TOOLS = new Set(["delegate_to_agent", "swarm_delegate"]);

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A failure the tool reported in-band, which still arrives as a normal result. */
export function isFailedResult(result: string | undefined, metadata?: Record<string, unknown>): boolean {
  if (metadata && (metadata["delegationSucceeded"] === false || metadata["success"] === false)) return true;
  return typeof result === "string" && /^\s*(error:|⚠️|failed:)/i.test(result);
}

/**
 * Who a delegation went to. The runtime's answer wins once there is one: the arguments name
 * who was ASKED for, and after a fallback that is the specialist that failed, not the one that
 * produced the result.
 */
export function delegationTarget(step: Pick<TurnStep, "args" | "metadata" | "target">): string | undefined {
  return str(step.metadata?.["agentName"]) ?? str(step.args?.["agentName"]) ?? step.target;
}

export function isDelegation(step: Pick<TurnStep, "name">): boolean {
  return DELEGATING_TOOLS.has(step.name);
}

/**
 * Bookkeeping a specialist does for the swarm rather than for the reader — publishing and
 * reading shared facts. Real calls, so the side panel still lists them; but a row saying
 * "share_finding latest_image" in the middle of the answer is plumbing, not progress.
 */
const QUIET_TOOLS = new Set(["share_finding", "read_shared_facts"]);

export function isQuietStep(step: Pick<TurnStep, "kind" | "name" | "status">): boolean {
  // A failing one is never quiet: if bookkeeping broke, that is worth seeing.
  return step.kind === "tool" && QUIET_TOOLS.has(step.name) && step.status !== "failed";
}

/** The row's main text: what this step IS, in words rather than a function name where we can. */
export function stepTitle(step: TurnStep): string {
  if (step.kind === "note") return step.text ?? step.name;
  const args = step.args ?? {};
  switch (step.name) {
    case "delegate_to_agent":
    case "swarm_delegate": {
      const target = delegationTarget(step);
      return target ? `Delegated to ${target}` : "Delegated to a specialist";
    }
    case "parallel_delegate": return "Delegated in parallel";
    case "run_task_graph": return "Ran a task graph";
    case "record_plan": {
      const steps = Array.isArray(args["steps"]) ? args["steps"].length : undefined;
      return steps ? `Planned ${steps} step${steps === 1 ? "" : "s"}` : "Planned the work";
    }
    case "execute_plan": return "Ran the plan";
    case "search_agents": return "Looked for the right specialist";
    case "generate_image":
      return str(args["baseImage"])
        ? (str(args["mask"]) ? "Edited a region of the image" : "Edited the image")
        : "Generated an image";
    case "transform_image": return "Transformed the image";
    case "ask_user": return "Asked you a question";
    // A specialist a coordinator brought in, reconstructed from the swarm record on reload.
    case "specialist_run": return step.agent ? `${step.agent} worked on it` : "A specialist worked on it";
    default: return step.name;
  }
}

/**
 * The one thing about this step's arguments worth seeing inline — what VS Code shows after a
 * tool name. Only for tools without a worded title, which already say what they did.
 */
export function stepSubject(step: TurnStep): string | undefined {
  if (step.kind !== "tool" || stepTitle(step) !== step.name) return undefined;
  const args = step.args ?? {};
  const pick = str(args["query"]) ?? str(args["path"]) ?? str(args["url"]) ?? str(args["file"])
    ?? str(args["command"]) ?? str(args["prompt"])
    ?? Object.values(args).map(str).find(Boolean);
  return pick ? clip(pick, 60) : undefined;
}

/** How the step came out, in one line. Undefined while it is still running. */
export function stepOutcome(step: TurnStep): string | undefined {
  if (step.kind === "note" || step.status === "running") return undefined;
  // Not "did not finish": a step can also land here because its completion event never
  // arrived while the turn itself succeeded. Claiming failure would be a guess.
  if (step.status === "stopped") return "no result reported";

  const meta = step.metadata ?? {};
  const result = step.result ?? "";

  // Answered without running: a duplicate call served from cache, or one a cap refused.
  // Said up front, because otherwise a cached result reads exactly like fresh work.
  if (meta["notExecuted"] === true) {
    const line = result.split("\n").map(l => l.trim()).find(Boolean);
    return `${meta["cached"] === true ? "cached" : "not run"}${line ? ` · ${clip(line, 100)}` : ""}`;
  }

  if (step.status === "failed") {
    const firstLine = result.split("\n").map(line => line.trim()).find(Boolean) ?? "failed";
    return clip(firstLine.replace(/^(error:|⚠️|failed:)\s*/i, ""), 110);
  }

  switch (step.name) {
    case "generate_image":
    case "transform_image": {
      const path = str(meta["outputPath"]) ?? str(meta["filename"]);
      const tier = str(meta["tier"])
        ?? (/slower quality tier/i.test(result) ? "quality" : undefined);
      return [path ? basename(path) : undefined, tier ? `${tier} tier` : undefined]
        .filter(Boolean).join(" · ") || "done";
    }
    case "search_agents": {
      const top = str(meta["topResult"]);
      const score = num(meta["topResultScore"]);
      return top ? `→ ${top}${score !== undefined ? ` (${Math.round(score * 100)}%)` : ""}` : "no match";
    }
    case "record_plan": {
      const count = num(meta["stepCount"]);
      const risk = str(meta["riskTier"]);
      return [count !== undefined ? `${count} step${count === 1 ? "" : "s"}` : undefined, risk ? `risk ${risk}` : undefined]
        .filter(Boolean).join(" · ") || undefined;
    }
    case "execute_plan": {
      const done = num(meta["done"]);
      const total = num(meta["steps"]);
      const failed = num(meta["failed"]);
      if (done === undefined || total === undefined) break;
      return `${done}/${total} done${failed ? ` · ${failed} failed` : ""}`;
    }
    case "delegate_to_agent":
    case "swarm_delegate": {
      // The specialist's OWN sentence about what it did is the best one-liner there is, so it
      // wins over a file count — and any file it made already has its own row nested below.
      // It sits after this marker in the result envelope the runtime wraps around it.
      const marker = /Observed evidence:\s*/i;
      if (marker.test(result)) {
        const line = result.split(marker)[1]!.split("\n").map(l => l.trim()).find(Boolean);
        if (line) return clip(line, 110);
      }
      const artifacts = Array.isArray(meta["artifacts"]) ? meta["artifacts"].map(record).filter(Boolean) : [];
      if (artifacts.length) {
        const first = artifacts[0]!;
        const name = str(first["filename"]) ?? (str(first["outputPath"]) ? basename(str(first["outputPath"])!) : undefined);
        return artifacts.length === 1 && name ? name : `${artifacts.length} files`;
      }
      break;
    }
    default:
      break;
  }

  const line = result.split("\n").map(l => l.trim()).find(Boolean);
  return line ? clip(line, 110) : undefined;
}

/**
 * What to expect from a step that is known to be slow, said while it runs.
 *
 * A two-minute wait with nothing but a spinner reads as a hang. These are the cases where the
 * duration is known in advance, so the reader is told once instead of left to guess. An edit
 * always runs on the slow tier here because only that tier has an edit route.
 */
export function stepHint(step: TurnStep): string | undefined {
  if (step.status !== "running") return undefined;
  if (step.name === "generate_image") {
    const slow = str(step.args?.["baseImage"]) || step.args?.["tier"] === "quality";
    return slow ? "quality tier — usually 2–3 min" : "usually ~10 s";
  }
  return undefined;
}

export function stepDurationMs(step: TurnStep, now: number): number | undefined {
  if (step.durationMs !== undefined) return step.durationMs;
  if (!step.startedAt) return undefined;
  const end = step.endedAt ?? (step.status === "running" ? now : undefined);
  return end !== undefined ? Math.max(0, end - step.startedAt) : undefined;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Steps for a message that has no live record of them — one reloaded from the transcript.
 *
 * Only the orchestrator's own calls survive a reload, but two other records say what happened
 * inside a delegation, and each covers what the other lacks:
 *
 *  - `swarmState` attempts say WHICH specialists ran and WHAT they called, with start and
 *    finish times — including specialists a coordinator brought in, which no tool call of the
 *    orchestrator's names.
 *  - a delegation's `artifacts` say what came OUT: file, tier, render time.
 *
 * So the specialists' calls come from the attempts, and each is enriched with the artifact it
 * produced when there is one. Timings the transcript does not keep are left blank rather than
 * guessed.
 */
export function stepsFromToolCalls(source: StepSource): TurnStep[] {
  const prefix = source.id ?? "reloaded";
  const attempts = Object.values(source.swarmState?.tasks ?? {})
    .flatMap(task => task.attempts ?? [])
    .sort((a, b) => (a.startedAt ?? "").localeCompare(b.startedAt ?? ""));
  const usedAttempts = new Set<SourceAttempt>();
  const calls = source.toolCalls ?? [];
  const lastDelegation = calls.reduce((last, call, i) => DELEGATING_TOOLS.has(call.name) ? i : last, -1);

  const steps: TurnStep[] = [];
  for (const [index, call] of calls.entries()) {
    const failed = isFailedResult(call.result, call.metadata);
    const step: TurnStep = {
      id: `${prefix}:${index}:${call.name}`,
      kind: "tool",
      name: call.name,
      depth: 0,
      status: call.result === undefined ? "stopped" : failed ? "failed" : "done",
      startedAt: 0,
      args: call.args,
      result: call.result,
      metadata: call.metadata,
    };
    steps.push(step);
    if (!DELEGATING_TOOLS.has(call.name)) continue;

    const target = delegationTarget(step);
    const artifacts = (Array.isArray(call.metadata?.["artifacts"]) ? call.metadata!["artifacts"] as unknown[] : [])
      .map(record).filter((a): a is Record<string, unknown> => Boolean(a));
    const usedArtifacts = new Set<Record<string, unknown>>();

    // The specialist this delegation went to, then — on the last delegation only — anyone
    // else the swarm recorded, which is who a coordinator brought in.
    const own = attempts.find(attempt => !usedAttempts.has(attempt) && attempt.agentName === target);
    const mine = [
      ...(own ? [own] : []),
      ...(index === lastDelegation ? attempts.filter(attempt => attempt !== own && !usedAttempts.has(attempt)) : []),
    ];

    for (const attempt of mine) {
      usedAttempts.add(attempt);
      const started = attempt.startedAt ? Date.parse(attempt.startedAt) : NaN;
      const finished = attempt.finishedAt ? Date.parse(attempt.finishedAt) : NaN;
      const spent = Number.isFinite(started) && Number.isFinite(finished) ? finished - started : undefined;
      if (attempt === own) {
        if (spent !== undefined) step.durationMs = spent;
      } else {
        steps.push({
          id: `${step.id}:run:${attempt.agentName}:${steps.length}`,
          kind: "tool",
          name: "specialist_run",
          agent: attempt.agentName,
          depth: 1,
          status: attempt.status === "failed" ? "failed" : attempt.status === "running" ? "stopped" : "done",
          startedAt: 0,
          ...(spent !== undefined ? { durationMs: spent } : {}),
          ...(attempt.summary ? { result: attempt.summary } : {}),
        });
      }
      for (const [toolIndex, toolName] of (attempt.toolNames ?? []).entries()) {
        const artifact = artifacts.find(candidate => !usedArtifacts.has(candidate)
          && str(candidate["sourceTool"]) === toolName
          && (str(candidate["sourceAgent"]) ?? attempt.agentName) === attempt.agentName);
        if (artifact) usedArtifacts.add(artifact);
        steps.push({
          id: `${step.id}:${attempt.agentName}:${toolIndex}`,
          kind: "tool",
          name: toolName,
          agent: attempt.agentName,
          depth: 1,
          // Only COMPLETED calls reach toolNames, so each one ran.
          status: "done",
          startedAt: 0,
          ...(artifact ? { metadata: artifact, durationMs: num(artifact["elapsedMs"]) } : {}),
        });
      }
    }

    // Anything made that no attempt accounted for — a transcript without swarm state.
    for (const [artifactIndex, artifact] of artifacts.entries()) {
      if (usedArtifacts.has(artifact)) continue;
      steps.push({
        id: `${step.id}:artifact:${artifactIndex}`,
        kind: "tool",
        name: str(artifact["sourceTool"]) ?? "tool",
        agent: str(artifact["sourceAgent"]) ?? target,
        depth: 1,
        status: "done",
        startedAt: 0,
        durationMs: num(artifact["elapsedMs"]),
        metadata: artifact,
      });
    }
  }
  return steps;
}

/** The steps to show for a message: the live record when there is one, else a reconstruction. */
export function stepsFor(source: StepSource): TurnStep[] {
  return source.steps?.length ? source.steps : stepsFromToolCalls(source);
}

/** Total wall time across the top-level steps, for a collapsed header. */
export function turnSpanMs(steps: TurnStep[], now: number): number | undefined {
  const timed = steps.filter(s => s.depth === 0 && s.startedAt);
  if (!timed.length) return undefined;
  const start = Math.min(...timed.map(s => s.startedAt));
  const end = Math.max(...timed.map(s => s.endedAt ?? (s.status === "running" ? now : s.startedAt)));
  return Math.max(0, end - start);
}
