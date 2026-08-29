export type MemoryType = 'episodic' | 'semantic' | 'procedural';

export type CategorySlot = 'company-values' | 'architecture' | 'coding-requirements' | 'custom';

// 'distillation': written only by `DistillationService` when it consolidates
// a cluster of related T2/T3 episodic memories into one T1 semantic memory.
// A dedicated value (not 'agent') so distillation output is distinguishable
// from agent-authored writes in ranking, audit, and the review queue. See
// add-memory-distillation.
export type MemorySource = 'cli' | 'api' | 'agent' | 'import' | 'distillation';

export type WriteOperation = 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';

export type SearchMode = 'semantic' | 'fulltext' | 'hybrid';

export type RetentionTier = 'T0' | 'T1' | 'T2' | 'T3';

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export type VectorReconciliationState = 'reconciled' | 'reconciling' | 'pending';

/**
 * Type/tags/time predicate pushed down into the vector and fulltext stores so a
 * recall's `limit` counts matching memories instead of unfiltered top-K
 * candidates (see `push-down-recall-filters`). Tag matching is OR (match
 * any provided tag), matching the pre-existing recall semantics. `after`/
 * `before` (ISO 8601, inclusive) bound a memory's `created_at` — not
 * `updated_at` — so they answer "when was this recorded", independent of the
 * separate recency-decay signal `updated_at` drives elsewhere (see
 * `add-time-scoped-recall`).
 */
export interface RecallFilter {
  type?: MemoryType;
  tags?: string[];
  after?: string;
  before?: string;
}

// Caller-supplied identity of the session/tool/repo that produced a memory's
// *content* (not its vector — see `embedding_model` below for that). All
// fields optional free-form strings: MCP has no standardized identity for
// any of session/tool/repo/branch across clients (Claude CLI, Codex,
// Gemini). See add-memory-provenance-metadata.
export interface MemoryOrigin {
  session_id?: string;
  tool?: string;
  repo?: string;
  branch?: string;
}

export type ErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'AUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'EMBEDDING_UNAVAILABLE'
  | 'INTERNAL';

export interface MemoryRecord {
  id: string;
  namespace: string;
  collection: string;
  type: MemoryType;
  category: string | null;
  content: string;
  summary: string;
  tags: string[];
  source: MemorySource;
  checksum: string;
  embedding: number[];
  importance: number;
  retention_tier: RetentionTier;
  expires_at: string | null;
  decay_eligible: boolean;
  review_due: string | null;
  access_count: number;
  last_operation: WriteOperation;
  merged_from: string | null;
  // Ids of the archived T2/T3 episodic source memories this row was
  // distilled from — set only on `DistillationService` output (JSON-encoded
  // TEXT column, same convention as `tags`). `null` for every ordinary
  // write. Structurally similar to `merged_from` but multi-valued, since
  // distillation consolidates a whole cluster rather than one predecessor.
  // See add-memory-distillation. Optional (like `device_id`/`embedding_model`
  // below) so the many pre-existing object literals typed against
  // `MemoryRecord`/`Omit<MemoryRecord, 'embedding'>` across the codebase and
  // its tests do not all require updating for one new additive field.
  derived_from?: string[] | null;
  archived: boolean;
  vector_synced: boolean;
  // Always included in `memory://inject` and `memory://inject/{hint}`
  // regardless of recency/relevance rank, bounded by
  // `defaults.pin_limit_per_namespace` and the memory section's budget. Has
  // no effect on search/recall ordering or ranking — deliberately distinct
  // from T0 retention. See add-inject-pinning.
  pinned: boolean;
  device_id?: string | null;
  // Provider-qualified embedding identity (`<provider>/<model>@<dimensions>`)
  // that produced this row's current vector. Null for legacy rows written
  // before provenance stamping, and for rows written without a vector (the
  // deterministic-fallback ADD path) — both are treated as "unknown" by
  // mismatch detection and re-embed selection. See embedding-provenance.
  embedding_model?: string | null;
  // Content provenance (who/where this memory's *belief* came from), distinct
  // from `embedding_model` above (which vector-provenance field identifies
  // what produced the *vector*). `origin` is null when the caller supplied
  // none (the common case, and always the case for pre-existing rows).
  // `confidence` defaults per-source from `pipeline.default_confidence` when
  // the caller omits it. See add-memory-provenance-metadata.
  origin: MemoryOrigin | null;
  confidence: number;
  created_at: string;
  updated_at: string;
  last_accessed: string;
}

