/**
 * The child process that actually runs a built page's JavaScript.
 *
 * WHY THIS IS A SEPARATE PROCESS. `vm` isolates globals, not realms: every host function the
 * DOM shim puts in the context hands the page `.constructor` and through it the host
 * `Function`, so `document.getElementById.constructor("return process")()` returns the real
 * `process` — env, `child_process`, everything. That was reachable with no tool call at all,
 * because the artifact probe executes every delivered .html. Executing model-authored code in
 * the gateway process is therefore not something a better shim can make safe.
 *
 * So the page runs here instead, started by page-check.ts with:
 *   - a SCRUBBED environment, so an escape finds no API keys, no JWT secret, no DB URL;
 *   - a working directory in the OS temp dir, so a relative write cannot land in the workspace;
 *   - a hard kill on the parent's timer, so a loop no vm timeout catches cannot outlive it;
 *   - no shared memory with the gateway, so nothing here can read a session, a token or a turn.
 *
 * What this does NOT claim: the child runs as the same OS user and can still touch the
 * filesystem. Full containment is the sandbox runner's job (shell_exec / run_script); this is
 * the bounded, dependency-free check that can run on every build without one.
 *
 * Protocol: one JSON request on stdin, one JSON response on stdout. Anything this process
 * writes to stderr is diagnostic only — the parent reads stdout.
 */

import { runScripts, type ScriptSource, type DeclaredElement } from "./page-check-runner.js";
import type { CanvasPaintReport } from "./canvas-geometry.js";

export interface PageCheckRequest {
  scripts: ScriptSource[];
  ids: string[];
  declared: Array<[string, DeclaredElement]>;
}

export interface PageCheckResponse {
  errors: string[];
  consoleErrors: string[];
  framesRun: number;
  /** Per-canvas paint report, already read out of the recorder's closures. */
  canvases: Array<[string, CanvasPaintReport]>;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { buf += chunk; });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
  });
}

async function main(): Promise<void> {
  const raw = await readStdin();
  const request = JSON.parse(raw) as PageCheckRequest;
  const report = runScripts(
    request.scripts,
    new Set(request.ids),
    new Map(request.declared),
  );
  const response: PageCheckResponse = {
    errors: report.errors,
    consoleErrors: report.consoleErrors,
    framesRun: report.framesRun,
    // The recorder's reports are closures; read them here, where the recorder lives.
    canvases: [...report.canvasPainting.entries()].map(([id, read]) => [id, read()]),
  };
  process.stdout.write(JSON.stringify(response));
}

main().then(
  () => { process.exit(0); },
  (err: unknown) => {
    process.stderr.write(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    process.exit(1);
  },
);
