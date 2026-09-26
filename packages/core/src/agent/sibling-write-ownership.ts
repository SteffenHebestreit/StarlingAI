/**
 * Write ownership among concurrently running sibling tasks (run_task_graph, parallel_delegate).
 *
 * Siblings of one fan-out run at the same time against the same workspace, and nothing stopped
 * one of them from writing another's file. In c297c5ea a run_task_graph started three builders
 * whose tasks named three different files (paper.md, the deck, notes.md); the write_paper builder
 * then edited the DECK at 02:24:09 and 02:24:55 while write_presentation was building it, and never
 * wrote paper.md. No rule over the task texts could have seen that: they named distinct files. The
 * collision only exists at write time, so that is where this checks.
 *
 * The rule, per fan-out group and only among members that are RUNNING:
 *  - a path exactly one running sibling's task names is that sibling's;
 *  - any other path is the first running sibling's to write it;
 *  - every other running sibling is refused, and the refusal names the owner;
 *  - an owner that has finished owns nothing, so a dependent node (it starts only after its
 *    prerequisites finished) may write what they wrote.
 * Paths are compared after the workspace write resolver, so "paper.md" and "generated/paper.md"
 * are one file, and two different files in one directory are two files.
 *
 * Membership travels with the async context (AsyncLocalStorage), so a sibling's own nested
 * delegations write as that sibling, and a fan-out nested inside a sibling is checked against both
 * groups. Structural throughout: path tokens and equality, no words.
 *
 * INVARIANT: a leaf module (imports only other leaves), so tools/sub-agent.ts and agent/sub-agent.ts
 * can both reach it.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { PATH_TOKEN } from "./artifact-path-repair.js";
import { resolveWorkspaceWritePath } from "../tools/workspace-path.js";

interface SiblingMember {
  /** Names the owner in a refusal: the node id or slice number, with its agent. */
  label: string;
  /** Normalised paths the member's task names. */
  named: Set<string>;
  running: boolean;
}

/** The files a task text names: path-shaped tokens with an extension (see PATH_TOKEN). */
export function extractTaskNamedPaths(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PATH_TOKEN)) {
    const token = match[1];
    if (token) found.add(token);
  }
  return [...found];
}

/** One fan-out's siblings: who is running, which paths their tasks name, and who wrote what first. */
export class SiblingWriteGroup {
  private readonly members = new Map<string, SiblingMember>();
  /** Normalised path → the member that wrote it first while running. */
  private readonly claims = new Map<string, string>();

  constructor(
    readonly kind: "run_task_graph" | "parallel_delegate",
    private readonly workspacePath: string | undefined,
  ) {}

  normalize(rawPath: string): string {
    const trimmed = rawPath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!this.workspacePath) return trimmed;
    try {
      return resolveWorkspaceWritePath(trimmed, this.workspacePath).relativePath;
    } catch {
      // Outside the workspace: compare literally rather than not at all (the write itself fails later).
      return trimmed;
    }
  }

  /** The member starts running with the paths its task names. */
  start(memberId: string, label: string, task: string): void {
    const named = new Set(extractTaskNamedPaths(task).map((path) => this.normalize(path)));
    this.members.set(memberId, { label, named, running: true });
  }

  /** The member finished: it owns nothing any more. */
  finish(memberId: string): void {
    const member = this.members.get(memberId);
    if (member) member.running = false;
  }

  /** The running sibling that owns `path` against `memberId`, or null when `memberId` may write it. */
  ownerAgainst(memberId: string, path: string): string | null {
    const namers = [...this.members.entries()]
      .filter(([, member]) => member.running && member.named.has(path))
      .map(([id]) => id);
    // Named by running siblings and not by this one: theirs.
    if (namers.length > 0 && !namers.includes(memberId)) return this.members.get(namers[0]!)!.label;
    // Named by this one alone: its own, whoever touched it first.
    if (namers.length === 1) return null;
    // Named by nobody running, or by several of them: the first running writer's.
    const claimer = this.claims.get(path);
    if (claimer && claimer !== memberId && this.members.get(claimer)?.running) return this.members.get(claimer)!.label;
    return null;
  }

  /** Record that `memberId` writes `path` (called only once every enclosing group allowed it). */
  claim(memberId: string, path: string): void {
    this.claims.set(path, memberId);
  }
}

type SiblingScope = ReadonlyArray<{ group: SiblingWriteGroup; memberId: string }>;
const siblingScope = new AsyncLocalStorage<SiblingScope>();

/**
 * Run one sibling of `group` as `memberId`: it (and whatever it delegates) writes as that member
 * until `work` settles, and the member stops owning anything the moment it does.
 */
export function runAsWriteSibling<T>(
  group: SiblingWriteGroup | null,
  memberId: string,
  label: string,
  task: string,
  work: () => Promise<T>,
): Promise<T> {
  if (!group) return work();
  group.start(memberId, label, task);
  const scope: SiblingScope = [...(siblingScope.getStore() ?? []), { group, memberId }];
  return siblingScope.run(scope, work).finally(() => group.finish(memberId));
}

/** A refused write: the sibling that owns the path, and which kind of fan-out it belongs to. */
export interface SiblingWriteRefusal {
  owner: string;
  kind: SiblingWriteGroup["kind"];
}

/**
 * Check a write about to run in the current async context. Outside any fan-out it is always
 * allowed. Allowed writes are claimed in every enclosing group; a refusal claims nothing.
 */
export function checkSiblingWrite(rawPath: string): SiblingWriteRefusal | null {
  const scope = siblingScope.getStore();
  if (!scope || scope.length === 0 || !rawPath.trim()) return null;
  const resolved = scope.map(({ group, memberId }) => ({ group, memberId, path: group.normalize(rawPath) }));
  for (const { group, memberId, path } of resolved) {
    const owner = group.ownerAgainst(memberId, path);
    if (owner) return { owner, kind: group.kind };
  }
  for (const { group, memberId, path } of resolved) group.claim(memberId, path);
  return null;
}
