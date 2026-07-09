<template>
  <div class="app-shell overflow-hidden text-gray-100 flex flex-col">

    <!-- Background orbs -->
    <div class="bg-orb bg-orb-1" aria-hidden="true" />
    <div class="bg-orb bg-orb-2" aria-hidden="true" />

    <!-- Model-unreachable banner: the gateway can't reach the configured model
         endpoint (e.g. a local LM Studio / Ollama that isn't running yet), so turns
         would fail with an unexplained empty answer. Auto-clears once it's up. -->
    <div
      v-if="gateway.modelUnreachable"
      role="alert"
      class="relative z-20 shrink-0 border-b border-amber-500/40 bg-amber-500/15 px-4 py-2 text-center text-sm text-amber-100 backdrop-blur-lg"
    >
      No model endpoint reachable — the swarm can't answer until a provider is connected.
      Start your local model server (LM&nbsp;Studio / Ollama) or set a provider in
      <code class="font-mono">.env</code>; this clears automatically once it responds.
    </div>

    <!-- Header -->
    <header class="app-header relative z-10 shrink-0 px-3 py-3 backdrop-blur-lg sm:px-5">

      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">

        <!-- Logo + brand: always a way home to the chat interface -->
        <router-link to="/" class="flex items-center gap-2 sm:gap-3 min-w-0" title="Open chat">
          <img
            src="/swarmLogo.svg"
            alt="StarlingAI logo"
            class="h-9 w-9 shrink-0 object-contain drop-shadow-[0_8px_18px_rgba(34,211,238,0.22)]"
          />
          <div class="flex flex-col leading-none min-w-0">
            <span class="font-display font-semibold text-base bg-gradient-to-r from-cyan-300 via-sky-300 to-violet-300 bg-clip-text text-transparent tracking-wide">
              StarlingAI
            </span>
            <span class="hidden sm:inline font-label text-[10px] uppercase tracking-[0.18em] text-cyan-200/70 mt-1">
              Guarded Agent Swarm
            </span>
          </div>
        </router-link>

        <div class="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2 sm:gap-4">
          <!-- Connection status -->
          <div class="flex items-center gap-2 text-xs shrink-0">
            <div :class="[
              'w-1.5 h-1.5 rounded-full transition-colors',
              gateway.connected   ? 'bg-emerald-400 dot-pulse'
              : gateway.connecting ? 'bg-amber-400 animate-pulse'
              : 'bg-red-500'
            ]" />
            <span class="text-gray-400 hidden sm:inline">
              {{ gateway.connected ? 'Connected' : gateway.connecting ? 'Connecting…' : 'Disconnected' }}
            </span>
          </div>

          <!-- Burger: the main nav and header tools live behind this toggle so
               the default chrome is just brand + status + account. -->
          <button
            type="button"
            class="nav-burger hud-btn inline-flex h-9 w-9 shrink-0 items-center justify-center"
            :class="navOpen ? 'hud-btn--active' : ''"
            :aria-expanded="navOpen"
            aria-label="Toggle navigation"
            title="Navigation"
            @click="navOpen = !navOpen"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="h-[18px] w-[18px]">
              <path d="M4 7h16" /><path d="M4 12h16" /><path d="M4 17h16" />
            </svg>
          </button>

          <!-- Click-away catcher + nav panel (everything beyond brand/status/
               account lives here, summoned by the burger). Teleported to
               <body> so it escapes the header's stacking context — otherwise
               the chat content paints over it. -->
          <Teleport to="body">
          <div v-if="navOpen" class="fixed inset-0 z-[225]" @click="navOpen = false" />
          <Transition name="hud-pop">
          <div v-if="navOpen" class="app-nav-panel">
            <div class="app-nav-panel__meta">
              <span>v{{ appVersion }}</span>
              <span>{{ gateway.connected ? 'Online' : 'Offline' }}</span>
            </div>

          <!-- Drill-down: the panel content is REPLACED by a group's items;
               the back row climbs up a level. Slide direction follows the
               navigation direction. -->
          <Transition :name="navLevel ? 'nav-fwd' : 'nav-back'" mode="out-in">
          <div v-if="!navLevel" key="root" class="app-nav-panel__level">

          <!-- Model switch: Local ⇄ presets (e.g. Claude via the Anthropic
               provider). Appears once the gateway reports at least one
               switchable preset; hidden for read-only viewers. The gear opens
               the Claude subscription connect/manage modal. -->
          <div
            v-if="modelPreset.available && !auth.isViewer"
            class="flex shrink-0 items-center gap-0.5 rounded-full border border-white/10 bg-white/5 p-0.5"
            role="group"
            aria-label="Model switch"
            :title="`Active model: ${modelPreset.activePrimary ?? modelPreset.defaultPrimary}`"
          >
            <button
              type="button"
              class="rounded-full border px-2.5 py-1 text-[11px] font-medium transition disabled:opacity-60"
              :class="modelPreset.active === null
                ? 'border-emerald-400/30 bg-emerald-500/15 text-emerald-200'
                : 'border-transparent text-gray-400 hover:text-gray-200'"
              :disabled="modelPreset.switching"
              :title="`Local default: ${modelPreset.defaultPrimary}`"
              @click="switchModelPreset(null)"
            >
              Local
            </button>
            <button
              v-for="preset in modelPreset.presets"
              :key="preset.name"
              type="button"
              class="rounded-full border px-2.5 py-1 text-[11px] font-medium transition disabled:opacity-60"
              :class="modelPreset.active === preset.name
                ? 'border-orange-400/35 bg-orange-500/15 text-orange-200'
                : 'border-transparent text-gray-400 hover:text-gray-200'"
              :disabled="modelPreset.switching"
              :title="preset.primary"
              @click="switchModelPreset(preset.name)"
            >
              {{ preset.label }}
            </button>
            <button
              type="button"
              class="ml-0.5 flex h-6 w-6 items-center justify-center rounded-full text-gray-500 transition hover:bg-white/5 hover:text-gray-300"
              title="Claude settings — model & subscription"
              aria-label="Claude settings"
              @click="showModelConnect = true"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-3.5 w-3.5">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
          </div>

          <!-- No Claude connected yet → entry point to the browser login. -->
          <button
            v-if="!modelPreset.oauthConnected && !auth.isViewer && gateway.connected"
            type="button"
            class="hidden shrink-0 items-center gap-1.5 rounded-full border border-orange-400/25 bg-orange-500/10 px-3 py-1 text-[11px] font-medium text-orange-200 transition hover:border-orange-300/45 hover:bg-orange-500/15 sm:inline-flex"
            @click="showModelConnect = true"
          >
            Connect Claude
          </button>

          <button
            v-if="notifications.supported && notifications.permission === 'default'"
            class="hidden sm:inline-flex items-center rounded-full border border-cyan-400/25 bg-cyan-500/10 px-3 py-1 text-[11px] font-medium text-cyan-200 transition hover:border-cyan-300/45 hover:bg-cyan-500/15"
            @click="enableBrowserNotifications"
          >
            Enable Notifications
          </button>

          <!-- Top-level nav: leaf routes navigate, groups drill down. -->
          <nav class="app-nav flex flex-col items-stretch gap-1" aria-label="Main navigation">
            <template v-for="entry in navEntries" :key="entry.kind === 'leaf' ? entry.to : entry.label">
              <RouterLink
                v-if="entry.kind === 'leaf'"
                :to="entry.to"
                class="inline-flex items-center rounded-full border px-3 py-2 text-sm font-medium transition-colors"
                :class="$route.path === entry.to
                  ? 'border-purple-400/40 bg-purple-500/12 text-purple-100 shadow-[0_12px_30px_rgba(91,33,182,0.22)]'
                  : 'border-transparent text-gray-300 hover:border-white/10 hover:bg-white/5 hover:text-white'"
                :aria-current="$route.path === entry.to ? 'page' : undefined"
              >
                {{ entry.label }}
              </RouterLink>
              <button
                v-else
                type="button"
                class="nav-group__trigger inline-flex items-center rounded-full border border-transparent px-3 py-2 text-sm font-medium transition-colors hover:border-white/10 hover:bg-white/5"
                @click="navLevel = entry.label"
              >
                <span>{{ entry.label }}</span>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-3.5 w-3.5" aria-hidden="true">
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </button>
            </template>
          </nav>

          </div>

          <!-- Sub-level: the group's items replace the panel content. -->
          <div v-else key="sub" class="app-nav-panel__level">
            <button type="button" class="app-nav-panel__back" @click="navLevel = null">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4" aria-hidden="true">
                <path d="M15 18l-6-6 6-6" />
              </svg>
              <span>{{ navLevel }}</span>
            </button>
            <nav class="app-nav-panel__sublist" aria-label="Section navigation">
              <RouterLink
                v-for="item in activeGroupItems"
                :key="item.to"
                :to="item.to"
                class="app-nav-panel__subitem"
                :class="$route.path === item.to ? 'app-nav-panel__subitem--active' : ''"
              >
                <span>{{ item.label }}</span>
                <span v-if="item.hint" class="app-nav-panel__subitem-hint">{{ item.hint }}</span>
              </RouterLink>
            </nav>
          </div>
          </Transition>

          </div>
          </Transition>
          </Teleport>

          <!-- Account: far-right icon that opens a small menu — username + sign
               out when signed in, or a sign-in entry point in token mode. -->
          <div class="relative shrink-0">
            <button
              ref="accountBtnRef"
              type="button"
              class="hud-btn inline-flex h-9 w-9 items-center justify-center"
              :class="signedInUser ? 'hud-btn--active' : ''"
              :title="signedInUser ? (currentUser?.displayName ?? currentUser?.username) : 'Sign in'"
              :aria-label="signedInUser ? 'Account menu' : 'Sign in'"
              aria-haspopup="menu"
              :aria-expanded="accountMenuOpen"
              @click="toggleAccountMenu"
            >
              <svg v-if="signedInUser" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-[18px] w-[18px]">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 20c0-4 3.6-6 8-6s8 2 8 6" />
              </svg>
              <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-[18px] w-[18px]">
                <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
                <path d="M10 17l5-5-5-5" />
                <path d="M15 12H3" />
              </svg>
            </button>

            <!-- Teleported to <body> so it escapes the header's stacking
                 context (otherwise the page content paints over it). -->
            <Teleport to="body">
              <div v-if="accountMenuOpen" class="fixed inset-0 z-[60]" @click="accountMenuOpen = false" />

              <Transition name="hud-pop">
              <div
                v-if="accountMenuOpen"
                class="fixed z-[70] w-56 overflow-hidden rounded-xl border border-white/10 bg-gray-900/95 shadow-2xl shadow-black/40 backdrop-blur-xl"
                :style="accountMenuStyle"
                role="menu"
              >
              <div class="border-b border-white/10 px-3 py-2.5">
                <template v-if="signedInUser">
                  <div class="truncate text-sm font-medium text-gray-100">{{ currentUser?.displayName ?? currentUser?.username }}</div>
                  <div
                    class="mt-0.5 text-[10px] uppercase tracking-wider"
                    :class="currentUser?.role === 'viewer' ? 'text-amber-300' : 'text-cyan-300/80'"
                  >
                    {{ currentUser?.role === 'viewer' ? 'Viewer · read-only' : 'Operator' }}
                  </div>
                </template>
                <template v-else>
                  <div class="text-sm font-medium text-gray-100">Not signed in</div>
                  <div class="mt-0.5 text-[10px] text-gray-500">Token / single-operator mode</div>
                </template>
              </div>
              <button
                type="button"
                role="menuitem"
                class="block w-full px-3 py-2 text-left text-sm text-gray-300 transition hover:bg-white/5 hover:text-white"
                @click="openAccountLogin"
              >
                {{ signedInUser ? 'Switch account' : 'Sign in' }}
              </button>
              <button
                v-if="signedInUser"
                type="button"
                role="menuitem"
                class="block w-full px-3 py-2 text-left text-sm text-red-300 transition hover:bg-red-500/10 hover:text-red-200"
                @click="signOutFromMenu"
              >
                Sign out
              </button>
              </div>
              </Transition>
            </Teleport>
          </div>
        </div>
      </div>
    </header>

    <!-- Login modal: auto-shown when disconnected/auth-failed, or opened on
         demand (e.g. token mode → sign in as a created user / switch account). -->
    <LoginModal
      v-if="showLogin || gateway.authFailed || (!gateway.connected && !gateway.connecting)"
      :dismissible="gateway.connected"
      @close="showLogin = false"
    />

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

    <!-- Router view. NOTE: no <Transition> here — several pages (Chat) are
         multi-root with position:fixed panels, which a transition transform
         would re-anchor mid-animation. Page-level motion lives in the pages. -->
    <main class="relative z-10 flex-1 min-h-0 overflow-hidden">
      <RouterView />
    </main>

    <!-- Claude subscription connect / manage (browser OAuth verification). -->
    <ModelConnectModal
      v-if="showModelConnect"
      @close="showModelConnect = false"
      @connected="onClaudeConnected"
    />

    <!-- Global operator requests: approvals + live-browser handoff, reachable
         from any page (e.g. for scenes/jobs started from the dropdown). -->
    <OperatorRequestsDock v-if="gateway.connected" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import { useGatewayStore } from "@/stores/gateway";
