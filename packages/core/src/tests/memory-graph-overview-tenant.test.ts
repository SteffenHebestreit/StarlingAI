import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { int, Node, Relationship } from "neo4j-driver";

/**
 * THE GRAPH INSPECTOR SHOWS AN ACCOUNT ITS OWN MEMORY AND THE SHARED MEMORY (found 2026-10-08).
 *
 * GET /api/graph/overview checked the token alone and sampled every account's MemoryRecord nodes,
 * text and vector included, so under multi-user auth a viewer could page through other accounts'
 * memory. Only a second bug kept that from happening: the route read its nodes from flattened rows,
 * which carry no identity, so it never returned a node at all.
 *
 * The fake graph below answers every query with every node, whatever the query asks for, so what an
 * account gets back is decided by the route itself.
 */
const { runCypher } = vi.hoisted(() => ({ runCypher: vi.fn() }));
vi.mock("../db/neo4j.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../db/neo4j.js")>()),
  isGraphDbAvailable: () => true,
  runCypher,
}));

const tempDir = mkdtempSync(join(tmpdir(), "starlingai-graph-overview-"));
const configPath = join(tempDir, "starlingai.json");
process.env["SAI_CONFIG_PATH"] = configPath;

const account = (username: string, role: string) => ({
  username, role, passwordHash: "scrypt$placeholder-hash-not-used-here", createdAt: "2026-10-08T00:00:00Z",
});

async function load(authEnabled: boolean) {
  writeFileSync(configPath, JSON.stringify({
    workspacePath: join(tempDir, "workspace"),
    gateway: { jwtSecret: "g".repeat(32) },
    auth: authEnabled
      ? { enabled: true, users: [account("alice", "operator"), account("bob", "operator"), account("vera", "viewer")] }
      : { enabled: false },
  }), "utf8");
  // Sequential: these modules import each other, and parallel first imports can deadlock.
  const loader = await import("../config/loader.js");
  const context = await import("../runtime/request-context.js");
  const scope = await import("../runtime/user-scope.js");
  const auth = await import("../gateway/auth.js");
  const routes = await import("../gateway/memory-graph-routes.js");
  loader.resetConfigForTests();
  loader.loadConfig();
  const app = new Hono();
  // What the gateway does for every /api request under auth (gateway/index.ts).
  app.use("/api/*", async (c, next) => {
    const user = await auth.authenticatedUser(c.req.header("Authorization"));
    return context.runWithRequestContext({ userId: user?.username }, () => next());
  });
  routes.registerMemoryGraphRoutes(app);
  const overview = async (username: string, role: string, query = "") => {
    const token = await auth.createToken(username, { role });
    return app.request(`/api/graph/overview${query}`, { headers: { Authorization: `Bearer ${token}` } });
  };
  return { overview, scope };
}

let identity = 0;
const node = (labels: string[], properties: Record<string, unknown>) => {
  identity += 1;
  return new Node(int(identity), labels, properties, String(identity));
};
const wrote = (agent: Node, memory: Node) => {
  identity += 1;
  return new Relationship(int(identity), agent.identity, memory.identity, "WROTE", { scope: "shared" }, String(identity), agent.elementId, memory.elementId);
};

/** Every node of two accounts, the shared root and one node with no owner, whatever was asked. */
function answerWithEveryNode(aliceSegment: string, bobSegment: string): void {
  const researcher = node(["Agent"], { name: "researcher" });
  const alicePreference = node(["MemoryRecord"], {
    id: "mem-alice-user", scope: "user", kind: "preference", tenant: "alice",
    content: "Alice trinkt Polarstern-Rooibos.", embedding: [0.25, 0.5, 0.75],
  });
  const aliceNote = node(["MemoryRecord"], { id: "mem-alice-ws", scope: "workspace", kind: "fact", tenant: aliceSegment, content: "Lager Nordhafen ist voll." });
  const sharedDecision = node(["MemoryRecord"], { id: "mem-shared", scope: "workspace", kind: "decision", tenant: "shared", content: "Release am Freitag." });
  const bobPreference = node(["MemoryRecord"], { id: "mem-bob-user", scope: "user", kind: "preference", tenant: "bob", content: "Bob trinkt Earl Grey." });
  const bobNote = node(["MemoryRecord"], { id: "mem-bob-ws", scope: "workspace", kind: "fact", tenant: bobSegment, content: "Lager Suedhafen ist leer." });
  const ownerless = node(["MemoryRecord"], { id: "fact:researcher:budget", scope: "workspace", kind: "fact", content: "budget = 40000" });
  const rows: Array<Record<string, unknown>> = [
    { n: alicePreference, r: wrote(researcher, alicePreference), m: researcher },
    { n: aliceNote, r: null, m: null },
    { n: sharedDecision, r: null, m: null },
    { n: bobPreference, r: wrote(researcher, bobPreference), m: researcher },
    { n: bobNote, r: null, m: null },
    { n: ownerless, r: null, m: null },
    { n: researcher, r: wrote(researcher, bobPreference), m: bobPreference },
  ];
  runCypher.mockResolvedValue({ records: rows.map((values) => ({ keys: Object.keys(values), get: (key: string) => values[key] ?? null })) });
}

