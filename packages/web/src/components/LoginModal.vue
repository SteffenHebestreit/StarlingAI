<template>
  <div class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
       role="dialog" aria-modal="true" aria-labelledby="login-heading"
       @click.self="onBackdrop">
    <div class="glass-card modal-pop relative w-full max-w-sm p-8 shadow-2xl shadow-purple-500/10">

      <!-- Close (only when the modal was opened manually while connected) -->
      <button
        v-if="dismissible"
        type="button"
        class="absolute right-3 top-3 rounded-full border border-white/10 px-2 py-0.5 text-sm text-gray-400 transition hover:border-white/20 hover:text-gray-200"
        aria-label="Close login"
        @click="close"
      >
        ✕
      </button>

      <!-- Header -->
      <div class="text-center mb-8">
        <img
          src="/swarmLogo.svg"
          alt="StarlingAI logo"
          class="h-20 w-20 mx-auto mb-4 object-contain drop-shadow-[0_14px_34px_rgba(34,211,238,0.2)]"
        />
        <h1 id="login-heading" class="text-xl font-semibold bg-gradient-to-r from-cyan-300 via-sky-300 to-violet-300 bg-clip-text text-transparent mb-1">
          StarlingAI
        </h1>
        <p class="text-xs uppercase tracking-[0.18em] text-cyan-200/70 mb-3">- Guarded Agent Swarm -</p>
        <p class="text-sm text-gray-500">{{ tabHint }}</p>
      </div>

      <div class="flex gap-2 mb-5 text-xs">
        <button
          type="button"
          :class="['flex-1 py-1.5 rounded-lg border transition', mode === 'password' ? 'border-purple-400/50 bg-purple-500/10 text-purple-100' : 'border-white/10 text-gray-400 hover:text-gray-200']"
          @click="setMode('password')"
        >
          Username
        </button>
        <button
          type="button"
          :class="['flex-1 py-1.5 rounded-lg border transition', mode === 'token' ? 'border-purple-400/50 bg-purple-500/10 text-purple-100' : 'border-white/10 text-gray-400 hover:text-gray-200']"
          @click="setMode('token')"
        >
          Token
        </button>
      </div>

      <form @submit.prevent="submit" class="space-y-6">
        <div>
          <label class="block text-xs font-medium text-gray-400 mb-2 uppercase tracking-wider">Gateway URL</label>
          <input
            v-model="wsUrl"
            type="text"
            class="input-line"
            :placeholder="defaultWsUrl"
          />
          <p class="mt-2 text-xs text-gray-500">Leave the default to use the current page origin via <code class="font-mono">/ws</code>.</p>
        </div>

        <template v-if="mode === 'password'">
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-2 uppercase tracking-wider">Username</label>
            <input
              v-model="usernameInput"
              type="text"
              class="input-line"
              autocomplete="username"
              autocapitalize="off"
              spellcheck="false"
              required
            />
          </div>
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-2 uppercase tracking-wider">Password</label>
            <input
              v-model="passwordInput"
              type="password"
              class="input-line"
              autocomplete="current-password"
              required
            />
          </div>
        </template>

        <template v-else>
          <div>
            <label class="block text-xs font-medium text-gray-400 mb-2 uppercase tracking-wider">Token</label>
            <input
              v-model="tokenInput"
              type="password"
              class="input-line"
              placeholder="Your gateway JWT token"
              autocomplete="current-password"
              required
            />
          </div>
        </template>

        <p v-if="errorMessage" class="text-xs text-red-300 -mt-2">
          {{ errorMessage }}
        </p>

        <button
          type="submit"
          class="btn-grad w-full py-2.5 rounded-xl text-sm mt-2 disabled:opacity-60"
          :disabled="submitting"
        >
          {{ submitting ? "Connecting…" : "Connect" }}
        </button>
      </form>

      <p v-if="mode === 'token'" class="text-xs text-gray-600 text-center mt-6">
        Token location: <code class="text-gray-500 font-mono">~/.starlingai/token</code>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { defaultGatewayWsUrl, useGatewayStore } from "@/stores/gateway";

const props = withDefaults(defineProps<{ dismissible?: boolean }>(), { dismissible: false });
const emit = defineEmits<{ (event: "close"): void }>();

const gateway = useGatewayStore();

function close(): void {
  emit("close");
}

function onBackdrop(): void {
  if (props.dismissible) close();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && props.dismissible) close();
}

type Mode = "password" | "token";
// Default to the token tab — the single-operator (auth-disabled) setup has no
// accounts, so username/password login would only 503. detectAuthMode() flips to
// the password tab when the gateway reports multi-user auth is on.
const mode = ref<Mode>("token");

async function detectAuthMode(): Promise<void> {
  try {
    const apiBase = apiBaseFromWsUrl(wsUrl.value);
    const res = await fetch(`${apiBase}/api/auth/mode`, { method: "GET" });
    if (!res.ok) return;
    const body = await res.json() as { authEnabled?: boolean };
    mode.value = body.authEnabled ? "password" : "token";
  } catch {
    // Gateway unreachable — keep the token default; surfaced clearly on submit.
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  void detectAuthMode();
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));

const usernameInput = ref("");
const passwordInput = ref("");
const tokenInput = ref(gateway.authFailed ? "" : gateway.token);
const wsUrl = ref(gateway.wsUrl);
const defaultWsUrl = defaultGatewayWsUrl();
const errorMessage = ref<string | null>(null);
const submitting = ref(false);

const tabHint = computed(() =>
  mode.value === "password"
    ? "Sign in with your StarlingAI account"
    : "Paste a gateway token (legacy / single-operator setup)",
);

function setMode(next: Mode): void {
  mode.value = next;
  errorMessage.value = null;
}

function apiBaseFromWsUrl(value: string): string {
  return value.replace(/^ws/, "http").replace(/\/ws$/, "");
}

async function submit(): Promise<void> {
  errorMessage.value = null;
  submitting.value = true;
  try {
    if (mode.value === "password") {
      const apiBase = apiBaseFromWsUrl(wsUrl.value);
      const res = await fetch(`${apiBase}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: usernameInput.value, password: passwordInput.value }),
      });
      if (!res.ok) {
        let message = `Login failed (${res.status})`;
        try {
          const body = await res.json() as { error?: string };
          if (body.error) message = body.error;
        } catch { /* ignore */ }
        errorMessage.value = message;
        return;
      }
      const body = await res.json() as { token: string };
      gateway.disconnect();
      gateway.token = body.token;
      gateway.wsUrl = wsUrl.value;
      gateway.connect();
    } else {
      gateway.disconnect();
      gateway.token = tokenInput.value;
      gateway.wsUrl = wsUrl.value;
      gateway.connect();
    }
  } catch (err) {
    // A thrown fetch (or JSON parse) means we never reached the gateway — the most
    // common first-run cause. Without this the error was swallowed and the form
    // just silently stopped, giving the user no idea the gateway was unreachable.
    errorMessage.value = `Can't reach the gateway at ${apiBaseFromWsUrl(wsUrl.value)}. Is it running? (${err instanceof Error ? err.message : String(err)})`;
  } finally {
    submitting.value = false;
  }
}
</script>
