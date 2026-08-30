## Context

Three independent drifts compound each other. First, dead weight: `openai` sits in
`dependencies` but `grep` finds no import of the package anywhere in `src/` or
`scripts/` — the provider class merely names itself `'openai'` and calls
`fetch('https://api.openai.com/v1/embeddings')` directly
(`src/embedding/index.ts:43,88`). Second, unpatched advisories: the full tree carries
18 (`npm audit`: 2 critical dev-side in the vitest 3 chain, production highs in
`fast-uri`, `hono`, `form-data`, `path-to-regexp`), all resolvable within existing
semver ranges. Third, an inverted engine contract: `@qdrant/js-client-rest@1.19.0`
(the resolved install) declares `engines.node >=22.0.0` while this package declares
`>=20.0.0` and CI, Docker, and the README all repeat 20. The lockfile's root version
(`1.6.0` vs manifest `1.12.0`) shows releases bypass any command that would have
caught this.

## Goals / Non-Goals

Goals:
- Zero `npm audit` findings (full tree) using only in-range updates.
- A production tree in which every package is actually imported.
- One consistent Node floor — `>=22.0.0` — across `engines`, CI, Docker, and docs.
- A lockfile that mechanically tracks the manifest (`npm version` workflow).
- An ordered, tested path through the pending majors, staged so each lands alone.

Non-Goals:
- No behavior or API changes in `src/` (majors that force code edits are gated
  behind their own tasks, each with lint+test verification).
- No replacement of sql.js — that is `migrate-sqlite-to-native-engine`'s scope;
  this change only delivers the Node 22 floor it depends on.
- No Node 24 adoption; 22 is the floor the dependency contract requires, and LTS.

## Decisions

- **Remove `openai` rather than pin it patched**: the package is unused; keeping a
  patched unused dependency still costs install weight, audit surface, and reader
  confusion. `OPENAI_API_KEY` handling is untouched — it feeds the fetch-based
  provider, not the SDK.
- **In-range refresh before majors**: `npm audit` confirms every advisory is
  fixable via `npm audit fix`; landing that first yields an audit-clean baseline so
  each subsequent major upgrade starts from green and its failures are attributable.
- **Node 22, not 24**: 22 is the strictest floor any dependency declares
  (`@qdrant/js-client-rest`), is active LTS through 2027, and matches the WSL
  verification recipe already in CLAUDE.md. `node:22-slim` digests are pinned the
  same way the current 20-slim digests are (multi-arch manifest-list digest,
  `docker buildx imagetools inspect`).
- **Majors ordered dev-first, riskiest-last**: vitest 4 first (dev-only blast
  radius, retires the deprecated `glob@10` held via `test-exclude`), then the small
  runtime majors (pino 10, commander 15, uuid 14 — changelog-reviewed, minimal API
  surface here), with zod 4 last and explicitly **gated on
  `@modelcontextprotocol/sdk` declaring zod-4 compatibility**, since the SDK's tool
  schemas and this repo's config schemas share the zod instance. If the SDK gate
  fails, the zod task is checked off as deferred-with-reason, not silently skipped.
- **`npm version` for future bumps**: it writes manifest and lockfile atomically,
  which is precisely the step the 1.6.0/1.12.0 divergence proves is being skipped.
  Documented in AGENTS.md rather than enforced by hooks — low ceremony, and the
  README-sync checklist in CLAUDE.md already governs releases.
- **tsconfig to ES2023 + NodeNext**: Node 22 fully implements ES2023;
  `NodeNext` is the forward-compatible successor of `Node16` resolution with no
  semantic change for this codebase's `.js`-suffixed ESM imports. Target/lib move
  together to keep `tsc` honest about available builtins.

## Risks / Trade-offs

- **In-range updates can still regress behavior** (express 5.x patch, MCP SDK
  minor 1.27→1.30). Mitigation: `npm run lint && npm test` after each step, and the
  MCP surface has integration tests over both transports.
- **Node 22 floor breaks anyone actually running 20** — but the Qdrant client
  already `EBADENGINE`s there, so such installs are broken today in a less legible
  way. The README change is the honest fix; called out as breaking in the release.
- **Digest pinning goes stale**: the new `node:22-slim` digest freezes a point in
  time, same trade-off as today; the Dockerfile comment documents the refresh
  command.
- **zod 4 may be blocked indefinitely** by the MCP SDK. Accepted: the task is
  written as gated, and the audit-clean goal does not depend on it (zod 3.25 has
  no open advisories).
- **Lockfile churn**: a full in-range refresh rewrites much of the 5,300-line
  lock. Reviewed as a generated file; the manifest diff is the reviewable surface.
