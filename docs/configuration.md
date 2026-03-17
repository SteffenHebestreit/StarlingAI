# Configuration Reference

<p align="center">
  <img src="../swarmLogo.svg" alt="StarlingAI logo" width="180" />
</p>

StarlingAI reads a single project-root `starlingai.json` file plus optional environment variables from `.env`. The configuration defines the swarm's local rules — which agents exist, what tools they can use, how they connect to models, and what channels they serve. The file is validated against `packages/core/src/config/schema.ts`, and most changes hot-reload without restarting the stack.

`web_search` requires `SEARXNG_BASE_URL` to point at a reachable SearXNG instance. The default runtime relies exclusively on that SearXNG backend.

Hot-reload follows the swarm principle of adaptability: the swarm can evolve its specialist roster, model parameters, and channel configuration at runtime — like a murmuration reshaping in response to changing conditions.

See also: [Sub-Agent Reference](agents.md) · [Message Channels](channels.md) · [Security Model](security.md)

## Structure

Top-level keys accepted by the current schema:

```jsonc
{
  "providers": {},
  "agents": {},
  "subAgents": {},
  "scenes": {},
  "channels": {},
  "gateway": {},
  "guardrails": {},
  "mcp": {},
  "sites": {},
  "integrations": {},
  "webhooks": {},
  "approvalChannels": {},
  "workspacePath": "/workspace"
}
```

## Providers

`providers` configures the model backends the runtime can call.

```jsonc
"providers": {
  "lmstudio": {
    "baseUrl": "http://host.docker.internal:1234/v1",
    "apiKey": "lm-studio",
    "timeoutMs": 30000,
    "maxRetries": 3
  },
  "ollama": {
    "baseUrl": "http://host.docker.internal:11434",
    "api": "ollama-native"
  },
  "anthropic": {
    "apiKey": "$ANTHROPIC_API_KEY",
    "timeoutMs": 60000
  }
}
```

`host.docker.internal` is the right default when the gateway runs in Docker and LM Studio or Ollama runs on the Windows host.

## Agents Defaults

`agents.defaults.model` is the base model config inherited by sub-agents unless they override fields.

```jsonc
"agents": {
  "defaults": {
    "model": {
      "primary": "lmstudio/qwen/qwen3.5-35b-a3b",
      "fallback": "lmstudio/qwen/qwen3.5-9b",
      "cloudFallback": "anthropic/claude-haiku-4-5-20251001",
      "contextWindow": 32768,
      "temperature": 0.3,
      "maxTokens": 4096,
      "topP": 0.95,
      "topK": 40,
      "minP": 0.05,
      "repeatPenalty": 1.05,
      "seed": 42,
      "embeddingModel": "lmstudio/text-embedding-qwen3-embedding-8b"
    }
  },
  "rateLimit": {
    "requestsPerMinute": 60,
    "toolCallsPerTurn": 20,
    "concurrentSessions": 10
  }
}
```

The dashboard can hot-patch most model fields for configured sub-agents through `PATCH /api/agents/:name/model`.

## Sub-Agents

Each entry in `subAgents` defines one specialist agent. The current schema supports:

- `description`
- `capabilities`
- `tags`
- `model`
- `systemPrompt`
- `tools`
- `maxIterations`
- `turnTimeoutMs`
- `container`

```jsonc
"subAgents": {
  "researcher": {
    "description": "Web research expert.",
    "capabilities": ["web research", "documentation lookup"],
    "tags": ["research", "docs"],
    "model": {
      "primary": "lmstudio/qwen/qwen3.5-9b",
      "temperature": 0.2,
      "maxTokens": 4096
    },
    "maxIterations": 4,
    "turnTimeoutMs": 45000,
    "tools": [
      "web_search",
      "web_fetch",
      "read_file",
      "write_file"
    ],
    "container": {
      "enabled": false,
      "image": "starlingai/agent-worker:dev",
      "memoryMb": 512,
      "cpus": 0.5,
      "timeoutMs": 60000
    }
  }
}
```

`turnTimeoutMs` is an optional wall-clock limit for that specific sub-agent run. If it fires, the delegated task is aborted and returned as a timeout instead of consuming the full gateway-wide turn budget.

## Gateway

```jsonc
"gateway": {
  "port": 8765,
  "restPort": 8766,
  "bindHost": "loopback",
  "sessionTtlMs": 3600000,
  "turnTimeoutMs": 900000,
  "publicUrl": "https://starlingai.example.com"
}
```

