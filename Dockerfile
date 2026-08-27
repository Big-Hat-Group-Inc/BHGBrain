# Stage 1: Build
# Pinned by digest for reproducible, supply-chain-safe builds. This is the
# multi-arch manifest-list digest for node:20-slim (Debian bookworm-slim base);
# Docker resolves the correct per-platform image from it automatically. To bump:
# `docker buildx imagetools inspect node:20-slim` and update both FROM lines.
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Stage 2: Runtime
FROM node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist/ dist/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV BHGBRAIN_DATA_DIR=/data
ENV BHGBRAIN_HTTP_HOST=0.0.0.0
ENV BHGBRAIN_REQUIRE_LOOPBACK=false

# Run as the unprivileged `node` user (present in the base image). Pre-create the
# data dir owned by that user so the mounted volume inherits writable ownership.
RUN mkdir -p /data && chown -R node:node /data
USER node

VOLUME ["/data"]
EXPOSE 3721

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3721/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The entrypoint provisions a bearer token before launch so the externally-bound
# API is authenticated by default (see docker-entrypoint.sh).
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
