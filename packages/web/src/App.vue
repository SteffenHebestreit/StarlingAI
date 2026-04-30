<template>
  <div class="min-h-screen bg-gray-950 text-gray-100 flex flex-col">

    <!-- Background orbs -->
    <div class="bg-orb bg-orb-1" aria-hidden="true" />
    <div class="bg-orb bg-orb-2" aria-hidden="true" />

    <!-- Header -->
    <header class="relative z-10 shrink-0 border-b border-purple-500/20 bg-gray-900/80 px-3 py-3 backdrop-blur-lg sm:px-5">

      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">

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
            v{{ appVersion }}
          </span>
        </div>

        <div class="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2 sm:gap-4">
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
               operator setups using the bootstrap admin token render no pill.
               A small role badge reminds viewers they have read-only access. -->
          <div
            v-if="currentUser && currentUser.username !== 'admin'"
            class="hidden sm:flex items-center gap-2 text-xs text-gray-300 shrink-0"
            :title="currentUser.role === 'operator' ? 'Operator account — full access' : 'Viewer account — read-only'"
          >
            <span class="rounded-full bg-purple-900/40 border border-purple-500/30 px-2.5 py-0.5">
              {{ currentUser.displayName ?? currentUser.username }}
            </span>
            <span
              v-if="currentUser.role === 'viewer'"
              class="rounded-full bg-amber-900/40 border border-amber-500/30 px-2 py-0.5 text-[10px] uppercase tracking-wider text-amber-200"
            >
              Viewer
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
          <!-- Nav: keep a single desktop row, but let it wrap below the
               metadata cluster on small screens so every control stays
               reachable without collapsing into a hamburger menu. -->
          <nav
            class="app-nav order-last flex min-w-0 basis-full items-center justify-end gap-1 overflow-x-auto scroll-smooth pt-1 -mr-3 pr-3 sm:order-none sm:basis-auto sm:flex-1 sm:pt-0 sm:mr-0 sm:pr-0"
            aria-label="Main navigation"
          >
            <template v-for="entry in navEntries" :key="entry.kind === 'leaf' ? entry.to : entry.label">
              <RouterLink
                v-if="entry.kind === 'leaf'"
                :to="entry.to"
                class="inline-flex shrink-0 items-center rounded-full border px-3 py-2 text-sm font-medium transition-colors"
                :class="$route.path === entry.to
                  ? 'border-purple-400/40 bg-purple-500/12 text-purple-100 shadow-[0_12px_30px_rgba(91,33,182,0.22)]'
                  : 'border-transparent text-gray-400 hover:border-white/10 hover:bg-white/5 hover:text-gray-100'"
                :aria-current="$route.path === entry.to ? 'page' : undefined"
              >
                {{ entry.label }}
              </RouterLink>
              <NavGroup
                v-else
                :label="entry.label"
                :items="entry.items"
              />
            </template>
          </nav>
        </div>
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
import { computed, onMounted, watch } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import { useGatewayStore } from "@/stores/gateway";
import { useAuthStore } from "@/stores/auth";
import { useNotificationStore, type NotificationLevel } from "@/stores/notifications";
import LoginModal from "@/components/LoginModal.vue";
import NavGroup, { type NavGroupItem } from "@/components/NavGroup.vue";
import { appVersion } from "@/appVersion";

const gateway = useGatewayStore();
const auth = useAuthStore();
const notifications = useNotificationStore();
const $route = useRoute();

const currentUser = computed(() => auth.currentUser);
const signOut = auth.signOut;

/**
 * The top-level nav is small (5 entries) and either renders as a single
 * RouterLink leaf or a popover NavGroup with sub-items.  Operator-only
 * groups disappear entirely for viewers; mixed groups (some items
 * operator-only) filter their children.
 */
interface NavLeaf {
  kind: "leaf";
  to: string;
  label: string;
  operatorOnly?: boolean;
}
interface NavGroupDef {
  kind: "group";
  label: string;
  items: (NavGroupItem & { operatorOnly?: boolean })[];
  operatorOnly?: boolean;
}
type NavEntry = NavLeaf | NavGroupDef;

const allNavEntries: NavEntry[] = [
  { kind: "leaf", to: "/", label: "Chat" },
  {
    kind: "group",
    label: "Live",
    items: [
      { to: "/jobs", label: "Jobs", hint: "Scenes & runs" },
      { to: "/swarm", label: "Swarm", hint: "Active delegations" },
      { to: "/federation", label: "Federation", hint: "Peer activity" },
    ],
  },
  {
    kind: "group",
    label: "Logs",
    items: [
      { to: "/sessions", label: "Sessions", hint: "Chat history" },
      { to: "/audit", label: "Audit", hint: "Event log" },
    ],
  },
  { kind: "leaf", to: "/memory", label: "Memory" },
  {
    kind: "group",
    label: "Manage",
    operatorOnly: true,
    items: [
      { to: "/agents", label: "Agents", hint: "Sub-agent definitions" },
      { to: "/plugins", label: "Plugins", hint: "Third-party tools", operatorOnly: true },
      { to: "/mcp", label: "MCP", hint: "External servers + publish self", operatorOnly: true },
      { to: "/a2a", label: "A2A", hint: "Agent-to-Agent peers", operatorOnly: true },
      { to: "/users", label: "Users", hint: "Accounts & roles", operatorOnly: true },
      { to: "/cost", label: "Cost", hint: "Token spend & budgets", operatorOnly: true },
      { to: "/settings", label: "Settings", hint: "Providers & config", operatorOnly: true },
    ],
  },
];

// Filter operator-only entries for viewers.  Unauthenticated users (no
// currentUser) see the full set so the legacy single-operator setup keeps
// working — the routes themselves still gate on auth via the gateway.
const navEntries = computed<NavEntry[]>(() => {
  if (!auth.isViewer) return allNavEntries;
  return allNavEntries
    .filter((entry) => !entry.operatorOnly)
    .map<NavEntry>((entry) => {
      if (entry.kind === "group") {
        const items = entry.items.filter((item) => !item.operatorOnly);
        return { ...entry, items };
      }
      return entry;
    })
    .filter((entry) => entry.kind === "leaf" || entry.items.length > 0);
});

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
  void auth.refreshCurrentUser();
});

// Re-fetch the current user whenever the connection state flips to
// connected (covers reconnects, token rotations from /api/auth/login).
watch(() => gateway.connected, (now) => {
  if (now) void auth.refreshCurrentUser();
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
