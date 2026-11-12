import { describe, expect, it, vi } from "vitest";
import { createRenderer, defineComponent, nextTick, onMounted, reactive } from "vue";
import { useGatewayStore } from "@/stores/gateway";
import { gatewayUsable, loadOnReadiness, shouldLoad, useLoadWhenConnected, type GatewayReadiness } from "./useLoadWhenConnected";

// The composable reads two fields of the gateway store. A stand-in with just those keeps the
// real store, and everything it pulls in, out of this test.
vi.mock("@/stores/gateway", async () => {
  const vue = await import("vue");
  const gateway = vue.reactive({ connected: false, token: "" });
  return { useGatewayStore: () => gateway };
});

const state = (connected: boolean, hasToken: boolean): GatewayReadiness => ({ connected, hasToken });
const DOWN = state(false, false);
const TOKEN_ONLY = state(false, true);
const SOCKET_ONLY = state(true, false);
const UP = state(true, true);

describe("when a page loads its data", () => {
  it("needs both a token and a connection", () => {
    expect(gatewayUsable(UP)).toBe(true);
    expect(gatewayUsable(TOKEN_ONLY)).toBe(false);
    expect(gatewayUsable(SOCKET_ONLY)).toBe(false);
    expect(gatewayUsable(DOWN)).toBe(false);
  });

  it("loads on mount only when the gateway is usable", () => {
    expect(shouldLoad(null, UP)).toBe(true);
    expect(shouldLoad(null, TOKEN_ONLY)).toBe(false);
    expect(shouldLoad(null, SOCKET_ONLY)).toBe(false);
    expect(shouldLoad(null, DOWN)).toBe(false);
  });

  it("loads when the connection comes up, and when a token appears on a live one", () => {
    expect(shouldLoad(TOKEN_ONLY, UP)).toBe(true);
    expect(shouldLoad(SOCKET_ONLY, UP)).toBe(true);
    expect(shouldLoad(DOWN, UP)).toBe(true);
  });

  it("loads once for a sign-in: not for the token alone, then for the connection", () => {
    expect(shouldLoad(DOWN, TOKEN_ONLY)).toBe(false);
    expect(shouldLoad(TOKEN_ONLY, UP)).toBe(true);
    expect(shouldLoad(UP, UP)).toBe(false);
  });

  it("does not load when the gateway goes away or stays away", () => {
    expect(shouldLoad(UP, TOKEN_ONLY)).toBe(false);
    expect(shouldLoad(UP, DOWN)).toBe(false);
    expect(shouldLoad(DOWN, DOWN)).toBe(false);
    expect(shouldLoad(TOKEN_ONLY, SOCKET_ONLY)).toBe(false);
  });
});

describe("watching the gateway", () => {
  function watched(connected: boolean, token: string) {
    const gateway = reactive({ connected, token });
    const load = vi.fn();
    const stop = loadOnReadiness(() => ({ connected: gateway.connected, hasToken: Boolean(gateway.token) }), load);
    return { gateway, load, stop };
  }

  it("loads at once when the gateway is already usable", () => {
    const { load, stop } = watched(true, "t");
    expect(load).toHaveBeenCalledTimes(1);
    stop();
  });

  it("waits for a page opened before the connection, then loads once", async () => {
    const { gateway, load, stop } = watched(false, "t");
    expect(load).not.toHaveBeenCalled();
    gateway.connected = true;
    await nextTick();
    expect(load).toHaveBeenCalledTimes(1);
    stop();
  });

  it("loads once for a sign-in, whether its two steps come together or apart", async () => {
    const together = watched(false, "");
    together.gateway.token = "t";
    together.gateway.connected = true;
    await nextTick();
    expect(together.load).toHaveBeenCalledTimes(1);
    together.stop();

    const apart = watched(false, "");
    apart.gateway.token = "t";
    await nextTick();
    expect(apart.load).not.toHaveBeenCalled();
    apart.gateway.connected = true;
    await nextTick();
    expect(apart.load).toHaveBeenCalledTimes(1);
    apart.stop();
  });

  it("loads again after a reconnect, and not for a token swapped on a live connection", async () => {
    const { gateway, load, stop } = watched(true, "t");
    gateway.token = "rotated";
    await nextTick();
    expect(load).toHaveBeenCalledTimes(1);
    gateway.connected = false;
    await nextTick();
    expect(load).toHaveBeenCalledTimes(1);
    gateway.connected = true;
    await nextTick();
    expect(load).toHaveBeenCalledTimes(2);
    stop();
  });

  it("loads again when a rejected sign-in (connection and token gone) is followed by a new one", async () => {
    const { gateway, load, stop } = watched(true, "stale");
    gateway.connected = false;
    gateway.token = "";
    await nextTick();
    gateway.token = "fresh";
    gateway.connected = true;
    await nextTick();
    expect(load).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stops loading once stopped", async () => {
    const { gateway, load, stop } = watched(false, "t");
    stop();
    gateway.connected = true;
    await nextTick();
    expect(load).not.toHaveBeenCalled();
  });
});

describe("useLoadWhenConnected in a mounted page", () => {
  // A renderer that draws nothing: enough to run a component's mount and unmount without a DOM.
  const { createApp } = createRenderer<object, object>({
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    insert: () => {},
    remove: () => {},
    setText: () => {},
    setElementText: () => {},
    parentNode: () => null,
    nextSibling: () => null,
    patchProp: () => {},
  });
  const gateway = useGatewayStore() as unknown as { connected: boolean; token: string };

  /** `load` is told whether the page was mounted when it ran. */
  function mountPage(load: (mounted: boolean) => void) {
    const app = createApp(defineComponent({
      setup() {
        let mounted = false;
        onMounted(() => { mounted = true; });
        useLoadWhenConnected(() => load(mounted));
        return () => null;
      },
    }));
    app.mount({});
    return app;
  }

  it("loads on mount (not before) when usable, again after a reconnect, and never after the page is gone", async () => {
    gateway.connected = true;
    gateway.token = "t";
    const load = vi.fn();
    const app = mountPage(load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenLastCalledWith(true);

    gateway.connected = false;
    await nextTick();
    gateway.connected = true;
    await nextTick();
    expect(load).toHaveBeenCalledTimes(2);

    app.unmount();
    gateway.connected = false;
    await nextTick();
    gateway.connected = true;
    await nextTick();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("loads a page that was opened signed out once the sign-in connects", async () => {
    gateway.connected = false;
    gateway.token = "";
    const load = vi.fn();
    const app = mountPage(load);
    expect(load).not.toHaveBeenCalled();

    gateway.token = "t";
    await nextTick();
    expect(load).not.toHaveBeenCalled();
    gateway.connected = true;
    await nextTick();
    expect(load).toHaveBeenCalledTimes(1);
    app.unmount();
  });
});
