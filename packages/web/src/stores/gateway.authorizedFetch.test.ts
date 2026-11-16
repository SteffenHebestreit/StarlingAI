import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { responseErrorMessage } from "@/composables/httpErrors";
import { GatewayHttpError, useGatewayStore } from "./gateway";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const text = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "text/plain" } });

describe("gateway.authorizedFetch", () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let next: () => Response;

  beforeEach(() => {
    setActivePinia(createPinia());
    calls.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return next();
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    [401, () => json(401, { error: "Unauthorized" })],
    [403, () => json(403, { error: "operator role required" })],
    [404, () => text(404, "Not Found")],
    [500, () => json(500, {})],
    [503, () => new Response("", { status: 503 })],
  ])("throws a GatewayHttpError that carries the status %i, with the message it always had", async (status, response) => {
    const gateway = useGatewayStore();
    next = response;
    const error = await gateway.authorizedFetch("/api/anything").then(() => null, (err: unknown) => err);

    expect(error).toBeInstanceOf(GatewayHttpError);
    expect(error).toBeInstanceOf(Error);
    expect((error as GatewayHttpError).status).toBe(status);
    expect((error as GatewayHttpError).name).toBe("GatewayHttpError");
    // The message is still exactly what responseErrorMessage says for that answer.
    expect((error as GatewayHttpError).message).toBe(await responseErrorMessage(response()));
  });

  it("hands the parsed JSON body along", async () => {
    const gateway = useGatewayStore();
    next = () => json(409, { error: "already exists", id: "kb-1" });
    const error = await gateway.authorizedFetch("/api/knowledge-bases", { method: "POST" }).then(() => null, (err: unknown) => err);
    expect(error).toMatchObject({ status: 409, message: "already exists", body: { error: "already exists", id: "kb-1" } });
  });

  it("returns a good answer untouched, and sends the token to the REST base of the socket URL", async () => {
    const gateway = useGatewayStore();
    gateway.token = "t0k";
    gateway.wsUrl = "wss://gw.example:8443/ws/?client=web#x";
    next = () => json(200, { ok: true });
    const response = await gateway.authorizedFetch("/api/health/subsystems");
    expect(await response.json()).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("https://gw.example:8443/api/health/subsystems");
    expect(new Headers(calls[0]?.init?.headers).get("Authorization")).toBe("Bearer t0k");
    expect(gateway.restBaseUrl()).toBe("https://gw.example:8443");
  });
});
