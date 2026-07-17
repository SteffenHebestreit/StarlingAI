FROM node:22-alpine AS base
RUN apk add --no-cache curl && npm install -g pnpm@10.6.0
WORKDIR /app

# Dependencies
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/mail-service/package.json ./packages/mail-service/
# --frozen-lockfile (not --no-frozen-lockfile): reproducible install that pins the
# exact locked versions and fails fast on a stale lockfile, instead of silently
# re-resolving to a drifting version set that only breaks later in the build.
# This stage builds @starlingai/core, the same package whose tsc step broke in the
# gateway build; see docker/gateway/Dockerfile for the full rationale.
RUN pnpm install --frozen-lockfile

# Build
FROM deps AS build
COPY scripts/clean-path.mjs ./scripts/clean-path.mjs
COPY packages/core ./packages/core
RUN pnpm --filter @starlingai/core build

# Runtime — minimal image, no shell for security
FROM node:22-alpine AS runtime
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/core/package.json ./packages/core/

# Non-root user
RUN addgroup -S agent && adduser -S agent -G agent

# Workspace directory (bind-mounted at runtime) — created as root before dropping privileges
RUN mkdir -p /workspace && chown agent:agent /workspace

USER agent

ENV NODE_ENV=production

# Reads task from stdin, writes result to stdout
CMD ["node", "packages/core/dist/agent/container-entrypoint.js"]
