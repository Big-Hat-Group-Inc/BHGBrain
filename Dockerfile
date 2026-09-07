# Stage 1: Build
# Pinned by digest for reproducible, supply-chain-safe builds. This is the
# multi-arch manifest-list digest for node:22-slim (Debian bookworm-slim base);
# Docker resolves the correct per-platform image from it automatically. To bump:
# `docker buildx imagetools inspect node:22-slim` and update both FROM lines.
FROM node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Stage 2: Runtime
FROM node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ dist/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV BHGBRAIN_DATA_DIR=/data
ENV BHGBRAIN_HTTP_HOST=0.0.0.0
ENV BHGBRAIN_REQUIRE_LOOPBACK=false
# Defense in depth, not the primary fix: the terminal JSON error middleware in
# createHttpServer guarantees structured envelopes (no HTML/stack traces) in
# every environment, including bare `npm start`. This just also drops
# Express's dev-mode overhead. See harden-http-server-lifecycle.
ENV NODE_ENV=production

# Run as the unprivileged `node` user (present in the base image). Pre-create the
# data dir owned by that user so the mounted volume inherits writable ownership.
RUN mkdir -p /data && chown -R node:node /data
USER node

VOLUME ["/data"]
EXPOSE 3721

# bound-qdrant-http-runtime task 3.4: `/health` (the full diagnostic
# snapshot) now requires Bearer auth like every other route, and this
# HEALTHCHECK has no way to supply one — using it here would make every
# container report unhealthy (401) regardless of actual process state.
# `/health/live` is the terse, unauthenticated, dependency-free probe meant
# exactly for a restart-decision healthcheck like this one; use
# `/health/ready` instead if you want Docker to also restart the container
# on a degraded Qdrant/SQLite dependency rather than only a wedged process.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3721/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The entrypoint provisions a bearer token before launch so the externally-bound
# API is authenticated by default (see docker-entrypoint.sh).
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
