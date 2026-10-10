# Identity, SSO & A2A auth (OpenID Connect)

StarlingAI has a **pluggable identity backend**, chosen with `auth.provider`:

| `auth.provider` | What it does |
|---|---|
| `builtin` (default) | Username + password accounts in `auth.users[]`, managed in the dashboard. |
| `oidc` | Single sign-on via an external OpenID Connect provider (e.g. **Keycloak**). The login screen redirects to the IdP, the IdP's roles map to our `admin`/`operator`/`viewer`, and the gateway mints its own session JWT — so the rest of the system (RBAC, per-user isolation, A2A) is unchanged. Each IdP subject gets an account of its own, with an immutable id and a username frozen at its first sign-in ([below](#accounts-one-per-idp-subject)). |

The setup wizard asks which to use; you can also configure OIDC entirely from `.env` (the Docker-first path) or a config shard.

## Human SSO (login)

With `auth.provider: "oidc"`, the login screen shows **Sign in with SSO**:

1. `GET /api/auth/oidc/login` → PKCE authorization-code redirect to the IdP.
2. IdP authenticates the user → redirects back to `GET /api/auth/oidc/callback`.
3. The gateway exchanges the code, validates the ID token, maps roles, and mints our session JWT.
4. The token is handed to the SPA via the URL **fragment** (never the query — fragments aren't logged or sent to the server); the SPA stores it and connects.

### Configure via `.env`

```bash
SAI_AUTH_PROVIDER=oidc
SAI_OIDC_ISSUER=http://keycloak:8080/realms/starlingai
SAI_OIDC_CLIENT_ID=starlingai
SAI_OIDC_CLIENT_SECRET=your-client-secret        # stored as a $ENV ref, never in the compiled config
SAI_OIDC_PUBLIC_URL=http://localhost:3001         # gateway public base; redirect = {this}/api/auth/oidc/callback
```

> **Local overrides:** to keep a machine-specific OIDC block (private issuer/clientId, dev
> `insecureSkipTlsVerify`) out of git, put it in `config/gateway/30-auth.local.jsonc` instead of
> editing the tracked `30-auth.jsonc`. The config globber loads `*.local.jsonc` shards **after**
> their numbered sibling (so they override), and `config/**/*.local.jsonc` is git-ignored — so a
> stray `git add` can never commit it.

### Role mapping

The IdP's roles (Keycloak: `realm_access.roles`) map to ours in `auth.oidc.roleMapping`. Most-privileged listed role wins; a user matching none falls back to `defaultRole`, or is **rejected** if that's unset (fail-closed).

```jsonc
"auth": {
  "oidc": {
    "roleMapping": {
      "admin":    ["admin"],
      "operator": ["operator"],
      "viewer":   ["viewer"],
      "defaultRole": null        // reject users with no mapped role
    }
  }
}
```

### Accounts: one per IdP subject

The username an ID token claims is not who the person is: two people can claim names that
lowercase alike ("Alice" and "alice"), and many IdPs let a person edit their own claim. Who the
person is, is the token's issuer and subject (`iss` and `sub`). So:

- **The first sign-in of an `(iss, sub)` pair creates an account.** It gets a random id
  (`oidc-<16 hex>`) and the username the token claims (`usernameClaim`, default
  `preferred_username`, lowercased). Every per-user store is keyed by that id, never by the name
  (see [security.md](security.md#per-user-data-isolation)).
- **The username is frozen.** A later sign-in whose claim differs still signs in under the frozen
  name. The new claim is recorded as the account's `requestedUsername` and audited
  (`auth_oidc_username_change_requested`); an admin approves it with the rename route below. Access
  lists name usernames, so a profile edit must not move someone's grants.
- **A new subject needs a free name.** A name is held by any account in the registry (in any status,
  and its names before an approved rename too, until an admin releases them), by a builtin account in
  `auth.users` (mixed mode, below), and by a deleted builtin account (its tombstone). A held name is
  refused at sign-in with "This username is held by another account; ask an admin"
  (`auth_oidc_username_conflict`). "Alice" after "alice" is refused, instead of becoming her.
- **Usernames** must match `^[a-z0-9][a-z0-9_.@+-]{0,127}$` after lowercasing
  (`auth_oidc_invalid_username` otherwise). No colon, space or control character: the names of
  channel senders and scene runs use a colon.
- **`usernameClaim: "email"` requires `email_verified: true`** in the ID token
  (`auth_oidc_unverified_email` otherwise): anyone can type someone else's address into a
  self-service profile.
- **Data from before account ids.** When something was stored under the name before account ids
  (a per-user directory of the name, or a chat from before ids), the new account starts **pending**
  and cannot sign in ("Account storage migration pending; ask an admin"). Nothing is handed to
  whoever signs in with the name first: an admin moves the data to this account with the account
  migration ([QUICKSTART](../QUICKSTART.md#upgrading-to-account-ids)), or declines it with the
  `decline-legacy` route below, and the account then starts empty. The name of a bootstrap token does
  not count: the bundled realm's `admin` user starts active and empty, and what `sai token` stored
  stays the token's.

The accounts live in the account registry, `<workspace>/.starlingai/accounts.json`. In Docker
that is on the `.:/workspace` bind mount, so `sai start --fresh` keeps it, and no file tool can
read it. A registry file that cannot be read is never written over, and no OIDC account signs in
while it cannot be read.

The issuer is part of the lookup. When your IdP's issuer URL changes (a new hostname, a trailing
slash added), every subject would look new, so rename the issuer in the registry first:
`pnpm sai migrate-account-ids --oidc-issuer-alias <old>=<new>`, applied in a maintenance boot
like every migration apply.

### Managing accounts

| Method | Path | Effect |
|---|---|---|
| `GET` | `/api/admin/accounts` | the registry: id, issuer, subject, username, status (`active`, `pending`, `retired`), `requestedUsername`, sign-in times |
| `POST` | `/api/admin/accounts/:id/rename` | gives the account its `requestedUsername` when no other account holds it; the old name stays held by this account |
| `POST` | `/api/admin/accounts/:id/retire` | the account signs in no more, and what it has running ends (below) |
| `POST` | `/api/admin/accounts/:id/release-username` | a retired account's names may be claimed by a new subject |
| `POST` | `/api/admin/accounts/:id/decline-legacy` | a pending account turns active and starts empty; what was stored under its name stays where it is |

Every route takes the `admin` role, and every change is audited. There is no page for them in the dashboard yet.

**Retiring** an account stops its tokens and closes its open dashboard sockets at once. It also
archives its chats and stops a turn it is running, cancels its queued and running jobs, disables
its schedules, and ends its MCP sessions and A2A tasks. Its storage stays under its id. The reply
lists `aclReferences`, the `allowedUsers` entries in the gateway's config that still name the
username or `account:<id>` (config is never edited). The name stays held until an admin releases
it. After `release-username`, a new subject can claim the name: it gets a new id and starts
empty, but a bare `allowedUsers` entry for the name grants it, so rewrite those entries first.
Removing the retired account's storage is explicit: `pnpm sai migrate-account-ids
--purge-retired <id>`.

**In access lists**, prefer `account:<id>` over the bare username for an OIDC account: the id
survives an approved rename and never passes to another person. See
[security.md](security.md#per-user-resource-access-rbac) for the entry forms.

### Mixed mode

Under `auth.provider: "oidc"`, accounts in `auth.users[]` still sign in with
`POST /api/auth/login`. The dashboard creates none there (the IdP owns the usernames), so they
come from a config shard, such as the e2e accounts of `pnpm e2e:setup`. Their tokens are checked
against the roster on every request, as under `builtin`, so a deleted builtin account's token
stops working at once. A builtin account's username is held against new IdP subjects.

### Bootstrap tokens and the IdP's `admin`

`pnpm sai token` mints a bootstrap token: an instance credential for whoever holds the JWT
secret, never an account. Its default name is `admin`, the same as the bundled realm's demo user,
and the two stay apart: two identities, two storage buckets, and the IdP user never reads what
the token stored.

### Session lifetime & revocation lag (important)

After a successful SSO login the gateway mints **its own** session JWT (24 h). It names the
account id (`aid`), and every request, and every message on an open dashboard socket, checks it
against the registry: the account must be active and still hold the token's username. These take
effect on the next request:

- retiring the account (`POST /api/admin/accounts/:id/retire`), which also closes its open
  sockets at once;
- an approved rename (the account's tokens name the old username), likewise;
- switching `auth.provider` away from `oidc` (an open socket closes at its next message).

The gateway does **not** re-introspect the IdP, though. The role is the one the IdP granted at
sign-in, so **disabling or role-changing a user in the IdP (e.g. Keycloak) does NOT take effect
immediately** — the session keeps its access and its role until the token expires, up to the full
24 h. To off-board someone at once, retire the account here as well. Under the built-in
username/password provider, deleting a user or changing their role in `auth.users[]` is enforced
on the very next request.

There is no logout/blocklist endpoint (logout is a client-side token drop), so a leaked OIDC
session token of an account you do not want to retire cannot be force-invalidated short of
rotating `SAI_JWT_SECRET` (which logs everyone out). If prompt off-boarding through the IdP alone
matters for your deployment, shorten the IdP's access-token / session lifetime accordingly and
treat the 24 h ceiling as the worst-case lag.

## Bundled Keycloak (turnkey dev IdP)

An optional, preconfigured Keycloak ships in the compose file under the `keycloak` profile:

```bash
docker compose --profile keycloak up
```

It imports a `starlingai` realm with the `starlingai` client, `admin`/`operator`/`viewer` realm roles, and an `admin` / `admin` demo user.

**One-time host setup.** So the browser *and* the gateway resolve the issuer to the same URL, add this line to your hosts file (`/etc/hosts`, or `C:\Windows\System32\drivers\etc\hosts`):

```
127.0.0.1 keycloak
```

Then `SAI_OIDC_ISSUER=http://keycloak:8080/realms/starlingai` works from both. Sign in at the dashboard with **admin / admin** (change it), or manage the realm at <http://keycloak:8080> (admin console: `admin` / `admin` from `KEYCLOAK_ADMIN*`).

> The bundle runs Keycloak in **dev mode** (in-memory H2, HTTP). For production, run Keycloak with a real database + TLS behind your reverse proxy, rotate the client secret, and disable the demo user.

The realm's `admin` user is an account like any other. Its first sign-in creates it, active and
empty, apart from the bootstrap token that `sai token` mints under the same name
([above](#bootstrap-tokens-and-the-idps-admin)). The realm file pins no user id, so when Keycloak
loses its data (dev mode keeps it inside the container, so at the latest when the container is
created again), the import creates `admin` anew under a new subject. The registry still holds the
old subject's account with that name, so the new subject is refused until an admin retires the
old account and releases its name (a `sai token` admin token can do both).

## A2A machine auth (agent-to-agent)

When `auth.oidc.a2a.enabled` is true, the swarm authenticates to and from **other agents** that trust the same issuer:

- **Outbound:** each peer call carries a fresh OIDC **client-credentials service token** (falling back to the configured static bearer if unavailable), so peers can validate us against the issuer's JWKS.
- **Inbound:** a peer's IdP access token is accepted after JWKS validation (signature + issuer + audience), in addition to the existing static-bearer and gateway-JWT paths.

Under multi-user auth an inbound peer (an IdP token or the shared bearer) acts as a **peer
principal**, never as an account: its sessions live in a namespace of its own, and its task runs
in the shared workspace root ([api.md](api.md)). A caller with a gateway JWT acts as the account or
bootstrap token the JWT names. A resource bound with `allowedUsers` grants a peer only through a
`principal:<sub>` entry.

```bash
SAI_OIDC_A2A_ENABLED=true
```

(or `auth.oidc.a2a: { enabled: true, audience: "..." }` in config).
