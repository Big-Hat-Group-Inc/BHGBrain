## 1. Remove the unused openai dependency

- [ ] 1.1 Re-verify no source imports the `openai` package (`grep -rn "from 'openai'"
  src scripts` and the `"openai"` double-quote variant — the only hits today are the
  provider-name string and the `api.openai.com` base URL in
  `src/embedding/index.ts:38,43`; the provider calls `fetch(`.../embeddings`)` at
  `src/embedding/index.ts:88`).
- [ ] 1.2 Remove `"openai": "^4.85.4"` from `dependencies` in `package.json` and run
  `npm install` to refresh `package-lock.json`.
- [ ] 1.3 Confirm with `npm ls form-data` that the production path through
  `openai → @types/node-fetch → form-data` is gone (remaining `form-data` paths are
  dev-only via `supertest`/`@types/supertest`).

## 2. In-range security refresh to audit-clean

- [ ] 2.1 Run `npm update` / `npm audit fix` (no `--force`) and verify `npm audit`
  reports **0 vulnerabilities** on the full tree (baseline today: 18 — 2 critical
  dev-side in the vitest 3 chain, production highs in `fast-uri` and `hono` via
  `@modelcontextprotocol/sdk`, `path-to-regexp` via `express`, `form-data`).
- [ ] 2.2 Raise manifest floors to the tested resolutions where the caret already
  allows them (at minimum `@modelcontextprotocol/sdk` `^1.12.1` → the updated
  1.30.x minor in `package.json`), so a fresh install cannot resolve below what CI
  tested.
- [ ] 2.3 `npm run lint && npm test` pass on the refreshed tree; smoke both
  transports per AGENTS.md ("Dual Transport" gotcha).

## 3. Honest Node 22 floor on every surface

- [ ] 3.1 Set `"engines": { "node": ">=22.0.0" }` in `package.json` (currently
  `>=20.0.0`, contradicted by `@qdrant/js-client-rest@1.19.0`'s `>=22.0.0`).
- [ ] 3.2 Bump `.github/workflows/ci.yml:20` `node-version: 20` → `22`.
- [ ] 3.3 Update both Dockerfile stages (`Dockerfile:6` and `Dockerfile:17`) from the
  pinned `node:20-slim@sha256:2cf067…` digest to the current `node:22-slim`
  manifest-list digest (`docker buildx imagetools inspect node:22-slim`), and update
  the comment at `Dockerfile:3-5` that names 20-slim.
- [ ] 3.4 Update the Prerequisites table row `Node.js | ≥ 20.0.0` in `README.md:125`
  and the same row at line 124 of `README.de.md`, `README.es.md`, `README.fr.md`,
  `README.zh-CN.md`; update the `node:20-slim` mention at `README.md:2995`.
- [ ] 3.5 Update `AGENTS.md:8` (`Node.js (>=20.0.0)`) and rewrite the now-stale
  CLAUDE.md live-verification bullet that says `package.json` "still declares
  `>=20.0.0`" (CLAUDE.md lines 43-45) to reflect the raised floor.

## 4. Lockfile and release-process hygiene

- [ ] 4.1 Verify `package-lock.json` root `version` matches the manifest after the
  `npm install` in 1.2 (today: lock says `1.6.0`, manifest says `1.12.0`).
- [ ] 4.2 Adopt `npm version <patch|minor>` as the release bump mechanism and
  document it in `AGENTS.md` (it updates manifest + lock atomically, closing the
  drift path); note it in CLAUDE.md's "Docs to keep in sync" list entry for
  `package.json`.

## 5. TypeScript baseline refresh

- [ ] 5.1 In `tsconfig.json`, raise `target` and `lib` from `ES2022` to `ES2023` and
  move `module`/`moduleResolution` from `Node16` to `NodeNext` (safe once engines
  declare >=22).
- [ ] 5.2 `npm run build && npm run lint && npm test` pass with the new compiler
  settings.

## 6. Staged major upgrades (ordered; each lands green before the next)

- [ ] 6.1 vitest 4: upgrade `vitest` + `@vitest/coverage-v8` `^3.x` → `^4.x`
  (dev-only; retires the deprecated `glob@10.5.0` currently held via
  `@vitest/coverage-v8 → test-exclude`); migrate any config/API breakage in
  `vitest` setup and co-located tests; full suite green.
- [ ] 6.2 Small runtime majors: `pino` `^9` → `^10`, `commander` `^13` → `^15`,
  `uuid` `^11` → `^14`; review each changelog against actual usage
  (`src/health/logger*`, `src/cli/`, id generation) and land together only if all
  three pass lint+test, otherwise split.
- [ ] 6.3 zod 4 — **gated**: upgrade `zod` `^3.24.2` → `^4.x` only once
  `@modelcontextprotocol/sdk` declares zod-4 compatibility (SDK tool schemas and
  `src/config/index.ts` share the instance). If the gate fails at implementation
  time, record the deferral and the blocking SDK version here rather than skipping
  silently.

## 7. Validation and release

- [ ] 7.1 `npm run lint` passes (tsc --noEmit + eslint src).
- [ ] 7.2 `npm test` passes.
- [ ] 7.3 `npm audit` reports 0 vulnerabilities; attach the output to the PR/issue.
- [ ] 7.4 User-facing release: README ×5 already updated in 3.4; bump
  `package.json` version via `npm version minor` (exercising the new 4.2 workflow).
