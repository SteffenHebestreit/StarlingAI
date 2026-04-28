<template>
  <div class="min-h-screen bg-gray-950 text-gray-100 flex flex-col">

    <!-- Background orbs -->
    <div class="bg-orb bg-orb-1" aria-hidden="true" />
    <div class="bg-orb bg-orb-2" aria-hidden="true" />

    <!-- Header -->
    <header class="relative z-10 bg-gray-900/80 backdrop-blur-lg border-b border-purple-500/20 px-3 sm:px-5 flex items-center justify-between gap-3 h-14 shrink-0">

      <!-- Logo + brand -->
      <div class="flex items-center gap-2 sm:gap-3 min-w-0">
        <img
          src="/swarmLogo.svg"
          alt="StarlingAI logo"
          class="h-9 w-9 shrink-0 object-contain drop-shadow-[0_8px_18px_rgba(34,211,238,0.22)]"
        />
        <div class="flex flex-col leading-none min-w-0">
          <span class="font-semibold text-sm bg-gradient-to-r from-cyan-300 via-sky-300 to-violet-300 bg-clip-text text-transparent tracking-wide">
            StarlingAI
          </span>
          <span class="hidden sm:inline text-[10px] uppercase tracking-[0.18em] text-cyan-200/70 mt-1">
            Guarded Agent Swarm
          </span>
        </div>
        <span class="hidden md:inline text-xs bg-purple-900/40 text-purple-400 border border-purple-700/30 px-2 py-0.5 rounded-full font-medium">
          v0.6.4
        </span>
      </div>

      <div class="flex items-center gap-2 sm:gap-5 min-w-0 flex-1 justify-end">
        <!-- Connection status -->
        <div class="flex items-center gap-2 text-xs shrink-0">
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

        <!-- Current user pill: visible only when an authenticated identity is
             attached to the JWT (i.e. multi-user auth is enabled).  Single-
             operator setups using the bootstrap admin token render no pill. -->
        <div
          v-if="currentUser && currentUser.username !== 'admin'"
          class="hidden sm:flex items-center gap-2 text-xs text-gray-300 shrink-0"
          :title="currentUser.role === 'operator' ? 'Operator account' : currentUser.role"
        >
          <span class="rounded-full bg-purple-900/40 border border-purple-500/30 px-2.5 py-0.5">
            {{ currentUser.displayName ?? currentUser.username }}
          </span>
          <button
            type="button"
            class="text-gray-400 hover:text-gray-200 transition"
            title="Sign out"
            @click="signOut"
          >
            ↪
          </button>
        </div>

        <button
          v-if="notifications.supported && notifications.permission === 'default'"
          class="hidden sm:inline-flex items-center rounded-full border border-cyan-400/25 bg-cyan-500/10 px-3 py-1 text-[11px] font-medium text-cyan-200 transition hover:border-cyan-300/45 hover:bg-cyan-500/15"
          @click="enableBrowserNotifications"
        >
          Enable Notifications
        </button>

        <!-- Nav: scrolls horizontally on small screens so all routes stay reachable
             without a hamburger menu, while keeping fast direct access on desktop. -->
        <nav
          class="app-nav flex overflow-x-auto scroll-smooth -mr-3 sm:mr-0 pr-3 sm:pr-0 max-w-full"
          aria-label="Main navigation"
        >
          <RouterLink
            v-for="link in navLinks"
            :key="link.to"
            :to="link.to"
            class="relative px-2.5 sm:px-3 py-[18px] text-sm font-medium transition-colors shrink-0"
            :class="$route.path === link.to ? 'text-purple-300' : 'text-gray-400 hover:text-gray-200'"
            :aria-current="$route.path === link.to ? 'page' : undefined"
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

    <TransitionGroup
      name="toast"
      tag="div"
      class="pointer-events-none fixed right-4 top-[4.5rem] z-50 flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-3"
    >
      <section
        v-for="item in notifications.items"
        :key="item.id"
        class="pointer-events-auto overflow-hidden rounded-2xl border bg-gray-950/92 shadow-[0_18px_50px_rgba(0,0,0,0.45)] backdrop-blur-xl"
        :class="notificationCardClass(item.level)"
        role="status"
        aria-live="polite"
      >
        <div class="flex items-start gap-3 px-4 py-3.5">
          <div class="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full" :class="notificationDotClass(item.level)" />
          <div class="min-w-0 flex-1">
            <div class="flex items-start justify-between gap-3">
              <div>
                <div class="text-sm font-semibold text-gray-50">{{ item.title }}</div>
                <div v-if="item.category" class="mt-0.5 text-[10px] uppercase tracking-[0.18em] text-gray-500">{{ item.category }}</div>
              </div>
              <button
                class="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-gray-400 transition hover:border-white/20 hover:text-gray-200"
                @click="notifications.dismiss(item.id)"
              >
                Dismiss
              </button>
            </div>
            <p class="mt-2 text-sm leading-5 text-gray-300">{{ item.message }}</p>
            <div class="mt-3 flex items-center justify-between gap-3 text-[11px] text-gray-500">
              <span>{{ formatNotificationTime(item.createdAt) }}</span>
              <RouterLink
                v-if="item.targetPath"
                :to="item.targetPath"
                class="rounded-full border border-white/10 px-2.5 py-1 text-gray-300 transition hover:border-white/20 hover:text-white"
              >
                Open
              </RouterLink>
            </div>
          </div>
        </div>
      </section>
    </TransitionGroup>

    <!-- Router view -->
    <main class="relative z-10 flex-1 overflow-hidden">
      <RouterView />
    </main>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import { useGatewayStore } from "@/stores/gateway";
