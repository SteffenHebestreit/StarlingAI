/**
 * Computer Use Configuration — Joi-validated schema.
 *
 * This schema is validated independently from the Zod root config.
 * The config loader calls `validateComputerUseConfig()` on the raw
 * `computerUse` block before feeding the full config to Zod.
 *
 * Uses Joi per user preference (the rest of the codebase uses Zod).
 */

import Joi from "joi";

// ── Per-Adapter Sub-Schemas ───────────────────────────────────────────────────

const LocalVscodeAdapterSchema = Joi.object({
  codePath: Joi.string().default("code"),
  workspacePath: Joi.string().optional(),
});

const LocalDesktopAdapterSchema = Joi.object({
  backend: Joi.string()
    .valid("nutjs", "robotjs", "pyautogui")
    .default("nutjs"),
  ocrEnabled: Joi.boolean().default(true),
});

const RemoteAdapterSchema = Joi.object({
  host: Joi.string().required(),
  port: Joi.number().integer().required(),
  protocol: Joi.string().valid("rdp", "vnc").required(),
  credentials: Joi.string().optional(),
  displayResolution: Joi.string()
    .pattern(/^\d+x\d+$/)
    .optional(),
  reconnectAttempts: Joi.number().integer().min(0).default(3),
  reconnectDelayMs: Joi.number().integer().min(100).default(5000),
});

const RemoteNodeAdapterSchema = Joi.object({
  baseUrl: Joi.string().uri({ scheme: [/https?/] }).required(),
  authToken: Joi.string().allow("").default(""),
  timeoutMs: Joi.number().integer().min(1000).default(15000),
  label: Joi.string().default("Remote desktop node"),
});

const RemoteAccessServiceSchema = Joi.object({
  baseUrl: Joi.string().uri({ scheme: [/https?/] }).required(),
  authToken: Joi.string().allow("").default(""),
  timeoutMs: Joi.number().integer().min(1000).default(20000),
  label: Joi.string().default("Remote access sidecar"),
});

const EphemeralVmAdapterSchema = Joi.object({
  image: Joi.string().default("starlingai/computer-desktop:dev"),
  memoryMb: Joi.number().integer().min(512).default(2048),
  cpus: Joi.number().integer().min(1).default(2),
  displayResolution: Joi.string()
    .pattern(/^\d+x\d+$/)
    .default("1920x1080"),
});

const SshAdapterSchema = Joi.object({
  host: Joi.string().required(),
  port: Joi.number().integer().default(22),
  username: Joi.string().default("root"),
  credentials: Joi.string().optional().description("Path to SSH private key or password (with authMethod='password')"),
  authMethod: Joi.string().valid("key", "password").default("key"),
  connectTimeoutMs: Joi.number().integer().min(1000).default(30000),
});

const AdaptersSchema = Joi.object({
  local_vscode: LocalVscodeAdapterSchema.optional(),
  remote_node: RemoteNodeAdapterSchema.optional(),
  local_desktop: LocalDesktopAdapterSchema.optional(),
  remote_vnc: RemoteAdapterSchema.optional(),
  remote_rdp: RemoteAdapterSchema.optional(),
  remote_ssh: SshAdapterSchema.optional(),
  ephemeral_vm: EphemeralVmAdapterSchema.optional(),
}).default({});

// ── Named nodes (multi-target) ────────────────────────────────────────────────

const NODE_ADAPTER_TYPES = ["remote_vnc", "remote_rdp", "remote_ssh", "remote_node"] as const;

const NodeEntrySchema = Joi.alternatives().conditional(".adapter", {
  switch: [
    {
      is: "remote_vnc",
      then: RemoteAdapterSchema.keys({
        adapter: Joi.string().valid("remote_vnc").required(),
        label: Joi.string().default(""),
      }),
    },
    {
      is: "remote_rdp",
      then: RemoteAdapterSchema.keys({
        adapter: Joi.string().valid("remote_rdp").required(),
        label: Joi.string().default(""),
      }),
    },
    {
      is: "remote_ssh",
      then: SshAdapterSchema.keys({
        adapter: Joi.string().valid("remote_ssh").required(),
        label: Joi.string().default(""),
      }),
    },
    {
      is: "remote_node",
      then: RemoteNodeAdapterSchema.keys({
        adapter: Joi.string().valid("remote_node").required(),
      }),
    },
  ],
  otherwise: Joi.forbidden(),
});

const NodesSchema = Joi.object()
  .pattern(Joi.string().pattern(/^[a-zA-Z0-9_-]+$/), NodeEntrySchema)
  .default({});

// ── Root Computer Use Schema ──────────────────────────────────────────────────

