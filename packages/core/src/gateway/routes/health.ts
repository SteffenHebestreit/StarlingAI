import type { Hono } from "hono";
import { verifyToken, extractBearerToken } from "../auth.js";
import { getAllSessions } from "../../agent/session.js";
import { getEventLoopLagSnapshot } from "../../observability/event-loop-monitor.js";
import { getLastProviderActivitySnapshot } from "../../observability/provider-activity-monitor.js";
import { PRODUCT } from "../../product/index.js";
import { listExtensionRoles, listLoadedExtensions } from "../../extension/index.js";
import { getConfig } from "../../config/loader.js";
import { probeEphemeralBackends } from "../../runtime/ephemeral-store/index.js";
import { evaluateDeploymentReadiness } from "../../runtime/deployment-mode.js";

/**
 * Health / readiness / diagnostic endpoints.
 *
 * Extracted verbatim from createGateway() as a pure, behavior-preserving move.
 * These handlers depend ONLY on module-level imports (no createGateway closure
 * state), so the registrar takes just the Hono `app`. Registration order is
 * preserved by the single call site in createGateway().
 */
export function registerHealthRoutes(app: Hono): void {
  // ── Health endpoints ─────────────────────────────────────────────────────
  app.get("/healthz", (c) => c.json({ status: "ok" }));

  // Product identity for the web shell (name, tagline, theme) plus
  // extension-contributed role metadata for badges. Public and unauthenticated
  // by design: the login screen renders branding before any token exists.
  // Forks override via product.json (docs/fork-boilerplate-plan.md).
  app.get("/api/product", (c) =>
    c.json({
      name: PRODUCT.name,
      slug: PRODUCT.slug,
      tagline: PRODUCT.tagline,
      // The web shell shows the on-disk token path ("~/<stateDir>/token") on the
      // login screen, so the state-dir name is part of the identity it needs —
      // otherwise a fork's UI would still print upstream's ".starlingai".
      stateDirName: PRODUCT.stateDirName,
      theme: PRODUCT.theme,
      roles: listExtensionRoles(),
      extensions: listLoadedExtensions().map((e) => ({ name: e.name, version: e.version, description: e.description })),
    })
  );
  app.get("/readyz", async (c) => {
    const sessions = getAllSessions().length;
    const config = getConfig();
    const mode = config.deployment.mode;
    // Do not start optional backends solely to answer local liveness. In cluster
    // modes the probes are LIVE (PING / SELECT 1 against the boot-time clients),
    // so a post-boot Redis/Postgres outage fails readiness instead of reusing
    // cached init results.
    const clustered = mode !== "single_process";
    const backends = clustered
      ? await probeEphemeralBackends()
      : { redis: false, postgres: false };
    const readiness = evaluateDeploymentReadiness({
      mode,
      redisAvailable: backends.redis,
      postgresAvailable: backends.postgres,
      authEnabled: config.auth?.enabled === true,
    });
    // Annotate each dependency with whether a live probe actually ran, so
    // operators can distinguish "probed and down" from "not probed (optional
    // in this mode)" — in single_process mode redis/postgres are skipped and
    // authentication availability always comes from config, not a probe.
    const deployment = {
      ...readiness,
      dependencies: readiness.dependencies.map((dependency) => ({
        ...dependency,
        probed: clustered && dependency.name !== "authentication",
      })),
    };
    // Latest event-loop lag sample (cheap, no probes) so operators can poll
    // whether the main thread is stalling without hitting the authed deep checks.
    const eventLoopLag = getEventLoopLagSnapshot();
    // In-flight provider activity (is the remote LLM producing / prefilling / stalled).
    // Use the READ-ONLY snapshot (the background sampler keeps it fresh) so polling
    // /readyz can't drive monitor-state mutation, and REDACT the in-flight model id —
    // /readyz is unauthenticated, so it must not let anyone enumerate which model the
    // org runs. Expose only the aggregate readiness signal (count + worst state/age).
    const activity = getLastProviderActivitySnapshot();
    const providerActivity = activity
      ? {
          sampledAt: activity.sampledAt,
          inFlight: activity.inFlight,
          worst: activity.worst ? { state: activity.worst.state, elapsedMs: activity.worst.elapsedMs } : null,
        }
      : null;
    return c.json({
      status: deployment.ready ? "ready" : "not_ready",
      sessions,
      deployment,
      ...(eventLoopLag ? { eventLoopLag } : {}),
      ...(providerActivity ? { providerActivity } : {}),
    }, deployment.ready ? 200 : 503);
  });

  // Deep subsystem self-checks (authed) — actively probe embeddings (non-zero
  // vectors), pgvector, MemGraph, and QuestDB telemetry so SILENT degradation
  // (e.g. all-zero embeddings) becomes visible instead of failing quietly.
  // Kept off /healthz so the Docker liveness probe stays cheap and stable.
  app.get("/api/health/subsystems", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const { runSubsystemChecks } = await import("../../observability/health-checks.js");
    const report = await runSubsystemChecks();
    return c.json(report, report.healthy ? 200 : 503);
  });

  // Recovery-net firing counts (authed). Shows which of the ~34 orchestration
  // autopilots actually fire — the evidence needed to retire dead scaffolding.
  app.get("/api/observability/recovery-nets", async (c) => {
    const token = extractBearerToken(c.req.header("Authorization"));
    if (!token || !await verifyToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const { getRecoveryMetricsSnapshot, getStaleNetsReport } = await import("../../observability/recovery-metrics.js");
    // ?staleDays=N tunes the retirement window (default 30): nets whose LAST firing is
    // older than the window are retirement candidates (counters persist across restarts,
    // so the clock is real — windowCovered says whether counting spans the window yet).
    const staleDaysRaw = Number(c.req.query("staleDays"));
    const staleDays = Number.isFinite(staleDaysRaw) && staleDaysRaw > 0 ? staleDaysRaw : 30;
    return c.json({ ...getRecoveryMetricsSnapshot(), stale: getStaleNetsReport(staleDays) });
  });
}
