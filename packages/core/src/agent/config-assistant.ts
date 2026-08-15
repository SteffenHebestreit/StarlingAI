import JSON5 from "json5";
import { z } from "zod";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { createChatProvider, resolveProviderEndpoint } from "../providers/index.js";
import type { ModelConfig } from "../config/schema.js";
import {
  type ConversationConfigChange,
  type ConversationPromptChange,
  MAIN_ASSISTANT_PROMPT_TARGET,
  isProtectedConfigPath,
} from "./config-assistant-proposals.js";
import { formatFlowMemoryGuidance } from "./flow-memory.js";

const log = childLogger("agent:config-assistant");

const DraftSchema = z.object({
  summary: z.string().min(1),
  configChanges: z.array(z.object({
    path: z.string().min(1),
    value: z.unknown(),
    reason: z.string().min(1),
  })).default([]),
  promptChanges: z.array(z.object({
    agentName: z.string().min(1),
    strategy: z.enum(["replace", "append"]).default("replace"),
    prompt: z.string().min(1),
    rationale: z.string().min(1),
  })).default([]),
  validations: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  lesson: z.string().optional(),
});

export interface ConfigAssistantDraft {
  summary: string;
  configChanges: ConversationConfigChange[];
  promptChanges: ConversationPromptChange[];
  validations: string[];
  tags: string[];
  lesson?: string;
}

export async function proposeConversationConfigChange(input: {
  request: string;
  mode: "setup" | "enhancement" | "prompt";
  targetAgent?: string;
  workspacePath: string;
}): Promise<{ assistantAgent: string; draft: ConfigAssistantDraft }> {
  const config = getConfig();
  const assistantAgent = selectAssistantAgent(input.mode, input.targetAgent);
  const assistantCfg = assistantAgent ? config.subAgents?.[assistantAgent] : undefined;
  const modelConfig: ModelConfig = { ...config.agents.defaults.model, ...(assistantCfg?.model ?? {}) };
  const provider = createChatProvider(modelConfig, resolveProviderEndpoint(modelConfig, config));
  const flowGuidance = formatFlowMemoryGuidance(input.workspacePath, input.request, {
    targetAgent: input.targetAgent,
    assistantAgent,
    limit: 4,
  });

  const safeConfigSnapshot = JSON.stringify(buildSafeConfigurationSnapshot(input.targetAgent), null, 2);
  const baseInstructions = assistantCfg?.systemPrompt?.trim()
    ? `${assistantCfg.systemPrompt.trim()}\n\n`
    : "";
  const systemPrompt = `${baseInstructions}You are StarlingAI's conversational configuration assistant.

Return JSON only with this exact top-level shape:
{
  "summary": string,
  "configChanges": [{ "path": string, "value": any, "reason": string }],
  "promptChanges": [{ "agentName": string, "strategy": "replace"|"append", "prompt": string, "rationale": string }],
  "validations": string[],
  "tags": string[],
  "lesson": string?
}

Rules:
- Propose the smallest viable change set.
- Only reference config paths that are plausible within the supplied snapshot.
- Never propose secrets, passwords, tokens, API keys, or credentials.
- Use agentName: "main_assistant" when the prompt proposal is meant for the primary assistant chat style rather than a sub-agent.
- Prompt changes are proposals only and require explicit user approval before application.
- If the request is ambiguous, keep the change list minimal and add validations/questions instead of guessing.
- If no safe automatic change is justified, return empty change arrays and explain why in validations.
- Do not wrap JSON in Markdown fences.`;

  const userPrompt = [
    `Mode: ${input.mode}`,
    input.targetAgent ? `Target agent: ${input.targetAgent}` : "Target agent: none",
    `User request: ${input.request}`,
    flowGuidance ? `Relevant flow guidance:\n${flowGuidance}` : "Relevant flow guidance: none",
    `Safe configuration snapshot:\n${safeConfigSnapshot}`,
  ].join("\n\n");

  const response = await provider.complete([
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ], []);

  const draft = parseDraftResponse(response.content ?? "", input.targetAgent);
  return { assistantAgent, draft };
}

