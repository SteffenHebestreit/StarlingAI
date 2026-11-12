<template>
  <div class="page-shell users-page">
    <header class="page-header">
      <div class="page-header__text">
        <h1 class="page-title">Users</h1>
        <p class="page-subtitle">
          Manage operator and viewer accounts.  Only an admin can add, reset or delete one.  Passwords are stored as bcrypt hashes — plaintext is never persisted.
        </p>
      </div>
      <div class="page-actions">
        <button type="button" class="btn-ghost px-4 py-2 rounded-xl text-sm" :disabled="loading" @click="loadUsers">
          {{ loading ? "Refreshing…" : "Refresh" }}
        </button>
        <button
          v-if="!accountsFromIdp"
          type="button"
          class="btn-grad px-4 py-2 rounded-xl text-sm"
          :disabled="!isAdmin"
          :title="isAdmin ? '' : 'Only admins can add users'"
          @click="openCreateForm"
        >
          + Add user
        </button>
      </div>
    </header>

    <div v-if="accountsFromIdp" class="users-disabled">
      <p>
        Accounts come from the identity provider (SSO), which owns the usernames: no local account
        can be added here.  Local accounts made before SSO are listed below.
      </p>
    </div>

    <div v-if="bootstrapHandoff" class="users-disabled">
      <p>
        Account <strong>{{ bootstrapHandoff }}</strong> was created.  The bootstrap admin session
        has ended now that a real account exists — sign in with the new account to continue.
      </p>
      <button type="button" class="btn-grad px-3 py-1.5 rounded-lg text-sm" @click="signInAsNewUser">
        Sign in
      </button>
    </div>

    <div v-else-if="!authEnabled" class="users-disabled">
      <p>
        Multi-user authentication is currently disabled — the gateway uses the bootstrap
        admin token for sign-in.  Adding the first account here automatically flips
        <code>auth.enabled</code> to <code>true</code>; from that point on, all sign-ins must use
        username + password.
      </p>
    </div>

    <p v-if="errorMessage && !bootstrapHandoff" class="users-page__error">{{ errorMessage }}</p>

    <!-- "No users" is only true after a load that worked; a failed one says why in the line above. -->
    <div v-if="loading && users.length === 0" class="users-page__empty">Loading…</div>

    <div v-else-if="loaded && users.length === 0" class="users-page__empty">
      <template v-if="accountsFromIdp">No local accounts.</template>
      <template v-else>No users configured yet.  Click <strong>Add user</strong> to create the first account.</template>
    </div>

    <ul v-else-if="users.length > 0" class="user-grid">
      <li v-for="user in users" :key="user.username" class="user-card">
        <div class="user-card__top">
          <div>
            <div class="user-card__title-row">
              <h3 class="user-card__title">{{ user.displayName ?? user.username }}</h3>
              <span :class="['user-card__role-pill', user.role === 'viewer' ? 'user-card__role-pill--viewer' : 'user-card__role-pill--operator']">
                {{ user.role }}
              </span>
              <span v-if="user.username === currentUsername" class="user-card__you-pill">you</span>
            </div>
            <code class="user-card__username">{{ user.username }}</code>
          </div>
          <div v-if="isAdmin" class="user-card__actions">
            <button type="button" class="btn-ghost px-3 py-1.5 rounded-lg text-sm whitespace-nowrap" @click="openResetForm(user)">
              Reset password
            </button>
            <button
              v-if="user.username !== currentUsername"
              type="button"
              class="btn-danger px-3 py-1.5 rounded-lg text-sm whitespace-nowrap"
              :disabled="deleting === user.username"
              @click="deleteUser(user)"
            >
              {{ deleting === user.username ? "…" : "Delete" }}
            </button>
          </div>
        </div>
        <p v-if="user.createdAt" class="user-card__meta">Created {{ formatTimestamp(user.createdAt) }}</p>
      </li>
    </ul>

    <div
      v-if="creating"
      class="users-create-modal"
      role="dialog"
      aria-modal="true"
      @click.self="dismissCreateForm"
    >
      <form class="users-create-card" @submit.prevent="submitCreate">
        <h3 class="users-create-card__title">Add user</h3>
        <label class="users-create-card__label">
          Username
          <input
            v-model="form.username"
            type="text"
            class="input-line"
            autocapitalize="off"
            spellcheck="false"
            required
          />
        </label>
        <label class="users-create-card__label">
          Password
          <input
            v-model="form.password"
            type="password"
            class="input-line"
            autocomplete="new-password"
            minlength="8"
            required
          />
          <span class="users-create-card__hint">≥ 8 characters.  Stored as a bcrypt hash.</span>
        </label>
        <label class="users-create-card__label">
          Display name <span class="users-create-card__optional">(optional)</span>
          <input v-model="form.displayName" type="text" class="input-line" />
        </label>
        <fieldset class="users-create-card__role">
          <legend>Role</legend>
          <label>
            <input v-model="form.role" type="radio" value="operator" /> Operator (full access)
          </label>
          <label>
            <input v-model="form.role" type="radio" value="viewer" /> Viewer (read-only)
          </label>
        </fieldset>
        <p v-if="formError" class="users-page__error">{{ formError }}</p>
        <div class="users-create-card__actions">
          <button type="button" class="btn-ghost px-4 py-2 rounded-xl text-sm" @click="closeCreateForm">Cancel</button>
          <button type="submit" class="btn-grad px-4 py-2 rounded-xl text-sm" :disabled="submitting">
            {{ submitting ? "Creating…" : "Create user" }}
          </button>
        </div>
      </form>
    </div>

    <div
      v-if="resetting"
      class="users-create-modal"
      role="dialog"
      aria-modal="true"
      @click.self="dismissResetForm"
    >
      <form class="users-create-card" @submit.prevent="submitReset">
        <h3 class="users-create-card__title">New password for {{ resetting }}</h3>
        <label class="users-create-card__label">
          Password
          <input
            v-model="resetPassword"
            type="password"
            class="input-line"
            autocomplete="new-password"
            minlength="8"
            required
          />
          <span class="users-create-card__hint">≥ 8 characters.  Sessions already signed in stay signed in until their token expires.</span>
        </label>
        <p v-if="formError" class="users-page__error">{{ formError }}</p>
        <div class="users-create-card__actions">
          <button type="button" class="btn-ghost px-4 py-2 rounded-xl text-sm" @click="closeResetForm">Cancel</button>
          <button type="submit" class="btn-grad px-4 py-2 rounded-xl text-sm" :disabled="submitting">
            {{ submitting ? "Saving…" : "Set password" }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useGatewayStore } from "@/stores/gateway";
