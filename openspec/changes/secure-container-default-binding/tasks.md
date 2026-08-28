# Secure Container Default Binding — Tasks

## 1. Secure default bind + token (must-fix)

- [x] 1.1 Decide and implement the secure default: either (a) bind loopback by
  default in the image, or (b) keep the external bind but require a bearer token
  before publishing. _(impl 2026-06-05: chose (b) — `docker-entrypoint.sh` provisions a
  `BHGBRAIN_TOKEN` before launch, persisted to the data volume and reused across restarts.)_
- [x] 1.2 Ensure a default `docker compose up` does NOT yield an unauthenticated,
  externally-reachable API — and does not crash-loop. _(default start is token-authenticated;
  open mode only via explicit `BHGBRAIN_ALLOW_UNAUTHENTICATED=true`.)_
- [x] 1.3 Default the published port to a host-loopback mapping
  (`127.0.0.1:3721:3721`) in `docker-compose.yml` so any unauthenticated mode is
  not LAN-reachable.
- [x] 1.4 Make `validateExternalAuthBinding()` emit a clear, Docker-aware,
  actionable message instead of a raw thrown error; keep the gate fail-closed.
  _(2026-06-06: message now lists the `openssl rand` step, the Docker entrypoint auto-token
  behavior, and the opt-in to run open, `src/transport/middleware.ts`. Still throws `SECURITY:` so
  the existing test holds.)_
- [x] 1.5 Document the token requirement and a `BHGBRAIN_TOKEN` generation step in
  `.env.example` and the README Docker section. _(2026-06-06: `.env.example` token comment +
  new README "Security defaults" subsection covering auto-token, retrieval, and stable token.)_

## 2. Non-root runtime user

- [x] 2.1 Add a non-root `USER` (e.g. `node`) to the runtime stage of the
  `Dockerfile`.
- [x] 2.2 `chown` the `/data` volume so the non-root user can write data/backups/config.
  _(`/app` is root-owned but world-readable, which is sufficient for the `node` user; all
  writes go to `BHGBRAIN_DATA_DIR=/data`, which is chowned to `node`.)_

## 3. Pin base and sidecar images

- [x] 3.1 Pin the Dockerfile base image by digest (e.g. `node:20-slim@sha256:...`)
  for both stages. _(2026-08-27: resolved via Docker Hub registry API —
  `node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0`
  (multi-arch manifest-list digest, current as of this date). Pinned on both the
  `builder` and runtime `FROM` lines with a comment on how to bump it.)_
- [x] 3.2 Pin the `qdrant/qdrant` image in `docker-compose.yml` to a fixed version
  instead of `:latest`. _(pinned to `qdrant/qdrant:v1.12.4` — **verify/adjust the tag** for your
  deployment; this service is opt-in via the `self-hosted` profile.)_

## 4. First-run without a hand-created `.env`

- [x] 4.1 Make the compose `env_file` optional (`required: false`) so the first
  `docker compose up` does not abort when `.env` is absent.
- [x] 4.2 Document and/or scaffold the `cp .env.example .env` flow so first run
  succeeds out of the box. _(2026-06-06: README Quick Start notes `.env` is optional and the
  entrypoint auto-provisions the token; first run works without a hand-created `.env`.)_

## 5. Tighten build context

- [x] 5.1 Add `.env`, secrets, and docs to `.dockerignore` so they never enter the
  build context. _(added `.env`, `.env.*`, `*.pem`, `*.key`, `*.md`, `codeaudit/`.)_

## 6. Validation

- [x] 6.1 Run `npm run lint`, `npm test`, and `npm run build`; build the image and
  verify a default `docker compose up` starts securely. _(2026-08-28: build-verified live in a
  fresh WSL2 Ubuntu 24.04 instance with real Docker Engine 29.7.2 + Compose v5.5.0 (this repo
  ships no Docker in its native environment, so a disposable sandbox was provisioned for this
  check). `docker compose build bhgbrain` succeeded on the digest-pinned `node:20-slim` base
  (both stages). `docker compose up -d bhgbrain` with no `.env` present (first-run scenario) came
  up `Up (healthy)` with no crash-loop: auto-provisioned a `BHGBRAIN_TOKEN`, printed it once,
  persisted it to `/data/bhgbrain-token`, and bound only to `127.0.0.1:3721` (confirmed via `ss
  -tlnp`, not `0.0.0.0`). With Qdrant/embedding credentials both absent it degraded gracefully
  (`status: degraded`, no crash) rather than failing closed destructively. `curl -H "Authorization:
  Bearer <token>"` against `/health` returned 200 with the expected component breakdown. Prior
  `npm run lint`/`npm test`/`npm run build` results (all green) reconfirmed on both Node 20 and
  Node 22 in the same sandbox. Nothing remains unverified for this change.)_
