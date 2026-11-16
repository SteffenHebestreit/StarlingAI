import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultGatewayWsUrl, gatewayRestBaseUrl, normalizeGatewayWsUrl } from "./gatewayUrl";

describe("gatewayRestBaseUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    // The plain cases every caller relied on.
    ["ws://localhost:8765/ws", "http://localhost:8765"],
    ["wss://gw.example/ws", "https://gw.example"],
    ["wss://gw.example:8443/ws", "https://gw.example:8443"],
    // A query string or a hash on the socket URL must not end up in front of every API path.
    ["wss://gw.example/ws?x=1", "https://gw.example"],
    ["ws://gw.example/ws?token=abc&client=web", "http://gw.example"],
    ["wss://gw.example/ws#frag", "https://gw.example"],
    ["wss://gw.example/ws?x=1#frag", "https://gw.example"],
    // Neither must a trailing slash, which left "/ws" in place before.
    ["ws://gw.example/ws/", "http://gw.example"],
    ["wss://gw.example/ws//", "https://gw.example"],
    ["wss://gw.example:8443/ws/?client=web#x", "https://gw.example:8443"],
    // A gateway behind a path prefix keeps the prefix.
    ["wss://host.example/starling/ws", "https://host.example/starling"],
    ["wss://host.example/starling/ws/?a=b", "https://host.example/starling"],
    ["wss://host.example/starling", "https://host.example/starling"],
    // Only a whole trailing "ws" segment is the socket path.
    ["ws://gw.example/wsx", "http://gw.example/wsx"],
    ["ws://gw.example/news", "http://gw.example/news"],
    // A bare origin, and an http(s) address typed in place of the socket URL.
    ["ws://gw.example", "http://gw.example"],
    ["ws://gw.example/", "http://gw.example"],
    ["http://gw.example:8765", "http://gw.example:8765"],
    ["https://gw.example/ws/", "https://gw.example"],
    ["  wss://gw.example/ws  ", "https://gw.example"],
  ])("%s -> %s", (wsUrl, rest) => {
    expect(gatewayRestBaseUrl(wsUrl)).toBe(rest);
  });

  it("answers the default for no URL, outside a page the legacy direct gateway", () => {
    expect(gatewayRestBaseUrl("")).toBe("http://localhost:8765");
    expect(gatewayRestBaseUrl(null)).toBe("http://localhost:8765");
    expect(gatewayRestBaseUrl(undefined)).toBe("http://localhost:8765");
  });

  it("follows the page for no URL and for the legacy one, like the socket the store opens", () => {
    vi.stubGlobal("window", { location: { protocol: "https:", host: "dash.example" } });
    expect(defaultGatewayWsUrl()).toBe("wss://dash.example/ws");
    expect(gatewayRestBaseUrl("")).toBe("https://dash.example");
    expect(gatewayRestBaseUrl("ws://localhost:8765/ws")).toBe("https://dash.example");
    expect(gatewayRestBaseUrl("ftp://gw.example/ws")).toBe("https://dash.example");
    expect(gatewayRestBaseUrl("wss://gw.example/ws?x=1")).toBe("https://gw.example");
  });

  it("never throws for text that is no URL, and still drops the query, hash and socket path", () => {
    expect(() => new URL("ws://exa mple/ws")).toThrow();
    expect(gatewayRestBaseUrl("ws://exa mple/ws/?x=1#y")).toBe("http://exa mple");
    expect(gatewayRestBaseUrl("wss://exa mple/ws")).toBe("https://exa mple");
  });

  it("keeps the store's socket URL normalization as it was", () => {
    expect(normalizeGatewayWsUrl("https://gw.example")).toBe("wss://gw.example/ws");
    expect(normalizeGatewayWsUrl("http://gw.example:8765/")).toBe("ws://gw.example:8765/ws");
    expect(normalizeGatewayWsUrl("wss://gw.example/ws?x=1#frag")).toBe("wss://gw.example/ws?x=1");
    expect(normalizeGatewayWsUrl("ws://localhost:8765/ws")).toBe("ws://localhost:8765/ws");
  });
});
