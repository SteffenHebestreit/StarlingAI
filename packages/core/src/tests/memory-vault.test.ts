import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exportMemoryVault,
  importMemoryVault,
  seedObsidianVaultSkill,
  OBSIDIAN_VAULT_SKILL_SLUG,
} from "../memory/vault.js";
import {
  listWorkspaceMemoryRecords,
  storeUserMemoryRecord,
  storeWorkspaceMemoryRecord,
  _clearDurableMemoryCaches,
} from "../memory/service.js";
import { getSkill } from "../skills/store.js";

describe("memory vault", () => {
  const dirs: string[] = [];
  let workspacePath: string;
  let userMemoryDir: string;

  beforeEach(() => {
    workspacePath = mkdtempSync(join(tmpdir(), "sai-vault-ws-"));
    userMemoryDir = mkdtempSync(join(tmpdir(), "sai-vault-user-"));
    dirs.push(workspacePath, userMemoryDir);
    // Isolate user-scope memory so tests never read the host's real durable store.
    process.env["SAI_USER_MEMORY_PATH"] = userMemoryDir;
    _clearDurableMemoryCaches();
  });

  afterEach(() => {
    delete process.env["SAI_USER_MEMORY_PATH"];
    _clearDurableMemoryCaches();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function readVault(rel: string): string {
    return readFileSync(join(workspacePath, "vault", rel), "utf8");
  }

  it("exports keyed durable memory as managed Obsidian notes with frontmatter, content, and tag wikilinks", async () => {
    storeWorkspaceMemoryRecord(workspacePath, {
      key: "deploy_flow",
      content: "The project deploys through GitHub pushes to main.",
      kind: "decision",
      subject: "Deployment flow",
      tags: ["deploy", "ci"],
    });
    storeUserMemoryRecord(workspacePath, {
      key: "tone_pref",
      content: "Prefers concise, technical answers.",
      kind: "preference",
      tags: ["style"],
    });

    const result = await exportMemoryVault({ workspacePath, includeSessions: false });

    expect(result.counts.workspaceMemory).toBe(1);
    expect(result.counts.userMemory).toBe(1);
    expect(existsSync(join(workspacePath, "vault", "README.md"))).toBe(true);

    const note = readVault("memory/workspace/deploy_flow.md");
    expect(note).toContain("starlingai_managed: true");
    expect(note).toContain("starlingai_key: deploy_flow");
    expect(note).toContain("kind: decision");
    expect(note).toContain("The project deploys through GitHub pushes to main.");
    expect(note).toContain("[[tags/deploy|#deploy]]");
    expect(note).toContain("%% starlingai:managed-footer");

    // Tag index note links back to the member.
    const tagNote = readVault("tags/deploy.md");
    expect(tagNote).toContain("[[memory/workspace/deploy_flow|Deployment flow]]");
    expect(tagNote).toContain("starlingai_managed: false");
  });

  it("re-ingests an edited managed note back into the durable store (correction loop)", async () => {
    storeWorkspaceMemoryRecord(workspacePath, {
      key: "deploy_flow",
      content: "Old, wrong fact.",
      kind: "fact",
      tags: ["deploy"],
    });
    await exportMemoryVault({ workspacePath, includeSessions: false });

    // Simulate a human editing the note body in Obsidian (above the footer).
    const notePath = join(workspacePath, "vault", "memory", "workspace", "deploy_flow.md");
    const original = readFileSync(notePath, "utf8");
    const corrected = original.replace("Old, wrong fact.", "Corrected: deploys via GitHub Actions.");
    writeFileSync(notePath, corrected, "utf8");

    const importResult = importMemoryVault({ workspacePath });
    expect(importResult.updated).toBe(1);
    expect(importResult.created).toBe(0);

    _clearDurableMemoryCaches();
    const records = listWorkspaceMemoryRecords(workspacePath);
    const rec = records.find((r) => r.key === "deploy_flow");
    expect(rec?.content).toContain("Corrected: deploys via GitHub Actions.");
    expect(rec?.content).not.toContain("managed-footer");
  });

  it("prunes managed notes whose source record no longer exists", async () => {
    storeWorkspaceMemoryRecord(workspacePath, { key: "keep_me", content: "Still here.", tags: [] });
    await exportMemoryVault({ workspacePath, includeSessions: false });

    // A stray managed note (e.g. from a record deleted out-of-band).
    const strayPath = join(workspacePath, "vault", "memory", "workspace", "ghost.md");
    writeFileSync(
      strayPath,
      "---\nstarlingai_managed: true\nstarlingai_id: nonexistent-id\nstarlingai_key: ghost\nkind: note\ntags: []\n---\n\nshould be pruned\n",
      "utf8",
    );

    const result = await exportMemoryVault({ workspacePath, includeSessions: false });
    expect(existsSync(strayPath)).toBe(false);
    expect(result.pruned.some((p) => p.endsWith("ghost.md"))).toBe(true);
    expect(existsSync(join(workspacePath, "vault", "memory", "workspace", "keep_me.md"))).toBe(true);
  });

  it("does not re-ingest read-only mirror notes (skills/sessions/tags) on import", async () => {
    storeWorkspaceMemoryRecord(workspacePath, { key: "real_fact", content: "kept", tags: ["t"] });
    await exportMemoryVault({ workspacePath, includeSessions: false });

    const before = listWorkspaceMemoryRecords(workspacePath).length;
    const result = importMemoryVault({ workspacePath });
    // Only the one managed memory note is processed; tag/readme mirrors are ignored.
    expect(result.created + result.updated).toBe(1);
    _clearDurableMemoryCaches();
    expect(listWorkspaceMemoryRecords(workspacePath).length).toBe(before);
  });

  it("seeds the obsidian-vault skill once (idempotent)", () => {
    expect(getSkill(workspacePath, OBSIDIAN_VAULT_SKILL_SLUG)).toBeNull();
    expect(seedObsidianVaultSkill(workspacePath)).toBe(true);
    const skill = getSkill(workspacePath, OBSIDIAN_VAULT_SKILL_SLUG);
    expect(skill?.frontmatter.tools).toContain("memory_export");
    // Second call is a no-op.
    expect(seedObsidianVaultSkill(workspacePath)).toBe(false);
  });
});
