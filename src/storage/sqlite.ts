import initSqlJs, { type Database } from 'sql.js';
import { readFileSync, writeFileSync, existsSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  MemoryRecord,
  CategoryRecord,
  AuditEntry,
  ArchiveRecord,
  MemoryRevisionRecord,
  RetentionTier,
  TierStats,
} from '../domain/types.js';

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
  stale INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  vector_synced INTEGER NOT NULL DEFAULT 1,
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
`;

export class SqliteStore {
  private db!: Database;
  private dbPath: string;
  private dirty = false;
  private deferredFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private lifecycleOperation: string | null = null;
  private static readonly DEFERRED_FLUSH_MS = 5_000;

  constructor(private dataDir: string) {
    this.dbPath = join(dataDir, 'brain.db');
  }

  async init(): Promise<void> {
    const SQL = await initSqlJs();
    if (existsSync(this.dbPath)) {
      const buffer = readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
    }
    // Run column migrations BEFORE SCHEMA_SQL so new indexes (e.g. idx_memories_tier)
    // that reference retention_tier don't fail on an existing DB that predates the column.
    this.ensureMemoryColumns();
    this.db.run(SCHEMA_SQL);
    this.flush();
  }

  async reloadFromDisk(): Promise<void> {
    const SQL = await initSqlJs();
    this.cancelDeferredFlush();
    this.dirty = false;
    if (this.db) {
      this.db.close();
    }
    if (!existsSync(this.dbPath)) {
      throw new Error(`Database file not found: ${this.dbPath}`);
    }
    const buffer = readFileSync(this.dbPath);
    this.db = new SQL.Database(buffer);
    this.ensureMemoryColumns();
    this.db.run(SCHEMA_SQL);
    this.dirty = false;
  }

  flush(): void {
    const data = this.db.export();
    atomicWriteFileSync(this.dbPath, Buffer.from(data));
    this.dirty = false;
  }

  private markDirty(): void {
    this.dirty = true;
  }

  flushIfDirty(): void {
    if (this.dirty) this.flush();
  }

  scheduleDeferredFlush(): void {
    if (this.lifecycleOperation) return;
    if (this.deferredFlushTimer) return;
    this.deferredFlushTimer = setTimeout(() => {
      this.deferredFlushTimer = null;
      this.flushIfDirty();
    }, SqliteStore.DEFERRED_FLUSH_MS);
  }

  cancelDeferredFlush(): void {
    if (this.deferredFlushTimer) {
      clearTimeout(this.deferredFlushTimer);
      this.deferredFlushTimer = null;
    }
  }

  insertMemory(mem: Omit<MemoryRecord, 'embedding'>): void {
    this.assertMutableAllowed();
    const retentionTier = mem.retention_tier ?? 'T2';
    const expiresAt = mem.expires_at ?? null;
    const decayEligible = mem.decay_eligible ?? true;
    const reviewDue = mem.review_due ?? null;
    const archived = mem.archived ?? false;
    const vectorSynced = mem.vector_synced ?? true;
    this.db.run(
      `INSERT INTO memories (
        id, namespace, collection, type, category, content, summary, tags, source, checksum,
        importance, retention_tier, expires_at, decay_eligible, review_due, access_count,
        last_operation, merged_from, stale, archived, vector_synced, created_at, updated_at, last_accessed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        0,
        archived ? 1 : 0,
        vectorSynced ? 1 : 0,
        mem.created_at,
        mem.updated_at,
        mem.last_accessed,
      ],
    );
    this.db.run(
      `INSERT INTO memories_fts (id, namespace, content, summary, tags) VALUES (?, ?, ?, ?, ?)`,
      [mem.id, mem.namespace, mem.content, mem.summary, mem.tags.join(' ')],
    );
    this.markDirty();
  }

  updateMemory(id: string, fields: Partial<Omit<MemoryRecord, 'embedding'>>): void {
    this.assertMutableAllowed();
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [key, val] of Object.entries(fields)) {
      if (key === 'tags') {
        sets.push('tags = ?');
        vals.push(JSON.stringify(val));
      } else if (key === 'decay_eligible' || key === 'archived' || key === 'vector_synced') {
        sets.push(`${key} = ?`);
        vals.push(val ? 1 : 0);
      } else {
        sets.push(`${key} = ?`);
        vals.push(val);
      }
    }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.run(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`, vals as any[]);

    if (fields.content || fields.summary || fields.tags || fields.archived) {
      this.db.run(`DELETE FROM memories_fts WHERE id = ?`, [id]);
      const mem = this.getMemoryById(id, true);
      if (mem && !mem.archived) {
        this.db.run(
          `INSERT INTO memories_fts (id, namespace, content, summary, tags) VALUES (?, ?, ?, ?, ?)`,
          [mem.id, mem.namespace, mem.content, mem.summary, mem.tags.join(' ')],
        );
      }
    }
    this.markDirty();
  }

  deleteMemory(id: string): boolean {
    this.assertMutableAllowed();
    const mem = this.getMemoryById(id, true);
    if (!mem) return false;
    this.db.run(`DELETE FROM memories WHERE id = ?`, [id]);
    this.db.run(`DELETE FROM memories_fts WHERE id = ?`, [id]);
    this.markDirty();
    return true;
  }

  getMemoryById(id: string, includeArchived = false): Omit<MemoryRecord, 'embedding'> | null {
    const sql = includeArchived
      ? `SELECT * FROM memories WHERE id = ?`
      : `SELECT * FROM memories WHERE id = ? AND archived = 0`;
    const stmt = this.db.prepare(sql);
    stmt.bind([id]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject();
    stmt.free();
    return this.rowToMemory(row);
  }

  getMemoryByChecksum(namespace: string, checksum: string): Omit<MemoryRecord, 'embedding'> | null {
    const stmt = this.db.prepare(`SELECT * FROM memories WHERE namespace = ? AND checksum = ? AND archived = 0 LIMIT 1`);
    stmt.bind([namespace, checksum]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject();
    stmt.free();
    return this.rowToMemory(row);
  }

  listMemories(namespace: string, limit: number, cursor?: string): Array<Omit<MemoryRecord, 'embedding'>> {
    let sql = `SELECT * FROM memories WHERE namespace = ? AND archived = 0`;
    const params: unknown[] = [namespace];
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

  countMemories(namespace?: string): number {
    const sql = namespace
      ? `SELECT COUNT(*) as cnt FROM memories WHERE namespace = ? AND archived = 0`
      : `SELECT COUNT(*) as cnt FROM memories WHERE archived = 0`;
    const params = namespace ? [namespace] : [];
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    stmt.step();
    const row = stmt.getAsObject() as { cnt: number };
    stmt.free();
    return row.cnt;
  }

  countMemoriesInCollection(namespace: string, collection: string): number {
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM memories WHERE namespace = ? AND collection = ? AND archived = 0`,
    );
    stmt.bind([namespace, collection]);
    stmt.step();
    const row = stmt.getAsObject() as { cnt: number };
    stmt.free();
    return row.cnt;
  }

  fullTextSearch(namespace: string, query: string, limit: number, collection?: string): Array<{ id: string; rank: number }> {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    const conditions = terms.map(() => `(LOWER(f.content) LIKE ? OR LOWER(f.summary) LIKE ? OR LOWER(f.tags) LIKE ?)`);
    const params: unknown[] = [namespace];

    let collectionJoin = ' JOIN memories m ON f.id = m.id AND m.archived = 0';
    if (collection) {
      collectionJoin += ` AND m.collection = ?`;
      params.push(collection);
    }

    for (const term of terms) {
      const like = `%${term}%`;
      params.push(like, like, like);
    }
    params.push(limit);

    const sql = `SELECT f.id, ${terms.length} as rank FROM memories_fts f${collectionJoin} WHERE f.namespace = ? AND ${conditions.join(' AND ')} LIMIT ?`;
    const stmt = this.db.prepare(sql);
    stmt.bind(params as any[]);
    const results: Array<{ id: string; rank: number }> = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as { id: string; rank: number };
      results.push({ id: row.id, rank: -terms.length });
    }
    stmt.free();
    return results;
  }

  markStale(memoryId: string): void {
    this.db.run(`UPDATE memories SET stale = 1 WHERE id = ?`, [memoryId]);
    this.markDirty();
  }

  getStaleMemories(importanceBelow: number, limit: number): Array<Omit<MemoryRecord, 'embedding'>> {
    return this.queryMemories(
      `SELECT * FROM memories WHERE stale = 1 AND importance < ? AND category IS NULL AND archived = 0 ORDER BY importance ASC LIMIT ?`,
      [importanceBelow, limit],
    );
  }

  listStaleCandidateIds(cutoffIso: string): string[] {
    const stmt = this.db.prepare(
      `SELECT id FROM memories WHERE last_accessed < ? AND stale = 0 AND category IS NULL AND archived = 0`,
    );
    stmt.bind([cutoffIso]);
    const ids: string[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as { id: string };
      ids.push(row.id);
    }
    stmt.free();
    return ids;
  }

  touchMemory(id: string): void {
    if (this.lifecycleOperation) return;
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?`,
      [now, id],
    );
    this.markDirty();
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
    const params: unknown[] = [accessCount, lastAccessed];
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
    this.db.run(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`, params as any[]);
    this.markDirty();
  }

  markVectorSync(id: string, synced: boolean): void {
    this.assertMutableAllowed();
    this.db.run(`UPDATE memories SET vector_synced = ? WHERE id = ?`, [synced ? 1 : 0, id]);
    this.markDirty();
  }

  recordAccessBatch(
    updates: Array<{
      id: string;
      access_count: number;
      last_accessed: string;
      expires_at?: string | null;
      retention_tier?: RetentionTier;
      review_due?: string | null;
    }>,
  ): void {
    if (this.lifecycleOperation || updates.length === 0) return;
    for (const update of updates) {
      const sets = ['access_count = ?', 'last_accessed = ?'];
      const params: unknown[] = [update.access_count, update.last_accessed];
      if (update.expires_at !== undefined) {
        sets.push('expires_at = ?');
        params.push(update.expires_at);
      }
      if (update.retention_tier) {
        sets.push('retention_tier = ?');
        params.push(update.retention_tier);
      }
      if (update.review_due !== undefined) {
        sets.push('review_due = ?');
        params.push(update.review_due);
      }
      params.push(update.id);
      this.db.run(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`, params as any[]);
    }
    this.markDirty();
  }

  listExpiredMemories(nowIso: string, tier?: RetentionTier): Array<Omit<MemoryRecord, 'embedding'>> {
    const sql = tier
      ? `SELECT * FROM memories WHERE archived = 0 AND decay_eligible = 1 AND expires_at IS NOT NULL AND expires_at < ? AND retention_tier = ? ORDER BY expires_at ASC`
      : `SELECT * FROM memories WHERE archived = 0 AND decay_eligible = 1 AND expires_at IS NOT NULL AND expires_at < ? ORDER BY expires_at ASC`;
    const params = tier ? [nowIso, tier] : [nowIso];
    return this.queryMemories(sql, params);
  }

  listExpiringMemories(nowIso: string, untilIso: string, limit: number): Array<Omit<MemoryRecord, 'embedding'>> {
    return this.queryMemories(
      `SELECT * FROM memories WHERE archived = 0 AND expires_at IS NOT NULL AND expires_at >= ? AND expires_at <= ? ORDER BY expires_at ASC LIMIT ?`,
      [nowIso, untilIso, limit],
    );
  }

  countExpiringMemories(nowIso: string, untilIso: string): number {
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM memories WHERE archived = 0 AND expires_at IS NOT NULL AND expires_at >= ? AND expires_at <= ?`,
    );
    stmt.bind([nowIso, untilIso]);
    stmt.step();
    const row = stmt.getAsObject() as { cnt: number };
    stmt.free();
    return row.cnt;
  }

  countByTier(): Record<RetentionTier, number> {
    const counts: Record<RetentionTier, number> = { T0: 0, T1: 0, T2: 0, T3: 0 };
    const stmt = this.db.prepare(
      `SELECT retention_tier, COUNT(*) as cnt FROM memories WHERE archived = 0 GROUP BY retention_tier`,
    );
    while (stmt.step()) {
      const row = stmt.getAsObject() as { retention_tier: RetentionTier; cnt: number };
      counts[row.retention_tier] = row.cnt;
    }
    stmt.free();
    return counts;
  }

  getTierStats(): TierStats[] {
    const counts = this.countByTier();
    return (Object.keys(counts) as RetentionTier[]).map(tier => ({ tier, count: counts[tier] }));
  }

  countArchivedMemories(): number {
    const stmt = this.db.prepare(`SELECT COUNT(*) as cnt FROM memory_archive`);
    stmt.step();
    const row = stmt.getAsObject() as { cnt: number };
    stmt.free();
    return row.cnt;
  }

  countUnsyncedVectors(): number {
    const stmt = this.db.prepare(`SELECT COUNT(*) as cnt FROM memories WHERE archived = 0 AND vector_synced = 0`);
    stmt.step();
    const row = stmt.getAsObject() as { cnt: number };
    stmt.free();
    return row.cnt;
  }

  archiveMemory(memory: Omit<MemoryRecord, 'embedding'>, expiredAt: string): void {
    this.db.run(
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
    this.markDirty();
  }

  listArchive(limit: number): ArchiveRecord[] {
    const stmt = this.db.prepare(`SELECT * FROM memory_archive ORDER BY expired_at DESC LIMIT ?`);
    stmt.bind([limit]);
    const rows: ArchiveRecord[] = [];
    while (stmt.step()) {
      rows.push(this.rowToArchive(stmt.getAsObject()));
    }
    stmt.free();
    return rows;
  }

  searchArchive(query: string, limit: number): ArchiveRecord[] {
    const like = `%${query.toLowerCase()}%`;
    const stmt = this.db.prepare(
      `SELECT * FROM memory_archive WHERE LOWER(summary) LIKE ? OR LOWER(tags) LIKE ? ORDER BY expired_at DESC LIMIT ?`,
    );
    stmt.bind([like, like, limit]);
    const rows: ArchiveRecord[] = [];
    while (stmt.step()) {
      rows.push(this.rowToArchive(stmt.getAsObject()));
    }
    stmt.free();
    return rows;
  }

  getArchiveByMemoryId(memoryId: string): ArchiveRecord | null {
    const stmt = this.db.prepare(`SELECT * FROM memory_archive WHERE memory_id = ? ORDER BY id DESC LIMIT 1`);
    stmt.bind([memoryId]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = this.rowToArchive(stmt.getAsObject());
    stmt.free();
    return row;
  }

  deleteArchive(memoryId: string): void {
    this.assertMutableAllowed();
    this.db.run(`DELETE FROM memory_archive WHERE memory_id = ?`, [memoryId]);
    this.markDirty();
  }

  insertRevision(memoryId: string, revision: number, content: string, updatedAt: string, updatedBy?: string): void {
    this.assertMutableAllowed();
    this.db.run(
      `INSERT INTO memory_revisions (memory_id, revision, content, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)`,
      [memoryId, revision, content, updatedAt, updatedBy ?? null],
    );
    this.markDirty();
  }

  listRevisions(memoryId: string): MemoryRevisionRecord[] {
    const stmt = this.db.prepare(`SELECT * FROM memory_revisions WHERE memory_id = ? ORDER BY revision DESC`);
    stmt.bind([memoryId]);
    const results: MemoryRevisionRecord[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as any;
      results.push({
        id: row.id,
        memory_id: row.memory_id,
        revision: row.revision,
        content: row.content,
        updated_at: row.updated_at,
        updated_by: row.updated_by ?? null,
      });
    }
    stmt.free();
    return results;
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
      this.db.run(
        `UPDATE categories SET content = ?, slot = ?, revision = revision + 1, updated_at = ? WHERE name = ?`,
        [content, slot, now, name],
      );
    } else {
      this.db.run(
        `INSERT INTO categories (name, slot, content, revision, updated_at) VALUES (?, ?, ?, 1, ?)`,
        [name, slot, content, now],
      );
    }
    this.markDirty();
    return this.getCategory(name)!;
  }

  getCategory(name: string): CategoryRecord | null {
    const stmt = this.db.prepare(`SELECT * FROM categories WHERE name = ?`);
    stmt.bind([name]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject() as any;
    stmt.free();
    return { name: row.name, slot: row.slot, content: row.content, updated_at: row.updated_at, revision: row.revision };
  }

  listCategories(): CategoryRecord[] {
    const stmt = this.db.prepare(`SELECT * FROM categories ORDER BY name`);
    const results: CategoryRecord[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as any;
      results.push({ name: row.name, slot: row.slot, content: row.content, updated_at: row.updated_at, revision: row.revision });
    }
    stmt.free();
    return results;
  }

  deleteCategory(name: string): boolean {
    this.assertMutableAllowed();
    const exists = this.getCategory(name);
    if (!exists) return false;
    this.db.run(`DELETE FROM categories WHERE name = ?`, [name]);
    this.markDirty();
    return true;
  }

  createCollection(namespace: string, name: string, embeddingModel: string, embeddingDimensions: number): void {
    this.assertMutableAllowed();
    const now = new Date().toISOString();
    this.db.run(
      `INSERT OR IGNORE INTO collections (name, namespace, embedding_model, embedding_dimensions, created_at) VALUES (?, ?, ?, ?, ?)`,
      [name, namespace, embeddingModel, embeddingDimensions, now],
    );
    this.markDirty();
  }

  getCollection(namespace: string, name: string): { name: string; namespace: string; embedding_model: string; embedding_dimensions: number } | null {
    const stmt = this.db.prepare(`SELECT * FROM collections WHERE namespace = ? AND name = ?`);
    stmt.bind([namespace, name]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject() as any;
    stmt.free();
    return { name: row.name, namespace: row.namespace, embedding_model: row.embedding_model, embedding_dimensions: row.embedding_dimensions };
  }

  listCollections(namespace?: string): Array<{ name: string; count: number }> {
    const sql = namespace
      ? `SELECT c.name, COUNT(m.id) as count FROM collections c LEFT JOIN memories m ON c.name = m.collection AND c.namespace = m.namespace AND m.archived = 0 WHERE c.namespace = ? GROUP BY c.name ORDER BY c.name`
      : `SELECT c.name, COUNT(m.id) as count FROM collections c LEFT JOIN memories m ON c.name = m.collection AND c.namespace = m.namespace AND m.archived = 0 GROUP BY c.namespace, c.name ORDER BY c.name`;
    const params = namespace ? [namespace] : [];
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const results: Array<{ name: string; count: number }> = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as any;
      results.push({ name: row.name, count: row.count });
    }
    stmt.free();
    return results;
  }

  deleteCollection(namespace: string, name: string): boolean {
    this.assertMutableAllowed();
    const stmt = this.db.prepare(`SELECT 1 FROM collections WHERE namespace = ? AND name = ?`);
    stmt.bind([namespace, name]);
    const exists = stmt.step();
    stmt.free();
    if (!exists) return false;
    this.db.run(`DELETE FROM collections WHERE namespace = ? AND name = ?`, [namespace, name]);
    this.markDirty();
    return true;
  }

  deleteMemoriesInCollection(namespace: string, collection: string): { deleted: number; ids: string[] } {
    this.assertMutableAllowed();
    const select = this.db.prepare(`SELECT id FROM memories WHERE namespace = ? AND collection = ? AND archived = 0`);
    select.bind([namespace, collection]);
    const ids: string[] = [];
    while (select.step()) {
      const row = select.getAsObject() as { id: string };
      ids.push(row.id);
    }
    select.free();

    if (ids.length === 0) {
      return { deleted: 0, ids: [] };
    }

    this.db.run(`DELETE FROM memories_fts WHERE namespace = ? AND id IN (SELECT id FROM memories WHERE namespace = ? AND collection = ?)`, [
      namespace,
      namespace,
      collection,
    ]);
    this.db.run(`DELETE FROM memories WHERE namespace = ? AND collection = ?`, [namespace, collection]);
    this.markDirty();

    return { deleted: ids.length, ids };
  }

  insertAudit(entry: AuditEntry): void {
    this.assertMutableAllowed();
    this.db.run(
      `INSERT INTO audit_log (id, timestamp, namespace, operation, memory_id, client_id, details) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [entry.id, entry.timestamp, entry.namespace, entry.operation, entry.memory_id, entry.client_id, entry.details ?? null],
    );
    this.markDirty();
  }

  listAudit(limit: number): AuditEntry[] {
    const stmt = this.db.prepare(`SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?`);
    stmt.bind([limit]);
    const results: AuditEntry[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as any;
      results.push({
        id: row.id,
        timestamp: row.timestamp,
        namespace: row.namespace,
        operation: row.operation,
        memory_id: row.memory_id,
        client_id: row.client_id,
        details: row.details,
      });
    }
    stmt.free();
    return results;
  }

  insertBackupMeta(path: string, sizeBytes: number, memoryCount: number, checksum: string): void {
    this.assertMutableAllowed();
    this.db.run(
      `INSERT INTO backup_metadata (path, size_bytes, memory_count, checksum, created_at) VALUES (?, ?, ?, ?, ?)`,
      [path, sizeBytes, memoryCount, checksum, new Date().toISOString()],
    );
    this.markDirty();
  }

  listBackups(): Array<{ path: string; size_bytes: number; memory_count: number; created_at: string }> {
    const stmt = this.db.prepare(`SELECT * FROM backup_metadata ORDER BY created_at DESC`);
    const results: Array<{ path: string; size_bytes: number; memory_count: number; created_at: string }> = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as any;
      results.push({ path: row.path, size_bytes: row.size_bytes, memory_count: row.memory_count, created_at: row.created_at });
    }
    stmt.free();
    return results;
  }

  exportData(): Buffer {
    return Buffer.from(this.db.export());
  }

  getDatabasePath(): string {
    return this.dbPath;
  }

  healthCheck(): boolean {
    try {
      const stmt = this.db.prepare('SELECT 1');
      stmt.step();
      stmt.free();
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    this.cancelDeferredFlush();
    this.flushIfDirty();
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

  getMemoriesByIds(ids: string[]): Array<Omit<MemoryRecord, 'embedding'>> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    return this.queryMemories(
      `SELECT * FROM memories WHERE archived = 0 AND id IN (${placeholders})`,
      ids,
    );
  }

  listMemoryIdsInCollection(namespace: string, collection: string): string[] {
    const stmt = this.db.prepare(`SELECT id FROM memories WHERE namespace = ? AND collection = ? AND archived = 0`);
    stmt.bind([namespace, collection]);
    const ids: string[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as { id: string };
      ids.push(row.id);
    }
    stmt.free();
    return ids;
  }

  listCategoryHeaders(): Array<{ name: string; slot: string; updated_at: string; revision: number; content_length: number }> {
    const stmt = this.db.prepare(`SELECT name, slot, updated_at, revision, LENGTH(content) as content_length FROM categories ORDER BY name`);
    const results: Array<{ name: string; slot: string; updated_at: string; revision: number; content_length: number }> = [];
    while (stmt.step()) {
      const row = stmt.getAsObject() as any;
      results.push({
        name: row.name,
        slot: row.slot,
        updated_at: row.updated_at,
        revision: row.revision,
        content_length: row.content_length,
      });
    }
    stmt.free();
    return results;
  }

  getCategoryContentSlice(name: string, maxChars: number): string | null {
    const stmt = this.db.prepare(`SELECT substr(content, 1, ?) as content FROM categories WHERE name = ?`);
    stmt.bind([maxChars, name]);
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject() as { content: string };
    stmt.free();
    return row.content ?? '';
  }

  private queryMemories(sql: string, params: unknown[]): Array<Omit<MemoryRecord, 'embedding'>> {
    const stmt = this.db.prepare(sql);
    stmt.bind(params as any[]);
    const results: Array<Omit<MemoryRecord, 'embedding'>> = [];
    while (stmt.step()) {
      results.push(this.rowToMemory(stmt.getAsObject()));
    }
    stmt.free();
    return results;
  }

  private rowToMemory(row: any): Omit<MemoryRecord, 'embedding'> {
    return {
      id: row.id,
      namespace: row.namespace,
      collection: row.collection,
      type: row.type,
      category: row.category ?? null,
      content: row.content,
      summary: row.summary,
      tags: JSON.parse(row.tags || '[]'),
      source: row.source,
      checksum: row.checksum,
      importance: row.importance,
      retention_tier: row.retention_tier ?? 'T2',
      expires_at: row.expires_at ?? null,
      decay_eligible: Boolean(row.decay_eligible),
      review_due: row.review_due ?? null,
      access_count: row.access_count,
      last_operation: row.last_operation,
      merged_from: row.merged_from ?? null,
      archived: Boolean(row.archived),
      vector_synced: row.vector_synced === undefined ? true : Boolean(row.vector_synced),
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_accessed: row.last_accessed,
    };
  }

  private rowToArchive(row: any): ArchiveRecord {
    return {
      id: row.id,
      memory_id: row.memory_id,
      summary: row.summary,
      tier: row.tier,
      namespace: row.namespace,
      created_at: row.created_at,
      expired_at: row.expired_at,
      access_count: row.access_count,
      tags: JSON.parse(row.tags || '[]'),
    };
  }

  private ensureMemoryColumns(): void {
    // Guard: if the memories table doesn't exist yet (fresh DB), skip migrations —
    // SCHEMA_SQL will create it with all columns present.
    const tableStmt = this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='memories'`);
    const tableFound = tableStmt.step();
    tableStmt.free();
    if (!tableFound) {
      return;
    }

    const existingColumns = new Set<string>();
    const stmt = this.db.prepare(`PRAGMA table_info(memories)`);
    while (stmt.step()) {
      const row = stmt.getAsObject() as { name: string };
      existingColumns.add(row.name);
    }
    stmt.free();

    const requiredColumns: Array<{ name: string; sql: string }> = [
      { name: 'retention_tier', sql: `ALTER TABLE memories ADD COLUMN retention_tier TEXT NOT NULL DEFAULT 'T2'` },
      { name: 'expires_at', sql: `ALTER TABLE memories ADD COLUMN expires_at TEXT` },
      { name: 'decay_eligible', sql: `ALTER TABLE memories ADD COLUMN decay_eligible INTEGER NOT NULL DEFAULT 1` },
      { name: 'review_due', sql: `ALTER TABLE memories ADD COLUMN review_due TEXT` },
      { name: 'archived', sql: `ALTER TABLE memories ADD COLUMN archived INTEGER NOT NULL DEFAULT 0` },
      { name: 'vector_synced', sql: `ALTER TABLE memories ADD COLUMN vector_synced INTEGER NOT NULL DEFAULT 1` },
    ];

    for (const column of requiredColumns) {
      if (!existingColumns.has(column.name)) {
        this.db.run(column.sql);
      }
    }
  }

  private assertMutableAllowed(): void {
    if (this.lifecycleOperation) {
      throw new Error(`Storage lifecycle operation in progress: ${this.lifecycleOperation}`);
    }
  }
}

export function atomicWriteFileSync(targetPath: string, data: Buffer): void {
  const tmpPath = `${targetPath}.tmp`;
  writeFileSync(tmpPath, data);
  renameSync(tmpPath, targetPath);
}
