/**
 * Who may waive human approval for a run they start.
 *
 * A caller that asks for auto-approval gets every approval-gated call of its run granted without
 * asking anyone: chat.send's `--auto` (runtime.ts replaces the turn's approval callback) and the
 * legacy A2A route's `autoApprove: true` (an approval callback that says yes to every call). So the
 * request is only as safe as the role behind it. `gateway.overrides.autoApproveMinRole` names the
 * lowest role whose request is honoured, compared by rank (an extension role ranks where its
 * manifest puts it), or "disabled" to honour no one. The default, "operator", is the behaviour
 * before the key existed. Below the floor `--auto` starts no turn, and the legacy route ignores
 * `autoApprove`, so its approval-gated calls fail closed.
 *
 * Under multi-user auth the caller's role decides. With auth off there is one operator and no roles
 * to rank: a request is honoured, as before, unless the key is "disabled".
 */
import { getConfig } from "../config/loader.js";
import { roleRank } from "./auth.js";

export type AutoApproveMinRole = "viewer" | "operator" | "admin" | "disabled";

const DEFAULT_MIN_ROLE: AutoApproveMinRole = "operator";

/** The configured floor; the default when the config holds none. */
export function autoApproveMinRole(): AutoApproveMinRole {
  return getConfig().gateway?.overrides?.autoApproveMinRole ?? DEFAULT_MIN_ROLE;
}

/**
 * Whether a caller holding `role` may have a run's approvals granted without asking anyone.
 * `role` is the caller's resolved role; an unknown or missing one never meets the floor under
 * multi-user auth.
 */
export function mayAutoApprove(role: string | undefined): boolean {
  const floor = autoApproveMinRole();
  if (floor === "disabled") return false;
  if (getConfig().auth?.enabled !== true) return true;
  if (!role) return false;
  return roleRank(role) >= roleRank(floor);
}