import { useAuthStore } from "@/stores/auth";
import { confirmAction } from "@/composables/useConfirm";
import { useEscapeToClose } from "@/composables/useEscapeToClose";
import { useLoadWhenConnected } from "@/composables/useLoadWhenConnected";
import { useToast, errorText } from "@/composables/useToast";

interface User {
  username: string;
  displayName?: string;
  role: "admin" | "operator" | "viewer";
  createdAt?: string;
}

const gateway = useGatewayStore();
const auth = useAuthStore();
const toast = useToast();
// Adding, resetting and deleting accounts is admin-only at the gateway (user-routes.ts): operator
// is every account's default role, so an operator could otherwise become anyone.
const isAdmin = computed(() => auth.currentUser?.role === "admin");
const currentUsername = computed(() => auth.currentUser?.username);

const users = ref<User[]>([]);
const authEnabled = ref(true);
// Under OIDC the identity provider owns the usernames and the gateway creates no local account.
const accountsFromIdp = ref(false);
const loading = ref(false);
// True while the last load succeeded: only then does an empty list mean "no users".
const loaded = ref(false);
const errorMessage = ref<string | null>(null);
const deleting = ref<string | null>(null);

const creating = ref(false);
const submitting = ref(false);
const formError = ref<string | null>(null);
// Set when creating the FIRST account ends the actor's own (bootstrap) session:
// the gateway closes the zero-users bootstrap window the moment a real account
// exists, so instead of surfacing the resulting 401s we hand off to sign-in.
const bootstrapHandoff = ref<string | null>(null);
const form = ref({
  username: "",
  password: "",
  displayName: "",
  role: "operator" as "operator" | "viewer",
});
// The account whose password is being reset. Re-creating an account whose name owns sessions is
// refused, so this is how a forgotten password is fixed.
const resetting = ref<string | null>(null);
const resetPassword = ref("");

function apiBase(): string {
  return gateway.wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
}

