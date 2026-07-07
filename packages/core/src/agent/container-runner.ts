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
 *   --network none        unless the agent needs internet (researcher/source_verifier/browser_agent)
 *
 * Heartbeat protocol:
 *   The container entrypoint writes "HEARTBEAT:<ms>\n" to stderr every 15 s.
 *   The runner strips these lines from stderr and uses them to detect stuck containers.
 *   If heartbeats stop for HEARTBEAT_TIMEOUT_MS the container is killed and the task
 *   is returned as a recoverable failure so the delegation fallback chain can retry.
 */

import { spawn } from "node:child_process";
import { childLogger } from "../logger.js";
import { assertSafeDockerRunArgs } from "../tools/docker-safety.js";
import type { SubAgentRunOptions } from "./sub-agent.js";
import type { SubAgentConfig, ModelConfig } from "../config/schema.js";
import { emitSwarmEvent } from "../swarm/bus.js";
import { resolveDockerWorkspaceMountSource } from "../tools/workspace-mount.js";
import { logAudit } from "../audit/logger.js";

const log = childLogger("agent:container-runner");

// How often the entrypoint emits a heartbeat (ms).
const HEARTBEAT_INTERVAL_MS = 15_000;
// How long without a heartbeat before we treat the container as stuck.
const HEARTBEAT_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * 3; // 45 s
// Grace period before the watchdog starts — lets slow containers warm up.
const HEARTBEAT_WARMUP_MS = 20_000;
// How long to wait for graceful shutdown after SIGTERM before sending SIGKILL.
const GRACEFUL_SHUTDOWN_MS = 5_000;
// If the container is still producing meaningful output near the deadline,
// extend the hard timeout in short increments instead of killing active work.
const ACTIVE_OUTPUT_GRACE_MS = 10_000;
const MAX_ACTIVE_OUTPUT_TIMEOUT_EXTENSIONS = 12;

