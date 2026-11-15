/**
 * The compose files of this stack, as the `-f` arguments `sai` (scripts/sai.mjs) passes to every
 * `docker compose` call it makes with files: `sai start` (build, up, `--fresh`'s down) and `sai stop`.
 *
 * Docker Compose reads a docker-compose.override.yml next to docker-compose.yml on its own only when
 * it is given no `-f` at all. `sai` passes `-f` (it adds overlays such as docker-compose.gpu.yml), so
 * Compose silently left the override out: an operator's or a fork's adjustments never reached the
 * containers `sai start` created, and `sai stop` did not know the services it added.
 */
import { existsSync } from "node:fs";

export const BASE_COMPOSE_FILE = "docker-compose.yml";
export const OVERRIDE_COMPOSE_FILE = "docker-compose.override.yml";

/**
 * `-f` arguments: the base file, then `overlays` in order, then docker-compose.override.yml when it
 * exists. The override comes last so the operator's own file has the final word over everything this
 * repository ships, overlays included. Paths are relative to the working directory, which `sai`
 * sets to the repository root.
 *
 * @param {string[]} [overlays] compose files `sai` adds for this run, e.g. docker-compose.gpu.yml
 * @param {{ exists?: (path: string) => boolean }} [io]
 * @returns {string[]}
 */
export function composeFileArgs(overlays = [], { exists = existsSync } = {}) {
  const files = [BASE_COMPOSE_FILE, ...overlays];
  if (exists(OVERRIDE_COMPOSE_FILE)) files.push(OVERRIDE_COMPOSE_FILE);
  return files.flatMap((file) => ["-f", file]);
}
