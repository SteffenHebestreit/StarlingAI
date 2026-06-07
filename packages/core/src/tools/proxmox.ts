import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { normalizeExecutionTimeout, resolveSecretRef } from "./infrastructure-shared.js";

const log = childLogger("tool:proxmox");
const DEFAULT_TIMEOUT_MS = 120_000;
const TASK_POLL_MS = 2_000;
const IP_POLL_MS = 3_000;

type VmAction = "clone" | "start" | "stop" | "status" | "delete" | "get_ip";
type VmBackend = "proxmox" | "webhook";

const VM_ACTIONS: VmAction[] = ["clone", "start", "stop", "status", "delete", "get_ip"];
const VM_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    backend: {
      type: "string",
      enum: ["auto", "proxmox", "webhook"],
      description: "Backend to use. vm_manage supports proxmox and webhook backends. Defaults to auto.",
    },
    profile: {
      type: "string",
      description: "Optional infrastructure.virtualization profile name from config.",
    },
    action: {
      type: "string",
      enum: VM_ACTIONS,
      description: "VM action to perform",
    },
    apiUrl: {
      type: "string",
      description: "Base Proxmox API URL, e.g. https://proxmox.example.com:8006/api2/json. Optional when 'profile' is set — the profile's apiUrl is used.",
    },
    node: {
      type: "string",
      description: "Target node name. Optional when 'profile' is set — the profile's node is used.",
    },
    vmId: {
      type: "number",
      description: "Target VM ID",
    },
    sourceVmid: {
      type: "number",
      description: "Template or source VM ID used for clone",
    },
    name: {
      type: "string",
      description: "VM name for clone operations",
    },
    targetNode: {
      type: "string",
      description: "Optional target node for the clone; defaults to node",
    },
    storage: {
      type: "string",
      description: "Optional target storage name for the cloned disks",
    },
    pool: {
      type: "string",
      description: "Optional pool name",
    },
    fullClone: {
      type: "boolean",
      description: "Whether to perform a full clone. Defaults to true.",
    },
    cores: {
      type: "number",
      description: "Optional CPU core count to apply after clone",
    },
    memoryMb: {
      type: "number",
      description: "Optional RAM in MB to apply after clone",
    },
    cloudInitUser: {
      type: "string",
      description: "Optional cloud-init username to apply after clone",
    },
    sshPublicKeys: {
      type: "string",
      description: "Optional SSH public keys to apply through cloud-init after clone",
    },
    startAfterClone: {
      type: "boolean",
      description: "Whether to start the VM after cloning. Defaults to true.",
    },
    waitForIp: {
      type: "boolean",
      description: "When true, waits for a guest-agent-reported IP after start. Requires qemu-guest-agent in the guest.",
    },
    timeoutMs: {
      type: "number",
      description: "Optional timeout in milliseconds. Defaults to 120000 and is capped at 900000.",
    },
  },
  required: ["action", "vmId"],
} as const;

registerTool({
  name: "vm_manage",
  description: "Manage virtual machines through configured infrastructure backends. Supports Proxmox profiles and generic webhook adapters. Authentication MUST come from a server-side 'profile' — credentials never enter model context.",
  parameters: VM_TOOL_PARAMETERS,
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    return executeVmTool(args, ctx, { allowWebhook: true, legacyProxmoxOnly: false });
  },
});

registerTool({
  name: "proxmox_vm",
  description: "Manage Proxmox virtual machines through the Proxmox VE API. Supports cloning from templates, starting/stopping VMs, checking status, and retrieving guest IPs. Authentication MUST come from a server-side 'profile' — credentials never enter model context.",
  parameters: VM_TOOL_PARAMETERS,
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    return executeVmTool(args, ctx, { allowWebhook: false, legacyProxmoxOnly: true });
  },
});

