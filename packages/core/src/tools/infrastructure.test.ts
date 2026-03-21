import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.fn();
const getCredentialMock = vi.fn((name: string) => {
  if (name === "tf_backend_secret") return "secret-backend-value";
  if (name === "tf_api_token") return "secret-variable-value";
  if (name === "ansible_vault_password") return "vault-secret-value";
  return undefined;
});

vi.mock("node:child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("../credentials/store.js", () => ({
  getCredential: getCredentialMock,
}));

describe("infrastructure tools", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("registers privileged infrastructure tools", async () => {
    const [{ getAllTools }, ] = await Promise.all([
      import("./registry.js"),
      import("./ansible.js"),
    ]);
    await import("./ssh.js");
    await import("./ssh-upload.js");
    await import("./ssh-download.js");
    await import("./service-check.js");
    await import("./ansible-task.js");
    await import("./terraform.js");
    await import("./proxmox.js");

    const toolNames = getAllTools().map((tool) => tool.name);
    expect(toolNames).toContain("ansible_playbook");
    expect(toolNames).toContain("ssh_exec");
    expect(toolNames).toContain("ssh_upload");
    expect(toolNames).toContain("ssh_download");
    expect(toolNames).toContain("service_check");
    expect(toolNames).toContain("ansible_task");
    expect(toolNames).toContain("terraform_exec");
    expect(toolNames).toContain("proxmox_vm");
  });

  it("appends a trailing comma only for a single-host ansible inventory", async () => {
    execFileMock.mockImplementation((_file, _args, options, callback) => {
      callback(null, { stdout: "ok", stderr: "" });
    });

    const [{ getTool }, ] = await Promise.all([
      import("./registry.js"),
      import("./ansible.js"),
    ]);

    const tool = getTool("ansible_playbook");
    const result = await tool!.execute({
      playbookYaml: "- hosts: all\n  tasks: []\n",
      inventory: "192.168.1.55",
    }, {
      sessionId: "session-ansible-single-host",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args).toContain("-i");
    expect(args).toContain("192.168.1.55,");
  });

  it("preserves inventory file paths for ansible", async () => {
    execFileMock.mockImplementation((_file, _args, options, callback) => {
      callback(null, { stdout: "ok", stderr: "" });
    });

    const [{ getTool }, ] = await Promise.all([
      import("./registry.js"),
      import("./ansible.js"),
    ]);

    const tool = getTool("ansible_playbook");
    const result = await tool!.execute({
      playbookYaml: "- hosts: all\n  tasks: []\n",
      inventory: __filename,
    }, {
      sessionId: "session-ansible-file-inventory",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(true);
    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args).toContain(__filename);
    expect(args).not.toContain(`${__filename},`);
  });

  it("passes SSH port and disables tty allocation", async () => {
    execFileMock.mockImplementation((_file, _args, options, callback) => {
      callback(null, { stdout: "remote ok", stderr: "" });
    });

    const [{ getTool }, ] = await Promise.all([
      import("./registry.js"),
      import("./ssh.js"),
    ]);

    const tool = getTool("ssh_exec");
    const result = await tool!.execute({
      host: "vm.internal",
      username: "deploy",
      port: 2222,
      command: "docker ps",
    }, {
      sessionId: "session-ssh-port",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(true);
    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args).toContain("-T");
    expect(args).toContain("-p");
    expect(args).toContain("2222");
    expect(args).toContain("deploy@vm.internal");
  });

  it("rejects unsafe SSH host values before execution", async () => {
    const [{ getTool }, ] = await Promise.all([
      import("./registry.js"),
      import("./ssh.js"),
    ]);

    const tool = getTool("ssh_exec");
    const result = await tool!.execute({
      host: "vm.internal; rm -rf /",
      command: "uname -a",
    }, {
      sessionId: "session-ssh-invalid-host",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("must not contain whitespace or shell control characters");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("builds ansible ad-hoc commands with module flags", async () => {
    execFileMock.mockImplementation((_file, _args, options, callback) => {
      callback(null, { stdout: "changed=1", stderr: "" });
    });

    const [{ getTool }, ] = await Promise.all([
      import("./registry.js"),
      import("./ansible-task.js"),
    ]);

    const tool = getTool("ansible_task");
    const result = await tool!.execute({
      inventory: "vm.internal",
      pattern: "all",
      module: "package",
      moduleArgs: "name=docker.io state=present",
      become: true,
      check: true,
      diff: true,
    }, {
      sessionId: "session-ansible-task",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(true);
    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args).toContain("all");
    expect(args).toContain("-m");
    expect(args).toContain("package");
    expect(args).toContain("-a");
    expect(args).toContain("name=docker.io state=present");
    expect(args).toContain("--become");
    expect(args).toContain("--check");
    expect(args).toContain("--diff");
  });

  it("runs ansible from a project directory and can generate a role playbook", async () => {
    execFileMock.mockImplementation((_file, _args, options, callback) => {
      callback(null, { stdout: "role ok", stderr: "" });
    });

    const [{ getTool }, ] = await Promise.all([
      import("./registry.js"),
      import("./ansible.js"),
    ]);

    const tool = getTool("ansible_playbook");
    const workspacePath = process.cwd();
    const result = await tool!.execute({
      projectDir: "src/tools",
      roleName: "deploy_app",
      hosts: "app",
      tags: ["setup", "docker"],
      skipTags: ["cleanup"],
      become: true,
      check: true,
      diff: true,
    }, {
      sessionId: "session-ansible-role",
      workspacePath,
    });

    expect(result.success).toBe(true);
    const [, args, options] = execFileMock.mock.calls[0] as [string, string[], { cwd?: string }];
    expect(options.cwd).toBe(join(workspacePath, "src", "tools"));
    expect(args).toEqual(expect.arrayContaining(["--tags", "setup,docker", "--skip-tags", "cleanup", "--become", "--check", "--diff"]));
  });

  it("passes a resolved vault password file to ansible playbook execution", async () => {
    execFileMock.mockImplementation((_file, args, _options, callback) => {
      const vaultFlagIndex = (args as string[]).findIndex((value) => value === "--vault-password-file");
      if (vaultFlagIndex >= 0) {
        const vaultFilePath = (args as string[])[vaultFlagIndex + 1];
        if (!vaultFilePath) {
          throw new Error("expected ansible to receive a vault password file path");
        }
        expect(readFileSync(vaultFilePath, "utf8")).toContain("vault-secret-value");
      }
      callback(null, { stdout: "vault ok", stderr: "" });
    });

    const [{ getTool }, ] = await Promise.all([
      import("./registry.js"),
      import("./ansible.js"),
    ]);

    const tool = getTool("ansible_playbook");
    const result = await tool!.execute({
      playbookYaml: "- hosts: all\n  tasks: []\n",
      vaultPassword: "secret:ansible_vault_password",
    }, {
      sessionId: "session-ansible-vault",
      workspacePath: process.cwd(),
    });

    expect(result.success).toBe(true);
    const [, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(args).toContain("--vault-password-file");
  });

  it("runs terraform with inline config and automatic init", async () => {
    execFileMock.mockImplementation((_file, _args, options, callback) => {
      callback(null, { stdout: "ok", stderr: "" });
    });

    const [{ getTool }, ] = await Promise.all([
      import("./registry.js"),
      import("./terraform.js"),
    ]);

    const tool = getTool("terraform_exec");
    const result = await tool!.execute({
      action: "plan",
      configFiles: {
        "main.tf": "terraform { required_version = \">= 1.5.0\" }",
      },
      variables: {
        vm_name: "app-321",
      },
      backendConfig: {
        path: "terraform.tfstate",
      },
      workspaceName: "dev",
      targets: ["proxmox_vm_qemu.app"],
    }, {
      sessionId: "session-terraform-inline",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(true);
    expect(execFileMock).toHaveBeenCalled();
    const callArgs = execFileMock.mock.calls.map((call) => call[1] as string[]);
    expect(callArgs[0]).toEqual(expect.arrayContaining(["init", "-input=false", "-no-color", "-backend-config=path=terraform.tfstate"]));
    expect(callArgs[1]).toEqual(expect.arrayContaining(["workspace", "select", "dev", "-no-color"]));
    expect(callArgs[2]).toEqual(expect.arrayContaining(["plan", "-no-color", "-input=false", "-target=proxmox_vm_qemu.app"]));
  });

  it("resolves Terraform secret refs in backend config and variables", async () => {
    process.env["TF_HTTP_USERNAME"] = "env-user";
    let capturedVarFile = "";
    execFileMock.mockImplementation((_file, args, options, callback) => {
      if (Array.isArray(args) && args[0] === "plan" && options && typeof options.cwd === "string") {
        const tempVarsPath = join(options.cwd, `.starlingai.auto.tfvars.${process.pid}.json`);
        capturedVarFile = readFileSync(tempVarsPath, "utf8");
      }
      callback(null, { stdout: "ok", stderr: "" });
    });

    const [{ getTool }, ] = await Promise.all([
      import("./registry.js"),
      import("./terraform.js"),
    ]);

    const tool = getTool("terraform_exec");
    const result = await tool!.execute({
      action: "plan",
      workingDir: ".",
      variables: {
        username: "$TF_HTTP_USERNAME",
        apiToken: "secret:tf_api_token",
      },
      backendConfig: {
        username: "$TF_HTTP_USERNAME",
        password: "secret:tf_backend_secret",
      },
    }, {
      sessionId: "session-terraform-secret-refs",
      workspacePath: process.cwd(),
    });

    expect(result.success).toBe(true);
    const initArgs = execFileMock.mock.calls[0]?.[1] as string[];
    expect(initArgs).toEqual(expect.arrayContaining([
      "-backend-config=username=env-user",
      "-backend-config=password=secret-backend-value",
    ]));
    expect(capturedVarFile).toContain("env-user");
    expect(capturedVarFile).toContain("secret-variable-value");
    delete process.env["TF_HTTP_USERNAME"];
  });

  it("writes and reuses Terraform saved plans", async () => {
    execFileMock.mockImplementation((_file, args, options, callback) => {
      callback(null, { stdout: Array.isArray(args) ? args.join(" ") : "ok", stderr: "" });
    });

    const [{ getTool }, ] = await Promise.all([
      import("./registry.js"),
      import("./terraform.js"),
    ]);

    const tool = getTool("terraform_exec");
    const workspacePath = process.cwd();
    const planPath = "packages/core/tmp/test.tfplan";

    const planResult = await tool!.execute({
      action: "plan",
      workingDir: ".",
      planOutPath: planPath,
    }, {
      sessionId: "session-terraform-plan-out",
      workspacePath,
    });

    expect(planResult.success).toBe(true);
    const planArgs = execFileMock.mock.calls.find((call) => (call[1] as string[])[0] === "plan")?.[1] as string[];
    expect(planArgs).toEqual(expect.arrayContaining([`-out=${join(workspacePath, "packages", "core", "tmp", "test.tfplan")}`]));

    execFileMock.mockReset();
    execFileMock.mockImplementation((_file, args, _options, callback) => {
      callback(null, { stdout: Array.isArray(args) ? args.join(" ") : "ok", stderr: "" });
    });

    mkdirSync(join(workspacePath, "packages", "core", "tmp"), { recursive: true });
    writeFileSync(join(workspacePath, "packages", "core", "tmp", "test.tfplan"), "fake-plan", "utf8");

    const showResult = await tool!.execute({
      action: "show",
      workingDir: ".",
      planFilePath: planPath,
    }, {
      sessionId: "session-terraform-show-plan",
      workspacePath,
    });

    expect(showResult.success).toBe(true);
    const showArgs = execFileMock.mock.calls.find((call) => (call[1] as string[])[0] === "show")?.[1] as string[];
    expect(showArgs).toEqual(expect.arrayContaining(["-json", join(workspacePath, "packages", "core", "tmp", "test.tfplan")]));

    execFileMock.mockReset();
    execFileMock.mockImplementation((_file, args, _options, callback) => {
      callback(null, { stdout: Array.isArray(args) ? args.join(" ") : "ok", stderr: "" });
    });

    const applyResult = await tool!.execute({
      action: "apply",
      workingDir: ".",
      planFilePath: planPath,
    }, {
      sessionId: "session-terraform-apply-plan",
      workspacePath,
    });

    expect(applyResult.success).toBe(true);
    const applyArgs = execFileMock.mock.calls.find((call) => (call[1] as string[])[0] === "apply")?.[1] as string[];
    expect(applyArgs).toEqual(expect.arrayContaining([join(workspacePath, "packages", "core", "tmp", "test.tfplan")]));
  });

  it("parses Terraform outputs into structured metadata", async () => {
    execFileMock.mockImplementation((_file, args, _options, callback) => {
      if (Array.isArray(args) && args[0] === "output") {
        callback(null, {
          stdout: JSON.stringify({
            vm_ip: {
              sensitive: false,
              type: "string",
              value: "10.0.0.42",
            },
            app_ports: {
              sensitive: false,
              type: ["list", "number"],
              value: [80, 443],
            },
          }),
          stderr: "",
        });
        return;
      }

      callback(null, { stdout: "ok", stderr: "" });
    });

    const [{ getTool }, ] = await Promise.all([
      import("./registry.js"),
      import("./terraform.js"),
    ]);

    const tool = getTool("terraform_exec");
    const result = await tool!.execute({
      action: "output",
      workingDir: ".",
    }, {
      sessionId: "session-terraform-output",
      workspacePath: process.cwd(),
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Terraform outputs:");
    expect(result.output).toContain("vm_ip");
    expect(result.metadata).toMatchObject({
      outputValues: {
        vm_ip: "10.0.0.42",
        app_ports: [80, 443],
      },
    });
    expect((result.metadata as Record<string, unknown>).outputs).toMatchObject({
      vm_ip: {
        value: "10.0.0.42",
      },
    });
  });

  it("uploads workspace files over scp", async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, { stdout: "copied", stderr: "" });
    });

    const [{ getTool }, ] = await Promise.all([
      import("./registry.js"),
      import("./ssh-upload.js"),
    ]);

    const tool = getTool("ssh_upload");
    const result = await tool!.execute({
      host: "vm.internal",
      username: "deploy",
      port: 2222,
      sourcePath: "src/tools/infrastructure.test.ts",
      destinationPath: "/opt/app/infrastructure.test.ts",
    }, {
      sessionId: "session-ssh-upload",
      workspacePath: process.cwd(),
    });

    expect(result.success).toBe(true);
    const [binary, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(binary).toBe("scp");
    expect(args).toEqual(expect.arrayContaining([
      "-P",
      "2222",
      `deploy@vm.internal:/opt/app/infrastructure.test.ts`,
    ]));
    expect(args.some((value) => value.endsWith("src/tools/infrastructure.test.ts"))).toBe(true);
  });

  it("downloads remote files over scp into the workspace", async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, { stdout: "downloaded", stderr: "" });
    });

    const [{ getTool }, ] = await Promise.all([
      import("./registry.js"),
      import("./ssh-download.js"),
    ]);

    const tool = getTool("ssh_download");
    const result = await tool!.execute({
      host: "vm.internal",
      username: "deploy",
      port: 2222,
      sourcePath: "/var/log/app.log",
      destinationPath: "packages/core/tmp/app.log",
    }, {
      sessionId: "session-ssh-download",
      workspacePath: process.cwd(),
    });

    expect(result.success).toBe(true);
    const [binary, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(binary).toBe("scp");
    expect(args).toEqual(expect.arrayContaining([
      "-P",
      "2222",
      "deploy@vm.internal:/var/log/app.log",
    ]));
    expect(args.some((value) => value.endsWith(join("packages", "core", "tmp", "app.log")))).toBe(true);
  });

  it("retries HTTP service checks until the endpoint is ready", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("warming", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const [{ getTool }, ] = await Promise.all([
      import("./registry.js"),
      import("./service-check.js"),
    ]);

    const tool = getTool("service_check");
    const result = await tool!.execute({
      protocol: "http",
      url: "https://example.test/healthz",
      maxAttempts: 2,
      intervalMs: 1,
    }, {
      sessionId: "session-service-check-http",
      workspacePath: process.cwd(),
    });

    expect(result.success).toBe(true);
    expect(result.metadata).toMatchObject({ attempts: 2, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it("checks TCP readiness against a listening port", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", (error?: Error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const [{ getTool }, ] = await Promise.all([
        import("./registry.js"),
        import("./service-check.js"),
      ]);

      const tool = getTool("service_check");
      const result = await tool!.execute({
        protocol: "tcp",
        host: "127.0.0.1",
        port,
      }, {
        sessionId: "session-service-check-tcp",
        workspacePath: process.cwd(),
      });

      expect(result.success).toBe(true);
      expect(result.output).toContain("TCP check passed");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  });

  it("uses SSH for service checks when requested", async () => {
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, { stdout: "", stderr: "" });
    });

    const [{ getTool }, ] = await Promise.all([
      import("./registry.js"),
      import("./service-check.js"),
    ]);

    const tool = getTool("service_check");
    const result = await tool!.execute({
      protocol: "ssh",
      host: "vm.internal",
      username: "deploy",
      port: 2222,
    }, {
      sessionId: "session-service-check-ssh",
      workspacePath: process.cwd(),
    });

    expect(result.success).toBe(true);
    const [binary, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(binary).toBe("ssh");
    expect(args).toEqual(expect.arrayContaining(["-p", "2222", "deploy@vm.internal", "true"]));
  });
});
