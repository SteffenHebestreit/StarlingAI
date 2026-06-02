import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// NOTE: deliberately no vi.mock of node:dns/promises or mcp/registry — mocking a core
// node module leaks across files in this repo's shared single worker (maxWorkers:1).
// fetch_image never calls getMcpConnections, and its SSRF guard tolerates DNS failure
// (caught → allowed), so the example.* hosts below resolve/NXDOMAIN fast like the
// existing web_fetch tests, which also do not mock DNS.

/** An image Response that passes the IMAGE_MIN_BYTES (256) floor and carries the PNG magic header. */
function imageResponse(contentType: string): Response {
  const b = new Uint8Array(320);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return new Response(b as unknown as BodyInit, { status: 200, headers: { "content-type": contentType } });
}

async function getFetchImage() {
  await import("../tools/web.js");
  const { getTool } = await import("../tools/registry.js");
  const tool = getTool("fetch_image");
  if (!tool) throw new Error("fetch_image is not registered");
  return tool;
}

/**
 * fetch_image downloads + verifies a real image into the workspace so deliverables
 * embed a LOCAL asset instead of a guessed/fabricated hotlink (audits 39953ed9,
 * 3b53af25: every embedded Wikimedia URL was a guessed hash and 0/N resolved).
 */
describe("fetch_image", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("downloads a direct image URL and saves it under the workspace", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sai-fetch-image-"));
    const fetchMock = vi.fn(async () => imageResponse("image/png"));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const tool = await getFetchImage();
      const result = await tool.execute(
        { url: "https://cdn.example.com/zwinger.png", outputDir: "deck/images" },
        { sessionId: "s1", workspacePath: ws },
      );
      expect(result.success).toBe(true);
      const rel = String(result.metadata?.["outputPath"] ?? "");
      expect(rel).toMatch(/deck\/images\/zwinger\.png$/);
      expect(existsSync(join(ws, rel))).toBe(true);
      expect(result.metadata?.["contentType"]).toBe("image/png");
      expect(result.metadata?.["saved"]).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("extracts og:image from a page and saves the real image (no URL guessing)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sai-fetch-image-"));
    const html = `<html><head><meta property="og:image" content="https://upload.example.org/real/Zwinger.jpg"></head><body>File page</body></html>`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes("/wiki/File:")) return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      if (u.includes("upload.example.org")) return imageResponse("image/jpeg");
      return new Response("nope", { status: 404, headers: { "content-type": "text/html" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const tool = await getFetchImage();
      const result = await tool.execute(
        { url: "https://commons.example.org/wiki/File:Zwinger.jpg", outputDir: "deck/images" },
        { sessionId: "s1", workspacePath: ws },
      );
      expect(result.success).toBe(true);
      expect(result.metadata?.["resolvedImageUrl"]).toBe("https://upload.example.org/real/Zwinger.jpg");
      const rel = String(result.metadata?.["outputPath"] ?? "");
      expect(rel).toMatch(/\.jpg$/);
      expect(existsSync(join(ws, rel))).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("fails (saved:false) on a 404 and writes nothing", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sai-fetch-image-"));
    const fetchMock = vi.fn(async () => new Response("not found", { status: 404, headers: { "content-type": "text/html" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const tool = await getFetchImage();
      const result = await tool.execute(
        { url: "https://cdn.example.com/missing.png", outputDir: "deck/images" },
        { sessionId: "s1", workspacePath: ws },
      );
      expect(result.success).toBe(false);
      expect(result.metadata?.["saved"]).toBe(false);
      expect(result.error ?? "").toMatch(/not found|404|not an image/i);
      expect(existsSync(join(ws, "deck", "images"))).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("fails when a page exposes no embeddable image", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sai-fetch-image-"));
    const html = `<html><head><title>text only</title></head><body><p>nothing here</p></body></html>`;
    const fetchMock = vi.fn(async () => new Response(html, { status: 200, headers: { "content-type": "text/html" } }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const tool = await getFetchImage();
      const result = await tool.execute({ url: "https://example.org/page" }, { sessionId: "s1", workspacePath: ws });
      expect(result.success).toBe(false);
      expect(result.metadata?.["reason"]).toBe("no_image_on_page");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("rejects a non-http(s) URL scheme before any fetch", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sai-fetch-image-"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const tool = await getFetchImage();
      const result = await tool.execute({ url: "ftp://example.com/x.png" }, { sessionId: "s1", workspacePath: ws });
      expect(result.success).toBe(false);
      expect(result.error ?? "").toMatch(/http/i);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
