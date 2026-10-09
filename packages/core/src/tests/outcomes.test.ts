import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendOutcome, formatOutcomesForPrompt } from "../agent/outcomes.js";

describe("outcome prompt formatting", () => {
  const dirs: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("omits one-off ephemeral task residue from the main prompt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-05T22:00:00.000Z"));

    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-outcomes-prompt-"));
    dirs.push(workspacePath);

    appendOutcome(workspacePath, {
      ts: "2026-04-05T21:55:00.000Z",
      agent: "ephemeral:dresden_temp_chart_generator",
      task: "Show a chart of the average temperature of each month last year in Dresden, Germany.",
      outcome: "partial",
      iterations: 5,
      totalTokens: 1200,
    });
    appendOutcome(workspacePath, {
      ts: "2026-04-05T21:56:00.000Z",
      agent: "data_analyst",
      task: "Gather monthly temperature data for Dresden, Germany.",
      outcome: "partial",
      iterations: 3,
      totalTokens: 800,
    });

    const promptSection = formatOutcomesForPrompt(workspacePath);

    expect(promptSection).toBe("");
  });

  it("keeps only recent repeated adverse outcomes for permanent agents", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-05T22:00:00.000Z"));

    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-outcomes-prompt-"));
    dirs.push(workspacePath);

    appendOutcome(workspacePath, {
      ts: "2026-04-05T20:30:00.000Z",
      agent: "researcher",
      task: "Old unrelated task",
      outcome: "failure",
      iterations: 2,
      totalTokens: 500,
    });
    appendOutcome(workspacePath, {
      ts: "2026-04-05T21:30:00.000Z",
      agent: "data_analyst",
      task: "Task A with user-specific context that should not leak",
      outcome: "partial",
      iterations: 3,
      totalTokens: 700,
    });
    appendOutcome(workspacePath, {
      ts: "2026-04-05T21:40:00.000Z",
      agent: "data_analyst",
      task: "Task B with more context that should not leak",
      outcome: "failure",
      iterations: 4,
      totalTokens: 900,
    });

    const promptSection = formatOutcomesForPrompt(workspacePath);

    expect(promptSection).toContain("## Recent Agent Performance");
    expect(promptSection).toContain("**data_analyst**: 1 failure(s), 1 partial(s) [0 success(es)]");
    expect(promptSection).not.toContain("Task A");
    expect(promptSection).not.toContain("Task B");
    expect(promptSection).not.toContain("researcher");
  });

  it("keeps the success count, so a few partials among many runs do not read as an agent that always fails", () => {
    // The note rides in the turn's tail since 2026-10-05, where a changing count costs nothing.
    // Without the successes, 2 partials of 27 runs read like 2 of 2 under "prefer an alternative".
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-05T22:00:00.000Z"));

    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-outcomes-prompt-"));
    dirs.push(workspacePath);

    const runs = 27;
    for (let i = 0; i < runs; i += 1) {
      const ts = new Date(Date.parse("2026-04-05T21:00:00.000Z") + i * 60_000).toISOString();
      appendOutcome(workspacePath, { ts, agent: "researcher", task: `t${i}`, outcome: i < 2 ? "partial" : "success", iterations: 1, totalTokens: 10 });
    }

    expect(formatOutcomesForPrompt(workspacePath)).toContain("**researcher**: 0 failure(s), 2 partial(s) [25 success(es)]");
  });
});