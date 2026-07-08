import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PRODUCT } from "../product/index.js";

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
        "app.example.com": {
          username: "user@example.com",
          password: "$N8N_PASSWORD",
          loginUrl: "http://app.example.com/",
          urls: {
            "analyzed-project-table": "http://app.example.com/projects/table",
          },
        },
      },
    }), "utf8");

    process.env["SAI_CONFIG_PATH"] = configPath;
    process.env["N8N_PASSWORD"] = "super-secret";
    vi.resetModules();

    try {
      const sites = await import("../credentials/sites.js");
      const resolved = sites.resolveSiteCredential("app");

      expect(resolved).toMatchObject({
        hostname: "app.example.com",
        username: "user@example.com",
        password: "super-secret",
        loginUrl: "http://app.example.com/",
        source: "config",
      });
      expect(resolved?.urls?.["analyzed-project-table"]).toBe("http://app.example.com/projects/table");
      expect(sites.hasConfigSiteCredential("app")).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps stored usernames and passwords out of get_site_credentials output", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sites-tool-"));
    const configPath = join(tempDir, "starlingai.json");

    writeFileSync(configPath, JSON.stringify({
      sites: {
        "app.example.com": {
          username: "user@example.com",
          password: "$N8N_PASSWORD",
          loginUrl: "http://app.example.com/login",
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
        { hostname: "app" },
        { sessionId: "session-credentials", workspacePath: tempDir },
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain("**Site:** app.example.com");
      expect(result.output).toContain("site_fill_credentials");
      expect(result.output).toContain("**Username selector:** `#email`");
      expect(result.output).not.toContain("user@example.com");
      expect(result.output).not.toContain("super-secret");
      expect(result.metadata).toMatchObject({
        hostname: "app.example.com",
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
    process.env["SAI_CRED_STORE"] = join(tempDir, PRODUCT.stateDirName, "credentials.enc");
    process.env["N8N_USERNAME"] = "admin@n8n.local";
    process.env["N8N_KEY"] = "super-secret-from-env";
    vi.resetModules();

    try {
      const sites = await import("../credentials/sites.js");

      sites.saveSiteCredential("app.example.com", {
        username: "$N8N_USERNAME",
        password: "$N8N_KEY",
        loginUrl: "http://app.example.com/signin",
      });

      expect(sites.getStoredSiteCredentialRecord("app.example.com")).toMatchObject({
        hostname: "app.example.com",
        username: "$N8N_USERNAME",
        password: "$N8N_KEY",
      });

      expect(sites.resolveSiteCredential("app")).toMatchObject({
        hostname: "app.example.com",
        username: "admin@n8n.local",
        password: "super-secret-from-env",
        loginUrl: "http://app.example.com/signin",
        source: "store",
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves store-backed credentials across equivalent TLD variants", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sites-store-tld-"));

    process.env["SAI_MASTER_KEY"] = "m".repeat(32);
    process.env["SAI_CRED_STORE"] = join(tempDir, PRODUCT.stateDirName, "credentials.enc");
    vi.resetModules();

    try {
      const sites = await import("../credentials/sites.js");

      sites.saveSiteCredential("www.freelancermap.de", {
        username: "user@example.com",
        password: "stored-secret",
        loginUrl: "https://www.freelancermap.de/login",
      });

      expect(sites.resolveSiteCredential("freelancermap.com")).toMatchObject({
        hostname: "freelancermap.de",
        username: "user@example.com",
        password: "stored-secret",
        loginUrl: "https://www.freelancermap.de/login",
        source: "store",
      });
      expect(sites.resolveSiteCredential("www.freelancermap.com")?.hostname).toBe("freelancermap.de");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

/**
 * Honest lookup-miss reporting (regression: session 8815a45e, 2026-07-02). A configured
 * freelancermap.de credential was RBAC-denied for the calling user, but the tools reported
 * "No credentials found — add them via the dashboard", contradicting the user (who HAD
 * stored it) and sending three delegation attempts hunting a phantom missing entry.
 * lookupSiteCredential must distinguish denied / unresolved-secret-ref / not_found, and the
 * user-facing message must never say "not found" for an entry that exists.
 */
describe("site credential lookup-miss honesty", () => {
  afterEach(async () => {
    delete process.env["SAI_CONFIG_PATH"];
    delete process.env["FM_PASSWORD"];
    vi.resetModules();
    const configLoader = await import("../config/loader.js");
    configLoader.resetConfigForTests();
  });

  async function withSitesConfig(entry: Record<string, unknown>, run: (sites: typeof import("../credentials/sites.js")) => void | Promise<void>) {
    const tempDir = mkdtempSync(join(tmpdir(), "guardedclaw-sites-miss-"));
    const configPath = join(tempDir, "starlingai.json");
    writeFileSync(configPath, JSON.stringify({ sites: { "freelancermap.de": entry } }), "utf8");
    process.env["SAI_CONFIG_PATH"] = configPath;
    vi.resetModules();
    try {
      await run(await import("../credentials/sites.js"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  it("reports 'denied' (not 'not found') when the entry exists but the user is not allowed", async () => {
    process.env["FM_PASSWORD"] = "pw";
    await withSitesConfig(
      { username: "u@example.com", password: "$FM_PASSWORD", allowedUsers: ["steffen"] },
      (sites) => {
        const result = sites.lookupSiteCredential("freelancermap.de", "sess-1", "admin");
        expect(result.status).toBe("denied");
        const msg = sites.siteCredentialMissMessage(result, "freelancermap.de");
        expect(msg).toContain("restricted");
        expect(msg).not.toContain("No credentials found");
        // Back-compat wrapper still collapses to null.
        expect(sites.resolveSiteCredential("freelancermap.de", "sess-1", "admin")).toBeNull();
      },
    );
  });

  it("still resolves for an allowed user and with auth disabled (no userId)", async () => {
    process.env["FM_PASSWORD"] = "pw";
    await withSitesConfig(
      { username: "u@example.com", password: "$FM_PASSWORD", allowedUsers: ["steffen"] },
      (sites) => {
        expect(sites.lookupSiteCredential("freelancermap.de", "sess-1", "steffen").status).toBe("resolved");
        expect(sites.lookupSiteCredential("freelancermap.de", "sess-1", undefined).status).toBe("resolved");
      },
    );
  });

  it("reports 'unresolved' (env-var drift class) when the entry exists but its secret ref is broken", async () => {
    // FM_PASSWORD deliberately NOT set — the "$VAR resolves from gateway env" gotcha.
    await withSitesConfig(
      { username: "u@example.com", password: "$FM_PASSWORD" },
      (sites) => {
        const result = sites.lookupSiteCredential("freelancermap.de", "sess-1", "admin");
        expect(result.status).toBe("unresolved");
        const msg = sites.siteCredentialMissMessage(result, "freelancermap.de");
        expect(msg).toContain("could not be resolved");
        expect(msg).not.toContain("No credentials found");
      },
    );
  });

  it("reports a genuine miss as 'not_found' with the add-it guidance", async () => {
    await withSitesConfig(
      { username: "u@example.com", password: "pw-literal" },
      (sites) => {
        const result = sites.lookupSiteCredential("unknown-site.example", "sess-1", "admin");
        expect(result.status).toBe("not_found");
        expect(sites.siteCredentialMissMessage(result, "unknown-site.example")).toContain("No credentials found");
      },
    );
  });
});