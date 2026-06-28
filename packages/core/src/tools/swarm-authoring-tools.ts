/**
 * Swarm self-authoring tools (capability co-development, roadmap P2).
 *
 * Give the swarm a STRUCTURED, VALIDATED, swarm_validate-gated path to durably persist a new
 * sub-agent / scene / job — and make it take effect live — without a maintainer hand-editing
 * workspace/**.jsonc shards and running `node scripts/sai.mjs config build`.
 *
 * Each tool does three things, in order, with a clean revert on any failure:
 *   1. zod-validate the single definition against the element schema (SubAgent/Scene/Job).
 *   2. Write the DURABLE shard into workspace/{agents,scenes,jobs}/ (the reproducible source of
 *      truth: version-controlled, swept by `config build`, survives a /data runtime-overlay wipe).
 *   3. Re-run the full cross-reference validator (validateWorkspaceConfig — scene→agent, job→scene)
 *      on the shards from disk; on any error REVERT the shard, then make the entry LIVE via
 *      updateConfig (runtime overlay). The overlay write trips the existing config-file watcher,
 *      which rebuilds the agent routing index (index.ts buildAgentIndex on a subAgents change) and
 *      re-syncs job/scene triggers — so a new agent becomes routable ~within the watch interval.
 *
 * Privileged: TWO_EXECUTE + per-call approval, granted only to the workspaceAccess:"full"
 * swarm_maintainer. They do NOT depend on the selfImprovement/toolDevelopment flags (config
 * authoring is not sandbox tool-dev) — a maintainer can author capabilities out of the box.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import type { ZodTypeAny } from "zod";
import { registerTool, getAllTools, type ToolContext, type ToolResult } from "./registry.js";
import { getConfig, updateConfig } from "../config/loader.js";
import { validateWorkspaceConfig } from "../config/validate-workspace.js";
import { SubAgentConfigSchema, SceneConfigSchema, JobConfigSchema } from "../config/schema.js";
import { logAudit } from "../audit/logger.js";
import { childLogger } from "../logger.js";

const log = childLogger("tool:swarm-authoring");

const NAME_RE = /^[a-z][a-z0-9_]*$/;

interface AuthorKind {
  /** Config map key the entry lives under (e.g. "subAgents"). */
  wrapper: "subAgents" | "scenes" | "jobs";
  /** workspace/ subdirectory the durable shard is written into. */
  subdir: "agents" | "scenes" | "jobs";
  /** Element schema the single definition is validated against. */
  schema: ZodTypeAny;
  /** Human label for messages/audit. */
  label: string;
}

/**
 * Author one swarm artifact: validate → write durable shard → cross-ref validate (revert on fail)
 * → apply live via the runtime overlay. All-or-nothing: a failure leaves nothing behind.
 */
