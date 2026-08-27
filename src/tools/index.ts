import type { BrainConfig } from '../config/index.js';
import type { StorageManager } from '../storage/index.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import type { WritePipeline } from '../pipeline/index.js';
import type { SearchService } from '../search/index.js';
import type { BackupService } from '../backup/index.js';
import type { HealthService } from '../health/index.js';
import type { MetricsCollector } from '../health/metrics.js';
import type pino from 'pino';
import {
  RememberInputSchema, RecallInputSchema, ForgetInputSchema,
  SearchInputSchema, TagInputSchema, CollectionsInputSchema,
  CategoryInputSchema, BackupInputSchema, RepairInputSchema,
  type RepairInput,
} from '../domain/schemas.js';
import type { WriteResult, SearchResult, MemoryRecord, RecallFilter } from '../domain/types.js';
import { BrainError, invalidInput, notFound, conflict } from '../errors/index.js';
import { computeChecksum } from '../domain/normalize.js';
import { handleImport } from './import.js';
import { handleBootstrap } from './bootstrap.js';
import { ZodError } from 'zod';

export interface ToolContext {
  config: BrainConfig;
  storage: StorageManager;
  embedding: EmbeddingProvider;
  pipeline: WritePipeline;
  search: SearchService;
  backup: BackupService;
  health: HealthService;
  metrics: MetricsCollector;
  logger: pino.Logger;
}

// Mutable out-param populated by tool handlers as soon as they resolve the
// namespace a call operates on, so `handleTool`'s request/error logs can
// include it even though namespace resolution happens deep inside
// tool-specific handlers (see `add-operations-security-reliability` audit
// follow-up 2026-06-05, task 4.5). Left empty for tools with no single
// applicable namespace (e.g. `repair`, which spans all namespaces).
export interface ToolLogContext {
  namespace?: string;
}

function parseInput<T>(schema: { parse: (d: unknown) => T }, data: unknown): T {
  try {
    return schema.parse(data);
  } catch (err) {
    if (err instanceof ZodError) {
      const messages = err.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
      throw invalidInput(messages);
    }
    throw err;
  }
}

export async function handleTool(
  ctx: ToolContext,
  toolName: string,
  args: unknown,
  clientId = 'unknown',
): Promise<unknown> {
  const start = Date.now();
  ctx.metrics.incCounter('bhgbrain_tool_calls_total');
  const logCtx: ToolLogContext = {};
  // Hoisted so the `finally` block below can record the tool-handler latency
  // histogram exactly once, on every path (success, BrainError, and
  // unexpected error) — see `record-tool-latency-on-all-paths`. Logging stays
  // in the try/catch branches, each computing `duration` once per branch.
  let duration = 0;
  let status: 'ok' | 'error' = 'ok';

  try {
    const result = await dispatch(ctx, toolName, args, clientId, logCtx);
    duration = Date.now() - start;
    ctx.logger.info({
      event: 'tool_call', tool: toolName, duration_ms: duration, client_id: clientId,
      namespace: logCtx.namespace ?? null,
    });
    return result;
  } catch (err) {
    status = 'error';
    duration = Date.now() - start;
    if (err instanceof BrainError) {
      ctx.logger.warn({
        event: 'tool_error', tool: toolName, error_code: err.code, duration_ms: duration, client_id: clientId,
        namespace: logCtx.namespace ?? null,
      });
      return err.toEnvelope();
    }
    ctx.logger.error({
      event: 'tool_error', tool: toolName, error: (err as Error).message, duration_ms: duration, client_id: clientId,
      namespace: logCtx.namespace ?? null,
    });
    return { error: { code: 'INTERNAL', message: 'An unexpected error occurred', retryable: true } };
  } finally {
    // Per-tool identification via a `tool` label (design decision 2), plus an
    // `ok`/`error` status label so the success/failure split is preserved
    // without excluding failures from the latency histogram itself.
    ctx.metrics.recordHistogram('bhgbrain_tool_handler_ms', duration, { tool: toolName, status });
  }
}

