import { afterEach, describe, expect, it, vi } from "vitest";

/** What a lab turn may do: tools that reach outside its scratch workspace are left out or stubbed. */

describe("the lab process and Redis", () => {
  afterEach(() => { delete process.env["SAI_HARNESS_LAB_PROCESS"]; vi.resetModules(); });

  it("has no localhost default to write to, and the rate limiter falls back to its in-memory check", async () => {
    const saved = process.env["REDIS_URL"];
    delete process.env["REDIS_URL"];
    process.env["SAI_HARNESS_LAB_PROCESS"] = "1";
    try {
      const { createClient } = await import("../guardrails/redis-client.js");
      expect(() => createClient()).toThrow(/No Redis in the harness-lab process/);
      const { checkRateLimit } = await import("../guardrails/rate-limiter.js");
      expect((await checkRateLimit("lab-session", "request")).allowed).toBe(true);
    } finally {
      if (saved !== undefined) process.env["REDIS_URL"] = saved;
    }
  });
});

describe("harness-lab tool policy", () => {
  afterEach(() => { vi.resetModules(); });

  it("leaves out real infrastructure, desktops, mailboxes, credentials and the deployment's own config", async () => {
    const { classifyLabTool } = await import("../harness-lab/tool-policy.js");
    for (const name of ["ssh_exec", "kubectl_apply", "nmap_scan", "grafana_dashboard_apply", "computer_click", "mail_send_draft", "get_site_credentials", "site_fill_credentials", "extract_credentials", "password_kv", "credentialed_browser_table_read", "git_push", "swarm_define_agent", "tool_dev_start", "request_human_assist"]) {
      expect(classifyLabTool(name), name).toBe("deny");
    }
  });

  it("stubs messages, schedules and writes to shared stores; everything else runs", async () => {
    const { classifyLabTool } = await import("../harness-lab/tool-policy.js");
    for (const name of ["send_email", "send_telegram", "cron_create", "schedule_task", "memory_store", "user_model_update", "http_request", "agent_store_write"]) {
      expect(classifyLabTool(name), name).toBe("stub");
    }
    for (const name of ["web_search", "web_fetch", "read_file", "write_file", "delegate_to_agent", "share_finding", "memory_search", "generate_document"]) {
      expect(classifyLabTool(name), name).toBe("pass");
    }
    expect(classifyLabTool("web_fetch", undefined, { deny: ["web_fetch"] })).toBe("deny");
    expect(classifyLabTool("write_file", undefined, { stub: ["write_file"] })).toBe("stub");
  });

  it("holds for tools registered before and after it, and a stub never runs the real tool", async () => {
    const registry = await import("../tools/registry.js");
    const { applyLabToolPolicy, setStubSink } = await import("../harness-lab/tool-policy.js");
    const real = vi.fn(async () => ({ success: true, output: "ran" }));
    const tool = (name: string) => ({ name, description: name, parameters: { type: "object", properties: {} }, execute: real });
    registry.registerTool(tool("ssh_exec"));
    registry.registerTool(tool("send_email"));
    const record = applyLabToolPolicy();
    registry.registerTool(tool("ssh_upload"));
    registry.registerTool(tool("send_slack"));
    registry.registerTool(tool("web_search"));

    expect(registry.getTool("ssh_exec")).toBeUndefined();
    expect(registry.getTool("ssh_upload")).toBeUndefined();
    expect([...record.denied].sort()).toEqual(["ssh_exec", "ssh_upload"]);
    expect([...record.stubbed].sort()).toEqual(["send_email", "send_slack"]);

    const sink: Array<{ tool: string }> = [];
    setStubSink(sink as never);
    const result = await registry.getTool("send_slack")!.execute({ channel: "#team", text: "hi" }, {} as never);
    expect(result.output).toContain("[harness-lab]");
    expect(sink).toEqual([expect.objectContaining({ tool: "send_slack", args: { channel: "#team", text: "hi" } })]);
    expect(real).not.toHaveBeenCalled();
    await registry.getTool("web_search")!.execute({}, {} as never);
    expect(real).toHaveBeenCalledTimes(1);
  });
});
