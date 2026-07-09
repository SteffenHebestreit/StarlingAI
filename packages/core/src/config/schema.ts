import { z } from "zod";
import { productEnv } from "../product/index.js";

// Domain sub-schemas extracted into config/schemas/* (pure relocation). They are
// re-exported here so the long-standing `from "../config/schema.js"` import path
// keeps resolving every moved schema/type for existing consumers.
export {
  ChannelWebChatSchema,
  ChannelTelegramSchema,
  ChannelSlackSchema,
  ChannelDiscordSchema,
  ChannelWhatsappSchema,
  ChannelEmailSchema,
  ChannelSignalSchema,
  ChannelsSchema,
} from "./schemas/channels.js";
export type {
  ChannelSlackConfig,
  ChannelDiscordConfig,
  ChannelWhatsappConfig,
  ChannelEmailConfig,
  ChannelSignalConfig,
} from "./schemas/channels.js";
export {
  MultimodalServiceSchema,
  MultimodalFileServiceSchema,
  MultimodalSpeechToTextSchema,
  MultimodalTextToSpeechSchema,
  MultimodalImageGenerationSchema,
  MultimodalWakeWordSchema,
  MultimodalSchema,
} from "./schemas/multimodal.js";
export type {
  MultimodalFileConfig,
  MultimodalSpeechToTextConfig,
  MultimodalTextToSpeechConfig,
} from "./schemas/multimodal.js";
export {
  RetrievalRerankerSchema,
  RetrievalSearchSchema,
  DocumentRagSchema,
  RetrievalSchema,
} from "./schemas/retrieval.js";
export type { DocumentRagConfig, RetrievalSearchConfig } from "./schemas/retrieval.js";
export { OrchestrationSchema } from "./schemas/orchestration.js";
export type { OrchestrationConfig } from "./schemas/orchestration.js";
export {
  EFFORT_TIERS,
  EffortTierSchema,
  EffortProfileSchema,
  EffortSchema,
} from "./schemas/effort.js";
export type { EffortProfile, EffortTier, EffortConfig } from "./schemas/effort.js";

// Value imports used to assemble ConfigSchema below.
import { ChannelsSchema } from "./schemas/channels.js";
import { MultimodalSchema } from "./schemas/multimodal.js";
import { RetrievalSchema } from "./schemas/retrieval.js";
import { OrchestrationSchema } from "./schemas/orchestration.js";
import { EffortSchema } from "./schemas/effort.js";

export const LMStudioProviderSchema = z.object({
  baseUrl: z.string().url().default("http://host.docker.internal:1234/v1"),
  apiKey: z.string().default("lm-studio"),
  timeoutMs: z.number().int().min(5000).max(300000).default(30000),
  maxRetries: z.number().int().min(0).max(5).default(3),
});

export const OpenAICompatibleProviderSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().default("local-openai"),
  timeoutMs: z.number().int().min(5000).max(300000).default(30000),
  maxRetries: z.number().int().min(0).max(5).default(3),
});

export const OllamaProviderSchema = z.object({
  baseUrl: z.string().url().default("http://host.docker.internal:11434"),
  api: z.literal("ollama-native").default("ollama-native"),
  timeoutMs: z.number().int().min(5000).max(300000).default(30000),
});

export const AnthropicProviderSchema = z.object({
  /** Anthropic API key (`sk-ant-api...`, console.anthropic.com — pay-per-use).
   *  Supports `$ENV_VAR` refs. Auto-filled from ANTHROPIC_API_KEY. */
  apiKey: z.string().optional(),
  /** OAuth bearer token (`sk-ant-oat...`), e.g. minted by Claude Code's
   *  `claude setup-token` — bills the Claude Pro/Max subscription instead of
   *  API usage. Takes precedence over apiKey. Supports `$ENV_VAR` refs.
   *  Auto-filled from ANTHROPIC_AUTH_TOKEN / CLAUDE_CODE_OAUTH_TOKEN. */
  authToken: z.string().optional(),
  baseUrl: z.string().url().default("https://api.anthropic.com"),
  /** Model used by the implicit "claude" dashboard preset when no explicit
   *  modelPresets entry overrides it. Bare Anthropic model id (no provider prefix). */
  defaultModel: z.string().default("claude-sonnet-4-6"),
  timeoutMs: z.number().int().min(5000).max(300000).default(120000),
  maxRetries: z.number().int().min(0).max(5).default(2),
});

export const ProvidersSchema = z.object({
  lmstudio: LMStudioProviderSchema.optional(),
  openaiCompatible: z.record(OpenAICompatibleProviderSchema).default({}),
  ollama: OllamaProviderSchema.optional(),
  anthropic: AnthropicProviderSchema.optional(),
});

export const ModelConfigSchema = z.object({
  primary: z.string().max(200).default("lmstudio/qwen/qwen3.6-35b-a3b"),
  fallback: z.string().max(200).optional(),
  cloudFallback: z.string().max(200).optional(),
  /** Override the provider's baseUrl for this specific model (e.g. a different LM Studio instance or vLLM endpoint). Falls back to the provider's configured baseUrl when omitted. */
  baseUrl: z.string().url().optional(),
  /** Override the provider's apiKey for this specific model endpoint. Falls back to the provider's configured apiKey when omitted. */
  apiKey: z.string().optional(),
  contextWindow: z.number().int().min(2048).max(131072).default(32768),
  temperature: z.number().min(0).max(2).default(0.3),
  maxTokens: z.number().int().min(256).max(16384).default(4096),
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().min(1).max(200).optional(),
  minP: z.number().min(0).max(1).optional(),
  repeatPenalty: z.number().min(0.5).max(2).optional(),
  seed: z.number().int().optional(),
  embeddingModel: z.string().max(200).optional(),
  /** Optional dedicated endpoint for embeddings when they must run on a separate server from the main chat model. */
  embeddingBaseUrl: z.string().url().optional(),
  /** Optional API key for the dedicated embedding endpoint. */
  embeddingApiKey: z.string().optional(),
  /** Enable or disable extended reasoning for LM Studio chat models that support
   *  chat_template_kwargs.enable_thinking (for example Qwen3.5/3.6 and Gemma 4).
   *  Defaults to `false` — thinking off — because the newer Qwen builds default
   *  to thinking-ON in the model template, which makes simple tool-driven runs
   *  burn the entire completion budget on `<think>` blocks before producing
   *  the first tool call. Opt agents back in by setting `enableThinking: true`
   *  when the work genuinely needs multi-step reasoning (mission coordinators,
   *  source verifiers, evidence reconciliation).
   *  true  → sends chat_template_kwargs: { enable_thinking: true } + Qwen
   *          recommended sampling (temp 0.6, top_p 0.95) unless explicitly overridden.
   *  false → sends chat_template_kwargs: { enable_thinking: false } + Qwen
   *          non-thinking sampling (temp 0.7, top_p 0.8) unless overridden.
   *
   *  NOTE FOR LITERAL CONSTRUCTION: this field is no longer optional in the
   *  parsed output type (`z.infer<typeof ModelConfigSchema>`). Code/tests that
   *  build a ModelConfig object inline (not via `.parse()`) MUST include
   *  `enableThinking` explicitly — the default only applies on schema parse. */
  enableThinking: z.boolean().default(false),
  /** Reasoning EFFORT for models with graded thinking (gpt-oss / o-series:
   *  low | medium | high). Family-aware (resolveThinkingControls):
   *  - gpt-oss: injected as a `Reasoning: <effort>` line in the system message
   *    (the only form LM Studio honors — it ignores the `reasoning_effort` API
   *    parameter, lmstudio-bug-tracker#988) AND sent as `reasoning_effort` in
   *    extra_body for backends that DO honor it (vLLM / OpenAI).
   *  - enable_thinking-toggle families (Qwen / GLM / DeepSeek) are on/off only via
   *    `enableThinking`; this field is ignored there. Undefined → model/GUI default;
   *    falls back to enableThinking (false→low, true→high) for gpt-oss when unset. */
  reasoningEffort: z.enum(["low", "medium", "high"]).optional(),
  /** Reuse the provider's KV/prefix cache across calls. The ~22KB base system
   *  prompt + tool catalog is the stable first part of every call, so reusing a
   *  cached prefill skips re-prefilling it each iteration/turn — a large latency
   *  (and, on Anthropic, cost) win.
   *   - OpenAI-compatible (llama.cpp / LM Studio): sends `extra_body.cache_prompt:
   *     true`. OPT-IN (off when unset) because non-llama.cpp backends (some vLLM
   *     builds) reject unknown `extra_body` keys; enable it only for a provider
   *     you know supports prompt caching.
   *   - Anthropic: places `cache_control: ephemeral` breakpoints on the tool
   *     catalog and system prompt. ON by default there (caching is always
   *     supported and sub-minimum prefixes are silently uncached); set
   *     `promptCache: false` to disable.
   *  Optional so inline ModelConfig literals don't all have to set it. */
  promptCache: z.boolean().optional(),
  /** Optional model-tier ladder. When set, the orchestrator swaps in the
   *  tier-specific model for certain paths instead of `primary`:
   *   - `routing`   : lightweight classifier/picker calls (reserved — wired as
   *                   adopted, currently unused by the runtime)
   *   - `synthesis` : final user-facing rewrite + delegate-coverage resynthesis
   *                   (see runtime.forceSynthesis). Use a smaller, more
   *                   instruction-following model to reduce tail latency on
   *                   synthesis turns while keeping `primary` for reasoning.
   *  Each value is a provider-prefixed model name, same format as `primary`
   *  (e.g. "lmstudio/qwen3-7b-instruct"). Other ModelConfig fields
   *  (temperature, context window, sampling) are inherited from the base
   *  ModelConfig — only the model name is overridden. */
  tiers: z.object({
    routing: z.string().max(200).optional(),
    synthesis: z.string().max(200).optional(),
  }).optional(),
});

