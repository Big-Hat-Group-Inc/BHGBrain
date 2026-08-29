import { v4 as uuidv4 } from 'uuid';
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
  RevisionsInputSchema, ReviewInputSchema, ConsolidateInputSchema,
  RelateInputSchema, FeedbackInputSchema,
  type RepairInput, type ConsolidateInput,
} from '../domain/schemas.js';
import type {
  WriteResult, SearchResult, MemoryRecord, MemoryRevisionRecord, RecallFilter,
} from '../domain/types.js';
import { BrainError, invalidInput, notFound, conflict } from '../errors/index.js';
import { computeChecksum } from '../domain/normalize.js';
import { MemoryLifecycleService } from '../domain/lifecycle.js';
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
  // Fires after a successful collection create/delete or category set/delete
  // so a connected MCP client can be told `collection://list` /
  // `category://list` changed (task 5.1). Wired only by the stdio transport
  // to `server.sendResourceListChanged()` (fire-and-forget, errors logged at
  // debug); left `undefined` on the REST path, where it is a no-op.
  notifyResourceListChanged?: () => void;
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
      const messages = err.issues.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
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
    case 'revisions': return handleRevisions(ctx, args, clientId, logCtx);
    case 'review': return handleReview(ctx, args, clientId, logCtx);
    case 'feedback': return handleFeedback(ctx, args, clientId, logCtx);
    case 'relate': return handleRelate(ctx, args, clientId, logCtx);
    case 'repair': return handleRepair(ctx, args);
    case 'consolidate': return handleConsolidate(ctx, args, clientId, logCtx);
    default:
      throw invalidInput(`Unknown tool: ${toolName}`);
  }
}

