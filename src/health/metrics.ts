import type { BrainConfig } from '../config/index.js';

export interface MetricEntry {
  name: string;
  type: 'counter' | 'histogram' | 'gauge';
  value: number;
  labels?: Record<string, string>;
}

export function computePercentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }

  const rank = Math.ceil((p / 100) * sortedValues.length);
  const index = Math.min(sortedValues.length - 1, Math.max(0, rank - 1));
  return sortedValues[index] ?? 0;
}

/** Bounded circular buffer for histogram values */
class BoundedBuffer {
  private buffer: number[];
  private index = 0;
  private full = false;
  private readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
  }

  push(value: number): void {
    this.buffer[this.index] = value;
    this.index = (this.index + 1) % this.capacity;
    if (this.index === 0) this.full = true;
  }

  values(): number[] {
    if (this.full) return [...this.buffer];
    return this.buffer.slice(0, this.index);
  }

  get length(): number {
    return this.full ? this.capacity : this.index;
  }
}

/**
 * A histogram is bucketed not just by metric name but by its label set, so
 * e.g. `bhgbrain_tool_handler_ms{tool="recall"}` and
 * `bhgbrain_tool_handler_ms{tool="remember"}` accumulate in independent
 * bounded buffers and are attributable to a specific tool in `getMetrics()`.
 */
interface HistogramFamily {
  name: string;
  labels?: Record<string, string>;
  buffer: BoundedBuffer;
  // strengthen-operational-observability task 2.3: the buffer above only
  // ever holds the most recent `HISTOGRAM_CAPACITY` samples, so its own
  // `.length` cannot answer "how many observations has this family EVER
  // recorded" once more than that many calls have been made — an operator
  // computing an error rate as (error observations / total observations)
  // needs a true monotonic denominator that keeps growing after the buffer
  // has wrapped, not one that resets to the window size. Tracked
  // independently of the buffer so it is never affected by eviction.
  totalObservations: number;
}

/** Stable composite key so identical label sets (regardless of key order) share a buffer. */
function histogramKey(name: string, labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const sorted = Object.keys(labels).sort().map(k => `${k}=${labels[k]}`).join(',');
  return `${name}{${sorted}}`;
}

/**
 * A counter is bucketed by metric name and label set, the same way histograms are
 * (see `HistogramFamily`), so e.g. `search_embedding_degraded{namespace="team-a"}`
 * and `search_embedding_degraded{namespace="team-b"}` accumulate independently.
 */
interface CounterEntry {
  name: string;
  labels?: Record<string, string>;
  value: number;
}

// strengthen-operational-observability task 2.1: the whole point of a
// registry cap is that it is a genuinely fixed ceiling — callers cannot
// raise it via configuration, since a value read from config could itself
// be pushed arbitrarily high by whatever already controls the attacker-
// influenced label values (tool/namespace/etc.) this cap defends against.
const MAX_TOTAL_SERIES = 2000;

// A label value is truncated (not rejected outright) at this length so one
// pathologically long value can never itself become an unbounded-memory
// attack independent of the series cap above.
const MAX_LABEL_VALUE_LENGTH = 128;

const DROPPED_SERIES_METRIC = 'bhgbrain_metrics_dropped_series_total';
const REGISTRY_SIZE_METRIC = 'bhgbrain_metrics_registry_size';

function sanitizeLabels(labels?: Record<string, string>): Record<string, string> | undefined {
  if (!labels) return undefined;
  const entries = Object.entries(labels).map(([k, v]) => {
    const value = typeof v === 'string' ? v : String(v);
    return [k, value.length > MAX_LABEL_VALUE_LENGTH ? value.slice(0, MAX_LABEL_VALUE_LENGTH) : value] as const;
  });
  return Object.fromEntries(entries);
}

export class MetricsCollector {
  private enabled: boolean;
  private counters = new Map<string, CounterEntry>();
  private histograms = new Map<string, HistogramFamily>();
  private gauges = new Map<string, number>();
  // strengthen-operational-observability task 2.2: counted independently of
  // `counters`/`histograms` (never itself subject to the cap it reports on)
  // so saturation stays visible via `getMetrics()` even once the registry
  // is completely full and refusing every new series.
  private droppedSeries = 0;
  private static readonly HISTOGRAM_CAPACITY = 1000;

  constructor(config: BrainConfig) {
    this.enabled = config.observability.metrics_enabled;
  }

