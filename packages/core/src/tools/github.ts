/**
 * GitHub source-forge tools.
 *
 * External-only: every call targets a remote GitHub host (api.github.com or a
 * GitHub Enterprise instance) configured under `sourceForge.github.<name>`.
 * The gateway never spins up a local forge or mocks the API.
 */
import { getConfig } from "../config/loader.js";
import type { GitHubInstanceSchema } from "../config/schema.js";
import type { z } from "zod";
import { registerTool, type ToolResult } from "./registry.js";
import { childLogger } from "../logger.js";
import { fetchWithTimeout, resolveSecretRef } from "./infrastructure-shared.js";

const log = childLogger("tool:github");

type GitHubInstance = z.infer<typeof GitHubInstanceSchema>;

const MAX_BODY_BYTES = 64_000;

function fail(message: string): ToolResult {
  return { success: false, output: "", error: message };
}

function truncate(body: string): string {
  if (body.length <= MAX_BODY_BYTES) return body;
  return `${body.slice(0, MAX_BODY_BYTES)}\n\n[Response truncated at ${MAX_BODY_BYTES} bytes]`;
}

function resolveGitHubInstance(
  requestedName: unknown,
): { name?: string; instance?: GitHubInstance; error?: string } {
  const config = getConfig();
  const explicit = typeof requestedName === "string" && requestedName.trim() ? requestedName.trim() : undefined;
  const name = explicit ?? config.sourceForge.defaultGithub;
  if (!name) {
    return { error: "No GitHub instance configured. Set sourceForge.defaultGithub or pass instance=<name>." };
  }
  const instance = config.sourceForge.github[name];
  if (!instance) {
    return { error: `Unknown GitHub instance '${name}'` };
  }
  return { name, instance };
}

