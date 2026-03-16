# BHGBrain Memory Management Specification

> Strategies for tiered memory retention, vector database hygiene, and long-term knowledge preservation.

## 1. Problem Statement

BHGBrain stores all memories in a single vector store (Qdrant) backed by SQLite metadata. Without lifecycle management, the vector database accumulates low-value ephemeral data — old trouble tickets, stale reports, transient emails, expired task context — alongside high-value persistent knowledge like architectural references, legal guidance, and accounting practices.

This degrades retrieval quality. When the vector space is polluted with thousands of expired support tickets, a semantic search for "authentication architecture" returns noise alongside signal. The embedding space becomes crowded, similarity scores flatten, and the system loses its ability to surface what matters.

The goal is a memory management layer that:
- Prevents unbounded vector database growth from transient content
- Preserves long-term knowledge that rarely changes but must persist indefinitely
- Classifies incoming memories by retention tier automatically
- Enforces cleanup without losing institutional knowledge

## 2. Memory Tier Model

All memories are assigned a **retention tier** that governs their lifecycle. Tiers are determined at ingestion time and can be promoted or demoted.

### 2.1 Tier Definitions

| Tier | Label | TTL | Examples | Auto-Cleanup |
|---|---|---|---|---|
| `T0` | **Foundational** | Never expires | Architecture references, legal requirements, accounting standards, company policies, compliance mandates | No |
| `T1` | **Institutional** | Expires after 365 days of zero access | Software design decisions, API contracts, deployment runbooks, coding standards, vendor agreements | Yes, with warning |
| `T2` | **Operational** | Expires after 90 days of zero access | Project status, sprint decisions, meeting outcomes, technical investigations | Yes |
| `T3` | **Transient** | Expires after 30 days | Trouble tickets, email summaries, daily reports, ad-hoc questions, debugging sessions | Yes |

### 2.2 Tier Assignment Rules

Tier assignment occurs during the write pipeline (spec.md Section 4) after extraction:

1. **Explicit assignment**: Caller passes `retention_tier` in the `remember` tool input. This takes precedence.
2. **Category-based**: Memories stored as persistent categories (Section 3.2 of spec.md) are always `T0`.
3. **Source-based heuristics**:
   - `source: import` with tags containing `architecture`, `legal`, `compliance`, `accounting`, `policy`, `standard` -> `T0`
   - `source: agent` with `type: procedural` -> `T1`
   - `source: agent` with `type: episodic` -> `T2`
   - `source: cli` with no explicit tier -> `T2`
   - Content matching transient patterns (ticket IDs, email headers, report dates) -> `T3`
4. **LLM classification** (when extraction pipeline is active): The extraction model assigns a tier based on content analysis. The prompt instructs the model to evaluate whether the content represents durable reference knowledge or time-bound operational context.
5. **Default**: `T2` (operational) if no other rule matches.

### 2.3 Tier Promotion and Demotion

- **Auto-promotion**: A `T2` or `T3` memory accessed more than 5 times within its TTL window is promoted one tier (e.g., `T3` -> `T2`). This prevents frequently-referenced operational knowledge from being garbage collected.
- **Manual promotion**: `bhgbrain tier set <id> T0` or via the `tag` tool with `retention_tier` update.
- **Demotion**: Not automatic. A user or admin can explicitly demote a memory (e.g., an obsolete architecture decision moved from `T0` to `T1`).

## 3. Long-Term Knowledge Store (T0/T1)

### 3.1 Characteristics of Long-Term Knowledge

Long-term knowledge is content that:
- Provides reference value months or years after creation
- Does not become stale on a fixed schedule
- Is consulted infrequently but critically (e.g., legal compliance during an audit)
- Represents institutional decisions that inform ongoing work

Examples by domain:

| Domain | Content Type | Why It Persists |
|---|---|---|
| Software Architecture | System diagrams, API contracts, dependency maps, technology choices | Informs every code change; rarely changes itself |
| Legal / Compliance | Regulatory requirements, data handling policies, retention mandates, license obligations | Must be available for audits; changes only with new regulations |
| Accounting | Chart of accounts references, reporting standards, fiscal calendar rules, tax treatment decisions | Guides financial operations; changes annually at most |
| Security | Threat models, access control policies, incident response procedures | Must be current and always retrievable |
| Operations | Runbooks, escalation paths, infrastructure topology | Referenced during incidents; updated periodically |

