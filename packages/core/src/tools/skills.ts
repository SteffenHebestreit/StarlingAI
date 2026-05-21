/**
 * Skill Library tools — let agents discover and author reusable procedures.
 *
 *   search_skills  (Tier 0)  — find learned procedures relevant to a task
 *   list_skills    (Tier 0)  — enumerate the catalog and reliability stats
 *   record_skill   (Tier 1)  — author a new procedure from experience
 *
 * Skills are pure procedural guidance (markdown). They never grant tools or
 * weaken the guardrail stack — see skills/store.ts for the security contract.
 */

import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { getConfig } from "../config/loader.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";
import { searchSkills } from "../skills/service.js";
import {
  listSkills,
  writeSkill,
  skillSuccessRate,
  SkillCredentialError,
} from "../skills/store.js";

const log = childLogger("tool:skills");

function disabledResult(): ToolResult {
  return {
    success: false,
    output: "",
    error: "Skill Library is disabled. Set skillLibrary.enabled = true in config.",
  };
}

function toStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

// ── search_skills ─────────────────────────────────────────────────────────────

registerTool({
  name: "search_skills",
  description:
    "Search the Skill Library for reusable procedures learned from past work. Use before planning a "
    + "recurring task; returns step procedures, agents/tools, and success rates (guidance only).",
  embeddingDescription:
    "find a learned procedure, how-to, playbook, or recipe for a recurring task; reuse prior approach; "
    + "procedural memory; what worked before",
  costHint: "low",
  latencyHint: "low",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural-language description of the task or procedure you need.",
      },
      limit: {
        type: "number",
        description: "Maximum number of skills to return. Default: 4.",
      },
    },
    required: ["query"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!getConfig().skillLibrary.enabled) return disabledResult();
    const query = String(args["query"] ?? "").trim();
    if (!query) return { success: false, output: "", error: "query is required" };

    const limit = Math.max(1, Math.min(10, Number(args["limit"] ?? 4) || 4));
    const matches = await searchSkills(ctx.workspacePath, query, { limit });

    if (matches.length === 0) {
      return {
        success: true,
        output: `No learned skills matched "${query}". Plan the task directly; a skill may be distilled from this run if it succeeds.`,
        metadata: { skillMatches: [] },
      };
    }

    const blocks = matches.map((match) => {
      const { frontmatter, meta } = match.skill;
      const rate = meta.uses > 0 ? `${Math.round(skillSuccessRate(meta) * 100)}% over ${meta.uses} uses` : "untested";
      return [
        `**${frontmatter.name}** [${frontmatter.status}] (${rate}, score ${match.combinedScore.toFixed(2)})`,
        `When to use: ${frontmatter.whenToUse}`,
        frontmatter.agents.length > 0 ? `Agents: ${frontmatter.agents.join(", ")}` : "",
        frontmatter.tools.length > 0 ? `Tools: ${frontmatter.tools.join(", ")}` : "",
        "",
        match.skill.body,
      ].filter(Boolean).join("\n");
    });

    return {
      success: true,
      output: [`Learned skills for "${query}":`, "", ...blocks].join("\n\n"),
      metadata: {
        skillMatches: matches.map((match) => ({
          slug: match.skill.frontmatter.slug,
          name: match.skill.frontmatter.name,
          score: match.combinedScore,
          status: match.skill.frontmatter.status,
        })),
      },
    };
  },
});

// ── list_skills ───────────────────────────────────────────────────────────────

