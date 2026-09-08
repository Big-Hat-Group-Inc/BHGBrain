import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
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
        scheduled_cleanup_enabled: true,
        pre_expiry_warning_days: 7,
        compaction_deleted_threshold: 0.1,
        audit_log_max_entries: 50000,
        revisions_per_memory_max: 20,
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
    } as unknown as BrainConfig;
  }

  beforeEach(() => {
    vi.resetModules();
  });

  it('redacts long content and previews tokens as a hash, never raw characters', async () => {
    const { redactContent, redactToken } = await import('./logger.js');
    expect(redactContent('short content')).toBe('short content');
    expect(redactContent('x'.repeat(60))).toBe(`${'x'.repeat(50)}...[redacted]`);
    expect(redactToken('')).toBe('***');
    // Hash-prefix preview (task 1.4/design.md decision 4): deterministic for
    // the same input, but must not contain any literal substring of the
    // token itself.
    const preview = redactToken('1234567890abcdef');
    expect(preview).toMatch(/^sha256:[0-9a-f]{8}$/);
    expect(preview).not.toContain('1234');
    expect(preview).not.toContain('cdef');
    expect(redactToken('1234567890abcdef')).toBe(preview); // deterministic
    expect(redactToken('different-token')).not.toBe(preview); // distinguishable
  });

  it('passes logger level and redact config to pino', async () => {
    const pinoMock = vi.fn(() => ({ level: 'warn' }));
    const stdTimeFunctions = { isoTime: vi.fn() };
    const stdSerializers = { err: vi.fn() };

    vi.doMock('pino', () => ({
      default: Object.assign(pinoMock, { stdTimeFunctions, stdSerializers }),
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

  it('redacts content/preview/summary fields in actual log output when log_redaction is enabled', async () => {
    vi.doUnmock('pino');
    const chunks: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });

    const { createLogger } = await import('./logger.js');
    const logger = createLogger(createConfig(true), destination);
    logger.warn({
      event: 'tool_call',
      content: 'super secret memory content',
      preview: 'secret preview text',
      summary: 'secret summary text',
      nested: { content: 'nested secret content' },
      tool: 'remember',
    });

    const output = chunks.join('');
    expect(output).not.toContain('super secret memory content');
    expect(output).not.toContain('secret preview text');
    expect(output).not.toContain('secret summary text');
    expect(output).not.toContain('nested secret content');
    expect(output).toContain('remember');
    expect(output).toContain('[Redacted]');
  });

  it('stamps service/version base fields and serializes a nested-cause error under `err`', async () => {
    vi.doUnmock('pino');
    const chunks: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });

    const { createLogger } = await import('./logger.js');
    const { PACKAGE_VERSION } = await import('../version.js');
    const logger = createLogger(createConfig(false), destination);

    const cause = new Error('root cause failure');
    const outer = new Error('outer failure', { cause });

    logger.error({ event: 'tool_error', tool: 'remember', err: outer });

    const line = JSON.parse(chunks.join(''));
    expect(line.service).toBe('bhgbrain');
    expect(line.version).toBe(PACKAGE_VERSION);
    expect(line.event).toBe('tool_error');
    expect(line.err.message).toContain('outer failure');
    // pino's err serializer folds a `.cause` chain's message/stack into the
    // top-level `message`/`stack` fields rather than a separate `cause` key.
    expect(line.err.message).toContain('root cause failure');
    expect(line.err.stack).toContain('root cause failure');
  });

  it('includes BrainError code/retryable in the serialized `err` field', async () => {
    vi.doUnmock('pino');
    const chunks: string[] = [];
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });

    const { createLogger } = await import('./logger.js');
    const { BrainError } = await import('../errors/index.js');
    const logger = createLogger(createConfig(false), destination);

    logger.warn({ event: 'tool_error', tool: 'forget', err: new BrainError('NOT_FOUND', 'Memory x not found', false) });

    const line = JSON.parse(chunks.join(''));
    expect(line.err.code).toBe('NOT_FOUND');
    expect(line.err.retryable).toBe(false);
    expect(line.err.message).toContain('Memory x not found');
  });

  it('withStableFields never lets caller-influenced details override the stable event fields', async () => {
    const { withStableFields } = await import('./logger.js');
    const details = { event: 'spoofed_event', tool: 'spoofed_tool', extra: 'kept' };
    const merged = withStableFields({ event: 'tool_error', tool: 'remember' }, details);
    expect(merged.event).toBe('tool_error');
    expect(merged.tool).toBe('remember');
    expect(merged.extra).toBe('kept');
  });

  it('toLogError wraps a non-Error throw instead of dropping it', async () => {
    const { toLogError } = await import('./logger.js');
    const wrapped = toLogError('a plain string throw');
    expect(wrapped).toBeInstanceOf(Error);
    expect(wrapped.message).toBe('a plain string throw');
    expect(toLogError(new Error('already an error')).message).toBe('already an error');
  });

  it('omits redact config when redaction is disabled', async () => {
    const pinoMock = vi.fn(() => ({ level: 'warn' }));
    const stdTimeFunctions = { isoTime: vi.fn() };
    const stdSerializers = { err: vi.fn() };

    vi.doMock('pino', () => ({
      default: Object.assign(pinoMock, { stdTimeFunctions, stdSerializers }),
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
