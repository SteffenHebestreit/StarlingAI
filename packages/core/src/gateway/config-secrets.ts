/**
 * Secrets in the settings the dashboard reads and writes back.
 *
 * The config GET routes are open to every signed-in account (reads bypass the role gate), and they
 * returned API keys in plain text. So a secret goes out as a placeholder, and a placeholder that
 * comes back on a PUT stands for the value already stored: the Settings page can keep echoing
 * what it was given without ever seeing, or overwriting, the key. A key nobody re-entered is only
 * ever sent where it was already being sent (`refuseMovedSecrets`, one rule for every route that
 * restores masked keys).
 */

/** What a stored secret reads as over the API. The channel settings use the same placeholder. */
export const SECRET_PLACEHOLDER = "••••••••";

/** Field names that hold a credential: apiKey, visionApiKey, embeddingApiKey, *Secret, *Password… */
const SECRET_KEY_PATTERN = /(?:apikey|secret|password|authtoken|accesstoken)$/i;

export function isSecretConfigKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

/**
 * A value the runtime reads as a pointer to a secret kept elsewhere, not as a key: `$NAME`, an
 * environment variable (providers/index.ts, channels/base.ts, tools/infrastructure-shared.ts), or
 * `secret:name`, the credential store (tools/infrastructure-shared.ts, credentials/sites.ts). Every
 * `$` counts, `$$` included: the providers resolve that too.
 */
export function isSecretReference(value: unknown): boolean {
  return typeof value === "string" && /^\s*(?:\$|secret:)/i.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A copy with every non-empty secret string replaced by the placeholder. An empty one stays empty. */
export function maskConfigSecrets<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => maskConfigSecrets(entry)) as T;
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = isSecretConfigKey(key) && typeof entry === "string" && entry !== ""
      ? SECRET_PLACEHOLDER
      : maskConfigSecrets(entry);
  }
  return out as T;
}

/**
 * Replace every placeholder in a PUT body with the secret it stands for, read from `current` (the
 * settings as the GET served them) at the same path. A placeholder with no stored secret behind it
 * is dropped.
 *
 * Restoring is all this does. Whether a restored (or merged-in) key may go where the save sends it
 * is `refuseMovedSecrets`' question, asked of the finished result: the multimodal PUT merges, so a
 * body that moves an endpoint need not carry the key's placeholder at all.
 */
export function resolveSecretPlaceholders(body: unknown, current: unknown): unknown {
  if (!isPlainObject(body)) return body;
  const stored = isPlainObject(current) ? current : {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (isSecretConfigKey(key) && value === SECRET_PLACEHOLDER) {
      if (typeof stored[key] === "string") out[key] = stored[key];
      continue;
    }
    out[key] = resolveSecretPlaceholders(value, stored[key]);
  }
  return out;
}

/** A key, by its dotted path in the section, and the endpoint the runtime sends it to. */
export interface SecretDestination {
  keyPath: string;
  /** Empty when the key goes nowhere: no endpoint is configured for it. */
  endpoint: string | undefined;
  /**
   * Set when keyPath is unset and the runtime sends another credential in its place: the
   * provider's key (`overrides.apiKey ?? provider key` in providers/index.ts). Its value names that
   * credential; empty when the provider has none.
   */
  fallback?: string;
  /**
   * The field a refusal names when it is not keyPath: the one whose value stops the send. The
   * embeddings borrow the orchestrator's key, but "" belongs in THEIR key — named on the
   * orchestrator's, the Settings page saved "" over the orchestrator key and chat lost its key.
   */
  field?: string;
}

/** Every key a section sends and where to, read from the section as the runtime reads it. */
export type SecretDestinations = (section: unknown) => SecretDestination[];

/** What the table needs from outside the section to say where a key ends up. */
export interface SecretEndpointContext {
  /** The endpoint a model name's provider resolves to, for a key whose own endpoint is unset. */
  providerEndpoint(model: string | undefined): string | undefined;
  /** The key a model name's provider sends when nothing overrides it; empty or undefined for none. */
  providerCredential(model: string | undefined): string | undefined;
  /**
   * The same two for the embeddings, which resolveEmbeddingEndpoint (providers/index.ts) resolves
   * on its own terms: the model's OpenAI-compatible provider, else the primary one — never
   * Anthropic's, so for an anthropic/* model it sends the primary key where the chat resolver
   * names the (maybe absent) Anthropic credential.
   */
  embeddingEndpoint(model: string | undefined): string | undefined;
  embeddingCredential(model: string | undefined): string | undefined;
  /** What the config loader fills into an openai-compatible image backend left without an endpoint. */
  chatEndpoint?: string;
}

