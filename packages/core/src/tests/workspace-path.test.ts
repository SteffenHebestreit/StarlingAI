import { afterEach, describe, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolvePathWithinWorkspace, resolveWorkspaceWritePath, resolveLiteralWorkspacePath, withoutRepeatedWorkspaceRoot, generatedZoneRel, userWorkspaceRoot, deploymentWorkspaceRoot, GENERATED_SUBDIR } from "../tools/workspace-path.js";
import { runWithRequestContext } from "../runtime/request-context.js";
import { safeUserSegment } from "../runtime/user-scope.js";
import * as configLoader from "../config/loader.js";

const WS = resolve("/tmp/ws");

describe("resolveWorkspaceWritePath", () => {
  it("roots a bare relative path under generated/", () => {
    const r = resolveWorkspaceWritePath("index.html", WS);
    expect(r.relativePath).toBe("generated/index.html");
    expect(r.resolved).toBe(resolve(WS, "generated", "index.html"));
  });

  it("roots nested project paths under generated/", () => {
    const r = resolveWorkspaceWritePath("site/css/app.css", WS);
    expect(r.relativePath).toBe("generated/site/css/app.css");
  });

  it("strips the /workspace virtual prefix then roots under generated/", () => {
    const r = resolveWorkspaceWritePath("/workspace/report.md", WS);
    expect(r.relativePath).toBe("generated/report.md");
  });

  it("is idempotent for paths already inside generated/", () => {
    const r = resolveWorkspaceWritePath(`${GENERATED_SUBDIR}/site/index.html`, WS);
    expect(r.relativePath).toBe("generated/site/index.html");
    expect(r.relativePath.startsWith("generated/generated")).toBe(false);
  });

  it("rejects paths escaping the workspace", () => {
    expect(() => resolveWorkspaceWritePath("../../etc/passwd", WS)).toThrow(/escapes workspace boundary/);
  });

  it("leaves reads workspace-wide (resolvePathWithinWorkspace is unchanged)", () => {
    // Reads must still reach the config zone, e.g. a scene definition.
    const r = resolvePathWithinWorkspace("scenes/10-scenes.jsonc", WS);
    expect(r.relativePath).toBe("scenes/10-scenes.jsonc");
    expect(r.relativePath.startsWith("generated/")).toBe(false);
  });
});

/**
 * Workspace zoning (audit 0ac7d3fc): scope-confined agents (the sub-agent default)
 * see only generated/ + uploads/; everything else re-roots into generated/ so a
 * working agent physically cannot wander into the platform's config zones or burn
 * minutes reading its docs. Core agents (workspaceAccess:"full") and runtime code
 * paths run without the scope and keep the whole workspace.
 */
describe("workspace zoning — scope-confined path resolution", () => {
  const scoped = <T>(fn: () => T): T => runWithRequestContext({ workspaceScope: "generated" }, fn);

  it("re-roots config-zone reads into generated/ under scope", () => {
    const r = scoped(() => resolvePathWithinWorkspace("README.md", WS));
    expect(r.relativePath).toBe("generated/README.md");
    const cfg = scoped(() => resolvePathWithinWorkspace("scenes/10-scenes.jsonc", WS));
    expect(cfg.relativePath).toBe("generated/scenes/10-scenes.jsonc");
  });

  it("re-roots the workspace root listing into generated/ under scope", () => {
    const r = scoped(() => resolvePathWithinWorkspace(".", WS));
    expect(r.relativePath).toBe(GENERATED_SUBDIR);
    expect(r.resolved).toBe(resolve(WS, GENERATED_SUBDIR));
  });

  it("keeps generated/ and uploads/ visible verbatim under scope", () => {
    expect(scoped(() => resolvePathWithinWorkspace("generated/site/index.html", WS)).relativePath)
      .toBe("generated/site/index.html");
    expect(scoped(() => resolvePathWithinWorkspace("uploads/brief.pdf", WS)).relativePath)
      .toBe("uploads/brief.pdf");
  });

  it("keeps read-after-write consistent: bare write target and bare read resolve to the same file", () => {
    const written = scoped(() => resolveWorkspaceWritePath("index.html", WS));
    const read = scoped(() => resolvePathWithinWorkspace("index.html", WS));
    expect(read.resolved).toBe(written.resolved);
  });

  it("does not double-root writes under scope", () => {
    const r = scoped(() => resolveWorkspaceWritePath("site/app.css", WS));
    expect(r.relativePath).toBe("generated/site/app.css");
    expect(r.relativePath.includes("generated/generated")).toBe(false);
  });

  it("still rejects workspace escapes under scope", () => {
    expect(() => scoped(() => resolvePathWithinWorkspace("../../etc/passwd", WS))).toThrow(/escapes workspace boundary/);
  });

  it("full scope and no scope leave resolution unchanged", () => {
    const full = runWithRequestContext({ workspaceScope: "full" }, () => resolvePathWithinWorkspace("README.md", WS));
    expect(full.relativePath).toBe("README.md");
    const unscoped = resolvePathWithinWorkspace("README.md", WS);
    expect(unscoped.relativePath).toBe("README.md");
  });
});