function buildHeaders(instance: GitHubInstance, contentType?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": instance.userAgent,
  };
  if (contentType) headers["Content-Type"] = contentType;
  if (instance.token) {
    const token = resolveSecretRef(instance.token) ?? instance.token;
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

function timeoutFor(args: Record<string, unknown>, instance: GitHubInstance): number {
  if (typeof args["timeoutMs"] === "number" && Number.isFinite(args["timeoutMs"])) {
    return Math.max(1_000, Math.min(300_000, Math.trunc(args["timeoutMs"])));
  }
  return instance.timeoutMs;
}

type OwnerRepoResult = { owner: string; repo: string } | { error: string };

function resolveOwnerRepo(
  args: Record<string, unknown>,
  instance: GitHubInstance,
): OwnerRepoResult {
  const owner = (typeof args["owner"] === "string" && String(args["owner"]).trim())
    ? String(args["owner"]).trim()
    : instance.defaultOwner;
  const repo = (typeof args["repo"] === "string" && String(args["repo"]).trim())
    ? String(args["repo"]).trim()
    : instance.defaultRepo;
  if (!owner) return { error: "owner is required (or set sourceForge.github.<instance>.defaultOwner)" };
  if (!repo) return { error: "repo is required (or set sourceForge.github.<instance>.defaultRepo)" };
  return { owner, repo };
}

interface GitHubCallOptions {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: Record<string, unknown>;
  query?: Record<string, string | number | undefined>;
}

async function callGithub(
  instance: GitHubInstance,
  timeoutMs: number,
  options: GitHubCallOptions,
): Promise<{ ok: true; status: number; data: unknown; raw: string } | { ok: false; status?: number; error: string; raw?: string }> {
  const url = new URL(options.path, instance.baseUrl.endsWith("/") ? instance.baseUrl : `${instance.baseUrl}/`);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
  }
  const headers = buildHeaders(instance, options.body ? "application/json" : undefined);
  const init: RequestInit = {
    method: options.method,
    headers,
  };
  if (options.body !== undefined) init.body = JSON.stringify(options.body);

  log.debug({ method: options.method, url: url.toString() }, "github request");
  try {
    const response = await fetchWithTimeout(url.toString(), init, timeoutMs);
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, status: response.status, error: `GitHub returned HTTP ${response.status}`, raw: truncate(text) };
    }
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { ok: true, status: response.status, data, raw: text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `GitHub request failed: ${message}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// READ-ONLY (Tier 0)
// ─────────────────────────────────────────────────────────────────────────────

registerTool({
  name: "github_pr_list",
  description:
    "List pull requests on a GitHub repository. Read-only. Filter by state (open/closed/all), head branch, base branch, and sort order.",
  embeddingDescription:
    "github pull request pr list filter open closed branch source forge code review queue",
  costHint: "low",
  latencyHint: "low",
  parameters: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repo owner (org or user). Falls back to instance defaultOwner." },
      repo: { type: "string", description: "Repo name. Falls back to instance defaultRepo." },
      state: { type: "string", enum: ["open", "closed", "all"], description: "Defaults to open." },
      head: { type: "string", description: "Filter to PRs whose head branch matches owner:branch or branch." },
      base: { type: "string", description: "Filter to PRs whose base branch matches." },
      sort: { type: "string", enum: ["created", "updated", "popularity", "long-running"], description: "Defaults to created." },
      direction: { type: "string", enum: ["asc", "desc"] },
      perPage: { type: "number", description: "Page size (max 100). Defaults to 30." },
      page: { type: "number", description: "Page number for pagination." },
      instance: { type: "string", description: "GitHub instance name. Defaults to sourceForge.defaultGithub." },
      timeoutMs: { type: "number" },
    },
    required: [],
  },
  async execute(args, _ctx) {
    const resolved = resolveGitHubInstance(args["instance"]);
    if (resolved.error || !resolved.instance) return fail(resolved.error ?? "GitHub instance unavailable");
    const ownerRepo = resolveOwnerRepo(args, resolved.instance);
    if ("error" in ownerRepo) return fail(ownerRepo.error);
    const result = await callGithub(resolved.instance, timeoutFor(args, resolved.instance), {
      method: "GET",
      path: `repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls`,
      query: {
        state: typeof args["state"] === "string" ? String(args["state"]) : undefined,
        head: typeof args["head"] === "string" ? String(args["head"]) : undefined,
        base: typeof args["base"] === "string" ? String(args["base"]) : undefined,
        sort: typeof args["sort"] === "string" ? String(args["sort"]) : undefined,
        direction: typeof args["direction"] === "string" ? String(args["direction"]) : undefined,
        per_page: typeof args["perPage"] === "number" ? Math.max(1, Math.min(100, Math.trunc(args["perPage"]))) : undefined,
        page: typeof args["page"] === "number" ? Math.max(1, Math.trunc(args["page"])) : undefined,
      },
    });
    if (!result.ok) return { success: false, output: result.raw ?? "", error: result.error };
    return {
      success: true,
      output: JSON.stringify(result.data, null, 2),
      metadata: {
        instance: resolved.name,
        owner: ownerRepo.owner,
        repo: ownerRepo.repo,
        count: Array.isArray(result.data) ? result.data.length : undefined,
      },
    };
  },
});

registerTool({
  name: "github_pr_get",
  description:
    "Fetch a single pull request by number, including title, body, head/base refs, mergeable state, requested reviewers, and labels. Read-only.",
  embeddingDescription:
    "github pull request pr get fetch detail head base mergeable reviewers labels code review",
  costHint: "low",
  latencyHint: "low",
  parameters: {
    type: "object",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      number: { type: "number", description: "PR number." },
      instance: { type: "string" },
      timeoutMs: { type: "number" },
    },
    required: ["number"],
  },
  async execute(args, _ctx) {
    const resolved = resolveGitHubInstance(args["instance"]);
    if (resolved.error || !resolved.instance) return fail(resolved.error ?? "GitHub instance unavailable");
    const ownerRepo = resolveOwnerRepo(args, resolved.instance);
    if ("error" in ownerRepo) return fail(ownerRepo.error);
    const number = typeof args["number"] === "number" && Number.isFinite(args["number"])
      ? Math.max(1, Math.trunc(args["number"]))
      : NaN;
    if (!Number.isFinite(number)) return fail("number must be a positive integer");
    const result = await callGithub(resolved.instance, timeoutFor(args, resolved.instance), {
      method: "GET",
      path: `repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls/${number}`,
    });
    if (!result.ok) return { success: false, output: result.raw ?? "", error: result.error };
    return {
      success: true,
      output: JSON.stringify(result.data, null, 2),
      metadata: { instance: resolved.name, owner: ownerRepo.owner, repo: ownerRepo.repo, number },
    };
  },
});

registerTool({
  name: "github_check_runs_list",
  description:
    "List CI check runs for a commit (typically a PR head SHA or branch ref). Read-only. Returns each check's name, conclusion, status, and detail URL.",
  embeddingDescription:
    "github check runs ci status pull request commit branch verify build test action workflow",
  costHint: "low",
  latencyHint: "low",
  parameters: {
    type: "object",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      ref: { type: "string", description: "Commit SHA or branch ref." },
      filter: { type: "string", enum: ["latest", "all"], description: "Defaults to latest." },
      perPage: { type: "number" },
      instance: { type: "string" },
      timeoutMs: { type: "number" },
    },
    required: ["ref"],
  },
  async execute(args, _ctx) {
    const resolved = resolveGitHubInstance(args["instance"]);
    if (resolved.error || !resolved.instance) return fail(resolved.error ?? "GitHub instance unavailable");
    const ownerRepo = resolveOwnerRepo(args, resolved.instance);
    if ("error" in ownerRepo) return fail(ownerRepo.error);
    const ref = String(args["ref"] ?? "").trim();
    if (!ref) return fail("ref is required");
    const result = await callGithub(resolved.instance, timeoutFor(args, resolved.instance), {
      method: "GET",
      path: `repos/${ownerRepo.owner}/${ownerRepo.repo}/commits/${encodeURIComponent(ref)}/check-runs`,
      query: {
        filter: typeof args["filter"] === "string" ? String(args["filter"]) : undefined,
        per_page: typeof args["perPage"] === "number" ? Math.max(1, Math.min(100, Math.trunc(args["perPage"]))) : undefined,
      },
    });
    if (!result.ok) return { success: false, output: result.raw ?? "", error: result.error };
    const data = result.data as { total_count?: number; check_runs?: unknown[] } | unknown;
    const totalCount = (data && typeof data === "object" && "total_count" in data)
      ? (data as { total_count?: number }).total_count
      : undefined;
    return {
      success: true,
      output: JSON.stringify(result.data, null, 2),
      metadata: { instance: resolved.name, owner: ownerRepo.owner, repo: ownerRepo.repo, ref, totalCount },
    };
  },
});

registerTool({
  name: "github_actions_runs_list",
  description:
    "List recent GitHub Actions workflow runs. Filter by workflow id/file, branch, status (queued/in_progress/completed), and event (push/pull_request/workflow_dispatch). Read-only.",
  embeddingDescription:
    "github actions workflow runs ci builds list status branch event dispatch deploy",
  costHint: "low",
  latencyHint: "low",
  parameters: {
    type: "object",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      workflow: { type: "string", description: "Workflow filename (e.g. ci.yml) or numeric id. Omit to list across all workflows." },
      branch: { type: "string" },
      event: { type: "string" },
      status: { type: "string", description: "queued | in_progress | completed | success | failure | cancelled | timed_out | action_required | etc." },
      perPage: { type: "number" },
      page: { type: "number" },
      instance: { type: "string" },
      timeoutMs: { type: "number" },
    },
    required: [],
  },
  async execute(args, _ctx) {
    const resolved = resolveGitHubInstance(args["instance"]);
    if (resolved.error || !resolved.instance) return fail(resolved.error ?? "GitHub instance unavailable");
    const ownerRepo = resolveOwnerRepo(args, resolved.instance);
    if ("error" in ownerRepo) return fail(ownerRepo.error);
    const workflow = typeof args["workflow"] === "string" && String(args["workflow"]).trim()
      ? String(args["workflow"]).trim()
      : "";
    const path = workflow
      ? `repos/${ownerRepo.owner}/${ownerRepo.repo}/actions/workflows/${encodeURIComponent(workflow)}/runs`
      : `repos/${ownerRepo.owner}/${ownerRepo.repo}/actions/runs`;
    const result = await callGithub(resolved.instance, timeoutFor(args, resolved.instance), {
      method: "GET",
      path,
      query: {
        branch: typeof args["branch"] === "string" ? String(args["branch"]) : undefined,
        event: typeof args["event"] === "string" ? String(args["event"]) : undefined,
        status: typeof args["status"] === "string" ? String(args["status"]) : undefined,
        per_page: typeof args["perPage"] === "number" ? Math.max(1, Math.min(100, Math.trunc(args["perPage"]))) : undefined,
        page: typeof args["page"] === "number" ? Math.max(1, Math.trunc(args["page"])) : undefined,
      },
    });
    if (!result.ok) return { success: false, output: result.raw ?? "", error: result.error };
    const data = result.data as { total_count?: number } | unknown;
    return {
      success: true,
      output: JSON.stringify(result.data, null, 2),
      metadata: {
        instance: resolved.name,
        owner: ownerRepo.owner,
        repo: ownerRepo.repo,
        workflow: workflow || null,
        totalCount: (data && typeof data === "object" && "total_count" in data)
          ? (data as { total_count?: number }).total_count
          : undefined,
      },
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// MUTATING (Tier 2, HITL)
// ─────────────────────────────────────────────────────────────────────────────

registerTool({
  name: "github_pr_create",
  description:
    "Open a new pull request on a GitHub repository. Approval-gated. Specify head (branch with the changes), base (target branch), title, optional body, and optional draft flag. Returns the new PR number, html_url, and node id.",
  embeddingDescription:
    "github pull request pr create open new branch merge propose changes review draft",
  parameters: {
    type: "object",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      title: { type: "string", description: "PR title (required)." },
      head: { type: "string", description: "Branch with the changes (e.g. feature/x or fork-owner:feature/x)." },
      base: { type: "string", description: "Target branch on the upstream repo (e.g. main, develop)." },
      body: { type: "string", description: "PR description in Markdown." },
      draft: { type: "boolean", description: "Open as a draft PR." },
      maintainerCanModify: { type: "boolean", description: "Allow maintainers to push to the PR head branch (default true for cross-fork PRs)." },
      instance: { type: "string" },
      timeoutMs: { type: "number" },
    },
    required: ["title", "head", "base"],
  },
  async execute(args, _ctx) {
    const resolved = resolveGitHubInstance(args["instance"]);
    if (resolved.error || !resolved.instance) return fail(resolved.error ?? "GitHub instance unavailable");
    const ownerRepo = resolveOwnerRepo(args, resolved.instance);
    if ("error" in ownerRepo) return fail(ownerRepo.error);
    const title = String(args["title"] ?? "").trim();
    const head = String(args["head"] ?? "").trim();
    const base = String(args["base"] ?? "").trim();
    if (!title) return fail("title is required");
    if (!head) return fail("head is required");
    if (!base) return fail("base is required");

    const body: Record<string, unknown> = { title, head, base };
    if (typeof args["body"] === "string") body["body"] = String(args["body"]);
    if (args["draft"] === true) body["draft"] = true;
    if (args["maintainerCanModify"] !== undefined) body["maintainer_can_modify"] = args["maintainerCanModify"] === true;

    const result = await callGithub(resolved.instance, timeoutFor(args, resolved.instance), {
      method: "POST",
      path: `repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls`,
      body,
    });
    if (!result.ok) return { success: false, output: result.raw ?? "", error: result.error };
    const pr = result.data as { number?: number; html_url?: string; node_id?: string };
    return {
      success: true,
      output: pr.html_url ? `Opened PR #${pr.number} → ${pr.html_url}` : JSON.stringify(result.data, null, 2),
      metadata: {
        instance: resolved.name,
        owner: ownerRepo.owner,
        repo: ownerRepo.repo,
        number: pr.number,
        htmlUrl: pr.html_url,
        nodeId: pr.node_id,
      },
    };
  },
});