/** A named, runtime-switchable alternate for the default chat model (the
 *  dashboard "Local ⇄ Claude" switch). When active it overrides the model
 *  identity (primary/fallback) everywhere — orchestrator AND sub-agents —
 *  while behavioral fields (maxIterations, tool sets, prompts) stay untouched.
 *  The previously configured primary automatically becomes the fallback so a
 *  broken cloud preset degrades back to the local model. */
export const ModelPresetSchema = z.object({
  /** Display label for the dashboard switch (defaults to the preset key). */
  label: z.string().max(60).optional(),
  /** Provider-prefixed model, e.g. "anthropic/claude-sonnet-4-6". */
  primary: z.string().max(200),
  /** Explicit fallback; defaults to the regular configured primary. */
  fallback: z.string().max(200).optional(),
  maxTokens: z.number().int().min(256).max(16384).optional(),
  contextWindow: z.number().int().min(2048).max(131072).optional(),
});
export type ModelPreset = z.infer<typeof ModelPresetSchema>;

export const RateLimitSchema = z.object({
  requestsPerMinute: z.number().int().min(1).max(600).default(60),
  toolCallsPerTurn: z.number().int().min(1).max(50).default(20),
  concurrentSessions: z.number().int().min(1).max(100).default(10),
  windowMs: z.number().int().min(10_000).max(600_000).default(60_000),
});

export const MainAssistantConfigSchema = z.object({
  toolMode: z.enum(["hybrid", "orchestration_only", "delegate_only"]).default("orchestration_only"),
  customInstructions: z.string().trim().min(1).max(16000).optional(),
  // When true (default), the model's own routing decision is trusted: keyword
  // freshness/source signals become advisory hints in the turn guidance rather
  // than a hard gate that forces delegation. The never-empty release still
  // applies in either mode. Set false to restore the strict "must delegate for
  // fresh/source-sensitive work" enforcement.
  trustModelRouting: z.boolean().default(true),
});

export const EphemeralGenerationSchema = z.object({
  enabled: z.boolean().default(true),
  skillMatchThreshold: z.number().min(0).max(1).default(0.7),
  architectAgentName: z.string().min(1).default("agent_architect"),
});

// Channel schemas (ChannelWebChatSchema … ChannelsSchema + the *Config types)
// moved to ./schemas/channels.ts; re-exported above.

export const GatewaySchema = z.object({
  port: z.number().int().min(1024).max(65535).default(8765),
  restPort: z.number().int().min(1024).max(65535).default(8766),
  bindHost: z.enum(["loopback", "lan", "docker"]).default("loopback"),
  jwtSecret: z.string().min(32).optional(), // loaded from env if not set
  sessionTtlMs: z.number().int().min(60000).default(3600000), // 1 hour
  // Hard ceiling for an interactive orchestrator turn. On expiry the turn is
  // aborted (propagated to the whole sub-agent subtree) and the partial/backstop
  // answer is returned, so a stuck coordinator cascade can't churn for half an
  // hour. 10 min is ~5x the orchestrator SLO (orchestratorTurnSloMs, 120s) —
  // generous for genuine deep multi-agent research yet far below the old 30 min.
  // Scenes/jobs are unaffected (they pass their own per-job turnTimeoutMs);
  // operators with very heavy autonomous workflows can raise this.
  turnTimeoutMs: z.number().int().min(30000).default(600000), // 10 minutes
  approvalTimeoutMs: z.number().int().min(60_000).max(3_600_000).default(300_000), // 5 minutes
  maxBodyBytes: z.number().int().min(1024).max(52_428_800).default(1_048_576), // 1 MB
  /** Publicly reachable base URL, used to construct approval callback URLs sent to external systems */
  publicUrl: z.string().url().optional(),
  /** Additional browser origins allowed to call the gateway directly when the dashboard runs on a separate host */
  corsAllowedOrigins: z.array(z.string().url()).default([]),
});

/**
 * A single user account.  Passwords are stored as bcrypt hashes; the plain
 * value is never persisted.  Use the `POST /api/auth/users` admin endpoint
 * (operator-authenticated) to add accounts at runtime — adding users by
 * hand-editing config is supported but discouraged because the hash format
 * is awkward to type correctly.
 */
/**
 * Role-based access control (Wave B).  `operator` is full access (current
 * default behavior); `viewer` is read-only — can browse audit, sessions,
 * jobs, federation, and the swarm dashboard but cannot mutate persistent
 * state (no user management, no config edits, no cron-trigger creation).
 *
 * Wave C will extend the gate to WS chat (viewers will not be able to
 * initiate turns); for now viewers can chat like operators, they just
 * can't administer the deployment.
 */
/** Role names are open strings: upstream ships operator/viewer; core
 *  extensions register additional roles (the gateway validates against the
 *  live role registry at runtime — config stays fork-agnostic). */
export const AuthRoleSchema = z.string().min(1).max(32).regex(/^[a-z][a-z0-9_-]*$/i).default("operator");

export const AuthUserSchema = z.object({
  username: z.string().min(1).max(64).regex(/^[a-z0-9_.-]+$/i, "username must be alphanumeric/_/-/."),
  /** bcrypt hash (e.g. "$2a$12$..."); never plain text. */
  passwordHash: z.string().min(20),
  /** Optional display name shown in the dashboard. */
  displayName: z.string().optional(),
  /** Account role.  Defaults to operator so existing users keep full access. */
  role: AuthRoleSchema,
  /** ISO timestamp of when this account was created.  Set by the runtime; do not edit. */
  createdAt: z.string().optional(),
});

export type AuthRole = z.infer<typeof AuthRoleSchema>;

/**
 * Map external-IdP role/group names → our roles. Checked admin → operator →
 * viewer (most-privileged wins); a user whose token carries none of the listed
 * roles falls back to `defaultRole` (or is rejected when that is unset).
 */
export const OidcRoleMappingSchema = z.object({
  admin: z.array(z.string()).default([]),
  operator: z.array(z.string()).default([]),
  viewer: z.array(z.string()).default([]),
  defaultRole: AuthRoleSchema.optional(),
}).default({});

/**
 * OpenID Connect provider (e.g. Keycloak). Used for SSO human login and, when
 * `a2a.enabled`, machine-to-machine agent auth via the client-credentials grant.
 * Discovery reads `{issuer}/.well-known/openid-configuration`.
 */
export const OidcConfigSchema = z.object({
  issuer: z.string().url(),
  clientId: z.string().min(1),
  /** Client secret — a $ENV or secret: reference, never an inline value. Omit for a public client. */
  clientSecret: z.string().optional(),
  /** The gateway's public base URL; the OIDC redirect is `{publicUrl}/api/auth/oidc/callback`.
   *  Falls back to gateway.publicUrl / the request origin when unset. */
  publicUrl: z.string().url().optional(),
  scopes: z.array(z.string()).default(["openid", "profile", "email"]),
  /** Token claim carrying the username (e.g. preferred_username, email, sub). */
  usernameClaim: z.string().default("preferred_username"),
  /** Token claim path holding the user's roles (Keycloak: realm_access.roles). */
  rolesClaim: z.string().default("realm_access.roles"),
  roleMapping: OidcRoleMappingSchema,
  /** Agent-to-agent (A2A) machine auth: request an OIDC client-credentials service
   *  token for OUTBOUND peer calls and validate INBOUND peer tokens via the issuer's
   *  JWKS. Peers must trust the same issuer. */
  a2a: z.object({
    enabled: z.boolean().default(false),
    /** Audience requested for / required on A2A service tokens. */
    audience: z.string().optional(),
  }).default({}),
  /** DEV ONLY: skip TLS certificate verification for the gateway's OUTBOUND OIDC
   *  requests (discovery, token exchange, JWKS) — e.g. a Keycloak behind an
   *  internal/self-signed CA the gateway container doesn't trust. Scoped to OIDC
   *  calls via a custom fetch; it does NOT disable TLS validation globally.
   *  Default false; never enable for an internet-facing IdP. Prefer trusting the
   *  CA (NODE_EXTRA_CA_CERTS) in production. */
  insecureSkipTlsVerify: z.boolean().default(false),
});

/**
 * Authentication.  When `enabled` is false (the default), the gateway keeps its
 * single-operator behavior and prints a bootstrap admin token on startup. When
 * enabled, `provider` selects the identity backend:
 *   - "builtin" — username + password from `users[]`, returning a JWT scoped to
 *     that username (`sub` claim) with a role from the user record.
 *   - "oidc"    — an external OpenID Connect provider (Keycloak) for SSO; the
 *     login flow redirects to the IdP, maps its roles, and mints our session JWT.
 */
export const AuthSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(["builtin", "oidc"]).default("builtin"),
  oidc: OidcConfigSchema.optional(),
  users: z.array(AuthUserSchema).default([]),
  /**
   * Trust the client-supplied `X-Forwarded-For` header for the login
   * brute-force rate-limit identity. Leave FALSE (the default) for a directly
   * exposed gateway — otherwise an attacker rotates the header to dodge the
   * limiter. Set TRUE only when the gateway sits behind a reverse proxy that
   * overwrites XFF; the limiter then keys on the left-most (client) hop.
   */
  trustProxyHeader: z.boolean().default(false),
});

export type AuthUser = z.infer<typeof AuthUserSchema>;
export type AuthConfig = z.infer<typeof AuthSchema>;
export type OidcConfig = z.infer<typeof OidcConfigSchema>;

/**
 * Upload storage. `backend: "local"` keeps files on the gateway's disk under
 * `<workspace>/uploads/` (the legacy default). `backend: "s3"` stores them in any
 * S3-compatible object store — the bundled SeaweedFS, or a real AWS S3 bucket by
 * pointing `s3` at it (same API, so it's a drop-in swap). Keys/endpoint are $ENV
 * refs. `forcePathStyle` must be true for SeaweedFS/MinIO, false for AWS S3.
 */
