/**
 * Whose scene and job runs an account may see and act on (found in review, 2026-10-08).
 *
 * The job store holds every account's runs, each with the user it ran as and the answer it gave.
 * GET /api/scenes/jobs and /api/scenes/jobs/:jobId returned all of them, raw user id included, to
 * any signed-in account, and any account could cancel or delete any of them. Under multi-user auth
 * an account now sees and acts on the runs made as itself; an admin sees and acts on every run.
 * Only an admin is sent the user a run was made as. A run made as no account (a webhook trigger,
 * a schedule) is an admin's alone. With one operator every run is theirs and goes out as stored.
 */
import { authenticatedUser, userHasRole } from "./auth.js";
import { getConfig } from "../config/loader.js";
import type { SceneJob } from "../agent/jobs.js";

/** Who is asking about scene jobs. */
export interface SceneJobViewer {
  /** Every run is theirs to see and act on: one operator, or an admin. */
  all: boolean;
  /** Under multi-user auth, the username a non-admin's own runs were made as. */
  userId?: string;
}

/** The viewer the request's caller is. A config that cannot be read counts as multi-user. */
export async function sceneJobViewer(authHeader: string | undefined): Promise<SceneJobViewer> {
  let multiUser = true;
  try {
    multiUser = getConfig().auth?.enabled === true;
  } catch { /* fail closed */ }
  if (!multiUser) return { all: true };
  const user = await authenticatedUser(authHeader);
  if (userHasRole(user, "admin")) return { all: true };
  return user?.username ? { all: false, userId: user.username } : { all: false };
}

/** Whether the viewer may see, cancel or delete this run. */
export function canSeeSceneJob(viewer: SceneJobViewer, job: Pick<SceneJob, "userId">): boolean {
  return viewer.all || (viewer.userId !== undefined && job.userId === viewer.userId);
}

/** The run as a response carries it: without the user it ran as, unless the viewer sees every run. */
export function presentSceneJob(job: SceneJob, viewer: SceneJobViewer): SceneJob | Omit<SceneJob, "userId"> {
  if (viewer.all) return job;
  const presented: Record<string, unknown> = { ...job };
  delete presented["userId"];
  return presented as Omit<SceneJob, "userId">;
}
