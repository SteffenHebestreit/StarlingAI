import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import {
  executeAutomationWebhook,
  formatCliExecutionError,
  normalizeExecutionTimeout,
  resolveAutomationProfile,
  resolveSecretRefs,
  resolveWorkspaceRelativePath,
  safeDelete,
} from "./infrastructure-shared.js";

const log = childLogger("tool:kubernetes");
const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Resolve kubectl/helm client binary + kubeconfig settings from the configured
 * infrastructure automation profile. Kubernetes tools always target external
 * clusters — the gateway never runs its own cluster. kubeconfig selects which
 * remote cluster we're speaking to.
 */
function resolveK8sClient(): {
  kubectlBinary: string;
  helmBinary: string;
  kubeconfigPath?: string;
  defaultKubeContext?: string;
  profileTimeoutMs?: number;
  profileError?: string;
  profileName?: string;
  profile?: ReturnType<typeof resolveAutomationProfile>["profile"];
} {
  const automation = resolveAutomationProfile(undefined);
  if (automation.error) {
    return { kubectlBinary: "kubectl", helmBinary: "helm", profileError: automation.error };
  }
  if (!automation.profile || automation.profile.type !== "local-cli") {
    return {
      kubectlBinary: "kubectl",
      helmBinary: "helm",
      profileName: automation.profileName,
      profile: automation.profile,
    };
  }
  return {
    kubectlBinary: automation.profile.kubectlBinary,
    helmBinary: automation.profile.helmBinary,
    kubeconfigPath: automation.profile.kubeconfigPath,
    defaultKubeContext: automation.profile.defaultKubeContext,
    profileTimeoutMs: automation.profile.timeoutMs,
    profileName: automation.profileName,
    profile: automation.profile,
  };
}

function buildClientEnv(kubeconfigPath?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (kubeconfigPath) {
    env["KUBECONFIG"] = kubeconfigPath;
  }
  return env;
}

function appendContext(args: string[], explicitContext: unknown, defaultContext?: string): string[] {
  const ctx = typeof explicitContext === "string" && explicitContext.trim()
    ? explicitContext.trim()
    : defaultContext;
  if (ctx) args.push(`--context=${ctx}`);
  return args;
}

function appendNamespace(args: string[], namespace: unknown, allowAllNamespaces = false): string[] {
  if (namespace === "*" || namespace === "all") {
    if (allowAllNamespaces) args.push("--all-namespaces");
    return args;
  }
  const ns = typeof namespace === "string" && namespace.trim() ? namespace.trim() : undefined;
  if (ns) args.push(`--namespace=${ns}`);
  return args;
}

function truncate(output: string, maxBytes = 60_000): string {
  if (output.length <= maxBytes) return output;
  return `${output.slice(0, maxBytes)}\n\n[Output truncated at ${maxBytes} bytes]`;
}