async function handleRemember(
  ctx: ToolContext, args: unknown, clientId: string, logCtx: ToolLogContext,
): Promise<WriteResult | WriteResult[]> {
  const input = parseInput(RememberInputSchema, args);
  logCtx.namespace = input.namespace;

  // Long-content guard (add-long-content-chunking): only `remember` passes raw,
  // unchunked caller content into the pipeline — `import` and `bootstrap` already
  // pre-split their candidates, so this check is deliberately scoped here rather
  // than inside `WritePipeline.process`. Content strictly over the threshold is
  // rejected before any embedding call or pipeline invocation; content at or under
  // it is unaffected.
  const threshold = ctx.config.pipeline.long_content_threshold_chars;
  if (input.content.length > threshold) {
    throw invalidInput(
      `Content is ${input.content.length} characters, which exceeds the ` +
      `${threshold}-character limit for remember. Use the import tool with ` +
      `format: "freeform" to store long content as chunked, independently-embedded ` +
      `memories, or split this content into smaller remember calls.`,
    );
  }

  // Pin cap enforced at write time (add-inject-pinning): whether this call
  // resolves to an ADD or an UPDATE of an as-yet-unpinned memory is only
  // known deep inside the dedup pipeline, so this is a conservative
  // namespace-wide check against an explicit `pinned: true` rather than a
  // precise "would this newly pin a memory" check — the same simplification
  // `tag`'s dedicated toggle (which does know the exact target) doesn't need.
  if (input.pinned === true) {
    const limit = ctx.config.defaults.pin_limit_per_namespace;
    if (ctx.storage.sqlite.countPinnedMemories(input.namespace) >= limit) {
      throw invalidInput(
        `Namespace "${input.namespace}" already has ${limit} pinned memories ` +
        `(defaults.pin_limit_per_namespace). Unpin one before pinning another.`,
      );
    }
  }

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
    pinned: input.pinned,
    origin: input.origin ?? undefined,
    confidence: input.confidence,
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

  // Push type/tags/after/before down into the store instead of discovering the
  // mismatch only after `limit` candidates are already spent
  // (push-down-recall-filters, extended by add-time-scoped-recall): omitted
  // entirely when nothing was requested, so an unfiltered recall's store call
  // is identical to before this parameter existed.
  const filter: RecallFilter | undefined = (
    input.type !== undefined || (input.tags?.length ?? 0) > 0
    || input.after !== undefined || input.before !== undefined
  )
    ? { type: input.type, tags: input.tags, after: input.after, before: input.before }
    : undefined;

  // Over-fetch modestly beyond `limit` so the expired-memory exclusion inside
  // `buildSearchResults` cannot starve the caller's limit even once the
  // store already narrows candidates down to matching memories. Capped so a
  // filtered recall never asks the store for an unbounded candidate pool.
  // When MMR is eligible (recall is semantic-only, so no mode check is
  // needed), widen the pool further using the config-driven formula so there
  // is genuine diversity headroom beyond `limit` (add-mmr-diversity-reranking).
  const baseFetchLimit = ctx.config.search.mmr.enabled
    ? Math.min(input.limit * ctx.config.search.mmr.candidate_pool_multiplier, ctx.config.search.mmr.candidate_pool_cap)
    : Math.min(input.limit * 2, 40);

  // When reranking is enabled, widen the pool at least up to
  // `search.rerank.candidate_pool` (capped at 40, the same ceiling the
  // pre-rerank formula already used) so the rerank stage has a meaningful
  // pool to score even for a small `limit`, without ever narrowing whatever
  // MMR already widened it to (add-opt-in-rerank-stage).
  const fetchLimit = ctx.config.search.rerank.enabled
    ? Math.max(baseFetchLimit, Math.min(ctx.config.search.rerank.candidate_pool, 40))
    : baseFetchLimit;

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
  if (input.after !== undefined) {
    filtered = filtered.filter(r => r.created_at >= input.after!);
  }
  if (input.before !== undefined) {
    filtered = filtered.filter(r => r.created_at <= input.before!);
  }
  if (filtered.length < beforeDefensiveCheck) {
    ctx.metrics.incCounter('recall_zero_after_filter');
  }

  // Opt-in LLM rerank stage (add-opt-in-rerank-stage): runs after the
  // defensive type/tag/date re-check and before `min_score` filtering, so a
  // rerank score never influences filter membership — only ordering.
  // `SearchService.rerank` already degrades to the pre-rerank list
  // internally on any provider failure (mirroring `hybridSearch`'s
  // embedding-degradation path), so this try/catch is defense in depth —
  // it guarantees `recall` cannot fail because reranking failed even if
  // that internal contract is ever violated.
  if (ctx.config.search.rerank.enabled) {
    try {
      filtered = await ctx.search.rerank(input.query, filtered, ctx.config.search.rerank.candidate_pool);
    } catch (err) {
      ctx.metrics.incCounter('search_rerank_degraded');
      ctx.logger.warn({
        event: 'rerank_degraded',
        message: (err as Error).message,
      });
    }
  }

  // min_score is calibrated for cosine similarity, so it is applied to
  // `semantic_score` explicitly (falling back to `score` only when
  // `semantic_score` is unavailable) rather than the mode-adjusted `score`
  // field recall previously thresholded — `handleRecall` hardcodes semantic
  // mode, but this keeps the comparison correct if that ever changes.
  filtered = filtered.filter(r => (r.semantic_score ?? r.score) >= input.min_score);

  const sliced = filtered.slice(0, input.limit);

  if (!input.follow_links) {
    return { results: sliced };
  }

  // One-hop neighbor expansion (add-memory-links): runs on the final,
  // limit-sliced result set (not the wider pre-slice candidate pool) so the
  // number of memories whose links get looked up is bounded by `input.limit`
  // regardless of how large `fetchLimit`'s over-fetch was. See design.md
  // "`follow_links` expansion happens in `handleRecall`".
  const baseIds = new Set(sliced.map(r => r.id));
  const appendedIds = new Set<string>();
  const neighbors: SearchResult[] = [];

  for (const base of sliced) {
    if (neighbors.length >= input.limit) break;
    const links = ctx.storage.sqlite.listMemoryLinks(base.id);
    for (const link of links) {
      if (neighbors.length >= input.limit) break;
      const otherId = link.direction === 'outgoing' ? link.to_id : link.from_id;
      if (baseIds.has(otherId) || appendedIds.has(otherId)) continue;

      // Default (non-archived-only) lookup: a link to a now-archived memory
      // contributes nothing recallable, so it is silently skipped.
      const neighborMem = ctx.storage.sqlite.getMemoryById(otherId);
      if (!neighborMem) continue;

      appendedIds.add(otherId);
      neighbors.push({
        id: neighborMem.id,
        content: neighborMem.content,
        summary: neighborMem.summary,
        type: neighborMem.type,
        tags: neighborMem.tags,
        score: 0,
        retention_tier: neighborMem.retention_tier,
        expires_at: neighborMem.expires_at,
        device_id: neighborMem.device_id ?? null,
        created_at: neighborMem.created_at,
        last_accessed: neighborMem.last_accessed,
        linked_from: base.id,
        link_relation: link.relation,
        link_direction: link.direction,
      });
    }
  }

  return { results: [...sliced, ...neighbors] };
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

  // `search` gains its first pushed-down filter here (add-time-scoped-recall):
  // still `undefined` when neither bound is requested, so an unfiltered
  // search's store call is unchanged. `search` has no `type`/`tags`
  // parameters, so this filter is `after`/`before` only.
  const filter: RecallFilter | undefined = (input.after !== undefined || input.before !== undefined)
    ? { after: input.after, before: input.before }
    : undefined;

  // When MMR is eligible (mode carries vectors, `search.mmr.enabled`), fetch a
  // wider pool using the same formula as `handleRecall` so there is genuine
  // diversity headroom beyond `limit`; otherwise fetch exactly `input.limit`
  // as before (add-mmr-diversity-reranking). `search()` no longer returns an
  // exactly-`limit`-sized array in the MMR-eligible case, so the explicit
  // `.slice(0, input.limit)` below truncates after filtering, mirroring how
  // `handleRecall` already truncates after its own filtering.
  const searchFetchLimit = input.mode !== 'fulltext' && ctx.config.search.mmr.enabled
    ? Math.min(input.limit * ctx.config.search.mmr.candidate_pool_multiplier, ctx.config.search.mmr.candidate_pool_cap)
    : input.limit;

  const results = await ctx.search.search(
    input.query, input.namespace, input.collection, input.mode, searchFetchLimit, signal,
    filter, input.include_archived,
  );

  // Defensive post-retrieval re-check for after/before, mirroring `handleRecall`'s
  // type/tags re-check: the store is the primary filtering mechanism, so this
  // should be a no-op in steady state, and its removals are counted separately
  // from `recall`'s counter since they are scoped to a different tool.
  const beforeDefensiveCheck = results.length;
  let filtered = results;
  if (input.after !== undefined) {
    filtered = filtered.filter(r => r.created_at >= input.after!);
  }
  if (input.before !== undefined) {
    filtered = filtered.filter(r => r.created_at <= input.before!);
  }
  if (filtered.length < beforeDefensiveCheck) {
    ctx.metrics.incCounter('search_zero_after_filter');
  }

  // `degraded` is true when hybrid mode fell back to fulltext-only (embedding /
  // vector store unavailable), so callers can tell it from a healthy result.
  return { results: filtered.slice(0, input.limit), degraded: signal.degraded ?? false };
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

  // Pin cap enforced at write time (add-inject-pinning): only checked when
  // this call would newly pin a memory not already pinned — re-pinning an
  // already-pinned memory, or unpinning, never trips it.
  if (input.pinned === true && !mem.pinned) {
    const limit = ctx.config.defaults.pin_limit_per_namespace;
    if (ctx.storage.sqlite.countPinnedMemories(mem.namespace) >= limit) {
      throw invalidInput(
        `Namespace "${mem.namespace}" already has ${limit} pinned memories ` +
        `(defaults.pin_limit_per_namespace). Unpin one before pinning another.`,
      );
    }
  }

  ctx.storage.sqlite.updateMemory(input.id, {
    tags,
    updated_at: new Date().toISOString(),
    ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
  });
  ctx.storage.sqlite.flushIfDirty();

  return { id: input.id, tags };
}

