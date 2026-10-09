import { describe, expect, it } from "vitest";
import {
  agentModelSecretDestinations,
  channelSecretDestinations,
  maskConfigSecrets,
  modelEndpointSecretDestinations,
  refuseMovedSecrets,
  resolveSecretPlaceholders,
  SECRET_PLACEHOLDER,
  type SecretEndpointContext,
} from "../gateway/config-secrets.js";
import { checkMultimodalConfigSave } from "../gateway/multimodal-config-merge.js";

/**
 * GET /api/multimodal/config (and /api/model-endpoints/config) returned every API key in plain
 * text to any signed-in account. Keys now go out as a placeholder, and a placeholder that comes
 * back on a PUT stands for the stored key.
 */
describe("config secrets over the settings API", () => {
  const stored = {
    files: { baseUrl: "http://files.local", apiKey: "files-key", visionBaseUrl: "http://vision.local/v1", visionApiKey: "vision-key" },
    imageGeneration: {
      baseUrl: "http://img.local/v1",
      apiKey: "img-key",
      qualityBackend: { api: "automatic1111-compatible", apiKey: "qb-key" },
    },
    tts: { baseUrl: "", apiKey: "" },
  };

  it("masks every non-empty key, at any depth, and nothing else", () => {
    const masked = maskConfigSecrets(stored);
    expect(masked.files).toEqual({
      baseUrl: "http://files.local", apiKey: SECRET_PLACEHOLDER,
      visionBaseUrl: "http://vision.local/v1", visionApiKey: SECRET_PLACEHOLDER,
    });
    expect(masked.imageGeneration.qualityBackend).toEqual({ api: "automatic1111-compatible", apiKey: SECRET_PLACEHOLDER });
    // An empty key is not a secret: showing it as set would be a lie.
    expect(masked.tts.apiKey).toBe("");
    expect(JSON.stringify(masked)).not.toMatch(/files-key|vision-key|img-key|qb-key/);
    // The input is not touched.
    expect(stored.files.apiKey).toBe("files-key");
  });

  it("reads an echoed placeholder as the stored key, and a new key as itself", () => {
    const result = resolveSecretPlaceholders({
      files: { baseUrl: "http://files.local", apiKey: SECRET_PLACEHOLDER, visionApiKey: "new-vision-key" },
      imageGeneration: { apiKey: SECRET_PLACEHOLDER, qualityBackend: { apiKey: SECRET_PLACEHOLDER } },
    }, stored);
    expect(result).toEqual({
      files: { baseUrl: "http://files.local", apiKey: "files-key", visionApiKey: "new-vision-key" },
      imageGeneration: { apiKey: "img-key", qualityBackend: { apiKey: "qb-key" } },
    });
  });

  it("drops a placeholder that stands for no stored key", () => {
    expect(resolveSecretPlaceholders({ stt: { baseUrl: "", apiKey: SECRET_PLACEHOLDER } }, stored)).toEqual({ stt: { baseUrl: "" } });
  });
});

/**
 * The moved-endpoint refusal only looked at bodies that carried a key's placeholder. PUT
 * /api/multimodal/config merges, so `{"files":{"baseUrl":"https://collector.example"}}` kept the
 * stored key beside the new endpoint and passed — and the Settings page, which leaves an untouched
 * key out of the save, did that on every honest endpoint change. The rule is now judged on the
 * merged result: a saved key goes only where it already went, unless the body typed it in.
 */
