import { describe, expect, it } from "vitest";
import { socketCloseOutcome } from "./socketClose";

describe("socketCloseOutcome", () => {
  it("stops reconnecting and forgets the token when the sign-in is refused", () => {
    expect(socketCloseOutcome(4401)).toBe("auth-failed");
    expect(socketCloseOutcome(4429)).toBe("auth-failed");
  });

  it("stops reconnecting but keeps the token when the account's role may not use the dashboard", () => {
    // A route policy's refusal of /ws. Reconnecting would only be refused again, forever.
    expect(socketCloseOutcome(4403)).toBe("access-denied");
  });

  it("reconnects after any other close", () => {
    for (const code of [1000, 1001, 1006, 1011, 4000, 4404]) expect(socketCloseOutcome(code)).toBe("reconnect");
  });
});
