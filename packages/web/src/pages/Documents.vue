<template>
  <div class="documents-page" style="height:100%;overflow:auto;">
    <header class="documents-page__header">
      <div>
        <h1 class="documents-page__title">Documents</h1>
        <p class="documents-page__subtitle">
          Files indexed into the document-RAG library (engram). Upload to your <strong>personal</strong> or the
          <strong>workspace</strong> library so the assistant can retrieve from them in any conversation, or manage the
          documents attached to the current <strong>session</strong>. Removing a document also clears it from the RAG
          index and deletes the stored file.
        </p>
      </div>
      <button v-if="gateway.connected" @click="reload" :disabled="loading" class="btn-ghost px-3 py-1.5 rounded-lg text-xs">
        {{ loading ? "Loading…" : "Reload" }}
      </button>
    </header>

    <div v-if="!gateway.connected" class="empty-state">Connect to manage documents.</div>

    <template v-else>
      <div v-if="!engramAvailable" class="doc-banner doc-banner--warn">
        The document-RAG service (engram) is not reachable. Document management is unavailable until it is running.
      </div>

      <!-- Upload -->
      <section class="glass-card p-5 mb-4">
        <h3 class="section-title mb-2">Upload a document</h3>
        <div class="text-xs text-gray-500 mb-3">
          The file is stored and its text is extracted + embedded into the chosen library. PDF, DOCX, PPTX, XLSX,
          images, Markdown, CSV, and plain text are supported.
        </div>
        <div class="doc-upload-row">
          <select v-model="uploadScope" class="input-box doc-upload-scope">
            <option value="user">Personal library (you)</option>
            <option value="workspace">Workspace library (shared)</option>
            <option v-if="currentSessionId" value="session">Current session</option>
          </select>
          <input ref="fileInputEl" type="file" class="hidden" @change="onFileSelected" />
          <button @click="fileInputEl?.click()" :disabled="uploading || !engramAvailable" class="btn-grad px-4 py-2 rounded-xl text-sm">
            {{ uploading ? "Indexing…" : "Choose file & upload" }}
          </button>
        </div>
        <div v-if="uploadError" class="text-sm text-red-400 mt-2">{{ uploadError }}</div>
        <div v-else-if="uploadNote" class="text-sm text-emerald-300 mt-2">{{ uploadNote }}</div>
      </section>

      <!-- Scope sections -->
      <section v-for="group in groups" :key="group.scope" class="glass-card p-5 mb-4">
        <div class="flex items-center justify-between mb-3 gap-3 flex-wrap">
          <div>
            <h3 class="section-title mb-0">{{ group.label }}</h3>
            <div class="text-xs text-gray-500 mt-1">{{ group.hint }}</div>
          </div>
          <span class="doc-count">{{ group.rows.length }}</span>
        </div>

        <div v-if="group.rows.length === 0" class="text-sm text-gray-500">No documents here yet.</div>

        <ul v-else class="doc-list">
          <li v-for="row in group.rows" :key="row.doc.id + row.entry.source" class="doc-row">
            <div class="doc-row__main">
              <div class="doc-row__title" :title="row.doc.title ?? row.doc.id">📄 {{ row.doc.title ?? row.doc.id.slice(0, 12) }}</div>
              <div class="doc-row__meta">
                {{ row.doc.chunkCount }} chunk{{ row.doc.chunkCount === 1 ? "" : "s" }}
                <span v-if="row.entry.size"> · {{ formatBytes(row.entry.size) }}</span>
                <span v-if="row.doc.createdAt"> · {{ formatDate(row.doc.createdAt) }}</span>
                <span v-if="otherScopes(row).length" class="doc-row__alsoin"> · also in {{ otherScopes(row).join(", ") }}</span>
              </div>
            </div>
            <div class="doc-row__actions">
              <button v-if="row.doc.hasFile" @click="viewDocument(row.doc)" :disabled="busyId === row.doc.id" class="btn-ghost px-3 py-1 rounded-lg text-xs">View</button>
              <button @click="removeDocument(row)" :disabled="busyId === row.doc.id" class="doc-remove px-3 py-1 rounded-lg text-xs">
                {{ busyId === row.doc.id ? "…" : "Remove" }}
              </button>
            </div>
          </li>
        </ul>
      </section>

      <div v-if="loadError" class="text-sm text-red-400">{{ loadError }}</div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useGatewayStore, type ManagedDocument, type ManagedDocumentScope } from "@/stores/gateway";

const gateway = useGatewayStore();

const loading = ref(false);
const loadError = ref("");
const documents = ref<ManagedDocument[]>([]);
const engramAvailable = ref(true);
const currentUser = ref<string | null>(null);

const fileInputEl = ref<HTMLInputElement | null>(null);
const uploadScope = ref<"user" | "workspace" | "session">("user");
const uploading = ref(false);
const uploadError = ref("");
const uploadNote = ref("");
const busyId = ref<string | null>(null);

const currentSessionId = computed(() => gateway.currentSessionId);

interface DocRow { doc: ManagedDocument; entry: ManagedDocumentScope }