import { useAuthStore } from "@/stores/auth";
import { useModelPresetStore } from "@/stores/modelPreset";
import { useNotificationStore, type NotificationLevel } from "@/stores/notifications";
import LoginModal from "@/components/LoginModal.vue";
import ModelConnectModal from "@/components/ModelConnectModal.vue";
import { type NavGroupItem } from "@/components/NavGroup.vue";
import OperatorRequestsDock from "@/components/OperatorRequestsDock.vue";
import { appVersion } from "@/appVersion";

const gateway = useGatewayStore();
const auth = useAuthStore();
const notifications = useNotificationStore();
const modelPreset = useModelPresetStore();
const $route = useRoute();

// Header model switch (Local ⇄ Claude). The gateway persists the choice in the
// runtime overlay, so it survives restarts and applies to the whole swarm.
async function switchModelPreset(name: string | null): Promise<void> {
  if (modelPreset.active === name) return;
  await modelPreset.activate(name);
  if (modelPreset.error) {
    notifications.pushLocalNotification({
      title: "Model switch failed",
      message: modelPreset.error,
      level: "error",
      category: "models",
    });
    return;
  }
  notifications.pushLocalNotification({
    title: name ? `Switched to ${name}` : "Switched to local model",
    message: `All agents now use ${modelPreset.activePrimary ?? modelPreset.defaultPrimary}`,
    level: "success",
    category: "models",
  });
}

