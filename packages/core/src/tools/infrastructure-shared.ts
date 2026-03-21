import { randomBytes } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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