async function handleRevisions(
  ctx: ToolContext, args: unknown, clientId: string, logCtx: ToolLogContext,
): Promise<{ id: string; revisions: MemoryRevisionRecord[] } | { id: string; revision: number; content: string }> {
  const input = parseInput(RevisionsInputSchema, args);
  const mem = ctx.storage.sqlite.getMemoryById(input.id);
  if (!mem) throw notFound(`Memory ${input.id} not found`);
  logCtx.namespace = mem.namespace;

  if (input.action === 'list') {
    return { id: input.id, revisions: ctx.storage.sqlite.listRevisions(input.id) };
  }

  // 'revert' — schema's refine already guarantees `revision` is present here.
  const updated = await ctx.storage.revertMemory(input.id, input.revision!, clientId);
  return { id: input.id, revision: input.revision!, content: updated.content };
}

// Closes the read side of the tiered lifecycle (add-review-and-archive-recall):
// `list` surfaces T1 memories whose `review_due` has lapsed (or falls within a
// look-ahead window); `keep`/`archive`/`restore` disposition them. Content
// revision is deliberately not duplicated here — that stays `remember`'s
// UPDATE flow (design.md "one write path for content").
async function handleReview(
  ctx: ToolContext, args: unknown, clientId: string, logCtx: ToolLogContext,
): Promise<unknown> {
  const input = parseInput(ReviewInputSchema, args);
  logCtx.namespace = input.namespace;

  if (input.action === 'list') {
    const now = new Date();
    const before = new Date(now.getTime() + input.days * 24 * 60 * 60 * 1000).toISOString();
    const due = ctx.storage.sqlite.listReviewDue(input.namespace, before, input.limit, input.cursor);
    const last = due[due.length - 1];
    const cursor = due.length === input.limit && last?.review_due
      ? `${last.review_due}|${last.id}`
      : null;

    return {
      items: due.map(m => ({
        id: m.id,
        namespace: m.namespace,
        collection: m.collection,
        summary: m.summary,
        tags: m.tags,
        retention_tier: m.retention_tier,
        review_due: m.review_due,
        expires_at: m.expires_at,
      })),
      cursor,
    };
  }

  // Schema refine guarantees `id` is present for keep/archive/restore.
  const id = input.id!;
  const lifecycle = new MemoryLifecycleService(ctx.config);

  if (input.action === 'keep') {
    const mem = ctx.storage.sqlite.getMemoryById(id);
    if (!mem) throw notFound(`Memory ${id} not found`);
    logCtx.namespace = mem.namespace;

    const now = new Date();
    const nowIso = now.toISOString();
    // A human confirmation is at least as strong a signal as an automated
    // access, so `keep` re-applies the tier's full lifecycle policy
    // (review_due + expires_at) regardless of sliding-window configuration —
    // design.md: "explicit curation beats passive policy".
    const nextReviewDue = lifecycle.buildMetadata(mem.retention_tier, now).review_due;
    const nextExpiry = lifecycle.computeExpiry(mem.retention_tier, now);

    ctx.storage.sqlite.updateMemory(id, {
      review_due: nextReviewDue,
      expires_at: nextExpiry,
      updated_at: nowIso,
    });
    ctx.storage.sqlite.flushIfDirty();

    ctx.storage.logAudit('REVISE', id, mem.namespace, clientId, {
      details: {
        memory_id: id,
        prior_tier: mem.retention_tier,
        new_tier: mem.retention_tier,
        actor: clientId,
        timestamp: nowIso,
        action: 'revise',
      },
    });

    return { id, review_due: nextReviewDue, expires_at: nextExpiry };
  }

  if (input.action === 'archive') {
    const mem = ctx.storage.sqlite.getMemoryById(id);
    if (!mem) {
      // Already archived (row moved to memory_archive, gone from `memories`)
      // is a conflict, not a not-found — distinguishable from "never existed".
      if (ctx.storage.sqlite.getArchiveByMemoryId(id)) {
        throw conflict(`Memory ${id} is already archived`);
      }
      throw notFound(`Memory ${id} not found`);
    }
    logCtx.namespace = mem.namespace;

    const nowIso = new Date().toISOString();
    ctx.storage.sqlite.archiveMemory(mem, nowIso);
    try {
      await ctx.storage.deleteMemory(id);
    } catch (err) {
      // Vector/SQLite removal failed: undo the archive row so the memory
      // isn't left both live and archived.
      ctx.storage.sqlite.deleteArchive(id);
      ctx.storage.sqlite.flushIfDirty();
      throw err;
    }

    ctx.storage.logAudit('ARCHIVE', id, mem.namespace, clientId, {
      details: {
        memory_id: id,
        prior_tier: mem.retention_tier,
        new_tier: null,
        actor: clientId,
        timestamp: nowIso,
        action: 'archive',
      },
    });
    ctx.metrics.setGauge('bhgbrain_memory_count', ctx.storage.sqlite.countMemories());
    return { id, archived: true };
  }

  // 'restore'
  const archived = ctx.storage.sqlite.getArchiveByMemoryId(id);
  if (!archived) throw notFound(`Archived memory ${id} not found`);
  logCtx.namespace = archived.namespace;

  const now = new Date();
  const nowIso = now.toISOString();
  const metadata = lifecycle.buildMetadata(archived.tier, now);
  // Provenance-carrying stub: content is the retained summary (archive rows
  // keep no content/vector), tagged so it's identifiable as a restore rather
  // than implying the original memory survived intact.
  const tags = [...new Set([...archived.tags, 'restored-from-archive'])];
  const content = archived.summary;
  const restoredId = uuidv4();

  const memory: Omit<MemoryRecord, 'embedding'> = {
    id: restoredId,
    namespace: archived.namespace,
    collection: 'general',
    type: 'semantic',
    category: null,
    content,
    summary: archived.summary,
    tags,
    source: 'cli',
    checksum: computeChecksum(content),
    importance: 0.5,
    retention_tier: archived.tier,
    expires_at: metadata.expires_at,
    decay_eligible: metadata.decay_eligible,
    review_due: metadata.review_due,
    access_count: 0,
    last_operation: 'ADD',
    merged_from: null,
    archived: false,
    vector_synced: true,
    // Archive rows carry no pin state, so a `review restore` never
    // resurrects a memory as pinned.
    pinned: false,
    device_id: ctx.config.device.id ?? null,
    // Archive rows carry no origin/confidence either, so this restore has
    // no provenance to recover — same "legacy row" default as elsewhere.
    origin: null,
    confidence: 1.0,
    created_at: nowIso,
    updated_at: nowIso,
    last_accessed: nowIso,
  };

  const vector = await ctx.embedding.embed(content);
  await ctx.storage.writeMemory(memory, vector);

  // Archive row is retained (not deleted) so the origin stays inspectable —
  // this deliberately differs from the CLI's `archive restore` path, which
  // deletes the archive row after restoring.
  ctx.storage.logAudit('RESTORE', restoredId, archived.namespace, clientId, {
    details: {
      memory_id: restoredId,
      prior_tier: null,
      new_tier: archived.tier,
      actor: clientId,
      timestamp: nowIso,
      action: 'restore',
    },
  });

  ctx.metrics.setGauge('bhgbrain_memory_count', ctx.storage.sqlite.countMemories());
  return { id: restoredId, restored_from: archived.memory_id, archive_id: archived.id, restored: true };
}

