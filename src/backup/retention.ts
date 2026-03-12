import { v4 as uuidv4 } from 'uuid';
import type { BrainConfig } from '../config/index.js';
import type { StorageManager } from '../storage/index.js';
import type { ArchiveRecord, MemoryRecord, RetentionTier } from '../domain/types.js';
import { MemoryLifecycleService } from '../domain/lifecycle.js';

export interface GarbageCollectionResult {
  scanned: number;
  archived: number;
  deleted: number;
  candidates: Array<{
    id: string;
    tier: RetentionTier;
    summary: string;
    expires_at: string | null;
  }>;
}

export class RetentionService {
  private lifecycle: MemoryLifecycleService;

  constructor(
    private config: BrainConfig,
    private storage: StorageManager,
  ) {
    this.lifecycle = new MemoryLifecycleService(config);
  }

  async runGc(options?: { dryRun?: boolean; tier?: RetentionTier }): Promise<GarbageCollectionResult> {
    const nowIso = new Date().toISOString();
    const expired = this.storage.sqlite
      .listExpiredMemories(nowIso, options?.tier)
      .filter(memory => memory.retention_tier !== 'T0');

    const candidates = expired.map(memory => ({
      id: memory.id,
      tier: memory.retention_tier,
      summary: memory.summary,
      expires_at: memory.expires_at,
    }));

    if (options?.dryRun) {
      return {
        scanned: expired.length,
        archived: 0,
        deleted: 0,
        candidates,
      };
    }

    let archived = 0;
    let deleted = 0;

    for (const memory of expired) {
      if (this.config.retention.archive_before_delete) {
        this.storage.sqlite.archiveMemory(memory, nowIso);
        archived++;
      }
    }

    deleted = await this.storage.deleteMemories(expired, { flush: false });
    for (const memory of expired) {
      this.storage.logAudit('FORGET', memory.id, memory.namespace, 'system', { flush: false });
    }

    this.storage.sqlite.flushIfDirty();

    return {
      scanned: expired.length,
      archived,
      deleted,
      candidates,
    };
  }

  markStaleMemories(): number {
    const decayDays = this.config.retention?.decay_after_days ?? 180;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - decayDays);
    const staleIds = this.storage.sqlite.listStaleCandidateIds(cutoff.toISOString());
    for (const id of staleIds) {
      this.storage.sqlite.markStale(id);
    }
    this.storage.sqlite.flushIfDirty();
    return staleIds.length;
  }

  runConsolidation(): { staleMarked: number; lowImportanceCandidates: number } {
    const staleMarked = this.markStaleMemories();
    const lowImportanceCandidates = this.storage.sqlite.getStaleMemories(0.5, 100).length;
    return { staleMarked, lowImportanceCandidates };
  }

  getTierStats(): { counts: Record<RetentionTier, number>; archived: number; unsynced_vectors: number } {
    return {
      counts: this.storage.sqlite.countByTier(),
      archived: this.storage.sqlite.countArchivedMemories(),
      unsynced_vectors: this.storage.sqlite.countUnsyncedVectors(),
    };
  }

  listExpiringSoon(limit = 50): Array<Omit<MemoryRecord, 'embedding'>> {
    const now = new Date();
    const until = new Date(now.getTime() + (this.config.retention.pre_expiry_warning_days * 24 * 60 * 60 * 1000));
    return this.storage.sqlite.listExpiringMemories(now.toISOString(), until.toISOString(), limit);
  }

  listArchive(limit = 50): ArchiveRecord[] {
    return this.storage.sqlite.listArchive(limit);
  }

  searchArchive(query: string, limit = 20): ArchiveRecord[] {
    return this.storage.sqlite.searchArchive(query, limit);
  }

  buildMetadataForTier(tier: RetentionTier) {
    return this.lifecycle.buildMetadata(tier, new Date());
  }

  async restoreArchive(memoryId: string): Promise<{ restored: boolean; id: string }> {
    const archived = this.storage.sqlite.getArchiveByMemoryId(memoryId);
    if (!archived) {
      return { restored: false, id: memoryId };
    }

    const now = new Date().toISOString();
    const metadata = this.lifecycle.buildMetadata(archived.tier, new Date(now));
    const memory: Omit<MemoryRecord, 'embedding'> = {
      id: archived.memory_id || uuidv4(),
      namespace: archived.namespace,
      collection: 'general',
      type: 'semantic',
      category: null,
      content: archived.summary,
      summary: archived.summary,
      tags: archived.tags,
      source: 'cli',
      checksum: archived.memory_id,
      importance: 0.5,
      retention_tier: archived.tier,
      expires_at: metadata.expires_at,
      decay_eligible: metadata.decay_eligible,
      review_due: metadata.review_due,
      access_count: 0,
      last_operation: 'ADD',
      merged_from: null,
      archived: false,
      vector_synced: true,
      created_at: now,
      updated_at: now,
      last_accessed: now,
    };
    const vector = await this.storage.embedding.embed(memory.content);
    await this.storage.writeMemory(memory, vector);
    this.storage.sqlite.deleteArchive(memoryId);
    this.storage.logAudit('ADD', memory.id, memory.namespace, 'system');
    this.storage.sqlite.flushIfDirty();
    return { restored: true, id: memory.id };
  }
}
