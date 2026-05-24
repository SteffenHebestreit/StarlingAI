FROM node:22-alpine AS base
RUN npm install -g pnpm@10.6.0
WORKDIR /app

# Dependencies — copy manifests first for layer caching
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/core/package.json ./packages/core/
COPY packages/web/package.json ./packages/web/
RUN pnpm install --no-frozen-lockfile

# Build
FROM deps AS build
COPY packages/web ./packages/web
RUN pnpm --filter @starlingai/web build

# Serve with nginx
FROM nginx:alpine AS runtime
RUN apk add --no-cache curl
COPY --from=build /app/packages/web/dist /usr/share/nginx/html
COPY docker/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 3000