export const S3StorageSchema = z.object({
  endpoint: z.string().optional(),           // e.g. http://seaweedfs:8333; omit for real AWS S3
  region: z.string().default("us-east-1"),
  bucket: z.string().min(1).default("starlingai-uploads"),
  accessKeyId: z.string().optional(),        // $ENV ref
  secretAccessKey: z.string().optional(),    // $ENV ref
  forcePathStyle: z.boolean().default(true), // SeaweedFS/MinIO need path-style; AWS uses false
});

/**
 * Anti-malware scanning of uploads via ClamAV (clamd INSTREAM). When `enabled`,
 * every upload is scanned BEFORE it is stored or ingested; an infected file is
 * rejected. `mode: "sync"` blocks the upload request until the verdict.
 */
export const UploadScanSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(["sync"]).default("sync"),
  clamdHost: z.string().default("clamav"),
  clamdPort: z.number().int().min(1).max(65535).default(3310),
  timeoutMs: z.number().int().min(1000).default(30_000),
  /** Files larger than this skip the scan (clamd has its own StreamMaxLength; keep in sync). */
  maxScanBytes: z.number().int().min(0).default(104_857_600), // 100 MB
});

export const StorageSchema = z.object({
  backend: z.enum(["local", "s3"]).default("local"),
  s3: S3StorageSchema.default({}),
  scan: UploadScanSchema.default({}),
});

export type StorageConfig = z.infer<typeof StorageSchema>;

/**
 * Cost governance.  When `enabled` is true the gateway aggregates token
 * usage from `sub_agent_completed` and `turn_performance` audit events,
 * prices each entry against the configured per-model rate card, and
 * emits `cost_budget_threshold` audit events at soft (75% of cap) and
 * hard (100% of cap) crossings.  Daily and monthly caps are independent;
 * leave either at 0 to disable that scope.
 *
 * Pricing is best-effort — the orchestrator's reported `model` field is
 * matched against `models[].matches` (regex) and the first hit's
 * `{promptPer1m, completionPer1m}` rate (per 1 000 000 tokens, in the
 * configured currency) is applied.  An empty rate card yields $0
 * everywhere so operators who only care about token volume can run with
 * `enabled: true, models: []` without bogus dollar amounts in the UI.
 */
export const CostModelRateSchema = z.object({
  matches: z.string().min(1),
  promptPer1m: z.number().min(0),
  completionPer1m: z.number().min(0),
  label: z.string().optional(),
});

export const CostSchema = z.object({
  enabled: z.boolean().default(false),
  currency: z.string().min(3).max(8).default("USD"),
  models: z.array(CostModelRateSchema).default([]),
  budgets: z.object({
    dailyUsd: z.number().min(0).default(0),
    monthlyUsd: z.number().min(0).default(0),
  }).default({}),
  /**
   * Hard-stop enforcement. When true (and `enabled`), a new turn is REFUSED once
   * the current day's or month's priced spend has reached the corresponding hard
   * budget (dailyUsd / monthlyUsd) — the user gets a clear "budget reached"
   * message instead of the request running. Default false preserves the historical
   * alert-only behavior (audit `cost_budget_threshold` events still fire either
   * way). Only the non-zero budgets gate; a $0 budget for a scope never blocks.
   */
  enforce: z.boolean().default(false),
});

export type CostModelRate = z.infer<typeof CostModelRateSchema>;
export type CostConfig = z.infer<typeof CostSchema>;

/**
 * OpenTelemetry distributed tracing.  When enabled, the gateway initializes
 * the OTel SDK at startup and produces spans for tool calls, sub-agent
 * runs, and federation requests.  Trace context is propagated across
 * federation HTTP boundaries via standard `traceparent` / `tracestate`
 * headers, so a delegation that hops three instances appears as one trace.
 */
export const TracingSchema = z.object({
  enabled: z.boolean().default(false),
  /** OTLP HTTP endpoint URL (e.g. http://localhost:4318/v1/traces). */
  otlpEndpoint: z.string().url().default("http://localhost:4318/v1/traces"),
  /** Optional headers (e.g. {"x-honeycomb-team": "..."}) for the OTLP exporter. */
  otlpHeaders: z.record(z.string()).optional(),
  /** Trace sampling probability 0..1.  Default 1.0 = sample every trace. */
  sampleRate: z.number().min(0).max(1).default(1),
  /** Service name reported in spans.  Defaults to "starlingai". */
  serviceName: z.string().min(1).default("starlingai"),
});

export type TracingConfig = z.infer<typeof TracingSchema>;

/** A single federation peer — another StarlingAI instance addressable over HTTP(S). */
export const FederationPeerSchema = z.object({
  /** Stable identifier used in tool calls and audit entries (e.g. "ops-east"). */
  id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/i, "id must be alphanumeric/_/-"),
  /** Base URL of the peer gateway, including protocol + port (no trailing slash). */
  url: z.string().url(),
  /** Optional human description shown in capability listings. */
  description: z.string().optional(),
  /** Optional tags used by the routing layer to filter peers (e.g. ["read-only", "production"]). */
  tags: z.array(z.string()).default([]),
});

/**
 * Federated swarms (Stage 11).  When `enabled` is true the gateway exposes
 * /api/federation/{health,capabilities,delegate} for peer instances and the
 * orchestrator gains the `delegate_to_remote_agent` + `list_federation_peers`
 * tools.  Each instance keeps its own tool tiers and human-in-loop policies —
 * federation never bypasses local guardrails.
 */
export const FederationSchema = z.object({
  /** Master switch — when false the gateway routes are not mounted and the tools refuse to execute. */
  enabled: z.boolean().default(false),
  /** Stable identifier for THIS instance, advertised to peers (e.g. "primary"). */
  instanceId: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/i).default("primary"),
  /** Shared HMAC secret used to sign + verify federation JWTs.  Both peers must have the same value.  Must be ≥32 chars when enabled. */
  sharedSecret: z.string().min(32).optional(),
  /** Outbound peers we will delegate to. */
  peers: z.array(FederationPeerSchema).default([]),
  /** Optional allowlist of agent names exposed to peers.  Empty array = all agents. */
  exposeAgents: z.array(z.string()).default([]),
  /** Hard timeout on a single remote delegation in ms.  Default 10 min. */
  delegationTimeoutMs: z.number().int().min(5_000).max(3_600_000).default(600_000),
  /** Capability cache TTL in ms — how long fetched peer capabilities stay fresh.  Default 5 min. */
  capabilityCacheTtlMs: z.number().int().min(0).max(3_600_000).default(300_000),
  /**
   * Auto peer discovery — instances periodically ask configured peers
   * "who else do you talk to?" and probe each new peer.  Reachable peers
   * (those whose `/api/federation/health` returns 200 with the matching
   * shared HMAC) are added to the in-memory peer list and can receive
   * delegations.  Discovered peers DO NOT persist to config — they are
   * forgotten on restart and re-discovered next startup.
   */
  discovery: z.object({
    enabled: z.boolean().default(false),
    /** How often to refresh the discovered-peer set, in ms.  Default 5 min. */
    intervalMs: z.number().int().min(30_000).max(86_400_000).default(300_000),
    /**
     * Allow discovered peer URLs to resolve to private / loopback / link-local
     * hosts. Leave FALSE (default) so a malicious peer cannot advertise an
     * internal address (e.g. 169.254.169.254 or 10.x) and make this instance
     * fetch it with a valid minted token (SSRF amplification). Set TRUE only for
     * a fully-trusted LAN mesh.
     */
    allowPrivateHosts: z.boolean().default(false),
    /** Hard cap on the number of peers a single discovery pass may add. */
    maxDiscoveredPeers: z.number().int().min(0).max(1000).default(50),
  }).default({}),
});

export type FederationPeerConfig = z.infer<typeof FederationPeerSchema>;
export type FederationConfig = z.infer<typeof FederationSchema>;

/**
 * Public Agent-to-Agent (A2A) protocol — Stage 12 / Open Interop.
 *
 * Where federation is StarlingAI-to-StarlingAI HMAC, A2A is the open public
 * spec at https://a2aproject.dev so cross-vendor agents (LangGraph, CrewAI,
 * Vertex AI, …) can delegate tasks back and forth.  We act as both a server
 * (advertising sub-agents via `/.well-known/agent-card.json`) and a client
 * (fetching peer agent cards and registering each as a virtual sub-agent).
 */
export const A2APeerSchema = z.object({
  /** Stable id used in `a2a__<peerId>__<agentName>` names + audit entries. */
  id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/i),
  /** Base URL of the peer (no trailing slash).  Agent card resolves at `<url>/.well-known/agent-card.json`. */
  url: z.string().url(),
  /** Optional human description shown in dashboards. */
  description: z.string().optional(),
  /** Bearer token required by the peer's `/a2a/v1` endpoint (resolves `$ENV` and `secret:` prefixes). */
  bearerToken: z.string().optional(),
  /** Skip outbound calls to this peer when false; useful for staging while keeping the entry. */
  enabled: z.boolean().default(true),
});

export const A2ASchema = z.object({
  /** Master switch — when false `/a2a/v1` returns 404 and the client doesn't poll peers. */
  enabled: z.boolean().default(false),
  /** Bearer token clients must present.  Unset = require gateway JWT. */
  inboundBearerToken: z.string().optional(),
  /** Optional allowlist of locally-defined agents exposed via A2A.  Empty = all. */
  exposeAgents: z.array(z.string()).default([]),
  /** Outbound peers we will pull agent cards from at startup. */
  peers: z.array(A2APeerSchema).default([]),
  /** Hard timeout on a single A2A `tasks/send` outbound call in ms. */
  taskTimeoutMs: z.number().int().min(5_000).max(3_600_000).default(600_000),
  /** Refresh interval in ms for re-fetching peer agent cards.  0 = once at startup. */
  refreshIntervalMs: z.number().int().min(0).max(86_400_000).default(900_000),
});

export type A2APeerConfig = z.infer<typeof A2APeerSchema>;
export type A2AConfig = z.infer<typeof A2ASchema>;

