import type { BrainConfig } from '../config/index.js';
import type { StorageManager } from '../storage/index.js';
import type { SearchService } from '../search/index.js';
import type { HealthService } from '../health/index.js';
import type { InjectPayload, PaginatedResult, MemoryRecord, MemoryRevisionRecord, SearchResult } from '../domain/types.js';
import type { CategoryHeader } from '../storage/sqlite.js';
import { MemoryLifecycleService } from '../domain/lifecycle.js';
import { cosineSimilarity } from '../search/similarity.js';

export class ResourceHandler {
  private static readonly LIST_LIMIT_MIN = 1;
  private static readonly LIST_LIMIT_MAX = 100;
  // `memory://inject/{hint}` caps the hint to the same length the `search`/
  // `recall` tools enforce on a query (`schemas.ts`), so an oversized hint
  // can't blow up the hybrid search behind it.
  private static readonly HINT_MAX_LENGTH = 500;
  private lifecycle: MemoryLifecycleService;

  constructor(
    private config: BrainConfig,
    private storage: StorageManager,
    private search: SearchService,
    private health: HealthService,
  ) {
    this.lifecycle = new MemoryLifecycleService(config);
  }

  // T0/T1 stay visible regardless of transient expiry (matches the search and
  // recall retrieval paths); only expired, decay-eligible T2/T3 memories are
  // excluded from resource reads. Closes the drift where `memory://list` and
  // `memory://{id}` read SQLite directly with no expiry filtering, leaking
  // memories that `search`/`recall` already exclude.
  private isExpiredForResource(mem: Pick<MemoryRecord, 'retention_tier' | 'expires_at'>): boolean {
    if (mem.retention_tier === 'T0' || mem.retention_tier === 'T1') return false;
    return this.lifecycle.isExpired(mem.expires_at, new Date());
  }

  async handle(uri: string): Promise<unknown> {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      // Matches the existing convention below of *returning* an envelope
      // for an unrecognized resource rather than throwing — this handler is
      // reached from stdio and `/mcp` as well as the HTTP `/resource`
      // endpoint, none of which have Express error middleware to backstop a
      // thrown TypeError from a malformed URI (harden-http-server-lifecycle
      // task 3.2).
      return { error: { code: 'INVALID_INPUT', message: `Malformed resource URI: ${uri}`, retryable: false } };
    }
    const scheme = url.protocol.replace(':', '');
    const host = url.hostname || url.pathname.replace('//', '');

    if (scheme === 'memory') {
      return this.handleMemory(uri, url);
    }
    if (scheme === 'category') {
      return this.handleCategory(uri);
    }
    if (scheme === 'collection') {
      return this.handleCollection(uri);
    }
    if (scheme === 'health') {
      return this.health.check();
    }