interface OverviewBody {
  nodes: Array<{ id: string; labels: string[]; name: string; properties: Record<string, unknown> }>;
  edges: Array<{ source: string; target: string; type: string }>;
}

const memoryIds = (body: OverviewBody) => body.nodes
  .filter((n) => n.labels.includes("MemoryRecord"))
  .map((n) => String(n.properties["id"]))
  .sort();

beforeEach(() => {
  runCypher.mockReset();
});

afterAll(async () => {
  (await import("../config/loader.js")).resetConfigForTests();
  delete process.env["SAI_CONFIG_PATH"];
  rmSync(tempDir, { recursive: true, force: true });
});

describe("GET /api/graph/overview under multi-user auth", () => {
  it("refuses a viewer before reading the graph", async () => {
    const { overview } = await load(true);
    const response = await overview("vera", "viewer");
    expect(response.status).toBe(403);
    expect(runCypher).not.toHaveBeenCalled();
  });

  it("shows each account its own and the shared memory, never another account's", async () => {
    const { overview, scope } = await load(true);
    answerWithEveryNode(scope.safeUserSegment("alice"), scope.safeUserSegment("bob"));

    const asAlice = await overview("alice", "operator", "?label=MemoryRecord&limit=500");
    expect(asAlice.status).toBe(200);
    const aliceText = await asAlice.text();
    const aliceBody = JSON.parse(aliceText) as OverviewBody;
    expect(memoryIds(aliceBody)).toEqual(["mem-alice-user", "mem-alice-ws", "mem-shared"]);
    expect(aliceText).toContain("Polarstern-Rooibos");
    for (const foreign of ["Earl Grey", "Suedhafen", "budget = 40000", "mem-bob-user", "fact:researcher"]) {
      expect(aliceText).not.toContain(foreign);
    }
    // The agent that wrote both preferences shows, linked to Alice's alone.
    const researcherId = aliceBody.nodes.find((n) => n.name === "researcher")?.id;
    const alicePreferenceId = aliceBody.nodes.find((n) => n.properties["id"] === "mem-alice-user")?.id;
    expect(researcherId).toBeDefined();
    expect(aliceBody.edges.map((e) => [e.source, e.target].sort())).toEqual([[alicePreferenceId, researcherId].sort()]);
    // A vector is no use to the view.
    expect(aliceBody.nodes.every((n) => !("embedding" in n.properties))).toBe(true);

    const asBob = await overview("bob", "operator", "?label=MemoryRecord&limit=500");
    const bobText = await asBob.text();
    expect(memoryIds(JSON.parse(bobText) as OverviewBody)).toEqual(["mem-bob-user", "mem-bob-ws", "mem-shared"]);
    for (const foreign of ["Polarstern", "Nordhafen", "budget = 40000"]) expect(bobText).not.toContain(foreign);
  });

  it("selects the sample per account, so its LIMIT counts the caller's own nodes", async () => {
    const { overview, scope } = await load(true);
    answerWithEveryNode(scope.safeUserSegment("alice"), scope.safeUserSegment("bob"));
    await overview("alice", "operator", "?label=MemoryRecord");
    const [query, params] = runCypher.mock.calls[0] as [string, Record<string, unknown>];
    const flat = query.replace(/\s+/g, " ");
    for (const variable of ["n", "m"]) {
      expect(flat).toContain(
        `(NOT ${variable}:MemoryRecord OR (${variable}.scope = 'user' AND ${variable}.tenant = $readerUserTenant)`
        + ` OR (${variable}.scope = 'workspace' AND ${variable}.tenant IN [$readerWorkspaceTenant, $sharedWorkspaceTenant]))`,
      );
    }
    // The node filter comes before the LIMIT, the neighbour filter on the neighbour match.
    expect(flat.indexOf("WHERE (NOT n:MemoryRecord")).toBeLessThan(flat.indexOf("LIMIT $limit"));
    expect(flat).toContain("OPTIONAL MATCH (n)-[r]-(m) WHERE (NOT m:MemoryRecord");
    expect(params).toMatchObject({
      limit: 150,
      readerUserTenant: "alice",
      readerWorkspaceTenant: scope.safeUserSegment("alice"),
      sharedWorkspaceTenant: "shared",
    });
  });
});

describe("GET /api/graph/overview with auth off", () => {
  it("stays open to any signed token and sends the same query as before", async () => {
    const { overview } = await load(false);
    answerWithEveryNode("alice-0000000000000000", "bob-0000000000000000");
    const response = await overview("operator", "viewer", "?label=MemoryRecord");
    expect(response.status).toBe(200);
    const body = await response.json() as OverviewBody;
    expect(memoryIds(body)).toEqual(["fact:researcher:budget", "mem-alice-user", "mem-alice-ws", "mem-bob-user", "mem-bob-ws", "mem-shared"]);
    expect(runCypher).toHaveBeenCalledWith(
      "MATCH (n:MemoryRecord)\n           WITH n LIMIT $limit\n           OPTIONAL MATCH (n)-[r]-(m)\n           RETURN n, r, m",
      { limit: 150 },
    );
  });
});