import { PROTECTED_WORKSPACE_ZONES, toSandboxPath } from "../tools/workspace-mount.js";

describe("write-zoning: scope-confined agents cannot write live-config zones via file tools", () => {
  it("re-roots a scoped agent's write to a config zone into generated/ (deny-by-reroot)", () => {
    for (const zone of PROTECTED_WORKSPACE_ZONES) {
      runWithRequestContext({ workspaceScope: "generated" }, () => {
        const r = resolveWorkspaceWritePath(`${zone}/50-authored-evil.jsonc`, WS);
        // The write never lands in the live config zone — it's rooted under generated/.
        expect(r.relativePath).toBe(`generated/${zone}/50-authored-evil.jsonc`);
        expect(r.relativePath.startsWith(`${zone}/`)).toBe(false);
      });
    }
  });

  it("a 'full' (maintenance) agent writes config zones literally", () => {
    runWithRequestContext({ workspaceScope: "full" }, () => {
      const r = resolveWorkspaceWritePath("agents/50-authored-ok.jsonc", WS);
      expect(r.relativePath).toBe("agents/50-authored-ok.jsonc");
    });
  });
});

/**
 * ONE ARTIFACT ZONE, TWO ACCOUNTS.
 *
 * `generated/` is a single directory shared by every turn the deployment has ever run. With one
 * operator that is fine; with two accounts it means one user's half-finished build is evidence
 * to the other's resume detection, and every artifact is readable by anyone holding a token.
 * Durable memory, the user-model and personality already partition per account — these pin the
 * same rule for the working zone.
 *
 * The gate is a PRESENT AMBIENT USER, never the auth flag alone: an unattended run under
 * multi-user auth has no user to partition by and must keep writing where it always did,
 * rather than into a bucket named after nobody.
 */
