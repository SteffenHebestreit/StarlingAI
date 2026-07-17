<!-- GENERATED FILE — do not edit by hand. Regenerate with `pnpm docs:reference`.
     Source of truth: packages/core/src/runtime/deployment-mode.ts (evaluateDeploymentReadiness). CI fails when this file drifts from the code. -->


# Deployment modes and their readiness guarantees

`/readyz` fails closed: a REQUIRED dependency that is unavailable makes the gateway not-ready. The reasons below are the exact strings the readiness probe reports.

## `single_process`

| Dependency | Required | Rationale |
| --- | --- | --- |
| redis | no | Single-process mode permits local coordination. |
| postgres | no | Single-process mode permits ephemeral local state. |
| authentication | no | Authentication is optional outside untrusted multi-tenant mode. |

## `trusted_cluster`

| Dependency | Required | Rationale |
| --- | --- | --- |
| redis | **yes** | Clustered coordination requires Redis; process-local swarm fallback is unsafe. |
| postgres | **yes** | Clustered state requires PostgreSQL; in-memory fallback is unsafe. |
| authentication | no | Authentication is optional outside untrusted multi-tenant mode. |

## `untrusted_multi_tenant`

| Dependency | Required | Rationale |
| --- | --- | --- |
| redis | **yes** | Clustered coordination requires Redis; process-local swarm fallback is unsafe. |
| postgres | **yes** | Clustered state requires PostgreSQL; in-memory fallback is unsafe. |
| authentication | **yes** | Untrusted multi-tenant mode requires authentication before serving shared resources. |
