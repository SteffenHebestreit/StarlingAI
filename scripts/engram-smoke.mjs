#!/usr/bin/env node
/**
 * engram endpoint smoke test — verifies the HTTP contract StarlingAI's client
 * (packages/core/src/retrieval/engram.ts) depends on, against a LIVE engram.
 *
 * This is Phase 0b of docs/engram-reevaluation-2026-07.md: run it after any
 * ENGRAM_REF pin bump (docker compose --profile rag build engram && up -d engram)
 * before trusting the new image. It exists because the client maps /search
 * results BY snake_case KEY with `?? 0` fallbacks — a renamed/dropped field does
 * not error, it silently zeroes (e.g. rerank_score → 0, which then trips
 * minRerankScore and drops every chunk, making RAG look empty).
 *
 * Usage:
 *   node scripts/engram-smoke.mjs [baseUrl]     (default http://localhost:8088)
 *   ENGRAM_API_KEY=… adds a bearer header.
 *
 * Exit 0 = contract intact. Exit 1 = a check failed. Ingest needs the engram
 * container to reach its EMBEDDING_API_BASE; search still answers via the
 * fulltext (BM25) fallback when embeddings are down, so the distinctive token
 * below is matchable either way.
 */

const BASE = (process.argv[2] || process.env.ENGRAM_SMOKE_URL || "http://localhost:8088").replace(/\/$/, "");
const API_KEY = process.env.ENGRAM_API_KEY || "";
const SOURCE = "smoke:canary";
const TOKEN = "aurora-canary-7f3e"; // distinctive fulltext-matchable token
const DOC_ID = "starlingai-smoke-canary";

// The exact snake_case keys engram.ts maps per result (engram.ts ~:172-185).
const RESULT_KEYS = [
  "chunk_id", "document_id", "text", "summary", "keywords", "origin",
  "graph_distance", "graph_proximity", "retrieval_score", "median_score",
  "fused_score", "rerank_score",
];

let failures = 0;
const ok = (msg) => console.log(`  ok    ${msg}`);
const warn = (msg) => console.log(`  warn  ${msg}`);
const fail = (msg) => { failures += 1; console.error(`  FAIL  ${msg}`); };

async function req(method, path, body, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    return { status: res.status, ok: res.ok, json, text };
  } finally {
    clearTimeout(timer);
  }
}

console.log(`engram smoke → ${BASE}`);

// 1. /health — retry a few times so a run right after `up -d` doesn't race startup.
let healthy = false;
for (let i = 0; i < 10 && !healthy; i++) {
  try {
    const res = await req("GET", "/health");
    healthy = res.ok;
    if (!healthy) await new Promise((r) => setTimeout(r, 2000));
  } catch {
    await new Promise((r) => setTimeout(r, 2000));
  }
}
if (healthy) ok("GET /health");
else {
  fail(`GET /health unreachable at ${BASE} — is the rag profile up? (docker compose --profile rag up -d engram)`);
  process.exit(1);
}

// 2. POST /documents — ingest under the canary source (replaces any prior run's doc).
//    Generous timeout: ingest runs chunking + metadata extraction.
let ingestedId = null;
try {
  const res = await req("POST", "/documents", {
    text: `StarlingAI smoke canary document. The magic token is ${TOKEN}. `
      + "It verifies that ingest, listing, search, and delete keep the shapes the gateway client maps.",
    source: SOURCE,
    title: "StarlingAI smoke canary",
    document_id: DOC_ID,
  }, 120000);
  if (res.ok && res.json?.document_id) {
    ingestedId = String(res.json.document_id);
    ok(`POST /documents → document_id=${ingestedId} chunk_count=${res.json.chunk_count ?? "?"}`);
    if (typeof res.json.chunk_count !== "number") warn("ingest response missing numeric chunk_count (client defaults it to 0)");
  } else {
    fail(`POST /documents → HTTP ${res.status}: ${res.text.slice(0, 200)}`);
  }
} catch (err) {
  fail(`POST /documents threw: ${err?.message ?? err}`);
}

