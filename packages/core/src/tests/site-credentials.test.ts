import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("site credential resolution", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["SAI_MASTER_KEY"];
    delete process.env["SAI_CRED_STORE"];
    delete process.env["N8N_PASSWORD"];
    delete process.env["N8N_USERNAME"];
    delete process.env["N8N_KEY"];
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

  it("keeps stored usernames and passwords out of get_site_credentials output", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sites-tool-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      sites: {
        "n8n.k2o": {
          username: "info@steffen-hebestreit.com",
          password: "$N8N_PASSWORD",
          loginUrl: "http://n8n.k2o/login",
          usernameSelector: "#email",
          passwordSelector: "#password",
          submitSelector: "button[type=submit]",
          notes: "Use the workspace account",
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    process.env["N8N_PASSWORD"] = "super-secret";
    vi.resetModules();

    try {
      const [{ executeTool }, _credentialTools] = await Promise.all([
        import("../tools/registry.js"),
        import("../tools/credentials.js"),
      ]);

      const result = await executeTool(
        "get_site_credentials",
        { hostname: "n8n" },
        { sessionId: "session-credentials", workspacePath: tempDir },
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain("**Site:** n8n.k2o");
      expect(result.output).toContain("site_fill_credentials");
      expect(result.output).toContain("**Username selector:** `#email`");
      expect(result.output).not.toContain("info@steffen-hebestreit.com");
      expect(result.output).not.toContain("super-secret");
      expect(result.metadata).toMatchObject({
        hostname: "n8n.k2o",
        hasLoginUrl: true,
        hasSelectors: true,
        source: "config",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves env refs from store-backed site credentials", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sites-store-env-"));

    process.env["SAI_MASTER_KEY"] = "m".repeat(32);
    process.env["SAI_CRED_STORE"] = join(tempDir, ".starlingai", "credentials.enc");
    process.env["N8N_USERNAME"] = "admin@n8n.local";
    process.env["N8N_KEY"] = "super-secret-from-env";
    vi.resetModules();

    try {
      const sites = await import("../credentials/sites.js");

      sites.saveSiteCredential("n8n.k2o", {
        username: "$N8N_USERNAME",
        password: "$N8N_KEY",
        loginUrl: "http://n8n.k2o/signin",
      });

      expect(sites.getStoredSiteCredentialRecord("n8n.k2o")).toMatchObject({
        hostname: "n8n.k2o",
        username: "$N8N_USERNAME",
        password: "$N8N_KEY",
      });

      expect(sites.resolveSiteCredential("n8n")).toMatchObject({
        hostname: "n8n.k2o",
        username: "admin@n8n.local",
        password: "super-secret-from-env",
        loginUrl: "http://n8n.k2o/signin",
        source: "store",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});