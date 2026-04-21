import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendFlowMemoryEntry,
  formatFlowMemoryGuidance,
  readFlowMemoryEntries,
  searchFlowMemory,
} from "../agent/flow-memory.js";

describe("flow memory", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stores and searches configuration flow outcomes", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "starlingai-flow-memory-"));
    dirs.push(workspacePath);

    appendFlowMemoryEntry(workspacePath, {
      ts: "2026-03-28T10:00:00.000Z",
      scope: "prompt",
      request: "Improve browser agent convergence on JS-heavy pages",
      summary: "Routing browser evidence to the vision analyst stopped repetitive browser retries",
      assistantAgent: "prompt_optimizer",
      targetAgent: "browser_agent",
      actions: ["delegate browser evidence to vision_browser_analyst"],
      outcome: "success",
      lesson: "Prefer evidence handoff once the needed text is visible.",
      tags: ["browser", "prompt"],
    });
    appendFlowMemoryEntry(workspacePath, {
      ts: "2026-03-29T10:00:00.000Z",
      scope: "enhancement",
      request: "Make browser agent more persistent",
      summary: "Blindly retrying clicks on a stable page caused loops",
      assistantAgent: "ops_triage",
      targetAgent: "browser_agent",
      actions: ["avoid repetitive click loops"],
      outcome: "failure",
      lesson: "Stable page state is a stop signal, not a retry signal.",
      tags: ["browser", "loops"],
    });

    const entries = readFlowMemoryEntries(workspacePath, 10);
    expect(entries).toHaveLength(2);

    const matches = searchFlowMemory(workspacePath, "browser loops evidence", {
      targetAgent: "browser_agent",
      limit: 2,
    });
    expect(matches).toHaveLength(2);
    expect(matches[0]?.summary).toContain("Routing browser evidence");

    const guidance = formatFlowMemoryGuidance(workspacePath, "browser evidence loops", {
      targetAgent: "browser_agent",
      limit: 2,
    });
    expect(guidance).toContain("Learned Flow Guidance");
    expect(guidance).toContain("Prefer [target=browser_agent]");
    expect(guidance).toContain("Avoid [target=browser_agent]");
  });
});