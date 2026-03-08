import type { BrainConfig } from '../config/index.js';
import type { StorageManager } from '../storage/index.js';

export class RetentionService {
  constructor(
    private config: BrainConfig,
    private storage: StorageManager,
  ) {}

  markStaleMemories(): number {
    const decayDays = this.config.retention.decay_after_days;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - decayDays);
    const cutoffIso = cutoff.toISOString();

    const staleIds = this.storage.sqlite.listStaleCandidateIds(cutoffIso);
    let count = 0;
    for (const id of staleIds) {
      this.storage.sqlite.markStale(id);
      count++;
    }
    this.storage.sqlite.flushIfDirty();

    return count;
  }

  getConsolidationCandidates(): {
    staleLowImportance: Array<{ id: string; importance: number }>;
  } {
    const candidates = this.storage.sqlite.getStaleMemories(0.5, 100);
    return {
      staleLowImportance: candidates.map(m => ({ id: m.id, importance: m.importance })),
    };
  }

  runConsolidation(): {
    staleMarked: number;
    lowImportanceCandidates: number;
  } {
    const staleMarked = this.markStaleMemories();
    const candidates = this.getConsolidationCandidates();

    return {
      staleMarked,
      lowImportanceCandidates: candidates.staleLowImportance.length,
    };
  }
}
