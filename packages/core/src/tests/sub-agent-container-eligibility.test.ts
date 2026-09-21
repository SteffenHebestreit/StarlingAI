/**
 * An agent whose tools need the gateway must not be sent to a container.
 *
 * The agent-worker container runs with `--network none` unless its agent name is on a
 * hardcoded allowlist, and it receives no gateway config — only the workspace mount and a
 * task payload on stdin. A tool that resolves an external endpoint from `multimodal.*`
 * config therefore fails twice over inside it: the config is absent, and the host it would
 * name is unreachable.
 *
 * The failure is invisible from outside. Live, `image_creator` was delegated a sunrise
 * image twice, ran 15.6s each time, and came back as "exited with code 1. Output:" with
 * nothing after it. Routing had picked it correctly at 0.92 both times. The turn ended by
 * telling the user to go and use DALL-E instead.
 *
 * So these tests run against the REAL catalog, not a fixture: the point is to notice when
 * an agent gains such a tool, not to re-state the rule.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { requiresInProcessExecution } from "../agent/sub-agent.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CATALOG_PATH = join(REPO_ROOT, "starlingai.json");

/** Tools that reach a configured external service through gateway-filled config. */
const GATEWAY_BOUND = ["generate_image", "analyze_image", "synthesize_speech", "transcribe_audio", "list_tts_voices"];

type Agent = { tools?: string[] };

function loadAgents(): Record<string, Agent> {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as { subAgents?: Record<string, Agent> };
  const agents = catalog.subAgents ?? {};
  // Under vitest a bare getConfig() resolves a stub declaring ZERO agents, and a gate that
  // ran against that would pass by having nothing to check.
  expect(Object.keys(agents).length).toBeGreaterThanOrEqual(40);
  return agents;
}

describe("container eligibility in the real catalog", () => {
  it("keeps every agent with a gateway-bound service tool OUT of a container", () => {
    const agents = loadAgents();
    const wrong: string[] = [];
    for (const [name, cfg] of Object.entries(agents)) {
      const bound = (cfg.tools ?? []).filter((t) => GATEWAY_BOUND.includes(t));
      if (bound.length > 0 && !requiresInProcessExecution(cfg.tools)) {
        wrong.push(`${name} (${bound.join(", ")})`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("covers image_creator specifically — the agent that failed live", () => {
    const agents = loadAgents();
    const imageCreator = agents["image_creator"];
    expect(imageCreator, "image_creator missing from the catalog").toBeDefined();
    expect(imageCreator!.tools ?? []).toContain("generate_image");
    expect(requiresInProcessExecution(imageCreator!.tools)).toBe(true);
  });

  it("does NOT force everything in-process — the control that keeps the rule meaningful", () => {
    // Without this, a predicate that returned true unconditionally would satisfy both cases
    // above while silently ending containerized execution for the whole swarm.
    const agents = loadAgents();
    const stillContainerizable = Object.entries(agents)
      .filter(([, cfg]) => !requiresInProcessExecution(cfg.tools))
      .map(([name]) => name);
    expect(stillContainerizable.length).toBeGreaterThan(5);
    // shell_agent is the clearest case: containerizing it is a real security boundary, so
    // the rule must not drag it in-process as a side effect.
    expect(stillContainerizable).toContain("shell_agent");
  });

  it("still catches the prefix-matched families it caught before", () => {
    expect(requiresInProcessExecution(["read_file", "mail_list"])).toBe(true);
    expect(requiresInProcessExecution(["read_file", "mcp__code_sandbox__run_js"])).toBe(true);
    expect(requiresInProcessExecution(["read_file", "calendar_create_event"])).toBe(true);
    expect(requiresInProcessExecution(["read_file", "delegate_to_agent"])).toBe(true);
    // And a plain worker tool set is untouched.
    expect(requiresInProcessExecution(["read_file", "write_file", "shell_exec"])).toBe(false);
  });
});
