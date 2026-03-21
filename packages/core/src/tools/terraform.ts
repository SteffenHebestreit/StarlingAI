import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { registerTool, type ToolContext, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import {
  normalizeExecutionTimeout,
  resolveSecretRefs,
  resolveWorkspaceRelativePath,
} from "./infrastructure-shared.js";

const log = childLogger("tool:terraform");
const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 180_000;
registerTool({
  name: "terraform_exec",
  description: "Run Terraform against a working directory or an inline configuration set. Supports init, plan, apply, destroy, validate, fmt, output, and show.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["init", "plan", "apply", "destroy", "validate", "fmt", "output", "show"],
        description: "Terraform action to execute",
      },
      workingDir: {
        type: "string",
        description: "Workspace-relative directory containing Terraform files",
      },
      configFiles: {
        type: "object",
        description: "Inline Terraform files keyed by filename, e.g. { main.tf: '...' }",
        additionalProperties: { type: "string" },
      },
      variables: {
        type: "object",
        description: "Variables written to a temporary terraform.tfvars.json",
        additionalProperties: true,
      },
      workspaceName: {
        type: "string",
        description: "Optional Terraform workspace to select or create",
      },
      backendConfig: {
        type: "object",
        description: "Optional backend config entries passed to terraform init via -backend-config=key=value",
        additionalProperties: true,
      },
      planOutPath: {
        type: "string",
        description: "Optional workspace-relative plan output file written by action=plan. Use with planFilePath for reviewed apply workflows.",
      },
      planFilePath: {
        type: "string",
        description: "Optional workspace-relative saved plan file to use with action=apply or action=show.",
      },
      targets: {
        type: "array",
        description: "Optional list of Terraform resource targets",
        items: { type: "string" },
      },
      autoInit: {
        type: "boolean",
        description: "Whether to run terraform init automatically before non-init actions. Defaults to true.",
      },
      autoApprove: {
        type: "boolean",
        description: "Whether apply/destroy should use -auto-approve. Defaults to true.",
      },
      destroyPlan: {
        type: "boolean",
        description: "When action=plan, create a destroy plan instead of a create/update plan.",
      },
      timeoutMs: {
        type: "number",
        description: "Optional execution timeout in milliseconds. Defaults to 180000 and is capped at 900000.",
      },
    },
    required: ["action"],
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const action = String(args["action"] ?? "").trim();
    if (!action) {
      return { success: false, output: "", error: "action is required" };
    }

    const timeoutMs = normalizeExecutionTimeout(args["timeoutMs"], DEFAULT_TIMEOUT_MS);
    const configFiles = normalizeConfigFiles(args["configFiles"]);
    const resolvedVariables = resolveObjectArg(args["variables"]);
    const resolvedBackendConfig = resolveObjectArg(args["backendConfig"]);
    const planOutPath = resolveOptionalPathArg(args["planOutPath"], ctx.workspacePath);
    const planFilePath = resolveOptionalPathArg(args["planFilePath"], ctx.workspacePath);
    let tempDir: string | undefined;
    const cleanupPaths: string[] = [];

    try {
      if ((action === "apply" || action === "show") && !planFilePath && args["planFilePath"] !== undefined) {
        return { success: false, output: "", error: "planFilePath must be a non-empty workspace-relative path when provided" };
      }
      if (action === "show" && !planFilePath) {
        return { success: false, output: "", error: "action=show requires planFilePath" };
      }
      if ((action === "apply" || action === "show") && planFilePath && !existsSync(planFilePath)) {
        return { success: false, output: "", error: `Saved plan file not found: ${String(args["planFilePath"])}` };
      }

      const workingDirectory = configFiles
        ? createInlineTerraformWorkspace(configFiles, resolvedVariables)
        : resolveTerraformWorkingDir(args["workingDir"], ctx.workspacePath);

      if (configFiles) {
        tempDir = workingDirectory;
      } else {
        cleanupPaths.push(...writeTemporaryVariableFiles(workingDirectory, resolvedVariables));
      }

      if (action !== "init" && action !== "fmt" && args["autoInit"] !== false) {
        await runTerraform(workingDirectory, buildInitArgs(resolvedBackendConfig), timeoutMs);
      }

      if (typeof args["workspaceName"] === "string" && String(args["workspaceName"]).trim()) {
        await ensureTerraformWorkspace(workingDirectory, String(args["workspaceName"]).trim(), timeoutMs);
      }

      const cliArgs = buildTerraformArgs(action, args, resolvedBackendConfig, planOutPath, planFilePath);
      const result = await runTerraform(workingDirectory, cliArgs, timeoutMs);
      const parsedOutput = action === "output" ? parseTerraformOutput(result.trim()) : undefined;
      return {
        success: true,
        output: parsedOutput ? formatTerraformOutput(parsedOutput) : result.trim(),
        metadata: {
          action,
          workingDir: workingDirectory,
          inlineConfig: Boolean(configFiles),
          ...(parsedOutput ? {
            outputs: parsedOutput.raw,
            outputValues: parsedOutput.values,
          } : {}),
          ...(planOutPath ? { planOutPath } : {}),
          ...(planFilePath ? { planFilePath } : {}),
        },
      };
    } catch (error: any) {
      log.error({ err: error, action }, "Terraform execution failed");
      return {
        success: false,
        output: `${error.stdout || ""}\n${error.stderr || ""}\n${error.message || ""}`.trim(),
        error: formatExecutionError(error),
      };
    } finally {
      for (const cleanupPath of cleanupPaths) {
        rmSync(cleanupPath, { force: true });
      }
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  },
});

function resolveTerraformWorkingDir(value: unknown, workspacePath: string): string {
  const relative = typeof value === "string" && value.trim() ? value.trim() : ".";
  return resolveWorkspaceRelativePath(relative, workspacePath);
}

