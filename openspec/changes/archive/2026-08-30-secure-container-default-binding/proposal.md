# Secure Container Default Binding

## Why

The audit of the completed `docker-support` change
(`codeaudit/docker-support-2026-06-05-02-19.md`) found a startup contradiction
in the shipped container. The image bakes an externally-reachable bind
(`BHGBRAIN_HTTP_HOST=0.0.0.0`, `BHGBRAIN_REQUIRE_LOOPBACK=false`) but ships **no**
bearer token and does not enable `allow_unauthenticated_http`. Because
`validateExternalAuthBinding()` fails closed, a default `docker compose up`
either crash-loops (with `restart: unless-stopped`) or pushes users toward the
"obvious" fix — `BHGBRAIN_ALLOW_UNAUTHENTICATED=true` — which publishes an
**unauthenticated memory API** on a host port (`3721:3721`) reachable from the LAN.
This is a drifted, insecure default: the headline "one-command startup" promise
collides with the auth gate, and the easiest escape hatch is the dangerous one.

Several supporting image-hardening gaps compound the risk: the runtime stage runs
as **root**, the base image and the `qdrant/qdrant` sidecar are **unpinned**
(`:latest`/floating tag), a mandatory `env_file: .env` aborts the very first run,
and `.dockerignore` does not exclude `.env`/docs from the build context.

## What Changes

- **Secure-by-default container start (must-fix)** — the default container start
  SHALL be secure. Either require a bearer token before the server is published
  externally, or bind loopback by default. A default `docker compose up` MUST NOT
  result in an unauthenticated, externally-reachable memory API (and MUST NOT
  silently crash-loop into one once a user flips the unauthenticated flag).
- **Clear, Docker-aware startup failure** — when an external bind is requested
  without a token, fail with an actionable, container-specific message instead of
  a raw thrown error/crash-loop.
- **Non-root runtime user** — the runtime stage SHALL run as a non-root user
  (e.g. the `node` user) with `/data` writable by that user.
- **Pinned base and sidecar images** — the Dockerfile base image and the
  `qdrant/qdrant` compose image SHALL be pinned (by digest or a fixed version),
  not `:latest`/floating tags.
- **First-run works without a hand-created `.env`** — the compose `env_file`
  dependency SHALL NOT abort the first `docker compose up`; `.env` is optional or
  is scaffolded/documented.
- **Tightened build context** — `.dockerignore` SHALL exclude `.env`, secrets,
  and docs so they never enter the build context.

## Capabilities

### New Capabilities

- `secure-container-defaults`: A container that starts securely out of the box —
  no unauthenticated, externally-reachable memory API by default; non-root
  runtime; pinned base/sidecar images; a first run that succeeds without a
  hand-authored `.env`; and a build context free of secrets and docs.

### Modified Capabilities

(none)

## Impact

**Affected files:**

- `Dockerfile` — default bind/loopback env, non-root `USER`, `chown /data`,
  digest-pinned base image (audit `Dockerfile:2,13,21-23`).
- `docker-compose.yml` — published port binding, pinned `qdrant/qdrant` image,
  optional `env_file` (audit `docker-compose.yml:4-5,8-9,17`).
- `.dockerignore` — exclude `.env`, secrets, and `*.md` docs (audit
  `.dockerignore:1-10`).
- `.env.example` / `README.md` — document the token requirement and first-run
  flow (audit SEC-1, STA-1).
- `src/transport/middleware.ts` — `validateExternalAuthBinding()` may emit a
  Docker-aware, actionable message; the auth gate itself stays fail-closed
  (audit `src/transport/middleware.ts:151-157`).

**Security notes:**

- Fail-closed behavior in `validateExternalAuthBinding()` is **correct** and is
  preserved — this change does not weaken it. It removes the insecure *defaults*
  that make the dangerous escape hatch the path of least resistance.
- The published port SHOULD default to a host-loopback mapping
  (`127.0.0.1:3721:3721`) so any unauthenticated mode cannot be reached from the
  LAN.
- No new attack surface is introduced; the net effect is a strictly smaller blast
  radius (non-root, no LAN-exposed unauthenticated API, no secrets in build
  context) and reproducible, supply-chain-pinned images.