async function dispatch(
  ctx: ToolContext,
  toolName: string,
  args: unknown,
  clientId: string,
  logCtx: ToolLogContext,
): Promise<unknown> {
  switch (toolName) {
    case 'remember': return handleRemember(ctx, args, clientId, logCtx);
    case 'recall': return handleRecall(ctx, args, logCtx);
    case 'forget': return handleForget(ctx, args, clientId, logCtx);
    case 'search': return handleSearch(ctx, args, logCtx);
    case 'tag': return handleTag(ctx, args, logCtx);
    case 'collections': return handleCollections(ctx, args, logCtx);
    case 'category': return handleCategory(ctx, args);
    case 'backup': return handleBackup(ctx, args);
    case 'bootstrap': return handleBootstrap(ctx, args, logCtx);
    case 'import': return handleImport(ctx, args, logCtx);
    case 'repair': return handleRepair(ctx, args);
    default:
      throw invalidInput(`Unknown tool: ${toolName}`);
  }
}

async function handleRemember(
  ctx: ToolContext, args: unknown, clientId: string, logCtx: ToolLogContext,
): Promise<WriteResult | WriteResult[]> {
  const input = parseInput(RememberInputSchema, args);
  logCtx.namespace = input.namespace;
  const results = await ctx.pipeline.process({
    content: input.content,
    namespace: input.namespace,
    collection: input.collection,
    type: input.type,
    tags: input.tags,
    category: input.category,
    importance: input.importance,
    source: input.source,
    retention_tier: input.retention_tier,
    device_id: ctx.config.device.id ?? null,
    clientId,
  });

  ctx.metrics.setGauge('bhgbrain_memory_count', ctx.storage.sqlite.countMemories());
  return results.length === 1 ? results[0]! : results;
}

async function handleRecall(
  ctx: ToolContext, args: unknown, logCtx: ToolLogContext,
): Promise<{ results: SearchResult[] }> {
  const input = parseInput(RecallInputSchema, args);
  logCtx.namespace = input.namespace;

  // Push type/tags down into the store instead of discovering the mismatch
  // only after `limit` candidates are already spent (push-down-recall-filters):
  // omitted entirely when neither filter is requested, so an unfiltered
  // recall's store call is identical to before this parameter existed.
  const filter: RecallFilter | undefined = (input.type !== undefined || (input.tags?.length ?? 0) > 0)
    ? { type: input.type, tags: input.tags }
    : undefined;

  // Over-fetch modestly beyond `limit` so the expired-memory exclusion inside
  // `buildSearchResults` cannot starve the caller's limit even once the
  // store already narrows candidates down to matching memories. Capped so a
  // filtered recall never asks the store for an unbounded candidate pool.
  const fetchLimit = Math.min(input.limit * 2, 40);

  const results = await ctx.search.search(
    input.query, input.namespace, input.collection, 'semantic', fetchLimit, undefined, filter,
  );

  // Defensive post-retrieval re-check for type/tags: the store is now the
  // primary filtering mechanism, so this should be a no-op in steady state.
  // It only fires on payload drift (e.g. Qdrant points written before
  // type/tags existed in the payload) or an inconsistent store — a
  // filter-starvation symptom worth surfacing, so its removals are counted.
  const beforeDefensiveCheck = results.length;
  let filtered = results;
  if (input.type) {
    filtered = filtered.filter(r => r.type === input.type);
  }
  if (input.tags && input.tags.length > 0) {
    filtered = filtered.filter(r => input.tags!.some(t => r.tags.includes(t)));
  }
  if (filtered.length < beforeDefensiveCheck) {
    ctx.metrics.incCounter('recall_zero_after_filter');
  }

  // min_score is calibrated for cosine similarity, so it is applied to
  // `semantic_score` explicitly (falling back to `score` only when
  // `semantic_score` is unavailable) rather than the mode-adjusted `score`
  // field recall previously thresholded — `handleRecall` hardcodes semantic
  // mode, but this keeps the comparison correct if that ever changes.
  filtered = filtered.filter(r => (r.semantic_score ?? r.score) >= input.min_score);

  return { results: filtered.slice(0, input.limit) };
}

