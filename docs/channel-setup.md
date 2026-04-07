# Channel Setup Guide

<p align="center">
  <img src="../assets/brand/swarmLogo.svg" alt="StarlingAI logo" width="180" />
</p>

StarlingAI supports the built-in web dashboard chat plus Telegram, Slack, Discord, WhatsApp, Email, and Signal channel runtimes.

---

## 1. Webchat (built-in, enabled by default)

No external setup required. The Vue frontend connects to the gateway over WebSocket and uses `POST /api/chat/stream` for token streaming.

```jsonc
"webchat": {
  "enabled": true,
  "port": 3001
}
```

**Optional hardening:**
```jsonc
"webchat": {
  "enabled": true,
  "port": 3001,
  "dmPolicy": "open",
  "allowFrom": [],
  "perSenderRateLimitCount": 20,
  "perSenderRateLimitWindowMs": 60000
}
```

---

## 2. Telegram

Uses the [Grammy](https://grammy.dev/) library. Long-polling — no public URL required.

### Step 1 — Create the bot
1. Open Telegram and message `@BotFather`
2. Send `/newbot` and follow the prompts
3. Copy the token (format: `123456789:AABBCCDDeeff...`)

### Step 2 — Find your user ID (optional, to restrict access)
Message `@userinfobot` on Telegram — it replies with your numeric user ID.

### Step 3 — Configure
```jsonc
"telegram": {
  "enabled": true,
  "botToken": "$TELEGRAM_BOT_TOKEN",
  "allowedUserIds": [123456789]   // leave [] for open access
}
```

### Step 4 — Set environment variable
```bash
# .env
TELEGRAM_BOT_TOKEN=123456789:AABBCCDDeeff...
```

### Commands
- `/start` — begin a new session
- `/reset` — clear conversation history

---

## 3. Discord

Uses the Discord Gateway WebSocket (long-running connection). No public URL or webhook needed.

### Step 1 — Create a bot at discord.com/developers
1. New Application → **Bot** tab → "Add Bot"
2. Under **Privileged Gateway Intents**, enable **Message Content Intent**
3. Copy the **Bot Token**

### Step 2 — Invite the bot to your server
1. OAuth2 → URL Generator → scopes: `bot`
2. Permissions: `Send Messages`, `Read Message History`
3. Visit the generated URL and invite to your server

### Step 3 — Get your server's Guild ID
Enable Developer Mode in Discord (Settings → Advanced), then right-click your server → **Copy Server ID**.

### Step 4 — Configure
```jsonc
"discord": {
  "enabled": true,
  "token": "$DISCORD_BOT_TOKEN",
  "guildIds": ["123456789012345678"],   // leave [] to allow all servers
  "dmPolicy": "pairing"
}
```

### Step 5 — Set environment variable
```bash
# .env
DISCORD_BOT_TOKEN=your-bot-token-here
```

### Usage
If `dmPolicy` is `"pairing"`, users must send `/pair <CODE>` where the code is printed in server logs at startup. Send `/reset` to clear session.

---

## 4. Slack

Uses the Events API — requires a public HTTPS endpoint (or an ngrok tunnel for local dev).

### Step 1 — Create a Slack app
1. Go to [api.slack.com/apps](https://api.slack.com/apps) → New App → From scratch
2. **OAuth & Permissions** → Bot Token Scopes — add:
   - `chat:write`
   - `channels:history`
   - `groups:history`
   - `im:history`
   - `mpim:history`
3. Install app to workspace → copy the **Bot User OAuth Token** (`xoxb-...`)
4. **Basic Information** → copy **Signing Secret**

### Step 2 — Expose the events endpoint
StarlingAI listens at `POST /channels/slack/events` on the gateway HTTP port (default `8765`). For local development use a tunnel:
```bash
ngrok http 8765
```

### Step 3 — Enable Event Subscriptions in Slack
1. App settings → **Event Subscriptions** → enable
2. Request URL: `https://<your-host>/channels/slack/events`
  - Slack sends a URL verification challenge that StarlingAI handles automatically
3. Subscribe to bot events: `message.channels`, `message.groups`, `message.im`, `message.mpim`
4. Save and reinstall the app

### Step 4 — Configure
```jsonc
"slack": {
  "enabled": true,
  "botToken": "$SLACK_BOT_TOKEN",
  "signingSecret": "$SLACK_SIGNING_SECRET",
  "dmPolicy": "pairing"
}
```

### Step 5 — Set environment variables
```bash
# .env
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
```

### Usage
If `dmPolicy` is `"pairing"`, DM the bot `/pair <CODE>` (code printed at startup). Send `/reset` to clear session.

---

## 5. WhatsApp

Uses the Meta Cloud API — requires a public HTTPS endpoint and a Meta Business account (test numbers are available without business verification).

### Step 1 — Create a Meta app
1. [developers.facebook.com](https://developers.facebook.com) → My Apps → Create App → Business type
2. Add **WhatsApp** product to the app
3. In **WhatsApp → Getting Started**, note the **Test phone number** and **Phone Number ID**
4. Generate a **Permanent Access Token** (or use the temporary token for dev)

### Step 2 — Configure the webhook
1. WhatsApp → Configuration → Webhook
2. Callback URL: `https://<your-host>/channels/whatsapp/webhook`
3. Verify Token: any secret string you choose — must match `verifyToken` in config below
4. Subscribe to webhook fields: `messages`

### Step 3 — Configure
```jsonc
"whatsapp": {
  "enabled": true,
  "accessToken": "$WHATSAPP_ACCESS_TOKEN",
  "phoneNumberId": "$WHATSAPP_PHONE_NUMBER_ID",
  "verifyToken": "$WHATSAPP_VERIFY_TOKEN",
  "appSecret": "$WHATSAPP_APP_SECRET",   // from Basic Information — used for signature verification
  "dmPolicy": "pairing"
}
```

### Step 4 — Set environment variables
```bash
# .env
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_VERIFY_TOKEN=your-chosen-secret
WHATSAPP_APP_SECRET=...
```

### Usage
Send `/pair <CODE>` to authorize (if `dmPolicy: "pairing"`). Code is logged at startup. Send `/reset` to clear session.

---

## 6. Email

Email uses IMAP polling plus SMTP replies.

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

Notes:

- `pollIntervalMs` defaults to 30000 ms.
- inbound HTML bodies are normalized before they reach the orchestrator.
- replies preserve thread headers when possible.

## 7. Signal

Signal uses `signal-cli` on the gateway host. StarlingAI polls `signal-cli receive` for inbound DMs and sends replies through `signal-cli send`.

### Step 1 — Install and link `signal-cli`
1. Install `signal-cli` on the same host where the gateway runs.
2. Link or register a dedicated Signal account.
3. Confirm the account appears in `signal-cli --output=json listAccounts`.

### Step 2 — Configure
```jsonc
"signal": {
  "enabled": true,
  "account": "+49123456789",
  "signalCliPath": "signal-cli",
  "dmPolicy": "pairing",
  "allowFrom": []
}
```

Notes:

- `account` must match the registered Signal number in international format.
- `signalCliPath` can point to a custom binary location when `signal-cli` is not on `PATH`.
- Pairing works the same way as Slack, Discord, and WhatsApp: the pairing code is logged at startup and users send `/pair CODE` in Signal.
- Signal is currently DM-oriented. Group messages are ignored by the adapter.

## Common config options

All channels (except webchat) support these base fields:

| Field | Default | Description |
|---|---|---|
| `dmPolicy` | `"pairing"` for most runtimes | `open`, `allowlist`, `pairing`, or `disabled` |
| `allowFrom` | `[]` | Sender IDs allowed under `allowlist` policy. Use `"*"` as wildcard |
| `perSenderRateLimitCount` | 12 | Max messages per sender per window |
| `perSenderRateLimitWindowMs` | 60000 | Rate limit window in milliseconds |
| `historyLimit` | 50 | Conversation history turns retained per session |

Telegram instead exposes `allowedUserIds` for sender restriction.

Channel configs can be updated at runtime via `PUT /api/channels/:type` and removed via `DELETE /api/channels/:type`. Stored overrides live in the encrypted credential store.
