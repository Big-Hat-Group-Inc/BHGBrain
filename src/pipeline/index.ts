import { v4 as uuidv4 } from 'uuid';
import type { BrainConfig } from '../config/index.js';
import type { StorageManager } from '../storage/index.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import type { MemoryType, MemorySource, WriteOperation, MemoryRecord, WriteResult } from '../domain/types.js';
import { normalizeContent, computeChecksum, generateSummary, containsSecret } from '../domain/normalize.js';
import { invalidInput, internal } from '../errors/index.js';

interface MemoryCandidate {
  content: string;
  type?: MemoryType;
  tags: string[];
  importance?: number;
}

export class WritePipeline {
  constructor(
    private config: BrainConfig,
    private storage: StorageManager,
    private embedding: EmbeddingProvider,
  ) {}

  async process(input: {
    content: string;
    namespace: string;
    collection: string;
    type?: MemoryType;
    tags: string[];
    category?: string;
    importance?: number;
    source: MemorySource;
    clientId?: string;
  }): Promise<WriteResult[]> {
    const normalized = normalizeContent(input.content);

    if (containsSecret(normalized)) {
      throw invalidInput('Content appears to contain credentials or secrets. Memory rejected for safety.');
    }

    // Phase A: Extraction
    const candidates = this.extract(normalized, input);

    // Phase B: Decision per candidate
    const results: WriteResult[] = [];
    for (const candidate of candidates) {
      const result = await this.decide(candidate, input);
      results.push(result);
    }

    return results;
  }

  private extract(
    normalized: string,
    input: { type?: MemoryType; tags: string[]; importance?: number },
  ): MemoryCandidate[] {
    // In v1, extraction is simplified - produce single candidate
    // LLM-based extraction would split multi-fact content into atomic candidates
    if (!this.config.pipeline.extraction_enabled) {
      return [{
        content: normalized,
        type: input.type,
        tags: input.tags,
        importance: input.importance,
      }];
    }

    // For now, deterministic single-candidate extraction
    // Full LLM extraction would use the extraction model to split content
    return [{
      content: normalized,
      type: input.type,
      tags: input.tags,
      importance: input.importance,
    }];
  }

  private async decide(
    candidate: MemoryCandidate,
    input: {
      namespace: string;
      collection: string;
      category?: string;
      source: MemorySource;
      clientId?: string;
    },
  ): Promise<WriteResult> {
    const checksum = computeChecksum(candidate.content);
    const now = new Date().toISOString();

    // Step 1: Exact dedup by checksum
    const exactMatch = this.storage.sqlite.getMemoryByChecksum(input.namespace, checksum);
    if (exactMatch) {
      return {
        id: exactMatch.id,
        summary: exactMatch.summary,
        type: exactMatch.type,
        operation: 'NOOP',
        created_at: exactMatch.created_at,
      };
    }

    // Step 2: Get embedding
    let vector: number[];
    try {
      vector = await this.embedding.embed(candidate.content);
    } catch (err) {
      if (this.config.pipeline.fallback_to_threshold_dedup) {
        return this.deterministicFallback(candidate, input, checksum, now);
      }
      throw err;
    }

    // Step 3: Similarity search for near-dedup
    const similar = await this.storage.qdrant.searchSimilar(
      input.namespace,
      input.collection,
      vector,
      10,
    );

    const operation = this.classifyOperation(similar);
    const resolvedType = candidate.type ?? 'semantic';
    const summary = generateSummary(candidate.content);
    const importance = candidate.importance ?? 0.5;

    if (operation.op === 'NOOP' && operation.targetId) {
      const existing = this.storage.sqlite.getMemoryById(operation.targetId);
      if (!existing) {
        throw internal(`NOOP target ${operation.targetId} not found`);
      }
      return {
        id: existing.id,
        summary: existing.summary,
        type: existing.type,
        operation: 'NOOP',
        created_at: existing.created_at,
      };
    }

    if (operation.op === 'UPDATE' && operation.targetId) {
      const existing = this.storage.sqlite.getMemoryById(operation.targetId);
      if (existing) {
        const mergedTags = [...new Set([...existing.tags, ...candidate.tags])];
        await this.storage.updateMemory(operation.targetId, {
          content: candidate.content,
          summary,
          tags: mergedTags,
          checksum,
          importance: Math.max(existing.importance, importance),
          last_operation: 'UPDATE',
          updated_at: now,
        }, vector);

        this.storage.logAudit('UPDATE', operation.targetId, input.namespace, input.clientId);

        return {
          id: operation.targetId,
          summary,
          type: existing.type,
          operation: 'UPDATE',
          merged_with_id: operation.targetId,
          created_at: existing.created_at,
        };
      }
    }

    // ADD: new memory
    const id = uuidv4();
    const mem: Omit<MemoryRecord, 'embedding'> = {
      id,
      namespace: input.namespace,
      collection: input.collection,
      type: resolvedType,
      category: input.category ?? null,
      content: candidate.content,
      summary,
      tags: candidate.tags,
      source: input.source,
      checksum,
      importance,
      access_count: 0,
      last_operation: 'ADD',
      merged_from: null,
      created_at: now,
      updated_at: now,
      last_accessed: now,
    };

    await this.storage.writeMemory(mem, vector);
    this.storage.logAudit('ADD', id, input.namespace, input.clientId);

    return {
      id,
      summary,
      type: resolvedType,
      operation: 'ADD',
      created_at: now,
    };
  }

  private classifyOperation(
    similar: Array<{ id: string; score: number }>,
  ): { op: WriteOperation; targetId?: string } {
    if (similar.length === 0) return { op: 'ADD' };

    const top = similar[0]!;
    const threshold = this.config.deduplication.similarity_threshold;

    if (top.score >= 0.98) {
      return { op: 'NOOP', targetId: top.id };
    }
    if (top.score >= threshold) {
      return { op: 'UPDATE', targetId: top.id };
    }
    return { op: 'ADD' };
  }

  private deterministicFallback(
    candidate: MemoryCandidate,
    input: {
      namespace: string;
      collection: string;
      category?: string;
      source: MemorySource;
      clientId?: string;
    },
    checksum: string,
    now: string,
  ): WriteResult {
    // No embedding available: just ADD with zero vector
    const id = uuidv4();
    const resolvedType = candidate.type ?? 'semantic';
    const summary = generateSummary(candidate.content);

    const mem: Omit<MemoryRecord, 'embedding'> = {
      id,
      namespace: input.namespace,
      collection: input.collection,
      type: resolvedType,
      category: input.category ?? null,
      content: candidate.content,
      summary,
      tags: candidate.tags,
      source: input.source,
      checksum,
      importance: candidate.importance ?? 0.5,
      access_count: 0,
      last_operation: 'ADD',
      merged_from: null,
      created_at: now,
      updated_at: now,
      last_accessed: now,
    };

    // Store in SQLite only (no vector without embedding)
    this.storage.sqlite.insertMemory(mem);
    this.storage.sqlite.flushIfDirty();
    this.storage.logAudit('ADD', id, input.namespace, input.clientId);

    return {
      id,
      summary,
      type: resolvedType,
      operation: 'ADD',
      created_at: now,
    };
  }
}
