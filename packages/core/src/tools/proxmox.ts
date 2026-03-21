import { getCredential } from "../credentials/store.js";
import { childLogger } from "../logger.js";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";

const log = childLogger("tool:proxmox");
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 15 * 60_000;
const TASK_POLL_MS = 2_000;
const IP_POLL_MS = 3_000;

registerTool({
  name: "proxmox_vm",
  description: "Manage Proxmox virtual machines through the Proxmox VE API. Supports cloning from templates, starting/stopping VMs, checking status, and retrieving guest IPs.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["clone", "start", "stop", "status", "delete", "get_ip"],
        description: "VM action to perform",
      },
      apiUrl: {
        type: "string",
        description: "Base Proxmox API URL, e.g. https://proxmox.example.com:8006/api2/json",
      },
      username: {
        type: "string",
        description: "Proxmox username for password login, e.g. root@pam",
      },
      password: {
        type: "string",
        description: "Password, $ENV_VAR, or secret:key for password login",
      },
      tokenId: {
        type: "string",
        description: "API token identifier, e.g. root@pam!starlingai",
      },
      tokenSecret: {
        type: "string",
        description: "API token secret, $ENV_VAR, or secret:key",
      },
      node: {
        type: "string",
        description: "Target Proxmox node name",
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
        description: "Optional Proxmox pool name",
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
    required: ["action", "apiUrl", "node", "vmId"],
  },
  async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    const action = String(args["action"] ?? "").trim();
    const apiUrl = normalizeApiUrl(String(args["apiUrl"] ?? ""));
    const node = String(args["node"] ?? "").trim();
    const vmId = toPositiveInt(args["vmId"]);
    const timeoutMs = normalizeTimeout(args["timeoutMs"]);

    if (!action || !apiUrl || !node || !vmId) {
      return { success: false, output: "", error: "action, apiUrl, node, and vmId are required" };
    }

    const auth = await createAuthContext({
      apiUrl,
      username: optionalString(args["username"]),
      password: optionalString(args["password"]),
      tokenId: optionalString(args["tokenId"]),
      tokenSecret: optionalString(args["tokenSecret"]),
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
      log.error({ err: error, action, node, vmId }, "Proxmox VM action failed");
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
});

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
      error: "Provide either tokenId + tokenSecret or username + password for Proxmox authentication",
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

function resolveSecretRef(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("$")) {
    return process.env[value.slice(1)];
  }
  if (value.startsWith("secret:")) {
    return getCredential(value.slice("secret:".length));
  }
  return value;
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
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(1_000, Math.min(MAX_TIMEOUT_MS, Math.trunc(value)));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}