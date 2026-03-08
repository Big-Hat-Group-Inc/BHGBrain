import initSqlJs, { type Database } from 'sql.js';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { MemoryRecord, CategoryRecord, AuditEntry, WriteOperation } from '../domain/types.js';

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
  access_count INTEGER NOT NULL DEFAULT 0,
  last_operation TEXT NOT NULL DEFAULT 'ADD',
  merged_from TEXT,
  stale INTEGER NOT NULL DEFAULT 0,
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
`;

export class SqliteStore {
  private db!: Database;
  private dbPath: string;
  private dirty = false;
  private deferredFlushTimer: ReturnType<typeof setTimeout> | null = null;
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
    this.db.run(SCHEMA_SQL);
    this.flush();
  }

  async reloadFromDisk(): Promise<void> {
    const SQL = await initSqlJs();
    if (this.db) {
      this.db.close();
    }
    if (!existsSync(this.dbPath)) {
      throw new Error(`Database file not found: ${this.dbPath}`);
    }
    const buffer = readFileSync(this.dbPath);
    this.db = new SQL.Database(buffer);
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

  /**
   * Schedule a deferred flush that will persist dirty state within a bounded window.
   * Used for non-critical writes (e.g., access metadata) to avoid synchronous
   * full-database exports on read paths.
   */
  scheduleDeferredFlush(): void {
    if (this.deferredFlushTimer) return; // already scheduled
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

  // -- Memory CRUD --

  insertMemory(mem: Omit<MemoryRecord, 'embedding'>): void {
    this.db.run(
      `INSERT INTO memories (id, namespace, collection, type, category, content, summary, tags, source, checksum, importance, access_count, last_operation, merged_from, created_at, updated_at, last_accessed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [mem.id, mem.namespace, mem.collection, mem.type, mem.category, mem.content, mem.summary,
       JSON.stringify(mem.tags), mem.source, mem.checksum, mem.importance, mem.access_count,
       mem.last_operation, mem.merged_from, mem.created_at, mem.updated_at, mem.last_accessed],
    );
    this.db.run(
      `INSERT INTO memories_fts (id, namespace, content, summary, tags) VALUES (?, ?, ?, ?, ?)`,
      [mem.id, mem.namespace, mem.content, mem.summary, mem.tags.join(' ')],
    );
    this.markDirty();
  }

  updateMemory(id: string, fields: Partial<Omit<MemoryRecord, 'embedding'>>): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [key, val] of Object.entries(fields)) {
      if (key === 'tags') {
        sets.push('tags = ?');
        vals.push(JSON.stringify(val));
      } else {
        sets.push(`${key} = ?`);
        vals.push(val);
      }
    }
    if (sets.length === 0) return;
    vals.push(id);
    this.db.run(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`, vals as any[]);

    if (fields.content || fields.summary || fields.tags) {
      this.db.run(`DELETE FROM memories_fts WHERE id = ?`, [id]);
      const mem = this.getMemoryById(id);
      if (mem) {
        this.db.run(
          `INSERT INTO memories_fts (id, namespace, content, summary, tags) VALUES (?, ?, ?, ?, ?)`,
          [mem.id, mem.namespace, mem.content, mem.summary, (mem.tags as string[]).join(' ')],
        );
      }
    }
    this.markDirty();
  }

  deleteMemory(id: string): boolean {
    const mem = this.getMemoryById(id);
    if (!mem) return false;
    this.db.run(`DELETE FROM memories WHERE id = ?`, [id]);
    this.db.run(`DELETE FROM memories_fts WHERE id = ?`, [id]);
    this.markDirty();
    return true;
  }

  getMemoryById(id: string): (Omit<MemoryRecord, 'embedding'>) | null {
    const stmt = this.db.prepare(`SELECT * FROM memories WHERE id = ?`);
    stmt.bind([id]);
    if (!stmt.step()) { stmt.free(); return null; }
    const row = stmt.getAsObject();
    stmt.free();
    return this.rowToMemory(row);
  }

  getMemoryByChecksum(namespace: string, checksum: string): (Omit<MemoryRecord, 'embedding'>) | null {
    const stmt = this.db.prepare(`SELECT * FROM memories WHERE namespace = ? AND checksum = ? LIMIT 1`);
    stmt.bind([namespace, checksum]);
    if (!stmt.step()) { stmt.free(); return null; }
    const row = stmt.getAsObject();
    stmt.free();
    return this.rowToMemory(row);
  }

  listMemories(namespace: string, limit: number, cursor?: string): Array<Omit<MemoryRecord, 'embedding'>> {
    let sql = `SELECT * FROM memories WHERE namespace = ?`;
    const params: unknown[] = [namespace];
    if (cursor) {
      // Composite cursor: "created_at|id" for stable tie-breaking
      const sepIdx = cursor.indexOf('|');
      if (sepIdx !== -1) {
        const cursorTime = cursor.substring(0, sepIdx);
        const cursorId = cursor.substring(sepIdx + 1);
        sql += ` AND (created_at < ? OR (created_at = ? AND id < ?))`;
        params.push(cursorTime, cursorTime, cursorId);
      } else {
        // Backwards-compatible: plain timestamp cursor
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
      ? `SELECT COUNT(*) as cnt FROM memories WHERE namespace = ?`
      : `SELECT COUNT(*) as cnt FROM memories`;
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
      `SELECT COUNT(*) as cnt FROM memories WHERE namespace = ? AND collection = ?`,
    );
    stmt.bind([namespace, collection]);
    stmt.step();
    const row = stmt.getAsObject() as { cnt: number };
    stmt.free();
    return row.cnt;
  }

  fullTextSearch(namespace: string, query: string, limit: number, collection?: string): Array<{ id: string; rank: number }> {
    // Use LIKE-based search since sql.js WASM doesn't include FTS5
    // When migrated to better-sqlite3 (with native build), switch to FTS5 MATCH
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    const conditions = terms.map(() => `(LOWER(f.content) LIKE ? OR LOWER(f.summary) LIKE ? OR LOWER(f.tags) LIKE ?)`);
    const params: unknown[] = [namespace];

    // Collection-aware filtering: join with memories table to filter by collection
    let collectionJoin = '';
    if (collection) {
      collectionJoin = ` JOIN memories m ON f.id = m.id AND m.collection = ?`;
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
      // Compute a simple relevance score based on match count
      results.push({ id: row.id, rank: -terms.length }); // negative rank = better (FTS5 convention)
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
      `SELECT * FROM memories WHERE stale = 1 AND importance < ? AND category IS NULL ORDER BY importance ASC LIMIT ?`,
      [importanceBelow, limit],
    );
  }

  listStaleCandidateIds(cutoffIso: string): string[] {
    const stmt = this.db.prepare(
      `SELECT id FROM memories WHERE last_accessed < ? AND stale = 0 AND category IS NULL`,
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
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?`,
      [now, id],
    );
    this.markDirty();
  }

  getDbSizeBytes(): number {
    try {
      const { size } = require('node:fs').statSync(this.dbPath);
      return size;
    } catch {
      return 0;
    }
  }

  // -- Categories --

  setCategory(name: string, slot: string, content: string): CategoryRecord {
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
    if (!stmt.step()) { stmt.free(); return null; }
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
    const exists = this.getCategory(name);
    if (!exists) return false;
    this.db.run(`DELETE FROM categories WHERE name = ?`, [name]);
    this.markDirty();
    return true;
  }

  // -- Collections --

  createCollection(namespace: string, name: string, embeddingModel: string, embeddingDimensions: number): void {
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
    if (!stmt.step()) { stmt.free(); return null; }
    const row = stmt.getAsObject() as any;
    stmt.free();
    return { name: row.name, namespace: row.namespace, embedding_model: row.embedding_model, embedding_dimensions: row.embedding_dimensions };
  }

  listCollections(namespace?: string): Array<{ name: string; count: number }> {
    const sql = namespace
      ? `SELECT c.name, COUNT(m.id) as count FROM collections c LEFT JOIN memories m ON c.name = m.collection AND c.namespace = m.namespace WHERE c.namespace = ? GROUP BY c.name ORDER BY c.name`
      : `SELECT c.name, COUNT(m.id) as count FROM collections c LEFT JOIN memories m ON c.name = m.collection AND c.namespace = m.namespace GROUP BY c.namespace, c.name ORDER BY c.name`;
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
    const select = this.db.prepare(`SELECT id FROM memories WHERE namespace = ? AND collection = ?`);
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

  // -- Audit --

  insertAudit(entry: AuditEntry): void {
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
        id: row.id, timestamp: row.timestamp, namespace: row.namespace,
        operation: row.operation, memory_id: row.memory_id, client_id: row.client_id, details: row.details,
      });
    }
    stmt.free();
    return results;
  }

  // -- Backup metadata --

  insertBackupMeta(path: string, sizeBytes: number, memoryCount: number, checksum: string): void {
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

  // -- Export/Import for backup --

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

  // -- Helpers --

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
      access_count: row.access_count,
      last_operation: row.last_operation,
      merged_from: row.merged_from ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      last_accessed: row.last_accessed,
    };
  }
}

/**
 * Write file atomically: write to temp file then rename.
 * Prevents truncated/partial files on crash.
 */
export function atomicWriteFileSync(targetPath: string, data: Buffer): void {
  const tmpPath = `${targetPath}.tmp`;
  writeFileSync(tmpPath, data);
  renameSync(tmpPath, targetPath);
}