// Records whether a previously recalled/searched memory was useful, as an
// append-only event (add-recall-feedback-signal). Purely additive: no
// aggregation, no read surface, no effect on ranking or lifecycle in this
// version — see design.md Non-Goals.
async function handleFeedback(
  ctx: ToolContext, args: unknown, clientId: string, logCtx: ToolLogContext,
): Promise<{ id: string; useful: boolean; recorded_at: string }> {
  const input = parseInput(FeedbackInputSchema, args);
  const mem = ctx.storage.sqlite.getMemoryById(input.id);
  if (!mem) throw notFound(`Memory ${input.id} not found`);
  logCtx.namespace = mem.namespace;

  const created_at = new Date().toISOString();
  ctx.storage.sqlite.recordFeedback({
    memory_id: input.id,
    namespace: mem.namespace,
    query: input.query ?? null,
    score: input.score ?? null,
    useful: input.useful,
    client_id: clientId,
    created_at,
  });
  ctx.storage.sqlite.flushIfDirty();

  return { id: input.id, useful: input.useful, recorded_at: created_at };
}

// Directed, typed edges between memories (add-memory-links): `add`/`list`/
// `remove` a general, caller-authored relationship alongside the write
// pipeline's automatic `merged_from` replacement pointer (deliberately left
// untouched — narrower, automatic concept). See design.md "Directed edges,
// symmetric relations included".
async function handleRelate(
  ctx: ToolContext, args: unknown, clientId: string, logCtx: ToolLogContext,
): Promise<unknown> {
  const input = parseInput(RelateInputSchema, args);

  if (input.action === 'add') {
    const fromId = input.from_id!;
    const toId = input.to_id!;
    const relation = input.relation!;

    if (fromId === toId) {
      throw invalidInput('from_id and to_id must differ');
    }

    const fromMem = ctx.storage.sqlite.getMemoryById(fromId);
    if (!fromMem) throw notFound(`Memory ${fromId} not found`);
    const toMem = ctx.storage.sqlite.getMemoryById(toId);
    if (!toMem) throw notFound(`Memory ${toId} not found`);

    if (fromMem.namespace !== toMem.namespace) {
      throw invalidInput(
        `from_id ${fromId} belongs to namespace "${fromMem.namespace}", but to_id ${toId} belongs to "${toMem.namespace}"`,
      );
    }
    logCtx.namespace = fromMem.namespace;

    const { record, created } = ctx.storage.sqlite.addMemoryLink(
      fromMem.namespace, fromId, toId, relation, clientId,
    );
    ctx.storage.sqlite.flushIfDirty();

    return {
      id: record.id,
      namespace: record.namespace,
      from_id: record.from_id,
      to_id: record.to_id,
      relation: record.relation,
      created_at: record.created_at,
      created,
    };
  }

  if (input.action === 'remove') {
    const fromId = input.from_id!;
    const toId = input.to_id!;
    const relation = input.relation!;
    const removed = ctx.storage.sqlite.removeMemoryLink(fromId, toId, relation);
    if (!removed) throw notFound(`Link ${fromId} -> ${toId} (${relation}) not found`);
    ctx.storage.sqlite.flushIfDirty();
    return { removed: true, from_id: fromId, to_id: toId, relation };
  }

  // 'list' — schema refine guarantees `id` is present here.
  const id = input.id!;
  // Archived-inclusive lookup so links on an about-to-be-archived memory
  // remain listable.
  const mem = ctx.storage.sqlite.getMemoryById(id, true);
  if (!mem) throw notFound(`Memory ${id} not found`);
  logCtx.namespace = mem.namespace;

  let links = ctx.storage.sqlite.listMemoryLinks(id, input.relation ? { relation: input.relation } : undefined);
  if (input.direction !== 'both') {
    const wanted: 'outgoing' | 'incoming' = input.direction === 'from' ? 'outgoing' : 'incoming';
    links = links.filter(l => l.direction === wanted);
  }

  return {
    id,
    links: links.map(l => ({
      id: l.id,
      from_id: l.from_id,
      to_id: l.to_id,
      relation: l.relation,
      direction: l.direction,
      created_at: l.created_at,
      created_by: l.created_by,
    })),
  };
}

