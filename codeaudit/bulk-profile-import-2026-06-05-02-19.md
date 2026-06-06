# Code Audit — OpenSpec proposal `bulk-profile-import`

- **Date:** 2026-06-05 02:19
- **Scope:** OpenSpec proposal `bulk-profile-import`
- **Auditor:** Software-architect audit skill
- **Conventions applied:** TypeScript ESM, Zod config, Pino, Vitest, sql.js+Qdrant
- **Files reviewed:** 9 (`src/tools/import.ts`, `src/tools/import.test.ts`, `src/pipeline/parser.ts`, `src/pipeline/parser.test.ts`, `src/pipeline/index.ts`, `src/pipeline/index.test.ts`, `src/tools/index.ts`, `src/tools/schemas.ts`, `src/bootstrap/sections.ts`)

## Executive summary

The `bulk-profile-import` feature is well-implemented and faithfully reuses the existing `WritePipeline` for dedup, embedding, and storage. Input is validated with a strict Zod schema (length cap, namespace pattern, `additionalProperties: false`), the dry-run path is clean, and the summary response matches the spec contract. Security posture is good because every imported chunk passes through `WritePipeline.process()` — content is normalized, secret-scanned, and parameterized at the storage layer, so there is no injection surface from imported text.

The single material discrepancy is a **spec-vs-implementation drift on section count**: the proposal, design, spec, README, and tool schema all describe a "12-section bootstrap format", but the actual single-source-of-truth (`src/bootstrap/sections.ts`) defines only **10 storage-mapped sections**. The implementation correctly imports 10 and intentionally ignores sections 11–12; the drift is purely in the documentation/naming, but it is pervasive and user-facing.

Secondary findings are minor: the import handler emits no per-import structured log or duration/count metrics (only the generic wrapper logging), a mid-batch pipeline failure aborts the whole import with partial writes already committed and no progress reported, and the "integration tests" in tasks 4.1–4.3 are implemented as unit tests with a fully mocked pipeline rather than true end-to-end tests through a real `WritePipeline`.

No high-severity defects were found.

## Spec compliance

| Requirement / Task | Status | Evidence |
|---|---|---|
| Req: Import tool accepts profile format (`format`, `content`, `namespace` default `profile`, `dry_run` default `false`) | Done | `src/tools/import.ts:7-12` Zod schema matches contract exactly |
| Scenario: Valid profile import | Done | `src/tools/import.ts:41-43` → `parser.parseProfile`; `src/pipeline/parser.ts:29-55` maps per section table |
| Scenario: Valid freeform import (`type:semantic`, `tier:T2`, namespace) | Done | `src/pipeline/parser.ts:61-77` sets `semantic`/`T2`; namespace passed at `src/tools/import.ts:103` |
| Scenario: Missing content → `INVALID_INPUT` | Done | `src/tools/import.ts:9` `min(1)`; `:55-65` maps ZodError→`invalidInput` (code `INVALID_INPUT`, `src/errors/index.ts:24-25`) |
| Req: Profile section parsing (`## N.` detection, per-section metadata) | Drifted | `src/pipeline/parser.ts:22,35` correct; but only **10** sections exist (`src/bootstrap/sections.ts:19-180`), spec says 12 |
| Scenario: All 12 sections present | Drifted | Only 10 are mapped; sections 11–12 are silently skipped (`src/pipeline/parser.ts:35-36`), test asserts 10 (`src/pipeline/parser.test.ts:84-101`) |
| Scenario: Partial profile (no error, summary lists processed) | Done | `src/pipeline/parser.ts:34-38` skips unknown, tracks `sectionsProcessed`; test `src/pipeline/parser.test.ts:45-57` |
| Req/Scenario: Dry run returns preview, zero writes | Done | `src/tools/import.ts:48-49,67-90`; pipeline not invoked; test `src/tools/import.test.ts:108-132` |
| Req/Scenario: Deduplication on import (checksum, skip + `duplicates_skipped`) | Done | `src/tools/import.ts:114-121` counts NOOP as duplicate; checksum dedup in `src/pipeline/index.ts:110-119` |
| Req/Scenario: Import summary (`memories_created`, `duplicates_skipped`, `collections`, `sections_processed`) | Done | `src/tools/import.ts:126-133` |
| Task 1.1 Parser + section mapping table | Done | `src/pipeline/parser.ts:24`; table re-exported from `src/bootstrap/sections.ts:19` (single source of truth) |
| Task 1.2 `parseProfile` | Done | `src/pipeline/parser.ts:29-55` |
| Task 1.3 `parseFreeform` | Done | `src/pipeline/parser.ts:61-77` |
| Task 1.4 Parser unit tests (all sections, partial, freeform) | Done | `src/pipeline/parser.test.ts` (11 cases) |
| Task 2.1 Import handler + validation + `INVALID_INPUT` | Done | `src/tools/import.ts:7-12,35-65` |
| Task 2.2 Dry-run path | Done | `src/tools/import.ts:48-49,67-90` |
| Task 2.3 Write path via `WritePipeline.process` + duplicate tracking | Done | `src/tools/import.ts:92-122` |
| Task 2.4 Structured summary | Done | `src/tools/import.ts:126-133` |
| Task 3.1 Register tool + JSON schema | Done | `src/tools/schemas.ts:140-154`; consumed in `src/index.ts:101` |
| Task 3.2 Wire handler | Done | `src/tools/index.ts:88` dispatch → `handleImport` |
| Task 4.1 Integration test: 12-section profile + dedup | Partial | `src/tools/import.test.ts:38-84` exists but pipeline is **mocked** (`:18,29`); not a real end-to-end test, and covers 10 sections not 12 |
| Task 4.2 Integration test: freeform | Partial | `src/tools/import.test.ts:86-106` with mocked pipeline |
| Task 4.3 Integration test: dry-run zero writes | Done | `src/tools/import.test.ts:108-132` (dry-run needs no pipeline) |