describe("the workspace root is per-user", () => {
  const SHARED = resolve("/tmp/ws");
  const mockAuth = (enabled: boolean): void => {
    vi.spyOn(configLoader, "getConfig").mockReturnValue(
      // A workspace with no account registry in it: no account holds any name, so a bare name
      // is a principal's, in the bucket it always had.
      { auth: { enabled, users: [] }, workspacePath: resolve(tmpdir(), "sai-scope-no-registry") } as unknown as ReturnType<typeof configLoader.getConfig>,
    );
  };
  const asUser = <T,>(userId: string, fn: () => T): T => runWithRequestContext({ identity: { userId } }, fn);
  const aliceRoot = () => resolve(SHARED, "users", safeUserSegment("alice"));

  afterEach(() => { vi.restoreAllMocks(); });

  it("is a no-op with auth off — the single-operator default is untouched", () => {
    mockAuth(false);
    expect(asUser("alice", () => userWorkspaceRoot(SHARED))).toBe(SHARED);
  });

  it("is a no-op with auth ON but no ambient user — an unattended run stays shared", () => {
    // The trap: gating on the flag alone sends a scheduled job, an inbound MCP call or a webhook
    // trigger into a root named after nobody, and splits one logical workspace in two.
    mockAuth(true);
    expect(userWorkspaceRoot(SHARED)).toBe(SHARED);
  });

  it("gives each account its own root under the shared one", () => {
    mockAuth(true);
    expect(asUser("alice", () => userWorkspaceRoot(SHARED))).toBe(aliceRoot());
    expect(asUser("bob", () => userWorkspaceRoot(SHARED))).not.toBe(aliceRoot());
  });

  it("leaves a root that already is the user's as it is, however often it was nested", () => {
    // A restored session hands its persisted root back in, and so does a workflow run with the
    // caller's root and id: each pass nested it once more, <shared>/users/<seg>/users/<seg>, a
    // directory with none of the user's memory in it (found in review, 2026-10-08).
    mockAuth(true);
    const segment = safeUserSegment("alice");
    const doubled = resolve(aliceRoot(), "users", segment);
    expect(asUser("alice", () => userWorkspaceRoot(aliceRoot()))).toBe(aliceRoot());
    expect(asUser("alice", () => userWorkspaceRoot(doubled))).toBe(aliceRoot());
    expect(asUser("alice", () => userWorkspaceRoot(resolve(doubled, "users", segment)))).toBe(aliceRoot());
    // Only the user's own segment is taken back: any other directory stays the root it is.
    const elsewhere = resolve(SHARED, "users", "someone-0123456789abcdef");
    expect(asUser("alice", () => userWorkspaceRoot(elsewhere))).toBe(resolve(elsewhere, "users", segment));
  });

  it("puts the working zones inside that root, with no second partition", () => {
    // The zone name stays plain: the user segment lives in the ROOT, and applying it here too
    // would produce <root>/users/<seg>/generated/users/<seg>.
    mockAuth(true);
    expect(asUser("alice", () => generatedZoneRel())).toBe(GENERATED_SUBDIR);
    const r = asUser("alice", () => resolveWorkspaceWritePath("app/index.html", aliceRoot()));
    expect(r.relativePath).toBe("generated/app/index.html");
    expect(r.resolved).toBe(resolve(aliceRoot(), "generated/app/index.html"));
  });

  it("makes a sibling account unreachable by the boundary that already existed", () => {
    // No new refusal rule: another account is simply outside this root, so it escapes the
    // workspace boundary exactly like any other outside path. That is the point of moving the
    // partition up — a mount of this root has no sibling in it to reach.
    mockAuth(true);
    const bobSegment = safeUserSegment("bob");
    expect(() => asUser("alice", () => resolvePathWithinWorkspace(`../${bobSegment}/generated/x`, aliceRoot())))
      .toThrow(/escapes workspace boundary/);
  });

  it("keeps the config zones out of the user root, where the shared root still has them", () => {
    // agents/ jobs/ scenes/ tools/ describe the DEPLOYMENT and are swept by the config loader.
    // They live at the shared root; the two workspaceAccess:"full" agents work from there.
    mockAuth(true);
    expect(asUser("alice", () => userWorkspaceRoot(SHARED)).startsWith(SHARED)).toBe(true);
    expect(asUser("alice", () => userWorkspaceRoot(SHARED))).not.toBe(SHARED);
  });

  it("still re-roots a scope-confined agent into its own working zone", () => {
    mockAuth(true);
    const r = runWithRequestContext({ identity: { userId: "alice" }, workspaceScope: "generated" },
      () => resolvePathWithinWorkspace("agents/10-core-agents.jsonc", aliceRoot()));
    expect(r.relativePath).toBe("generated/agents/10-core-agents.jsonc");
    expect(r.resolved.startsWith(aliceRoot())).toBe(true);
  });
});

