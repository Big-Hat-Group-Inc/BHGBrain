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
  CategoryInputSchema, BackupInputSchema,
} from '../domain/schemas.js';
import type { WriteResult, SearchResult } from '../domain/types.js';
import { BrainError, invalidInput, notFound, conflict } from '../errors/index.js';
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

  try {
    const result = await dispatch(ctx, toolName, args, clientId);
    const duration = Date.now() - start;
    ctx.metrics.recordHistogram('bhgbrain_tool_duration_seconds', duration / 1000);
    ctx.logger.info({ event: 'tool_call', tool: toolName, duration_ms: duration, client_id: clientId });
    return result;
  } catch (err) {
    const duration = Date.now() - start;
    if (err instanceof BrainError) {
      ctx.logger.warn({ event: 'tool_error', tool: toolName, error_code: err.code, duration_ms: duration, client_id: clientId });
      return err.toEnvelope();
    }
    ctx.logger.error({ event: 'tool_error', tool: toolName, error: (err as Error).message, duration_ms: duration, client_id: clientId });
    return { error: { code: 'INTERNAL', message: 'An unexpected error occurred', retryable: true } };
  }
}

async function dispatch(
  ctx: ToolContext,
  toolName: string,
  args: unknown,
  clientId: string,
): Promise<unknown> {
  switch (toolName) {
    case 'remember': return handleRemember(ctx, args, clientId);
    case 'recall': return handleRecall(ctx, args);
    case 'forget': return handleForget(ctx, args, clientId);
    case 'search': return handleSearch(ctx, args);
    case 'tag': return handleTag(ctx, args);
    case 'collections': return handleCollections(ctx, args);
    case 'category': return handleCategory(ctx, args);
    case 'backup': return handleBackup(ctx, args);
    default:
      throw invalidInput(`Unknown tool: ${toolName}`);
  }
}

async function handleRemember(ctx: ToolContext, args: unknown, clientId: string): Promise<WriteResult | WriteResult[]> {
  const input = parseInput(RememberInputSchema, args);
  const results = await ctx.pipeline.process({
    content: input.content,
    namespace: input.namespace,
    collection: input.collection,
    type: input.type,
    tags: input.tags,
    category: input.category,
    importance: input.importance,
    source: input.source,
    clientId,
  });

  ctx.metrics.setGauge('bhgbrain_memory_count', ctx.storage.sqlite.countMemories());
  return results.length === 1 ? results[0]! : results;
}

async function handleRecall(ctx: ToolContext, args: unknown): Promise<{ results: SearchResult[] }> {
  const input = parseInput(RecallInputSchema, args);
  const results = await ctx.search.search(
    input.query, input.namespace, input.collection, 'semantic', input.limit,
  );

  // Filter by min_score and type
  let filtered = results.filter(r => r.score >= input.min_score);
  if (input.type) {
    filtered = filtered.filter(r => r.type === input.type);
  }
  if (input.tags && input.tags.length > 0) {
    filtered = filtered.filter(r => input.tags!.some(t => r.tags.includes(t)));
  }

  return { results: filtered };
}

async function handleForget(ctx: ToolContext, args: unknown, clientId: string): Promise<{ deleted: boolean; id: string }> {
  const input = parseInput(ForgetInputSchema, args);
  const mem = ctx.storage.sqlite.getMemoryById(input.id);
  if (!mem) throw notFound(`Memory ${input.id} not found`);

  const deleted = await ctx.storage.deleteMemory(input.id);
  if (deleted) {
    ctx.storage.logAudit('FORGET', input.id, mem.namespace, clientId);
  }

  ctx.metrics.setGauge('bhgbrain_memory_count', ctx.storage.sqlite.countMemories());
  return { deleted, id: input.id };
}

async function handleSearch(ctx: ToolContext, args: unknown): Promise<{ results: SearchResult[] }> {
  const input = parseInput(SearchInputSchema, args);
  const results = await ctx.search.search(
    input.query, input.namespace, input.collection, input.mode, input.limit,
  );
  return { results };
}

async function handleTag(ctx: ToolContext, args: unknown): Promise<{ id: string; tags: string[] }> {
  const input = parseInput(TagInputSchema, args);
  const mem = ctx.storage.sqlite.getMemoryById(input.id);
  if (!mem) throw notFound(`Memory ${input.id} not found`);

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

async function handleCollections(ctx: ToolContext, args: unknown): Promise<unknown> {
  const input = parseInput(CollectionsInputSchema, args);
  const namespace = input.namespace;

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
        const removed = await ctx.storage.deleteCollectionData(namespace, input.name);
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
