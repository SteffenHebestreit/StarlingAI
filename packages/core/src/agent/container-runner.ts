/**
 * Container Runner — executes a sub-agent inside an ephemeral Docker container.
 *
 * Spawns: docker run --rm --memory=<N>m --cpus=<N> ... starlingai/agent-worker:dev
 * Passes the task as a JSON payload on stdin.
 * Reads the JSON result from stdout.
 *
 * Security flags applied unconditionally:
 *   --read-only           root filesystem is read-only
 *   --security-opt no-new-privileges
 *   --cap-drop ALL
 *   --pids-limit 64
 *   --network none        unless the agent needs internet (researcher/browser_agent)
 *
 * Heartbeat protocol:
 *   The container entrypoint writes "HEARTBEAT:<ms>\n" to stderr every 15 s.
 *   The runner strips these lines from stderr and uses them to detect stuck containers.
 *   If heartbeats stop for HEARTBEAT_TIMEOUT_MS the container is killed and the task
 *   is returned as a recoverable failure so the delegation fallback chain can retry.
 */

import { spawn } from "node:child_process";
import { childLogger } from "../logger.js";
import type { SubAgentRunOptions } from "./sub-agent.js";
import type { SubAgentConfig, ModelConfig } from "../config/schema.js";
import { emitSwarmEvent } from "../swarm/bus.js";

const log = childLogger("agent:container-runner");

// How often the entrypoint emits a heartbeat (ms).
const HEARTBEAT_INTERVAL_MS = 15_000;
// How long without a heartbeat before we treat the container as stuck.
const HEARTBEAT_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * 3; // 45 s
// Grace period before the watchdog starts — lets slow containers warm up.
const HEARTBEAT_WARMUP_MS = 20_000;
// How long to wait for graceful shutdown after SIGTERM before sending SIGKILL.
const GRACEFUL_SHUTDOWN_MS = 5_000;

export interface ContainerTaskPayload {
  agentName: string;
  task: string;
  context?: string;
  parentSessionId: string;
  workspacePath: string;
  agentConfig: SubAgentConfig;
  resolvedModelConfig: ModelConfig;
  lmsBaseUrl: string;
  lmsApiKey: string;
}

export interface ContainerTaskResult {
  success: boolean;
  result?: string;
  error?: string;
}

export interface ContainerRunMetrics {
  containerColdStartMs?: number;
  containerBootstrapMs?: number;
  containerRuntimeMs: number;
  heartbeatSupported: boolean;
}

export interface ContainerRunResult {
  output: string;
  metrics: ContainerRunMetrics;
}

export type ContainerDiagnosticEvent =
  | { type: "heartbeat" }
  | { type: "ready"; bootstrapMs?: number };

// Tools that need internet access — these agents run with --network=bridge
const NEEDS_INTERNET = new Set(["researcher", "browser_agent"]);

/** Send SIGTERM, then SIGKILL after grace period, swallowing errors if already gone. */
function gracefulKill(pid: number | undefined, proc: ReturnType<typeof spawn>): void {
  try { proc.kill("SIGTERM"); } catch { /* already dead */ }
  const forceKill = setTimeout(() => {
    try { proc.kill("SIGKILL"); } catch { /* already dead */ }
  }, GRACEFUL_SHUTDOWN_MS);
  forceKill.unref();
}

/**
 * Try to extract a meaningful partial result from stdout when the container
 * died before writing valid JSON. Picks the longest non-empty non-JSON line.
 */
function recoverPartialOutput(stdout: string): string {
  const lines = stdout.trim().split("\n").filter(l => l.trim().length > 0);
  // Skip lines that look like JSON object/array starts
  const textLines = lines.filter(l => !l.trimStart().startsWith("{") && !l.trimStart().startsWith("["));
  if (textLines.length === 0) return "";
  // Return up to 400 chars from the longest meaningful line
  return textLines.sort((a, b) => b.length - a.length)[0]!.slice(0, 400);
}

