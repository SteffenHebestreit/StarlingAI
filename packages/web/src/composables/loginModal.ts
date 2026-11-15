/** The connection state the shell shows its sign-in screen by (stores/gateway.ts). */
export interface LoginModalInputs {
  /** The person asked for it: "Sign in", "Switch account", the access-denied banner's button. */
  requested: boolean;
  authFailed: boolean;
  connected: boolean;
  connecting: boolean;
  reconnecting: boolean;
  /** The gateway took the sign-in, but a route policy keeps this role off the live dashboard (4403). */
  accessDenied: boolean;
}

/**
 * Whether the sign-in screen shows, and whether it can be closed.
 *
 * It comes up by itself when there is no connection and none is under way, except for an account the
 * dashboard socket refused (4403): that one keeps its sign-in, and a banner says why the live
 * dashboard is missing. It can be closed whenever there is something behind it to go back to: the
 * connected dashboard, or for a refused account the pages that work over REST. A sign-in opened from
 * the access-denied banner could not be closed before, so it covered those pages until a reload.
 */
export function loginModalState(state: LoginModalInputs): { visible: boolean; dismissible: boolean } {
  const visible = state.requested || state.authFailed
    || (!state.connected && !state.connecting && !state.reconnecting && !state.accessDenied);
  return { visible, dismissible: state.connected || state.accessDenied };
}
