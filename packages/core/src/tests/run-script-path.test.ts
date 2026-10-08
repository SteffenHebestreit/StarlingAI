import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveScriptPath } from "../tools/shell.js";
import { getTool } from "../tools/registry.js";
import { runWithRequestContext } from "../runtime/request-context.js";

// run_script's `docker run`, answered without a sandbox so a test can read the command it was handed.
// Hoisted: shell.js promisifies execFile when it loads, which is during this file's imports.
const execFileAsyncMock = vi.hoisted(() => vi.fn(async (_file: string, _args: string[]) => ({ stdout: "8392\n", stderr: "" })));
vi.mock("node:child_process", async (importOriginal) => {
  const { promisify } = await import("node:util");
  const execFile = vi.fn();
  (execFile as unknown as Record<PropertyKey, unknown>)[promisify.custom] = execFileAsyncMock;
  return { ...(await importOriginal<typeof import("node:child_process")>()), execFile };
});

/**
 * run_script finds a script where write_file put it (found by the E2E suite, 2026-10-07).
 *
 * write_file roots a working agent's writes under generated/, and run_script looked for the path
 * as given: the coder wrote primes.js (→ generated/primes.js), ran primes.js, and the sandbox
 * found nothing.
 */
describe("run_script path resolution", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  function workspace(files: string[]): string {
    const ws = mkdtempSync(join(tmpdir(), "sai-run-script-"));
    dirs.push(ws);
    for (const file of files) {
      mkdirSync(join(ws, file, ".."), { recursive: true });
      writeFileSync(join(ws, file), "console.log(1);\n", "utf8");
    }
    return ws;
  }

  it("finds a script write_file rooted under generated/", () => {
    const ws = workspace(["generated/primes.js"]);
    expect(resolveScriptPath("primes.js", ws)).toBe("generated/primes.js");
  });

  it("keeps a script that exists where it was named", () => {
    const ws = workspace(["scripts/deploy.sh", "generated/scripts/deploy.sh"]);
    expect(resolveScriptPath("scripts/deploy.sh", ws)).toBe("scripts/deploy.sh");
  });

  it("keeps the path as given when the script is nowhere, so the error names it", () => {
    const ws = workspace([]);
    expect(resolveScriptPath("missing.py", ws)).toBe("missing.py");
  });

  it("resolves the same way for a scope-confined agent", () => {
    const ws = workspace(["generated/primes.js"]);
    const resolved = runWithRequestContext({ workspaceScope: "generated" }, () => resolveScriptPath("primes.js", ws));
    expect(resolved).toBe("generated/primes.js");
  });

  // A scope-confined agent's file tools see generated/ in place of the workspace root, but its
  // shell_exec runs at /workspace: a script it wrote there, or a build's dist/, sits at the root,
  // and run_script looked only under generated/ for it.
  it("finds a script a scope-confined agent's shell left at the workspace root", () => {
    const ws = workspace(["fib.py", "dist/app.js"]);
    const scoped = (path: string) => runWithRequestContext({ workspaceScope: "generated" }, () => resolveScriptPath(path, ws));
    expect(scoped("fib.py")).toBe("fib.py");
    expect(scoped("/workspace/dist/app.js")).toBe("dist/app.js");
  });

  it("keeps the generated/ copy a scope-confined agent's file tools see when the root has one too", () => {
    const ws = workspace(["fib.py", "generated/fib.py"]);
    expect(runWithRequestContext({ workspaceScope: "generated" }, () => resolveScriptPath("fib.py", ws))).toBe("generated/fib.py");
  });

  // The tests above pin the helper; this one pins that run_script hands the sandbox what it found.
  // A command that names the script as given ran /workspace/primes.js, which is the E2E failure.
  it("runs the script in the sandbox where it was found", async () => {
    const ws = workspace(["generated/primes.js"]);
    execFileAsyncMock.mockClear();
    const result = await getTool("run_script")!.execute({ path: "primes.js" }, { sessionId: "run-script-path", workspacePath: ws });
    expect(result.success).toBe(true);
    expect(execFileAsyncMock).toHaveBeenCalledTimes(1);
    expect(execFileAsyncMock.mock.calls[0]?.[1].at(-1)).toBe("node '/workspace/generated/primes.js'");
  });
});
