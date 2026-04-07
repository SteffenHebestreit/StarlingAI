import { z } from "zod";

const OptionalEndpointUrlSchema = z.preprocess(
  (value) => typeof value === "string" ? value.trim() : value,
  z.union([z.literal(""), z.string().url()]),
);

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
  apiKey: z.string().min(1),
  timeoutMs: z.number().int().min(5000).max(120000).default(60000),
});

export const ProvidersSchema = z.object({
  lmstudio: LMStudioProviderSchema.optional(),
  openaiCompatible: z.record(OpenAICompatibleProviderSchema).default({}),
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
  /** Optional dedicated endpoint for embeddings when they must run on a separate server from the main chat model. */
  embeddingBaseUrl: z.string().url().optional(),
  /** Optional API key for the dedicated embedding endpoint. */
  embeddingApiKey: z.string().optional(),
  /** Enable or disable extended reasoning for LM Studio chat models that support
   *  chat_template_kwargs.enable_thinking (for example Qwen3.5 and Gemma 4).
   *  true / false → sends chat_template_kwargs: { enable_thinking: <value> }
   *  undefined → no thinking parameter sent (model default).
   *  Qwen keeps its special sampling auto-tuning unless explicitly overridden;
   *  other models retain their configured sampling values. */
  enableThinking: z.boolean().optional(),
});

export const RateLimitSchema = z.object({
  requestsPerMinute: z.number().int().min(1).max(600).default(60),
  toolCallsPerTurn: z.number().int().min(1).max(50).default(20),
  concurrentSessions: z.number().int().min(1).max(100).default(10),
  windowMs: z.number().int().min(10_000).max(600_000).default(60_000),
});

export const MainAssistantConfigSchema = z.object({
  toolMode: z.enum(["hybrid", "orchestration_only", "delegate_only"]).default("orchestration_only"),
  customInstructions: z.string().trim().min(1).max(6000).optional(),
});

export const EphemeralGenerationSchema = z.object({
  enabled: z.boolean().default(true),
  skillMatchThreshold: z.number().min(0).max(1).default(0.7),
  architectAgentName: z.string().min(1).default("agent_architect"),
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
  turnTimeoutMs: z.number().int().min(30000).default(1800000), // 30 minutes
  maxBodyBytes: z.number().int().min(1024).max(52_428_800).default(1_048_576), // 1 MB
  /** Publicly reachable base URL, used to construct approval callback URLs sent to external systems */
  publicUrl: z.string().url().optional(),
  /** Additional browser origins allowed to call the gateway directly when the dashboard runs on a separate host */
  corsAllowedOrigins: z.array(z.string().url()).default([]),
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
  /** Optional dedicated OpenAI-compatible endpoint for the vision model fallback. */
  visionBaseUrl: z.string().url().optional(),
  /** Optional API key for the dedicated vision endpoint. */
  visionApiKey: z.string().optional(),
});

export const MultimodalSpeechToTextSchema = MultimodalServiceSchema.extend({
  baseUrl: OptionalEndpointUrlSchema.default(""),
  api: z.enum(["auto", "openai-compatible", "transcribe-only"]).default("auto"),
  model: z.string().min(1).default("whisper-1"),
});

export const MultimodalTextToSpeechSchema = MultimodalServiceSchema.extend({
  baseUrl: OptionalEndpointUrlSchema.default(""),
  api: z.enum(["qwen-compatible", "openai-compatible"]).default("openai-compatible"),
  model: z.string().min(1).default("tts-1"),
  defaultLanguage: z.string().min(2).default("English"),
  defaultSpeaker: z.string().min(1).default("alloy"),
  defaultVoiceId: z.string().min(1).optional(),
  voiceSamplePath: z.string().min(1).optional(),
  voiceSampleText: z.string().min(1).optional(),
  defaultQuality: z.string().min(1).default("medium"),
  /** Auto-speak a summary of the assistant reply after each turn when voice-input mode is active. */
  speakReplySummary: z.boolean().default(false),
  /** Maximum number of spoken sentences in the auto-generated reply summary. */
  speakReplySummaryMaxSentences: z.number().int().min(1).max(5).default(3),
});

