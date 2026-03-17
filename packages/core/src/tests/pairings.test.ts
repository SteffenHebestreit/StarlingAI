import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("channel pairing persistence", () => {
  afterEach(() => {
    delete process.env["SAI_MASTER_KEY"];
    delete process.env["SAI_CRED_STORE"];
    vi.resetModules();
  });

  it("persists paired senders across module reloads", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-pairings-"));

    try {
      process.env["SAI_MASTER_KEY"] = "m".repeat(32);
      process.env["SAI_CRED_STORE"] = join(tempDir, "credentials.enc");

      vi.resetModules();
      const pairings = await import("../credentials/pairings.js");

      pairings.pairSender("slack", "U123");
      pairings.pairSender("slack", "U999");

      expect(pairings.isSenderPaired("slack", "U123")).toBe(true);
      expect(pairings.listPairedSenders("slack")).toEqual(["U123", "U999"]);

      vi.resetModules();
      const reloaded = await import("../credentials/pairings.js");
      expect(reloaded.listPairedSenders("slack")).toEqual(["U123", "U999"]);

      reloaded.unpairSender("slack", "U123");
      expect(reloaded.isSenderPaired("slack", "U123")).toBe(false);
      expect(reloaded.listPairedSenders("slack")).toEqual(["U999"]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});