export interface ContainerTaskPayload {
  agentName: string;
  task: string;
  context?: string;
  parentSessionId: string;
  workspacePath: string;
  agentConfig: SubAgentConfig;
  resolvedModelConfig: ModelConfig;
  providerBaseUrl: string;
  providerApiKey: string;
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

export function shouldExtendContainerTimeoutForRecentOutput(
  lastMeaningfulOutputAt: number | undefined,
  now: number,
  extensionCount: number,
): boolean {
  return typeof lastMeaningfulOutputAt === "number"
    && now - lastMeaningfulOutputAt <= ACTIVE_OUTPUT_GRACE_MS
    && extensionCount < MAX_ACTIVE_OUTPUT_TIMEOUT_EXTENSIONS;
}

export type ContainerDiagnosticEvent =
  | { type: "heartbeat" }
  | { type: "ready"; bootstrapMs?: number };

// Tools that need internet access — these agents run with --network=bridge.
// Anything that calls http_request, web_search, web_fetch, or external HTTP
// endpoints (LM Studio probes, REST integrations, webhook tests) must be here
// or it will get --network=none and silently fail to reach any host.
const NEEDS_INTERNET = new Set([
  "researcher",
  "source_verifier",
  "browser_agent",
  "api_integrator",
  "citation_researcher",
  "vision_browser_analyst",
  "web_task_coordinator",
]);

/**
 * Patterns the Docker CLI emits when it cannot reach the daemon. Used to
 * distinguish "daemon is down" from normal container-side errors so the Warden
 * can raise a distinct alert operators act on differently.
 */
const DOCKER_UNREACHABLE_PATTERNS = /cannot connect to the docker daemon|is the docker daemon running|error response from daemon.*dial|docker daemon is not running|docker endpoint.*not found|error during connect: this error may indicate that the docker daemon/i;

/**
 * Rate-limit repeated unreachable-daemon alerts: if the daemon is down every
 * delegation will trip this path and we would otherwise flood the audit log.
 */
const DOCKER_UNREACHABLE_COOLDOWN_MS = 60_000;
let _lastDockerUnreachableAt = 0;

/** Test-only — reset the cooldown so successive tests can each observe the alert. */
export function resetDockerUnreachableCooldownForTests(): void {
  _lastDockerUnreachableAt = 0;
}

function reportDockerUnreachable(
  agentName: string,
  parentSessionId: string,
  errorMessage: string,
  source: "spawn_error" | "stderr",
): void {
  const now = Date.now();
  if (now - _lastDockerUnreachableAt < DOCKER_UNREACHABLE_COOLDOWN_MS) return;
  _lastDockerUnreachableAt = now;
  log.error({ agentName, source, errorMessage: errorMessage.slice(0, 500) },
    "Docker daemon appears unreachable during containerized delegation");
  logAudit(
    "docker_daemon_unreachable",
    {
      agentName,
      source,
      errorMessage: errorMessage.slice(0, 500),
    },
    { sessionId: parentSessionId, severity: "error" },
  );
}

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
  providerBaseUrl: string,
  providerApiKey: string,
): Promise<ContainerRunResult> {
  const container = agentCfg.container ?? {} as NonNullable<SubAgentConfig["container"]>;
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
    providerBaseUrl,
    providerApiKey,
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
    "-v", `${resolveDockerWorkspaceMountSource(opts.workspacePath)}:${opts.workspacePath}`,
    "--interactive",
    image,
  ];

  log.info({ agentName: opts.agentName, image, memoryMb, cpus, network }, "Spawning sub-agent container");

  const startedAt = Date.now();

  return new Promise((resolve) => {
    // Defense-in-depth: never spawn a sub-agent container with escape-shaped flags.
    try {
      assertSafeDockerRunArgs(dockerArgs, "sub-agent");
    } catch (err) {
      resolve({
        output: `Sub-agent container refused: ${err instanceof Error ? err.message : String(err)}`,
        metrics: { containerRuntimeMs: 0, heartbeatSupported: false },
      });
      return;
    }
    const proc = spawn("docker", dockerArgs, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stderrBuffer = "";
    let resolved = false;
    let lastMeaningfulOutputAt: number | undefined;
    let hardTimeoutExtensions = 0;

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

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (text.trim()) {
        lastMeaningfulOutputAt = Date.now();
      }
    });

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
          lastMeaningfulOutputAt = Date.now();
          stderr += line + "\n";
        }
      }
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    const cleanup = () => {
      proc.stdout.removeAllListeners();
      proc.stderr.removeAllListeners();
      clearTimeout(heartbeatWarmupHandle);
      clearInterval(heartbeatWatchdogInterval);
      if (timeoutHandle) clearTimeout(timeoutHandle);
    };

    const armHardTimeout = (delayMs: number) => {
      timeoutHandle = setTimeout(() => {
        const now = Date.now();
        if (shouldExtendContainerTimeoutForRecentOutput(lastMeaningfulOutputAt, now, hardTimeoutExtensions)) {
          hardTimeoutExtensions += 1;
          log.info(
            {
              agentName: opts.agentName,
              timeoutMs,
              extensionCount: hardTimeoutExtensions,
              outputIdleMs: now - (lastMeaningfulOutputAt ?? now),
            },
            "Container hard timeout extended because output is still arriving",
          );
          armHardTimeout(ACTIVE_OUTPUT_GRACE_MS);
          return;
        }

        log.warn({ agentName: opts.agentName, timeoutMs, hardTimeoutExtensions }, "Container hard timeout reached");
        cleanup();
        gracefulKill(proc.pid, proc);
        const partial = recoverPartialOutput(stdout);
        // Include the stderr tail: a container that burns its whole budget with
        // no output usually died inside (provider unreachable, auth, crash) and
        // the bare "timed out" line hides the actual cause from the audit trail
        // (audit f0143008: api_integrator's container ran 60s and reported
        // nothing actionable).
        const errTail = stderr.trim().slice(-300);
        settle(
          `Sub-agent '${opts.agentName}' timed out after ${timeoutMs}ms.` +
          (partial ? ` Partial: ${partial}` : "") +
          (errTail ? ` Container stderr (tail): ${errTail}` : ""),
        );
      }, delayMs);
      timeoutHandle.unref?.();
    };

    // Hard timeout — SIGTERM then SIGKILL unless active output keeps arriving.
    armHardTimeout(timeoutMs);

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
          const errTail = stderr.trim().slice(-300);
          settle(
            `Sub-agent '${opts.agentName}' stopped responding (no heartbeat for ${Math.round(staleMs / 1000)}s).` +
            (partial ? ` Partial: ${partial}` : "") +
            (errTail ? ` Container stderr (tail): ${errTail}` : ""),
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
        if (DOCKER_UNREACHABLE_PATTERNS.test(stderr)) {
          reportDockerUnreachable(opts.agentName, opts.parentSessionId, stderr, "stderr");
        }
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
      const errWithCode = err as NodeJS.ErrnoException;
      if (errWithCode.code === "ENOENT" || DOCKER_UNREACHABLE_PATTERNS.test(err.message)) {
        reportDockerUnreachable(opts.agentName, opts.parentSessionId, err.message, "spawn_error");
      }
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

    // Remove the abort listener when the process exits to prevent memory leaks
    proc.on("close", () => {
      opts.signal?.removeEventListener("abort", onAbort);
    });
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

export interface DockerReachability {
  reachable: boolean;
  /** docker server version reported by `docker version --format`. Present only when reachable. */
  serverVersion?: string;
  /** Captured stderr / spawn error message when unreachable. */
  error?: string;
  /** Time taken by the probe in ms. */
  durationMs: number;
}

/**
 * Probe whether Docker is reachable from this process. Used at gateway startup
 * when `agents.defaultContainerized` is enabled — if Docker is down, we want to
 * abort loud rather than silently fall back to in-process execution and lose
 * the isolation guarantee that operators are relying on.
 *
 * Pure read-only — runs `docker version --format '{{.Server.Version}}'` with a
 * short timeout. Never spawns a container.
 */
export async function probeDockerReachability(timeoutMs = 5000): Promise<DockerReachability> {
  const start = Date.now();
  return new Promise<DockerReachability>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (result: DockerReachability) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn("docker", ["version", "--format", "{{.Server.Version}}"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      settle({ reachable: false, error: `docker spawn failed: ${message}`, durationMs: Date.now() - start });
      return;
    }

    const killTimer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      settle({ reachable: false, error: `docker probe timed out after ${timeoutMs}ms`, durationMs: Date.now() - start });
    }, timeoutMs);
    killTimer.unref?.();

    proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    proc.on("error", (err) => {
      clearTimeout(killTimer);
      settle({ reachable: false, error: `docker spawn error: ${err.message}`, durationMs: Date.now() - start });
    });
    proc.on("close", (code) => {
      clearTimeout(killTimer);
      const durationMs = Date.now() - start;
      const serverVersion = stdout.trim();
      if (code === 0 && serverVersion) {
        settle({ reachable: true, serverVersion, durationMs });
      } else {
        const errMsg = stderr.trim() || `docker exited with code ${code}`;
        settle({ reachable: false, error: errMsg, durationMs });
      }
    });
  });
}
