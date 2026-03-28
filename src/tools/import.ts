import { z } from 'zod';
import type { ToolContext } from './index.js';
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

interface ImportSummary {
  dry_run: boolean;
  format: string;
  memories_created: number;
  duplicates_skipped: number;
  collections: string[];
  sections_processed?: number;
  previews?: MemoryPreview[];
}

export async function handleImport(ctx: ToolContext, args: unknown): Promise<ImportSummary> {
  const input = parseImportInput(args);
  const parser = new ProfileParser();

  let parsed: { memories: ParsedMemory[]; sectionsProcessed?: number[] };

  if (input.format === 'profile') {
    const result = parser.parseProfile(input.content);
    parsed = { memories: result.memories, sectionsProcessed: result.sectionsProcessed };
  } else {
    parsed = parser.parseFreeform(input.content);
  }

  if (input.dry_run) {
    return buildDryRunSummary(input, parsed);
  }

  return processMemories(ctx, input, parsed);
}

function parseImportInput(args: unknown): ImportInput {
  try {
    return ImportInputSchema.parse(args);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const messages = err.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
      throw invalidInput(messages);
    }
    throw err;
  }
}

function buildDryRunSummary(
  input: ImportInput,
  parsed: { memories: ParsedMemory[]; sectionsProcessed?: number[] },
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
    previews,
  };
}

async function processMemories(
  ctx: ToolContext,
  input: ImportInput,
  parsed: { memories: ParsedMemory[]; sectionsProcessed?: number[] },
): Promise<ImportSummary> {
  let memoriesCreated = 0;
  let duplicatesSkipped = 0;
  const collectionsSet = new Set<string>();

  for (const mem of parsed.memories) {
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
    });

    for (const result of results) {
      if (result.operation === 'NOOP') {
        duplicatesSkipped++;
      } else {
        memoriesCreated++;
        collectionsSet.add(mem.collection);
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
  };
}
