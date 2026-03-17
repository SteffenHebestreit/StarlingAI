import { z } from "zod";

export const LMStudioProviderSchema = z.object({
  baseUrl: z.string().url().default("http://host.docker.internal:1234/v1"),
  apiKey: z.string().default("lm-studio"),
  timeoutMs: z.number().int().min(5000).max(300000).default(30000),
  maxRetries: z.number().int().min(0).max(5).default(3),
});

export const OllamaProviderSchema = z.object({
  baseUrl: z.string().url().default("http://host.docker.internal:11434"),
  api: z.literal("ollama-native").default("ollama-native"),
  timeoutMs: z.number().int().min(5000).max(300000).default(30000),
});

export const AnthropicProviderSchema = z.object({
  apiKey: z.string().min(1),
  timeoutMs: z.number().int().min(5000).max(120000).default(60000),
});

export const ProvidersSchema = z.object({
  lmstudio: LMStudioProviderSchema.optional(),
  ollama: OllamaProviderSchema.optional(),
  anthropic: AnthropicProviderSchema.optional(),
});

export const ModelConfigSchema = z.object({
  primary: z.string().max(200).default("lmstudio/qwen3.5"),
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
});

export const RateLimitSchema = z.object({
  requestsPerMinute: z.number().int().min(1).max(600).default(60),
  toolCallsPerTurn: z.number().int().min(1).max(50).default(20),
  concurrentSessions: z.number().int().min(1).max(100).default(10),
  windowMs: z.number().int().min(10_000).max(600_000).default(60_000),
});

export const ChannelWebChatSchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().int().min(1024).max(65535).default(3001),
});

export const ChannelTelegramSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().min(1).optional(),
  allowedUserIds: z.array(z.number().int()).default([]),
});

// ─── Channel base (shared fields for all inbound message channels) ────────────
const ChannelBaseSchema = z.object({
  enabled: z.boolean().default(false),
  /** How unknown senders are handled */
  dmPolicy: z.enum(["open", "allowlist", "pairing", "disabled"]).default("pairing"),
  /** Sender IDs to allow (channel-specific format). "*" = all. */
  allowFrom: z.array(z.string()).default([]),
  /** Max messages kept per chat session */
  historyLimit: z.number().int().min(1).max(500).default(50),
  /** Per-sender inbound message budget within the rolling window */
  perSenderRateLimitCount: z.number().int().min(1).max(200).default(12),
  /** Rolling window for per-sender inbound rate limits */
  perSenderRateLimitWindowMs: z.number().int().min(1000).max(3_600_000).default(60_000),
});

export const ChannelSlackSchema = ChannelBaseSchema.extend({
  /** xoxb-... Bot User OAuth Token */
  botToken: z.string().optional(),
  /** xapp-... App-Level Token (Socket Mode) — leave empty for Events API mode */
  appToken: z.string().optional(),
  /** Signing secret for verifying Events API requests */
  signingSecret: z.string().optional(),
});

export const ChannelDiscordSchema = ChannelBaseSchema.extend({
  /** Bot token from Discord Developer Portal */
  token: z.string().optional(),
  /** Restrict to specific guild (server) IDs; empty = respond in all guilds + DMs */
  guildIds: z.array(z.string()).default([]),
});

export const ChannelWhatsappSchema = ChannelBaseSchema.extend({
  /** Webhook verify token (set same value in Meta Developer Console) */
  verifyToken: z.string().optional(),
  /** Meta app secret used to validate X-Hub-Signature-256 on inbound webhooks */
  appSecret: z.string().optional(),
  /** Permanent access token or $ENV_VAR for the Meta Graph API */
  accessToken: z.string().optional(),
  /** WhatsApp Business phone number ID from Meta Console */
  phoneNumberId: z.string().optional(),
});

export const ChannelEmailSchema = ChannelBaseSchema.extend({
  imapHost: z.string().optional(),
  imapPort: z.number().int().default(993),
  imapUser: z.string().optional(),
  imapPassword: z.string().optional(),
  smtpHost: z.string().optional(),
  smtpPort: z.number().int().default(587),
  smtpUser: z.string().optional(),
  smtpPassword: z.string().optional(),
  smtpFrom: z.string().optional(),
  pollIntervalMs: z.number().int().min(5000).default(30_000),
});

export const ChannelSignalSchema = ChannelBaseSchema.extend({
  /** Registered Signal account (phone number) */
  account: z.string().optional(),
  /** Path to signal-cli binary */
  signalCliPath: z.string().default("signal-cli"),
});

