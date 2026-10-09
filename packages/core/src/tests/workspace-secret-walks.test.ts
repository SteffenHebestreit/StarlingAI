import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * Security finding S1 (2026-10-05): the directory walkers that hand back file CONTENTS never
 * consulted the file tools' secrets denylist. The gateway mounts the repository root as
 * /workspace, so workspace_search("canary") returned the contents of ".env" and "prod.env".
 * Every walker below must skip whatever isSensitiveWorkspacePath refuses, judged on the
 * WORKSPACE-relative path, and every one still finds an ordinary file (the discriminator: a
 * walker that returns nothing at all would pass the negative assertions too).
 */

const SECRETS = {
  dotenv: "canary-dotenv-7a1f",
  prodEnv: "canary-prodenv-29c4",
  nestedEnv: "canary-nestedenv-b803",
  dotenvJson: "canary-dotenvjson-55e2",
  stateMemory: "canary-statememory-0d9b",
  gitConfig: "canary-gitconfig-c4e1",
};

function seedWorkspace(ws: string): void {
  mkdirSync(join(ws, "docker"), { recursive: true });
  mkdirSync(join(ws, "packages", "app"), { recursive: true });
  mkdirSync(join(ws, ".starlingai", "memory", "user"), { recursive: true });
  mkdirSync(join(ws, ".git"), { recursive: true });
  writeFileSync(join(ws, ".env"), `OPENAI_API_KEY=${SECRETS.dotenv}\n`);
  writeFileSync(join(ws, "docker", "prod.env"), `DB_PASSWORD=${SECRETS.prodEnv}\n`);
  writeFileSync(join(ws, "packages", "app", ".env"), `TOKEN=${SECRETS.nestedEnv}\n`);
  writeFileSync(join(ws, ".env.json"), JSON.stringify({ key: SECRETS.dotenvJson }));
  writeFileSync(join(ws, ".starlingai", "memory", "user", "facts.json"), JSON.stringify({ fact: SECRETS.stateMemory }));
  writeFileSync(join(ws, ".git", "config"), `[remote "origin"]\n\turl = https://user:${SECRETS.gitConfig}@example.com/r.git\n`);
  writeFileSync(join(ws, ".env.example"), "OPENAI_API_KEY=canary-template-placeholder\n");
  writeFileSync(join(ws, "notes.md"), "The canary-public note is ordinary workspace text.\n");
}

function expectNoSecret(text: string): void {
  for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret);
}