async function executeVmTool(
  args: Record<string, unknown>,
  _ctx: ToolContext,
  options: { allowWebhook: boolean; legacyProxmoxOnly: boolean },
): Promise<ToolResult> {
  const action = String(args["action"] ?? "").trim() as VmAction;
  const vmId = toPositiveInt(args["vmId"]);
  const requestedBackend = optionalString(args["backend"]);
  const profileName = optionalString(args["profile"]);
  const profile = profileName ? getConfig().infrastructure.virtualization.profiles[profileName] : undefined;

  if (!action || !VM_ACTIONS.includes(action)) {
    return { success: false, output: "", error: "action is required and must be a supported VM operation" };
  }
  if (!vmId) {
    return { success: false, output: "", error: "vmId is required" };
  }
  if (profileName && !profile) {
    return { success: false, output: "", error: `Unknown virtualization profile '${profileName}'` };
  }

  const backendResolution = resolveVmBackend(requestedBackend, profile?.type, options);
  if (!backendResolution.success) {
    return { success: false, output: "", error: backendResolution.error };
  }

  if (backendResolution.backend === "webhook") {
    return executeWebhookVmAction(action, vmId, args, profileName, profile as { type: "webhook"; url: string; headers?: Record<string, string>; timeoutMs: number });
  }

  const apiUrl = normalizeApiUrl(optionalString(args["apiUrl"]) ?? (profile?.type === "proxmox" ? profile.apiUrl : ""));
  const node = optionalString(args["node"]) ?? (profile?.type === "proxmox" ? profile.node : undefined);
  const timeoutMs = normalizeExecutionTimeout(args["timeoutMs"] ?? profile?.timeoutMs, DEFAULT_TIMEOUT_MS);

  if (!apiUrl || !node) {
    return { success: false, output: "", error: "apiUrl and node are required unless provided by a proxmox profile" };
  }

  const auth = await createAuthContext({
    apiUrl,
    username: optionalString(args["username"]) ?? (profile?.type === "proxmox" ? profile.username : undefined),
    password: optionalString(args["password"]) ?? (profile?.type === "proxmox" ? profile.password : undefined),
    tokenId: optionalString(args["tokenId"]) ?? (profile?.type === "proxmox" ? profile.tokenId : undefined),
    tokenSecret: optionalString(args["tokenSecret"]) ?? (profile?.type === "proxmox" ? profile.tokenSecret : undefined),
  }, timeoutMs);

  if (!auth.success) {
    return { success: false, output: "", error: auth.error };
  }

  try {
    switch (action) {
      case "clone":
        return await cloneVm(apiUrl, node, vmId, args, auth.value, timeoutMs);
      case "start":
        return await runStatusAction(apiUrl, node, vmId, "start", auth.value, timeoutMs);
      case "stop":
        return await runStatusAction(apiUrl, node, vmId, "stop", auth.value, timeoutMs);
      case "status":
        return await readStatus(apiUrl, node, vmId, auth.value, timeoutMs);
      case "delete":
        return await deleteVm(apiUrl, node, vmId, auth.value, timeoutMs);
      case "get_ip":
        return await getVmIp(apiUrl, node, vmId, auth.value, timeoutMs);
      default:
        return { success: false, output: "", error: `Unsupported action '${action}'` };
    }
  } catch (error) {
    log.error({ err: error, action, node, vmId }, "VM action failed");
    return {
      success: false,
      output: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function resolveVmBackend(
  requestedBackend: string | undefined,
  profileType: string | undefined,
  options: { allowWebhook: boolean; legacyProxmoxOnly: boolean },
): { success: true; backend: VmBackend } | { success: false; error: string } {
  const normalizedRequested = requestedBackend === "auto" || !requestedBackend ? undefined : requestedBackend;

  if (options.legacyProxmoxOnly) {
    if (profileType && profileType !== "proxmox") {
      return { success: false, error: "proxmox_vm only supports proxmox profiles. Use vm_manage for generic backends." };
    }
    if (normalizedRequested && normalizedRequested !== "proxmox") {
      return { success: false, error: "proxmox_vm only supports the proxmox backend. Use vm_manage for generic backends." };
    }
    return { success: true, backend: "proxmox" };
  }

  const resolvedBackend = (normalizedRequested ?? profileType ?? "proxmox") as VmBackend;
  if (resolvedBackend === "webhook" && !options.allowWebhook) {
    return { success: false, error: "This tool does not allow the webhook backend." };
  }
  if (profileType && normalizedRequested && profileType !== normalizedRequested) {
    return { success: false, error: `Profile backend '${profileType}' does not match requested backend '${normalizedRequested}'` };
  }
  return { success: true, backend: resolvedBackend };
}

async function executeWebhookVmAction(
  action: VmAction,
  vmId: number,
  args: Record<string, unknown>,
  profileName: string | undefined,
  profile: { type: "webhook"; url: string; headers?: Record<string, string>; timeoutMs: number },
): Promise<ToolResult> {
  if (!profile) {
    return { success: false, output: "", error: "vm_manage with backend=webhook requires a webhook profile" };
  }

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...resolveWebhookHeaders(profile.headers ?? {}),
  };
  const timeoutMs = normalizeExecutionTimeout(args["timeoutMs"] ?? profile.timeoutMs, DEFAULT_TIMEOUT_MS);
  const payload = {
    action,
    vmId,
    profile: profileName,
    params: Object.fromEntries(Object.entries(args).filter(([key]) => key !== "backend" && key !== "profile")),
  };

  try {
    const response = await fetchWithTimeout(profile.url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    }, timeoutMs);

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { success: false, output: "", error: `VM webhook returned HTTP ${response.status}: ${body.slice(0, 400)}` };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("json")) {
      const body = await response.json() as Record<string, unknown>;
      if (typeof body["success"] === "boolean") {
        return {
          success: Boolean(body["success"]),
          output: typeof body["output"] === "string" ? body["output"] : "",
          error: typeof body["error"] === "string" ? body["error"] : undefined,
          metadata: {
            backend: "webhook",
            profile: profileName,
            ...(body["metadata"] && typeof body["metadata"] === "object" ? body["metadata"] as Record<string, unknown> : {}),
          },
        };
      }

      return {
        success: true,
        output: JSON.stringify(body).slice(0, 4000),
        metadata: { backend: "webhook", profile: profileName },
      };
    }

    return {
      success: true,
      output: (await response.text()).slice(0, 4000),
      metadata: { backend: "webhook", profile: profileName },
    };
  } catch (error) {
    log.error({ err: error, action, vmId, profile: profileName }, "VM webhook action failed");
    return {
      success: false,
      output: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function resolveWebhookHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      value.replace(/\$([A-Z0-9_]+)/gi, (_match, envName: string) => process.env[envName] ?? ""),
    ]),
  );
}

