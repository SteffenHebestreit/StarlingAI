import { describe, expect, it } from "vitest";
import { readAllowedRpcMethods, rpcMethodAllowed } from "./rpcAccess";

describe("rpc access", () => {
  it("reads the methods hello-ok lists for the connection", () => {
    expect(readAllowedRpcMethods({ connId: "c", sessions: [], methods: ["session.list", "session.get"] })).toEqual(["session.list", "session.get"]);
    expect(readAllowedRpcMethods({ methods: ["session.list", 7, null, "chat.send"] })).toEqual(["session.list", "chat.send"]);
    expect(readAllowedRpcMethods({ methods: [] })).toEqual([]);
  });

  it("knows nothing when the gateway lists nothing, as a gateway from before the list", () => {
    for (const data of [{ connId: "c", sessions: [] }, { methods: "chat.send" }, null, undefined, "hello"]) {
      expect(readAllowedRpcMethods(data), JSON.stringify(data)).toBeNull();
    }
  });

  it("allows only the listed methods, and every method while nothing is listed", () => {
    const viewer = readAllowedRpcMethods({ methods: ["gateway.status", "session.list", "session.get"] });
    expect(rpcMethodAllowed(viewer, "session.get")).toBe(true);
    expect(rpcMethodAllowed(viewer, "chat.send")).toBe(false);
    expect(rpcMethodAllowed(viewer, "session.create")).toBe(false);
    expect(rpcMethodAllowed([], "session.list")).toBe(false);
    expect(rpcMethodAllowed(null, "chat.send")).toBe(true);
  });
});
