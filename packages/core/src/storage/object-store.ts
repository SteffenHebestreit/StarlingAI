/**
 * Upload object store — one interface over two backends, keyed by the same
 * `uploads/<scope>/<name>` relative path the handlers already use:
 *   - `storage.backend: "local"` → the gateway's disk under `<workspace>/<key>`
 *     (the legacy default; existing files stay readable).
 *   - `storage.backend: "s3"`    → any S3-compatible store via @aws-sdk/client-s3
 *     — the bundled SeaweedFS, or a real AWS S3 bucket (same API, drop-in swap).
 *
 * The AWS client is imported lazily so a `local` deployment never loads the SDK.
 *
 * EVERY KEY IS THE CALLER'S. putUpload, getUpload and deleteUpload take a path relative to the
 * ambient caller's own root and store it under that caller's namespace (callerUploadKey below).
 */
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { resolveSecretRef } from "../tools/infrastructure-shared.js";
import { userWorkspaceRoot } from "../tools/workspace-path.js";
import { multiUserAuthActive, segmentFor } from "../runtime/user-scope.js";
import { USERS_SUBDIR } from "../tools/workspace-zones.js";
import type { S3Client } from "@aws-sdk/client-s3";

const log = childLogger("storage:object-store");

/**
 * THE KEY OF AN UPLOAD IS ITS PLACE IN THE CALLER'S OWN ROOT.
 *
 * The store was keyed by the bare relative path, which every caller computed against ITS OWN
 * root (`<shared>/users/<segment>` under multi-user auth), while the local backend joined it to
 * the SHARED root and S3 kept one flat namespace for every account. So the fallback that reads an
 * attachment back through the store read another account's file for the asking: account A's
 * extract_file_content("users/<B>/generated/x.pdf") missed on A's disk and was then answered from
 * `<shared>/users/<B>/generated/x.pdf`, and ".starlingai/users/<B>/memory/k.json" read B's memory.
 * Under S3 every account's uploads shared `uploads/<session>/...`, guarded by nothing but the
 * session id being hard to guess.
 *
 * Now a path is resolved against the ambient caller's own root (userWorkspaceRoot, the same root
 * the caller's agents and the workspace routes use), must stay inside it, and may not name what
 * read_file refuses (secrets, the state directory, VCS internals). The key is where that lands
 * relative to the shared root: `users/<segment>/<path>` for an account or a principal under
 * multi-user auth, the path itself with one operator, so a single-operator store is unchanged.
 * The local backend's file is therefore the very file in the caller's root, and an S3 key has the
 * same shape: no caller can name a key outside its own namespace.
 */
export class UploadPathRefusedError extends Error {
  constructor(relativePath: string, why: string) {
    super(`Refusing upload path '${relativePath}': ${why}`);
    this.name = "UploadPathRefusedError";
  }
}

/** A store key as stored: forward slashes, whatever the platform. */
function toKey(sharedRoot: string, absolutePath: string): string {
  return relative(sharedRoot, absolutePath).split(sep).join("/");
}

/** Whether `child` is `parent` or inside it. */
function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The store key and local file of `relativePath` for the ambient caller. Throws
 * UploadPathRefusedError when the path leaves the caller's root or names protected data.
 */
export async function callerUploadKey(relativePath: string): Promise<{ key: string; file: string }> {
  const sharedRoot = resolve(getConfig().workspacePath);
  const root = userWorkspaceRoot(sharedRoot);
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const file = resolve(root, normalized);
  const withinRoot = relative(root, file);
  if (withinRoot === "" || !isWithin(root, file)) throw new UploadPathRefusedError(relativePath, "it is not a file in your own workspace");
  // Under multi-user auth a caller without an identity resolves at the shared root, where users/
  // holds every account's root, so a path there names another account's file. No caller today gets
  // here without one (review 2026-10-12); this fails closed for the next that does, and leaves an
  // identity-less run its own shared-root files. The test reads the RESOLVED path: the first
  // segment as written let `uploads/../users/<B>/...` through, which resolve() then turned into B's
  // file. Case-insensitively, since a Docker Desktop bind is, and `Users/` is the same directory.
  const firstSegment = withinRoot.split(sep)[0];
  if (firstSegment?.toLowerCase() === USERS_SUBDIR && !segmentFor() && multiUserAuthActive()) {
    throw new UploadPathRefusedError(relativePath, "no signed-in account owns a path under users/");
  }
  // Loaded on use: the denylist lives with the file tools, which this store must not load eagerly.
  const { isSensitiveWorkspacePath } = await import("../tools/filesystem.js");
  if (isSensitiveWorkspacePath(withinRoot)) throw new UploadPathRefusedError(relativePath, "it names protected workspace data");
  return { key: toKey(sharedRoot, file), file };
}

