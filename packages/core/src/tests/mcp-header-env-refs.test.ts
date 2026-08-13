import { afterEach, describe, expect, it } from "vitest";
import { resolveMcpHeaderEnvRefs } from "../mcp/client.js";

/**
 * MCP headers were the one secret-bearing config in the codebase that did not resolve
 * `$VAR`, while A2A tokens, provider keys, OIDC secrets and approval-webhook secrets
 * all do. A shard written the documented way was sent to the remote server literally,
 * so the failure arrived as a 401 from the far end and read as a wrong credential —
 * which is the most expensive way to be told a variable is unset.
 */

const ORIGINAL = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL);
});

describe("resolveMcpHeaderEnvRefs", () => {
  it("expands a reference embedded in a header value", () => {
    process.env["PM_TEST_KEY"] = "pmk_abc123";
    expect(
      resolveMcpHeaderEnvRefs({ Authorization: "Bearer $PM_TEST_KEY" }, "processmem"),
    ).toEqual({ Authorization: "Bearer pmk_abc123" });
  });

  it("expands the braced form too", () => {
    process.env["PM_TEST_KEY"] = "pmk_abc123";
    expect(
      resolveMcpHeaderEnvRefs({ Authorization: "Bearer ${PM_TEST_KEY}" }, "processmem"),
    ).toEqual({ Authorization: "Bearer pmk_abc123" });
  });

  it("expands several references across several headers", () => {
    process.env["PM_A"] = "one";
    process.env["PM_B"] = "two";
    expect(
      resolveMcpHeaderEnvRefs({ First: "$PM_A/$PM_B", Second: "x-$PM_B" }, "s"),
    ).toEqual({ First: "one/two", Second: "x-two" });
  });

  it("throws on an unset variable rather than sending a blank credential", () => {
    delete process.env["PM_MISSING"];
    expect(() => resolveMcpHeaderEnvRefs({ Authorization: "Bearer $PM_MISSING" }, "processmem"))
      .toThrow(/processmem.*\$PM_MISSING/s);
  });

  it("treats an empty variable as unset — a blank token is not a credential", () => {
    process.env["PM_EMPTY"] = "";
    expect(() => resolveMcpHeaderEnvRefs({ Authorization: "Bearer $PM_EMPTY" }, "s"))
      .toThrow(/\$PM_EMPTY/);
  });

  it("names every missing variable at once, not just the first", () => {
    delete process.env["PM_ONE"];
    delete process.env["PM_TWO"];
    expect(() => resolveMcpHeaderEnvRefs({ A: "$PM_ONE", B: "$PM_TWO" }, "s"))
      .toThrow(/\$PM_ONE, \$PM_TWO/);
  });

  it("leaves headers without references untouched", () => {
    expect(resolveMcpHeaderEnvRefs({ "X-Trace": "plain-value" }, "s"))
      .toEqual({ "X-Trace": "plain-value" });
  });

  it("does not treat a lone dollar or a price as a reference", () => {
    expect(resolveMcpHeaderEnvRefs({ A: "costs $ and $9.99", B: "100%" }, "s"))
      .toEqual({ A: "costs $ and $9.99", B: "100%" });
  });

  it("returns undefined when there are no headers, so the transport stays unconfigured", () => {
    expect(resolveMcpHeaderEnvRefs(undefined, "s")).toBeUndefined();
  });
});
