import { z } from 'zod';
import type { ToolContext, ToolLogContext } from './index.js';
import type { WriteResult } from '../domain/types.js';
import { ProfileParser, type ParsedMemory } from '../pipeline/parser.js';
import { invalidInput } from '../errors/index.js';

export const ImportInputSchema = z.object({
  format: z.enum(['profile', 'freeform']),
  content: z.string().min(1, 'content is required').max(500000),
  namespace: z.string().regex(/^[a-zA-Z0-9/-]{1,200}$/).default('profile'),
  dry_run: z.boolean().default(false),
}).strict();

export type ImportInput = z.infer<typeof ImportInputSchema>;

interface MemoryPreview {
  content_snippet: string;
  collection: string;
  type: string;
  retention_tier: string;
  tags: string[];
  section?: number;
}

interface ImportChunkFailure {
  chunk_index: number;
  error: string;
}

interface ImportSummary {
  dry_run: boolean;
  format: string;
  memories_created: number;
  duplicates_skipped: number;
  collections: string[];
  sections_processed?: number;
  sections_ignored?: number[];
  previews?: MemoryPreview[];
  // Present only when at least one chunk failed to process — a per-item
  // failure never aborts the rest of the import (bound-corpus-scale-
  // workflows task 3.2's "preserving per-item outcomes").
  failed?: number;
  failures?: ImportChunkFailure[];
}

export async function handleImport(
  ctx: ToolContext, args: unknown, logCtx?: ToolLogContext,
): Promise<ImportSummary> {
  const input = parseImportInput(args);
  if (logCtx) logCtx.namespace = input.namespace;
  const parser = new ProfileParser();

  let parsed: { memories: ParsedMemory[]; sectionsProcessed?: number[]; sectionsIgnored?: number[] };

  if (input.format === 'profile') {
    const result = parser.parseProfile(input.content);
    parsed = {
      memories: result.memories,
      sectionsProcessed: result.sectionsProcessed,
      sectionsIgnored: result.sectionsIgnored,
    };
  } else {
    parsed = parser.parseFreeform(input.content);
  }

  // Bound amplification (bound-corpus-scale-workflows tasks 3.1/3.2) before
  // either the dry-run preview or any provider call sees the chunk set:
  // hard-split any oversized chunk deterministically, then reject the whole
  // call up front if the resulting chunk count still exceeds the configured
  // maximum — a dry run reports the same rejection a real run would, rather
  // than previewing a request that would only fail later.
  parsed = {
    ...parsed,
    memories: hardSplitOversizedChunks(parsed.memories, ctx.config.import.max_chunk_chars),
  };
  const maxChunks = ctx.config.import.max_chunks;
  if (parsed.memories.length > maxChunks) {
    throw invalidInput(
      `Import would create ${parsed.memories.length} memories, exceeding the configured maximum of ` +
      `${maxChunks} (import.max_chunks). Reduce the input size or raise import.max_chunks.`,
    );
  }

  if (input.dry_run) {
    return buildDryRunSummary(input, parsed);
  }

  return processMemories(ctx, input, parsed);
}

/**
 * Deterministically splits any chunk longer than `maxChars` into
 * `maxChars`-sized pieces (the last piece shorter), preserving every other
 * field unchanged — see design.md Decision #5 ("hard-splits chunks ...
 * before provider calls"). A chunk at or under the limit passes through as
 * a single-element result, so this is a no-op for the common case. Splitting
 * happens on a plain character offset (not a word/sentence boundary): the
 * bound is a hard safety ceiling against a "mush vector"/provider-rejected
 * embed, not a semantic re-chunker, and a deterministic offset keeps the
 * resulting chunk count and boundaries reproducible for the same input.
 */
function hardSplitOversizedChunks(memories: ParsedMemory[], maxChars: number): ParsedMemory[] {
  const result: ParsedMemory[] = [];
  for (const mem of memories) {
    if (mem.content.length <= maxChars) {
      result.push(mem);
      continue;
    }
    for (let offset = 0; offset < mem.content.length; offset += maxChars) {
      result.push({ ...mem, content: mem.content.slice(offset, offset + maxChars) });
    }
  }
  return result;
}

function parseImportInput(args: unknown): ImportInput {
  try {
    return ImportInputSchema.parse(args);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const messages = err.issues.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
      throw invalidInput(messages);
    }
    throw err;
  }
}

