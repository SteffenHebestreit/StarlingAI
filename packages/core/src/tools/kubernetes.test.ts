import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("../credentials/store.js", () => ({
  getCredential: vi.fn(() => undefined),
}));

async function setupLocalCliProfile(overrides: Record<string, unknown> = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-k8s-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    infrastructure: {
      automation: {
        defaultProfile: "prod",
        profiles: {
          prod: {
            type: "local-cli",
            kubectlBinary: "kubectl",
            helmBinary: "helm",
            kubeconfigPath: "/var/starling/kubeconfig",
            defaultKubeContext: "prod-eu",
            ...overrides,
          },
        },
      },
    },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  return tempDir;
}

describe("kubernetes tools", () => {
  const cleanup: string[] = [];

  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    for (const dir of cleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    delete process.env["SAI_CONFIG_PATH"];
    vi.resetModules();
  });

  it("registers all Wave 1 K8s read-only tools", async () => {
    const [{ getAllTools }] = await Promise.all([
      import("./registry.js"),
      import("./kubernetes.js"),
    ]);
    const toolNames = getAllTools().map((t) => t.name);
    expect(toolNames).toEqual(expect.arrayContaining([
      "kubectl_get",
      "kubectl_describe",
      "kubectl_logs",
      "kubectl_top",
      "helm_list",
    ]));
  });

  it("registers all Wave 2 K8s mutate tools with approval-gated tiers", async () => {
    const [{ getAllTools }, { getToolTier }] = await Promise.all([
      import("./registry.js"),
      import("../guardrails/tool-tiers.js"),
      import("./kubernetes.js"),
    ]);
    const names = getAllTools().map((t) => t.name);
    const mutate = [
      "kubectl_apply",
      "kubectl_delete",
      "kubectl_rollout_restart",
      "kubectl_scale",
      "helm_upgrade",
      "helm_rollback",
    ];
    expect(names).toEqual(expect.arrayContaining(mutate));
    for (const name of mutate) {
      const def = getToolTier(name);
      expect(def.tier).toBe(3);
      expect(def.requiresPerCallApproval).toBe(true);
    }
  });

  it("kubectl_get assembles resource, namespace, selector, and output flags", async () => {
    cleanup.push(await setupLocalCliProfile());
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, { stdout: "NAME\tSTATUS\nweb-1\tRunning", stderr: "" });
    });

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./kubernetes.js"),
    ]);

    const result = await getTool("kubectl_get")!.execute({
      resource: "pods",
      namespace: "api",
      labelSelector: "app=web",
      output: "wide",
    }, { sessionId: "s1", workspacePath: "/workspace" });

    expect(result.success).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [binary, args, options] = execFileMock.mock.calls[0] ?? [];
    expect(binary).toBe("kubectl");
    expect(args).toEqual([
      "get",
      "pods",
      "--namespace=api",
      "--selector=app=web",
      "-o=wide",
      "--context=prod-eu",
    ]);
    expect((options as { env: NodeJS.ProcessEnv }).env["KUBECONFIG"]).toBe("/var/starling/kubeconfig");
  });

  it("kubectl_get maps namespace='*' to --all-namespaces", async () => {
    cleanup.push(await setupLocalCliProfile());
    execFileMock.mockImplementation((_f, _a, _o, cb) => cb(null, { stdout: "", stderr: "" }));

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./kubernetes.js"),
    ]);

    await getTool("kubectl_get")!.execute({
      resource: "pods",
      namespace: "*",
    }, { sessionId: "s1", workspacePath: "/workspace" });

    const args = execFileMock.mock.calls[0]?.[1] as string[];
    expect(args).toContain("--all-namespaces");
    expect(args).not.toContain("--namespace=*");
  });

  it("kubectl_describe rejects missing name", async () => {
    cleanup.push(await setupLocalCliProfile());
    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./kubernetes.js"),
    ]);

    const result = await getTool("kubectl_describe")!.execute({
      resource: "pod",
    }, { sessionId: "s1", workspacePath: "/workspace" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("name is required");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("kubectl_logs requires pod or labelSelector", async () => {
    cleanup.push(await setupLocalCliProfile());
    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./kubernetes.js"),
    ]);

    const result = await getTool("kubectl_logs")!.execute({
      namespace: "api",
    }, { sessionId: "s1", workspacePath: "/workspace" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("pod or labelSelector");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("kubectl_logs rejects pod + labelSelector together", async () => {
    cleanup.push(await setupLocalCliProfile());
    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./kubernetes.js"),
    ]);

    const result = await getTool("kubectl_logs")!.execute({
      pod: "web-1",
      labelSelector: "app=web",
    }, { sessionId: "s1", workspacePath: "/workspace" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("mutually exclusive");
  });

  it("kubectl_logs passes tail, since, container, previous flags", async () => {
    cleanup.push(await setupLocalCliProfile());
    execFileMock.mockImplementation((_f, _a, _o, cb) => cb(null, { stdout: "boot line\nready", stderr: "" }));

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./kubernetes.js"),
    ]);

    await getTool("kubectl_logs")!.execute({
      pod: "web-1",
      container: "app",
      tail: 200,
      sinceSeconds: 600,
      previous: true,
      namespace: "api",
    }, { sessionId: "s1", workspacePath: "/workspace" });

    const args = execFileMock.mock.calls[0]?.[1] as string[];
    expect(args).toEqual([
      "logs",
      "web-1",
      "-c=app",
      "--tail=200",
      "--since=600s",
      "--previous",
      "--namespace=api",
      "--context=prod-eu",
    ]);
  });

  it("kubectl_top validates target and supports sortBy", async () => {
    cleanup.push(await setupLocalCliProfile());
    execFileMock.mockImplementation((_f, _a, _o, cb) => cb(null, { stdout: "NAME\tCPU\nnode-1\t250m", stderr: "" }));

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./kubernetes.js"),
    ]);

    const bad = await getTool("kubectl_top")!.execute({
      target: "deployments",
    }, { sessionId: "s1", workspacePath: "/workspace" });
    expect(bad.success).toBe(false);
    expect(bad.error).toContain("pods");

    const good = await getTool("kubectl_top")!.execute({
      target: "nodes",
      sortBy: "cpu",
    }, { sessionId: "s1", workspacePath: "/workspace" });
    expect(good.success).toBe(true);
    const args = execFileMock.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(["top", "nodes", "--sort-by=cpu", "--context=prod-eu"]);
  });

  it("helm_list returns parsed JSON release list", async () => {
    cleanup.push(await setupLocalCliProfile());
    execFileMock.mockImplementation((_f, _a, _o, cb) =>
      cb(null, {
        stdout: JSON.stringify([
          { name: "gateway", status: "deployed", chart: "gateway-1.2.0" },
          { name: "worker", status: "deployed", chart: "worker-0.4.0" },
        ]),
        stderr: "",
      }),
    );

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./kubernetes.js"),
    ]);

    const result = await getTool("helm_list")!.execute({
      namespace: "api",
      status: "deployed",
    }, { sessionId: "s1", workspacePath: "/workspace" });

    expect(result.success).toBe(true);
    expect(result.output).toContain("gateway");
    expect(result.output).toContain("worker");
    expect(result.metadata?.["releaseCount"]).toBe(2);
    const args = execFileMock.mock.calls[0]?.[1] as string[];
    expect(args).toEqual([
      "list",
      "--output=json",
      "--namespace=api",
      "--deployed",
      "--context=prod-eu",
    ]);
  });

  it("honors explicit context override over profile default", async () => {
    cleanup.push(await setupLocalCliProfile());
    execFileMock.mockImplementation((_f, _a, _o, cb) => cb(null, { stdout: "", stderr: "" }));

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./kubernetes.js"),
    ]);

    await getTool("kubectl_get")!.execute({
      resource: "pods",
      context: "staging-us",
    }, { sessionId: "s1", workspacePath: "/workspace" });

    const args = execFileMock.mock.calls[0]?.[1] as string[];
    expect(args).toContain("--context=staging-us");
    expect(args).not.toContain("--context=prod-eu");
  });

  it("surfaces binary-not-found error cleanly", async () => {
    cleanup.push(await setupLocalCliProfile());
    execFileMock.mockImplementation((_f, _a, _o, cb) => {
      const err = Object.assign(new Error("kubectl not found"), { code: "ENOENT" });
      cb(err, { stdout: "", stderr: "" });
    });

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./kubernetes.js"),
    ]);

    const result = await getTool("kubectl_get")!.execute({
      resource: "pods",
    }, { sessionId: "s1", workspacePath: "/workspace" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not installed");
  });

  // ── Wave 2: mutate tools ────────────────────────────────────────────────

  it("kubectl_apply rejects both manifestPath and inlineManifest", async () => {
    cleanup.push(await setupLocalCliProfile());
    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./kubernetes.js"),
    ]);

    const result = await getTool("kubectl_apply")!.execute({
      manifestPath: "k8s/deploy.yaml",
      inlineManifest: "kind: Deployment\n",
    }, { sessionId: "s1", workspacePath: "/workspace" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("mutually exclusive");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("kubectl_apply writes inlineManifest to a temp file and passes dryRun flag", async () => {
    cleanup.push(await setupLocalCliProfile());
    execFileMock.mockImplementation((_f, _a, _o, cb) => cb(null, { stdout: "deployment/web configured (dry run)", stderr: "" }));

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./kubernetes.js"),
    ]);

    const result = await getTool("kubectl_apply")!.execute({
      inlineManifest: "apiVersion: apps/v1\nkind: Deployment\n",
      namespace: "api",
      serverSide: true,
      forceConflicts: true,
      dryRun: true,
    }, { sessionId: "s1", workspacePath: "/workspace" });

    expect(result.success).toBe(true);
    const args = execFileMock.mock.calls[0]?.[1] as string[];
    expect(args[0]).toBe("apply");
    expect(args[1]).toBe("-f");
    expect(args[2]).toMatch(/manifest\.yaml$/);
    expect(args).toEqual(expect.arrayContaining([
      "--namespace=api",
      "--server-side=true",
      "--force-conflicts=true",
      "--dry-run=server",
      "--context=prod-eu",
    ]));
  });

  it("kubectl_apply requires pruneLabel when prune=true", async () => {
    cleanup.push(await setupLocalCliProfile());
    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./kubernetes.js"),
    ]);

    const result = await getTool("kubectl_apply")!.execute({
      inlineManifest: "kind: Deployment\n",
      prune: true,
    }, { sessionId: "s1", workspacePath: "/workspace" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("pruneLabel");
  });

  it("kubectl_delete rejects name + labelSelector combo", async () => {
    cleanup.push(await setupLocalCliProfile());
    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./kubernetes.js"),
    ]);

    const result = await getTool("kubectl_delete")!.execute({
      resource: "pod",
      name: "web-1",
      labelSelector: "app=web",
    }, { sessionId: "s1", workspacePath: "/workspace" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("mutually exclusive");
  });

  it("kubectl_delete honors gracePeriodSeconds=0 for immediate deletion", async () => {
    cleanup.push(await setupLocalCliProfile());
    execFileMock.mockImplementation((_f, _a, _o, cb) => cb(null, { stdout: "pod/web-1 deleted", stderr: "" }));

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./kubernetes.js"),
    ]);

    const result = await getTool("kubectl_delete")!.execute({
      resource: "pod",
      name: "web-1",
      namespace: "api",
      gracePeriodSeconds: 0,
    }, { sessionId: "s1", workspacePath: "/workspace" });

    expect(result.success).toBe(true);
    const args = execFileMock.mock.calls[0]?.[1] as string[];
    expect(args).toEqual([
      "delete",
      "pod",
      "web-1",
      "--namespace=api",
      "--grace-period=0",
      "--context=prod-eu",
    ]);
  });

  it("kubectl_rollout_restart rejects unsupported workload kinds", async () => {
    cleanup.push(await setupLocalCliProfile());
    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./kubernetes.js"),
    ]);

    const bad = await getTool("kubectl_rollout_restart")!.execute({
      resource: "cronjob",
      name: "nightly",
    }, { sessionId: "s1", workspacePath: "/workspace" });
    expect(bad.success).toBe(false);
    expect(bad.error).toContain("deployment");

    execFileMock.mockImplementation((_f, _a, _o, cb) => cb(null, { stdout: "deployment.apps/api restarted", stderr: "" }));
    const good = await getTool("kubectl_rollout_restart")!.execute({
      resource: "deployment",
      name: "api",
      namespace: "api",
    }, { sessionId: "s1", workspacePath: "/workspace" });
    expect(good.success).toBe(true);
    const args = execFileMock.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(["rollout", "restart", "deployment/api", "--namespace=api", "--context=prod-eu"]);
  });

  it("kubectl_scale enforces non-negative replicas and passes currentReplicas precondition", async () => {
    cleanup.push(await setupLocalCliProfile());
    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./kubernetes.js"),
    ]);

    const bad = await getTool("kubectl_scale")!.execute({
      resource: "deployment",
      name: "api",
      replicas: -1,
    }, { sessionId: "s1", workspacePath: "/workspace" });
    expect(bad.success).toBe(false);
    expect(bad.error).toContain("non-negative");

    execFileMock.mockImplementation((_f, _a, _o, cb) => cb(null, { stdout: "deployment.apps/api scaled", stderr: "" }));
    const good = await getTool("kubectl_scale")!.execute({
      resource: "deployment",
      name: "api",
      replicas: 5,
      currentReplicas: 3,
      namespace: "api",
    }, { sessionId: "s1", workspacePath: "/workspace" });
    expect(good.success).toBe(true);
    const args = execFileMock.mock.calls[0]?.[1] as string[];
    expect(args).toEqual([
      "scale",
      "deployment/api",
      "--replicas=5",
      "--current-replicas=3",
      "--namespace=api",
      "--context=prod-eu",
    ]);
  });

  it("helm_upgrade materializes inline values, resolves secrets, and emits --install/--atomic", async () => {
    cleanup.push(await setupLocalCliProfile());
    process.env["TEST_API_TOKEN"] = "env-token-42";
    execFileMock.mockImplementation((_f, _a, _o, cb) => cb(null, { stdout: "Release \"api\" has been upgraded.", stderr: "" }));

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./kubernetes.js"),
    ]);

    const result = await getTool("helm_upgrade")!.execute({
      release: "api",
      chart: "oci://ghcr.io/example/api",
      version: "1.4.2",
      namespace: "api",
      install: true,
      atomic: true,
      waitReady: true,
      valuesFiles: [
        { filename: "overrides.yaml", content: "image:\n  tag: 1.4.2\n" },
      ],
      setValues: {
        apiToken: "$TEST_API_TOKEN",
      },
    }, { sessionId: "s1", workspacePath: "/workspace" });

    expect(result.success).toBe(true);
    const args = execFileMock.mock.calls[0]?.[1] as string[];
    expect(args[0]).toBe("upgrade");
    expect(args[1]).toBe("api");
    expect(args[2]).toBe("oci://ghcr.io/example/api");
    expect(args).toEqual(expect.arrayContaining([
      "--install",
      "--version=1.4.2",
      "--namespace=api",
      "--atomic",
      "--wait",
      "--set=apiToken=env-token-42",
      "--context=prod-eu",
    ]));
    const valuesArg = args.find((a) => a.startsWith("--values="));
    expect(valuesArg).toBeDefined();
    expect(valuesArg!).toMatch(/overrides\.yaml$/);
    delete process.env["TEST_API_TOKEN"];
  });

  it("helm_rollback targets a specific revision when provided", async () => {
    cleanup.push(await setupLocalCliProfile());
    execFileMock.mockImplementation((_f, _a, _o, cb) => cb(null, { stdout: "Rollback was a success!", stderr: "" }));

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./kubernetes.js"),
    ]);

    const result = await getTool("helm_rollback")!.execute({
      release: "api",
      revision: 7,
      namespace: "api",
      waitReady: true,
    }, { sessionId: "s1", workspacePath: "/workspace" });

    expect(result.success).toBe(true);
    const args = execFileMock.mock.calls[0]?.[1] as string[];
    expect(args).toEqual(["rollback", "api", "7", "--namespace=api", "--wait", "--context=prod-eu"]);
  });

  it("routes through webhook profile when configured", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-k8s-webhook-"));
    cleanup.push(tempDir);
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({
      infrastructure: {
        automation: {
          defaultProfile: "remote",
          profiles: {
            remote: {
              type: "webhook",
              url: "https://example.com/k8s-executor",
              headers: { "X-Token": "abc" },
            },
          },
        },
      },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;

    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ success: true, output: "pod/web-1 Running", metadata: { cluster: "remote" } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./kubernetes.js"),
    ]);

    const result = await getTool("kubectl_get")!.execute({
      resource: "pods",
      namespace: "api",
    }, { sessionId: "s1", workspacePath: "/workspace" });

    expect(result.success).toBe(true);
    expect(result.output).toContain("web-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
