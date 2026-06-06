# Code Audit — OpenSpec proposal `docker-support`

- **Date:** 2026-06-05 02:19
- **Scope:** OpenSpec proposal `docker-support`
- **Auditor:** Software-architect audit skill
- **Conventions applied:** TypeScript ESM, Docker, Zod config, Pino
- **Files reviewed:** 13

## Executive summary

The `docker-support` proposal is functionally complete and well-aligned with its design: a multi-stage `node:20-slim` Dockerfile, a `docker-compose.yml` with a `self-hosted` Qdrant profile, an `applyEnvOverrides()` config overlay with full unit-test coverage, an `.env.example`, and `.dockerignore` are all present. The env-overlay code is clean, defensively validated, and matches the documented `BHGBRAIN_*` table exactly.

The most material gap is a **startup contradiction**: the container forces an externally-reachable bind (`0.0.0.0` + `require_loopback_http=false`) but ships no bearer token and does not set `allow_unauthenticated_http=true`. Per `validateExternalAuthBinding()`, a plain `docker compose up` with an unedited `.env` (empty `BHGBRAIN_TOKEN`) will **throw and crash on boot** (fail-closed). This is correct security behavior but breaks the headline "one-command startup" promise and is not documented. Combined with publishing port `3721` to the host by default, this is the area needing the most attention.

Secondary issues: the base image is pinned only to a floating `node:20-slim` tag (no digest), the runtime stage runs as **root** (no `USER` directive), `qdrant/qdrant:latest` is unpinned, and the build does not run `npm ci --omit=dev` reproducibly against a lockfile-only context for the runtime stage's WASM dependency (works, but undocumented reliance on sql.js shipping in production deps).

No blocking correctness defects were found in the env-overlay implementation itself.

## Spec compliance

| Requirement / Task | Status | Evidence |
|---|---|---|
| Env-var config overlay (`applyEnvOverrides`) overrides config.json | Done | `src/config/index.ts:199-242`, called at `src/config/index.ts:189` |
| Overlay covers all 8 documented vars | Done | `src/config/index.ts:202-241` matches `design.md:9-16` table 1:1 |
| Invalid values silently ignored | Done | Port/enum guards `src/config/index.ts:211-214,219,238`; tests `src/config/index.test.ts:140-156,182-186` |
| Add env-overlay tests | Done | `src/config/index.test.ts:91-216` (16 cases) |
| Multi-stage Dockerfile, node:20-slim | Done | `Dockerfile:2,13` (builder + runtime) |
| Default container env (0.0.0.0, /data, loopback off) | Done | `Dockerfile:21-23` |
| Includes sql.js WASM binary | Done (implicit) | `sql.js` is a prod dep (`package.json`), `npm ci --omit=dev` at `Dockerfile:17`; `initSqlJs()` resolves WASM from node_modules `src/storage/sqlite.ts:271` |
| `.dockerignore` created | Done | `.dockerignore:1-10` |
| docker-compose.yml self-hosted + cloud profiles | Done | `docker-compose.yml:1-35`; `self-hosted` profile `docker-compose.yml:18-19` |
| `depends_on required:false` so cloud mode starts without Qdrant | Done | `docker-compose.yml:10-13` |
| Built-in healthcheck at /health | Done | `Dockerfile:28-29`; endpoint `src/transport/http.ts:29-33` |
| Bootstrap synergy (empty /data hydrates from Qdrant) | Done | `src/index.ts:62-74` `bootstrapFromQdrant()` |
| `.env.example` documents all vars (self-hosted vs cloud) | Done | `.env.example:1-57` |
| Update ROADMAP.md | Done | `ROADMAP.md:17-26` |
| Update README.md with Docker section | Done | `README.md:2418-2477` |
| `/data` volume persists DB/config/backups | Done | `Dockerfile:25`, `docker-compose.yml:6-7`; `ensureDataDir` `src/config/index.ts:281-292` |
| One-command startup actually succeeds out-of-the-box | Drifted | Fail-closed auth (`src/transport/middleware.ts:151-157`) crashes default `docker compose up` with empty `BHGBRAIN_TOKEN`; not documented (see SEC-1) |

## Findings overview

| # | Severity | Confidence | Effort | Dimension | Location | Summary |
|---|---|---|---|---|---|---|
| SEC-1 | High | High | S | Security/Stability | `Dockerfile:22-23` / `src/transport/middleware.ts:151-157` | External bind + no token → fail-closed crash on default `docker compose up` |
| SEC-2 | Medium | High | S | Security | `Dockerfile:13` | Runtime stage runs as root; no non-root `USER` |
| SEC-3 | Medium | High | S | Security/Stability | `Dockerfile:2,13` | Base image not digest-pinned (floating `node:20-slim`) |
| SEC-4 | Low | High | S | Security/Stability | `docker-compose.yml:17` | `qdrant/qdrant:latest` unpinned |
| STA-1 | Medium | High | S | Stability | `docker-compose.yml:8-9` | `env_file: .env` is mandatory; missing `.env` aborts compose |
| PERF-1 | Low | Medium | S | Performance | `Dockerfile:16-19` | Runtime stage reinstalls deps instead of copying pruned node_modules; larger/slower build |
| MAINT-1 | Low | High | S | Maintainability | `.dockerignore:1-10` | `.env`, `*.md` READMEs, `checklist.md`, `temp_*` not excluded from build context |