async function handleForget(
  ctx: ToolContext, args: unknown, clientId: string, logCtx: ToolLogContext,
): Promise<{ deleted: boolean; id: string }> {
  const input = parseInput(ForgetInputSchema, args);
  const mem = ctx.storage.sqlite.getMemoryById(input.id);
  if (!mem) throw notFound(`Memory ${input.id} not found`);
  logCtx.namespace = mem.namespace;

  const deleted = await ctx.storage.deleteMemory(input.id);
  if (deleted) {
    ctx.storage.logAudit('FORGET', input.id, mem.namespace, clientId);
  }

  ctx.metrics.setGauge('bhgbrain_memory_count', ctx.storage.sqlite.countMemories());
  return { deleted, id: input.id };
}

async function handleSearch(
  ctx: ToolContext, args: unknown, logCtx: ToolLogContext,
): Promise<{ results: SearchResult[]; degraded: boolean }> {
  const input = parseInput(SearchInputSchema, args);
  logCtx.namespace = input.namespace;
  const signal: { degraded?: boolean } = {};
  const results = await ctx.search.search(
    input.query, input.namespace, input.collection, input.mode, input.limit, signal,
  );
  // `degraded` is true when hybrid mode fell back to fulltext-only (embedding /
  // vector store unavailable), so callers can tell it from a healthy result.
  return { results, degraded: signal.degraded ?? false };
}

async function handleTag(
  ctx: ToolContext, args: unknown, logCtx: ToolLogContext,
): Promise<{ id: string; tags: string[] }> {
  const input = parseInput(TagInputSchema, args);
  const mem = ctx.storage.sqlite.getMemoryById(input.id);
  if (!mem) throw notFound(`Memory ${input.id} not found`);
  logCtx.namespace = mem.namespace;

  let tags = [...mem.tags];
  if (input.add.length > 0) {
    tags = [...new Set([...tags, ...input.add])];
  }
  if (input.remove.length > 0) {
    tags = tags.filter(t => !input.remove.includes(t));
  }

  if (tags.length > 20) {
    throw invalidInput('Maximum 20 tags per memory');
  }

  ctx.storage.sqlite.updateMemory(input.id, { tags, updated_at: new Date().toISOString() });
  ctx.storage.sqlite.flushIfDirty();

  return { id: input.id, tags };
}

async function handleCollections(
  ctx: ToolContext, args: unknown, logCtx: ToolLogContext,
): Promise<unknown> {
  const input = parseInput(CollectionsInputSchema, args);
  const namespace = input.namespace;
  logCtx.namespace = namespace;

  switch (input.action) {
    case 'list':
      return { collections: ctx.storage.sqlite.listCollections(namespace) };

    case 'create':
      if (!input.name) throw invalidInput('name is required for create');
      ctx.storage.sqlite.createCollection(
        namespace, input.name,
        ctx.embedding.model, ctx.embedding.dimensions,
      );
      ctx.storage.sqlite.flushIfDirty();
      return { ok: true, namespace, name: input.name };

    case 'delete':
      if (!input.name) throw invalidInput('name is required for delete');
      const exists = ctx.storage.sqlite.getCollection(namespace, input.name);
      if (!exists) throw notFound(`Collection "${input.name}" not found`);

      const memoryCount = ctx.storage.countMemoriesInCollection(namespace, input.name);
      if (memoryCount > 0 && !input.force) {
        throw conflict(
          `Collection "${input.name}" is not empty (${memoryCount} memories). ` +
          `Retry with force=true to delete all collection data.`,
        );
      }

      let deletedMemoryCount = 0;
      if (input.force) {
        const removed = await ctx.storage.deleteCollectionData(namespace, input.name, { logger: ctx.logger });
        deletedMemoryCount = removed.deleted;
        for (const memoryId of removed.ids) {
          ctx.storage.logAudit('FORGET', memoryId, namespace);
        }
      }

      const deleted = ctx.storage.sqlite.deleteCollection(namespace, input.name);
      if (!deleted) throw notFound(`Collection "${input.name}" not found`);
      ctx.storage.sqlite.flushIfDirty();

      ctx.metrics.setGauge('bhgbrain_memory_count', ctx.storage.sqlite.countMemories());
      return { ok: true, namespace, name: input.name, deleted_memory_count: deletedMemoryCount };
  }
}