/**
 * The local file of a key the server recorded itself (the document registry's storeKey), checked
 * again before use: a normalized key inside the shared root that names nothing read_file refuses.
 * Throws when not.
 */
async function recordedKeyFile(storeKey: string): Promise<{ key: string; file: string }> {
  const sharedRoot = resolve(getConfig().workspacePath);
  const file = resolve(sharedRoot, storeKey);
  const key = toKey(sharedRoot, file);
  if (key === "" || key !== storeKey || !isWithin(sharedRoot, file)) throw new UploadPathRefusedError(storeKey, "it is not a store key");
  const { isSensitiveWorkspacePath } = await import("../tools/filesystem.js");
  if (isSensitiveWorkspacePath(key)) throw new UploadPathRefusedError(storeKey, "it names protected workspace data");
  return { key, file };
}

/** The root of the namespace a key lies in: `<shared>/users/<segment>` for a per-user key. */
function namespaceRootOf(key: string): string {
  const sharedRoot = resolve(getConfig().workspacePath);
  const [top, segment] = key.split("/");
  return top === USERS_SUBDIR && segment ? resolve(sharedRoot, USERS_SUBDIR, segment) : sharedRoot;
}

/**
 * A local file read through the store must be what its key says. A link inside the caller's root
 * that points into another account's root would read that account's file under the caller's key,
 * so the real path has to stay inside the key's namespace, and be nothing read_file refuses there.
 */
async function realFileAllowed(key: string, file: string): Promise<boolean> {
  const { realpath } = await import("node:fs/promises");
  try {
    const realRoot = await realpath(namespaceRootOf(key));
    const realFile = await realpath(file);
    if (!isWithin(realRoot, realFile)) return false;
    const { isSensitiveWorkspacePath } = await import("../tools/filesystem.js");
    return !isSensitiveWorkspacePath(relative(realRoot, realFile));
  } catch {
    return false;   // missing: nothing to read
  }
}

/**
 * Whether `dir`, or the nearest of its ancestors that exists, really lies inside the key's
 * namespace. A namespace root that does not exist yet holds nothing, so no link either.
 */
async function realDirWithin(key: string, dir: string): Promise<boolean> {
  const { realpath } = await import("node:fs/promises");
  const root = namespaceRootOf(key);
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return true;
  }
  for (let probe = dir; isWithin(root, probe); probe = dirname(probe)) {
    try {
      return isWithin(realRoot, await realpath(probe));
    } catch { /* not there yet: the nearest ancestor that is decides */ }
    if (probe === root) break;
  }
  return false;
}

let _s3: S3Client | null = null;
let _s3Key = "";

async function s3Client(): Promise<S3Client> {
  const s3 = getConfig().storage.s3;
  const cacheKey = `${s3.endpoint ?? ""}|${s3.region}|${s3.bucket}|${s3.forcePathStyle}`;
  if (_s3 && _s3Key === cacheKey) return _s3;
  const { S3Client } = await import("@aws-sdk/client-s3");
  const accessKeyId = s3.accessKeyId ? resolveSecretRef(s3.accessKeyId) : undefined;
  const secretAccessKey = s3.secretAccessKey ? resolveSecretRef(s3.secretAccessKey) : undefined;
  _s3 = new S3Client({
    region: s3.region,
    forcePathStyle: s3.forcePathStyle,
    ...(s3.endpoint ? { endpoint: s3.endpoint } : {}),
    // Explicit keys when configured; otherwise fall back to the default AWS
    // credential chain (env AWS_* / instance role) so real-AWS just works.
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  });
  _s3Key = cacheKey;
  return _s3;
}

/** True when uploads are stored in S3 (vs the local disk). */
export function usingS3(): boolean {
  return getConfig().storage.backend === "s3";
}

/**
 * Ensure the upload bucket exists (idempotent). SeaweedFS starts with no buckets,
 * so first-run creates it. Best-effort — logs and continues on failure.
 */
