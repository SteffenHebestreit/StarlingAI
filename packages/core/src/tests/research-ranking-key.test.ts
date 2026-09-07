import { beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig } from "../config/loader.js";

/**
 * THE RANKING IS THE ROUTER (live session 00b3675d, 2026-09-07).
 *
 * The user asked, four times across two hours, for current pricing and plan comparisons.
 * Every one of those turns was classified source-sensitive, and every one was handed to
 * `paper_author` at high confidence (topResultScore 0.845-0.866). The model itself named no
 * agent on any of them — each `delegate_to_agent` call arrived without an agentName and the
 * runtime filled in `search_agents`' top result (four `tool_call_recovered` rows, reason
 * "reuse_search_agents_top_result"). So `preferResearchCapableCandidates` is not a hint here;
 * it decides.
 *
 * paper_author holds `delegate_to_agent`, and `agentCfgIsResearchCapable` credits any holder
 * of a COORDINATION tool as research-capable. That is right for a coordinator and wrong for a
 * writer whose own description says it drafts "from an already-collected evidence ledger" and
 * is "distinct from researcher". Credited, it topped the ranking, and its sub-sessions made
 * 0 web_search and 0 web_fetch calls — on three of the four, 0 delegate_to_agent calls as
 * well. All four reported `delegationOutcome: "success"`. Three pricing reports were written
 * from model memory; one told the user a vendor they personally subscribe to has no
 * subscription plans.
 *
 * These tests drive the config-backed wrapper, not the pure reorder, because the fix is which
 * predicate that wrapper passes down. Shapes below are verbatim from the deployed shards.
 */
vi.mock("../config/loader.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../config/loader.js")>();
  const base = original.getConfig();
  return {
    ...original,
    getConfig: vi.fn(() => ({
      ...base,
      subAgents: {
        paper_author: {
          description: "Drafts FORMAL, source-grounded long-form documents from an already-collected evidence ledger.",
          tools: [
            "search_agents", "delegate_to_agent", "read_shared_facts", "read_file", "write_file",
            "edit_file", "generate_document", "generate_pdf", "generate_docx", "regex_test", "datetime_arithmetic",
          ],
        },
        researcher: {
          description: "Gathers and verifies information from the open web.",
          tools: ["web_search", "web_fetch", "url_inspect"],
        },
        content_writer: {
          description: "Marketing copy, blogs, websites, slide decks.",
          tools: ["generate_presentation", "generate_document", "write_file"],
        },
        mission_coordinator: {
          description: "Runs multi-area missions by fanning them out to specialists.",
          tools: ["delegate_to_agent", "parallel_delegate", "run_task_graph"],
        },
      },
    })),
  };
});

const { preferResearchCapableCandidates } = await import("../tools/agent-routing.js");
import type { AgentRoutingCandidate } from "../tools/agent-routing.js";

// The delegation task text the orchestrator actually built on those turns, trimmed.
const PRICING_TASK =
  "Research the current subscription plans and pricing for the major AI coding assistants and compare them. For each provider give the plan name, the monthly price, and the source URL.";

const rank = (...names: string[]): AgentRoutingCandidate[] =>
  names.map((name, i) => ({ name, score: 0.87 - i * 0.01 } as AgentRoutingCandidate));

describe("research ranking key — the writer must not outrank the gatherer", () => {
  beforeEach(() => vi.mocked(getConfig).mockClear());

  it("confirms the config shape that caused it: paper_author reads as capable", () => {
    // Not asserted as desirable — asserted so this test fails loudly if the shard changes
    // and this regression's premise quietly stops holding.
    const paperAuthorTools = getConfig().subAgents.paper_author?.tools ?? [];
    expect(paperAuthorTools).toContain("delegate_to_agent");
    expect(paperAuthorTools.some((t: string) => t.startsWith("web_"))).toBe(false);
  });

  it("puts the researcher above paper_author when both are ranked (turn T1)", () => {
    const out = preferResearchCapableCandidates(rank("paper_author", "researcher", "content_writer"), PRICING_TASK);
    expect(out[0]?.name).toBe("researcher");
    expect(out.map((r) => r.name)).toContain("paper_author"); // demoted, never dropped
    expect(out).toHaveLength(3);
  });

  it("surfaces the researcher when it was never ranked at all (turns T2/T4/T5)", () => {
    // The researcher did not appear in those three rankings, so demotion alone could not
    // have saved them — needsFallback has to prepend the specialist.
    const out = preferResearchCapableCandidates(rank("paper_author", "content_writer"), PRICING_TASK);
    expect(out[0]?.name).toBe("researcher");
    expect(out[0]?.score).toBeGreaterThan(0.72); // above the strong-match threshold
    expect(out.map((r) => r.name)).toEqual(["researcher", "paper_author", "content_writer"]);
  });

  it("a coordinator does not outrank the gatherer either, and is not removed", () => {
    const out = preferResearchCapableCandidates(rank("mission_coordinator", "researcher"), PRICING_TASK);
    expect(out.map((r) => r.name)).toEqual(["researcher", "mission_coordinator"]);
  });

  it("leaves a non-research query completely alone", () => {
    const set = rank("paper_author", "researcher");
    expect(preferResearchCapableCandidates(set, "Draft the paper from the notes we already collected")).toBe(set);
  });
});
