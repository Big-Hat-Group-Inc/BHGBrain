## Why

Restore now distinguishes SQLite activation from vector readiness, but it still has post-activation failure paths that can return overall restore failure after restored metadata is already live. It also leaves reconciliation progress less durable than it should be when vector rebuild work fails partway through.

## What Changes

- Harden restore so once SQLite activation succeeds, subsequent vector invalidation or reconciliation failures are reported as explicit degraded readiness instead of negating restore activation.
- Make post-restore reconciliation progress durable so successful vector rebuild work is preserved even if a later upsert in the same run fails.
- Tighten restore lifecycle handling so restore serialization state is always cleaned up safely, including lock-acquisition and early-failure paths.
- Add regression coverage for post-activation vector-clear failures, partial reconciliation progress, and restore lock cleanup behavior.

## Capabilities

### New Capabilities

### Modified Capabilities
- `dual-store-backup-restore-consistency`: restore must preserve explicit activated-but-degraded semantics and durable reconciliation progress when vector recovery work fails after SQLite activation.
- `backup-restore-runtime-activation`: restore activation semantics are tightened so activation success is not masked by later post-activation failures and restore serialization remains fail-safe.

## Impact

- Affected code: `src/backup/index.ts`, `src/storage/index.ts`, `src/storage/qdrant.ts`, `src/storage/sqlite.ts`, and restore-related tests.
- API behavior: restore responses become stricter about activated-versus-degraded outcomes after SQLite is live.
- Reliability: reduces sticky restore lock failures and prevents successful reconciliation work from being lost on partial post-restore failures.
