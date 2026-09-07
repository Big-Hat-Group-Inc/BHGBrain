## Why

The current green test baseline does not type-check tests, enforce promise-safety rules, or exercise the real retention store, allowing a completely inert GC to pass. Large handlers also duplicate payload reconstruction and critical boundary logic, making recovery behavior easy to change inconsistently.

## What Changes

- Enable type-aware lint rules for floating/misused promises and add a test TypeScript configuration.
- Add a coverage command and ratcheted thresholds based on the repository's measured baseline.
- Add real-store retention integration coverage, MCP session lifecycle tests, forget/backup dispatch tests, and bidirectional schema/dispatch lockstep tests.
- Extract one Qdrant payload-to-memory mapper and reuse it in hydration, repair, and search fallback.
- Split oversized review, repair, recall, and hybrid-search handlers into focused functions with pure helpers for pool sizing, fusion, and mapping.
- Require focused regression tests in each audit remediation change before its tasks are considered complete.

## Capabilities

### New Capabilities
- `verification-and-maintainability-guardrails`: Defines type-aware verification, coverage ratcheting, real-boundary integration tests, and shared recovery/search mapping boundaries.

### Modified Capabilities

## Impact

- Affected code: `eslint.config.js`, TypeScript/Vitest configuration, package scripts, `src/backup/retention.test.ts`, `src/transport/mcp-http.test.ts`, tool contract tests, `src/tools/index.ts`, `src/search/index.ts`, and `src/storage/index.ts`.
- Audit coverage: F65 and F96, plus verification obligations for the other audit proposals.
- Development workflow: lint and CI become stricter; coverage starts from the measured current baseline and can only improve.
