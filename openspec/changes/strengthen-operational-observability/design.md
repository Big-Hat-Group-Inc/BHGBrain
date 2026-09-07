## Context

Metrics are in-memory maps with arbitrary label values, detailed errors are mostly flattened to strings, request identity is not propagated, and several documented health thresholds or drift directions are absent. See `proposal.md` and `specs/operational-signal-fidelity/spec.md`.

## Goals / Non-Goals

**Goals:**
- Make logs and health sufficient to identify a failing request and root cause.
- Bound telemetry memory and expose meaningful cumulative measurements.
- Make documented capacity and background failure states observable.

**Non-Goals:**
- Replacing Pino or adding a hosted telemetry dependency.
- Attaching namespace or memory content to metrics.

## Decisions

1. Create one request-scoped logger context.
- HTTP assigns a random request ID; MCP uses session ID plus a per-call ID; trusted client identity is passed into `buildMcpServer` and child loggers.
- Timestamp-only correlation was rejected because concurrent default-namespace calls are indistinguishable.

2. Register metric descriptors with allowed labels and a global series cap.
- Tool names come from the declared dispatch set, status is an enum, namespace is removed from provider-wide metrics, and overflow increments a fixed dropped-series counter.
- Unbounded dynamic maps were rejected as an attacker-controlled heap.

3. Separate cumulative counters from rolling histograms.
- Tool completions increment `{tool,status}` counters; rolling sample occupancy is a gauge and every histogram also exposes total observations.
- Naming rolling occupancy `_count` was rejected because monitoring systems interpret it as monotonic.

4. Standardize errors under `err` with serializers and base fields.
- Logs include service/version and child context; CLI destinations use stderr. Redaction paths match emitted fields and token previews become hash prefixes.
- Message-only exception fields and inert redaction rules were rejected.

5. Compose health from explicit component snapshots.
- Capacity uses configured byte/count warning thresholds; scheduler and restore causes retain states; vector health compares authoritative row counts with managed point counts in both directions on a cached cadence.
- Inferring drift solely from SQLite flags was rejected because vector-only or stale-payload cases are invisible.

6. Emit state transitions, not repeated constant warnings.
- Process-lifetime configuration conditions log once; recurring failures log at warn/error with stable cause/retryability fields and rate-limited repetition.
- Per-request `auth_skip` warnings were rejected as signal-destroying noise.

## Risks / Trade-offs

- [Count comparison can be expensive] -> Cache it, use count APIs when available, and report staleness timestamp.
- [Renamed log/metric fields affect dashboards] -> Emit temporary compatibility aliases for one release and document replacements.
- [Metrics enabled by default add small overhead] -> Bound all registries and keep collection work constant per observation.

## Migration Plan

1. Add logger base/serializer/context and compatibility fields.
2. Add metric descriptors, caps, corrected counters, and explicit endpoint behavior.
3. Thread request and trusted client identity through transport/tool/storage layers.
4. Add capacity, scheduler, restore, and bidirectional drift health components.
5. Remove compatibility aliases after a documented deprecation window.
