/**
 * The boot check of the `allowedUsers` lists the gateway enforces (guardrails/resource-access.ts).
 *
 * Under multi-user auth a bare entry grants only an account by its username, or a bootstrap token
 * by its `sub`; a channel sender, an A2A peer or a scene run needs `principal:<raw>`. An entry that
 * granted a Telegram id or a mail address before now grants nothing, silently. Boot names every
 * bare entry that no account, registry entry or bootstrap token holds, once, so an admin can move it
 * to the `principal:` form (or see the typo it always was). Config is never edited.
 *
 * The mail-service's lists live in its own accounts files, which the gateway does not read; the
 * same forms apply there (packages/mail-service/src/account-access.ts).
 */
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { DEFAULT_BOOTSTRAP_SUB, sameAccountId } from "../runtime/accounts.js";
import { accountRegistryBootstrapSubs, accountRegistryEntries } from "../runtime/account-registry.js";
import { ACL_ACCOUNT_PREFIX, ACL_PRINCIPAL_PREFIX } from "./resource-access.js";

const log = childLogger("guardrails:acl-entries");

/** One `allowedUsers` list and where it is configured. */
export interface AclList {
  where: string;
  entries: readonly string[];
}

/**
 * The bare entries of `lists` that name nobody who can hold them: no account username (builtin or
 * identity-provider, in any status) and no bootstrap `sub` seen. `account:` and `principal:`
 * entries are explicit and never reported.
 */
export function bareAclEntriesNamingNoAccount(lists: readonly AclList[], holders: ReadonlySet<string>): Array<{ where: string; entry: string }> {
  const found: Array<{ where: string; entry: string }> = [];
  for (const list of lists) {
    for (const raw of list.entries) {
      const entry = raw.trim();
      const lower = entry.toLowerCase();
      if (!entry || lower.startsWith(ACL_ACCOUNT_PREFIX) || lower.startsWith(ACL_PRINCIPAL_PREFIX)) continue;
      if (!holders.has(lower)) found.push({ where: list.where, entry });
    }
  }
  return found;
}

/** The `allowedUsers` lists in the gateway's own config: site credentials and computer nodes. */
function configuredAclLists(): AclList[] {
  const config = getConfig();
  const lists: AclList[] = [];
  for (const [host, site] of Object.entries(config.sites ?? {})) {
    if (site.allowedUsers?.length) lists.push({ where: `sites.${host}`, entries: site.allowedUsers });
  }
  const computerUse = (config.computerUse ?? {}) as Record<string, unknown>;
  const groups: Array<[string, unknown]> = [["computerUse.nodes", computerUse["nodes"]], ["computerUse.adapters", computerUse["adapters"]]];
  for (const [prefix, group] of groups) {
    if (!group || typeof group !== "object") continue;
    for (const [name, node] of Object.entries(group as Record<string, unknown>)) {
      const allowed = (node as { allowedUsers?: unknown } | null)?.allowedUsers;
      if (Array.isArray(allowed) && allowed.length > 0) lists.push({ where: `${prefix}.${name}`, entries: allowed.map(String) });
    }
  }
  return lists;
}

/**
 * The `allowedUsers` entries in the gateway's config that name an account: a bare entry with its
 * username, or `account:<id>` with its id. Deleting or retiring an account leaves them in place
 * (config is never edited); the reply names them, because an account created again under the name
 * gets every bare grant. The mail-service's lists are in its own files, which the gateway does not
 * read.
 */
export function aclEntriesNamingAccount(username: string, account: string | undefined): Array<{ where: string; entry: string }> {
  const name = username.trim().toLowerCase();
  const found: Array<{ where: string; entry: string }> = [];
  for (const list of configuredAclLists()) {
    for (const raw of list.entries) {
      const entry = raw.trim();
      const lower = entry.toLowerCase();
      if (lower.startsWith(ACL_PRINCIPAL_PREFIX)) continue;
      const names = lower.startsWith(ACL_ACCOUNT_PREFIX)
        ? account !== undefined && sameAccountId(entry.slice(ACL_ACCOUNT_PREFIX.length).trim(), account)
        : lower === name;
      if (names) found.push({ where: list.where, entry });
    }
  }
  return found;
}

/**
 * Logs, once per boot and only under multi-user auth, every bare `allowedUsers` entry in the
 * gateway's config that names no account. Never throws: a check that cannot run is logged too.
 */
export function reportBareAclEntries(): void {
  try {
    const config = getConfig();
    if (config.auth?.enabled !== true) return;
    const holders = new Set<string>([
      ...config.auth.users.map((user) => user.username.toLowerCase()),
      ...accountRegistryEntries().map((entry) => entry.username.toLowerCase()),
      ...accountRegistryBootstrapSubs().map((sub) => sub.toLowerCase()),
      DEFAULT_BOOTSTRAP_SUB,
    ]);
    const found = bareAclEntriesNamingNoAccount(configuredAclLists(), holders);
    if (found.length === 0) return;
    log.warn(
      { entries: found },
      "allowedUsers entries name no account: a bare name grants only an account (or a bootstrap token) of that name; a channel sender, an A2A peer or a scene run needs `principal:<raw>`, an account may be named `account:<id>`",
    );
  } catch (err) {
    log.warn({ err }, "The allowedUsers entries could not be checked against the accounts");
  }
}