| Field | Default | Notes |
| --- | --- | --- |
| `port` | `8765` | Active HTTP and WebSocket listener used by the current gateway |
| `restPort` | `8766` | Reserved in config; current gateway routes still serve from `port` |
| `bindHost` | `loopback` | `loopback`, `lan`, or `docker` |
| `sessionTtlMs` | `3600000` | Session idle expiry |
| `turnTimeoutMs` | `900000` | 15-minute turn timeout. WebSocket and AG-UI turns end the session when this fires; scene jobs fail and close their scene session |
| `publicUrl` | unset | Required for approval links and public webhooks |

## Multimodal

The default speech stack now uses Qwen3-ASR and Qwen3-TTS from the `tts-stt-playground` services in Docker Compose.

```jsonc
"multimodal": {
  "maxUploadBytes": 20971520,
  "files": {
    "baseUrl": "http://fastapi-mcp-template:8000",
    "toolName": "file_to_markdown",
    "timeoutMs": 60000
  },
  "stt": {
    "baseUrl": "http://qwen3-asr-service:5002",
    "model": "Qwen/Qwen3-ASR-1.7B",
    "timeoutMs": 60000
  },
  "tts": {
    "baseUrl": "http://qwen3-tts-service:5004",
    "model": "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
    "defaultLanguage": "English",
    "defaultSpeaker": "Vivian",
    "voiceSamplePath": "samples/assistant-voice.wav",
    "voiceSampleText": "Hello, this is the reference voice sample used by StarlingAI.",
    "timeoutMs": 60000
  },
  "wakeWord": {
    "enabled": false,
    "language": "en-US",
    "keywords": ["Hey Guarded", "Okay Guarded", "Luna"],
    "stopPhrases": ["stop recording", "end recording", "stop listening", "luna stop"],
    "silenceTimeoutMs": 4000
  }
}
```

Notes:

- `tts.defaultVoiceId` is optional and uses Qwen3-TTS's fast saved-voice route when present.
- `tts.voiceSamplePath` is a workspace-relative audio file used for one-shot cloning when no saved voice ID is configured.
- `tts.voiceSampleText` is optional but improves cloning quality because it maps to Qwen3's `ref_text` input.
- `tts.defaultQuality` remains in the schema for backward compatibility with older Piper-oriented configs, but Qwen3-TTS mainly uses `defaultSpeaker`, `defaultVoiceId`, and the optional voice sample fields.

## Channels

`channels` contains the built-in webchat plus the configurable external channel runtimes.

```jsonc
"channels": {
  "webchat": {
    "enabled": true,
    "port": 3001
  },
  "telegram": {
    "enabled": false,
    "botToken": "$TELEGRAM_BOT_TOKEN",
    "allowedUserIds": []
  },
  "slack": {
    "enabled": false,
    "botToken": "$SLACK_BOT_TOKEN",
    "signingSecret": "$SLACK_SIGNING_SECRET",
    "appToken": "$SLACK_APP_TOKEN",
    "dmPolicy": "pairing",
    "allowFrom": []
  }
}
```

Shared channel fields for Slack, Discord, WhatsApp, Email, and Signal:

- `enabled`
- `dmPolicy`
- `allowFrom`
- `historyLimit`
- `perSenderRateLimitCount`
- `perSenderRateLimitWindowMs`

Signal can be configured but is currently reported as unsupported at runtime.

## Approval Channels

`approvalChannels` are named outbound approval adapters referenced from scenes.

```jsonc
"approvalChannels": {
  "slack-approvals": {
    "type": "slack",
    "webhookUrl": "https://hooks.slack.com/services/YOUR/SLACK/WEBHOOK_URL",
    "timeoutMs": 600000
  },
  "ops-webhook": {
    "type": "outbound_webhook",
    "url": "https://example.com/approvals",
    "secret": "$APPROVAL_SECRET"
  },
  "sync-gate": {
    "type": "sync_webhook",
    "url": "https://example.com/approve-sync",
    "timeoutMs": 30000
  }
}
```

These are only used when a scene defines both `humanInLoopSteps` and `approvalChannel`.

## Scenes

Scenes are task templates, not step arrays.

```jsonc
"scenes": {
  "apply_jobs": {
    "description": "Submit one ranked freelance lead.",
    "task": "Run the application pipeline for leads rated {{minRating|0.7}} or higher.",
    "webhookKey": "$SCENE_APPLY_JOBS_KEY",
    "params": {
      "minRating": {
        "description": "Minimum accepted lead rating",
        "default": "0.7"
      }
    },
    "allowedAgents": ["application_pipeline", "proposal_writer"],
    "humanInLoopSteps": ["get_site_credentials", "mcp__playwright__browser_navigate"],
    "approvalChannel": "slack-approvals"
  }
}
```