interface AuthHeaders {
  headers: Record<string, string>;
  csrfToken?: string;
}

async function cloneVm(
  apiUrl: string,
  node: string,
  vmId: number,
  args: Record<string, unknown>,
  auth: AuthHeaders,
  timeoutMs: number,
): Promise<ToolResult> {
  const sourceVmid = toPositiveInt(args["sourceVmid"]);
  const name = optionalString(args["name"]);
  if (!sourceVmid || !name) {
    return { success: false, output: "", error: "clone requires sourceVmid and name" };
  }

  const form = new URLSearchParams();
  form.set("newid", String(vmId));
  form.set("name", name);
  form.set("full", String(args["fullClone"] !== false ? 1 : 0));
  form.set("target", optionalString(args["targetNode"]) ?? node);

  const storage = optionalString(args["storage"]);
  const pool = optionalString(args["pool"]);
  if (storage) form.set("storage", storage);
  if (pool) form.set("pool", pool);

  const task = await postTask(
    `${apiUrl}/nodes/${encodeURIComponent(node)}/qemu/${sourceVmid}/clone`,
    form,
    auth,
    timeoutMs,
  );
  await waitForTask(apiUrl, node, task, auth, timeoutMs);

  const configForm = new URLSearchParams();
  const cores = toPositiveInt(args["cores"]);
  const memoryMb = toPositiveInt(args["memoryMb"]);
  const cloudInitUser = optionalString(args["cloudInitUser"]);
  const sshPublicKeys = optionalString(args["sshPublicKeys"]);
  if (cores) configForm.set("cores", String(cores));
  if (memoryMb) configForm.set("memory", String(memoryMb));
  if (cloudInitUser) configForm.set("ciuser", cloudInitUser);
  if (sshPublicKeys) configForm.set("sshkeys", sshPublicKeys);

  if ([...configForm.keys()].length > 0) {
    const configTask = await postTask(
      `${apiUrl}/nodes/${encodeURIComponent(node)}/qemu/${vmId}/config`,
      configForm,
      auth,
      timeoutMs,
    );
    await waitForTask(apiUrl, node, configTask, auth, timeoutMs);
  }

  let ipAddress: string | undefined;
  if (args["startAfterClone"] !== false) {
    await runStatusAction(apiUrl, node, vmId, "start", auth, timeoutMs);
    if (args["waitForIp"] === true) {
      ipAddress = await waitForVmIp(apiUrl, node, vmId, auth, timeoutMs);
    }
  }

  const status = await readStatus(apiUrl, node, vmId, auth, timeoutMs);
  return {
    success: true,
    output: [
      `VM cloned successfully`,
      `Node: ${node}`,
      `VM ID: ${vmId}`,
      `Name: ${name}`,
      ipAddress ? `IP: ${ipAddress}` : undefined,
      status.output ? `Status: ${status.output}` : undefined,
    ].filter(Boolean).join("\n"),
    metadata: {
      node,
      vmId,
      sourceVmid,
      name,
      ipAddress,
      started: args["startAfterClone"] !== false,
    },
  };
}

