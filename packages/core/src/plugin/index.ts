/**
 * Plugin SDK — public API for writing third-party tool packages.
 *
 * Example plugin (consumer-side):
 *
 *   // ~/.starlingai/plugins/csv-utilities/index.js
 *   import { definePlugin, defineTool } from "@starlingai/core/plugin";
 *
 *   export default definePlugin({
 *     name: "csv-utilities",
 *     version: "1.0.0",
 *     description: "CSV parse + transform helpers",
 *     tools: [
 *       defineTool({
 *         name: "parse_csv",
 *         description: "Parse a CSV string into JSON rows",
 *         parameters: { type: "object", properties: { csv: { type: "string" } }, required: ["csv"] },
 *         async execute({ csv }) {
 *           return { success: true, output: JSON.stringify(parse(csv as string)) };
 *         },
 *       }),
 *     ],
 *   });
 *
 * Plugins register at `plugin__<plugin-name>__<tool-name>` in the live tool
 * registry.  Their tier is fixed at Tier 2 (per-call approval + sandboxed
 * execution semantics) — a plugin cannot grant itself a higher tier.  Tool
 * names that would shadow a built-in are hard-rejected at load time.
 */

import type { ToolContext, ToolResult } from "../tools/registry.js";

/**
 * Plugin-author-facing tool definition.  Mirrors the internal ToolHandler
 * shape but trims internal fields and accepts a single object argument so
 * authors see a clean signature.  The runtime adds the `plugin__<name>__`
 * prefix automatically when registering, so authors write the bare name.
 */
export interface PluginTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
  /** Optional — used by the embedding-based reranker if set. */
  embeddingDescription?: string;
  /** Optional — qualitative cost / latency hints used by routing. */
  costHint?: "low" | "medium" | "high";
  latencyHint?: "low" | "medium" | "high";
  /** Optional per-tool execution timeout (ms).  Defaults to no per-tool timeout. */
  timeoutMs?: number;
}

export interface Plugin {
  /** Unique plugin id — must match `^[a-z][a-z0-9_-]{1,32}$`.  Used as the registry namespace. */
  name: string;
  /** Semver-style string.  Surfaced in audit + dashboard but not enforced. */
  version: string;
  /** Short human description shown in plugin listings. */
  description?: string;
  /** Optional author / vendor name. */
  author?: string;
  /** Tools the plugin exposes. */
  tools: PluginTool[];
}

/**
 * Identity helper.  At runtime this just returns its argument — its real value
 * is the IDE / TypeScript story: authors get the typed shape and editor
 * completion without depending on internal types.
 */
export function defineTool<T extends PluginTool>(tool: T): T {
  return tool;
}

/** Same as `defineTool` but for the top-level plugin manifest. */
export function definePlugin<T extends Plugin>(plugin: T): T {
  return plugin;
}

export type { ToolContext, ToolResult } from "../tools/registry.js";
