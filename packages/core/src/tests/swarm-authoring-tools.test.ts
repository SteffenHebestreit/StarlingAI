import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real temp workspace so we exercise the actual shard write + revert; mocked loader/validator/audit.
let workspaceDir: string;
let configState: { subAgents: Record<string, unknown>; scenes: Record<string, unknown>; jobs: Record<string, unknown> };
let overlayMutations: Array<Record<string, unknown>>;
let validationResult: { ok: boolean; parseErrors: string[]; schemaErrors: string[]; referenceErrors: string[]; warnings: string[]; summary: { subAgents: number; scenes: number; jobs: number } };

vi.mock("../config/loader.js", () => ({
  getConfig: () => ({ workspacePath: workspaceDir, ...configState }),
  updateConfig: (mut: (raw: Record<string, unknown>) => void) => {
    const raw = JSON.parse(JSON.stringify(configState));
    mut(raw);
    configState = raw;
    overlayMutations.push(raw);
    return raw;
  },
}));
vi.mock("../config/validate-workspace.js", () => ({
  validateWorkspaceConfig: () => validationResult,
}));
vi.mock("../audit/logger.js", () => ({ logAudit: () => undefined }));

const { getAllTools } = await import("../tools/registry.js");
await import("../tools/swarm-authoring-tools.js");
const tool = (name: string) => getAllTools().find((t) => t.name === name)!;
const ctx = { sessionId: "test", workspacePath: "" } as never;

describe("swarm authoring tools (P2) — validate → durable shard → cross-ref gate → live apply", () => {
  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "sai-author-"));
    for (const d of ["agents", "scenes", "jobs"]) mkdirSync(join(workspaceDir, d), { recursive: true });
    configState = { subAgents: {}, scenes: {}, jobs: {} };
    overlayMutations = [];
    validationResult = { ok: true, parseErrors: [], schemaErrors: [], referenceErrors: [], warnings: [], summary: { subAgents: 0, scenes: 0, jobs: 0 } };
  });
  afterEach(() => { rmSync(workspaceDir, { recursive: true, force: true }); });

  it("swarm_define_agent writes the durable shard AND applies the agent live", async () => {
    const res = await tool("swarm_define_agent").execute(
      { name: "cartographer", definition: { description: "Owns POI/map workflows", capabilities: ["maps"], systemPrompt: "You build maps.", tools: ["serve_app"] } },
      ctx,
    );
    expect(res.success).toBe(true);
    const shard = join(workspaceDir, "agents", "50-authored-cartographer.jsonc");
    expect(existsSync(shard)).toBe(true);
    expect(JSON.parse(readFileSync(shard, "utf8"))).toEqual({ subAgents: { cartographer: { description: "Owns POI/map workflows", capabilities: ["maps"], systemPrompt: "You build maps.", tools: ["serve_app"] } } });
    // applied live via the runtime overlay
    expect((configState.subAgents as Record<string, unknown>)["cartographer"]).toBeTruthy();
    expect(overlayMutations).toHaveLength(1);
  });

  it("rejects a schema-invalid definition WITHOUT writing a shard or applying", async () => {
    const res = await tool("swarm_define_agent").execute({ name: "broken", definition: { capabilities: ["x"] } }, ctx); // no description
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/schema validation/i);
    expect(existsSync(join(workspaceDir, "agents", "50-authored-broken.jsonc"))).toBe(false);
    expect(overlayMutations).toHaveLength(0);
  });

  it("REVERTS the shard and does NOT apply when the cross-reference gate fails", async () => {
    validationResult = { ok: false, parseErrors: [], schemaErrors: [], referenceErrors: ["scene 'pois_near' references unknown agent 'cartographer'"], warnings: [], summary: { subAgents: 0, scenes: 1, jobs: 0 } };
    const res = await tool("swarm_save_scene").execute({ name: "pois_near", definition: { description: "POIs near a place", task: "geocode {{place}} then list POIs", allowedAgents: ["cartographer"] } }, ctx);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/would make the swarm config invalid/i);
    expect(res.error).toMatch(/unknown agent/);
    expect(existsSync(join(workspaceDir, "scenes", "50-authored-pois_near.jsonc"))).toBe(false); // reverted (no prior content → deleted)
    expect(overlayMutations).toHaveLength(0);
  });

  it("restores PRIOR shard content on a gate failure (does not destroy an existing file)", async () => {
    const shard = join(workspaceDir, "scenes", "50-authored-pois_near.jsonc");
    writeFileSync(shard, '{"scenes":{"pois_near":{"description":"old","task":"old"}}}\n', "utf8");
    validationResult = { ok: false, parseErrors: [], schemaErrors: [], referenceErrors: ["bad ref"], warnings: [], summary: { subAgents: 0, scenes: 1, jobs: 0 } };
    await tool("swarm_save_scene").execute({ name: "pois_near", definition: { description: "new", task: "new task", overwrite: true } as never, overwrite: true }, ctx);
    expect(readFileSync(shard, "utf8")).toContain('"old"'); // prior content restored verbatim
  });

  it("refuses to clobber an existing entry unless overwrite:true", async () => {
    configState.subAgents = { researcher: { description: "built-in" } };
    const res = await tool("swarm_define_agent").execute({ name: "researcher", definition: { description: "hijack" } }, ctx);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/already exists/i);
    expect(overlayMutations).toHaveLength(0);
  });

  it("rejects a non-snake_case name", async () => {
    const res = await tool("swarm_save_job").execute({ name: "Bad-Name", definition: { description: "d", steps: [{ scene: "x" }] } }, ctx);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/snake_case/i);
  });
});