async function handleCategory(ctx: ToolContext, args: unknown): Promise<unknown> {
  const input = parseInput(CategoryInputSchema, args);

  switch (input.action) {
    case 'list':
      return { categories: ctx.storage.sqlite.listCategories().map(c => ({
        name: c.name,
        slot: c.slot,
        preview: c.content.substring(0, 200),
        revision: c.revision,
        updated_at: c.updated_at,
      }))};

    case 'get':
      if (!input.name) throw invalidInput('name is required for get');
      const cat = ctx.storage.sqlite.getCategory(input.name);
      if (!cat) throw notFound(`Category "${input.name}" not found`);
      return cat;

    case 'set': {
      if (!input.name) throw invalidInput('name is required for set');
      if (!input.content) throw invalidInput('content is required for set');
      const slot = input.slot ?? 'custom';
      const result = ctx.storage.sqlite.setCategory(input.name, slot, input.content);
      ctx.storage.sqlite.flushIfDirty();
      return result;
    }

    case 'delete': {
      if (!input.name) throw invalidInput('name is required for delete');
      const removed = ctx.storage.sqlite.deleteCategory(input.name);
      if (!removed) throw notFound(`Category "${input.name}" not found`);
      ctx.storage.sqlite.flushIfDirty();
      return { ok: true, name: input.name };
    }
  }
}

async function handleBackup(ctx: ToolContext, args: unknown): Promise<unknown> {
  const input = parseInput(BackupInputSchema, args);

  switch (input.action) {
    case 'create':
      return ctx.backup.create();

    case 'list':
      return { backups: ctx.backup.list() };

    case 'restore':
      if (!input.path) throw invalidInput('path is required for restore');
      return ctx.backup.restore(input.path);
  }
}

