import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import {
  executeAutomationWebhook,
  formatCliExecutionError,
  materializeInventory,
  normalizeExecutionTimeout,
  resolveAutomationProfile,
  resolveSecretRef,
  resolveWorkspaceRelativePath,
  safeDelete,
} from "./infrastructure-shared.js";

const log = childLogger("tool:ansible");
const execFileAsync = promisify(execFile);

const EXEC_TIMEOUT_MS = 120_000; // Playbooks can take a while
registerTool({
  name: "ansible_playbook",
  description: "Execute an Ansible playbook on the host. Use for privileged infrastructure changes such as provisioning VMs or configuring remote systems.",
  parameters: {
    type: "object",
    properties: {
      playbookYaml: {
        type: "string",
        description: "The complete YAML content of the Ansible playbook",
      },
      playbookPath: {
        type: "string",
        description: "Workspace-relative playbook path. Useful when running an existing Ansible project.",
      },
      projectDir: {
        type: "string",
        description: "Optional workspace-relative Ansible project directory used as cwd for ansible-playbook.",
      },
      profile: {
        type: "string",
        description: "Optional infrastructure.automation profile name. Supports local-cli and webhook profiles.",
      },
      inventory: {
        type: "string",
        description: "Optional inventory source. Supports a single host, a comma-separated host list, an inventory file path, or raw inventory content.",
      },
      inventoryUrl: {
        type: "string",
        description: "Deprecated alias for inventory. Supports a single host or inventory file path.",
      },
      extraVars: {
        type: "object",
        description: "Extra variables to pass to the playbook (--extra-vars)",
        additionalProperties: true,
      },
      tags: {
        type: "array",
        description: "Optional list of Ansible tags to run",
        items: { type: "string" },
      },
      skipTags: {
        type: "array",
        description: "Optional list of Ansible tags to skip",
        items: { type: "string" },
      },
      limit: {
        type: "string",
        description: "Optional --limit value",
      },
      become: {
        type: "boolean",
        description: "Whether to run with privilege escalation",
      },
      check: {
        type: "boolean",
        description: "Whether to run in check mode",
      },
      diff: {
        type: "boolean",
        description: "Whether to request diff output when supported",
      },
      roleName: {
        type: "string",
        description: "Optional role name to run without authoring a full playbook",
      },
      hosts: {
        type: "string",
        description: "Host pattern used when roleName is provided. Defaults to all.",
      },
      roleVars: {
        type: "object",
        description: "Optional vars injected into the generated role playbook",
        additionalProperties: true,
      },
      vaultPassword: {
        type: "string",
        description: "Optional Ansible Vault password, $ENV_VAR, or secret:key. When provided, a temporary vault password file is created automatically.",
      },
      vaultPasswordFilePath: {
        type: "string",
        description: "Optional workspace-relative path to an existing Ansible Vault password file.",
      },
      vaultId: {
        type: "string",
        description: "Optional Ansible Vault ID label used with the supplied vault password source.",
      },
      timeoutMs: {
        type: "number",
        description: "Optional execution timeout in milliseconds. Defaults to 120000 and is capped at 900000.",
      },
    },
    required: [],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const automationProfile = resolveAutomationProfile(args["profile"]);
    if (automationProfile.error) {
      return { success: false, output: "", error: automationProfile.error };
    }
    if (automationProfile.profile?.type === "webhook" && automationProfile.profileName) {
      return executeAutomationWebhook(
        "ansible_playbook",
        automationProfile.profileName,
        automationProfile.profile,
        args,
        EXEC_TIMEOUT_MS,
      );
    }

    const playbookYaml = String(args["playbookYaml"] ?? "");
    const playbookPathInput = typeof args["playbookPath"] === "string" ? String(args["playbookPath"]).trim() : "";
    const projectDirInput = typeof args["projectDir"] === "string" ? String(args["projectDir"]).trim() : "";
    const inventoryInput = args["inventory"] ?? args["inventoryUrl"];
    const inventory = inventoryInput ? String(inventoryInput) : undefined;
    const extraVars = (args["extraVars"] as Record<string, unknown> | undefined) ?? {};
    const timeoutMs = normalizeExecutionTimeout(args["timeoutMs"] ?? automationProfile.profile?.timeoutMs, EXEC_TIMEOUT_MS);
    const projectDir = projectDirInput
      ? resolveWorkspaceRelativePath(projectDirInput, ctx.workspacePath)
      : undefined;
    const roleName = typeof args["roleName"] === "string" ? String(args["roleName"]).trim() : "";
    const vaultPassword = typeof args["vaultPassword"] === "string" ? resolveSecretRef(String(args["vaultPassword"]).trim()) : undefined;
    const vaultPasswordFilePathInput = typeof args["vaultPasswordFilePath"] === "string" ? String(args["vaultPasswordFilePath"]).trim() : "";
    const vaultId = typeof args["vaultId"] === "string" ? String(args["vaultId"]).trim() : "";

    if (!playbookYaml.trim() && !playbookPathInput && !roleName) {
      return { success: false, output: "", error: "Provide playbookYaml, playbookPath, or roleName" };
    }
    if (vaultPassword && vaultPasswordFilePathInput) {
      return { success: false, output: "", error: "Provide either vaultPassword or vaultPasswordFilePath, not both" };
    }

    const tmpFilename = `playbook_${randomBytes(6).toString("hex")}.yml`;
    const tmpPath = join(tmpdir(), tmpFilename);
    const tmpVaultPath = join(tmpdir(), `vault_${randomBytes(6).toString("hex")}.txt`);
    let playbookPath = "";
    let shouldDeletePlaybook = false;
    let inventoryPath: string | undefined;
    let shouldDeleteInventory = false;
    let vaultPasswordFilePath: string | undefined;
    let shouldDeleteVaultPasswordFile = false;
    const cliArgs: string[] = [];
    const binary = automationProfile.profile?.type === "local-cli"
      ? automationProfile.profile.ansiblePlaybookBinary
      : "ansible-playbook";

    try {
      if (playbookYaml.trim()) {
        writeFileSync(tmpPath, playbookYaml, { mode: 0o600 });
        playbookPath = tmpPath;
        shouldDeletePlaybook = true;
      } else if (playbookPathInput) {
        playbookPath = resolveWorkspaceRelativePath(playbookPathInput, ctx.workspacePath, projectDir);
      } else {
        const generatedPlaybook = buildRolePlaybook(args["hosts"], roleName, args["roleVars"]);
        writeFileSync(tmpPath, generatedPlaybook, { mode: 0o600 });
        playbookPath = tmpPath;
        shouldDeletePlaybook = true;
      }

      cliArgs.push(playbookPath);

      if (inventory) {
        const resolvedInventory = materializeInventory(inventory, {
          baseDir: projectDir,
          tempPrefix: "inventory",
        });
        inventoryPath = resolvedInventory.path;
        shouldDeleteInventory = resolvedInventory.shouldDelete;
        cliArgs.push("-i");
        cliArgs.push(inventoryPath);
      }

      if (Object.keys(extraVars).length > 0) {
        cliArgs.push("-e");
        cliArgs.push(JSON.stringify(extraVars));
      }

      if (vaultPassword) {
        writeFileSync(tmpVaultPath, `${vaultPassword}\n`, { mode: 0o600 });
        vaultPasswordFilePath = tmpVaultPath;
        shouldDeleteVaultPasswordFile = true;
      } else if (vaultPasswordFilePathInput) {
        vaultPasswordFilePath = resolveWorkspaceRelativePath(vaultPasswordFilePathInput, ctx.workspacePath, projectDir);
      }

      if (vaultPasswordFilePath) {
        if (vaultId) {
          cliArgs.push("--vault-id", `${vaultId}@${vaultPasswordFilePath}`);
        } else {
          cliArgs.push("--vault-password-file", vaultPasswordFilePath);
        }
      }

      appendListOption(cliArgs, "--tags", args["tags"]);
      appendListOption(cliArgs, "--skip-tags", args["skipTags"]);
      if (typeof args["limit"] === "string" && String(args["limit"]).trim()) {
        cliArgs.push("--limit", String(args["limit"]).trim());
      }
      if (args["become"] === true) {
        cliArgs.push("--become");
      }
      if (args["check"] === true) {
        cliArgs.push("--check");
      }
      if (args["diff"] === true) {
        cliArgs.push("--diff");
      }

      log.debug({ playbookPath, projectDir, args: cliArgs }, "Running ansible-playbook");

      const { stdout, stderr } = await execFileAsync(binary, cliArgs, {
        cwd: projectDir,
        timeout: timeoutMs,
      });

      return {
        success: true,
        output: `${stdout}\n${stderr}`.trim(),
      };
    } catch (error: any) {
      log.error({ err: error }, "Ansible playbook execution failed");
      const errOutput = `${error.stdout || ""}\n${error.stderr || ""}\n${error.message || ""}`;
      return {
        success: false,
        output: errOutput.trim(),
        error: formatCliExecutionError(error, binary),
      };
    } finally {
      if (shouldDeletePlaybook) {
        safeDelete(tmpPath);
      }
      if (shouldDeleteInventory && inventoryPath) {
        safeDelete(inventoryPath);
      }
      if (shouldDeleteVaultPasswordFile && vaultPasswordFilePath) {
        safeDelete(vaultPasswordFilePath);
      }
    }
  },
});

function appendListOption(target: string[], flag: string, value: unknown): void {
  if (!Array.isArray(value)) {
    return;
  }
  const items = value.map((item) => String(item).trim()).filter(Boolean);
  if (items.length > 0) {
    target.push(flag, items.join(","));
  }
}

function buildRolePlaybook(hostsValue: unknown, rawRoleName: string, roleVarsValue: unknown): string {
  const hosts = typeof hostsValue === "string" && hostsValue.trim() ? hostsValue.trim() : "all";
  const roleVars = roleVarsValue && typeof roleVarsValue === "object" && !Array.isArray(roleVarsValue)
    ? roleVarsValue as Record<string, unknown>
    : undefined;
  const includeRoleBlock = [
    "- hosts: " + hosts,
    "  gather_facts: false",
    "  tasks:",
    "    - name: Run role " + rawRoleName,
    "      ansible.builtin.include_role:",
    "        name: " + rawRoleName,
  ];
  if (roleVars && Object.keys(roleVars).length > 0) {
    includeRoleBlock.push("      vars: " + JSON.stringify(roleVars));
  }
  return includeRoleBlock.join("\n") + "\n";
}
