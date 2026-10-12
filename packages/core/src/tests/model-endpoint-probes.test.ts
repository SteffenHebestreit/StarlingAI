import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The dashboard's "model endpoints" check read every endpoint's OpenAI model list. On the live stack
 * (2026-10-12) it reported two healthy endpoints as unhealthy: the rerank server, which serves
 * /health and /rerank but no /models (HTTP 404), and the embedding model, configured under an alias
 * the model server serves but does not list. Each is now read the way it is used.
 */

const tempDirs: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env["SAI_CONFIG_PATH"];
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Reply = { status: number; json?: unknown };

/** Checks the endpoints of a config with the reranker and the embedding model as given, against `reply`. */
async function checkEndpoints(
  reranker: Record<string, unknown>,
  reply: (url: string, init?: RequestInit) => Reply,
) {
  const dir = mkdtempSync(join(tmpdir(), "sai-endpoint-probes-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "starlingai.json"), JSON.stringify({
    providers: { lmstudio: { baseUrl: "http://models.test/v1", apiKey: "key" } },
    agents: {
      defaults: {
        model: { primary: "lmstudio/qwen", embeddingModel: "lmstudio/text-embedding-qwen3-embedding-0.6b" },
      },
    },
    retrieval: { reranker: { enabled: true, apiKey: "key", ...reranker } },
  }), "utf8");
  process.env["SAI_CONFIG_PATH"] = join(dir, "starlingai.json");
  vi.resetModules();
  const requests: Array<{ url: string; body?: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    const { status, json } = reply(url, init);
    return new Response(json === undefined ? "" : JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
  }));
  const { syncModelEndpointRuntimeStatus } = await import("../runtime/model-endpoints.js");
  const endpoints = await syncModelEndpointRuntimeStatus();
  return { endpoints, requests, byRole: (role: string) => endpoints.find((endpoint) => endpoint.role === role) };
}

/** The model server lists its models by their own names, not by the alias the config uses. */
function modelServer(embeds: boolean) {
  return (url: string): Reply => {
    if (url === "http://models.test/v1/models") return { status: 200, json: { data: [{ id: "qwen" }, { id: "qwen3-embedding-0.6b" }] } };
    if (url === "http://models.test/v1/embeddings") return embeds ? { status: 200, json: { data: [{ embedding: [0.1, 0.2, 0.3] }] } } : { status: 404 };
    return { status: 404 };
  };
}

describe("a rerank server is read at its /health", () => {
  const rerankServer = (health: Reply) => (url: string): Reply =>
    url.startsWith("http://reranker:80/") ? (url === "http://reranker:80/health" ? health : { status: 404 }) : modelServer(true)(url);

  it("is healthy when it has loaded the configured model, though it lists no models", async () => {
    const { byRole } = await checkEndpoints(
      { baseUrl: "http://reranker:80", model: "Qwen/Qwen3-Reranker-0.6B" },
      rerankServer({ status: 200, json: { status: "ok", model: "Qwen/Qwen3-Reranker-0.6B", loaded: true } }),
    );
    expect(byRole("reranker")).toMatchObject({ ok: true, matchedModel: "Qwen/Qwen3-Reranker-0.6B" });
  });

  it("is unhealthy while its model is not loaded, when it serves another model, or when /health fails", async () => {
    const notLoaded = await checkEndpoints(
      { baseUrl: "http://reranker:80", model: "Qwen/Qwen3-Reranker-0.6B" },
      rerankServer({ status: 200, json: { model: "Qwen/Qwen3-Reranker-0.6B", loaded: false } }),
    );
    expect(notLoaded.byRole("reranker")).toMatchObject({ ok: false, error: "Model not loaded" });

    const otherModel = await checkEndpoints(
      { baseUrl: "http://reranker:80", model: "Qwen/Qwen3-Reranker-0.6B" },
      rerankServer({ status: 200, json: { model: "BAAI/bge-reranker-v2-m3", loaded: true } }),
    );
    expect(otherModel.byRole("reranker")?.ok).toBe(false);
    expect(otherModel.byRole("reranker")?.error).toContain("BAAI/bge-reranker-v2-m3");

    const loading = await checkEndpoints(
      { baseUrl: "http://reranker:80", model: "Qwen/Qwen3-Reranker-0.6B" },
      rerankServer({ status: 503 }),
    );
    expect(loading.byRole("reranker")).toMatchObject({ ok: false, error: "HTTP 503" });
  });

  it("is read by its model list when it has no /health, as an OpenAI-style rerank server", async () => {
    const { byRole, requests } = await checkEndpoints({ baseUrl: "http://models.test/v1", model: "qwen" }, modelServer(true));
    expect(requests.some((request) => request.url === "http://models.test/v1/health")).toBe(true);
    expect(byRole("reranker")).toMatchObject({ ok: true, matchedModel: "qwen" });

    const unlisted = await checkEndpoints({ baseUrl: "http://models.test/v1", model: "BAAI/bge-reranker-v2-m3" }, modelServer(true));
    expect(unlisted.byRole("reranker")?.ok).toBe(false);
  });

  it("is still read by its model list in \"llm\" mode, where it is an OpenAI-compatible chat model", async () => {
    const { byRole, requests } = await checkEndpoints(
      { mode: "llm", baseUrl: "http://models.test/v1", model: "lmstudio/qwen" },
      modelServer(true),
    );
    expect(byRole("reranker")).toMatchObject({ ok: true, matchedModel: "qwen" });
    expect(requests.some((request) => request.url.endsWith("/health"))).toBe(false);
  });
});

describe("an embedding model the server serves under an unlisted alias", () => {
  it("is healthy when the server embeds under the configured name, sent as the provider sends it", async () => {
    const { byRole, requests } = await checkEndpoints({ baseUrl: "http://reranker:80", enabled: false }, modelServer(true));
    expect(byRole("embeddings")).toMatchObject({ ok: true, matchedModel: "lmstudio/text-embedding-qwen3-embedding-0.6b" });
    const probe = requests.find((request) => request.url === "http://models.test/v1/embeddings");
    expect(JSON.parse(probe?.body ?? "{}")).toMatchObject({ model: "text-embedding-qwen3-embedding-0.6b" });
  });

  it("is unhealthy when the server does not embed under that name either", async () => {
    const { byRole } = await checkEndpoints({ baseUrl: "http://reranker:80", enabled: false }, modelServer(false));
    expect(byRole("embeddings")?.ok).toBe(false);
    expect(byRole("embeddings")?.error).toContain("not advertised");
  });

  it("does not probe a chat model by generating: an unlisted chat model stays unhealthy", async () => {
    const { byRole, requests } = await checkEndpoints({ baseUrl: "http://reranker:80", enabled: false }, (url) =>
      url === "http://models.test/v1/models" ? { status: 200, json: { data: [{ id: "qwen3-embedding-0.6b" }] } } : modelServer(true)(url));
    expect(byRole("orchestrator")?.ok).toBe(false);
    expect(requests.some((request) => request.url.endsWith("/chat/completions"))).toBe(false);
  });
});
