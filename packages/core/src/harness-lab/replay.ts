/**
 * A lab run that stopped (its time budget ran out, the machine restarted) goes on where it stopped:
 * every attempt and every lab model call is kept under the run's --out, keyed by what went in, and a
 * run on the same --out serves them back. Served in order, the same records give the editors the same
 * input, so they get the same answers back and propose the same edits, and the run replays to the
 * point it reached before doing anything new.
 *
 * Every key carries the harness fingerprint (the prompts the run started from): once a proposal is
 * applied or a prompt edited, nothing recorded against the old prompts is served again.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function sha256(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

/** The prompts a run starts from, as one hash. */
export function harnessFingerprint(prompts: Record<string, string>): string {
  return sha256(Object.keys(prompts).sort().map((key) => [key, prompts[key]]));
}

/** The id of the run an --out directory holds, so a run that goes on with it keeps that id. */
export function readRunId(outDir: string): string | null {
  try {
    const id = (JSON.parse(readFileSync(join(outDir, "run.json"), "utf8")) as { runId?: unknown }).runId;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

export function writeRunId(outDir: string, runId: string): void {
  mkdirSync(outDir, { recursive: true });
  if (!existsSync(join(outDir, "run.json"))) writeFileSync(join(outDir, "run.json"), `${JSON.stringify({ runId })}\n`, "utf8");
}

/** Where the nightly runs stand: the run a spent budget paused, and the last one that finished. */
export interface NightlyState {
  unfinished?: string;
  pausedAt?: string;
  pauseReason?: string;
  lastFinished?: string;
  finishedAt?: string;
  verdict?: string;
}

export function readNightlyState(root: string): NightlyState {
  try {
    return JSON.parse(readFileSync(join(root, "state.json"), "utf8")) as NightlyState;
  } catch {
    return {};
  }
}

export function writeNightlyState(root: string, state: NightlyState): void {
  mkdirSync(root, { recursive: true });
  const file = join(root, "state.json");
  writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  renameSync(`${file}.tmp`, file);
}

export interface ReplayStats {
  served: number;
  recorded: number;
}

export class ReplayCache {
  readonly stats: ReplayStats = { served: 0, recorded: 0 };
  private readonly dir: string;

  constructor(outDir: string, private readonly fingerprint: string) {
    this.dir = join(outDir, "replay");
    mkdirSync(this.dir, { recursive: true });
  }

  /** The recorded result for `key`, else `produce`'s, recorded once it settles (a throw records nothing). */
  async through<T>(kind: string, key: unknown, produce: () => Promise<T>): Promise<T> {
    const file = join(this.dir, `${kind}-${sha256([this.fingerprint, key])}.json`);
    if (existsSync(file)) {
      try {
        const value = (JSON.parse(readFileSync(file, "utf8")) as { value: T }).value;
        this.stats.served += 1;
        return value;
      } catch {
        // A file torn by a kill mid-write is a miss.
      }
    }
    const value = await produce();
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify({ value }), "utf8");
    renameSync(temp, file);
    this.stats.recorded += 1;
    return value;
  }
}
