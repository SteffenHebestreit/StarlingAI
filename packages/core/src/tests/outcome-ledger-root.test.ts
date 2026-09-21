/**
 * The turn prompt must read the agent-outcome ledger from the root it is WRITTEN to.
 *
 * Every writer uses the deployment root — `appendOutcome(getConfig().workspacePath, …)` in
 * sub-agent.ts (twice), warden.ts (twice), tools/memory.ts and tools/sub-agent.ts. But a
 * Session's `workspacePath` is per-user (`userWorkspaceRoot(...)`, session.ts:224) whenever
 * auth is on, and the base prompt ended with `formatOutcomesForPrompt(workspacePath)`.
 *
 * So for every signed-in user the "Recent Agent Performance" block read a directory nothing
 * ever writes and came back empty — the guidance was silently inert, which is precisely the
 * failure `deploymentWorkspaceRoot`'s own doc comment warns about: "an agent's lessons
 * simply stop appearing". memory/service.ts:915 already maps the root back for the same
 * reason; this is the other read site, which did not.
 *
 * It also mattered to the prompt cache. The warm-keeper runs with no ambient user and so
 * built its prompt from the deployment root, while an authenticated turn built it from the
 * per-user root. Once the ledger held two adverse outcomes inside the 6h window the two
 * prompts differed on the LAST line of the base — ahead of the ~9.2k-token tool block — so
 * the warm stopped buying the thing it exists to buy. Reading one root fixes both.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deploymentWorkspaceRoot } from "../tools/workspace-path.js";
import { formatOutcomesForPrompt } from "../agent/outcomes.js";

let root: string | undefined;

/** A deployment root with a ledger, and the per-user root a signed-in session would use. */
function deployment(): { shared: string; perUser: string } {
  root = mkdtempSync(join(tmpdir(), "starlingai-outcome-root-"));
  const shared = root;
  const perUser = join(shared, "users", "steffen-67913ee9be1346dc");
  mkdirSync(join(shared, ".starlingai"), { recursive: true });
  mkdirSync(perUser, { recursive: true });

  // The reader parses `ts` with Date.parse and counts `outcome`, and it needs at least
  // PROMPT_MIN_ADVERSE_OUTCOMES of them inside the lookback window for a non-ephemeral
  // agent. Getting either field wrong makes every assertion below pass vacuously on "".
  const now = Date.now();
  const rows = [1, 2, 3].map((n) => JSON.stringify({
    ts: new Date(now - n * 1000).toISOString(),
    agent: "image_creator",
    task: `generate an image ${n}`,
    outcome: "failure",
    lesson: "the container exited before the model produced anything",
    durationMs: 15600,
  }));
  writeFileSync(join(shared, ".starlingai", "agent_outcomes.ndjson"), rows.join("\n") + "\n", "utf8");
  return { shared, perUser };
}

describe("the agent-outcome ledger root", () => {
  afterEach(() => {
    if (root) { rmSync(root, { recursive: true, force: true }); root = undefined; }
  });

  it("maps a per-user root back to the deployment root", () => {
    const { shared, perUser } = deployment();
    expect(deploymentWorkspaceRoot(perUser)).toBe(shared);
  });

  it("leaves a root that is NOT per-user untouched — the control", () => {
    // Without this, a mapper that always climbed two directories would satisfy the case
    // above while breaking every auth-off deployment.
    const { shared } = deployment();
    expect(deploymentWorkspaceRoot(shared)).toBe(shared);
  });

  it("finds the outcomes a signed-in session would otherwise miss", () => {
    const { shared, perUser } = deployment();

    // What the code did before: read the session's own per-user root.
    const beforeFix = formatOutcomesForPrompt(perUser);
    // What it does now.
    const afterFix = formatOutcomesForPrompt(deploymentWorkspaceRoot(perUser));

    expect(beforeFix, "the per-user root is where nothing is ever written").toBe("");
    expect(afterFix).not.toBe("");
    expect(afterFix).toContain("image_creator");
    // And it matches what a no-user caller (the warm-keeper) builds, which is the whole
    // point: one prompt, not two that diverge on the last line of the base.
    expect(afterFix).toBe(formatOutcomesForPrompt(shared));
  });
});