function parseDraftResponse(raw: string, targetAgent?: string): ConfigAssistantDraft {
  let parsed: z.infer<typeof DraftSchema> | null = null;
  try {
    parsed = DraftSchema.parse(JSON5.parse(extractJsonPayload(raw)));
  } catch (err) {
    log.warn({ err, rawPreview: raw.slice(0, 400) }, "Config assistant response was not valid JSON");
  }

  const fallbackSummary = raw.trim().replace(/\s+/g, " ").slice(0, 240) || "No machine-readable proposal was produced.";
  const source: z.infer<typeof DraftSchema> = parsed ?? {
    summary: fallbackSummary,
    configChanges: [],
    promptChanges: [],
    validations: ["The model response could not be parsed as structured JSON. Review the summary and retry if you need an applyable proposal."],
    tags: ["unparsed"],
    lesson: undefined,
  };

  const validations = [...source.validations];
  const configChanges = dedupeConfigChanges(source.configChanges)
    .filter((change) => {
      if (!isProtectedConfigPath(change.path)) return true;
      validations.push(`Manual step required: protected path '${change.path}' was excluded from the applyable proposal.`);
      return false;
    });

  const availableAgents = new Set([MAIN_ASSISTANT_PROMPT_TARGET, ...Object.keys(getConfig().subAgents ?? {})]);
  const promptChanges = dedupePromptChanges(source.promptChanges)
    .filter((change) => {
      if (!availableAgents.has(change.agentName)) {
        validations.push(`Prompt proposal ignored: agent '${change.agentName}' does not exist in config.`);
        return false;
      }
      return true;
    });

  if (targetAgent && source.promptChanges.length === 0 && source.configChanges.length === 0) {
    validations.push(`No concrete change was proposed for target agent '${targetAgent}'. Review the request wording or provide more specific goals.`);
  }

  return {
    summary: source.summary.trim().slice(0, 400),
    configChanges,
    promptChanges,
    validations: dedupeStrings(validations, 10, 240),
    tags: dedupeStrings(source.tags, 10, 40),
    lesson: source.lesson?.trim().slice(0, 400) || undefined,
  };
}

function selectAssistantAgent(mode: "setup" | "enhancement" | "prompt", targetAgent?: string): string {
  const config = getConfig();
  if ((mode === "prompt" || targetAgent) && config.subAgents?.["prompt_optimizer"]) return "prompt_optimizer";
  if (config.subAgents?.["ops_triage"]) return "ops_triage";
  return "main_assistant";
}