function buildDryRunSummary(
  input: ImportInput,
  parsed: { memories: ParsedMemory[]; sectionsProcessed?: number[]; sectionsIgnored?: number[] },
): ImportSummary {
  const collections = [...new Set(parsed.memories.map(m => m.collection))];
  const previews: MemoryPreview[] = parsed.memories.map(m => ({
    content_snippet: m.content.length > 200 ? m.content.slice(0, 200) + '...' : m.content,
    collection: m.collection,
    type: m.type,
    retention_tier: m.retention_tier,
    tags: m.tags,
    section: m.section,
  }));

  return {
    dry_run: true,
    format: input.format,
    memories_created: parsed.memories.length,
    duplicates_skipped: 0,
    collections,
    ...(parsed.sectionsProcessed ? { sections_processed: parsed.sectionsProcessed.length } : {}),
    ...(parsed.sectionsIgnored?.length ? { sections_ignored: parsed.sectionsIgnored } : {}),
    previews,
  };
}

async function processMemories(
  ctx: ToolContext,
  input: ImportInput,
  parsed: { memories: ParsedMemory[]; sectionsProcessed?: number[]; sectionsIgnored?: number[] },
): Promise<ImportSummary> {
  let memoriesCreated = 0;
  let duplicatesSkipped = 0;
  const collectionsSet = new Set<string>();
  const failures: ImportChunkFailure[] = [];

  const batchSize = ctx.config.import.embedding_batch_size;
  const memories = parsed.memories;

  for (let batchStart = 0; batchStart < memories.length; batchStart += batchSize) {
    const batch = memories.slice(batchStart, batchStart + batchSize);

    // Batch-embed the whole chunk group in one provider round trip (task
    // 3.2), so outbound embedding requests scale with chunk-count/batch-size
    // rather than one call per chunk. A batch failure (provider outage, a
    // malformed input) does not lose this batch's chunks: each simply falls
    // back to `WritePipeline.process()`'s own per-item embed call (with its
    // existing degraded-write handling) instead of the whole batch aborting.
    let vectors: Array<number[] | undefined> = new Array(batch.length).fill(undefined);
    try {
      vectors = await ctx.embedding.embedBatch(batch.map(m => m.content));
    } catch (err) {
      ctx.logger.warn({
        event: 'import_batch_embed_failed',
        batch_start: batchStart,
        batch_size: batch.length,
        error: (err as Error).message,
      });
    }

    for (const [offset, mem] of batch.entries()) {
      const chunkIndex = batchStart + offset;
      try {
        const results: WriteResult[] = await ctx.pipeline.process({
          content: mem.content,
          namespace: input.namespace,
          collection: mem.collection,
          type: mem.type,
          tags: mem.tags,
          importance: mem.importance,
          source: 'import',
          retention_tier: mem.retention_tier,
          device_id: ctx.config.device.id ?? null,
          precomputedEmbedding: vectors[offset],
        });

        for (const result of results) {
          if (result.operation === 'NOOP') {
            duplicatesSkipped++;
          } else {
            memoriesCreated++;
            collectionsSet.add(mem.collection);
          }
        }
      } catch (err) {
        // A single chunk's total failure (every extraction candidate
        // rejected — see WritePipeline.process()'s own re-throw) must not
        // abort the rest of the import; it is recorded and the loop
        // continues with the next chunk.
        failures.push({ chunk_index: chunkIndex, error: (err as Error).message });
        ctx.logger.warn({
          event: 'import_chunk_failed',
          chunk_index: chunkIndex,
          collection: mem.collection,
          error: (err as Error).message,
        });
      }
    }
  }

  ctx.metrics.setGauge('bhgbrain_memory_count', ctx.storage.sqlite.countMemories());

  return {
    dry_run: false,
    format: input.format,
    memories_created: memoriesCreated,
    duplicates_skipped: duplicatesSkipped,
    collections: [...collectionsSet],
    ...(parsed.sectionsProcessed ? { sections_processed: parsed.sectionsProcessed.length } : {}),
    ...(parsed.sectionsIgnored?.length ? { sections_ignored: parsed.sectionsIgnored } : {}),
    ...(failures.length > 0 ? { failed: failures.length, failures } : {}),
  };
}