registerTool({
  name: "list_skills",
  description:
    "List skills in the Skill Library with their status and reliability stats. "
    + "Optionally filter by status (draft, active, archived).",
  costHint: "low",
  latencyHint: "low",
  parameters: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["draft", "active", "archived"],
        description: "Optional status filter.",
      },
    },
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!getConfig().skillLibrary.enabled) return disabledResult();
    const statusFilter = args["status"] ? String(args["status"]).trim() : undefined;

    const skills = listSkills(ctx.workspacePath, { includeArchived: true })
      .filter((skill) => !statusFilter || skill.frontmatter.status === statusFilter);

    if (skills.length === 0) {
      return {
        success: true,
        output: statusFilter ? `No skills with status "${statusFilter}".` : "No skills in the library yet.",
        metadata: { count: 0 },
      };
    }

    const lines = skills.map((skill) => {
      const { frontmatter, meta } = skill;
      const rate = meta.uses > 0 ? `${Math.round(skillSuccessRate(meta) * 100)}% / ${meta.uses}` : "untested";
      return `- **${frontmatter.name}** \`${frontmatter.slug}\` [${frontmatter.status} v${frontmatter.version}] (${rate}) — ${frontmatter.whenToUse}`;
    });

    return {
      success: true,
      output: `## Skill Library (${skills.length})\n\n${lines.join("\n")}`,
      metadata: { count: skills.length },
    };
  },
});

// ── record_skill ──────────────────────────────────────────────────────────────

registerTool({
  name: "record_skill",
  description:
    "Author a reusable procedure (skill) from experience so the swarm can reuse it later. "
    + "Call this after completing a non-trivial multi-step task that is likely to recur. "
    + "Capture the WHEN (trigger), the WHO (agents), and the step-by-step procedure plus pitfalls. "
    + "Do NOT include secrets — credential-shaped content is rejected. New skills start as drafts and "
    + "graduate to active after they succeed in real use.",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "Short human-readable title for the procedure." },
      description: { type: "string", description: "One-paragraph summary of what the procedure accomplishes." },
      whenToUse: { type: "string", description: "Trigger condition — when this procedure applies." },
      procedure: { type: "string", description: "Markdown body: the step-by-step procedure and pitfalls." },
      tags: { type: "array", items: { type: "string" }, description: "Optional topic tags." },
      agents: { type: "array", items: { type: "string" }, description: "Specialist sub-agents the procedure routes through." },
      tools: { type: "array", items: { type: "string" }, description: "Tools the procedure relies on (advisory only)." },
    },
    required: ["name", "description", "procedure"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!getConfig().skillLibrary.enabled) return disabledResult();

    const name = String(args["name"] ?? "").trim();
    const description = String(args["description"] ?? "").trim();
    const procedure = String(args["procedure"] ?? "").trim();
    const whenToUse = args["whenToUse"] ? String(args["whenToUse"]).trim() : undefined;

    if (!name || !description || !procedure) {
      return { success: false, output: "", error: "name, description, and procedure are required" };
    }
    if (procedure.length < 40) {
      return { success: false, output: "", error: "procedure too short — capture the actual steps and pitfalls" };
    }

    try {
      const skill = writeSkill(ctx.workspacePath, {
        name,
        description,
        whenToUse,
        procedure,
        tags: toStringList(args["tags"]),
        agents: toStringList(args["agents"]),
        tools: toStringList(args["tools"]),
        origin: "agent",
        sourceSessionId: ctx.sessionId,
      });

      logAudit("skill_authored", {
        slug: skill.frontmatter.slug,
        name: skill.frontmatter.name,
        version: skill.frontmatter.version,
        origin: skill.meta.origin,
        authoringAgent: ctx.currentAgentName ?? "orchestrator",
      }, { sessionId: ctx.sessionId, severity: "info" });

      log.info({ slug: skill.frontmatter.slug, version: skill.frontmatter.version }, "record_skill");

      return {
        success: true,
        output:
          `## Skill Recorded\n\n`
          + `**${skill.frontmatter.name}** \`${skill.frontmatter.slug}\` `
          + `[${skill.frontmatter.status} v${skill.frontmatter.version}]\n\n`
          + `It will surface in future planning when a task matches: ${skill.frontmatter.whenToUse}`,
        metadata: {
          slug: skill.frontmatter.slug,
          version: skill.frontmatter.version,
          status: skill.frontmatter.status,
        },
      };
    } catch (err) {
      if (err instanceof SkillCredentialError) {
        return { success: false, output: "", error: "Skill rejected: the procedure contains credential-shaped text. Remove secrets and retry." };
      }
      return {
        success: false,
        output: "",
        error: `Failed to record skill: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
