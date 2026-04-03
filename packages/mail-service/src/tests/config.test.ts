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
      address: "bundeswehr@steffen-hebestreit.com",
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
        from: "OTL Hebestreit <bundeswehr@steffen-hebestreit.com>"
      }
    },
  ],
}
`, "utf8");

    process.env["SAI_MAIL_SERVICE_CONFIG_PATH"] = configPath;
    process.env["MAIL_WORK_USER"] = "bundeswehr@steffen-hebestreit.com";
    process.env["MAIL_WORK_PASS"] = "secret-pass";

    try {
      const config = await loadMailServiceConfig();
      expect(config.accounts).toHaveLength(1);
      expect(config.accounts[0]).toMatchObject({
        id: "work",
        address: "bundeswehr@steffen-hebestreit.com",
        imap: {
          host: "imap.strato.de",
          user: "bundeswehr@steffen-hebestreit.com",
          pass: "secret-pass",
        },
        smtp: {
          host: "smtp.strato.de",
          user: "bundeswehr@steffen-hebestreit.com",
          pass: "secret-pass",
        },
      });
    } finally {
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
      address: "bundeswehr@steffen-hebestreit.com",
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
    process.env["MAIL_WORK_USER"] = "bundeswehr@steffen-hebestreit.com";
    delete process.env["MAIL_WORK_PASS"];

    try {
      await expect(loadMailServiceConfig()).rejects.toThrow("Missing environment variable MAIL_WORK_PASS");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});