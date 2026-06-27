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

/**
 * Single-process draft/category store. State is held in memory (lazily loaded
 * once) and persisted via temp-file + rename. Previously every operation did a
 * full read-modify-write of the JSON file with NO serialization, so concurrent
 * mutations lost-updated, and getCategory re-read the whole file per search hit.
 * Mutations now run through a promise-chain mutex (no interleaving); reads serve
 * from the in-memory copy.
 */
export class DraftStore {
  private state: MailServiceState | null = null;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  private async ensureState(): Promise<MailServiceState> {
    if (!this.state) this.state = await this.loadState();
    return this.state;
  }

  /** Serialize a mutation against all other mutations, then persist once. */
  private mutate<T>(fn: (state: MailServiceState) => T): Promise<T> {
    const run = this.writeQueue.then(async () => {
      const state = await this.ensureState();
      const result = fn(state);
      await this.persist(state);
      return result;
    });
    // Keep the chain alive even if this mutation rejects (its rejection still
    // propagates to the caller below).
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  async getDraft(id: string): Promise<DraftRecord | null> {
    const state = await this.ensureState();
    return state.drafts[id] ?? null;
  }

  async createDraft(input: Omit<DraftRecord, "id" | "status" | "createdAt" | "updatedAt">): Promise<DraftRecord> {
    return this.mutate((state) => {
      const now = new Date().toISOString();
      const draft: DraftRecord = {
        ...input,
        id: randomUUID(),
        status: "draft",
        createdAt: now,
        updatedAt: now,
      };
      state.drafts[draft.id] = draft;
      return draft;
    });
  }

  async updateDraft(id: string, patch: Partial<Omit<DraftRecord, "id" | "accountId" | "createdAt" | "sentAt" | "status">>): Promise<DraftRecord | null> {
    return this.mutate((state) => {
      const existing = state.drafts[id];
      if (!existing) return null;
      const updated: DraftRecord = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      state.drafts[id] = updated;
      return updated;
    });
  }

  async markDraftSent(id: string): Promise<DraftRecord | null> {
    return this.mutate((state) => {
      const existing = state.drafts[id];
      if (!existing) return null;
      const now = new Date().toISOString();
      const updated: DraftRecord = { ...existing, status: "sent", updatedAt: now, sentAt: now };
      state.drafts[id] = updated;
      return updated;
    });
  }

  async categorize(items: Array<CategoryRecord>): Promise<void> {
    await this.mutate((state) => {
      for (const item of items) state.categories[messageKey(item)] = item;
    });
  }

  async getCategory(ref: MessageRef): Promise<CategoryRecord | null> {
    const state = await this.ensureState();
    return state.categories[messageKey(ref)] ?? null;
  }

  private async loadState(): Promise<MailServiceState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      return JSON.parse(raw) as MailServiceState;
    } catch {
      return emptyState();
    }
  }

  private async persist(state: MailServiceState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.tmp`;
    await writeFile(tempPath, JSON.stringify(state, null, 2), "utf8");
    await rename(tempPath, this.filePath);
  }
}