// Multimodal schemas (MultimodalServiceSchema … MultimodalSchema, plus the
// private OptionalEndpointUrlSchema helper) moved to ./schemas/multimodal.ts;
// re-exported above.

// Retrieval schemas (RetrievalRerankerSchema / RetrievalSearchSchema /
// DocumentRagSchema + DocumentRagConfig / RetrievalSchema) moved to
// ./schemas/retrieval.ts; re-exported above.

// ─── MCP Server configuration ────────────────────────────────────────────────

export const McpStdioServerSchema = z.object({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
  autoStart: z.boolean().default(true),
});

export const McpDockerRunServerSchema = z.object({
  transport: z.literal("docker"),
  image: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
  mounts: z.array(z.string()).default([]),
  network: z.string().optional(),
  /** Extra host mappings injected as --add-host=host:ip (e.g. ["myhost.internal:192.168.1.50"]) */
  addHosts: z.array(z.string()).default([]),
  autoStart: z.boolean().default(true),
});

export const McpDockerExecServerSchema = z.object({
  transport: z.literal("docker-exec"),
  container: z.string().min(1),   // name or ID of a running container
  args: z.array(z.string()).default([]),
  autoStart: z.boolean().default(true),
});

export const McpHttpServerSchema = z.object({
  transport: z.literal("http"),
  url: z.string().url(),           // StreamableHTTP or legacy JSON-RPC endpoint
  protocol: z.enum(["streamable", "legacy-jsonrpc"]).default("streamable"),
  headers: z.record(z.string()).optional(),
  autoStart: z.boolean().default(true),
});

export const McpTcpServerSchema = z.object({
  transport: z.literal("tcp"),     // e.g. Docker Desktop socat bridge
  host: z.string().default("host.docker.internal"),
  port: z.number().int().min(1).max(65535),
  autoStart: z.boolean().default(true),
});

export const McpServerConfigSchema = z.discriminatedUnion("transport", [
  McpStdioServerSchema,
  McpDockerRunServerSchema,
  McpDockerExecServerSchema,
  McpHttpServerSchema,
  McpTcpServerSchema,
]);

/**
 * Outbound MCP-server expose config (Stage 12 / Open Interop).
 *
 * When `enabled` is true, the gateway publishes itself as an MCP endpoint so
 * external clients (Claude Desktop, Claude Code, Cursor, Zed, …) can call
 * StarlingAI tools, sub-agents, scenes, and jobs.  Two transports are
 * supported simultaneously:
 *
 *   - **stdio** — the `mcp-stdio` entrypoint.  Operators wire this into
 *     external tooling via `claude mcp add starlingai -- node dist/mcp-stdio.js`.
 *   - **HTTP/SSE** — mounted at `/mcp` on the regular gateway listener;
 *     reuses the existing JWT auth so operator/viewer rules apply.
 *
 * Tier gating mirrors federation: Tier 0/1 surface by default, Tier 2 is
 * opt-in per-tool, Tier 3+ never.
 */
export const McpServerExposeSchema = z.object({
  /** Master switch.  When false, `/mcp` returns 404 and the stdio entrypoint exits with a hint. */
  enabled: z.boolean().default(false),
  /**
   * Allowlist of tool names exposed via MCP.  Empty array = expose every
   * Tier 0/1 tool.  Tier 2 tools must be listed explicitly; Tier 3+ are
   * never exposed regardless of allowlist contents.
   */
  exposeTools: z.array(z.string()).default([]),
  /** Allowlist of sub-agent names exposed as `agent__<name>` tools.  Empty array = all. */
  exposeAgents: z.array(z.string()).default([]),
  /** Allowlist of scenes exposed as `scene__<name>` tools.  Empty array = all. */
  exposeScenes: z.array(z.string()).default([]),
  /** When true, allow Tier 2 tools listed in `exposeTools` (per-call approval still applies). */
  allowTier2: z.boolean().default(false),
  /** HTTP transport (`/mcp`) on/off.  Stdio transport is governed by whether the entrypoint is launched. */
  http: z.object({
    enabled: z.boolean().default(true),
    /** When true the HTTP transport requires the same JWT as `/api/*`.  Disable only for trusted local sockets. */
    requireAuth: z.boolean().default(true),
  }).default({}),
});

export type McpServerExposeConfig = z.infer<typeof McpServerExposeSchema>;

export const McpConfigSchema = z.object({
  servers: z.record(McpServerConfigSchema).default({}),
  /** Expose StarlingAI itself as an MCP server (Stage 12 / Open Interop). */
  expose: McpServerExposeSchema.default({}),
  /**
   * Lazily reconnect a bridged MCP server (once, throttled) when a tool call
   * fails, so a crashed/restarted server self-heals instead of staying dead
   * until the next manual sync or gateway restart. Default off.
   */
  autoReconnect: z.boolean().default(false),
});

export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;

// ─── Site credentials ────────────────────────────────────────────────────────
// Stored in the config for reference; passwords never stored in plain text.
// Password value formats:
//   "$ENV_VAR_NAME"    → resolved from process.env at runtime
//   "secret:key_name"  → resolved from the AES-256-GCM encrypted credential store
//   "literal value"    → used as-is (only acceptable in dev; emit a warning)

export const SiteCredentialSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),     // supports $ENV and secret: prefixes
  loginUrl: z.string().url().optional(),            // override if login page != root
  urls: z.record(z.string()).optional(),            // named URL shortcuts, e.g. { "leads": "http://..." }
  usernameSelector: z.string().optional(),          // CSS selector hint for Playwright
  passwordSelector: z.string().optional(),
  submitSelector: z.string().optional(),
  notes: z.string().optional(),                     // human-readable reminder
  // Usernames permitted to use this credential. Empty/unset = shared (all
  // users). Enforced against the authenticated user before any credential read.
  allowedUsers: z.array(z.string()).default([]),
});

export const SitesSchema = z.record(SiteCredentialSchema);  // keyed by hostname

export type SiteCredential = z.infer<typeof SiteCredentialSchema>;

// ─── Sub-agent definitions ───────────────────────────────────────────────────
// Specialized agents with their own model, system prompt, and allowed tool set.
// Referenced by the delegate_to_agent tool from the orchestrator.

export const SubAgentContainerSchema = z.object({
  enabled: z.boolean().default(false),
  /** Set to true to explicitly opt this agent OUT of containerized execution even when
   *  agents.defaultContainerized is enabled globally. Use only for trusted, read-only
   *  specialists where in-process execution is acceptable (e.g. memory_search-only agents). */
  disabled: z.boolean().default(false),
  image: z.string().default("starlingai/agent-worker:dev"),
  memoryMb: z.number().int().min(128).max(4096).default(512),
  cpus: z.number().min(0.1).max(4).default(0.5),
  timeoutMs: z.number().int().min(5000).max(300000).default(60000),
}).refine(
  data => !(data.enabled && data.disabled),
  { message: "container.enabled and container.disabled cannot both be true" },
);

/** Optional GPU/compute resource requirements for GPU-aware routing (Stage 9). */
export const AgentComputeProfileSchema = z.object({
  /** Minimum GPU VRAM required in MB (0 = no GPU required). */
  minVramMb: z.number().int().min(0).default(0),
  /** Whether this agent benefits from GPU acceleration (used for routing preference). */
  gpuPreferred: z.boolean().default(false),
  /** Named GPU tier required: "none" | "low" | "medium" | "high" | "any" */
  gpuTier: z.enum(["none", "low", "medium", "high", "any"]).default("none"),
}).optional();

export const SubAgentConfigSchema = z.object({
  description: z.string(),                          // shown to orchestrator LLM
  capabilities: z.array(z.string()).default([]),   // explicit routing keywords, e.g. ["browser", "forms"]
  tags: z.array(z.string()).default([]),           // lightweight product/category tags for discovery
  /** Product domain grouping — research | coding | browser | data | communication | workflow | reliability */
  domain: z.string().optional(),
  role: z.enum(["coordinator", "specialist", "reviewer", "generator", "supervisor", "planner"]).optional(),
  model: ModelConfigSchema.partial().optional(),    // overrides agents.defaults.model
  systemPrompt: z.string().optional(),              // specialist persona
  tools: z.array(z.string()).optional(),            // allowed tool names; undefined = inherit all
  maxIterations: z.number().int().min(1).max(30).default(5), // hard cap on tool-call loops
  // Optional per-agent wall-clock turn timeout. A number is the budget in ms.
  // The literal "unbound" disables the turn timeout entirely (no soft/hard
  // deadline, no adaptive budget) — for agents whose deliverable legitimately
  // takes a long time to generate (e.g. a full site) and must not be cut off.
  turnTimeoutMs: z.union([z.number().int().min(1_000).max(1_800_000), z.literal("unbound")]).optional(),
  maxConcurrent: z.number().int().min(1).max(20).optional(), // max simultaneous containers (default: 3)
  container: SubAgentContainerSchema.optional(),    // run in ephemeral Docker container
  /** GPU/compute resource requirements — used for GPU-aware routing. */
  compute: AgentComputeProfileSchema,
  /**
   * Workspace visibility zone. "generated" (default) confines the agent's file
   * tools to the working zones (generated/ + uploads/) — paths outside are
   * transparently re-rooted into generated/, mirroring the write rooting. "full"
   * exposes the whole workspace (config zones agents/, scenes/, jobs/, tools/,
   * runtime/) and is reserved for core/self-improvement agents that maintain
   * the swarm itself.
   */
  workspaceAccess: z.enum(["full", "generated"]).optional(),
});

export const SubAgentsSchema = z.record(SubAgentConfigSchema);
export type SubAgentConfig = z.infer<typeof SubAgentConfigSchema>;

// ─── Approval channels ────────────────────────────────────────────────────────
// Named adapters that deliver human-in-the-loop approval requests to the user
// when a scene is triggered via webhook (no WebSocket/dashboard is open).
//
// Each entry in `approvalChannels` is referenced by name from a scene's
// `approvalChannel` field.
//
// Supported types:
//   telegram        — send an inline-keyboard message via the Telegram bot
//   outbound_webhook — POST the request; the receiver calls back to /api/approval/:id
//   sync_webhook    — POST and expect { approved: boolean } in the response body