## Quick wins

- Set `ENV BHGBRAIN_ALLOW_UNAUTHENTICATED` only via `.env` and document that `BHGBRAIN_TOKEN` is **required**, or default the compose service to loopback-published port mapping `127.0.0.1:3721:3721` (SEC-1).
- Add `USER node` to the runtime stage and `chown` `/data` (SEC-2).
- Pin base image by digest and pin `qdrant/qdrant` to a version tag (SEC-3, SEC-4).
- Add `.env` and `*.md` to `.dockerignore` (MAINT-1).

## Performance

### [Low · Medium · S] Runtime stage reinstalls deps instead of copying pruned modules — `Dockerfile:16-19`

**Issue:** The runtime stage runs a fresh `npm ci --omit=dev` (`Dockerfile:17`) rather than copying a pruned `node_modules` from the builder. This re-resolves and re-downloads all production dependencies in the second stage, adding network/CPU to every build and defeating part of the multi-stage caching benefit.

**Why it matters:** Slower, less reproducible builds; the registry is hit twice (full install in builder at `Dockerfile:6`, prod install here). The proposal targets a ~200MB image and fast onboarding.

**Recommendation:** Either `RUN npm ci --omit=dev` in the builder into a separate dir and `COPY --from=builder` it, or accept the current approach but add `npm cache` mount (`RUN --mount=type=cache,target=/root/.npm`) to speed repeat builds.

## Logging & observability

No issues found. Logging routes correctly: Pino writes to stderr under stdio and stdout otherwise (`src/index.ts:43`), and `BHGBRAIN_LOG_LEVEL` is wired through the overlay (`src/config/index.ts:236-241`). The healthcheck exercises the real `/health` handler (`Dockerfile:28-29` → `src/transport/http.ts:29-33`), which reflects storage/embedding/breaker health.

## Stability & reliability

### [Medium · High · S] Compose requires a `.env` file that does not exist by default — `docker-compose.yml:8-9`

**Issue:** `env_file: - .env` makes `.env` mandatory. Compose aborts with "env file ... not found" if the user runs `docker compose up` before copying `.env.example` to `.env`. The repo ships no `.env` (correctly gitignored at `.gitignore:4`), so the very first run fails.

**Why it matters:** Contradicts the "single `docker compose up`" experience in the proposal (proposal.md:5,16).

**Recommendation:** Mark it optional via `env_file: [{ path: .env, required: false }]` (Compose ≥ 2.24), or document the `cp .env.example .env` prerequisite prominently in the README Docker section.

(See also SEC-1, which is both a security and stability finding.)

## Security

### [High · High · S] External bind with no token fails closed and crashes default startup — `Dockerfile:22-23` / `src/transport/middleware.ts:151-157`

**Issue:** The image bakes `BHGBRAIN_HTTP_HOST=0.0.0.0` and `BHGBRAIN_REQUIRE_LOOPBACK=false` (`Dockerfile:22-23`), making the server externally reachable. `validateExternalAuthBinding()` throws when the bind is non-loopback, no `BHGBRAIN_TOKEN` is set, and `allow_unauthenticated_http` is false (`src/transport/middleware.ts:151-157`). The shipped `.env.example` leaves `BHGBRAIN_TOKEN=` empty (`.env.example:28`) and does not enable unauthenticated mode, so a default `docker compose up` throws at boot and `restart: unless-stopped` (`docker-compose.yml:14`) will crash-loop.

**Why it matters:** The headline capability is one-command startup; out-of-the-box it crash-loops. Worse, the "obvious" user fix is to set `BHGBRAIN_ALLOW_UNAUTHENTICATED=true`, which exposes an unauthenticated memory API on a host-published port (`docker-compose.yml:4-5` publishes `3721` to all interfaces). This is the highest-risk outcome.

**Why it matters (security):** Port `3721:3721` binds to `0.0.0.0` on the host (`docker-compose.yml:4-5`), so any unauthenticated-mode escape hatch is reachable from the LAN, not just the container network.

**Recommendation:** (1) Make `BHGBRAIN_TOKEN` a documented hard requirement and have the README/`.env.example` instruct generating one; (2) publish the port as `127.0.0.1:3721:3721` by default so only the host can reach it; (3) fail with a clear, Docker-specific message (or a startup log) rather than a raw thrown error, so the crash-loop is diagnosable.