describe("a saved key is not sent to an endpoint it was not sent to", () => {
  const ctx: SecretEndpointContext = {
    providerEndpoint: (model) => (model?.startsWith("openrouter/") ? "https://openrouter.example/v1" : "http://lmstudio.local/v1"),
    providerCredential: (model) => (model?.startsWith("anthropic/") ? "anthropic-oauth-token" : "lm-studio"),
    embeddingEndpoint: () => "http://lmstudio.local/v1",
    embeddingCredential: () => "lm-studio",
  };
  // The section as the GET served it, before masking.
  const current = {
    files: { baseUrl: "http://files.local", apiKey: "files-key", visionModel: "lmstudio/qwen-vl", visionBaseUrl: "http://vision.local/v1", visionApiKey: "vision-key" },
    stt: { baseUrl: "http://stt.local", apiKey: "stt-key" },
    tts: { baseUrl: "http://tts.local", apiKey: "tts-key" },
    imageGeneration: {
      baseUrl: "http://img.local/v1",
      api: "openai-compatible",
      apiKey: "img-key",
      qualityModel: "image-quality",
      qualityBackend: { api: "automatic1111-compatible", baseUrl: "http://quality.local" },
    },
  };
  const save = (body: unknown, context = ctx) => checkMultimodalConfigSave(current, body, context);
  const refusedField = (body: unknown, context = ctx) => {
    const result = save(body, context);
    return result.ok ? undefined : (result.details as { field: string }).field;
  };
  const evil = "https://collector.example/v1";

  it("refuses to move an endpoint whose key the body left out", () => {
    expect(refusedField({ files: { baseUrl: evil } })).toBe("files.apiKey");
    expect(refusedField({ files: { visionBaseUrl: evil } })).toBe("files.visionApiKey");
    expect(refusedField({ stt: { baseUrl: evil } })).toBe("stt.apiKey");
    expect(refusedField({ tts: { baseUrl: evil } })).toBe("tts.apiKey");
    expect(refusedField({ imageGeneration: { baseUrl: evil } })).toBe("imageGeneration.apiKey");
    const refused = save({ imageGeneration: { baseUrl: evil } });
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("Enter the key again") });
  });

  it("refuses the same move when the body echoes the key's placeholder", () => {
    expect(refusedField({ imageGeneration: { baseUrl: evil, apiKey: SECRET_PLACEHOLDER } })).toBe("imageGeneration.apiKey");
  });

  it("accepts a moved endpoint with a key typed in, or with the key cleared", () => {
    const typed = save({ imageGeneration: { baseUrl: evil, apiKey: "typed-again" } });
    expect(typed).toMatchObject({ ok: true, patch: { imageGeneration: { baseUrl: evil, apiKey: "typed-again" } } });
    // Cleared: nothing is left to send. The quality tier has no key of its own, so it would fall
    // back to the image key — which is now gone too.
    expect(save({ imageGeneration: { baseUrl: evil, apiKey: null } }).ok).toBe(true);
    expect(save({ files: { baseUrl: evil, apiKey: null } }).ok).toBe(true);
  });

  it("still saves an unrelated edit, with or without the untouched mask", () => {
    expect(save({ imageGeneration: { defaultSteps: 8 } })).toMatchObject({ ok: true, patch: { imageGeneration: { defaultSteps: 8 } } });
    const echoed = save({ imageGeneration: { baseUrl: " http://img.local/v1 ", apiKey: SECRET_PLACEHOLDER, defaultSteps: 8 } });
    expect(echoed).toMatchObject({ ok: true, patch: { imageGeneration: { apiKey: "img-key", defaultSteps: 8 } } });
    // Emptying an endpoint sends its key nowhere.
    expect(save({ stt: { baseUrl: "" } }).ok).toBe(true);
  });

  it("follows the quality tier's key to the endpoint it really uses", () => {
    // The tier has no key of its own: the image key goes to the tier's endpoint.
    expect(refusedField({ imageGeneration: { qualityBackend: { baseUrl: evil } } })).toBe("imageGeneration.apiKey");
    // Dropping the tier's own endpoint hands it the image endpoint, where the image key already goes.
    expect(save({ imageGeneration: { qualityBackend: { baseUrl: null } } }).ok).toBe(true);
    // A key of its own, typed in, travels alone; the image key stays where it was.
    expect(save({ imageGeneration: { qualityBackend: { baseUrl: evil, apiKey: "tier-key" } } }).ok).toBe(true);
    // Moving the image endpoint moves the tier's key too when the tier has no endpoint of its own.
    const noTierEndpoint = { ...current, imageGeneration: { ...current.imageGeneration, qualityBackend: { apiKey: "qb-key" } } };
    const moved = checkMultimodalConfigSave(noTierEndpoint, { imageGeneration: { baseUrl: evil, apiKey: "typed-again" } }, ctx);
    expect(moved).toMatchObject({ ok: false, details: { field: "imageGeneration.qualityBackend.apiKey" } });
  });

  it("reads an endpoint-less openai-compatible image backend as the chat endpoint the loader fills in", () => {
    const chat = { ...ctx, chatEndpoint: "http://img.local/v1" };
    // Following the chat endpoint, which is where the key already went.
    expect(save({ imageGeneration: { baseUrl: "" } }, chat).ok).toBe(true);
    // A different chat endpoint is a different destination.
    expect(refusedField({ imageGeneration: { baseUrl: "" } }, { ...ctx, chatEndpoint: evil })).toBe("imageGeneration.apiKey");
    // Another api keeps no endpoint at all: the key goes nowhere.
    expect(save({ imageGeneration: { baseUrl: "", api: "comfyui" } }, { ...ctx, chatEndpoint: evil }).ok).toBe(true);
  });

  it("sends the vision key to its model's provider when no vision endpoint is set", () => {
    const noVisionEndpoint = { ...current, files: { ...current.files, visionBaseUrl: undefined } };
    const check = (body: unknown) => checkMultimodalConfigSave(noVisionEndpoint, body, ctx);
    expect(check({ files: { visionModel: "lmstudio/other-vl" } }).ok).toBe(true);
    expect(check({ files: { visionModel: "openrouter/qwen-vl" } })).toMatchObject({ ok: false, details: { field: "files.visionApiKey" } });
  });

  /**
   * A `$NAME` counted as a key typed in, so `{"visionApiKey":"$SAI_JWT_SECRET"}` beside the
   * caller's own endpoint passed — and the status probe, open to any signed-in account, sent the
   * gateway's signing secret there. A reference names a secret the caller never saw: it is judged
   * like a saved key, by what it names.
   */
  it("does not take a $NAME or secret: reference for a key typed in", () => {
    const exploit = { files: { visionModel: "lmstudio/x", visionBaseUrl: evil, visionApiKey: "$SAI_JWT_SECRET" } };
    expect(save(exploit)).toMatchObject({ ok: false, details: { field: "files.visionApiKey" }, error: expect.stringContaining("reference") });
    expect(refusedField({ files: { visionBaseUrl: evil, visionApiKey: "secret:anthropic_oauth" } })).toBe("files.visionApiKey");
    expect(refusedField({ imageGeneration: { baseUrl: evil, apiKey: " $HOME" } })).toBe("imageGeneration.apiKey");
    // The two-step version: park a junk key at the endpoint first — accepted, it is typed — then
    // swap in the reference with the endpoint unchanged.
    expect(save({ files: { visionBaseUrl: evil, visionApiKey: "junk" } }).ok).toBe(true);
    const afterStepOne = { ...current, files: { ...current.files, visionBaseUrl: evil, visionApiKey: "junk" } };
    expect(checkMultimodalConfigSave(afterStepOne, { files: { visionApiKey: "$SAI_JWT_SECRET" } }, ctx))
      .toMatchObject({ ok: false, details: { field: "files.visionApiKey" } });
  });

  it("still sends a reference where it already went", () => {
    const withReference = { ...current, stt: { baseUrl: "http://stt.local", apiKey: "$STT_KEY" } };
    const check = (body: unknown) => checkMultimodalConfigSave(withReference, body, ctx);
    // Echoed as the mask, or sent again as itself: same secret, same endpoint.
    expect(check({ stt: { apiKey: SECRET_PLACEHOLDER, model: "whisper-2" } }).ok).toBe(true);
    expect(check({ stt: { apiKey: "$STT_KEY" } }).ok).toBe(true);
    // Another variable at the same path is another secret; the same one at a new endpoint is a move.
    expect(check({ stt: { apiKey: "$SAI_JWT_SECRET" } })).toMatchObject({ ok: false, details: { field: "stt.apiKey" } });
    expect(check({ stt: { baseUrl: evil } })).toMatchObject({ ok: false, details: { field: "stt.apiKey" } });
  });

  /**
   * With no vision key, the runtime sends the vision model's PROVIDER key to the vision endpoint
   * (`visionApiKey ?? provider key`), so `{"visionModel":"anthropic/…","visionBaseUrl":evil}` sent
   * the Anthropic token there — and so did clearing the vision key (`null`) beside a moved endpoint.
   * A moved endpoint with no key of its own must say which key it gets: a typed one, or "" for none.
   */
  it("does not hand the provider's key to a vision endpoint that has no key of its own", () => {
    expect(save({ files: { visionModel: "anthropic/claude-x", visionBaseUrl: evil, visionApiKey: null } }))
      .toMatchObject({ ok: false, details: { field: "files.visionApiKey" }, error: expect.stringContaining("provider's key") });
    expect(save({ files: { visionBaseUrl: evil, visionApiKey: "" } }).ok).toBe(true);
    expect(save({ files: { visionBaseUrl: evil, visionApiKey: "typed" } }).ok).toBe(true);

    const keyless = { ...current, files: { ...current.files, visionApiKey: undefined } };
    const check = (body: unknown) => checkMultimodalConfigSave(keyless, body, ctx);
    expect(check({ files: { visionModel: "anthropic/claude-x" } })).toMatchObject({ ok: false, details: { field: "files.visionApiKey" } });
    expect(check({ files: { visionBaseUrl: evil } })).toMatchObject({ ok: false, details: { field: "files.visionApiKey" } });
    // Where the provider key already went, it may keep going; with no endpoint of its own it stays with the provider.
    expect(check({ files: { visionModel: "lmstudio/other-vl" } }).ok).toBe(true);
    expect(check({ files: { visionBaseUrl: null } }).ok).toBe(true);
  });
});

