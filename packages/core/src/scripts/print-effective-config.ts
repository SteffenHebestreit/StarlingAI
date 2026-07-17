// Prints the fully-merged effective configuration as JSON on stdout.
//
// Secret-shaped string values (keys matching apiKey, jwtSecret, authToken,
// botToken, token, oauthToken, clientSecret, secretAccessKey, password,
// webhookSecret, secret — case-insensitive) are replaced with
// "<redacted:<length>>" so env-injected credentials never reach CI logs or
// registry tooling. Key names and object structure are preserved, so
// consumers such as scripts/audit-config-flags.mjs still see every field.
// Pass --with-secrets to skip redaction (local debugging only).
//
// stdout must stay pure JSON for consumers, so the logger defaults to silent
// here; the env must be set before the loader (and its logger) is imported,
// hence the dynamic import.
if (!process.env["LOG_LEVEL"]) process.env["LOG_LEVEL"] = "silent";
const { loadConfig } = await import("../config/loader.js");

const SECRET_KEY_NAMES = new Set([
  "apikey",
  "jwtsecret",
  "authtoken",
  "bottoken",
  "token",
  "oauthtoken",
  "clientsecret",
  "secretaccesskey",
  "password",
  "webhooksecret",
  "secret",
]);

function redactSecrets(value: unknown, keyName?: string): unknown {
  if (typeof value === "string" && keyName !== undefined && SECRET_KEY_NAMES.has(keyName.toLowerCase())) {
    return `<redacted:${String(value).length}>`;
  }
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, redactSecrets(nested, key)]));
  }
  return value;
}

const config = loadConfig({ skipCompiledWrite: true });
const output = process.argv.includes("--with-secrets") ? config : redactSecrets(config);
process.stdout.write(JSON.stringify(output));
