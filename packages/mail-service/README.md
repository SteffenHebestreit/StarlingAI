# @starlingai/mail-service

Standalone HTTP service that gives the swarm access to email (IMAP/SMTP), calendars (CalDAV), and contacts (CardDAV). Runs as its own container so the gateway never holds IMAP/SMTP/DAV sockets directly.

## What this service does

The mail-service is a thin HTTP facade over per-account IMAP/SMTP/CalDAV/CardDAV clients. The gateway's `mail_agent` (and any other agent with the appropriate tool tier) calls this service instead of talking to providers directly. That keeps:

- **Credentials out of the gateway's process space** — account passwords live only in the mail-service's config.
- **Connection state local** — IMAP sessions, SMTP pools, DAV caches are owned by this service and don't have to survive gateway restarts.
- **Provider churn isolated** — adding Gmail OAuth, Outlook, or iCloud quirks doesn't touch the gateway.

## HTTP API

Base URL: `http://${host}:${port}` — default `http://0.0.0.0:5020`.

Auth (optional): set `SAI_MAIL_SERVICE_TOKEN`; clients pass `Authorization: Bearer <token>`. When unset, the service runs unauthenticated (only safe on a private Docker network).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness probe; returns `{ ok: true, accounts: <count> }` |
| `GET` | `/api/accounts` | List configured email accounts |
| `GET` | `/api/accounts/:accountId/mailboxes` | List IMAP folders |
| `POST` | `/api/mailboxes` | Create a folder |
| `DELETE` | `/api/mailboxes` | Delete a folder |
| `POST` | `/api/messages/search` | IMAP search with limit and filters |
| `POST` | `/api/messages/read` | Fetch full message(s) with attachments |
| `POST` | `/api/messages/move` | Bulk move to another mailbox |
| `POST` | `/api/messages/delete` | Bulk delete (soft or hard) |
| `POST` | `/api/messages/categorize` | Apply custom tag metadata |
| `POST` | `/api/drafts` | Create a draft; returns a UUID |
| `GET` | `/api/drafts/:draftId` | Fetch a draft |
| `PATCH` | `/api/drafts/:draftId` | Update draft fields |
| `POST` | `/api/drafts/:draftId/send` | Send via SMTP |
| `GET` | `/api/calendar/:accountId/calendars` | List CalDAV calendars |
| `POST` | `/api/calendar/events/list` | Range query for events |
| `POST` / `PUT` / `DELETE` | `/api/calendar/events` | Event CRUD |
| `GET` | `/api/contacts/:accountId/addressbooks` | List CardDAV address books |
| `POST` | `/api/contacts/list` | Search/list contacts |
| `POST` / `PUT` / `DELETE` | `/api/contacts` | Contact CRUD |

All routes validate their payloads with Zod. The full OpenAPI spec lives in [`specs/mail-service.openapi.yaml`](../../specs/mail-service.openapi.yaml).

## Configuration

The service is configured through two channels:

- **Accounts file** — a JSON/JSON5 document pointed at by `SAI_MAIL_SERVICE_CONFIG_PATH` (default: `/config/mail/accounts.json`). Only account definitions live here.
- **Runtime environment variables** — host, port, data path, and auth token come from the process environment, not the accounts file.

### Accounts file

```jsonc
{
  "accounts": [
    {
      "id": "work",
      "address": "alice@example.com",
      "displayName": "Work email",
      "imap": {
        "host": "imap.example.com",
        "port": 993,
        "secure": true,
        "user": "$WORK_IMAP_USER",
        "pass": "$WORK_IMAP_PASS"
      },
      "smtp": {
        "host": "smtp.example.com",
        "port": 587,
        "secure": false,
        "user": "$WORK_SMTP_USER",
        "pass": "$WORK_SMTP_PASS",
        "from": "Alice <alice@example.com>"
      },
      "caldav": {
        "serverUrl": "https://dav.example.com/cal/work",
        "username": "$WORK_DAV_USER",
        "password": "$WORK_DAV_PASS"
      },
      "carddav": {
        "serverUrl": "https://dav.example.com/card/work",
        "username": "$WORK_DAV_USER",
        "password": "$WORK_DAV_PASS"
      }
    }
  ]
}
```

- Any string value prefixed with `$` is resolved against the process environment at load time — use this to keep secrets out of the config file.
- `caldav` and `carddav` are optional. Accounts without them return `422` from the matching routes.
- `imap.port` defaults to `993` / `secure: true`; `smtp.port` defaults to `587` / `secure: false` (STARTTLS).

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `SAI_MAIL_SERVICE_CONFIG_PATH` | `/config/mail/accounts.json` | Path to the accounts file |
| `HOST` | `0.0.0.0` | Bind address |
| `PORT` | `5020` | Listen port |
| `SAI_MAIL_SERVICE_DATA_PATH` | `/data/mail-service.json` | File (not directory) where drafts and category metadata are persisted. Mount its parent as a volume in Docker. |
| `SAI_MAIL_SERVICE_TOKEN` | *(unset)* | When set, every request must carry `Authorization: Bearer <token>` |

## Source layout

| File | Responsibility |
|---|---|
| `src/index.ts` | Entrypoint — loads config, starts Hono server |
| `src/app.ts` | Hono app wiring; mounts account, message, draft, calendar, contacts routes |
| `src/config.ts` | Config loader + Zod schema; env-var reference resolution |
| `src/imap-client.ts` | IMAP session pool (via imapflow) |
| `src/smtp-client.ts` | SMTP transport (via nodemailer) |
| `src/dav-client.ts` | CalDAV + CardDAV client (via tsdav) |
| `src/calendar-routes.ts` | Calendar HTTP handlers |
| `src/contacts-routes.ts` | Contacts HTTP handlers |
| `src/draft-store.ts` | Local draft persistence (disk-backed) |
| `src/email-parser.ts` | mailparser wrapper; address/header normalization |
| `src/query-parser.ts` | Shared search-query AST |
| `src/logger.ts` | pino child logger |
| `src/types.ts` | Shared request/response types |

## Running locally

```bash
# In the package directory
pnpm dev             # tsx watch against src/index.ts
pnpm start           # run the built dist/index.js

# From the repo root — the mail-service is part of the default Compose stack
pnpm sai start
```

## Testing

```bash
pnpm test            # vitest suite
pnpm check           # tsc --noEmit
```

For a live smoke test against a real mailbox, see `scripts/mail-smoke.mjs` in the repo root.

## Further reading

- [docs/mail-service.md](../../docs/mail-service.md) — architecture, wire-level examples, and failure-mode notes
