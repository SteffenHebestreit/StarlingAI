<template>
  <div class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4"
       role="dialog" aria-modal="true" aria-labelledby="login-heading">
    <div class="glass-card w-full max-w-sm p-8 shadow-2xl shadow-purple-500/10">

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
        <p class="text-sm text-gray-500">Enter your gateway token to connect</p>
      </div>

      <form @submit.prevent="connect" class="space-y-6">
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
        <button
          type="submit"
          class="btn-grad w-full py-2.5 rounded-xl text-sm mt-2"
        >
          Connect
        </button>
      </form>

      <p class="text-xs text-gray-600 text-center mt-6">
        Token location: <code class="text-gray-500 font-mono">~/.starlingai/token</code>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { defaultGatewayWsUrl, useGatewayStore } from "@/stores/gateway";

const gateway = useGatewayStore();
const tokenInput = ref(gateway.authFailed ? "" : gateway.token);
const wsUrl = ref(gateway.wsUrl);
const defaultWsUrl = defaultGatewayWsUrl();

function connect() {
  gateway.disconnect();          // tear down any lingering socket / reconnect timer
  gateway.token = tokenInput.value;
  gateway.wsUrl = wsUrl.value;
  gateway.connect();
}
</script>
