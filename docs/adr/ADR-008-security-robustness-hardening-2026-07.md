# ADR-008: Security & robustness hardening wave (audit redaction, sandbox/CSP, network isolation, mail per-user authz)

**Status:** accepted (implemented 2026-07-21)
**Date:** 2026-07-21
**Scope:** `v0.46.2`. A cross-cutting hardening wave plus the fixes surfaced by a
full `/code-review` of the wave before release. This ADR records the decisions
so later work does not silently undo them or re-litigate the tradeoffs.

## Context

The wave tightened several untrusted-input boundaries at once — agent-authored
HTML previews, generated apps on the Docker network, shell/script access to
workspace secrets, audit-log persistence, mail per-user access, and internal
service-to-service auth — and removed provider chain-of-thought from every
client/persistence path. A recall-oriented review of the wave found real
regressions introduced by the tightening itself (a strict CSP that blanked every
generated artifact, a sidecar that lost outbound egress, health checks that
would 401 forever, guard regexes that were trivially bypassable). This document
captures both the intended end state and the tradeoffs deliberately kept.

## Decisions

### 1. Chain-of-thought never leaves the server

Provider reasoning is captured only as **counts** (`reasoningChars`,
`reasoningCaptured: true`) — never the raw text — in audit events, and is no
longer streamed to the dashboard or forwarded to sub-agent progress. The stream
collector is the single enforcement point: `collectStream` is not passed an
`onReasoning` sink, so nothing downstream can emit CoT.

- **Kept:** the enforcement lives at the producer (stream collection), not at
  each consumer.
- **Follow-up (not blocking):** the consumer-side plumbing (`onReasoning` option
  in `turn-types.ts`, the `agent.reasoning`/`THINKING_TEXT_MESSAGE_CONTENT`
  emitters in `rpc.ts`/`agui.ts`, and the web store's now-empty handler + dead
  `streamingReasoning` refs) is **dead but retained** this release. It is a
  latent re-enable risk: any future call that passes `onReasoning` would resume
  streaming raw CoT. Delete the option and both emitters end-to-end when the
  reasoning UI is next touched. Note the AG-UI `THINKING_TEXT_MESSAGE_CONTENT`
  event is a protocol-visible surface — removing it needs a protocol/docs note.

### 2. Untrusted generated apps get their own Docker network

`serve_app` containers now default to `starlingai-app` (isolated bridge, internet
egress allowed, cannot resolve mail/database/control-plane sidecars). The gateway
joins it solely to reverse-proxy.

- **Correction made in review:** `mail-service` had been dropped from
  `starlingai-public` and left only on `starlingai-internal`, which is
  `internal: true` (no egress) — this severed all external IMAP/SMTP. Since the
  isolation goal is already met by the app-network move, mail-service was
  **restored to `starlingai-public`**; untrusted apps can no longer reach it
  because they are on `starlingai-app`, not `public`.
- **Known boundary (documented, not a regression):** the gateway — the control
  plane itself — is reachable from `starlingai-app` (it must be, to proxy the
  app). The compose comment's "cannot resolve control-plane sidecars" refers to
  mail/db/redis, not the gateway. A generated app can reach `http://gateway:8765`;
  that exposure is unchanged from the previous `starlingai-public` arrangement.
- **Follow-up:** `serve_app` has no network-existence fallback, so a partial
  upgrade (`docker compose restart` without `up`, or a hot-swapped gateway
  image) can fail with `network starlingai-app not found`. A full
  `docker compose up` creates it. Add an auto-create/pre-flight if this bites.

### 3. Agent-authored HTML previews: sandbox + CSP

Previews render in a sandboxed iframe (`allow-scripts` only — **no**
`allow-same-origin`, so the artifact has an opaque origin and cannot reach the
dashboard origin or its token storage) plus a defense-in-depth CSP.

- **CSP relaxed in review** to `WORKSPACE_PREVIEW_CSP` (one shared const in
  `workspace-routes.ts`). The original `default-src 'self' data: blob:` with no
  `'unsafe-inline'` and no CDN blanked **every** generated artifact — decks,
  docs, and charts are built with inline `<script>`/`<style>` and load
  reveal.js/chart.js/mermaid/highlight.js from `cdn.jsdelivr.net`. The kept CSP
  allows inline + that CDN for script/style/font/img while keeping
  `form-action 'none'`, `object-src 'none'`, `base-uri 'none'`, and a restricted
  `connect-src`. **`frame-ancestors` was dropped** so the dashboard can embed the
  preview even when served from a different origin (e.g. `pnpm web:dev` on :3001
  → gateway :8765); origin isolation is already enforced by the sandbox.
