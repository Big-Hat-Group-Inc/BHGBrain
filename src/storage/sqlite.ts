import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, existsSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  MemoryRecord,
  MemoryOrigin,
  MemoryType,
  CategoryRecord,
  AuditEntry,
  ArchiveRecord,
  RecallFeedbackEntry,
  MemoryRevisionRecord,
  MemoryLinkRecord,
  MemoryLinkRelation,
  RetentionTier,
  TierStats,
  RecallFilter,
} from '../domain/types.js';

const ALLOWED_MEMORY_TYPES: readonly MemoryType[] = ['episodic', 'semantic', 'procedural'];

function isAllowedMemoryType(value: string): value is MemoryType {
  return (ALLOWED_MEMORY_TYPES as readonly string[]).includes(value);
}

type SqlValue = string | number | null | Uint8Array;
export type SqlParams = SqlValue[];

type SqlRow = Record<string, SqlValue | undefined>;

type MemoryRecordWithoutEmbedding = Omit<MemoryRecord, 'embedding'>;

export interface AccessUpdate {
  id: string;
  access_count: number;
  last_accessed: string;
  expires_at?: string | null;
  retention_tier?: RetentionTier;
  review_due?: string | null;
}

export interface CategoryHeader {
  name: string;
  slot: string;
  updated_at: string;
  revision: number;
  content_length: number;
}

export interface CategoryContentSlice {
  content: string;
  // Character length of `content` as counted by SQLite's LENGTH(), i.e. the same
  // unit as CategoryHeader.content_length. Deliberately NOT the JS UTF-16
  // `content.length` — those disagree for astral-plane characters, which is the
  // mismatch this type exists to avoid at the call site.
  length: number;
}

export interface CollectionRecord {
  name: string;
  namespace: string;
  embedding_model: string;
  embedding_dimensions: number;
}

export interface BootstrapSectionRow {
  namespace: string;
  section_number: number;
  status: 'pending' | 'complete';
  memory_ids: string[];
  updated_at: string;
}

export interface SqliteStorage {
  init(): Promise<void>;
  reloadFromDisk(): Promise<void>;
  activateDatabaseImage(image: Buffer): Promise<void>;
  flush(): void;
  flushIfDirty(): void;
  scheduleDeferredFlush(): void;
  cancelDeferredFlush(): void;
  insertMemory(mem: MemoryRecordWithoutEmbedding): void;
  updateMemory(id: string, fields: Partial<MemoryRecordWithoutEmbedding>): void;
  deleteMemory(id: string): boolean;
  getMemoryById(id: string, includeArchived?: boolean): MemoryRecordWithoutEmbedding | null;
  getMemoryByChecksum(namespace: string, checksum: string, collection?: string): MemoryRecordWithoutEmbedding | null;
  listMemories(namespace: string, limit: number, cursor?: string): MemoryRecordWithoutEmbedding[];
  listMemoriesInCollection(namespace: string, collection: string, limit: number, cursor?: string): MemoryRecordWithoutEmbedding[];
  listPinnedMemories(namespace: string): MemoryRecordWithoutEmbedding[];
  countPinnedMemories(namespace: string): number;
  countMemories(namespace?: string): number;
  countMemoriesInCollection(namespace: string, collection: string): number;
  fullTextSearch(namespace: string, query: string, limit: number, collection?: string, filter?: RecallFilter): Array<{ id: string; rank: number }>;
  markStale(memoryId: string): void;
  getStaleMemories(importanceBelow: number, limit: number): MemoryRecordWithoutEmbedding[];
  listStaleCandidateIds(cutoffIso: string): string[];
  touchMemory(id: string): void;
  recordAccess(
    id: string,
    accessCount: number,
    lastAccessed: string,
    expiresAt?: string | null,
    retentionTier?: RetentionTier,
    reviewDue?: string | null,
  ): void;
  markVectorSync(
    id: string, synced: boolean,
    options?: { allowDuringLifecycle?: boolean; embeddingModel?: string | null },
  ): void;
  markVectorsSyncBatch(ids: string[], synced: boolean, options?: { allowDuringLifecycle?: boolean }): void;
  markAllVectorsSyncState(synced: boolean, options?: { allowDuringLifecycle?: boolean }): number;
  recordAccessBatch(updates: AccessUpdate[]): void;
  listExpiredMemories(nowIso: string, tier?: RetentionTier): MemoryRecordWithoutEmbedding[];
  listReviewCandidates(nowIso: string, limit?: number): MemoryRecordWithoutEmbedding[];
  listReviewDue(namespace: string, before: string, limit: number, cursor?: string): MemoryRecordWithoutEmbedding[];
  listExpiringMemories(nowIso: string, untilIso: string, limit: number): MemoryRecordWithoutEmbedding[];
  countExpiringMemories(nowIso: string, untilIso: string): number;
  countByTier(): Record<RetentionTier, number>;
  getTierStats(): TierStats[];
  setRetentionDegraded(degraded: boolean, message?: string | null, completedAt?: string): void;
  getRetentionDegraded(): { degraded: boolean; message: string | null; last_success_at: string | null };
  recordDistillationRun(result: { distilled: number; skipped: number; degraded: boolean }, completedAt?: string): void;
  getDistillationState(): {
    last_run_at: string | null; last_run_degraded: boolean; distilled_total: number; skipped_total: number;
  };
  listDistillationCollections(): Array<{ namespace: string; collection: string }>;
  countArchivedMemories(): number;
  countUnsyncedVectors(): number;
  listMemoriesNeedingVectorSync(limit: number, cursor?: string): MemoryRecordWithoutEmbedding[];
  getExpectedEmbeddingIdentity(): string | null;
  adoptEmbeddingIdentityIfAbsent(identity: string): void;
  setExpectedEmbeddingIdentity(identity: string): void;
  countMemoriesWithStaleEmbeddingStamp(activeIdentity: string, includeLegacy: boolean): number;
  listMemoriesWithStaleEmbeddingStamp(
    activeIdentity: string, includeLegacy: boolean, limit: number, cursor?: string,
  ): MemoryRecordWithoutEmbedding[];
  listMemoryChecksums(): Array<{ id: string; checksum: string }>;
  archiveMemory(memory: MemoryRecordWithoutEmbedding, expiredAt: string): void;
  listArchive(limit: number): ArchiveRecord[];
  searchArchive(query: string, limit: number): ArchiveRecord[];
  searchArchived(namespace: string, query: string, limit: number): ArchiveRecord[];
  getArchiveByMemoryId(memoryId: string): ArchiveRecord | null;
  deleteArchive(memoryId: string): void;
  insertRevision(memoryId: string, revision: number, content: string, updatedAt: string, updatedBy?: string): void;
  listRevisions(memoryId: string): MemoryRevisionRecord[];
  addMemoryLink(
    namespace: string, fromId: string, toId: string, relation: MemoryLinkRelation, createdBy: string | null,
  ): { record: MemoryLinkRecord; created: boolean };
  listMemoryLinks(
    memoryId: string, options?: { relation?: MemoryLinkRelation },
  ): Array<MemoryLinkRecord & { direction: 'outgoing' | 'incoming' }>;
  removeMemoryLink(fromId: string, toId: string, relation: MemoryLinkRelation): boolean;
  getDbSizeBytes(): number;
  isFts5Available(): boolean;
  setCategory(name: string, slot: string, content: string): CategoryRecord;
  getCategory(name: string): CategoryRecord | null;
  listCategories(): CategoryRecord[];
  deleteCategory(name: string): boolean;
  createCollection(namespace: string, name: string, embeddingModel: string, embeddingDimensions: number): void;
  getCollection(namespace: string, name: string): CollectionRecord | null;
  listCollections(namespace?: string): Array<{ name: string; count: number }>;
  deleteCollection(namespace: string, name: string): boolean;
  deleteMemoriesInCollection(namespace: string, collection: string): { deleted: number; ids: string[] };
  insertAudit(entry: AuditEntry): void;
  listAudit(limit: number): AuditEntry[];
  recordFeedback(entry: RecallFeedbackEntry): void;
  insertBackupMeta(path: string, sizeBytes: number, memoryCount: number, checksum: string): void;
  listBackups(): Array<{ path: string; size_bytes: number; memory_count: number; created_at: string }>;
  exportData(): Buffer;
  getDatabasePath(): string;
  healthCheck(): boolean;
  close(): void;
  beginLifecycleOperation(reason: string): void;
  endLifecycleOperation(reason?: string): void;
  isLifecycleOperationInProgress(): boolean;
  getLifecycleOperation(): string | null;
  getMemoriesByIds(ids: string[]): MemoryRecordWithoutEmbedding[];
  listMemoryIdsInCollection(namespace: string, collection: string): string[];
  upsertMemoryFromPayload(id: string, payload: Record<string, unknown>): boolean;
  listCategoryHeaders(): CategoryHeader[];
  getCategoryContentSlice(name: string, maxChars: number): CategoryContentSlice | null;

  // Bootstrap session methods
  createBootstrapSession(namespace: string, totalSections: number): void;
  getBootstrapSession(namespace: string): BootstrapSectionRow[];
  updateBootstrapSection(namespace: string, sectionNumber: number, status: 'pending' | 'complete', memoryIds: string[]): void;
  resetBootstrapSection(namespace: string, sectionNumber: number): string[];
  getBootstrapSectionMemoryIds(namespace: string, sectionNumber: number): string[];
  clearBootstrapSection(namespace: string, sectionNumber: number): void;
  bootstrapSessionExists(namespace: string): boolean;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL DEFAULT 'global',
  collection TEXT NOT NULL DEFAULT 'general',
  type TEXT NOT NULL CHECK(type IN ('episodic','semantic','procedural')),
  category TEXT,
  content TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'cli',
  checksum TEXT NOT NULL,
  importance REAL NOT NULL DEFAULT 0.5,
  retention_tier TEXT NOT NULL DEFAULT 'T2',
  expires_at TEXT,
  decay_eligible INTEGER NOT NULL DEFAULT 1,
  review_due TEXT,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_operation TEXT NOT NULL DEFAULT 'ADD',
  merged_from TEXT,
  derived_from TEXT,
  stale INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  vector_synced INTEGER NOT NULL DEFAULT 1,
  pinned INTEGER NOT NULL DEFAULT 0,
  device_id TEXT,
  embedding_model TEXT,
  origin TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_accessed TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_namespace ON memories(namespace);
CREATE INDEX IF NOT EXISTS idx_memories_collection ON memories(namespace, collection);
CREATE INDEX IF NOT EXISTS idx_memories_checksum ON memories(namespace, checksum);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(namespace, type);
CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
CREATE INDEX IF NOT EXISTS idx_memories_stale ON memories(stale, importance);
CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memories_tier ON memories(namespace, collection, retention_tier);
CREATE INDEX IF NOT EXISTS idx_memories_expiry ON memories(decay_eligible, expires_at);
CREATE INDEX IF NOT EXISTS idx_memories_review_due ON memories(retention_tier, review_due);
CREATE INDEX IF NOT EXISTS idx_memories_archived ON memories(archived);
CREATE INDEX IF NOT EXISTS idx_memories_vector_synced ON memories(vector_synced);
CREATE INDEX IF NOT EXISTS idx_memories_pinned ON memories(namespace, pinned);

CREATE TABLE IF NOT EXISTS memories_fts (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  name TEXT NOT NULL,
  slot TEXT NOT NULL CHECK(slot IN ('company-values','architecture','coding-requirements','custom')),
  content TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (name)
);

CREATE TABLE IF NOT EXISTS collections (
  name TEXT NOT NULL,
  namespace TEXT NOT NULL DEFAULT 'global',
  embedding_model TEXT,
  embedding_dimensions INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (namespace, name)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  namespace TEXT NOT NULL,
  operation TEXT NOT NULL,
  memory_id TEXT,
  client_id TEXT NOT NULL DEFAULT 'unknown',
  details TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp DESC);

CREATE TABLE IF NOT EXISTS backup_metadata (
  path TEXT PRIMARY KEY,
  size_bytes INTEGER NOT NULL,
  memory_count INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  UNIQUE(memory_id, revision)
);

CREATE TABLE IF NOT EXISTS memory_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  tier TEXT NOT NULL,
  namespace TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expired_at TEXT NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]'
);

