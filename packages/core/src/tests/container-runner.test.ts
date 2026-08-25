import { describe, expect, it } from "vitest";
import {
  buildContainerTaskPayload,
  parseContainerDiagnosticLine,
  probeDockerReachability,
  shouldExtendContainerTimeoutForRecentOutput,
} from "../agent/container-runner.js";
import { runWithRequestContext } from "../runtime/request-context.js";
import type { SubAgentRunOptions } from "../agent/sub-agent.js";
import type { ModelConfig, SubAgentConfig } from "../config/schema.js";
import {
  resolveDockerWorkspaceBind,
  resolveDockerWorkspaceMountSource,
  resolveHostWorkspacePath,
} from "../tools/workspace-mount.js";

describe("container runner diagnostics", () => {
  it("parses readiness markers with bootstrap timing", () => {
    expect(parseContainerDiagnosticLine("READY:187")).toEqual({
      type: "ready",
      bootstrapMs: 187,
    });
  });

  it("parses heartbeat markers", () => {
    expect(parseContainerDiagnosticLine("HEARTBEAT:1710600000000")).toEqual({
      type: "heartbeat",
    });
  });

  it("ignores non-diagnostic stderr lines", () => {
    expect(parseContainerDiagnosticLine("regular stderr output")).toBeNull();
  });

  it("extends hard timeouts while meaningful output is still arriving", () => {
    expect(shouldExtendContainerTimeoutForRecentOutput(55_000, 60_000, 0)).toBe(true);
  });

  it("does not extend hard timeouts when output has gone idle", () => {
    expect(shouldExtendContainerTimeoutForRecentOutput(49_000, 60_000, 0)).toBe(false);
    expect(shouldExtendContainerTimeoutForRecentOutput(undefined, 60_000, 0)).toBe(false);
  });

  it("stops extending hard timeouts after the bounded extension budget is exhausted", () => {
    expect(shouldExtendContainerTimeoutForRecentOutput(55_000, 60_000, 12)).toBe(false);
  });

  it("prefers an explicit workspace mount source for docker child containers", () => {
    expect(
      resolveDockerWorkspaceMountSource("/workspace", {
        mountSource: "/run/desktop/mnt/host/f/StarlingAI",
        fallbackVolume: "gc-workspace",
      }),
    ).toBe("/run/desktop/mnt/host/f/StarlingAI");
  });

  it("falls back to the shared workspace volume when no host mount source is provided", () => {
    expect(
      resolveDockerWorkspaceMountSource("/workspace/subdir", {
        mountSource: "",
        fallbackVolume: "gc-workspace",
      }),
    ).toBe("gc-workspace");
  });

  it("passes through non-default workspace paths unchanged", () => {
    expect(
      resolveDockerWorkspaceMountSource("/tmp/custom-workspace", {
        mountSource: "/run/desktop/mnt/host/f/StarlingAI",
        fallbackVolume: "gc-workspace",
      }),
    ).toBe("/tmp/custom-workspace");
  });

  it("probeDockerReachability resolves with reachable=true or returns a structured failure", async () => {
    // Real probe — environment-dependent, so we only assert structural shape.
    const result = await probeDockerReachability(3000);
    expect(typeof result.reachable).toBe("boolean");
    expect(typeof result.durationMs).toBe("number");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    if (result.reachable) {
      expect(result.serverVersion).toBeTruthy();
      expect(result.error).toBeUndefined();
    } else {
      expect(result.error).toBeTruthy();
    }
  }, 10_000);

  it("probeDockerReachability honors a tight timeout when docker is missing", async () => {
    // Override PATH so the docker binary cannot be found, forcing the spawn to fail
    // fast. This validates that probe failures surface as structured errors rather
    // than throwing.
    const originalPath = process.env["PATH"];
    process.env["PATH"] = "/nonexistent-path-for-test";
    try {
      const result = await probeDockerReachability(2000);
      expect(result.reachable).toBe(false);
      expect(result.error).toBeTruthy();
      expect(result.durationMs).toBeLessThan(3000);
    } finally {
      if (originalPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = originalPath;
    }
  }, 10_000);
});
/**
 * IDENTITY DOES NOT CROSS A PROCESS BOUNDARY BY ITSELF.
 *
 * Every in-process path keeps the owning user through AsyncLocalStorage: the turn establishes
 * it, each tool call re-establishes it, and a delegated sub-agent inherits it. A CONTAINERIZED
 * sub-agent is a different process with an empty store — and it is the DEFAULT execution mode
 * (agents.defaultContainerized defaults true). Anything inside it that resolves a per-user path
 * therefore resolved to the shared bucket while the gateway that spawned it resolved to the
 * user's, which is how a partitioned artifact zone would end up written in one place and looked
 * for in another.
 */
describe("the container payload carries the owning user", () => {
  const opts = (over: Partial<SubAgentRunOptions> = {}): SubAgentRunOptions => ({
    agentName: "web_coder",
    task: "build the page",
    parentSessionId: "sess-1",
    workspacePath: "/w",
    ...over,
  } as SubAgentRunOptions);
  const agentCfg = { tools: [] } as unknown as SubAgentConfig;
  const model = { primary: "lmstudio/qwen" } as unknown as ModelConfig;
  const build = (o: SubAgentRunOptions) => buildContainerTaskPayload(o, agentCfg, model, "http://x", "k");

  it("carries an explicitly threaded userId", () => {
    expect(build(opts({ userId: "alice" })).userId).toBe("alice");
  });

  it("falls back to the ambient turn user when the caller did not thread one", () => {
    // The same fallback the in-process runner uses (tools/registry.ts), so a call site that
    // predates the userId option still hands the container the real owner.
    const payload = runWithRequestContext({ userId: "bob" }, () => build(opts()));
    expect(payload.userId).toBe("bob");
  });

  it("carries nothing when there is nothing to carry — auth-off stays shared", () => {
    expect(build(opts()).userId).toBeUndefined();
  });

  it("never lets an ambient user override an explicit one", () => {
    const payload = runWithRequestContext({ userId: "bob" }, () => build(opts({ userId: "alice" })));
    expect(payload.userId).toBe("alice");
  });
});

/**
 * THE MOUNT SOURCE IS NOT THE WORKSPACE.
 *
 * The shipped compose deployment binds the REPO root at /workspace on purpose — the
 * self-improvement agents run git there — so the workspace is the `workspace/` directory
 * inside it, which is why SAI_WORKSPACE_CONFIG_PATH is `/workspace/workspace`. Two call sites
 * did not account for that offset, and both were verified wrong against the running stack:
 * `-v <repo>:/workspace/workspace` put the repo where the workspace should be, and
 * `/workspace/workspace/generated` came back "No such file or directory" with the real tree one
 * level deeper. Containerized sub-agents are the DEFAULT execution mode, so that was every
 * default sub-agent addressing a workspace that was not there.
 */
describe("workspace binds account for the mount source's offset", () => {
  const DOCKERIZED = { mountSource: "/run/desktop/mnt/host/f/StarlingAI", fallbackVolume: "gc-workspace" };

  it("binds the host equivalent of the path it was handed, at that same path", () => {
    // The off-by-one was `<source>:/workspace/workspace`, which put the REPO where the workspace
    // should be. The fix maps the container path to its host equivalent instead — and binding
    // exactly that directory is also what makes a per-user root a boundary rather than a
    // convention: there is no sibling in the mount to reach.
    expect(resolveDockerWorkspaceBind("/workspace/workspace", DOCKERIZED))
      .toBe("/run/desktop/mnt/host/f/StarlingAI/workspace:/workspace/workspace");
  });

  it("binds only the user's own root when the workspace is partitioned", () => {
    expect(resolveDockerWorkspaceBind("/workspace/workspace/users/alice-abc123", DOCKERIZED))
      .toBe("/run/desktop/mnt/host/f/StarlingAI/workspace/users/alice-abc123:/workspace/workspace/users/alice-abc123");
  });

  it("falls back to the whole tree when the source is a volume it cannot subdivide", () => {
    expect(resolveDockerWorkspaceBind("/workspace/workspace", { mountSource: "", fallbackVolume: "gc-workspace" }))
      .toBe("gc-workspace:/workspace");
  });

  it("binds at the workspace's own path when the source IS the workspace", () => {
    // Outside a container there is no /workspace mapping; the in-container tools resolve
    // against the same absolute path the host uses.
    expect(resolveDockerWorkspaceBind("/srv/sai/workspace", { mountSource: "", fallbackVolume: "" }))
      .toBe("/srv/sai/workspace:/srv/sai/workspace");
  });

  it("re-applies the workspace offset when building a host path for a subdirectory", () => {
    // serve_app binds ONE app directory, so it needs the host path rather than the tree.
    expect(resolveHostWorkspacePath("/workspace/workspace", "generated/my-app", DOCKERIZED))
      .toBe("/run/desktop/mnt/host/f/StarlingAI/workspace/generated/my-app");
  });

  it("adds no offset when the workspace is not under /workspace", () => {
    expect(resolveHostWorkspacePath("/srv/sai/workspace", "generated/my-app", { mountSource: "", fallbackVolume: "" }))
      .toBe("/srv/sai/workspace/generated/my-app");
  });

  it("refuses to build a host path out of a named volume", () => {
    // A volume has no host path to append to; the old code produced "gc-workspace/generated/x"
    // and docker created a directory of that name.
    expect(resolveHostWorkspacePath("/workspace/workspace", "generated/my-app", { mountSource: "", fallbackVolume: "gc-workspace" }))
      .toBeNull();
  });
});
