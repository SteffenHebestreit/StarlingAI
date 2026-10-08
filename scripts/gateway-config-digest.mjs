/**
 * Digests of the config files the running gateway reads: the compiled starlingai.json
 * (SAI_CONFIG_PATH, bind-mounted from the host) and its runtime overlay (SAI_MUTABLE_CONFIG_PATH:
 * the dashboard's model preset and every other change made at runtime). `pnpm e2e:env status
 * --json` (scripts/e2e-env.mjs) reports them, and the e2e harness lists a difference between two
 * runs (packages/core/src/e2e/provenance.ts): a flag flipped in a gitignored *.local.jsonc shard,
 * or a preset switched on the dashboard, changes neither the image nor the checkout, and a
 * comparison across it read "same gateway image and harness commit".
 *
 * The files are read inside the container, so the digests are of the gateway's own view of them.
 * Only the digests leave it.
 */

/**
 * Runs in the gateway container (`node -e`) and prints {"compiled": …, "overlay": …}: each the
 * file's sha256, "absent" when there is no such file (no runtime change was ever saved), or null
 * when the variable is unset or the file cannot be read.
 */
export const CONFIG_DIGEST_SCRIPT = [
  'const { createHash } = require("node:crypto");',
  'const { existsSync, readFileSync } = require("node:fs");',
  "const digest = (path) => {",
  "  if (!path) return null;",
  '  if (!existsSync(path)) return "absent";',
  '  try { return createHash("sha256").update(readFileSync(path)).digest("hex"); } catch { return null; }',
  "};",
  "process.stdout.write(JSON.stringify({ compiled: digest(process.env.SAI_CONFIG_PATH), overlay: digest(process.env.SAI_MUTABLE_CONFIG_PATH) }));",
].join("\n");

const DIGEST = /^[0-9a-f]{64}$/;

/**
 * The config block of the e2e environment status (`gateway.config`); null without a container, or
 * when it gave no readable answer.
 *
 * @param {(args: string[]) => { ok: boolean, out: string }} docker
 * @param {string | null} container
 */
export function configOfContainer(docker, container) {
  if (!container) return null;
  const result = docker(["exec", container, "node", "-e", CONFIG_DIGEST_SCRIPT]);
  if (!result.ok) return null;
  let answer;
  try { answer = JSON.parse(result.out); } catch { return null; }
  if (!answer || typeof answer !== "object") return null;
  const digest = (value) => (typeof value === "string" && (DIGEST.test(value) || value === "absent") ? value : null);
  return { compiled: digest(answer.compiled), overlay: digest(answer.overlay) };
}