Notes:

- `task` is injected into a fresh scene session.
- `params` supports `{{name|default}}` substitution for chat `/run` and webhook-triggered runs.
- `allowedAgents` restricts delegation scope for that scene.
- `humanInLoopSteps` is a list of tool names, not numeric step indexes.
- Config-file scenes are read-only in the dashboard; dashboard-created scenes live in the credential store.

## MCP Servers

The current schema uses `mcp.servers`, not the older `mcpServers` key.

```jsonc
"mcp": {
  "servers": {
    "playwright": {
      "transport": "docker",
      "image": "mcp/playwright:latest",
      "network": "bridge",
      "autoStart": true
    },
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
      "autoStart": true
    }
  }
}
```

Supported transports today:

- `stdio`
- `docker`
- `docker-exec`
- `http`
- `tcp`

## Sites

`sites` stores browser-login bundles.

```jsonc
"sites": {
  "freelancermap.de": {
    "username": "info@example.com",
    "password": "$FREELANCEMAP_PASSWORD",
    "loginUrl": "https://www.freelancermap.de/login",
    "urls": {
      "projects": "https://www.freelancermap.de/projektboerse.html"
    },
    "notes": "Use the local account rather than SSO."
  }
}
```

Password resolution order is:

1. `$ENV_VAR`
2. `secret:key`
3. literal string

## Integrations And Webhooks

```jsonc
"integrations": {
  "n8n": {
    "baseUrl": "http://host.docker.internal:5678",
    "apiKey": "$N8N_API_KEY",
    "leadsWebhookUrl": "http://host.docker.internal:5678/webhook/starlingai-leads",
    "markAppliedWebhookUrl": "http://host.docker.internal:5678/webhook/starlingai-apply"
  }
},
"webhooks": {
  "notify_ops": {
    "description": "Notify ops about important runtime events.",
    "url": "https://example.com/hooks/starlingai",
    "method": "POST",
    "headers": {
      "Authorization": "$OPS_WEBHOOK_TOKEN"
    }
  }
}
```

Each webhook entry becomes a `webhook__<name>` tool.

## Guardrails

```jsonc
"guardrails": {
  "promptInjectionBlock": true,
  "outputSecretScan": true,
  "maxInputLength": 32000,
  "sandboxShellExec": true
}
```

`sandboxShellExec` is effectively locked on by the runtime.

## Workspace Path

```jsonc
"workspacePath": "/workspace"
```

This is the path tools see inside the runtime container or sandbox.

## Environment Variables

Common environment variables used by the current stack:

| Variable | Purpose |
| --- | --- |
| `SAI_MASTER_KEY` | Required. Credential-store encryption key |
| `POSTGRES_PASSWORD` | Required by Docker Compose for Postgres |
| `SAI_JWT_SECRET` | Optional JWT signing override |
| `SAI_LMSTUDIO_URL` | Optional LM Studio URL override |
| `SAI_AUDIT_LOG` | Optional audit JSONL path override |
| `SAI_CRED_STORE` | Optional credential-store path override |
| `ANTHROPIC_API_KEY` | Optional cloud fallback |
| `TELEGRAM_BOT_TOKEN`, `SLACK_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, `WHATSAPP_*` | Optional channel secrets |
| `N8N_API_KEY`, `FREELANCEMAP_PASSWORD`, `N8N_PASSWORD` | Integration and site secrets |

Default path behavior in local development:

- audit log: `./.starlingai/audit.jsonl`
- credential store: `./.starlingai/credentials.enc`
- JWT secret fallback: `./.starlingai/.jwt_secret`, then `~/.starlingai/.jwt_secret`

Docker Compose overrides the audit log and credential store to `/data/...`.

## Hot Reload

Most config changes apply without restarting the whole stack:

- channel config changes reconcile the runtime and restart affected adapters
- agent model patches apply in memory immediately
- scene, site, and guardrail changes are visible to the dashboard on the next fetch
- MCP, webhook, and approval-channel changes are reloaded by the gateway config watcher
- Scenes added to `starlingai.json` become available on next file save.

The config loader uses Zod validation — invalid config changes are rejected and the previous valid config remains active. Validation errors are logged to the audit stream.
