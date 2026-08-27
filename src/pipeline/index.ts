import { v4 as uuidv4 } from 'uuid';
import type { BrainConfig } from '../config/index.js';
import type { StorageManager } from '../storage/index.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import type { MemoryType, MemorySource, WriteOperation, MemoryRecord, WriteResult, RetentionTier } from '../domain/types.js';
import { normalizeContent, computeChecksum, generateSummary, containsSecret, detectsInvalidation } from '../domain/normalize.js';
import { MemoryLifecycleService } from '../domain/lifecycle.js';
import { invalidInput, internal } from '../errors/index.js';

interface MemoryCandidate {
  content: string;
  type?: MemoryType;
  tags: string[];
  importance?: number;
}

export class WritePipeline {
  private lifecycle: MemoryLifecycleService;

  constructor(
    private config: BrainConfig,
    private storage: StorageManager,
    private embedding: EmbeddingProvider,
    private logger?: { warn: (obj: Record<string, unknown>) => void },
  ) {
    this.lifecycle = new MemoryLifecycleService(config);
  }

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
    retention_tier?: RetentionTier;
    device_id?: string | null;
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
    // v1 extraction is deterministic and single-candidate only, regardless of
    // `pipeline.extraction_enabled` — the config knob is reserved for a future
    // model-backed extraction stage but has no effect on candidate count today.
    // TODO(bootstrap-memory-core): implement LLM-backed multi-candidate
    // extraction using `config.pipeline.extraction_model` to split multi-fact
    // content into atomic candidates, or retire `extraction_enabled` /
    // `extraction_model` if multi-candidate extraction stays out of scope.
    // The multi-candidate scenario is de-scoped for v1 in
    // `write-decision-pipeline/spec.md` until this lands.
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
      retention_tier?: RetentionTier;
      device_id?: string | null;
    },
  ): Promise<WriteResult> {
    const checksum = computeChecksum(candidate.content);
    const now = new Date().toISOString();
    const tier = this.lifecycle.assignTier({
      category: input.category,
      source: input.source,
      type: candidate.type,
      tags: candidate.tags,
      content: candidate.content,
      explicitTier: input.retention_tier,
    });
    const lifecycleMetadata = this.lifecycle.buildMetadata(tier, new Date(now));

    // Step 1: Exact dedup by checksum, scoped to the target collection
    const exactMatch = this.storage.sqlite.getMemoryByChecksum(input.namespace, checksum, input.collection);
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
        this.logger?.warn({
          event: 'degraded_write',
          namespace: input.namespace,
          collection: input.collection,
          error: (err as Error).message,
        });
        return await this.deterministicFallback(candidate, input, checksum, now);
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

    const operation = this.classifyOperation(candidate.content, similar, tier);
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
      if (!existing) {
        // A drifted store (Qdrant returned a target SQLite no longer has) must
        // surface as an error, never silently degrade into a duplicate ADD.
        throw internal(`UPDATE target ${operation.targetId} not found`);
      }

      const mergedTags = [...new Set([...existing.tags, ...candidate.tags])];
      await this.storage.updateMemory(operation.targetId, {
        content: candidate.content,
        summary,
        tags: mergedTags,
        checksum,
        importance: Math.max(existing.importance, importance),
        retention_tier: tier,
        expires_at: lifecycleMetadata.expires_at,
        decay_eligible: lifecycleMetadata.decay_eligible,
        review_due: lifecycleMetadata.review_due,
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

    if (operation.op === 'DELETE' && operation.targetId) {
      const existing = this.storage.sqlite.getMemoryById(operation.targetId);
      if (!existing) {
        throw internal(`DELETE target ${operation.targetId} not found`);
      }

      // Candidate explicitly invalidates the prior memory: remove the stale
      // record and persist the correction as a new memory, linked back via
      // `merged_from`/`merged_with_id` so the replacement lineage is visible.
      await this.storage.deleteMemory(operation.targetId);
      this.storage.logAudit('DELETE', operation.targetId, input.namespace, input.clientId);

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
        retention_tier: tier,
        expires_at: lifecycleMetadata.expires_at,
        decay_eligible: lifecycleMetadata.decay_eligible,
        review_due: lifecycleMetadata.review_due,
        access_count: 0,
        last_operation: 'DELETE',
        merged_from: operation.targetId,
        archived: false,
        vector_synced: true,
        device_id: input.device_id ?? null,
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
        operation: 'DELETE',
        merged_with_id: operation.targetId,
        created_at: now,
      };
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
      retention_tier: tier,
      expires_at: lifecycleMetadata.expires_at,
      decay_eligible: lifecycleMetadata.decay_eligible,
      review_due: lifecycleMetadata.review_due,
      access_count: 0,
      last_operation: 'ADD',
      merged_from: null,
      archived: false,
      vector_synced: true,
      device_id: input.device_id ?? null,
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
    candidateContent: string,
    similar: Array<{ id: string; score: number }>,
    tier: RetentionTier,
  ): { op: WriteOperation; targetId?: string } {
    if (similar.length === 0) return { op: 'ADD' };

    const top = similar[0]!;
    const thresholds = this.lifecycle.dedupThresholdFor(tier, this.config.deduplication.similarity_threshold);

    // An explicit invalidation ("no longer true", "correction:", ...) tied to
    // a sufficiently similar prior memory takes DELETE over NOOP/UPDATE — see
    // "Candidate invalidation results in DELETE" in write-decision-pipeline/spec.md.
    if (top.score >= thresholds.update && detectsInvalidation(candidateContent)) {
      return { op: 'DELETE', targetId: top.id };
    }
    if (top.score >= thresholds.noop) {
      return { op: 'NOOP', targetId: top.id };
    }
    if (top.score >= thresholds.update) {
      return { op: 'UPDATE', targetId: top.id };
    }
    return { op: 'ADD' };
  }

  /**
   * Deterministic, embedding-free similarity proxy used by
   * `deterministicFallback` when no vector is available. Token-set Jaccard
   * similarity over lowercased word sets — cheap, dependency-free, and
   * comparable (0..1) to the cosine-similarity thresholds configured for the
   * normal embedding path, even though the two are not the same metric.
   */
  private textSimilarity(a: string, b: string): number {
    const tokenize = (s: string): Set<string> => new Set(s.toLowerCase().split(/\W+/).filter(Boolean));
    const setA = tokenize(a);
    const setB = tokenize(b);
    if (setA.size === 0 || setB.size === 0) return 0;

    let intersection = 0;
    for (const token of setA) {
      if (setB.has(token)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  private async deterministicFallback(
    candidate: MemoryCandidate,
    input: {
      namespace: string;
      collection: string;
      category?: string;
      source: MemorySource;
      clientId?: string;
      retention_tier?: RetentionTier;
      device_id?: string | null;
    },
    checksum: string,
    now: string,
  ): Promise<WriteResult> {
    // No embedding available: fall back to a vectorless similarity proxy
    // (namespace/collection-scoped full-text search + token-set Jaccard
    // similarity) so a degraded window still threshold-branches between
    // UPDATE and ADD instead of unconditionally ADDing every candidate —
    // see "High-similarity candidate yields UPDATE in fallback mode" /
    // "Below-threshold candidate yields ADD in fallback mode" in
    // write-decision-pipeline/spec.md.
    const resolvedType = candidate.type ?? 'semantic';
    const summary = generateSummary(candidate.content);
    const importance = candidate.importance ?? 0.5;
    const tier = this.lifecycle.assignTier({
      category: input.category,
      source: input.source,
      type: candidate.type,
      tags: candidate.tags,
      content: candidate.content,
      explicitTier: input.retention_tier,
    });
    const lifecycleMetadata = this.lifecycle.buildMetadata(tier, new Date(now));
    const thresholds = this.lifecycle.dedupThresholdFor(tier, this.config.deduplication.similarity_threshold);

    let updateTargetId: string | undefined;
    const ftsMatches = this.storage.sqlite.fullTextSearch(input.namespace, candidate.content, 5, input.collection);
    if (ftsMatches.length > 0) {
      const top = ftsMatches[0]!;
      const existing = this.storage.sqlite.getMemoryById(top.id);
      if (existing && this.textSimilarity(candidate.content, existing.content) >= thresholds.update) {
        updateTargetId = top.id;
      }
    }

    if (updateTargetId) {
      const existing = this.storage.sqlite.getMemoryById(updateTargetId);
      if (!existing) {
        throw internal(`Fallback UPDATE target ${updateTargetId} not found`);
      }

      const mergedTags = [...new Set([...existing.tags, ...candidate.tags])];
      // No vector to upsert: the merged content now diverges from whatever
      // vector (if any) Qdrant holds for this id, so the row is explicitly
      // marked unsynced rather than left falsely reporting a clean sync.
      await this.storage.updateMemory(updateTargetId, {
        content: candidate.content,
        summary,
        tags: mergedTags,
        checksum,
        importance: Math.max(existing.importance, importance),
        retention_tier: tier,
        expires_at: lifecycleMetadata.expires_at,
        decay_eligible: lifecycleMetadata.decay_eligible,
        review_due: lifecycleMetadata.review_due,
        last_operation: 'UPDATE',
        vector_synced: false,
        updated_at: now,
      });

      this.storage.logAudit('UPDATE', updateTargetId, input.namespace, input.clientId);

      return {
        id: updateTargetId,
        summary,
        type: existing.type,
        operation: 'UPDATE',
        merged_with_id: updateTargetId,
        created_at: existing.created_at,
      };
    }

    // Below threshold (or no candidates at all): ADD with no vector.
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
      retention_tier: tier,
      expires_at: lifecycleMetadata.expires_at,
      decay_eligible: lifecycleMetadata.decay_eligible,
      review_due: lifecycleMetadata.review_due,
      access_count: 0,
      last_operation: 'ADD',
      merged_from: null,
      archived: false,
      vector_synced: false,
      device_id: input.device_id ?? null,
      created_at: now,
      updated_at: now,
      last_accessed: now,
    };

    // Store in SQLite only (no vector without embedding)
    this.storage.writeMemoryWithoutVector(mem);
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
