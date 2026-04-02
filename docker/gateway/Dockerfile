FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@10.6.0
WORKDIR /app

# Dependencies — copy manifests first for layer caching
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/web/package.json ./packages/web/
COPY packages/mail-service/package.json ./packages/mail-service/
RUN pnpm install --no-frozen-lockfile

# Test — runs vitest inside the container, exits non-zero on failure
FROM deps AS test
COPY packages/core ./packages/core
# Stub a minimal config so config-dependent tools don't fail to import
RUN echo '{"workspacePath":"/tmp/test-workspace"}' > /app/starlingai.json && \
    mkdir -p /tmp/test-workspace
ENV SAI_CONFIG_PATH=/app/starlingai.json
ENV NODE_ENV=test
CMD ["pnpm", "--filter", "@starlingai/core", "test"]

# Build
FROM deps AS build
COPY scripts/clean-path.mjs ./scripts/clean-path.mjs
COPY packages/core ./packages/core
RUN pnpm --filter @starlingai/core build

# Shared runtime filesystem
FROM node:22-slim AS runtime-base
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl docker.io \
    && rm -rf /var/lib/apt/lists/*
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

# Gateway runtime
FROM runtime-base AS runtime

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:8765/healthz || exit 1

EXPOSE 8765
CMD ["node", "packages/core/dist/index.js"]

# Remote access sidecar runtime
FROM runtime-base AS computer-remote-runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
        xvfb freerdp2-x11 xdotool imagemagick \
        openssh-client sshpass \
        && rm -rf /var/lib/apt/lists/*

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -sf http://localhost:8890/health || exit 1

EXPOSE 8890
CMD ["node", "packages/core/dist/computer-remote-main.js"]
