# Configuration Reference

<p align="center">
  <img src="../swarmLogo.svg" alt="StarlingAI logo" width="180" />
</p>

StarlingAI reads a single project-root `starlingai.json` file plus optional environment variables from `.env`. The configuration defines the swarm's local rules — which agents exist, what tools they can use, how they connect to models, and what channels they serve. The file is validated against `packages/core/src/config/schema.ts`, and most changes hot-reload without restarting the stack.

`web_search` now reads `retrieval.search`. In `auto` mode it prefers a configured SearXNG instance and falls back to DuckDuckGo when SearXNG is absent or temporarily unavailable.

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
  "retrieval": {},
  "guardrails": {},
  "mcp": {},
  "sites": {},
  "infrastructure": {},
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
  "openaiCompatible": {
    "coder_vllm": {
      "baseUrl": "http://host.docker.internal:8000/v1",
      "apiKey": "local-vllm"
    }
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

`providers.openaiCompatible` lets you register additional named OpenAI-compatible backends without overloading the global LM Studio entry. Any model whose `primary` or `embeddingModel` starts with that provider name will resolve through the matching backend.

```jsonc
"agents": {
  "defaults": {
    "model": {
      "primary": "coder_vllm/Qwen/Qwen3-Coder-30B-A3B-Instruct",
      "embeddingModel": "coder_vllm/text-embedding-qwen3-embedding-0.6b"
    }
  }
}
```

## Agents Defaults

`agents.defaults.model` is the base model config inherited by sub-agents unless they override fields.

```jsonc
"agents": {
  "mainAssistant": {
    "toolMode": "delegate_only"
  },
  "defaults": {
    "model": {
      "primary": "lmstudio/qwen/qwen3.5-35b-a3b",
      "fallback": "lmstudio/qwen3.5-4b",
      "cloudFallback": "anthropic/claude-haiku-4-5-20251001",
      "contextWindow": 32768,
      "temperature": 0.3,
      "maxTokens": 4096,
      "topP": 0.95,
      "topK": 40,
      "minP": 0.05,
      "repeatPenalty": 1.05,
      "seed": 42,
      "embeddingModel": "lmstudio/text-embedding-qwen3-embedding-0.6b",
      "embeddingBaseUrl": "http://host.docker.internal:8004/v1",
      "embeddingApiKey": "local-embed"
    }
  },
  "rateLimit": {
    "requestsPerMinute": 60,
    "toolCallsPerTurn": 20,
    "concurrentSessions": 10
  }
}
```

`agents.mainAssistant.toolMode` controls whether the top-level assistant can use direct tools itself or must route work through sub-agents:

- `hybrid`: direct tools plus orchestration tools
- `orchestration_only`: orchestration tools only
- `delegate_only`: only `delegate_to_agent`

`agents.ephemeralGeneration` controls when the runtime generates an on-the-fly specialist instead of delegating to an existing agent:

```jsonc
"agents": {
  "ephemeralGeneration": {
    "enabled": true,
    "skillMatchThreshold": 0.75,
    "architectAgentName": "agent_architect"
  }
}
```

- `enabled`: disables threshold-triggered ephemeral generation entirely when set to `false`
- `skillMatchThreshold`: `0` to `1` cutoff for the best routed or bid specialist; below this score the runtime generates an ephemeral agent instead
- `architectAgentName`: configured specialist used to write the ephemeral agent description, prompt, tools, and model

The dashboard can hot-patch most model fields for configured sub-agents through `PATCH /api/agents/:name/model`.

`baseUrl` and `apiKey` can be set directly on any model config to route that model to a separate OpenAI-compatible server instead of the global LM Studio endpoint. That applies both to `agents.defaults.model` and to per-sub-agent `model` blocks.

```jsonc
"agents": {
  "defaults": {
    "model": {
      "primary": "lmstudio/Qwen/Qwen3-Coder-30B-A3B-Instruct",
      "baseUrl": "http://host.docker.internal:8000/v1",
      "apiKey": "local-vllm"
    }
  }
}
```

This is the right pattern when a model cannot be downloaded or served by LM Studio and must run under vLLM, SGLang, llama.cpp server, or another OpenAI-compatible runtime.

If embeddings need to run separately as well, use `embeddingBaseUrl` and `embeddingApiKey` on the same model block. Semantic agent search and shared-memory retrieval will use that dedicated endpoint.

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
      "primary": "lmstudio/qwen3.5-4b",
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

Sub-agents can also override the endpoint at the model level when only some specialists need a separate server:

```jsonc
"subAgents": {
  "repo_engineer": {
    "model": {
      "primary": "lmstudio/Qwen/Qwen3-Coder-30B-A3B-Instruct",
      "baseUrl": "http://host.docker.internal:8000/v1",
      "apiKey": "local-vllm"
    }
  }
}
```

For source-grounded document work, the recommended specialist stack is `citation_researcher` for authoritative source collection, `paper_author` for drafting only from shared evidence, and `source_verifier` for final citation and claim checks. `prompt_optimizer` is useful when an agent loops or hallucinates, and `incident_responder` is the preferred triage agent for provider/model/config failures.

For dynamic specialization, add an `agent_architect` specialist. The runtime calls it whenever the best available specialist scores below `agents.ephemeralGeneration.skillMatchThreshold`, and the generated ephemeral agent is executed immediately on the original task.

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

The default speech stack uses the host-level Qwen3-ASR and Qwen3-TTS services on ports `5002` and `5004`. The bundled Compose speech services remain optional under the `speech` profile and can expose the same ports when needed.

```jsonc
"multimodal": {
  "maxUploadBytes": 20971520,
  "files": {
    "baseUrl": "http://fastapi-mcp-template:8000",
    "toolName": "file_to_markdown",
    "visionModel": "lmstudio/your-vision-model",
    "visionBaseUrl": "http://host.docker.internal:8001/v1",
    "visionApiKey": "local-vision",
    "timeoutMs": 60000
  },
  "stt": {
    "baseUrl": "http://host.docker.internal:5002",
    "api": "auto",
    "model": "Qwen/Qwen3-ASR-1.7B",
    "timeoutMs": 60000
  },
  "tts": {
    "baseUrl": "http://host.docker.internal:5004",
    "api": "qwen-compatible",
    "model": "Qwen/Qwen3-TTS-12Hz-0.6B-Instruct",
    "defaultLanguage": "English",
    "defaultSpeaker": "Vivian",
    "voiceSamplePath": "samples/assistant-voice.wav",
    "voiceSampleText": "Hello, this is the reference voice sample used by StarlingAI.",
    "timeoutMs": 60000
  },
  "imageGeneration": {
    "baseUrl": "http://image-generation-service:5005",
    "model": "black-forest-labs/FLUX.1-schnell",
    "timeoutMs": 120000,
    "defaultWidth": 768,
    "defaultHeight": 768,
    "defaultSteps": 4,
    "defaultGuidanceScale": 0,
    "cpuOffload": true
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

- `files.visionModel` enables direct screenshot and image analysis through the configured OpenAI-compatible vision model. This is useful for screenshot-heavy browser agents and image QA flows even when the file-conversion backend returns little or no OCR text.
- `files.visionBaseUrl` and `files.visionApiKey` are optional overrides for running the vision model on a separate server from the main orchestrator. When omitted, the vision model's provider prefix is resolved the same way as the main agent provider configuration.
- `stt.api` controls how speech-to-text requests are sent. `auto` keeps the current Qwen-friendly behavior: try OpenAI-compatible `/v1/audio/transcriptions` first, then fall back to `/transcribe`. Use `openai-compatible` or `transcribe-only` when a backend only supports one style.
- `tts.api` controls the text-to-speech backend protocol. Keep `qwen-compatible` when using Qwen3-TTS so saved voices, cloning, and language normalization continue to work. Use `openai-compatible` for backends that expose `/v1/audio/speech`.
- `tts.defaultVoiceId` is optional and uses the Qwen3-TTS saved-voice route when `tts.api = qwen-compatible`.
- `tts.voiceSamplePath` is a workspace-relative audio file used for one-shot cloning when `tts.api = qwen-compatible` and no saved voice ID is configured.
- `tts.voiceSampleText` is optional but improves cloning quality because it maps to Qwen3's `ref_text` input.
- `tts.defaultQuality` remains in the schema for backward compatibility with older non-Qwen configs, but Qwen3-TTS mainly uses `defaultSpeaker`, `defaultVoiceId`, and the optional voice sample fields.
- `imageGeneration` enables the `generate_image` tool and the dashboard image-generation status/API path.
- The default image backend now uses `black-forest-labs/FLUX.1-schnell`, the official Flux Schnell repository, with Flux-tuned defaults of low step count and zero guidance for the fast checkpoint. Because Hugging Face gates file access behind terms acceptance, set `HF_TOKEN` in `.env` so the image-generation container can authenticate during model download.

## Retrieval

`retrieval` contains optional retrieval-quality upgrades that sit below the swarm routing layer.

```jsonc
"retrieval": {
  "search": {
    "backend": "auto",
    "searxngBaseUrl": "http://search.k2o",
    "timeoutMs": 12000
  },
  "reranker": {
    "enabled": true,
    "baseUrl": "http://host.docker.internal:1234/v1",
    "apiKey": "lm-studio",
    "model": "Qwen/Qwen3-Reranker-4B",
    "timeoutMs": 15000,
    "topK": 6
  }
}
```

Notes:

- `retrieval.search.backend` supports `auto`, `searxng`, and `duckduckgo`.
- `auto` keeps SearXNG as the preferred local backend when available, but the swarm can continue web research through DuckDuckGo if that endpoint is missing or unhealthy.
- `retrieval.search.searxngBaseUrl` overrides `SEARXNG_BASE_URL` when both are set.
- The reranker is optional. If the model is unavailable or the request fails, StarlingAI falls back to the existing keyword-plus-embedding ranking.
- Today the reranker is applied to agent routing candidates, improving `search_agents` and `delegate_to_agent` selection quality.
- The intended model family here is `Qwen3-Reranker`.
- `retrieval.reranker.baseUrl` does not need to match `providers.lmstudio.baseUrl`; it is designed for a separate reranker service when LM Studio cannot host that checkpoint.

## Infrastructure

`infrastructure` contains named adapters for privileged infrastructure tools. VM management and Terraform/Ansible automation now share the same profile-driven approach.

```jsonc
"infrastructure": {
  "automation": {
    "defaultProfile": "ops_webhook",
    "profiles": {
      "ops_webhook": {
        "type": "webhook",
        "url": "https://ops.example.com/automation",
        "headers": {
          "Authorization": "Bearer $INFRA_AUTOMATION_TOKEN"
        },
        "timeoutMs": 45000
      },
      "local_cli": {
        "type": "local-cli",
        "terraformBinary": "terraform",
        "ansibleBinary": "ansible",
        "ansiblePlaybookBinary": "ansible-playbook"
      }
    }
  },
  "virtualization": {
    "profiles": {
      "lab_proxmox": {
        "type": "proxmox",
        "apiUrl": "https://proxmox.example.com:8006",
        "node": "pve-01",
        "tokenId": "root@pam!starlingai",
        "tokenSecret": "$PROXMOX_TOKEN_SECRET",
        "timeoutMs": 120000
      },
      "lab_webhook": {
        "type": "webhook",
        "url": "https://n8n.example.com/webhook/vm-manage",
        "headers": {
          "Authorization": "Bearer $INFRA_WEBHOOK_TOKEN"
        },
        "timeoutMs": 45000
      }
    }
  }
}
```

Notes:

- `infrastructure.automation.profiles` controls how `terraform_exec`, `ansible_playbook`, and `ansible_task` run.
- `local-cli` preserves the current host-side workflow while letting you swap binaries such as `tofu` or a custom Ansible wrapper.
- `webhook` forwards `{ action, profile, params }` to a remote automation endpoint so the swarm can target AWX, Terraform runners, CI jobs, or other self-hosted orchestration backends without new hard-coded tools.
- Each automation tool accepts an optional `profile` argument to override `infrastructure.automation.defaultProfile` for a single call.
- `vm_manage` is the generic privileged VM tool. It can target `proxmox` or `webhook` backends.
- `proxmox_vm` remains available as the Proxmox-specialized path and now supports `profile` references for named Proxmox connections.
- Webhook VM profiles let you front arbitrary self-hosted infrastructure systems behind a stable JSON contract without hard-coding more vendor-specific tools into the swarm.
- Webhook responses may return `{ "success": boolean, "output": string, "error"?: string, "metadata"?: object }`.

## Guardrails

`guardrails` still controls the deterministic runtime protections, and can now optionally call a model-backed moderation pass.

```jsonc
"guardrails": {
  "promptInjectionBlock": true,
  "outputSecretScan": true,
  "maxInputLength": 32000,
  "sandboxShellExec": true,
  "modelModeration": {
    "enabled": true,
    "baseUrl": "http://host.docker.internal:1234/v1",
    "apiKey": "lm-studio",
    "model": "Qwen/Qwen3Guard-Gen-4B",
    "timeoutMs": 15000,
    "moderateInputs": true,
    "moderateToolOutputs": true,
    "maxChars": 6000,
    "blockOn": "unsafe"
  }
}
```

Notes:

- The regex and policy-based guardrails remain the first enforcement layer.
- `modelModeration` is optional and failure-tolerant. If the moderation model is missing or unreachable, the deterministic guardrails still operate normally.
- `blockOn` can be `unsafe` or `controversial_or_unsafe` depending on how aggressively you want the runtime to block content.
- The intended model family here is `Qwen3Guard-Gen`.
- `modelModeration.baseUrl` can point at a dedicated moderation server, separate from the orchestrator or coding-model endpoint.

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

Signal uses the local `signal-cli` binary. `channels.signal.account` must already be registered or linked in `signal-cli`, and `signalCliPath` can be overridden when the binary is not on `PATH`.

## Pentest

`pentest` configures how the pentest tools reach their execution backend. The legacy `serviceUrl` path still targets the bundled Kali service by default.

```jsonc
"pentest": {
  "serviceUrl": "http://kali-pentest:5010",
  "defaultProfile": "ops_webhook",
  "profiles": {
    "ops_webhook": {
      "type": "webhook",
      "url": "https://ops.example.com/pentest",
      "headers": {
        "Authorization": "Bearer $PENTEST_WEBHOOK_TOKEN"
      },
      "timeoutMs": 45000
    },
    "local_kali": {
      "type": "kali-service",
      "serviceUrl": "http://kali-pentest:5010",
      "timeoutMs": 300000
    }
  }
}
```

Notes:

- Without `defaultProfile`, StarlingAI keeps using `pentest.serviceUrl` as the compatibility path.
- Each pentest tool that reaches a backend accepts an optional `profile` argument, so one engagement can temporarily switch between named Kali or webhook backends without changing global config.
- `kali-service` preserves the existing `/api/<tool>` contract, timeout recovery behavior, and `SAI_PENTEST_SERVICE_URL` override.
- `webhook` sends `{ action, payload, profile }` to a single endpoint so you can front alternative scanners or orchestration systems behind one stable tool surface.

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
    "description": "Run a browser-assisted application workflow for one approved freelance lead.",
    "task": "Use web_task_coordinator to review one approved lead and delegate browser submission only after stored credentials exist and secure credential fill has been approved.",
    "webhookKey": "$SCENE_APPLY_JOBS_KEY",
    "params": {
      "minRating": {
        "description": "Minimum accepted lead rating",
        "default": "0.7"
      }
    },
    "allowedAgents": ["web_task_coordinator", "browser_agent", "researcher", "summarizer"],
    "humanInLoopSteps": ["site_fill_credentials", "mcp__playwright__browser_navigate"],
    "approvalChannel": "slack-approvals"
  },
  "source_backed_paper": {
    "description": "Produce a paper or report grounded in official sources and verified citations.",
    "task": "Use citation_researcher to gather authoritative sources, paper_author to draft only from collected evidence, and source_verifier to check every citation and factual claim before finalizing.",
    "allowedAgents": ["citation_researcher", "paper_author", "source_verifier", "researcher", "summarizer"],
    "params": {
      "outputStyle": {
        "description": "Requested style or citation format",
        "default": "technical report with inline references"
      }
    }
  }
}
```

Notes:

- `task` is injected into a fresh scene session.
- `params` supports `{{name|default}}` substitution for chat `/run` and webhook-triggered runs.
- `allowedAgents` restricts delegation scope for that scene.
- `humanInLoopSteps` matches tool names, not scene phases. For credentialed browser or desktop flows, gate `site_fill_credentials` or `computer_type_credential`; `get_site_credentials` is safe metadata lookup and does not expose secrets.
- `humanInLoopSteps` is a list of tool names, not numeric step indexes.
- Config-file scenes are read-only in the dashboard; dashboard-created scenes live in the credential store.

The bundled compose stack now treats local speech containers as optional. By default the gateway reads STT/TTS from `SAI_MULTIMODAL_STT_URL` and `SAI_MULTIMODAL_TTS_URL`, which default to `http://host.docker.internal:5002` and `http://host.docker.internal:5004`. Start the built-in Qwen speech services only when needed with `docker compose --profile speech up -d`.

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