async function tool(name: string, module: string) {
  const [{ getTool }] = await Promise.all([import("../tools/registry.js"), import(module)]);
  const found = getTool(name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
}

describe("isSensitiveWorkspacePath covers dotenv files at any depth and name shape", () => {
  it("flags prod.env, nested .env files and .env.* variants; keeps the public template readable", async () => {
    const { isSensitiveWorkspacePath } = await import("../tools/filesystem.js");
    for (const p of ["prod.env", "docker/staging.env", "packages/app/.env", "packages/app/.env.local", "a\\b\\.ENV", "PROD.ENV", ".env.json"]) {
      expect(isSensitiveWorkspacePath(p), p).toBe(true);
    }
    for (const p of [".env.example", "docker/.env.example", "src/environment.ts", "docs/env.md", "src/.envrc.md"]) {
      expect(isSensitiveWorkspacePath(p), p).toBe(false);
    }
    // The template exemption never reopens a protected tree.
    expect(isSensitiveWorkspacePath(".git/.env.example")).toBe(true);
    expect(isSensitiveWorkspacePath(".starlingai/.env.example")).toBe(true);
  });

  it("covers dash/underscore variants, direnv and backup copies; keeps templates and env-named code readable", async () => {
    const { isSensitiveWorkspacePath } = await import("../tools/filesystem.js");
    for (const p of [".envrc", "app/.envrc", ".env-local", ".env_prod", ".env~", "secrets.env.bak", "docker/prod.env.orig", "prod.env~"]) {
      expect(isSensitiveWorkspacePath(p), p).toBe(true);
    }
    for (const p of [".env.sample", "docker/.env.template", ".env.dist", "example.env", "deploy/sample.env", "jest.env.js", "src/vite-env.d.ts", "src/env.ts"]) {
      expect(isSensitiveWorkspacePath(p), p).toBe(false);
    }
    // An alternate data stream names the file itself on a Windows host.
    expect(isSensitiveWorkspacePath(".env::$DATA")).toBe(process.platform === "win32");
  });
});

describe("directory walkers skip protected workspace data", () => {
  const cleanup: string[] = [];
  let ws: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), "sai-secret-walk-"));
    cleanup.push(ws);
    seedWorkspace(ws);
  });

  afterEach(() => { for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true }); });

  const ctx = () => ({ sessionId: "s", workspacePath: ws }) as never;

  it("workspace_search never returns the contents of a dotenv file", async () => {
    const t = await tool("workspace_search", "../tools/workspace-search.js");
    const r = await t.execute({ query: "canary", maxResults: 30 }, ctx());
    expect(r.success).toBe(true);
    expect(String(r.output)).toContain("notes.md");   // the walk still works
    expectNoSecret(String(r.output));
  });

  it("searchWorkspace (the federated peer path) applies the same denylist", async () => {
    const { searchWorkspace } = await import("../tools/workspace-search.js");
    const matches = searchWorkspace(ws, "canary", 30);
    expect(matches.map((m) => m.file)).toContain("notes.md");
    expectNoSecret(JSON.stringify(matches));
  });

  it("grep_files never returns prod.env or a nested .env", async () => {
    const t = await tool("grep_files", "../tools/code-navigation.js");
    const r = await t.execute({ pattern: "canary" }, ctx());
    expect(r.success).toBe(true);
    expect(String(r.output)).toContain("notes.md");
    expectNoSecret(String(r.output));
  });

  it("grep_files rooted INSIDE a protected directory still refuses its contents", async () => {
    const t = await tool("grep_files", "../tools/code-navigation.js");
    for (const path of [".starlingai", ".starlingai/memory", ".git"]) {
      const r = await t.execute({ pattern: "canary", path }, ctx());
      expectNoSecret(`${r.output ?? ""}${r.error ?? ""}`);
    }
  });

  it("glob_files rooted inside a protected directory lists none of it", async () => {
    const t = await tool("glob_files", "../tools/code-navigation.js");
    const r = await t.execute({ pattern: "**/*", path: ".starlingai" }, ctx());
    expect(String(r.output ?? "")).not.toContain("facts.json");
  });

  // A root that is itself a link into a protected tree (a sandbox shell can plant one inside the
  // mount): the walk judged each entry relative to the link, and those paths read as innocent.
  it("grep_files and glob_files refuse a root that links into a protected directory", async () => {
    mkdirSync(join(ws, "generated"), { recursive: true });
    symlinkSync(join(ws, ".starlingai"), join(ws, "generated", "link"), "junction");
    const grep = await tool("grep_files", "../tools/code-navigation.js");
    const glob = await tool("glob_files", "../tools/code-navigation.js");

    const grepped = await grep.execute({ pattern: "canary", path: "generated/link" }, ctx());
    expect(grepped.success).toBe(false);
    expect(grepped.error).toMatch(/Access denied/);
    expectNoSecret(`${grepped.output ?? ""}${grepped.error ?? ""}`);
    const globbed = await glob.execute({ pattern: "**/*", path: "generated/link" }, ctx());
    expect(globbed.success).toBe(false);
    expect(String(globbed.output ?? "")).not.toContain("facts.json");

    // A link to an ordinary directory still searches (refusing every link would pass the above).
    mkdirSync(join(ws, "docs"), { recursive: true });
    writeFileSync(join(ws, "docs", "guide.md"), "The canary-public guide.\n");
    symlinkSync(join(ws, "docs"), join(ws, "generated", "docs-link"), "junction");
    const ordinary = await grep.execute({ pattern: "canary", path: "generated/docs-link" }, ctx());
    expect(ordinary.success).toBe(true);
    expect(String(ordinary.output)).toContain("guide.md");
  });

  it("bundle_artifact_zip refuses a protected file and leaves protected entries out of a directory bundle", async () => {
    const t = await tool("bundle_artifact_zip", "../tools/bundle-zip.js");

    for (const [i, workspacePath] of [".env", "docker/prod.env", ".git/config"].entries()) {
      const named = await t.execute({ output_file: `named-${i}.zip`, files: [{ workspacePath }] }, ctx());
      expect(named.success, workspacePath).toBe(false);
      expect(named.error).toMatch(/Access denied/);
    }

    const dir = await t.execute({ output_file: "protected-dir.zip", directories: [{ workspaceDir: ".starlingai" }] }, ctx());
    expect(dir.success).toBe(false);
    expect(dir.error).toMatch(/Access denied/);

    const whole = await t.execute({ output_file: "whole.zip", directories: [{ workspaceDir: "." }], compressionLevel: 0 }, ctx());
    expect(whole.success).toBe(true);
    const zipPath = join(ws, String(whole.metadata?.["outputPath"]));
    expect(existsSync(zipPath)).toBe(true);
    const names = zipEntryNames(zipPath);
    expect(names).toContain("notes.md");
    expect(names).toContain(".env.example");
    for (const protectedEntry of [".env", "docker/prod.env", "packages/app/.env", ".env.json", ".starlingai/memory/user/facts.json", ".git/config"]) {
      expect(names, protectedEntry).not.toContain(protectedEntry);
    }
    expectNoSecret(readFileSync(zipPath).toString("latin1"));   // stored, so contents would be plain text
  });
});

/** Entry names from a zip's central directory (signature PK\x01\x02), read from the end record. */
function zipEntryNames(path: string): string[] {
  const buf = readFileSync(path);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("end of central directory not found");
  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    names.push(buf.toString("utf8", offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}
