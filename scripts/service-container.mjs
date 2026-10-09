/**
 * One compose service's container in a project, as `docker ps` shows it, for the e2e environment
 * status (scripts/e2e-env.mjs): its own test services, the mail-service, and the stack's reranker.
 * This module runs no docker itself: the runner comes in, so packages/core/src/tests can drive it.
 */

/**
 * The container's name, its state, and its health as Docker's healthcheck last saw it ("healthy",
 * "unhealthy" or "health: starting"; "no healthcheck" while it runs without one, "-" while it does
 * not run). null when the project has no container for the service.
 *
 * A `docker ps` that failed is { error }, not null. For a service the stack may run without (the
 * reranker, behind the rag profile) no container reads as fine, so a docker that could not be asked
 * must not look like one.
 *
 * @param {(args: string[]) => { ok: boolean, out: string, err: string }} docker
 * @param {string} project
 * @param {string} service
 * @returns {{ name: string, state: string, health: string } | { error: string } | null}
 */
export function serviceContainer(docker, project, service) {
  const r = docker(["ps", "-a", "--filter", `label=com.docker.compose.project=${project}`, "--filter", `label=com.docker.compose.service=${service}`,
    "--format", "{{.Names}}\t{{.State}}\t{{.Status}}"]);
  if (!r.ok) return { error: r.err.split("\n")[0] || "docker ps failed" };
  const [name, state, status] = (r.out.split("\n")[0] ?? "").split("\t");
  if (!name) return null;
  const health = /\((healthy|unhealthy|health: starting)\)/.exec(status ?? "")?.[1] ?? (state === "running" ? "no healthcheck" : "-");
  return { name, state, health };
}
