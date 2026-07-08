# StarlingAI — OpenAPI Specifications

Machine-readable specs for StarlingAI's HTTP-facing services.

| File | Service | Port (default) |
|---|---|---|
| [core-gateway.openapi.yaml](core-gateway.openapi.yaml) | `@starlingai/core` gateway (REST) | 8765 |
| [mail-service.openapi.yaml](mail-service.openapi.yaml) | `@starlingai/mail-service` | 5020 |

Both specs are OpenAPI 3.1. They describe paths, parameters, auth, and response shapes. Request/response bodies use loose schemas (`additionalProperties: true`) in places where the runtime Zod schemas in the source tree are authoritative — follow the link in the relevant path's `description` to the source file, or read:

- Gateway runtime schemas: [`packages/core/src/config/`](../packages/core/src/config/) and [`packages/core/src/gateway/`](../packages/core/src/gateway/)
- Mail-service runtime schemas: [`packages/mail-service/src/`](../packages/mail-service/src/)

WebSocket RPC (`ws://${host}:${port}/ws?token=<jwt>` on the gateway) is not covered by OpenAPI; see the WebSocket RPC method catalog in [`../docs/api.md`](../docs/api.md).

## Using the specs

```bash
# View in Swagger UI locally
docker run --rm -p 8080:8080 \
  -e SWAGGER_JSON=/specs/core-gateway.openapi.yaml \
  -v "$(pwd)/specs:/specs" \
  swaggerapi/swagger-ui

# Generate a TypeScript client
npx openapi-typescript specs/core-gateway.openapi.yaml -o generated/core-gateway.d.ts

# Lint a spec
npx @redocly/cli lint specs/core-gateway.openapi.yaml
```

When you add or change a route in the gateway or mail-service, update the corresponding spec in the same commit.
