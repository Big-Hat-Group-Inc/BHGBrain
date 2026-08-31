## ADDED Requirements

### Requirement: MetricsCollector counter, gauge, and disabled behaviors are covered
The metrics test suite SHALL assert the enumerated `MetricsCollector` behaviors so the
`incCounter`, `setGauge`, and disabled-collector branches are exercised rather than
shipping uncovered. Specifically: counter accumulation across calls, counter increment
by a custom amount, gauge overwrite, and a disabled collector ignoring all record calls.

#### Scenario: Counter accumulates across calls
- **WHEN** `incCounter('c')` is called twice (or once plus a custom amount)
- **THEN** `getMetrics()` reports the entry `{ name: 'c', type: 'counter', value: <sum> }`

#### Scenario: Gauge overwrites the previous value
- **WHEN** `setGauge('g', 1)` is followed by `setGauge('g', 2)`
- **THEN** `getMetrics()` reports the gauge with the latest value `2`

#### Scenario: Disabled collector emits nothing
- **WHEN** a `MetricsCollector` constructed with `metrics_enabled: false` receives counter,
  gauge, and histogram record calls
- **THEN** `getMetrics()` returns `[]`

### Requirement: getMetrics output shape includes the type field
The metrics test suite SHALL assert the `type` field on `getMetrics()` entries, not only
`name` and `value`, so that counter-vs-histogram-vs-gauge tagging is verified.

#### Scenario: Entries carry the expected type tag
- **WHEN** `getMetrics()` returns counter, histogram, and gauge entries
- **THEN** each entry's `type` is asserted (counter, histogram, and gauge respectively)