registerTool({
  name: "github_pr_comment",
  description:
    "Post an issue-style comment on a pull request thread. Approval-gated. For inline review comments on specific files/lines use a separate review-comment tool (not yet wired).",
  embeddingDescription:
    "github pull request pr comment post reply review feedback discuss thread",
  parameters: {
    type: "object",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      number: { type: "number", description: "PR number." },
      body: { type: "string", description: "Comment body in Markdown." },
      instance: { type: "string" },
      timeoutMs: { type: "number" },
    },
    required: ["number", "body"],
  },
  async execute(args, _ctx) {
    const resolved = resolveGitHubInstance(args["instance"]);
    if (resolved.error || !resolved.instance) return fail(resolved.error ?? "GitHub instance unavailable");
    const ownerRepo = resolveOwnerRepo(args, resolved.instance);
    if ("error" in ownerRepo) return fail(ownerRepo.error);
    const number = typeof args["number"] === "number" && Number.isFinite(args["number"])
      ? Math.max(1, Math.trunc(args["number"]))
      : NaN;
    if (!Number.isFinite(number)) return fail("number must be a positive integer");
    const body = String(args["body"] ?? "").trim();
    if (!body) return fail("body is required");

    const result = await callGithub(resolved.instance, timeoutFor(args, resolved.instance), {
      method: "POST",
      path: `repos/${ownerRepo.owner}/${ownerRepo.repo}/issues/${number}/comments`,
      body: { body },
    });
    if (!result.ok) return { success: false, output: result.raw ?? "", error: result.error };
    const comment = result.data as { id?: number; html_url?: string };
    return {
      success: true,
      output: comment.html_url ? `Comment posted → ${comment.html_url}` : JSON.stringify(result.data, null, 2),
      metadata: { instance: resolved.name, owner: ownerRepo.owner, repo: ownerRepo.repo, number, commentId: comment.id, htmlUrl: comment.html_url },
    };
  },
});