export const MultimodalImageGenerationSchema = MultimodalServiceSchema.extend({
  baseUrl: OptionalEndpointUrlSchema.default(""),
  api: z.enum(["automatic1111-compatible", "comfyui"]).default("automatic1111-compatible"),
  model: z.string().min(1).optional(),
  defaultWidth: z.number().int().min(256).max(2048).default(1024),
  defaultHeight: z.number().int().min(256).max(2048).default(1024),
  defaultSteps: z.number().int().min(1).max(100).default(28),
  defaultGuidanceScale: z.number().min(0).max(20).default(7),
  /** Default negative prompt appended to every generate_image call unless the agent supplies one. */
  defaultNegativePrompt: z.string().optional(),
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
  imageGeneration: MultimodalImageGenerationSchema.optional(),
});

export const RetrievalRerankerSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: z.string().url().default("http://host.docker.internal:1234/v1"),
  apiKey: z.string().default("lm-studio"),
  model: z.string().min(1).default("Qwen/Qwen3-Reranker-4B"),
  timeoutMs: z.number().int().min(1000).max(120000).default(15000),
  topK: z.number().int().min(2).max(12).default(6),
});

export const RetrievalSearchSchema = z.object({
  backend: z.enum(["auto", "searxng", "playwright", "duckduckgo"]).default("auto"),
  searxngBaseUrl: z.string().url().optional(),
  timeoutMs: z.number().int().min(1000).max(60000).default(12000),
});

export const RetrievalSchema = z.object({
  reranker: RetrievalRerankerSchema.default({}),
  search: RetrievalSearchSchema.default({}),
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
  model: ModelConfigSchema.partial().optional(),    // overrides agents.defaults.model
  systemPrompt: z.string().optional(),              // specialist persona
  tools: z.array(z.string()).optional(),            // allowed tool names; undefined = inherit all
  maxIterations: z.number().int().min(1).max(30).default(5), // hard cap on tool-call loops
  turnTimeoutMs: z.number().int().min(1_000).max(1_800_000).optional(), // optional per-agent wall-clock turn timeout
  maxConcurrent: z.number().int().min(1).max(20).optional(), // max simultaneous containers (default: 3)
  container: SubAgentContainerSchema.optional(),    // run in ephemeral Docker container
  /** GPU/compute resource requirements — used for GPU-aware routing. */
  compute: AgentComputeProfileSchema,
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
  /** If true, skip initial capability-gap approval and start dev session directly. */
  autoStartDevSession: z.boolean().default(false),
});

export type ToolDevelopmentConfig = z.infer<typeof ToolDevelopmentSchema>;
export type SelfImprovementConfig = z.infer<typeof SelfImprovementSchema>;

export const ConfigSchema = z.object({
  providers: ProvidersSchema.default({}),
  agents: z.object({
    defaults: z.object({
      model: ModelConfigSchema.default({}),
    }).default({}),
    mainAssistant: MainAssistantConfigSchema.default({}),
    ephemeralGeneration: EphemeralGenerationSchema.default({}),
    /** When true, ALL sub-agents default to containerized execution (Docker isolation).
     *  Individual agents can opt out by setting container.disabled: true in their config.
     *  Defaults to false for backwards compatibility; set true in production for full
     *  alignment with the "every agent runs in an isolated container" security principle. */
    defaultContainerized: z.boolean().default(false),
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
  pentest: PentestSchema.default({}),
  mail: MailServiceSchema.default({}),
  toolDevelopment: ToolDevelopmentSchema.default({}),
  selfImprovement: SelfImprovementSchema.default({}),
  /** Computer use configuration — validated separately by Joi, passed through by Zod. */
  computerUse: z.record(z.unknown()).default({}),
  workspacePath: z.string().default("/workspace"),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type GatewayConfig = z.infer<typeof GatewaySchema>;
export type MultimodalFileConfig = z.infer<typeof MultimodalFileServiceSchema>;
export type MultimodalSpeechToTextConfig = z.infer<typeof MultimodalSpeechToTextSchema>;
export type MultimodalTextToSpeechConfig = z.infer<typeof MultimodalTextToSpeechSchema>;
export type RetrievalSearchConfig = z.infer<typeof RetrievalSearchSchema>;
export type InfrastructureAutomationProfile = z.infer<typeof InfrastructureAutomationProfileSchema>;
export type MailServiceConfig = z.infer<typeof MailServiceSchema>;
