import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { useGatewayStore } from "@/stores/gateway";

export type AuthRole = "operator" | "viewer" | "admin";

export interface CurrentUser {
  username: string;
  role: AuthRole;
  displayName?: string;
}

/**
 * Auth store — owns the currently-signed-in user, role-derived flags, and
 * the sign-out flow.  Components branch on `isOperator` / `isViewer`
 * instead of duplicating role logic.  The current user is fetched lazily
 * via `refreshCurrentUser()` whenever the gateway connection flips to
 * connected (App.vue triggers this on mount + watch).
 */
export const useAuthStore = defineStore("auth", () => {
  const gateway = useGatewayStore();
  const currentUser = ref<CurrentUser | null>(null);
  const refreshing = ref(false);

  const isAuthenticated = computed(() => currentUser.value !== null);
  // Role gates mirror the gateway's rank hierarchy (admin 90 > operator 50 >
  // viewer 10, gateway/auth.ts): "operator" here means operator-or-higher, so
  // an admin session (e.g. the bootstrap token) never has FEWER UI rights than
  // an operator. Exact-matching "operator" would disable operator-only controls
  // for admins — that's how the bootstrap session got locked out of Users.
  const isOperator = computed(() => currentUser.value?.role === "operator" || currentUser.value?.role === "admin");
  const isViewer = computed(() => currentUser.value?.role === "viewer");

  function apiBase(): string {
    return gateway.wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
  }

  async function refreshCurrentUser(): Promise<void> {
    if (!gateway.token) {
      currentUser.value = null;
      return;
    }
    refreshing.value = true;
    try {
      const res = await fetch(`${apiBase()}/api/auth/me`, {
        headers: { Authorization: `Bearer ${gateway.token}` },
      });
      if (!res.ok) {
        currentUser.value = null;
        return;
      }
      currentUser.value = await res.json() as CurrentUser;
    } catch {
      currentUser.value = null;
    } finally {
      refreshing.value = false;
    }
  }

  function signOut(): void {
    gateway.disconnect();
    gateway.token = "";
    currentUser.value = null;
    try { localStorage.removeItem("gc_token"); } catch { /* non-fatal */ }
  }

  return {
    currentUser,
    refreshing,
    isAuthenticated,
    isOperator,
    isViewer,
    refreshCurrentUser,
    signOut,
  };
});