function authorShard(kind: AuthorKind, args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const name = String(args["name"] ?? "").trim();
  const definition = args["definition"];
  const overwrite = args["overwrite"] === true;

  if (!NAME_RE.test(name)) {
    return reject(kind, name, `Invalid name "${name}". Use snake_case: start with a letter, then letters/digits/underscores.`);
  }
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    return reject(kind, name, `"definition" must be a ${kind.label} object.`);
  }

  // 1) Validate the single definition against its element schema BEFORE touching disk.
  const parsed = kind.schema.safeParse(definition);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).slice(0, 12);
    return reject(kind, name, `${kind.label} "${name}" failed schema validation:\n- ${issues.join("\n- ")}`);
  }

  // Guard against silently clobbering an existing (often built-in) entry.
  const existingInConfig = (getConfig() as unknown as Record<string, Record<string, unknown> | undefined>)[kind.wrapper];
  if (!overwrite && existingInConfig && name in existingInConfig) {
    return reject(kind, name, `A ${kind.label} named "${name}" already exists. Pass overwrite:true to replace it (this can shadow a built-in — be deliberate).`);
  }

  const workspacePath = getConfig().workspacePath;
  const shardPath = join(workspacePath, kind.subdir, `50-authored-${name}.jsonc`);
  const priorContent = existsSync(shardPath) ? readFileSync(shardPath, "utf8") : null;

  // 2) Write the durable shard. Store the ORIGINAL definition (no injected zod defaults) so the
  // shard stays clean + human-editable; the loader applies defaults when it reads.
  try {
    mkdirSync(dirname(shardPath), { recursive: true });
    const payload = { [kind.wrapper]: { [name]: definition } };
    writeFileSync(shardPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch (err) {
    return reject(kind, name, `Failed to write the shard: ${err instanceof Error ? err.message : String(err)}`);
  }

  const restoreShard = () => {
    try {
      if (priorContent !== null) writeFileSync(shardPath, priorContent, "utf8");
      else if (existsSync(shardPath)) unlinkSync(shardPath);
    } catch (err) {
      log.error({ err, shardPath }, "Failed to revert authored shard after a validation failure");
    }
  };

  // 3) Re-run the full cross-reference validator on the shards from disk (the swarm_validate gate).
  const knownToolNames = new Set(getAllTools().map((h) => h.name));
  const validation = validateWorkspaceConfig(workspacePath, knownToolNames);
  if (!validation.ok) {
    restoreShard();
    const blocks = [
      ...validation.parseErrors.map((e) => `parse: ${e}`),
      ...validation.schemaErrors.map((e) => `schema: ${e}`),
      ...validation.referenceErrors.map((e) => `reference: ${e}`),
    ].slice(0, 14);
    return reject(
      kind, name,
      `Writing ${kind.label} "${name}" would make the swarm config invalid (reverted, nothing applied):\n- ${blocks.join("\n- ")}`,
    );
  }

  // Apply live via the runtime overlay. This persists to the mutable overlay and the resulting
  // config-file change trips the watcher → agent index rebuild / trigger re-sync.
  try {
    updateConfig((raw) => {
      const map = (raw[kind.wrapper] ??= {}) as Record<string, unknown>;
      map[name] = definition;
    });
  } catch (err) {
    restoreShard();
    return reject(kind, name, `Applied validation passed but the live config reload failed (reverted): ${err instanceof Error ? err.message : String(err)}`);
  }

  logAudit("swarm_shard_authored", { kind: kind.wrapper, name, shardPath, overwrite, warnings: validation.warnings.length }, { sessionId: ctx.sessionId });
  log.info({ kind: kind.wrapper, name, shardPath }, "Authored swarm shard + applied live");

  const warnBlock = validation.warnings.length
    ? `\n\nWarnings (non-blocking):\n- ${validation.warnings.slice(0, 8).join("\n- ")}`
    : "";
  return {
    success: true,
    output:
      `## Authored ${kind.label} "${name}" ✓\n\n`
      + `Durable shard: workspace/${kind.subdir}/50-authored-${name}.jsonc (the reproducible source — survives a runtime wipe and is picked up by \`config build\`).\n`
      + `Applied live via the runtime overlay; it becomes routable within the config-watch interval (~a couple of seconds).${warnBlock}`,
    metadata: { kind: kind.wrapper, name, shardPath, applied: true, warnings: validation.warnings.length },
  };
}

function reject(kind: AuthorKind, name: string, reason: string): ToolResult {
  logAudit("swarm_shard_author_rejected", { kind: kind.wrapper, name, reason: reason.slice(0, 400) });
  return { success: false, output: "", error: reason };
}

const AGENT_KIND: AuthorKind = { wrapper: "subAgents", subdir: "agents", schema: SubAgentConfigSchema, label: "sub-agent" };
const SCENE_KIND: AuthorKind = { wrapper: "scenes", subdir: "scenes", schema: SceneConfigSchema, label: "scene" };
const JOB_KIND: AuthorKind = { wrapper: "jobs", subdir: "jobs", schema: JobConfigSchema, label: "job" };

registerTool({
  name: "swarm_define_agent",
  description:
    "Durably author a NEW reusable sub-agent and apply it live. Use after building a capability to "
    + "capture a specialist (e.g. a 'cartographer' that owns a POI/map workflow) so future turns can "
    + "route to it. Validates the definition, writes a version-controlled workspace shard, runs the "
    + "swarm_validate cross-reference gate (reverts on any error), then applies it via the runtime "
    + "overlay so it is routable without a restart. Privileged: maintainer-only, approval-gated.",
  embeddingDescription:
    "create / register / persist a new reusable sub-agent or specialist agent so it survives and can "
    + "be delegated to later; durably save an agent definition into the swarm",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "snake_case agent name, unique (e.g. cartographer)." },
      definition: {
        type: "object",
        description:
          "The sub-agent definition. Required: description (string shown to the orchestrator for routing). "
          + "Recommended: capabilities (string[]), tags (string[]), systemPrompt (the persona), tools (allowed "
          + "tool names). Optional: role, model, maxIterations, turnTimeoutMs, workspaceAccess. Must match the "
          + "SubAgentConfig schema.",
      },
      overwrite: { type: "boolean", description: "Replace an existing agent of the same name (can shadow a built-in — be deliberate). Default false." },
    },
    required: ["name", "definition"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    return authorShard(AGENT_KIND, args, ctx);
  },
});

