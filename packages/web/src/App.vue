<template>
  <div class="min-h-screen bg-gray-950 text-gray-100 flex flex-col">

    <!-- Background orbs -->
    <div class="bg-orb bg-orb-1" aria-hidden="true" />
    <div class="bg-orb bg-orb-2" aria-hidden="true" />

    <!-- Header -->
    <header class="relative z-10 bg-gray-900/80 backdrop-blur-lg border-b border-purple-500/20 px-5 flex items-center justify-between h-14 shrink-0">

      <!-- Logo + brand -->
      <div class="flex items-center gap-3">
        <img
          src="/swarmLogo.svg"
          alt="StarlingAI logo"
          class="h-9 w-9 shrink-0 object-contain drop-shadow-[0_8px_18px_rgba(34,211,238,0.22)]"
        />
        <div class="flex flex-col leading-none">
          <span class="font-semibold text-sm bg-gradient-to-r from-cyan-300 via-sky-300 to-violet-300 bg-clip-text text-transparent tracking-wide">
            StarlingAI
          </span>
          <span class="text-[10px] uppercase tracking-[0.18em] text-cyan-200/70 mt-1">
            Guarded Agent Swarm
          </span>
        </div>
        <span class="text-xs bg-purple-900/40 text-purple-400 border border-purple-700/30 px-2 py-0.5 rounded-full font-medium">
          v0.2.0
        </span>
      </div>

      <div class="flex items-center gap-5">
        <!-- Connection status -->
        <div class="flex items-center gap-2 text-xs">
          <div :class="[
            'w-1.5 h-1.5 rounded-full transition-colors',
            gateway.connected   ? 'bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]'
            : gateway.connecting ? 'bg-amber-400 animate-pulse'
            : 'bg-red-500'
          ]" />
          <span class="text-gray-400 hidden sm:inline">
            {{ gateway.connected ? 'Connected' : gateway.connecting ? 'Connecting…' : 'Disconnected' }}
          </span>
        </div>

        <!-- Nav -->
        <nav class="flex">
          <RouterLink
            v-for="link in navLinks"
            :key="link.to"
            :to="link.to"
            class="relative px-3 py-[18px] text-sm font-medium transition-colors"
            :class="$route.path === link.to ? 'text-purple-300' : 'text-gray-400 hover:text-gray-200'"
          >
            {{ link.label }}
            <span v-if="$route.path === link.to"
              class="absolute bottom-0 left-0 right-0 h-0.5 bg-gradient-to-r from-purple-500 to-pink-500 rounded-t" />
          </RouterLink>
        </nav>
      </div>
    </header>

    <!-- Login modal if not connected or auth failed -->
    <LoginModal v-if="gateway.authFailed || (!gateway.connected && !gateway.connecting)" />

    <!-- Router view -->
    <main class="relative z-10 flex-1 overflow-hidden">
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { onMounted } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import { useGatewayStore } from "@/stores/gateway";
import LoginModal from "@/components/LoginModal.vue";

const gateway = useGatewayStore();
const $route = useRoute();

const navLinks = [
  { to: "/", label: "Chat" },
  { to: "/audit", label: "Audit" },
  { to: "/jobs", label: "Jobs" },
  { to: "/sessions", label: "Sessions" },
  { to: "/settings", label: "Settings" },
];

onMounted(() => { if (gateway.token) gateway.connect(); });
</script>
