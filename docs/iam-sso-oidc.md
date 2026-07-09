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