/**
 * Slack — posts a Block Kit message with one-click Approve / Deny links
 * via a Slack Incoming Webhook (no Slack app or interactive components required).
 * gateway.publicUrl must be set so StarlingAI can construct the link URLs.
 */
export const SlackApprovalChannelSchema = z.object({
  type: z.literal("slack"),
  /** Slack Incoming Webhook URL (from your Slack app or workflow) */
  webhookUrl: z.string().url(),
  /** Timeout in ms before auto-deny (default 10 min) */
  timeoutMs: z.number().int().default(600_000),
});

/**
 * Outbound webhook — POSTs a JSON approval request to any URL.
 * The payload contains pre-formed `approveUrl` and `denyUrl` one-click links
 * plus a `callbackUrl` for programmatic POST-back.
 * Perfect for n8n → WhatsApp / email / SMS / any custom channel.
 * gateway.publicUrl must be set.
 */
export const OutboundWebhookApprovalChannelSchema = z.object({
  type: z.literal("outbound_webhook"),
  /** URL to POST the approval request payload to */
  url: z.string().url(),
  /** Shared secret — included in the outbound payload and expected back on the callback */
  secret: z.string().min(16),
  /** Extra headers on the outbound POST (e.g. Authorization for n8n) */
  headers: z.record(z.string()).optional(),
  /** Timeout in ms before auto-deny (default 10 min) */
  timeoutMs: z.number().int().default(600_000),
});

/**
 * Sync webhook — POSTs the approval request and expects { approved: boolean }
 * in the response body immediately.  Use for internal approval systems that
 * can decide synchronously (e.g. a rules engine, a manager dashboard that
 * pops a modal on load).
 */
export const SyncWebhookApprovalChannelSchema = z.object({
  type: z.literal("sync_webhook"),
  /** URL that receives the POST and responds with { approved: boolean } */
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  /** Timeout for the synchronous response (default 30 s) */
  timeoutMs: z.number().int().default(30_000),
});

export const ApprovalChannelSchema = z.discriminatedUnion("type", [
  SlackApprovalChannelSchema,
  OutboundWebhookApprovalChannelSchema,
  SyncWebhookApprovalChannelSchema,
]);

export const ApprovalChannelsSchema = z.record(ApprovalChannelSchema);
export type ApprovalChannelConfig = z.infer<typeof ApprovalChannelSchema>;


// ─── Generic configurable webhook tools ───────────────────────────────────────
// Each entry generates a tool named webhook__<key> at Tier 1.
// Supports GET/POST/PUT/PATCH/DELETE; header values starting with $ are resolved
// from process.env at call time.

export const WebhookToolSchema = z.object({
  description: z.string().min(1),
  url: z.string().url(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("POST"),
  headers: z.record(z.string()).optional(),
});

export const WebhooksSchema = z.record(WebhookToolSchema);
export type WebhookToolConfig = z.infer<typeof WebhookToolSchema>;


// ─── Infrastructure adapters ───────────────────────────────────────────────

export const InfrastructureVmProxmoxProfileSchema = z.object({
  type: z.literal("proxmox"),
  apiUrl: z.string().url(),
  node: z.string().min(1),
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  tokenId: z.string().min(1).optional(),
  tokenSecret: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1000).max(900000).default(120000),
});

export const InfrastructureVmWebhookProfileSchema = z.object({
  type: z.literal("webhook"),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  timeoutMs: z.number().int().min(1000).max(900000).default(120000),
});

export const InfrastructureVmProfileSchema = z.discriminatedUnion("type", [
  InfrastructureVmProxmoxProfileSchema,
  InfrastructureVmWebhookProfileSchema,
]);

export const InfrastructureAutomationLocalCliProfileSchema = z.object({
  type: z.literal("local-cli"),
  terraformBinary: z.string().min(1).default("terraform"),
  ansibleBinary: z.string().min(1).default("ansible"),
  ansiblePlaybookBinary: z.string().min(1).default("ansible-playbook"),
  kubectlBinary: z.string().min(1).default("kubectl"),
  helmBinary: z.string().min(1).default("helm"),
  kubeconfigPath: z.string().min(1).optional(),
  defaultKubeContext: z.string().min(1).optional(),
  timeoutMs: z.number().int().min(1000).max(900000).optional(),
});

export const InfrastructureAutomationWebhookProfileSchema = z.object({
  type: z.literal("webhook"),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  timeoutMs: z.number().int().min(1000).max(900000).optional(),
});

export const InfrastructureAutomationProfileSchema = z.discriminatedUnion("type", [
  InfrastructureAutomationLocalCliProfileSchema,
  InfrastructureAutomationWebhookProfileSchema,
]);

export const InfrastructureSchema = z.object({
  virtualization: z.object({
    profiles: z.record(InfrastructureVmProfileSchema).default({}),
  }).default({}),
  automation: z.object({
    defaultProfile: z.string().min(1).optional(),
    profiles: z.record(InfrastructureAutomationProfileSchema).default({}),
  }).default({}),
});


// ─── Monitoring (Prometheus, Alertmanager, Grafana) ──────────────────────────
// External-only: each instance points at a remote endpoint. The gateway never
// runs its own Prometheus/Alertmanager/Grafana.

export const BasicAuthSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const PrometheusInstanceSchema = z.object({
  baseUrl: z.string().url(),
  bearerToken: z.string().optional(),
  basicAuth: BasicAuthSchema.optional(),
  headers: z.record(z.string()).optional(),
  timeoutMs: z.number().int().min(1000).max(300000).default(30000),
});

export const AlertmanagerInstanceSchema = z.object({
  baseUrl: z.string().url(),
  bearerToken: z.string().optional(),
  basicAuth: BasicAuthSchema.optional(),
  headers: z.record(z.string()).optional(),
  timeoutMs: z.number().int().min(1000).max(300000).default(30000),
});

export const GrafanaInstanceSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  orgId: z.number().int().min(1).optional(),
  headers: z.record(z.string()).optional(),
  timeoutMs: z.number().int().min(1000).max(300000).default(30000),
});

export const MonitoringSchema = z.object({
  defaultPrometheus: z.string().min(1).optional(),
  defaultAlertmanager: z.string().min(1).optional(),
  defaultGrafana: z.string().min(1).optional(),
  prometheus: z.record(PrometheusInstanceSchema).default({}),
  alertmanager: z.record(AlertmanagerInstanceSchema).default({}),
  grafana: z.record(GrafanaInstanceSchema).default({}),
});


// ─── Source forge integration (GitHub today; GitLab/Gitea later) ─────────────
// External-only: each instance points at api.github.com or a GitHub Enterprise
// host. Token is a PAT or fine-grained PAT with $ENV / secret: ref support.

export const GitHubInstanceSchema = z.object({
  baseUrl: z.string().url().default("https://api.github.com"),
  token: z.string().optional(),
  defaultOwner: z.string().min(1).optional(),
  defaultRepo: z.string().min(1).optional(),
  userAgent: z.string().min(1).default("StarlingAI"),
  timeoutMs: z.number().int().min(1000).max(300000).default(30000),
});

export const SourceForgeSchema = z.object({
  defaultGithub: z.string().min(1).optional(),
  github: z.record(GitHubInstanceSchema).default({}),
  /** Optional API key for Google PageSpeed Insights (lighthouse_audit).
   *  Avoids the strict anonymous quota. Supports $ENV / secret: refs. */
  pageSpeedInsightsApiKey: z.string().optional(),
});


// ─── Pentest service ──────────────────────────────────────────────────────────

export const PentestKaliServiceProfileSchema = z.object({
  type: z.literal("kali-service"),
  serviceUrl: z.string().url().default("http://kali-pentest:5010"),
  timeoutMs: z.number().int().min(1000).max(900000).default(300000),
});

export const PentestWebhookProfileSchema = z.object({
  type: z.literal("webhook"),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  timeoutMs: z.number().int().min(1000).max(900000).default(300000),
});

export const PentestProfileSchema = z.discriminatedUnion("type", [
  PentestKaliServiceProfileSchema,
  PentestWebhookProfileSchema,
]);

export const PentestSchema = z.object({
  serviceUrl: z.string().url().default("http://kali-pentest:5010"),
  defaultProfile: z.string().min(1).optional(),
  profiles: z.record(PentestProfileSchema).default({}),
});

export const MailServiceSchema = z.object({
  serviceUrl: z.string().url().default("http://mail-service:5020"),
  timeoutMs: z.number().int().min(1000).max(300000).default(20000),
  authToken: z.string().min(1).optional(),
});

// ─── Data Feeds ───────────────────────────────────────────────────────────────
// Per-provider configuration for the pluggable real-time data architecture
// (weather, news, finance, reference, network). Each provider entry is keyed
// by its provider id. Free providers default to enabled; keyed providers wait
// until an `apiKey` (env-var ref or `secret:` reference) is supplied.

export const DataFeedProviderEntrySchema = z.object({
  /** Explicitly enable/disable this provider. Omit to use the default policy. */
  enabled: z.boolean().optional(),
  /** API key for paid/keyed providers. Supports `$ENV_VAR` and `secret:key` refs. */
  apiKey: z.string().optional(),
  /** Provider-specific configuration overrides (passed verbatim to the provider). */
  config: z.record(z.unknown()).optional(),
});

export const DataFeedsSchema = z.object({
  providers: z.record(DataFeedProviderEntrySchema).default({}),
});

export type DataFeedsConfig = z.infer<typeof DataFeedsSchema>;

// ─── Guardrails ───────────────────────────────────────────────────────────────

