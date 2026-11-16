import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectSecrets } from "../observability/secret-hygiene.js";
// @ts-expect-error — plain .mjs, no types
import * as masterKeyModule from "../../../../scripts/master-key.mjs";

type Decision = { action: "generate" | "keep"; reason?: string; sealedStores?: string[] };
const {
  SHIPPED_MASTER_KEY_PLACEHOLDER,
  PLACEHOLDER_FRAGMENTS,
  isPlaceholderSecret,
  stateRoots,
  findSealedStores,
  decideMasterKey,
  keepReplacedKey,
} = masterKeyModule as {
  SHIPPED_MASTER_KEY_PLACEHOLDER: string;
  PLACEHOLDER_FRAGMENTS: string[];
  isPlaceholderSecret: (value: unknown) => boolean;
  stateRoots: (opts: { cwd: string; home?: string }) => string[];
  findSealedStores: (opts: {
    cwd: string;
    roots?: string[];
    stateDirNames: string[];
    credStore?: string;
    maxDepth?: number;
    maxEntries?: number;
  }) => string[];
  decideMasterKey: (current: string | undefined, findSealed: () => string[]) => Decision;
  keepReplacedKey: (opts: { dir: string; value: string; reason: string; now?: Date }) => string;
};

/**
 * .env.example shipped SAI_MASTER_KEY=your-256-bit-master-key-for-credential-encryption. That value is
 * 48 chars, so the setup wizard's only check (missing or shorter than 32) kept it, and so did the
 * credential store's: an operator who copied .env.example to .env had every stored credential
 * encrypted with a key printed in the public repo.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const STRONG = "QzXzDcSb3fvg1TZKFWxNfEuG-vjHONcDTodrdk-35IZ0JLDvDl0_7vAuYjc7dA4";
const GENERATED_KEY = /^[A-Za-z0-9_-]{64}$/;

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "starlingai-master-key-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function envValue(text: string, key: string): string | undefined {
  const line = text.split(/\r?\n/).find((l) => l.startsWith(`${key}=`));
  return line === undefined ? undefined : line.slice(key.length + 1);
}

describe(".env.example", () => {
  it("ships no value for SAI_MASTER_KEY (nor POSTGRES_PASSWORD), so a copied template holds no public secret", () => {
    const template = readFileSync(join(REPO_ROOT, ".env.example"), "utf8");
    expect(envValue(template, "SAI_MASTER_KEY")).toBe("");
    expect(envValue(template, "POSTGRES_PASSWORD")).toBe("");
  });

  it("offers no value for a core secret to uncomment either, such as the old SAI_JWT_SECRET example", () => {
    const template = readFileSync(join(REPO_ROOT, ".env.example"), "utf8");
    // Commented-out lines count: an operator uncomments them as they are.
    const core = new Set(["SAI_MASTER_KEY", "SAI_JWT_SECRET", "POSTGRES_PASSWORD"]);
    const assignments = template.split(/\r?\n/).flatMap((line) => {
      const m = line.match(/^#?\s*([A-Z0-9_]+)=(.*)$/);
      return m?.[1] && core.has(m[1]) ? [{ line, value: m[2] ?? "" }] : [];
    });
    expect(assignments).toHaveLength(3);
    expect(assignments.filter((a) => a.value.trim() !== "").map((a) => a.line)).toEqual([]);
  });
});

describe("isPlaceholderSecret", () => {
  it("recognises the master key .env.example used to ship, in any case and with surrounding space", () => {
    expect(isPlaceholderSecret(SHIPPED_MASTER_KEY_PLACEHOLDER)).toBe(true);
    expect(isPlaceholderSecret(`  ${SHIPPED_MASTER_KEY_PLACEHOLDER.toUpperCase()} `)).toBe(true);
    expect(isPlaceholderSecret("replace-with-a-real-key-of-at-least-32-chars")).toBe(true);
  });

  it("accepts a random key, one that merely contains 'example', and nothing at all", () => {
    expect(isPlaceholderSecret(STRONG)).toBe(false);
    expect(isPlaceholderSecret(`${STRONG}example_marketing_payload_8a3b`)).toBe(false);
    expect(isPlaceholderSecret("")).toBe(false);
    expect(isPlaceholderSecret(undefined)).toBe(false);
  });

  it("replaces only what the gateway's boot check also calls a placeholder", () => {
    // Every fragment setup acts on must be one the gateway warns about, so setup never rotates a key
    // the gateway accepts (secret-hygiene.ts keeps the list the gateway uses).
    for (const fragment of PLACEHOLDER_FRAGMENTS) {
      const findings = inspectSecrets({ SAI_MASTER_KEY: `${STRONG}-${fragment}`, SAI_JWT_SECRET: STRONG });
      expect(findings, fragment).toEqual([expect.objectContaining({ envVar: "SAI_MASTER_KEY", severity: "placeholder" })]);
    }
    expect(inspectSecrets({ SAI_MASTER_KEY: SHIPPED_MASTER_KEY_PLACEHOLDER, SAI_JWT_SECRET: STRONG }))
      .toEqual([expect.objectContaining({ envVar: "SAI_MASTER_KEY", severity: "placeholder" })]);
  });
});

describe("decideMasterKey", () => {
  it("generates a missing or too-short key without looking for sealed data", () => {
    const findSealed = vi.fn(() => ["never asked"]);
    expect(decideMasterKey(undefined, findSealed)).toEqual({ action: "generate", reason: "missing" });
    expect(decideMasterKey("", findSealed)).toEqual({ action: "generate", reason: "missing" });
    expect(decideMasterKey("too-short", findSealed)).toEqual({ action: "generate", reason: "short" });
    expect(findSealed).not.toHaveBeenCalled();
  });

  it("keeps a real key without looking for sealed data", () => {
    const findSealed = vi.fn(() => [] as string[]);
    expect(decideMasterKey(STRONG, findSealed)).toEqual({ action: "keep" });
    expect(findSealed).not.toHaveBeenCalled();
  });

  it("replaces the shipped placeholder when nothing is sealed with it yet", () => {
    expect(decideMasterKey(SHIPPED_MASTER_KEY_PLACEHOLDER, () => [])).toEqual({ action: "generate", reason: "placeholder" });
  });

  it("keeps the shipped placeholder when data is already sealed with it, and names that data", () => {
    expect(decideMasterKey(SHIPPED_MASTER_KEY_PLACEHOLDER, () => ["/srv/.starlingai/credentials.enc"])).toEqual({
      action: "keep",
      reason: "placeholder-sealed",
      sealedStores: ["/srv/.starlingai/credentials.enc"],
    });
  });
});

describe("findSealedStores", () => {
  const touch = (path: string, text = "x") => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  };

  it("finds nothing without a state directory, or with only unsealed state in it", () => {
    expect(findSealedStores({ cwd: dir, stateDirNames: [".starlingai"] })).toEqual([]);
    touch(join(dir, ".starlingai", "dashboard-token.txt"));
    touch(join(dir, ".starlingai", "audit.jsonl"));
    touch(join(dir, ".starlingai", "users", "u1", "skills", "a", "SKILL.md"));
    expect(findSealedStores({ cwd: dir, stateDirNames: [".starlingai"] })).toEqual([]);
  });

  it("finds the credential store and any salt file, also in a fork's state directory and below it", () => {
    touch(join(dir, ".starlingai", "credentials.enc"));
    touch(join(dir, ".starlingai", "credentials.enc.salt"));
    touch(join(dir, ".myfork", "inbox", "inbox.salt"));
    const found = findSealedStores({ cwd: dir, stateDirNames: [".starlingai", ".myfork", ".starlingai"] });
    expect(found.sort()).toEqual([
      join(dir, ".myfork", "inbox", "inbox.salt"),
      join(dir, ".starlingai", "credentials.enc"),
      join(dir, ".starlingai", "credentials.enc.salt"),
    ].sort());
  });

  it("finds a credential store that SAI_CRED_STORE moved out of the state directory", () => {
    touch(join(dir, "secrets", "creds.bin"));
    expect(findSealedStores({ cwd: dir, stateDirNames: [".starlingai"], credStore: "./secrets/creds.bin" }))
      .toEqual([join(dir, "secrets", "creds.bin")]);
    expect(findSealedStores({ cwd: dir, stateDirNames: [".starlingai"], credStore: "./secrets/absent.bin" })).toEqual([]);
  });

  it("counts a state directory too large to scan as sealed rather than as empty", () => {
    for (let i = 0; i < 5; i++) touch(join(dir, ".starlingai", `note-${i}.md`));
    expect(findSealedStores({ cwd: dir, stateDirNames: [".starlingai"], maxEntries: 3 })).toEqual([join(dir, ".starlingai")]);
  });

  it("looks in every state root setup knows: workspace/, packages/core/ (and its workspace/), and the home directory", () => {
    // Where a fork keeps stores sealed with the same key: workspace-rooted state (the host side of
    // SAI_WORKSPACE_CONFIG_PATH), the dev gateway's and the CLIs' cwd, and the credential store's
    // home fallback.
    const home = join(dir, "home");
    touch(join(dir, "workspace", ".myfork", "voice", "inbox.salt"));
    touch(join(dir, "packages", "core", ".myfork", "users.enc.salt"));
    touch(join(dir, "packages", "core", "workspace", ".starlingai", "notes.salt"));
    touch(join(home, ".starlingai", "credentials.enc"));
    const stateDirNames = [".starlingai", ".myfork"];
    expect(stateRoots({ cwd: dir, home })).toEqual([
      join(dir),
      join(dir, "workspace"),
      join(dir, "packages", "core"),
      join(dir, "packages", "core", "workspace"),
      home,
    ].map((p) => resolve(p)));
    // The repo root alone (the default) holds nothing sealed here.
    expect(findSealedStores({ cwd: dir, stateDirNames })).toEqual([]);
    expect(findSealedStores({ cwd: dir, roots: stateRoots({ cwd: dir, home }), stateDirNames }).sort()).toEqual([
      join(dir, "workspace", ".myfork", "voice", "inbox.salt"),
      join(dir, "packages", "core", ".myfork", "users.enc.salt"),
      join(dir, "packages", "core", "workspace", ".starlingai", "notes.salt"),
      join(home, ".starlingai", "credentials.enc"),
    ].sort());
  });

  it("walks a linked directory inside a state directory", () => {
    // A junction needs no privileges on Windows; elsewhere the type is ignored and a symlink is made.
    touch(join(dir, "elsewhere", "voice", "inbox.salt"));
    mkdirSync(join(dir, ".starlingai"), { recursive: true });
    symlinkSync(join(dir, "elsewhere", "voice"), join(dir, ".starlingai", "voice"), "junction");
    expect(findSealedStores({ cwd: dir, stateDirNames: [".starlingai"] })).toEqual([join(dir, ".starlingai", "voice", "inbox.salt")]);
  });

  it("counts a link with a sealed name, even one that leads to a directory, without walking it", () => {
    // Runs without the symlink privilege on Windows (a junction); the next test covers file links.
    touch(join(dir, "elsewhere", "store", "inner.salt"));
    mkdirSync(join(dir, ".starlingai"), { recursive: true });
    symlinkSync(join(dir, "elsewhere", "store"), join(dir, ".starlingai", "credentials.enc"), "junction");
    expect(findSealedStores({ cwd: dir, stateDirNames: [".starlingai"] })).toEqual([join(dir, ".starlingai", "credentials.enc")]);
  });

  it("counts a credential store or salt file that is a link, without reading it", (ctx) => {
    touch(join(dir, "secrets", "credentials.enc"));
    mkdirSync(join(dir, ".starlingai"), { recursive: true });
    try {
      symlinkSync(join(dir, "secrets", "credentials.enc"), join(dir, ".starlingai", "credentials.enc"), "file");
      symlinkSync(join(dir, "secrets", "absent.salt"), join(dir, ".starlingai", "credentials.enc.salt"), "file"); // dangling
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") return ctx.skip(); // Windows without the symlink privilege
      throw err;
    }
    expect(findSealedStores({ cwd: dir, stateDirNames: [".starlingai"] }).sort()).toEqual([
      join(dir, ".starlingai", "credentials.enc"),
      join(dir, ".starlingai", "credentials.enc.salt"),
    ].sort());
  });
});

describe("keepReplacedKey", () => {
  it("appends each replaced key to one owner-only file, oldest first", () => {
    const stateDir = join(dir, ".starlingai");
    const file = keepReplacedKey({ dir: stateDir, value: SHIPPED_MASTER_KEY_PLACEHOLDER, reason: "placeholder", now: new Date("2026-11-14T10:00:00Z") });
    expect(keepReplacedKey({ dir: stateDir, value: "too-short", reason: "short" })).toBe(file);
    expect(file).toBe(join(stateDir, "replaced-master-keys.txt"));
    const text = readFileSync(file, "utf8");
    expect(text).toContain("# 2026-11-14T10:00:00.000Z: replaced by setup (placeholder).");
    expect(text).toContain(`\nSAI_MASTER_KEY=${SHIPPED_MASTER_KEY_PLACEHOLDER}\n`);
    expect(text.indexOf(SHIPPED_MASTER_KEY_PLACEHOLDER)).toBeLessThan(text.indexOf("SAI_MASTER_KEY=too-short\n"));
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("the setup wizard", () => {
  // The wizard writes .env, starlingai.json and .starlingai/ into its cwd only. SeaweedFS's
  // credential file sits in the repo, so the S3 secret is preset and the wizard leaves it alone.
  const fillers = [
    `SAI_S3_SECRET_ACCESS_KEY=${"s".repeat(48)}`,
    `SAI_MAIL_SERVICE_TOKEN=${"t".repeat(48)}`,
    `SAI_COMPUTER_REMOTE_TOKEN=${"c".repeat(48)}`,
  ];
  const runWizard = (envFile: string): { env: string; output: string } => {
    writeFileSync(join(dir, ".env"), envFile);
    // A home of its own, so state in the real home directory cannot change the outcome.
    const home = join(dir, "home");
    const childEnv: NodeJS.ProcessEnv = { ...process.env, SAI_SETUP_BACKEND: "byo-openai", SAI_SETUP_IAM: "builtin", HOME: home, USERPROFILE: home };
    delete childEnv["SAI_CRED_STORE"];
    const output = execFileSync(process.execPath, [join(REPO_ROOT, "scripts", "setup-wizard.mjs"), "--defaults"], {
      cwd: dir,
      env: childEnv,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { env: readFileSync(join(dir, ".env"), "utf8"), output };
  };

  it("turns a copied .env.example into random core secrets", () => {
    const template = readFileSync(join(REPO_ROOT, ".env.example"), "utf8");
    const { env } = runWizard(`${template}\n${fillers.join("\n")}\n`);
    const key = envValue(env, "SAI_MASTER_KEY") ?? "";
    expect(key).toMatch(GENERATED_KEY);
    expect(inspectSecrets({ SAI_MASTER_KEY: key, SAI_JWT_SECRET: STRONG })).toEqual([]);
    expect(envValue(env, "POSTGRES_PASSWORD")).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("replaces the placeholder an older .env.example left in .env when nothing is sealed with it", () => {
    const { env, output } = runWizard([`SAI_MASTER_KEY=${SHIPPED_MASTER_KEY_PLACEHOLDER}`, `POSTGRES_PASSWORD=${"p".repeat(32)}`, ...fillers, ""].join("\n"));
    const key = envValue(env, "SAI_MASTER_KEY") ?? "";
    expect(key).not.toBe(SHIPPED_MASTER_KEY_PLACEHOLDER);
    expect(key).toMatch(GENERATED_KEY);
    expect(output).toContain("Replaced the template SAI_MASTER_KEY placeholder");
    // A gateway still running on the old key would seal what it stores now with that key.
    expect(output).toContain("If the stack is running, restart it now (`pnpm sai start`) before storing any credential");
    // The old value is kept, so a wrong "nothing is sealed" decision can be undone.
    const kept = join(dir, ".starlingai", "replaced-master-keys.txt");
    expect(output).toContain(kept);
    expect(readFileSync(kept, "utf8")).toContain(`SAI_MASTER_KEY=${SHIPPED_MASTER_KEY_PLACEHOLDER}\n`);
    // Nothing else is touched.
    expect(envValue(env, "POSTGRES_PASSWORD")).toBe("p".repeat(32));
  });

  it("keeps a placeholder that seals data in the workspace state directory, where a fork keeps stores", () => {
    mkdirSync(join(dir, "workspace", ".starlingai", "voice"), { recursive: true });
    writeFileSync(join(dir, "workspace", ".starlingai", "voice", "inbox.salt"), "salt");
    const { env, output } = runWizard([`SAI_MASTER_KEY=${SHIPPED_MASTER_KEY_PLACEHOLDER}`, `POSTGRES_PASSWORD=${"p".repeat(32)}`, ...fillers, ""].join("\n"));
    expect(envValue(env, "SAI_MASTER_KEY")).toBe(SHIPPED_MASTER_KEY_PLACEHOLDER);
    expect(output).toContain(join(dir, "workspace", ".starlingai", "voice", "inbox.salt"));
  });

  it("replaces the SAI_JWT_SECRET placeholder an uncommented older .env.example line left in .env", () => {
    const { env, output } = runWizard([
      "SAI_JWT_SECRET=your-256-bit-jwt-secret-here-min-32-chars",
      `SAI_MASTER_KEY=${STRONG}`,
      `POSTGRES_PASSWORD=${"p".repeat(32)}`,
      ...fillers,
      "",
    ].join("\n"));
    expect(envValue(env, "SAI_JWT_SECRET")).toMatch(GENERATED_KEY);
    expect(output).toContain("Replaced the template SAI_JWT_SECRET placeholder");
    expect(envValue(env, "SAI_MASTER_KEY")).toBe(STRONG);
  });

  it("keeps a placeholder that already seals a credential store, and says how to rotate", () => {
    mkdirSync(join(dir, ".starlingai"), { recursive: true });
    writeFileSync(join(dir, ".starlingai", "credentials.enc"), "ciphertext");
    const { env, output } = runWizard([`SAI_MASTER_KEY=${SHIPPED_MASTER_KEY_PLACEHOLDER}`, `POSTGRES_PASSWORD=${"p".repeat(32)}`, ...fillers, ""].join("\n"));
    expect(envValue(env, "SAI_MASTER_KEY")).toBe(SHIPPED_MASTER_KEY_PLACEHOLDER);
    expect(output).toContain("SAI_MASTER_KEY is still a template placeholder");
    expect(output).toContain(join(dir, ".starlingai", "credentials.enc"));
    expect(output).toContain("To rotate");
  });

  it("keeps a real key and JWT secret as they are", () => {
    const jwt = `${STRONG.slice(1)}J`;
    const { env } = runWizard([`SAI_JWT_SECRET=${jwt}`, `SAI_MASTER_KEY=${STRONG}`, `POSTGRES_PASSWORD=${"p".repeat(32)}`, ...fillers, ""].join("\n"));
    expect(envValue(env, "SAI_MASTER_KEY")).toBe(STRONG);
    expect(envValue(env, "SAI_JWT_SECRET")).toBe(jwt);
    expect(existsSync(join(dir, ".starlingai", "replaced-master-keys.txt"))).toBe(false);
  });
});
