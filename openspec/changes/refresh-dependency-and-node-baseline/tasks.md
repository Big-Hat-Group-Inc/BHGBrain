## 1. Remove the unused openai dependency

- [x] 1.1 Re-verify no source imports the `openai` package (`grep -rn "from 'openai'"
  src scripts` and the `"openai"` double-quote variant — the only hits today are the
  provider-name string and the `api.openai.com` base URL in
  `src/embedding/index.ts:38,43`; the provider calls `fetch(`.../embeddings`)` at
  `src/embedding/index.ts:88`).
- [x] 1.2 Remove `"openai": "^4.85.4"` from `dependencies` in `package.json` and run
  `npm install` to refresh `package-lock.json`.
- [x] 1.3 Confirm with `npm ls form-data` that the production path through
  `openai → @types/node-fetch → form-data` is gone (remaining `form-data` paths are
  dev-only via `supertest`/`@types/supertest`).

## 2. In-range security refresh to audit-clean

- [x] 2.1 Run `npm update` / `npm audit fix` (no `--force`) and verify `npm audit`
  reports **0 vulnerabilities** on the full tree (baseline today: 18 — 2 critical
  dev-side in the vitest 3 chain, production highs in `fast-uri` and `hono` via
  `@modelcontextprotocol/sdk`, `path-to-regexp` via `express`, `form-data`).
  Resolved via `npm audit fix` + `npm update tsx esbuild` (tsx's `esbuild` pin was
  `~0.27.0`; bumping tsx to 4.23.x pulled `esbuild@0.28.2`, clearing the last low).
- [x] 2.2 Raise manifest floors to the tested resolutions where the caret already
  allows them (at minimum `@modelcontextprotocol/sdk` `^1.12.1` → the updated
  1.30.x minor in `package.json`), so a fresh install cannot resolve below what CI
  tested.
- [x] 2.3 `npm run lint && npm test` pass on the refreshed tree; smoke both
  transports per AGENTS.md ("Dual Transport" gotcha). Both `--stdio` and HTTP
  (`GET /health`) smoke-tested manually against a build with no live Qdrant/embedding
  credentials in this sandbox — both start and report `degraded` health as expected.

## 3. Honest Node 22 floor on every surface

