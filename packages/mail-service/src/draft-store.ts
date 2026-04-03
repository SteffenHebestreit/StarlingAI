import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { CategoryRecord, DraftRecord, MailServiceState, MessageRef } from "./types.js";

function emptyState(): MailServiceState {
  return { drafts: {}, categories: {} };
}

function messageKey(ref: MessageRef): string {
  return `${ref.accountId}::${ref.mailbox}::${ref.uid}`;
}

export class DraftStore {
  constructor(private readonly filePath: string) {}

  async getDraft(id: string): Promise<DraftRecord | null> {
    const state = await this.readState();
    return state.drafts[id] ?? null;
  }

  async createDraft(input: Omit<DraftRecord, "id" | "status" | "createdAt" | "updatedAt">): Promise<DraftRecord> {
    const now = new Date().toISOString();
    const draft: DraftRecord = {
      ...input,
      id: randomUUID(),
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };
    const state = await this.readState();
    state.drafts[draft.id] = draft;
    await this.writeState(state);
    return draft;
  }

  async updateDraft(id: string, patch: Partial<Omit<DraftRecord, "id" | "accountId" | "createdAt" | "sentAt" | "status">>): Promise<DraftRecord | null> {
    const state = await this.readState();
    const existing = state.drafts[id];
    if (!existing) return null;
    const updated: DraftRecord = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    state.drafts[id] = updated;
    await this.writeState(state);
    return updated;
  }

  async markDraftSent(id: string): Promise<DraftRecord | null> {
    const state = await this.readState();
    const existing = state.drafts[id];
    if (!existing) return null;
    const now = new Date().toISOString();
    const updated: DraftRecord = {
      ...existing,
      status: "sent",
      updatedAt: now,
      sentAt: now,
    };
    state.drafts[id] = updated;
    await this.writeState(state);
    return updated;
  }

  async categorize(items: Array<CategoryRecord>): Promise<void> {
    const state = await this.readState();
    for (const item of items) {
      state.categories[messageKey(item)] = item;
    }
    await this.writeState(state);
  }

  async getCategory(ref: MessageRef): Promise<CategoryRecord | null> {
    const state = await this.readState();
    return state.categories[messageKey(ref)] ?? null;
  }

  private async readState(): Promise<MailServiceState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as MailServiceState;
    } catch {
      return emptyState();
    }
  }

  private async writeState(state: MailServiceState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
    await rename(tempPath, this.filePath);
  }
}