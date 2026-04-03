# Mail Service Design

## Goals

- Provide a headless mail service for agents.
- Support multiple mail addresses/accounts from the start.
- Separate mailbox access from approval policy.
- Allow agents to read, search, summarize, categorize, draft, and send mail.
- Require explicit approval for every draft send.

## Architecture

The mail stack has three layers:

1. Standalone mail library
   - IMAP mailbox discovery and search
   - message parsing and normalization
   - SMTP draft send
   - file-backed state for drafts and categories

2. Headless mail service container
   - REST API over the standalone library
   - multi-account routing
   - optional bearer token auth
   - no UI and no approval UX

3. StarlingAI tool layer
   - calls the mail service over HTTP
   - exposes agent-safe tools
   - enforces per-call approval on send via tool tiers
   - streams tool results to the UI for on-the-fly visualization

Approval is enforced in StarlingAI, not delegated to the mail service. The service is a capability backend; the gateway decides whether a send is allowed.

## Multi-Account Model

Every configured mailbox account has a stable `accountId`.

Read operations:

- may target one `accountId`
- may target multiple `accountIds`
- default to all configured accounts when omitted

Write operations:

- always require exactly one `accountId`
- drafts belong to one account
- sending uses the SMTP identity of the draft's account

Message identity is mailbox-scoped. A message reference is the triple:

- `accountId`
- `mailbox`
- `uid`

Categories are local service metadata and are keyed by that triple.

## Account Config

The service reads a config file with multiple accounts.

Example shape:

```json
{
  "accounts": [
    {
      "id": "personal",
      "address": "me@example.com",
      "displayName": "Personal",
      "imap": {
        "host": "imap.example.com",
        "port": 993,
        "secure": true,
        "user": "$MAIL_PERSONAL_USER",
        "pass": "$MAIL_PERSONAL_PASS"
      },
      "smtp": {
        "host": "smtp.example.com",
        "port": 587,
        "secure": false,
        "user": "$MAIL_PERSONAL_USER",
        "pass": "$MAIL_PERSONAL_PASS",
        "from": "Me <me@example.com>"
      }
    }
  ]
}
```

## REST API

### `GET /health`

Returns service health and configured account count.

### `GET /api/accounts`

Lists configured accounts:

- `id`
- `address`
- `displayName`

### `GET /api/accounts/:accountId/mailboxes`

Lists available mailboxes for one account.

### `POST /api/messages/search`

Body:

```json
{
  "accountIds": ["work", "personal"],
  "mailboxes": ["INBOX"],
  "query": "is:unread from:billing@example.com",
  "limit": 50
}
```

Returns normalized message summaries across one or many accounts.

Each summary includes:

- `accountId`
- `mailbox`
- `uid`
- `messageId`
- `from`
- `to`
- `cc`
- `subject`
- `date`
- `attachmentCount`
- `categories`
- `textPreview`

### `POST /api/messages/read`

Body:

```json
{
  "accountId": "work",
  "mailbox": "INBOX",
  "uid": 12345
}
```

Returns a full normalized message record, including body and attachment metadata.

### `POST /api/messages/categorize`

Body:

```json
{
  "items": [
    {
      "accountId": "work",
      "mailbox": "INBOX",
      "uid": 12345,
      "category": "finance",
      "note": "Invoice for March"
    }
  ]
}
```

Persists local category metadata.

### `POST /api/drafts`

Creates a draft.

Body:

```json
{
  "accountId": "work",
  "to": ["team@example.com"],
  "cc": [],
  "bcc": [],
  "subject": "Draft subject",
  "textBody": "Plain text body",
  "htmlBody": "<p>Optional HTML</p>",
  "replyTo": {
    "accountId": "work",
    "mailbox": "INBOX",
    "uid": 12345
  }
}
```

Returns the stored draft.

### `GET /api/drafts/:draftId`

Returns one stored draft.

### `PATCH /api/drafts/:draftId`

Updates draft fields.

### `POST /api/drafts/:draftId/send`

Sends the draft via the configured SMTP account.

This endpoint itself does not provide user approval UX. StarlingAI must only call it from a tool that always requires per-call approval.

## Agent Tools

The core gateway should expose these tools:

- `mail_list_accounts`
- `mail_list_mailboxes`
- `mail_search`
- `mail_read`
- `mail_list_unread`
- `mail_prepare_draft`
- `mail_update_draft`
- `mail_get_draft`
- `mail_categorize`
- `mail_send_draft`

Tool tier policy:

- read tools: Tier 0
- draft create/update/categorize: Tier 1
- `mail_send_draft`: Tier 3 with mandatory per-call approval

## Mail Agent

Add a dedicated `mail_agent` sub-agent with these responsibilities:

- triage inboxes across multiple accounts
- summarize important unread messages
- prepare replies and outbound drafts
- categorize messages for follow-up
- never send without explicit approval

Allowed tools:

- `mail_list_accounts`
- `mail_list_mailboxes`
- `mail_search`
- `mail_read`
- `mail_list_unread`
- `mail_prepare_draft`
- `mail_update_draft`
- `mail_get_draft`
- `mail_categorize`
- `mail_send_draft`
- `read_shared_facts`
- `share_finding`

## Runtime Notes

- Service state is stored under `/data` in the container.
- Account credentials come from env-expanded values in the mounted config file.
- UI visualization stays in the gateway/web app by rendering tool output, approval prompts, and draft previews dynamically.