function readPath(value: unknown, path: string): unknown {
  let at = value;
  for (const segment of path.split(".")) {
    if (!isPlainObject(at)) return undefined;
    at = at[segment];
  }
  return at;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function section(value: unknown, key: string): Record<string, unknown> {
  const inner = isPlainObject(value) ? value[key] : undefined;
  return isPlainObject(inner) ? inner : {};
}

/**
 * A model call's key and where it goes, as resolveEndpointForProviderModel (providers/index.ts)
 * reads it: the key of its own, to the endpoint of its own or else its provider's. With no key of
 * its own (`??`: "" is a key, "none"), the provider's key goes instead — and leaves the provider
 * only when an endpoint of its own is set, which is the one case worth a route.
 */
function modelKeyRoute(
  ctx: SecretEndpointContext,
  keyPath: string,
  key: unknown,
  endpoint: string,
  model: string | undefined,
): SecretDestination {
  if (typeof key === "string" || !endpoint) return { keyPath, endpoint: endpoint || ctx.providerEndpoint(model) };
  return { keyPath, endpoint, fallback: ctx.providerCredential(model) ?? "" };
}

/**
 * The embeddings key and where it goes, as resolveEmbeddingEndpoint (providers/index.ts) reads it:
 * whichever of key and endpoint the embeddings do not set, they borrow from the orchestrator, then
 * from the provider — so the orchestrator key reaches an embeddings endpoint and the embeddings key
 * an orchestrator one. The provider is the embeddings resolver's, not the chat one's (see
 * embeddingCredential), and a refusal names the embeddings key whichever key it judged.
 */
function embeddingKeyRoute(
  ctx: SecretEndpointContext,
  paths: { embeddingKey: string; orchestratorKey: string },
  embeddings: Record<string, unknown>,
  orchestrator: Record<string, unknown>,
): SecretDestination {
  const model = text(embeddings["embeddingModel"]) || text(orchestrator["primary"]) || undefined;
  const endpoint = text(embeddings["embeddingBaseUrl"]) || text(orchestrator["baseUrl"]);
  const field = paths.embeddingKey;
  if (typeof embeddings["embeddingApiKey"] === "string") {
    return { keyPath: paths.embeddingKey, endpoint: endpoint || ctx.embeddingEndpoint(model) };
  }
  if (typeof orchestrator["apiKey"] === "string" || !endpoint) {
    return { keyPath: paths.orchestratorKey, field, endpoint: endpoint || ctx.embeddingEndpoint(model) };
  }
  return { keyPath: paths.orchestratorKey, field, endpoint, fallback: ctx.embeddingCredential(model) ?? "" };
}

/**
 * The multimodal section's keys and where each goes. Two of them do not go to the endpoint beside
 * them: the quality tier sends the image key when it has none of its own, to its own endpoint when
 * it has one (resolveTierBackend in image-generation.ts); the vision key goes to the vision model's
 * provider when no vision endpoint is set, and with no vision key the provider's key goes to the
 * vision endpoint.
 */
export function multimodalSecretDestinations(ctx: SecretEndpointContext): SecretDestinations {
  return (config) => {
    const files = section(config, "files");
    const image = section(config, "imageGeneration");
    const imageEndpoint = text(image["baseUrl"])
      || (image["api"] === "openai-compatible" ? text(ctx.chatEndpoint) : "");
    const destinations: SecretDestination[] = [
      { keyPath: "files.apiKey", endpoint: text(files["baseUrl"]) },
      modelKeyRoute(ctx, "files.visionApiKey", files["visionApiKey"], text(files["visionBaseUrl"]), text(files["visionModel"]) || undefined),
      { keyPath: "stt.apiKey", endpoint: text(section(config, "stt")["baseUrl"]) },
      { keyPath: "tts.apiKey", endpoint: text(section(config, "tts")["baseUrl"]) },
      { keyPath: "imageGeneration.apiKey", endpoint: imageEndpoint },
    ];
    const quality = image["qualityBackend"];
    if (isPlainObject(quality)) {
      destinations.push({
        keyPath: text(quality["apiKey"]) ? "imageGeneration.qualityBackend.apiKey" : "imageGeneration.apiKey",
        endpoint: typeof quality["baseUrl"] === "string" ? text(quality["baseUrl"]) : imageEndpoint,
      });
    }
    return destinations;
  };
}

/** The model-endpoints body's keys and where each goes (the orchestrator and embeddings pair: embeddingKeyRoute). */
export function modelEndpointSecretDestinations(ctx: SecretEndpointContext): SecretDestinations {
  return (config) => {
    const orchestrator = section(config, "orchestrator");
    return [
      modelKeyRoute(ctx, "orchestrator.apiKey", orchestrator["apiKey"], text(orchestrator["baseUrl"]), text(orchestrator["primary"]) || undefined),
      embeddingKeyRoute(ctx, { embeddingKey: "embeddings.embeddingApiKey", orchestratorKey: "orchestrator.apiKey" }, section(config, "embeddings"), orchestrator),
      { keyPath: "reranker.apiKey", endpoint: text(section(config, "reranker")["baseUrl"]) },
      { keyPath: "guard.apiKey", endpoint: text(section(config, "guard")["baseUrl"]) },
    ];
  };
}

/**
 * The chat models' keys in a whole config and where each goes: the default model, its embeddings,
 * and every sub-agent, which runs on the default model with its own fields laid over it
 * (mergeAgentModelOverride in agent/sub-agent-model-config.ts). A sub-agent with an endpoint of its
 * own but no key of its own is sent the DEFAULT key there — or, with none, its provider's.
 */
export function agentModelSecretDestinations(ctx: SecretEndpointContext): SecretDestinations {
  return (config) => {
    const defaults = section(section(config, "agents"), "defaults");
    const model = section(defaults, "model");
    const base = "agents.defaults.model";
    const routes: SecretDestination[] = [
      modelKeyRoute(ctx, `${base}.apiKey`, model["apiKey"], text(model["baseUrl"]), text(model["primary"]) || undefined),
      embeddingKeyRoute(ctx, { embeddingKey: `${base}.embeddingApiKey`, orchestratorKey: `${base}.apiKey` }, model, model),
    ];
    for (const [name, agent] of Object.entries(section(config, "subAgents"))) {
      const own = section(agent, "model");
      const merged = { ...model, ...Object.fromEntries(Object.entries(own).filter(([, value]) => value !== undefined)) };
      const keyPath = own["apiKey"] !== undefined ? `subAgents.${name}.model.apiKey` : `${base}.apiKey`;
      routes.push(modelKeyRoute(ctx, keyPath, merged["apiKey"], text(merged["baseUrl"]), text(merged["primary"]) || undefined));
    }
    return routes;
  };
}

/**
 * A channel's keys that go to a host its settings name: the mail server passwords. The chat
 * platforms' tokens go to fixed hosts that no setting moves.
 */
export const channelSecretDestinations: SecretDestinations = (config) => {
  const channel = isPlainObject(config) ? config : {};
  return [
    { keyPath: "imapPassword", endpoint: text(channel["imapHost"]) },
    { keyPath: "smtpPassword", endpoint: text(channel["smtpHost"]) },
  ];
};

/**
 * What a route sends, named so that the same name before and after is the same secret: a saved key
 * by its path; a reference by its path AND what it names, since the same path pointing elsewhere
 * is another secret; a provider's key standing in for an unset one by that key, whichever path it
 * stands in for.
 */
function secretSent(config: unknown, route: SecretDestination): string | undefined {
  if (route.fallback !== undefined) return text(route.fallback) ? `fallback\n${text(route.fallback)}` : undefined;
  const value = text(readPath(config, route.keyPath));
  if (!value) return undefined;
  return isSecretReference(value) ? `${route.keyPath}\n${value}` : route.keyPath;
}

/**
 * Refuse a save that would send a saved key somewhere it was not being sent.
 *
 * Otherwise any account that can save settings could point an endpoint at a server of its own and
 * have the gateway send it a key it was never shown — and the Settings page did exactly that on an
 * honest endpoint change, since it leaves an untouched key out of the save. So the rule is judged on
 * the result, not on the body: every key the saved settings send (`after`) must already have gone
 * to that endpoint (`before`), unless this body typed the key in. A key the body clears (`null`)
 * is sent nowhere, so clearing one is allowed — unless the runtime then sends the provider's key in
 * its place, which is judged like any other key ("" says "no key" and stops that fallback); a key
 * that falls back to another is judged as that other key. `body` is the body as received,
 * placeholders and all.
 *
 * A `$NAME` or `secret:name` in the body is not typed in: the runtime reads it as the secret it
 * names, one the caller need never have seen — `{"visionApiKey":"$SAI_JWT_SECRET"}` beside their
 * own endpoint sent them the gateway's signing secret. It passes only where that same reference
 * already went.
 */
export function refuseMovedSecrets(
  destinations: SecretDestinations,
  body: unknown,
  before: unknown,
  after: unknown,
): { ok: true } | { ok: false; error: string; field: string } {
  const sentBefore = new Set<string>();
  for (const route of destinations(before)) {
    const secret = secretSent(before, route);
    if (secret && text(route.endpoint)) sentBefore.add(`${secret}\n${text(route.endpoint)}`);
  }
  for (const route of destinations(after)) {
    const secret = secretSent(after, route);
    if (!secret || !text(route.endpoint)) continue;
    const sent = readPath(body, route.keyPath);
    const typedIn = route.fallback === undefined && typeof sent === "string" && sent !== ""
      && sent !== SECRET_PLACEHOLDER && !isSecretReference(sent);
    if (typedIn || sentBefore.has(`${secret}\n${text(route.endpoint)}`)) continue;
    const field = route.field ?? route.keyPath;
    return {
      ok: false,
      field,
      error: route.fallback !== undefined
        ? `${field}: with no key of its own, the endpoint would be sent the provider's key. Enter a key, or "" for none.`
        : isSecretReference(sent)
          ? `${field}: a $NAME or secret: reference is only sent where the secret it names already goes. Enter the key itself.`
          : field !== route.keyPath
            ? `${field}: with no key of its own, the endpoint would be sent the saved key at ${route.keyPath}. Enter a key, or "" for none.`
            : `${field}: the endpoint changed, so the saved key is not sent to it. Enter the key again.`,
    };
  }
  return { ok: true };
}