const currentUser = computed(() => auth.currentUser);
// A real per-user identity (multi-user auth). The bootstrap admin token and the
// legacy single-operator token have none, so the account menu shows a sign-in entry.
const signedInUser = computed(() => Boolean(currentUser.value && currentUser.value.username !== "admin"));
const signOut = auth.signOut;

// Manual login-modal trigger (token mode → sign in as a created user / switch account).
const showLogin = ref(false);

// Burger nav panel: the main nav + header tools are hidden by default and
// summoned here; navigating closes it. Groups drill down into a sub-level
// that replaces the panel content (navLevel = the open group's label).
const navOpen = ref(false);
const navLevel = ref<string | null>(null);
watch(() => $route.path, () => { navOpen.value = false; });
watch(navOpen, (open) => { if (open) navLevel.value = null; });

const activeGroupItems = computed<NavGroupItem[]>(() => {
  const entry = navEntries.value.find(
    (candidate) => candidate.kind === "group" && candidate.label === navLevel.value,
  );
  return entry && entry.kind === "group" ? entry.items : [];
});

// Claude subscription connect/manage modal (browser OAuth verification).
const showModelConnect = ref(false);
function onClaudeConnected(): void {
  notifications.pushLocalNotification({
    title: "Claude subscription connected",
    message: "Use the Local ⇄ Claude switch in the header to run the swarm on Claude.",
    level: "success",
    category: "models",
  });
}

