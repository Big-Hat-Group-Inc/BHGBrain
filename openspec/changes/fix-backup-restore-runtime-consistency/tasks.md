## 1. Restore Lifecycle Refactor

- [x] 1.1 Add a storage-level reload mechanism to re-open `SqliteStore` from disk safely.
- [x] 1.2 Update `BackupService.restore` to invoke reload after checksum-validated write.
- [x] 1.3 Ensure restore execution is serialized to prevent concurrent mutation conflicts.

## 2. API Contract and Error Handling

- [x] 2.1 Extend restore result payload with activation outcome metadata.
- [x] 2.2 Return explicit failure when runtime activation fails after file restore.
- [x] 2.3 Add structured logs for restore phases (validate, write, activate, complete/fail).

## 3. Verification

- [x] 3.1 Add tests that validate restored data is immediately visible after successful restore.
- [x] 3.2 Add tests for activation failure paths to prevent false-success responses.
- [x] 3.3 Update backup/restore documentation with runtime activation behavior.
