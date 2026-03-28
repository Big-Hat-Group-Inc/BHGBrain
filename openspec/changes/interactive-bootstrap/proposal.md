## Why

First-time users currently need to paste the bootstrap prompt into their MCP client and manually drive the 12-section interview. There is no way to pause mid-interview and resume later, nor is there built-in progress tracking. A stateful `bhgbrain.bootstrap` tool would provide a fully guided onboarding experience managed by BHGBrain itself, with session persistence across conversations.

## What Changes

- Add a new `bhgbrain.bootstrap` MCP tool with actions: `start`, `submit`, `status`, and `reset`
- Implement session state tracking (which sections are complete, memory counts per collection) persisted in SQLite
- `start` returns the first incomplete section's questions and instructions
- `submit` accepts answers for a section, stores memories via the write pipeline, and advances to the next section
- `status` returns a progress overview (sections complete, memory counts, last updated)
- `reset` clears and re-runs a specific section, removing its stored memories before re-collecting

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
