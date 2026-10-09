/**
 * With the 15 specialists now running in-process (2026-10-09 decision), they are subject to the
 * in-process leaf run deadline — 60 s at medium effort for an agent that declares no turnTimeoutMs
 * (agent/sub-agent.ts leafDefaultMs; config/schema.ts). A containerized run had no such deadline
 * before. The clear long-running cases — a shell build, a full test suite, nmap/nikto/sqlmap/hydra
 * pentest work, metasploit, and terraform/ansible/helm infra changes — declare a per-agent
 * turnTimeoutMs so the 60 s default does not guillotine them. The rest keep the effort-scaled
 * default and are an open item for E2E measurement, deliberately NOT given a budget here.
 *
 * Gate over the SHIPPED catalog, so it fails if one of these declarations is dropped (revert
 * proof) and documents which agents were intentionally left at the default.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CATALOG_PATH = join(REPO_ROOT, "starlingai.json");

/** The clear long-running cases, with the budget each declares (ms). */
const DECLARED: Record<string, number> = {
  shell_agent: 300_000,
  qa_guard: 600_000,
  recon_agent: 600_000,
  web_auditor_agent: 900_000,
  network_auditor_agent: 900_000,
  exploit_agent: 600_000,
  infrastructure_agent: 900_000,
  tool_developer: 360_000, // pre-existing; asserted so a sweep cannot silently drop it
};

/** The other in-process specialists, deliberately left at the effort-scaled default (open item). */
const LEFT_AT_DEFAULT = [
  "git_developer", "ops_triage", "notification_agent",
  "report_writer_agent", "pentest_qa_validator", "api_integrator", "sql_specialist",
];

type Agent = { turnTimeoutMs?: number | "unbound" };

function loadAgents(): Record<string, Agent> {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as { subAgents?: Record<string, Agent> };
  const agents = catalog.subAgents ?? {};
  expect(Object.keys(agents).length).toBeGreaterThanOrEqual(40);
  return agents;
}

describe("per-agent run deadlines for the in-process specialists", () => {
  it("declares a turnTimeoutMs for every clear long-running case", () => {
    const agents = loadAgents();
    for (const [name, ms] of Object.entries(DECLARED)) {
      expect(agents[name], `${name} missing from the catalog`).toBeDefined();
      expect(agents[name]!.turnTimeoutMs, `${name} must declare turnTimeoutMs ${ms}`).toBe(ms);
    }
  });

  it("leaves the remaining specialists at the effort-scaled default (open item)", () => {
    const agents = loadAgents();
    for (const name of LEFT_AT_DEFAULT) {
      expect(agents[name], `${name} missing from the catalog`).toBeDefined();
      expect(agents[name]!.turnTimeoutMs, `${name} is intentionally left at the default`).toBeUndefined();
    }
  });
});
