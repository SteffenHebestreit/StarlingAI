import { describe, expect, it } from "vitest";
import { forbiddenReason, rpcErrorText } from "./rpcErrors";

describe("rpc errors", () => {
  it("reads the gateway's refusal for the caller's role, with or without the Error: prefix", () => {
    expect(forbiddenReason("Forbidden: chat.send requires role operator")).toBe("chat.send requires role operator");
    expect(forbiddenReason("Error: Forbidden: session.create requires role operator")).toBe("session.create requires role operator");
    expect(forbiddenReason("Forbidden: session.list is not available to role kiosk")).toBe("session.list is not available to role kiosk");
  });

  it("leaves every other error alone", () => {
    for (const message of ["RPC timeout", "Not connected", "Error: Session not found: abc", "Error: Invalid channel", "Unknown method: x", "Something Forbidden: here"]) {
      expect(forbiddenReason(message), message).toBeNull();
      expect(rpcErrorText(message, "en"), message).toBe(message);
    }
  });

  it("words a refusal as an access message, in both languages", () => {
    expect(rpcErrorText("Forbidden: chat.send requires role operator", "en")).toBe("No access — chat.send requires role operator");
    expect(rpcErrorText("Forbidden: chat.send requires role operator", "de")).toBe("Kein Zugriff — chat.send requires role operator");
  });
});