export const GuardrailsSchema = z.object({
  promptInjectionBlock: z.boolean().default(true),
  outputSecretScan: z.boolean().default(true),
  maxInputLength: z.number().int().min(100).max(100000).default(32000),
  sandboxShellExec: z.boolean().default(true), // ALWAYS sandbox shell — hard override in code
  modelModeration: z.object({
    enabled: z.boolean().default(false),
    baseUrl: z.string().url().default("http://host.docker.internal:1234/v1"),
    apiKey: z.string().default("lm-studio"),
    model: z.string().min(1).default("Qwen/Qwen3Guard-Gen-4B"),
    timeoutMs: z.number().int().min(1000).max(120000).default(15000),
    moderateInputs: z.boolean().default(true),
    moderateToolOutputs: z.boolean().default(true),
    maxChars: z.number().int().min(256).max(32000).default(6000),
    blockOn: z.enum(["unsafe", "controversial_or_unsafe"]).default("unsafe"),
  }).default({}),
});

// ─── Scenes ───────────────────────────────────────────────────────────────────
// Named, reusable workflows that can be triggered via chat (/run <name>) or
// via a webhook POST /api/scenes/:name/run?key=<webhookKey>.

export const SceneParamSchema = z.object({
  description: z.string().optional(),          // shown in /run help output
  default: z.string().optional(),              // used when param not provided
});

/**
 * Catalog-routing triggers for a scene/job. Authors declare narrow,
 * high-precision regex patterns that uniquely identify when *their* workflow
 * is being requested. The runtime tests every pattern entry against the
 * normalised user message; an entry matches only when ALL of its `all` regexes
 * match. ANY entry that matches → the workflow is a candidate.
 *
 * Without `triggers` declared, a scene/job is still discoverable via
 * `search_workflows` by the LLM, but it never trips the workflow guardrail
 * on its own. This is intentional: the old token-overlap heuristic was noisy.
 *
 * `requiresActionVerb` further gates the candidate: when true, the user
 * message must contain an imperative/action verb (apply, deploy, run, ...,
 * ausrollen, anwenden, durchführen, ...) before the workflow is treated as a
 * confirmed intent. Without an action verb, the runtime will instead suggest
 * the workflow to the user and ask whether they want it executed — i.e.
 * passive questions like "erklär mir diesen WireGuard tunnel" never force
 * a routing decision.
 */
export const WorkflowCatalogTriggerEntrySchema = z.object({
  /** All listed regex patterns must match (case-insensitive). */
  all: z.array(z.string().min(1)).min(1),
});
export const WorkflowCatalogTriggersSchema = z.object({
  patterns: z.array(WorkflowCatalogTriggerEntrySchema).min(1),
  /** Require an imperative/action verb in the message to count as a confirmed intent. */
  requiresActionVerb: z.boolean().optional(),
}).optional();
export type WorkflowCatalogTriggers = z.infer<typeof WorkflowCatalogTriggersSchema>;

export const SceneConfigSchema = z.object({
  description: z.string(),                     // shown when listing scenes
  task: z.string().min(1),                     // the prompt injected into the session
  webhookKey: z.string().min(16).optional(),   // shared secret for unauthenticated webhook calls
  params: z.record(SceneParamSchema).optional(),    // named {{param|default}} template vars
  allowedAgents: z.array(z.string()).optional(),    // restrict which sub-agents this scene may use
  humanInLoopSteps: z.array(z.string()).optional(), // tool names that require user approval in this scene
  // When true and this scene runs as a single-agent job step, the job runner verifies the
  // step actually persisted an output file; if not, it does ONE corrective re-attempt and,
  // failing that, reports the step incomplete instead of claiming the deliverable exists.
  expectArtifact: z.boolean().optional(),
  /** Optional catalog-routing triggers (see WorkflowCatalogTriggersSchema). */
  triggers: WorkflowCatalogTriggersSchema,
  /** Name of an entry in `approvalChannels` — used when this scene is triggered via webhook */
  approvalChannel: z.string().optional(),
  /** Override the approval channel timeout for this scene (ms). Min 60 s, max 24 h.
   *  Falls back to the channel's own timeoutMs when not set. */
  approvalTimeoutMs: z.number().int().min(60_000).max(86_400_000).optional(),
});

export const ScenesSchema = z.record(SceneConfigSchema);
export type SceneConfig = z.infer<typeof SceneConfigSchema>;

// ─── Jobs ────────────────────────────────────────────────────────────────────
// Jobs orchestrate one or more scenes. They can be triggered explicitly via
// API and, for configured cron triggers, automatically by the gateway.

export const JobStepSchema = z.object({
  scene: z.string().min(1),
  label: z.string().optional(),
  params: z.record(z.string()).optional(),
});

export const ApiJobTriggerSchema = z.object({
  type: z.literal("api"),
  webhookKey: z.string().min(16).optional(),
  params: z.record(z.string()).optional(),
});

export const CronJobTriggerSchema = z.object({
  type: z.literal("cron"),
  expression: z.string().min(1),
  enabled: z.boolean().default(true),
  params: z.record(z.string()).optional(),
});

export const ChannelJobTriggerSchema = z.object({
  type: z.literal("channel"),
  channels: z.array(z.enum(["slack", "discord", "whatsapp", "email", "signal", "telegram"]))
    .min(1)
    .optional(),
  pattern: z.string().min(1),
  mode: z.enum(["prefix", "exact", "contains", "regex"]).default("prefix"),
  ignoreCase: z.boolean().default(true),
  parseParams: z.boolean().default(true),
  silent: z.boolean().default(false),
  replyText: z.string().min(1).optional(),
  captureMessageAs: z.string().min(1).optional(),
  captureRemainderAs: z.string().min(1).optional(),
  params: z.record(z.string()).optional(),
});

export const JobTriggerSchema = z.discriminatedUnion("type", [
  ApiJobTriggerSchema,
  CronJobTriggerSchema,
  ChannelJobTriggerSchema,
]);

export const JobConfigSchema = z.object({
  description: z.string(),
  params: z.record(SceneParamSchema).optional(),
  steps: z.array(JobStepSchema).min(1),
  triggers: z.array(JobTriggerSchema).optional(),
  /** Optional catalog-routing triggers (see WorkflowCatalogTriggersSchema). */
  catalogTriggers: WorkflowCatalogTriggersSchema,
});

export const JobsSchema = z.record(JobConfigSchema);
export type JobConfig = z.infer<typeof JobConfigSchema>;
export type JobTriggerConfig = z.infer<typeof JobTriggerSchema>;
export type JobStepConfig = z.infer<typeof JobStepSchema>;

// ─── Tool Development & Self-Improvement ────────────────────────────────────

export const ToolDevelopmentSchema = z.object({
  /** Enable the tool development sandbox pipeline */
  enabled: z.boolean().default(false),
  /** Maximum wall-clock duration for a single dev session (ms). Default 30 min. */
  maxSessionDurationMs: z.number().int().min(60_000).max(7_200_000).default(1_800_000),
  /** Max idle time before a dev session is marked stuck (ms). Default 5 min. */
  maxIdleMs: z.number().int().min(30_000).max(1_800_000).default(300_000),
  /** Max concurrent tool development sessions. */
  maxConcurrentSessions: z.number().int().min(1).max(5).default(2),
  /** Require human approval before deploying developed tools. */
  requireApproval: z.boolean().default(true),
  /** Named approval channel for tool submissions (from approvalChannels config). */
  approvalChannel: z.string().optional(),
  /** Approval timeout for tool submissions (ms). Default 60 min. */
  approvalTimeoutMs: z.number().int().min(60_000).max(86_400_000).default(3_600_000),
});

export const SelfImprovementSchema = z.object({
  /** Enable autonomous self-improvement loop. */
  enabled: z.boolean().default(false),
  /** Minimum repeated failures before proposing a new tool. */
  minFailuresBeforeProposal: z.number().int().min(1).max(20).default(3),
  /** Max concurrent tool proposals in flight. */
  maxConcurrentProposals: z.number().int().min(1).max(3).default(1),
  /**
   * Named approval channel (from approvalChannels config) to notify when a selfdev__ tool
   * reaches the promotion threshold and is awaiting operator sign-off.
   * When omitted, nominations are logged and queryable but no external notification fires.
   */
  promotionApprovalChannel: z.string().min(1).optional(),
  /**
   * Number of successful selfdev__ tool calls required before the tool is nominated
   * for promotion review. Mirrors dynamic-tools PROMOTION_MIN_CALLS default (10).
   */
  promotionMinCalls: z.number().int().min(1).max(500).default(10),
  /**
   * Minimum success-rate (0–1) required to nominate a selfdev__ tool for promotion.
   * Mirrors dynamic-tools PROMOTION_MIN_SUCCESS_RATE default (0.8).
   */
  promotionMinSuccessRate: z.number().min(0).max(1).default(0.8),
  /**
   * Number of successful selfdev__ tool invocations required to consider the
   * originating capability gap confirmed-closed (post-deployment feedback loop).
   * Kept separate from promotionMinCalls, which governs promotion eligibility.
   */
  gapClosureConfirmationCount: z.number().int().min(1).max(500).default(5),
  /**
   * Upper bound on capability gaps held in memory. Past this the oldest
   * terminal-status gaps (deployed/closed/rejected) are evicted first, then the
   * oldest remaining — so a long-running instance never accretes them unboundedly.
   */
  maxTrackedGaps: z.number().int().min(100).max(50_000).default(2000),
});

export type ToolDevelopmentConfig = z.infer<typeof ToolDevelopmentSchema>;
export type SelfImprovementConfig = z.infer<typeof SelfImprovementSchema>;