### [Medium · High · S] Runtime container runs as root — `Dockerfile:13`

**Issue:** The runtime stage (`FROM node:20-slim`, `Dockerfile:13`) never drops privileges with a `USER` directive, so `node dist/index.js` (`Dockerfile:31`) runs as root inside the container.

**Why it matters:** A compromise of the Node process (or a dependency) executes as root; combined with the `/data` volume mount this is a broader blast radius than necessary. `node:*` images ship a non-root `node` user precisely for this.

**Recommendation:** After copying `dist/` and node_modules, `RUN chown -R node:node /app /data` and add `USER node`. Ensure `/data` (the `VOLUME` at `Dockerfile:25`) is writable by `node`.

### [Medium · High · S] Base image not digest-pinned — `Dockerfile:2,13`

**Issue:** Both stages use the floating tag `node:20-slim` (`Dockerfile:2,13`). The same Dockerfile produces different images over time as the tag is republished.

**Why it matters:** Non-reproducible builds and silent base-image drift; a supply-chain compromise of the tag is picked up automatically. The proposal explicitly chose `node:20-slim` (design.md:22) but did not pin it.

**Recommendation:** Pin by digest, e.g. `FROM node:20-slim@sha256:<digest> AS builder` and the same digest for the runtime stage, and update via a controlled bump.

### [Low · High · S] Qdrant sidecar uses `:latest` — `docker-compose.yml:17`

**Issue:** `image: qdrant/qdrant:latest` (`docker-compose.yml:17`) is unpinned.

**Why it matters:** Vector storage compatibility and behavior can change between Qdrant releases without notice; reproducibility suffers.

**Recommendation:** Pin to a tested minor version (e.g. `qdrant/qdrant:v1.x.y`).

## Maintainability & code quality

### [Low · High · S] `.dockerignore` omits `.env` and docs from the build context — `.dockerignore:1-10`

**Issue:** `.dockerignore` (`.dockerignore:1-10`) excludes `node_modules`, `dist`, `.git`, tests, and several dot-dirs, but not `.env`, the large translated `README.*.md` files, `checklist.md`, `temp_percentile.patch`, or `temp_stage/`. The current Dockerfile only `COPY`s specific paths (`Dockerfile:5,8-9,16`), so no secret is baked into the image today — but a future `COPY . .` or `docker build` context inspection would pull `.env` and 500KB+ of READMEs into the context.

**Why it matters:** Defense-in-depth against accidental secret inclusion and a smaller, faster build context. Low risk only because the COPY list is currently narrow.

**Recommendation:** Add `.env`, `*.md` (or `README*.md`), `temp_*`, `coverage/`, and `*.tsbuildinfo` to `.dockerignore`.

## Testing & coverage

No issues found. The env-overlay is thoroughly tested: 16 cases in `src/config/index.test.ts:91-216` covering each variable, invalid-value rejection (port, qdrant mode, log level), simultaneous overrides, and the no-env baseline. Env state is saved/restored per test (`src/config/index.test.ts:105-120`), avoiding cross-test leakage.

Gap (not a defect): no test or CI step actually builds the Docker image or asserts the healthcheck/startup path — so SEC-1 (fail-closed crash) is not caught by the suite. A smoke test (`docker build` + `docker run` + curl `/health`) would have surfaced it. Recommend adding one, but it is out of the stated proposal scope.

## Dependencies & supply chain

No first-party dependency issues found. The runtime relies on `sql.js` shipping its WASM via the production dependency tree (`package.json` deps; resolved at `src/storage/sqlite.ts:271` via default `initSqlJs()`), which `npm ci --omit=dev` (`Dockerfile:17`) satisfies. Supply-chain concerns are the unpinned base images (SEC-3) and `qdrant:latest` (SEC-4), tracked above. `package-lock.json` is present and `npm ci` is used in both stages (`Dockerfile:6,17`), giving reproducible npm resolution.

## Recommendations (prioritized)

1. **SEC-1 (High):** Default the published port to `127.0.0.1:3721:3721`, make `BHGBRAIN_TOKEN` a documented requirement, and emit a clear Docker-aware startup error instead of crash-looping. Highest impact on both security and the core "one-command" promise.
2. **STA-1 (Medium):** Make `env_file` optional or document `cp .env.example .env` as a required first step.
3. **SEC-2 (Medium):** Add a non-root `USER node` and `chown /data`.
4. **SEC-3 / SEC-4 (Medium/Low):** Digest-pin `node:20-slim`; version-pin `qdrant/qdrant`.
5. **MAINT-1 (Low):** Tighten `.dockerignore` (`.env`, `*.md`, `temp_*`, `coverage/`).
6. **PERF-1 (Low):** Copy pruned `node_modules` from the builder or add an npm cache mount.
7. **Testing (Low):** Add a Docker build + `/health` smoke test to CI to catch startup regressions like SEC-1.
