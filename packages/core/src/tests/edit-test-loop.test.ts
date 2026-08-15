import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import JSON5 from "json5";

/**
 * The generate → test → fix-in-place → test loop.
 *
 * Before this, edit_file was granted to ZERO agents: nine could run code and tests,
 * none could make a surgical edit. So the only way to change a file was write_file —
 * re-emitting the whole thing — which is what exhausts the completion budget on long
 * code turns and truncates the result. The loop could not close inside one agent.
 */
// Read the committed workspace SHARDS, not the generated starlingai.json — that file
// is gitignored, so it does not exist in CI and a test depending on it fails there
// while passing locally. Mirrors workspace-catalog.test.ts.
const agentsDir = fileURLToPath(new URL("../../../../workspace/agents/", import.meta.url));
type Agent = { tools?: string[]; systemPrompt?: string };
const config: { subAgents: Record<string, Agent> } = { subAgents: {} };
for (const file of readdirSync(agentsDir)) {
  if (!file.endsWith(".jsonc")) continue;
  const shard = JSON5.parse<{ subAgents?: Record<string, Agent> }>(readFileSync(join(agentsDir, file), "utf-8"));
  Object.assign(config.subAgents, shard.subAgents ?? {});
}
const VERIFY = ["run_test_suite", "shell_exec", "run_script", "verify_app"];
const tools = (n: string): string[] => config.subAgents[n]?.tools ?? [];

describe("edit-test-fix loop", () => {
  it("the builders can BOTH edit in place and verify", () => {
    for (const agent of ["coder", "web_coder", "backend_coder", "qa_guard"]) {
      expect(tools(agent), `${agent} must edit in place`).toContain("edit_file");
      expect(tools(agent).some((t) => VERIFY.includes(t)), `${agent} must be able to verify`).toBe(true);
    }
  });

  it("an agent that can edit can also LOCATE the span to edit", () => {
    // edit_file needs a unique old_string; grep_files with context is how you find one.
    for (const agent of ["coder", "web_coder", "backend_coder", "qa_guard"]) {
      expect(tools(agent), `${agent} needs grep_files to anchor an edit`).toContain("grep_files");
    }
  });

  it("every agent that can write a file can also edit one", () => {
    const writeOnly = Object.entries(config.subAgents)
      .filter(([, a]) => (a.tools ?? []).includes("write_file") && !(a.tools ?? []).includes("edit_file"))
      .map(([n]) => n);
    // Otherwise its only way to fix a file is to re-emit all of it.
    expect(writeOnly).toEqual([]);
  });

  it("the builders are told to edit rather than re-emit", () => {
    for (const agent of ["coder", "web_coder", "backend_coder", "qa_guard"]) {
      expect(config.subAgents[agent]?.systemPrompt ?? "", agent).toContain("FIX BY EDITING");
    }
  });
});
