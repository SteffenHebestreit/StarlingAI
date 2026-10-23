import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "../tools/registry.js";
import { checkFieldValue, resetBrowserFormGateForTests, valueIsUsers } from "../tools/browser-form-gate.js";

/**
 * E2E 2026-10-22 (core-ix-browser-order-form-quantity-refused): the browser agent typed the 1200
 * the user asked for, the form refused it ("Menge (1–999)"), and it typed 999 into the same field
 * and submitted again, reporting the reference the page then gave.
 */
const ORDER = { opening: "Fülle das Bestellformular aus: Artikel NW-1101, Menge 1200, Versandart Express, sonst Standard.", midTurn: [] };

describe("a value the user chose stays in its field", () => {
  afterEach(() => resetBrowserFormGateForTests());
  const enter = (value: string, field = { ref: "e31", element: "Menge-Feld (Spinbutton)" }, runId = "sub:s1:browser_agent:1") =>
    checkFieldValue({ runId, ...field, value, userWords: ORDER });

  it("refuses a value of the agent's own in a field holding the user's", () => {
    expect(enter("1200")).toBeNull();
    expect(enter("999")).toMatch(/^Not entered: Menge-Feld \(Spinbutton\) holds "1200", the value the user gave, and "999" is not one the user gave\./);
  });

  it("finds the field by its label when the page gave it a new ref", () => {
    expect(enter("1200")).toBeNull();
    expect(enter("999", { ref: "e77", element: "menge-feld  (spinbutton)" })).toMatch(/^Not entered/);
  });

  it("lets the same value through in another format, and an alternative the user named", () => {
    expect(enter("1200")).toBeNull();
    expect(enter("1.200")).toBeNull();
    const shipping = { ref: "e33", element: "Versandart" };
    expect(enter("Express", shipping)).toBeNull();
    expect(enter("Standard", shipping)).toBeNull();
  });

  it("lets the agent correct a value of its own, and keeps runs apart", () => {
    expect(enter("12000")).toBeNull();
    expect(enter("1200")).toBeNull();
    expect(enter("1200", undefined, "sub:s2:browser_agent:2")).toBeNull();
    expect(enter("999", undefined, "sub:s3:browser_agent:3")).toBeNull();
  });

  it("refuses nothing on a turn no person opened", () => {
    expect(checkFieldValue({ runId: "r", ref: "e31", value: "1200", userWords: undefined })).toBeNull();
    expect(checkFieldValue({ runId: "r", ref: "e31", value: "999", userWords: undefined })).toBeNull();
  });

  it.each([
    ["1200", true], ["1 200", true], ["1,200", true], ["999", false],
    ["NW-1101", true], ["nw-1101", true], ["Express", true], ["Overnight", false],
  ])("reads %s as the user's: %s", (value, expected) => {
    expect(valueIsUsers(value, ORDER)).toBe(expected);
  });
});

describe("browser_type and browser_select_option", () => {
  afterEach(() => resetBrowserFormGateForTests());

  it("are refused before the browser is called", async () => {
    const { getTool } = await import("../tools/registry.js");
    await import("../tools/multimodal.js");
    const ctx = { sessionId: "sub:s9:browser_agent:9", workspacePath: "/w", turnUserWords: ORDER } as ToolContext;

    // No browser is connected here: the user's value passes the gate and fails at the browser.
    const first = await getTool("browser_type")!.execute({ ref: "e31", element: "Menge", text: "1200" }, ctx);
    expect(first.error).not.toMatch(/^Not entered/);
    const second = await getTool("browser_type")!.execute({ ref: "e31", element: "Menge", text: "999" }, ctx);
    expect(second.success).toBe(false);
    expect(second.error).toMatch(/^Not entered: Menge holds "1200"/);

    await getTool("browser_select_option")!.execute({ ref: "e33", element: "Versandart", values: ["express"] }, ctx);
    const overnight = await getTool("browser_select_option")!.execute({ ref: "e33", element: "Versandart", values: ["overnight"] }, ctx);
    expect(overnight.error).toMatch(/^Not entered: Versandart holds "express"/);
  });
});
