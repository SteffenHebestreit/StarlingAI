/**
 * Upload object store — one interface over two backends, keyed by the same
 * `uploads/<scope>/<name>` relative path the handlers already use:
 *   - `storage.backend: "local"` → the gateway's disk under `<workspace>/<key>`
 *     (the legacy default; existing files stay readable).
 *   - `storage.backend: "s3"`    → any S3-compatible store via @aws-sdk/client-s3
 *     — the bundled SeaweedFS, or a real AWS S3 bucket (same API, drop-in swap).
 *
 * The AWS client is imported lazily so a `local` deployment never loads the SDK.
 */
import { getConfig } from "../config/loader.js";
import { childLogger } from "../logger.js";
import { resolveSecretRef } from "../tools/infrastructure-shared.js";
import type { S3Client } from "@aws-sdk/client-s3";

const log = childLogger("storage:object-store");

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

/** Store an upload at `key` (the relative path). */
export async function putUpload(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
  if (usingS3()) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = await s3Client();
    await s3.send(new PutObjectCommand({ Bucket: getConfig().storage.s3.bucket, Key: key, Body: bytes, ContentType: contentType }));
    return;
  }
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { join, dirname } = await import("node:path");
  const abs = join(getConfig().workspacePath, key);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
}

/** Fetch an upload by `key`. Null when it doesn't exist. */
export async function getUpload(key: string): Promise<Uint8Array | null> {
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
  const { readFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  try {
    return new Uint8Array(await readFile(join(getConfig().workspacePath, key)));
  } catch {
    return null;
  }
}

/** Delete an upload by `key`. Best-effort (idempotent). */
export async function deleteUpload(key: string): Promise<void> {
  if (usingS3()) {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const s3 = await s3Client();
    try { await s3.send(new DeleteObjectCommand({ Bucket: getConfig().storage.s3.bucket, Key: key })); } catch { /* ignore */ }
    return;
  }
  const { unlink } = await import("node:fs/promises");
  const { join } = await import("node:path");
  try { await unlink(join(getConfig().workspacePath, key)); } catch { /* ignore */ }
}

/** Test-only: drop the cached S3 client. */
export function _resetObjectStoreForTests(): void {
  _s3 = null;
  _s3Key = "";
}