registerTool({
  name: "github_actions_trigger",
  description:
    "Trigger a workflow_dispatch run for a GitHub Actions workflow. Approval-gated. The workflow must define `on: workflow_dispatch` and any inputs you pass must match its declared input schema.",
  embeddingDescription:
    "github actions workflow trigger dispatch run ci deploy build manual on-demand kick off",
  parameters: {
    type: "object",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      workflow: { type: "string", description: "Workflow filename (e.g. ci.yml) or numeric id." },
      ref: { type: "string", description: "Git ref the workflow runs against (branch or tag)." },
      inputs: { type: "object", description: "Optional inputs map matching the workflow_dispatch inputs schema.", additionalProperties: true },
      instance: { type: "string" },
      timeoutMs: { type: "number" },
    },
    required: ["workflow", "ref"],
  },
  async execute(args, _ctx) {
    const resolved = resolveGitHubInstance(args["instance"]);
    if (resolved.error || !resolved.instance) return fail(resolved.error ?? "GitHub instance unavailable");
    const ownerRepo = resolveOwnerRepo(args, resolved.instance);
    if ("error" in ownerRepo) return fail(ownerRepo.error);
    const workflow = String(args["workflow"] ?? "").trim();
    const ref = String(args["ref"] ?? "").trim();
    if (!workflow) return fail("workflow is required");
    if (!ref) return fail("ref is required");
    const inputs = (args["inputs"] && typeof args["inputs"] === "object" && !Array.isArray(args["inputs"]))
      ? args["inputs"] as Record<string, unknown>
      : undefined;

    const body: Record<string, unknown> = { ref };
    if (inputs) body["inputs"] = inputs;

    const result = await callGithub(resolved.instance, timeoutFor(args, resolved.instance), {
      method: "POST",
      path: `repos/${ownerRepo.owner}/${ownerRepo.repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
      body,
    });
    if (!result.ok) return { success: false, output: result.raw ?? "", error: result.error };
    return {
      success: true,
      output: `Dispatched workflow '${workflow}' on ref '${ref}'. Use github_actions_runs_list to inspect the resulting run.`,
      metadata: { instance: resolved.name, owner: ownerRepo.owner, repo: ownerRepo.repo, workflow, ref, status: result.status },
    };
  },
});

registerTool({
  name: "github_release_create",
  description:
    "Create a GitHub Release pointing at a tag (existing or newly created from `targetCommitish`). Approval-gated. Body is the release notes Markdown — typically produced by the release_notes_draft scene.",
  embeddingDescription:
    "github release create publish version tag changelog notes ship deliver",
  parameters: {
    type: "object",
    properties: {
      owner: { type: "string" },
      repo: { type: "string" },
      tagName: { type: "string", description: "Tag name (e.g. v1.4.0). Created if it does not exist." },
      targetCommitish: { type: "string", description: "Commit SHA or branch the tag points at when creating it." },
      name: { type: "string", description: "Release title. Defaults to the tag name." },
      body: { type: "string", description: "Release notes in Markdown." },
      draft: { type: "boolean" },
      prerelease: { type: "boolean" },
      generateReleaseNotes: { type: "boolean", description: "Ask GitHub to auto-generate notes from PRs/commits since the last release." },
      instance: { type: "string" },
      timeoutMs: { type: "number" },
    },
    required: ["tagName"],
  },
  async execute(args, _ctx) {
    const resolved = resolveGitHubInstance(args["instance"]);
    if (resolved.error || !resolved.instance) return fail(resolved.error ?? "GitHub instance unavailable");
    const ownerRepo = resolveOwnerRepo(args, resolved.instance);
    if ("error" in ownerRepo) return fail(ownerRepo.error);
    const tagName = String(args["tagName"] ?? "").trim();
    if (!tagName) return fail("tagName is required");

    const body: Record<string, unknown> = { tag_name: tagName };
    if (typeof args["targetCommitish"] === "string" && String(args["targetCommitish"]).trim()) {
      body["target_commitish"] = String(args["targetCommitish"]).trim();
    }
    if (typeof args["name"] === "string" && String(args["name"]).trim()) body["name"] = String(args["name"]).trim();
    if (typeof args["body"] === "string") body["body"] = String(args["body"]);
    if (args["draft"] === true) body["draft"] = true;
    if (args["prerelease"] === true) body["prerelease"] = true;
    if (args["generateReleaseNotes"] === true) body["generate_release_notes"] = true;

    const result = await callGithub(resolved.instance, timeoutFor(args, resolved.instance), {
      method: "POST",
      path: `repos/${ownerRepo.owner}/${ownerRepo.repo}/releases`,
      body,
    });
    if (!result.ok) return { success: false, output: result.raw ?? "", error: result.error };
    const release = result.data as { id?: number; html_url?: string; tag_name?: string };
    return {
      success: true,
      output: release.html_url ? `Release ${release.tag_name} created → ${release.html_url}` : JSON.stringify(result.data, null, 2),
      metadata: { instance: resolved.name, owner: ownerRepo.owner, repo: ownerRepo.repo, tagName, releaseId: release.id, htmlUrl: release.html_url },
    };
  },
});
