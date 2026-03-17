import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("site credential resolution", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["N8N_PASSWORD"];
    vi.resetModules();

    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  it("resolves short host aliases against configured site credentials", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sites-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      sites: {
        "n8n.k2o": {
          username: "info@steffen-hebestreit.com",
          password: "$N8N_PASSWORD",
          loginUrl: "http://n8n.k2o/",
          urls: {
            "analyzed-project-table": "http://n8n.k2o/projects/table",
          },
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    process.env["N8N_PASSWORD"] = "super-secret";
    vi.resetModules();

    try {
      const sites = await import("../credentials/sites.js");
      const resolved = sites.resolveSiteCredential("n8n");

      expect(resolved).toMatchObject({
        hostname: "n8n.k2o",
        username: "info@steffen-hebestreit.com",
        password: "super-secret",
        loginUrl: "http://n8n.k2o/",
        source: "config",
      });
      expect(resolved?.urls?.["analyzed-project-table"]).toBe("http://n8n.k2o/projects/table");
      expect(sites.hasConfigSiteCredential("n8n")).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});