export interface CategoryRecord {
  name: string;
  slot: CategorySlot;
  content: string;
  updated_at: string;
  revision: number;
}

export interface CollectionInfo {
  name: string;
  count: number;
}

export interface SearchResult {
  id: string;
  content: string;
  summary: string;
  type: MemoryType;
  tags: string[];
  score: number;
  semantic_score?: number;
  fulltext_score?: number;
  // Populated only when `recall`'s opt-in rerank stage
  // (`SearchService.rerank`, gated on `search.rerank.enabled`) actually
  // scored this candidate — the raw, clamped LLM relevance judgment in
  // `[0, 1]` that `score` was overwritten with. Absent (not `false`/`null`)
  // for every result reranking did not touch, same "absent, not
  // false/null" convention `archived`/`vector` already use on this
  // interface. `semantic_score` is left untouched by reranking, so
  // `min_score` filtering (which reads `semantic_score ?? score`) is
  // unaffected. See add-opt-in-rerank-stage.
  rerank_score?: number;
  retention_tier: RetentionTier;
  expires_at?: string | null;
  expiring_soon?: boolean;
  device_id?: string | null;
  created_at: string;
  last_accessed: string;
  // Populated by `SearchService.searchForInject` (the semantic leg's raw
  // vector, when available) so relevance-conditioned inject can suppress
  // near-duplicate memories — those callers see it populated. Also used as
  // transient MMR scratch space inside the public `search()` method
  // (add-mmr-diversity-reranking: candidate vectors requested when
  // `search.mmr.enabled`, consumed by the diversity reorder) but always
  // cleared to `undefined` before `search()` returns, so it never appears in
  // the public `search`/`recall` tools' JSON responses.
  vector?: number[];
  // Set only on archived matches surfaced via `search`'s `include_archived`
  // (add-review-and-archive-recall). Absent (not `false`) on every active
  // result, so it never appears in default JSON responses.
  archived?: boolean;
  // Set only on one-hop neighbors appended by `recall`'s `follow_links`
  // (add-memory-links). Absent on every directly relevant result, same
  // convention as `archived` above.
  linked_from?: string;
  link_relation?: MemoryLinkRelation;
  link_direction?: 'outgoing' | 'incoming';
  // Content provenance, mirrored from `MemoryRecord` — see the comment there.
  // Optional here (unlike the required fields on `MemoryRecord`) so existing
  // `SearchResult` object literals across the codebase don't all require an
  // update for one additive field, matching `device_id`'s convention; both
  // are populated on every active result in practice, not conditionally like
  // `archived`/`vector`.
  origin?: MemoryOrigin | null;
  confidence?: number;
}

export interface WriteResult {
  id: string;
  summary: string;
  type: MemoryType;
  operation: WriteOperation;
  merged_with_id?: string;
  created_at: string;
}

export interface BackupInfo {
  path: string;
  size_bytes: number;
  memory_count: number;
  created_at: string;
}

export interface ComponentHealth {
  status: HealthStatus;
  message?: string;
}

export interface VectorReconciliationStatus extends ComponentHealth {
  state: VectorReconciliationState;
  unsynced_vectors: number;
}

export interface RestoreResult {
  memory_count: number;
  metadata_activated: boolean;
  vector_reconciliation: VectorReconciliationStatus;
}

export interface HealthSnapshot {
  status: HealthStatus;
  components: {
    sqlite: ComponentHealth;
    qdrant: ComponentHealth;
    embedding: ComponentHealth;
    vector_reconciliation: VectorReconciliationStatus;
    retention?: ComponentHealth;
  };
  memory_count: number;
  db_size_bytes: number;
  uptime_seconds: number;
  circuitBreakers?: Record<string, 'closed' | 'open' | 'half-open'>;
  retention?: {
    counts_by_tier: Record<RetentionTier, number>;
    expiring_soon: number;
    archived_count: number;
    unsynced_vectors: number;
    over_capacity: boolean;
    // Seconds since the last cleanup (GC) run that completed without a
    // partial failure; null if cleanup has never completed successfully.
    cleanup_lag_seconds: number | null;
    // Additive rollup for the distillation job (add-memory-distillation) —
    // absent from any pre-existing `retention` health consumer's assumptions
    // since it is a new optional field, not a change to any existing one.
    // Undefined when distillation has never run in this process.
    distillation?: {
      last_run_at: string | null;
      last_run_degraded: boolean;
      distilled_total: number;
      skipped_total: number;
    };
  };
}

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
  };
}