// Far-right account menu (username + sign out, or sign in). The dropdown is
// teleported to <body> and positioned with fixed coords anchored to the button,
// so it escapes the header's stacking context (no z-index fighting with page content).
const accountMenuOpen = ref(false);
const accountBtnRef = ref<HTMLElement | null>(null);
const accountMenuStyle = ref<Record<string, string>>({});
function positionAccountMenu(): void {
  const el = accountBtnRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  accountMenuStyle.value = {
    position: "fixed",
    top: `${rect.bottom + 6}px`,
    right: `${Math.max(8, window.innerWidth - rect.right)}px`,
  };
}
function toggleAccountMenu(): void {
  accountMenuOpen.value = !accountMenuOpen.value;
  if (accountMenuOpen.value) void nextTick(positionAccountMenu);
}
function openAccountLogin(): void {
  accountMenuOpen.value = false;
  showLogin.value = true;
}
function signOutFromMenu(): void {
  accountMenuOpen.value = false;
  signOut();
}
// Close the menu on navigation so it never lingers over a new page.
watch(() => $route.path, () => { accountMenuOpen.value = false; });

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
  { kind: "leaf", to: "/skills", label: "Skills" },
  { kind: "leaf", to: "/documents", label: "Documents" },
  { kind: "leaf", to: "/knowledge", label: "Knowledge" },
  { kind: "leaf", to: "/catalog", label: "Agents" },
  {
    kind: "group",
    label: "Manage",
    operatorOnly: true,
    items: [
      { to: "/agents", label: "Agent tuning", hint: "Models & routing" },
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
  // OIDC/SSO return: the gateway hands our JWT back in the URL FRAGMENT (never the
  // query — fragments aren't logged or sent to the server). Consume it into the
  // token, then strip the hash so it doesn't linger in the address bar.
  const hash = window.location.hash.replace(/^#/, "");
  if (hash.includes("sai_token=") || hash.includes("sai_error=")) {
    const ssoToken = new URLSearchParams(hash).get("sai_token");
    if (ssoToken) gateway.token = ssoToken;
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  notifications.syncPermission();
  if (gateway.token) {
    gateway.connect();
    void modelPreset.fetch();
    void modelPreset.fetchOAuthStatus();
  }
  void auth.refreshCurrentUser();
  // Keep the teleported account menu anchored to its button on resize.
  window.addEventListener("resize", () => {
    if (accountMenuOpen.value) positionAccountMenu();
  });
});

// Re-fetch the current user whenever the connection state flips to
// connected (covers reconnects, token rotations from /api/auth/login).
watch(() => gateway.connected, (now) => {
  if (now) {
    showLogin.value = false; // a successful (re)connect closes a manually-opened modal
    void auth.refreshCurrentUser();
    void modelPreset.fetch();
    void modelPreset.fetchOAuthStatus();
  }
});
</script>

<style>
/* The app shell owns the viewport height so child pages size themselves with
   height:100% / h-full instead of fragile `calc(100vh - <header px>)` math that
   broke whenever the real header height differed or the nav wrapped. 100dvh
   tracks the visible area on mobile (URL bar show/hide); 100vh is the fallback
   for browsers without dvh. Combined with `<main class="flex-1 min-h-0">`, the
   content area is always exactly viewport minus header — no overflow. */
.app-shell {
  height: 100vh;
  height: 100dvh;
}

/* Themed header surface: translucent panel tinted toward the active accent,
   hairline accent border, and a faint top sheen so it reads as a raised bar
   over the canvas rather than a flat gray strip. Repaints with the palette. */
.app-header {
  background:
    linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0)) ,
    rgba(var(--app-bg), 0.72);
  border-bottom: 1px solid var(--hairline);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.03), 0 8px 24px rgba(0, 0, 0, 0.28);
}