interface ConsolidateClusterMember {
  id: string;
  summary: string;
  tags: string[];
  importance: number;
  access_count: number;
  updated_at: string;
}

interface ConsolidateCluster {
  members: ConsolidateClusterMember[];
  suggested_target: string;
}

// Closes the read-side gap write-time dedup leaves open for imports and
// degraded-window writes (add-duplicate-cluster-consolidation): `list`
// discovers clusters of near-duplicate *existing* memories via bounded,
// paginated per-point ANN neighbor queries (no full pairwise scan); `merge`
// consolidates an explicit, human-chosen cluster into one target, reusing
// `review`'s archive-transition code path per source.
async function handleConsolidate(
  ctx: ToolContext, args: unknown, clientId: string, logCtx: ToolLogContext,
): Promise<unknown> {
  const input = parseInput(ConsolidateInputSchema, args);
  logCtx.namespace = input.namespace;

  if (!ctx.config.consolidation.enabled) {
    throw invalidInput('The consolidate tool is disabled (consolidation.enabled = false)');
  }

  if (input.action === 'list') {
    return handleConsolidateList(ctx, input);
  }
  return handleConsolidateMerge(ctx, input, clientId);
}

async function handleConsolidateList(
  ctx: ToolContext, input: ConsolidateInput,
): Promise<{ clusters: ConsolidateCluster[]; cursor: string | null }> {
  const { namespace, collection } = input;
  const maxScan = ctx.config.consolidation.max_scan_per_call;
  const page = ctx.storage.sqlite.listMemoriesInCollection(namespace, collection, maxScan, input.cursor);

  const byId = new Map(page.map(m => [m.id, m]));
  const parent = new Map<string, string>();
  for (const m of page) parent.set(m.id, m.id);

  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const m of page) {
    const neighbors = await ctx.storage.qdrant.findNeighborsById(
      namespace, collection, m.id,
      ctx.config.consolidation.neighbor_top_k,
      ctx.config.consolidation.similarity_threshold,
    );
    for (const n of neighbors) {
      // Only edges between memories both present in this scanned page can be
      // clustered — metadata for the suggested-target tie-break is only
      // available for page members (design.md: "union-find over the page's
      // neighbor edges").
      if (byId.has(n.id)) {
        union(m.id, n.id);
      }
    }
  }

  const groups = new Map<string, string[]>();
  for (const m of page) {
    const root = find(m.id);
    const arr = groups.get(root) ?? [];
    arr.push(m.id);
    groups.set(root, arr);
  }

  const clusters: ConsolidateCluster[] = [];
  for (const ids of groups.values()) {
    if (ids.length < input.min_cluster_size) continue;
    const members = ids.map(id => byId.get(id)!);
    const suggested = members.reduce((best, cur) => {
      if (cur.importance !== best.importance) return cur.importance > best.importance ? cur : best;
      if (cur.access_count !== best.access_count) return cur.access_count > best.access_count ? cur : best;
      return cur.updated_at > best.updated_at ? cur : best;
    });
    clusters.push({
      members: members.map(m => ({
        id: m.id, summary: m.summary, tags: m.tags,
        importance: m.importance, access_count: m.access_count, updated_at: m.updated_at,
      })),
      suggested_target: suggested.id,
    });
  }

  const last = page[page.length - 1];
  const cursor = page.length === maxScan && last
    ? `${last.created_at}|${last.id}`
    : null;

  return { clusters, cursor };
}

