import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type pino from 'pino';
import { handleTool } from './index.js';
import type { ToolContext } from './index.js';
import { WritePipeline } from '../pipeline/index.js';
import type { SearchService } from '../search/index.js';
import type { BackupService } from '../backup/index.js';
import type { HealthService } from '../health/index.js';
import type { MetricsCollector } from '../health/metrics.js';
import type { StorageManager } from '../storage/index.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import type { ErrorEnvelope as BrainErrorEnvelope } from '../domain/types.js';
import { createEvalStorage, teardownEvalStorage, type EvalStorage } from '../eval/harness.js';

// fix-non-default-collection-writes (BIG-928): every `remember` (and every
// `bootstrap submit`, which writes to the `profile` namespace) into a
// namespace/collection whose Qdrant collection did not exist yet failed with
// a generic retryable INTERNAL error, because the write pipeline's dedup
// lookup misread the real Qdrant client's missing-collection 404 as a hard
// failure. These run the real handler -> WritePipeline -> StorageManager ->
// QdrantStore path, with the Qdrant transport replaced by `FakeQdrantClient`
// (which throws the real client's `ApiError` shape for a missing collection).
describe('writes to a namespace/collection with no Qdrant collection yet (fix-non-default-collection-writes)', () => {
  let store: EvalStorage;
  let ctx: ToolContext;

  beforeEach(async () => {
    store = await createEvalStorage();
    ctx = {
      config: store.config,
      storage: store.storage,
      embedding: store.storage.embedding,
      pipeline: new WritePipeline(store.config, store.storage, store.storage.embedding),
      search: {} as SearchService,
      backup: {} as BackupService,
      health: {} as HealthService,
      metrics: { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as MetricsCollector,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger,
    };
  });

  afterEach(() => {
    teardownEvalStorage(store);
  });

  it.each([
    ['a new namespace without a slash', { namespace: 'profile' }, 'profile', 'general'],
    ['a new namespace with a slash', { namespace: 'projects/shipwin32' }, 'projects/shipwin32', 'general'],
    ['a new collection in the default namespace', { collection: 'diagnostic' }, 'global', 'diagnostic'],
  ])('remember succeeds into %s', async (_label, target, namespace, collection) => {
    const result = await handleTool(ctx, 'remember', {
      content: `BIG-928 regression probe for ${namespace}/${collection}`,
      ...target,
    }, 'c1') as Record<string, unknown>;

    expect(result).not.toHaveProperty('error');
    expect(result.operation).toBe('ADD');
    const row = store.storage.sqlite.getMemoryById(result.id as string);
    expect(row).toMatchObject({ namespace, collection, vector_synced: true });
  });

  it('remember succeeds into a collection pre-created with `collections create` (SQLite row, no Qdrant collection)', async () => {
    const created = await handleTool(ctx, 'collections', {
      action: 'create', namespace: 'projects', name: 'shipwin32',
    }, 'c1') as Record<string, unknown>;
    expect(created.ok).toBe(true);

    const result = await handleTool(ctx, 'remember', {
      content: 'ShipWin32 status note',
      namespace: 'projects',
      collection: 'shipwin32',
    }, 'c1') as Record<string, unknown>;

    expect(result).not.toHaveProperty('error');
    expect(result.operation).toBe('ADD');
  });

  it('a second write to the same new collection still deduplicates against the first', async () => {
    const content = 'Kevin prefers concise status updates';
    const first = await handleTool(ctx, 'remember', { content, namespace: 'profile' }, 'c1') as Record<string, unknown>;
    const second = await handleTool(ctx, 'remember', { content, namespace: 'profile' }, 'c1') as Record<string, unknown>;

    expect(first.operation).toBe('ADD');
    expect(second.operation).toBe('NOOP');
  });

  it('bootstrap submit stores its answers in `profile` and status reports the section complete', async () => {
    const started = await handleTool(ctx, 'bootstrap', { action: 'start' }, 'c1') as Record<string, unknown>;
    expect(started).not.toHaveProperty('error');

    const submitted = await handleTool(ctx, 'bootstrap', {
      action: 'submit',
      section: 1,
      answers: 'I run a small Microsoft-focused consultancy.\n\nI work mostly in TypeScript and PowerShell.',
    }, 'c1') as Record<string, unknown>;
    expect(submitted).not.toHaveProperty('error');
    expect(submitted.submitted).toBe(1);
    expect(submitted.memories_stored).toBe(2);

    const status = await handleTool(ctx, 'bootstrap', { action: 'status' }, 'c1') as {
      sections: Array<{ section: number; status: string }>;
    };
    expect(status.sections.find(s => s.section === 1)?.status).toBe('complete');
  });
});

// A raw upstream 4xx that reaches handleTool unclassified is a permanent
// rejection: it must not be reported as the generic `retryable: true`
// INTERNAL fallback, which invites callers to retry forever.
describe('permanent upstream failures at the handleTool boundary (fix-non-default-collection-writes)', () => {
  function ctxWithFailingDedup(error: unknown): ToolContext {
    const embedding = {
      model: 'test-model',
      dimensions: 2,
      embed: vi.fn(async () => [0.1, 0.2]),
      embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
      healthCheck: vi.fn(async () => true),
    } as unknown as EmbeddingProvider;
    const config = {
      pipeline: { long_content_threshold_chars: 10_000 },
      defaults: { pin_limit_per_namespace: 10 },
      device: { id: null },
    } as unknown as ToolContext['config'];
    const pipeline = { process: vi.fn(async () => { throw error; }) } as unknown as WritePipeline;
    return {
      config,
      storage: {} as StorageManager,
      embedding,
      pipeline,
      search: {} as SearchService,
      backup: {} as BackupService,
      health: {} as HealthService,
      metrics: { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as MetricsCollector,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger,
    };
  }

  function apiError(status: number, statusText: string, detail: string): Error {
    return Object.assign(new Error(statusText), {
      status,
      statusText,
      data: { status: { error: detail }, time: 0 },
    });
  }

  it('reports a raw upstream 4xx as non-retryable without leaking the upstream body', async () => {
    const ctx = ctxWithFailingDedup(apiError(400, 'Bad Request', 'Wrong input: Vector dimension error: expected dim: 3072, got 1536'));

    const result = await handleTool(ctx, 'remember', { content: 'x', namespace: 'profile' }, 'c1') as BrainErrorEnvelope;

    expect(result.error.code).toBe('INTERNAL');
    expect(result.error.retryable).toBe(false);
    expect(result.error.message).toMatch(/HTTP 400/);
    expect(result.error.message).not.toMatch(/dimension/);
  });

  it.each([
    [408, 'Request Timeout'],
    [429, 'Too Many Requests'],
    [503, 'Service Unavailable'],
  ])('keeps a transient upstream %i retryable', async (status, statusText) => {
    const ctx = ctxWithFailingDedup(apiError(status, statusText, 'transient'));

    const result = await handleTool(ctx, 'remember', { content: 'x', namespace: 'profile' }, 'c1') as BrainErrorEnvelope;

    expect(result.error.code).toBe('INTERNAL');
    expect(result.error.retryable).toBe(true);
    expect(result.error.message).toBe('An unexpected error occurred');
  });
});