/* Burger nav panel: header tools + main nav, summoned on demand.
   Fixed + teleported to <body> so it always paints above page content. */
.app-nav-panel {
  position: fixed;
  right: 0.75rem;
  top: 4.4rem;
  /* above the floating HUD pods (z 220) — the summoned menu always wins */
  z-index: 230;
  width: min(22rem, calc(100vw - 1.5rem));
  max-height: calc(100vh - 5.5rem);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.9rem;
  border-radius: 0.6rem;
  border: 1px solid var(--hairline);
  background: rgba(var(--app-bg), 0.92);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
}
.app-nav-panel__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-family: var(--font-label);
  font-size: 0.62rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  color: rgba(165, 243, 252, 0.55);
  padding-bottom: 0.5rem;
  border-bottom: 1px solid var(--hairline);
}

/* Drill-down levels: forward slides in from the right, back from the left. */
.app-nav-panel__level {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.nav-fwd-enter-active, .nav-fwd-leave-active,
.nav-back-enter-active, .nav-back-leave-active {
  transition: opacity 180ms var(--ease-out), transform 220ms var(--ease-out);
}
.nav-fwd-enter-from  { opacity: 0; transform: translateX(28px); }
.nav-fwd-leave-to    { opacity: 0; transform: translateX(-28px); }
.nav-back-enter-from { opacity: 0; transform: translateX(-28px); }
.nav-back-leave-to   { opacity: 0; transform: translateX(28px); }

.app-nav-panel__back {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: 100%;
  font-family: var(--font-label);
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.13em;
  color: rgb(var(--logo-cyan));
  padding: 0.55rem 0.7rem;
  border-radius: 0.25rem;
  background: rgba(var(--accent-purple), 0.08);
  border: 1px solid rgba(var(--accent-purple), 0.25);
  cursor: pointer;
  transition: background 180ms var(--ease-out);
}
.app-nav-panel__back:hover { background: rgba(var(--accent-purple), 0.16); }

.app-nav-panel__sublist {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}
.app-nav-panel__subitem {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.55rem 0.7rem;
  border-radius: 8px;
  font-size: 0.85rem;
  color: rgb(203 213 225);
  text-decoration: none;
  transition: background-color 120ms ease, color 120ms ease;
}
.app-nav-panel__subitem:hover {
  background: rgba(var(--accent-purple), 0.16);
  color: rgb(241 245 249);
}
.app-nav-panel__subitem--active {
  background: linear-gradient(90deg, rgba(var(--accent-purple), 0.22), rgba(var(--accent-pink), 0.16));
  color: rgb(var(--acc1-200));
}
.app-nav-panel__subitem-hint {
  font-size: 0.7rem;
  color: rgb(148 163 184);
}
.app-nav-panel .app-nav {
  flex-direction: column;
  align-items: stretch;
  justify-content: flex-start;
  overflow: visible;
  flex-basis: auto;
  margin: 0;
  padding: 0;
}
.app-nav-panel .app-nav a { justify-content: flex-start; width: 100%; }
.app-nav-panel .app-nav .nav-group__trigger { width: 100%; justify-content: space-between; }

/* Energy line: a slow accent current flowing along the header's lower edge —
   the one continuous "alive" cue of the chrome. background-position only. */
.app-header::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 1px;
  pointer-events: none;
  /* A narrow traveling glint on a faint base line — reads as a current
     passing through, not a constant stripe. */
  background:
    linear-gradient(90deg,
      transparent 40%,
      rgba(var(--accent-purple), 0.5) 46%,
      rgba(var(--logo-cyan), 0.9) 50%,
      rgba(var(--accent-pink), 0.5) 54%,
      transparent 60%) no-repeat,
    linear-gradient(90deg, transparent, rgba(var(--accent-purple), 0.16) 30%, rgba(var(--accent-purple), 0.16) 70%, transparent);
  background-size: 300% 100%, 100% 100%;
  animation: header-current 9s linear infinite;
  opacity: 0.9;
}
@keyframes header-current {
  from { background-position: -150% 0, 0 0; }
  to   { background-position: 250% 0, 0 0; }
}

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
