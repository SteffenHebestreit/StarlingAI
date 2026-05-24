FROM node:22-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@10.6.0
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/mail-service/package.json ./packages/mail-service/
RUN pnpm install --no-frozen-lockfile

FROM deps AS build
COPY scripts/clean-path.mjs ./scripts/clean-path.mjs
COPY packages/mail-service ./packages/mail-service
RUN pnpm --filter @starlingai/mail-service build

FROM node:22-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/mail-service/node_modules ./packages/mail-service/node_modules
COPY --from=build /app/packages/mail-service/dist ./packages/mail-service/dist
COPY --from=build /app/packages/mail-service/package.json ./packages/mail-service/

RUN mkdir -p /config/mail /data

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=5020

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:5020/health || exit 1

EXPOSE 5020
CMD ["node", "packages/mail-service/dist/index.js"]