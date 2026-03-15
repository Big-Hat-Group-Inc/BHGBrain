# BHGBrain Roadmap

## Completed

### MCP-Aware Bootstrap Prompt ✅
- Rewrote `BootstrapPrompt.txt` to store memories via `bhgbrain.remember` as the interview progresses
- Discrete memories per entity/goal/role (not monolithic blocks)
- Storage mapping: section → collection, tier, type, importance, tags
- Update mode for re-running individual sections without duplication
- Verification step confirms all memories stored
- Works with any MCP-connected agent today — zero code changes

---

## Planned

### Bulk Profile Import Tool
**Priority:** Medium  
**Effort:** ~1–2 days  

Add a `bhgbrain.import` tool that accepts a structured profile (the 12-section output from the bootstrap interview) and atomically creates individual memories with correct namespaces, collections, tags, tiers, and categories.

**Why:** The MCP-aware bootstrap prompt works well for interactive onboarding, but some users will have an existing profile document (from a previous bootstrap, a wiki page, or a structured notes file) they want to ingest in one shot. Currently they'd need to manually call `remember` for each piece.

**Proposed interface:**
```json
{
  "name": "import",
  "params": {
    "format": "profile | freeform",
    "content": "<structured profile text or freeform document>",
    "namespace": "profile",
    "dry_run": true
  }
}
```

**Behavior:**
- `format: "profile"` — Parses the 12-section bootstrap output, splits into discrete memories, assigns collection/tier/importance/tags per the storage mapping table
- `format: "freeform"` — Uses the extraction pipeline to chunk and classify arbitrary text into memories
- `dry_run: true` — Returns what would be stored without writing (for review)
- Deduplication applies — safe to re-import after updates
- Returns a summary: N memories created across Y collections, M duplicates skipped

**Implementation notes:**
- Add section parser to `src/pipeline/` that recognizes the 12-section format (heading-based splitting)
- Reuse existing `remember` pipeline for each extracted memory (dedup, embedding, storage)
- Freeform mode can leverage the existing extraction model (`BHGBRAIN_EXTRACTION_API_KEY`) for chunking

---

### Interactive Bootstrap Tool (Future)
**Priority:** Low  
**Effort:** ~3–5 days  

Add a stateful `bhgbrain.bootstrap` tool that drives the interview from within BHGBrain itself, tracking progress across sessions.

**Why:** For first-time users who want a fully guided experience without needing to paste the bootstrap prompt. The tool manages state, so users can pause and resume across sessions.

**Proposed interface:**
```json
bhgbrain.bootstrap({ "action": "start" })
// → Returns section 1 questions + instructions

bhgbrain.bootstrap({ "action": "submit", "section": 1, "answers": {...} })
// → Stores memories, returns next section

bhgbrain.bootstrap({ "action": "status" })
// → Shows which sections are complete, memory counts per collection

bhgbrain.bootstrap({ "action": "reset", "section": 3 })
// → Clears and re-runs a specific section
```

**Deferred because:** The MCP-aware prompt + import tool cover 95% of use cases. This is a polish feature for when BHGBrain has external users who need hand-holding.
