import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, createReadStream } from 'node:fs';
import { join } from 'node:path';
import type { BrainConfig } from '../config/index.js';
import type { StorageManager } from '../storage/index.js';
import { atomicWriteStreamAsync, writeChunk } from '../storage/sqlite.js';
import type { LifecycleOperationToken } from '../storage/sqlite.js';
import type { BackupInfo, RestoreResult, VectorReconciliationStatus } from '../domain/types.js';
import { BrainError, invalidInput, internal } from '../errors/index.js';
import type pino from 'pino';

// Backups are intentionally SQLite-only: the `.bhgb` file is a JSON header
// plus a raw export of the SQLite database, and deliberately contains no
// vector data. Qdrant vectors are always rebuilt from the restored SQLite
// content (reconciled against drift, see restoreVectorStateAfterActivation
// below) rather than bundled into the backup artifact. This keeps backups
// small and portable and avoids coupling the backup format to a specific
// vector store's snapshot format; see openspec/changes/
// bound-restore-reconciliation/design.md for the reasoning.
const BACKUP_FORMAT_VERSION = 2;

interface BackupHeader {
  version: number;
  memory_count: number;
  checksum: string;
  created_at?: string;
  embedding_model?: string;
  embedding_dimensions?: number;
  header_checksum?: string;
}

export interface BackupRetentionResult {
  pruned: string[];
  missingFlagged: string[];
  failed: string[];
}

function canonicalHeaderMetadata(header: Omit<BackupHeader, 'header_checksum'>): string {
  return JSON.stringify({
    version: header.version,
    memory_count: header.memory_count,
    checksum: header.checksum,
    created_at: header.created_at ?? null,
    embedding_model: header.embedding_model ?? null,
    embedding_dimensions: header.embedding_dimensions ?? null,
  });
}

function headerChecksum(header: Omit<BackupHeader, 'header_checksum'>): string {
  return createHash('sha256').update(canonicalHeaderMetadata(header)).digest('hex');
}

export class BackupService {
  private backupDir: string;
  private restoreInProgress = false;
  // Set once restoreVectorStateAfterActivation has already released the
  // restore lifecycle lock (or decided reconciliation needs no lock at all),
  // so the outer restore()'s finally block does not try to release it again.
  private restoreLockReleased = false;
  private restoreLifecycleToken: LifecycleOperationToken | null = null;
  private restoreLockPath: string | null = null;
  private restoreLockDescriptor: number | null = null;

  // Bounds for the reconciliation pass that runs *after* the lifecycle lock
  // has been released, so a slow/hanging embedding provider blocks neither
  // the restore call nor other writers.
  private static readonly BACKGROUND_RECONCILE_TIMEOUT_MS = 60_000;
  private static readonly BACKGROUND_RECONCILE_MAX_BATCHES = 500;
  private static readonly BACKGROUND_RECONCILE_MAX_RETRIES = 3;
  private static readonly BACKGROUND_RECONCILE_RETRY_DELAY_MS = 5_000;

