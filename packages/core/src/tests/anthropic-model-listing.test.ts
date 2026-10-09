/**
 * Live Claude model listing for the dashboard picker.
 *
 * The picker used to be fed by a hand-maintained constant, which went stale
 * silently — it still offered Sonnet 4.6 as "the default" long after Opus 5 and
 * Sonnet 5 shipped. These tests cover the replacement: ask Anthropic.
 *
 * They run the real SDK against a local server rather than mocking the client,
 * because the two things most likely to be wrong here — pagination and which
 * auth header a credential lands on — are the SDK's behaviour, not ours, and a
 * mock would assert my belief about the SDK instead of the SDK.
 */
import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  ANTHROPIC_FALLBACK_MAX_OUTPUT_TOKENS,
  ANTHROPIC_MODEL_CHOICES,
  fetchAnthropicModelChoices,
  forgetAnthropicOutputLimits,
  resolveAnthropicMaxOutputTokens,
} from "../providers/anthropic.js";

interface Capture { paths: string[]; headers: Array<http.IncomingHttpHeaders> }

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** A stand-in /v1/models that serves `pages` in order, one per request. */
async function serveModels(
  pages: Array<Record<string, unknown>>,
  opts: { status?: number } = {},
): Promise<{ baseUrl: string; capture: Capture }> {
  const capture: Capture = { paths: [], headers: [] };
  let served = 0;
  const server = http.createServer((req, res) => {
    capture.paths.push(req.url ?? "");
    capture.headers.push(req.headers);
    const body = pages[Math.min(served, pages.length - 1)];
    served += 1;
    res.writeHead(opts.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, capture };
}

function modelInfo(id: string, displayName: string, ctx: number | null, out: number | null) {
  return {
    type: "model", id, display_name: displayName,
    created_at: "2026-01-01T00:00:00Z",
    max_input_tokens: ctx, max_tokens: out, capabilities: null,
  };
}

describe("fetchAnthropicModelChoices", () => {
  it("turns the API's model records into picker choices", async () => {
    const { baseUrl } = await serveModels([{
      data: [modelInfo("claude-opus-5", "Claude Opus 5", 1_000_000, 128_000)],
      has_more: false, first_id: "claude-opus-5", last_id: "claude-opus-5",
    }]);

    const choices = await fetchAnthropicModelChoices({ credential: "sk-ant-api03-key", baseUrl });

    expect(choices).toEqual([
      {
        id: "claude-opus-5",
        label: "Claude Opus 5",
        hint: "1M context · 128K output",
        // Carried through, not just formatted into the hint and dropped: this is
        // the number that keeps a newly-listed model off the 8,192 guess.
        maxOutputTokens: 128_000,
      },
    ]);
  });

  it("keeps the API's newest-first order instead of imposing its own", async () => {
    const { baseUrl } = await serveModels([{
      data: [
        modelInfo("claude-opus-5", "Claude Opus 5", 1_000_000, 128_000),
        modelInfo("claude-haiku-4-5", "Claude Haiku 4.5", 200_000, 64_000),
      ],
      has_more: false, first_id: null, last_id: null,
    }]);

    const choices = await fetchAnthropicModelChoices({ credential: "sk-ant-api03-key", baseUrl });

    expect(choices.map((c) => c.id)).toEqual(["claude-opus-5", "claude-haiku-4-5"]);
  });

  it("follows pagination instead of stopping at the first page", async () => {
    // The failure this guards is silent: one page of models looks like a
    // complete catalogue, just a shorter one.
    const { baseUrl, capture } = await serveModels([
      {
        data: [modelInfo("claude-opus-5", "Claude Opus 5", 1_000_000, 128_000)],
        has_more: true, first_id: "claude-opus-5", last_id: "claude-opus-5",
      },
      {
        data: [modelInfo("claude-haiku-4-5", "Claude Haiku 4.5", 200_000, 64_000)],
        has_more: false, first_id: "claude-haiku-4-5", last_id: "claude-haiku-4-5",
      },
    ]);

    const choices = await fetchAnthropicModelChoices({ credential: "sk-ant-api03-key", baseUrl });

    expect(choices.map((c) => c.id)).toEqual(["claude-opus-5", "claude-haiku-4-5"]);
    expect(capture.paths).toHaveLength(2);
    expect(capture.paths[1]).toContain("after_id=claude-opus-5");
  });

  it("treats an empty catalogue as a failure, not as an empty picker", async () => {
    // A blank dropdown is indistinguishable from a broken one, and the caller
    // can only fall back to the built-in list if it is told something is wrong.
    const { baseUrl } = await serveModels([{ data: [], has_more: false, first_id: null, last_id: null }]);

    await expect(fetchAnthropicModelChoices({ credential: "sk-ant-api03-key", baseUrl }))
      .rejects.toThrow(/empty model list/i);
  });

  it("omits the token count it does not have rather than printing a placeholder", async () => {
    const { baseUrl } = await serveModels([{
      data: [modelInfo("claude-mystery-1", "Claude Mystery", null, 64_000)],
      has_more: false, first_id: null, last_id: null,
    }]);

    const choices = await fetchAnthropicModelChoices({ credential: "sk-ant-api03-key", baseUrl });

    expect(choices[0]!.hint).toBe("64K output");
  });

  it("sends a subscription token as a bearer, never as an API key", async () => {
    // Sending both headers is rejected by the API, so the unused slot must be
    // explicitly null — otherwise the SDK fills it from the environment.
    const { baseUrl, capture } = await serveModels([{
      data: [modelInfo("claude-opus-5", "Claude Opus 5", 1_000_000, 128_000)],
      has_more: false, first_id: null, last_id: null,
    }]);

    await fetchAnthropicModelChoices({ credential: "sk-ant-oat01-subscription", baseUrl });

    const headers = capture.headers[0]!;
    expect(headers["authorization"]).toBe("Bearer sk-ant-oat01-subscription");
    expect(headers["x-api-key"]).toBeUndefined();
    expect(String(headers["anthropic-beta"] ?? "")).toContain("oauth-2025-04-20");
  });

  it("lets an explicit oauthMode:false override the sniff — the footgun the caller must avoid", async () => {
    // Documented deliberately: an explicit false WINS, so a caller deriving the
    // flag from something narrower than "is this an oat token" (as the gateway's
    // managed-OAuth check is) must OR the sniff back in rather than pass its own
    // false through. This is the shape of the bug, kept visible.
    const { baseUrl, capture } = await serveModels([{
      data: [modelInfo("claude-opus-5", "Claude Opus 5", 1_000_000, 128_000)],
      has_more: false, first_id: null, last_id: null,
    }]);

    await fetchAnthropicModelChoices({ credential: "sk-ant-oat01-pasted", baseUrl, oauthMode: false });

    expect(capture.headers[0]!["x-api-key"]).toBe("sk-ant-oat01-pasted");
    expect(capture.headers[0]!["authorization"]).toBeUndefined();
  });

  it("sends an API key as x-api-key, with no bearer and no oauth beta", async () => {
    const { baseUrl, capture } = await serveModels([{
      data: [modelInfo("claude-opus-5", "Claude Opus 5", 1_000_000, 128_000)],
      has_more: false, first_id: null, last_id: null,
    }]);

    await fetchAnthropicModelChoices({ credential: "sk-ant-api03-key", baseUrl });

    const headers = capture.headers[0]!;
    expect(headers["x-api-key"]).toBe("sk-ant-api03-key");
    expect(headers["authorization"]).toBeUndefined();
    expect(String(headers["anthropic-beta"] ?? "")).not.toContain("oauth");
  });
});

describe("fetchAnthropicModelChoices failure paths", () => {
  it("propagates a 403 rather than quietly handing back the built-in list", async () => {
    // The documented reason the picker was static: an inference-scoped
    // subscription token may not call /v1/models at all. The caller can only
    // fall back, and label the fallback honestly, if this actually throws.
    const { baseUrl } = await serveModels(
      [{ type: "error", error: { type: "permission_error", message: "not permitted" } }],
      { status: 403 },
    );

    await expect(fetchAnthropicModelChoices({ credential: "sk-ant-oat01-scoped", baseUrl }))
      .rejects.toThrow();
  });

  it("gives up on a cursor that never advances instead of paginating forever", async () => {
    // `timeout` is per HTTP attempt, not per listing, so an upstream that keeps
    // saying has_more:true would otherwise spin inside a request nothing aborts.
    const { baseUrl, capture } = await serveModels([{
      data: [modelInfo("claude-opus-5", "Claude Opus 5", 1_000_000, 128_000)],
      has_more: true, first_id: "claude-opus-5", last_id: "claude-opus-5",
    }]);

    await expect(fetchAnthropicModelChoices({ credential: "sk-ant-api03-key", baseUrl }))
      .rejects.toThrow(/did not terminate/i);
    // Bounded, not merely "eventually stopped".
    expect(capture.paths.length).toBeLessThanOrEqual(21);
  });
});

describe("output ceilings learned from a live listing", () => {
  afterEach(() => { forgetAnthropicOutputLimits(); });

  it("prefers Anthropic's own max_tokens over the hand-maintained prefix guess", async () => {
    // The picker now offers whatever Anthropic lists, so ids with no prefix
    // entry became selectable — and their guess is 8,192, which silently
    // truncates answers. The listing already carries the real number.
    const unknownId = "claude-brandnew-9";
    expect(resolveAnthropicMaxOutputTokens(unknownId)).toBe(ANTHROPIC_FALLBACK_MAX_OUTPUT_TOKENS);

    const { baseUrl } = await serveModels([{
      data: [modelInfo(unknownId, "Claude Brand New 9", 1_000_000, 64_000)],
      has_more: false, first_id: null, last_id: null,
    }]);
    await fetchAnthropicModelChoices({ credential: "sk-ant-api03-key", baseUrl });

    expect(resolveAnthropicMaxOutputTokens(unknownId)).toBe(64_000);
  });

  it("leaves a model the listing gave no ceiling for on the prefix table", async () => {
    const { baseUrl } = await serveModels([{
      data: [modelInfo("claude-opus-5", "Claude Opus 5", 1_000_000, null)],
      has_more: false, first_id: null, last_id: null,
    }]);
    await fetchAnthropicModelChoices({ credential: "sk-ant-api03-key", baseUrl });

    // Unchanged: still the table's 128K for this prefix, not a null or a 0.
    expect(resolveAnthropicMaxOutputTokens("claude-opus-5")).toBe(128_000);
  });

  it("forgets learned ceilings when asked, so a credential change cannot leak them", async () => {
    const { baseUrl } = await serveModels([{
      data: [modelInfo("claude-brandnew-9", "Claude Brand New 9", 1_000_000, 64_000)],
      has_more: false, first_id: null, last_id: null,
    }]);
    await fetchAnthropicModelChoices({ credential: "sk-ant-api03-key", baseUrl });
    expect(resolveAnthropicMaxOutputTokens("claude-brandnew-9")).toBe(64_000);

    forgetAnthropicOutputLimits();

    expect(resolveAnthropicMaxOutputTokens("claude-brandnew-9")).toBe(ANTHROPIC_FALLBACK_MAX_OUTPUT_TOKENS);
  });
});

describe("built-in fallback list", () => {
  it("still contains the id the gateway falls back to, so the picker can resolve it", () => {
    // The route defaults providers.anthropic.defaultModel to claude-sonnet-4-6;
    // dropping it from the list would silently push the picker to "Custom".
    expect(ANTHROPIC_MODEL_CHOICES.map((c) => c.id)).toContain("claude-sonnet-4-6");
  });

  it("leads with current-generation models", () => {
    const ids = ANTHROPIC_MODEL_CHOICES.map((c) => c.id);
    expect(ids).toContain("claude-opus-5");
    expect(ids).toContain("claude-sonnet-5");
    // The staleness that prompted this work: the 4.x ids must not outrank them.
    expect(ids.indexOf("claude-opus-5")).toBeLessThan(ids.indexOf("claude-opus-4-8"));
  });
});
