import { describe, expect, it } from 'vitest';
import { MetricsCollector, computePercentile } from './metrics.js';
import type { BrainConfig } from '../config/index.js';

describe('MetricsCollector', () => {
  function createConfig(metricsEnabled = true): BrainConfig {
    return {
      data_dir: 'test-data',
      embedding: { provider: 'openai', model: 'test-model', api_key_env: 'OPENAI_API_KEY', dimensions: 3 },
      qdrant: { mode: 'embedded', embedded_path: './qdrant', external_url: null, api_key_env: null },
      transport: {
        http: { enabled: true, host: '127.0.0.1', port: 3721, bearer_token_env: 'BHGBRAIN_TOKEN' },
        stdio: { enabled: true },
      },
      defaults: {
        namespace: 'global',
        collection: 'general',
        recall_limit: 5,
        min_score: 0.6,
        auto_inject_limit: 10,
        max_response_chars: 50000,
      },
      retention: {
        decay_after_days: 180,
        max_db_size_gb: 2,
        max_memories: 500000,
        warn_at_percent: 80,
        tier_ttl: { T0: null, T1: 365, T2: 90, T3: 30 },
        tier_budgets: { T0: null, T1: 100000, T2: 200000, T3: 200000 },
        auto_promote_access_threshold: 5,
        sliding_window_enabled: true,
        archive_before_delete: true,
        cleanup_schedule: '0 2 * * *',
        pre_expiry_warning_days: 7,
        compaction_deleted_threshold: 0.1,
      },
      deduplication: { enabled: true, similarity_threshold: 0.92 },
      resilience: {
        circuit_breaker: {
          failure_threshold: 1,
          open_window_ms: 30000,
          half_open_probe_count: 1,
        },
      },
      search: { hybrid_weights: { semantic: 0.7, fulltext: 0.3 } },
      security: {
        require_loopback_http: true,
        allow_unauthenticated_http: false,
        log_redaction: true,
        rate_limit_rpm: 100,
        max_request_size_bytes: 1048576,
      },
      auto_inject: { max_chars: 30000, max_tokens: null },
      observability: { metrics_enabled: metricsEnabled, structured_logging: true, log_level: 'info' },
      pipeline: {
        extraction_enabled: true,
        extraction_model: 'gpt-4o-mini',
        extraction_model_env: 'BHGBRAIN_EXTRACTION_API_KEY',
        fallback_to_threshold_dedup: true,
      },
      auto_summarize: true,
    };
  }

  it('emits histogram avg/count and percentile entries', () => {
    const metrics = new MetricsCollector(createConfig());
    metrics.recordHistogram('latency_ms', 10);
    metrics.recordHistogram('latency_ms', 20);
    metrics.recordHistogram('latency_ms', 30);
    metrics.recordHistogram('latency_ms', 40);

    const entries = Object.fromEntries(metrics.getMetrics().map(entry => [entry.name, entry.value]));

    expect(entries.latency_ms_avg).toBe(25);
    expect(entries.latency_ms_p50).toBe(20);
    expect(entries.latency_ms_p95).toBe(40);
    expect(entries.latency_ms_p99).toBe(40);
    expect(entries.latency_ms_count).toBe(4);
  });

  it('computes percentiles for empty, single-value, and known distributions', () => {
    expect(computePercentile([], 50)).toBe(0);
    expect(computePercentile([7], 95)).toBe(7);

    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(computePercentile(values, 50)).toBe(50);
    expect(computePercentile(values, 95)).toBe(95);
    expect(computePercentile(values, 99)).toBe(99);
  });

  it('computes percentiles from the most recent 1000 histogram samples', () => {
    const metrics = new MetricsCollector(createConfig());
    for (let value = 1; value <= 1005; value += 1) {
      metrics.recordHistogram('rolling_ms', value);
    }

    const entries = Object.fromEntries(metrics.getMetrics().map(entry => [entry.name, entry.value]));
    expect(entries.rolling_ms_count).toBe(1000);
    expect(entries.rolling_ms_p50).toBe(505);
    expect(entries.rolling_ms_p95).toBe(955);
    expect(entries.rolling_ms_p99).toBe(995);
  });
});
