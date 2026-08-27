import type { BrainConfig } from '../config/index.js';
import type { StorageManager } from '../storage/index.js';
import type { SearchService } from '../search/index.js';
import type { HealthService } from '../health/index.js';
import type { InjectPayload, PaginatedResult, MemoryRecord, MemoryRevisionRecord } from '../domain/types.js';
import type { CategoryHeader } from '../storage/sqlite.js';
import { MemoryLifecycleService } from '../domain/lifecycle.js';

export class ResourceHandler {
  private static readonly LIST_LIMIT_MIN = 1;
  private static readonly LIST_LIMIT_MAX = 100;
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
    const url = new URL(uri);
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
      return this.buildInjectPayload(namespace);
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

  private async buildInjectPayload(namespace: string): Promise<InjectPayload> {
    const maxChars = this.config.auto_inject.max_chars;
    const parts: string[] = [];
    let totalChars = 0;
    let truncated = false;
    const appendBlock = (block: string): boolean => {
      if (totalChars >= maxChars) {
        truncated = true;
        return false;
      }
      const remaining = maxChars - totalChars;
      if (block.length <= remaining) {
        parts.push(block);
        totalChars += block.length;
        return true;
      }
      parts.push(block.slice(0, remaining));
      totalChars = maxChars;
      truncated = true;
      return false;
    };

    // 1. All category content (full)
    const categoryHeaders = this.storage.sqlite.listCategoryHeaders();
    let categoriesCount = 0;
    for (const cat of categoryHeaders) {
      if (totalChars >= maxChars) {
        truncated = true;
        break;
      }

      const prefix = `## ${cat.name} (${cat.slot})\n`;
      if (!appendBlock(prefix)) break;

      const remainingForContent = maxChars - totalChars - 2;
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
      if (!appendBlock(`${content}\n\n`)) break;
      if (!fullyIncluded) {
        truncated = true;
        break;
      }
      categoriesCount++;
    }

    // 2. Top-K relevant memories
    const topK = this.config.defaults.auto_inject_limit;
    const memories = this.storage.sqlite.listMemories(namespace, topK);
    let memoriesCount = 0;

    for (const mem of memories) {
      if (totalChars >= maxChars) break;

      const remaining = maxChars - totalChars;
      const contentBlock = mem.content.length + 50 <= remaining
        ? `- [${mem.type}] ${mem.content}\n`
        : `- [${mem.type}] ${mem.summary}\n`;
      if (appendBlock(contentBlock)) {
        memoriesCount++;
      } else {
        break;
      }
    }

    const content = parts.join('');
    truncated = truncated || memories.length > memoriesCount;

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
  { uriTemplate: 'category://{name}', name: 'Category', description: 'Full category content' },
  { uriTemplate: 'collection://{name}', name: 'Collection', description: 'Memories in a collection' },
];