    return { error: { code: 'NOT_FOUND', message: `Unknown resource: ${uri}`, retryable: false } };
  }

  private async handleMemory(uri: string, url: URL): Promise<unknown> {
    const path = url.hostname || url.pathname.replace('//', '');

    if (path === 'inject') {
      const namespace = url.searchParams.get('namespace') ?? this.config.defaults.namespace;
      return this.buildInjectPayload(namespace, this.extractInjectHint(url));
    }

    if (path === 'list') {
      const namespace = url.searchParams.get('namespace') ?? this.config.defaults.namespace;
      const parsedLimit = this.parseListLimit(url.searchParams.get('limit'));
      if (typeof parsedLimit !== 'number') {
        return parsedLimit;
      }
      const cursor = url.searchParams.get('cursor') ?? undefined;
      return this.listMemories(namespace, parsedLimit, cursor);
    }

    // memory://{id}/revisions
    if (path && url.pathname === '/revisions') {
      return this.handleMemoryRevisions(path);
    }

    // memory://{id}
    const id = path;
    if (id) {
      const mem = this.storage.sqlite.getMemoryById(id);
      if (!mem || this.isExpiredForResource(mem)) {
        return { error: { code: 'NOT_FOUND', message: `Memory ${id} not found`, retryable: false } };
      }
      this.storage.sqlite.touchMemory(id);
      this.storage.sqlite.scheduleDeferredFlush();
      return mem;
    }

    return { error: { code: 'NOT_FOUND', message: 'Invalid memory resource URI', retryable: false } };
  }

  private handleMemoryRevisions(id: string): { id: string; revisions: MemoryRevisionRecord[] } | { error: { code: 'NOT_FOUND'; message: string; retryable: false } } {
    const mem = this.storage.sqlite.getMemoryById(id);
    if (!mem || this.isExpiredForResource(mem)) {
      return { error: { code: 'NOT_FOUND', message: `Memory ${id} not found`, retryable: false } };
    }
    return { id, revisions: this.storage.sqlite.listRevisions(id) };
  }

  private listMemories(
    namespace: string,
    limit: number,
    cursor?: string,
  ): PaginatedResult<Omit<MemoryRecord, 'embedding'>> {
    const items = this.storage.sqlite.listMemories(namespace, limit + 1, cursor);
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    // Cursor continuation is positional (based on the raw, unfiltered page),
    // so it stays correct even though expired T2/T3 memories are dropped
    // from what's actually returned below.
    const lastItem = page[page.length - 1];
    const nextCursor = hasMore && lastItem ? `${lastItem.created_at}|${lastItem.id}` : null;
    const total = this.storage.sqlite.countMemories(namespace);
    const visiblePage = page.filter(mem => !this.isExpiredForResource(mem));

    return {
      items: visiblePage,
      cursor: nextCursor,
      total_results: total,
      truncated: hasMore,
    };
  }

  private parseListLimit(rawLimit: string | null): number | { error: { code: 'INVALID_INPUT'; message: string; retryable: false } } {
    if (rawLimit === null) return 20;
    if (!/^\d+$/.test(rawLimit)) {
      return {
        error: {
          code: 'INVALID_INPUT',
          message: 'limit must be an integer',
          retryable: false,
        },
      };
    }

    const parsed = parseInt(rawLimit, 10);
    if (parsed < ResourceHandler.LIST_LIMIT_MIN || parsed > ResourceHandler.LIST_LIMIT_MAX) {
      return {
        error: {
          code: 'INVALID_INPUT',
          message: `limit must be between ${ResourceHandler.LIST_LIMIT_MIN} and ${ResourceHandler.LIST_LIMIT_MAX}`,
          retryable: false,
        },
      };
    }

    return parsed;
  }

  // `memory://inject` has no hint segment (`url.pathname` is '' or '/');
  // `memory://inject/{hint}` carries it as the path remainder. Decoded once,
  // trimmed, and length-capped so a hint typo or an oversized value can't
  // reach the hybrid search underneath unbounded.
  private extractInjectHint(url: URL): string | undefined {
    const rawSegment = url.pathname && url.pathname !== '/' ? url.pathname.slice(1) : '';
    if (!rawSegment) return undefined;
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      decoded = rawSegment;
    }
    const trimmed = decoded.trim();
    return trimmed ? trimmed.slice(0, ResourceHandler.HINT_MAX_LENGTH) : undefined;
  }

  // Greedy near-duplicate suppression over relevance-ranked candidates: a
  // candidate is dropped once it exceeds the dedup threshold's similarity to
  // an already-selected memory. Candidates with no vector (fulltext-only
  // matches, or the cross-device Qdrant-payload fallback) are never
  // suppressed — there is nothing to compare them against.
  private suppressNearDuplicates(candidates: SearchResult[]): SearchResult[] {
    const threshold = this.config.deduplication.similarity_threshold;
    const selected: SearchResult[] = [];
    for (const candidate of candidates) {
      const vector = candidate.vector;
      const isDuplicate = vector !== undefined && selected.some(sel =>
        sel.vector !== undefined && cosineSimilarity(vector, sel.vector) > threshold,
      );
      if (!isDuplicate) selected.push(candidate);
    }
    return selected;
  }

  private async buildInjectPayload(namespace: string, hint?: string): Promise<InjectPayload> {
    const { max_chars, budget_unit, memory_budget_fraction, dedup_suppression } = this.config.auto_inject;
    // `budget_unit: 'tokens'` estimates 1 token ~= 4 chars; scaling the char
    // budget by 4 keeps every length comparison below in chars unchanged, so
    // `budget_unit: 'chars'` (the default) is byte-for-byte identical to the
    // arithmetic that existed before this option did.
    const budgetChars = budget_unit === 'tokens' ? max_chars * 4 : max_chars;
    // Categories draw from their reserved share only; whatever they leave
    // unused rolls into the memory section's remaining budget below, so a
    // light category set doesn't waste the reservation (no fixed carve-out).
    const categoryBudget = budgetChars * (1 - memory_budget_fraction);

    const parts: string[] = [];
    let totalChars = 0;
    let truncated = false;
    const appendBlock = (block: string, cap: number): boolean => {
      if (totalChars >= cap) {
        truncated = true;
        return false;
      }
      const remaining = cap - totalChars;
      if (block.length <= remaining) {
        parts.push(block);
        totalChars += block.length;
        return true;
      }
      parts.push(block.slice(0, remaining));
      totalChars = cap;
      truncated = true;
      return false;
    };

    // 1. All category content (full, capped to the reserved category share)
    const categoryHeaders = this.storage.sqlite.listCategoryHeaders();
    let categoriesCount = 0;
    for (const cat of categoryHeaders) {
      if (totalChars >= categoryBudget) {
        truncated = true;
        break;
      }

      const prefix = `## ${cat.name} (${cat.slot})\n`;
      if (!appendBlock(prefix, categoryBudget)) break;

      const remainingForContent = categoryBudget - totalChars - 2;
      if (remainingForContent <= 0) {
        truncated = true;
        break;
      }

      const slice = this.storage.sqlite.getCategoryContentSlice(cat.name, remainingForContent);
      const content = slice?.content ?? '';
      // Compare SQLite-counted character lengths on both sides (slice.length vs.
      // cat.content_length) rather than JS UTF-16 `.length`, so multibyte/astral
      // content near the budget boundary is not mis-classified as fully included.
      const fullyIncluded = (slice?.length ?? 0) >= cat.content_length;
      if (!appendBlock(`${content}\n\n`, categoryBudget)) break;
      if (!fullyIncluded) {
        truncated = true;
        break;
      }
      categoriesCount++;
    }

    // 2. Memory section: a namespace's pinned memories are always included
    // first (regardless of recency/relevance rank), drawing from the same
    // remaining budget the recency/relevance candidates below use — no
    // separate carve-out. This runs identically for `memory://inject` and
    // `memory://inject/{hint}` (before the `trimmedHint` branch below
    // decides which algorithm fills the rest of the section), and is
    // deliberately never passed through `suppressNearDuplicates`: pinned
    // memories are exempt from near-duplicate suppression in both
    // directions (see design's near-duplicate-exemption decision). Ids
    // included here are excluded from the recency/relevance candidate list
    // below via a plain Set check, so a memory that is both pinned and
    // independently top-ranked appears exactly once and doesn't consume an
    // extra slot of `auto_inject_limit`. See add-inject-pinning.
    const pinnedIds = new Set<string>();
    let pinnedAppended = 0;
    let pinnedTotal = 0;
    if (this.config.auto_inject.pinned_enabled) {
      const pinnedMemories = this.storage.sqlite.listPinnedMemories(namespace);
      pinnedTotal = pinnedMemories.length;
      for (const mem of pinnedMemories) {
        if (totalChars >= budgetChars) break;

        const remaining = budgetChars - totalChars;
        const contentBlock = mem.content.length + 50 <= remaining
          ? `- [${mem.type}] ${mem.content}\n`
          : `- [${mem.type}] ${mem.summary}\n`;
        if (appendBlock(contentBlock, budgetChars)) {
          pinnedIds.add(mem.id);
          pinnedAppended++;
        } else {
          break;
        }
      }
    }

    // 3. Recency/relevance selection, unchanged from what `memory://inject`
    // always did except for excluding already-pinned ids: hybrid-relevance
    // selection when a hint is given (access recorded and expiry-filtered
    // identically to a normal search, near-duplicate suppressed), recency
    // fallback otherwise.
    const topK = this.config.defaults.auto_inject_limit;
    const trimmedHint = hint?.trim();
    let memories: Array<Pick<MemoryRecord | SearchResult, 'id' | 'type' | 'content' | 'summary'>>;
    if (trimmedHint) {
      const candidates = await this.search.searchForInject(trimmedHint, namespace, topK);
      // Exclude already-pinned ids BEFORE suppression, not after: a memory
      // that is both pinned and independently top-ranked must never act as
      // the suppressing (or suppressed) party against a *different*
      // candidate on account of its now-to-be-excluded presence here — see
      // the near-duplicate-exemption decision. Suppression therefore only
      // ever runs over genuinely non-pinned candidates.
      const nonPinned = candidates.filter(mem => !pinnedIds.has(mem.id));
      memories = dedup_suppression ? this.suppressNearDuplicates(nonPinned) : nonPinned;
    } else {
      memories = this.storage.sqlite.listMemories(namespace, topK).filter(mem => !pinnedIds.has(mem.id));
    }
    let candidatesAppended = 0;

    for (const mem of memories) {
      if (totalChars >= budgetChars) break;

      const remaining = budgetChars - totalChars;
      const contentBlock = mem.content.length + 50 <= remaining
        ? `- [${mem.type}] ${mem.content}\n`
        : `- [${mem.type}] ${mem.summary}\n`;
      if (appendBlock(contentBlock, budgetChars)) {
        candidatesAppended++;
      } else {
        break;
      }
    }

    const memoriesCount = pinnedAppended + candidatesAppended;
    const content = parts.join('');
    truncated = truncated || pinnedTotal > pinnedAppended || memories.length > candidatesAppended;

    return {
      content,
      truncated,
      total_results: this.storage.sqlite.countMemories(namespace),
      categories_count: categoriesCount,
      memories_count: memoriesCount,
    };
  }

  private handleCategory(uri: string): unknown {
    // Categories are intentionally global: they hold shared policy context
    // (company values, architecture, coding requirements) and have no namespace
    // dimension in the schema, so `category://` reads are not namespace-scoped.
    // This is by design — contrast with `collection://`, which IS namespace-scoped.
    const url = new URL(uri);
    const path = url.hostname || url.pathname.replace('//', '');

    if (path === 'list') {
      return {
        categories: this.storage.sqlite.listCategories().map(c => ({
          name: c.name,
          slot: c.slot,
          preview: c.content.substring(0, 200),
          revision: c.revision,
          updated_at: c.updated_at,
        })),
      };
    }

    // category://{name}
    const cat = this.storage.sqlite.getCategory(path);
    if (!cat) {
      return { error: { code: 'NOT_FOUND', message: `Category "${path}" not found`, retryable: false } };
    }
    return cat;
  }

  private handleCollection(uri: string): unknown {
    const url = new URL(uri);
    const path = url.hostname || url.pathname.replace('//', '');

    // Resolve namespace the same way memory:// does: scoped to the configured
    // default namespace, with ?namespace= as an explicit, opt-in override. This
    // closes the cross-namespace leak where collection reads always saw `global`.
    const namespace = url.searchParams.get('namespace') ?? this.config.defaults.namespace;

    if (path === 'list') {
      return { collections: this.storage.sqlite.listCollections(namespace) };
    }

    // collection://{name} - list memories in the collection, namespace-scoped and
    // cursor-paginated (no longer a fixed 50-row in-memory filter that silently
    // dropped collections whose members fell outside the first page).
    const parsedLimit = this.parseListLimit(url.searchParams.get('limit'));
    if (typeof parsedLimit !== 'number') {
      return parsedLimit;
    }
    const cursor = url.searchParams.get('cursor') ?? undefined;
    const items = this.storage.sqlite.listMemoriesInCollection(namespace, path, parsedLimit + 1, cursor);
    const hasMore = items.length > parsedLimit;
    const page = hasMore ? items.slice(0, parsedLimit) : items;
    const lastItem = page[page.length - 1];
    const nextCursor = hasMore && lastItem ? `${lastItem.created_at}|${lastItem.id}` : null;
    return {
      collection: path,
      namespace,
      memories: page,
      cursor: nextCursor,
      total_results: this.storage.sqlite.countMemoriesInCollection(namespace, path),
      truncated: hasMore,
    };
  }
}

