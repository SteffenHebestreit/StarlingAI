/**
 * Run deadlines for the 15 in-process specialists (2026-10-09 decision).
 *
 * The earlier commit (fd422c13) gave seven of them a per-agent turnTimeoutMs, on the premise that an
 * undeclared in-process leaf gets "60 s at medium effort" and the 60 s default would guillotine a
 * long build / test suite / scan. Both halves of that premise are wrong, which is why those
 * declarations were counterproductive on the path these agents actually run:
 *
 *   - The leaf default is not 60 s. agent/sub-agent.ts leafDefaultMs is `effectiveSubAgentTurnSloMs()
 *     || 60_000`, and the shipped agents.performance.subAgentTurnSloMs is 240_000 (10-gateway.jsonc).
 *     60_000 is only the fallback when the config value is absent.
 *   - More importantly, the leaf default is NOT used on the orchestrator's delegate_to_agent path.
 *     The gateway sets turnTimeoutOverrideMs on every turn, tools/sub-agent.ts passes a positive
 *     delegationCeilingMs down as the child's caller ceiling, and resolveTurnBudgetMs then returns
 *     min(ceiling, declared) when the agent declares a number — and the ceiling alone when it does
 *     not. So a per-agent turnTimeoutMs can only SHORTEN a delegated specialist's budget below the
 *     ceiling it would otherwise inherit. qa_guard declaring 600_000 under a ~24 min delegation
 *     ceiling was cut to 10 min; shell_agent to 5. The knob worked against its own stated intent.
 *
 * So the seven declarations are dropped: on the delegation path an undeclared specialist inherits
 * the full caller ceiling, which is longer than any fixed cap. A per-agent budget would have to be a
 * FLOOR (min time guaranteed), not a fixed turnTimeoutMs that resolveTurnBudgetMs reads as a ceiling;
 * if the nested / no-override paths ever need one, it belongs there as a floor, not here as a cap.
 * tool_developer's pre-existing 360_000 is left untouched and pinned so a sweep cannot silently drop
 * it — the same reasoning applies to it, but changing a pre-existing declaration is out of scope.
 *
 * Two gates: the shipped catalog shape (revert proof — re-adding a declaration fails it), and the
 * resolution itself via resolveTurnBudgetMs, which is why a fixed cap was the wrong primitive.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTurnBudgetMs } from "../agent/sub-agent-turn-budget.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CATALOG_PATH = join(REPO_ROOT, "starlingai.json");

/** The clear long-running cases fd422c13 declared, now dropped: on the delegation path each inherits
 *  the caller ceiling instead, which is longer than the cap it used to carry. */
const DROPPED_DECLARATIONS = [
  "shell_agent", "qa_guard", "recon_agent",
  "web_auditor_agent", "network_auditor_agent", "exploit_agent", "infrastructure_agent",
];

/** Every other in-process specialist also runs at the inherited ceiling / effort-scaled default. */
const ALSO_NO_DECLARATION = [
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

describe("in-process specialist run deadlines", () => {
  it("leaves the long-running specialists with NO per-agent turnTimeoutMs cap", () => {
    const agents = loadAgents();
    for (const name of [...DROPPED_DECLARATIONS, ...ALSO_NO_DECLARATION]) {
      expect(agents[name], `${name} missing from the catalog`).toBeDefined();
      // A numeric cap here would only reduce the delegated budget below the inherited ceiling
      // (see the resolution gate below). "unbound" would be acceptable, a number is not.
      expect(
        typeof agents[name]!.turnTimeoutMs === "number",
        `${name} must not declare a numeric turnTimeoutMs cap — it only shortens the delegated budget`,
      ).toBe(false);
    }
  });

  it("keeps tool_developer's pre-existing budget (out of scope, pinned against a silent drop)", () => {
    const agents = loadAgents();
    expect(agents["tool_developer"]?.turnTimeoutMs).toBe(360_000);
  });

  it("resolves an undeclared leaf to the full caller ceiling, a declared cap only shorter", () => {
    // A delegated specialist 2 min into a 30 min turn is handed a ceiling of ~24 min.
    const ceiling = 1_440_000;
    // Undeclared: inherits the whole ceiling — longer than any of the dropped caps.
    expect(resolveTurnBudgetMs({ callerCeilingMs: ceiling, agentTurnTimeout: undefined })).toBe(ceiling);
    // Declared shorter: min() wins, so the cap REDUCES the budget — the regression the drop fixes.
    expect(resolveTurnBudgetMs({ callerCeilingMs: ceiling, agentTurnTimeout: 600_000 })).toBe(600_000);
    expect(resolveTurnBudgetMs({ callerCeilingMs: ceiling, agentTurnTimeout: 300_000 })).toBe(300_000);
    // Each dropped cap was strictly below the ceiling, so dropping it raises the budget.
    for (const cap of [300_000, 600_000, 900_000]) {
      expect(resolveTurnBudgetMs({ callerCeilingMs: ceiling, agentTurnTimeout: cap })).toBeLessThan(ceiling);
    }
  });
});