export const SkillLibrarySchema = z.object({
  /**
   * Enable the procedural Skill Library: swarm-authored, self-improving
   * markdown procedures retrieved at planning time. Pure guidance — no code,
   * no privilege. Safe to leave on; produces no effect until skills exist.
   */
  enabled: z.boolean().default(true),
  /**
   * Autonomously distill skills from successful trajectories. Safe: drafts only
   * (graduate to active on first real-use success), deduped against existing
   * skills, and the Warden caps authoring bursts (skill_authoring_flood).
   */
  autoAuthor: z.boolean().default(true),
  /** Min delegations/tool steps in a successful turn before auto-authoring is considered. */
  minStepsToAuthor: z.number().int().min(1).max(50).default(3),
  /** Max skills retrieved and injected into the planner prompt per turn. */
  maxInjected: z.number().int().min(1).max(10).default(3),
  /** Success-rate floor (0–1) below which the driver retires a skill (Phase 3). */
  retireBelowSuccessRate: z.number().min(0).max(1).default(0.34),
  /** Minimum recorded uses before retirement is considered (Phase 3). */
  retireMinUses: z.number().int().min(1).max(100).default(5),
  /**
   * Auto-promote consistently reliable skills into reusable scenes in the
   * workflow catalog. Disable to keep the swarm from creating scenes without an
   * operator in the loop while still authoring/retiring skills.
   */
  autoPromoteToScene: z.boolean().default(true),
  /**
   * Holdout sampling rate (0–1) for measuring skill lift. With probability
   * holdoutRate, the top matching skill is NOT injected for a turn and that
   * turn's outcome is recorded as a baseline. Comparing injected vs. held-out
   * success (skillLift) shows whether the skill actually helps or whether its
   * success rate just reflects easy matching tasks — so retirement can be
   * driven by evidence of value, not raw success rate. 0 disables (default);
   * 0.15 is a reasonable measurement rate.
   */
  holdoutRate: z.number().min(0).max(0.5).default(0),
});

export type SkillLibraryConfig = z.infer<typeof SkillLibrarySchema>;

const MemoryConfigSchema = z.object({
  /**
   * When a session is archived, promote its durable-worthy shared-facts into
   * workspace memory (embedded on write) so long-term memory accumulates across
   * sessions instead of being lost when the session closes. Deterministic,
   * deduped, credential-scrubbed, and bounded by maxConsolidatedPerSession.
   */
  autoConsolidateSessions: z.boolean().default(true),
  /** Max facts promoted to durable memory per archived session. */
  maxConsolidatedPerSession: z.number().int().min(1).max(50).default(8),
  /** Minimum fact-value length (chars) to be worth promoting. */
  minConsolidatedFactChars: z.number().int().min(1).max(2_000).default(40),
  /**
   * Sleep-time consolidation: a periodic idle pass over durable memory that
   * compacts near-duplicates and backfills missing embeddings (Letta-style
   * background reflection). Safe and additive — it never deletes facts. Set
   * false to keep memory maintenance write-triggered only.
   */
  sleepTimeConsolidation: z.boolean().default(true),
  /** Interval (ms) between sleep-time consolidation sweeps. Default 30 min. */
  consolidationIntervalMs: z.number().int().min(60_000).max(6 * 3_600_000).default(30 * 60_000),
  /**
   * Temporal supersession: when a new durable fact is stored under the same
   * explicit subject as an existing one but with different content, mark the
   * older record superseded and exclude it from retrieval (Zep/Graphiti-style
   * validity). Prevents stale facts from resurfacing. Superseded records stay
   * on disk for forensics. Default true.
   */
  supersedeStaleFacts: z.boolean().default(true),
});

export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

export const ToolPipelineSchema = z.object({
  /**
   * Enable run_tool_pipeline: a declarative batch executor that runs several
   * tool calls in one turn (collapsing model round-trips). Every step still
   * dispatches through the normal tier/approval/audit path AND is restricted to
   * the calling agent's own tool allowlist — so it batches without escalating.
   * Only agents explicitly granted run_tool_pipeline can use it.
   */
  enabled: z.boolean().default(true),
  /** Maximum steps in a single pipeline. */
  maxSteps: z.number().int().min(1).max(25).default(8),
  /** Cap on a prior step's output length when substituted into a later step's args. */
  maxTemplateOutputChars: z.number().int().min(200).max(20_000).default(4_000),
});

export type ToolPipelineConfig = z.infer<typeof ToolPipelineSchema>;

// ─── Orchestration tuning ─────────────────────────────────────────────────────
// OrchestrationSchema + OrchestrationConfig moved to ./schemas/orchestration.ts;
// re-exported above.

// ─── Effort profiles ──────────────────────────────────────────────────────────
// EFFORT_TIERS / EffortTierSchema / EffortProfileSchema / EffortSchema + the
// EffortProfile / EffortTier / EffortConfig types moved to ./schemas/effort.ts;
// re-exported above.

/**
 * Receptionist fast lane — an opt-in first-contact gatekeeper that answers
 * trivial conversational turns (greetings, thanks, "how are you") with a tiny
 * routing-tier model + a compressed memory capsule, skipping the full system
 * prompt, tool loading, and the swarm loop. Any miss (task intent, a registered
 * fork escalate term, no routing tier configured, model escalation, or error)
 * falls through to the full runtime, so enabling it can only cut latency on
 * trivial turns — it never changes how real work is handled. Requires
 * `agents.defaults.model.tiers.routing`. Forks specialise the front desk via
 * registerReceptionistPolicy() (agent/receptionist-policy.ts).
 */
export const ReceptionistSchema = z.object({
  /** Master switch. Default false (opt-in, fail-safe fall-through). */
  enabled: z.boolean().default(false),
  /** A fast-lane reply longer than this is treated as an escalation — a real
   *  answer belongs on the full path, not the front desk. */
  maxResponseChars: z.number().int().min(40).max(2_000).default(400),
  /** Extra terms (beyond registered fork policies) that must always escalate to
   *  the full runtime rather than be answered at the front desk. */
  alwaysEscalateTerms: z.array(z.string()).default([]),
  /** CONFIDENCE-ATTEMPT mode (vLLM "Confidence" micro-agent pattern). When true, the
   *  front desk no longer answers ONLY trivial smalltalk: a clearly-direct, self-
   *  contained question that the turn classifier flagged with NO task intent (so it is
   *  not research/freshness/source/user-own-facts/mail/etc. — all of which still
   *  escalate) becomes a fast-lane candidate. The routing-tier model either answers it
   *  OR emits an abstain/low-confidence signal, and the answer is accepted ONLY when it
   *  self-reports high confidence; anything unparseable, low, or sentinel escalates
   *  (fail-SAFE to the full model). This attacks the generation-latency floor for
   *  general-knowledge questions the cheap model can fully answer, without touching how
   *  any flagged/real work is routed. Default OFF until a pass^k eval (with negative
   *  abstain cases) confirms the cheap model does not over-answer. */
  confidenceAttempt: z.boolean().default(false),
  /** Candidate-length ceiling for confidenceAttempt's relaxed Stage-0 gate: a question
   *  longer than this still escalates WITHOUT a micro-call (likely multi-part/complex).
   *  Only consulted when confidenceAttempt is on. */
  confidenceAttemptMaxChars: z.number().int().min(120).max(1_000).default(400),
});