  /** Total distinct series currently held (counters + histogram families). */
  private seriesCount(): number {
    return this.counters.size + this.histograms.size;
  }

  /**
   * Returns true when `key` may allocate a new series in `existing` — either
   * because it already exists (incrementing/observing an existing series
   * never counts against the cap) or because the registry has room for one
   * more. A rejected allocation increments `droppedSeries` so operators can
   * see saturation (task 2.1/2.2's "unknown tool/namespace inputs cannot
   * grow the registry ... registry remains within its configured cap").
   */
  private admit(key: string, existing: Map<string, unknown>): boolean {
    if (existing.has(key)) return true;
    if (this.seriesCount() >= MAX_TOTAL_SERIES) {
      this.droppedSeries += 1;
      return false;
    }
    return true;
  }

  incCounter(name: string, amount = 1, labels?: Record<string, string>): void {
    if (!this.enabled) return;
    const cleanLabels = sanitizeLabels(labels);
    const key = histogramKey(name, cleanLabels);
    if (!this.admit(key, this.counters)) return;
    const current = this.counters.get(key);
    if (current) {
      current.value += amount;
    } else {
      this.counters.set(key, { name, labels: cleanLabels, value: amount });
    }
  }

  recordHistogram(name: string, value: number, labels?: Record<string, string>): void {
    if (!this.enabled) return;
    const cleanLabels = sanitizeLabels(labels);
    const key = histogramKey(name, cleanLabels);
    if (!this.admit(key, this.histograms)) return;
    let family = this.histograms.get(key);
    if (!family) {
      family = { name, labels: cleanLabels, buffer: new BoundedBuffer(MetricsCollector.HISTOGRAM_CAPACITY), totalObservations: 0 };
      this.histograms.set(key, family);
    }
    family.buffer.push(value);
    family.totalObservations += 1;
  }

  setGauge(name: string, value: number): void {
    if (!this.enabled) return;
    this.gauges.set(name, value);
  }

  getMetrics(): MetricEntry[] {
    if (!this.enabled) return [];
    const entries: MetricEntry[] = [];

    for (const { name, labels, value } of this.counters.values()) {
      entries.push({ name, type: 'counter', value, labels });
    }
    for (const family of this.histograms.values()) {
      const { name, labels } = family;
      const vals = family.buffer.values();
      const count = vals.length;
      const sum = count > 0 ? vals.reduce((a, b) => a + b, 0) : 0;
      const avg = count > 0 ? sum / count : 0;
      const sortedValues = [...vals].sort((a, b) => a - b);
      entries.push({ name: `${name}_avg`, type: 'histogram', value: avg, labels });
      entries.push({ name: `${name}_p50`, type: 'histogram', value: computePercentile(sortedValues, 50), labels });
      entries.push({ name: `${name}_p95`, type: 'histogram', value: computePercentile(sortedValues, 95), labels });
      entries.push({ name: `${name}_p99`, type: 'histogram', value: computePercentile(sortedValues, 99), labels });
      // strengthen-operational-observability task 2.3 / design.md decision
      // 3: the rolling window's current occupancy is NOT a cumulative
      // count — it goes back down implicitly (stays at capacity) as old
      // samples are evicted, so a monitoring system reading it as monotonic
      // (as the prior `_count`-suffixed, 'counter'-typed field invited)
      // would derive a nonsensical rate. Tagged 'gauge' and suffixed
      // `_sample_count` instead of `_count` to make that explicit.
      entries.push({ name: `${name}_sample_count`, type: 'gauge', value: count, labels });
      // The true monotonic total — keeps growing after the buffer above has
      // wrapped, so an error-rate query (errors / total) built from two
      // `_observations_total` counters stays meaningful past 1,000 samples,
      // where the rolling buffer alone would silently cap the denominator.
      entries.push({ name: `${name}_observations_total`, type: 'counter', value: family.totalObservations, labels });
    }
    for (const [name, value] of this.gauges) {
      entries.push({ name, type: 'gauge', value });
    }

    // strengthen-operational-observability task 2.2: always present (even
    // at zero) once metrics are enabled, so "saturation is visible without
    // allocating new series" holds from the very first scrape rather than
    // only once the registry has actually dropped something.
    entries.push({ name: DROPPED_SERIES_METRIC, type: 'counter', value: this.droppedSeries });
    entries.push({ name: REGISTRY_SIZE_METRIC, type: 'gauge', value: this.seriesCount() });

    return entries;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}
