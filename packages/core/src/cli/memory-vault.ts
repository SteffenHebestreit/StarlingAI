#!/usr/bin/env tsx
/**
 * `sai memory export|import` — operator CLI for the Markdown memory vault.
 *
 * Unlike the agent-callable memory_export/memory_import tools (which keep the
 * vault inside the workspace), this CLI can target an EXTERNAL Obsidian vault
 * path so a human reviews/edits/back-ups durable memory in their own vault.
 *
 *   tsx src/cli/memory-vault.ts export [--vault <path>] [--workspace <path>] [--no-sessions]
 *   tsx src/cli/memory-vault.ts import [--vault <path>] [--workspace <path>]
 *
 * The durable memory store is plain files under <workspace>/.starlingai/memory,
 * so no running gateway is required. Recent-session summaries are only available
 * when a live session store exists, so they are skipped in this standalone CLI.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { exportMemoryVault, importMemoryVault, seedObsidianVaultSkill } from "../memory/vault.js";

/** Mirror the runtime's two-zone workspace resolution so the CLI hits the same store. */
function defaultWorkspace(): string {
  const env = process.env["SAI_WORKSPACE_CONFIG_PATH"];
  if (env?.trim()) return resolve(env);
  const ws = resolve(process.cwd(), "workspace");
  return existsSync(ws) ? ws : process.cwd();
}

async function main(): Promise<void> {
  const sub = process.argv[2];
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      vault: { type: "string" },
      workspace: { type: "string" },
      "no-sessions": { type: "boolean" },
    },
    allowPositionals: true,
  });

  const workspacePath = values.workspace ?? defaultWorkspace();
  const vaultPath = values.vault;

  if (sub === "export") {
    seedObsidianVaultSkill(workspacePath);
    const result = await exportMemoryVault({
      workspacePath,
      vaultPath,
      includeSessions: !values["no-sessions"],
    });
    const c = result.counts;
    console.log(`✓ Memory vault exported to ${result.vaultPath}`);
    console.log(
      `  ${c.workspaceMemory} workspace + ${c.userMemory} user memories · ${c.skills} skills · ` +
        `${c.sessions} sessions · ${c.tags} tag indexes`,
    );
    console.log(`  ${result.written.length} notes written${result.pruned.length ? `, ${result.pruned.length} pruned` : ""}`);
    console.log(`  Edit 'starlingai_managed: true' notes under memory/, then: sai memory import --vault ${result.vaultPath}`);
    return;
  }

  if (sub === "import") {
    const result = importMemoryVault({ workspacePath, vaultPath });
    console.log(
      `✓ Memory vault imported — ${result.created} created, ${result.updated} updated, ${result.skipped} skipped` +
        `${result.errors.length ? `, ${result.errors.length} errors` : ""}`,
    );
    for (const err of result.errors.slice(0, 10)) console.error(`  ✗ ${err}`);
    return;
  }

  console.error("Usage: sai memory <export|import> [--vault <path>] [--workspace <path>] [--no-sessions]");
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(`memory-vault failed: ${String(err)}`);
  process.exitCode = 1;
});