async function runStatusAction(
  apiUrl: string,
  node: string,
  vmId: number,
  action: "start" | "stop",
  auth: AuthHeaders,
  timeoutMs: number,
): Promise<ToolResult> {
  const task = await postTask(
    `${apiUrl}/nodes/${encodeURIComponent(node)}/qemu/${vmId}/status/${action}`,
    new URLSearchParams(),
    auth,
    timeoutMs,
  );
  await waitForTask(apiUrl, node, task, auth, timeoutMs);
  const status = await readStatus(apiUrl, node, vmId, auth, timeoutMs);
  return {
    success: true,
    output: `VM ${action} completed\n${status.output}`,
    metadata: { node, vmId, action },
  };
}

async function readStatus(
  apiUrl: string,
  node: string,
  vmId: number,
  auth: AuthHeaders,
  timeoutMs: number,
): Promise<ToolResult> {
  const body = await proxmoxJson<{ data?: Record<string, unknown> }>(
    `${apiUrl}/nodes/${encodeURIComponent(node)}/qemu/${vmId}/status/current`,
    { method: "GET", headers: auth.headers },
    timeoutMs,
  );

  const data = body.data ?? {};
  return {
    success: true,
    output: [
      `Status: ${String(data["status"] ?? "unknown")}`,
      data["qmpstatus"] ? `QMP: ${String(data["qmpstatus"])}` : undefined,
      typeof data["name"] === "string" ? `Name: ${String(data["name"])}` : undefined,
      typeof data["cpu"] === "number" ? `CPU usage: ${String(data["cpu"])}` : undefined,
      typeof data["mem"] === "number" ? `Memory bytes: ${String(data["mem"])}` : undefined,
      typeof data["uptime"] === "number" ? `Uptime: ${String(data["uptime"])}s` : undefined,
    ].filter(Boolean).join("\n"),
    metadata: { node, vmId, ...data },
  };
}

async function deleteVm(
  apiUrl: string,
  node: string,
  vmId: number,
  auth: AuthHeaders,
  timeoutMs: number,
): Promise<ToolResult> {
  const headers = withCsrf(auth, {});
  const response = await proxmoxJson<{ data?: string }>(
    `${apiUrl}/nodes/${encodeURIComponent(node)}/qemu/${vmId}?purge=1&destroy-unreferenced-disks=1`,
    { method: "DELETE", headers },
    timeoutMs,
  );

  const task = String(response.data ?? "");
  if (task) {
    await waitForTask(apiUrl, node, task, auth, timeoutMs);
  }

  return {
    success: true,
    output: `VM deleted\nNode: ${node}\nVM ID: ${vmId}`,
    metadata: { node, vmId },
  };
}

async function getVmIp(
  apiUrl: string,
  node: string,
  vmId: number,
  auth: AuthHeaders,
  timeoutMs: number,
): Promise<ToolResult> {
  const ipAddress = await getPreferredVmIp(apiUrl, node, vmId, auth, timeoutMs);
  if (!ipAddress) {
    return {
      success: false,
      output: "",
      error: "No guest IP reported. Ensure qemu-guest-agent is installed and the VM has networking.",
    };
  }

  return {
    success: true,
    output: `VM IP: ${ipAddress}`,
    metadata: { node, vmId, ipAddress },
  };
}

async function waitForVmIp(
  apiUrl: string,
  node: string,
  vmId: number,
  auth: AuthHeaders,
  timeoutMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ip = await getPreferredVmIp(apiUrl, node, vmId, auth, timeoutMs);
    if (ip) {
      return ip;
    }
    await delay(IP_POLL_MS);
  }

  return undefined;
}

