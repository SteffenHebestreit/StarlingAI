import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import {
  executeAutomationWebhook,
  formatCliExecutionError,
  materializeInventory,
  normalizeExecutionTimeout,
  resolveAutomationProfile,
  resolveWorkspaceRelativePath,
  safeDelete,
} from "./infrastructure-shared.js";

const log = childLogger("tool:ansible-task");
const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 60_000;
registerTool({
  name: "ansible_task",
  description: "Run a single Ansible ad-hoc module command against an inventory. Use for repeatable remote actions that do not need a full playbook.",
  parameters: {
    type: "object",
    properties: {
      inventory: {
        type: "string",
        description: "Inventory source. Supports a single host, a comma-separated host list, an inventory file path, or raw inventory content.",
      },
      inventoryUrl: {
        type: "string",
        description: "Deprecated alias for inventory.",
      },
      projectDir: {
        type: "string",
        description: "Optional workspace-relative Ansible project directory used as cwd for ansible.",
      },
      profile: {
        type: "string",
        description: "Optional infrastructure.automation profile name. Supports local-cli and webhook profiles.",
      },
      pattern: {
        type: "string",
        description: "Ansible host pattern to target. Defaults to all.",
        default: "all",
      },
      module: {
        type: "string",
        description: "Ansible module name, e.g. shell, command, apt, package, service, git, copy",
      },
      moduleArgs: {
        type: "string",
        description: "Module argument string passed to -a",
      },
      limit: {
        type: "string",
        description: "Optional --limit value",
      },
      become: {
        type: "boolean",
        description: "Whether to run the task with privilege escalation",
      },
      check: {
        type: "boolean",
        description: "Whether to run in check mode",
      },
      diff: {
        type: "boolean",
        description: "Whether to request diff output when supported",
      },
      extraVars: {
        type: "object",
        description: "Extra variables passed via --extra-vars",
        additionalProperties: true,
      },
      timeoutMs: {
        type: "number",
        description: "Optional execution timeout in milliseconds. Defaults to 60000 and is capped at 900000.",
      },
    },
    required: ["module"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const automationProfile = resolveAutomationProfile(args["profile"]);
    if (automationProfile.error) {
      return { success: false, output: "", error: automationProfile.error };
    }
    if (automationProfile.profile?.type === "webhook" && automationProfile.profileName) {
      return executeAutomationWebhook(
        "ansible_task",
        automationProfile.profileName,
        automationProfile.profile,
        args,
        DEFAULT_TIMEOUT_MS,
      );
    }

    const inventoryInput = args["inventory"] ?? args["inventoryUrl"];
    const inventory = inventoryInput ? String(inventoryInput) : undefined;
    const pattern = String(args["pattern"] ?? "all").trim() || "all";
    const moduleName = String(args["module"] ?? "").trim();
    const moduleArgs = typeof args["moduleArgs"] === "string" ? String(args["moduleArgs"]).trim() : "";
    const extraVars = (args["extraVars"] as Record<string, unknown> | undefined) ?? {};
    const timeoutMs = normalizeExecutionTimeout(args["timeoutMs"] ?? automationProfile.profile?.timeoutMs, DEFAULT_TIMEOUT_MS);
    const projectDirInput = typeof args["projectDir"] === "string" ? String(args["projectDir"]).trim() : "";
    const projectDir = projectDirInput
      ? resolveWorkspaceRelativePath(projectDirInput, ctx.workspacePath)
      : undefined;

    if (!moduleName) {
      return { success: false, output: "", error: "module is required" };
    }

    let inventoryPath: string | undefined;
    let shouldDeleteInventory = false;
    const cliArgs = [pattern, "-m", moduleName];
    const binary = automationProfile.profile?.type === "local-cli"
      ? automationProfile.profile.ansibleBinary
      : "ansible";

    try {
      if (inventory) {
        const resolvedInventory = materializeInventory(inventory, {
          baseDir: projectDir,
          tempPrefix: "ansible_inventory",
        });
        inventoryPath = resolvedInventory.path;
        shouldDeleteInventory = resolvedInventory.shouldDelete;
        cliArgs.push("-i", inventoryPath);
      }

      if (moduleArgs) {
        cliArgs.push("-a", moduleArgs);
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
      if (typeof args["limit"] === "string" && String(args["limit"]).trim()) {
        cliArgs.push("--limit", String(args["limit"]).trim());
      }
      if (Object.keys(extraVars).length > 0) {
        cliArgs.push("-e", JSON.stringify(extraVars));
      }

      log.debug({ moduleName, pattern, args: cliArgs }, "Running ansible ad-hoc task");
      const { stdout, stderr } = await execFileAsync(binary, cliArgs, {
        cwd: projectDir,
        timeout: timeoutMs,
      });

      return {
        success: true,
        output: `${stdout}\n${stderr}`.trim(),
        metadata: {
          module: moduleName,
          pattern,
        },
      };
    } catch (error: any) {
      log.error({ err: error }, "Ansible ad-hoc task failed");
      return {
        success: false,
        output: `${error.stdout || ""}\n${error.stderr || ""}\n${error.message || ""}`.trim(),
        error: formatCliExecutionError(error, binary),
      };
    } finally {
      if (shouldDeleteInventory && inventoryPath) {
        safeDelete(inventoryPath);
      }
    }
  },
});
