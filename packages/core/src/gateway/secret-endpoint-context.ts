/**
 * Where a settings route's keys end up when their own endpoint or key is unset (see
 * config-secrets.ts), read from the live config. Shared by every route that applies the
 * moved-key rule: the multimodal and model-endpoint settings, the sub-agent model patch and the
 * config-assistant apply.
 *
 * Each answer comes from the resolver the runtime sends with: resolveProviderEndpointForModel for
 * a chat or vision call, resolveEmbeddingEndpoint for the embeddings. A copy of either drifts —
 * the embeddings were judged by the chat resolver, which for an anthropic/* model with no Anthropic
 * credentials answered "no key" while the embeddings sent the primary key.
 */
import { getConfig } from "../config/loader.js";
import type { Config } from "../config/schema.js";
import { resolveEmbeddingEndpoint, resolveProviderEndpointForModel, type ResolvedProviderEndpoint } from "../providers/index.js";
import type { SecretEndpointContext } from "./config-secrets.js";

/** Unknown is not "none": a stand-in that no endpoint has been sent yet, so a move is refused. */
const UNRESOLVED_CREDENTIAL = "(unresolved provider key)";

export function secretEndpointContext(cfg: Config = getConfig()): SecretEndpointContext {
  const chat = (model: string | undefined) => resolveProviderEndpointForModel(model ?? cfg.agents.defaults.model.primary, {}, cfg);
  // The embeddings with nothing of their own set, so what the resolver falls back to is what is left.
  const embedding = (model: string | undefined) => resolveEmbeddingEndpoint({
    ...cfg.agents.defaults.model,
    primary: model ?? cfg.agents.defaults.model.primary,
    embeddingModel: model,
    baseUrl: undefined,
    apiKey: undefined,
    embeddingBaseUrl: undefined,
    embeddingApiKey: undefined,
  }, cfg);
  const endpointOf = (resolve: (model: string | undefined) => ResolvedProviderEndpoint) => (model: string | undefined) => {
    try {
      return resolve(model).baseUrl;
    } catch {
      return undefined;
    }
  };
  const credentialOf = (resolve: (model: string | undefined) => ResolvedProviderEndpoint) => (model: string | undefined) => {
    try {
      return resolve(model).apiKey;
    } catch {
      return UNRESOLVED_CREDENTIAL;
    }
  };
  return {
    providerEndpoint: endpointOf(chat),
    providerCredential: credentialOf(chat),
    embeddingEndpoint: endpointOf(embedding),
    embeddingCredential: credentialOf(embedding),
    // The same variables config/loader.ts fills an endpoint-less openai-compatible image backend from.
    chatEndpoint: process.env["SAI_PRIMARY_MODEL_URL"] ?? process.env["SAI_LMSTUDIO_URL"],
  };
}
