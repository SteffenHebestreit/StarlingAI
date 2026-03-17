FROM node:22-alpine AS base
RUN apk add --no-cache curl && npm install -g pnpm@10.6.0
WORKDIR /app

# Dependencies — copy manifests first for layer caching
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/web/package.json ./packages/web/
RUN pnpm install --frozen-lockfile

# Build
FROM deps AS build
COPY packages/core ./packages/core
RUN pnpm --filter @starlingai/core build

# Runtime
FROM node:22-alpine AS runtime
RUN apk add --no-cache curl docker-cli
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/core/package.json ./packages/core/

# Bake default config into image — can be overridden by bind-mounting a file to /config/starlingai.json
RUN mkdir -p /config
COPY starlingai.json /config/starlingai.json

ENV NODE_ENV=production
ENV LOG_LEVEL=info

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:8765/healthz || exit 1

EXPOSE 8765
CMD ["node", "packages/core/dist/index.js"]
