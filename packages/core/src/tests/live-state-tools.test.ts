import { describe, it, expect } from "vitest";
import { isLiveStateTool } from "../agent/sub-agent.js";

describe("isLiveStateTool (dedup exemption)", () => {
  it("treats browser_* and computer_* tools as live-state (never dedup/cache)", () => {
    for (const name of [
      "browser_navigate",
      "browser_snapshot",
      "browser_click",
      "browser_type",
      "browser_screenshot",
      "browser_wait_for",
      "computer_snapshot",
      "computer_click",
      "computer_type",
      "computer_capture_region",
    ]) {
      expect(isLiveStateTool(name)).toBe(true);
    }
  });

  it("treats pure read-only / query tools as cacheable (not live-state)", () => {
    for (const name of [
      "read_file",
      "web_search",
      "web_fetch",
      "workspace_search",
      "search_agents",
      "get_site_credentials",
      "site_fill_credentials",
    ]) {
      expect(isLiveStateTool(name)).toBe(false);
    }
  });
});
