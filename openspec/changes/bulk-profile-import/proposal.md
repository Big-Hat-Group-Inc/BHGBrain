## Why

The MCP-aware bootstrap prompt works well for interactive onboarding, but users with existing profile documents (from a previous bootstrap, a wiki page, or structured notes) must manually call `remember` for each piece of information. There is no way to ingest a complete profile in one shot, which makes migration and re-onboarding tedious.

## What Changes

- Add a new `bhgbrain.import` MCP tool that accepts structured profile text or freeform documents
- Implement a section parser in `src/pipeline/` that recognizes the 12-section bootstrap format and splits it into discrete memories
- Support two input formats: `profile` (structured 12-section output) and `freeform` (arbitrary text chunked via extraction)
- Add `dry_run` mode that returns a preview of what would be stored without writing
- Apply deduplication via existing checksum-based dedup in the write pipeline
- Return a summary report: memories created, collections touched, duplicates skipped

## Capabilities

### New Capabilities
- `bulk-import`: Accepts structured or freeform documents, parses them into discrete memories with correct namespace/collection/tier/importance/tags, and stores them atomically via the existing write pipeline

### Modified Capabilities

_None — this builds on the existing write pipeline and `remember` tool without changing their behavior._

## Impact

- **New files:** Section parser in `src/pipeline/`, import tool handler in `src/tools/`
- **Modified files:** Tool registration in MCP server entry point (`src/index.ts`)
- **Dependencies:** No new external dependencies; reuses existing write pipeline, embedding provider, and storage manager
- **APIs:** Adds one new MCP tool (`bhgbrain.import`); no breaking changes to existing tools