/** Concrete (non-parameterized) resources for ListResources */
export const MCP_RESOURCE_DEFINITIONS = [
  { uri: 'memory://list', name: 'Memory List', description: 'Cursor-paginated memories (newest first)' },
  { uri: 'memory://inject', name: 'Session Inject', description: 'Budgeted session context block for auto-inject' },
  { uri: 'category://list', name: 'Categories', description: 'List all categories with preview' },
  { uri: 'collection://list', name: 'Collections', description: 'List all collections with counts' },
  { uri: 'health://status', name: 'Health Status', description: 'Health snapshot' },
];

/** Parameterized URI templates for ListResourceTemplates */
export const MCP_RESOURCE_TEMPLATES = [
  { uriTemplate: 'memory://{id}', name: 'Memory Details', description: 'Full memory details by ID' },
  { uriTemplate: 'memory://{id}/revisions', name: 'Memory Revisions', description: 'Revision history for a memory, newest first' },
  { uriTemplate: 'memory://inject/{hint}', name: 'Session Inject (Hinted)', description: 'Budgeted session context block whose memory section is selected by hybrid relevance to the hint, instead of recency' },
  { uriTemplate: 'category://{name}', name: 'Category', description: 'Full category content' },
  { uriTemplate: 'collection://{name}', name: 'Collection', description: 'Memories in a collection' },
];
