/// <reference types="node" />
/// <reference lib="dom" />

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import { SignJWT } from "jose";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "../../../..");
const gatewayBaseUrl = process.env["SAI_GATEWAY_URL"]?.trim() || "http://127.0.0.1:8765";
const speechText = process.env["SAI_QWEN_SMOKE_TEXT"]?.trim() || "Hello from the Qwen speech smoke test.";
const sampleAudioPath = process.env["SAI_QWEN_SMOKE_SAMPLE_PATH"]?.trim();
const smokeLogPath = resolve(repoRoot, ".starlingai/qwen-speech-smoke.last.log");
const smokeStatusPath = resolve(repoRoot, ".starlingai/qwen-speech-smoke.last.status");

type TranscriptionResponse = {
  text?: string;
  language?: string;
  duration?: number;
};

type SaveVoiceResponse = {
  voice_id?: string;
  name?: string;
  ref_text?: string;
};

type MultimodalStatusResponse = {
  tts?: {
    ok?: boolean;
    error?: string;
  };
};

async function main(): Promise<void> {
  resetSmokeLog();
  logStep(`gateway: ${gatewayBaseUrl}`);

  await waitForHealth(`${gatewayBaseUrl}/healthz`);
  const token = await getGatewayToken();
  const voiceName = `smoke-${Date.now()}`;

  logStep("step: verify qwen tts readiness");
  await ensureTtsReady(token);

  const speakerAudio = loadSeedAudioSample(token);
  assertWav(speakerAudio, "Initial smoke seed sample");

  logStep("step: transcribe generated sample through qwen asr");
  const transcript = await transcribeAudio(token, speakerAudio, "smoke-sample.wav");
  if (!transcript.text?.trim()) {
    throw new Error(`ASR returned empty text: ${JSON.stringify(transcript)}`);
  }

  logStep("step: save generated sample as qwen voice");
  const savedVoice = await saveVoice(token, speakerAudio, voiceName);
  if (!savedVoice.voice_id?.trim()) {
    throw new Error(`Voice save returned no voice_id: ${JSON.stringify(savedVoice)}`);
  }

  logStep("step: synthesize using saved qwen voice");
  const clonedAudio = await synthesizeSpeech(token, {
    text: speechText,
    voiceId: savedVoice.voice_id,
  });
  assertWav(clonedAudio, "Saved-voice Qwen TTS output");

  logStep("Qwen speech smoke passed");
  logStep(`Transcript: ${transcript.text}`);
  logStep(`Saved voice: ${savedVoice.voice_id}`);
  if (savedVoice.ref_text) {
    logStep(`Reference text: ${savedVoice.ref_text}`);
  }

  writeFileSync(smokeStatusPath, "0\n", "utf8");
}

function resetSmokeLog(): void {
  mkdirSync(resolve(repoRoot, ".starlingai"), { recursive: true });
  writeFileSync(smokeLogPath, "", "utf8");
  writeFileSync(smokeStatusPath, "running\n", "utf8");
}

function logStep(message: string): void {
  console.log(message);
  appendFileSync(smokeLogPath, `${message}\n`, "utf8");
}

