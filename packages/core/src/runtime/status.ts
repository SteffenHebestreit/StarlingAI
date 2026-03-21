export type RuntimeComponentName = "config_reload" | "channels" | "webhooks" | "mcp" | "providers" | "approvals" | "model_endpoints";

export interface RuntimeComponentStatus {
  name: RuntimeComponentName;
  healthy: boolean;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  details?: Record<string, unknown>;
}

export interface RuntimeStatusSnapshot {
  healthy: boolean;
  components: RuntimeComponentStatus[];
}

const componentNames: RuntimeComponentName[] = ["config_reload", "channels", "webhooks", "mcp", "providers", "approvals", "model_endpoints"];

const componentStatus = new Map<RuntimeComponentName, RuntimeComponentStatus>(
  componentNames.map((name) => [name, { name, healthy: true }]),
);

export function markRuntimeComponentAttempt(name: RuntimeComponentName): void {
  const existing = componentStatus.get(name) ?? { name, healthy: true };
  componentStatus.set(name, {
    ...existing,
    name,
    lastAttemptAt: new Date().toISOString(),
  });
}

export function markRuntimeComponentSuccess(
  name: RuntimeComponentName,
  details?: Record<string, unknown>,
  opts?: { healthy?: boolean; error?: string },
): void {
  const existing = componentStatus.get(name) ?? { name, healthy: true };
  componentStatus.set(name, {
    ...existing,
    name,
    healthy: opts?.healthy ?? true,
    lastAttemptAt: existing.lastAttemptAt ?? new Date().toISOString(),
    lastSuccessAt: new Date().toISOString(),
    lastError: opts?.error,
    details,
  });
}

export function markRuntimeComponentFailure(
  name: RuntimeComponentName,
  error: unknown,
  details?: Record<string, unknown>,
): void {
  const existing = componentStatus.get(name) ?? { name, healthy: true };
  componentStatus.set(name, {
    ...existing,
    name,
    healthy: false,
    lastAttemptAt: new Date().toISOString(),
    lastError: normalizeError(error),
    details,
  });
}

export function getRuntimeStatusSnapshot(): RuntimeStatusSnapshot {
  const components = componentNames.map((name) => componentStatus.get(name) ?? { name, healthy: true });
  return {
    healthy: components.every((component) => component.healthy),
    components,
  };
}

export function resetRuntimeStatusForTests(): void {
  componentStatus.clear();
  for (const name of componentNames) {
    componentStatus.set(name, { name, healthy: true });
  }
}

function normalizeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}