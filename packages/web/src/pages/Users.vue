<template>
  <div class="users-page" style="height: 100%; overflow-y: auto">
    <div class="users-page__header">
      <div>
        <h2 class="users-page__title">Users</h2>
        <p class="users-page__subtitle">
          Manage operator and viewer accounts.  Passwords are stored as bcrypt hashes — plaintext is never persisted.
        </p>
      </div>
      <div class="users-page__actions">
        <button class="users-page__button" :disabled="loading" @click="loadUsers">Refresh</button>
        <button
          class="users-page__button users-page__button--primary"
          :disabled="!isOperator"
          :title="isOperator ? '' : 'Only operators can add users'"
          @click="openCreateForm"
        >
          + Add user
        </button>
      </div>
    </div>

    <div v-if="bootstrapHandoff" class="users-disabled">
      <p>
        Account <strong>{{ bootstrapHandoff }}</strong> was created.  The bootstrap admin session
        has ended now that a real account exists — sign in with the new account to continue.
      </p>
      <button class="users-page__button users-page__button--primary" @click="signInAsNewUser">
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

    <div v-if="loading && users.length === 0" class="users-page__empty">Loading…</div>

    <div v-else-if="users.length === 0" class="users-page__empty">
      No users configured yet.  Click <strong>Add user</strong> to create the first account.
    </div>

    <ul v-else class="user-grid">
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
          <button
            v-if="isOperator && user.username !== currentUsername"
            class="user-card__button user-card__button--danger"
            :disabled="deleting === user.username"
            @click="deleteUser(user)"
          >
            {{ deleting === user.username ? "…" : "Delete" }}
          </button>
        </div>
        <p v-if="user.createdAt" class="user-card__meta">Created {{ formatTimestamp(user.createdAt) }}</p>
      </li>
    </ul>

    <div
      v-if="creating"
      class="users-create-modal"
      role="dialog"
      aria-modal="true"
      @click.self="closeCreateForm"
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
          <button type="button" class="users-page__button" @click="closeCreateForm">Cancel</button>
          <button type="submit" class="users-page__button users-page__button--primary" :disabled="submitting">
            {{ submitting ? "Creating…" : "Create user" }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useGatewayStore } from "@/stores/gateway";
import { useAuthStore } from "@/stores/auth";

interface User {
  username: string;
  displayName?: string;
  role: "operator" | "viewer";
  createdAt?: string;
}

const gateway = useGatewayStore();
const auth = useAuthStore();
const isOperator = computed(() => auth.isOperator);
const currentUsername = computed(() => auth.currentUser?.username);

const users = ref<User[]>([]);
const authEnabled = ref(true);
const loading = ref(false);
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

function apiBase(): string {
  return gateway.wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "");
}

async function loadUsers(): Promise<void> {
  if (!gateway.token) return;
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
    const body = await res.json() as { enabled: boolean; users: User[] };
    authEnabled.value = body.enabled;
    users.value = body.users;
  } catch (err) {
    errorMessage.value = (err as Error).message;
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
    closeCreateForm();
    // Creating the first account closes the gateway's bootstrap window, which
    // invalidates a bootstrap (token-mode) session mid-flight. Detect that via
    // a session re-check and hand off to sign-in instead of 401-ing on reload.
    await auth.refreshCurrentUser();
    if (!auth.currentUser) {
      bootstrapHandoff.value = createdUsername;
      return;
    }
    await loadUsers();
  } finally {
    submitting.value = false;
  }
}

function signInAsNewUser(): void {
  auth.signOut(); // drops the dead token; App.vue shows the login modal on disconnect
}

async function deleteUser(user: User): Promise<void> {
  if (!confirm(`Delete user '${user.username}'?  This cannot be undone.`)) return;
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
      errorMessage.value = message;
      return;
    }
    await loadUsers();
  } finally {
    deleting.value = null;
  }
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

onMounted(() => {
  void loadUsers();
});
</script>

<style scoped>
.users-page {
  padding: 1.5rem 1.75rem 3rem;
  color: rgb(229 231 235);
}

.users-page__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  margin-bottom: 1.25rem;
}

.users-page__title {
  font-size: 1.5rem;
  font-weight: 600;
  margin: 0;
  background: linear-gradient(90deg, rgb(165 243 252), rgb(196 181 253));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

.users-page__subtitle {
  margin: 0.4rem 0 0;
  color: rgb(156 163 175);
  font-size: 0.875rem;
  max-width: 36rem;
}

.users-page__actions {
  display: flex;
  gap: 0.5rem;
}

.users-page__button {
  background: rgba(76, 29, 149, 0.35);
  border: 1px solid rgba(168, 85, 247, 0.35);
  color: rgb(233 213 255);
  padding: 0.4rem 0.85rem;
  border-radius: 999px;
  font-size: 0.85rem;
  cursor: pointer;
  transition: all 120ms ease;
}

.users-page__button:hover:not(:disabled) {
  background: rgba(124, 58, 237, 0.55);
  color: white;
}

.users-page__button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.users-page__button--primary {
  background: linear-gradient(90deg, rgba(124, 58, 237, 0.65), rgba(217, 70, 239, 0.55));
  border-color: rgba(217, 70, 239, 0.55);
  color: white;
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

.user-card__button {
  background: transparent;
  border: 1px solid rgba(248, 113, 113, 0.45);
  color: rgb(252 165 165);
  padding: 0.25rem 0.7rem;
  border-radius: 999px;
  font-size: 0.75rem;
  cursor: pointer;
  transition: all 120ms ease;
}

.user-card__button:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.18);
  color: white;
}

.user-card__button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
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
