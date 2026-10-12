/**
 * Companion stacks: compose projects of their own that this machine runs next to the stack, declared
 * in the local, gitignored docker/companions.local.jsonc. `sai start --all` (or --companions) brings
 * them up and `sai stop` takes them down.
 *
 *   {
 *     "stacks": [
 *       {
 *         "name": "notes",                          // its compose project name
 *         "compose": "d:/notes/docker-compose.yml", // its compose file
 *         "join": { "service": "api", "alias": "notes" } // what the gateway reaches, and as what
 *       }
 *     ]
 *   }
 *
 * Each stack stays its OWN compose project, so its service names stay its own (a companion's
 * `postgres` must not merge into this stack's). The one service the gateway talks to joins the
 * gateway's network under its alias through a compose override written here, which holds across a
 * recreated container; a `docker network connect` by hand did not. Nothing here knows any companion:
 * what runs, and under which name the gateway reaches it, is the local file's.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";

export const COMPANIONS_FILE = "docker/companions.local.jsonc";

/** A compose project name: what `docker compose -p` accepts. */
const PROJECT_NAME = /^[a-z0-9][a-z0-9_-]*$/;
/** A compose service name, and a DNS alias on a Docker network. */
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * The companion stacks the local file declares, or the reason it cannot be used. No file: no stacks.
 * A stack that is not well-formed fails the whole file, so a typo is reported instead of a companion
 * silently not starting.
 */
export function readCompanionStacks(path = COMPANIONS_FILE, { exists = existsSync, read = (p) => readFileSync(p, "utf8") } = {}) {
  if (!exists(path)) return { stacks: [] };
  let parsed;
  try {
    parsed = JSON5.parse(read(path));
  } catch (err) {
    return { stacks: [], error: `${path} is not valid JSONC: ${err instanceof Error ? err.message : String(err)}` };
  }
  const entries = parsed?.stacks;
  if (!Array.isArray(entries)) return { stacks: [], error: `${path} has no "stacks" list` };
  const stacks = [];
  for (const [index, entry] of entries.entries()) {
    const where = `${path} stacks[${index}]`;
    if (!entry || typeof entry !== "object") return { stacks: [], error: `${where} is not an object` };
    if (typeof entry.name !== "string" || !PROJECT_NAME.test(entry.name)) {
      return { stacks: [], error: `${where}: "name" must be a compose project name (lowercase letters, digits, - and _)` };
    }
    if (typeof entry.compose !== "string" || !entry.compose.trim()) return { stacks: [], error: `${where}: "compose" must name its compose file` };
    let joinSpec;
    if (entry.join !== undefined) {
      const { service, alias } = entry.join ?? {};
      if (typeof service !== "string" || !SERVICE_NAME.test(service) || typeof alias !== "string" || !SERVICE_NAME.test(alias)) {
        return { stacks: [], error: `${where}: "join" needs a "service" and an "alias"` };
      }
      joinSpec = { service, alias };
    }
    stacks.push({ name: entry.name, compose: entry.compose.trim(), ...(joinSpec ? { join: joinSpec } : {}) });
  }
  return { stacks };
}

/**
 * The compose override that puts the stack's joined service on the gateway's network under its alias.
 * It names `default` too: a service with no networks of its own is on its project's default network,
 * and an override that lists only the gateway's network would take it off that one, away from the
 * rest of its own stack.
 */
export function companionOverrideYaml(joinSpec, network) {
  return [
    "services:",
    `  ${joinSpec.service}:`,
    "    networks:",
    "      default: {}",
    "      sai-gateway:",
    "        aliases:",
    `          - ${joinSpec.alias}`,
    "networks:",
    "  sai-gateway:",
    "    external: true",
    `    name: ${network}`,
    "",
  ].join("\n");
}

/** A path quoted for the shell string `sai`'s runner joins its arguments into. */
const quoted = (value) => (/[\s"]/.test(value) ? JSON.stringify(value) : value);

/**
 * The `docker compose` invocation for one stack, with its override written to the temp dir when it
 * joins the gateway's network. Its project directory is its compose file's, so its own .env applies.
 */
export function companionCompose(stack, network, { write = writeFileSync, dir = tmpdir() } = {}) {
  const parts = ["docker", "compose", "-p", stack.name, "-f", quoted(stack.compose)];
  if (stack.join) {
    const overridePath = join(dir, `sai-companion-${stack.name}.override.yml`);
    write(overridePath, companionOverrideYaml(stack.join, network));
    parts.push("-f", quoted(overridePath));
  }
  return parts;
}
