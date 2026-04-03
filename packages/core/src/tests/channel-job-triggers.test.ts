import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("channel job triggers", () => {
  afterEach(async () => {
    try {
      const configLoader = await import("../config/loader.js");
      configLoader.resetConfigForTests();
    } catch {
      // ignore cleanup errors during module resets
    }

    try {
      const jobs = await import("../agent/jobs.js");
      await jobs.resetJobsForTests();
    } catch {
      // ignore cleanup errors during module resets
    }

    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["DATABASE_URL"];
    vi.resetModules();
    vi.unmock("../agent/jobs.js");
  });

  it("matches prefix triggers and parses key=value overrides from the remainder", async () => {
    const { matchChannelTrigger, parseChannelTriggerKeyValuePairs } = await import("../channels/job-triggers.js");

    const trigger = {
      type: "channel" as const,
      pattern: "/ops-brief",
      mode: "prefix" as const,
      ignoreCase: true,
      parseParams: true,
    };

    const match = matchChannelTrigger(trigger, {
      channel: "slack",
      senderId: "U123",
      text: '/OPS-BRIEF topic="prod incident" priority=high',
    });

    expect(match).toEqual({
      matched: true,
      remainder: 'topic="prod incident" priority=high',
    });
    expect(parseChannelTriggerKeyValuePairs(match.remainder ?? "")).toEqual({
      topic: "prod incident",
      priority: "high",
    });
  });

  it("queues the first matching channel-triggered job with contextual params", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-channel-job-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      gateway: {
        jwtSecret: "s".repeat(32),
        turnTimeoutMs: 30_000,
      },
      workspacePath: tempDir,
      scenes: {
        notify_scene: {
          description: "Notify ops",
          task: "Message: {{message}} Topic: {{topic|none}} Sender: {{senderId}}",
        },
      },
      jobs: {
        ops_brief: {
          description: "Run an ops brief from channel ingress",
          steps: [
            {
              scene: "notify_scene",
              params: {
                message: "{{message}}",
                topic: "{{topic}}",
                senderId: "{{senderId}}",
              },
            },
          ],
          triggers: [
            {
              type: "channel",
              channels: ["slack"],
              pattern: "/ops-brief",
              mode: "prefix",
              captureRemainderAs: "topic",
              parseParams: false,
              replyText: "Queued {{jobName}} for {{topic}} as {{jobId}}",
            },
          ],
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;

    const createJob = vi.fn(async (input: Record<string, unknown>) => ({
      id: "job-123",
      sessionId: "session-123",
      sceneName: String(input["sceneName"] ?? ""),
      definitionType: input["definitionType"],
      userId: input["userId"],
      status: "queued",
      createdAt: new Date().toISOString(),
      progress: {
        stage: "queued",
        toolCallsRequested: 0,
        toolCallsCompleted: 0,
        approvalsRequested: 0,
        subAgentsStarted: 0,
        swarmTasksTotal: 0,
        swarmTasksCompleted: 0,
        lastEventAt: new Date().toISOString(),
      },
    }));

    vi.doMock("../agent/jobs.js", () => ({
      createJob,
      resetJobsForTests: vi.fn(async () => undefined),
    }));

    try {
      const { dispatchChannelTriggeredJob } = await import("../channels/job-triggers.js");
      const result = await dispatchChannelTriggeredJob({
        channel: "slack",
        senderId: "U123",
        text: "/ops-brief production outage",
      });

      expect(result).toMatchObject({
        matched: true,
        jobName: "ops_brief",
        jobId: "job-123",
        responseText: "Queued ops_brief for production outage as job-123",
      });
      expect(createJob).toHaveBeenCalledTimes(1);
      expect(createJob).toHaveBeenCalledWith(expect.objectContaining({
        sceneName: "ops_brief",
        definitionType: "job",
        userId: "slack:U123",
        steps: [expect.objectContaining({
          sceneName: "notify_scene",
          task: "Message: /ops-brief production outage Topic: production outage Sender: U123",
        })],
        turnTimeoutMs: 30_000,
      }));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("supports silent channel triggers", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-channel-job-silent-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      gateway: {
        jwtSecret: "s".repeat(32),
        turnTimeoutMs: 30_000,
      },
      workspacePath: tempDir,
      scenes: {
        notify_scene: {
          description: "Notify ops",
          task: "Message: {{message}}",
        },
      },
      jobs: {
        quiet_brief: {
          description: "Run silently from channel ingress",
          steps: [
            {
              scene: "notify_scene",
              params: {
                message: "{{message}}",
              },
            },
          ],
          triggers: [
            {
              type: "channel",
              channels: ["slack"],
              pattern: "/quiet-brief",
              mode: "prefix",
              silent: true,
            },
          ],
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;

    const createJob = vi.fn(async () => ({
      id: "job-quiet",
      sessionId: "session-quiet",
      sceneName: "quiet_brief",
      definitionType: "job",
      userId: "slack:U123",
      status: "queued",
      createdAt: new Date().toISOString(),
      progress: {
        stage: "queued",
        toolCallsRequested: 0,
        toolCallsCompleted: 0,
        approvalsRequested: 0,
        subAgentsStarted: 0,
        swarmTasksTotal: 0,
        swarmTasksCompleted: 0,
        lastEventAt: new Date().toISOString(),
      },
    }));

    vi.doMock("../agent/jobs.js", () => ({
      createJob,
      resetJobsForTests: vi.fn(async () => undefined),
    }));

    try {
      const { dispatchChannelTriggeredJob } = await import("../channels/job-triggers.js");
      const result = await dispatchChannelTriggeredJob({
        channel: "slack",
        senderId: "U123",
        text: "/quiet-brief check this later",
      });

      expect(result).toMatchObject({
        matched: true,
        jobName: "quiet_brief",
        jobId: "job-quiet",
      });
      expect(result.responseText).toBeUndefined();
      expect(createJob).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});