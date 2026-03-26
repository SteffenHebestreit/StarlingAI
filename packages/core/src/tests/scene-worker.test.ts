import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("scene job worker", () => {
  afterEach(async () => {
    try {
      const configLoader = await import("../config/loader.js");
      configLoader.resetConfigForTests();
    } catch {
      // ignore cleanup errors during module resets
    }

    try {
      const auth = await import("../gateway/auth.js");
      auth.resetAuthStateForTests();
    } catch {
      // ignore cleanup errors during module resets
    }

    try {
      const worker = await import("../agent/scene-worker.js");
      await worker.stopSceneJobWorker();
    } catch {
      // ignore cleanup errors during module resets
    }

    try {
      const jobs = await import("../agent/jobs.js");
      await jobs.resetJobsForTests();
    } catch {
      // ignore cleanup errors during module resets
    }

    try {
      const sessions = await import("../agent/session.js");
      for (const session of sessions.getAllSessions()) {
        sessions.endSession(session.id);
      }
    } catch {
      // ignore cleanup errors during module resets
    }

    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_JWT_SECRET"];
    delete process.env["SAI_MASTER_KEY"];
    delete process.env["SAI_CRED_STORE"];
    delete process.env["SAI_AUDIT_LOG"];
    delete process.env["DATABASE_URL"];

    vi.resetModules();
    vi.unmock("../agent/runtime.js");
  });

  it("executes queued scene jobs and records progress", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-scene-worker-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      gateway: {
        jwtSecret: "s".repeat(32),
        turnTimeoutMs: 30_000,
      },
      workspacePath: tempDir,
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;

    vi.doMock("../agent/runtime.js", () => ({
      runTurn: vi.fn(async (opts: Record<string, unknown>) => {
        const onToolCall = opts["onToolCall"] as ((name: string, args: Record<string, unknown>) => void) | undefined;
        const onToolResult = opts["onToolResult"] as ((name: string, result: string) => void) | undefined;

        onToolCall?.("web_search", { query: "latest release" });
        onToolResult?.("web_search", "ok");

        return {
          response: "done",
          toolCallsExecuted: 1,
          guardrailEvents: [],
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
          blocked: false,
        };
      }),
    }));

    try {
      const [{ createJob, getJob }, { runSceneJobWorkerTick }] = await Promise.all([
        import("../agent/jobs.js"),
        import("../agent/scene-worker.js"),
      ]);

      const job = await createJob({
        sceneName: "research_scene",
        userId: "scene:research_scene",
        task: "Find the current release status.",
        turnTimeoutMs: 30_000,
      });

      expect(job.status).toBe("queued");

      const started = await runSceneJobWorkerTick();
      expect(started).toBe(true);

      const completed = await waitForJobStatus(getJob, job.id, "completed");
      expect(completed.toolCallsExecuted).toBe(1);
      expect(completed.progress.toolCallsRequested).toBe(1);
      expect(completed.progress.toolCallsCompleted).toBe(1);
      expect(completed.progress.stage).toBe("completed");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("queues jobs via the gateway and supports cancellation", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-scene-cancel-"));
    const port = 23000 + Math.floor(Math.random() * 1000);
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      gateway: {
        port,
        jwtSecret: "t".repeat(32),
        turnTimeoutMs: 30_000,
      },
      workspacePath: tempDir,
      scenes: {
        slow_scene: {
          description: "Slow scene",
          task: "Keep working until cancelled.",
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    process.env["SAI_MASTER_KEY"] = "m".repeat(32);
    process.env["SAI_CRED_STORE"] = join(tempDir, ".starlingai", "credentials.enc");
    process.env["SAI_AUDIT_LOG"] = join(tempDir, ".starlingai", "audit.jsonl");

    vi.doMock("../agent/runtime.js", () => ({
      runTurn: vi.fn((opts: Record<string, unknown>) => {
        const signal = opts["signal"] as AbortSignal;
        return new Promise((_resolve, reject) => {
          if (signal.aborted) {
            reject(new Error("aborted"));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }),
    }));

    let gateway: { start: () => Promise<void>; stop: () => Promise<void> } | null = null;

    try {
      const configLoader = await import("../config/loader.js");

      configLoader.resetConfigForTests();
      configLoader.loadConfig();

      const [{ createGateway }, auth, worker] = await Promise.all([
        import("../gateway/index.js"),
        import("../gateway/auth.js"),
        import("../agent/scene-worker.js"),
      ]);

      gateway = createGateway();
      await gateway.start();
      await worker.startSceneJobWorker();

      const baseUrl = `http://127.0.0.1:${port}`;
      await waitForHealth(`${baseUrl}/healthz`);
      const token = await auth.createToken("admin", { role: "admin" });

      const runResponse = await fetch(`${baseUrl}/api/scenes/slow_scene/run`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ params: {} }),
      });
      expect(runResponse.status).toBe(200);

      const runBody = await runResponse.json() as { jobId: string; status: string };
      expect(runBody.status).toBe("queued");

      await waitForApiJobStatus(baseUrl, token, runBody.jobId, "running");

      const cancelResponse = await fetch(`${baseUrl}/api/scenes/jobs/${runBody.jobId}/cancel`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });
      expect(cancelResponse.status).toBe(200);

      const cancelled = await waitForApiJobStatus(baseUrl, token, runBody.jobId, "cancelled");
      expect(cancelled.error).toContain("cancelled");
      expect(cancelled.progress.stage).toBe("cancelled");
    } finally {
      if (gateway) await gateway.stop();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // gateway still starting
    }

    await sleep(100);
  }

  throw new Error(`Gateway did not become ready: ${url}`);
}

async function waitForJobStatus(
  getJob: (id: string) => Promise<{ status: string; toolCallsExecuted?: number; progress: { stage: string; toolCallsRequested: number; toolCallsCompleted: number } } | undefined>,
  jobId: string,
  expectedStatus: string,
): Promise<{ status: string; toolCallsExecuted?: number; progress: { stage: string; toolCallsRequested: number; toolCallsCompleted: number } }> {
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const job = await getJob(jobId);
    if (job?.status === expectedStatus) return job;
    await sleep(50);
  }

  throw new Error(`Job ${jobId} did not reach ${expectedStatus}`);
}

async function waitForApiJobStatus(
  baseUrl: string,
  token: string,
  jobId: string,
  expectedStatus: string,
): Promise<{ status: string; error?: string; progress: { stage: string } }> {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/api/scenes/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.ok) {
      const job = await response.json() as { status: string; error?: string; progress: { stage: string } };
      if (job.status === expectedStatus) return job;
    }

    await sleep(100);
  }

  throw new Error(`Job ${jobId} did not reach ${expectedStatus}`);
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}