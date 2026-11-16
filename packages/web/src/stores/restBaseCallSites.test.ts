import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useAuthStore } from "./auth";
import { useGatewayStore } from "./gateway";
import { useJobsStore } from "./jobs";
import { useProductStore } from "./product";

/**
 * Stores that build their own `/api/...` URLs from the socket URL, rather than going through
 * gateway.authorizedFetch. With a query string, a hash or a trailing slash on the socket URL they
 * used to send `https://gw.example/ws?x=1/api/...` while chat (authorizedFetch) kept working.
 */
describe("stores that call the REST API directly", () => {
  const urls: string[] = [];

  beforeEach(() => {
    setActivePinia(createPinia());
    urls.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(url);
      const body = url.endsWith("/api/jobs") ? [] : url.endsWith("/api/auth/me") ? { username: "op", role: "operator" } : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["wss://gw.example/ws?x=1", "https://gw.example"],
    ["ws://gw.example:8765/ws/", "http://gw.example:8765"],
    ["wss://gw.example/ws#frag", "https://gw.example"],
    ["wss://gw.example/starling/ws/?client=web", "https://gw.example/starling"],
  ])("send requests for socket URL %s to %s/api/...", async (wsUrl, base) => {
    const gateway = useGatewayStore();
    gateway.wsUrl = wsUrl;
    gateway.token = "t0k";

    await useProductStore().load();
    await useAuthStore().refreshCurrentUser();
    await useJobsStore().fetch();

    expect(urls).toEqual([`${base}/api/product`, `${base}/api/auth/me`, `${base}/api/jobs`]);
    expect(useAuthStore().currentUser).toEqual({ username: "op", role: "operator" });
  });
});
