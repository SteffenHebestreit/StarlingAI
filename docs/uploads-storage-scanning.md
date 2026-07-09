# Upload storage & malware scanning

Every file uploaded to StarlingAI (the document library and chat attachments) is
**virus-scanned, then stored** in an S3-compatible object store. Both are bundled
and **on by default**.

## Flow

```
upload ──► ClamAV scan ──► [clean] ──► object store ──► ingest / use as context
                       └──► [infected]  → 422 rejected (never stored)
                       └──► [scanner down] → 503 rejected (fail-closed)
```

- Scanning is **synchronous** — the request waits for the verdict. An infected
  file is rejected (`422`) and never stored or ingested; if the scanner is
  unreachable the upload is rejected too (`503`, fail-closed) rather than storing
  bytes unscanned. Rejections are audited (`upload_infected` / `upload_scan_failed`).
- Storage is **S3-compatible**: the bundled SeaweedFS by default, or **real AWS
  S3** by pointing config at your bucket — same API, drop-in swap. `local` keeps
  files on the gateway's disk (the legacy behaviour).

## Bundled services

`docker compose up` brings up:

- **`seaweedfs`** — S3-compatible object storage on `:8333` (internal-only, never
  published). Credentials live in `docker/seaweedfs/s3-config.json`.
- **`clamav`** — `clamd` on `:3310`. Its signature database (~1 GB) downloads on
  first start, so it's **~1–2 minutes before scans succeed** — uploads fail closed
  (503) until then, then work. ClamAV holds the DB in RAM (~2 GB `mem_limit`).

## Configuration

Everything is env-driven (`.env` / config `storage`):

| Env | Default | Meaning |
|---|---|---|
| `SAI_STORAGE_BACKEND` | `s3` | `s3` or `local` |
| `SAI_S3_ENDPOINT` | `http://seaweedfs:8333` | leave **empty** for real AWS S3 |
| `SAI_S3_REGION` / `SAI_S3_BUCKET` | `us-east-1` / `starlingai-uploads` | |
| `SAI_S3_ACCESS_KEY_ID` / `SAI_S3_SECRET_ACCESS_KEY` | dev creds | **change for production** |
| `SAI_S3_FORCE_PATH_STYLE` | `true` | `true` for SeaweedFS/MinIO, `false` for AWS S3 |
| `SAI_UPLOAD_SCAN` | `true` | `false` to disable ClamAV scanning |
| `SAI_CLAMD_HOST` / `SAI_CLAMD_PORT` | `clamav` / `3310` | |

Keys are stored as `$ENV` references, never inlined into the compiled config.

### Switch to real AWS S3

```bash
SAI_S3_ENDPOINT=                       # empty → the AWS default endpoint
SAI_S3_REGION=eu-central-1
SAI_S3_BUCKET=my-starlingai-uploads
SAI_S3_ACCESS_KEY_ID=AKIA...           # or leave the keys unset to use the
SAI_S3_SECRET_ACCESS_KEY=...           # instance role / AWS default credential chain
SAI_S3_FORCE_PATH_STYLE=false
```

Then drop the bundled `seaweedfs` service — nothing else changes.

## Production notes

- Change the SeaweedFS dev credentials (both `docker/seaweedfs/s3-config.json` and
  `SAI_S3_*`), or use real AWS S3.
- ClamAV keeps its signatures fresh via the image's built-in `freshclam`; the DB
  persists across restarts in the `gc-clamav-data` volume.
- Large files skip the scan above `storage.scan.maxScanBytes` (default 100 MB);
  keep it in step with clamd's `StreamMaxLength`.
