## Why

First-time users currently need to paste the bootstrap prompt into their MCP client and manually drive the 12-section interview. There is no way to pause mid-interview and resume later, nor is there built-in progress tracking. A stateful `bhgbrain.bootstrap` tool would provide a fully guided onboarding experience managed by BHGBrain itself, with session persistence across conversations.

## What Changes

- Add a new `bhgbrain.bootstrap` MCP tool with actions: `start`, `submit`, `status`, and `reset`
- Implement session state tracking (which sections are complete, memory counts per collection) persisted in SQLite
- `start` returns the first incomplete section's questions and instructions
- `submit` accepts answers for a section, stores memories via the write pipeline, and advances to the next section
- `status` returns a progress overview (sections complete, memory counts, last updated)
- `reset` clears and re-runs a specific section, removing its stored memories before re-collecting

### Audit follow-ups (2026-06-05)

Two issues surfaced by the code audit (`codeaudit/interactive-bootstrap-2026-06-05-02-19.md`
and `codeaudit/bulk-profile-import-2026-06-05-02-19.md`, same root drift):

- **Canonical section count = 10.** The proposal/design/spec/tasks and two tool description
  strings said "12 sections", but the implementation, tests, and Zod validator use **10**
  (`BOOTSTRAP_SECTIONS` / `TOTAL_SECTIONS` in `src/bootstrap/sections.ts`). This change
  reconciles every reference to 10 — spec, tasks, the "outside 1–12 → INVALID_INPUT"
  scenario (now 1–10), the `import` tool description ("12-section bootstrap format"), and the
  `bulk-profile-import` parser that silently drops headings 11–12. Because the section table
  is shared, this **also resolves the `bulk-profile-import` drift — no separate proposal.**
- **Reset cross-store ordering bug.** `reset` cleared the SQLite `memory_ids` tracking before
  deleting the Qdrant vectors, orphaning vector data if a deletion failed. Reset now deletes
  vectors first and only clears tracking after deletions succeed (preserving the recovery
  list on partial failure).

## Capabilities

### New Capabilities
- `bootstrap-session`: Stateful interview session management — start, submit answers, track progress, resume across conversations, and reset individual sections

### Modified Capabilities

_None — this adds a new tool without changing existing tool behavior._

## Impact

- **New files:** Bootstrap tool handler, session state module, section question definitions
- **Modified files:** MCP tool registration in `src/index.ts`, SQLite schema (new `bootstrap_sessions` table)
- **Dependencies:** No new external dependencies; reuses existing write pipeline and SQLite store
- **APIs:** Adds one new MCP tool (`bhgbrain.bootstrap`); no breaking changes
- **Data:** New SQLite table for session state; no migration needed for existing data
