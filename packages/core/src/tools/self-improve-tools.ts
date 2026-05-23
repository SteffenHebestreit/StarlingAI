/**
 * Self-Improvement Tools — agents use these to request new capabilities
 * and track the status of capability gaps.
 */
import { registerTool, getAllTools, type ToolContext, type ToolResult } from "./registry.js";
import {
  recordCapabilityGap,
  listCapabilityGaps,
  getCapabilityGap,
  buildToolProposalPrompt,
} from "../agent/self-improve.js";
import { getConfig } from "../config/loader.js";
import { validateWorkspaceConfig } from "../config/validate-workspace.js";
import { childLogger } from "../logger.js";

const log = childLogger("tool:self-improve");

// ── request_new_capability ──────────────────────────────────────────────────

registerTool({
  name: "request_new_capability",
  description:
    "Request development of a new tool to fill a capability gap. " +
    "Call this when you encounter a task that no existing tool can handle. " +
    "Provide a clear description of the missing capability, ideally with " +
    "an example input and expected output. " +
    "When enough similar failures are recorded, the system will propose " +
    "a new tool for sandbox development, testing, and human approval.",
  parameters: {
    type: "object",
    properties: {
      description: {
        type: "string",
        description:
          "Clear description of the missing capability. " +
          "What task were you trying to accomplish? What tool would have helped?",
      },
      exampleInput: {
        type: "string",
        description: "Optional: example input that the hypothetical tool would receive.",
      },
      exampleOutput: {
        type: "string",
        description: "Optional: example of what the tool should return.",
      },
    },
    required: ["description"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const config = getConfig();
    if (!config.selfImprovement.enabled) {
      return {
        success: false,
        output: "",
        error: "Self-improvement is disabled. Set selfImprovement.enabled = true in config.",
      };
    }

    const description = String(args["description"] ?? "").trim();
    const exampleInput = args["exampleInput"] ? String(args["exampleInput"]).trim() : undefined;
    const exampleOutput = args["exampleOutput"] ? String(args["exampleOutput"]).trim() : undefined;

    if (!description) {
      return { success: false, output: "", error: "description is required" };
    }
    if (description.length < 10) {
      return { success: false, output: "", error: "description too short — provide a clear explanation of the missing capability" };
    }

    try {
      const gap = await recordCapabilityGap({
        description,
        exampleInput,
        exampleOutput,
        sessionId: ctx.sessionId,
      });

      const threshold = config.selfImprovement.minFailuresBeforeProposal;
      const remaining = Math.max(0, threshold - gap.failureCount);

      let output =
        `## Capability Gap Recorded\n\n` +
        `**Gap ID:** ${gap.id}\n` +
        `**Status:** ${gap.status}\n` +
        `**Failure count:** ${gap.failureCount}\n`;

      if (gap.status === "detected" && remaining > 0) {
        output += `\n${remaining} more similar failure(s) needed before a tool proposal is triggered (threshold: ${threshold}).`;
      } else if (gap.status === "proposed") {
        output += `\nThreshold reached — a tool proposal has been queued for development.`;
      } else if (gap.status === "developing") {
        output += `\nA tool is already being developed for this gap (session: ${gap.devSessionId}).`;
      }

      log.info({ gapId: gap.id, status: gap.status, failureCount: gap.failureCount }, "request_new_capability");

      return {
        success: true,
        output,
        metadata: { gapId: gap.id, status: gap.status, failureCount: gap.failureCount },
      };
    } catch (err) {
      return {
        success: false,
        output: "",
        error: `Failed to record capability gap: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});

// ── list_capability_gaps ────────────────────────────────────────────────────

registerTool({
  name: "list_capability_gaps",
  description:
    "List all detected capability gaps and their current status. " +
    "Shows which gaps are being tracked, which have proposals in development, " +
    "and which tools have been deployed to fill them.",
  parameters: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["detected", "proposed", "developing", "submitted", "deployed", "rejected"],
        description: "Optional: filter by status.",
      },
    },
  },
  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const statusFilter = args["status"] ? String(args["status"]).trim() : undefined;

    let gaps = listCapabilityGaps();
    if (statusFilter) {
      gaps = gaps.filter((g) => g.status === statusFilter);
    }

    if (gaps.length === 0) {
      return {
        success: true,
        output: statusFilter
          ? `No capability gaps with status "${statusFilter}".`
          : "No capability gaps detected yet.",
        metadata: { count: 0 },
      };
    }

    // Sort: active first, then by failure count
    const statusOrder: Record<string, number> = {
      developing: 0, proposed: 1, submitted: 2, detected: 3, deployed: 4, rejected: 5,
    };
    gaps.sort((a, b) => (statusOrder[a.status] ?? 9) - (statusOrder[b.status] ?? 9) || b.failureCount - a.failureCount);

    const lines = gaps.map((g) => {
      let line = `### ${g.id}\n`;
      line += `**Status:** ${g.status} | **Failures:** ${g.failureCount} | **Detected:** ${g.detectedAt}\n`;
      line += `**Description:** ${g.description.slice(0, 200)}\n`;
      if (g.proposedToolName) line += `**Proposed tool:** \`selfdev__${g.proposedToolName}\`\n`;
      if (g.devSessionId) line += `**Dev session:** ${g.devSessionId}\n`;
      return line;
    });

    return {
      success: true,
      output: `## Capability Gaps (${gaps.length})\n\n${lines.join("\n")}`,
      metadata: { count: gaps.length },
    };
  },
});

// ── swarm_validate ──────────────────────────────────────────────────────────

registerTool({
  name: "swarm_validate",
  description:
    "Validate self-authored swarm configuration (scenes, jobs, and sub-agent definitions) " +
    "after editing the workspace shards. Re-reads config/ + workspace/ from disk, checks JSON " +
    "syntax, schema conformance, and reference integrity (scenes → agents, jobs → scenes, " +
    "agents → tools), and reports every problem. Run this BEFORE declaring a scene/job/agent " +
    "change complete — it is the config-side equivalent of running tests on new tool code. " +
    "Read-only: it never writes or applies anything.",
  embeddingDescription:
    "verify that a new or edited scene, job, workflow, or agent definition is valid; check swarm "
    + "config for broken references and schema errors before applying; test self-authored agents",
  costHint: "low",
  latencyHint: "low",
  parameters: { type: "object", properties: {} },
  async execute(_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const knownToolNames = new Set(getAllTools().map((handler) => handler.name));
    const result = validateWorkspaceConfig(ctx.workspacePath, knownToolNames);

    const { summary } = result;
    const inventory = `Inventory: ${summary.subAgents} agents, ${summary.scenes} scenes, ${summary.jobs} jobs.`;

    if (result.ok) {
      const warnBlock = result.warnings.length > 0
        ? `\n\n### Warnings (${result.warnings.length})\n` + result.warnings.map((w) => `- ${w}`).join("\n")
        : "";
      log.info({ ...summary, warnings: result.warnings.length }, "swarm_validate — passed");
      return {
        success: true,
        output:
          `## Swarm Config Valid ✓\n\n${inventory}\n\n`
          + `JSON syntax, schema, and all references check out.${warnBlock}\n\n`
          + `Apply the change with \`node scripts/sai.mjs config build\` (then reload).`,
        metadata: { ok: true, ...summary, warnings: result.warnings.length },
      };
    }

    const section = (title: string, items: string[]) =>
      items.length > 0 ? `### ${title} (${items.length})\n` + items.map((i) => `- ${i}`).join("\n") : "";

    const blocks = [
      section("Parse errors", result.parseErrors),
      section("Schema errors", result.schemaErrors),
      section("Reference errors", result.referenceErrors),
      section("Warnings", result.warnings),
    ].filter(Boolean);

    log.warn({
      parseErrors: result.parseErrors.length,
      schemaErrors: result.schemaErrors.length,
      referenceErrors: result.referenceErrors.length,
    }, "swarm_validate — failed");

    return {
      success: true, // the validation ran; the config is what failed
      output:
        `## Swarm Config INVALID ✗\n\n${inventory}\n\n`
        + `Fix every problem below, then run swarm_validate again. Do NOT report the change as `
        + `complete while these remain.\n\n`
        + blocks.join("\n\n"),
      metadata: {
        ok: false,
        parseErrors: result.parseErrors.length,
        schemaErrors: result.schemaErrors.length,
        referenceErrors: result.referenceErrors.length,
        warnings: result.warnings.length,
      },
    };
  },
});
