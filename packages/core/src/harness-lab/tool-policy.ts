/**
 * What a lab turn may do. A lab run replays tasks unattended, many times, on prompts nobody has
 * approved yet, so every tool that reaches outside the lab's own scratch workspace is either taken
 * out of the registry (denied: the model never sees it) or stubbed (the model sees it and its call
 * is recorded, with its arguments, but nothing runs). Everything else runs as it does live.
 */
import { BUILTIN_TOOL_GROUPS, resolveToolGroup } from "../tools/groups.js";
import { installToolRegistrationPolicy, type ToolResult } from "../tools/registry.js";

export type LabToolDisposition = "pass" | "stub" | "deny";

/** Real infrastructure, real desktops, real mailboxes, real credentials, the deployment's own config. */
const DENIED_GROUPS = ["pentest", "infrastructure", "kubernetes", "observability"];
const DENIED_PREFIXES = ["computer_", "mail_", "tool_dev_"];
/** Any tool that reads, fills or extracts a stored secret, whatever its prefix. */
const DENIED_SUBSTRINGS = ["credential", "password"];
const DENIED_TOOLS = new Set([
  "git_push",
  "swarm_define_agent",
  "swarm_save_scene",
  "swarm_save_job",
  "create_knowledge_base",
  "request_new_capability",
  "request_human_assist",
]);

/** Messages to people or peers, schedules, and writes to memory and stores other runs share. */
const STUBBED_TOOLS = new Set([
  "send_email",
  "send_slack",
  "send_discord",
  "send_telegram",
  "send_agent_message",
  "swarm_delegate",
  "http_request",
  "cron_create",
  "cron_remove",
  "schedule_task",
  "schedule_remove",
  "memory_store",
  "memory_promote",
  "memory_import",
  "memory_compact",
  "user_model_update",
  "agent_store_write",
  "agent_store_delete",
]);

export interface LabToolPolicyExtra {
  stub?: string[];
  deny?: string[];
}

export function classifyLabTool(name: string, group?: string, extra: LabToolPolicyExtra = {}): LabToolDisposition {
  if (extra.deny?.includes(name) || DENIED_TOOLS.has(name)) return "deny";
  if (DENIED_PREFIXES.some((prefix) => name.startsWith(prefix))) return "deny";
  if (DENIED_SUBSTRINGS.some((part) => name.includes(part))) return "deny";
  const resolved = resolveToolGroup(name, group);
  if (resolved && DENIED_GROUPS.includes(resolved)) return "deny";
  if (DENIED_GROUPS.some((g) => BUILTIN_TOOL_GROUPS[g]?.includes(name))) return "deny";
  if (extra.stub?.includes(name) || STUBBED_TOOLS.has(name)) return "stub";
  return "pass";
}

export interface StubbedCall {
  tool: string;
  args: Record<string, unknown>;
  at: string;
}

/** The current attempt's record of stubbed calls; the turn runner swaps it per attempt. */
let _stubSink: StubbedCall[] | null = null;

export function setStubSink(sink: StubbedCall[] | null): void {
  _stubSink = sink;
}

export function stubResult(tool: string): ToolResult {
  return {
    success: true,
    output: `[harness-lab] ${tool} was recorded, not executed: this is an evaluation run with no effect outside its workspace.`,
    metadata: { harnessLabStub: true },
  };
}

export interface LabToolPolicyRecord {
  /** Tools the policy left out of the registry, by name, as they were registered. */
  denied: Set<string>;
  /** Tools the policy stubbed. */
  stubbed: Set<string>;
}

/**
 * Apply the policy to every tool registered now and later (tools/registry.ts
 * installToolRegistrationPolicy): a tool a late import registers gets the same treatment.
 */
export function applyLabToolPolicy(extra: LabToolPolicyExtra = {}): LabToolPolicyRecord {
  const record: LabToolPolicyRecord = { denied: new Set(), stubbed: new Set() };
  installToolRegistrationPolicy((handler) => {
    const disposition = classifyLabTool(handler.name, handler.group, extra);
    if (disposition === "deny") {
      record.denied.add(handler.name);
      return null;
    }
    if (disposition === "stub") {
      record.stubbed.add(handler.name);
      const name = handler.name;
      return {
        ...handler,
        execute: async (args) => {
          _stubSink?.push({ tool: name, args, at: new Date().toISOString() });
          return stubResult(name);
        },
      };
    }
    return handler;
  });
  return record;
}
