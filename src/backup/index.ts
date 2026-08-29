import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainConfig } from '../config/index.js';
import type { StorageManager } from '../storage/index.js';
import { atomicWriteFileSync } from '../storage/sqlite.js';
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
const BACKUP_FORMAT_VERSION = 1;

interface BackupHeader {
  version: number;
  memory_count: number;
  checksum: string;
  embedding_model?: string;
  embedding_dimensions?: number;
}

export class BackupService {
  private backupDir: string;
  private restoreInProgress = false;
  // Set once restoreVectorStateAfterActivation has already released the
  // restore lifecycle lock (or decided reconciliation needs no lock at all),
  // so the outer restore()'s finally block does not try to release it again.
  private restoreLockReleased = false;

  // Bounds for the reconciliation pass that runs *after* the lifecycle lock
  // has been released, so a slow/hanging embedding provider blocks neither
  // the restore call nor other writers.
  private static readonly BACKGROUND_RECONCILE_TIMEOUT_MS = 60_000;
  private static readonly BACKGROUND_RECONCILE_MAX_BATCHES = 500;
  private static readonly BACKGROUND_RECONCILE_MAX_RETRIES = 3;
  private static readonly BACKGROUND_RECONCILE_RETRY_DELAY_MS = 5_000;

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

    try {
      const dbData = this.storage.sqlite.exportData();
      const memoryCount = this.storage.sqlite.countMemories();
      const checksum = createHash('sha256').update(dbData).digest('hex');

      // Write backup as a simple format: JSON header + db data. This format
      // is intentionally SQLite-only (see the BACKUP_FORMAT_VERSION comment
      // above) — no vectors are included.
      const header = JSON.stringify({
        version: BACKUP_FORMAT_VERSION,
        memory_count: memoryCount,
        checksum,
        created_at: new Date().toISOString(),
        embedding_model: this.config.embedding.model,
        embedding_dimensions: this.config.embedding.dimensions,
      });

      const headerBuf = Buffer.from(header, 'utf-8');
      const headerLen = Buffer.alloc(4);
      headerLen.writeUInt32LE(headerBuf.length);

      const backup = Buffer.concat([headerLen, headerBuf, dbData]);
      atomicWriteFileSync(backupPath, backup);

      const sizeBytes = backup.length;

      this.storage.sqlite.insertBackupMeta(backupPath, sizeBytes, memoryCount, checksum);
      this.storage.sqlite.flushIfDirty();

      return {
        path: backupPath,
        size_bytes: sizeBytes,
        memory_count: memoryCount,
        created_at: new Date().toISOString(),
      };
    } catch (err) {
      throw internal(`Backup creation failed: ${(err as Error).message}`);
    }
  }

  list(): BackupInfo[] {
    const dbBackups = this.storage.sqlite.listBackups();
    return dbBackups.map(b => ({
      path: b.path,
      size_bytes: b.size_bytes,
      memory_count: b.memory_count,
      created_at: b.created_at,
    }));
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
      const headerLen = data.readUInt32LE(0);
      const headerJson = data.subarray(4, 4 + headerLen).toString('utf-8');
      const header = JSON.parse(headerJson) as BackupHeader;

      const dbData = data.subarray(4 + headerLen);
      const checksum = createHash('sha256').update(dbData).digest('hex');

      if (checksum !== header.checksum) {
        throw invalidInput('Backup integrity check failed: checksum mismatch');
      }

      // Activate the restored image through the store: this closes the live
      // native connection, clears stale WAL/SHM sidecars, atomically writes
      // `dbData` onto `brain.db`, and reopens — required on Windows, where
      // writing onto a file the store still has open natively fails (EPERM).
      // See migrate-sqlite-to-native-engine design.md "Restore must
      // close-before-overwrite".
      this.logger?.info({ event: 'backup_restore_write', path: backupPath, bytes: dbData.length });

      try {
        this.logger?.info({ event: 'backup_restore_activate_start', path: backupPath });
        await this.storage.activateSqliteImage(dbData);
      } catch (err) {
        this.logger?.error({
          event: 'backup_restore_activate_failed',
          path: backupPath,
          error: (err as Error).message,
        });
        throw internal(`Backup restore activation failed: ${(err as Error).message}`);
      }

      const activeCount = this.storage.sqlite.countMemories();

      // Memory-count cross-check (audit follow-up 2026-06-05, task 4.6): the
      // backup archive is a raw byte-for-byte export of the SQLite database
      // captured at `create()` time, so after activation the restored count
      // must exactly equal what was recorded in the header. A mismatch here
      // means the checksum check above passed but the activated data still
      // does not match what was backed up — treat that as a failed restore
      // rather than a successful one with silently wrong data.
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
      throw invalidInput('Backup restore already in progress');
    }

    try {
      this.storage.sqlite.beginLifecycleOperation('restore');
    } catch {
      throw invalidInput('Backup restore already in progress');
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
      this.storage.sqlite.endLifecycleOperation('restore');
    } finally {
      this.restoreInProgress = false;
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
        allowDuringLifecycle: true,
      });
    } catch (err) {
      this.endRestoreLifecycleLock();
      return this.toPendingVectorReconciliation(err, 'backup_restore_vector_drift_detection_pending');
    }

    // The only lock-scoped work is the drift check above (a few bounded
    // SQLite/Qdrant reads). The potentially slow, unbounded part —
    // re-embedding drifted memories — has not started yet, so the restore
    // lifecycle lock is released here instead of being held for it.
    this.endRestoreLifecycleLock();

    if (outcome.driftedCount === 0) {
      this.logger?.info({ event: 'backup_restore_vector_no_drift', mode: outcome.mode });
      return {
        status: 'healthy',
        state: 'reconciled',
        unsynced_vectors: 0,
      };
    }

    this.logger?.info({
      event: 'backup_restore_vector_drift_detected',
      mode: outcome.mode,
      drifted_count: outcome.driftedCount,
    });

    this.scheduleBackgroundReconciliation();

    return {
      status: 'degraded',
      state: 'reconciling',
      unsynced_vectors: outcome.driftedCount,
      message: outcome.mode === 'full-rebuild'
        ? 'Restore activated SQLite metadata; the embedding model or dimensions changed since this backup, so vectors are being fully rebuilt in the background.'
        : 'Restore activated SQLite metadata; vector reconciliation for the drifted subset is continuing in the background.',
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
    this.storage.setBackgroundReconciliationActive(true);
    void this.runBackgroundReconciliation(attempt);
  }

  private async runBackgroundReconciliation(attempt: number): Promise<void> {
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
    const timer = setTimeout(() => {
      this.scheduleBackgroundReconciliation(attempt + 1);
    }, BackupService.BACKGROUND_RECONCILE_RETRY_DELAY_MS);
    timer.unref?.();
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
