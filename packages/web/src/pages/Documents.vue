<template>
  <div class="page-shell documents-page">
    <header class="page-header">
      <div class="page-header__text">
        <h1 class="page-title">Documents</h1>
        <p class="page-subtitle">
          Files indexed into the document-RAG library (engram). Upload to your <strong>personal</strong> or the
          <strong>workspace</strong> library so the assistant can retrieve from them in any conversation, or manage the
          documents attached to the current <strong>session</strong>. Removing a document also clears it from the RAG
          index and deletes the stored file.
        </p>
      </div>
      <div v-if="gateway.connected" class="page-actions">
        <button type="button" @click="reload" :disabled="loading" class="btn-ghost px-4 py-2 rounded-xl text-sm">
          {{ loading ? "Loading…" : "Reload" }}
        </button>
      </div>
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
          <button type="button" @click="fileInputEl?.click()" :disabled="uploading || !engramAvailable" class="btn-grad px-4 py-2 rounded-xl text-sm">
            {{ uploading ? "Indexing…" : "Choose file & upload" }}
          </button>
        </div>
        <div v-if="uploadError" class="text-sm text-red-400 mt-2" role="alert">{{ uploadError }}</div>
        <div v-else-if="uploadNote" class="text-sm text-emerald-300 mt-2">{{ uploadNote }}</div>
      </section>

      <div v-if="loadError" class="notice notice--error mb-4" role="alert">{{ loadError }}</div>

      <!-- Scope sections -->
      <section v-for="group in groups" :key="group.scope" class="glass-card p-5 mb-4">
        <div class="flex items-center justify-between mb-3 gap-3 flex-wrap">
          <div>
            <h3 class="section-title mb-0">{{ group.label }}</h3>
            <div class="text-xs text-gray-500 mt-1">
              {{ group.hint }}
              <template v-if="group.ragSwitch">
                <RouterLink :to="{ path: '/agents', hash: '#document-rag' }" class="underline decoration-dotted hover:text-white">Manage → Agent tuning</RouterLink>
                (Document RAG).
              </template>
            </div>
          </div>
          <span class="doc-count">{{ group.rows.length }}</span>
        </div>

        <!-- "No documents" is only true after a load that worked. -->
        <div v-if="group.rows.length === 0" class="text-sm text-gray-500">
          {{ loaded ? "No documents here yet." : loading ? "Loading documents…" : "Documents could not be loaded." }}
        </div>

        <ul v-else class="doc-list">
          <li v-for="row in group.rows" :key="row.doc.id + row.entry.source" class="doc-row">
            <div class="doc-row__main">
              <div class="doc-row__title" :title="row.doc.title ?? row.doc.id">
                📄 {{ row.doc.title ?? row.doc.id.slice(0, 12) }}
                <span v-if="row.doc.invalidated" class="doc-outdated-badge" title="Marked outdated — retrieval skips this document; re-upload the file to reinstate it.">outdated</span>
              </div>
              <div class="doc-row__meta">
                {{ row.doc.chunkCount }} chunk{{ row.doc.chunkCount === 1 ? "" : "s" }}
                <span v-if="row.entry.size"> · {{ formatBytes(row.entry.size) }}</span>
                <span v-if="row.doc.createdAt" :title="isoTimestamp(row.doc.createdAt)"> · {{ formatDateTime(row.doc.createdAt) }}</span>
                <span v-if="otherScopes(row).length" class="doc-row__alsoin"> · also in {{ otherScopes(row).join(", ") }}</span>
              </div>
            </div>
            <div class="doc-row__actions">
              <button v-if="row.doc.hasFile" type="button" @click="viewDocument(row.doc)" :disabled="busyId === row.doc.id" class="btn-ghost px-3 py-1 rounded-lg text-xs">View</button>
              <button
                v-if="!row.doc.invalidated"
                type="button"
                @click="markOutdated(row)"
                :disabled="busyId === row.doc.id"
                class="doc-outdate px-3 py-1 rounded-lg text-xs"
                title="Keep the document stored but stop retrieval from using it (all scopes). Re-upload to reinstate."
              >{{ busyId === row.doc.id ? "…" : "Mark outdated" }}</button>
              <button type="button" @click="removeDocument(row)" :disabled="busyId === row.doc.id" class="doc-remove px-3 py-1 rounded-lg text-xs">
                {{ busyId === row.doc.id ? "…" : "Remove" }}
              </button>
            </div>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { useGatewayStore, type ManagedDocument, type ManagedDocumentScope } from "@/stores/gateway";