  // Tracked lifecycle for the background-reconciliation retry timer
  // (align-runtime-entrypoint-contracts task 3.3; design.md decision 5:
  // "backup retries and other timers have stop() methods" — untracked
  // fire-and-forget retry timers were rejected). Previously this retry
  // timer was a bare, unreferenced setTimeout with no way to cancel it:
  // a pending retry could fire after `stop()` (called from process shutdown
  // ahead of `sqlite.close()`) and touch a store that is being or has
  // already been closed. `stopped` additionally short-circuits an
  // in-flight (already-fired, still-running) reconciliation pass from
  // scheduling a further retry once shutdown has begun.
  private pendingRetryTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private config: BrainConfig,
    private storage: StorageManager,
    private logger?: pino.Logger,
  ) {
    this.backupDir = join(config.data_dir!, 'backups');
  }

  async create(): Promise<BackupInfo> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${timestamp}.bhgb`;
    const backupPath = join(this.backupDir, filename);

    // Task 1.4: stream the SQLite export through hashing and disk output
    // instead of concatenating whole in-memory buffers, so backup creation's
    // peak memory stays bounded to a small, fixed number of chunks
    // regardless of database size. `exportDataToFile` writes a VACUUM'd
    // export to a temp file and hands back its path rather than reading it
    // into memory; this method owns cleaning that temp file up.
    let exportPath: string | null = null;
    try {
      const exported = this.storage.sqlite.exportDataToFile();
      exportPath = exported.path;
      const memoryCount = this.storage.sqlite.countMemories();

      // Pass 1: stream-hash the exported file (one chunk in memory at a
      // time) rather than hashing a whole-database buffer.
      const checksum = await this.streamFileChecksum(exportPath);

      // Write backup as a simple format: JSON header + db data. This format
      // is intentionally SQLite-only (see the BACKUP_FORMAT_VERSION comment
      // above) — no vectors are included. The header must come first but
      // needs the body's checksum, which is why this is a second pass over
      // the (already on-disk, not in-memory) export rather than one
      // combined read.
      const unsignedHeader: Omit<BackupHeader, 'header_checksum'> = {
        version: BACKUP_FORMAT_VERSION,
        memory_count: memoryCount,
        checksum,
        created_at: new Date().toISOString(),
        embedding_model: this.config.embedding.model,
        embedding_dimensions: this.config.embedding.dimensions,
      };
      const header = JSON.stringify({ ...unsignedHeader, header_checksum: headerChecksum(unsignedHeader) });

      const headerBuf = Buffer.from(header, 'utf-8');
      const headerLen = Buffer.alloc(4);
      headerLen.writeUInt32LE(headerBuf.length);

      // Pass 2: stream header + body straight into the durably-committed
      // artifact — never assembled as one whole-database `Buffer`.
      await atomicWriteStreamAsync(backupPath, async (dest) => {
        await writeChunk(dest, headerLen);
        await writeChunk(dest, headerBuf);
        for await (const chunk of createReadStream(exportPath!)) {
          await writeChunk(dest, chunk as Buffer);
        }
      });

      const sizeBytes = headerLen.length + headerBuf.length + exported.sizeBytes;

      this.storage.sqlite.insertBackupMeta(backupPath, sizeBytes, memoryCount, checksum);
      this.storage.sqlite.flushIfDirty();

      // Task 3.4: prune backups beyond the configured count/age bounds after
      // a successful create. Best-effort — a pruning failure never turns a
      // just-succeeded backup into a reported failure; it's logged and left
      // for the next create's pass to retry.
      try {
        this.pruneRetention();
      } catch (err) {
        this.logger?.warn?.({ event: 'backup_retention_pass_failed', error: (err as Error).message });
      }

      return {
        path: backupPath,
        size_bytes: sizeBytes,
        memory_count: memoryCount,
        created_at: new Date().toISOString(),
        missing: false,
      };
    } catch (err) {
      throw internal(`Backup creation failed: ${(err as Error).message}`);
    } finally {
      if (exportPath && existsSync(exportPath)) {
        try {
          unlinkSync(exportPath);
        } catch {
          // Best-effort cleanup of the scratch export file.
        }
      }
    }
  }

  /** Hashes `path` incrementally, one chunk at a time, never buffering the whole file. */
  private async streamFileChecksum(path: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) {
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
  }

  list(): BackupInfo[] {
    const dbBackups = this.storage.sqlite.listBackups();
    return dbBackups.map(b => ({
      path: b.path,
      size_bytes: b.size_bytes,
      memory_count: b.memory_count,
      created_at: b.created_at,
      // Coordinated metadata/file state (task 3.4): a row whose file is gone
      // is flagged rather than presented as a restorable backup.
      missing: !existsSync(b.path),
    }));
  }

  /**
   * Prunes backups beyond the configured count/age bounds, removing both the
   * file and its metadata row together. A backup at index >= `max_count`
   * (rows are newest-first) or older than `max_age_days` is pruned; either
   * bound alone is enough to mark a backup for pruning. `null` disables a
   * bound. Missing files are flagged (metadata still cleaned up so `list()`
   * stops reporting them) rather than treated as a delete failure; an actual
   * delete failure leaves that row's metadata in place so the next pass
   * retries it instead of losing track of an undeleted file. See
   * make-backup-restore-transactional task 3.4.
   */
  pruneRetention(): BackupRetentionResult {
    const maxCount = this.config.backup?.retention?.max_count ?? null;
    const maxAgeDays = this.config.backup?.retention?.max_age_days ?? null;
    if (maxCount === null && maxAgeDays === null) {
      return { pruned: [], missingFlagged: [], failed: [] };
    }

    const backups = this.storage.sqlite.listBackups(); // created_at DESC: index 0 is newest.
    const cutoffMs = maxAgeDays !== null ? Date.now() - maxAgeDays * 24 * 60 * 60 * 1000 : null;

    const toPrune = backups.filter((b, index) => {
      const overCount = maxCount !== null && index >= maxCount;
      const overAge = cutoffMs !== null && Date.parse(b.created_at) < cutoffMs;
      return overCount || overAge;
    });

    const pruned: string[] = [];
    const missingFlagged: string[] = [];
    const failed: string[] = [];

    for (const backup of toPrune) {
      if (!existsSync(backup.path)) {
        missingFlagged.push(backup.path);
        this.logger?.warn?.({ event: 'backup_retention_file_missing', path: backup.path });
        this.storage.sqlite.deleteBackupMeta(backup.path);
        continue;
      }

      try {
        unlinkSync(backup.path);
      } catch (err) {
        failed.push(backup.path);
        this.logger?.warn?.({
          event: 'backup_retention_delete_failed',
          path: backup.path,
          error: (err as Error).message,
        });
        // File delete failed: leave the metadata row in place so this
        // backup is retried (not silently dropped) on the next prune pass.
        continue;
      }

      pruned.push(backup.path);
      this.storage.sqlite.deleteBackupMeta(backup.path);
    }

    if (pruned.length > 0 || missingFlagged.length > 0 || failed.length > 0) {
      this.storage.sqlite.flushIfDirty();
      this.logger?.info({
        event: 'backup_retention_pruned',
        pruned_count: pruned.length,
        missing_flagged_count: missingFlagged.length,
        failed_count: failed.length,
      });
    }

    return { pruned, missingFlagged, failed };
  }

  async restore(backupPath: string): Promise<RestoreResult> {
    if (!existsSync(backupPath)) {
      throw invalidInput(`Backup file not found: ${backupPath}`);
    }

    let restoreGuardAcquired = false;
    try {
      this.beginRestoreOperation();
      restoreGuardAcquired = true;
      this.logger?.info({ event: 'backup_restore_validate', path: backupPath });
      const data = readFileSync(backupPath);
      if (data.length < 4) {
        throw invalidInput('Backup integrity check failed: truncated header length');
      }
      const headerLen = data.readUInt32LE(0);
      if (headerLen === 0 || headerLen > data.length - 4) {
        throw invalidInput('Backup integrity check failed: invalid header length');
      }
      const headerJson = data.subarray(4, 4 + headerLen).toString('utf-8');
      let header: BackupHeader;
      try {
        header = JSON.parse(headerJson) as BackupHeader;
      } catch {
        throw invalidInput('Backup integrity check failed: invalid JSON header');
      }

      if (header.version !== 1 && header.version !== BACKUP_FORMAT_VERSION) {
        throw invalidInput(`Unsupported backup format version: ${header.version}`);
      }
      if (!Number.isSafeInteger(header.memory_count) || header.memory_count < 0 || typeof header.checksum !== 'string') {
        throw invalidInput('Backup integrity check failed: invalid header metadata');
      }
      if (header.version === BACKUP_FORMAT_VERSION) {
        const { header_checksum, ...unsignedHeader } = header;
        if (typeof header_checksum !== 'string' || headerChecksum(unsignedHeader) !== header_checksum) {
          throw invalidInput('Backup integrity check failed: header metadata checksum mismatch');
        }
      }

      const dbData = data.subarray(4 + headerLen);
      const checksum = createHash('sha256').update(dbData).digest('hex');

      if (checksum !== header.checksum) {
        throw invalidInput('Backup integrity check failed: checksum mismatch');
      }

      // Activate the restored image through the store: this validates the
      // candidate in a scratch copy (integrity, schema, record count against
      // the header's `memory_count`), checkpoints and closes the live
      // connection, renames the live image *aside* (not overwriting it) so
      // it can be recovered, renames the validated candidate into place, and
      // reopens — rolling back to the preserved pre-restore image if any
      // step fails. Required close-before-write on Windows, where writing
      // onto a file the store still has open natively fails (EPERM). See
      // migrate-sqlite-to-native-engine design.md "Restore must
      // close-before-overwrite" and make-backup-restore-transactional tasks
      // 2.1/2.3.
      this.logger?.info({ event: 'backup_restore_write', path: backupPath, bytes: dbData.length });

      try {
        this.logger?.info({ event: 'backup_restore_activate_start', path: backupPath });
        await this.storage.activateSqliteImage(dbData, { expectedMemoryCount: header.memory_count });
      } catch (err) {
        // `activateSqliteImage` itself rolled back to the pre-restore image
        // on any failure from checkpoint onward (task 2.3); its message says
        // so ("prior database restored") when that happened, versus a
        // pre-activation validation failure (scratch integrity/schema/count
        // check) that never touched the live database at all. Both are
        // surfaced here rather than collapsed into one generic message, so
        // logs and the thrown error name the real cause.
        const message = (err as Error).message;
        const rolledBack = /prior database restored/.test(message);
        this.logger?.error({
          event: 'backup_restore_activate_failed',
          path: backupPath,
          error: message,
          rolled_back: rolledBack,
        });
        throw internal(
          rolledBack
            ? `Backup restore activation failed; the prior database was restored and is active: ${message}`
            : `Backup restore activation failed before any change to the active database: ${message}`,
        );
      }

      const activeCount = this.storage.sqlite.countMemories();

      // Defense-in-depth: `activateSqliteImage` above already validates and
      // rolls back on a count mismatch inside the real storage layer (task
      // 2.1/2.3), but this check stays here too so a mocked or bypassed
      // storage layer (or a future write path that skips activation's own
      // check) still cannot report a successful restore with silently wrong
      // data — the backup archive is a byte-for-byte export of the SQLite
      // database captured at `create()` time, so after activation the
      // restored count must exactly equal what was recorded in the header.
      if (activeCount !== header.memory_count) {
        this.logger?.error({
          event: 'backup_restore_count_mismatch',
          path: backupPath,
          expected_memory_count: header.memory_count,
          actual_memory_count: activeCount,
        });
        throw internal(
          `Backup restore integrity check failed: expected ${header.memory_count} memories after ` +
          `activation but found ${activeCount}`,
        );
      }

      const vectorReconciliation = await this.restoreVectorStateAfterActivation(activeCount, header);
      this.logger?.info({
        event: 'backup_restore_complete',
        path: backupPath,
        metadata_activated: true,
        memory_count: activeCount,
        vector_reconciliation_state: vectorReconciliation.state,
        unsynced_vectors: vectorReconciliation.unsynced_vectors,
      });

      return {
        memory_count: activeCount,
        metadata_activated: true,
        vector_reconciliation: vectorReconciliation,
      };
    } catch (err) {
      if (err instanceof BrainError) throw err;
      throw internal(`Backup restore failed: ${(err as Error).message}`);
    } finally {
      if (restoreGuardAcquired) {
        this.endRestoreLifecycleLock();
      }
    }
  }

  private beginRestoreOperation(): void {
    if (this.restoreInProgress) {
      throw new BrainError('CONFLICT', 'Backup restore already in progress', true);
    }

    try {
      this.acquireRestoreDirectoryLock();
      this.restoreLifecycleToken = this.storage.sqlite.beginLifecycleOperation('restore');
    } catch (err) {
      this.releaseRestoreDirectoryLock();
      if (err instanceof BrainError) throw err;
      throw new BrainError('CONFLICT', `Backup restore already in progress: ${(err as Error).message}`, true);
    }

    this.restoreInProgress = true;
    this.restoreLockReleased = false;
  }

  // Idempotent: safe to call once after drift detection completes (to free
  // the lock before the potentially slow re-embed) and again from the outer
  // restore() `finally` (covers every path that returns before reaching that
  // point, e.g. activation failure or drift-detection failure).
  private endRestoreLifecycleLock(): void {
    if (this.restoreLockReleased) return;
    this.restoreLockReleased = true;
    try {
      this.storage.sqlite.endLifecycleOperation(this.restoreLifecycleToken!, 'restore');
      this.restoreLifecycleToken = null;
    } finally {
      this.restoreInProgress = false;
      this.releaseRestoreDirectoryLock();
    }
  }

  private acquireRestoreDirectoryLock(): void {
    const lockPath = join(this.config.data_dir!, '.restore.lock');
    try {
      this.restoreLockDescriptor = openSync(lockPath, 'wx', 0o600);
      this.restoreLockPath = lockPath;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        throw new BrainError('CONFLICT', 'Backup restore is already active for this data directory', true);
      }
      throw err;
    }
  }

  private releaseRestoreDirectoryLock(): void {
    const descriptor = this.restoreLockDescriptor;
    const path = this.restoreLockPath;
    this.restoreLockDescriptor = null;
    this.restoreLockPath = null;
    if (descriptor !== null) {
      try {
        closeSync(descriptor);
      } finally {
        if (path && existsSync(path)) unlinkSync(path);
      }
    }
  }

  private async restoreVectorStateAfterActivation(
    memoryCount: number,
    header: BackupHeader,
  ): Promise<VectorReconciliationStatus> {
    if (memoryCount === 0) {
      return {
        status: 'healthy',
        state: 'reconciled',
        unsynced_vectors: 0,
      };
    }

    let outcome: Awaited<ReturnType<StorageManager['detectAndMarkVectorDrift']>>;
    try {
      outcome = await this.storage.detectAndMarkVectorDrift({
        // Legacy backups written before this field existed have no recorded
        // embedding model/dimensions; treat that as "unchanged" rather than
        // forcing every such restore into a full rebuild — checksum-based
        // drift detection still runs and self-heals any real mismatch.
        expectedEmbeddingModel: header.embedding_model ?? this.config.embedding.model,
        expectedEmbeddingDimensions: header.embedding_dimensions ?? this.config.embedding.dimensions,
        lifecycleToken: this.restoreLifecycleToken!,
        // Scopes vector-only surplus pruning to this device's own points (or
        // legacy ones predating device stamping) so another device's
        // legitimate cross-device-fallback points are never touched — see
        // StorageManager.computeVectorReconciliationDiff.
        deviceId: this.config.device?.id ?? null,
      });
    } catch (err) {
      this.endRestoreLifecycleLock();
      return this.toPendingVectorReconciliation(err, 'backup_restore_vector_drift_detection_pending');
    }

    // The only lock-scoped work is the drift check above (a few bounded
    // SQLite/Qdrant reads, plus bounded surplus deletion). The potentially
    // slow, unbounded part — re-embedding drifted memories — has not started
    // yet, so the restore lifecycle lock is released here instead of being
    // held for it.
    this.endRestoreLifecycleLock();

    // Defensive against outcome objects that predate these fields (older
    // test doubles, or a future caller that omits them) — treated as "no
    // surplus work", never as a spurious degraded state.
    const surplusPruned = outcome.surplusPruned ?? 0;
    const surplusRemaining = outcome.surplusRemaining ?? 0;

    if (surplusPruned > 0 || surplusRemaining > 0) {
      this.logger?.info({
        event: 'backup_restore_vector_surplus_pruned',
        surplus_pruned: surplusPruned,
        surplus_remaining: surplusRemaining,
      });
    }

    // Task 3.2: vector-only surplus (points with no row in the restored
    // SQLite image) must be removed — or explicitly reported as unresolved,
    // retryable orphan work — before reconciliation is reported healthy.
    // Otherwise an orphaned point with no expiry can surface forever via
    // the cross-device Qdrant-payload search fallback even though the
    // restored source of truth (SQLite) has no record of it.
    if (outcome.driftedCount === 0 && surplusRemaining === 0) {
      this.logger?.info({ event: 'backup_restore_vector_no_drift', mode: outcome.mode });
      return {
        status: 'healthy',
        state: 'reconciled',
        unsynced_vectors: 0,
      };
    }

    if (outcome.driftedCount > 0) {
      this.logger?.info({
        event: 'backup_restore_vector_drift_detected',
        mode: outcome.mode,
        drifted_count: outcome.driftedCount,
      });
      this.scheduleBackgroundReconciliation();
    }

    // Task 3.3: `mode` names three genuinely different causes, and the
    // message shown to callers/health must not collapse them into one —
    // in particular, a transient Qdrant read outage ('inspection-failed')
    // must never be reported as "the embedding model changed"
    // ('full-rebuild'), since that misdirects an operator toward a
    // non-existent model migration instead of a retry.
    const driftMessage = outcome.driftedCount === 0
      ? null
      : outcome.mode === 'full-rebuild'
        ? 'the embedding model or dimensions changed since this backup, so vectors are being fully rebuilt in the background'
        : outcome.mode === 'inspection-failed'
          ? 'the vector store could not be inspected for drift (a transient failure, not a model change), so reconciliation is conservatively re-embedding the corpus in the background'
          : 'vector reconciliation for the drifted subset is continuing in the background';
    const orphanMessage = surplusRemaining > 0
      ? `${surplusRemaining} vector-only orphan point(s) from a previous state could not be pruned and remain retryable work`
      : null;

    return {
      status: 'degraded',
      state: 'reconciling',
      unsynced_vectors: outcome.driftedCount,
      message: `Restore activated SQLite metadata; ${[driftMessage, orphanMessage].filter(Boolean).join('; ')}.`,
    };
  }

  // Bounded background reconciliation: released from the restore lifecycle
  // lock, this runs `reconcileVectorsFromSqlite` under its own timeout/batch
  // cap and, if unsynced memories remain (bound reached, or a transient
  // Qdrant/embedding failure), automatically retries with a short backoff up
  // to BACKGROUND_RECONCILE_MAX_RETRIES. It never holds the restore lock,
  // is safe to interleave with other writers, and always resumes from
  // whatever `listMemoriesNeedingVectorSync` currently reports — so it is
  // resumable even across a process restart (the next reconcile trigger,
  // whether another restore or an explicit repair, simply picks up the
  // remaining unsynced set).
  private scheduleBackgroundReconciliation(attempt = 1): void {
    if (this.stopped) return;
    this.storage.setBackgroundReconciliationActive(true);
    void this.runBackgroundReconciliation(attempt);
  }

  private async runBackgroundReconciliation(attempt: number): Promise<void> {
    if (this.stopped) return;
    try {
      const result = await this.storage.reconcileVectorsFromSqlite({
        batchSize: 100,
        timeoutMs: BackupService.BACKGROUND_RECONCILE_TIMEOUT_MS,
        maxBatches: BackupService.BACKGROUND_RECONCILE_MAX_BATCHES,
      });
      this.logger?.info({
        event: 'backup_restore_background_reconcile',
        reconciled: result.reconciled,
        remaining: result.remaining,
        bound_reached: result.boundReached,
        attempt,
      });
      if (result.remaining > 0) {
        this.retryOrGiveUp(attempt);
      } else {
        this.storage.setBackgroundReconciliationActive(false);
      }
    } catch (err) {
      this.logger?.warn?.({
        event: 'backup_restore_background_reconcile_failed',
        error: (err as Error).message,
        attempt,
      });
      this.retryOrGiveUp(attempt);
    }
  }

  private retryOrGiveUp(attempt: number): void {
    if (attempt >= BackupService.BACKGROUND_RECONCILE_MAX_RETRIES) {
      this.logger?.warn?.({
        event: 'backup_restore_background_reconcile_retries_exhausted',
        attempts: attempt,
        unsynced_vectors: this.storage.sqlite.countUnsyncedVectors(),
      });
      // Auto-retry is exhausted, but search is not left blank with no
      // recovery path: health reports a degraded "pending" vector
      // reconciliation state (see HealthService.checkVectorReconciliation)
      // for as long as unsynced vectors remain, and any later restore or
      // reconciliation trigger resumes from the same unsynced set.
      this.storage.setBackgroundReconciliationActive(false);
      return;
    }
    if (this.stopped) return;
    this.pendingRetryTimer = setTimeout(() => {
      this.pendingRetryTimer = null;
      this.scheduleBackgroundReconciliation(attempt + 1);
    }, BackupService.BACKGROUND_RECONCILE_RETRY_DELAY_MS);
    this.pendingRetryTimer.unref?.();
  }

  /**
   * Cancels any pending background-reconciliation retry timer and prevents
   * further retries from being scheduled. Idempotent. Callers (process
   * shutdown — see src/index.ts's createShutdown) MUST call this before
   * `sqlite.close()` so a retry can never fire against a closed store.
   */
  stop(): void {
    this.stopped = true;
    if (this.pendingRetryTimer) {
      clearTimeout(this.pendingRetryTimer);
      this.pendingRetryTimer = null;
    }
  }

  private toPendingVectorReconciliation(
    err: unknown,
    event: string,
  ): VectorReconciliationStatus {
    const message = err instanceof Error
      ? err.message
      : 'Restore activated SQLite metadata, but vector reconciliation is still pending.';
    this.logger?.warn?.({
      event,
      error: message,
    });
    return {
      status: 'degraded',
      state: 'pending',
      unsynced_vectors: this.storage.sqlite.countUnsyncedVectors(),
      message,
    };
  }
}
