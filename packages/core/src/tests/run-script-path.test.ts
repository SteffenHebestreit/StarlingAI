import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveScriptPath } from "../tools/shell.js";
import { runWithRequestContext } from "../runtime/request-context.js";

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
});
