/**
 * THE GATEWAY'S OTHER READERS AND WRITERS FOLLOW NO LINK OUT OF ITS ZONE (review 2026-10-11).
 *
 * Beside the file tools (workspace-link-containment.test.ts), the gateway opens workspace files by
 * path in the dashboard's routes (download, preview, site, archive, upload), in the generators that
 * write into generated/, and in the readers that take a path from a page or a tool's report (the
 * images a deck inlines, the scripts a page check runs, the artifact probes, the snapshot refresh,
 * the memory vault, the unfinished-build scan, serve_app's bind). A sandbox can leave a link under
 * any of those names; each now holds the path to its zone (containedWorkspaceRealPath).
 *
 * Real temp directories and real links; a link to a directory is a junction where this machine
 * cannot make symbolic links, and the case that needs a link to a FILE skips there.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as configLoader from "../config/loader.js";
import { runWithRequestContext } from "../runtime/request-context.js";
import { getTool, type ToolContext, type ToolResult } from "../tools/registry.js";

const ORIGINAL = "{ \"original\": true }\n";
const SECRET = "gateway-secret-canary";

/** Whether this machine can make a symbolic link to a file. */
const fileLinks = (() => {
  const dir = mkdtempSync(join(tmpdir(), "sai-link-probe-"));
  try {
    writeFileSync(join(dir, "f"), "");
    symlinkSync(join(dir, "f"), join(dir, "l"));
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();
const FILE_LINK_REASON = "this machine cannot make a symbolic link to a file (Windows without the privilege); runs where it can";

/** A link to a directory: a symbolic link, or a junction where the machine cannot make one. */
function linkDir(target: string, at: string): void {
  try {
    symlinkSync(target, at, "dir");
  } catch {
    symlinkSync(target, at, "junction");
  }
}

let ws = "";
let outside = "";

beforeAll(async () => {
  await import("../tools/artifact-emitters.js");
  await import("../tools/website.js");
});

beforeEach(() => {
  // The shared root of an auth-off deployment: the config zone, the state directory and generated/.
  ws = mkdtempSync(join(tmpdir(), "sai-link-ws-"));
  outside = mkdtempSync(join(tmpdir(), "sai-link-outside-"));
  mkdirSync(join(ws, "agents"), { recursive: true });
  writeFileSync(join(ws, "agents", "evil.jsonc"), ORIGINAL);
  mkdirSync(join(ws, ".starlingai"), { recursive: true });
  writeFileSync(join(ws, ".starlingai", "accounts.json"), ORIGINAL);
  mkdirSync(join(ws, "generated"), { recursive: true });
  writeFileSync(join(outside, "secret.txt"), SECRET);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(ws, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const unchanged = () => {
  expect(readFileSync(join(ws, "agents", "evil.jsonc"), "utf8")).toBe(ORIGINAL);
  expect(readFileSync(join(ws, ".starlingai", "accounts.json"), "utf8")).toBe(ORIGINAL);
};

function run(tool: string, args: Record<string, unknown>, scope: "generated" | "full" = "generated"): Promise<ToolResult> {
  const ctx: ToolContext = { sessionId: `s-link-${tool}`, workspacePath: ws, workspaceScope: scope };
  return runWithRequestContext({ workspaceScope: scope }, () => getTool(tool)!.execute(args, ctx));
}

describe("the generators", () => {
  it("generate_svg refuses an output through a link", async () => {
    linkDir(join(ws, "agents"), join(ws, "generated", "cfg"));
    const result = await run("generate_svg", { svg: "<rect width='1' height='1'/>", output_file: "cfg/x.svg" });
    expect(result.success).toBe(false);
    expect(readdirSync(join(ws, "agents"))).toEqual(["evil.jsonc"]);
  });

  it("generate_website writes no page through a link inside its output directory", async () => {
    mkdirSync(join(ws, "generated", "site"), { recursive: true });
    linkDir(join(ws, "agents"), join(ws, "generated", "site", "docs"));
    const result = await run("generate_website", {
      outputDir: "site",
      title: "Site",
      pages: [
        { path: "index.html", title: "Home", content: "# Home" },
        { path: "docs/planted.html", title: "Planted", content: "planted" },
      ],
    });
    expect(result.success).toBe(false);
    expect(readdirSync(join(ws, "agents"))).toEqual(["evil.jsonc"]);
    unchanged();
  });

  it("inlines no image a link leads to", async () => {
    const { inlineLocalImagesInHtml } = await import("../tools/inline-images.js");
    mkdirSync(join(ws, "generated", "deck"), { recursive: true });
    writeFileSync(join(outside, "secret.png"), SECRET);
    linkDir(outside, join(ws, "generated", "deck", "img"));
    const html = await inlineLocalImagesInHtml("<img src=\"img/secret.png\">", join(ws, "generated", "deck"));
    expect(html).toBe("<img src=\"img/secret.png\">");
  });

  it("reads no script a link leads to into the page check", async () => {
    const { collectScripts } = await import("../tools/page-check-runner.js");
    mkdirSync(join(ws, "generated", "page"), { recursive: true });
    writeFileSync(join(outside, "app.js"), `throw new Error("${SECRET}")`);
    linkDir(outside, join(ws, "generated", "page", "js"));
    const { scripts, externalMisses } = collectScripts("<script src=\"js/app.js\"></script>", join(ws, "generated", "page", "index.html"));
    expect(scripts.map((script) => script.code).join("")).not.toContain(SECRET);
    expect(externalMisses).toEqual(["js/app.js"]);
  });

  it("serve_app binds no directory reached through a link", async () => {
    const { reachedThroughNoLink } = await import("../tools/serve-app.js");
    mkdirSync(join(ws, "generated", "app"), { recursive: true });
    expect(reachedThroughNoLink("generated/app", ws)).toBe(true);
    linkDir(outside, join(ws, "generated", "hostdir"));
    linkDir(join(ws, "generated", "app"), join(ws, "generated", "alias"));
    expect(reachedThroughNoLink("generated/hostdir", ws)).toBe(false);
    // Even one that stays in its zone: docker resolves it on the host, where it can lead elsewhere.
    expect(reachedThroughNoLink("generated/alias", ws)).toBe(false);
  });

  it("the artifact probes read no file a link leads to", async () => {
    const { probeArtifacts } = await import("../agent/artifact-probes.js");
    linkDir(outside, join(ws, "generated", "out"));
    const report = await probeArtifacts([{ kind: "file", location: "generated/out/secret.txt" }], { workspacePath: ws });
    expect(report.receipts.every((receipt) => receipt.status !== "pass")).toBe(true);
    expect(JSON.stringify(report)).not.toContain(SECRET);
  });

  it("the memory vault export writes no note through a link in the vault", async () => {
    const { exportMemoryVault } = await import("../memory/vault.js");
    const { storeWorkspaceMemoryRecord } = await import("../memory/service.js");
    storeWorkspaceMemoryRecord(ws, { key: "editor", subject: "Editor", content: "vim", kind: "preference" });
    mkdirSync(join(ws, "vault"), { recursive: true });
    linkDir(join(ws, "agents"), join(ws, "vault", "memory"));
    await exportMemoryVault({ workspacePath: ws, includeSessions: false });
    expect(readdirSync(join(ws, "agents"))).toEqual(["evil.jsonc"]);
  });

  it("the artifact snapshot refresh previews no file a link leads to", async () => {
    const { refreshWorkspaceArtifactSnapshot } = await import("../agent/sub-agent.js");
    linkDir(outside, join(ws, "generated", "out"));
    const artifact = { artifactKind: "workspace_file", outputPath: "generated/out/secret.txt", textPreview: "write-time" };
    expect(refreshWorkspaceArtifactSnapshot(artifact, ws)["textPreview"]).toBe("write-time");
  });

  it("the unfinished-build scan does not walk a generated/ that is a link", async () => {
    const { findUnfilledStubFiles } = await import("../agent/sub-agent.js");
    const { UNFINISHED_STUB_MARKER } = await import("../agent/sub-agent-prompt-guidance.js");
    writeFileSync(join(outside, "x.js"), `// ${UNFINISHED_STUB_MARKER}: ${SECRET}\n`);
    rmSync(join(ws, "generated"), { recursive: true, force: true });
    linkDir(outside, join(ws, "generated"));
    expect(findUnfilledStubFiles(ws).count).toBe(0);
  });
});

describe("the dashboard's workspace routes", () => {
  const SECRET_KEY = "workspace-link-containment-test-secret-key";
  let app: Hono;
  let token = "";

  beforeAll(() => { process.env["SAI_JWT_SECRET"] = SECRET_KEY; });

  beforeEach(async () => {
    const config = { auth: { enabled: false, provider: "builtin", users: [] }, workspacePath: ws, gateway: { jwtSecret: SECRET_KEY } };
    vi.spyOn(configLoader, "getConfig").mockImplementation(() => config as unknown as ReturnType<typeof configLoader.getConfig>);
    const { createToken } = await import("../gateway/auth.js");
    token = await createToken("operator");
    const { registerWorkspaceRoutes } = await import("../gateway/workspace-routes.js");
    app = new Hono();
    registerWorkspaceRoutes(app);
    linkDir(outside, join(ws, "generated", "out"));
  });

  afterAll(() => { delete process.env["SAI_JWT_SECRET"]; });

  const get = (path: string) => app.request(path, { headers: { Authorization: `Bearer ${token}` } });

  it("GET /api/workspace/file serves no file a link leads to", async () => {
    const response = await get(`/api/workspace/file?path=${encodeURIComponent("generated/out/secret.txt")}`);
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(SECRET);
  });

  it("the preview and site routes serve no file a link leads to", async () => {
    const preview = await app.request(`/api/workspace/preview?root=generated&file=${encodeURIComponent("out/secret.txt")}&token=${token}`);
    expect(preview.status).toBe(400);
    expect(await preview.text()).not.toContain(SECRET);
    const enc = Buffer.from("generated").toString("base64url");
    const site = await app.request(`/api/workspace/site/${enc}/out/secret.txt?token=${token}`);
    expect(site.status).toBe(400);
    expect(await site.text()).not.toContain(SECRET);
  });

  it("the archive leaves a link out", async () => {
    writeFileSync(join(ws, "generated", "kept.txt"), "kept");
    const response = await get(`/api/workspace/archive?path=generated`);
    expect(response.status).toBe(200);
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.includes(Buffer.from("kept.txt"))).toBe(true);
    expect(bytes.includes(Buffer.from("secret.txt"))).toBe(false);
  });

  it.skipIf(!fileLinks)(`an upload is not written through a link at its own name (${FILE_LINK_REASON})`, async () => {
    symlinkSync(join(outside, "secret.txt"), join(ws, "generated", "notes.txt"));
    const form = new FormData();
    form.set("file", new File(["planted"], "notes.txt"));
    form.set("subdir", "generated");
    const response = await app.request("/api/workspace/upload", { method: "POST", body: form, headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(400);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe(SECRET);
  });

  it("an upload is not written through a link", async () => {
    const form = new FormData();
    form.set("file", new File(["planted"], "evil.jsonc"));
    form.set("subdir", "generated/out");
    const response = await app.request("/api/workspace/upload", { method: "POST", body: form, headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(400);
    expect(readdirSync(outside)).toEqual(["secret.txt"]);
  });
});
