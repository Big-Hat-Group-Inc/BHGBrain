import type { BrainConfig } from '../config/index.js';

interface MetricEntry {
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

export class MetricsCollector {
  private enabled: boolean;
  private counters = new Map<string, number>();
  private histograms = new Map<string, BoundedBuffer>();
  private gauges = new Map<string, number>();
  private static readonly HISTOGRAM_CAPACITY = 1000;

  constructor(config: BrainConfig) {
    this.enabled = config.observability.metrics_enabled;
  }

  incCounter(name: string, amount = 1): void {
    if (!this.enabled) return;
    const current = this.counters.get(name) ?? 0;
    this.counters.set(name, current + amount);
  }

  recordHistogram(name: string, value: number): void {
    if (!this.enabled) return;
    let buf = this.histograms.get(name);
    if (!buf) {
      buf = new BoundedBuffer(MetricsCollector.HISTOGRAM_CAPACITY);
      this.histograms.set(name, buf);
    }
    buf.push(value);
  }

  setGauge(name: string, value: number): void {
    if (!this.enabled) return;
    this.gauges.set(name, value);
  }

  getMetrics(): MetricEntry[] {
    if (!this.enabled) return [];
    const entries: MetricEntry[] = [];

    for (const [name, value] of this.counters) {
      entries.push({ name, type: 'counter', value });
    }
    for (const [name, buf] of this.histograms) {
      const vals = buf.values();
      const count = vals.length;
      const sum = count > 0 ? vals.reduce((a, b) => a + b, 0) : 0;
      const avg = count > 0 ? sum / count : 0;
      const sortedValues = [...vals].sort((a, b) => a - b);
      entries.push({ name: `${name}_avg`, type: 'histogram', value: avg });
      entries.push({ name: `${name}_p50`, type: 'histogram', value: computePercentile(sortedValues, 50) });
      entries.push({ name: `${name}_p95`, type: 'histogram', value: computePercentile(sortedValues, 95) });
      entries.push({ name: `${name}_p99`, type: 'histogram', value: computePercentile(sortedValues, 99) });
      entries.push({ name: `${name}_count`, type: 'counter', value: count });
    }
    for (const [name, value] of this.gauges) {
      entries.push({ name, type: 'gauge', value });
    }

    return entries;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}