- [x] 3.1 Set `"engines": { "node": ">=22.0.0" }` in `package.json` (currently
  `>=20.0.0`, contradicted by `@qdrant/js-client-rest@1.19.0`'s `>=22.0.0`).
- [x] 3.2 Bump `.github/workflows/ci.yml:20` `node-version: 20` → `22`.
- [x] 3.3 Update both Dockerfile stages (`Dockerfile:6` and `Dockerfile:17`) from the
  pinned `node:20-slim@sha256:2cf067…` digest to the current `node:22-slim`
  manifest-list digest (`docker buildx imagetools inspect node:22-slim`), and update
  the comment at `Dockerfile:3-5` that names 20-slim. Docker CLI isn't available in
  this sandbox; the manifest-list digest
  (`sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5`) was
  obtained and verified instead via the registry HTTP API (Docker Hub tag lookup +
  `registry-1.docker.io` manifest fetch confirming `Content-Type:
  application/vnd.oci.image.index.v1+json`, i.e. a real multi-arch index, not a
  single-platform digest).
- [x] 3.4 Update the Prerequisites table row `Node.js | ≥ 20.0.0` in `README.md:125`
  and the same row at line 124 of `README.de.md`, `README.es.md`, `README.fr.md`,
  `README.zh-CN.md`; update the `node:20-slim` mention at `README.md:2995`. (Line
  numbers had drifted slightly since the proposal was written — rows found and
  updated at ~README.md:129 and ~README.*.md:128/129.)
- [x] 3.5 Update `AGENTS.md:8` (`Node.js (>=20.0.0)`) and rewrite the now-stale
  CLAUDE.md live-verification bullet that says `package.json` "still declares
  `>=20.0.0`" (CLAUDE.md lines 43-45) to reflect the raised floor.

## 4. Lockfile and release-process hygiene

- [x] 4.1 Verify `package-lock.json` root `version` matches the manifest after the
  `npm install` in 1.2 (today: lock says `1.6.0`, manifest says `1.12.0`). Confirmed
  in sync at `1.32.0` after `npm install`.
- [x] 4.2 Adopt `npm version <patch|minor>` as the release bump mechanism and
  document it in `AGENTS.md` (it updates manifest + lock atomically, closing the
  drift path); note it in CLAUDE.md's "Docs to keep in sync" list entry for
  `package.json`.

## 5. TypeScript baseline refresh

- [x] 5.1 In `tsconfig.json`, raise `target` and `lib` from `ES2022` to `ES2023` and
  move `module`/`moduleResolution` from `Node16` to `NodeNext` (safe once engines
  declare >=22).
- [x] 5.2 `npm run build && npm run lint && npm test` pass with the new compiler
  settings.

## 6. Staged major upgrades (ordered; each lands green before the next)

- [x] 6.1 vitest 4: upgrade `vitest` + `@vitest/coverage-v8` `^3.x` → `^4.x`
  (dev-only; retires the deprecated `glob@10.5.0` currently held via
  `@vitest/coverage-v8 → test-exclude`); migrate any config/API breakage in
  `vitest` setup and co-located tests; full suite green. No config/test-source
  breakage — `vitest.config.ts` was already minimal. `npm ls glob` now reports
  empty; 950/950 tests pass.
- [x] 6.2 Small runtime majors: `pino` `^9` → `^10`, `uuid` `^11` → `^14` landed as
  specified. **`commander` landed at `^14.0.3`, not `^15` as the task named**:
  `commander@15` declares `engines.node: >=22.12.0`, stricter than the
  `>=22.0.0` floor this change deliberately set in section 3 (design.md: "Node 22,
  not 24" — the strictest floor any *currently adopted* dependency requires).
  Taking commander 15 would force re-bumping `engines`/CI/Docker/README a second
  time to 22.12.0, contradicting that decision. `commander@14` requires only
  `node >=20` and has no other breaking changes affecting `src/cli/index.ts`'s
  usage (`new Command()...`); CLI smoke-tested (`node dist/cli/index.js --help`)
  and prints the full command list correctly. Revisit commander 15 in a future
  change if/when the Node floor moves to >=22.12.0 or higher.
- [x] 6.3 zod 4 — **gated**: upgrade `zod` `^3.24.2` → `^4.x` only once
  `@modelcontextprotocol/sdk` declares zod-4 compatibility (SDK tool schemas and
  `src/config/index.ts` share the instance). If the gate fails at implementation
  time, record the deferral and the blocking SDK version here rather than skipping
  silently. **Gate satisfied**: `@modelcontextprotocol/sdk@1.30.0` declares
  `peerDependencies.zod: "^3.25 || ^4.0"`. Landed `zod@^4.5.4`. Required two
  source-level migrations beyond the version bump (both behavior-preserving, not
  scope creep — the major does not compile otherwise):
  1. `src/config/index.ts`: zod 4 changed `.default(x)` to type-check `x` against
     the schema's *output* type instead of the *input* type, so the codebase's
     30 occurrences of `.default({})` wrapping objects whose fields carry their
     own `.default(...)` (e.g. `qdrant: z.object({...}).default({})`) no longer
     type-checked (`{}` doesn't satisfy the fully-defaulted output shape). Zod 4
     ships `.prefault(x)` specifically for this: it substitutes `x` as *input*
     and still runs it through the inner schema (applying nested defaults),
     reproducing zod 3's old `.default()` behavior exactly. Verified with an
     isolated repro (`schema.parse({})` before/after) that
     `.prefault({})` yields the identical fully-defaulted output as zod 3's
     `.default({})` did. All 30 sites converted via a targeted
     `s/\.default({})/\.prefault({})/` — scalar defaults (strings/numbers/
     booleans/enums) were untouched since they don't hit this typing change.
  2. `src/tools/bootstrap.ts`, `src/tools/import.ts`, `src/tools/index.ts`: zod 4
     removed the `ZodError.errors` alias (now only `.issues`); updated the three
     `err.errors.map(...)` call sites to `err.issues.map(...)`.
  `npm run lint && npm test` green after both fixes (950/950); stdio transport
  smoke-tested end-to-end against the rebuilt `dist/` to confirm config parsing
  still produces the fully-defaulted config at runtime, not just at the type
  level.

## 7. Validation and release

- [x] 7.1 `npm run lint` passes (tsc --noEmit + eslint src).
- [x] 7.2 `npm test` passes (950/950; one `http.test.ts` timeout was observed once
  under full-suite parallel load and reproduced as a pass both in isolation and on
  a full-suite re-run — an environmental flake, not a regression from this change).
- [x] 7.3 `npm audit` reports 0 vulnerabilities; attach the output to the PR/issue.
  Final `npm audit` output: `found 0 vulnerabilities`.
- [x] 7.4 User-facing release: README ×5 already updated in 3.4; bump
  `package.json` version via `npm version minor` (exercising the new 4.2 workflow).
