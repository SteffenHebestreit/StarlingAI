/**
 * The 15 specialists that once resolved to the agent-worker container now run IN-PROCESS
 * (2026-10-09 user decision; the tool bridge was dropped because a worker under `--network none`
 * cannot reach the model either, so the container would only have held loop bookkeeping). This
 * gate runs against the SHIPPED catalog, not a fixture, so it notices if any agent that declares
 * tools regains the container dispatch path — the path that, since the worker image registers no
 * tool module, can only fail loud. It calls the runtime's own resolution predicate
 * (resolvesToContainerizedDispatch), so the rule and the gate cannot drift apart.
 *
 * It evaluates under agents.defaultContainerized = TRUE, the shipped production default
 * (config/schema.ts). The test harness can flip that default to false through an env override to
 * keep mock-LLM tests in-process, but this gate must use the production value: under a false
 * default nothing resolves to the container regardless of container.disabled, so reverting the
 * opt-out would not fail the test.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { requiresInProcessExecution, resolvesToContainerizedDispatch } from "../agent/sub-agent.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CATALOG_PATH = join(REPO_ROOT, "starlingai.json");

const PRODUCTION_DEFAULT_CONTAINERIZED = true;

/** The specialists the 2026-10-09 decision moved in-process. */
const IN_PROCESS_SPECIALISTS = [
  "git_developer", "shell_agent", "qa_guard", "recon_agent", "web_auditor_agent",
  "network_auditor_agent", "exploit_agent", "report_writer_agent", "pentest_qa_validator",
  "infrastructure_agent", "ops_triage", "notification_agent", "tool_developer",
  "api_integrator", "sql_specialist",
];

type Agent = { tools?: string[]; container?: { enabled?: boolean; disabled?: boolean } };

function loadAgents(): Record<string, Agent> {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as { subAgents?: Record<string, Agent> };
  const agents = catalog.subAgents ?? {};
  // Under a bare getConfig() stub vitest resolves ZERO agents; a gate over nothing would pass by
  // having nothing to check.
  expect(Object.keys(agents).length).toBeGreaterThanOrEqual(40);
  return agents;
}

describe("no shipped agent resolves to the container path", () => {
  it("every agent that declares tools runs in-process", () => {
    const agents = loadAgents();
    const containerized = Object.entries(agents)
      .filter(([, cfg]) => (cfg.tools?.length ?? 0) > 0)
      .filter(([, cfg]) => resolvesToContainerizedDispatch(cfg, PRODUCTION_DEFAULT_CONTAINERIZED))
      .map(([name]) => name);
    expect(containerized).toEqual([]);
  });

  it("covers the 15 specialists this decision moved in-process", () => {
    const agents = loadAgents();
    for (const name of IN_PROCESS_SPECIALISTS) {
      const cfg = agents[name];
      expect(cfg, `${name} missing from the catalog`).toBeDefined();
      expect((cfg!.tools?.length ?? 0), `${name} should declare tools`).toBeGreaterThan(0);
      expect(cfg!.container?.disabled, `${name} must set container.disabled`).toBe(true);
      expect(resolvesToContainerizedDispatch(cfg!, PRODUCTION_DEFAULT_CONTAINERIZED)).toBe(false);
    }
  });

  it("is discriminating: without container.disabled the same specialists resolve to the container", () => {
    // Proves the gate fails when the fix is reverted even if starlingai.json is NOT rebuilt first:
    // the container.disabled flag, not the predicate, is what keeps these agents in-process. If
    // this were vacuously true the first test could never catch a regression.
    const agents = loadAgents();
    const containerizedWithoutOptOut = Object.entries(agents)
      .filter(([, cfg]) => (cfg.tools?.length ?? 0) > 0)
      // Strip the container key, keep the tools: this is the pre-decision shape.
      .filter(([, cfg]) => resolvesToContainerizedDispatch({ tools: cfg.tools }, PRODUCTION_DEFAULT_CONTAINERIZED))
      .map(([name]) => name);
    for (const name of IN_PROCESS_SPECIALISTS) {
      expect(containerizedWithoutOptOut, `${name} must be one that the opt-out keeps in-process`).toContain(name);
    }
  });

  it("leaves the in-process-forcing tool rule intact (defaultContainerized stays on)", () => {
    // The opt-out is per-agent; the global default and the fail-loud predicate are unchanged, so a
    // future containerized-by-default agent with a gateway-bound tool is still forced in-process,
    // and one without is still eligible for the container (and its fail-loud path).
    expect(requiresInProcessExecution(["read_file", "generate_image"])).toBe(true);
    expect(resolvesToContainerizedDispatch({ tools: ["read_file", "generate_image"] }, true)).toBe(false);
    expect(resolvesToContainerizedDispatch({ tools: ["read_file", "write_file"] }, true)).toBe(true);
    expect(resolvesToContainerizedDispatch({ tools: ["read_file", "write_file"] }, false)).toBe(false);
  });
});