export async function ensureUploadBucket(): Promise<void> {
  if (!usingS3()) return;
  const { HeadBucketCommand, CreateBucketCommand } = await import("@aws-sdk/client-s3");
  const s3 = await s3Client();
  const Bucket = getConfig().storage.s3.bucket;
  try {
    await s3.send(new HeadBucketCommand({ Bucket }));
  } catch {
    try {
      await s3.send(new CreateBucketCommand({ Bucket }));
      log.info({ Bucket }, "Created upload bucket");
    } catch (err) {
      log.warn({ Bucket, err: err instanceof Error ? err.message : String(err) }, "Could not ensure upload bucket");
    }
  }
}

/**
 * Store an upload at `relativePath` in the caller's own root, and return the store key it went
 * to (record that, not the path, wherever the file is looked up later on someone's behalf).
 * Throws UploadPathRefusedError for a path the caller may not store at.
 */
export async function putUpload(relativePath: string, bytes: Uint8Array, contentType: string): Promise<string> {
  const { key, file } = await callerUploadKey(relativePath);
  if (usingS3()) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = await s3Client();
    await s3.send(new PutObjectCommand({ Bucket: getConfig().storage.s3.bucket, Key: key, Body: bytes, ContentType: contentType }));
    return key;
  }
  const { writeFile, mkdir, lstat } = await import("node:fs/promises");
  // A directory on the way that is a link would carry the write, and the mkdir before it, into
  // whatever it points at; a link at the name itself would be written through.
  if (!await realDirWithin(key, dirname(file))) throw new UploadPathRefusedError(relativePath, "it leads out of your own workspace");
  await mkdir(dirname(file), { recursive: true });
  const existing = await lstat(file).catch(() => null);
  if (existing?.isSymbolicLink()) throw new UploadPathRefusedError(relativePath, "it is a link");
  await writeFile(file, bytes);
  return key;
}

async function readStored(key: string, file: string): Promise<Uint8Array | null> {
  if (usingS3()) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = await s3Client();
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: getConfig().storage.s3.bucket, Key: key }));
      const bytes = await res.Body?.transformToByteArray();
      return bytes ? new Uint8Array(bytes) : null;
    } catch {
      return null;
    }
  }
  if (!await realFileAllowed(key, file)) return null;
  const { readFile } = await import("node:fs/promises");
  try {
    return new Uint8Array(await readFile(file));
  } catch {
    return null;
  }
}

async function deleteStored(key: string, file: string): Promise<void> {
  if (usingS3()) {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = await s3Client();
    try { await s3.send(new DeleteObjectCommand({ Bucket: getConfig().storage.s3.bucket, Key: key })); } catch { /* ignore */ }
    return;
  }
  // unlink removes a link at the name itself, never what it points at, but a linked directory on
  // the way is followed like any other.
  if (!await realDirWithin(key, dirname(file))) return;
  const { unlink } = await import("node:fs/promises");
  try { await unlink(file); } catch { /* ignore */ }
}

/**
 * Fetch the upload at `relativePath` in the caller's own root. Null when it doesn't exist, and
 * for a path the caller may not read: a refusal answers the same as a miss, so a probe for
 * another account's file learns nothing from it.
 */
export async function getUpload(relativePath: string): Promise<Uint8Array | null> {
  let location: { key: string; file: string };
  try {
    location = await callerUploadKey(relativePath);
  } catch (err) {
    log.warn({ path: relativePath, err: err instanceof Error ? err.message : String(err) }, "Refused an upload read: not a path in the caller's own namespace, or protected");
    return null;
  }
  return readStored(location.key, location.file);
}

/** Fetch an upload by a store key the server recorded (putUpload's return). Null when missing. */
export async function getUploadByStoreKey(storeKey: string): Promise<Uint8Array | null> {
  try {
    const { key, file } = await recordedKeyFile(storeKey);
    return await readStored(key, file);
  } catch {
    return null;
  }
}

/** Delete the upload at `relativePath` in the caller's own root. Best-effort (idempotent). */
export async function deleteUpload(relativePath: string): Promise<void> {
  try {
    const { key, file } = await callerUploadKey(relativePath);
    await deleteStored(key, file);
  } catch { /* refused or gone: nothing of the caller's to delete */ }
}

/** Delete an upload by a store key the server recorded. Best-effort (idempotent). */
export async function deleteUploadByStoreKey(storeKey: string): Promise<void> {
  try {
    const { key, file } = await recordedKeyFile(storeKey);
    await deleteStored(key, file);
  } catch { /* not a store key: nothing to delete */ }
}

/** Test-only: drop the cached S3 client. */
export function _resetObjectStoreForTests(): void {
  _s3 = null;
  _s3Key = "";
}