async function handleRepair(ctx: ToolContext, args: unknown): Promise<unknown> {
  const input = parseInput(RepairInputSchema, args);
  if (input.mode === 're-embed') {
    return handleReembed(ctx, input);
  }
  const dryRun = input.dry_run;
  // `all_devices` and `device_id` are mutually exclusive (enforced by the
  // schema); omitting both is the documented, backward-compatible
  // all-devices default, same as passing `all_devices: true` explicitly.
  const filterDeviceId = input.all_devices ? undefined : input.device_id;
  const localDeviceId = ctx.config.device.id ?? null;

  const collections = await ctx.storage.qdrant.listAllCollections();
  let scannedPoints = 0;
  let recoveredCount = 0;
  let skippedNoContent = 0;
  let skippedDeviceFilter = 0;
  let alreadyInSqlite = 0;
  const errors: string[] = [];

  for (const collectionName of collections) {
    let points: Array<{ id: string; payload: Record<string, unknown> }>;
    try {
      points = await ctx.storage.qdrant.scrollAll(collectionName);
    } catch (err) {
      errors.push(`Failed to scroll ${collectionName}: ${(err as Error).message}`);
      continue;
    }

    scannedPoints += points.length;

    for (const point of points) {
      const payload = point.payload;
      const content = payload.content as string | undefined;

      if (!content) {
        skippedNoContent++;
        continue;
      }

      // Filter by device_id if specified
      const pointDeviceId = (payload.device_id as string) ?? null;
      if (filterDeviceId && pointDeviceId !== filterDeviceId) {
        skippedDeviceFilter++;
        continue;
      }

      // Check if already in SQLite
      const existing = ctx.storage.sqlite.getMemoryById(point.id);
      if (existing) {
        alreadyInSqlite++;
        continue;
      }

      if (dryRun) {
        recoveredCount++;
        continue;
      }

      // Reconstruct and insert into SQLite
      const now = new Date().toISOString();
      const namespace = (payload.namespace as string) ?? 'global';
      const collection = (payload.collection as string) ?? 'general';

      // Ensure the collection exists in SQLite
      const colRecord = ctx.storage.sqlite.getCollection(namespace, collection);
      if (!colRecord) {
        ctx.storage.sqlite.createCollection(
          namespace, collection,
          ctx.embedding.model, ctx.embedding.dimensions,
        );
      }

      // Use original device_id from payload, or fall back to local device_id
      const recoveredDeviceId = pointDeviceId ?? localDeviceId;

      const mem: Omit<MemoryRecord, 'embedding'> = {
        id: point.id,
        namespace,
        collection,
        type: (payload.type as MemoryRecord['type']) ?? 'semantic',
        category: (payload.category as string) ?? null,
        content,
        summary: (payload.summary as string) ?? '',
        tags: Array.isArray(payload.tags) ? payload.tags as string[] : [],
        source: (payload.source as MemoryRecord['source']) ?? 'import',
        checksum: computeChecksum(content),
        importance: (payload.importance as number) ?? 0.5,
        retention_tier: (payload.retention_tier as MemoryRecord['retention_tier']) ?? 'T2',
        expires_at: null,
        decay_eligible: (payload.decay_eligible as boolean) ?? true,
        review_due: null,
        access_count: 0,
        last_operation: 'ADD',
        merged_from: null,
        archived: false,
        vector_synced: true,
        device_id: recoveredDeviceId,
        // Carry forward whatever identity the recovered vector was already
        // stamped with — this reconstructs a SQLite row from an existing
        // Qdrant point, not a new embedding, so it must not claim the active
        // configuration's identity. Missing on the payload means the point
        // predates provenance stamping and stays "unknown" (null).
        embedding_model: typeof payload.embedding_model === 'string' ? payload.embedding_model : null,
        created_at: (payload.created_at as string) ?? now,
        updated_at: now,
        last_accessed: now,
      };

      try {
        ctx.storage.sqlite.insertMemory(mem);
        recoveredCount++;
      } catch (err) {
        errors.push(`Failed to insert ${point.id}: ${(err as Error).message}`);
      }
    }
  }

  if (recoveredCount > 0 && !dryRun) {
    ctx.storage.sqlite.flushIfDirty();
    ctx.metrics.setGauge('bhgbrain_memory_count', ctx.storage.sqlite.countMemories());
  }

  return {
    dry_run: dryRun,
    all_devices: input.all_devices || filterDeviceId === undefined,
    device_id_filter: filterDeviceId ?? null,
    collections_scanned: collections.length,
    points_scanned: scannedPoints,
    already_in_sqlite: alreadyInSqlite,
    skipped_no_content: skippedNoContent,
    skipped_device_filter: filterDeviceId ? skippedDeviceFilter : undefined,
    recovered: recoveredCount,
    errors: errors.length > 0 ? errors : undefined,
  };
}

async function handleReembed(ctx: ToolContext, input: RepairInput): Promise<unknown> {
  const activeIdentity = ctx.embedding.identity;
  const expectedIdentity = ctx.storage.getExpectedEmbeddingIdentity();

  if (input.dry_run) {
    const staleCount = ctx.storage.sqlite.countMemoriesWithStaleEmbeddingStamp(activeIdentity, input.include_legacy);
    return {
      mode: 're-embed',
      dry_run: true,
      active_identity: activeIdentity,
      expected_identity: expectedIdentity,
      include_legacy: input.include_legacy,
      would_re_embed: staleCount,
    };
  }

  const result = await ctx.storage.reembedMismatchedVectors({
    includeLegacy: input.include_legacy,
    batchSize: input.batch_size,
    logger: ctx.logger,
  });

  ctx.metrics.setGauge('bhgbrain_memory_count', ctx.storage.sqlite.countMemories());

  return {
    mode: 're-embed',
    dry_run: false,
    active_identity: activeIdentity,
    include_legacy: input.include_legacy,
    updated: result.updated,
    failed: result.failed,
    remaining: result.remaining,
    bound_reached: result.boundReached,
    converged: result.converged,
  };
}