export const ChannelsSchema = z.object({
  webchat: ChannelWebChatSchema.default({}),
  telegram: ChannelTelegramSchema.default({}),
  slack: ChannelSlackSchema.default({}),
  discord: ChannelDiscordSchema.default({}),
  whatsapp: ChannelWhatsappSchema.default({}),
  email: ChannelEmailSchema.default({}),
  signal: ChannelSignalSchema.default({}),
});

export type ChannelSlackConfig = z.infer<typeof ChannelSlackSchema>;
export type ChannelDiscordConfig = z.infer<typeof ChannelDiscordSchema>;
export type ChannelWhatsappConfig = z.infer<typeof ChannelWhatsappSchema>;
export type ChannelEmailConfig = z.infer<typeof ChannelEmailSchema>;
export type ChannelSignalConfig = z.infer<typeof ChannelSignalSchema>;

export const GatewaySchema = z.object({
  port: z.number().int().min(1024).max(65535).default(8765),
  restPort: z.number().int().min(1024).max(65535).default(8766),
  bindHost: z.enum(["loopback", "lan", "docker"]).default("loopback"),
  jwtSecret: z.string().min(32).optional(), // loaded from env if not set
  sessionTtlMs: z.number().int().min(60000).default(3600000), // 1 hour
  turnTimeoutMs: z.number().int().min(30000).default(900000), // 15 minutes
  maxBodyBytes: z.number().int().min(1024).max(52_428_800).default(1_048_576), // 1 MB
  /** Publicly reachable base URL, used to construct approval callback URLs sent to external systems */
  publicUrl: z.string().url().optional(),
});

export const MultimodalServiceSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().optional(),
  timeoutMs: z.number().int().min(1000).max(300000).default(60000),
});

export const MultimodalFileServiceSchema = MultimodalServiceSchema.extend({
  baseUrl: z.string().url().default("http://host.docker.internal:8010"),
  mcpServer: z.string().min(1).optional(),
  toolName: z.string().min(1).default("file_to_markdown"),
  /** Vision model used as fallback for images when file_to_markdown returns no content.
   *  Format: same as agents.defaults.model.primary, e.g. "lmstudio/qwen2-vl-7b-instruct"
   *  When set, the gateway encodes the image as base64 and calls the LM Studio vision API. */
  visionModel: z.string().min(1).optional(),
});

export const MultimodalSpeechToTextSchema = MultimodalServiceSchema.extend({
  baseUrl: z.string().url().default("http://qwen3-asr-service:5002"),
  model: z.string().min(1).default("Qwen/Qwen3-ASR-1.7B"),
});

export const MultimodalTextToSpeechSchema = MultimodalServiceSchema.extend({
  baseUrl: z.string().url().default("http://qwen3-tts-service:5004"),
  model: z.string().min(1).default("Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"),
  defaultLanguage: z.string().min(2).default("English"),
  defaultSpeaker: z.string().min(1).default("Vivian"),
  defaultVoiceId: z.string().min(1).optional(),
  voiceSamplePath: z.string().min(1).optional(),
  voiceSampleText: z.string().min(1).optional(),
  defaultQuality: z.string().min(1).default("medium"),
  /** Auto-speak a summary of the assistant reply after each turn when voice-input mode is active. */
  speakReplySummary: z.boolean().default(false),
  /** Maximum number of spoken sentences in the auto-generated reply summary. */
  speakReplySummaryMaxSentences: z.number().int().min(1).max(5).default(3),
});

export const MultimodalWakeWordSchema = z.object({
  enabled: z.boolean().default(false),
  language: z.enum(["de-DE", "en-US", "pl-PL"]).default("en-US"),
  keywords: z.array(z.string().min(1)).default(["Hey Guarded", "Okay Guarded", "Luna"]),
  stopPhrases: z.array(z.string().min(1)).default(["stop recording", "end recording", "stop listening", "luna stop"]),
  silenceTimeoutMs: z.number().int().min(1000).max(15000).default(4000),
});

export const MultimodalSchema = z.object({
  maxUploadBytes: z.number().int().min(1024).max(104_857_600).default(20_971_520),
  files: MultimodalFileServiceSchema.default({}),
  stt: MultimodalSpeechToTextSchema.default({}),
  tts: MultimodalTextToSpeechSchema.default({}),
  wakeWord: MultimodalWakeWordSchema.default({}),
});

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
  /** Extra host mappings injected as --add-host=host:ip (e.g. ["n8n.k2o:192.168.1.50"]) */
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

export const McpConfigSchema = z.object({
  servers: z.record(McpServerConfigSchema).default({}),
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
});

