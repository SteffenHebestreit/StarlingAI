#!/usr/bin/env node
/**
 * StarlingAI guided setup wizard — Docker-only first-run.
 *
 * Runs inside a bare `node:22-alpine` container (no pnpm, no dependency
 * install) with the repo mounted, so the *only* host prerequisite is Docker.
 * It uses Node built-ins exclusively.
 *
 * What it does:
 *   1. Generates the core secrets (JWT, master key, Postgres password).
 *   2. Asks which model backend to use:
 *        A) a model you provide  — Anthropic API key, or any OpenAI-compatible
 *           endpoint (LM Studio, vLLM, llama.cpp, OpenAI, …)
 *        B) a local model via Ollama — no API key, pulled automatically
 *   3. Optionally wires one chat channel (Telegram) now.
 *   4. Writes everything to `.env`, bootstraps `starlingai.json` from the
 *      shipped example (the gateway re-parses it as JSON5), and mints a
 *      dashboard login token so the browser opens already signed in.
 *
 * Flags:
 *   --defaults   Non-interactive. Uses sensible defaults (OpenAI-compatible
 *                LM Studio at host.docker.internal) — used by CI and the
 *                launchers' unattended path. Env overrides honoured:
 *                SAI_SETUP_BACKEND=byo-openai|byo-anthropic|ollama,
 *                SAI_SETUP_MODEL, SAI_SETUP_URL, SAI_SETUP_API_KEY.
 */