export async function runSubAgentInContainer(
  opts: SubAgentRunOptions,
  agentCfg: SubAgentConfig,
  resolvedModelConfig: ModelConfig,
  lmsBaseUrl: string,
  lmsApiKey: string,
): Promise<ContainerRunResult> {
  const container = agentCfg.container!;
  const image = container.image ?? "starlingai/agent-worker:dev";
  const memoryMb = container.memoryMb ?? 512;
  const cpus = container.cpus ?? 0.5;
  const timeoutMs = container.timeoutMs ?? 60000;

  const network = NEEDS_INTERNET.has(opts.agentName) ? "bridge" : "none";

  const payload: ContainerTaskPayload = {
    agentName: opts.agentName,
    task: opts.task,
    context: opts.context,
    parentSessionId: opts.parentSessionId,
    workspacePath: opts.workspacePath,
    agentConfig: agentCfg,
    resolvedModelConfig,
    lmsBaseUrl,
    lmsApiKey,
  };

  const dockerArgs = [
    "run", "--rm", "--init",
    "--memory", `${memoryMb}m`,
    "--memory-swap", `${memoryMb}m`,  // disable swap
    "--cpus", String(cpus),
    "--pids-limit", "64",
    "--read-only",
    "--security-opt", "no-new-privileges",
    "--cap-drop", "ALL",
    "--network", network,
    // Mount workspace volume so tools can read/write files
    "-v", `gc-workspace:${opts.workspacePath}`,
    "--interactive",
    image,
  ];

  log.info({ agentName: opts.agentName, image, memoryMb, cpus, network }, "Spawning sub-agent container");

  const startedAt = Date.now();

  return new Promise((resolve) => {
    const proc = spawn("docker", dockerArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stderrBuffer = "";
    let resolved = false;

    // Heartbeat tracking
    let lastHeartbeatAt: number = Date.now();
    let heartbeatSeen = false;
    let readyAt: number | undefined;
    let containerBootstrapMs: number | undefined;

    const settle = (output: string) => {
      if (resolved) return;
      resolved = true;
      resolve({
        output,
        metrics: {
          containerColdStartMs: readyAt ? readyAt - startedAt : undefined,
          containerBootstrapMs,
          containerRuntimeMs: Date.now() - startedAt,
          heartbeatSupported: heartbeatSeen,
        },
      });
    };

    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
      const lines = stderrBuffer.split("\n");
      stderrBuffer = lines.pop() ?? "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        const diagnostic = parseContainerDiagnosticLine(line);
        if (diagnostic?.type === "heartbeat") {
          lastHeartbeatAt = Date.now();
          heartbeatSeen = true;
          continue;
        }
        if (diagnostic?.type === "ready") {
          readyAt ??= Date.now();
          if (diagnostic.bootstrapMs !== undefined) {
            containerBootstrapMs = diagnostic.bootstrapMs;
          }
          continue;
        }
        if (line) {
          stderr += line + "\n";
        }
      }
    });

    const cleanup = () => {
      proc.stdout.removeAllListeners();
      proc.stderr.removeAllListeners();
      clearTimeout(heartbeatWarmupHandle);
      clearInterval(heartbeatWatchdogInterval);
      clearTimeout(timeoutHandle);
    };

    // Hard timeout — SIGTERM then SIGKILL
    const timeoutHandle = setTimeout(() => {
      log.warn({ agentName: opts.agentName, timeoutMs }, "Container hard timeout reached");
      cleanup();
      gracefulKill(proc.pid, proc);
      const partial = recoverPartialOutput(stdout);
      settle(`Sub-agent '${opts.agentName}' timed out after ${timeoutMs}ms.${partial ? ` Partial: ${partial}` : ""}`);
    }, timeoutMs);

    // Heartbeat watchdog — starts after warmup so slow-starting containers aren't penalised
    let heartbeatWatchdogInterval: ReturnType<typeof setInterval>;
    const heartbeatWarmupHandle = setTimeout(() => {
      heartbeatWatchdogInterval = setInterval(() => {
        if (!heartbeatSeen) return; // container may be too old to support heartbeats
        const staleMs = Date.now() - lastHeartbeatAt;
        if (staleMs > HEARTBEAT_TIMEOUT_MS) {
          log.warn(
            { agentName: opts.agentName, staleMs },
            "Container heartbeat lost — treating as stuck",
          );
          cleanup();
          gracefulKill(proc.pid, proc);
          emitSwarmEvent("task_requeued", {
            sessionId: opts.parentSessionId,
            agentName: opts.agentName,
            task: opts.task,
            data: { reason: "heartbeat_lost", staleMs },
          });
          const partial = recoverPartialOutput(stdout);
          settle(
            `Sub-agent '${opts.agentName}' stopped responding (no heartbeat for ${Math.round(staleMs / 1000)}s).` +
            (partial ? ` Partial: ${partial}` : ""),
          );
        }
      }, 10_000);
      heartbeatWatchdogInterval.unref();
    }, HEARTBEAT_WARMUP_MS);
    heartbeatWarmupHandle.unref();

    proc.on("close", (code) => {
      cleanup();

      const trailingDiagnostic = parseContainerDiagnosticLine(stderrBuffer.trim());
      if (trailingDiagnostic?.type === "ready") {
        readyAt ??= Date.now();
        if (trailingDiagnostic.bootstrapMs !== undefined) {
          containerBootstrapMs = trailingDiagnostic.bootstrapMs;
        }
      } else if (trailingDiagnostic?.type === "heartbeat") {
        heartbeatSeen = true;
        lastHeartbeatAt = Date.now();
      } else if (stderrBuffer.trim()) {
        stderr += stderrBuffer.trim() + "\n";
      }
      stderrBuffer = "";

      if (opts.signal?.aborted) {
        settle("Sub-agent task was cancelled");
        return;
      }

      if (stderr.trim()) {
        log.debug({ agentName: opts.agentName, stderr: stderr.slice(0, 500) }, "Container stderr");
      }

      // OOM kill: Docker sends SIGKILL → exit code 137; kernel OOM may also appear in stderr
      const oomInStderr = /oom.kill|out of memory|memory limit exceeded|killed/i.test(stderr);
      if (code === 137 || oomInStderr) {
        log.warn({ agentName: opts.agentName, code }, "Container likely OOM-killed");
        const partial = recoverPartialOutput(stdout);
        settle(
          `Sub-agent '${opts.agentName}' was killed (likely OOM, exit ${code}).` +
          (partial ? ` Partial: ${partial}` : ""),
        );
        return;
      }

      const lastLine = stdout.trim().split("\n").pop() ?? "";
      let taskResult: ContainerTaskResult;
      try {
        taskResult = JSON.parse(lastLine) as ContainerTaskResult;
      } catch {
        // Non-zero exit with no valid JSON — try to recover partial output
        const partial = recoverPartialOutput(stdout);
        log.error({ agentName: opts.agentName, code, stdout: stdout.slice(0, 500) }, "Container output parse failed");
        settle(
          `Sub-agent '${opts.agentName}' exited with code ${code}.` +
          (partial ? ` Partial: ${partial}` : ` Output: ${stdout.slice(0, 300)}`),
        );
        return;
      }

      if (taskResult.success && taskResult.result) {
        settle(taskResult.result);
      } else {
        settle(`Sub-agent '${opts.agentName}' container error: ${taskResult.error ?? "unknown"}`);
      }
    });

    proc.on("error", (err) => {
      cleanup();
      log.error({ err, agentName: opts.agentName }, "Failed to spawn container");
      settle(`Failed to spawn sub-agent container: ${err.message}`);
    });

    // Write task payload to stdin then close it so the entrypoint knows to start
    const json = JSON.stringify(payload);
    try {
      proc.stdin.write(json);
      proc.stdin.end();
    } catch (err) {
      log.warn({ err, agentName: opts.agentName }, "Failed to write to container stdin (process may have exited early)");
    }

    // Handle parent abort — SIGTERM the container so it can flush partial output
    const onAbort = () => {
      cleanup();
      gracefulKill(proc.pid, proc);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    proc.on("close", () => {
      opts.signal?.removeEventListener("abort", onAbort);
    });
  });
}

export function parseContainerDiagnosticLine(line: string): ContainerDiagnosticEvent | null {
  if (!line) return null;
  if (line.startsWith("HEARTBEAT:")) {
    return { type: "heartbeat" };
  }
  if (line.startsWith("READY:")) {
    const rawValue = Number(line.slice("READY:".length));
    return Number.isFinite(rawValue) && rawValue >= 0
      ? { type: "ready", bootstrapMs: rawValue }
      : { type: "ready" };
  }
  return null;
}
