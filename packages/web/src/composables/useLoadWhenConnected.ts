/**
 * Load a page's data when the gateway can answer — not only at the moment the page opens.
 *
 * The management pages loaded once, in onMounted, and their loaders return early without a token
 * or a connection. Opened by URL before the socket was up, or signed in to while already open, a
 * page then sat on "Not signed in…" or an empty list until someone pressed Refresh.
 *
 *   useLoadWhenConnected(refresh);
 *
 * `load` runs on mount when the gateway is usable, and again each time it becomes usable.
 * "Usable" is a token AND an open connection: the REST loaders need the first, the RPC ones the
 * second, and the socket's handshake is what says a stored token is still good.
 */
import { onMounted, watch, type WatchStopHandle } from "vue";
import { useGatewayStore } from "@/stores/gateway";

export interface GatewayReadiness {
  connected: boolean;
  hasToken: boolean;
}

/** Signed in and connected: both the REST API and the socket will answer. */
export function gatewayUsable(state: GatewayReadiness): boolean {
  return state.connected && state.hasToken;
}

/**
 * Whether to load now. `previous` is the state at the last look, null at mount.
 *
 * True at mount when the gateway is usable, and after that only on the step from not usable to
 * usable. So signing in (the token appears, then the connection comes up) loads once, a
 * reconnect loads again, and a token swapped on a live connection loads nothing.
 */
export function shouldLoad(previous: GatewayReadiness | null, current: GatewayReadiness): boolean {
  if (!gatewayUsable(current)) return false;
  return previous === null || !gatewayUsable(previous);
}

/**
 * The watching itself, apart from any component so it can be tested without mounting one: looks
 * at the gateway now and whenever anything `read` uses changes, and leaves the decision to
 * `shouldLoad`. Returns the stop.
 */
export function loadOnReadiness(read: () => GatewayReadiness, load: () => void | Promise<void>): WatchStopHandle {
  let previous: GatewayReadiness | null = null;
  return watch(
    read,
    (current) => {
      const due = shouldLoad(previous, current);
      previous = current;
      // Returned, so a loader that rejects is reported the way a rejecting onMounted hook was.
      return due ? load() : undefined;
    },
    { immediate: true },
  );
}

export function useLoadWhenConnected(load: () => void | Promise<void>): void {
  const gateway = useGatewayStore();
  // From mount on, not from setup: a loader may reach for the page's own elements. A watcher
  // made in the mounted hook belongs to the component and stops with it.
  onMounted(() => {
    loadOnReadiness(() => ({ connected: gateway.connected, hasToken: Boolean(gateway.token) }), load);
  });
}