registerTool({
  name: "swarm_save_scene",
  description:
    "Durably author a NEW reusable scene (a parameterized task template) and apply it live. Use to "
    + "capture a repeatable capability entry-point (e.g. 'pois_near' that geocodes a place then queries "
    + "POIs). Validates against the Scene schema, writes a version-controlled shard, runs the "
    + "swarm_validate cross-reference gate (scene→agent; reverts on error), then applies it via the "
    + "runtime overlay. Unlike the lossy store path this keeps allowedAgents/params/triggers/expectArtifact. "
    + "Privileged: maintainer-only, approval-gated.",
  embeddingDescription:
    "create / persist a new reusable scene or task template with params and allowed agents so a workflow "
    + "can run it later; durably save a scene into the swarm catalog",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "snake_case scene name, unique (e.g. pois_near)." },
      definition: {
        type: "object",
        description:
          "The scene definition. Required: description (string), task (string — the prompt, may use {{param}} "
          + "vars). Optional: params (named vars), allowedAgents (restrict delegation), humanInLoopSteps, "
          + "expectArtifact, triggers, approvalChannel. Must match the SceneConfig schema.",
      },
      overwrite: { type: "boolean", description: "Replace an existing scene of the same name. Default false." },
    },
    required: ["name", "definition"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    return authorShard(SCENE_KIND, args, ctx);
  },
});

registerTool({
  name: "swarm_save_job",
  description:
    "Durably author a NEW reusable job (a multi-step workflow over scenes) and apply it live. Use to "
    + "capture an end-to-end pipeline (e.g. build+serve a backend, then a frontend). Validates against "
    + "the Job schema, writes a version-controlled shard, runs the swarm_validate cross-reference gate "
    + "(job→scene; reverts on error), then applies it via the runtime overlay. Privileged: maintainer-only, "
    + "approval-gated.",
  embeddingDescription:
    "create / persist a new reusable job or multi-step workflow that sequences scenes so it can be "
    + "triggered later; durably save a job pipeline into the swarm",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "snake_case job name, unique." },
      definition: {
        type: "object",
        description:
          "The job definition. Required: description (string), steps (array of { scene: <existing scene name>, "
          + "label? } — at least one). Optional: params, triggers (api/cron/channel), catalogTriggers. Each "
          + "referenced scene must already exist (author scenes first). Must match the JobConfig schema.",
      },
      overwrite: { type: "boolean", description: "Replace an existing job of the same name. Default false." },
    },
    required: ["name", "definition"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    return authorShard(JOB_KIND, args, ctx);
  },
});
