import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";
import { resolvePathWithinWorkspace, resolveWorkspaceWritePath, generatedZoneRel, GENERATED_SUBDIR } from "../tools/workspace-path.js";
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
describe("the artifact zone partitions per user", () => {
  const WSP = resolve("/tmp/ws");
  const mockAuth = (enabled: boolean): void => {
    vi.spyOn(configLoader, "getConfig").mockReturnValue(
      { auth: { enabled } } as unknown as ReturnType<typeof configLoader.getConfig>,
    );
  };
  const asUser = <T,>(userId: string, fn: () => T): T => runWithRequestContext({ userId }, fn);
  const alice = () => `generated/users/${safeUserSegment("alice")}`;

  afterEach(() => { vi.restoreAllMocks(); });

  it("is a no-op with auth off — the single-operator default is untouched", () => {
    mockAuth(false);
    expect(asUser("alice", () => generatedZoneRel())).toBe(GENERATED_SUBDIR);
    expect(asUser("alice", () => resolveWorkspaceWritePath("index.html", WSP)).relativePath)
      .toBe("generated/index.html");
  });

  it("is a no-op with auth ON but no ambient user — an unattended run stays shared", () => {
    // The trap this avoids: gating on the flag alone sends a scheduled job, an inbound MCP
    // call or a webhook trigger into a bucket named after nobody, and splits one logical zone
    // across two locations depending on which entry point wrote it.
    mockAuth(true);
    expect(generatedZoneRel()).toBe(GENERATED_SUBDIR);
    expect(resolveWorkspaceWritePath("index.html", WSP).relativePath).toBe("generated/index.html");
  });

  it("roots a write into the ambient user's partition", () => {
    mockAuth(true);
    const r = asUser("alice", () => resolveWorkspaceWritePath("app/index.html", WSP));
    expect(r.relativePath).toBe(`${alice()}/app/index.html`);
    expect(r.resolved).toBe(resolve(WSP, r.relativePath));
  });

  it("re-roots the `generated/...` form every tool description teaches", () => {
    // THE CASE THAT DECIDES WHETHER THIS WORKS AT ALL. Prompts, tool descriptions and the
    // stub-marker paths the runner reports all use `generated/x` — if that short-circuits as
    // "already rooted" it lands in the shared zone and the partition is decorative.
    mockAuth(true);
    expect(asUser("alice", () => resolveWorkspaceWritePath("generated/app/index.html", WSP)).relativePath)
      .toBe(`${alice()}/app/index.html`);
    expect(asUser("alice", () => resolvePathWithinWorkspace("generated/app/index.html", WSP)).relativePath)
      .toBe(`${alice()}/app/index.html`);
  });

  it("keeps read-after-write on the same file, whichever form is used", () => {
    mockAuth(true);
    const written = asUser("alice", () => resolveWorkspaceWritePath("app/index.html", WSP));

    // Zone-addressed forms resolve to the written file from any execution: this is the
    // property the partition had to preserve, since `generated/app/index.html` is what tool
    // output, prompts and artifact records hand back to the model.
    for (const form of ["generated/app/index.html", written.relativePath]) {
      expect(asUser("alice", () => resolvePathWithinWorkspace(form, WSP)).resolved).toBe(written.resolved);
    }

    // The BARE form resolves workspace-wide unless the agent is scope-confined — unchanged
    // pre-existing behaviour (see "leaves reads workspace-wide" above). Under the scope every
    // real agent runs with, it lands on the same file the write did.
    const scoped = runWithRequestContext({ userId: "alice", workspaceScope: "generated" },
      () => resolvePathWithinWorkspace("app/index.html", WSP));
    expect(scoped.resolved).toBe(written.resolved);
  });

  it("refuses a path that names another account's partition", () => {
    mockAuth(true);
    const bobs = `generated/users/${safeUserSegment("bob")}/secret.html`;
    expect(() => asUser("alice", () => resolvePathWithinWorkspace(bobs, WSP)))
      .toThrow(/another user's artifact zone/);
    expect(() => asUser("alice", () => resolveWorkspaceWritePath(bobs, WSP)))
      .toThrow(/another user's artifact zone/);
  });

  it("gives two accounts two zones, and neither the bare one", () => {
    mockAuth(true);
    const a = asUser("alice", () => resolveWorkspaceWritePath("index.html", WSP)).resolved;
    const b = asUser("bob", () => resolveWorkspaceWritePath("index.html", WSP)).resolved;
    expect(a).not.toBe(b);
    expect(a).not.toBe(resolve(WSP, "generated", "index.html"));
  });

  it("keeps the TOP segment `generated`, which the zone-membership tests read", () => {
    // SCOPED_VISIBLE_ZONES and the config loader's non-config sweep both test the depth-0
    // directory name. A partition that changed it would drag the whole subtree into the
    // config merge.
    mockAuth(true);
    expect(asUser("alice", () => generatedZoneRel()).split("/")[0]).toBe(GENERATED_SUBDIR);
  });

  it("still re-roots a scope-confined agent out of the platform zones, into its own partition", () => {
    mockAuth(true);
    const r = runWithRequestContext({ userId: "alice", workspaceScope: "generated" },
      () => resolvePathWithinWorkspace("agents/10-core-agents.jsonc", WSP));
    expect(r.relativePath).toBe(`${alice()}/agents/10-core-agents.jsonc`);
  });
});
