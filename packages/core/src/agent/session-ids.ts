/**
 * Session ids of nested runs, and the session they belong to.
 *
 * A sub-agent run is `sub:<parent>:<agent>:<stamp>` (agent/sub-agent.ts, agent/container-entrypoint.ts),
 * a workflow run `workflow:<parent>:<scene>:<uuid>` (tools/workflow-catalog.ts). The parent may itself
 * be nested, and an ephemeral agent's name carries its own colon: `ephemeral:<name>`
 * (tools/ephemeral-agent-factory.ts). Seven hand-rolled copies of this parse cut at the last two
 * colons, so an ephemeral run resolved to `<parent>:ephemeral`: its shared findings went to a session
 * nobody else reads, and its audit events, steering and operator stops missed their turn (2026-10-07).
 */

/** The namespace of agents the ephemeral-agent factory mints; part of the agent name, not the parent. */
const EPHEMERAL_NAMESPACE = "ephemeral";

/**
 * The session a nested run was started from, or null when `sessionId` carries none of `prefixes`.
 * A degenerate id without the full `<parent>:<name>:<stamp>` tail resolves to its body.
 */
export function parentSessionOf(sessionId: string, prefixes: readonly string[] = ["sub:"]): string | null {
  const prefix = prefixes.find((candidate) => sessionId.startsWith(candidate));
  if (!prefix) return null;
  const inner = sessionId.slice(prefix.length);
  const stampAt = inner.lastIndexOf(":");
  if (stampAt <= 0) return inner;
  let nameAt = inner.lastIndexOf(":", stampAt - 1);
  if (nameAt <= 0) return inner;
  if (prefix === "sub:") {
    const namespaceAt = inner.lastIndexOf(":", nameAt - 1);
    if (namespaceAt > 0 && inner.slice(namespaceAt + 1, nameAt) === EPHEMERAL_NAMESPACE) nameAt = namespaceAt;
  }
  return inner.slice(0, nameAt);
}

/**
 * The session a nested run belongs to: follow `sub:` hops (and `workflow:` hops too when passed in
 * `prefixes`) back to the first id that is neither.
 */
export function rootSessionOf(sessionId: string, prefixes: readonly string[] = ["sub:"]): string {
  let current = sessionId;
  for (;;) {
    const parent = parentSessionOf(current, prefixes);
    if (parent === null || parent === current) return current;
    current = parent;
  }
}