import { useNotificationStore, type NotificationLevel } from "@/stores/notifications";
import LoginModal from "@/components/LoginModal.vue";

const gateway = useGatewayStore();
const notifications = useNotificationStore();
const $route = useRoute();

interface CurrentUser { username: string; role: string; displayName?: string }
const currentUser = ref<CurrentUser | null>(null);

function apiBaseFromWsUrl(value: string): string {
  return value.replace(/^ws/, "http").replace(/\/ws$/, "");
}

async function refreshCurrentUser(): Promise<void> {
  if (!gateway.token) {
    currentUser.value = null;
    return;
  }
  try {
    const res = await fetch(`${apiBaseFromWsUrl(gateway.wsUrl)}/api/auth/me`, {
      headers: { Authorization: `Bearer ${gateway.token}` },
    });
    if (!res.ok) {
      currentUser.value = null;
      return;
    }
    currentUser.value = await res.json() as CurrentUser;
  } catch {
    currentUser.value = null;
  }
}

function signOut(): void {
  gateway.disconnect();
  gateway.token = "";
  currentUser.value = null;
  // Drop persisted credentials so the LoginModal reappears clean.
  try { localStorage.removeItem("gc_token"); } catch { /* non-fatal */ }
}

const navLinks = [
  { to: "/", label: "Chat" },
  { to: "/audit", label: "Audit" },
  { to: "/jobs", label: "Jobs" },
  { to: "/sessions", label: "Sessions" },
  { to: "/agents", label: "Agents" },
  { to: "/swarm", label: "Swarm" },
  { to: "/memory", label: "Memory" },
  { to: "/federation", label: "Federation" },
  { to: "/settings", label: "Settings" },
];

function notificationCardClass(level: NotificationLevel): string {
  switch (level) {
    case "success":
      return "border-emerald-500/30";
    case "warn":
      return "border-amber-500/35";
    case "error":
      return "border-red-500/35";
    default:
      return "border-cyan-500/25";
  }
}

function notificationDotClass(level: NotificationLevel): string {
  switch (level) {
    case "success":
      return "bg-emerald-400 shadow-[0_0_14px_rgba(52,211,153,0.55)]";
    case "warn":
      return "bg-amber-400 shadow-[0_0_14px_rgba(251,191,36,0.55)]";
    case "error":
      return "bg-red-400 shadow-[0_0_14px_rgba(248,113,113,0.55)]";
    default:
      return "bg-cyan-400 shadow-[0_0_14px_rgba(34,211,238,0.55)]";
  }
}

function formatNotificationTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Just now";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function enableBrowserNotifications(): Promise<void> {
  await notifications.requestPermission();
}

onMounted(() => {
  notifications.syncPermission();
  if (gateway.token) gateway.connect();
  void refreshCurrentUser();
});

// Re-fetch the current user whenever the connection state flips to
// connected (covers reconnects, token rotations from /api/auth/login).
watch(() => gateway.connected, (now) => {
  if (now) void refreshCurrentUser();
});
</script>

<style>
.toast-enter-active,
.toast-leave-active,
.toast-move {
  transition: opacity 180ms ease, transform 180ms ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate3d(0, -10px, 0);
}

/* Hide the horizontal scrollbar on the mobile nav — overflow still works
   via touch / wheel, but we don't want a visible bar shrinking the row. */
.app-nav {
  scrollbar-width: none;
}
.app-nav::-webkit-scrollbar {
  display: none;
}
</style>