async function loadUsers(): Promise<void> {
  loaded.value = false;
  if (!gateway.token) {
    errorMessage.value = "Not signed in to the gateway — sign in, then refresh to see the users.";
    return;
  }
  loading.value = true;
  errorMessage.value = null;
  try {
    const res = await fetch(`${apiBase()}/api/auth/users`, {
      headers: { Authorization: `Bearer ${gateway.token}` },
    });
    if (!res.ok) {
      errorMessage.value = res.status === 401
        ? "Your session is no longer valid — sign in again."
        : `Failed to load users (${res.status})`;
      return;
    }
    const body = await res.json() as { enabled: boolean; provider?: string; users: User[] };
    authEnabled.value = body.enabled;
    accountsFromIdp.value = body.provider === "oidc";
    users.value = body.users;
    loaded.value = true;
  } catch (err) {
    errorMessage.value = errorText(err);
  } finally {
    loading.value = false;
  }
}

function openCreateForm(): void {
  form.value = { username: "", password: "", displayName: "", role: "operator" };
  formError.value = null;
  creating.value = true;
}

function closeCreateForm(): void {
  creating.value = false;
}

// A click beside a dialog closes it only while nothing has been entered: a stray click must not
// throw away a half-filled form. Escape and Cancel always close.
function dismissCreateForm(): void {
  const { username, password, displayName, role } = form.value;
  if (!username && !password && !displayName && role === "operator") closeCreateForm();
}

useEscapeToClose(() => creating.value, closeCreateForm);

async function submitCreate(): Promise<void> {
  formError.value = null;
  submitting.value = true;
  try {
    const res = await fetch(`${apiBase()}/api/auth/users`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${gateway.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        username: form.value.username.trim().toLowerCase(),
        password: form.value.password,
        displayName: form.value.displayName.trim() || undefined,
        role: form.value.role,
      }),
    });
    if (!res.ok) {
      let message = `Failed (${res.status})`;
      try {
        const body = await res.json() as { error?: string };
        if (body.error) message = body.error;
      } catch { /* ignore */ }
      formError.value = message;
      return;
    }
    const createdUsername = form.value.username.trim().toLowerCase();
    const createdRole = form.value.role;
    closeCreateForm();
    toast.success("User created", `"${createdUsername}" can sign in now, as ${createdRole === "viewer" ? "a viewer" : "an operator"}.`);
    // Creating the first account closes the gateway's bootstrap window, which
    // invalidates a bootstrap (token-mode) session mid-flight. Detect that via
    // a session re-check and hand off to sign-in instead of 401-ing on reload.
    await auth.refreshCurrentUser();
    if (!auth.currentUser) {
      bootstrapHandoff.value = createdUsername;
      return;
    }
    await loadUsers();
  } catch (err) {
    toast.error("Couldn't create the user", errorText(err));
  } finally {
    submitting.value = false;
  }
}

function openResetForm(user: User): void {
  resetting.value = user.username;
  resetPassword.value = "";
  formError.value = null;
}

function closeResetForm(): void {
  resetting.value = null;
}

function dismissResetForm(): void {
  if (!resetPassword.value) closeResetForm();
}

useEscapeToClose(() => resetting.value !== null, closeResetForm);