describe("deploymentWorkspaceRoot", () => {
  // The inverse of userWorkspaceRoot, for the ledgers that describe the DEPLOYMENT rather than a
  // person. Code holding only its own execution root would otherwise read one account's slice of
  // them — which is empty, and silently so: an agent's lessons simply stop appearing.
  it("maps a per-user root back to the shared one", () => {
    expect(deploymentWorkspaceRoot(join("/srv", "workspace", "users", "steffen-67913ee9be1346dc")))
      .toBe(join("/srv", "workspace"));
  });

  it("leaves a root that is not per-user alone", () => {
    expect(deploymentWorkspaceRoot(join("/srv", "workspace"))).toBe(join("/srv", "workspace"));
    expect(deploymentWorkspaceRoot(join("/tmp", "some-test-dir"))).toBe(join("/tmp", "some-test-dir"));
    // "users" as a leaf is a directory named users, not a per-user root.
    expect(deploymentWorkspaceRoot(join("/srv", "workspace", "users")))
      .toBe(join("/srv", "workspace", "users"));
  });

  it("round-trips with userWorkspaceRoot", () => {
    const shared = join("/srv", "workspace");
    const perUser = join(shared, "users", "someone-0123456789abcdef");
    expect(deploymentWorkspaceRoot(perUser)).toBe(shared);
  });
});

/**
 * A RELATIVE PATH THAT REPEATS THE ROOT.
 *
 * Every sub-agent is told "Current workspace: <root>", /workspace/workspace/users/<segment> in the
 * compose deployment, and writes relative paths that start with that root's tail. Taken as
 * relative, `workspace/users/<segment>/x.html` landed at generated/workspace/users/<segment>/x.html,
 * a read of `x.html` found nothing, and the agent wrote the whole file again (E2E, several runs). Such
 * a path names what the plain name names, for every resolver in every scope.
 */