function normalizeConfigFiles(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([key, fileContent]) => typeof fileContent === "string" && key.trim().length > 0)
    .map(([key, fileContent]) => [key.trim(), String(fileContent)]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function createInlineTerraformWorkspace(
  configFiles: Record<string, string>,
  variables: unknown,
): string {
  const directory = mkdtempSync(join(tmpdir(), "starlingai-terraform-"));
  for (const [filename, content] of Object.entries(configFiles)) {
    const fullPath = join(directory, filename);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf8");
  }
  if (variables && typeof variables === "object" && !Array.isArray(variables) && Object.keys(variables as Record<string, unknown>).length > 0) {
    writeFileSync(join(directory, "terraform.auto.tfvars.json"), JSON.stringify(variables, null, 2), "utf8");
  }
  return directory;
}

function writeTemporaryVariableFiles(workingDirectory: string, variables: unknown): string[] {
  if (!variables || typeof variables !== "object" || Array.isArray(variables) || Object.keys(variables as Record<string, unknown>).length === 0) {
    return [];
  }
  const tempVarsPath = join(workingDirectory, `.starlingai.auto.tfvars.${process.pid}.json`);
  writeFileSync(tempVarsPath, JSON.stringify(variables, null, 2), "utf8");
  return [tempVarsPath];
}

function buildInitArgs(backendConfig: Record<string, unknown> | undefined): string[] {
  const cliArgs = ["init", "-input=false", "-no-color"];
  if (backendConfig && typeof backendConfig === "object" && !Array.isArray(backendConfig)) {
    for (const [key, value] of Object.entries(backendConfig)) {
      if (value === undefined || value === null) continue;
      cliArgs.push(`-backend-config=${key}=${String(value)}`);
    }
  }
  return cliArgs;
}

function buildTerraformArgs(
  action: string,
  args: Record<string, unknown>,
  backendConfig: Record<string, unknown> | undefined,
  planOutPath?: string,
  planFilePath?: string,
): string[] {
  const targets = Array.isArray(args["targets"]) ? args["targets"].map((value) => String(value).trim()).filter(Boolean) : [];
  const cliArgs = [action, "-no-color"];

  switch (action) {
    case "plan":
      cliArgs.push("-input=false");
      if (args["destroyPlan"] === true) {
        cliArgs.push("-destroy");
      }
      if (planOutPath) {
        cliArgs.push(`-out=${planOutPath}`);
      }
      break;
    case "apply":
      cliArgs.push("-input=false");
      if (planFilePath) {
        cliArgs.push(planFilePath);
        break;
      }
      if (args["autoApprove"] !== false) {
        cliArgs.push("-auto-approve");
      }
      break;
    case "destroy":
      cliArgs.push("-input=false");
      if (args["autoApprove"] !== false) {
        cliArgs.push("-auto-approve");
      }
      break;
    case "output":
      cliArgs.push("-json");
      break;
    case "show":
      cliArgs.push("-json");
      if (planFilePath) {
        cliArgs.push(planFilePath);
      }
      return cliArgs;
    case "fmt":
      cliArgs.push("-recursive");
      break;
    case "validate":
      cliArgs.push("-json");
      break;
    case "init":
      return buildInitArgs(backendConfig);
  }

  for (const target of targets) {
    cliArgs.push(`-target=${target}`);
  }
  return cliArgs;
}

async function ensureTerraformWorkspace(workingDirectory: string, workspaceName: string, timeoutMs: number): Promise<void> {
  try {
    await runTerraform(workingDirectory, ["workspace", "select", workspaceName, "-no-color"], timeoutMs);
  } catch {
    await runTerraform(workingDirectory, ["workspace", "new", workspaceName, "-no-color"], timeoutMs);
  }
}

async function runTerraform(workingDirectory: string, args: string[], timeoutMs: number): Promise<string> {
  log.debug({ workingDirectory, args }, "Running terraform");
  const { stdout, stderr } = await execFileAsync("terraform", args, {
    cwd: workingDirectory,
    timeout: timeoutMs,
  });

  return `${stdout}\n${stderr}`;
}

function resolveObjectArg(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return resolveSecretRefs(value as Record<string, unknown>);
}

function resolveOptionalPathArg(value: unknown, workspacePath: string): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return resolveWorkspaceRelativePath(value.trim(), workspacePath);
}

function formatExecutionError(error: { code?: string; killed?: boolean; signal?: string }): string {
  if (error.code === "ENOENT") {
    return "terraform is not installed or not on PATH";
  }
  if (error.killed || error.signal === "SIGTERM") {
    return "Execution timed out. Check output for partial progress.";
  }
  return "Execution failed. Check output for details.";
}

function parseTerraformOutput(raw: string): { raw: Record<string, unknown>; values: Record<string, unknown> } | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }

    const values = Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => {
        if (value && typeof value === "object" && !Array.isArray(value) && "value" in value) {
          return [key, (value as { value: unknown }).value];
        }
        return [key, value];
      }),
    );

    return { raw: parsed, values };
  } catch {
    return undefined;
  }
}

function formatTerraformOutput(parsed: { raw: Record<string, unknown>; values: Record<string, unknown> }): string {
  const keys = Object.keys(parsed.values);
  if (keys.length === 0) {
    return JSON.stringify(parsed.raw, null, 2);
  }

  const lines = ["Terraform outputs:"];
  for (const key of keys) {
    lines.push(`- ${key}: ${JSON.stringify(parsed.values[key])}`);
  }
  lines.push("", "Raw JSON:", JSON.stringify(parsed.raw, null, 2));
  return lines.join("\n");
}