import { ownUserSourceMatcher } from "@/composables/documentSources";
import { formatDateTime, isoTimestamp } from "@/composables/formatDate";
import { confirmAction } from "@/composables/useConfirm";
import { useLoadWhenConnected } from "@/composables/useLoadWhenConnected";
import { useToast, errorText } from "@/composables/useToast";

const gateway = useGatewayStore();
const toast = useToast();

const loading = ref(false);
// True while the lists on screen come from a load that succeeded.
const loaded = ref(false);
const loadError = ref("");
const documents = ref<ManagedDocument[]>([]);
const engramAvailable = ref(true);
const currentUser = ref<string | null>(null);
/** Under multi-user auth, the caller's own user corpora by source (keyed by its account id). */
const currentUserSources = ref<string[] | undefined>(undefined);

const fileInputEl = ref<HTMLInputElement | null>(null);
const uploadScope = ref<"user" | "workspace" | "session">("user");
const uploading = ref(false);
const uploadError = ref("");
const uploadNote = ref("");
const busyId = ref<string | null>(null);

const currentSessionId = computed(() => gateway.currentSessionId);

interface DocRow { doc: ManagedDocument; entry: ManagedDocumentScope }

function rowsForScope(scope: "session" | "user" | "workspace", matchSource?: string | ((source: string) => boolean)): DocRow[] {
  const matches = typeof matchSource === "string" ? (source: string) => source === matchSource : matchSource;
  const rows: DocRow[] = [];
  for (const doc of documents.value) {
    const entry = doc.scopes.find((s) => s.scope === scope && (!matches || matches(s.source)));
    if (entry) rows.push({ doc, entry });
  }
  return rows;
}