describe("a relative path that repeats the workspace root", () => {
  const SEGMENT = "eval-19e81d52fcab8153";
  const OTHER = "bob-0123456789abcdef";
  // The compose deployment's roots, as the platform running the test spells them.
  const SHARED = resolve("/workspace/workspace");
  const ACCOUNT = resolve(SHARED, "users", SEGMENT);
  const REPEATED = [
    `workspace/users/${SEGMENT}/a.html`,
    `users/${SEGMENT}/a.html`,
    `workspace/workspace/users/${SEGMENT}/a.html`,
    `generated/workspace/users/${SEGMENT}/a.html`,
  ];

  type Scope = "generated" | "full" | undefined;
  const SCOPES: Scope[] = ["generated", undefined, "full"];
  const inScope = <T,>(scope: Scope, fn: () => T): T => (scope ? runWithRequestContext({ workspaceScope: scope }, fn) : fn());
  const RESOLVERS = { write: resolveWorkspaceWritePath, read: resolvePathWithinWorkspace, literal: resolveLiteralWorkspacePath };

  /** Every resolver, in every scope, resolves `path` where it resolves `plain`. */
  const expectSameAs = (path: string, plain: string, root: string): void => {
    for (const scope of SCOPES) {
      for (const [resolver, resolveIt] of Object.entries(RESOLVERS)) {
        const got = inScope(scope, () => resolveIt(path, root));
        const want = inScope(scope, () => resolveIt(plain, root));
        expect({ path, scope, resolver, at: got.relativePath }).toEqual({ path, scope, resolver, at: want.relativePath });
        expect(got.resolved).toBe(want.resolved);
      }
    }
  };

  it("writes a scope-confined agent's file where the plain name goes, and reads it back by that name", () => {
    for (const path of REPEATED) {
      const written = inScope("generated", () => resolveWorkspaceWritePath(path, ACCOUNT));
      expect({ path, at: written.relativePath }).toEqual({ path, at: "generated/a.html" });
      expect(inScope("generated", () => resolvePathWithinWorkspace("a.html", ACCOUNT)).resolved).toBe(written.resolved);
      expect(inScope("generated", () => resolvePathWithinWorkspace(path, ACCOUNT)).resolved).toBe(written.resolved);
    }
  });

  it("writes an unscoped caller's file where the plain name goes, and reads it back by the name it was given", () => {
    // Unscoped reads are workspace-wide, so the name that reads it back is the one the write returned.
    for (const path of REPEATED) {
      const written = resolveWorkspaceWritePath(path, ACCOUNT);
      expect({ path, at: written.relativePath }).toEqual({ path, at: "generated/a.html" });
      expect(resolvePathWithinWorkspace(written.relativePath, ACCOUNT).resolved).toBe(written.resolved);
      expect(resolvePathWithinWorkspace(`generated/workspace/users/${SEGMENT}/a.html`, ACCOUNT).resolved).toBe(written.resolved);
    }
  });

  it("names what the plain name names, for every resolver in every scope", () => {
    for (const path of REPEATED.slice(0, 3)) expectSameAs(path, "a.html", ACCOUNT);
    expectSameAs(`${SEGMENT}/a.html`, "a.html", ACCOUNT);
    // The doubled form the generated/ rooting made, and what an earlier turn reported.
    expectSameAs(`generated/workspace/users/${SEGMENT}/a.html`, "generated/a.html", ACCOUNT);
    expectSameAs(`generated/users/${SEGMENT}/site/index.html`, "generated/site/index.html", ACCOUNT);
    // However often it repeats, and however the two nest.
    expectSameAs(`users/${SEGMENT}/users/${SEGMENT}/a.html`, "a.html", ACCOUNT);
    expectSameAs(`workspace/users/${SEGMENT}/generated/users/${SEGMENT}/a.png`, "generated/a.png", ACCOUNT);
    // The root itself, in any case and with either separator.
    expectSameAs(`./workspace/users/${SEGMENT}/`, ".", ACCOUNT);
    expectSameAs(`Users\\${SEGMENT.toUpperCase()}\\a.html`, "a.html", ACCOUNT);
  });

  it("keeps the shared root's real users/ zone: another account's path there is not the root", () => {
    // Auth off, or a full-scope agent: the root is the shared one, and users/<segment> in it is
    // that account's directory.
    const other = `users/${OTHER}/notes.md`;
    for (const scope of SCOPES) {
      expect(inScope(scope, () => resolveLiteralWorkspacePath(other, SHARED)).relativePath).toBe(other);
    }
    expect(inScope("full", () => resolveWorkspaceWritePath(other, SHARED)).relativePath).toBe(other);
    expect(resolvePathWithinWorkspace(other, SHARED).relativePath).toBe(other);
    // Two segments of the shared root's own path in front of it are the root.
    expectSameAs(`workspace/workspace/${other}`, other, SHARED);
    expectSameAs("workspace/workspace/a.html", "a.html", SHARED);
  });

  it("drops nothing on the root's plain name alone where the root is not an account's", () => {
    // The shared root ends in `workspace`, an ordinary name in it: `workspace/index.html` next to
    // `index.html` are two files, and so are generated/workspace/app.js and generated/app.js, and a
    // Bazel WORKSPACE file is a file, not the root (review 2026-10-12).
    const twoFiles: Array<[string, string]> = [
      ["workspace/index.html", "index.html"],
      [`workspace/users/${OTHER}/notes.md`, `users/${OTHER}/notes.md`],
      ["generated/workspace/app.js", "generated/app.js"],
      ["Workspace/BUILD", "BUILD"],
    ];
    for (const [path, plain] of twoFiles) {
      expect(withoutRepeatedWorkspaceRoot(path, SHARED)).toBe(path);
      for (const scope of SCOPES) {
        for (const [resolver, resolveIt] of Object.entries(RESOLVERS)) {
          const same = inScope(scope, () => resolveIt(path, SHARED)).resolved === inScope(scope, () => resolveIt(plain, SHARED)).resolved;
          expect({ path, scope, resolver, same }).toEqual({ path, scope, resolver, same: false });
        }
      }
    }
    expect(withoutRepeatedWorkspaceRoot("WORKSPACE", SHARED)).toBe("WORKSPACE");
    for (const scope of SCOPES) {
      expect(inScope(scope, () => resolveLiteralWorkspacePath("WORKSPACE", SHARED)).relativePath).toBe("WORKSPACE");
    }
    // An account's root ends in its id, which nothing else in it is named: one segment is enough.
    expectSameAs(`${SEGMENT}/a.html`, "a.html", ACCOUNT);
  });

  it("takes a name that is on disk as named, and drops a repeated root only from one that is not", () => {
    // Files a turn left under a repeated root before the rule are still there, and listed under that
    // name: a read, an edit or a delete of that name is of that file (review 2026-10-12).
    const base = mkdtempSync(join(tmpdir(), "sai-repeated-root-"));
    try {
      const account = join(base, "users", SEGMENT);
      const legacy = join(account, "generated", "users", SEGMENT);
      mkdirSync(legacy, { recursive: true });
      writeFileSync(join(legacy, "old.html"), "stale", "utf8");
      writeFileSync(join(account, "generated", "old.html"), "current", "utf8");
      const named = `generated/users/${SEGMENT}/old.html`;
      for (const scope of SCOPES) {
        for (const [resolver, resolveIt] of Object.entries(RESOLVERS)) {
          expect({ scope, resolver, at: inScope(scope, () => resolveIt(named, account)).relativePath })
            .toEqual({ scope, resolver, at: named });
        }
      }
      // A scope-confined agent's own spelling of it, re-rooted into its zone, is there too.
      expect(inScope("generated", () => resolvePathWithinWorkspace(`users/${SEGMENT}/old.html`, account)).relativePath).toBe(named);
      expect(inScope("generated", () => resolveWorkspaceWritePath(`users/${SEGMENT}/old.html`, account)).relativePath).toBe(named);
      // The directory, as listed.
      expect(inScope("generated", () => resolvePathWithinWorkspace(`generated/users/${SEGMENT}`, account)).relativePath)
        .toBe(`generated/users/${SEGMENT}`);
      // A name that is not there yet still lands where the plain name goes, beside the old files.
      expect(inScope("generated", () => resolveWorkspaceWritePath(`users/${SEGMENT}/new.html`, account)).relativePath)
        .toBe("generated/new.html");
      expect(inScope("generated", () => resolveWorkspaceWritePath(`generated/users/${SEGMENT}/new.html`, account)).relativePath)
        .toBe("generated/new.html");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("keeps a path that shares only segments before the root's last", () => {
    for (const path of [
      "workspace/a.html",
      "workspace/users/a.html",
      "users/a.html",
      `users/${OTHER}/a.html`,
      `workspace/workspace/users/${OTHER}/a.html`,
      `generated/users/${OTHER}/a.html`,
      `${SEGMENT}-old/a.html`,
    ]) {
      expect(withoutRepeatedWorkspaceRoot(path, ACCOUNT)).toBe(path);
      for (const scope of SCOPES) {
        expect({ path, scope, at: inScope(scope, () => resolveLiteralWorkspacePath(path, ACCOUNT)).relativePath })
          .toEqual({ path, scope, at: path });
      }
    }
  });

  it("matches a Windows root and a POSIX one, in any case and with either separator", () => {
    const windowsShared = "C:\\Users\\steffen\\StarlingAI\\workspace";
    const windowsAccount = `${windowsShared}\\users\\acct-0123456789abcdef`;
    expect(withoutRepeatedWorkspaceRoot("workspace/a.html", windowsShared)).toBe("workspace/a.html");
    expect(withoutRepeatedWorkspaceRoot("StarlingAI\\Workspace\\a.html", windowsShared)).toBe("a.html");
    expect(withoutRepeatedWorkspaceRoot("Users/steffen/StarlingAI/workspace/a.html", windowsShared)).toBe("a.html");
    expect(withoutRepeatedWorkspaceRoot("Users/steffen/a.html", windowsShared)).toBe("Users/steffen/a.html");
    expect(withoutRepeatedWorkspaceRoot("users/acct-0123456789abcdef/a.html", windowsShared)).toBe("users/acct-0123456789abcdef/a.html");
    expect(withoutRepeatedWorkspaceRoot("users/ACCT-0123456789ABCDEF/a.html", windowsAccount)).toBe("a.html");
    expect(withoutRepeatedWorkspaceRoot("generated\\workspace\\users\\acct-0123456789abcdef\\a.html", windowsAccount)).toBe("generated/a.html");

    const posixShared = "/home/x/ws";
    expect(withoutRepeatedWorkspaceRoot("ws/a.html", posixShared)).toBe("ws/a.html");
    expect(withoutRepeatedWorkspaceRoot("x/ws/a.html", posixShared)).toBe("a.html");
    expect(withoutRepeatedWorkspaceRoot("X/WS/ws/a.html", posixShared)).toBe("ws/a.html");
    expect(withoutRepeatedWorkspaceRoot("home/x/ws/a.html", posixShared)).toBe("a.html");
    expect(withoutRepeatedWorkspaceRoot("x/a.html", posixShared)).toBe("x/a.html");
    expect(withoutRepeatedWorkspaceRoot("home/a.html", posixShared)).toBe("home/a.html");
    expect(withoutRepeatedWorkspaceRoot("wsx/a.html", posixShared)).toBe("wsx/a.html");
  });

  it("reaches nothing the path did not, and returns one with nothing to drop as it came", () => {
    // Normalized first: what is left of the path once its `..` are applied is what is matched.
    expect(withoutRepeatedWorkspaceRoot(`users/${SEGMENT}/../../etc/passwd`, ACCOUNT)).toBe(`users/${SEGMENT}/../../etc/passwd`);
    expect(withoutRepeatedWorkspaceRoot(`../${SEGMENT}/a.html`, ACCOUNT)).toBe(`../${SEGMENT}/a.html`);
    expect(() => resolvePathWithinWorkspace(`users/${SEGMENT}/../../../x`, ACCOUNT)).toThrow(/escapes workspace boundary/);
    expect(withoutRepeatedWorkspaceRoot("site\\index.html", ACCOUNT)).toBe("site\\index.html");
    expect(withoutRepeatedWorkspaceRoot("a.html", resolve("/"))).toBe("a.html");
  });

  it("takes an absolute path inside the root as it is, where a sandbox has it too", () => {
    // The root every sub-agent is told, written back. In a container it starts with /workspace,
    // which the resolvers otherwise read as a sandbox's view of the root.
    const told = `/workspace/workspace/users/${SEGMENT}`;
    expectSameAs(`${told}/a.html`, "a.html", ACCOUNT);
    expectSameAs(told, ".", ACCOUNT);
    // As it is: a repeated root after it is a directory a turn left there, which this names exactly.
    expect(inScope("generated", () => resolvePathWithinWorkspace(`${told}/generated/users/${SEGMENT}/a.html`, ACCOUNT)).relativePath)
      .toBe(`generated/users/${SEGMENT}/a.html`);
    // Where it does not lead into the root, /workspace is still a sandbox's view of it.
    expectSameAs("/workspace/a.html", "a.html", ACCOUNT);
    // A sandbox has that path, and what the resolvers made of it, at the same place, mapped once.
    expect(toSandboxPath(`${told}/a.html`, told)).toBe("/workspace/a.html");
    expect(toSandboxPath(resolveLiteralWorkspacePath(`${told}/a.html`, ACCOUNT).resolved, ACCOUNT)).toBe("/workspace/a.html");
  });
});