// 3. GET /documents — list must be an array; our doc must carry its source ref.
try {
  const res = await req("GET", "/documents");
  if (!res.ok || !Array.isArray(res.json)) {
    fail(`GET /documents → HTTP ${res.status} or non-array body`);
  } else {
    ok(`GET /documents → ${res.json.length} document(s)`);
    if (ingestedId) {
      const mine = res.json.find((d) => String(d?.id ?? "") === ingestedId);
      if (!mine) fail(`ingested document ${ingestedId} missing from GET /documents`);
      else if (!Array.isArray(mine.sources) || !mine.sources.includes(SOURCE)) {
        fail(`document ${ingestedId} lacks its "${SOURCE}" source ref (sources=${JSON.stringify(mine?.sources)}) — scope post-filtering would break`);
      } else ok(`document carries source ref "${SOURCE}"`);
    }
  }
} catch (err) {
  fail(`GET /documents threw: ${err?.message ?? err}`);
}

// 4. POST /search — shape check on the fields the client maps by key.
try {
  const res = await req("POST", "/search", { query: `magic token ${TOKEN}`, tuning: { final_top_k: 5 } }, 60000);
  if (!res.ok || !Array.isArray(res.json?.results)) {
    fail(`POST /search → HTTP ${res.status} or missing results[] (body: ${res.text.slice(0, 200)})`);
  } else {
    const results = res.json.results;
    ok(`POST /search → ${results.length} result(s)`);
    // New v0.6.0+ response-level confidence fields (consumed by the CRAG flag later).
    for (const key of ["top_rerank_score", "score_gap"]) {
      if (key in res.json) ok(`response exposes ${key} (${res.json[key] === null ? "null" : res.json[key]})`);
      else warn(`response lacks ${key} — pre-v0.6.0 server? CRAG phase would be inert`);
    }
    const hit = results.find((r) => String(r?.text ?? "").includes(TOKEN)) ?? results[0];
    if (!hit) {
      fail(`search returned no results for the canary token "${TOKEN}" (even fulltext fallback should match)`);
    } else {
      const missing = RESULT_KEYS.filter((k) => !(k in hit));
      if (missing.length > 0) {
        fail(`result missing key(s) the client maps: ${missing.join(", ")} — these silently coerce to 0/'' and can drop every chunk via minRerankScore`);
      } else ok(`result carries all ${RESULT_KEYS.length} client-mapped keys`);
      if (!String(hit?.text ?? "").includes(TOKEN)) warn("top result does not contain the canary token (ranking, not contract)");
    }
  }
} catch (err) {
  fail(`POST /search threw: ${err?.message ?? err}`);
}

// 5. DELETE — scoped ref-drop first (the client's soft path), then hard delete to leave no residue.
if (ingestedId) {
  try {
    const scoped = await req("DELETE", `/documents/${encodeURIComponent(ingestedId)}?source=${encodeURIComponent(SOURCE)}`);
    if (scoped.ok) ok(`DELETE /documents/{id}?source=${SOURCE}`);
    else fail(`scoped DELETE → HTTP ${scoped.status}`);
    // Hard delete is a cleanup no-op if the ref-drop already removed the last reference.
    const hard = await req("DELETE", `/documents/${encodeURIComponent(ingestedId)}`);
    if (hard.ok || hard.status === 404) ok("hard DELETE cleanup");
    else warn(`hard DELETE → HTTP ${hard.status} (canary doc may linger)`);
  } catch (err) {
    fail(`DELETE threw: ${err?.message ?? err}`);
  }
}

if (failures > 0) {
  console.error(`\nengram smoke: ${failures} FAILURE(S) — do not promote this ENGRAM_REF; rollback per docker/engram/Dockerfile.`);
  process.exit(1);
}
console.log("\nengram smoke: contract intact.");
