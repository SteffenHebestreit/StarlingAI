# Separate Model Serving

Use this when one or more Qwen checkpoints cannot be downloaded or hosted by LM Studio. StarlingAI can route different model roles to different OpenAI-compatible servers.

The dashboard Settings page now includes a Model Routing editor for:

- Orchestrator model endpoint
- Embedding model endpoint
- Reranker endpoint
- Guard moderation endpoint

Sub-agent model endpoints remain editable from the agent settings UI, and vision fallback stays under the multimodal settings card.

The runtime now supports endpoint overrides for:

- Main orchestrator model via `agents.defaults.model.baseUrl` and `apiKey`
- Sub-agent models via `subAgents.<name>.model.baseUrl` and `apiKey`
- Embeddings via `agents.defaults.model.embeddingBaseUrl` and `embeddingApiKey`
- Vision fallback via `multimodal.files.visionBaseUrl` and `visionApiKey`
- Reranker via `retrieval.reranker.baseUrl`
- Guard moderation via `guardrails.modelModeration.baseUrl`

## What The Server Must Expose

For chat, coding, reranker, guard, and vision roles, the server must expose:

- `/v1/chat/completions`
- `/v1/models`

For embeddings, the server must expose:

- `/v1/embeddings`
- `/v1/models`

StarlingAI currently treats reranking and moderation as prompt-driven chat tasks, not as dedicated OpenAI `responses`, `rerank`, or `moderations` APIs.

## Dashboard Health Checks

The runtime health view does more than check whether an endpoint answers.

- An endpoint is healthy only when `/v1/models` responds successfully
- The configured model must also appear in the advertised model list
- The dashboard shows mismatches when the endpoint is reachable but the expected model is not loaded

This makes it easier to catch the common operator failure mode where a server is up but serving the wrong checkpoint.

## Dashboard Workflow

Typical operator flow:

1. Open Settings in the dashboard
2. Edit Model Routing for orchestrator, embeddings, reranker, or guard
3. Save the config
4. Check the health badges to confirm the configured model is actually advertised by the target server

If a badge shows a mismatch, compare the configured model name with the `/v1/models` output from that server.

## Compose Overlay

An optional template overlay is included at [docker-compose.model-servers.yml](../docker-compose.model-servers.yml).

Start the base stack plus dedicated model servers like this:

```bash
docker compose -f docker-compose.yml -f docker-compose.model-servers.yml --profile model-servers up -d
```

You can also start only the services you want:

```bash
docker compose -f docker-compose.yml -f docker-compose.model-servers.yml \
  --profile coder-model --profile reranker-model up -d
```

The overlay is a vLLM-oriented template. If you prefer SGLang, llama.cpp server, TGI, or host-side Windows processes, replace the service image and command but keep the same OpenAI-compatible URLs in `starlingai.json`.

## Recommended Role Split

Suggested deployment split for the current StarlingAI Qwen setup:

| Role | Suggested runtime | Config keys |
| --- | --- | --- |
| Orchestrator/generalist | LM Studio or dedicated OpenAI-compatible server | `agents.defaults.model.primary`, `baseUrl`, `apiKey` |
| Coding specialists | Dedicated vLLM/SGLang server | `subAgents.repo_engineer.model.*`, `subAgents.test_repairer.model.*`, `subAgents.coder.model.*` |
| Vision/browser analysis | Dedicated multimodal server | `multimodal.files.visionModel`, `visionBaseUrl`, `visionApiKey` |
| Embeddings | Dedicated embedding server | `agents.defaults.model.embeddingModel`, `embeddingBaseUrl`, `embeddingApiKey` |
| Reranker | Dedicated lightweight chat server | `retrieval.reranker.*` |
| Guard moderation | Dedicated lightweight chat server | `guardrails.modelModeration.*` |

## Example Config

When the gateway runs in Docker Compose, use internal service names instead of `host.docker.internal` for dedicated model servers:

```jsonc
"agents": {
  "defaults": {
    "model": {
      "primary": "lmstudio/qwen/qwen3.5-35b-a3b",
      "baseUrl": "http://host.docker.internal:1234/v1",
      "apiKey": "lm-studio",
      "embeddingModel": "lmstudio/Qwen/Qwen3-Embedding-8B",
      "embeddingBaseUrl": "http://qwen3-embedding-openai:8000/v1",
      "embeddingApiKey": "local-embed"
    }
  }
},
"subAgents": {
  "repo_engineer": {
    "model": {
      "primary": "lmstudio/Qwen/Qwen3-Coder-30B-A3B-Instruct",
      "baseUrl": "http://qwen3-coder-openai:8000/v1",
      "apiKey": "local-vllm"
    }
  },
  "test_repairer": {
    "model": {
      "primary": "lmstudio/Qwen/Qwen3-Coder-30B-A3B-Instruct",
      "baseUrl": "http://qwen3-coder-openai:8000/v1",
      "apiKey": "local-vllm"
    }
  }
},
"multimodal": {
  "files": {
    "visionModel": "lmstudio/Qwen/Qwen2.5-VL-7B-Instruct",
    "visionBaseUrl": "http://qwen3-vision-openai:8000/v1",
    "visionApiKey": "local-vision"
  }
},
"retrieval": {
  "reranker": {
    "enabled": true,
    "baseUrl": "http://qwen3-reranker-openai:8000/v1",
    "apiKey": "reranker",
    "model": "Qwen/Qwen3-Reranker-4B"
  }
},
"guardrails": {
  "modelModeration": {
    "enabled": true,
    "baseUrl": "http://qwen3guard-openai:8000/v1",
    "apiKey": "guard",
    "model": "Qwen/Qwen3Guard-Gen-4B"
  }
}
```

## Practical Notes

- If you keep the orchestrator on LM Studio, leave `providers.lmstudio` and `agents.defaults.model.baseUrl` pointed at LM Studio.
- If a specialist model lives elsewhere, only override that specialist's model block.
- If you run the model server on the Windows host instead of Compose, use `host.docker.internal` from inside the gateway container.
- The included Compose overlay is not a guarantee that every listed model will run correctly under vLLM on every GPU. Treat it as a starting template.
- For AMD/ROCm or Windows-native serving, it is often cleaner to run the dedicated model server outside Docker and point StarlingAI at that endpoint.