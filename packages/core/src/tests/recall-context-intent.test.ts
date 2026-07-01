import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Task-conditional retrieval scope: when the caller doesn't pin `include`,
 * recall_context derives the section order/budget from the detected intent via
 * the shared turn classifier. Uses real modules (no mocks) so the classifier
 * runs; subsystems return empty against a temp workspace, so we assert only the
 * chosen plan, surfaced as metadata.recallIntent — the new behavior.
 */
describe("recall_context task-conditional scope", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function ws(): string {
    const dir = mkdtempSync(join(tmpdir(), "starlingai-recall-intent-"));
    dirs.push(dir);
    return dir;
  }

  async function run(query: string, include?: string[]) {
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/recall-context.js");
    const tool = getTool("recall_context")!;
    const args: Record<string, unknown> = { query };
    if (include) args["include"] = include;
    return tool.execute(args, { sessionId: "recall-intent-test", workspacePath: ws() });
  }

  // De-lexicalization (cleanup/lean-base): deriveRecallPlan's "research" and
  // "maintenance" branches key on buildDynamicTurnGuidance's sourceSensitive /
  // freshnessSensitive / swarmMaintenanceSensitive flags, which the de-lex made
  // default OFF. Those two plans are therefore unreachable now (every non-explicit
  // query resolves to "general"), so the two tests that asserted the research /
  // maintenance recall plans were removed. The "general" and "explicit" plans below
  // still exercise the surviving structural behavior.

  it("falls back to the general plan for an ordinary query", async () => {
    const r = await run("what should we cook for dinner tonight");
    expect(r.success).toBe(true);
    expect(r.metadata?.["recallIntent"]).toBe("general");
  });

  it("respects an explicit include and reports the explicit plan", async () => {
    const r = await run("search online and validate the latest info", ["user", "memory"]);
    expect(r.success).toBe(true);
    expect(r.metadata?.["recallIntent"]).toBe("explicit");
  });
});