async function handleConsolidateMerge(
  ctx: ToolContext, input: ConsolidateInput, clientId: string,
): Promise<{ target_id: string; merged: string[]; failed: string[] }> {
  const targetId = input.target_id!;
  const sourceIds = input.source_ids!;

  const target = ctx.storage.sqlite.getMemoryById(targetId);
  if (!target) throw notFound(`Target memory ${targetId} not found`);

  // Resolve every source up front, before any mutation: an unknown id or a
  // namespace/collection mismatch rejects the whole request without
  // archiving anything (spec: "No target/source overlap or cross-collection
  // merge"). Already-archived sources are excluded from the merge set
  // rather than rejected, so a retried merge over a partially-completed
  // attempt is safe (spec: "Retrying a partially completed merge").
  const liveSources: Array<Omit<MemoryRecord, 'embedding'>> = [];
  for (const id of sourceIds) {
    const mem = ctx.storage.sqlite.getMemoryById(id);
    if (mem) {
      if (mem.namespace !== target.namespace || mem.collection !== target.collection) {
        throw invalidInput(
          `Source ${id} belongs to namespace/collection "${mem.namespace}/${mem.collection}", ` +
          `but target ${targetId} belongs to "${target.namespace}/${target.collection}"`,
        );
      }
      liveSources.push(mem);
    } else if (!ctx.storage.sqlite.getArchiveByMemoryId(id)) {
      throw notFound(`Source memory ${id} not found`);
    }
    // else: already archived — skipped (idempotent retry).
  }

  if (liveSources.length === 0) {
    return { target_id: targetId, merged: [], failed: [] };
  }

  const unionTags = new Set(target.tags);
  for (const s of liveSources) for (const t of s.tags) unionTags.add(t);
  const maxImportance = Math.max(target.importance, ...liveSources.map(s => s.importance));
  const mergedFromIds = liveSources.map(s => s.id);
  const mergedFrom = target.merged_from
    ? `${target.merged_from},${mergedFromIds.join(',')}`
    : mergedFromIds.join(',');

  // Metadata-only update: no newVector, so the target's content/embedding
  // are left untouched (spec: "target's content and embedding SHALL remain
  // unchanged").
  await ctx.storage.updateMemory(targetId, {
    tags: [...unionTags],
    importance: maxImportance,
    merged_from: mergedFrom,
    updated_at: new Date().toISOString(),
  });

  const merged: string[] = [];
  const failed: string[] = [];
  for (const source of liveSources) {
    const nowIso = new Date().toISOString();
    ctx.storage.sqlite.archiveMemory(source, nowIso);
    try {
      await ctx.storage.deleteMemory(source.id);
    } catch {
      // Vector/SQLite removal failed: undo the archive row so the source
      // isn't left both archived and live (same rollback `review`'s
      // `archive` action uses).
      ctx.storage.sqlite.deleteArchive(source.id);
      ctx.storage.sqlite.flushIfDirty();
      failed.push(source.id);
      continue;
    }

    ctx.storage.logAudit('ARCHIVE', source.id, source.namespace, clientId, {
      details: {
        memory_id: source.id,
        prior_tier: source.retention_tier,
        new_tier: null,
        actor: clientId,
        timestamp: nowIso,
        action: 'consolidate',
        merged_into: targetId,
      },
    });
    merged.push(source.id);
  }

  ctx.metrics.setGauge('bhgbrain_memory_count', ctx.storage.sqlite.countMemories());

  return { target_id: targetId, merged, failed };
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
      ctx.notifyResourceListChanged?.();
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
      ctx.notifyResourceListChanged?.();
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
      ctx.notifyResourceListChanged?.();
      return result;
    }

    case 'delete': {
      if (!input.name) throw invalidInput('name is required for delete');
      const removed = ctx.storage.sqlite.deleteCategory(input.name);
      if (!removed) throw notFound(`Category "${input.name}" not found`);
      ctx.storage.sqlite.flushIfDirty();
      ctx.notifyResourceListChanged?.();
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
        // Restore pin state from the recovered Qdrant payload rather than
        // defaulting it to false, so `repair --mode from-qdrant` preserves
        // it. See add-inject-pinning.
        pinned: typeof payload.pinned === 'boolean' ? payload.pinned : false,
        device_id: recoveredDeviceId,
        // Carry forward whatever identity the recovered vector was already
        // stamped with — this reconstructs a SQLite row from an existing
        // Qdrant point, not a new embedding, so it must not claim the active
        // configuration's identity. Missing on the payload means the point
        // predates provenance stamping and stays "unknown" (null).
        embedding_model: typeof payload.embedding_model === 'string' ? payload.embedding_model : null,
        // Same recovery posture as `embedding_model` above: carry forward
        // whatever content provenance the payload already carries rather
        // than inventing new provenance for a reconstructed row. A missing
        // or malformed field narrows to "unknown" (null / 1.0), mirroring
        // `SqliteStore.upsertMemoryFromPayload`. See
        // add-memory-provenance-metadata.
        origin: payload.origin !== null && typeof payload.origin === 'object' && !Array.isArray(payload.origin)
          ? payload.origin as MemoryRecord['origin']
          : null,
        confidence: typeof payload.confidence === 'number' ? payload.confidence : 1.0,
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
