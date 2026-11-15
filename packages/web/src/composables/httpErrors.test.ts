import { describe, expect, it } from "vitest";
import { chatText } from "./chatText";
import { GatewayHttpError, responseErrorMessage } from "./httpErrors";

const NGINX_413 = "<html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n<body>\r\n<center><h1>413 Request Entity Too Large</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>";
const page = (status: number, body = NGINX_413) => new Response(body, { status, headers: { "content-type": "text/html" } });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

describe("responseErrorMessage", () => {
  it("calls an upload the proxy refused for its size too large, not a broken installation", async () => {
    for (const lang of ["en", "de"] as const) {
      const message = await responseErrorMessage(page(413), lang);
      expect(message).toBe(chatText.uploadTooLarge(lang));
      expect(message).not.toMatch(/HTML|JSON|proxy/i);
    }
  });

  it("says the same when the gateway itself refuses the size, in the reader's language", async () => {
    expect(await responseErrorMessage(json(413, { error: "Request body too large" }), "de")).toBe(chatText.uploadTooLarge("de"));
  });

  it("passes the gateway's own words on", async () => {
    expect(await responseErrorMessage(json(400, { error: "sessionId is required" }), "de")).toBe("sessionId is required");
    expect(await responseErrorMessage(json(422, { detail: "unsupported file type" }), "en")).toBe("unsupported file type");
    // The gateway's reason for a 503 is worth more than a guess about it.
    expect(await responseErrorMessage(json(503, { error: "Vision service is not configured" }), "en")).toBe("Vision service is not configured");
  });

  it("falls back to the status when the JSON says nothing usable", async () => {
    expect(await responseErrorMessage(json(500, { error: { code: 7 } }), "en")).toBe("HTTP 500");
    expect(await responseErrorMessage(json(500, {}), "en")).toBe("HTTP 500");
    expect(await responseErrorMessage(new Response("not json", { status: 500, headers: { "content-type": "application/json" } }), "en")).toBe("HTTP 500");
  });

  it("names a gateway that did not answer through the proxy", async () => {
    for (const status of [502, 503, 504]) {
      expect(await responseErrorMessage(page(status, "<html><head><title>Gateway Time-out</title></head></html>"), "en")).toBe(chatText.gatewayNoAnswer("en", status));
      expect(await responseErrorMessage(new Response("", { status }), "de")).toBe(chatText.gatewayNoAnswer("de", status));
    }
    expect(chatText.gatewayNoAnswer("de", 504)).toContain("504");
  });

  it("names a web page where data was expected, with its status", async () => {
    const message = await responseErrorMessage(page(404, "<!DOCTYPE html><html><body>app</body></html>"), "en");
    expect(message).toBe(chatText.serverSentPage("en", 404));
    expect(message).toContain("404");
    expect(await responseErrorMessage(page(404, "<!doctype html><title>x</title>"), "de")).toBe(chatText.serverSentPage("de", 404));
  });

  it("passes plain text on, cut to a line or two", async () => {
    expect(await responseErrorMessage(new Response("upstream said no", { status: 400 }), "en")).toBe("upstream said no");
    expect((await responseErrorMessage(new Response("x".repeat(900), { status: 400 }), "en")).length).toBe(240);
    expect(await responseErrorMessage(new Response("", { status: 418 }), "en")).toBe("HTTP 418");
  });
});

describe("GatewayHttpError.fromResponse", () => {
  it.each([
    [401, () => json(401, { error: "Unauthorized" })],
    [403, () => json(403, { detail: "operator role required" })],
    [404, () => page(404, "<!DOCTYPE html><html><body>app</body></html>")],
    [413, () => page(413)],
    [500, () => new Response("boom", { status: 500 })],
    [503, () => new Response("", { status: 503 })],
  ])("carries the status %i and the message responseErrorMessage gives", async (status, response) => {
    for (const lang of ["en", "de"] as const) {
      const error = await GatewayHttpError.fromResponse(response(), lang);
      expect(error).toBeInstanceOf(GatewayHttpError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("GatewayHttpError");
      expect(error.status).toBe(status);
      expect(error.message).toBe(await responseErrorMessage(response(), lang));
    }
  });

  it("hands the parsed JSON body along, and nothing for an answer that is not JSON", async () => {
    expect((await GatewayHttpError.fromResponse(json(409, { error: "exists", id: "kb-1" }), "en")).body).toEqual({ error: "exists", id: "kb-1" });
    // The 413 message does not read the body; the body is still there.
    expect((await GatewayHttpError.fromResponse(json(413, { error: "Request body too large", limit: 10 }), "en")).body).toEqual({ error: "Request body too large", limit: 10 });
    expect((await GatewayHttpError.fromResponse(page(502, "<html></html>"), "en")).body).toBeUndefined();
    expect((await GatewayHttpError.fromResponse(new Response("not json", { status: 500, headers: { "content-type": "application/json" } }), "en")).body).toBeUndefined();
  });

  it("still gives the message for an answer whose body was already read", async () => {
    const response = new Response("gone", { status: 410 });
    await response.text();
    const error = await GatewayHttpError.fromResponse(response, "en");
    expect(error.status).toBe(410);
    expect(error.body).toBeUndefined();
  });
});
