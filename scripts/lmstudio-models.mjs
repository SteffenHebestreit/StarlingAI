import { execFileSync } from "node:child_process";

function readGatewayEnv(name) {
  try {
    return execFileSync("docker", ["exec", "starlingai-gateway-1", "printenv", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function nativeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/v1\/?$/, "").replace(/\/$/, "");
}

// Prefer the provider-neutral primary-model vars; fall back to the legacy SAI_LMSTUDIO_* aliases.
const lmstudioUrl = process.env.SAI_PRIMARY_MODEL_URL || process.env.SAI_LMSTUDIO_URL
  || readGatewayEnv("SAI_PRIMARY_MODEL_URL") || readGatewayEnv("SAI_LMSTUDIO_URL") || "http://localhost:1234/v1";
const apiKey = process.env.SAI_PRIMARY_MODEL_KEY || process.env.SAI_LMSTUDIO_API_KEY
  || readGatewayEnv("SAI_PRIMARY_MODEL_KEY") || readGatewayEnv("SAI_LMSTUDIO_API_KEY");
const url = `${nativeBaseUrl(lmstudioUrl)}/api/v0/models`;

const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
const response = await fetch(url, { headers });
const body = await response.text();

if (!response.ok) {
  console.error(`LM Studio models check failed: HTTP ${response.status}`);
  console.error(body);
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(body);
} catch {
  console.error("LM Studio models check failed: response was not JSON");
  console.error(body);
  process.exit(1);
}

const models = Array.isArray(payload.data) ? payload.data : [];
console.log(`LM Studio native models: ${models.length} total (${url})`);
console.log(`API token: ${apiKey ? `present, length=${apiKey.length}` : "not set"}`);

for (const model of models) {
  const id = typeof model.id === "string" ? model.id : "<unknown>";
  const state = typeof model.state === "string" ? model.state : "unknown";
  const type = typeof model.type === "string" ? model.type : "unknown";
  const context = typeof model.loaded_context_length === "number" ? ` context=${model.loaded_context_length}` : "";
  console.log(`${state.padEnd(10)} ${type.padEnd(10)} ${id}${context}`);
}