CREATE INDEX IF NOT EXISTS idx_memory_archive_memory_id ON memory_archive(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_archive_expired_at ON memory_archive(expired_at DESC);

-- Append-only usefulness-feedback events (add-recall-feedback-signal). Each
-- feedback tool call inserts one row; never mutated or collapsed into a
-- running total on memories. Purely additive and otherwise inert in this
-- version - no ranking, lifecycle, or search-behavior effect reads this
-- table yet. See openspec/changes/add-recall-feedback-signal.
CREATE TABLE IF NOT EXISTS recall_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL,
  namespace TEXT NOT NULL,
  query TEXT,
  score REAL,
  useful INTEGER NOT NULL CHECK(useful IN (0,1)),
  client_id TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recall_feedback_memory_id ON recall_feedback(memory_id);
CREATE INDEX IF NOT EXISTS idx_recall_feedback_created_at ON recall_feedback(created_at DESC);

CREATE TABLE IF NOT EXISTS bootstrap_sessions (
  namespace TEXT NOT NULL,
  section_number INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','complete')),
  memory_ids TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (namespace, section_number)
);

-- Single-row state for the most recent cleanup (GC) run, so HealthService can
-- surface a degraded retention signal and cleanup lag (time since the last
-- clean run) without holding that state only in the in-memory
-- RetentionService (which does not survive a restart or run inside a
-- different process than the one polling health).
CREATE TABLE IF NOT EXISTS retention_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  degraded INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  last_success_at TEXT,
  updated_at TEXT NOT NULL
);

-- Single-row state for the most recent distillation job run, so
-- HealthService can surface a retention.distillation rollup (last-run
-- timestamp, last-run degraded flag, cumulative counts) that survives a
-- restart and works across processes, mirroring retention_state above.
-- See add-memory-distillation.
CREATE TABLE IF NOT EXISTS distillation_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_run_at TEXT,
  last_run_degraded INTEGER NOT NULL DEFAULT 0,
  distilled_total INTEGER NOT NULL DEFAULT 0,
  skipped_total INTEGER NOT NULL DEFAULT 0
);

-- Single-row record of the store's expected embedding identity
-- (<provider>/<model>@<dimensions>), adopted on the first vector-producing
-- write after this table is empty and updated only when a re-embed
-- migration completes. Independent of Qdrant availability so startup/health
-- mismatch detection works even when Qdrant is unreachable. See
-- openspec/changes/stamp-embedding-provenance.
CREATE TABLE IF NOT EXISTS embedding_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  identity TEXT NOT NULL,
  adopted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Directed, typed edges between memories (add-memory-links). A brand-new
