import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import * as configLoader from "../config/loader.js";
import { appendFlowMemoryEntry, readFlowMemoryEntries } from "../agent/flow-memory.js";
import { createConversationConfigProposal, listConversationConfigProposals } from "../agent/config-assistant-proposals.js";
import { createToken, resetAuthStateForTests } from "../gateway/auth.js";
import { registerSubAgentRoutes } from "../gateway/sub-agent-routes.js";
import { runWithRequestContext } from "../runtime/request-context.js";
import { safeUserSegment } from "../runtime/user-scope.js";

/**
 * A config-assistant request goes back to its author and to an admin only (found in review,
 * 2026-10-08).
 *
 * The proposals store and flow memory are one file each for the whole deployment, and
 * GET /api/flow-memory and GET /api/config-assistant/proposals handed every signed-in account, a
 * viewer too, every account's raw request text. Under multi-user auth the other accounts still get
 * the summary, the changes and the actions, so the review in Settings works for everyone.
 */
const ALICE_REQUEST = "Make the researcher prefer German family-law sources for my custody case";
const LEGACY_REQUEST = "Switch the summarizer to a smaller model";
const SUMMARY = "Prefer German legal sources in the researcher";

const dirs: string[] = [];

function withConfig(workspacePath: string, authEnabled: boolean): void {
  const real = configLoader.getConfig();
  vi.spyOn(configLoader, "getConfig").mockReturnValue({ ...real, workspacePath, auth: { ...real.auth, enabled: authEnabled } } as typeof real);
}

/** A deployment root holding Alice's proposal and its flow entry, and a proposal and flow entry
 *  written before either carried an account. */
function seed(): string {
  const shared = mkdtempSync(join(tmpdir(), "config-request-visibility-"));
  dirs.push(shared);
  const alice = safeUserSegment("alice");
  const item = (request: string, account?: string) => {
    createConversationConfigProposal(shared, {
      status: "pending",
      mode: "enhancement",
      request,
      summary: SUMMARY,
      assistantAgent: "config_assistant",
      targetAgent: "researcher",
      configChanges: [{ path: "subAgents.researcher.temperature", value: 0.2, reason: "steadier sources" }],
      promptChanges: [],
      validations: [],
      tags: ["sources"],
      ...(account ? { account } : {}),
    });
    appendFlowMemoryEntry(shared, {
      scope: "enhancement",
      request,
      summary: SUMMARY,
      targetAgent: "researcher",
      actions: ["set subAgents.researcher.temperature"],
      outcome: "proposed",
      ...(account ? { account } : {}),
    });
  };
  item(ALICE_REQUEST, alice);
  item(LEGACY_REQUEST);
  return shared;
}

interface Listing { text: string; items: Array<Record<string, unknown>> }

/** The two listings as the gateway serves them: every /api request runs in its user's context. */
async function listingsAs(userId: string | undefined, role: string): Promise<{ flow: Listing; proposals: Listing }> {
  const app = new Hono();
  app.use("/api/*", (_c, next) => runWithRequestContext({ userId }, () => next()));
  registerSubAgentRoutes(app);
  const headers = { Authorization: `Bearer ${await createToken(userId ?? "bootstrap", { role })}` };
  const read = async (path: string, key: string): Promise<Listing> => {
    const response = await app.request(path, { headers });
    expect(response.status).toBe(200);
    const text = await response.text();
    return { text, items: (JSON.parse(text) as Record<string, Array<Record<string, unknown>>>)[key]! };
  };
  return { flow: await read("/api/flow-memory", "entries"), proposals: await read("/api/config-assistant/proposals", "proposals") };
}

describe("config-assistant request text and who reads it", () => {
  beforeAll(() => {
    // A signing key of the test's own, so no token touches the operator's stored one.
    process.env["SAI_JWT_SECRET"] = "request-visibility-test-".repeat(3);
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

  it("under multi-user auth, gives the author their own request text and no one else's", async () => {
    withConfig(seed(), true);

    const { flow, proposals } = await listingsAs("alice", "operator");

    for (const listing of [flow, proposals]) {
      expect(listing.text).toContain(ALICE_REQUEST);
      expect(listing.text).not.toContain(LEGACY_REQUEST);
      expect(listing.text).not.toContain("\"account\"");
    }
  });

  it("under multi-user auth, gives another account the summary and the changes without the request text", async () => {
    withConfig(seed(), true);

    const { flow, proposals } = await listingsAs("bob", "operator");

    for (const listing of [flow, proposals]) {
      expect(listing.items).toHaveLength(2);
      expect(listing.text).not.toContain(ALICE_REQUEST);
      expect(listing.text).not.toContain(LEGACY_REQUEST);
      expect(listing.text).not.toContain("\"account\"");
      for (const item of listing.items) {
        expect(item).not.toHaveProperty("request");
        expect(item["summary"]).toBe(SUMMARY);
      }
    }
    expect(flow.items[0]).toMatchObject({ actions: ["set subAgents.researcher.temperature"] });
    expect(proposals.items[0]).toMatchObject({ configChanges: [{ path: "subAgents.researcher.temperature" }] });
  });

  it("under multi-user auth, gives an admin every request text", async () => {
    withConfig(seed(), true);

    const { flow, proposals } = await listingsAs("carol", "admin");

    for (const listing of [flow, proposals]) {
      expect(listing.text).toContain(ALICE_REQUEST);
      expect(listing.text).toContain(LEGACY_REQUEST);
      expect(listing.text).not.toContain("\"account\"");
    }
  });

  it("with one operator, serves every item as it is stored", async () => {
    const shared = mkdtempSync(join(tmpdir(), "config-request-visibility-"));
    dirs.push(shared);
    withConfig(shared, false);
    // Written the way the routes write them with one operator: no account.
    appendFlowMemoryEntry(shared, { scope: "enhancement", request: ALICE_REQUEST, summary: SUMMARY, actions: [], outcome: "proposed" });
    createConversationConfigProposal(shared, {
      status: "pending", mode: "enhancement", request: ALICE_REQUEST, summary: SUMMARY, assistantAgent: "config_assistant",
      configChanges: [], promptChanges: [], validations: [], tags: [],
    });

    const { flow, proposals } = await listingsAs("bob", "viewer");

    expect(flow.items).toEqual(readFlowMemoryEntries(shared, 50).reverse());
    expect(proposals.items).toEqual(listConversationConfigProposals(shared, 50));
  });

  it("records the caller as the author of a flow entry it posts, whatever the body says", async () => {
    const shared = mkdtempSync(join(tmpdir(), "config-request-visibility-"));
    dirs.push(shared);
    withConfig(shared, true);
    const app = new Hono();
    app.use("/api/*", (_c, next) => runWithRequestContext({ userId: "bob" }, () => next()));
    registerSubAgentRoutes(app);

    const response = await app.request("/api/flow-memory", {
      method: "POST",
      headers: { Authorization: `Bearer ${await createToken("bob", { role: "operator" })}`, "content-type": "application/json" },
      body: JSON.stringify({ scope: "workflow", request: "Bob's own request", summary: "A summary", outcome: "proposed", account: safeUserSegment("alice") }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).not.toHaveProperty("account");
    expect(readFlowMemoryEntries(shared, 10).at(-1)).toMatchObject({ request: "Bob's own request", account: safeUserSegment("bob") });
  });
});
