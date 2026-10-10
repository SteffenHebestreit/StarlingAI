/**
 * An account id is the key of an account's own storage (runtime/accounts.ts). Two records holding
 * one id would share one bucket, and a record holding the default bootstrap token's segment would
 * share the bootstrap admin's. The config load refuses both, so neither roster ever runs.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACCOUNT_ID_RE,
  accountIdSlug,
  mintBuiltinAccountId,
  newBuiltinAccountId,
  newOidcAccountId,
  principalSegment,
  safeUserSegment,
} from "../runtime/accounts.js";

const DUMMY_HASH = "$2b$10$0123456789abcdefghijklmno";
const tempDirs: string[] = [];

async function loadWithUsers(users: Array<Record<string, unknown>>) {
  const dir = mkdtempSync(join(tmpdir(), "starlingai-account-ids-"));
  tempDirs.push(dir);
  const configPath = join(dir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({ gateway: { jwtSecret: "u".repeat(40) }, workspacePath: dir, auth: { enabled: true, users } }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  process.env["SAI_MUTABLE_CONFIG_PATH"] = configPath;
  vi.resetModules();
  const loader = await import("../config/loader.js");
  return () => loader.loadConfig();
}

function user(username: string, id?: string): Record<string, unknown> {
  return { username, passwordHash: DUMMY_HASH, role: "operator", ...(id ? { id } : {}) };
}

afterEach(async () => {
  const loader = await import("../config/loader.js");
  loader.resetConfigForTests();
  delete process.env["SAI_CONFIG_PATH"];
  delete process.env["SAI_MUTABLE_CONFIG_PATH"];
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.resetModules();
});

describe("account ids in the roster", () => {
  it("loads distinct ids, and records without one (they predate ids)", async () => {
    const load = await loadWithUsers([user("alice", "alice-0123456789abcdef"), user("bob", "bob-fedcba9876543210"), user("carol")]);
    expect(load().auth.users.map((u) => u.id)).toEqual(["alice-0123456789abcdef", "bob-fedcba9876543210", undefined]);
  });

  it("refuses two records holding one id, also when only the case differs", async () => {
    const duplicate = await loadWithUsers([user("alice", "alice-0123456789abcdef"), user("bob", "alice-0123456789abcdef")]);
    expect(duplicate).toThrow(/already held by 'alice'/);
    const caseOnly = await loadWithUsers([user("alice", "alice-0123456789abcdef"), user("bob", "ALICE-0123456789abcdef")]);
    expect(caseOnly).toThrow(/already held by 'alice'/);
  });

  it("refuses the default bootstrap token's storage segment as an account id", async () => {
    const load = await loadWithUsers([user("alice", principalSegment("admin"))]);
    expect(load).toThrow(/bootstrap token's storage segment/);
  });

  it("refuses an id that is not shaped like a segment", async () => {
    const load = await loadWithUsers([user("alice", "alice")]);
    expect(load).toThrow(/Invalid configuration/);
  });
});

describe("account id formats", () => {
  it("mints random builtin ids with a readable prefix, never derived from the name alone", () => {
    const first = newBuiltinAccountId("Alice.Smith");
    const second = newBuiltinAccountId("Alice.Smith");
    expect(first).toMatch(ACCOUNT_ID_RE);
    expect(first).toMatch(/^alice_smith-[0-9a-f]{16}$/);
    expect(second).not.toBe(first);
    expect(newOidcAccountId()).toMatch(/^oidc-[0-9a-f]{16}$/);
    expect(accountIdSlug("  ")).toBe("u");
    expect(accountIdSlug("--x")).toBe("x");
  });

  it("keeps a principal's segment the formula it always had", () => {
    expect(principalSegment("telegram:12345")).toBe(safeUserSegment("telegram:12345"));
    expect(principalSegment("admin")).toMatch(ACCOUNT_ID_RE);
  });

  it("mints around an id already held (in any case) and around the bootstrap segment", async () => {
    const bootstrapHex = principalSegment("admin").slice(-16);
    const draws = ["0123456789abcdef", "1111111111111111", bootstrapHex, "2222222222222222"].map((hex) => Buffer.from(hex, "hex"));
    vi.doMock("node:crypto", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:crypto")>();
      return { ...actual, randomBytes: () => draws.shift()! };
    });
    vi.resetModules();
    try {
      const accounts = await import("../runtime/accounts.js");
      expect(accounts.mintBuiltinAccountId("alice", ["ALICE-0123456789abcdef"])).toBe("alice-1111111111111111");
      expect(accounts.mintBuiltinAccountId("admin", [])).toBe("admin-2222222222222222");
    } finally {
      vi.doUnmock("node:crypto");
    }
    expect(mintBuiltinAccountId("alice", [])).toMatch(ACCOUNT_ID_RE);
  });
});