import { randomBytes, createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const CWD = process.cwd();
const ENV_FILE = join(CWD, ".env");
const CONFIG_FILE = join(CWD, "starlingai.json");
const EXAMPLE_CONFIG = join(REPO_ROOT, "starlingai.example.json");
const TOKEN_DIR = join(CWD, ".starlingai");
const TOKEN_FILE = join(TOKEN_DIR, "dashboard-token.txt");

const NON_INTERACTIVE = process.argv.includes("--defaults") || !input.isTTY;

// ── tiny ANSI helpers (mirrors scripts/setup.mjs) ───────────────────────────
const BOLD = "\x1b[1m", GREEN = "\x1b[32m", YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m", DIM = "\x1b[2m", RESET = "\x1b[0m";
const log = (m = "") => console.log(m);
const ok = (m) => console.log(`${GREEN}✓${RESET} ${m}`);
const warn = (m) => console.log(`${YELLOW}⚠${RESET} ${m}`);
const info = (m) => console.log(`${CYAN}ℹ${RESET} ${m}`);

// ── .env read/merge/write (order-preserving, never clobbers existing keys) ───
function readEnv() {
  const env = {};
  if (!existsSync(ENV_FILE)) return env;
  for (const line of readFileSync(ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}
function writeEnv(env) {
  const body = Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  writeFileSync(ENV_FILE, body, { mode: 0o600 });
}

// ── HS256 JWT minting (mirrors scripts/gen-token.mjs) ────────────────────────
function b64url(value) {
  return Buffer.from(value).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function mintToken(secret, { userId = "admin", role = "admin", ttlSeconds = 30 * 86400 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ sub: userId, role, iat: now, exp: now + ttlSeconds }));
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64")
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${header}.${payload}.${sig}`;
}

// ── model-endpoint probe — validate the chosen model actually answers BEFORE
// declaring setup done, and list the loaded ids so the user picks a real one
// (no guessing). Best-effort: a failure never throws into setup.
async function probeOpenAi(baseUrl, apiKey) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return { reachable: true, models: [], status: res.status };
    const body = await res.json().catch(() => ({}));
    const models = Array.isArray(body?.data) ? body.data.map((m) => m?.id).filter(Boolean) : [];
    return { reachable: true, models };
  } catch {
    return { reachable: false, models: [] };
  }
}

async function main() {
  log(`\n${BOLD}🐦 StarlingAI — guided setup${RESET}\n`);
  if (NON_INTERACTIVE) {
    if (process.argv.includes("--defaults")) info("Running non-interactively (--defaults).");
    // A double-clicked launcher that didn't allocate a TTY silently lands here —
    // make that loud so the user knows defaults (not their input) are being used.
    else warn("No interactive terminal detected — using DEFAULTS (local model at host.docker.internal:1234). Re-run `pnpm sai setup` in a real terminal to choose a backend.");
  }

  const env = readEnv();
  const rl = NON_INTERACTIVE ? null : createInterface({ input, output });
  const ask = async (q, def = "") => {
    if (!rl) return def;
    const a = (await rl.question(`${q}${def ? ` ${DIM}[${def}]${RESET}` : ""}: `)).trim();
    return a || def;
  };
  const choose = async (q, options, defIdx = 0) => {
    if (!rl) return defIdx;
    log(`\n${BOLD}${q}${RESET}`);
    options.forEach((o, i) => log(`  ${CYAN}${i + 1}${RESET}) ${o}`));
    const a = (await rl.question(`Choose ${DIM}[${defIdx + 1}]${RESET}: `)).trim();
    const n = Number.parseInt(a, 10);
    return Number.isInteger(n) && n >= 1 && n <= options.length ? n - 1 : defIdx;
  };

  try {
    // ── 1. secrets ──────────────────────────────────────────────────────────
    let changed = false;
    if (!env.SAI_JWT_SECRET || env.SAI_JWT_SECRET.length < 32) {
      env.SAI_JWT_SECRET = randomBytes(48).toString("base64url"); changed = true; ok("Generated SAI_JWT_SECRET");
    }
    if (!env.SAI_MASTER_KEY || env.SAI_MASTER_KEY.length < 32) {
      env.SAI_MASTER_KEY = randomBytes(48).toString("base64url"); changed = true; ok("Generated SAI_MASTER_KEY (credential encryption)");
    }
    if (!env.POSTGRES_PASSWORD) {
      env.POSTGRES_PASSWORD = randomBytes(24).toString("base64url"); changed = true; ok("Generated POSTGRES_PASSWORD");
    }
    if (!changed) info("Secrets already present — preserving them.");

    // ── 2. model backend ─────────────────────────────────────────────────────
    const backendChoice = NON_INTERACTIVE
      ? ({ "byo-openai": 0, "byo-anthropic": 1, ollama: 2 }[process.env.SAI_SETUP_BACKEND ?? "byo-openai"] ?? 0)
      : await choose("How should the swarm reach a language model?", [
          "Connect to an OpenAI-compatible endpoint I run (LM Studio, vLLM, llama.cpp, OpenAI…)",
          "Use Anthropic (Claude) with my API key",
          "Run a local model with Ollama — no API key, pulled for me",
        ]);

    // Reset prior backend wiring so re-running cleanly switches backends.
    for (const k of ["SAI_MODEL_BACKEND", "SAI_OLLAMA_MODEL"]) delete env[k];

    if (backendChoice === 1) {
      // Anthropic (Claude) — best for constrained hardware: zero local VRAM.
      let key = NON_INTERACTIVE ? (process.env.SAI_SETUP_API_KEY ?? "") : await ask("Anthropic API key (sk-ant-…)");
      // Refuse to finish this backend with no key — re-prompt once, else fall back.
      if (!NON_INTERACTIVE && !key) {
        warn("This backend needs an Anthropic key (or connect Claude later via the dashboard's Local↔Claude switch).");
        key = (await ask("Paste your Anthropic API key, or leave blank to skip")).trim();
      }
      const model = NON_INTERACTIVE ? (process.env.SAI_SETUP_MODEL ?? "claude-sonnet-4-6")
        : await ask("Default Claude model id", "claude-sonnet-4-6");
      if (key) { env.ANTHROPIC_API_KEY = key; ok("Anthropic key saved."); }
      else warn("No key entered — set ANTHROPIC_API_KEY in .env (or use the dashboard switch) before delegating.");
      env.SAI_DEFAULT_MODEL = `anthropic/${model}`;
      env.SAI_MODEL_BACKEND = "anthropic";
      ok(`Model backend: Anthropic (${env.SAI_DEFAULT_MODEL})`);
    } else if (backendChoice === 2) {
      // Local Ollama (overlay-managed). Provider stays "lmstudio" pointing at
      // Ollama's OpenAI-compatible endpoint; the served id is the pulled tag.
      // A small Qwen at Q4 runs on modest hardware (Ollama pulls Q4 by default).
      const tag = NON_INTERACTIVE ? (process.env.SAI_SETUP_MODEL ?? "qwen2.5:7b")
        : await ask("Ollama model tag to pull (smaller = lighter on RAM/VRAM; Q4 by default)", "qwen2.5:7b");
      env.SAI_MODEL_BACKEND = "ollama";
      env.SAI_OLLAMA_MODEL = tag;
      env.SAI_LMSTUDIO_URL = "http://ollama:11434/v1";
      env.SAI_LMSTUDIO_API_KEY = "ollama";
      env.SAI_DEFAULT_MODEL = `lmstudio/${tag}`;
      ok(`Model backend: local Ollama (${tag}) — the launcher adds docker-compose.ollama.yml`);
    } else {
      // OpenAI-compatible (LM Studio / vLLM / llama.cpp / OpenAI).
      // host.docker.internal reaches a server on the host from the gateway container.
      const url = NON_INTERACTIVE ? (process.env.SAI_SETUP_URL ?? "http://host.docker.internal:1234/v1")
        : await ask("OpenAI-compatible base URL", "http://host.docker.internal:1234/v1");
      const key = NON_INTERACTIVE ? (process.env.SAI_SETUP_API_KEY ?? "lm-studio")
        : await ask("API key (any value if your server ignores it)", "lm-studio");

      // Probe the endpoint and offer the LOADED models so the user picks a real
      // id — your Qwen3 (3.5 / 3.6) models show up here automatically. Q4 quant
      // is recommended for a good size/VRAM balance.
      let model = NON_INTERACTIVE ? (process.env.SAI_SETUP_MODEL ?? "qwen/qwen3.6-35b-a3b") : "";
      if (!NON_INTERACTIVE) {
        info(`Checking ${url} …`);
        const probe = await probeOpenAi(url, key);
        if (probe.reachable && probe.models.length) {
          ok(`Reachable — ${probe.models.length} model(s) loaded.`);
          const idx = await choose("Which loaded model should the swarm use?", [...probe.models, "Type a different id…"], 0);
          model = idx < probe.models.length ? probe.models[idx] : (await ask("Model id", probe.models[0])).trim();
        } else if (probe.reachable) {
          warn("Reachable, but no model is loaded — load a Qwen3 model (3.5 or 3.6, Q4 quant) in your server.");
          model = await ask("Default model id to use once loaded", "qwen/qwen3.6-35b-a3b");
        } else {
          warn(`Not reachable at ${url} yet — start your model server and load a Qwen3 model (3.5/3.6, Q4). The stack connects once it's up.`);
          model = await ask("Default model id to use", "qwen/qwen3.6-35b-a3b");
        }
      }
      env.SAI_LMSTUDIO_URL = url;
      env.SAI_LMSTUDIO_API_KEY = key || "lm-studio";
      env.SAI_DEFAULT_MODEL = `lmstudio/${model}`;
      env.SAI_MODEL_BACKEND = "openai-compatible";
      ok(`Model backend: ${url} (${env.SAI_DEFAULT_MODEL})`);
    }

    // ── 3. optional chat channel ─────────────────────────────────────────────
    if (!NON_INTERACTIVE) {
      const wantTg = (await ask("Wire a Telegram bot now? Paste a bot token, or leave blank to skip")).trim();
      if (wantTg) { env.TELEGRAM_BOT_TOKEN = wantTg; ok("Telegram channel wired."); }
      else info("No chat channel wired — you can add Telegram/Slack/Discord later in the dashboard.");
    }

    writeEnv(env);
    ok(`Wrote ${ENV_FILE}`);

    // ── 4. bootstrap starlingai.json (gateway parses JSON5) ──────────────────
    if (existsSync(CONFIG_FILE)) {
      info("starlingai.json already present — leaving it untouched.");
    } else if (existsSync(EXAMPLE_CONFIG)) {
      copyFileSync(EXAMPLE_CONFIG, CONFIG_FILE);
      ok("Bootstrapped starlingai.json from the shipped example.");
    } else {
      warn("starlingai.example.json not found — run `node scripts/config-layout.mjs build` to generate starlingai.json.");
    }

    // ── 5. dashboard login token (auto sign-in) ──────────────────────────────
    const token = mintToken(env.SAI_JWT_SECRET);
    mkdirSync(TOKEN_DIR, { recursive: true });
    writeFileSync(TOKEN_FILE, token + "\n", { mode: 0o600 });
    ok("Minted a 30-day dashboard login token.");

    // ── done ──────────────────────────────────────────────────────────────
    log(`\n${BOLD}Setup complete.${RESET}`);
    log(`${DIM}The launcher now builds the images and starts the stack with Docker.${RESET}`);
    log(`Dashboard: ${CYAN}http://localhost:3001/?token=${token}${RESET}\n`);
  } finally {
    rl?.close();
  }
}

main().catch((err) => {
  console.error(`\n${YELLOW}Setup failed:${RESET} ${err?.stack ?? err}`);
  process.exit(1);
});
