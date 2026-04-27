# Docker Support — Design

## Env-Var Overlay

An `applyEnvOverrides()` function runs at the end of `loadConfig()`, after Zod parsing and the `data_dir` fallback. Each `BHGBRAIN_*` variable maps to a specific config field. Invalid values (wrong type, out of enum range) are silently ignored — the file/default value stands.

| Env var | Config field | Type |
|---------|-------------|------|
| `BHGBRAIN_DATA_DIR` | `data_dir` | string |
| `BHGBRAIN_HTTP_HOST` | `transport.http.host` | string |
| `BHGBRAIN_HTTP_PORT` | `transport.http.port` | int |
| `BHGBRAIN_QDRANT_MODE` | `qdrant.mode` | enum |
| `BHGBRAIN_QDRANT_URL` | `qdrant.external_url` | string |
| `BHGBRAIN_REQUIRE_LOOPBACK` | `security.require_loopback_http` | bool |
| `BHGBRAIN_ALLOW_UNAUTHENTICATED` | `security.allow_unauthenticated_http` | bool |
| `BHGBRAIN_LOG_LEVEL` | `observability.log_level` | enum |

## Multi-Stage Dockerfile

- **Stage 1 (builder):** Full `npm ci`, TypeScript compilation
- **Stage 2 (runtime):** `npm ci --omit=dev`, copy `dist/` from builder
- Base: `node:20-slim` — minimal Debian with Node.js, native `fetch()` for healthchecks (no curl needed)
- Default env: `BHGBRAIN_DATA_DIR=/data`, `BHGBRAIN_HTTP_HOST=0.0.0.0`, `BHGBRAIN_REQUIRE_LOOPBACK=false`

## Compose Profiles

Single `docker-compose.yml` with two usage modes:

1. **Self-hosted Qdrant:** `docker compose --profile self-hosted up` — starts `qdrant/qdrant:latest` sidecar with healthcheck, BHGBrain depends on it conditionally
2. **Qdrant Cloud:** `docker compose up` — no Qdrant container, env vars in `.env` point at cloud instance

The `depends_on` with `required: false` ensures BHGBrain starts even when the Qdrant profile is not active.

## Volume Strategy

Single `/data` mount point maps to `BHGBRAIN_DATA_DIR`. Contains:
- `brain.db` — SQLite database
- `config.json` — persisted config with resolved device_id
- `backups/` — backup files from `bhgbrain backup create`

This aligns with `ensureDataDir()` which creates the directory structure.

## Bootstrap Synergy

New containers with an empty `/data` volume connecting to a populated Qdrant instance will automatically hydrate SQLite via the existing `bootstrapFromQdrant()` feature — no manual `repair` step needed.
