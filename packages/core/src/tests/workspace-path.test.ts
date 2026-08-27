import { afterEach, describe, expect, it, vi } from "vitest";
import { join, resolve } from "node:path";
import { resolvePathWithinWorkspace, resolveWorkspaceWritePath, generatedZoneRel, userWorkspaceRoot, deploymentWorkspaceRoot, GENERATED_SUBDIR } from "../tools/workspace-path.js";
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

import { PROTECTED_WORKSPACE_ZONES } from "../tools/workspace-mount.js";

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
      { auth: { enabled } } as unknown as ReturnType<typeof configLoader.getConfig>,
    );
  };
  const asUser = <T,>(userId: string, fn: () => T): T => runWithRequestContext({ userId }, fn);
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
    const r = runWithRequestContext({ userId: "alice", workspaceScope: "generated" },
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
