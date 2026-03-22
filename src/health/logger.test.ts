import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainConfig } from '../config/index.js';

describe('logger helpers', () => {
  function createConfig(logRedaction: boolean): BrainConfig {
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
        log_redaction: logRedaction,
        rate_limit_rpm: 100,
        max_request_size_bytes: 1048576,
      },
      auto_inject: { max_chars: 30000, max_tokens: null },
      observability: { metrics_enabled: false, structured_logging: true, log_level: 'warn' },
      pipeline: {
        extraction_enabled: true,
        extraction_model: 'gpt-4o-mini',
        extraction_model_env: 'BHGBRAIN_EXTRACTION_API_KEY',
        fallback_to_threshold_dedup: true,
      },
      auto_summarize: true,
    };
  }

  beforeEach(() => {
    vi.resetModules();
  });

  it('redacts long content and short/long tokens correctly', async () => {
    const { redactContent, redactToken } = await import('./logger.js');
    expect(redactContent('short content')).toBe('short content');
    expect(redactContent('x'.repeat(60))).toBe(`${'x'.repeat(50)}...[redacted]`);
    expect(redactToken('short')).toBe('***');
    expect(redactToken('1234567890abcdef')).toBe('1234...cdef');
  });

  it('passes logger level and redact config to pino', async () => {
    const pinoMock = vi.fn(() => ({ level: 'warn' }));
    const stdTimeFunctions = { isoTime: vi.fn() };

    vi.doMock('pino', () => ({
      default: Object.assign(pinoMock, { stdTimeFunctions }),
    }));

    const { createLogger } = await import('./logger.js');
    createLogger(createConfig(true));

    expect(pinoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        redact: expect.arrayContaining(['req.headers.authorization', 'token', 'bearer', 'api_key']),
      }),
      process.stdout,
    );
  });

  it('omits redact config when redaction is disabled', async () => {
    const pinoMock = vi.fn(() => ({ level: 'warn' }));
    const stdTimeFunctions = { isoTime: vi.fn() };

    vi.doMock('pino', () => ({
      default: Object.assign(pinoMock, { stdTimeFunctions }),
    }));

    const { createLogger } = await import('./logger.js');
    createLogger(createConfig(false));

    expect(pinoMock).toHaveBeenCalledWith(
      expect.objectContaining({
        level: 'warn',
        redact: undefined,
      }),
      process.stdout,
    );
  });
});
