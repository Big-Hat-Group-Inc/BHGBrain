import type { BrainConfig } from '../config/index.js';
import type { StorageManager } from '../storage/index.js';
import type { SearchService } from '../search/index.js';
import type { HealthService } from '../health/index.js';
import type { InjectPayload, PaginatedResult, MemoryRecord } from '../domain/types.js';

export class ResourceHandler {
  private static readonly LIST_LIMIT_MIN = 1;
  private static readonly LIST_LIMIT_MAX = 100;

  constructor(
    private config: BrainConfig,
    private storage: StorageManager,
    private search: SearchService,
    private health: HealthService,
  ) {}

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

    // memory://{id}
    const id = path;
    if (id) {
      const mem = this.storage.sqlite.getMemoryById(id);
      if (!mem) {
        return { error: { code: 'NOT_FOUND', message: `Memory ${id} not found`, retryable: false } };
      }
      this.storage.sqlite.touchMemory(id);
      this.storage.sqlite.scheduleDeferredFlush();
      return mem;
    }

    return { error: { code: 'NOT_FOUND', message: 'Invalid memory resource URI', retryable: false } };
  }

  private listMemories(
    namespace: string,
    limit: number,
    cursor?: string,
  ): PaginatedResult<Omit<MemoryRecord, 'embedding'>> {
    const items = this.storage.sqlite.listMemories(namespace, limit + 1, cursor);
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const lastItem = page[page.length - 1];
    // Composite cursor: "created_at|id" for stable tie-breaking
    const nextCursor = hasMore && lastItem ? `${lastItem.created_at}|${lastItem.id}` : null;
    const total = this.storage.sqlite.countMemories(namespace);

    return {
      items: page,
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
    const categoryHeaders = typeof (this.storage.sqlite as any).listCategoryHeaders === 'function'
      ? this.storage.sqlite.listCategoryHeaders()
      : this.storage.sqlite.listCategories().map((cat: any) => ({
        name: cat.name,
        slot: cat.slot,
        revision: cat.revision,
        updated_at: cat.updated_at,
        content_length: cat.content.length,
        content: cat.content,
      }));
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

      const content = 'content' in cat
        ? cat.content.slice(0, remainingForContent)
        : this.storage.sqlite.getCategoryContentSlice(cat.name, remainingForContent) ?? '';
      const fullyIncluded = content.length >= (cat.content_length ?? content.length);
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

    if (path === 'list') {
      return { collections: this.storage.sqlite.listCollections() };
    }

    // collection://{name} - list memories in collection
    const namespace = url.searchParams.get('namespace') ?? 'global';
    const memories = this.storage.sqlite.listMemories(namespace, 50);
    const filtered = memories.filter(m => m.collection === path);
    return { collection: path, memories: filtered };
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
  { uriTemplate: 'category://{name}', name: 'Category', description: 'Full category content' },
  { uriTemplate: 'collection://{name}', name: 'Collection', description: 'Memories in a collection' },
];