### 3.2 Storage Strategy for Long-Term Knowledge

Long-term memories (T0/T1) receive special treatment in both vector and persistent stores:

**Vector store (Qdrant):**
- Payload includes `retention_tier: "T0"` or `"T1"` and `persistent: true`
- These points are excluded from all TTL cleanup jobs
- Indexed on `retention_tier` for fast filtering
- T0 memories are always included in hybrid search results regardless of score threshold (boosted by +0.1 to final score)

**SQLite (metadata):**
- T0/T1 memories have `decay_exempt = 1` in the metadata table
- Full content stored in SQLite as well (not just summary), enabling recovery if vector store is rebuilt
- `revision` column tracks content updates (append-only history for T0)
- `review_due` date field for T1 memories (set to `created_at + 365 days`, reset on access)

### 3.3 T0 Version History

Foundational knowledge changes rarely, but when it does the previous version must be preserved:

- On `UPDATE` of a T0 memory, the prior content is archived in a `memory_revisions` SQLite table
- Revision records: `{ memory_id, revision, content, updated_at, updated_by }`
- The vector store always contains only the current version embedding
- Prior versions are searchable via FTS5 on the revisions table but not via semantic search

## 4. Transient Memory Lifecycle (T2/T3)

### 4.1 Ingestion Tagging

At write time, transient memories receive additional metadata:

```json
{
  "retention_tier": "T3",
  "expires_at": 1712000000,
  "decay_eligible": true,
  "access_count": 0,
  "last_accessed": null
}
```

`expires_at` is computed as `created_at + tier_ttl_seconds`. This is stored in both the Qdrant payload and SQLite metadata.

### 4.2 Access Tracking

Every retrieval (via `recall`, `search`, or `memory://inject`) updates:
- `access_count += 1`
- `last_accessed = now()`
- `expires_at = max(expires_at, now() + tier_ttl_seconds)` (sliding window)

This means actively-used memories never expire, while untouched memories hit their TTL.

### 4.3 Cleanup Job

A background reaper runs on a configurable schedule (default: daily at 02:00 local time, or manual via `bhgbrain gc`):

```
Phase 1: Identify expired non-persistent points
  - Query Qdrant: persistent == false AND expires_at < now()
  - Exclude any memory with retention_tier T0 or T1

Phase 2: Archive before delete (optional, configurable)
  - For each expired memory, write a compressed summary to the archive table
  - Archive record: { memory_id, summary, tier, created_at, expired_at, access_count }

Phase 3: Delete from Qdrant and SQLite
  - Batch delete from Qdrant (filter-based)
  - Delete corresponding SQLite rows
  - Log deletion count to audit trail

Phase 4: Compact
  - Trigger Qdrant vacuum if deleted_threshold exceeded
  - Run SQLite VACUUM if fragmentation warrants it
```

### 4.4 Pre-Expiry Warning

Memories approaching expiration (within 7 days of `expires_at`) are flagged in the `memory://inject` payload with a `expiring_soon: true` indicator. This allows agents to decide whether to promote them.

## 5. Vector Database Hygiene

### 5.1 Capacity Budgets

Configuration controls to prevent unbound growth:

```json
{
  "retention": {
    "max_memories": 500000,
    "max_db_size_gb": 2,
    "warn_at_percent": 80,
    "tier_budgets": {
      "T0": null,
      "T1": 100000,
      "T2": 200000,
      "T3": 200000
    }
  }
}
```

- `T0` has no cap (foundational knowledge must always fit)
- `T1`-`T3` have soft caps; when exceeded, the cleanup job aggressively prunes the oldest/lowest-access memories in that tier first
- When total `warn_at_percent` is reached, the health endpoint reports `degraded` with a warning message

### 5.2 Embedding Space Quality

Over time, the vector space can degrade as deleted point IDs fragment the HNSW index. Mitigation:

- **Segment compaction**: Set Qdrant `deleted_threshold` to 0.10 (compact when 10% of a segment is deleted)
- **Periodic reindex**: On major cleanup runs (>5% of total points deleted), trigger a full segment rebuild
- **Collection rotation** (future): If embedding model changes, create a new collection and migrate T0/T1 first, then backfill T2/T3 as they are accessed

### 5.3 Duplicate Prevention at Ingestion

