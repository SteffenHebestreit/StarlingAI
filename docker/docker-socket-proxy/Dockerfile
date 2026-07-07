# Filtering docker-socket proxy — the ONLY container with docker-socket access.
# Zero external deps (pure node:http/net). The gateway reaches it over TCP.
FROM node:22-slim
WORKDIR /app
COPY docker/docker-socket-proxy/server.mjs docker/docker-socket-proxy/filter.mjs docker/docker-socket-proxy/bind-policy.mjs ./
# Runs as root because it must read the host socket bind — but it exposes only a
# filtered, internal-only TCP surface; the raw socket never leaves this container.
ENV NODE_ENV=production
CMD ["node", "server.mjs"]