function rowsForScope(scope: "session" | "user" | "workspace", matchSource?: string): DocRow[] {
  const rows: DocRow[] = [];
  for (const doc of documents.value) {
    const entry = doc.scopes.find((s) => s.scope === scope && (!matchSource || s.source === matchSource));
    if (entry) rows.push({ doc, entry });
  }
  return rows;
}

const groups = computed(() => {
  const sid = currentSessionId.value;
  const out: Array<{ scope: "session" | "user" | "workspace"; label: string; hint: string; rows: DocRow[] }> = [];
  out.push({
    scope: "session",
    label: "Current session",
    hint: sid ? "Files attached to the conversation you have open." : "Open a chat to see its attached documents.",
    rows: sid ? rowsForScope("session", `session:${sid}`) : [],
  });
  out.push({
    scope: "user",
    label: "Personal library",
    hint: "Your documents — searchable across your conversations when enabled in Settings → Document RAG.",
    rows: rowsForScope("user", currentUser.value ? `user:${currentUser.value}` : undefined),
  });
  out.push({
    scope: "workspace",
    label: "Workspace library",
    hint: "Shared across the workspace when enabled in Settings → Document RAG.",
    rows: rowsForScope("workspace"),
  });
  return out;
});

function otherScopes(row: DocRow): string[] {
  return row.doc.scopes
    .filter((s) => s.source !== row.entry.source)
    .map((s) => s.scope)
    .filter((s, i, arr) => arr.indexOf(s) === i);
}

async function reload() {
  loading.value = true;
  loadError.value = "";
  try {
    const res = await gateway.listDocuments();
    documents.value = res.documents;
    engramAvailable.value = res.engramAvailable;
    currentUser.value = res.currentUser;
  } catch (e) {
    loadError.value = `Failed to load documents: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    loading.value = false;
  }
}

async function onFileSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  uploading.value = true;
  uploadError.value = "";
  uploadNote.value = "";
  try {
    const sid = uploadScope.value === "session" ? (currentSessionId.value ?? undefined) : undefined;
    const res = await gateway.uploadDocument(file, uploadScope.value, sid);
    uploadNote.value = `Indexed “${res.title}” (${res.chunkCount} chunk${res.chunkCount === 1 ? "" : "s"}) into the ${res.scope} library.`;
    await reload();
  } catch (e) {
    uploadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    uploading.value = false;
  }
}

async function viewDocument(doc: ManagedDocument) {
  busyId.value = doc.id;
  try {
    const blob = await gateway.fetchDocumentFileBlob(doc.id);
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener");
    // Revoke after a delay so the new tab has time to load it.
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    busyId.value = null;
  }
}

async function removeDocument(row: DocRow) {
  const label = row.doc.title ?? row.doc.id.slice(0, 12);
  const multi = row.doc.scopes.length > 1;
  const msg = multi
    ? `Remove “${label}” from the ${row.entry.scope} library? (It stays available in its other scopes.)`
    : `Remove “${label}”? This deletes it from the RAG index and removes the stored file.`;
  if (!window.confirm(msg)) return;
  busyId.value = row.doc.id;
  try {
    const sid = row.entry.scope === "session" ? row.entry.source.replace(/^session:/, "") : undefined;
    await gateway.deleteDocument(row.doc.id, row.entry.scope, sid);
    await reload();
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e);
  } finally {
    busyId.value = null;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

onMounted(() => {
  if (gateway.connected) void reload();
});
</script>

<style scoped>
.documents-page { padding: 1.25rem 1.5rem 2rem; max-width: 980px; margin: 0 auto; }
.documents-page__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 1.25rem; }
.documents-page__title { font-size: 1.5rem; font-weight: 700; }
.documents-page__subtitle { font-size: 0.85rem; color: var(--muted, #9aa4b2); max-width: 70ch; margin-top: 0.25rem; }
.doc-banner { border-radius: 0.75rem; padding: 0.6rem 0.9rem; font-size: 0.8rem; margin-bottom: 1rem; }
.doc-banner--warn { border: 1px solid rgba(245, 158, 11, 0.4); background: rgba(245, 158, 11, 0.08); color: #fcd9a8; }
.doc-upload-row { display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: center; }
.doc-upload-scope { max-width: 16rem; }
.doc-count { font-size: 0.75rem; color: var(--muted, #9aa4b2); border: 1px solid rgba(255,255,255,0.12); border-radius: 999px; padding: 0.1rem 0.6rem; }
.doc-list { display: flex; flex-direction: column; gap: 0.5rem; }
.doc-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.6rem 0.8rem; border: 1px solid rgba(255,255,255,0.08); border-radius: 0.75rem; background: rgba(255,255,255,0.02); }
.doc-row__title { font-size: 0.9rem; font-weight: 600; }
.doc-row__meta { font-size: 0.75rem; color: var(--muted, #9aa4b2); margin-top: 0.15rem; }
.doc-row__alsoin { opacity: 0.8; }
.doc-row__actions { display: flex; gap: 0.4rem; shrink: 0; }
.doc-remove { border: 1px solid rgba(248, 113, 113, 0.4); color: #fca5a5; background: rgba(248, 113, 113, 0.08); transition: background 0.15s; }
.doc-remove:hover { background: rgba(248, 113, 113, 0.18); }
.empty-state { color: var(--muted, #9aa4b2); font-size: 0.9rem; padding: 2rem; text-align: center; }
</style>