- **Known tradeoff (accepted):** removing `allow-same-origin` breaks **multi-file
  site** previews — relative CSS/images/sub-pages rely on the `SameSite=Lax`
  `sai_site_token` cookie, which an opaque-origin document will not send.
  Single-file artifacts (the common case: decks, docs, charts) render correctly.
  The security win (artifact cannot escape its sandbox) outweighs multi-file
  preview fidelity. **Follow-up:** re-enable multi-file previews via a
  non-cookie auth mechanism (token in each sub-resource URL, or a
  service-worker), not by restoring `allow-same-origin`.
- **Follow-up:** the `/api/app/:id/*` live-app proxy still strips the upstream
  CSP and sets none, and can be opened as a top-level tab. It was left untouched
  because served apps are full interactive apps and a blanket CSP would break
  their own fetch/inline needs — a per-app policy is the right fix, tracked
  separately.

### 4. Shell / script guards reuse the canonical denylist

`shell_exec` and `run_script` block references to workspace secrets/VCS internals
by **tokenizing the command and reusing `isSensitiveWorkspacePath`** (the same
denylist the file tools use) instead of a second hand-rolled regex set.

- **Why:** the review found the hand-rolled regexes both over- and under-matched
  — they blocked `.env.example` (the public template the file tools allow) yet
  let `./.env`, `sub/.env`, `.env|base64`, and `tar czf x .git` through, and they
  drifted from the file-tool denylist. Reusing one denylist fixes all of these
  and keeps the two guards in sync. `run_script` now also scans its `args`.
- **Known limit (accepted):** this is string-level, not a shell parser. Variable
  indirection (`X=.env; cat $X`) and script **contents** (`run_script` on a
  benign `.sh` that itself reads `.env`) are out of scope. Both sandboxes run
  `--network=none`, so the residual risk is a secret landing in tool output/model
  context, not network exfil. **The deeper fix is the mount layer** — shadow-mount
  the sensitive paths out of the sandbox container so they are not visible at all;
  the string guard is defense-in-depth until then.

### 5. Audit-log redaction is a single choke point

`sanitizeAuditData` in `logAudit` redacts credential-shaped **keys** (anchored
name match — deliberately does **not** match `promptTokens`/`totalTokens`, which
are numeric cost telemetry) and runs string leaves through the shared
`scanOutput` secret scanner, wrapped in try/catch so a least-privilege plugin
worker's missing scanner config can never turn an audit event into a gateway
failure.

- **Corrections made in review:**
  - Non-plain objects (`Date`, `Buffer`/TypedArray, `Map`, `Set`) now pass
    through untouched so `JSON.stringify` serializes them natively; the previous
    `Object.entries` rebuild flattened a `Date` to `{}` and exploded a `Buffer`
    into a per-byte object.
  - The free-form `channel` field is now value-scanned. `sessionId`/`userId`
    remain verbatim — they are identity keys the audit trail exists to record,
    and redacting them would break per-user audit filtering (PII
    pseudonymization, where required, is a separate extension-hook concern).
- **Follow-up (accepted debt):** the key-name pattern is now the 5th independent
  secret-key list in the codebase (alongside `guardrails/output.ts`,
  `config-assistant.ts`, `print-effective-config.ts`, `credentials/channels.ts`)
  and misses camelCase compounds (`accessToken`, `imapPassword`). It should be
  consolidated into one shared, camelCase-aware definition; until then the value
  scanner is the backstop for those keys.
- **Observability:** `getAuditWriteStatus` is now wired into
  `runSubsystemChecks` / `/api/health/subsystems` as an `audit` check (failed
  fire-and-forget writes were previously an unobservable silent-degradation).

### 6. Mail per-user authorization is batch-atomic

`categorize`, `move`, and `delete` authorize **every** account in a mixed-account
batch before mutating any of them, so an unauthorized later item cannot leave
earlier groups already moved/deleted (irreversible for permanent delete).

- **Follow-up (accepted debt):** authorization is still hand-rolled at ~23 call
  sites across `app.ts`/`calendar-routes.ts`/contacts — the exact per-route
  pattern that produced the original `categorize` hole. The right altitude is one
  Hono middleware that extracts every `accountId` from the validated request
  shape and authorizes it against `x-sai-user` before the handler runs. Deferred
  as a focused refactor.

### 7. Internal service tokens are mandatory (fail-closed)

