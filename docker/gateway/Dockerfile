FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@10.6.0
WORKDIR /app

# Dependencies — copy manifests + lockfile first for layer caching.
# The lockfile MUST be copied so the in-container install resolves the SAME
# dependency versions as the host/CI lockfile. Without it, pnpm re-resolves from
# the manifests and a stale cached layer can serve an incompatible version (e.g.
# a `docx` build whose v9 exports are missing), breaking `tsc` only inside Docker.
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
RUN cd /app/packages/core \
    && node ../../scripts/clean-path.mjs dist \
    && pnpm exec tsc -p tsconfig.build.json --pretty false

# Shared runtime filesystem
FROM node:22-slim AS runtime-base
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl docker.io openssh-client sshpass \
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

# NOTE: the gateway deliberately runs as root. Running it as an unprivileged user
# (USER node) was tried and backed out: the gateway owns its credential store,
# audit log, and caches under the host-bind zones /workspace/.starlingai and /app,
# whose files are root-created (credentials.enc is mode 600 root) — a non-root
# gateway can't even READ the connected Claude token, and can't write audit/cache.
# Reconciling that would require chowning host-bind state and is fragile (any root
# write re-breaks it). The real blast-radius reduction here comes from
# docker-socket-proxy: the raw docker socket is NOT mounted (see docker-compose.yml),
# so a gateway compromise — root or not — can no longer reach the host docker
# control plane or spawn escape-shaped containers (privileged / host-ns / host
# bind / socket bind are all rejected at the proxy). Gateway uid does not change
# that, and the gateway's secrets live in its own process env regardless of uid.

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -sf http://127.0.0.1:8765/healthz || exit 1

EXPOSE 8765
CMD ["node", "packages/core/dist/index.js"]

# Remote access sidecar runtime
FROM runtime-base AS computer-remote-runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb freerdp2-x11 xdotool imagemagick \
        && rm -rf /var/lib/apt/lists/*

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -sf http://localhost:8890/health || exit 1

EXPOSE 8890
CMD ["node", "packages/core/dist/computer-remote-main.js"]
