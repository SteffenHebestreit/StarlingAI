# ADR-007: Plugin isolation process model and capability RPC

**Status:** proposed (design for `SEC-105` full slice; requires approval before implementation per the dev plan's governance rule. The first slice — plugins default-off + digest-less trust warning — already shipped.)
**Date:** 2026-07-16
**Plan reference:** [agent-swarm-development-plan-2026-07.md](../agent-swarm-development-plan-2026-07.md) — P0 "Third-party plugins execute before approval containment", package `SEC-105`.

## Context

`plugin/loader.ts` imports arbitrary plugin JavaScript with native ESM `import()` **inside the gateway process**. Module-level code runs before validation and before any Tier-2 approval gate; a compromised plugin is gateway code execution with access to process secrets (JWT secret, provider keys) and internal networks. Defaulting plugins off (shipped) contains the default posture but not the enabled one.

## Decision

### Trust before load

- **Manifest first:** a plugin directory must carry a data-only `plugin.manifest.json` (name, version, entry, declared tools with schemas, requested capabilities: network hosts, filesystem paths, env vars). The manifest is parsed and validated WITHOUT importing any plugin code.
- **Digest pinning:** trust is recorded against the content digest (sha256 over the plugin tree, sorted paths). The operator approves `name@version#digest` once; any byte change invalidates the receipt and returns the plugin to untrusted/unloaded. Optional signature verification layers on top for registries.

### Process isolation

- Plugin code runs in a **separate worker process per plugin** (Node `child_process` with a minimal env — no gateway secrets, no `REDIS_URL`/`DATABASE_URL`; container isolation via the existing `docker-socket-proxy` path is the hardened tier for `untrusted_multi_tenant` mode).
- The worker gets a **capability-scoped RPC surface** over stdio (JSON-RPC): only the manifest-declared capabilities are bridged (fetch restricted to declared hosts, fs restricted to declared subtree, no env access beyond declared vars). The gateway-side bridge enforces the grants; the worker cannot reach anything it didn't declare.
- Tool invocation flows gateway → RPC request → worker handler → RPC response, with per-call timeout, memory cap (`--max-old-space-size`), and crash containment: a plugin crash/timeout/OOM fails that call and marks the plugin degraded — it never terminates the gateway.
- Tool-tier approval remains **in addition to** load-time trust (defense in depth, per the plan).

### Compatibility

The existing in-process SDK (`definePlugin`/`defineTool`) keeps its authoring surface; the loader gains a versioned RPC shim so v1 plugins run unmodified inside the worker unless they relied on gateway globals. A compatibility scanner flags such reliance at trust time. A `trustedLegacyInProcess` escape hatch (explicit per-plugin operator opt-in, loud warning, sunset date) covers plugins that cannot migrate immediately — never available in `untrusted_multi_tenant` mode.

## Acceptance (from the plan)

- Import-time side effects cannot affect the gateway; a plugin cannot read gateway env secrets or call ungranted tools/network/files.
- Changing one byte invalidates the trust receipt.
- Plugin crash, timeout, and memory exhaustion never terminate the gateway.