`SAI_MAIL_SERVICE_TOKEN` and `SAI_COMPUTER_REMOTE_TOKEN` use compose `${VAR:?}`
so an internal sidecar can never start open merely because it shares a network.
`pnpm sai setup` generates both (32-byte), and now **only fills them when empty**
— it will not rotate an operator's deliberately-set value out from under a
running container.

- **Corrections made in review:**
  - Both sidecars registered `/health` behind their `app.use("*")` bearer gate,
    so with the token now mandatory the no-auth compose healthcheck would 401
    forever and the container would sit permanently `unhealthy`. `/health` is now
    **exempted** in both the mail-service and computer-remote middleware.
- **`${VAR:?}` is the correct pattern** — `SAI_JWT_SECRET`, `SAI_MASTER_KEY`, and
  `POSTGRES_PASSWORD` already use it. It makes **every** compose subcommand
  (including `down`/`logs`) abort when the var is unset, which is the intended
  fail-closed posture *provided* `sai` populates the value first (the `:?` message
  itself says "run pnpm sai start first — it generates .env").
- **Bug found in practice (fixed in v0.46.3):** unlike the older secrets, the two
  new tokens were only written on **first-run** setup, so a pre-existing `.env`
  never got them backfilled — and because `sai stop`/`sai start` both shell out to
  compose, the missing tokens blocked *both*, i.e. an upgraded install could
  neither start nor stop. Fix: `ensureInternalSecrets()` in `scripts/sai.mjs`
  generates any missing/empty required token into `.env` before every compose
  invocation in both `cmdStart` and `cmdStop` (idempotent; never overwrites an
  existing value). This is the general "sai owns the lifecycle of its required
  secrets" rule — **any future `${VAR:?}` compose secret must be added to
  `ensureInternalSecrets` in the same change**, or it will break the upgrade path
  the same way.
- **Follow-up:** the `${VAR:?}` guard covers only these two tokens; sibling
  internal secrets (`SAI_N8N_SSH_PASSWORD`, `MEMGRAPH_PASSWORD`, `SEARXNG_SECRET`,
  `KC_BOOTSTRAP_ADMIN_PASSWORD`) still default to empty/shipped values. Driving
  the full internal-secret set from the wizard + a uniform pre-flight is the
  general fix.

### 8. Redis eviction policy: `noeviction`, kept

Redis holds task leases, mission budgets, and delivery coordination; evicting one
of those keys duplicates effects. The policy is therefore `noeviction` at
`maxmemory 256mb` (kept well below the 512m container `mem_limit` to leave room
for Redis overhead/fragmentation — do **not** raise `maxmemory` to match
`mem_limit`).

- **Accepted tradeoff:** under memory pressure Redis hard-rejects writes
  (`OOM command not allowed`) rather than silently dropping correctness state, and
  with `appendonly` the state survives restart. This is correct for the
  correctness keyspaces. It is only safe because the cache-flavored keyspaces
  sharing the instance (session snapshots, scratch) carry **TTLs** and expire on
  their own rather than accumulating.
- **Rule for future work:** any new Redis keyspace must either be correctness
  state (fine) or carry a TTL (never rely on eviction). If sustained volume
  approaches the cap, scale `mem_limit` **and** `maxmemory` together, or split the
  cache keyspace onto a separate `allkeys-lru` instance — do not switch this
  instance back to `allkeys-lru`.

### 9. Local-only auth config stays out of git

`config/gateway/30-auth.jsonc` is committed as the safe default (`enabled: true`
only). Machine-specific OIDC config — a private issuer, dev
`insecureSkipTlsVerify: true`, `defaultRole: admin` — **must** live in the
git-ignored `config/gateway/30-auth.local.jsonc` override, never in the tracked
shard (docs/iam-sso-oidc.md and .gitignore state this). The tracked shard shipped
in this release is the safe default; any working-tree OIDC block is intentionally
uncommitted.

## Consequences

- Generated single-file previews (decks/docs/charts) render again; multi-file
  site previews are a known, tracked limitation.
- External mail works; internal sidecars are fail-closed and correctly report
  health.
- Shell/script secret guards are consistent with the file-tool denylist; the
  mount-layer defense is the next step.
- Audit persistence is redacted at one choke point and observable via
  `/api/health/subsystems`.
- Several items are explicitly deferred (listed as follow-ups above) rather than
  half-solved: reasoning-plumbing removal, mail authz middleware, secret-key-list
  consolidation, `/api/app` CSP, and the mount-layer shell guard.