async function submitReset(): Promise<void> {
  if (!resetting.value) return;
  const username = resetting.value;
  formError.value = null;
  submitting.value = true;
  try {
    const res = await fetch(`${apiBase()}/api/auth/users/${encodeURIComponent(username)}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${gateway.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ password: resetPassword.value }),
    });
    if (!res.ok) {
      let message = `Failed (${res.status})`;
      try {
        const body = await res.json() as { error?: string };
        if (body.error) message = body.error;
      } catch { /* ignore */ }
      formError.value = message;
      return;
    }
    closeResetForm();
    toast.success("Password changed", `"${username}" signs in with the new password from now on. Sessions already signed in stay so until their token expires.`);
  } catch (err) {
    toast.error("Couldn't change the password", errorText(err));
  } finally {
    submitting.value = false;
  }
}

function signInAsNewUser(): void {
  auth.signOut(); // drops the dead token; App.vue shows the login modal on disconnect
}

async function deleteUser(user: User): Promise<void> {
  const confirmed = await confirmAction({
    title: `Delete the user "${user.username}"?`,
    message: "The account is removed and can no longer sign in. This cannot be undone.",
    confirmLabel: "Delete user",
    danger: true,
  });
  if (!confirmed) return;
  deleting.value = user.username;
  errorMessage.value = null;
  try {
    const res = await fetch(`${apiBase()}/api/auth/users/${encodeURIComponent(user.username)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${gateway.token}` },
    });
    if (!res.ok) {
      let message = `Failed (${res.status})`;
      try {
        const body = await res.json() as { error?: string };
        if (body.error) message = body.error;
      } catch { /* ignore */ }
      // A toast, not the page's error line: the next reload of the list clears that line.
      toast.error("Couldn't delete the user", message);
      return;
    }
    toast.success("User deleted", `"${user.username}" can no longer sign in.`);
    await loadUsers();
  } catch (err) {
    toast.error("Couldn't delete the user", errorText(err));
  } finally {
    deleting.value = null;
  }
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

// Also when the gateway comes up after the page did (opened by URL, or signed in to here).
useLoadWhenConnected(loadUsers);
</script>

<style scoped>
.users-page {
  color: rgb(229 231 235);
}

.users-page__error {
  background: rgba(239, 68, 68, 0.12);
  border: 1px solid rgba(248, 113, 113, 0.4);
  border-radius: 8px;
  padding: 0.55rem 0.8rem;
  color: rgb(252 165 165);
  font-size: 0.85rem;
}

.users-page__empty {
  color: rgb(148 163 184);
  font-size: 0.9rem;
  padding: 1.5rem 0;
}

.users-disabled {
  border: 1px dashed rgba(168, 85, 247, 0.35);
  background: rgba(15, 23, 42, 0.7);
  border-radius: 14px;
  padding: 1rem 1.25rem;
  color: rgb(203 213 225);
  font-size: 0.85rem;
  margin-bottom: 1rem;
  line-height: 1.55;
}

.users-disabled code {
  background: rgba(0, 0, 0, 0.4);
  padding: 0.05rem 0.35rem;
  border-radius: 4px;
  color: rgb(165 243 252);
  font-size: 0.85em;
}

.user-grid {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 0.85rem;
}

.user-card {
  background: rgba(15, 23, 42, 0.65);
  border: 1px solid rgba(168, 85, 247, 0.18);
  border-radius: 12px;
  padding: 0.85rem 1rem 0.95rem;
}

.user-card__top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.5rem;
}

.user-card__title-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.user-card__title {
  font-size: 1rem;
  font-weight: 600;
  margin: 0;
  color: rgb(241 245 249);
}

.user-card__role-pill {
  font-size: 0.65rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  border: 1px solid currentColor;
}

.user-card__role-pill--operator {
  color: rgb(196 181 253);
  background: rgba(124, 58, 237, 0.18);
}

.user-card__role-pill--viewer {
  color: rgb(252 211 77);
  background: rgba(217, 119, 6, 0.18);
}

.user-card__you-pill {
  font-size: 0.6rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  background: rgba(34, 211, 238, 0.18);
  color: rgb(165 243 252);
  border: 1px solid rgba(34, 211, 238, 0.4);
}

.user-card__username {
  font-size: 0.78rem;
  color: rgb(148 163 184);
  display: inline-block;
  margin-top: 0.3rem;
}

.user-card__meta {
  margin: 0.5rem 0 0;
  font-size: 0.75rem;
  color: rgb(148 163 184);
}

.user-card__actions {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.users-create-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
  padding: 1rem;
}

.users-create-card {
  width: 100%;
  max-width: 24rem;
  background: rgba(15, 23, 42, 0.95);
  border: 1px solid rgba(168, 85, 247, 0.4);
  border-radius: 16px;
  padding: 1.5rem 1.5rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  box-shadow: 0 30px 60px -20px rgba(0, 0, 0, 0.6);
}

.users-create-card__title {
  margin: 0;
  font-size: 1.1rem;
  font-weight: 600;
  color: rgb(241 245 249);
}

.users-create-card__label {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  font-size: 0.75rem;
  color: rgb(156 163 175);
  text-transform: uppercase;
  letter-spacing: 0.07em;
}

.users-create-card__label .input-line {
  text-transform: none;
  letter-spacing: 0;
  font-size: 0.95rem;
  color: rgb(229 231 235);
}

.users-create-card__hint {
  font-size: 0.7rem;
  color: rgb(107 114 128);
  text-transform: none;
  letter-spacing: 0;
}

.users-create-card__optional {
  text-transform: lowercase;
  letter-spacing: 0;
  color: rgb(107 114 128);
}

.users-create-card__role {
  border: 1px solid rgba(168, 85, 247, 0.18);
  border-radius: 10px;
  padding: 0.5rem 0.75rem 0.6rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  color: rgb(203 213 225);
  font-size: 0.85rem;
}

.users-create-card__role legend {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: rgb(156 163 175);
  padding: 0 0.4rem;
}

.users-create-card__actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.5rem;
}
</style>
