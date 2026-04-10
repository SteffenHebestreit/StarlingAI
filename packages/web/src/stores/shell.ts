import { defineStore } from "pinia";
import { computed, ref } from "vue";

export type ShellToolName = "ssh_exec" | "shell_exec" | "run_script";

export interface ShellExecution {
  id: string;
  requestId?: string;
  toolCallId?: string;
  toolName: ShellToolName;
  title: string;
  target?: string;
  command: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  status: "running" | "completed" | "failed";
  outputPreview?: string;
  metadata?: Record<string, unknown>;
}

const INTERESTING_TOOLS = new Set<ShellToolName>(["ssh_exec", "shell_exec", "run_script"]);
const MAX_ENTRIES = 20;

export const useShellStore = defineStore("shell", () => {
  const executions = ref<ShellExecution[]>([]);
  const observedExecutionId = ref<string | null>(null);

  const activeExecutions = computed(() => executions.value.filter((entry) => entry.status === "running"));
  const recentExecutions = computed(() => executions.value.slice(0, 10));
  const hasEntries = computed(() => executions.value.length > 0);
  const observedExecution = computed(() => {
    const explicitlyObserved = observedExecutionId.value
      ? executions.value.find((entry) => entry.id === observedExecutionId.value)
      : undefined;
    return explicitlyObserved ?? activeExecutions.value[0] ?? recentExecutions.value[0] ?? null;
  });

  function reset() {
    executions.value = [];
    observedExecutionId.value = null;
  }

  function observeExecution(id: string | null) {
    observedExecutionId.value = id;
  }

  function handleToolStart(data: Record<string, unknown>) {
    const toolName = normalizeToolName(data["name"]);
    if (!toolName) return;

    const args = asRecord(data["args"]);
    const toolCallId = typeof data["toolCallId"] === "string" ? data["toolCallId"] : undefined;
    const requestId = typeof data["requestId"] === "string" ? data["requestId"] : undefined;
    const id = toolCallId ?? `${requestId ?? "request"}:${toolName}:${Date.now()}`;
    const now = Date.now();

    const next: ShellExecution = {
      id,
      requestId,
      toolCallId,
      toolName,
      title: buildTitle(toolName, args),
      target: buildTarget(toolName, args),
      command: buildCommand(toolName, args),
      startedAt: now,
      updatedAt: now,
      status: "running",
    };

    upsertExecution(next);
    if (!observedExecutionId.value || activeExecutions.value.length <= 1) {
      observedExecutionId.value = id;
    }
  }

  function handleToolDone(data: Record<string, unknown>) {
    const toolName = normalizeToolName(data["name"]);
    if (!toolName) return;

    const toolCallId = typeof data["toolCallId"] === "string" ? data["toolCallId"] : undefined;
    const requestId = typeof data["requestId"] === "string" ? data["requestId"] : undefined;
    const result = String(data["result"] ?? "");
    const metadata = asRecord(data["metadata"]);
    const failed = /^Error:/i.test(result.trim());
    const now = Date.now();

    const existingIndex = findExecutionIndex(toolCallId, requestId, toolName);
    if (existingIndex === -1) {
      const fallback: ShellExecution = {
        id: toolCallId ?? `${requestId ?? "request"}:${toolName}:${Date.now()}`,
        requestId,
        toolCallId,
        toolName,
        title: buildTitle(toolName, metadata),
        target: buildTarget(toolName, metadata),
        command: buildCommand(toolName, metadata),
        startedAt: now,
        updatedAt: now,
        finishedAt: now,
        status: failed ? "failed" : "completed",
        outputPreview: result,
        metadata,
      };
      upsertExecution(fallback);
      return;
    }

    const current = executions.value[existingIndex]!;
    executions.value[existingIndex] = {
      ...current,
      updatedAt: now,
      finishedAt: now,
      status: failed ? "failed" : "completed",
      outputPreview: result,
      metadata: Object.keys(metadata).length > 0 ? metadata : current.metadata,
      target: current.target ?? buildTarget(toolName, metadata),
      command: current.command || buildCommand(toolName, metadata),
    };
  }

  function upsertExecution(entry: ShellExecution) {
    const existingIndex = executions.value.findIndex((current) => current.id === entry.id);
    if (existingIndex >= 0) {
      executions.value[existingIndex] = {
        ...executions.value[existingIndex]!,
        ...entry,
      };
      return;
    }

    executions.value = [entry, ...executions.value].slice(0, MAX_ENTRIES);
  }

  function findExecutionIndex(toolCallId: string | undefined, requestId: string | undefined, toolName: ShellToolName): number {
    if (toolCallId) {
      const exactIndex = executions.value.findIndex((entry) => entry.toolCallId === toolCallId);
      if (exactIndex >= 0) return exactIndex;
    }

    return executions.value.findIndex((entry) => (
      entry.toolName === toolName
      && entry.status === "running"
      && (!requestId || entry.requestId === requestId)
    ));
  }

  return {
    executions,
    activeExecutions,
    recentExecutions,
    hasEntries,
    observedExecutionId,
    observedExecution,
    reset,
    observeExecution,
    handleToolStart,
    handleToolDone,
  };
});

function normalizeToolName(value: unknown): ShellToolName | null {
  if (typeof value !== "string") return null;
  return INTERESTING_TOOLS.has(value as ShellToolName) ? (value as ShellToolName) : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function buildTitle(toolName: ShellToolName, value: Record<string, unknown>): string {
  if (toolName === "ssh_exec") return "Remote Shell";
  if (toolName === "run_script") return "Sandbox Script";
  return "Sandbox Shell";
}

function buildTarget(toolName: ShellToolName, value: Record<string, unknown>): string | undefined {
  if (toolName === "ssh_exec") {
    const nodeName = typeof value["nodeName"] === "string" ? value["nodeName"].trim() : "";
    if (nodeName) return nodeName;
    const host = typeof value["host"] === "string" ? value["host"].trim() : "";
    const username = typeof value["username"] === "string" ? value["username"].trim() : "";
    if (host && username) return `${username}@${host}`;
    if (host) return host;
  }

  if (toolName === "shell_exec") {
    const workdir = typeof value["workdir"] === "string" ? value["workdir"].trim() : "";
    return workdir || "/workspace";
  }

  if (toolName === "run_script") {
    const path = typeof value["path"] === "string" ? value["path"].trim() : "";
    return path || undefined;
  }

  return undefined;
}

function buildCommand(toolName: ShellToolName, value: Record<string, unknown>): string {
  if (toolName === "run_script") {
    const path = typeof value["path"] === "string" ? value["path"].trim() : "";
    const args = Array.isArray(value["args"])
      ? (value["args"] as unknown[]).map((entry) => String(entry)).filter(Boolean)
      : [];
    return [path, ...args].filter(Boolean).join(" ") || "(script path unavailable)";
  }

  const command = typeof value["command"] === "string" ? value["command"].trim() : "";
  return command || "(command unavailable)";
}