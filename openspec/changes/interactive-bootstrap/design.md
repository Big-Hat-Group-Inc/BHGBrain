## Context

BHGBrain's onboarding relies on the MCP-aware bootstrap prompt — a 12-section interview that the user pastes into their MCP client. The client's agent drives the conversation, calling `bhgbrain.remember` for each piece of information. This works but requires the user to manage the prompt externally. There is no persistence if the conversation is interrupted, and no way to check which sections are done.

The bulk-profile-import tool (separate change) handles batch ingestion of completed profiles. This change complements it by providing a guided, incremental interview flow managed entirely within BHGBrain.

## Goals / Non-Goals

**Goals:**
- Provide a stateful MCP tool that drives the 12-section interview from within BHGBrain
- Persist session state in SQLite so users can resume across conversations
- Allow resetting individual sections without affecting others
- Reuse the existing write pipeline for memory storage
- Return clear progress indicators at each step

**Non-Goals:**
- Custom question sets or user-defined sections (hardcoded to the 12-section format)
- Multi-user session management (one active session per namespace)
- UI/frontend — this is a tool-level API; the MCP client renders the interaction
- Replacing the existing bootstrap prompt — both paths coexist

## Decisions

### 1. Session state stored in a new SQLite table

**Decision:** Create a `bootstrap_sessions` table with columns: `namespace` (PK), `section_number`, `status` (pending/complete), `memory_ids` (JSON array of stored memory IDs), `updated_at`. One row per section per namespace.

**Rationale:** SQLite is already the local state store. A dedicated table keeps session state queryable and transactional. Alternative: JSON file — rejected because it's not transactional and adds a new storage path to maintain.

### 2. Section definitions as a static configuration module

**Decision:** Create `src/bootstrap/sections.ts` containing the 12 section definitions: title, questions/prompts, and metadata mapping (collection, tier, type, importance, tags). This is the same mapping table used by the profile parser in bulk-profile-import.

**Rationale:** Centralizes the section knowledge. Both the bootstrap tool and the profile parser can import from the same source, preventing drift. Alternative: Store sections in the database — rejected because they're static content, not user data.

### 3. Single active session per namespace

**Decision:** Only one bootstrap session exists per namespace. Calling `start` when a session exists resumes it (returns the first incomplete section). To truly restart, call `reset` for each section or all sections.

**Rationale:** Simplifies state management. Multiple concurrent sessions per namespace would create confusion about which memories belong to which session.

### 4. Reset deletes stored memories before re-collecting

**Decision:** `reset` for a section deletes all memories whose IDs are tracked in `memory_ids` for that section row, then marks the section as pending.

**Rationale:** Clean reset ensures no stale data. The `memory_ids` column provides an exact deletion list without needing content-based matching.

### 5. Canonical section count is 10 (audit reconciliation, 2026-06-05)

**Decision:** The bootstrap interview has **10** storage-mapped sections, not 12. The single
source of truth is `BOOTSTRAP_SECTIONS` / `TOTAL_SECTIONS` in `src/bootstrap/sections.ts`,
already used by the bootstrap tool, the profile parser, the tests, and the Zod validator. All
"12-section" references in this proposal's narrative, the spec scenarios, the tasks, the
"section outside 1–12 → INVALID_INPUT" bound (now 1–10), and the `import` tool description
strings in `src/tools/schemas.ts` are corrected to 10.

**Rationale:** The audit (`codeaudit/interactive-bootstrap-2026-06-05-02-19.md` Finding 1)
found the docs/spec drifted from internally-consistent code. Because the section table is
shared with bulk import, the same drift was independently flagged in
`codeaudit/bulk-profile-import-2026-06-05-02-19.md` (Finding 1). Owning the reconciliation
here keeps a single source of truth and **resolves the `bulk-profile-import` drift without a
separate proposal**. The `bulk-profile-import` parser must also stop silently dropping
headings 11–12 (make the ignore explicit / surface it), so a "12-section" document no longer
loses data without notice. Choosing 10 (over restoring 2 sections) avoids changing runtime
behavior and matches what users already see in the README "10-section interview" wording.

### 6. Reset deletes vectors before clearing SQLite tracking (audit fix, 2026-06-05)

**Decision:** `reset` SHALL delete the section's memories — including their Qdrant vectors —
**before** it clears the `memory_ids` column or marks the section pending. On a partial
deletion failure the `memory_ids` list SHALL be preserved so the section remains recoverable
and re-resettable.

**Rationale:** The audit (`codeaudit/interactive-bootstrap-2026-06-05-02-19.md` Finding 2)
found `resetBootstrapSection` zeroed `memory_ids` in SQLite first and then looped
`deleteMemory`; a `deleteMemory` throw (Qdrant failure) or crash after the column was zeroed
orphaned the vectors/rows with no tracked recovery list — contradicting Decision 4's guarantee
that `memory_ids` "provides an exact deletion list". Deleting vectors first (or wrapping the
operation so the ID list survives failure) keeps the two stores consistent.

## Risks / Trade-offs

- **Section definition coupling** — The 12-section format is hardcoded; changes to the bootstrap prompt require code updates → Mitigation: Extract section definitions into a shared module that both bootstrap and import tools reference.
- **Memory deletion on reset** — If a user manually modified a memory that was originally created by bootstrap, reset will delete it → Mitigation: Acceptable trade-off; document that reset removes section memories.
- **Large tool response sizes** — Returning full section questions in a single tool response may be verbose → Mitigation: Keep question text concise; the MCP client's agent can elaborate.
