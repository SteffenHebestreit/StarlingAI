/**
 * Memory Vault tools — surface durable memory as an Obsidian-style Markdown vault
 * for human review, then re-ingest edits (the correction loop).
 *
 *   memory_export — render durable memory + skills + recent sessions → Markdown
 *   memory_import — re-ingest edited managed notes back into the durable store
 *
 * Agent-callable writes are constrained to within the workspace
 * (resolvePathWithinWorkspace); the `sai memory` CLI can target an external
 * Obsidian vault path. The export itself is deterministic code in memory/vault.ts.
 */
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import { resolvePathWithinWorkspace } from "./workspace-path.js";
import {
  DEFAULT_VAULT_SUBDIR,
  exportMemoryVault,
  importMemoryVault,
  seedObsidianVaultSkill,
} from "../memory/vault.js";

const log = childLogger("tool:memory-vault");

function resolveVaultArg(args: Record<string, unknown>, ctx: ToolContext): string {
  const raw = String(args["vaultPath"] ?? "").trim() || DEFAULT_VAULT_SUBDIR;
  // Agent-callable: keep the write target inside the workspace boundary.
  return resolvePathWithinWorkspace(raw, ctx.workspacePath).resolved;
}

registerTool({
  name: "memory_export",
  description:
    "Mirror durable memory (workspace + user), skills, recent session summaries, and tag indexes into an " +
    "Obsidian-style Markdown vault for human review and backup. Idempotent: refreshes notes and prunes " +
    "ones whose source record is gone. Default location: <workspace>/vault. Editable notes carry " +
    "'starlingai_managed: true'; apply edits back with memory_import.",
  embeddingDescription:
    "Export, mirror, surface, review, audit, back up agent memory as Markdown / Obsidian vault. " +
    "Gedächtnis als Markdown exportieren, Notizen sichern, Memory-Vault aktualisieren, zur Durchsicht anzeigen.",
  costHint: "low",
  latencyHint: "low",
  parameters: {
    type: "object",
    properties: {
      vaultPath: {
        type: "string",
        description: "Workspace-relative folder for the vault (default 'vault'). Must stay inside the workspace.",
      },
      includeSessions: {
        type: "boolean",
        description: "Also mirror recent session summaries (default true).",
      },
    },
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const vaultPath = resolveVaultArg(args, ctx);
      seedObsidianVaultSkill(ctx.workspacePath);
      const result = await exportMemoryVault({
        workspacePath: ctx.workspacePath,
        vaultPath,
        sessionId: ctx.sessionId,
        includeSessions: args["includeSessions"] !== false,
      });
      const c = result.counts;
      return {
        success: true,
        output:
          `Memory vault exported to ${result.vaultPath} — ` +
          `${c.workspaceMemory} workspace + ${c.userMemory} user memories, ${c.skills} skills, ` +
          `${c.sessions} sessions, ${c.tags} tag indexes (${result.written.length} notes written` +
          `${result.pruned.length ? `, ${result.pruned.length} pruned` : ""}). ` +
          `Edit 'starlingai_managed: true' notes under memory/ and run memory_import to apply.`,
        metadata: { vaultPath: result.vaultPath, counts: c, written: result.written.length, pruned: result.pruned.length },
      };
    } catch (err) {
      log.error({ err }, "memory_export failed");
      return { success: false, output: "", error: `Failed to export memory vault: ${String(err)}` };
    }
  },
});

registerTool({
  name: "memory_import",
  description:
    "Re-ingest a memory vault's edited managed notes (memory/** with 'starlingai_managed: true') back into the " +
    "durable store, matched by key. The correction loop for human edits made in Obsidian/Markdown. " +
    "Read-only mirrors (skills/, sessions/, tags/) are ignored.",
  embeddingDescription:
    "Import, re-ingest, apply edited memory notes, sync vault edits back into memory. " +
    "Bearbeitete Memory-Notizen zurück übernehmen, Vault-Änderungen in den Speicher übernehmen.",
  costHint: "low",
  latencyHint: "low",
  parameters: {
    type: "object",
    properties: {
      vaultPath: {
        type: "string",
        description: "Workspace-relative folder of the vault (default 'vault'). Must stay inside the workspace.",
      },
    },
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const vaultPath = resolveVaultArg(args, ctx);
      const result = importMemoryVault({ workspacePath: ctx.workspacePath, vaultPath });
      return {
        success: true,
        output:
          `Memory vault imported from ${vaultPath} — ${result.created} created, ${result.updated} updated, ` +
          `${result.skipped} skipped${result.errors.length ? `, ${result.errors.length} errors` : ""}.` +
          (result.errors.length ? `\nErrors:\n- ${result.errors.slice(0, 5).join("\n- ")}` : ""),
        metadata: { created: result.created, updated: result.updated, skipped: result.skipped, errors: result.errors },
      };
    } catch (err) {
      log.error({ err }, "memory_import failed");
      return { success: false, output: "", error: `Failed to import memory vault: ${String(err)}` };
    }
  },
});
