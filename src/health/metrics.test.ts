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
        scheduled_cleanup_enabled: true,
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

  it('accumulates incCounter across multiple calls (task 3.1 / 8.1)', () => {
    const metrics = new MetricsCollector(createConfig());
    metrics.incCounter('requests_total');
    metrics.incCounter('requests_total');

    const entry = metrics.getMetrics().find(e => e.name === 'requests_total');
    expect(entry).toEqual({ name: 'requests_total', type: 'counter', value: 2 });
  });

  it('accumulates incCounter with a custom amount (task 3.2 / 8.2)', () => {
    const metrics = new MetricsCollector(createConfig());
    metrics.incCounter('bytes_total', 3);
    metrics.incCounter('bytes_total', 5);

    const entry = metrics.getMetrics().find(e => e.name === 'bytes_total');
    expect(entry).toEqual({ name: 'bytes_total', type: 'counter', value: 8 });
  });

  it('overwrites the previous value with setGauge (task 3.5 / 8.3)', () => {
    const metrics = new MetricsCollector(createConfig());
    metrics.setGauge('active_connections', 1);
    metrics.setGauge('active_connections', 2);

    const entry = metrics.getMetrics().find(e => e.name === 'active_connections');
    expect(entry).toEqual({ name: 'active_connections', type: 'gauge', value: 2 });
  });

  it('ignores all record calls and returns [] when disabled (task 3.6 / 8.4)', () => {
    const metrics = new MetricsCollector(createConfig(false));
    metrics.incCounter('requests_total');
    metrics.setGauge('active_connections', 1);
    metrics.recordHistogram('latency_ms', 10);

    expect(metrics.getMetrics()).toEqual([]);
  });

  it('tags getMetrics entries with the correct type (task 3.7 / 8.6)', () => {
    const metrics = new MetricsCollector(createConfig());
    metrics.incCounter('requests_total');
    metrics.setGauge('active_connections', 1);
    metrics.recordHistogram('latency_ms', 10);

    const entries = Object.fromEntries(metrics.getMetrics().map(entry => [entry.name, entry.type]));

    expect(entries.requests_total).toBe('counter');
    expect(entries.active_connections).toBe('gauge');
    expect(entries.latency_ms_avg).toBe('histogram');
    expect(entries.latency_ms_p50).toBe('histogram');
    expect(entries.latency_ms_p95).toBe('histogram');
    expect(entries.latency_ms_p99).toBe('histogram');
    // The rolling sample count is itself tagged 'counter', not 'histogram'.
    expect(entries.latency_ms_count).toBe('counter');
  });

  it('buckets a labeled histogram separately per distinct label set (record-tool-latency-on-all-paths task 2)', () => {
    const metrics = new MetricsCollector(createConfig());
    metrics.recordHistogram('bhgbrain_tool_handler_ms', 10, { tool: 'recall', status: 'ok' });
    metrics.recordHistogram('bhgbrain_tool_handler_ms', 20, { tool: 'recall', status: 'ok' });
    metrics.recordHistogram('bhgbrain_tool_handler_ms', 100, { tool: 'remember', status: 'error' });

    const entries = metrics.getMetrics();
    const recallAvg = entries.find(e => e.name === 'bhgbrain_tool_handler_ms_avg' && e.labels?.tool === 'recall');
    const rememberAvg = entries.find(e => e.name === 'bhgbrain_tool_handler_ms_avg' && e.labels?.tool === 'remember');

    expect(recallAvg?.value).toBe(15);
    expect(recallAvg?.labels).toEqual({ tool: 'recall', status: 'ok' });
    expect(rememberAvg?.value).toBe(100);
    expect(rememberAvg?.labels).toEqual({ tool: 'remember', status: 'error' });
  });

  it('accumulates a labeled counter separately per distinct label set (add-retrieval-quality-metrics task 1.4)', () => {
    const metrics = new MetricsCollector(createConfig());
    metrics.incCounter('search_embedding_degraded', 1, { namespace: 'team-a' });
    metrics.incCounter('search_embedding_degraded', 1, { namespace: 'team-a' });
    metrics.incCounter('search_embedding_degraded', 1, { namespace: 'team-b' });

    const entries = metrics.getMetrics();
    const teamA = entries.find(e => e.name === 'search_embedding_degraded' && e.labels?.namespace === 'team-a');
    const teamB = entries.find(e => e.name === 'search_embedding_degraded' && e.labels?.namespace === 'team-b');

    expect(teamA).toEqual({ name: 'search_embedding_degraded', type: 'counter', value: 2, labels: { namespace: 'team-a' } });
    expect(teamB).toEqual({ name: 'search_embedding_degraded', type: 'counter', value: 1, labels: { namespace: 'team-b' } });
  });

  it('computes percentiles for empty, single-value, and known distributions', () => {
    expect(computePercentile([], 50)).toBe(0);
    expect(computePercentile([7], 95)).toBe(7);

    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(computePercentile(values, 50)).toBe(50);
    expect(computePercentile(values, 95)).toBe(95);
    expect(computePercentile(values, 99)).toBe(99);
  });

  it('wraps the bounded histogram buffer at capacity: count, avg, and percentiles reflect only the most recent window (task 3.4 / 8.5)', () => {
    // Pushes capacity (1000) + 5 samples. The oldest 5 (values 1..5) must be
    // evicted by the circular buffer, leaving exactly `capacity` items — the
    // window 6..1005 — which is asserted directly via count and avg, not
    // only indirectly via the percentile cap.
    const metrics = new MetricsCollector(createConfig());
    for (let value = 1; value <= 1005; value += 1) {
      metrics.recordHistogram('rolling_ms', value);
    }

    const entries = Object.fromEntries(metrics.getMetrics().map(entry => [entry.name, entry.value]));
    // Exactly `capacity` items remain in the window (not 1005).
    expect(entries.rolling_ms_count).toBe(1000);
    // Average of the most-recent window [6..1005], not the full [1..1005]
    // sequence (which would average to 503).
    expect(entries.rolling_ms_avg).toBe(505.5);
    expect(entries.rolling_ms_p50).toBe(505);
    expect(entries.rolling_ms_p95).toBe(955);
    expect(entries.rolling_ms_p99).toBe(995);
  });
});