export const computerUseSchema = Joi.object({
  /** Global kill-switch — opt-in only. */
  enabled: Joi.boolean().default(false),

  /** Per-adapter configuration (single default per adapter type). */
  adapters: AdaptersSchema,

  /** Named nodes — multiple targets of any adapter type. */
  nodes: NodesSchema,

  /** Optional sidecar that owns remote VNC/RDP/SSH dependencies. */
  remoteAccessService: RemoteAccessServiceSchema.optional(),

  /** Vision model for screenshot analysis (falls back to multimodal.files.visionModel). */
  visionModel: Joi.string().allow("").default(""),

  /** Vision model base URL override. */
  visionBaseUrl: Joi.string().uri().allow("").default(""),

  /** Maximum concurrent computer sessions. */
  maxConcurrentSessions: Joi.number().integer().min(1).max(10).default(3),

  /** Session auto-stop timeout (ms). Default 30 minutes. */
  sessionTimeoutMs: Joi.number().integer().min(30_000).default(1_800_000),

  /** Heartbeat emit interval (ms). */
  heartbeatIntervalMs: Joi.number().integer().min(5_000).default(15_000),

  /** Heartbeat stale timeout (ms). */
  heartbeatTimeoutMs: Joi.number().integer().min(15_000).default(45_000),

  /** Enable session recording (action + screenshot hash NDJSON). */
  recordingEnabled: Joi.boolean().default(false),

  /** Max screenshot width (pixels) before downscale. */
  screenshotMaxWidth: Joi.number().integer().min(640).default(1920),

  /** Screenshot JPEG/WebP quality (0.1–1.0). */
  screenshotQuality: Joi.number().min(0.1).max(1.0).default(0.8),

  /** Minimum delay between consecutive actions (ms). Prevents click storms. */
  actionPacingMs: Joi.number().integer().min(0).default(500),

  /** Enable emergency stop capability. */
  emergencyStopEnabled: Joi.boolean().default(true),

  /** Whitelist of scene names that may use computer tools. Empty = all allowed. */
  allowedScenes: Joi.array().items(Joi.string()).default([]),
}).default({});

// ── Types ─────────────────────────────────────────────────────────────────────

export interface NodeEntry {
  adapter: "remote_vnc" | "remote_rdp" | "remote_ssh" | "remote_node";
  label?: string;
  /* Adapter-specific fields are spread into the same object. */
  [key: string]: unknown;
}

export interface ComputerUseConfig {
  enabled: boolean;
  adapters: {
    local_vscode?: { codePath: string; workspacePath?: string };
    remote_node?: RemoteNodeAdapterConfig;
    local_desktop?: { backend: "nutjs" | "robotjs" | "pyautogui"; ocrEnabled: boolean };
    remote_vnc?: RemoteAdapterConfig;
    remote_rdp?: RemoteAdapterConfig;
    remote_ssh?: SshAdapterConfig;
    ephemeral_vm?: { image: string; memoryMb: number; cpus: number; displayResolution: string };
  };
  nodes: Record<string, NodeEntry>;
  remoteAccessService?: RemoteAccessServiceConfig;
  visionModel: string;
  visionBaseUrl: string;
  maxConcurrentSessions: number;
  sessionTimeoutMs: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  recordingEnabled: boolean;
  screenshotMaxWidth: number;
  screenshotQuality: number;
  actionPacingMs: number;
  emergencyStopEnabled: boolean;
  allowedScenes: string[];
}

interface RemoteAdapterConfig {
  host: string;
  port: number;
  protocol: "rdp" | "vnc";
  credentials?: string;
  displayResolution?: string;
  reconnectAttempts: number;
  reconnectDelayMs: number;
}

interface SshAdapterConfig {
  host: string;
  port: number;
  username: string;
  credentials?: string;
  authMethod: "key" | "password";
  connectTimeoutMs: number;
}

export type { RemoteAdapterConfig, SshAdapterConfig };
export { NODE_ADAPTER_TYPES };

export interface RemoteAccessServiceConfig {
  baseUrl: string;
  authToken?: string;
  timeoutMs: number;
  label: string;
}

export interface RemoteNodeAdapterConfig {
  baseUrl: string;
  authToken?: string;
  timeoutMs: number;
  label: string;
}

// ── Validation Helper ─────────────────────────────────────────────────────────

/**
 * Validate and apply defaults to a raw `computerUse` config block.
 * Returns the validated config or throws on validation errors.
 */
export function validateComputerUseConfig(raw: unknown): ComputerUseConfig {
  const { error, value } = computerUseSchema.validate(raw ?? {}, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    const details = error.details.map((d: { message: string }) => d.message).join("; ");
    throw new Error(`computerUse config validation failed: ${details}`);
  }

  return value as ComputerUseConfig;
}
