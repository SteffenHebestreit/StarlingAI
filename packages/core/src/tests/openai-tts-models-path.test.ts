/**
 * An OpenAI-compatible TTS server keeps its model list beside its speech route, at /v1/models.
 * The status check and the voice catalog read /models, so the dashboard reported TTS offline
 * (404) while every speech request to /v1/audio/speech succeeded (2026-10-11). Both now read
 * /v1/models first and fall back to /models for a server that serves the list at the root.
 *
 * A real HTTP server on an ephemeral port stands in for the upstream; each case serves one layout.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { checkOpenAiTtsHealth, fetchOpenAiTtsModels } from "../gateway/upstream-http.js";

let server: Server | undefined;
let requested: string[] = [];

async function upstream(routes: Record<string, number>): Promise<string> {
  requested = [];
  server = createServer((req, res) => {
    requested.push(req.url ?? "");
    const status = routes[req.url ?? ""] ?? 404;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(status === 200 ? { object: "list", data: [{ id: "tts-1" }] } : { detail: "Not Found" }));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe("OpenAI-compatible TTS model list", () => {
  it("reads /v1/models, where a server with /v1/audio/speech keeps it", async () => {
    const baseUrl = await upstream({ "/v1/models": 200 });
    expect(await checkOpenAiTtsHealth({ baseUrl, timeoutMs: 2000 })).toEqual({ ok: true, status: 200 });
    const response = await fetchOpenAiTtsModels({ baseUrl, timeoutMs: 2000 });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: [{ id: "tts-1" }] });
    expect(requested).toEqual(["/v1/models", "/v1/models"]);
  });

  it("falls back to /models for a server that serves the list at the root", async () => {
    const baseUrl = await upstream({ "/models": 200 });
    expect(await checkOpenAiTtsHealth({ baseUrl, timeoutMs: 2000 })).toEqual({ ok: true, status: 200 });
    expect((await fetchOpenAiTtsModels({ baseUrl, timeoutMs: 2000 })).status).toBe(200);
    expect(requested).toEqual(["/v1/models", "/models", "/v1/models", "/models"]);
  });

  it("reports the server down when neither path answers", async () => {
    const baseUrl = await upstream({});
    const health = await checkOpenAiTtsHealth({ baseUrl, timeoutMs: 2000 });
    expect(health.ok).toBe(false);
    expect(health.status).toBe(404);
    expect((await fetchOpenAiTtsModels({ baseUrl, timeoutMs: 2000 })).status).toBe(404);
  });

  it("does not fall back past an error that is not a missing route", async () => {
    const baseUrl = await upstream({ "/v1/models": 401, "/models": 200 });
    const health = await checkOpenAiTtsHealth({ baseUrl, timeoutMs: 2000 });
    expect(health).toMatchObject({ ok: false, status: 401 });
    expect(requested).toEqual(["/v1/models"]);
  });
});
