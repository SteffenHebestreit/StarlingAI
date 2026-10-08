import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import * as configLoader from "../config/loader.js";
import { appendFlowMemoryEntry, formatFlowMemoryGuidance, readFlowMemoryEntries } from "../agent/flow-memory.js";
import { createConversationConfigProposal, listConversationConfigProposals } from "../agent/config-assistant-proposals.js";
import { createToken, resetAuthStateForTests } from "../gateway/auth.js";
import { registerSubAgentRoutes } from "../gateway/sub-agent-routes.js";
import { runWithRequestContext } from "../runtime/request-context.js";
import { safeUserSegment } from "../runtime/user-scope.js";

/**
 * A config-assistant request, and everything written from it, goes to its author and to an admin
 * only (found in review, 2026-10-08).
 *
 * The proposals store and flow memory are one file each for the whole deployment, and
 * GET /api/flow-memory and GET /api/config-assistant/proposals handed every signed-in account, a
 * viewer too, every account's request and everything drafted from it: the summary, the reasons,
 * the prompts and their rationale, the checks, the lesson, the feedback notes. Under multi-user
 * auth every other account gets the structure only. Each such field below carries the word
 * "custody", so one search finds any of them.
 */
const MARK = "custody";
const ALICE_REQUEST = "Make the researcher prefer German family-law sources for my custody case";

const dirs: string[] = [];

function withConfig(workspacePath: string, authEnabled: boolean): void {
  const real = configLoader.getConfig();
  vi.spyOn(configLoader, "getConfig").mockReturnValue({ ...real, workspacePath, auth: { ...real.auth, enabled: authEnabled } } as typeof real);
}

/** A deployment root holding Alice's proposal and flow entry, and a proposal and flow entry written
 *  before either carried an account; every field written from a request names the custody case. */
