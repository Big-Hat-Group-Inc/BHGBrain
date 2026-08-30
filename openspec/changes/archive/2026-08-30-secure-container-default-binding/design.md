# Secure Container Default Binding — Design

## Context

The `docker-support` change shipped a working multi-stage container, but the
audit (`codeaudit/docker-support-2026-06-05-02-19.md`, SEC-1) surfaced a startup
contradiction. The image bakes:

- `BHGBRAIN_HTTP_HOST=0.0.0.0` (`Dockerfile:22`)
- `BHGBRAIN_REQUIRE_LOOPBACK=false` (`Dockerfile:23`)

making the server externally reachable, yet ships no bearer token and does not
enable `allow_unauthenticated_http`. `validateExternalAuthBinding()`
(`src/transport/middleware.ts:151-157`) correctly **fails closed**: a default
`docker compose up` with an empty `BHGBRAIN_TOKEN` throws on boot, and
`restart: unless-stopped` (`docker-compose.yml:14`) turns that into a crash-loop.
The natural user "fix" — `BHGBRAIN_ALLOW_UNAUTHENTICATED=true` — exposes an
unauthenticated memory API on `3721:3721`, which binds to `0.0.0.0` on the host
and is therefore reachable from the LAN.

The auth gate is correct; the **defaults** are not. The supporting hardening gaps
(root runtime, unpinned images, mandatory `.env`, leaky build context) widen the
blast radius and degrade reproducibility.

## Goals / Non-Goals

**Goals:**

- A default container start is secure: no unauthenticated, externally-reachable
  memory API, and no silent path into one.
- Default `docker compose up` either succeeds securely or fails with a clear,
  actionable, Docker-aware message — never a cryptic crash-loop.
- Harden the image: non-root runtime, pinned base + `qdrant/qdrant` images,
  first-run without a hand-authored `.env`, and a build context free of secrets
  and docs.

**Non-Goals:**

- Weakening or removing `validateExternalAuthBinding()`'s fail-closed behavior.
- Re-architecting the embedding/Qdrant stack or the env-overlay table.
- Kubernetes/Helm manifests, Alpine builds, or CI image publishing.
- Adding a Docker build/healthcheck smoke test to CI (noted by the audit as
  out-of-scope; may be a follow-up).

## Decisions

1. **Secure default bind (must-fix).** Choose one of two secure defaults and
   apply it in the image: (a) **bind loopback by default** (`127.0.0.1` /
   `require_loopback_http=true`), leaving external exposure as an explicit opt-in;
   or (b) **keep the external bind but require a token** to be present before the
   server publishes. Preference is (a) loopback-by-default for the in-image env,
   because it is safe even if a user later flips the unauthenticated flag, with
   (b) reinforcing it as documentation. Either way, a default `docker compose up`
   must not produce an unauthenticated externally-reachable API.

2. **Host-loopback port publish.** Default the compose port mapping to
   `127.0.0.1:3721:3721` so that, even under an explicit unauthenticated opt-in,
   the API is not reachable from the LAN — only from the host.

3. **Actionable startup failure.** When an external bind is requested without a
   token, `validateExternalAuthBinding()` emits a Docker-aware, actionable message
   (what env var to set, how to generate a token, how to opt into unauthenticated
   mode) rather than a bare thrown error. The gate stays fail-closed.

4. **Non-root runtime user.** Run the runtime stage as the `node` user; `chown`
   `/app` and the `/data` volume so it remains writable.

5. **Pin images.** Pin the Dockerfile base image by digest for both stages and pin
   `qdrant/qdrant` to a fixed version tag.

6. **Optional `.env`.** Mark the compose `env_file` `required: false` (Compose
   ≥ 2.24) and/or document the `cp .env.example .env` step so the first run never
   aborts on a missing file.

7. **Tighten `.dockerignore`.** Exclude `.env`, secrets, and `*.md` docs from the
   build context as defense-in-depth, independent of the current narrow `COPY`
   list.

## Risks / Trade-offs

- **Loopback-by-default reduces out-of-box remote reachability.** Users who want
  remote access must explicitly opt in (set a token + external bind). This is the
  intended, safer trade-off; it is documented.
- **Digest-pinned base image requires controlled bumps.** Pinning trades automatic
  patch pickup for reproducibility and supply-chain safety; security updates now
  require an intentional digest bump (acceptable; standard practice).
- **`env_file: required: false` needs a recent Compose.** If targeting older
  Compose, fall back to documenting the `cp .env.example .env` prerequisite.
- **Changing the published port mapping** may surprise users expecting LAN
  reachability; this is called out in the README.

## Migration Plan

- No data migration. Changes are to the image/compose/build-context and a
  message-only tweak in `validateExternalAuthBinding()`.
- Existing users with a configured `BHGBRAIN_TOKEN` and an intentional external
  bind are unaffected functionally; they may need to adjust the published port
  mapping if they relied on `0.0.0.0` host publishing.
- Rebuild the image and re-run `docker compose up`; the `/data` volume and its
  contents are preserved.

## Open Questions

- Decision 1: ship loopback-by-default in the image (preferred) vs. require a
  token while keeping the external bind — confirm the primary intended Docker UX.
- Which `qdrant/qdrant` version to pin to (latest tested compatible release)?
- Should the image scaffold/generate a `BHGBRAIN_TOKEN` on first run, or strictly
  require the user to provide one?