export const SitesSchema = z.record(SiteCredentialSchema);  // keyed by hostname

export type SiteCredential = z.infer<typeof SiteCredentialSchema>;

// ─── Sub-agent definitions ───────────────────────────────────────────────────
// Specialized agents with their own model, system prompt, and allowed tool set.
// Referenced by the delegate_to_agent tool from the orchestrator.

export const SubAgentContainerSchema = z.object({
  enabled: z.boolean().default(false),
  image: z.string().default("starlingai/agent-worker:dev"),
  memoryMb: z.number().int().min(128).max(4096).default(512),
  cpus: z.number().min(0.1).max(4).default(0.5),
  timeoutMs: z.number().int().min(5000).max(300000).default(60000),
});

export const SubAgentConfigSchema = z.object({
  description: z.string(),                          // shown to orchestrator LLM
  capabilities: z.array(z.string()).default([]),   // explicit routing keywords, e.g. ["browser", "forms"]
  tags: z.array(z.string()).default([]),           // lightweight product/category tags for discovery
  /** Product domain grouping — research | coding | browser | data | communication | workflow | reliability */
  domain: z.string().optional(),
  model: ModelConfigSchema.partial().optional(),    // overrides agents.defaults.model
  systemPrompt: z.string().optional(),              // specialist persona
  tools: z.array(z.string()).optional(),            // allowed tool names; undefined = inherit all
  maxIterations: z.number().int().min(1).max(20).default(5), // hard cap on tool-call loops
  turnTimeoutMs: z.number().int().min(1_000).max(900_000).optional(), // optional per-agent wall-clock turn timeout
  maxConcurrent: z.number().int().min(1).max(20).optional(), // max simultaneous containers (default: 3)
  container: SubAgentContainerSchema.optional(),    // run in ephemeral Docker container
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


// ─── Guardrails ───────────────────────────────────────────────────────────────

export const GuardrailsSchema = z.object({
  promptInjectionBlock: z.boolean().default(true),
  outputSecretScan: z.boolean().default(true),
  maxInputLength: z.number().int().min(100).max(100000).default(32000),
  sandboxShellExec: z.boolean().default(true), // ALWAYS sandbox shell — hard override in code
});

// ─── Scenes ───────────────────────────────────────────────────────────────────
// Named, reusable workflows that can be triggered via chat (/run <name>) or
// via a webhook POST /api/scenes/:name/run?key=<webhookKey>.

export const SceneParamSchema = z.object({
  description: z.string().optional(),          // shown in /run help output
  default: z.string().optional(),              // used when param not provided
});

export const SceneConfigSchema = z.object({
  description: z.string(),                     // shown when listing scenes
  task: z.string().min(1),                     // the prompt injected into the session
  webhookKey: z.string().min(16).optional(),   // shared secret for unauthenticated webhook calls
  params: z.record(SceneParamSchema).optional(),    // named {{param|default}} template vars
  allowedAgents: z.array(z.string()).optional(),    // restrict which sub-agents this scene may use
  humanInLoopSteps: z.array(z.string()).optional(), // tool names that require user approval in this scene
  /** Name of an entry in `approvalChannels` — used when this scene is triggered via webhook */
  approvalChannel: z.string().optional(),
});

export const ScenesSchema = z.record(SceneConfigSchema);
export type SceneConfig = z.infer<typeof SceneConfigSchema>;

export const ConfigSchema = z.object({
  providers: ProvidersSchema.default({}),
  agents: z.object({
    defaults: z.object({
      model: ModelConfigSchema.default({}),
    }).default({}),
    rateLimit: RateLimitSchema.default({}),
    /** Maximum tool-call iterations for the orchestrator per turn */
    maxToolIterations: z.number().int().min(1).max(100).default(20),
    /** Session pruning check interval in ms */
    sessionPruneIntervalMs: z.number().int().min(10_000).max(600_000).default(60_000),
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
    }).default({}),
  }).default({}),
  subAgents: SubAgentsSchema.default({}),
  scenes: ScenesSchema.default({}),
  channels: ChannelsSchema.default({}),
  gateway: GatewaySchema.default({}),
  guardrails: GuardrailsSchema.default({}),
  multimodal: MultimodalSchema.default({}),
  mcp: McpConfigSchema.default({}),
  sites: SitesSchema.default({}),
  webhooks: WebhooksSchema.default({}),
  approvalChannels: ApprovalChannelsSchema.default({}),
  workspacePath: z.string().default("/workspace"),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type GatewayConfig = z.infer<typeof GatewaySchema>;
