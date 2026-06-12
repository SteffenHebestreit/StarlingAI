import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mutable config the mock returns — tests reassign `mockTools` per case.
let mockTools: { disabledGroups?: string[]; disabledTools?: string[] } | undefined;

vi.mock("../config/loader.js", () => ({
  getConfig: () => ({ tools: mockTools }),
}));

import { BUILTIN_TOOL_GROUPS, isToolDisabled, resolveToolGroup, _resetToolGroupsForTests } from "../tools/groups.js";
import { registerTool, unregisterTool, getTool } from "../tools/registry.js";

describe("tool groups", () => {
  beforeEach(() => {
    mockTools = undefined;
    _resetToolGroupsForTests();
  });

  it("maps built-in tools to their group", () => {
    expect(resolveToolGroup("nmap_scan")).toBe("pentest");
    expect(resolveToolGroup("ssh_exec")).toBe("infrastructure");
    expect(resolveToolGroup("kubectl_get")).toBe("kubernetes");
    expect(resolveToolGroup("read_file")).toBeUndefined();
  });

  it("prefers the handler-declared group over the built-in map", () => {
    expect(resolveToolGroup("my_ext_tool", "medical")).toBe("medical");
  });

  it("disables nothing when no tools config is present", () => {
    expect(isToolDisabled("nmap_scan")).toBe(false);
    expect(isToolDisabled("read_file")).toBe(false);
  });

  it("disables every member of a disabled group and nothing else", () => {
    mockTools = { disabledGroups: ["pentest"] };
    for (const tool of BUILTIN_TOOL_GROUPS["pentest"]!) {
      expect(isToolDisabled(tool), tool).toBe(true);
    }
    expect(isToolDisabled("ssh_exec")).toBe(false);
    expect(isToolDisabled("read_file")).toBe(false);
  });

  it("disables individual tools via disabledTools", () => {
    mockTools = { disabledTools: ["grafana_alerts_list"] };
    expect(isToolDisabled("grafana_alerts_list")).toBe(true);
    expect(isToolDisabled("grafana_dashboard_search")).toBe(false);
  });

  it("honors declared groups for extension tools", () => {
    mockTools = { disabledGroups: ["medical"] };
    expect(isToolDisabled("mfa_icd10_lookup", "medical")).toBe(true);
    expect(isToolDisabled("mfa_icd10_lookup")).toBe(false);
  });

  it("tolerates unknown group names", () => {
    mockTools = { disabledGroups: ["no-such-group"] };
    expect(isToolDisabled("nmap_scan")).toBe(false);
  });
});

describe("registerTool with disabled tools", () => {
  const handler = (name: string) => ({
    name,
    description: "test handler",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ success: true, output: "" }),
  });

  afterEach(() => {
    unregisterTool("nmap_scan");
    unregisterTool("ssh_exec");
    mockTools = undefined;
  });

  it("skips registration for a config-disabled tool instead of throwing", () => {
    mockTools = { disabledGroups: ["pentest"] };
    expect(() => registerTool(handler("nmap_scan"))).not.toThrow();
    expect(getTool("nmap_scan")).toBeUndefined();
  });

  it("still registers tools outside disabled groups", () => {
    mockTools = { disabledGroups: ["pentest"] };
    registerTool(handler("ssh_exec"));
    expect(getTool("ssh_exec")).toBeDefined();
  });
});
