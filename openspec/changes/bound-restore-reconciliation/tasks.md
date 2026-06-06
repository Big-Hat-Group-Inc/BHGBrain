## 1. Drift-only reconciliation

- [ ] 1.1 Replace the unconditional "mark all unsynced + clear all managed vectors + re-embed everything" in `restoreVectorStateAfterActivation` (`src/backup/index.ts:163-177`) with a path that reconciles only actual drift.
- [ ] 1.2 Compare restored SQLite rows against existing Qdrant points (e.g. by content/payload hash or sync marker) and skip re-embedding memories whose vectors already match, so a no-drift restore performs no embedding work.
- [ ] 1.3 Add a fallback to full rebuild only when drift cannot be determined (e.g. embedding model/dimensions changed or Qdrant state is missing/incompatible).

## 2. Bounded, non-blocking reconciliation

- [ ] 2.1 Add an overall timeout and an iteration/cap bound to `reconcileVectorsFromSqlite` (`src/storage/index.ts:204-258`) so a slow or hanging embedding provider cannot loop indefinitely.
- [ ] 2.2 Stop holding the restore lifecycle lock for the full re-embed: return `reconciling`/`pending` once SQLite activation completes and run remaining reconciliation in a bounded background task.
- [ ] 2.3 Ensure background/bounded reconciliation is resumable from the remaining unsynced set and that health transitions `reconciling → reconciled` when complete.

## 3. Preserve search availability

- [ ] 3.1 Avoid destroying existing managed vectors before a successful rebuild (`src/backup/index.ts:171`) — rebuild-then-swap into fresh collections, or defer the destructive clear until embeddings are confirmed available.
- [ ] 3.2 Provide an auto-retry path or a degraded health signal so a failed reconciliation does not leave semantic search blank with no recovery.

## 4. Durable, resumable progress

- [ ] 4.1 Make reconciliation sync-mark durability bounded at batch granularity so a hard crash mid-batch loses at most one batch of progress (`src/storage/index.ts:223-248`).
- [ ] 4.2 Document and rely on idempotent re-upsert for any progress lost to a hard crash, so restart safely resumes from the remaining unsynced set without duplicating data.

## 5. Documentation

- [ ] 5.1 Document in-code (backup header/comment) that backups are intentionally SQLite-only and vectors are rebuilt from SQLite on restore.

## 6. Validation

- [ ] 6.1 Run `npm run lint`, `npm test`, and `npm run build`.