The existing dedup pipeline (spec.md Section 4.2) prevents duplicate writes. For memory management specifically:

- T3 memories with cosine similarity >= 0.95 to an existing T3 memory are automatically `NOOP`
- T0/T1 memories use a stricter threshold (>= 0.98) since near-duplicates may represent intentional versioning
- Email and ticket content is normalized (strip headers, signatures, forwarding chains) before embedding to reduce false uniqueness

## 6. Content Classification Signals

The system uses these signals to classify memory value:

### 6.1 High-Value Indicators (push toward T0/T1)

- Contains architectural terms: `architecture`, `design decision`, `ADR`, `RFC`, `contract`, `schema`
- Contains compliance terms: `regulation`, `HIPAA`, `SOC2`, `GDPR`, `audit`, `retention requirement`
- Contains accounting terms: `GAAP`, `revenue recognition`, `chart of accounts`, `fiscal year`
- Contains legal terms: `agreement`, `license`, `liability`, `obligation`, `SLA`, `terms of service`
- Referenced by persistent categories
- Explicitly tagged with `persistent`, `reference`, `standard`
- High importance score (>= 0.8) assigned by extraction model

### 6.2 Low-Value Indicators (push toward T2/T3)

- Contains temporal markers: `today`, `this week`, `by Friday`, `Q3 2026`, `sprint 14`
- Contains ticket/issue references: `JIRA-1234`, `#456`, `incident report`, `support case`
- Contains email metadata: `From:`, `Subject:`, `FW:`, `RE:`, date headers
- Contains meeting context: `standup notes`, `meeting minutes`, `action items from`
- Short content (< 50 chars) with no tags
- Low importance score (< 0.3)
- Source is `agent` with type `episodic` and no explicit tier

## 7. Configuration

New config keys under `retention`:

```json
{
  "retention": {
    "decay_after_days": 180,
    "max_db_size_gb": 2,
    "max_memories": 500000,
    "warn_at_percent": 80,
    "tier_ttl": {
      "T0": null,
      "T1": 365,
      "T2": 90,
      "T3": 30
    },
    "tier_budgets": {
      "T0": null,
      "T1": 100000,
      "T2": 200000,
      "T3": 200000
    },
    "auto_promote_access_threshold": 5,
    "sliding_window_enabled": true,
    "archive_before_delete": true,
    "cleanup_schedule": "0 2 * * *",
    "pre_expiry_warning_days": 7,
    "compaction_deleted_threshold": 0.10
  }
}
```

## 8. Schema Changes

### 8.1 Memory Record Additions

New fields on the memory record (extends spec.md Section 3.3):

```text
retention_tier     T0 | T1 | T2 | T3
expires_at         ISO 8601 (null for T0)
decay_eligible     boolean
review_due         ISO 8601 (T1 only, null otherwise)
archived           boolean (default false)
```

### 8.2 New SQLite Tables

**`memory_revisions`** (T0 version history):
```sql
CREATE TABLE memory_revisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id   TEXT NOT NULL REFERENCES memories(id),
  revision    INTEGER NOT NULL,
  content     TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT,
  UNIQUE(memory_id, revision)
);
```

**`memory_archive`** (deleted memory summaries):
```sql
CREATE TABLE memory_archive (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id     TEXT NOT NULL,
  summary       TEXT NOT NULL,
  tier          TEXT NOT NULL,
  namespace     TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  expired_at    TEXT NOT NULL,
  access_count  INTEGER NOT NULL DEFAULT 0,
  tags          TEXT
);
```

### 8.3 Qdrant Payload Index Additions

New payload indexes required for efficient filtering:

- `retention_tier` (keyword index)
- `expires_at` (integer/range index)
- `decay_eligible` (boolean index)

## 9. CLI Extensions

```bash
# Tier management
bhgbrain tier show <id>              # Show tier and expiration for a memory
bhgbrain tier set <id> <T0|T1|T2|T3> # Change retention tier
bhgbrain tier list --tier T0         # List all memories in a tier

# Archive inspection
bhgbrain archive list                # List archived (deleted) memory summaries
bhgbrain archive search <query>      # Search archive by text
bhgbrain archive restore <id>        # Restore an archived memory

# Cleanup
bhgbrain gc --dry-run                # Show what would be cleaned up
bhgbrain gc --tier T3                # Clean up only T3 memories
bhgbrain gc --force-compact          # Force Qdrant segment compaction

# Diagnostics
bhgbrain stats --by-tier             # Memory count and size breakdown by tier
bhgbrain stats --expiring            # Show memories expiring in next 7 days
```

