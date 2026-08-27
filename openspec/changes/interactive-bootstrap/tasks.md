## 1. Shared Section Definitions

- [x] 1.1 Create `src/bootstrap/sections.ts` with the 10-section definition array (title, questions, collection, tier, type, importance, tags)
- [x] 1.2 Add unit tests verifying all 10 sections have valid metadata mappings
- [x] 1.3 Refactor `ProfileParser` (from bulk-profile-import) to import section mappings from this shared module

## 2. Session State Storage

- [x] 2.1 Add `bootstrap_sessions` table to SQLite schema (namespace, section_number, status, memory_ids JSON, updated_at)
- [x] 2.2 Create `src/bootstrap/session.ts` with CRUD operations: createSession, getSession, updateSection, resetSection
- [x] 2.3 Add unit tests for session state CRUD (create, resume, update, reset)

## 3. Bootstrap Tool Handler

- [x] 3.1 Create `src/tools/bootstrap.ts` with action routing (start, submit, status, reset) and input validation
- [x] 3.2 Implement `start` action: create or resume session, return first incomplete section
- [x] 3.3 Implement `submit` action: parse answers into memories, store via WritePipeline, update session state, return next section
- [x] 3.4 Implement `status` action: return session progress overview
- [x] 3.5 Implement `reset` action: delete tracked memories, mark section as pending

## 4. MCP Tool Registration

- [x] 4.1 Register `bhgbrain.bootstrap` tool in `src/index.ts` with JSON schema for params (action, section, answers, namespace)

## 5. Integration Tests

- [x] 5.1 Add integration test: full start → submit all 10 sections → completion flow
- [x] 5.2 Add integration test: resume session after simulated restart
- [x] 5.3 Add integration test: reset section deletes memories and allows re-submission

## Audit follow-ups (2026-06-05)

> Source: `codeaudit/interactive-bootstrap-2026-06-05-02-19.md` (Findings 1 & 2) and
> `codeaudit/bulk-profile-import-2026-06-05-02-19.md` (Finding 1, same root drift). This
> proposal OWNS the canonical reconciliation of the bootstrap section count shared by
> `src/bootstrap/sections.ts` and the `import` tool, so the `bulk-profile-import` drift is
> resolved here — no separate proposal is needed.

- [x] 6.1 RECONCILE the section count to the canonical value of **10** (code, tests, and the
      Zod validator already use 10 via `BOOTSTRAP_SECTIONS`/`TOTAL_SECTIONS` in
      `src/bootstrap/sections.ts`; only the proposal/design/spec/tasks and two tool
      description strings still say "12"). Align ALL of the following to 10:
  - [x] 6.1.1 This proposal's spec (`specs/bootstrap-session/spec.md`): "all 12 sections" →
        "all 10 sections" everywhere, and the out-of-range scenario bound.
  - [x] 6.1.2 This proposal's design.md and proposal.md narrative references to "12-section".
  - [x] 6.1.3 Tasks 1.1, 1.2, and 5.1 above (currently "12-section" / "all 12 sections").
  - [x] 6.1.4 The Zod validator's `section` bound — confirm it caps at `TOTAL_SECTIONS` (10),
        matching the corrected "section outside 1–10 → INVALID_INPUT" scenario (it must NOT
        accept 11–12). (Already correct: `src/tools/bootstrap.ts` uses
        `z.number().int().min(1).max(TOTAL_SECTIONS)` and `src/tools/schemas.ts`'s JSON
        schema already had `maximum: 10`.)
  - [x] 6.1.5 The `import` tool description / `format` enum docstring in
        `src/tools/schemas.ts` (still says "12-section bootstrap format") → "10-section".
  - [x] 6.1.6 The `bulk-profile-import` parser (`src/pipeline/parser.ts`): it currently
        silently ignores headings 11–12 — make this behavior explicit/documented (or surface
        ignored sections) so a "12-section" document no longer drops data without notice.
        (`parseProfile` now returns `sectionsIgnored`, surfaced by the `import` tool as
        `sections_ignored`.)
  - [x] 6.1.7 Keep `README.md` "MCP Tools Reference" in sync per CLAUDE.md. (Translated
        READMEs do not contain an `import`/bootstrap tools-reference section to mirror —
        pre-existing gap, out of scope for this wording fix.)

- [x] 6.2 BUG (Finding 2): `reset` clears the tracked `memory_ids` from SQLite BEFORE the
      Qdrant vectors are deleted (`src/storage/sqlite.ts` `resetBootstrapSection` zeroes the
      column, then `src/tools/bootstrap.ts` loops `deleteMemory`). A `deleteMemory` failure
      (or crash) after the column is zeroed orphans the vectors/rows with no recovery list.
      Delete the Qdrant vectors (and SQLite memory rows) FIRST, and only clear `memory_ids` /
      mark the section pending after the deletions succeed — or wrap the reset so the ID list
      is preserved on partial failure. Reset must leave the two stores consistent.
  - [x] 6.2.1 Add a failure-path test: make `deleteMemory` reject mid-reset and assert the
        section's tracked `memory_ids` remain recoverable (not silently lost).