function seed(): string {
  const shared = mkdtempSync(join(tmpdir(), "config-request-visibility-"));
  dirs.push(shared);
  const item = (account?: string) => {
    createConversationConfigProposal(shared, {
      status: "pending",
      mode: "enhancement",
      request: ALICE_REQUEST,
      summary: `Prefer German family-law sources for the ${MARK} case`,
      assistantAgent: "config_assistant",
      targetAgent: "researcher",
      configChanges: [{ path: "subAgents.researcher.temperature", value: `${MARK} 0.2`, reason: `steadier sources for the ${MARK} case` }],
      promptChanges: [{ agentName: "researcher", strategy: "append", prompt: `Cite family-law sources for ${MARK} matters.`, rationale: `the ${MARK} case needs them` }],
      validations: [`Check the ${MARK} sources exist`],
      tags: [MARK],
      lesson: `${MARK} cases need primary sources`,
      feedbackHistory: [{ ts: "2026-10-08T12:00:00.000Z", outcome: "partial", notes: `the ${MARK} part worked`, lesson: `keep the ${MARK} sources` }],
      ...(account ? { account } : {}),
    });
    appendFlowMemoryEntry(shared, {
      scope: "enhancement",
      request: ALICE_REQUEST,
      summary: `Prefer German family-law sources for the ${MARK} case`,
      targetAgent: "researcher",
      actions: [`set subAgents.researcher.${MARK}`],
      outcome: "proposed",
      lesson: `${MARK} cases need primary sources`,
      tags: [MARK],
      ...(account ? { account } : {}),
    });
  };
  item(safeUserSegment("alice"));
  item();
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

describe("config-assistant requests and who reads what was written from them", () => {
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

  it("under multi-user auth, gives the author their own items whole and no one else's", async () => {
    withConfig(seed(), true);

    const { flow, proposals } = await listingsAs("alice", "operator");

    for (const listing of [flow, proposals]) {
      expect(listing.items).toHaveLength(2);
      expect(listing.items.filter((item) => JSON.stringify(item).includes(MARK))).toHaveLength(1);
      expect(listing.text).toContain(ALICE_REQUEST);
      expect(listing.text).not.toContain("\"account\"");
    }
    expect(proposals.text).toContain(`the ${MARK} part worked`);
  });

  it("under multi-user auth, gives another account the structure only", async () => {
    withConfig(seed(), true);

    const { flow, proposals } = await listingsAs("bob", "operator");

    for (const listing of [flow, proposals]) {
      expect(listing.items).toHaveLength(2);
      expect(listing.text).not.toContain(MARK);
      expect(listing.text).not.toContain("\"account\"");
    }
    for (const proposal of proposals.items) {
      expect(Object.keys(proposal).sort()).toEqual(["assistantAgent", "configChanges", "feedbackHistory", "id", "mode", "promptChanges", "status", "targetAgent", "ts"]);
      expect(proposal).toMatchObject({
        status: "pending",
        configChanges: [{ path: "subAgents.researcher.temperature" }],
        promptChanges: [{ agentName: "researcher", strategy: "append" }],
        feedbackHistory: [{ ts: "2026-10-08T12:00:00.000Z", outcome: "partial" }],
      });
    }
    for (const entry of flow.items) {
      expect(Object.keys(entry).sort()).toEqual(["id", "outcome", "scope", "targetAgent", "ts"]);
    }
  });

  it("under multi-user auth, gives an admin every item whole", async () => {
    withConfig(seed(), true);

    const { flow, proposals } = await listingsAs("carol", "admin");

    for (const listing of [flow, proposals]) {
      expect(listing.items.filter((item) => JSON.stringify(item).includes(MARK))).toHaveLength(2);
      expect(listing.text).not.toContain("\"account\"");
    }
  });

  it("with one operator, serves every item as it is stored", async () => {
    const shared = mkdtempSync(join(tmpdir(), "config-request-visibility-"));
    dirs.push(shared);
    withConfig(shared, false);
    // Written the way the routes write them with one operator: no account.
    appendFlowMemoryEntry(shared, { scope: "enhancement", request: ALICE_REQUEST, summary: "A summary", actions: ["set a.b"], outcome: "proposed", lesson: "A lesson" });
    createConversationConfigProposal(shared, {
      status: "pending", mode: "enhancement", request: ALICE_REQUEST, summary: "A summary", assistantAgent: "config_assistant",
      configChanges: [{ path: "a.b", value: 1, reason: "a reason" }], promptChanges: [], validations: ["a check"], tags: ["a"],
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

describe("the learned flow guidance and whose entries it reads", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** One entry for Alice, one for Bob, one from before entries carried an account, all matching
   *  the query; each names its owner in its summary. */
  function seedGuidance(): string {
    const root = mkdtempSync(join(tmpdir(), "flow-guidance-account-"));
    dirs.push(root);
    const entry = (owner: string, account?: string) => appendFlowMemoryEntry(root, {
      scope: "enhancement",
      request: "steady researcher sources",
      summary: `${owner} made the researcher prefer steady sources`,
      targetAgent: "researcher",
      actions: ["set subAgents.researcher.temperature"],
      outcome: "applied",
      ...(account ? { account } : {}),
    });
    entry("Alice", safeUserSegment("alice"));
    entry("Bob", safeUserSegment("bob"));
    entry("Someone before accounts");
    return root;
  }

  const guidance = (root: string) => formatFlowMemoryGuidance(root, "steady researcher sources", { targetAgent: "researcher", limit: 5 });

  it("under multi-user auth, reads only the caller's own entries", () => {
    const root = seedGuidance();
    withConfig(root, true);

    const text = runWithRequestContext({ userId: "bob" }, () => guidance(root));

    expect(text).toContain("Bob made the researcher");
    expect(text).not.toContain("Alice");
    expect(text).not.toContain("Someone before accounts");
  });

  it("under multi-user auth with no user in the request, reads none", () => {
    const root = seedGuidance();
    withConfig(root, true);

    expect(guidance(root)).toBe("");
  });

  it("with one operator, reads every entry as before", () => {
    const root = seedGuidance();
    withConfig(root, false);

    const text = guidance(root);

    for (const owner of ["Alice", "Bob", "Someone before accounts"]) expect(text).toContain(`${owner} made the researcher`);
  });
});
