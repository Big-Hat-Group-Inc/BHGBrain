## 1. Storage Lifecycle Coordination

- [x] 1.1 Add explicit APIs to cancel, drain, or quarantine deferred flush state during reload.
- [x] 1.2 Add a restore/runtime lock that prevents overlapping persistence work while reload is active.

## 2. Restore Flow Hardening

- [x] 2.1 Update backup restore to use the storage lifecycle lock.
- [x] 2.2 Return explicit failure when lifecycle coordination cannot safely activate restored state.

## 3. Verification

- [x] 3.1 Add tests for restore with a pending deferred flush timer.
- [x] 3.2 Add tests for concurrent mutation attempts during restore.
