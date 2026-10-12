import { describe, expect, it } from "vitest";
// @ts-expect-error — plain .mjs, no types
import * as companionStacksModule from "../../../../scripts/companion-stacks.mjs";

interface CompanionStack { name: string; compose: string; join?: { service: string; alias: string } }
type FileAccess = { exists: (path: string) => boolean; read: (path: string) => string };
const { companionCompose, companionOverrideYaml, readCompanionStacks } = companionStacksModule as {
  readCompanionStacks: (path: string, access: FileAccess) => { stacks: CompanionStack[]; error?: string };
  companionOverrideYaml: (join: { service: string; alias: string }, network: string) => string;
  companionCompose: (
    stack: CompanionStack,
    network: string,
    io: { dir: string; write: (path: string, text: string) => void; override?: boolean },
  ) => string[];
};

/**
 * Companion stacks (scripts/companion-stacks.mjs): compose projects of their own, declared in the
 * local docker/companions.local.jsonc, that `sai start --all` starts before the stack and `sai stop`
 * takes down. The dashboard reported an MCP server that failed to connect because its stack was not
 * running, and the hand-made `docker network connect` that reached it did not survive a recreated
 * container.
 */

const fileWith = (text: string) => ({ exists: () => true, read: () => text });

describe("readCompanionStacks", () => {
  it("reads the declared stacks, comments and all, and none when there is no file", () => {
    const { stacks, error } = readCompanionStacks("companions.jsonc", fileWith(`{
      // a stack the gateway reaches as "notes"
      "stacks": [
        { "name": "notes", "compose": "d:/notes/docker-compose.yml", "join": { "service": "api", "alias": "notes" } },
        { "name": "batch-jobs", "compose": "d:/jobs/compose.yml" },
      ],
    }`));
    expect(error).toBeUndefined();
    expect(stacks).toEqual([
      { name: "notes", compose: "D:/notes/docker-compose.yml", join: { service: "api", alias: "notes" } },
      { name: "batch-jobs", compose: "D:/jobs/compose.yml" },
    ]);
    expect(readCompanionStacks("missing.jsonc", { exists: () => false, read: () => "" })).toEqual({ stacks: [] });
  });

  it("names a Windows compose path's drive in upper case: compose's build failed on a lower-case one", () => {
    const { stacks } = readCompanionStacks("c.jsonc", fileWith(String.raw`{ stacks: [
      { name: "a", compose: "e:/notes/docker-compose.yml" },
      { name: "b", compose: "e:\\notes\\compose.yml" },
      { name: "c", compose: "/srv/notes/compose.yml" },
    ] }`));
    expect(stacks.map((stack) => stack.compose)).toEqual(["E:/notes/docker-compose.yml", "E:\\notes\\compose.yml", "/srv/notes/compose.yml"]);
  });

  it("fails the whole file on a malformed stack, so a typo is reported instead of a stack silently not starting", () => {
    expect(readCompanionStacks("c.jsonc", fileWith("{ stacks: [ { name: 'Notes', compose: 'x.yml' } ] }")).error).toMatch(/compose project name/);
    expect(readCompanionStacks("c.jsonc", fileWith("{ stacks: [ { name: 'notes' } ] }")).error).toMatch(/"compose"/);
    expect(readCompanionStacks("c.jsonc", fileWith("{ stacks: [ { name: 'notes', compose: 'x.yml', join: { service: 'api' } } ] }")).error).toMatch(/"join"/);
    expect(readCompanionStacks("c.jsonc", fileWith("{ stacks: [ { name: 'notes', compose: 'x.yml', join: { service: 'api', alias: 'no tes' } } ] }")).error).toMatch(/"join"/);
    expect(readCompanionStacks("c.jsonc", fileWith("{ services: [] }")).error).toMatch(/"stacks"/);
    expect(readCompanionStacks("c.jsonc", fileWith("{ stacks: [ ")).error).toMatch(/not valid JSONC/);
    expect(readCompanionStacks("c.jsonc", fileWith("{ stacks: [ { name: 'ok', compose: 'a.yml' }, { name: 'Bad', compose: 'b.yml' } ] }")).stacks).toEqual([]);
  });
});

describe("companionOverrideYaml", () => {
  it("puts the joined service on the gateway's network under its alias, and keeps it on its own stack's", () => {
    const yaml = companionOverrideYaml({ service: "api", alias: "notes" }, "stack_stack-internal");
    expect(yaml).toContain("  api:\n    networks:\n      default: {}\n      sai-gateway:\n        aliases:\n          - notes");
    expect(yaml).toContain("networks:\n  sai-gateway:\n    external: true\n    name: stack_stack-internal");
  });
});

describe("companionCompose", () => {
  it("runs the stack as its own project, with its override when it joins the gateway's network", () => {
    const written: Array<{ path: string; text: string }> = [];
    const parts = companionCompose(
      { name: "notes", compose: "d:/notes/docker-compose.yml", join: { service: "api", alias: "notes" } },
      "stack_stack-internal",
      { dir: "/tmp/x", write: (path: string, text: string) => { written.push({ path, text }); } },
    );
    expect(parts.slice(0, 6)).toEqual(["docker", "compose", "-p", "notes", "-f", "d:/notes/docker-compose.yml"]);
    expect(parts.slice(6, 7)).toEqual(["-f"]);
    expect(written).toHaveLength(1);
    expect(parts[7]).toBe(written[0]!.path);
    expect(written[0]!.text).toContain("- notes");
  });

  it("leaves the override out when asked, for a build, which the network does not concern", () => {
    const written: unknown[] = [];
    const parts = companionCompose(
      { name: "notes", compose: "d:/notes/docker-compose.yml", join: { service: "api", alias: "notes" } },
      "stack_stack-internal",
      { dir: "/tmp/x", write: () => { written.push(1); }, override: false },
    );
    expect(parts).toEqual(["docker", "compose", "-p", "notes", "-f", "d:/notes/docker-compose.yml"]);
    expect(written).toHaveLength(0);
  });

  it("writes no override for a stack the gateway does not reach, and quotes a path with spaces", () => {
    const written: unknown[] = [];
    const parts = companionCompose(
      { name: "jobs", compose: "C:/Program Files/jobs/compose.yml" },
      "stack_stack-internal",
      { dir: "/tmp/x", write: () => { written.push(1); } },
    );
    expect(parts).toEqual(["docker", "compose", "-p", "jobs", "-f", "\"C:/Program Files/jobs/compose.yml\""]);
    expect(written).toHaveLength(0);
  });
});