## Findings overview

| # | Severity | Confidence | Effort | Dimension | Location | Summary |
|---|---|---|---|---|---|---|
| 1 | Medium | High | S | Maintainability | `src/bootstrap/sections.ts:14-19`, `specs/bulk-import/spec.md:21`, `src/tools/schemas.ts:142` | "12-section" naming drift vs 10 mapped sections across spec/docs/schema |
| 2 | Low | High | M | Testing | `src/tools/import.test.ts:18,29` | Tasks 4.1–4.2 "integration tests" use a fully mocked pipeline, not a real `WritePipeline` |
| 3 | Low | High | S | Logging | `src/tools/import.ts:92-134` | No per-import structured log or count/duration metric beyond the generic wrapper |
| 4 | Low | Medium | M | Stability | `src/tools/import.ts:101-122`, `src/pipeline/index.ts:43-45` | Mid-batch failure (e.g. secret rejection / embedding error) aborts whole import with partial writes already committed, no partial summary |

## Quick wins

- Replace "12-section" with "10-section" (or "the bootstrap section format") in `specs/bulk-import/spec.md`, `proposal.md`, `design.md`, `src/tools/schemas.ts:142,146`, and the README import section to match `src/bootstrap/sections.ts` (Finding 1).
- Add a single `ctx.logger.info({ event: 'import', format, memories_created, duplicates_skipped, sections: sectionsProcessed?.length })` at the end of `processMemories` for observability (Finding 3).

## Performance

The design's stated risk — large profiles being slow due to sequential per-memory embedding calls — is real but accepted in `design.md:50` with `dry_run` as the mitigation, and the 500 KB content cap (`src/tools/import.ts:9`) bounds worst-case work. Each memory triggers one embedding call plus a similarity search of up to 10 neighbors (`src/pipeline/index.ts:124,133-138`), all awaited serially in `src/tools/import.ts:101-122`. This matches the documented decision (Decision 3) and is acceptable for the onboarding use case. No issues found beyond the already-documented trade-off.

## Logging & observability

### [Low · High · S] Import handler emits no domain-specific log or metric — `src/tools/import.ts:92-134`

**Issue:** `processMemories` performs a potentially long, multi-write batch but produces no structured log line of its own. The only observability is the generic `tool_call` log and `bhgbrain_tool_handler_ms` histogram emitted by the wrapper in `src/tools/index.ts:56-59`, plus the memory-count gauge at `src/tools/import.ts:124`. There is no record of how many memories were created vs skipped, which sections were processed, or which namespace was targeted — exactly the data needed to debug a "my import didn't store everything" report.

**Why it matters:** Bulk import is the highest-fan-out tool; silent partial outcomes (see Finding 4) are hard to diagnose without an explicit summary log.

**Recommendation:** Emit one Pino info line at the end of `processMemories` (and one for dry-run) with `memories_created`, `duplicates_skipped`, `collections.length`, and `sections_processed`. Optionally add a `bhgbrain_import_memories_total` counter.

## Stability & reliability

### [Low · Medium · M] Mid-batch pipeline failure aborts import with partial writes and no summary — `src/tools/import.ts:101-122`

**Issue:** The loop awaits `ctx.pipeline.process()` for each parsed memory with no try/catch. If any single memory throws — most plausibly `WritePipeline` rejecting content that `containsSecret` (`src/pipeline/index.ts:43-45`) or an embedding-provider error that isn't covered by `fallback_to_threshold_dedup` — the entire `handleImport` rejects. Earlier memories in the batch have already been committed to SQLite+Qdrant (each `writeMemory` flushes, `src/storage/index.ts:42`), so the store is left in a partial state and the caller receives only a generic `INTERNAL`/`INVALID_INPUT` envelope with no indication of how far the import progressed.

