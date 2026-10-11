/**
 * ONE TTS VOICE CATALOG for the dashboard's voice route and the list_tts_voices tool (review
 * 2026-10-11).
 *
 * The route learned to read an OpenAI-compatible server's model list at /v1/models, beside its
 * /v1/audio/speech, but the tool kept its own copy of the catalog, which still read /models: on such
 * a server the tool failed ("Failed to load TTS models") while the dashboard listed the backend.
 * Both now use multimodal/tts-voice-catalog.ts.
 *
 * A real HTTP server on an ephemeral port stands in for the upstream; each test sets its routes.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../mcp/registry.js", () => ({
  getMcpConnections: () => new Map(),
}));

type Route = { status: number; body: unknown };
let routes: Record<string, Route> = {};
let requested: string[] = [];
let server: Server;
let baseUrl = "";
let tempDir = "";
let savedConfigPath: string | undefined;

/** An OpenAI-compatible speech server: the model list at /v1/models, in OpenAI's list shape. */
const OPENAI_SPEECH_SERVER: Record<string, Route> = {
  "/v1/models": { status: 200, body: { object: "list", data: [{ id: "tts-1", object: "model" }, { id: "kokoro", object: "model" }] } },
};

beforeAll(async () => {
  server = createServer((req, res) => {
    requested.push(req.url ?? "");
    const route = routes[req.url ?? ""] ?? { status: 404, body: { detail: "Not Found" } };
    res.writeHead(route.status, { "content-type": "application/json" });
    res.end(JSON.stringify(route.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  tempDir = mkdtempSync(join(tmpdir(), "sai-tts-catalog-"));
  const configPath = join(tempDir, "starlingai.json");
  writeFileSync(configPath, JSON.stringify({
    workspacePath: tempDir,
    multimodal: { tts: { baseUrl, api: "openai-compatible", timeoutMs: 2000 } },
  }), "utf8");
  savedConfigPath = process.env["SAI_CONFIG_PATH"];
  process.env["SAI_CONFIG_PATH"] = configPath;
  (await import("../config/loader.js")).resetConfigForTests();
  await import("../tools/multimodal.js");
});

afterAll(async () => {
  if (savedConfigPath === undefined) delete process.env["SAI_CONFIG_PATH"];
  else process.env["SAI_CONFIG_PATH"] = savedConfigPath;
  (await import("../config/loader.js")).resetConfigForTests();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(() => {
  routes = {};
  requested = [];
});

describe("list_tts_voices on an OpenAI-compatible speech server", () => {
  it("reads the model list at /v1/models, as the dashboard's route does", async () => {
    routes = OPENAI_SPEECH_SERVER;
    const { getTool } = await import("../tools/registry.js");
    const result = await getTool("list_tts_voices")!.execute({}, { sessionId: "s-tts-catalog", workspacePath: tempDir });
    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(requested).toContain("/v1/models");
    expect(requested).not.toContain("/models");
  });
});
