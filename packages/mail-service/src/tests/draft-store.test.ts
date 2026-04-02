import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DraftStore } from "../draft-store.js";

describe("DraftStore", () => {
  it("stores drafts and categories on disk", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "starlingai-mail-store-"));
    const store = new DraftStore(join(tempDir, "state.json"));

    try {
      const draft = await store.createDraft({
        accountId: "work",
        to: ["team@example.com"],
        cc: [],
        bcc: [],
        subject: "Hello",
        textBody: "Draft body",
      });

      const fetched = await store.getDraft(draft.id);
      expect(fetched?.subject).toBe("Hello");

      await store.categorize([
        {
          accountId: "work",
          mailbox: "INBOX",
          uid: 42,
          category: "finance",
          note: "March invoice",
          updatedAt: new Date().toISOString(),
        },
      ]);

      const category = await store.getCategory({ accountId: "work", mailbox: "INBOX", uid: 42 });
      expect(category?.category).toBe("finance");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});