describe("the channel settings PUT keeps a mail password with its server", () => {
  const existing = { enabled: true, imapHost: "imap.example.com", imapPassword: "imap-pass", smtpHost: "smtp.example.com", smtpPassword: "smtp-pass" };
  // The route: placeholders restored in place, the saved body laid over the channel's base config.
  const check = (received: Record<string, unknown>, base: Record<string, unknown> = {}) => {
    const restored = resolveSecretPlaceholders(received, existing) as Record<string, unknown>;
    return refuseMovedSecrets(channelSecretDestinations, received, existing, { ...base, ...restored });
  };

  it("refuses a moved server with the password echoed, or inherited from the base config", () => {
    expect(check({ ...maskConfigSecrets(existing), imapHost: "imap.collector.example" })).toMatchObject({ ok: false, field: "imapPassword" });
    expect(check({ smtpHost: "smtp.collector.example" }, { smtpPassword: "smtp-pass" })).toMatchObject({ ok: false, field: "smtpPassword" });
  });

  it("accepts an echoed save and a moved server with the password typed in", () => {
    expect(check(maskConfigSecrets(existing))).toEqual({ ok: true });
    expect(check({ ...maskConfigSecrets(existing), imapHost: "imap.new.example", imapPassword: "typed" })).toEqual({ ok: true });
  });
});

