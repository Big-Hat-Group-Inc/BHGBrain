import { v4 as uuidv4 } from 'uuid';
import type { BrainConfig } from '../config/index.js';
import { computeChecksum } from './normalize.js';
import { MemoryLifecycleService } from './lifecycle.js';
import type { ArchiveRecord, MemoryRecord, MemorySource } from './types.js';

export interface RestoreArchiveOptions {
  source?: MemorySource;
  deviceId?: string | null;
  now?: Date;
}

/**
 * The single mapping from an archive row back to a live `MemoryRecord`,
 * shared by every archive-restore entrypoint (the CLI's `archive restore`
 * command via `RetentionService.restoreArchive`, and the `review` MCP
 * tool's `restore` action) so checksum, expiry/review, and provenance
 * fields cannot drift between them. See
 * openspec/changes/make-backup-restore-transactional (task 2.4) — an
 * earlier CLI-only implementation derived `checksum` from `archived.memory_id`
 * (an unrelated identifier) instead of the restored content.
 */
export function buildRestoredMemoryFromArchive(
  config: BrainConfig,
  archived: ArchiveRecord,
  options: RestoreArchiveOptions = {},
): Omit<MemoryRecord, 'embedding'> {
  const lifecycle = new MemoryLifecycleService(config);
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();
  const metadata = lifecycle.buildMetadata(archived.tier, now);
  // Archive rows keep no content/vector, only the retained summary — tag the
  // restored record so it's identifiable as a restore rather than implying
  // the original memory content survived intact.
  const content = archived.summary;
  const tags = [...new Set([...archived.tags, 'restored-from-archive'])];

  return {
    id: uuidv4(),
    namespace: archived.namespace,
    collection: 'general',
    type: 'semantic',
    category: null,
    content,
    summary: archived.summary,
    tags,
    source: options.source ?? 'cli',
    checksum: computeChecksum(content),
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
    // Archive rows carry no pin state, so a restore never resurrects a
    // memory as pinned.
    pinned: false,
    device_id: options.deviceId ?? null,
    // Archive rows carry no origin/confidence either — a restore has no
    // provenance to recover, matching the "legacy row" default (origin:
    // null, confidence: 1.0). See add-memory-provenance-metadata.
    origin: null,
    confidence: 1.0,
    created_at: nowIso,
    updated_at: nowIso,
    last_accessed: nowIso,
  };
}
