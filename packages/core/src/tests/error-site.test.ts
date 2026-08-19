/**
 * A MESSAGE WITHOUT A LOCATION IS A SEARCH TASK.
 *
 * verify_page reported `ReferenceError: state is not defined` about a 16,000-character file
 * and nothing else. The only way to act on that is to read the whole artifact hunting for it
 * — which is exactly the reading-without-writing stall the supervisor then has to interrupt.
 * Every ingredient for a precise answer was in the thrown error and discarded one line later.
 */
import { describe, expect, it } from "vitest";
import { createContext, runInContext } from "node:vm";
import { describeErrorSite, SCRIPT_VM_FILENAME } from "../tools/error-site.js";

describe("an error reports where it happened", () => {
  it("quotes V8's own line and caret for a fault in the script", () => {
    let captured: unknown;
    try {
      runInContext("const a = 1;\nconst b = 2;\nboom.x = 3;\n", createContext({}), {
        filename: SCRIPT_VM_FILENAME,
        displayErrors: true,
      });
    } catch (err) {
      captured = err;
    }
    const site = describeErrorSite(captured, "const a = 1;\nconst b = 2;\nboom.x = 3;\n");
    expect(site).toContain(`${SCRIPT_VM_FILENAME}:3`);
    expect(site).toContain("boom.x = 3;");
    expect(site).toContain("^");
  });

  it("works on errors thrown INSIDE the vm, which are not instanceof the host Error", () => {
    // THE BUG THIS EXISTS TO PREVENT. An error thrown inside a vm context is built by that
    // realm's Error, whose prototype chain has nothing to do with the host's, so
    // `err instanceof Error` is false for precisely the errors this describes. The first
    // implementation guarded on instanceof, rejected every real vm error at line one, and
    // passed its own isolated test because that test constructed a host-realm Error.
    let captured: unknown;
    try {
      runInContext("undefinedThing.call();", createContext({}), {
        filename: SCRIPT_VM_FILENAME,
        displayErrors: true,
      });
    } catch (err) {
      captured = err;
    }
    expect(captured instanceof Error, "a vm error is NOT a host Error").toBe(false);
    expect(describeErrorSite(captured, "undefinedThing.call();")).not.toBe("");
  });

  it("returns nothing for a value carrying no stack, rather than inventing a location", () => {
    expect(describeErrorSite("just a string", "src")).toBe("");
    expect(describeErrorSite(null, "src")).toBe("");
    expect(describeErrorSite({ message: "no stack here" }, "src")).toBe("");
  });

  it("truncates a long source line instead of flooding the report", () => {
    const err = new Error("x");
    err.stack = `something\n    at ${SCRIPT_VM_FILENAME}:1:1\n`;
    const site = describeErrorSite(err, "x".repeat(500));
    expect(site).toContain("…");
    expect(site.length).toBeLessThan(400);
  });
});
