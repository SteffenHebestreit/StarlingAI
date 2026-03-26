import { randomBytes } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getConfig } from "../config/loader.js";
import type { InfrastructureAutomationProfile } from "../config/schema.js";
import { getCredential } from "../credentials/store.js";
import { resolvePathWithinWorkspace } from "./workspace-path.js";

const MAX_TIMEOUT_MS = 15 * 60_000;

export function normalizeExecutionTimeout(value: unknown, defaultMs: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultMs;
  }
  return Math.max(1_000, Math.min(MAX_TIMEOUT_MS, Math.trunc(value)));
}

export function materializeInventory(
  inventory: string,
  options?: { baseDir?: string; tempPrefix?: string },
): { path: string; shouldDelete: boolean } {
  const trimmed = inventory.trim();
  if (!trimmed) {
    throw new Error("inventory cannot be empty when provided");
  }

  if (existsSync(trimmed)) {
    return { path: trimmed, shouldDelete: false };
  }

  if (options?.baseDir) {
    const candidate = resolve(options.baseDir, trimmed);
    if (existsSync(candidate)) {
      return { path: candidate, shouldDelete: false };
    }
  }

  if (/[\r\n]/.test(trimmed) || /^\s*\[.+\]\s*$/m.test(trimmed)) {
    const inventoryPath = join(
      tmpdir(),
      `${options?.tempPrefix ?? "inventory"}_${randomBytes(6).toString("hex")}.ini`,
    );
    writeFileSync(inventoryPath, trimmed, { mode: 0o600 });
    return { path: inventoryPath, shouldDelete: true };
  }

  if (trimmed.includes(",")) {
    return { path: trimmed, shouldDelete: false };
  }

  return { path: `${trimmed},`, shouldDelete: false };
}

export function safeDelete(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup.
  }
}

export function formatCliExecutionError(
  error: { code?: string; killed?: boolean; signal?: string },
  binary: string,
  timeoutMessage?: string,
): string {
  if (error.code === "ENOENT") {
    return `${binary} is not installed or not on PATH`;
  }
  if (error.killed || error.signal === "SIGTERM") {
    return timeoutMessage ?? "Execution timed out. Check output for partial progress.";
  }
  return "Execution failed. Check output for details.";
}

export function isSafeConnectionTarget(value: string): boolean {
  return !(/[\s;&|`$<>\n\r]/.test(value));
}

export function isSafeRemotePath(value: string): boolean {
  return Boolean(value.trim()) && !(/[\n\r;]/.test(value));
}

export function resolveSecretRef(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("$")) {
    return process.env[value.slice(1)];
  }
  if (value.startsWith("secret:")) {
    return getCredential(value.slice("secret:".length));
  }
  return value;
}

export function resolveSecretRefs<T>(value: T): T {
  if (typeof value === "string") {
    return (resolveSecretRef(value) ?? value) as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveSecretRefs(item)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, resolveSecretRefs(item)]),
    ) as T;
  }
  return value;
}

export function resolveWebhookHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => {
      const resolved = resolveSecretRef(value) ?? value;
      return [
        key,
        resolved.replace(/\$([A-Z0-9_]+)/gi, (_match, envName: string) => process.env[envName] ?? ""),
      ];
    }),
  );
}

export function resolveWorkspaceRelativePath(
  inputPath: string,
  workspacePath: string,
  baseDir?: string,
): string {
  if (baseDir) {
    const candidate = resolve(baseDir, inputPath);
    return resolvePathWithinWorkspace(candidate, workspacePath).resolved;
  }
  return resolvePathWithinWorkspace(inputPath, workspacePath).resolved;
}

export function resolveAutomationProfile(
  requestedProfile: unknown,
): { profileName?: string; profile?: InfrastructureAutomationProfile; error?: string } {
  const config = getConfig();
  const explicitProfile = typeof requestedProfile === "string" && requestedProfile.trim()
    ? requestedProfile.trim()
    : undefined;
  const profileName = explicitProfile ?? config.infrastructure.automation.defaultProfile?.trim();

  if (!profileName) {
    return {};
  }

  const profile = config.infrastructure.automation.profiles[profileName];
  if (!profile) {
    return { error: `Unknown automation profile '${profileName}'` };
  }

  return { profileName, profile };
}

export async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function executeAutomationWebhook(
  toolName: string,
  profileName: string,
  profile: Extract<InfrastructureAutomationProfile, { type: "webhook" }>,
  args: Record<string, unknown>,
  defaultTimeoutMs: number,
): Promise<{ success: boolean; output: string; error?: string; metadata?: Record<string, unknown> }> {
  const timeoutMs = normalizeExecutionTimeout(args["timeoutMs"] ?? profile.timeoutMs, defaultTimeoutMs);
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    ...resolveWebhookHeaders(profile.headers ?? {}),
  };

  try {
    const response = await fetchWithTimeout(profile.url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: toolName,
        profile: profileName,
        params: args,
      }),
    }, timeoutMs);

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        success: false,
        output: "",
        error: `Automation webhook returned HTTP ${response.status}: ${body.slice(0, 400)}`,
      };
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
    return {
      success: false,
      output: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}