describe("the model-endpoints PUT pairs a key with the endpoint the runtime really uses", () => {
  const ctx: SecretEndpointContext = {
    providerEndpoint: () => "http://lmstudio.local/v1",
    providerCredential: () => "provider-key",
    embeddingEndpoint: () => "http://lmstudio.local/v1",
    embeddingCredential: () => "provider-key",
  };
  const destinations = modelEndpointSecretDestinations(ctx);
  const current = {
    orchestrator: { primary: "lmstudio/orch", baseUrl: "http://orch.local/v1", apiKey: "orch-key" },
    embeddings: { embeddingModel: "embed", embeddingApiKey: "embed-key" },
    reranker: { enabled: true, model: "rerank", baseUrl: "http://rerank.local/v1", apiKey: "rerank-key" },
    guard: { enabled: true, model: "guard", baseUrl: "http://guard.local/v1", apiKey: "guard-key" },
  };
  const evil = "https://collector.example/v1";
  // The route's full replace: the parsed body, masked keys restored.
  const check = (body: unknown) => refuseMovedSecrets(destinations, body, current, resolveSecretPlaceholders(body, current));
  const masked = maskConfigSecrets(current);

  it("refuses to send the embeddings key to a moved orchestrator endpoint it falls back to", () => {
    const body = { ...masked, orchestrator: { ...masked.orchestrator, baseUrl: evil, apiKey: "attacker-own-key" } };
    expect(check(body)).toMatchObject({ ok: false, field: "embeddings.embeddingApiKey" });
  });

  it("refuses to send the orchestrator key to an embeddings endpoint it falls back to, and names the embeddings key", () => {
    // The refusal names the key whose "" stops the send. Named on the orchestrator key, the
    // Settings page saved "" over THAT one on the next save, and chat lost its key.
    const withoutEmbeddingKey = { ...masked, embeddings: { embeddingModel: "embed", embeddingBaseUrl: evil } };
    expect(check(withoutEmbeddingKey)).toMatchObject({ ok: false, field: "embeddings.embeddingApiKey" });
    expect(check({ ...withoutEmbeddingKey, embeddings: { ...withoutEmbeddingKey.embeddings, embeddingApiKey: "" } })).toEqual({ ok: true });
  });

  it("judges the embeddings' stand-in key by the embeddings resolver, not the chat one", () => {
    // resolveEmbeddingEndpoint never reads Anthropic's credentials. For an anthropic/* model with
    // none, the chat resolver answered "no key" while the embeddings sent the primary key.
    const split: SecretEndpointContext = {
      providerEndpoint: (model) => (model?.startsWith("anthropic/") ? "https://api.anthropic.com" : "http://lmstudio.local/v1"),
      providerCredential: (model) => (model?.startsWith("anthropic/") ? "" : "primary-key"),
      embeddingEndpoint: () => "http://lmstudio.local/v1",
      embeddingCredential: () => "primary-key",
    };
    const keyless = { ...current, orchestrator: { primary: "lmstudio/orch", baseUrl: "http://orch.local/v1" }, embeddings: { embeddingModel: "lmstudio/embed" } };
    const body = { ...maskConfigSecrets(keyless), embeddings: { embeddingModel: "anthropic/x", embeddingBaseUrl: evil } };
    expect(refuseMovedSecrets(modelEndpointSecretDestinations(split), body, keyless, resolveSecretPlaceholders(body, keyless)))
      .toMatchObject({ ok: false, field: "embeddings.embeddingApiKey", error: expect.stringContaining("provider's key") });
  });

  it("places the embeddings' own key, with no endpoint set, where the embeddings resolver sends it", () => {
    // An anthropic/* model's own key goes to the primary endpoint (resolveEmbeddingEndpoint), not
    // to Anthropic's, where the chat resolver would place it. Placed there, moving the key to
    // Anthropic's endpoint read as no move at all (r3 A-security #4).
    const split: SecretEndpointContext = {
      providerEndpoint: (model) => (model?.startsWith("anthropic/") ? "https://api.anthropic.com" : "http://lmstudio.local/v1"),
      providerCredential: (model) => (model?.startsWith("anthropic/") ? "" : "primary-key"),
      embeddingEndpoint: () => "http://lmstudio.local/v1",
      embeddingCredential: () => "primary-key",
    };
    const own = { ...current, orchestrator: { primary: "lmstudio/orch" }, embeddings: { embeddingModel: "anthropic/x", embeddingApiKey: "embed-key" } };
    const judge = (body: unknown) => refuseMovedSecrets(modelEndpointSecretDestinations(split), body, own, resolveSecretPlaceholders(body, own));
    const maskedOwn = maskConfigSecrets(own);
    expect(judge({ ...maskedOwn, embeddings: { ...maskedOwn.embeddings, embeddingBaseUrl: "https://api.anthropic.com" } }))
      .toMatchObject({ ok: false, field: "embeddings.embeddingApiKey" });
    // Set to where it already goes, it has not moved.
    expect(judge({ ...maskedOwn, embeddings: { ...maskedOwn.embeddings, embeddingBaseUrl: "http://lmstudio.local/v1" } })).toEqual({ ok: true });
  });

  it("keeps an echoed save and a re-keyed move working", () => {
    expect(check(masked)).toEqual({ ok: true });
    const rekeyed = {
      ...masked,
      orchestrator: { ...masked.orchestrator, baseUrl: evil, apiKey: "new-orch-key" },
      embeddings: { ...masked.embeddings, embeddingApiKey: "new-embed-key" },
    };
    expect(check(rekeyed)).toEqual({ ok: true });
    expect(check({ ...masked, reranker: { ...masked.reranker, baseUrl: evil } })).toMatchObject({ ok: false, field: "reranker.apiKey" });
  });

  it("does not take a reference for a key typed in", () => {
    // The same exploit as the vision key: the orchestrator resolves `$NAME` from the gateway's env.
    const body = { ...masked, orchestrator: { ...masked.orchestrator, baseUrl: evil, apiKey: "$SAI_JWT_SECRET" } };
    expect(check(body)).toMatchObject({ ok: false, field: "orchestrator.apiKey" });
  });

  it("does not hand the provider's key to a moved endpoint left without a key", () => {
    const keyless = {
      ...current,
      orchestrator: { primary: "lmstudio/orch", baseUrl: "http://orch.local/v1" },
      embeddings: { embeddingModel: "embed" },
    };
    const checkKeyless = (body: unknown) => refuseMovedSecrets(destinations, body, keyless, resolveSecretPlaceholders(body, keyless));
    const maskedKeyless = maskConfigSecrets(keyless);
    // The orchestrator, and the embeddings that borrow its endpoint, would get the provider's key.
    expect(checkKeyless({ ...maskedKeyless, orchestrator: { primary: "lmstudio/orch", baseUrl: evil } }))
      .toMatchObject({ ok: false, field: "orchestrator.apiKey" });
    expect(checkKeyless({ ...maskedKeyless, embeddings: { embeddingModel: "embed", embeddingBaseUrl: evil } }))
      .toMatchObject({ ok: false, field: "embeddings.embeddingApiKey" });
    // "" says "no key", which stops the fallback; so does a typed key.
    expect(checkKeyless({ ...maskedKeyless, orchestrator: { primary: "lmstudio/orch", baseUrl: evil, apiKey: "" } }))
      .toEqual({ ok: true });
    expect(checkKeyless({ ...maskedKeyless, embeddings: { embeddingModel: "embed", embeddingBaseUrl: evil, embeddingApiKey: "" } }))
      .toEqual({ ok: true });
    // Unmoved, the provider key keeps going where it went.
    expect(checkKeyless(maskedKeyless)).toEqual({ ok: true });
  });
});