-- table, not a column on memories, so a plain CREATE TABLE IF NOT EXISTS
-- covers existing databases on next startup with no ALTER TABLE step.
-- namespace is denormalized onto the row (redundant with the memories it
-- points at) following the memory_archive precedent above, so link
-- listing/scoping never needs a join.
CREATE TABLE IF NOT EXISTS memory_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  namespace TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation TEXT NOT NULL CHECK(relation IN ('refines','contradicts','derived_from','about_same_entity','follows')),
  created_at TEXT NOT NULL,
  created_by TEXT,
  UNIQUE(from_id, to_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_memory_links_from ON memory_links(from_id);
CREATE INDEX IF NOT EXISTS idx_memory_links_to ON memory_links(to_id);
CREATE INDEX IF NOT EXISTS idx_memory_links_namespace ON memory_links(namespace);
`;

// SQLite-lock retry/backoff (audit follow-up 2026-06-05, task 4.2; revisited by
// migrate-sqlite-to-native-engine): this store runs on `node:sqlite`'s
// `DatabaseSync`, a single, synchronous, in-process native SQLite connection —
// still no separate database server and no OS-level file lock contended by
// concurrent connections, since every read/write goes through this one
// `DatabaseSync` instance in this one Node.js process. There is therefore no
// "SQLite is locked by another writer" condition for a retry-with-backoff
// wrapper to recover from; the closest real failure (a native exception from a
// malformed statement or constraint violation) is not a transient
// lock-contention error and should not be retried. Per the
// `retention-and-degradation` spec's "In-process store documents retry as
// no-op" scenario, this is intentionally not implemented rather than
// asserting an unimplemented contract — see
// `openspec/changes/add-operations-security-reliability/specs/
// retention-and-degradation/spec.md`.
export class SqliteStore implements SqliteStorage {
  private db!: DatabaseSync;
  private dbPath: string;
  private lifecycleOperation: string | null = null;
  // Startup FTS5 capability probe result (openspec/changes/upgrade-fulltext-to-fts5,
  // task 1.1; migrate-sqlite-to-native-engine task 1.7). `node:sqlite`'s bundled
  // SQLite build compiles in the `fts5` virtual table module, so this probes
  // (rather than assumes) availability and is expected to report `true` here —
  // the probe itself stays engine-agnostic and authoritative, per design.md, so
  // it also correctly reports `false` again if ever run against a build that
  // omits fts5. Consumed by HealthService to surface a legacy-fulltext fallback
  // condition visibly rather than silently, per the "Missing FTS5 support SHALL
  // degrade gracefully and visibly" requirement.
  private ftsAvailable = false;

  constructor(private dataDir: string) {
    this.dbPath = join(dataDir, 'brain.db');
  }

  /**
   * Executes a single SQL statement with no result rows (INSERT/UPDATE/DELETE/
   * single-statement DDL). One of three private helpers
   * (`execSql`/`queryAll`/`queryOne`) that encapsulate `DatabaseSync`'s
   * `prepare()`/`run()`/`all()`/`get()` idiom so the ~80 call sites below never
   * touch the engine directly (migrate-sqlite-to-native-engine task 1.1).
   */
  private execSql(sql: string, params: SqlParams = []): void {
    this.db.prepare(sql).run(...params);
  }

  /** Runs `sql` and returns every result row. */
  private queryAll(sql: string, params: SqlParams = []): SqlRow[] {
    return this.db.prepare(sql).all(...params).map(row => this.getRow(row));
  }

  /** Runs `sql` and returns the first result row, or `null` if there is none. */
  private queryOne(sql: string, params: SqlParams = []): SqlRow | null {
    const row = this.db.prepare(sql).get(...params);
    return row === undefined ? null : this.getRow(row);
  }

  /**
   * Opens (creating if absent) `this.dbPath` directly with `DatabaseSync` — no
   * whole-file read — applies the WAL pragmas, runs column migrations and
   * `SCHEMA_SQL`, and re-probes FTS5 support. Shared by `init()`,
   * `reloadFromDisk()`, and `activateDatabaseImage()` so all three open paths
   * stay identical.
   */
  private openDatabase(): void {
    this.db = new DatabaseSync(this.dbPath);
    // WAL: page-level journaling instead of sql.js's whole-file export/rewrite.
    // synchronous=NORMAL: durable at every commit (fsynced on WAL checkpoint
    // boundaries) without paying full-fsync cost per write; only an OS/power
    // failure (not an application crash) can lose the last few commits — see
    // design.md "Pragmas at open".
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    // Run column migrations BEFORE SCHEMA_SQL so new indexes (e.g. idx_memories_tier)
    // that reference retention_tier don't fail on an existing DB that predates the column.
    this.ensureMemoryColumns();
    this.db.exec(SCHEMA_SQL);
    this.ftsAvailable = this.probeFts5Support();
  }

  async init(): Promise<void> {
    this.openDatabase();
  }

  async reloadFromDisk(): Promise<void> {
    this.cancelDeferredFlush();
    if (this.db) {
      this.db.close();
    }
    if (!existsSync(this.dbPath)) {
      throw new Error(`Database file not found: ${this.dbPath}`);
    }
    this.removeStaleSidecarFiles();
    this.openDatabase();
  }

  /**
   * Activates a full replacement database image (a restored backup): closes
   * the live connection, removes any stale `-wal`/`-shm` sidecars so they
   * cannot be replayed against the new image, atomically writes `image` onto
   * `brain.db`, then reopens. Closing before overwriting is required on
   * Windows, where renaming onto a file with an open native handle fails
   * (EPERM) — harmless under the old memory-only sql.js engine, but required
   * here. See design.md "Restore must close-before-overwrite" and
   * migrate-sqlite-to-native-engine task 2.1.
   */
  async activateDatabaseImage(image: Buffer): Promise<void> {
    this.cancelDeferredFlush();
    if (this.db) {
      this.db.close();
    }
    this.removeStaleSidecarFiles();
    atomicWriteFileSync(this.dbPath, image);
    this.openDatabase();
  }

  /** Removes any `-wal`/`-shm` sidecars next to `dbPath`, if present. */
  private removeStaleSidecarFiles(): void {
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = `${this.dbPath}${suffix}`;
      if (existsSync(sidecar)) {
        try {
          unlinkSync(sidecar);
        } catch {
          // Best-effort: a sidecar that can't be removed will simply be
          // superseded once the reopened connection re-establishes its own
          // WAL, so this never needs to fail the reload/activation.
        }
      }
    }
  }

  /**
   * Attempts to create (and immediately drop) a scratch FTS5 virtual table in the
   * temp schema, so its result never touches the persisted database image.
   * openspec/changes/upgrade-fulltext-to-fts5 task 1.1 — the engine-level FTS5
   * fulltext path (table DDL, migration, BM25 query) is not implemented yet (see
   * `ftsAvailable`'s comment above); this only probes capability. The probe
   * itself is real and generic: it reports `true` on any SQLite build (this
   * engine's included) that compiles fts5 in, and `false` otherwise.
   */
  private probeFts5Support(): boolean {
    try {
      this.db.exec(`CREATE VIRTUAL TABLE temp.__fts5_probe USING fts5(x)`);
      this.db.exec(`DROP TABLE temp.__fts5_probe`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Whether this SQLite build supports FTS5 (openspec/changes/upgrade-fulltext-to-fts5).
   * `node:sqlite`'s bundled build ships fts5, so this reports `true` in normal
   * operation — see `ftsAvailable`. Consumed by HealthService to surface the
   * legacy-fulltext-fallback condition if it is ever `false`.
   */
  isFts5Available(): boolean {
    return this.ftsAvailable;
  }

  /**
   * Checkpoints the write-ahead log into the main database file (PASSIVE: best
   * effort, never blocks on or interrupts other readers/writers). Every commit
   * is already durable under WAL+NORMAL (see `openDatabase`'s pragmas), so this
   * is not required for correctness — it exists so `brain.db` reflects recent
   * writes for external tooling that reads the file directly, and to keep the
   * public `flush()` contract meaningful. Kept on `SqliteStorage` so the ~38
   * existing call sites need no changes (migrate-sqlite-to-native-engine task 1.4).
   */
  flush(): void {
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  }

  /**
   * No-op: there is no deferred-write buffer to flush under WAL — every write
   * already persisted at commit time. Kept on the interface for call-site
   * compatibility (migrate-sqlite-to-native-engine task 1.4).
   */
  flushIfDirty(): void {
    // Intentionally empty.
  }

  /**
   * No-op: WAL+NORMAL durability makes every commit durable immediately, so
   * there is no window left to defer a flush across. Kept on the interface for
   * call-site compatibility.
   */
  scheduleDeferredFlush(): void {
    // Intentionally empty.
  }

  /** No-op counterpart to `scheduleDeferredFlush()`. */
  cancelDeferredFlush(): void {
    // Intentionally empty.
  }

  insertMemory(mem: MemoryRecordWithoutEmbedding): void {
    this.assertMutableAllowed();
    const retentionTier = mem.retention_tier ?? 'T2';
    const expiresAt = mem.expires_at ?? null;
    const decayEligible = mem.decay_eligible ?? true;
    const reviewDue = mem.review_due ?? null;
    const archived = mem.archived ?? false;
    const vectorSynced = mem.vector_synced ?? true;
    const pinned = mem.pinned ?? false;
    const deviceId = mem.device_id ?? null;
    const embeddingModel = mem.embedding_model ?? null;
    const derivedFrom = mem.derived_from ?? null;
    const origin = mem.origin ? JSON.stringify(mem.origin) : null;
    const confidence = mem.confidence ?? 1.0;
    this.execSql(
      `INSERT INTO memories (
        id, namespace, collection, type, category, content, summary, tags, source, checksum,
        importance, retention_tier, expires_at, decay_eligible, review_due, access_count,
        last_operation, merged_from, derived_from, stale, archived, vector_synced, pinned, device_id, embedding_model, origin, confidence, created_at, updated_at, last_accessed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        mem.id,
        mem.namespace,
        mem.collection,
        mem.type,
        mem.category,
        mem.content,
        mem.summary,
        JSON.stringify(mem.tags),
        mem.source,
        mem.checksum,
        mem.importance,
        retentionTier,
        expiresAt,
        decayEligible ? 1 : 0,
        reviewDue,
        mem.access_count,
        mem.last_operation,
        mem.merged_from,
        derivedFrom ? JSON.stringify(derivedFrom) : null,
        0,
        archived ? 1 : 0,
        vectorSynced ? 1 : 0,
        pinned ? 1 : 0,
        deviceId,
        embeddingModel,
        origin,
        confidence,
        mem.created_at,
        mem.updated_at,
        mem.last_accessed,
      ],
    );
    this.execSql(
      `INSERT INTO memories_fts (id, namespace, content, summary, tags) VALUES (?, ?, ?, ?, ?)`,
      [mem.id, mem.namespace, mem.content, mem.summary, mem.tags.join(' ')],
    );
  }

  upsertMemoryFromPayload(id: string, payload: Record<string, unknown>): boolean {
    this.assertMutableAllowed();
    const now = new Date().toISOString();
    const content = typeof payload.content === 'string' ? payload.content : '';
    const summary = typeof payload.summary === 'string' ? payload.summary : '';
    const namespace = typeof payload.namespace === 'string' ? payload.namespace : 'global';
    const collection = typeof payload.collection === 'string' ? payload.collection : 'general';
    // Validate against the `memories.type` CHECK constraint before it ever reaches the
    // insert — a Qdrant payload with an out-of-enum `type` must be normalized to the
    // documented default rather than silently dropped by INSERT OR IGNORE.
    const type: MemoryType = typeof payload.type === 'string' && isAllowedMemoryType(payload.type)
      ? payload.type
      : 'semantic';
    const tags: string[] = Array.isArray(payload.tags) ? payload.tags.filter((t): t is string => typeof t === 'string') : [];
    const importance = typeof payload.importance === 'number' ? payload.importance : 0.5;
    const retentionTier = typeof payload.retention_tier === 'string' ? payload.retention_tier : 'T2';
    const deviceId = typeof payload.device_id === 'string' ? payload.device_id : null;
    // Carry forward whatever identity (if any) the source vector was already
    // stamped with — this is metadata recovery, not a new embedding, so it
    // must not claim the active configuration's identity. A missing field
    // means the point predates provenance stamping and stays "unknown" (null).
    const embeddingModel = typeof payload.embedding_model === 'string' ? payload.embedding_model : null;
    const createdAt = typeof payload.created_at === 'string' ? payload.created_at : now;
    const source = typeof payload.source === 'string' ? payload.source : 'import';
    const category = typeof payload.category === 'string' ? payload.category : null;
    const decayEligible = typeof payload.decay_eligible === 'boolean' ? payload.decay_eligible : true;
    const checksum = typeof payload.checksum === 'string' ? payload.checksum : '';
    // Restore pin state from the payload rather than defaulting it to false,
    // so a `repair --mode from-qdrant` rebuild (or the cross-device fallback
    // path) preserves it. See add-inject-pinning.
    const pinned = typeof payload.pinned === 'boolean' ? payload.pinned : false;
    // Narrow to a plain object (not array/null) or fall back to null, mirroring
    // `embeddingModel`'s narrowing above — a malformed/missing field is
    // "unknown", not an error. See add-memory-provenance-metadata.
    const origin = payload.origin !== null && typeof payload.origin === 'object' && !Array.isArray(payload.origin)
      ? JSON.stringify(payload.origin)
      : null;
    const confidence = typeof payload.confidence === 'number' ? payload.confidence : 1.0;

    // Handle expires_at which may be stored as epoch seconds in Qdrant
    let expiresAt: string | null = null;
    if (typeof payload.expires_at === 'number' && payload.expires_at > 0) {
      expiresAt = new Date(payload.expires_at * 1000).toISOString();
    } else if (typeof payload.expires_at === 'string') {
      expiresAt = payload.expires_at;
    }

    // Check if already exists — skip if so (idempotent)
    if (this.getMemoryById(id)) {
      return false;
    }

    // Hydration must be atomic per memory: the `memories` insert and its
    // `memories_fts` companion either both apply or neither does. A plain (non-`OR
    // IGNORE`) insert into `memories` fails loudly on a constraint violation instead
    // of being swallowed, and the surrounding transaction guarantees no orphan FTS
    // row survives a rolled-back memories insert.
    this.execSql('BEGIN TRANSACTION');
    try {
      this.execSql(
        `INSERT INTO memories (
          id, namespace, collection, type, category, content, summary, tags, source, checksum,
          importance, retention_tier, expires_at, decay_eligible, review_due, access_count,
          last_operation, merged_from, stale, archived, vector_synced, pinned, device_id, embedding_model, origin, confidence, created_at, updated_at, last_accessed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, namespace, collection, type, category, content, summary,
          JSON.stringify(tags), source, checksum, importance, retentionTier,
          expiresAt, decayEligible ? 1 : 0, null, 0,
          'ADD', null, 0, 0, 1, pinned ? 1 : 0, deviceId, embeddingModel, origin, confidence, createdAt, now, now,
        ],
      );
      this.execSql(
        `INSERT OR IGNORE INTO memories_fts (id, namespace, content, summary, tags) VALUES (?, ?, ?, ?, ?)`,
        [id, namespace, content, summary, tags.join(' ')],
      );
      this.execSql('COMMIT');
    } catch (err) {
      this.execSql('ROLLBACK');
      throw err;
    }
    return true;
  }

  updateMemory(id: string, fields: Partial<MemoryRecordWithoutEmbedding>): void {
    this.assertMutableAllowed();
    const sets: string[] = [];
    const vals: SqlParams = [];
    for (const key of Object.keys(fields) as Array<keyof MemoryRecordWithoutEmbedding>) {
      const val = fields[key];
      if (val === undefined) {
        continue;
      }
      if (key === 'tags') {
        sets.push('tags = ?');
        vals.push(JSON.stringify(val));
      } else if (key === 'derived_from') {
        sets.push('derived_from = ?');
        vals.push(val === null ? null : JSON.stringify(val));
      } else if (key === 'origin') {
        sets.push('origin = ?');
        vals.push(val === null ? null : JSON.stringify(val));
      } else if (key === 'decay_eligible' || key === 'archived' || key === 'vector_synced' || key === 'pinned') {
        sets.push(`${key} = ?`);
        vals.push(val ? 1 : 0);
      } else {
        // `origin` (the one non-primitive field left) is handled by the
        // dedicated branch above, so every value reaching here is one
        // `toSqlValue` already accepts.
        sets.push(`${key} = ?`);
        vals.push(this.toSqlValue(val as string | number | boolean | string[] | null, key));
      }
    }
    if (sets.length === 0) return;
    vals.push(id);
    this.execSql(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`, vals);

    if (fields.content || fields.summary || fields.tags || fields.archived) {
      this.execSql(`DELETE FROM memories_fts WHERE id = ?`, [id]);
      const mem = this.getMemoryById(id, true);
      if (mem && !mem.archived) {
        this.execSql(
          `INSERT INTO memories_fts (id, namespace, content, summary, tags) VALUES (?, ?, ?, ?, ?)`,
          [mem.id, mem.namespace, mem.content, mem.summary, mem.tags.join(' ')],
        );
      }
    }
  }

  deleteMemory(id: string): boolean {
    this.assertMutableAllowed();
    const mem = this.getMemoryById(id, true);
    if (!mem) return false;
    this.execSql(`DELETE FROM memories WHERE id = ?`, [id]);
    this.execSql(`DELETE FROM memories_fts WHERE id = ?`, [id]);
    // Cascade-clean edges (add-memory-links) so both `forget` and `review`'s
    // `archive` action (which calls this same method after archiveMemory)
    // never leave a memory_links row pointing at a now-missing memory.
    this.execSql(`DELETE FROM memory_links WHERE from_id = ? OR to_id = ?`, [id, id]);
    return true;
  }

  getMemoryById(id: string, includeArchived = false): MemoryRecordWithoutEmbedding | null {
    const sql = includeArchived
      ? `SELECT * FROM memories WHERE id = ?`
      : `SELECT * FROM memories WHERE id = ? AND archived = 0`;
    const row = this.queryOne(sql, [id]);
    return row ? this.rowToMemory(row) : null;
  }

  getMemoryByChecksum(namespace: string, checksum: string, collection?: string): MemoryRecordWithoutEmbedding | null {
    // Exact dedup is scoped to the collection when one is given, so identical
    // content in a different collection is treated as a distinct memory rather
    // than a cross-collection NOOP.
    let sql = `SELECT * FROM memories WHERE namespace = ? AND checksum = ? AND archived = 0`;
    const params: SqlParams = [namespace, checksum];
    if (collection !== undefined) {
      sql += ` AND collection = ?`;
      params.push(collection);
    }
    sql += ` LIMIT 1`;
    const row = this.queryOne(sql, params);
    return row ? this.rowToMemory(row) : null;
  }

  listMemories(namespace: string, limit: number, cursor?: string): MemoryRecordWithoutEmbedding[] {
    let sql = `SELECT * FROM memories WHERE namespace = ? AND archived = 0`;
    const params: SqlParams = [namespace];
    if (cursor) {
      const sepIdx = cursor.indexOf('|');
      if (sepIdx !== -1) {
        const cursorTime = cursor.substring(0, sepIdx);
        const cursorId = cursor.substring(sepIdx + 1);
        sql += ` AND (created_at < ? OR (created_at = ? AND id < ?))`;
        params.push(cursorTime, cursorTime, cursorId);
      } else {
        sql += ` AND created_at < ?`;
        params.push(cursor);
      }
    }
    sql += ` ORDER BY created_at DESC, id DESC LIMIT ?`;
    params.push(limit);
    return this.queryMemories(sql, params);
  }

  listMemoriesInCollection(namespace: string, collection: string, limit: number, cursor?: string): MemoryRecordWithoutEmbedding[] {
    let sql = `SELECT * FROM memories WHERE namespace = ? AND collection = ? AND archived = 0`;
    const params: SqlParams = [namespace, collection];
    if (cursor) {
      const sepIdx = cursor.indexOf('|');
      if (sepIdx !== -1) {
        const cursorTime = cursor.substring(0, sepIdx);
        const cursorId = cursor.substring(sepIdx + 1);
        sql += ` AND (created_at < ? OR (created_at = ? AND id < ?))`;
        params.push(cursorTime, cursorTime, cursorId);
      } else {
        sql += ` AND created_at < ?`;
        params.push(cursor);
      }
    }
    sql += ` ORDER BY created_at DESC, id DESC LIMIT ?`;
    params.push(limit);
    return this.queryMemories(sql, params);
  }

  /**
   * A namespace's pinned, non-archived memories, ordered `updated_at DESC`
   * ("most recently affirmed first") — the always-included candidate set for
   * `buildInjectPayload`'s pinned step. See add-inject-pinning.
   */
  listPinnedMemories(namespace: string): MemoryRecordWithoutEmbedding[] {
    return this.queryMemories(
      `SELECT * FROM memories WHERE namespace = ? AND archived = 0 AND pinned = 1 ORDER BY updated_at DESC`,
      [namespace],
    );
  }

  countPinnedMemories(namespace: string): number {
    const row = this.queryOne(
      `SELECT COUNT(*) as cnt FROM memories WHERE namespace = ? AND archived = 0 AND pinned = 1`,
      [namespace],
    );
    return row ? this.getNumber(row, 'cnt') : 0;
  }

  countMemories(namespace?: string): number {
    const sql = namespace
      ? `SELECT COUNT(*) as cnt FROM memories WHERE namespace = ? AND archived = 0`
      : `SELECT COUNT(*) as cnt FROM memories WHERE archived = 0`;
    const params: SqlParams = namespace ? [namespace] : [];
    const row = this.queryOne(sql, params);
    return row ? this.getNumber(row, 'cnt') : 0;
  }

  countMemoriesInCollection(namespace: string, collection: string): number {
    const row = this.queryOne(
      `SELECT COUNT(*) as cnt FROM memories WHERE namespace = ? AND collection = ? AND archived = 0`,
      [namespace, collection],
    );
    return row ? this.getNumber(row, 'cnt') : 0;
  }

  fullTextSearch(namespace: string, query: string, limit: number, collection?: string, filter?: RecallFilter): Array<{ id: string; rank: number }> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    const conditions = terms.map(() => `(LOWER(f.content) LIKE ? OR LOWER(f.summary) LIKE ? OR LOWER(f.tags) LIKE ?)`);
    const params: SqlParams = [namespace];

    let collectionJoin = ' JOIN memories m ON f.id = m.id AND m.archived = 0';
    if (collection) {
      collectionJoin += ` AND m.collection = ?`;
      params.push(collection);
    }

    for (const term of terms) {
      const like = `%${term}%`;
      params.push(like, like, like);
    }

    // Push type/tags predicates down so `limit` counts matching memories (see
    // `push-down-recall-filters`). These are appended to `conditions` (not
    // `collectionJoin`) and their params pushed after the term LIKEs above,
    // so their `?` placeholders land in the same relative order in both the
    // SQL text and the bound params array.
    if (filter?.type) {
      conditions.push('m.type = ?');
      params.push(filter.type);
    }
    if (filter?.tags && filter.tags.length > 0) {
      // Delimiter-aware match against the JSON-serialized `m.tags` column
      // (`["foo","bar"]`): each tag is wrapped in double quotes by
      // JSON.stringify, so `%"tag"%` cannot match a differently-named tag
      // that merely shares a substring (e.g. "foo" vs. "foobar"). OR over
      // provided tags, mirroring recall's pre-existing "match any" semantics.
      conditions.push(`(${filter.tags.map(() => 'm.tags LIKE ?').join(' OR ')})`);
      for (const tag of filter.tags) {
        params.push(`%"${tag}"%`);
      }
    }
    if (filter?.after !== undefined) {
      conditions.push('m.created_at >= ?');
      params.push(filter.after);
    }
    if (filter?.before !== undefined) {
      conditions.push('m.created_at <= ?');
      params.push(filter.before);
    }

    // Over-fetch a bounded candidate pool so the relevance ranker below has rows to
    // order; the matching predicate is non-sargable LIKE, so keep the cap modest.
    const candidateLimit = Math.min(Math.max(limit * 5, 50), 500);
    params.push(candidateLimit);

    // `memories_fts` is a plain table (not an FTS5 virtual table), so there is no
    // bm25()/rank available. Compute a deterministic term-frequency relevance score
    // per row — weighting matches in the curated summary/tags above the body — and
    // return rows ordered by descending relevance. Ordering is what feeds hybrid RRF
    // (which ranks by array position), so this replaces the previous constant rank
    // that made the fulltext RRF component degenerate.
    const sql = `SELECT f.id, f.content, f.summary, f.tags FROM memories_fts f${collectionJoin} WHERE f.namespace = ? AND ${conditions.join(' AND ')} LIMIT ?`;
    const rows = this.queryAll(sql, params);
    const scored: Array<{ id: string; rank: number }> = [];
    for (const row of rows) {
      const content = this.getString(row, 'content').toLowerCase();
      const summary = this.getString(row, 'summary').toLowerCase();
      const tags = this.getString(row, 'tags').toLowerCase();
      let score = 0;
      for (const term of terms) {
        score += SqliteStore.countOccurrences(content, term)
          + SqliteStore.countOccurrences(summary, term) * 2
          + SqliteStore.countOccurrences(tags, term) * 2;
      }
      scored.push({ id: this.getString(row, 'id'), rank: score });
    }
    // Higher relevance first; break ties on id for deterministic ordering.
    scored.sort((a, b) => (b.rank - a.rank) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return scored.slice(0, limit);
  }

  /** Counts non-overlapping occurrences of `needle` within `haystack`. */
  private static countOccurrences(haystack: string, needle: string): number {
    if (!needle) return 0;
    let count = 0;
    let pos = haystack.indexOf(needle);
    while (pos !== -1) {
      count++;
      pos = haystack.indexOf(needle, pos + needle.length);
    }
    return count;
  }

  markStale(memoryId: string): void {
    this.assertMutableAllowed();
    this.execSql(`UPDATE memories SET stale = 1 WHERE id = ?`, [memoryId]);
  }

  getStaleMemories(importanceBelow: number, limit: number): MemoryRecordWithoutEmbedding[] {
    return this.queryMemories(
      `SELECT * FROM memories WHERE stale = 1 AND importance < ? AND category IS NULL AND archived = 0 ORDER BY importance ASC LIMIT ?`,
      [importanceBelow, limit],
    );
  }

  listStaleCandidateIds(cutoffIso: string): string[] {
    const rows = this.queryAll(
      `SELECT id FROM memories WHERE last_accessed < ? AND stale = 0 AND category IS NULL AND archived = 0`,
      [cutoffIso],
    );
    return rows.map(row => this.getString(row, 'id'));
  }

  touchMemory(id: string): void {
    if (this.lifecycleOperation) return;
    const now = new Date().toISOString();
    this.execSql(
      `UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?`,
      [now, id],
    );
  }

  recordAccess(
    id: string,
    accessCount: number,
    lastAccessed: string,
    expiresAt?: string | null,
    retentionTier?: RetentionTier,
    reviewDue?: string | null,
  ): void {
    if (this.lifecycleOperation) return;
    const sets = ['access_count = ?', 'last_accessed = ?'];
    const params: SqlParams = [accessCount, lastAccessed];
    if (expiresAt !== undefined) {
      sets.push('expires_at = ?');
      params.push(expiresAt);
    }
    if (retentionTier) {
      sets.push('retention_tier = ?');
      params.push(retentionTier);
    }
    if (reviewDue !== undefined) {
      sets.push('review_due = ?');
      params.push(reviewDue);
    }
    params.push(id);
    this.execSql(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  markVectorSync(
    id: string, synced: boolean,
    options?: { allowDuringLifecycle?: boolean; embeddingModel?: string | null },
  ): void {
    if (!options?.allowDuringLifecycle) {
      this.assertMutableAllowed();
    }
    // `embeddingModel` is set in the same statement (rather than a separate
    // updateMemory call) so a re-embed running during a restore lifecycle
    // window (allowDuringLifecycle: true) can stamp the new identity without
    // tripping assertMutableAllowed, which updateMemory always enforces.
    if (options && 'embeddingModel' in options) {
      this.execSql(
        `UPDATE memories SET vector_synced = ?, embedding_model = ? WHERE id = ?`,
        [synced ? 1 : 0, options.embeddingModel ?? null, id],
      );
    } else {
      this.execSql(`UPDATE memories SET vector_synced = ? WHERE id = ?`, [synced ? 1 : 0, id]);
    }
  }

  markVectorsSyncBatch(ids: string[], synced: boolean, options?: { allowDuringLifecycle?: boolean }): void {
    if (!options?.allowDuringLifecycle) {
      this.assertMutableAllowed();
    }
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(', ');
    this.execSql(
      `UPDATE memories SET vector_synced = ? WHERE id IN (${placeholders})`,
      [synced ? 1 : 0, ...ids],
    );
  }

  markAllVectorsSyncState(synced: boolean, options?: { allowDuringLifecycle?: boolean }): number {
    if (!options?.allowDuringLifecycle) {
      this.assertMutableAllowed();
    }
    const affected = synced ? this.countUnsyncedVectors() : this.countMemories();
    if (affected === 0) {
      return 0;
    }
    this.execSql(`UPDATE memories SET vector_synced = ? WHERE archived = 0`, [synced ? 1 : 0]);
    return affected;
  }

  recordAccessBatch(
    updates: AccessUpdate[],
  ): void {
    if (this.lifecycleOperation || updates.length === 0) return;
    // A single prepared statement is reused across every row: the tri-state
    // optional fields (expires_at/retention_tier/review_due) are expressed with a
    // `CASE WHEN <changed> THEN <value> ELSE <column>` guard so an "unchanged"
    // field (update.<field> === undefined) is a no-op write in SQL, without
    // needing to know the row's current value in JS and without rebuilding/
    // re-parsing the SQL string per row (matching prior per-row SET-shape
    // behavior exactly). Reused directly (not through `execSql`) because the
    // whole point is compiling the statement once for the loop, not once per row.
    const stmt = this.db.prepare(
      `UPDATE memories SET
        access_count = ?,
        last_accessed = ?,
        expires_at = CASE WHEN ? THEN ? ELSE expires_at END,
        retention_tier = CASE WHEN ? THEN ? ELSE retention_tier END,
        review_due = CASE WHEN ? THEN ? ELSE review_due END
      WHERE id = ?`,
    );
    for (const update of updates) {
      const expiresChanged = update.expires_at !== undefined;
      const tierChanged = !!update.retention_tier;
      const reviewChanged = update.review_due !== undefined;
      const params: SqlParams = [
        update.access_count,
        update.last_accessed,
        expiresChanged ? 1 : 0,
        expiresChanged ? (update.expires_at as string | null) : null,
        tierChanged ? 1 : 0,
        tierChanged ? (update.retention_tier as string) : null,
        reviewChanged ? 1 : 0,
        reviewChanged ? (update.review_due as string | null) : null,
        update.id,
      ];
      stmt.run(...params);
    }
  }

  listExpiredMemories(nowIso: string, tier?: RetentionTier): MemoryRecordWithoutEmbedding[] {
    const sql = tier
      ? `SELECT * FROM memories WHERE archived = 0 AND decay_eligible = 1 AND expires_at IS NOT NULL AND expires_at < ? AND retention_tier = ? ORDER BY expires_at ASC`
      : `SELECT * FROM memories WHERE archived = 0 AND decay_eligible = 1 AND expires_at IS NOT NULL AND expires_at < ? ORDER BY expires_at ASC`;
    const params: SqlParams = tier ? [nowIso, tier] : [nowIso];
    return this.queryMemories(sql, params);
  }

  /**
   * `T1` (institutional) memories whose `expires_at` or `review_due` has
   * passed. These are surfaced as review candidates, never as direct-delete
   * candidates: `listExpiredMemories` alone would miss rows whose expiry is
   * still in the future but whose `review_due` has already lapsed, so this
   * query is a separate OR condition rather than reusing that method with a
   * `T1` filter.
   */
  listReviewCandidates(nowIso: string, limit = 200): MemoryRecordWithoutEmbedding[] {
    return this.queryMemories(
      `SELECT * FROM memories WHERE archived = 0 AND retention_tier = 'T1'
       AND ((expires_at IS NOT NULL AND expires_at < ?) OR (review_due IS NOT NULL AND review_due < ?))
       ORDER BY COALESCE(review_due, expires_at) ASC LIMIT ?`,
      [nowIso, nowIso, limit],
    );
  }

  /**
   * Namespace-scoped, paginated companion to `listReviewCandidates`: the
   * review queue surfaced through the `review` MCP tool needs a bound (`due
   * now` or `due within N days`, via `before`) and cursor pagination rather
   * than the GC-oriented top-N-globally shape `listReviewCandidates` has.
   * Only T1 memories carry a `review_due`, so the tier filter mirrors that
   * invariant; ordering is oldest-due-first per the review queue contract.
   */
  listReviewDue(namespace: string, before: string, limit: number, cursor?: string): MemoryRecordWithoutEmbedding[] {
    let sql = `SELECT * FROM memories WHERE archived = 0 AND namespace = ? AND retention_tier = 'T1'
       AND review_due IS NOT NULL AND review_due <= ?`;
    const params: SqlParams = [namespace, before];
    if (cursor) {
      const sepIdx = cursor.indexOf('|');
      if (sepIdx !== -1) {
        const cursorDue = cursor.substring(0, sepIdx);
        const cursorId = cursor.substring(sepIdx + 1);
        sql += ` AND (review_due > ? OR (review_due = ? AND id > ?))`;
        params.push(cursorDue, cursorDue, cursorId);
      }
    }
    sql += ` ORDER BY review_due ASC, id ASC LIMIT ?`;
    params.push(limit);
    return this.queryMemories(sql, params);
  }

  listExpiringMemories(nowIso: string, untilIso: string, limit: number): MemoryRecordWithoutEmbedding[] {
    return this.queryMemories(
      `SELECT * FROM memories WHERE archived = 0 AND expires_at IS NOT NULL AND expires_at >= ? AND expires_at <= ? ORDER BY expires_at ASC LIMIT ?`,
      [nowIso, untilIso, limit],
    );
  }

  countExpiringMemories(nowIso: string, untilIso: string): number {
    const row = this.queryOne(
      `SELECT COUNT(*) as cnt FROM memories WHERE archived = 0 AND expires_at IS NOT NULL AND expires_at >= ? AND expires_at <= ?`,
      [nowIso, untilIso],
    );
    return row ? this.getNumber(row, 'cnt') : 0;
  }

  countByTier(): Record<RetentionTier, number> {
    const counts: Record<RetentionTier, number> = { T0: 0, T1: 0, T2: 0, T3: 0 };
    const rows = this.queryAll(
      `SELECT retention_tier, COUNT(*) as cnt FROM memories WHERE archived = 0 GROUP BY retention_tier`,
    );
    for (const row of rows) {
      const tier = this.getString(row, 'retention_tier') as RetentionTier;
      counts[tier] = this.getNumber(row, 'cnt');
    }
    return counts;
  }

  getTierStats(): TierStats[] {
    const counts = this.countByTier();
    return (Object.keys(counts) as RetentionTier[]).map(tier => ({ tier, count: counts[tier] }));
  }

  // `last_success_at` only advances when this call reports a clean run
  // (`degraded = false`); a degraded call leaves it untouched so it keeps
  // reflecting the last time cleanup actually completed cleanly — the basis
  // for the `cleanup_lag_seconds` health signal.
  setRetentionDegraded(degraded: boolean, message: string | null = null, completedAt?: string): void {
    this.assertMutableAllowed();
    const degradedInt = degraded ? 1 : 0;
    const now = completedAt ?? new Date().toISOString();
    this.execSql(
      `INSERT INTO retention_state (id, degraded, message, last_success_at, updated_at)
       VALUES (1, ?1, ?2, CASE WHEN ?1 = 0 THEN ?3 ELSE NULL END, ?3)
       ON CONFLICT(id) DO UPDATE SET
         degraded = ?1,
         message = ?2,
         last_success_at = CASE WHEN ?1 = 0 THEN ?3 ELSE retention_state.last_success_at END,
         updated_at = ?3`,
      [degradedInt, message, now],
    );
  }

  getRetentionDegraded(): { degraded: boolean; message: string | null; last_success_at: string | null } {
    const row = this.queryOne(`SELECT degraded, message, last_success_at FROM retention_state WHERE id = 1`);
    if (!row) {
      return { degraded: false, message: null, last_success_at: null };
    }
    return {
      degraded: this.getNumber(row, 'degraded') === 1,
      message: this.getNullableString(row, 'message'),
      last_success_at: this.getNullableString(row, 'last_success_at'),
    };
  }

  // Cumulative counters (`distilled_total`/`skipped_total`) accumulate across
  // every run this process (or a prior one, since it's persisted) has
  // recorded; `last_run_degraded` reflects only the most recent run. See
  // add-memory-distillation.
  recordDistillationRun(
    result: { distilled: number; skipped: number; degraded: boolean },
    completedAt?: string,
  ): void {
    this.assertMutableAllowed();
    const now = completedAt ?? new Date().toISOString();
    this.execSql(
      `INSERT INTO distillation_state (id, last_run_at, last_run_degraded, distilled_total, skipped_total)
       VALUES (1, ?1, ?2, ?3, ?4)
       ON CONFLICT(id) DO UPDATE SET
         last_run_at = ?1,
         last_run_degraded = ?2,
         distilled_total = distillation_state.distilled_total + ?3,
         skipped_total = distillation_state.skipped_total + ?4`,
      [now, result.degraded ? 1 : 0, result.distilled, result.skipped],
    );
  }

  getDistillationState(): {
    last_run_at: string | null; last_run_degraded: boolean; distilled_total: number; skipped_total: number;
  } {
    const row = this.queryOne(
      `SELECT last_run_at, last_run_degraded, distilled_total, skipped_total FROM distillation_state WHERE id = 1`,
    );
    if (!row) {
      return { last_run_at: null, last_run_degraded: false, distilled_total: 0, skipped_total: 0 };
    }
    return {
      last_run_at: this.getNullableString(row, 'last_run_at'),
      last_run_degraded: this.getNumber(row, 'last_run_degraded') === 1,
      distilled_total: this.getNumber(row, 'distilled_total'),
      skipped_total: this.getNumber(row, 'skipped_total'),
    };
  }

  /**
   * Distinct namespace/collection pairs currently holding at least one
   * non-archived T2/T3 episodic memory — the scan scope
   * `DistillationService.runOnce` iterates over. See add-memory-distillation.
   */
  listDistillationCollections(): Array<{ namespace: string; collection: string }> {
    const rows = this.queryAll(
      `SELECT DISTINCT namespace, collection FROM memories
       WHERE archived = 0 AND type = 'episodic' AND retention_tier IN ('T2', 'T3')
       ORDER BY namespace, collection`,
    );
    return rows.map(row => ({ namespace: this.getString(row, 'namespace'), collection: this.getString(row, 'collection') }));
  }

  countArchivedMemories(): number {
    const row = this.queryOne(`SELECT COUNT(*) as cnt FROM memory_archive`);
    return row ? this.getNumber(row, 'cnt') : 0;
  }

  countUnsyncedVectors(): number {
    const row = this.queryOne(`SELECT COUNT(*) as cnt FROM memories WHERE archived = 0 AND vector_synced = 0`);
    return row ? this.getNumber(row, 'cnt') : 0;
  }

  listMemoriesNeedingVectorSync(limit: number, cursor?: string): MemoryRecordWithoutEmbedding[] {
    let sql = `SELECT * FROM memories WHERE archived = 0 AND vector_synced = 0`;
    const params: SqlParams = [];
    if (cursor) {
      const sepIdx = cursor.indexOf('|');
      if (sepIdx !== -1) {
        const cursorTime = cursor.substring(0, sepIdx);
        const cursorId = cursor.substring(sepIdx + 1);
        sql += ` AND (created_at > ? OR (created_at = ? AND id > ?))`;
        params.push(cursorTime, cursorTime, cursorId);
      } else {
        sql += ` AND created_at > ?`;
        params.push(cursor);
      }
    }
    sql += ` ORDER BY created_at ASC, id ASC LIMIT ?`;
    params.push(limit);
    return this.queryMemories(sql, params);
  }

  /**
   * Reads the store's persisted expected embedding identity, or null if no
   * vector-producing write has adopted one yet (a fresh store, or one that
   * hasn't written since upgrading to provenance stamping).
   */
  getExpectedEmbeddingIdentity(): string | null {
    const row = this.queryOne(`SELECT identity FROM embedding_state WHERE id = 1`);
    return row ? this.getString(row, 'identity') : null;
  }

  /**
   * Adopts `identity` as the store's expected embedding identity only if no
   * expectation has been recorded yet ("first stamped write"). A no-op when
   * a row already exists — the expected identity is only ever overwritten
   * explicitly by `setExpectedEmbeddingIdentity` (a completed re-embed), so
   * this can be called unconditionally after every compatible write without
   * risk of masking a mismatch that was already recorded.
   */
  adoptEmbeddingIdentityIfAbsent(identity: string): void {
    this.assertMutableAllowed();
    const now = new Date().toISOString();
    this.execSql(
      `INSERT OR IGNORE INTO embedding_state (id, identity, adopted_at, updated_at) VALUES (1, ?, ?, ?)`,
      [identity, now, now],
    );
  }

  /** Unconditionally overwrites the store's expected embedding identity (a completed re-embed). */
  setExpectedEmbeddingIdentity(identity: string): void {
    this.assertMutableAllowed();
    const now = new Date().toISOString();
    this.execSql(
      `INSERT INTO embedding_state (id, identity, adopted_at, updated_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET identity = ?1, updated_at = ?3`,
      [identity, now, now],
    );
  }

  /**
   * Rows whose embedding stamp differs from `activeIdentity` — the re-embed
   * migration's selection set. Legacy rows (NULL stamp, predating
   * provenance) are excluded unless `includeLegacy` is set, per "Legacy
   * unstamped rows ... included in migration only when explicitly
   * requested".
   */
  countMemoriesWithStaleEmbeddingStamp(activeIdentity: string, includeLegacy: boolean): number {
    const row = this.queryOne(
      `SELECT COUNT(*) as cnt FROM memories
       WHERE archived = 0 AND (embedding_model != ?1 OR (embedding_model IS NULL AND ?2))`,
      [activeIdentity, includeLegacy ? 1 : 0],
    );
    return row ? this.getNumber(row, 'cnt') : 0;
  }

  listMemoriesWithStaleEmbeddingStamp(
    activeIdentity: string, includeLegacy: boolean, limit: number, cursor?: string,
  ): MemoryRecordWithoutEmbedding[] {
    let sql = `SELECT * FROM memories
       WHERE archived = 0 AND (embedding_model != ?1 OR (embedding_model IS NULL AND ?2))`;
    const params: SqlParams = [activeIdentity, includeLegacy ? 1 : 0];
    if (cursor) {
      const sepIdx = cursor.indexOf('|');
      if (sepIdx !== -1) {
        const cursorTime = cursor.substring(0, sepIdx);
        const cursorId = cursor.substring(sepIdx + 1);
        sql += ` AND (created_at > ? OR (created_at = ? AND id > ?))`;
        params.push(cursorTime, cursorTime, cursorId);
      } else {
        sql += ` AND created_at > ?`;
        params.push(cursor);
      }
    }
    sql += ` ORDER BY created_at ASC, id ASC LIMIT ?`;
    params.push(limit);
    return this.queryMemories(sql, params);
  }

  listMemoryChecksums(): Array<{ id: string; checksum: string }> {
    const rows = this.queryAll(`SELECT id, checksum FROM memories WHERE archived = 0`);
    return rows.map(row => ({ id: this.getString(row, 'id'), checksum: this.getString(row, 'checksum') }));
  }

  archiveMemory(memory: MemoryRecordWithoutEmbedding, expiredAt: string): void {
    this.assertMutableAllowed();
    this.execSql(
      `INSERT INTO memory_archive (memory_id, summary, tier, namespace, created_at, expired_at, access_count, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        memory.id,
        memory.summary,
        memory.retention_tier,
        memory.namespace,
        memory.created_at,
        expiredAt,
        memory.access_count,
        JSON.stringify(memory.tags),
      ],
    );
  }

  listArchive(limit: number): ArchiveRecord[] {
    const rows = this.queryAll(`SELECT * FROM memory_archive ORDER BY expired_at DESC LIMIT ?`, [limit]);
    return rows.map(row => this.rowToArchive(row));
  }

  searchArchive(query: string, limit: number): ArchiveRecord[] {
    const like = `%${query.toLowerCase()}%`;
    const rows = this.queryAll(
      `SELECT * FROM memory_archive WHERE LOWER(summary) LIKE ? OR LOWER(tags) LIKE ? ORDER BY expired_at DESC LIMIT ?`,
      [like, like, limit],
    );
    return rows.map(row => this.rowToArchive(row));
  }

  /**
   * Namespace-scoped companion to `searchArchive` (which is deliberately
   * namespace-agnostic for the CLI/operator surface): the `search` tool's
   * `include_archived` results must not leak archived memories across
   * namespace boundaries the way an unscoped LIKE query would. Matches on
   * retained summary/tags only — content and vectors are not kept for
   * archived rows, so this is metadata-term search, not semantic search.
   */
  searchArchived(namespace: string, query: string, limit: number): ArchiveRecord[] {
    const like = `%${query.toLowerCase()}%`;
    const rows = this.queryAll(
      `SELECT * FROM memory_archive WHERE namespace = ? AND (LOWER(summary) LIKE ? OR LOWER(tags) LIKE ?) ORDER BY expired_at DESC LIMIT ?`,
      [namespace, like, like, limit],
    );
    return rows.map(row => this.rowToArchive(row));
  }

  getArchiveByMemoryId(memoryId: string): ArchiveRecord | null {
    const row = this.queryOne(`SELECT * FROM memory_archive WHERE memory_id = ? ORDER BY id DESC LIMIT 1`, [memoryId]);
    return row ? this.rowToArchive(row) : null;
  }

  deleteArchive(memoryId: string): void {
    this.assertMutableAllowed();
    this.execSql(`DELETE FROM memory_archive WHERE memory_id = ?`, [memoryId]);
  }

  insertRevision(memoryId: string, revision: number, content: string, updatedAt: string, updatedBy?: string): void {
    this.assertMutableAllowed();
    this.execSql(
      `INSERT INTO memory_revisions (memory_id, revision, content, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)`,
      [memoryId, revision, content, updatedAt, updatedBy ?? null],
    );
  }

  listRevisions(memoryId: string): MemoryRevisionRecord[] {
    const rows = this.queryAll(`SELECT * FROM memory_revisions WHERE memory_id = ? ORDER BY revision DESC`, [memoryId]);
    return rows.map(row => ({
      id: this.getNumber(row, 'id'),
      memory_id: this.getString(row, 'memory_id'),
      revision: this.getNumber(row, 'revision'),
      content: this.getString(row, 'content'),
      updated_at: this.getString(row, 'updated_at'),
      updated_by: this.getNullableString(row, 'updated_by'),
    }));
  }

  private rowToMemoryLink(row: SqlRow): MemoryLinkRecord {
    return {
      id: this.getNumber(row, 'id'),
      namespace: this.getString(row, 'namespace'),
      from_id: this.getString(row, 'from_id'),
      to_id: this.getString(row, 'to_id'),
      relation: this.getString(row, 'relation') as MemoryLinkRelation,
      created_at: this.getString(row, 'created_at'),
      created_by: this.getNullableString(row, 'created_by'),
    };
  }

  addMemoryLink(
    namespace: string, fromId: string, toId: string, relation: MemoryLinkRelation, createdBy: string | null,
  ): { record: MemoryLinkRecord; created: boolean } {
    this.assertMutableAllowed();
    // Read-then-write (mirrors getArchiveByMemoryId's read-before-insert
    // shape) rather than INSERT OR IGNORE + a second query, so an existing
    // edge is returned verbatim including its original created_at/created_by.
    const existing = this.queryOne(
      `SELECT * FROM memory_links WHERE from_id = ? AND to_id = ? AND relation = ?`,
      [fromId, toId, relation],
    );
    if (existing) {
      return { record: this.rowToMemoryLink(existing), created: false };
    }

    const now = new Date().toISOString();
    this.execSql(
      `INSERT INTO memory_links (namespace, from_id, to_id, relation, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
      [namespace, fromId, toId, relation, now, createdBy],
    );

    const inserted = this.queryOne(
      `SELECT * FROM memory_links WHERE from_id = ? AND to_id = ? AND relation = ?`,
      [fromId, toId, relation],
    );
    return { record: this.rowToMemoryLink(inserted as SqlRow), created: true };
  }

  listMemoryLinks(
    memoryId: string, options?: { relation?: MemoryLinkRelation },
  ): Array<MemoryLinkRecord & { direction: 'outgoing' | 'incoming' }> {
    const params: SqlParams = [memoryId, memoryId];
    let sql = `SELECT * FROM memory_links WHERE (from_id = ? OR to_id = ?)`;
    if (options?.relation) {
      sql += ` AND relation = ?`;
      params.push(options.relation);
    }
    const rows = this.queryAll(sql, params);
    return rows.map((row) => {
      const record = this.rowToMemoryLink(row);
      return { ...record, direction: record.from_id === memoryId ? ('outgoing' as const) : ('incoming' as const) };
    });
  }

  removeMemoryLink(fromId: string, toId: string, relation: MemoryLinkRelation): boolean {
    this.assertMutableAllowed();
    const existing = this.queryOne(
      `SELECT 1 FROM memory_links WHERE from_id = ? AND to_id = ? AND relation = ?`,
      [fromId, toId, relation],
    );
    if (!existing) return false;

    this.execSql(
      `DELETE FROM memory_links WHERE from_id = ? AND to_id = ? AND relation = ?`,
      [fromId, toId, relation],
    );
    return true;
  }

  getDbSizeBytes(): number {
    try {
      return statSync(this.dbPath).size;
    } catch {
      return 0;
    }
  }

  setCategory(name: string, slot: string, content: string): CategoryRecord {
    this.assertMutableAllowed();
    const now = new Date().toISOString();
    const existing = this.getCategory(name);
    if (existing) {
      this.execSql(
        `UPDATE categories SET content = ?, slot = ?, revision = revision + 1, updated_at = ? WHERE name = ?`,
        [content, slot, now, name],
      );
    } else {
      this.execSql(
        `INSERT INTO categories (name, slot, content, revision, updated_at) VALUES (?, ?, ?, 1, ?)`,
        [name, slot, content, now],
      );
    }
    return this.getCategory(name)!;
  }

  getCategory(name: string): CategoryRecord | null {
    const row = this.queryOne(`SELECT * FROM categories WHERE name = ?`, [name]);
    if (!row) return null;
    return {
      name: this.getString(row, 'name'),
      slot: this.getString(row, 'slot') as CategoryRecord['slot'],
      content: this.getString(row, 'content'),
      updated_at: this.getString(row, 'updated_at'),
      revision: this.getNumber(row, 'revision'),
    };
  }

  listCategories(): CategoryRecord[] {
    const rows = this.queryAll(`SELECT * FROM categories ORDER BY name`);
    return rows.map(row => ({
      name: this.getString(row, 'name'),
      slot: this.getString(row, 'slot') as CategoryRecord['slot'],
      content: this.getString(row, 'content'),
      updated_at: this.getString(row, 'updated_at'),
      revision: this.getNumber(row, 'revision'),
    }));
  }

  deleteCategory(name: string): boolean {
    this.assertMutableAllowed();
    const exists = this.getCategory(name);
    if (!exists) return false;
    this.execSql(`DELETE FROM categories WHERE name = ?`, [name]);
    return true;
  }

  createCollection(namespace: string, name: string, embeddingModel: string, embeddingDimensions: number): void {
    this.assertMutableAllowed();
    const now = new Date().toISOString();
    this.execSql(
      `INSERT OR IGNORE INTO collections (name, namespace, embedding_model, embedding_dimensions, created_at) VALUES (?, ?, ?, ?, ?)`,
      [name, namespace, embeddingModel, embeddingDimensions, now],
    );
  }

  getCollection(namespace: string, name: string): CollectionRecord | null {
    const row = this.queryOne(`SELECT * FROM collections WHERE namespace = ? AND name = ?`, [namespace, name]);
    if (!row) return null;
    return {
      name: this.getString(row, 'name'),
      namespace: this.getString(row, 'namespace'),
      embedding_model: this.getString(row, 'embedding_model'),
      embedding_dimensions: this.getNumber(row, 'embedding_dimensions'),
    };
  }

  listCollections(namespace?: string): Array<{ name: string; count: number }> {
    const sql = namespace
      ? `SELECT c.name, COUNT(m.id) as count FROM collections c LEFT JOIN memories m ON c.name = m.collection AND c.namespace = m.namespace AND m.archived = 0 WHERE c.namespace = ? GROUP BY c.name ORDER BY c.name`
      : `SELECT c.name, COUNT(m.id) as count FROM collections c LEFT JOIN memories m ON c.name = m.collection AND c.namespace = m.namespace AND m.archived = 0 GROUP BY c.namespace, c.name ORDER BY c.name`;
    const params: SqlParams = namespace ? [namespace] : [];
    const rows = this.queryAll(sql, params);
    return rows.map(row => ({ name: this.getString(row, 'name'), count: this.getNumber(row, 'count') }));
  }

  deleteCollection(namespace: string, name: string): boolean {
    this.assertMutableAllowed();
    const exists = this.queryOne(`SELECT 1 FROM collections WHERE namespace = ? AND name = ?`, [namespace, name]);
    if (!exists) return false;
    this.execSql(`DELETE FROM collections WHERE namespace = ? AND name = ?`, [namespace, name]);
    return true;
  }

  deleteMemoriesInCollection(namespace: string, collection: string): { deleted: number; ids: string[] } {
    this.assertMutableAllowed();
    const idRows = this.queryAll(`SELECT id FROM memories WHERE namespace = ? AND collection = ? AND archived = 0`, [namespace, collection]);
    const ids = idRows.map(row => this.getString(row, 'id'));

    if (ids.length === 0) {
      return { deleted: 0, ids: [] };
    }

    this.execSql(`DELETE FROM memories_fts WHERE namespace = ? AND id IN (SELECT id FROM memories WHERE namespace = ? AND collection = ?)`, [
      namespace,
      namespace,
      collection,
    ]);
    this.execSql(`DELETE FROM memories WHERE namespace = ? AND collection = ?`, [namespace, collection]);

    return { deleted: ids.length, ids };
  }

  insertAudit(entry: AuditEntry): void {
    this.assertMutableAllowed();
    this.execSql(
      `INSERT INTO audit_log (id, timestamp, namespace, operation, memory_id, client_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [entry.id, entry.timestamp, entry.namespace, entry.operation, entry.memory_id, entry.client_id, entry.details ?? null],
    );
  }

  listAudit(limit: number): AuditEntry[] {
    const rows = this.queryAll(`SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?`, [limit]);
    return rows.map(row => ({
      id: this.getString(row, 'id'),
      timestamp: this.getString(row, 'timestamp'),
      namespace: this.getString(row, 'namespace'),
      operation: this.getString(row, 'operation') as AuditEntry['operation'],
      memory_id: this.getString(row, 'memory_id'),
      client_id: this.getString(row, 'client_id'),
      details: this.getNullableString(row, 'details') ?? undefined,
    }));
  }

  recordFeedback(entry: RecallFeedbackEntry): void {
    this.assertMutableAllowed();
    this.execSql(
      `INSERT INTO recall_feedback (memory_id, namespace, query, score, useful, client_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.memory_id,
        entry.namespace,
        entry.query,
        entry.score,
        entry.useful ? 1 : 0,
        entry.client_id,
        entry.created_at,
      ],
    );
  }

  insertBackupMeta(path: string, sizeBytes: number, memoryCount: number, checksum: string): void {
    this.assertMutableAllowed();
    this.execSql(
      `INSERT INTO backup_metadata (path, size_bytes, memory_count, checksum, created_at) VALUES (?, ?, ?, ?, ?)`,
      [path, sizeBytes, memoryCount, checksum, new Date().toISOString()],
    );
  }

  listBackups(): Array<{ path: string; size_bytes: number; memory_count: number; created_at: string }> {
    const rows = this.queryAll(`SELECT * FROM backup_metadata ORDER BY created_at DESC`);
    return rows.map(row => ({
      path: this.getString(row, 'path'),
      size_bytes: this.getNumber(row, 'size_bytes'),
      memory_count: this.getNumber(row, 'memory_count'),
      created_at: this.getString(row, 'created_at'),
    }));
  }

  /**
   * `DatabaseSync` has no `serialize()`/`export()` (sql.js's whole-image dump).
   * `VACUUM INTO` writes a compacted, self-contained, checkpointed copy of the
   * live database to a temp file inside `dataDir` (same volume, so the rename-
   * free `readFileSync` below never crosses a filesystem boundary), which is
   * read back into memory and then removed. See design.md "exportData() via
   * VACUUM INTO".
   */
  exportData(): Buffer {
    const tmpPath = join(this.dataDir, `.brain-export-${randomUUID()}.sqlite`);
    try {
      this.db.prepare('VACUUM INTO ?').run(tmpPath);
      return readFileSync(tmpPath);
    } finally {
      if (existsSync(tmpPath)) {
        try {
          unlinkSync(tmpPath);
        } catch {
          // Best-effort cleanup of the scratch export file.
        }
      }
    }
  }

  getDatabasePath(): string {
    return this.dbPath;
  }

  healthCheck(): boolean {
    try {
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.cancelDeferredFlush();
    // TRUNCATE checkpoint folds the WAL back into the main file and removes
    // the `-wal`/`-shm` sidecars, so a clean shutdown leaves `brain.db`
    // self-contained and readable by any whole-file reader (old sql.js
    // builds, external inspection tools) — see design.md "close() checkpoints
    // TRUNCATE first".
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.close();
  }

  beginLifecycleOperation(reason: string): void {
    if (this.lifecycleOperation) {
      throw new Error(`Storage lifecycle operation already in progress: ${this.lifecycleOperation}`);
    }
    this.cancelDeferredFlush();
    this.lifecycleOperation = reason;
  }

  endLifecycleOperation(reason?: string): void {
    if (reason && this.lifecycleOperation !== reason) {
      throw new Error(`Mismatched lifecycle operation end: expected ${this.lifecycleOperation ?? 'none'}, got ${reason}`);
    }
    this.lifecycleOperation = null;
  }

  isLifecycleOperationInProgress(): boolean {
    return this.lifecycleOperation !== null;
  }

  getLifecycleOperation(): string | null {
    return this.lifecycleOperation;
  }

  getMemoriesByIds(ids: string[]): MemoryRecordWithoutEmbedding[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return this.queryMemories(
      `SELECT * FROM memories WHERE archived = 0 AND id IN (${placeholders})`,
      ids,
    );
  }

  listMemoryIdsInCollection(namespace: string, collection: string): string[] {
    const rows = this.queryAll(`SELECT id FROM memories WHERE namespace = ? AND collection = ? AND archived = 0`, [namespace, collection]);
    return rows.map(row => this.getString(row, 'id'));
  }

  listCategoryHeaders(): CategoryHeader[] {
    const rows = this.queryAll(`SELECT name, slot, updated_at, revision, LENGTH(content) as content_length FROM categories ORDER BY name`);
    return rows.map(row => ({
      name: this.getString(row, 'name'),
      slot: this.getString(row, 'slot'),
      updated_at: this.getString(row, 'updated_at'),
      revision: this.getNumber(row, 'revision'),
      content_length: this.getNumber(row, 'content_length'),
    }));
  }

  getCategoryContentSlice(name: string, maxChars: number): CategoryContentSlice | null {
    // Both `content` and `content_length` are computed by SQLite in the same
    // character-counting unit, so callers can compare `length` against a
    // SQLite-derived total (e.g. CategoryHeader.content_length) without ever
    // going through JS's UTF-16 `.length` on either side.
    const row = this.queryOne(
      `SELECT substr(content, 1, ?) as content, LENGTH(substr(content, 1, ?)) as content_length FROM categories WHERE name = ?`,
      [maxChars, maxChars, name],
    );
    if (!row) return null;
    return {
      content: this.getNullableString(row, 'content') ?? '',
      length: this.getNumber(row, 'content_length'),
    };
  }

  private queryMemories(sql: string, params: SqlParams): MemoryRecordWithoutEmbedding[] {
    return this.queryAll(sql, params).map(row => this.rowToMemory(row));
  }

  private rowToMemory(row: SqlRow): MemoryRecordWithoutEmbedding {
    return {
      id: this.getString(row, 'id'),
      namespace: this.getString(row, 'namespace'),
      collection: this.getString(row, 'collection'),
      type: this.getString(row, 'type') as MemoryRecord['type'],
      category: this.getNullableString(row, 'category'),
      content: this.getString(row, 'content'),
      summary: this.getString(row, 'summary'),
      tags: JSON.parse(this.getNullableString(row, 'tags') ?? '[]') as string[],
      source: this.getString(row, 'source') as MemoryRecord['source'],
      checksum: this.getString(row, 'checksum'),
      importance: this.getNumber(row, 'importance'),
      retention_tier: (this.getNullableString(row, 'retention_tier') ?? 'T2') as RetentionTier,
      expires_at: this.getNullableString(row, 'expires_at'),
      decay_eligible: this.getBoolean(row, 'decay_eligible'),
      review_due: this.getNullableString(row, 'review_due'),
      access_count: this.getNumber(row, 'access_count'),
      last_operation: this.getString(row, 'last_operation') as MemoryRecord['last_operation'],
      merged_from: this.getNullableString(row, 'merged_from'),
      derived_from: JSON.parse(this.getNullableString(row, 'derived_from') ?? 'null') as string[] | null,
      archived: this.getBoolean(row, 'archived'),
      vector_synced: row.vector_synced === undefined ? true : this.getBoolean(row, 'vector_synced'),
      pinned: row.pinned === undefined ? false : this.getBoolean(row, 'pinned'),
      device_id: this.getNullableString(row, 'device_id'),
      embedding_model: this.getNullableString(row, 'embedding_model'),
      origin: this.parseOrigin(this.getNullableString(row, 'origin')),
      confidence: row.confidence === undefined ? 1.0 : this.getNumber(row, 'confidence'),
      created_at: this.getString(row, 'created_at'),
      updated_at: this.getString(row, 'updated_at'),
      last_accessed: this.getString(row, 'last_accessed'),
    };
  }

  // Fail-soft on corrupt/legacy JSON: a malformed `origin` column must never
  // block a memory read, matching the project's general fail-soft-on-read
  // posture for optional metadata (see `derived_from`/`tags` parsing above).
  // See add-memory-provenance-metadata.
  private parseOrigin(raw: string | null): MemoryOrigin | null {
    if (raw === null) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as MemoryOrigin;
      }
      return null;
    } catch {
      return null;
    }
  }

  private rowToArchive(row: SqlRow): ArchiveRecord {
    return {
      id: this.getNumber(row, 'id'),
      memory_id: this.getString(row, 'memory_id'),
      summary: this.getString(row, 'summary'),
      tier: this.getString(row, 'tier') as RetentionTier,
      namespace: this.getString(row, 'namespace'),
      created_at: this.getString(row, 'created_at'),
      expired_at: this.getString(row, 'expired_at'),
      access_count: this.getNumber(row, 'access_count'),
      tags: JSON.parse(this.getNullableString(row, 'tags') ?? '[]') as string[],
    };
  }

  // -- Bootstrap session methods --

  createBootstrapSession(namespace: string, totalSections: number): void {
    const now = new Date().toISOString();
    for (let i = 1; i <= totalSections; i++) {
      this.execSql(
        `INSERT OR IGNORE INTO bootstrap_sessions (namespace, section_number, status, memory_ids, updated_at) VALUES (?, ?, 'pending', '[]', ?)`,
        [namespace, i, now],
      );
    }
  }

  getBootstrapSession(namespace: string): BootstrapSectionRow[] {
    const rows = this.queryAll(`SELECT * FROM bootstrap_sessions WHERE namespace = ? ORDER BY section_number`, [namespace]);
    return rows.map(row => ({
      namespace: this.getString(row, 'namespace'),
      section_number: this.getNumber(row, 'section_number'),
      status: this.getString(row, 'status') as 'pending' | 'complete',
      memory_ids: JSON.parse(this.getString(row, 'memory_ids')) as string[],
      updated_at: this.getString(row, 'updated_at'),
    }));
  }

  updateBootstrapSection(namespace: string, sectionNumber: number, status: 'pending' | 'complete', memoryIds: string[]): void {
    const now = new Date().toISOString();
    this.execSql(
      `UPDATE bootstrap_sessions SET status = ?, memory_ids = ?, updated_at = ? WHERE namespace = ? AND section_number = ?`,
      [status, JSON.stringify(memoryIds), now, namespace, sectionNumber],
    );
  }

  resetBootstrapSection(namespace: string, sectionNumber: number): string[] {
    const memoryIds = this.getBootstrapSectionMemoryIds(namespace, sectionNumber);
    this.clearBootstrapSection(namespace, sectionNumber);
    return memoryIds;
  }

  /**
   * Reads the memory IDs tracked for a section WITHOUT clearing them. Callers that need to
   * delete the underlying memories (including their Qdrant vectors) before the section's
   * tracking is cleared should use this together with `clearBootstrapSection`, so the
   * recovery list survives a mid-deletion failure (see `clearBootstrapSection`).
   */
  getBootstrapSectionMemoryIds(namespace: string, sectionNumber: number): string[] {
    const row = this.queryOne(`SELECT memory_ids FROM bootstrap_sessions WHERE namespace = ? AND section_number = ?`, [namespace, sectionNumber]);
    return row ? (JSON.parse(this.getString(row, 'memory_ids')) as string[]) : [];
  }

  /**
   * Clears a section's tracked memory IDs and marks it pending. Callers deleting the
   * underlying memories first (see `getBootstrapSectionMemoryIds`) should only call this
   * AFTER every deletion succeeds, so a failed deletion leaves `memory_ids` intact and the
   * section recoverable/re-resettable rather than orphaning Qdrant vectors with no tracked
   * recovery list.
   */
  clearBootstrapSection(namespace: string, sectionNumber: number): void {
    const now = new Date().toISOString();
    this.execSql(
      `UPDATE bootstrap_sessions SET status = 'pending', memory_ids = '[]', updated_at = ? WHERE namespace = ? AND section_number = ?`,
      [now, namespace, sectionNumber],
    );
  }

  bootstrapSessionExists(namespace: string): boolean {
    const row = this.queryOne(`SELECT COUNT(*) as cnt FROM bootstrap_sessions WHERE namespace = ?`, [namespace]);
    return row ? this.getNumber(row, 'cnt') > 0 : false;
  }

  private ensureMemoryColumns(): void {
    // Guard: if the memories table doesn't exist yet (fresh DB), skip migrations —
    // SCHEMA_SQL will create it with all columns present.
    const tableFound = this.queryOne(`SELECT name FROM sqlite_master WHERE type='table' AND name='memories'`);
    if (!tableFound) {
      return;
    }

    const existingColumns = new Set<string>();
    for (const row of this.queryAll(`PRAGMA table_info(memories)`)) {
      existingColumns.add(this.getString(row, 'name'));
    }

    const requiredColumns: Array<{ name: string; sql: string }> = [
      { name: 'retention_tier', sql: `ALTER TABLE memories ADD COLUMN retention_tier TEXT NOT NULL DEFAULT 'T2'` },
      { name: 'expires_at', sql: `ALTER TABLE memories ADD COLUMN expires_at TEXT` },
      { name: 'decay_eligible', sql: `ALTER TABLE memories ADD COLUMN decay_eligible INTEGER NOT NULL DEFAULT 1` },
      { name: 'review_due', sql: `ALTER TABLE memories ADD COLUMN review_due TEXT` },
      { name: 'archived', sql: `ALTER TABLE memories ADD COLUMN archived INTEGER NOT NULL DEFAULT 0` },
      { name: 'vector_synced', sql: `ALTER TABLE memories ADD COLUMN vector_synced INTEGER NOT NULL DEFAULT 1` },
      { name: 'device_id', sql: `ALTER TABLE memories ADD COLUMN device_id TEXT` },
      { name: 'embedding_model', sql: `ALTER TABLE memories ADD COLUMN embedding_model TEXT` },
      { name: 'pinned', sql: `ALTER TABLE memories ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0` },
      { name: 'derived_from', sql: `ALTER TABLE memories ADD COLUMN derived_from TEXT` },
      { name: 'origin', sql: `ALTER TABLE memories ADD COLUMN origin TEXT` },
      { name: 'confidence', sql: `ALTER TABLE memories ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0` },
    ];

    for (const column of requiredColumns) {
      if (!existingColumns.has(column.name)) {
        this.db.exec(column.sql);
      }
    }
  }

  private assertMutableAllowed(): void {
    if (this.lifecycleOperation) {
      throw new Error(`Storage lifecycle operation in progress: ${this.lifecycleOperation}`);
    }
  }

  private getRow(value: unknown): SqlRow {
    return value as SqlRow;
  }

  private getString(row: SqlRow, key: string): string {
    const value = row[key];
    if (typeof value !== 'string') {
      throw new Error(`Expected string column "${key}"`);
    }
    return value;
  }

  private getNullableString(row: SqlRow, key: string): string | null {
    const value = row[key];
    if (value == null) {
      return null;
    }
    if (typeof value !== 'string') {
      throw new Error(`Expected nullable string column "${key}"`);
    }
    return value;
  }

  private getNumber(row: SqlRow, key: string): number {
    const value = row[key];
    if (typeof value !== 'number') {
      throw new Error(`Expected number column "${key}"`);
    }
    return value;
  }

  private getBoolean(row: SqlRow, key: string): boolean {
    return Boolean(this.getNumber(row, key));
  }

  private toSqlValue(value: string | number | boolean | string[] | null, key: string): SqlValue {
    if (typeof value === 'string' || typeof value === 'number' || value === null) {
      return value;
    }
    throw new Error(`Unsupported SQL value for "${key}"`);
  }
}

export function atomicWriteFileSync(targetPath: string, data: Buffer): void {
  const tmpPath = `${targetPath}.tmp`;
  writeFileSync(tmpPath, data);
  renameSync(tmpPath, targetPath);
}
