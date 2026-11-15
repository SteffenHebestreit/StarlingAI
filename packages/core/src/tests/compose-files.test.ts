import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs, no types
import * as composeFilesModule from "../../../../scripts/compose-files.mjs";

const { composeFileArgs, OVERRIDE_COMPOSE_FILE } = composeFilesModule as {
  composeFileArgs: (overlays?: string[], io?: { exists?: (path: string) => boolean }) => string[];
  OVERRIDE_COMPOSE_FILE: string;
};

/**
 * `sai start` (scripts/sai.mjs) ran `docker compose -f docker-compose.yml …`. Compose reads a
 * docker-compose.override.yml next to the base file on its own only when it is given no `-f`, so the
 * override was silently left out: its settings never reached the containers `sai start` created, and
 * `sai stop` did not know the services it added. The one-click launchers had the same gap.
 */

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const read = (file: string): string => readFileSync(join(root, file), "utf8").replace(/\r\n/g, "\n");
/** Source lines that are not comments. */
const code = (text: string): string => text.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*|#)/.test(line)).join("\n");

const overrideOnly = (path: string): boolean => path === "docker-compose.override.yml";
const nothing = (): boolean => false;

describe("composeFileArgs (scripts/compose-files.mjs)", () => {
  it("adds docker-compose.override.yml when it exists, last, after the base file and the overlays", () => {
    expect(composeFileArgs(["docker-compose.gpu.yml"], { exists: overrideOnly })).toEqual([
      "-f", "docker-compose.yml",
      "-f", "docker-compose.gpu.yml",
      "-f", "docker-compose.override.yml",
    ]);
    expect(composeFileArgs([], { exists: overrideOnly })).toEqual(["-f", "docker-compose.yml", "-f", "docker-compose.override.yml"]);
    expect(OVERRIDE_COMPOSE_FILE).toBe("docker-compose.override.yml");
  });

  it("leaves it out when there is none, so a stack without one starts exactly as before", () => {
    expect(composeFileArgs(["docker-compose.e2e.yml"], { exists: nothing })).toEqual(["-f", "docker-compose.yml", "-f", "docker-compose.e2e.yml"]);
    expect(composeFileArgs(undefined, { exists: nothing })).toEqual(["-f", "docker-compose.yml"]);
  });

  it("asks about the override file only, relative to the working directory sai sets to the repository root", () => {
    const asked: string[] = [];
    composeFileArgs(["docker-compose.gpu.yml"], { exists: (path) => { asked.push(path); return false; } });
    expect(asked).toEqual(["docker-compose.override.yml"]);
  });
});

describe("sai.mjs: every docker compose call that names files takes them from composeFileArgs", () => {
  const sai = code(read("scripts/sai.mjs"));

  it("names docker-compose.yml nowhere itself, so no call can drop the override", () => {
    expect(sai).not.toMatch(/["']-f["'],\s*["']docker-compose\.yml["']/);
    expect(sai).toMatch(/^import \{ BASE_COMPOSE_FILE, OVERRIDE_COMPOSE_FILE, composeFileArgs \} from "\.\/compose-files\.mjs";$/m);
  });

  it("builds composeFiles only through composeFileArgs, in sai start and in sai stop", () => {
    const definitions = [...sai.matchAll(/\bconst composeFiles = ([^;]+);/g)].map((match) => match[1]!);
    expect(definitions).toEqual(["composeFileArgs(composeOverlays)", "composeFileArgs(composeOverlays)"]);
    // The GPU overlay (start) and the e2e overlay (stop) go in as overlays, not as `-f` pairs.
    expect(sai).toContain('composeOverlays.push("docker-compose.gpu.yml");');
    expect(sai).toContain('composeOverlays.push("docker-compose.e2e.yml");');
  });

  it("passes composeFiles to every array-form compose call of this stack", () => {
    const calls = [...sai.matchAll(/\["docker",\s*"compose",\s*([^,\]]+)/g)].map((match) => match[1]!.trim());
    expect(calls.length).toBeGreaterThanOrEqual(4); // dc(), the two build-only builds, stop's down
    expect(calls.every((first) => first === "...composeFiles")).toBe(true);
  });

  it("gives the string-form calls (sai wipe) no -f, so Compose reads the override itself", () => {
    const stringCalls = [...sai.matchAll(/`docker compose ([^`]*)`|"docker compose ([^"]*)"/g)].map((match) => match[1] ?? match[2]!);
    expect(stringCalls.length).toBeGreaterThan(0);
    for (const call of stringCalls) expect(call, call).not.toMatch(/(^|\s)(-f|--file)\s/);
  });

  it("says so in its output when it loads the override", () => {
    expect(sai).toMatch(/function noteComposeOverride\(composeFiles\) \{\n\s+if \(composeFiles\.includes\(OVERRIDE_COMPOSE_FILE\)\) info\(/);
    expect(sai.match(/\bnoteComposeOverride\(composeFiles\);/g)).toHaveLength(2);
  });
});

describe("one-click launchers load docker-compose.override.yml last, too", () => {
  it("start.sh appends it after every other compose file and before it starts the stack", () => {
    const launcher = code(read("start.sh"));
    const appendOverride = launcher.indexOf("compose_files+=(-f docker-compose.override.yml)");
    expect(launcher).toContain("if [ -f docker-compose.override.yml ]; then");
    expect(appendOverride).toBeGreaterThan(launcher.lastIndexOf("compose_files+=(-f docker-compose.gpu.yml)"));
    expect(appendOverride).toBeGreaterThan(launcher.lastIndexOf("compose_files+=(-f docker-compose.ollama.yml)"));
    expect(appendOverride).toBeLessThan(launcher.indexOf('docker compose "${compose_files[@]}"'));
  });

  it("start.ps1 does the same", () => {
    const launcher = code(read("start.ps1"));
    const appendOverride = launcher.indexOf('$composeFiles += @("-f", "docker-compose.override.yml")');
    expect(launcher).toContain('if (Test-Path -LiteralPath "docker-compose.override.yml" -PathType Leaf) {');
    expect(appendOverride).toBeGreaterThan(launcher.lastIndexOf('$composeFiles += @("-f", "docker-compose.gpu.yml")'));
    expect(appendOverride).toBeGreaterThan(launcher.lastIndexOf('$composeFiles += @("-f", "docker-compose.ollama.yml")'));
    expect(appendOverride).toBeLessThan(launcher.indexOf("& docker compose @composeFiles"));
  });
});
