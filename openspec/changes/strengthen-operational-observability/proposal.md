## Why

Many important failure signals are disabled, mislabeled, unbounded, or impossible to correlate across a request. Operators can receive green or silent telemetry during cleanup, vector, credential, capacity, and breaker failures.

## What Changes

- Propagate request, session, and trusted client identifiers through tool and storage logs using child loggers.
- Bound metric-series cardinality, validate label values, add monotonic per-tool success/error counters, and expose registry saturation.
- Make metrics discoverable by default or return an explicit disabled response rather than an unexplained 404.
- Add structured error serialization, service/version base fields, stderr CLI logging, consistent exception keys, and effective redaction.
- Report distinct vector-drift causes, both drift directions, database capacity thresholds, scheduler state, and Qdrant health failures truthfully.
- Correct log levels and remove per-request warning noise for process-lifetime conditions.

## Capabilities

### New Capabilities
- `operational-signal-fidelity`: Defines bounded metrics, correlated structured logs, effective redaction, actionable health states, and stable failure classifications.

### Modified Capabilities

## Impact

- Affected code: `src/health/`, `src/tools/index.ts`, `src/transport/`, `src/storage/`, `src/backup/`, `src/cli/`, configuration, README, and observability tests.
- Audit coverage: F53-F59, F63, F64, F83, and F90-F93.
- Operations: existing metrics/log consumers may need to adopt the normalized labels and error fields.
