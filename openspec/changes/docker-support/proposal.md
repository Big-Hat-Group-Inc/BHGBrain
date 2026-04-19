# Docker Container Support

## Why

BHGBrain currently requires users to install Node.js, clone the repo, build from source, and separately run Qdrant. This friction slows adoption and makes deployment error-prone. Docker packaging provides a single `docker compose up` experience.

## What Changes

- **Env-var config overlay** — `BHGBRAIN_*` environment variables override `config.json` values at load time, enabling idiomatic Docker configuration without mounting config files.
- **Multi-stage Dockerfile** — `node:20-slim` based image with build and runtime stages. Includes `sql.js` WASM binary. Default env vars set for container use (`0.0.0.0` bind, `/data` volume, loopback disabled).
- **Compose profiles** — Single `docker-compose.yml` with a `self-hosted` profile for bundled Qdrant sidecar. Cloud users run `docker compose up` (no profile) with env vars pointing at Qdrant Cloud.
- **`.env.example`** — Documents all env vars with commented blocks for self-hosted vs cloud configurations.

## Capabilities

- One-command startup for both self-hosted Qdrant and Qdrant Cloud deployments
- `/data` volume persists SQLite DB, config, and backups across container restarts
- Built-in healthcheck at `/health` endpoint
- Bootstrap synergy: new containers with empty `/data` auto-hydrate from Qdrant via existing `bootstrapFromQdrant()` feature

## Impact

- **Config system** — One new function (`applyEnvOverrides`) added to `src/config/index.ts`
- **No breaking changes** — Env vars only apply when set; existing file-based config continues to work
- **Image size** — ~200MB (node:20-slim + production deps + sql.js WASM)

## Non-Goals

- Custom base images or Alpine builds (node:20-slim is sufficient)
- Kubernetes manifests or Helm charts (future work)
- Embedded Qdrant inside the container (external Qdrant is the established pattern)
- CI/CD image publishing (separate concern)