## 10. Integration with Existing Spec

This memory management specification extends (does not replace) the core BHGBrain application specification as represented by the current repository structure (`README.md`, `AGENTS.md`, and the `src/` module boundaries):

| Core Spec Section | Extension |
|---|---|
| 3.2 Persistent Categories | Categories are always `T0`. No change to behavior. |
| 3.3 Memory Record Schema | Four new fields added (Section 8.1 above). |
| 4.1 Extraction | Extraction output now includes `retention_tier` recommendation. |
| 4.2 Decision Pipeline | Dedup thresholds vary by tier (Section 5.3). |
| 5. Retention | TTL model replaced by tier-based system. `decay_after_days` becomes `T2` default. |
| 6.5 Graceful Degradation | Cleanup job failure is non-fatal; memories persist longer rather than being lost. |
| 7.2 `remember` Tool | New optional input: `retention_tier`. |
| 9. Configuration | New `tier_ttl` and `tier_budgets` config keys. |

## 11. Architectural Guidance

This section translates the retention model into an implementation shape that fits the current BHGBrain codebase. The goal is to keep memory management a first-class subsystem, not a scattered set of TTL checks spread across tools and storage calls.

### 11.1 Recommended Module Ownership

The feature should be implemented as a thin vertical slice across existing modules:

| Module | Responsibility |
|---|---|
| `src/domain/` | Canonical retention tier types, TTL rules, promotion rules, and classification helpers |
| `src/pipeline/` | Tier assignment during write, dedup thresholds by tier, archive decisions before delete |
| `src/storage/` | Persistence of retention metadata, revision/archive tables, atomic SQLite + Qdrant coordination |
| `src/search/` | Tier-aware scoring, access tracking on successful retrieval, expiring-soon indicators |
| `src/health/` | Capacity warnings, cleanup metrics, tier distribution metrics, degraded-state reporting |
| `src/cli/` | `tier`, `archive`, `gc`, and `stats` subcommands |
| `src/tools/` and `src/resources/` | MCP exposure for retention-aware read/write operations |

Architecturally, retention policy should not live inside individual tools. Tools call domain and pipeline services; those services own policy.

### 11.2 Introduce a Retention Policy Service

Add a dedicated domain service such as `RetentionPolicyService` or `MemoryLifecycleService` with deterministic, testable methods:

- `assignTier(input, extractedMemory) -> tier`
- `computeExpiry(tier, now, lastAccessed?) -> expiresAt | null`
- `shouldPromote(memory, accessEvent) -> nextTier | null`
- `isDecayEligible(memory) -> boolean`
- `getDedupThreshold(tier) -> number`
- `isExpiringSoon(memory, now) -> boolean`

This prevents retention rules from being duplicated between the write pipeline, search layer, and cleanup job.

### 11.3 Persistence and Consistency Model

Because BHGBrain uses SQLite for metadata and Qdrant for vectors, memory lifecycle operations must treat SQLite as the system of record for retention state.

Recommended approach:

1. Write retention metadata to SQLite first inside a transaction.
2. Write or update the Qdrant point second.
3. Mark the SQLite row as `vector_synced = 1` only after Qdrant succeeds.
4. If Qdrant fails, keep the SQLite row with a recoverable sync state and surface degraded health instead of dropping the write.

For deletes and archival:

1. Copy archive/revision rows into SQLite first.
2. Delete from Qdrant second.
3. Soft-delete or hard-delete SQLite rows only after Qdrant delete succeeds.

This produces replayable recovery semantics and matches the existing hybrid-storage architecture.

### 11.4 Retrieval Path Rules

All retrieval paths should go through one shared memory query service. Do not let `recall`, `search`, CLI reads, and `memory://inject` each update access counters differently.

The shared retrieval service should:

- Apply namespace and collection scoping first
- Exclude expired `T2`/`T3` memories by default
- Always include `T0`/`T1` candidates in candidate generation
- Apply hybrid ranking after any tier boosts
- Persist access tracking asynchronously but reliably after a successful read
- Attach advisory flags such as `expiring_soon`, `persistent`, and `retention_tier`

