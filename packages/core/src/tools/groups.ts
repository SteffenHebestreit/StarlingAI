/**
 * Tool groups — config-driven disabling of built-in capability families.
 *
 * Forks of this codebase (see docs/fork-boilerplate-plan.md) often don't want
 * whole families of built-in tools: a medical-office fork has no business
 * shipping pentest tooling. Before this module the only way out was deleting
 * the tool files and editing index.ts — the worst possible rebase-conflict
 * surface. Now the fork ships config instead:
 *
 *   // <product>.json
 *   { "tools": { "disabledGroups": ["pentest", "infrastructure"] } }
 *
 * Disabled tools are skipped at registration time (registerTool no-ops with
 * an info log), so they don't exist anywhere downstream: not in the registry,
 * not in LLM tool defs, not in the dashboard.
 *
 * Group membership for built-ins lives here (single upstream-owned map, so
 * tool files stay untouched). Extension tools declare `group` on the handler
 * instead — both paths are honored by isToolDisabled().
 */

import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";

const log = childLogger("tool-groups");

/**
 * Built-in tool → group map. Only coherent, disable-worthy families are
 * grouped; ungrouped built-ins can still be disabled individually via
 * `tools.disabledTools`.
 */
export const BUILTIN_TOOL_GROUPS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  /** Offensive security: scanners, exploitation, reporting. */
  pentest: [
    "nmap_scan",
    "nikto_scan",
    "gobuster_scan",
    "sqlmap_scan",
    "hydra_attack",
    "metasploit_exec",
    "searchsploit_query",
    "pentest_exec",
    "pentest_report",
    "pentest_set_scope",
  ],
  /** Remote-host + IaC management: SSH, Ansible, Proxmox, Terraform. */
  infrastructure: [
    "ssh_exec",
    "ssh_upload",
    "ssh_download",
    "service_check",
    "ansible_playbook",
    "ansible_task",
    "proxmox_vm",
    "vm_manage",
    "terraform_exec",
  ],
  /** Cluster operations: kubectl + helm. */
  kubernetes: [
    "kubectl_get",
    "kubectl_describe",
    "kubectl_logs",
    "kubectl_top",
    "kubectl_apply",
    "kubectl_delete",
    "kubectl_rollout_restart",
    "kubectl_scale",
    "helm_list",
    "helm_upgrade",
    "helm_rollback",
  ],
  /** Monitoring stacks: Prometheus, Alertmanager, Grafana. */
  observability: [
    "prometheus_query",
    "alertmanager_silences_list",
    "alertmanager_silence_create",
    "alertmanager_silence_expire",
    "grafana_dashboard_search",
    "grafana_alerts_list",
    "grafana_dashboard_apply",
    "grafana_alert_apply",
  ],
});

let _toolToGroup: Map<string, string> | null = null;

function toolToGroup(): Map<string, string> {
  if (!_toolToGroup) {
    _toolToGroup = new Map();
    for (const [group, tools] of Object.entries(BUILTIN_TOOL_GROUPS)) {
      for (const tool of tools) _toolToGroup.set(tool, group);
    }
  }
  return _toolToGroup;
}

/** The group a tool belongs to: handler-declared (extensions) or built-in map. */
export function resolveToolGroup(toolName: string, declaredGroup?: string): string | undefined {
  return declaredGroup ?? toolToGroup().get(toolName);
}

const _warnedUnknownGroups = new Set<string>();

/**
 * True when config disables this tool — by name or via its group.
 * Reads config lazily so it works during side-effect tool registration
 * (config loads synchronously on first access).
 */
export function isToolDisabled(toolName: string, declaredGroup?: string): boolean {
  let cfg: { disabledGroups?: string[]; disabledTools?: string[] } | undefined;
  try {
    cfg = (getConfig() as { tools?: { disabledGroups?: string[]; disabledTools?: string[] } }).tools;
  } catch {
    // Config not loadable (e.g. isolated unit tests constructing registries
    // directly) — fail open: nothing is disabled.
    return false;
  }
  if (!cfg) return false;

  if (cfg.disabledTools?.includes(toolName)) return true;

  const groups = cfg.disabledGroups ?? [];
  if (groups.length === 0) return false;
  for (const g of groups) {
    if (!(g in BUILTIN_TOOL_GROUPS) && !_warnedUnknownGroups.has(g)) {
      // Unknown names are tolerated (configs travel across versions/forks
      // whose extensions declare their own groups) but surfaced once.
      _warnedUnknownGroups.add(g);
      log.warn({ group: g }, "tools.disabledGroups names a group with no built-in members");
    }
  }
  const group = resolveToolGroup(toolName, declaredGroup);
  return group !== undefined && groups.includes(group);
}

/** Test hook: reset memoized state. */
export function _resetToolGroupsForTests(): void {
  _toolToGroup = null;
  _warnedUnknownGroups.clear();
}
