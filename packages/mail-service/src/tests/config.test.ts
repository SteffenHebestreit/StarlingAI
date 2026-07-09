import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMailServiceConfig } from "../config.js";

describe("loadMailServiceConfig", () => {
  const previousEnv = {
    configPath: process.env["SAI_MAIL_SERVICE_CONFIG_PATH"],
    workUser: process.env["MAIL_WORK_USER"],
    workPass: process.env["MAIL_WORK_PASS"],
  };

  afterEach(() => {
    if (previousEnv.configPath === undefined) delete process.env["SAI_MAIL_SERVICE_CONFIG_PATH"];
    else process.env["SAI_MAIL_SERVICE_CONFIG_PATH"] = previousEnv.configPath;

    if (previousEnv.workUser === undefined) delete process.env["MAIL_WORK_USER"];
    else process.env["MAIL_WORK_USER"] = previousEnv.workUser;

    if (previousEnv.workPass === undefined) delete process.env["MAIL_WORK_PASS"];
    else process.env["MAIL_WORK_PASS"] = previousEnv.workPass;
  });

  it("parses commented account config files and resolves env tokens", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-mail-config-"));
    const configPath = join(tempDir, "accounts.json");

    writeFileSync(configPath, `{
  // active work account
  accounts: [
    {
      id: "work",
      address: "user@example.com",
      displayName: "Work",
      imap: {
        host: "imap.strato.de",
        port: 993,
        secure: true,
        user: "$MAIL_WORK_USER",
        pass: "$MAIL_WORK_PASS"
      },
      smtp: {
        host: "smtp.strato.de",
        port: 587,
        secure: false,
        user: "$MAIL_WORK_USER",
        pass: "$MAIL_WORK_PASS",
        from: "Test User <user@example.com>"
      }
    },
  ],
}
`, "utf8");

    process.env["SAI_MAIL_SERVICE_CONFIG_PATH"] = configPath;
    process.env["MAIL_WORK_USER"] = "user@example.com";
    process.env["MAIL_WORK_PASS"] = "secret-pass";

    try {
      const config = await loadMailServiceConfig();
      expect(config.accounts).toHaveLength(1);
      expect(config.accounts[0]).toMatchObject({
        id: "work",
        address: "user@example.com",
        imap: {
          host: "imap.strato.de",
          user: "user@example.com",
          pass: "secret-pass",
        },
        smtp: {
          host: "smtp.strato.de",
          user: "user@example.com",
          pass: "secret-pass",
        },
      });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("resolves env references for ANY attribute (address, port, secure, allowedUsers) and coerces types", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-mail-config-"));
    const configPath = join(tempDir, "accounts.json");
    writeFileSync(configPath, `{
  accounts: [
    {
      id: "work",
      address: "$MAIL_ADDR",
      displayName: "$MAIL_NAME",
      allowedUsers: ["$MAIL_OWNER"],
      imap: { host: "$MAIL_HOST", port: "$MAIL_IMAP_PORT", secure: "$MAIL_SECURE", user: "$MAIL_ADDR", pass: "$MAIL_PASS" },
      smtp: { host: "$MAIL_HOST", port: 587, secure: "false", user: "$MAIL_ADDR", pass: "$MAIL_PASS" }
    }
  ]
}
`, "utf8");
    process.env["SAI_MAIL_SERVICE_CONFIG_PATH"] = configPath;
    Object.assign(process.env, {
      MAIL_ADDR: "user@example.com", MAIL_NAME: "Work", MAIL_OWNER: "alice",
      MAIL_HOST: "imap.example.com", MAIL_IMAP_PORT: "993", MAIL_SECURE: "true", MAIL_PASS: "secret",
    });
    try {
      const config = await loadMailServiceConfig();
      const acct = config.accounts[0]!;
      expect(acct.address).toBe("user@example.com"); // string field via env (passed .email())
      expect(acct.displayName).toBe("Work");
      expect(acct.allowedUsers).toEqual(["alice"]);
      expect(acct.imap.port).toBe(993);              // coerced string→number
      expect(acct.imap.secure).toBe(true);           // coerced string→boolean
      expect(acct.smtp.secure).toBe(false);          // literal string→boolean
    } finally {
      for (const k of ["MAIL_ADDR", "MAIL_NAME", "MAIL_OWNER", "MAIL_HOST", "MAIL_IMAP_PORT", "MAIL_SECURE", "MAIL_PASS"]) delete process.env[k];
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("fails fast when a referenced mail credential env var is missing", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-mail-config-"));
    const configPath = join(tempDir, "accounts.json");

    writeFileSync(configPath, `{
  accounts: [
    {
      id: "work",
      address: "user@example.com",
      imap: {
        host: "imap.strato.com",
        port: 993,
        secure: true,
        user: "$MAIL_WORK_USER",
        pass: "$MAIL_WORK_PASS"
      },
      smtp: {
        host: "smtp.strato.com",
        port: 465,
        secure: true,
        user: "$MAIL_WORK_USER",
        pass: "$MAIL_WORK_PASS"
      }
    }
  ]
}
`, "utf8");

    process.env["SAI_MAIL_SERVICE_CONFIG_PATH"] = configPath;
    process.env["MAIL_WORK_USER"] = "user@example.com";
    delete process.env["MAIL_WORK_PASS"];

    try {
      await expect(loadMailServiceConfig()).rejects.toThrow("Missing environment variable MAIL_WORK_PASS");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});