This keeps ranking, access-count mutation, and expiry enforcement consistent across transports.

### 11.5 Background Job Architecture

The cleanup job should be implemented as an internal lifecycle service, not as logic embedded only in a CLI command.

Recommended job split:

- `RetentionScanner`: finds expired or over-budget candidates from SQLite
- `ArchiveWriter`: writes archive summaries and T0/T1 revision records
- `VectorJanitor`: deletes or compacts Qdrant payloads/segments
- `MetadataJanitor`: removes or marks SQLite rows after vector confirmation
- `CapacityReporter`: emits tier counts, bytes, and warning signals to health/metrics

`bhgbrain gc` should call the same service used by the scheduled job, with flags for `dry-run`, `tier`, and `force-compact`. That avoids two different cleanup implementations.

### 11.6 Schema and Index Guidance

To support this cleanly, the SQLite `memories` table should gain explicit lifecycle fields in the primary row rather than relying on opaque JSON blobs:

- `retention_tier`
- `expires_at`
- `decay_eligible`
- `review_due`
- `last_accessed`
- `access_count`
- `vector_synced`
- `archived`

Recommended SQLite indexes:

- `(namespace, collection, retention_tier)`
- `(decay_eligible, expires_at)`
- `(retention_tier, review_due)`
- `(last_accessed)`

Recommended Qdrant payload fields should remain flat and filterable. Avoid nested payload objects for retention metadata because cleanup and search filtering need simple indexed predicates.

### 11.7 Operational Safeguards

For production behavior, add these safeguards to the application specification:

- Cleanup must be idempotent. Re-running `gc` after a partial failure must not corrupt state.
- Promotion must be monotonic by default. Automatic demotion is explicitly disallowed.
- T0 writes should require either explicit caller intent or a high-confidence classification path.
- Any bulk cleanup over a configurable threshold should emit an audit event and a warning log.
- Health status should degrade when SQLite/Qdrant retention state diverges beyond a small threshold.

### 11.8 Observability Requirements

The feature is not production-ready without visibility. Add these metrics and structured logs:

- `memories_total{tier=...}`
- `memories_expiring_soon_total`
- `memories_archived_total`
- `memories_deleted_total`
- `retention_promotions_total`
- `retention_cleanup_duration_ms`
- `retention_storage_drift_total`
- `qdrant_compactions_total`

Structured audit events should include:

- memory ID
- namespace
- collection
- prior tier
- new tier
- action (`created`, `promoted`, `archived`, `deleted`, `restored`, `revised`)
- actor (`agent`, `cli`, `system`)
- timestamp

### 11.9 Rollout Strategy

Implement this in phases to reduce migration risk:

1. Add schema fields and write-path tier assignment with no cleanup enabled.
2. Add read-path filtering and access tracking.
3. Add archive tables and dry-run cleanup reporting.
4. Enable actual deletion for `T3` only.
5. Enable T1 review workflows and T0 revision history.
6. Add compaction automation and capacity-based pruning.

This phased rollout is safer than shipping ingestion, scoring, archival, and deletion in one release.

### 11.10 Testing Expectations

The application specification should require tests at three levels:

- Unit tests for tier assignment, TTL computation, promotion, and classification signals
- Integration tests for SQLite + Qdrant lifecycle operations, including partial-failure recovery
- End-to-end tests for CLI and MCP flows that prove reads extend expiry windows and cleanup removes only eligible memories

Critical regression cases:

- T0 memories never deleted even under capacity pressure
- T3 memories removed only after archive succeeds when archive is enabled
- Access tracking cannot resurrect already-deleted rows
- Duplicate prevention respects tier-specific thresholds
- Rebuild/replay from SQLite can restore Qdrant retention payloads

## 12. Acceptance Criteria

1. All memories are assigned a retention tier at write time.
2. T0 memories never expire regardless of access pattern.
3. T3 memories are automatically cleaned up after 30 days of zero access.
4. Tier promotion triggers when access threshold is met.
5. Cleanup job runs on schedule and logs all deletions to audit trail.
6. T0 updates preserve prior content in revision history.
7. `bhgbrain stats --by-tier` accurately reports tier distribution.
8. Archive-before-delete captures summary for post-mortem inspection.
9. Vector DB point count stays within configured tier budgets.
10. Health endpoint warns when capacity thresholds are approached.
