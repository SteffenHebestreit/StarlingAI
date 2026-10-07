# E2E test environment

Two small, synthetic, deterministic services the end-to-end suite runs against, started and
stopped next to the running stack without touching it:

| Service | What it is | Inside the stack | On the host (harness) |
|---|---|---|---|
| `e2e-mail` | [GreenMail](https://greenmail-mail-test.github.io/greenmail/) 2.1.14: SMTP + IMAP + REST API, the mailbox of the eval account | `e2e-mail:3025` (SMTP), `e2e-mail:3143` (IMAP), `e2e-mail:8080` (API) | `localhost:13025` (SMTP), `localhost:13143` (IMAP), `http://localhost:18080` (API) |
| `e2e-site` | nginx serving [`site/`](site/) read-only: the fictional company *Nordlicht Werkzeuge GmbH* | `http://www.nordlicht-werkzeuge.test/` | `http://localhost:18081/` |

Both are defined in [`docker-compose.e2e.yml`](../../docker-compose.e2e.yml) behind the `e2e` profile (so
`sai start` never starts them), join the stack's networks, publish their ports on `127.0.0.1` only, and
keep no state on disk: GreenMail holds its mail in memory, the site is static files.

Everything is synthetic: `e2e.test` and `nordlicht-werkzeuge.test` are reserved test domains, the company,
its managing director (the placeholder name Erika Mustermann), address (00000 Polarstadt) and phone numbers
(`+49 000 …`) do not exist, and GreenMail never relays a message anywhere.

## Commands

```bash
pnpm sai start            # the stack must be running; the test services join its networks
pnpm e2e:env up           # start both services, switch their config on (below), print the status
pnpm e2e:env status       # what is up and usable (exit 1 while anything is missing); --json for the harness
pnpm e2e:env down         # switch the config off, stop and remove both services
```

`pnpm e2e:env` ([`scripts/e2e-env.mjs`](../../scripts/e2e-env.mjs)) works in the stack's own compose
project (read from the running gateway container) and names only `e2e-mail` and `e2e-site` in every compose
command: it never runs `compose down`, never stops, recreates or rebuilds a stack service, and never removes a
network or volume. `up` and `down` are idempotent.

What `up` switches on, and `down` switches off again:

| File (gitignored, generated) | Effect |
|---|---|
| `config/mail/accounts.d/e2e.json5` — a copy of [`env/mail-accounts.json5`](env/mail-accounts.json5) | The running mail-service adds the account `eval` (`eval@e2e.test`, GreenMail) within ~2 s, no restart |
| `config/gateway/90-e2e.local.jsonc` | `guardrails.allowedPrivateHosts` gains `www.nordlicht-werkzeuge.test`; `up` then runs `sai config build`, and the gateway hot-reloads `starlingai.json` |

Before rebuilding, `up` copies every `allowedPrivateHosts` entry the other shards configure into its own
shard (arrays replace on merge, so nothing configured elsewhere is dropped), and after the build it checks
the compiled list. Both commands print which config paths the rebuild changed — only
`guardrails.allowedPrivateHosts` is expected; anything else means shard edits were pending before the run.

### One-time prerequisite: current images

The environment relies on two features the running images must carry. The user rebuilds images
(`pnpm sai start --build`); `pnpm e2e:env` never does. `status` checks the baked code of the running
containers and says when one is too old:

- **mail-service**: the accounts overlay directory (`config/mail/accounts.d/`, re-read while running) and
  `isolatedUsers`. With an older image the eval account is not loaded.
- **gateway**: `guardrails.allowedPrivateHosts`. With an older image the SSRF guard still refuses the site.

## Mail: how agents reach the eval mailbox

```
agent mail tool (mail_search, mail_read, mail_prepare_draft, mail_send_draft, …)
  → gateway (forwards the signed-in user as X-Sai-User: eval)
  → mail-service (account "eval" from config/mail/accounts.d/e2e.json5)
  → GreenMail e2e-mail:3143 (IMAP) / e2e-mail:3025 (SMTP)
```

- The account is bound to the user `eval` (`allowedUsers`): no other user sees or uses it.
- `isolatedUsers: ["eval", "eval-viewer"]` withholds every **shared** account (one without `allowedUsers`)
  from the eval identities, so an eval turn can never read or send from the operator's real mailboxes —
  without it, `eval` would see every shared account of `config/mail/accounts.json`. `status` reports how many
  other accounts `eval` can see; it must be 0.
- `config/mail/accounts.json` (the operator's real accounts) is never read or written by any of this.
- Credentials (synthetic): login `eval@e2e.test`, password `e2e-test-mailbox`. GreenMail runs with
  authentication on, so a wrong password fails as it would against a real server. Delivering mail to it over
  SMTP needs no login.
- GreenMail is a sink: it accepts mail for any recipient and stores it in a mailbox of that address, created
  when the first message arrives. A reply the agent "sends" to `vertrieb@nordlicht-werkzeuge.test` lands in
  GreenMail's mailbox for that address and nowhere else.
- Only `INBOX` exists at first; the mail-service sends without keeping a copy in a Sent folder. Folders an
  agent creates (`mail_create_mailbox`) live until GreenMail restarts.
- Drafts the eval account prepares are kept in the mail-service's own draft store, bound to account `eval`
  (no other user can open them).

### The harness `mail` step (scenario contract: `kind: "mail"`)

| Action | How |
|---|---|
| `deliver` | SMTP to `localhost:13025`, `To: eval@e2e.test`, any `From` |
| `expect` | `GET http://localhost:18080/api/user/{to}/messages/INBOX` → `[{ uid, Message-ID, subject, contentType, mimeMessage }]`. `mimeMessage` is the raw RFC 822 source: decode quoted-printable/base64 parts before matching body text with umlauts. An address that never received mail answers `400 {"message":"User '…' not found"}` — that is zero messages. Default recipient: `eval@e2e.test`. |
| `clear` | `POST http://localhost:18080/api/mail/purge` (all messages of all mailboxes; users stay). `POST /api/service/reset` restarts GreenMail from its start configuration. |

Other API calls: `GET /api/user` (mailboxes), `GET /api/service/readiness`, `GET /api/configuration`; the
OpenAPI description is at `http://localhost:18080/greenmail-openapi.yml`.

## Website: how agents reach it

Agents use `http://www.nordlicht-werkzeuge.test/`. That name is a network alias of `e2e-site` on the stack's
networks; it resolves to a private container address, which the SSRF guard (`packages/core/src/tools/web.ts`,
`hostIsBlocked`) refuses — except for exact names in `guardrails.allowedPrivateHosts`. That list:

- matches exact host names only (no wildcards, ports or IP literals);
- never opens a name the guard refuses literally (`localhost`, `*.internal`, the cloud-metadata names), nor a
  name that resolves to a loopback, link-local (incl. `169.254.169.254`) or unspecified address;
- applies to every caller of the shared guard: `web_fetch` (every redirect hop), `fetch_image`,
  `http_request`, the `browser_*` tools (`browser_navigate`) and the knowledge-base crawler. The data-feed
  tools (RSS) keep their own guard and still refuse the site.

Reach: tools run in the gateway process for the orchestrator and the in-process sub-agents — `researcher`,
`source_verifier`, `browser_agent`, `vision_browser_analyst` (all `container.disabled`); the browser itself
(Chrome in `browser-vnc`) resolves the name on the same networks. A sub-agent that runs **containerized**
(`agent-worker` on Docker's default bridge network, e.g. `api_integrator` while `agents.defaultContainerized`
is on) can neither resolve the name nor pass its own guard, so site scenarios should route to the agents
above.

### Pages

All pages are German, small, deterministic (no dates that move, no randomness, no external assets) and carry
a footer saying the company is fictional.

| Path | Content | Exercises |
|---|---|---|
| `/` (`/index.html`) | Company profile: founded 1987, 146 employees, 18 articles in 6 categories, 3 warehouses, managing director | Simple fact lookup |
| `/produkte/seite-1.html` … `seite-3.html` | Catalogue, 6 articles per page, prices incl. VAT, availability; `/produkte/` redirects (relative `302`) to page 1 | Pagination, aggregation across pages |
| `/preise.html` | Maintenance plans (feature matrix), volume discounts, shipping costs | Table reading, price calculations |
| `/lager.html` | Stock per warehouse (Nordhafen, Südtal, Westmark) and minimum stock for all 18 articles | Data-table extraction, sums, filters |
| `/dokumentation.html` | Short manual of the cordless screwdriver NW-AS 18 | Facts only knowable from the page |
| `/kontakt.html` | Contacts + order form (JavaScript only, nothing is sent) | Form filling; deterministic confirmation |
| `/lieferstatus.html` | Order status table that appears **4 s after load** (from `/daten/lieferstatus.json`) | Waiting for dynamic content |
| `/langsam.html` | Static page the server sends at ~300 bytes/s (**~7 s**) | Slow responses, timeouts |
| `/impressum.html` | Fictional legal notice | Fact lookup |
| `/robots.txt` | Allows everything | Crawler |
| `/healthz` | `ok` (healthcheck) | — |

### Ground truth

Derived from the served pages (re-derive after editing `site/`):

- **Catalogue**: 18 articles — Akkuwerkzeug 3, Handwerkzeug 2, Messwerkzeug 4, Werkstatt 3, Arbeitsschutz 3,
  Zubehör 3. Cheapest: NW-3102 Schutzbrille Klarsicht, 8,90 €. Most expensive: NW-2104 Werkstattwagen Eisberg
  (7 Schubladen), 459,00 € (page 2). Under 50 €: 8 articles (NW-1201, NW-1203, NW-2102, NW-3101, NW-3102,
  NW-3103, NW-3105, NW-3106). Sum of all list prices: 1.938,30 €. Sold out: NW-1203 only; "nur noch wenige auf
  Lager": NW-1103. Special offer only on page 3: NW-3106 Bit-Sortiment Aurora, 24,90 € instead of 32,90 €.
- **Prices & shipping**: maintenance plans Basis 9,90 € / Profi 24,90 € / Werkstatt 59,00 € per month
  (yearly prepayment: 10 monthly fees); response time 5 working days / 2 working days / 24 hours. Volume
  discount per article line: 10–24 → 5 %, 25–49 → 8 %, 50–99 → 12 %, from 100 → 15 %. Standard shipping
  5,90 €, free from 150,00 € goods value after discount; express 14,90 € always; freight (NW-2104, NW-2106)
  39,00 €, no express. Example: 30 × NW-3102 = 267,00 € − 8 % = 245,64 €, shipping free.
- **Stock** (as of 30.09.2026): warehouse totals Nordhafen 756, Südtal 596, Westmark 689. NW-1101 in total 82
  (most in Nordhafen, 42). Below minimum stock: NW-1103 (4 < 10), NW-1203 (0 < 20), NW-2104 (3 < 5), NW-2106
  (10 < 12). Largest total: NW-3102 (555).
- **Documentation (NW-AS 18)**: 21 torque levels + drill mode, factory setting level 7; 62 Nm hard / 28 Nm soft;
  NW-3104 on charger NW-LG 18: 0 → 80 % in 38 min, full in 61 min; error codes E17 battery too hot, E22 motor
  blocked, E31 firmware checksum, E45 battery communication; reset: hold "M" and "+" for 4 s until the LED
  blinks blue three times; firmware 3.2.1 released 12.03.2026; gearbox grease check every 150 operating hours;
  warranty 36 months if registered within 30 days, else 24.
- **Order form**: confirmation reference `NW-B-<article digits>-<quantity>-<S|E>` (e.g. 3 × NW-2104, standard
  shipping → `NW-B-2104-3-S`). Express for NW-2104/NW-2106 is refused with an error message; missing fields are
  listed in an error message.
- **Delivery status** (after 4 s): NW-A-2041 versandt, parcel NWP-7731-0042, expected 09.10.2026; NW-A-2042 in
  Bearbeitung; NW-A-2043 zugestellt am 02.10.2026.
- **Slow page**: customer portal maintenance every first Tuesday of the month, 02:00–04:00; last outage
  14.09.2026, 10:15–11:40, ticket NW-ST-0193.
- **Contacts**: vertrieb@nordlicht-werkzeuge.test, support@nordlicht-werkzeuge.test; Mon–Fri 8:00–16:30, Friday
  until 14:00.

## Which scenarios use it

Scenarios declare what they need in `requires` (scenario contract, `packages/core/src/e2e/scenario.ts`); the
runner skips — not fails — a scenario whose service is down:

- `requires: ["mail"]` — every scenario with a `kind: "mail"` step or a turn that reads, drafts or sends mail
  as `eval`: inbox triage, summarising a delivered message, drafting and sending a reply whose arrival the
  harness checks in GreenMail, and the guard scenarios that prove `eval` cannot reach another account.
- `requires: ["e2e-site"]` — browsing, research and scraping scenarios: facts from the documentation page,
  aggregation across the paginated catalogue, the stock table, calculations from the price page, filling the
  order form (check the reference code in the reply), waiting for the delivery status, the slow page, crawling
  the site into a knowledge base.

## Tear down

```bash
pnpm e2e:env down
```

deletes `config/mail/accounts.d/e2e.json5` and `config/gateway/90-e2e.local.jsonc`, rebuilds `starlingai.json`
(the gateway hot-reloads it, the mail-service drops the eval account within ~2 s), then stops and removes the
two containers. All mail in GreenMail is gone with it. `pnpm e2e:env status` afterwards shows every row as
absent. `pnpm sai stop` also removes the two containers (it includes the overlay), but leaves the two config
files in place — run `pnpm e2e:env down` to remove them.
