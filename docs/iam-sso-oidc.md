# Identity, SSO & A2A auth (OpenID Connect)

StarlingAI has a **pluggable identity backend**, chosen with `auth.provider`:

| `auth.provider` | What it does |
|---|---|
| `builtin` (default) | Username + password accounts in `auth.users[]`, managed in the dashboard. |
| `oidc` | Single sign-on via an external OpenID Connect provider (e.g. **Keycloak**). The login screen redirects to the IdP, the IdP's roles map to our `admin`/`operator`/`viewer`, and the gateway mints its own session JWT — so the rest of the system (RBAC, per-user isolation, A2A) is unchanged. |

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

### Session lifetime & revocation lag (important)

After a successful SSO login the gateway mints **its own** session JWT (24 h) from the IdP's
validated claims, and every subsequent request is authorized from that token's claims — the
gateway does **not** re-introspect the IdP or re-derive the role per request.

Consequence: **disabling or role-changing an OIDC user in the IdP (e.g. Keycloak) does NOT take
effect immediately** — the existing StarlingAI session keeps its access (and its role frozen at
login) until that token expires, up to the full 24 h lifetime. This differs from the built-in
username/password provider, where deleting a user or changing their role in `auth.users[]` is
enforced on the very next request.

There is no logout/blocklist endpoint (logout is a client-side token drop), so a leaked or
outstanding OIDC session token cannot be force-invalidated short of rotating `SAI_JWT_SECRET`
(which logs everyone out). If prompt off-boarding matters for your deployment, shorten the IdP's
access-token / session lifetime accordingly and treat the 24 h ceiling as the worst-case lag.

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

## A2A machine auth (agent-to-agent)

When `auth.oidc.a2a.enabled` is true, the swarm authenticates to and from **other agents** that trust the same issuer:

- **Outbound:** each peer call carries a fresh OIDC **client-credentials service token** (falling back to the configured static bearer if unavailable), so peers can validate us against the issuer's JWKS.
- **Inbound:** a peer's IdP access token is accepted after JWKS validation (signature + issuer + audience), in addition to the existing static-bearer and gateway-JWT paths.

```bash
SAI_OIDC_A2A_ENABLED=true
```

(or `auth.oidc.a2a: { enabled: true, audience: "..." }` in config).
