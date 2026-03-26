# Message Channels

<p align="center">
  <img src="../swarmLogo.svg" alt="StarlingAI logo" width="180" />
</p>

StarlingAI is a general-purpose agent swarm reachable from multiple communication channels. Each channel is an entry point into the swarm — the same set of specialist agents, routing, tools, and guardrails serve every channel. This multi-channel resilience follows the swarm principle of robustness: the system remains functional even if individual channels fail.

StarlingAI has one built-in local channel plus a set of configurable external channel runtimes.

See also: [Channel Setup Guide](channel-setup.md) · [Security Model](security.md) · [REST API](api.md)

## Current Support Matrix

| Channel | Config Key | Runtime State |
| --- | --- | --- |
| Web dashboard chat | `channels.webchat` | built-in |
| Telegram | `channels.telegram` | supported |
| Slack | `channels.slack` | supported |
| Discord | `channels.discord` | supported |
| WhatsApp | `channels.whatsapp` | supported |
| Email | `channels.email` | supported |
| Signal | `channels.signal` | supported via `signal-cli` polling |

The dashboard channel management API covers the external runtimes, not the built-in webchat transport.

## Shared Runtime Fields

Slack, Discord, WhatsApp, Email, and Signal all share the same base channel fields:

- `enabled`
- `dmPolicy`
- `allowFrom`
- `historyLimit`
- `perSenderRateLimitCount`
- `perSenderRateLimitWindowMs`

Telegram is a special case: it exposes `allowedUserIds` instead of `allowFrom`.

## `dmPolicy`

| Value | Meaning |
| --- | --- |
| `open` | accept messages from any sender |
| `allowlist` | only accept senders in `allowFrom` |
| `pairing` | require a pairing flow before messages are accepted |
| `disabled` | reject inbound traffic while preserving config |

Pairing state is stored in the encrypted credential store.

## Per-Sender Rate Limiting

Per-channel inbound throttling is configured with:

```jsonc
"slack": {
  "enabled": true,
  "dmPolicy": "pairing",
  "perSenderRateLimitCount": 12,
  "perSenderRateLimitWindowMs": 60000
}
```

These checks are separate from the broader session and tool rate limits enforced by the runtime.

## Runtime Status API

`GET /api/channels` returns one status object per known external channel type. Fields include:

- `type`
- `enabled`
- `running`
- `supported`
- `reason`
- `error`
- `health`
- `metrics`

`health` includes:

- `healthy`
- `latencyMs`
- `error`
- `checkedAt`

`metrics` includes:

- `delivered`
- `deliveryFailures`
- `ingressDenied`
- `lastDeliveryError`
- `lastIngressDeniedAt`

## Dead-Letter Queue

Failed outbound deliveries are appended to `.starlingai/dead-letters.ndjson` in local development or the Docker-mounted data volume in containerized runs.

Use:

```text
GET /api/channels/dead-letters
```

That endpoint returns both the total `count` and the last 50 parsed `entries`.

## Delivery Retries

Outbound delivery uses exponential backoff through `packages/core/src/channels/delivery.ts`:

- 3 attempts
- 1 second base delay
- jitter on retries
- dead-letter fallback after the final failure

## Security Verification

- Slack inbound events are signature-checked against the signing secret.
- WhatsApp inbound events are verified against `X-Hub-Signature-256` using `appSecret`.
- Unauthorized or malformed inbound traffic is rejected before any agent turn starts.

## Email Configuration Shape

Email uses flat fields in the current schema, not nested `imap` and `smtp` objects:

```jsonc
"email": {
  "enabled": true,
  "imapHost": "imap.example.com",
  "imapPort": 993,
  "imapUser": "$EMAIL_IMAP_USER",
  "imapPassword": "$EMAIL_IMAP_PASSWORD",
  "smtpHost": "smtp.example.com",
  "smtpPort": 587,
  "smtpUser": "$EMAIL_SMTP_USER",
  "smtpPassword": "$EMAIL_SMTP_PASSWORD",
  "smtpFrom": "StarlingAI <bot@example.com>",
  "pollIntervalMs": 30000,
  "dmPolicy": "allowlist",
  "allowFrom": ["ops@example.com"]
}
```

## Runtime Configuration Management

Dashboard and API writes use these endpoints:

- `GET /api/channels/:type`
- `PUT /api/channels/:type`
- `DELETE /api/channels/:type`

Stored overrides are merged over `starlingai.json`, secrets are redacted on reads, and the runtime reconciler reloads the affected adapter.
