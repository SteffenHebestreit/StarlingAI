/**
 * One attempt of a task on one arm: real turns, in-process, on the eval channel, as a synthetic
 * principal of the run, in the arm's scratch workspace. What the attempt records is everything the
 * lab later scores, digests and compares: each turn's reply and status, its tool calls with their
 * results, its audit events (the root session and every run under it), the artifacts it delivered,
 * its scorecard, the task's checks, and the calls the tool policy stubbed.
 */
import type { TurnQualityScorecard } from "../agent/turn-scorecard.js";
import { collectTurnArtifactAttachments, runTurn } from "../agent/runtime.js";
import { createSession } from "../agent/session.js";
import { extractInfraFailureSignature } from "../agent/infra-failure.js";
import { subscribeToAudit } from "../audit/logger.js";
import { evaluateTurnExpectations, type ArtifactRef } from "../e2e/assertions.js";
import type { AuditEventLike } from "../e2e/gateway-client.js";
import { parseOverrideFlags } from "../gateway/override-flags.js";
import { principalIdentity } from "../runtime/user-scope.js";
import { SELF_SANDBOXING_TOOLS } from "../tools/registry.js";
import { withArm, type LabArm } from "./arm.js";
import type { HarnessTask } from "./task-schema.js";
import { setStubSink, type StubbedCall } from "./tool-policy.js";

/** A tool result is kept up to this many characters: enough to see what came back. */
const TOOL_RESULT_CHARS = 1_500;
const DEFAULT_TURN_TIMEOUT_MS = 300_000;
/** Post-turn learning writes and audits are fire-and-forget; wait this long for their rows. */
const DEFAULT_GRACE_MS = 1_500;

export interface LabToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: string;
}

export interface LabTurnRecord {
  message: string;
  status: "ok" | "error" | "blocked";
  reply: string;
  error?: string;
  durationMs: number;
  scorecard?: TurnQualityScorecard;
  toolCalls: LabToolCall[];
  events: AuditEventLike[];
  artifacts: ArtifactRef[];
  /** The task's checks that failed; empty when they all passed or the turn had none. */
  checkFailures: string[];
  /** The turn had checks to fail. */
  checked: boolean;
}

export interface LabRunRecord {
  taskId: string;
  arm: string;
  attempt: number;
  sessionId: string;
  turns: LabTurnRecord[];
  durationMs: number;
  stubbedCalls: StubbedCall[];
  /** Set when the attempt says nothing about the harness: the model backend could not be reached. */
  unscored?: string;
}

export interface RunAttemptOptions {
  runId: string;
  attempt: number;
  scratchRoot: string;
  graceMs?: number;
}

function toArtifactRef(raw: Record<string, unknown>): ArtifactRef {
  const str = (key: string): string | undefined => (typeof raw[key] === "string" ? raw[key] as string : undefined);
  const filename = str("filename") ?? str("name") ?? "";
  return {
    path: str("relativePath") ?? str("externalUrl") ?? filename,
    filename,
    ...(str("contentType") ? { contentType: str("contentType") } : {}),
    ...(str("sourceTool") ? { sourceTool: str("sourceTool") } : {}),
  };
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runLabAttempt(task: HarnessTask, arm: LabArm, opts: RunAttemptOptions): Promise<LabRunRecord> {
  const startedAt = Date.now();
  const stubbedCalls: StubbedCall[] = [];
  return withArm(arm, opts.scratchRoot, `${task.id}-${opts.attempt}`, async (workspacePath) => {
    const session = createSession({
      channel: "eval",
      ...principalIdentity(`harness-lab:${opts.runId}`, "synthetic"),
      workspacePath,
    });
    const record: LabRunRecord = {
      taskId: task.id,
      arm: arm.name,
      attempt: opts.attempt,
      sessionId: session.id,
      turns: [],
      durationMs: 0,
      stubbedCalls,
    };
    setStubSink(stubbedCalls);
    try {
      for (const turn of task.turns) {
        const events: AuditEventLike[] = [];
        // A sub-agent's session is sub:<parent>:<agent>:<ts>, and a nested one carries its
        // parent's id in turn: every run under this turn names the root session.
        const unsubscribe = subscribeToAudit((event) => {
          if (event.sessionId && event.sessionId.includes(session.id)) events.push(event as unknown as AuditEventLike);
        });
        const toolCalls = new Map<string, LabToolCall>();
        const turnStarted = Date.now();
        let reply = "";
        let status: LabTurnRecord["status"] = "ok";
        let error: string | undefined;
        let scorecard: TurnQualityScorecard | undefined;
        // A message written for the chat may carry its inline flags (--auto, --agent, --effort …).
        const { clean, flags } = parseOverrideFlags(turn.message);
        const agent = turn.agent ?? flags.forceAgent;
        const effort = turn.effort ?? flags.effort;
        try {
          const out = await runTurn({
            session,
            userMessage: clean,
            userWords: clean,
            ...(agent ? { directiveAgent: agent } : {}),
            ...(effort ? { effortTier: effort } : {}),
            ...(flags.maxIterationsOverride !== undefined ? { maxIterationsOverride: flags.maxIterationsOverride } : {}),
            autoApprove: false,
            // Nobody is there to approve. --auto approves only the tools that run in a sandbox of
            // their own; every other call that needs approval is refused, as a person declining would.
            approvalCallback: async (tool) => flags.autoApprove && SELF_SANDBOXING_TOOLS.has(tool),
            turnTimeoutOverrideMs: turn.timeoutMs ?? (flags.turnTimeoutSec !== undefined ? flags.turnTimeoutSec * 1000 : undefined) ?? task.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS,
            onToolCall: (id, name, args) => { toolCalls.set(id, { id, name, args }); },
            onToolResult: (id, name, result) => {
              const call = toolCalls.get(id) ?? { id, name, args: {} };
              call.result = result.slice(0, TOOL_RESULT_CHARS);
              toolCalls.set(id, call);
            },
          });
          reply = out.response;
          status = out.blocked ? "blocked" : "ok";
          scorecard = out.qualityScorecard;
          // A model call that failed ends the turn as blocked with an "LLM error" reply rather than
          // throwing. The run then says nothing about the harness either way; a candidate that makes
          // every call fail ends its run as no verdict, never as a win.
          if (scorecard?.finishReason === "llm_error" && !record.unscored) {
            const signature = extractInfraFailureSignature(reply);
            record.unscored = signature ? `model backend unreachable: ${signature}` : `model call failed: ${reply.slice(0, 160)}`;
          }
        } catch (err) {
          status = "error";
          error = err instanceof Error ? err.message : String(err);
          const signature = extractInfraFailureSignature(error);
          if (signature && !record.unscored) record.unscored = `model backend unreachable: ${signature}`;
        }
        const durationMs = Date.now() - turnStarted;
        await wait(opts.graceMs ?? DEFAULT_GRACE_MS);
        unsubscribe();
        const artifacts = collectTurnArtifactAttachments(session).map(toArtifactRef);
        const checkFailures = evaluateTurnExpectations(turn.expect, { status, reply, ...(error ? { error } : {}), durationMs, events, artifacts });
        record.turns.push({
          message: turn.message,
          status,
          reply,
          ...(error ? { error } : {}),
          durationMs,
          ...(scorecard ? { scorecard } : {}),
          toolCalls: [...toolCalls.values()],
          events,
          artifacts,
          checkFailures,
          checked: turn.expect !== undefined,
        });
        if (record.unscored) break;
      }
    } finally {
      setStubSink(null);
    }
    record.durationMs = Date.now() - startedAt;
    return record;
  });
}