export const ConfigSchema = z.object({
  providers: ProvidersSchema.default({}),
  agents: z.object({
    defaults: z.object({
      model: ModelConfigSchema.default({}),
      /** Named alternates for the default chat model, switchable at runtime
       *  from the dashboard header. An implicit "claude" preset exists
       *  whenever providers.anthropic is configured (model from
       *  providers.anthropic.defaultModel). */
      modelPresets: z.record(ModelPresetSchema).default({}),
      /** Currently active preset name; unset = the configured local default.
       *  Persisted by the dashboard switch into the runtime overlay. */
      activeModelPreset: z.string().optional(),
      /** How WIDELY the active preset (e.g. "claude") is applied across the swarm — the
       *  granularity dial for the "Local ⇄ Claude" switch. Only meaningful when activeModelPreset
       *  is set (unset = "off", pure local):
       *   - "all" (default, back-compat): the preset replaces EVERY agent's model — the whole swarm
       *     runs on the preset model.
       *   - "unspecified": the preset applies to the orchestrator and any sub-agent that did NOT set
       *     its own model; a sub-agent with an explicit `model.primary` keeps it.
       *   - "coordinator_qa": the preset applies ONLY to the high-leverage reasoning roles — the main
       *     orchestrator plus sub-agents whose role is coordinator / planner / reviewer (QA). Every
       *     execution specialist (researcher, coder, …) stays on its own configured model.
       *  Persisted by the dashboard switch into the runtime overlay alongside activeModelPreset. */
      modelPresetScope: z.enum(["all", "unspecified", "coordinator_qa"]).default("all"),
    }).default({}),
    mainAssistant: MainAssistantConfigSchema.default({}),
    ephemeralGeneration: EphemeralGenerationSchema.default({}),
    /** When true, ALL sub-agents default to containerized execution (Docker isolation).
     *  Individual agents can opt out by setting container.disabled: true in their config.
     *  Defaults to true to align with the "every agent runs in an isolated container"
     *  security principle. The gateway runs a Docker reachability probe at startup —
     *  if Docker is unreachable while this flag is on, startup aborts loud rather than
     *  silently falling back to in-process execution. Set explicitly to false to keep
     *  the legacy in-process default.
     *
     *  Environment override: <ENV_PREFIX>_DEFAULT_CONTAINERIZED=false flips the default
     *  back to false (used by the test harness to keep mock-LLM tests in-process). */
    defaultContainerized: z.boolean().default(
      productEnv("DEFAULT_CONTAINERIZED") === "false" ? false : true,
    ),
    rateLimit: RateLimitSchema.default({}),
    /** Maximum tool-call iterations for the orchestrator per turn */
    maxToolIterations: z.number().int().min(1).max(100).default(20),
    /** Session pruning check interval in ms */
    sessionPruneIntervalMs: z.number().int().min(10_000).max(600_000).default(60_000),
    /** Auto-archive a still-active session after this long with no activity, so it
     *  drops out of the hot active set (otherwise abandoned sessions accumulate in
     *  memory). Generous by default — a turn touches on activity and is capped well
     *  under this, so a live turn is never mistaken for idle. Set to 0 to disable
     *  idle archival entirely (the value is honored: 0/negative turns it off). */
    sessionIdleArchiveMs: z.number().int().refine((v) => v <= 0 || v >= 60_000, "must be 0 (disabled) or at least 60000ms").default(86_400_000), // 24h
    /** Retention for sessions archived because they went IDLE (real user conversations).
     *  These are NOT reclaimed on the short ephemera TTL (gateway.sessionTtlMs) — a chat
     *  merely idle for a day must not be permanently deleted an hour later. Default 0 =
     *  keep idle-archived conversations indefinitely (the user can clear them manually);
     *  set a positive value to auto-delete them after that long. */
    sessionIdleRetentionMs: z.number().int().refine((v) => v <= 0 || v >= 3_600_000, "must be 0 (keep forever) or at least 3600000ms").default(0),
    /** Latency SLO and prompt budget thresholds */
    performance: z.object({
      /** Max orchestrator turn duration before a turn_slo_breach alert fires (ms). Default 2 min. */
      orchestratorTurnSloMs: z.number().int().min(5_000).default(120_000),
      /** Max sub-agent turn duration before a turn_slo_breach alert fires (ms). Default 60 s. */
      subAgentTurnSloMs: z.number().int().min(5_000).default(60_000),
      /** Max first-model-response latency before a turn_slo_breach alert fires (ms). Default 30 s. */
      firstTokenSloMs: z.number().int().min(1_000).default(30_000),
      /** Warn when system prompt exceeds this char count (~8k tokens). */
      promptBudgetChars: z.number().int().min(1_000).default(32_000),
      /**
       * Lean context injection. When true, the per-turn memory/user-model/skill/
       * flow/trajectory blocks are NOT pushed into the system prompt; instead a
       * tiny digest tells the model to pull them on demand via recall_context.
       * Keeps the prompt lean and saves the retrieval latency on turns that don't
       * need it. Default true — validated against qwen3.6-35b (May 2026): routing
       * unchanged vs. always-on injection, and the model pulls context via
       * recall_context before delegating. Set false to restore always-on blocks.
       */
      leanContextInjection: z.boolean().default(true),
      /**
       * Task-conditional base prompt. When true, the always-on intent-routing
       * rules (computer-use / server-ops / pentest-methodology / swarm-maintenance)
       * are dropped from the static system prompt — the per-turn classifier
       * already injects richer, more specific guidance for each of those intents
       * only when it fires. Trims the base template, BUT relies on the classifier
       * catching the intent — and it misses untyped phrasings (a bare "run a
       * shell command" or "code a website" with no ssh/docker keyword), leaving
       * the orchestrator with no routing hint so it over-routes to the generic
       * mission_coordinator. Default false (reverted May 2026 after that
       * regression surfaced in live use); keep the always-on routing rules until
       * the classifier covers those intents.
       */
      taskConditionalPrompt: z.boolean().default(false),
      /**
       * Split orchestration prompt. When true, the contiguous orchestration block
       * (Swarm Rules → Orchestration Strategy, ~13KB / ~half the base) is lifted out
       * of the always-on system prompt and injected back only on turns that show
       * orchestration intent (the per-turn classifier fired). A direct-answer turn
       * then pays a roughly half-size prompt — faster first token, fewer input tokens —
       * while the delegation TOOLS and the honesty/core sections stay available regardless,
       * so a misclassified turn loses routing GUIDANCE, not capability. Default off
       * (eval-gate the routing quality before flipping). See runtime.ts (marker split).
       */
      splitOrchestrationPrompt: z.boolean().default(false),
      /**
       * Prompt-cache warm-keeper. When true, a background warm-up prefills the
       * orchestrator's stable base system prompt into the model server's KV cache
       * (cache_prompt) on boot and a short idle window after each turn, so the next
       * real turn reuses the prefix instead of paying the cold prefill. Aborts the
       * instant a real turn starts; strictly best-effort, never slows a turn.
       * Default off (A/B the first-token latency). See agent/cache-warmer.ts.
       */
      promptCacheWarmKeeper: z.boolean().default(false),
      /** Idle window (ms) after a turn before the warm-keeper re-warms the prefix. */
      promptCacheWarmIdleMs: z.number().int().min(1_000).max(120_000).default(4_000),
      /**
       * Max chars of a single delegated agent's result that the orchestrator
       * relays verbatim. Long deliverables (guides, reports) above this are
       * truncated before the relay, cutting the user's answer off mid-way. The
       * 10k default fits small context windows; raise it for models with a
       * larger context so full deliverables come through (it is added to the
       * relay prompt, so keep it within the model's context budget).
       */
      maxDelegatedResultChars: z.number().int().min(2_000).max(200_000).default(10_000),
      /**
       * Soft routing enforcement. The orchestrator injects per-turn enforcement
       * system messages (maintenance / workflow-catalog / search-no-match) as
       * hard imperative gates ("You MUST … this turn", removing tools from the
       * set). The trust-the-LLM direction is soft hints, not hard gates — but
       * softening changes tuned routing behavior, so it is gated here and
       * requires live-model eval before flipping. When true, the *routing-class*
       * enforcement prompts are reframed as strong recommendations and the hard
       * search_agents tool-removal gate is relaxed to a hint. Anti-hallucination
       * enforcement (source-sensitive research) and correctness enforcement
       * (unresolved clarification) stay hard regardless. Default false (current
       * eval-validated behavior).
       */
      softRoutingEnforcement: z.boolean().default(false),
    }).default({}),
    /**
     * Soft per-task budgets enforced AFTER a delegated sub-agent finishes.
     * They are observability signals, not mid-flight kills (turnTimeoutMs handles
     * hard cutoffs). When a delegation exceeds any limit, the attempt and task are
     * tagged with budgetExceeded + a list of which limits tripped, and a budget
     * audit event fires. The sub-agent's output is still returned — orchestrators
     * can decide whether to spend more on a retry or stop here.
     *
     * Set any field to 0 to disable that specific check.
     */
    budgets: z.object({
      /** Cap on total tokens (prompt + completion) attributed to a single delegation attempt. */
      maxTokensPerTask: z.number().int().min(0).default(0),
      /** Cap on tool-call count for a single delegation attempt. */
      maxToolCallsPerTask: z.number().int().min(0).default(0),
      /** Cap on wall-clock duration for a single delegation attempt (ms). */
      maxDurationMsPerTask: z.number().int().min(0).default(0),
    }).default({}),
  }).default({}),
  subAgents: SubAgentsSchema.default({}),
  scenes: ScenesSchema.default({}),
  jobs: JobsSchema.default({}),
  channels: ChannelsSchema.default({}),
  gateway: GatewaySchema.default({}),
  guardrails: GuardrailsSchema.default({}),
  multimodal: MultimodalSchema.default({}),
  retrieval: RetrievalSchema.default({}),
  mcp: McpConfigSchema.default({}),
  sites: SitesSchema.default({}),
  webhooks: WebhooksSchema.default({}),
  approvalChannels: ApprovalChannelsSchema.default({}),
  infrastructure: InfrastructureSchema.default({}),
  monitoring: MonitoringSchema.default({}),
  sourceForge: SourceForgeSchema.default({}),
  pentest: PentestSchema.default({}),
  mail: MailServiceSchema.default({}),
  toolDevelopment: ToolDevelopmentSchema.default({}),
  selfImprovement: SelfImprovementSchema.default({}),
  skillLibrary: SkillLibrarySchema.default({}),
  memory: MemoryConfigSchema.default({}),
  toolPipeline: ToolPipelineSchema.default({}),
  dataFeeds: DataFeedsSchema.default({}),
  /** Computer use configuration — validated separately by Joi, passed through by Zod. */
  computerUse: z.record(z.unknown()).default({}),
  auth: AuthSchema.default({}),
  storage: StorageSchema.default({}),
  cost: CostSchema.default({}),
  tracing: TracingSchema.default({}),
  federation: FederationSchema.default({}),
  a2a: A2ASchema.default({}),
  /**
   * Plugin SDK — third-party tool packages loaded from a directory at
   * startup.  When `enabled` is false the loader is skipped entirely.
   * When the directory is unset the loader falls back to
   * `~/.starlingai/plugins`.  Plugin tools register under
   * `plugin__<plugin-name>__<tool-name>` at Tier 2 (sandboxed, per-call
   * approval) — plugins cannot grant themselves higher tiers.
   */
  plugins: z.object({
    enabled: z.boolean().default(true),
    dir: z.string().optional(),
  }).default({}),
  /**
   * Built-in tool surface control.  Forks disable whole capability families
   * here instead of deleting upstream tool files (deletions are the worst
   * rebase-conflict source — see docs/fork-boilerplate-plan.md WS2).
   * Group names live in tools/groups.ts; unknown names are ignored with a
   * warning so configs stay portable across versions.
   */
  tools: z.object({
    /** Built-in group names to skip at registration (e.g. "pentest", "infrastructure"). */
    disabledGroups: z.array(z.string()).default([]),
    /** Individual tool names to skip at registration. */
    disabledTools: z.array(z.string()).default([]),
  }).default({}),
  /**
   * Per-extension config slices for first-party core extensions
   * (src/extensions/<name>/), keyed by extension name. Passed through opaquely
   * here; each extension validates its own slice with the `configSchema` from
   * its manifest at boot.
   */
  extensions: z.record(z.unknown()).default({}),
  workspacePath: z.string().default("/workspace"),
  orchestration: OrchestrationSchema.default({}),
  effort: EffortSchema.default({}),
  receptionist: ReceptionistSchema.default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type GatewayConfig = z.infer<typeof GatewaySchema>;
// MultimodalFileConfig / MultimodalSpeechToTextConfig / MultimodalTextToSpeechConfig
// re-exported from ./schemas/multimodal.js; RetrievalSearchConfig from
// ./schemas/retrieval.js (both above).
export type InfrastructureAutomationProfile = z.infer<typeof InfrastructureAutomationProfileSchema>;
export type MailServiceConfig = z.infer<typeof MailServiceSchema>;
