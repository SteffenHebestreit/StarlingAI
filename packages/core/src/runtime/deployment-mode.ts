export const DEPLOYMENT_MODES = ["single_process", "trusted_cluster", "untrusted_multi_tenant"] as const;
export type DeploymentMode = typeof DEPLOYMENT_MODES[number];

export interface DeploymentReadinessInput {
  mode: DeploymentMode;
  redisAvailable: boolean;
  postgresAvailable: boolean;
  authEnabled: boolean;
}

export interface DeploymentDependencyStatus {
  name: "redis" | "postgres" | "authentication";
  required: boolean;
  available: boolean;
  reason: string;
}

export interface DeploymentReadiness {
  mode: DeploymentMode;
  ready: boolean;
  dependencies: DeploymentDependencyStatus[];
}

/**
 * Classify topology readiness without touching infrastructure. Clustered modes
 * must never silently fall back to process-local coordination or unauthenticated
 * shared state; single-process mode intentionally keeps that development path.
 */
export function evaluateDeploymentReadiness(input: DeploymentReadinessInput): DeploymentReadiness {
  const clustered = input.mode !== "single_process";
  const multiTenant = input.mode === "untrusted_multi_tenant";
  const dependencies: DeploymentDependencyStatus[] = [
    {
      name: "redis",
      required: clustered,
      available: input.redisAvailable,
      reason: clustered
        ? "Clustered coordination requires Redis; process-local swarm fallback is unsafe."
        : "Single-process mode permits local coordination.",
    },
    {
      name: "postgres",
      required: clustered,
      available: input.postgresAvailable,
      reason: clustered
        ? "Clustered state requires PostgreSQL; in-memory fallback is unsafe."
        : "Single-process mode permits ephemeral local state.",
    },
    {
      name: "authentication",
      required: multiTenant,
      available: input.authEnabled,
      reason: multiTenant
        ? "Untrusted multi-tenant mode requires authentication before serving shared resources."
        : "Authentication is optional outside untrusted multi-tenant mode.",
    },
  ];

  return {
    mode: input.mode,
    ready: dependencies.every((dependency) => !dependency.required || dependency.available),
    dependencies,
  };
}