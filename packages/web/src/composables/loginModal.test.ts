import { describe, expect, it } from "vitest";
import { loginModalState, type LoginModalInputs } from "./loginModal";

const signedOut: LoginModalInputs = {
  requested: false,
  authFailed: false,
  connected: false,
  connecting: false,
  reconnecting: false,
  accessDenied: false,
};

describe("loginModalState", () => {
  it("shows the sign-in when signed out, and it cannot be closed: there is nothing behind it", () => {
    expect(loginModalState(signedOut)).toEqual({ visible: true, dismissible: false });
    expect(loginModalState({ ...signedOut, authFailed: true })).toEqual({ visible: true, dismissible: false });
  });

  it("stays away while connecting or reconnecting, and while connected unless asked for", () => {
    expect(loginModalState({ ...signedOut, connecting: true }).visible).toBe(false);
    expect(loginModalState({ ...signedOut, reconnecting: true }).visible).toBe(false);
    expect(loginModalState({ ...signedOut, connected: true }).visible).toBe(false);
    expect(loginModalState({ ...signedOut, connected: true, requested: true })).toEqual({ visible: true, dismissible: true });
  });

  it("leaves an account the dashboard socket refused (4403) on its banner, and lets it close a sign-in it opened", () => {
    const denied = { ...signedOut, accessDenied: true };
    expect(loginModalState(denied).visible).toBe(false);
    // "Sign in with another account": closing it goes back to the pages that work over REST.
    expect(loginModalState({ ...denied, requested: true })).toEqual({ visible: true, dismissible: true });
  });
});
