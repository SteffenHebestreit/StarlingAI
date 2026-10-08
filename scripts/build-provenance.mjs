/**
 * The build identity of the gateway image: the commit it is built from and whether that tree had
 * uncommitted changes. `sai start` (scripts/sai.mjs) puts both into the environment, the compose
 * build args (docker-compose.yml) hand them to docker/gateway/Dockerfile, which stamps them into
 * the image's labels, and `pnpm e2e:env status --json` (scripts/e2e-env.mjs) reads them back off
 * the running image for the e2e harness (packages/core/src/e2e/provenance.ts).
 *
 * Twice (2026-09-05, 2026-10-06) the stack ran an image older than the code under test, and only
 * grepping the baked dist showed it. This module runs neither git nor docker itself: both come in
 * as runners, so packages/core/src/tests can follow the whole chain, from git to the harness.
 */

/** The compose build args, and the image labels the Dockerfile's runtime stage sets from them. */
export const BUILD_SHA_ARG = "SAI_BUILD_SHA";
export const BUILD_DIRTY_ARG = "SAI_BUILD_DIRTY";
export const BUILD_REVISION_LABEL = "org.opencontainers.image.revision";
export const BUILD_DIRTY_LABEL = "starlingai.build.dirty";

/** A full git object name: SHA-1, or SHA-256 in a repository that uses it. */
const COMMIT_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Sets SAI_BUILD_SHA to HEAD and SAI_BUILD_DIRTY to "true" or "false" in `env` (process.env for
 * `sai start`). Outside a git checkout it removes both, so a value left over in the shell cannot
 * label an image with a commit it was not built from.
 *
 * @param {Record<string, string | undefined>} env
 * @param {(args: string[]) => string | null} git trimmed stdout, or null when git failed
 */
export function stampBuildRevision(env, git) {
  const sha = git(["rev-parse", "HEAD"]);
  if (!sha || !COMMIT_SHA.test(sha)) {
    delete env[BUILD_SHA_ARG];
    delete env[BUILD_DIRTY_ARG];
    return;
  }
  const status = git(["status", "--porcelain"]);
  env[BUILD_SHA_ARG] = sha;
  // A status git could not produce is not a clean tree.
  env[BUILD_DIRTY_ARG] = status === "" ? "false" : "true";
}

/** What `imageFromInspect` reads: the image's build time and its labels, tab-separated. */
export const IMAGE_INSPECT_FORMAT = "{{json .Created}}\t{{json .Config.Labels}}";

/**
 * The image block of the e2e environment status (`gateway.image`): its id, when it was built, and
 * the commit and dirty flag from its labels, each null where the image carries none (built before
 * the labels, or not by `sai start`).
 *
 * @param {string} id
 * @param {string | null} inspected the IMAGE_INSPECT_FORMAT output, or null when the inspect failed
 */
export function imageFromInspect(id, inspected) {
  const [created, labels] = (inspected ?? "").split("\t").map((part) => {
    try { return JSON.parse(part); } catch { return null; }
  });
  const label = (key) => (labels && typeof labels === "object" && typeof labels[key] === "string" && labels[key] ? labels[key] : null);
  const dirty = label(BUILD_DIRTY_LABEL);
  return {
    id,
    created: typeof created === "string" && created ? created : null,
    revision: label(BUILD_REVISION_LABEL),
    dirty: dirty === "true" ? true : dirty === "false" ? false : null,
  };
}

/**
 * The image a container runs; null without a container, or when docker cannot name its image.
 *
 * @param {(args: string[]) => { ok: boolean, out: string }} docker
 * @param {string | null} container
 */
export function imageOfContainer(docker, container) {
  if (!container) return null;
  const id = docker(["inspect", "--format", "{{.Image}}", container]);
  if (!id.ok || !id.out) return null;
  const meta = docker(["image", "inspect", "--format", IMAGE_INSPECT_FORMAT, id.out]);
  return imageFromInspect(id.out, meta.ok ? meta.out : null);
}