/**
 * A sub-agent runs on the default model with its own fields laid over it, so one with an endpoint
 * of its own and no key of its own is sent the DEFAULT key there (or its provider's). PATCH
 * /api/agents/:name/model moved endpoints with no rule, and a config-assistant proposal could
 * move the default or a sub-agent endpoint the same way.
 */
describe("a sub-agent or default model keeps its key with its endpoint", () => {
  const ctx: SecretEndpointContext = {
    providerEndpoint: (model) => (model?.startsWith("anthropic/") ? "https://anthropic.example" : "http://lmstudio.local/v1"),
    providerCredential: (model) => (model?.startsWith("anthropic/") ? "anthropic-oauth-token" : "lm-studio"),
    embeddingEndpoint: () => "http://lmstudio.local/v1",
    embeddingCredential: () => "lm-studio",
  };
  const destinations = agentModelSecretDestinations(ctx);
  const evil = "https://collector.example/v1";
  const config = {
    agents: { defaults: { model: { primary: "lmstudio/orch", baseUrl: "http://orch.local/v1", apiKey: "default-key" } } },
    subAgents: {
      coder: { model: { primary: "lmstudio/coder" } },
      own: { model: { primary: "lmstudio/own", baseUrl: "http://own.local/v1", apiKey: "own-key" } },
    },
  };
  const withAgentModel = (name: string, model: Record<string, unknown>) => ({
    ...config,
    subAgents: { ...config.subAgents, [name]: { model } },
  });
  // As the PATCH route runs it: the body as sent, the config before and after.
  const patch = (name: string, body: Record<string, unknown>, model: Record<string, unknown>) =>
    refuseMovedSecrets(destinations, { subAgents: { [name]: { model: body } } }, config, withAgentModel(name, model));

  it("refuses to send the default key to a sub-agent endpoint it was not sent to", () => {
    expect(patch("coder", { baseUrl: evil }, { primary: "lmstudio/coder", baseUrl: evil }))
      .toMatchObject({ ok: false, field: "agents.defaults.model.apiKey" });
    // Clearing its own key hands it the default one — at its own endpoint.
    expect(patch("own", { apiKey: null }, { primary: "lmstudio/own", baseUrl: "http://own.local/v1" }))
      .toMatchObject({ ok: false, field: "agents.defaults.model.apiKey" });
  });

  it("refuses its own saved key at a moved endpoint, and a reference anywhere new", () => {
    expect(patch("own", { baseUrl: evil }, { primary: "lmstudio/own", baseUrl: evil, apiKey: "own-key" }))
      .toMatchObject({ ok: false, field: "subAgents.own.model.apiKey" });
    expect(patch("own", { apiKey: "$SAI_JWT_SECRET" }, { primary: "lmstudio/own", baseUrl: "http://own.local/v1", apiKey: "$SAI_JWT_SECRET" }))
      .toMatchObject({ ok: false, field: "subAgents.own.model.apiKey" });
  });

  it("refuses the provider's key at a sub-agent endpoint when no key is set anywhere", () => {
    const keyless = { ...config, agents: { defaults: { model: { primary: "lmstudio/orch" } } } };
    const moved = { ...keyless, subAgents: { ...keyless.subAgents, coder: { model: { primary: "anthropic/claude", baseUrl: evil } } } };
    expect(refuseMovedSecrets(destinations, {}, keyless, moved)).toMatchObject({ ok: false, field: "agents.defaults.model.apiKey" });
    const none = { ...keyless, subAgents: { ...keyless.subAgents, coder: { model: { primary: "anthropic/claude", baseUrl: evil, apiKey: "" } } } };
    expect(refuseMovedSecrets(destinations, {}, keyless, none)).toEqual({ ok: true });
  });

  it("follows a sub-agent with a key of its own but no endpoint of its own to a moved default endpoint", () => {
    // Its key goes to the DEFAULT endpoint, so the model-endpoints save that moves that endpoint —
    // with the default key typed in, which covers only the default key — moves this key too.
    const pinnedKey = withAgentModel("coder", { primary: "lmstudio/coder", apiKey: "coder-key" });
    const moved = { ...pinnedKey, agents: { defaults: { model: { ...config.agents.defaults.model, baseUrl: evil, apiKey: "typed" } } } };
    const typed = { agents: { defaults: { model: { apiKey: "typed" } } } };
    expect(refuseMovedSecrets(destinations, typed, pinnedKey, moved)).toMatchObject({ ok: false, field: "subAgents.coder.model.apiKey" });
    // Without such a sub-agent the same save passes: the default key was typed in.
    expect(refuseMovedSecrets(destinations, typed, config, { ...config, agents: moved.agents })).toEqual({ ok: true });
  });

  it("accepts a typed key, and edits that move nothing", () => {
    expect(patch("coder", { baseUrl: evil, apiKey: "typed" }, { primary: "lmstudio/coder", baseUrl: evil, apiKey: "typed" })).toEqual({ ok: true });
    expect(patch("own", { temperature: 0.2 }, { ...config.subAgents.own.model, temperature: 0.2 })).toEqual({ ok: true });
  });

  it("judges a config-assistant proposal, which types nothing, on the config it leaves", () => {
    const moveDefault = { ...config, agents: { defaults: { model: { ...config.agents.defaults.model, baseUrl: evil } } } };
    expect(refuseMovedSecrets(destinations, {}, config, moveDefault)).toMatchObject({ ok: false, field: "agents.defaults.model.apiKey" });
    const moveEmbeddings = { ...config, agents: { defaults: { model: { ...config.agents.defaults.model, embeddingBaseUrl: evil } } } };
    expect(refuseMovedSecrets(destinations, {}, config, moveEmbeddings)).toMatchObject({ ok: false, field: "agents.defaults.model.embeddingApiKey" });
    const retune = { ...config, agents: { defaults: { model: { ...config.agents.defaults.model, temperature: 0.3 } } } };
    expect(refuseMovedSecrets(destinations, {}, config, retune)).toEqual({ ok: true });
  });
});
