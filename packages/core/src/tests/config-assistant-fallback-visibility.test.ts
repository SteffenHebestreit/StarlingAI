import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import * as configLoader from "../config/loader.js";
import { proposeConversationConfigChange } from "../agent/config-assistant.js";
import { createConversationConfigProposal } from "../agent/config-assistant-proposals.js";
import { createToken, resetAuthStateForTests } from "../gateway/auth.js";
import { registerSubAgentRoutes } from "../gateway/sub-agent-routes.js";
import { runWithRequestContext } from "../runtime/request-context.js";
import { safeUserSegment } from "../runtime/user-scope.js";

/**
 * A reply the config assistant could not parse becomes the proposal's summary, and it can repeat the
 * request (found in review, 2026-10-08). Under multi-user auth that summary goes, like the request,
 * only to the author and an admin.
 */
const REPLY = "I would make the researcher cite family-law sources for your custody hearing next week";

vi.mock("../providers/index.js", async (importActual) => ({
  ...(await importActual<typeof import("../providers/index.js")>()),
  createChatProvider: () => ({
    complete: async () => ({ content: REPLY, tool_calls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, finishReason: "stop" }),
  }),
}));

const dirs: string[] = [];

describe("the summary drafted from an unparsed reply", () => {
  beforeAll(() => {
    process.env["SAI_JWT_SECRET"] = "fallback-visibility-test-".repeat(3);
    resetAuthStateForTests();
  });
  afterAll(() => {
    delete process.env["SAI_JWT_SECRET"];
    resetAuthStateForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("under multi-user auth, goes to the author and not to another account", async () => {
    const shared = mkdtempSync(join(tmpdir(), "config-fallback-visibility-"));
    dirs.push(shared);
    const real = configLoader.getConfig();
    vi.spyOn(configLoader, "getConfig").mockReturnValue({ ...real, workspacePath: shared, auth: { ...real.auth, enabled: true } } as typeof real);
    const request = "Make the researcher cite family-law sources for my custody hearing";
    const { assistantAgent, draft } = await runWithRequestContext({ userId: "alice" }, () => proposeConversationConfigChange({ request, mode: "enhancement", workspacePath: shared }));
    expect(draft.summary).toContain("custody hearing");
    createConversationConfigProposal(shared, { status: "pending", mode: "enhancement", request, assistantAgent, ...draft, account: safeUserSegment("alice") });

    const listAs = async (userId: string) => {
      const app = new Hono();
      app.use("/api/*", (_c, next) => runWithRequestContext({ userId }, () => next()));
      registerSubAgentRoutes(app);
      const response = await app.request("/api/config-assistant/proposals", { headers: { Authorization: `Bearer ${await createToken(userId, { role: "operator" })}` } });
      return response.text();
    };

    expect(await listAs("alice")).toContain("custody hearing next week");
    expect(await listAs("bob")).not.toContain("custody");
  });
});
