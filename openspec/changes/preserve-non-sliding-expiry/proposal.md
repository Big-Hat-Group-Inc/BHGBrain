## Why

When sliding-window expiry is disabled, read-path access updates currently appear to clear `expires_at` instead of preserving the existing deadline. That turns a configuration intended to disable expiry extension into behavior that can accidentally make time-bounded memories non-expiring.

## What Changes

- Define non-sliding expiry behavior so access tracking can update counters and timestamps without removing existing expiry values.
- Separate “do not change expiry” from “explicitly clear expiry” in lifecycle and storage update contracts.
- Add regression tests for search/read paths when `sliding_window_enabled` is `false`.

## Capabilities

### New Capabilities
- `non-sliding-expiry-preservation`: preserves existing expiry metadata during access updates when sliding-window extension is disabled.

### Modified Capabilities

## Impact

- Affected code: `src/domain/lifecycle.ts`, `src/search/index.ts`, `src/storage/sqlite.ts`, and lifecycle/search tests.
- Data behavior: prevents read access from silently removing TTLs under a non-sliding retention policy.
- Reliability: makes retention configuration semantics safe and predictable for operators.
