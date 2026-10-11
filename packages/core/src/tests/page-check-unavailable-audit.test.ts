/**
 * A page never runs unconfined, so on a Node without the permission model the page check has no
 * runner and the build-quality gate is off. That used to leave only a log warning; the audit trail
 * now records it once per process (review 2026-10-12).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const logAudit = vi.fn();
vi.mock("../audit/logger.js", () => ({ logAudit }));

const realFlags = Object.getOwnPropertyDescriptor(process, "allowedNodeEnvironmentFlags")!;

afterEach(() => {
  Object.defineProperty(process, "allowedNodeEnvironmentFlags", realFlags);
  logAudit.mockClear();
  vi.resetModules();
});

describe("a page check with no confined runner", () => {
  it("returns no evidence and records the lost gate once", async () => {
    // A Node without --permission or --experimental-permission.
    Object.defineProperty(process, "allowedNodeEnvironmentFlags", { ...realFlags, get: () => new Set<string>() });
    const { runScriptsIsolated } = await import("../tools/page-check.js");
    const script = [{ src: "inline", code: "document.title = 'x';" }];
    expect(await runScriptsIsolated(script as never, new Set(), new Map())).toBeNull();
    expect(await runScriptsIsolated(script as never, new Set(), new Map())).toBeNull();
    expect(logAudit).toHaveBeenCalledTimes(1);
    expect(logAudit.mock.calls[0]?.[0]).toBe("page_check_unavailable");
    expect(logAudit.mock.calls[0]?.[2]).toMatchObject({ severity: "warn" });
  });
});