// 'DISTILL' is logged against the newly-written T1 semantic memory when
// `DistillationService` archives a cluster's sources after a successful
// distilled write — see add-memory-distillation.
export type LifecycleAuditOperation = 'PROMOTE' | 'ARCHIVE' | 'REVISE' | 'RESTORE' | 'DISTILL';

export interface AuditEntry {
  id: string;
  timestamp: string;
  namespace: string;
  operation: WriteOperation | 'FORGET' | LifecycleAuditOperation;
  memory_id: string;
  client_id: string;
  details?: string;
}

/**
 * Structured payload for lifecycle-transition audit events (promotion,
 * archival, revision, deletion, restore). Passed to `StorageManager.logAudit`
 * via `options.details` and persisted as JSON in `AuditEntry.details`, so
 * these transitions are distinguishable from generic content ADD/UPDATE
 * events instead of collapsing into an undifferentiated write log.
 */
export interface LifecycleAuditDetails {
  memory_id: string;
  prior_tier: RetentionTier | null;
  new_tier: RetentionTier | null;
  actor: string;
  timestamp: string;
  action: 'promote' | 'archive' | 'revise' | 'delete' | 'restore' | 'consolidate' | 'distill';
  // Present only on the explicit `revisions` tool `revert` action's REVISE
  // audit entry — the revision number the memory was reverted to. Absent on
  // the generic T0-snapshot REVISE that `StorageManager.updateMemory` emits
  // on every T0 content change, so the two are distinguishable in the log.
  source_revision?: number;
  // Present only on `action: 'consolidate'` ARCHIVE entries (the `consolidate`
  // tool's `merge` action): the target memory id each archived source was
  // merged into, distinguishing a consolidation-driven archive from `review`'s
  // ordinary `action: 'archive'` entries. See
  // add-duplicate-cluster-consolidation.
  merged_into?: string;
  // Present only on `action: 'distill'` DISTILL entries: the archived source
  // memory ids this distilled memory replaces (mirrors `derived_from` on the
  // record itself). See add-memory-distillation.
  derived_from?: string[];
}

export interface PaginatedResult<T> {
  items: T[];
  cursor: string | null;
  total_results: number;
  truncated: boolean;
}

export interface InjectPayload {
  content: string;
  truncated: boolean;
  total_results: number;
  categories_count: number;
  memories_count: number;
}

export interface ArchiveRecord {
  id: number;
  memory_id: string;
  summary: string;
  tier: RetentionTier;
  namespace: string;
  created_at: string;
  expired_at: string;
  access_count: number;
  tags: string[];
}

// Append-only usefulness-feedback event for a recalled/searched memory
// (add-recall-feedback-signal). One row per `feedback` call — never
// aggregated or mutated after insert. See `recall_feedback` in
// src/storage/sqlite.ts.
export interface RecallFeedbackEntry {
  memory_id: string;
  namespace: string;
  query: string | null;
  score: number | null;
  useful: boolean;
  client_id: string;
  created_at: string;
}

export interface MemoryRevisionRecord {
  id: number;
  memory_id: string;
  revision: number;
  content: string;
  updated_at: string;
  updated_by: string | null;
}

// Directed, typed edge between two memories (add-memory-links). See the
// `relate` tool and `recall`'s `follow_links` parameter.
export type MemoryLinkRelation = 'refines' | 'contradicts' | 'derived_from' | 'about_same_entity' | 'follows';

export interface MemoryLinkRecord {
  id: number;
  namespace: string;
  from_id: string;
  to_id: string;
  relation: MemoryLinkRelation;
  created_at: string;
  created_by: string | null;
}

export interface TierStats {
  tier: RetentionTier;
  count: number;
}