async function runClient(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string> {
  log.debug({ binary, args }, "Running kubernetes client");
  const { stdout, stderr } = await execFileAsync(binary, args, { env, timeout: timeoutMs });
  const combined = `${stdout}\n${stderr}`.trim();
  return combined;
}

function buildWebhookPassthrough(
  toolName: string,
  args: Record<string, unknown>,
  client: ReturnType<typeof resolveK8sClient>,
): Promise<ToolResult> | undefined {
  if (client.profile?.type === "webhook" && client.profileName) {
    return executeAutomationWebhook(
      toolName,
      client.profileName,
      client.profile,
      args,
      DEFAULT_TIMEOUT_MS,
    );
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// kubectl_get — list or describe resources (read-only)
// ─────────────────────────────────────────────────────────────────────────────
registerTool({
  name: "kubectl_get",
  description:
    "Get one or more Kubernetes resources from an external cluster. Read-only. Supports resource kinds (pods, deployments, services, configmaps, events, etc.), label/field selectors, namespace or all-namespaces, and yaml/json/wide output.",
  embeddingDescription:
    "list kubernetes resources pods deployments services configmaps events read-only describe cluster state",
  costHint: "low",
  latencyHint: "low",
  parameters: {
    type: "object",
    properties: {
      resource: {
        type: "string",
        description: "Resource kind to get (e.g. pods, deployments, services, configmaps, events, nodes, ingresses)",
      },
      name: {
        type: "string",
        description: "Optional specific resource name to fetch",
      },
      namespace: {
        type: "string",
        description: "Namespace to target. Use '*' or 'all' for --all-namespaces. Defaults to the kubeconfig's current namespace.",
      },
      labelSelector: {
        type: "string",
        description: "Optional label selector, e.g. 'app=web,tier=frontend'",
      },
      fieldSelector: {
        type: "string",
        description: "Optional field selector, e.g. 'status.phase=Running'",
      },
      output: {
        type: "string",
        enum: ["wide", "yaml", "json", "name", "default"],
        description: "Output format. Defaults to kubectl's table output.",
      },
      context: {
        type: "string",
        description: "kubeconfig context to use. Falls back to the profile's defaultKubeContext, then the current kubeconfig context.",
      },
      timeoutMs: {
        type: "number",
        description: "Execution timeout in ms. Defaults to 60000 and is capped at 900000.",
      },
    },
    required: ["resource"],
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const client = resolveK8sClient();
    if (client.profileError) {
      return { success: false, output: "", error: client.profileError };
    }
    const webhook = buildWebhookPassthrough("kubectl_get", args, client);
    if (webhook) return webhook;

    const resource = String(args["resource"] ?? "").trim();
    if (!resource) {
      return { success: false, output: "", error: "resource is required" };
    }
    const timeoutMs = normalizeExecutionTimeout(args["timeoutMs"] ?? client.profileTimeoutMs, DEFAULT_TIMEOUT_MS);

    const cliArgs = ["get", resource];
    if (typeof args["name"] === "string" && String(args["name"]).trim()) {
      cliArgs.push(String(args["name"]).trim());
    }
    appendNamespace(cliArgs, args["namespace"], true);
    if (typeof args["labelSelector"] === "string" && String(args["labelSelector"]).trim()) {
      cliArgs.push(`--selector=${String(args["labelSelector"]).trim()}`);
    }
    if (typeof args["fieldSelector"] === "string" && String(args["fieldSelector"]).trim()) {
      cliArgs.push(`--field-selector=${String(args["fieldSelector"]).trim()}`);
    }
    const output = typeof args["output"] === "string" ? String(args["output"]).trim() : "";
    if (output && output !== "default") {
      cliArgs.push(`-o=${output}`);
    }
    appendContext(cliArgs, args["context"], client.defaultKubeContext);

    try {
      const stdout = await runClient(client.kubectlBinary, cliArgs, buildClientEnv(client.kubeconfigPath), timeoutMs);
      return {
        success: true,
        output: truncate(stdout),
        metadata: { resource, namespace: args["namespace"] ?? "default", output: output || "default" },
      };
    } catch (error: any) {
      return {
        success: false,
        output: `${error.stdout || ""}\n${error.stderr || ""}`.trim(),
        error: formatCliExecutionError(error, client.kubectlBinary),
      };
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// kubectl_describe — human-readable detail view (read-only)
// ─────────────────────────────────────────────────────────────────────────────
registerTool({
  name: "kubectl_describe",
  description:
    "Describe a Kubernetes resource in detail (events, conditions, related resources). Read-only. Prefer kubectl_describe over kubectl_get when diagnosing why a resource is unhealthy.",
  embeddingDescription:
    "describe kubernetes resource events conditions pod deployment service debugging diagnose unhealthy",
  costHint: "low",
  latencyHint: "low",
  parameters: {
    type: "object",
    properties: {
      resource: {
        type: "string",
        description: "Resource kind (e.g. pod, deployment, service, node, ingress)",
      },
      name: {
        type: "string",
        description: "Resource name to describe",
      },
      namespace: {
        type: "string",
        description: "Namespace of the resource. Defaults to the kubeconfig's current namespace.",
      },
      context: {
        type: "string",
        description: "kubeconfig context. Falls back to the profile's defaultKubeContext.",
      },
      timeoutMs: {
        type: "number",
        description: "Execution timeout in ms. Defaults to 60000.",
      },
    },
    required: ["resource", "name"],
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const client = resolveK8sClient();
    if (client.profileError) {
      return { success: false, output: "", error: client.profileError };
    }
    const webhook = buildWebhookPassthrough("kubectl_describe", args, client);
    if (webhook) return webhook;

    const resource = String(args["resource"] ?? "").trim();
    const name = String(args["name"] ?? "").trim();
    if (!resource) return { success: false, output: "", error: "resource is required" };
    if (!name) return { success: false, output: "", error: "name is required" };

    const timeoutMs = normalizeExecutionTimeout(args["timeoutMs"] ?? client.profileTimeoutMs, DEFAULT_TIMEOUT_MS);
    const cliArgs = ["describe", resource, name];
    appendNamespace(cliArgs, args["namespace"]);
    appendContext(cliArgs, args["context"], client.defaultKubeContext);

    try {
      const stdout = await runClient(client.kubectlBinary, cliArgs, buildClientEnv(client.kubeconfigPath), timeoutMs);
      return {
        success: true,
        output: truncate(stdout),
        metadata: { resource, name, namespace: args["namespace"] ?? "default" },
      };
    } catch (error: any) {
      return {
        success: false,
        output: `${error.stdout || ""}\n${error.stderr || ""}`.trim(),
        error: formatCliExecutionError(error, client.kubectlBinary),
      };
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// kubectl_logs — container logs (read-only)
// ─────────────────────────────────────────────────────────────────────────────
registerTool({
  name: "kubectl_logs",
  description:
    "Fetch container logs from a pod in an external Kubernetes cluster. Read-only. Supports container selection, tail-line cap, time-window filter, previous-instance logs, and label-selector pod selection.",
  embeddingDescription:
    "kubernetes container logs pod stdout stderr debug crash investigation tail incident triage",
  costHint: "low",
  latencyHint: "medium",
  parameters: {
    type: "object",
    properties: {
      pod: {
        type: "string",
        description: "Pod name (mutually exclusive with labelSelector)",
      },
      labelSelector: {
        type: "string",
        description: "Label selector to pick a pod (mutually exclusive with pod). Use when the exact pod name is not known.",
      },
      container: {
        type: "string",
        description: "Container name (required when the pod has multiple containers).",
      },
      namespace: {
        type: "string",
        description: "Namespace. Defaults to the kubeconfig's current namespace.",
      },
      tail: {
        type: "number",
        description: "Max recent log lines to return. Defaults to 500.",
      },
      sinceSeconds: {
        type: "number",
        description: "Only return logs newer than this many seconds. Use for incident windows.",
      },
      previous: {
        type: "boolean",
        description: "Return logs from the previous (crashed) container instance instead of the current one.",
      },
      context: {
        type: "string",
        description: "kubeconfig context. Falls back to the profile's defaultKubeContext.",
      },
      timeoutMs: {
        type: "number",
        description: "Execution timeout in ms. Defaults to 60000.",
      },
    },
    required: [],
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const client = resolveK8sClient();
    if (client.profileError) {
      return { success: false, output: "", error: client.profileError };
    }
    const webhook = buildWebhookPassthrough("kubectl_logs", args, client);
    if (webhook) return webhook;

    const pod = typeof args["pod"] === "string" ? String(args["pod"]).trim() : "";
    const labelSelector = typeof args["labelSelector"] === "string" ? String(args["labelSelector"]).trim() : "";
    if (!pod && !labelSelector) {
      return { success: false, output: "", error: "either pod or labelSelector is required" };
    }
    if (pod && labelSelector) {
      return { success: false, output: "", error: "pod and labelSelector are mutually exclusive" };
    }

    const timeoutMs = normalizeExecutionTimeout(args["timeoutMs"] ?? client.profileTimeoutMs, DEFAULT_TIMEOUT_MS);
    const cliArgs = ["logs"];
    if (pod) {
      cliArgs.push(pod);
    } else {
      cliArgs.push(`--selector=${labelSelector}`);
    }
    if (typeof args["container"] === "string" && String(args["container"]).trim()) {
      cliArgs.push(`-c=${String(args["container"]).trim()}`);
    }
    const tail = typeof args["tail"] === "number" && Number.isFinite(args["tail"])
      ? Math.max(1, Math.trunc(args["tail"]))
      : 500;
    cliArgs.push(`--tail=${tail}`);
    if (typeof args["sinceSeconds"] === "number" && Number.isFinite(args["sinceSeconds"])) {
      cliArgs.push(`--since=${Math.max(1, Math.trunc(args["sinceSeconds"]))}s`);
    }
    if (args["previous"] === true) {
      cliArgs.push("--previous");
    }
    appendNamespace(cliArgs, args["namespace"]);
    appendContext(cliArgs, args["context"], client.defaultKubeContext);

    try {
      const stdout = await runClient(client.kubectlBinary, cliArgs, buildClientEnv(client.kubeconfigPath), timeoutMs);
      return {
        success: true,
        output: truncate(stdout),
        metadata: { pod: pod || null, labelSelector: labelSelector || null, tail, namespace: args["namespace"] ?? "default" },
      };
    } catch (error: any) {
      return {
        success: false,
        output: `${error.stdout || ""}\n${error.stderr || ""}`.trim(),
        error: formatCliExecutionError(error, client.kubectlBinary),
      };
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// kubectl_top — resource usage for pods or nodes (read-only)
// ─────────────────────────────────────────────────────────────────────────────
registerTool({
  name: "kubectl_top",
  description:
    "Report current CPU and memory usage for pods or nodes in an external Kubernetes cluster. Requires the Metrics API to be installed on the cluster.",
  embeddingDescription:
    "kubernetes cpu memory resource usage top pod node saturation metrics monitoring",
  costHint: "low",
  latencyHint: "medium",
  parameters: {
    type: "object",
    properties: {
      target: {
        type: "string",
        enum: ["pods", "nodes"],
        description: "What to measure: pods or nodes",
      },
      namespace: {
        type: "string",
        description: "Namespace when target=pods. Use '*' or 'all' for --all-namespaces.",
      },
      sortBy: {
        type: "string",
        enum: ["cpu", "memory"],
        description: "Sort rows by cpu or memory consumption (descending).",
      },
      context: {
        type: "string",
        description: "kubeconfig context. Falls back to the profile's defaultKubeContext.",
      },
      timeoutMs: {
        type: "number",
        description: "Execution timeout in ms. Defaults to 60000.",
      },
    },
    required: ["target"],
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const client = resolveK8sClient();
    if (client.profileError) {
      return { success: false, output: "", error: client.profileError };
    }
    const webhook = buildWebhookPassthrough("kubectl_top", args, client);
    if (webhook) return webhook;

    const target = String(args["target"] ?? "").trim();
    if (target !== "pods" && target !== "nodes") {
      return { success: false, output: "", error: "target must be 'pods' or 'nodes'" };
    }
    const timeoutMs = normalizeExecutionTimeout(args["timeoutMs"] ?? client.profileTimeoutMs, DEFAULT_TIMEOUT_MS);

    const cliArgs = ["top", target];
    if (target === "pods") {
      appendNamespace(cliArgs, args["namespace"], true);
    }
    if (typeof args["sortBy"] === "string" && (args["sortBy"] === "cpu" || args["sortBy"] === "memory")) {
      cliArgs.push(`--sort-by=${args["sortBy"]}`);
    }
    appendContext(cliArgs, args["context"], client.defaultKubeContext);

    try {
      const stdout = await runClient(client.kubectlBinary, cliArgs, buildClientEnv(client.kubeconfigPath), timeoutMs);
      return {
        success: true,
        output: truncate(stdout),
        metadata: { target, namespace: args["namespace"] ?? null },
      };
    } catch (error: any) {
      return {
        success: false,
        output: `${error.stdout || ""}\n${error.stderr || ""}`.trim(),
        error: formatCliExecutionError(error, client.kubectlBinary),
      };
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// helm_list — installed releases (read-only)
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// Helpers for mutate tools (Wave 2)
// ─────────────────────────────────────────────────────────────────────────────

function materializeManifest(
  inlineManifest: unknown,
  manifestPath: unknown,
  workspacePath: string,
): { path: string; cleanup?: string } {
  const inline = typeof inlineManifest === "string" ? inlineManifest : undefined;
  const relPath = typeof manifestPath === "string" ? manifestPath.trim() : "";
  if (inline && relPath) {
    throw new Error("manifestPath and inlineManifest are mutually exclusive");
  }
  if (!inline && !relPath) {
    throw new Error("one of manifestPath or inlineManifest is required");
  }
  if (inline) {
    const dir = mkdtempSync(join(tmpdir(), "starlingai-k8s-manifest-"));
    const fullPath = join(dir, "manifest.yaml");
    writeFileSync(fullPath, inline, "utf8");
    return { path: fullPath, cleanup: dir };
  }
  return { path: resolveWorkspaceRelativePath(relPath, workspacePath) };
}

function materializeValuesFiles(
  inlineValues: unknown,
  workspacePath: string,
): { paths: string[]; cleanup: string[] } {
  const entries = (Array.isArray(inlineValues) ? inlineValues : [inlineValues])
    .filter((entry): entry is { filename?: string; content: string } | string => entry != null);
  const paths: string[] = [];
  const cleanup: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string" && entry.trim()) {
      paths.push(resolveWorkspaceRelativePath(entry.trim(), workspacePath));
      continue;
    }
    if (entry && typeof entry === "object" && typeof (entry as { content: unknown }).content === "string") {
      const dir = mkdtempSync(join(tmpdir(), "starlingai-helm-values-"));
      const filename = (entry as { filename?: string }).filename?.trim() || "values.yaml";
      const fullPath = join(dir, filename);
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, String((entry as { content: string }).content), "utf8");
      paths.push(fullPath);
      cleanup.push(dir);
    }
  }
  return { paths, cleanup };
}

registerTool({
  name: "helm_list",
  description:
    "List Helm releases in the target Kubernetes cluster. Read-only. Covers status, chart version, app version, and last-updated time.",
  embeddingDescription:
    "helm list releases charts deployments installed applications kubernetes helm3",
  costHint: "low",
  latencyHint: "low",
  parameters: {
    type: "object",
    properties: {
      namespace: {
        type: "string",
        description: "Namespace to list. Use '*' or 'all' for --all-namespaces.",
      },
      filter: {
        type: "string",
        description: "Regex filter against release name.",
      },
      status: {
        type: "string",
        enum: ["deployed", "failed", "pending", "uninstalling", "superseded", "uninstalled"],
        description: "Only list releases in this status.",
      },
      context: {
        type: "string",
        description: "kubeconfig context. Falls back to the profile's defaultKubeContext.",
      },
      timeoutMs: {
        type: "number",
        description: "Execution timeout in ms. Defaults to 60000.",
      },
    },
    required: [],
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const client = resolveK8sClient();
    if (client.profileError) {
      return { success: false, output: "", error: client.profileError };
    }
    const webhook = buildWebhookPassthrough("helm_list", args, client);
    if (webhook) return webhook;

    const timeoutMs = normalizeExecutionTimeout(args["timeoutMs"] ?? client.profileTimeoutMs, DEFAULT_TIMEOUT_MS);
    const cliArgs = ["list", "--output=json"];
    const namespace = args["namespace"];
    if (namespace === "*" || namespace === "all") {
      cliArgs.push("--all-namespaces");
    } else if (typeof namespace === "string" && namespace.trim()) {
      cliArgs.push(`--namespace=${namespace.trim()}`);
    }
    if (typeof args["filter"] === "string" && String(args["filter"]).trim()) {
      cliArgs.push(`--filter=${String(args["filter"]).trim()}`);
    }
    if (typeof args["status"] === "string" && String(args["status"]).trim()) {
      cliArgs.push(`--${String(args["status"]).trim()}`);
    }
    appendContext(cliArgs, args["context"], client.defaultKubeContext);

    try {
      const stdout = await runClient(client.helmBinary, cliArgs, buildClientEnv(client.kubeconfigPath), timeoutMs);
      let parsed: unknown = undefined;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        // Helm sometimes prints warnings on stderr that land in the combined output; return raw text.
      }
      return {
        success: true,
        output: parsed ? JSON.stringify(parsed, null, 2) : truncate(stdout),
        metadata: {
          namespace: namespace ?? null,
          releaseCount: Array.isArray(parsed) ? parsed.length : undefined,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        output: `${error.stdout || ""}\n${error.stderr || ""}`.trim(),
        error: formatCliExecutionError(error, client.helmBinary),
      };
    }
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Wave 2: mutate tools — tier 3, per-call approval required
// ─────────────────────────────────────────────────────────────────────────────

// kubectl_apply — apply a manifest file or inline YAML
registerTool({
  name: "kubectl_apply",
  description:
    "Apply a Kubernetes manifest (create or update) against an external cluster. Supports workspace-relative manifest files or inline YAML, optional --server-side apply, pruning by label, and a dryRun mode that returns the server-side diff without changing state.",
  embeddingDescription:
    "kubectl apply manifest yaml deploy update create kubernetes resource rollout provision",
  parameters: {
    type: "object",
    properties: {
      manifestPath: {
        type: "string",
        description: "Workspace-relative path to a YAML or JSON manifest. Mutually exclusive with inlineManifest.",
      },
      inlineManifest: {
        type: "string",
        description: "Inline YAML or JSON manifest. Mutually exclusive with manifestPath.",
      },
      namespace: {
        type: "string",
        description: "Namespace to apply into (when the manifest does not pin one).",
      },
      serverSide: {
        type: "boolean",
        description: "Use server-side apply (recommended for controller-managed resources).",
      },
      forceConflicts: {
        type: "boolean",
        description: "With serverSide=true, force conflicting field ownership transfers.",
      },
      prune: {
        type: "boolean",
        description: "Enable --prune. Requires pruneLabel so only objects with that label are removed.",
      },
      pruneLabel: {
        type: "string",
        description: "Label selector for --prune, e.g. 'starlingai.io/scene=deploy-api'.",
      },
      dryRun: {
        type: "boolean",
        description: "Perform a server-side dry run (no changes applied). Still surfaces the would-be diff.",
      },
      context: {
        type: "string",
        description: "kubeconfig context. Falls back to the profile's defaultKubeContext.",
      },
      timeoutMs: {
        type: "number",
        description: "Execution timeout in ms. Defaults to 60000.",
      },
    },
    required: [],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const client = resolveK8sClient();
    if (client.profileError) {
      return { success: false, output: "", error: client.profileError };
    }
    const webhook = buildWebhookPassthrough("kubectl_apply", args, client);
    if (webhook) return webhook;

    let manifest: { path: string; cleanup?: string };
    try {
      manifest = materializeManifest(args["inlineManifest"], args["manifestPath"], ctx.workspacePath);
    } catch (error) {
      return { success: false, output: "", error: error instanceof Error ? error.message : String(error) };
    }

    const timeoutMs = normalizeExecutionTimeout(args["timeoutMs"] ?? client.profileTimeoutMs, DEFAULT_TIMEOUT_MS);
    const cliArgs = ["apply", "-f", manifest.path];
    appendNamespace(cliArgs, args["namespace"]);
    if (args["serverSide"] === true) {
      cliArgs.push("--server-side=true");
      if (args["forceConflicts"] === true) cliArgs.push("--force-conflicts=true");
    }
    if (args["prune"] === true) {
      const label = typeof args["pruneLabel"] === "string" ? String(args["pruneLabel"]).trim() : "";
      if (!label) {
        if (manifest.cleanup) safeDelete(manifest.cleanup);
        return { success: false, output: "", error: "prune=true requires pruneLabel" };
      }
      cliArgs.push("--prune=true", `--selector=${label}`);
    }
    if (args["dryRun"] === true) cliArgs.push("--dry-run=server");
    appendContext(cliArgs, args["context"], client.defaultKubeContext);

    try {
      const stdout = await runClient(client.kubectlBinary, cliArgs, buildClientEnv(client.kubeconfigPath), timeoutMs);
      return {
        success: true,
        output: truncate(stdout),
        metadata: {
          manifest: manifest.path,
          namespace: args["namespace"] ?? null,
          dryRun: args["dryRun"] === true,
          serverSide: args["serverSide"] === true,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        output: `${error.stdout || ""}\n${error.stderr || ""}`.trim(),
        error: formatCliExecutionError(error, client.kubectlBinary),
      };
    } finally {
      if (manifest.cleanup) safeDelete(manifest.cleanup);
    }
  },
});

// kubectl_delete — delete a named resource
registerTool({
  name: "kubectl_delete",
  description:
    "Delete a Kubernetes resource by kind and name (or by label selector within a namespace). Approval-gated. Does not accept --all without an explicit labelSelector scope.",
  embeddingDescription:
    "kubectl delete resource pod deployment service remove teardown cleanup",
  parameters: {
    type: "object",
    properties: {
      resource: {
        type: "string",
        description: "Resource kind (pod, deployment, service, configmap, etc.)",
      },
      name: {
        type: "string",
        description: "Specific resource name. Mutually exclusive with labelSelector.",
      },
      labelSelector: {
        type: "string",
        description: "Label selector. Mutually exclusive with name. Required when deleting multiple resources.",
      },
      namespace: {
        type: "string",
        description: "Namespace of the resource.",
      },
      gracePeriodSeconds: {
        type: "number",
        description: "Grace period for termination. 0 forces immediate deletion.",
      },
      context: {
        type: "string",
        description: "kubeconfig context. Falls back to the profile's defaultKubeContext.",
      },
      timeoutMs: {
        type: "number",
        description: "Execution timeout in ms. Defaults to 60000.",
      },
    },
    required: ["resource"],
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const client = resolveK8sClient();
    if (client.profileError) {
      return { success: false, output: "", error: client.profileError };
    }
    const webhook = buildWebhookPassthrough("kubectl_delete", args, client);
    if (webhook) return webhook;

    const resource = String(args["resource"] ?? "").trim();
    if (!resource) return { success: false, output: "", error: "resource is required" };
    const name = typeof args["name"] === "string" ? String(args["name"]).trim() : "";
    const labelSelector = typeof args["labelSelector"] === "string" ? String(args["labelSelector"]).trim() : "";
    if (!name && !labelSelector) {
      return { success: false, output: "", error: "either name or labelSelector is required" };
    }
    if (name && labelSelector) {
      return { success: false, output: "", error: "name and labelSelector are mutually exclusive" };
    }

    const timeoutMs = normalizeExecutionTimeout(args["timeoutMs"] ?? client.profileTimeoutMs, DEFAULT_TIMEOUT_MS);
    const cliArgs = ["delete", resource];
    if (name) cliArgs.push(name);
    if (labelSelector) cliArgs.push(`--selector=${labelSelector}`);
    appendNamespace(cliArgs, args["namespace"]);
    if (typeof args["gracePeriodSeconds"] === "number" && Number.isFinite(args["gracePeriodSeconds"])) {
      cliArgs.push(`--grace-period=${Math.max(0, Math.trunc(args["gracePeriodSeconds"]))}`);
    }
    appendContext(cliArgs, args["context"], client.defaultKubeContext);

    try {
      const stdout = await runClient(client.kubectlBinary, cliArgs, buildClientEnv(client.kubeconfigPath), timeoutMs);
      return {
        success: true,
        output: truncate(stdout),
        metadata: { resource, name: name || null, labelSelector: labelSelector || null },
      };
    } catch (error: any) {
      return {
        success: false,
        output: `${error.stdout || ""}\n${error.stderr || ""}`.trim(),
        error: formatCliExecutionError(error, client.kubectlBinary),
      };
    }
  },
});

// kubectl_rollout_restart — trigger a rolling restart
registerTool({
  name: "kubectl_rollout_restart",
  description:
    "Restart a Deployment, StatefulSet, or DaemonSet so its pods recycle with a fresh template hash. Common fix for config/secret changes that don't auto-reload.",
  embeddingDescription:
    "kubectl rollout restart deployment daemonset statefulset recycle pods refresh config reload",
  parameters: {
    type: "object",
    properties: {
      resource: {
        type: "string",
        enum: ["deployment", "statefulset", "daemonset"],
        description: "Workload kind to restart.",
      },
      name: {
        type: "string",
        description: "Workload name.",
      },
      namespace: {
        type: "string",
        description: "Namespace.",
      },
      context: {
        type: "string",
        description: "kubeconfig context. Falls back to the profile's defaultKubeContext.",
      },
      timeoutMs: {
        type: "number",
        description: "Execution timeout in ms. Defaults to 60000.",
      },
    },
    required: ["resource", "name"],
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const client = resolveK8sClient();
    if (client.profileError) {
      return { success: false, output: "", error: client.profileError };
    }
    const webhook = buildWebhookPassthrough("kubectl_rollout_restart", args, client);
    if (webhook) return webhook;

    const resource = String(args["resource"] ?? "").trim();
    const name = String(args["name"] ?? "").trim();
    if (!resource) return { success: false, output: "", error: "resource is required" };
    if (!name) return { success: false, output: "", error: "name is required" };
    if (!["deployment", "statefulset", "daemonset"].includes(resource)) {
      return { success: false, output: "", error: "resource must be deployment, statefulset, or daemonset" };
    }

    const timeoutMs = normalizeExecutionTimeout(args["timeoutMs"] ?? client.profileTimeoutMs, DEFAULT_TIMEOUT_MS);
    const cliArgs = ["rollout", "restart", `${resource}/${name}`];
    appendNamespace(cliArgs, args["namespace"]);
    appendContext(cliArgs, args["context"], client.defaultKubeContext);

    try {
      const stdout = await runClient(client.kubectlBinary, cliArgs, buildClientEnv(client.kubeconfigPath), timeoutMs);
      return {
        success: true,
        output: truncate(stdout),
        metadata: { resource, name, namespace: args["namespace"] ?? null },
      };
    } catch (error: any) {
      return {
        success: false,
        output: `${error.stdout || ""}\n${error.stderr || ""}`.trim(),
        error: formatCliExecutionError(error, client.kubectlBinary),
      };
    }
  },
});

// kubectl_scale — scale a workload to a specific replica count
registerTool({
  name: "kubectl_scale",
  description:
    "Scale a Deployment, StatefulSet, or ReplicaSet to a specific replica count. Approval-gated. Accepts current-replicas precondition for safety.",
  embeddingDescription:
    "kubectl scale replicas deployment statefulset horizontal resize workload capacity",
  parameters: {
    type: "object",
    properties: {
      resource: {
        type: "string",
        enum: ["deployment", "statefulset", "replicaset"],
        description: "Workload kind to scale.",
      },
      name: {
        type: "string",
        description: "Workload name.",
      },
      replicas: {
        type: "number",
        description: "Target replica count (must be >= 0).",
      },
      currentReplicas: {
        type: "number",
        description: "Optional precondition. kubectl will refuse to scale if the current count differs.",
      },
      namespace: {
        type: "string",
        description: "Namespace.",
      },
      context: {
        type: "string",
        description: "kubeconfig context. Falls back to the profile's defaultKubeContext.",
      },
      timeoutMs: {
        type: "number",
        description: "Execution timeout in ms. Defaults to 60000.",
      },
    },
    required: ["resource", "name", "replicas"],
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const client = resolveK8sClient();
    if (client.profileError) {
      return { success: false, output: "", error: client.profileError };
    }
    const webhook = buildWebhookPassthrough("kubectl_scale", args, client);
    if (webhook) return webhook;

    const resource = String(args["resource"] ?? "").trim();
    const name = String(args["name"] ?? "").trim();
    const replicas = typeof args["replicas"] === "number" && Number.isFinite(args["replicas"])
      ? Math.trunc(args["replicas"])
      : NaN;
    if (!resource) return { success: false, output: "", error: "resource is required" };
    if (!name) return { success: false, output: "", error: "name is required" };
    if (!Number.isFinite(replicas) || replicas < 0) {
      return { success: false, output: "", error: "replicas must be a non-negative integer" };
    }
    if (!["deployment", "statefulset", "replicaset"].includes(resource)) {
      return { success: false, output: "", error: "resource must be deployment, statefulset, or replicaset" };
    }

    const timeoutMs = normalizeExecutionTimeout(args["timeoutMs"] ?? client.profileTimeoutMs, DEFAULT_TIMEOUT_MS);
    const cliArgs = ["scale", `${resource}/${name}`, `--replicas=${replicas}`];
    if (typeof args["currentReplicas"] === "number" && Number.isFinite(args["currentReplicas"])) {
      cliArgs.push(`--current-replicas=${Math.max(0, Math.trunc(args["currentReplicas"]))}`);
    }
    appendNamespace(cliArgs, args["namespace"]);
    appendContext(cliArgs, args["context"], client.defaultKubeContext);

    try {
      const stdout = await runClient(client.kubectlBinary, cliArgs, buildClientEnv(client.kubeconfigPath), timeoutMs);
      return {
        success: true,
        output: truncate(stdout),
        metadata: { resource, name, replicas, namespace: args["namespace"] ?? null },
      };
    } catch (error: any) {
      return {
        success: false,
        output: `${error.stdout || ""}\n${error.stderr || ""}`.trim(),
        error: formatCliExecutionError(error, client.kubectlBinary),
      };
    }
  },
});

// helm_upgrade — upgrade or install a release
registerTool({
  name: "helm_upgrade",
  description:
    "Upgrade a Helm release (or install it if absent when install=true). Supports chart version pinning, workspace-relative values files, inline values content, and --atomic rollback on failure.",
  embeddingDescription:
    "helm upgrade install release chart deploy kubernetes values template version rollout",
  parameters: {
    type: "object",
    properties: {
      release: { type: "string", description: "Release name." },
      chart: {
        type: "string",
        description: "Chart reference — repo/name, OCI ref, or workspace-relative path to a packaged chart.",
      },
      version: {
        type: "string",
        description: "Optional chart version to pin.",
      },
      namespace: {
        type: "string",
        description: "Target namespace.",
      },
      valuesFiles: {
        description:
          "Optional values files. Accepts an array of workspace-relative paths and/or {filename, content} objects (inline YAML written to a temp file).",
      },
      setValues: {
        type: "object",
        description: "Optional key=value map passed as --set. Values support $ENV and secret: refs.",
        additionalProperties: true,
      },
      install: {
        type: "boolean",
        description: "Install the release if it does not yet exist. Defaults to false.",
      },
      atomic: {
        type: "boolean",
        description: "Roll back automatically if the upgrade fails.",
      },
      waitReady: {
        type: "boolean",
        description: "Wait for resources to become ready before returning.",
      },
      context: {
        type: "string",
        description: "kubeconfig context. Falls back to the profile's defaultKubeContext.",
      },
      timeoutMs: {
        type: "number",
        description: "Execution timeout in ms. Defaults to 60000.",
      },
    },
    required: ["release", "chart"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const client = resolveK8sClient();
    if (client.profileError) {
      return { success: false, output: "", error: client.profileError };
    }
    const webhook = buildWebhookPassthrough("helm_upgrade", args, client);
    if (webhook) return webhook;

    const release = String(args["release"] ?? "").trim();
    const chart = String(args["chart"] ?? "").trim();
    if (!release) return { success: false, output: "", error: "release is required" };
    if (!chart) return { success: false, output: "", error: "chart is required" };

    const timeoutMs = normalizeExecutionTimeout(args["timeoutMs"] ?? client.profileTimeoutMs, DEFAULT_TIMEOUT_MS);
    const cliArgs = ["upgrade", release, chart];
    if (args["install"] === true) cliArgs.push("--install");
    if (typeof args["version"] === "string" && String(args["version"]).trim()) {
      cliArgs.push(`--version=${String(args["version"]).trim()}`);
    }
    if (typeof args["namespace"] === "string" && String(args["namespace"]).trim()) {
      cliArgs.push(`--namespace=${String(args["namespace"]).trim()}`);
    }
    if (args["atomic"] === true) cliArgs.push("--atomic");
    if (args["waitReady"] === true) cliArgs.push("--wait");

    let valuesCleanup: string[] = [];
    try {
      const values = materializeValuesFiles(args["valuesFiles"], ctx.workspacePath);
      valuesCleanup = values.cleanup;
      for (const path of values.paths) {
        cliArgs.push(`--values=${path}`);
      }
      const setValues = args["setValues"];
      if (setValues && typeof setValues === "object" && !Array.isArray(setValues)) {
        const resolved = resolveSecretRefs(setValues as Record<string, unknown>);
        for (const [key, value] of Object.entries(resolved)) {
          if (value === undefined || value === null) continue;
          cliArgs.push(`--set=${key}=${String(value)}`);
        }
      }
      appendContext(cliArgs, args["context"], client.defaultKubeContext);

      const stdout = await runClient(client.helmBinary, cliArgs, buildClientEnv(client.kubeconfigPath), timeoutMs);
      return {
        success: true,
        output: truncate(stdout),
        metadata: {
          release,
          chart,
          namespace: args["namespace"] ?? null,
          install: args["install"] === true,
          atomic: args["atomic"] === true,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        output: `${error.stdout || ""}\n${error.stderr || ""}`.trim(),
        error: formatCliExecutionError(error, client.helmBinary),
      };
    } finally {
      for (const dir of valuesCleanup) safeDelete(dir);
    }
  },
});

// helm_rollback — roll back a release to a previous revision
registerTool({
  name: "helm_rollback",
  description:
    "Roll back a Helm release to a previous revision. Approval-gated. Use helm_list history (via helm_list + kubectl events) to choose the revision.",
  embeddingDescription:
    "helm rollback revision release restore previous version undo",
  parameters: {
    type: "object",
    properties: {
      release: { type: "string", description: "Release name." },
      revision: {
        type: "number",
        description: "Target revision number. Defaults to the previous revision.",
      },
      namespace: {
        type: "string",
        description: "Namespace of the release.",
      },
      waitReady: {
        type: "boolean",
        description: "Wait for resources to become ready before returning.",
      },
      context: {
        type: "string",
        description: "kubeconfig context. Falls back to the profile's defaultKubeContext.",
      },
      timeoutMs: {
        type: "number",
        description: "Execution timeout in ms. Defaults to 60000.",
      },
    },
    required: ["release"],
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const client = resolveK8sClient();
    if (client.profileError) {
      return { success: false, output: "", error: client.profileError };
    }
    const webhook = buildWebhookPassthrough("helm_rollback", args, client);
    if (webhook) return webhook;

    const release = String(args["release"] ?? "").trim();
    if (!release) return { success: false, output: "", error: "release is required" };

    const timeoutMs = normalizeExecutionTimeout(args["timeoutMs"] ?? client.profileTimeoutMs, DEFAULT_TIMEOUT_MS);
    const cliArgs = ["rollback", release];
    if (typeof args["revision"] === "number" && Number.isFinite(args["revision"])) {
      const rev = Math.max(1, Math.trunc(args["revision"]));
      cliArgs.push(String(rev));
    }
    if (typeof args["namespace"] === "string" && String(args["namespace"]).trim()) {
      cliArgs.push(`--namespace=${String(args["namespace"]).trim()}`);
    }
    if (args["waitReady"] === true) cliArgs.push("--wait");
    appendContext(cliArgs, args["context"], client.defaultKubeContext);

    try {
      const stdout = await runClient(client.helmBinary, cliArgs, buildClientEnv(client.kubeconfigPath), timeoutMs);
      return {
        success: true,
        output: truncate(stdout),
        metadata: { release, revision: args["revision"] ?? "previous", namespace: args["namespace"] ?? null },
      };
    } catch (error: any) {
      return {
        success: false,
        output: `${error.stdout || ""}\n${error.stderr || ""}`.trim(),
        error: formatCliExecutionError(error, client.helmBinary),
      };
    }
  },
});