async function getGatewayToken(): Promise<string> {
  const envToken = process.env["SAI_TOKEN"]?.trim();
  if (envToken) return envToken;

  const secret = resolveGatewaySecret();
  return await new SignJWT({ sub: "admin", role: "admin" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(new TextEncoder().encode(secret));
}

function loadSeedAudioSample(token: string): Uint8Array {
  void token;

  if (sampleAudioPath) {
    const resolvedPath = resolve(sampleAudioPath);
    if (!existsSync(resolvedPath)) {
      throw new Error(`Configured smoke sample does not exist: ${resolvedPath}`);
    }
    logStep(`step: use local seed sample (${resolvedPath})`);
    return new Uint8Array(readFileSync(resolvedPath));
  }

  throw new Error("No smoke seed sample configured. Set SAI_QWEN_SMOKE_SAMPLE_PATH to a WAV file with spoken text and rerun.");
}

function resolveGatewaySecret(): string {
  const envSecret = process.env["SAI_JWT_SECRET"]?.trim();
  if (envSecret && envSecret.length >= 32) return envSecret;

  const configSecret = readConfigJwtSecret();
  if (configSecret && configSecret.length >= 32) return configSecret;

  const secretPath = join(homedir(), ".starlingai", ".jwt_secret");
  try {
    const stored = readFileSync(secretPath, "utf8").trim();
    if (stored.length >= 32) return stored;
  } catch {
    // fall through
  }

  const dockerSecret = readGatewaySecretFromDocker();
  if (dockerSecret && dockerSecret.length >= 32) return dockerSecret;

  throw new Error("Could not resolve the active gateway JWT secret. Set SAI_TOKEN or SAI_JWT_SECRET and retry.");
}

function readConfigJwtSecret(): string | undefined {
  const explicitConfigPath = process.env["SAI_CONFIG_PATH"]?.trim();
  const configPath = explicitConfigPath ? resolve(explicitConfigPath) : resolve(repoRoot, "starlingai.json");

  try {
    const parsed = JSON5.parse(readFileSync(configPath, "utf8")) as { gateway?: { jwtSecret?: unknown } };
    const jwtSecret = parsed.gateway?.jwtSecret;
    return typeof jwtSecret === "string" ? jwtSecret.trim() : undefined;
  } catch {
    return undefined;
  }
}

function readGatewaySecretFromDocker(): string | undefined {
  try {
    const composeOutput = execFileSync("docker", ["compose", "ps", "--format", "json", "gateway"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    if (!composeOutput) return undefined;

    const composeEntry = JSON.parse(composeOutput) as { Name?: string };
    const containerName = typeof composeEntry.Name === "string" ? composeEntry.Name.trim() : "";
    if (!containerName) return undefined;

    const envOutput = execFileSync("docker", ["inspect", "--format", "{{range .Config.Env}}{{println .}}{{end}}", containerName], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    const secretLine = envOutput.split(/\r?\n/).find((line) => line.startsWith("SAI_JWT_SECRET="));
    const secret = secretLine?.slice("SAI_JWT_SECRET=".length).trim();
    return secret || undefined;
  } catch {
    return undefined;
  }
}

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // retry
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }

  throw new Error(`Timed out waiting for gateway health at ${url}`);
}

async function transcribeAudio(token: string, audioBytes: Uint8Array, filename: string): Promise<TranscriptionResponse> {
  const form = new FormData();
  form.append("file", new File([bytesToAudioBlob(audioBytes)], filename, { type: "audio/wav" }));

  const response = await fetch(`${gatewayBaseUrl}/api/multimodal/transcribe`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`ASR request failed with ${response.status}: ${await response.text()}`);
  }
  return await response.json() as TranscriptionResponse;
}

async function ensureTtsReady(token: string): Promise<void> {
  let lastError = "unknown error";

  for (let attempt = 1; attempt <= 6; attempt += 1) {
    try {
      const response = await fetch(`${gatewayBaseUrl}/api/multimodal/status`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        lastError = `HTTP ${response.status}: ${await response.text()}`;
      } else {
        const body = await response.json() as MultimodalStatusResponse;
        if (body.tts?.ok) {
          return;
        }
        lastError = body.tts?.error ?? "unknown error";
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (attempt < 6) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5000));
    }
  }

  logStep(`warning: TTS readiness check did not pass after retries (${lastError}); continuing with live synthesis`);
}

async function saveVoice(token: string, audioBytes: Uint8Array, voiceName: string): Promise<SaveVoiceResponse> {
  const form = new FormData();
  form.append("name", voiceName);
  form.append("language", "English");
  form.append("file", new File([bytesToAudioBlob(audioBytes)], `${voiceName}.wav`, { type: "audio/wav" }));

  const response = await fetch(`${gatewayBaseUrl}/api/multimodal/voices/save`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!response.ok) {
    throw new Error(`Voice save request failed with ${response.status}: ${await response.text()}`);
  }
  return await response.json() as SaveVoiceResponse;
}

async function synthesizeSpeech(token: string, payload: { text: string; speaker?: string; voiceId?: string; model?: string }): Promise<Uint8Array> {
  const response = await fetch(`${gatewayBaseUrl}/api/multimodal/tts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`TTS request failed with ${response.status}: ${await response.text()}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function bytesToAudioBlob(audioBytes: Uint8Array): Blob {
  const arrayBuffer = audioBytes.buffer.slice(
    audioBytes.byteOffset,
    audioBytes.byteOffset + audioBytes.byteLength,
  ) as ArrayBuffer;
  return new Blob([arrayBuffer], { type: "audio/wav" });
}

function assertWav(audioBytes: Uint8Array, label: string): void {
  const riff = Buffer.from(audioBytes.subarray(0, 4)).toString("utf8");
  if (riff !== "RIFF") {
    throw new Error(`${label} did not return WAV bytes`);
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  try {
    appendFileSync(smokeLogPath, `${message}\n`, "utf8");
    writeFileSync(smokeStatusPath, "1\n", "utf8");
  } catch {
    // Ignore logging failures on the failure path.
  }
  process.exit(1);
});
