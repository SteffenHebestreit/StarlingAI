import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

describe("http_request tool", () => {
  beforeAll(async () => {
    await import("../tools/http-request.js");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends POST requests with auto JSON content-type and returns response metadata", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => new Response('{"ok":true}', {
      status: 201,
      statusText: "Created",
      headers: {
        "Content-Type": "application/json",
        "X-Trace-Id": "trace-123",
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("http_request");

    const result = await tool!.execute({
      url: "https://api.example.com/items",
      method: "POST",
      body: '{"name":"alpha"}',
    }, {
      sessionId: "session-http-post",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("HTTP 201 Created");
    expect(result.output).toContain('{"ok":true}');
    expect(result.metadata).toMatchObject({
      status: 201,
      statusText: "Created",
      headers: expect.objectContaining({
        "content-type": "application/json",
        "x-trace-id": "trace-123",
      }),
    });
    expect(fetchMock).toHaveBeenCalledWith("https://api.example.com/items", expect.objectContaining({
      method: "POST",
      body: '{"name":"alpha"}',
      headers: expect.any(Headers),
    }));

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Headers).get("Content-Type")).toBe("application/json");
  });

  it("omits request bodies for HEAD requests and returns an empty body", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => new Response(null, {
      status: 200,
      statusText: "OK",
      headers: { "Content-Type": "text/plain" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("http_request");

    const result = await tool!.execute({
      url: "https://api.example.com/healthz",
      method: "HEAD",
      body: "should-be-ignored",
    }, {
      sessionId: "session-http-head",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("HTTP 200 OK");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBeUndefined();
  });

  it("rejects non-http URLs", async () => {
    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("http_request");

    const result = await tool!.execute({
      url: "file:///etc/passwd",
    }, {
      sessionId: "session-http-invalid",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/http:\/\/ or https:\/\//i);
  });

  it("truncates oversized response bodies", async () => {
    const largeBody = "x".repeat(70_000);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(largeBody, {
      status: 200,
      statusText: "OK",
      headers: { "Content-Type": "text/plain" },
    })));

    const { getTool } = await import("../tools/registry.js");
    const tool = getTool("http_request");

    const result = await tool!.execute({
      url: "https://example.com/large",
    }, {
      sessionId: "session-http-large",
      workspacePath: "/workspace",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("[... truncated at 64000 chars]");
  });
});