function buildSafeConfigurationSnapshot(targetAgent?: string): Record<string, unknown> {
  const config = getConfig();
  const subAgents = Object.fromEntries(
    Object.entries(config.subAgents ?? {}).map(([name, agent]) => [
      name,
      {
        description: agent.description,
        capabilities: agent.capabilities ?? [],
        tags: agent.tags ?? [],
        model: agent.model
          ? {
              primary: agent.model.primary,
              temperature: agent.model.temperature,
              maxTokens: agent.model.maxTokens,
              enableThinking: agent.model.enableThinking,
              reasoningEffort: agent.model.reasoningEffort,
            }
          : undefined,
        ...(name === targetAgent ? { systemPrompt: agent.systemPrompt ?? "" } : {}),
      },
    ]),
  );

  const snapshot = {
    agents: {
      mainAssistant: config.agents.mainAssistant,
      defaults: {
        model: {
          primary: config.agents.defaults.model.primary,
          fallback: config.agents.defaults.model.fallback,
          contextWindow: config.agents.defaults.model.contextWindow,
          temperature: config.agents.defaults.model.temperature,
          maxTokens: config.agents.defaults.model.maxTokens,
          enableThinking: config.agents.defaults.model.enableThinking,
          reasoningEffort: config.agents.defaults.model.reasoningEffort,
          embeddingModel: config.agents.defaults.model.embeddingModel,
        },
      },
      subAgents,
    },
    retrieval: config.retrieval,
    multimodal: {
      maxUploadBytes: config.multimodal.maxUploadBytes,
      files: {
        baseUrl: config.multimodal.files.baseUrl,
        toolName: config.multimodal.files.toolName,
        visionModel: config.multimodal.files.visionModel,
      },
      stt: {
        baseUrl: config.multimodal.stt.baseUrl,
        api: config.multimodal.stt.api,
        model: config.multimodal.stt.model,
      },
      tts: {
        baseUrl: config.multimodal.tts.baseUrl,
        api: config.multimodal.tts.api,
        model: config.multimodal.tts.model,
        defaultLanguage: config.multimodal.tts.defaultLanguage,
        defaultSpeaker: config.multimodal.tts.defaultSpeaker,
      },
    },
    computerUse: {
      enabled: config.computerUse.enabled,
      adapters: Object.keys(config.computerUse.adapters ?? {}),
      nodes: Object.fromEntries(
        Object.entries(config.computerUse.nodes ?? {}).map(([name, node]) => [name, {
          adapter: node.adapter,
          host: node.host,
          port: node.port,
          protocol: node.protocol,
          label: node.label,
          displayResolution: node.displayResolution,
        }]),
      ),
    },
    guardrails: {
      promptInjectionBlock: config.guardrails.promptInjectionBlock,
      maxInputLength: config.guardrails.maxInputLength,
      modelModeration: {
        enabled: config.guardrails.modelModeration.enabled,
        model: config.guardrails.modelModeration.model,
        baseUrl: config.guardrails.modelModeration.baseUrl,
      },
    },
    gateway: {
      port: config.gateway.port,
      publicUrl: config.gateway.publicUrl,
      corsAllowedOrigins: config.gateway.corsAllowedOrigins,
    },
    providers: {
      lmstudio: config.providers.lmstudio
        ? {
            baseUrl: config.providers.lmstudio.baseUrl,
            timeoutMs: config.providers.lmstudio.timeoutMs,
            maxRetries: config.providers.lmstudio.maxRetries,
          }
        : undefined,
      openaiCompatible: Object.fromEntries(
        Object.entries(config.providers.openaiCompatible ?? {}).map(([name, provider]) => [name, {
          baseUrl: provider.baseUrl,
          timeoutMs: provider.timeoutMs,
          maxRetries: provider.maxRetries,
        }]),
      ),
      ollama: config.providers.ollama
        ? {
            baseUrl: config.providers.ollama.baseUrl,
            api: config.providers.ollama.api,
            timeoutMs: config.providers.ollama.timeoutMs,
          }
        : undefined,
      anthropic: config.providers.anthropic ? { configured: true, timeoutMs: config.providers.anthropic.timeoutMs } : undefined,
    },
    infrastructure: config.infrastructure,
    pentest: config.pentest,
    mcp: {
      servers: Object.keys(config.mcp.servers ?? {}),
    },
  };

  return redactSensitive(snapshot) as Record<string, unknown>;
}

function extractJsonPayload(raw: string): string {
  const trimmed = raw.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return withoutFence.slice(start, end + 1);
  }
  return withoutFence;
}

function dedupeConfigChanges(changes: Array<{ path: string; value?: unknown; reason: string }>): ConversationConfigChange[] {
  const seen = new Set<string>();
  const output: ConversationConfigChange[] = [];
  for (const change of [...changes].reverse()) {
    if (!("value" in change)) continue;
    const path = change.path.trim();
    if (!path) continue;
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.unshift({
      path,
      value: change.value,
      reason: change.reason.trim().slice(0, 240),
    });
  }
  return output;
}

function dedupePromptChanges(changes: ConversationPromptChange[]): ConversationPromptChange[] {
  const seen = new Set<string>();
  const output: ConversationPromptChange[] = [];
  for (const change of [...changes].reverse()) {
    const agentName = change.agentName.trim();
    if (!agentName) continue;
    const key = agentName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.unshift({
      agentName,
      strategy: change.strategy,
      prompt: change.prompt.trim().slice(0, 6000),
      rationale: change.rationale.trim().slice(0, 240),
    });
  }
  return output;
}

function dedupeStrings(values: string[], limit: number, itemMax: number): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const raw of values) {
    const value = raw.trim().slice(0, itemMax);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(value);
    if (output.length >= limit) break;
  }
  return output;
}

function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactSensitive(entry));
  if (typeof value !== "object" || value === null) return value;

  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/(secret|password|token|apikey|api_key|privatekey|private_key|credential|credentials|headers)/i.test(key)) {
      continue;
    }
    output[key] = redactSensitive(entry);
  }
  return output;
}