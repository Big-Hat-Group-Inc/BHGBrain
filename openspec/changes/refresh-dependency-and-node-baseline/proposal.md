## Why

The dependency baseline has drifted from what the code actually needs and what it
actually claims:

- The `openai` SDK ships in the production dependency tree (`package.json`
  `dependencies`, resolving to `openai@4.104.0`) but **nothing imports it** — the
  OpenAI provider talks to `/v1/embeddings` with raw `fetch`
  (`src/embedding/index.ts:88`). Its only contribution is the HIGH-severity
  `form-data` advisory (GHSA-hmw2-7cc7-3qxx) it drags in via `@types/node-fetch`.
- `npm audit` reports **18 vulnerabilities** (2 critical, 10 high, 4 moderate, 2 low);
  10 are in the production tree, including `fast-uri` host-confusion (via the MCP
  SDK's `ajv`), a long list of `hono` advisories (via the MCP SDK), the express
  `path-to-regexp` ReDoS, and `form-data`. Every one reports "fix available via
  `npm audit fix`" — all fixable in-range, no majors required.
- `package.json` declares `"node": ">=20.0.0"` while the pinned
  `@qdrant/js-client-rest@1.19.0` declares `"node": ">=22.0.0"` — a live install on
  Node 20 raises `EBADENGINE` (verified; see CLAUDE.md's live-verification notes).
  CI (`.github/workflows/ci.yml:20`, `node-version: 20`), both Dockerfile stages
  (`node:20-slim` digests at `Dockerfile:6` and `Dockerfile:17`), and the README
  Prerequisites table (`README.md:125`, mirrored in all four translations at line
  124) all advertise a floor the dependency contract disclaims.
- `package-lock.json` records root `"version": "1.6.0"` against the manifest's
  `1.12.0` — six releases bumped the manifest without refreshing the lock, proving
  the release process skips `npm install`/`npm version`.
- `tsconfig.json` targets ES2022 with `module: Node16`, conservative for a Node
  22 floor.

## What Changes

- Remove `openai` from `dependencies`; the production tree loses the `form-data`
  chain and ~its entire install weight for zero functional change.
- Run the in-range security refresh (`npm update` / `npm audit fix`) to an
  audit-clean tree; raise manifest floors to the tested versions (notably
  `@modelcontextprotocol/sdk` to the updated minor).
- Raise `engines.node` to `>=22.0.0` and make every surface agree: CI matrix,
  both Dockerfile `FROM` digests (`node:22-slim`), README Prerequisites in all
  five languages, and the stale AGENTS.md/CLAUDE.md notes about the mismatch.
- Resync `package-lock.json` with the manifest and adopt `npm version` for future
  bumps so the lock can never drift again (documented in AGENTS.md).
- Raise `tsconfig.json` to `target`/`lib` ES2023 and `module`/`moduleResolution`
  `NodeNext` once the engine floor moves.
- Schedule the major upgrades as ordered follow-up tasks **within this change**:
  vitest 4 (+ coverage, retiring the deprecated `glob@10` it transitively holds),
  zod 4 (gated on MCP SDK compatibility), then pino 10 / commander 15 / uuid 14.

## Capabilities

### New Capabilities
- `dependency-baseline`: The declared runtime floor, dependency tree, and lockfile
  are honest — every declared dependency is imported, known advisories are
  resolved, the Node floor matches the strictest transitive engine requirement on
  every surface, and the lockfile tracks the manifest version.

### Modified Capabilities

## Impact

- Affected files: `package.json`, `package-lock.json`, `.github/workflows/ci.yml`,
  `Dockerfile`, `tsconfig.json`, `README.md` + four translations, `AGENTS.md`,
  `CLAUDE.md`.
- No `src/` behavior change is intended; lint + full test suite gate every step.
- **Breaking for operators pinned to Node 20**: the floor was already broken in
  practice (`EBADENGINE` from the Qdrant client); this change makes the docs and
  metadata stop lying about it.
- Coordinates with: `migrate-sqlite-to-native-engine` (sibling, depends on the
  Node 22 floor — **this change owns the engines/Docker/README floor edits**).
- User-facing: README ×5, `package.json` version bump.
