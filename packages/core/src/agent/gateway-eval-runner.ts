/**
 * Gateway-routed evaluation runner.
 *
 * The in-process eval runner (runSubAgentWithStats) executes an agent in the eval
 * process, which lacks the gateway's runtime environment — docker (serve_app),
 * the bundled SearXNG, the browser-vnc, container-bound MCP servers. That's fine
 * for a pure-reasoning/file agent (content_writer) but breaks web/computer/docker/
 * delegation agents, so pass^k could only validly cover a sliver of the swarm.
 *
 * This runner sends each eval case through a RUNNING gateway over the same WS RPC
 * the dashboard uses — `chat.send` with the `--agent <name>` override forces the
 * orchestrator to delegate the task to exactly that agent, in the full environment.
 * The final turn response becomes the agent output; the `turn_performance` audit
 * event supplies token/iteration stats. Wall-clock latency is measured by the
 * harness around the runner call, so it needs no stats from here.
 *
 * It changes NO runtime behavior — it is an alternate eval transport, opt-in via
 * `pnpm agents:evaluate --via-gateway`.
 */
import { WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { childLogger } from "../logger.js";
import type { AgentEvaluationRunner } from "./evaluation.js";
import type { SubAgentRunOptions, SubAgentRunResult, SubAgentExecutionStats } from "./sub-agent.js";

const log = childLogger("agent:gateway-eval-runner");

interface GatewayRunnerOptions {
  /** Gateway WS URL, e.g. ws://localhost:8765/ws */
  url: string;
  /** Bearer token (same JWT the dashboard uses). */
  token: string;
  /** Per-case hard timeout (ms) before the run is reported as an error. */
  caseTimeoutMs?: number;
  /** Effort tier to run each case under (default "high" — give the agent budget). */
  effort?: "low" | "medium" | "high" | "max";
}

interface GatewayEvalRunner {
  runner: AgentEvaluationRunner;
  close: () => void;
}

interface TurnPerf {
  toolIterations?: number;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

/** Build a minimal-but-valid stats object from an optional turn_performance payload. */
export function statsFromTurnPerformance(
  agentName: string,
  sessionId: string,
  userContentChars: number,
  perf: TurnPerf | undefined,
  status: "ok" | "error" | "blocked",
): SubAgentExecutionStats {
  const usage = perf?.usage ?? {};
  return {
    agentName,
    sessionId,
    promptChars: 0,
    userContentChars,
    toolCount: 0,
    toolNames: [],
    iterations: perf?.toolIterations ?? 0,
    usage: {
      promptTokens: usage.promptTokens ?? 0,
      completionTokens: usage.completionTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
    },
    maxIterations: 0,
    model: "gateway",
    capabilities: [],
    terminalState: status === "ok" ? "completed" : "error",
  };
}

/** Compose the chat.send message: task + optional context + the forced-agent flag. */
export function buildGatewayMessage(opts: Pick<SubAgentRunOptions, "task" | "context" | "agentName">): string {
  const base = opts.context ? `Context:\n${opts.context}\n\nTask: ${opts.task}` : opts.task;
  return `${base} --agent ${opts.agentName}`;
}

export function createGatewayEvalRunner(options: GatewayRunnerOptions): GatewayEvalRunner {
  const caseTimeoutMs = options.caseTimeoutMs ?? 15 * 60 * 1000;
  const effort = options.effort ?? "high";

  let ws: WebSocket | null = null;
  let ready: Promise<void> | null = null;
  let rpcId = 0;
  const pendingRpc = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  // requestId → resolver for the final turn status of an in-flight chat turn.
  const pendingTurns = new Map<string, (r: { status: "ok" | "error" | "blocked"; response: string }) => void>();
  // sessionId → latest turn_performance payload (consumed when the turn finalizes).
  const lastPerfBySession = new Map<string, TurnPerf>();
  // sessionId → latest turn_scorecard payload (QPR-004: eval reports consume the
  // same quality schema the dashboard does).
  const lastScorecardBySession = new Map<string, Record<string, unknown>>();

  function connect(): Promise<void> {
    if (ready) return ready;
    ready = new Promise<void>((resolve, reject) => {
      const sep = options.url.includes("?") ? "&" : "?";
      const socket = new WebSocket(`${options.url}${sep}token=${encodeURIComponent(options.token)}`);
      ws = socket;
      const failTimer = setTimeout(() => reject(new Error("gateway WS connect timeout")), 15000);
      socket.on("message", (raw: Buffer) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (msg["type"] === "hello-ok") {
          clearTimeout(failTimer);
          // Subscribe to audit so we can capture turn_performance for stats.
          void rpc("audit.subscribe", {});
          resolve();
          return;
        }
        const id = msg["id"];
        if (typeof id === "string" && pendingRpc.has(id)) {
          const { resolve: res, reject: rej } = pendingRpc.get(id)!;
          pendingRpc.delete(id);
          if (msg["ok"]) res(msg["payload"]);
          else rej(new Error(String(msg["error"] ?? "rpc error")));
          return;
        }
        if (msg["type"] === "audit.event") {
          const ev = msg["data"] as Record<string, unknown> | undefined;
          const evType = ev?.["eventType"] ?? ev?.["type"];
          if (evType === "turn_performance" && ev) {
            const sid = (ev["sessionId"] as string) ?? "";
            const data = (ev["data"] ?? ev) as TurnPerf;
            if (sid) lastPerfBySession.set(sid, data);
          }
          if (evType === "turn_scorecard" && ev) {
            const sid = (ev["sessionId"] as string) ?? "";
            const data = (ev["data"] ?? ev) as Record<string, unknown>;
            if (sid) lastScorecardBySession.set(sid, data);
          }
          return;
        }
        if (msg["type"] === "status") {
          const data = msg["data"] as Record<string, unknown> | undefined;
          const reqId = data?.["requestId"];
          const status = data?.["status"];
          if (typeof reqId === "string" && pendingTurns.has(reqId)
            && (status === "ok" || status === "error" || status === "blocked")) {
            const done = pendingTurns.get(reqId)!;
            pendingTurns.delete(reqId);
            done({ status, response: String(data?.["response"] ?? "") });
          }
        }
      });
      socket.on("error", (err: Error) => { clearTimeout(failTimer); reject(err); });
      socket.on("close", () => {
        for (const { reject: rej } of pendingRpc.values()) rej(new Error("gateway WS closed"));
        pendingRpc.clear();
      });
    });
    return ready;
  }

  function rpc(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = `e${++rpcId}`;
    return new Promise((resolve, reject) => {
      pendingRpc.set(id, { resolve, reject });
      ws!.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pendingRpc.delete(id)) reject(new Error(`rpc timeout: ${method}`));
      }, 20000);
    });
  }

  const runner: AgentEvaluationRunner = async (opts: SubAgentRunOptions): Promise<SubAgentRunResult> => {
    await connect();
    const created = await rpc("session.create", { channel: "eval" }) as { sessionId: string };
    const sessionId = created.sessionId;
    await rpc("session.updateSettings", { sessionId, effort }).catch(() => undefined);
    const requestId = randomUUID();

    const turnDone = new Promise<{ status: "ok" | "error" | "blocked"; response: string }>((resolve) => {
      pendingTurns.set(requestId, resolve);
      const timer = setTimeout(() => {
        if (pendingTurns.delete(requestId)) resolve({ status: "error", response: "gateway eval case timed out" });
      }, caseTimeoutMs);
      timer.unref?.();
    });

    await rpc("chat.send", { sessionId, requestId, message: buildGatewayMessage(opts) });
    const { status, response } = await turnDone;

    const perf = lastPerfBySession.get(sessionId);
    lastPerfBySession.delete(sessionId);
    const scorecard = lastScorecardBySession.get(sessionId);
    lastScorecardBySession.delete(sessionId);
    log.info({ agentName: opts.agentName, sessionId, status, responseChars: response.length }, "gateway eval case complete");
    return {
      output: status === "ok" ? response : `Sub-agent error: ${response || status}`,
      stats: statsFromTurnPerformance(opts.agentName, sessionId, opts.task.length, perf, status),
      // The v2 quality scorecard rides along verbatim when the turn emitted one —
      // shape-validated at emission (TurnQualityScorecard), so pass-through is safe.
      ...(scorecard && Number(scorecard["version"]) === 2
        ? { qualityScorecard: scorecard as unknown as SubAgentRunResult["qualityScorecard"] }
        : {}),
    };
  };

  return {
    runner,
    close: () => { try { ws?.close(); } catch { /* already closed */ } },
  };
}
