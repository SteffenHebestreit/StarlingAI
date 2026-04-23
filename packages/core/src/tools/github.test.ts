import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../credentials/store.js", () => ({
  getCredential: vi.fn((name: string) => name === "github_token" ? "stored-pat-token" : undefined),
}));

async function setupConfig(extra: Record<string, unknown> = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), "starlingai-github-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    sourceForge: {
      defaultGithub: "primary",
      github: {
        primary: {
          baseUrl: "https://api.github.com",
          token: "secret:github_token",
          defaultOwner: "acme",
          defaultRepo: "widgets",
          userAgent: "StarlingAI/test",
          timeoutMs: 30000,
        },
        enterprise: {
          baseUrl: "https://github.example.com/api/v3",
          token: "$GHE_TOKEN",
          userAgent: "StarlingAI/ghe",
          timeoutMs: 30000,
        },
      },
      ...extra,
    },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = configPath;
  return tempDir;
}

describe("github tools", () => {
  const cleanup: string[] = [];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const dir of cleanup.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["GHE_TOKEN"];
    vi.resetModules();
  });

  async function getTool(name: string) {
    const [{ getTool }] = await Promise.all([
      import("./registry.js"),
      import("./github.js"),
    ]);
    return getTool(name)!;
  }

  function ctx() {
    return { sessionId: "s1", workspacePath: "/tmp" };
  }

  it("registers all 8 GitHub tools at the right tiers", async () => {
    const [{ getAllTools }, { getToolTier }] = await Promise.all([
      import("./registry.js"),
      import("../guardrails/tool-tiers.js"),
      import("./github.js"),
    ]);
    const names = getAllTools().map((t) => t.name);
    const reads = ["github_pr_list", "github_pr_get", "github_check_runs_list", "github_actions_runs_list"];
    const mutates = ["github_pr_create", "github_pr_comment", "github_actions_trigger", "github_release_create"];
    expect(names).toEqual(expect.arrayContaining([...reads, ...mutates]));
    for (const r of reads) expect(getToolTier(r).tier).toBe(0);
    for (const m of mutates) {
      const def = getToolTier(m);
      expect(def.tier).toBe(2);
      expect(def.requiresPerCallApproval).toBe(true);
    }
  });

  it("github_pr_list builds correct URL and headers, falls back to defaultOwner/defaultRepo", async () => {
    cleanup.push(await setupConfig());
    fetchMock.mockResolvedValue(new Response(JSON.stringify([{ number: 1, title: "x" }]), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await (await getTool("github_pr_list")).execute({
      state: "open",
      perPage: 25,
    }, ctx());

    expect(result.success).toBe(true);
    expect(result.metadata?.["count"]).toBe(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("https://api.github.com/repos/acme/widgets/pulls?");
    expect(String(url)).toContain("state=open");
    expect(String(url)).toContain("per_page=25");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer stored-pat-token");
    expect(headers["Accept"]).toBe("application/vnd.github+json");
    expect(headers["User-Agent"]).toBe("StarlingAI/test");
    expect(headers["X-GitHub-Api-Version"]).toBe("2022-11-28");
  });

  it("github_pr_list explicit owner/repo override defaults", async () => {
    cleanup.push(await setupConfig());
    fetchMock.mockResolvedValue(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));

    await (await getTool("github_pr_list")).execute({
      owner: "other-org",
      repo: "other-repo",
    }, ctx());

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/repos/other-org/other-repo/pulls");
  });

  it("github_pr_get rejects missing/invalid number and fetches the right path", async () => {
    cleanup.push(await setupConfig());
    const tool = await getTool("github_pr_get");

    const bad = await tool.execute({}, ctx());
    expect(bad.success).toBe(false);
    expect(bad.error).toContain("number");

    fetchMock.mockResolvedValue(new Response(JSON.stringify({ number: 42, title: "Test" }), { status: 200, headers: { "content-type": "application/json" } }));
    const ok = await tool.execute({ number: 42 }, ctx());
    expect(ok.success).toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/repos\/acme\/widgets\/pulls\/42$/);
  });

  it("github_check_runs_list URL-encodes the ref and forwards filter+per_page", async () => {
    cleanup.push(await setupConfig());
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ total_count: 3, check_runs: [] }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await (await getTool("github_check_runs_list")).execute({
      ref: "feature/encoding test",
      filter: "latest",
      perPage: 50,
    }, ctx());

    expect(result.success).toBe(true);
    expect(result.metadata?.["totalCount"]).toBe(3);
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/commits/feature%2Fencoding%20test/check-runs");
    expect(url).toContain("filter=latest");
    expect(url).toContain("per_page=50");
  });

  it("github_actions_runs_list switches between scoped and global endpoints", async () => {
    cleanup.push(await setupConfig());
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }), { status: 200, headers: { "content-type": "application/json" } }));

    await (await getTool("github_actions_runs_list")).execute({}, ctx());
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/repos\/acme\/widgets\/actions\/runs/);

    fetchMock.mockClear();
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ total_count: 0, workflow_runs: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    await (await getTool("github_actions_runs_list")).execute({ workflow: "ci.yml", branch: "main" }, ctx());
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toMatch(/\/actions\/workflows\/ci\.yml\/runs/);
    expect(url).toContain("branch=main");
  });

  it("github_pr_create requires title/head/base, returns html_url in metadata + summary", async () => {
    cleanup.push(await setupConfig());
    const tool = await getTool("github_pr_create");

    const missing = await tool.execute({ head: "x", base: "main" }, ctx());
    expect(missing.success).toBe(false);
    expect(missing.error).toContain("title");

    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ number: 7, html_url: "https://github.com/acme/widgets/pull/7", node_id: "PR_kxyz" }),
      { status: 201, headers: { "content-type": "application/json" } },
    ));
    const result = await tool.execute({
      title: "Add foo",
      head: "feature/foo",
      base: "main",
      body: "Closes #1",
      draft: true,
    }, ctx());

    expect(result.success).toBe(true);
    expect(result.metadata?.["number"]).toBe(7);
    expect(result.metadata?.["htmlUrl"]).toBe("https://github.com/acme/widgets/pull/7");
    expect(result.output).toContain("PR #7");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ title: "Add foo", head: "feature/foo", base: "main", body: "Closes #1", draft: true });
  });

  it("github_pr_comment requires non-empty body and POSTs to issues/<n>/comments", async () => {
    cleanup.push(await setupConfig());
    const tool = await getTool("github_pr_comment");

    const empty = await tool.execute({ number: 7, body: "   " }, ctx());
    expect(empty.success).toBe(false);
    expect(empty.error).toContain("body");

    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ id: 555, html_url: "https://github.com/acme/widgets/pull/7#issuecomment-555" }),
      { status: 201, headers: { "content-type": "application/json" } },
    ));
    const result = await tool.execute({ number: 7, body: "LGTM, thanks!" }, ctx());
    expect(result.success).toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/repos\/acme\/widgets\/issues\/7\/comments$/);
    expect(result.metadata?.["commentId"]).toBe(555);
  });

  it("github_actions_trigger POSTs ref + inputs to dispatches", async () => {
    cleanup.push(await setupConfig());
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    const result = await (await getTool("github_actions_trigger")).execute({
      workflow: "deploy.yml",
      ref: "main",
      inputs: { environment: "staging", dryRun: true },
    }, ctx());

    expect(result.success).toBe(true);
    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/actions\/workflows\/deploy\.yml\/dispatches$/);
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toEqual({ ref: "main", inputs: { environment: "staging", dryRun: true } });
  });

  it("github_release_create posts to releases endpoint and forwards optional flags", async () => {
    cleanup.push(await setupConfig());
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ id: 99, tag_name: "v1.4.0", html_url: "https://github.com/acme/widgets/releases/tag/v1.4.0" }),
      { status: 201, headers: { "content-type": "application/json" } },
    ));

    const result = await (await getTool("github_release_create")).execute({
      tagName: "v1.4.0",
      targetCommitish: "main",
      name: "Release 1.4.0",
      body: "## Highlights\n- foo",
      prerelease: false,
      generateReleaseNotes: true,
    }, ctx());

    expect(result.success).toBe(true);
    expect(result.metadata?.["releaseId"]).toBe(99);
    expect(result.output).toContain("v1.4.0");
    const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.tag_name).toBe("v1.4.0");
    expect(body.target_commitish).toBe("main");
    expect(body.generate_release_notes).toBe(true);
    expect(body.prerelease).toBeUndefined();
  });

  it("surfaces non-2xx responses with the body for diagnosis", async () => {
    cleanup.push(await setupConfig());
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ message: "Not Found" }),
      { status: 404, headers: { "content-type": "application/json" } },
    ));
    const result = await (await getTool("github_pr_get")).execute({ number: 9999 }, ctx());
    expect(result.success).toBe(false);
    expect(result.error).toContain("HTTP 404");
    expect(result.output).toContain("Not Found");
  });

  it("explicit instance picks the GHE host instead of github.com and resolves $ENV token", async () => {
    process.env["GHE_TOKEN"] = "ghe-pat-from-env";
    cleanup.push(await setupConfig());
    fetchMock.mockResolvedValue(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));

    await (await getTool("github_pr_list")).execute({
      instance: "enterprise",
      owner: "internal",
      repo: "ops",
    }, ctx());

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toContain("https://github.example.com/api/v3/repos/internal/ops/pulls");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer ghe-pat-from-env");
    expect(headers["User-Agent"]).toBe("StarlingAI/ghe");
  });

  it("clear error when no GitHub instance is configured", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-github-empty-"));
    cleanup.push(tempDir);
    writeFileSync(join(tempDir, "starlingai.json"), JSON.stringify({
      sourceForge: { github: {} },
    }), "utf8");
    process.env["SAI_CONFIG_PATH"] = join(tempDir, "starlingai.json");

    const result = await (await getTool("github_pr_list")).execute({ owner: "x", repo: "y" }, ctx());
    expect(result.success).toBe(false);
    expect(result.error).toContain("No GitHub instance");
  });
});