async function getPreferredVmIp(
  apiUrl: string,
  node: string,
  vmId: number,
  auth: AuthHeaders,
  timeoutMs: number,
): Promise<string | undefined> {
  const body = await proxmoxJson<{ data?: { result?: Array<{ name?: string; "ip-addresses"?: Array<{ "ip-address"?: string; "ip-address-type"?: string }> }> } }>(
    `${apiUrl}/nodes/${encodeURIComponent(node)}/qemu/${vmId}/agent/network-get-interfaces`,
    { method: "GET", headers: auth.headers },
    timeoutMs,
  );

  const interfaces = body.data?.result ?? [];
  for (const networkInterface of interfaces) {
    for (const ipAddress of networkInterface["ip-addresses"] ?? []) {
      const address = ipAddress["ip-address"];
      const addressType = ipAddress["ip-address-type"];
      if (!address || addressType !== "ipv4") continue;
      if (address.startsWith("127.") || address.startsWith("169.254.")) continue;
      return address;
    }
  }

  return undefined;
}

async function createAuthContext(
  input: {
    apiUrl: string;
    username?: string;
    password?: string;
    tokenId?: string;
    tokenSecret?: string;
  },
  timeoutMs: number,
): Promise<{ success: true; value: AuthHeaders } | { success: false; error: string }> {
  const tokenId = input.tokenId?.trim();
  const tokenSecret = resolveSecretRef(input.tokenSecret)?.trim();
  if (tokenId && tokenSecret) {
    return {
      success: true,
      value: {
        headers: {
          Authorization: `PVEAPIToken=${tokenId}=${tokenSecret}`,
        },
      },
    };
  }

  const username = input.username?.trim();
  const password = resolveSecretRef(input.password)?.trim();
  if (!username || !password) {
    return {
      success: false,
      error: "Proxmox authentication is missing. Configure a 'profile' under infrastructure.virtualization with tokenId+tokenSecret or username+password (use $ENV_VAR or secret:key references — credentials must not enter model context).",
    };
  }

  const form = new URLSearchParams();
  form.set("username", username);
  form.set("password", password);
  const response = await proxmoxJson<{ data?: { ticket?: string; CSRFPreventionToken?: string } }>(
    `${input.apiUrl}/access/ticket`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    },
    timeoutMs,
  );

  const ticket = response.data?.ticket;
  if (!ticket) {
    return { success: false, error: "Proxmox login did not return a ticket" };
  }

  return {
    success: true,
    value: {
      headers: {
        Cookie: `PVEAuthCookie=${ticket}`,
      },
      csrfToken: response.data?.CSRFPreventionToken,
    },
  };
}

async function postTask(url: string, form: URLSearchParams, auth: AuthHeaders, timeoutMs: number): Promise<string> {
  const headers = withCsrf(auth, { "Content-Type": "application/x-www-form-urlencoded" });
  const response = await proxmoxJson<{ data?: string }>(url, {
    method: "POST",
    headers,
    body: form.toString(),
  }, timeoutMs);

  const task = String(response.data ?? "").trim();
  if (!task) {
    throw new Error("Proxmox task request returned no task ID");
  }
  return task;
}

async function waitForTask(apiUrl: string, node: string, taskId: string, auth: AuthHeaders, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = await proxmoxJson<{ data?: Record<string, unknown> }>(
      `${apiUrl}/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(taskId)}/status`,
      { method: "GET", headers: auth.headers },
      timeoutMs,
    );

    const data = body.data ?? {};
    if (String(data["status"] ?? "") === "stopped") {
      const exitStatus = String(data["exitstatus"] ?? "OK");
      if (exitStatus !== "OK") {
        throw new Error(`Proxmox task failed: ${exitStatus}`);
      }
      return;
    }

    await delay(TASK_POLL_MS);
  }

  throw new Error(`Timed out waiting for Proxmox task ${taskId}`);
}

async function proxmoxJson<T>(url: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Proxmox API request failed (${response.status}): ${text.slice(0, 400) || response.statusText}`);
    }
    return await response.json() as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Proxmox API request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function withCsrf(auth: AuthHeaders, headers: Record<string, string>): Record<string, string> {
  return {
    ...auth.headers,
    ...headers,
    ...(auth.csrfToken ? { CSRFPreventionToken: auth.csrfToken } : {}),
  };
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function toPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : undefined;
}

function normalizeApiUrl(apiUrl: string): string {
  const trimmed = apiUrl.trim().replace(/\/$/, "");
  if (!trimmed) return "";
  if (trimmed.endsWith("/api2/json")) return trimmed;
  return `${trimmed}/api2/json`;
}

function normalizeTimeout(value: unknown): number {
  return normalizeExecutionTimeout(value, DEFAULT_TIMEOUT_MS);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}