**Why it matters:** A user importing a profile where one paragraph happens to look like a credential gets a hard failure with no partial summary, and a confusing partially-populated store. This is more likely with imported documents (wikis, exported notes) than with hand-typed `remember` calls.

**Recommendation:** Wrap the per-memory `process()` call in try/catch; collect failures into an `errors[]` array (mirroring the `repair` handler at `src/tools/index.ts:292,380-382`) and continue the batch, returning the partial summary plus an `errors` field. This makes import resilient and self-describing.

## Security

No issues found. All imported content flows through `WritePipeline.process()`, which normalizes (`normalizeContent`), runs `containsSecret` rejection (`src/pipeline/index.ts:41-45`), and writes via the storage layer (no string-concatenated SQL — sql.js parameterized inserts). Input is strictly validated: `content` is length-capped at 500 KB and required (`src/tools/import.ts:9`), `namespace` is constrained by `^[a-zA-Z0-9/-]{1,200}$` (`:10`), `format` is an enum, and `.strict()` rejects unknown keys (`:12`). Imported text is never interpreted as markup/HTML or executed; it is stored and embedded as opaque content. There is no injection surface from imported data.

## Maintainability & code quality

### [Medium · High · S] "12-section" naming drift versus 10 mapped sections — `src/bootstrap/sections.ts:14-19`

**Issue:** The proposal, design, spec scenarios ("All 12 sections present"), the tool description and `format` enum docstring (`src/tools/schemas.ts:142,146`), and the README all refer to a "12-section bootstrap format". The actual single source of truth, `BOOTSTRAP_SECTIONS` in `src/bootstrap/sections.ts:19-180`, defines exactly **10** storage-mapped sections, and the parser intentionally ignores any heading numbered 11 or 12 (`src/pipeline/parser.ts:35-36`; test `src/pipeline/parser.test.ts:84-101` asserts this). The code comment even states "The 10 storage-mapped sections" (`src/bootstrap/sections.ts:15`). The implementation is internally consistent and correct; only the surrounding documentation/schema text is wrong.

**Why it matters:** A user reading the tool schema or README will format a "12-section" document expecting all 12 to import, but sections 11–12 are silently dropped with no warning in the summary. The mismatch also undermines the spec as a verification artifact.

**Recommendation:** Update the spec, proposal, design, README, and `src/tools/schemas.ts:142,146` to say "10-section" (consistent with the bootstrap tool, already described as a "10-section interview" in the README). Alternatively, if sections 11–12 are deliberately non-storage, state that explicitly in the tool description.

## Testing & coverage

### [Low · High · M] Tasks 4.1–4.2 "integration tests" mock the entire pipeline — `src/tools/import.test.ts:18,29`

**Issue:** Tasks 4.1 ("full 12-section profile import **with dedup verification**") and 4.2 are checked off, but `import.test.ts` injects `pipeline: { process: pipelineProcess }` as a `vi.fn()` (`src/tools/import.ts:29`) and asserts on the mock's call args and a hand-coded NOOP return (`:61-84`). No test exercises a real `WritePipeline` against a real (temporary) `SqliteStore`/Qdrant stub, so the actual checksum dedup path, secret rejection, and SQLite persistence are never verified end-to-end for the import flow. The genuine pipeline tests in `src/pipeline/index.test.ts` cover `WritePipeline` in isolation but never call the import handler.

**Why it matters:** The dedup-on-import guarantee (a named spec requirement) and the partial-failure behavior (Finding 4) are untested at the integration level; a regression in how the handler maps `WriteResult.operation` to counters, or in real dedup, would pass CI.

**Recommendation:** Add one true integration test that constructs a real `WritePipeline` with a temporary SQLite store and a stub embedding provider, imports a profile twice, and asserts the second import reports `duplicates_skipped` > 0 and writes nothing new. Update the section count to 10.

## Dependencies & supply chain

No issues found. The feature introduces no new external dependencies, as promised in `proposal.md:27`. It reuses `zod` (already a project dependency) for validation and `uuid` only transitively via the existing pipeline. Parsing is dependency-free regex/string splitting (`src/pipeline/parser.ts`), consistent with Decision 2's goal of keeping the feature deterministic and dependency-free.

## Recommendations (prioritized)

1. **(Medium, S)** Fix the "12-section" → "10-section" drift across spec, proposal, design, README, and `src/tools/schemas.ts:142,146` so docs match `src/bootstrap/sections.ts`. Optionally surface "ignored_sections" in the summary so dropped 11/12 headings are visible (Finding 1).
2. **(Low, M)** Make import resilient to per-memory failures: try/catch each `pipeline.process()`, collect `errors[]`, and return a partial summary instead of aborting (Finding 4).
3. **(Low, M)** Add a real end-to-end integration test with a live `WritePipeline` + temp SQLite verifying dedup-on-import and persistence (Finding 2).
4. **(Low, S)** Emit a per-import structured Pino log and an import counter for observability (Finding 3).