const groups = computed(() => {
  const sid = currentSessionId.value;
  // ragSwitch: the hint ends in a link to the page that holds the Document RAG switch.
  const out: Array<{ scope: "session" | "user" | "workspace"; label: string; hint: string; ragSwitch: boolean; rows: DocRow[] }> = [];
  out.push({
    scope: "session",
    label: "Current session",
    hint: sid ? "Files attached to the conversation you have open." : "Open a chat to see its attached documents.",
    ragSwitch: false,
    rows: sid ? rowsForScope("session", `session:${sid}`) : [],
  });
  out.push({
    scope: "user",
    label: "Personal library",
    hint: "Your documents — searchable across your conversations when enabled in",
    ragSwitch: true,
    rows: rowsForScope("user", ownUserSourceMatcher({ currentUser: currentUser.value, currentUserSources: currentUserSources.value })),
  });
  out.push({
    scope: "workspace",
    label: "Workspace library",
    hint: "Shared across the workspace when enabled in",
    ragSwitch: true,
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
    currentUserSources.value = res.currentUserSources;
    loaded.value = true;
  } catch (e) {
    loaded.value = false;
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
    // Indexing takes a while; by the time it fails the line under the button may be off screen.
    toast.error("Couldn't upload the document", `“${file.name}”: ${errorText(e)}`);
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
    toast.error("Couldn't open the document", errorText(e));
  } finally {
    busyId.value = null;
  }
}

async function markOutdated(row: DocRow) {
  const label = row.doc.title ?? row.doc.id.slice(0, 12);
  const multi = row.doc.scopes.length > 1;
  // Not marked as destructive: nothing is deleted, and a re-upload undoes it.
  if (!(await confirmAction({
    title: "Mark this document as outdated?",
    message: `“${label}” stays stored and viewable, but retrieval stops using it${multi ? " — in EVERY scope holding it" : ""}. Re-uploading the same file reinstates it.`,
    confirmLabel: "Mark outdated",
  }))) return;
  busyId.value = row.doc.id;
  try {
    const sid = row.entry.scope === "session" ? row.entry.source.replace(/^session:/, "") : currentSessionId.value ?? undefined;
    await gateway.invalidateDocument(row.doc.id, sid);
    toast.success("Marked outdated", `Retrieval no longer uses “${label}”.`);
    await reload();
  } catch (e) {
    toast.error("Couldn't mark the document outdated", errorText(e));
  } finally {
    busyId.value = null;
  }
}

async function removeDocument(row: DocRow) {
  const label = row.doc.title ?? row.doc.id.slice(0, 12);
  const multi = row.doc.scopes.length > 1;
  if (!(await confirmAction({
    title: multi ? `Remove this document from the ${row.entry.scope} library?` : "Remove this document?",
    message: multi
      ? `“${label}” leaves the ${row.entry.scope} library. It stays available in its other scopes.`
      : `“${label}” is deleted from the RAG index and its stored file is removed. To get it back you would have to upload it again.`,
    confirmLabel: "Remove document",
    danger: true,
  }))) return;
  busyId.value = row.doc.id;
  try {
    const sid = row.entry.scope === "session" ? row.entry.source.replace(/^session:/, "") : undefined;
    await gateway.deleteDocument(row.doc.id, row.entry.scope, sid);
    toast.success(
      "Document removed",
      multi ? `“${label}” left the ${row.entry.scope} library.` : `“${label}” and its stored file are gone.`,
    );
    await reload();
  } catch (e) {
    toast.error("Couldn't remove the document", errorText(e));
  } finally {
    busyId.value = null;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// The page can be open before the gateway is reachable (a reload of this URL): the lists load
// once it connects, and again after every reconnect.
useLoadWhenConnected(reload);
</script>

<style scoped>
/* A reading column: the header and the cards share one centred width (the old 980px column
   less its padding) while the page itself scrolls at the window's edge. */
.documents-page > * { max-width: 932px; margin-left: auto; margin-right: auto; }
.doc-banner { border-radius: 0.75rem; padding: 0.6rem 0.9rem; font-size: 0.8rem; margin-bottom: 1rem; }
.doc-banner--warn { border: 1px solid rgba(245, 158, 11, 0.4); background: rgba(245, 158, 11, 0.08); color: #fcd9a8; }
.doc-upload-row { display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: center; }
.doc-upload-scope { max-width: 16rem; }
.doc-count { font-size: 0.75rem; color: rgb(156 163 175); border: 1px solid rgba(255,255,255,0.12); border-radius: 999px; padding: 0.1rem 0.6rem; }
.doc-list { display: flex; flex-direction: column; gap: 0.5rem; }
.doc-row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.6rem 0.8rem; border: 1px solid rgba(255,255,255,0.08); border-radius: 0.75rem; background: rgba(255,255,255,0.02); }
.doc-row__title { font-size: 0.9rem; font-weight: 600; }
.doc-row__meta { font-size: 0.75rem; color: rgb(156 163 175); margin-top: 0.15rem; }
.doc-row__alsoin { opacity: 0.8; }
.doc-row__actions { display: flex; gap: 0.4rem; shrink: 0; }
.doc-remove { border: 1px solid rgba(248, 113, 113, 0.4); color: #fca5a5; background: rgba(248, 113, 113, 0.08); transition: background 0.15s; }
.doc-remove:hover { background: rgba(248, 113, 113, 0.18); }
.doc-outdate { border: 1px solid rgba(245, 158, 11, 0.4); color: #fcd9a8; background: rgba(245, 158, 11, 0.08); transition: background 0.15s; }
.doc-outdate:hover { background: rgba(245, 158, 11, 0.18); }
.doc-outdated-badge { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.05em; border: 1px solid rgba(245, 158, 11, 0.45); color: #fcd9a8; background: rgba(245, 158, 11, 0.12); border-radius: 999px; padding: 0.05rem 0.5rem; margin-left: 0.4rem; vertical-align: middle; }
</style>
