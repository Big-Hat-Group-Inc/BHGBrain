// Shared JSON-schema fragments for outputSchema declarations (task 2.2/2.3):
// mirror `src/domain/types.ts` `SearchResult` and `WriteResult` so
// `structuredContent` on `recall`/`search`/`remember` is validatable by
// clients. Fields never emitted on these paths (e.g. `SearchResult.vector`)
// are intentionally omitted.
const SEARCH_RESULT_SCHEMA = {
  type: 'object' as const,
  properties: {
    id: { type: 'string' },
    content: { type: 'string' },
    summary: { type: 'string' },
    type: { type: 'string', enum: ['episodic', 'semantic', 'procedural'] },
    tags: { type: 'array', items: { type: 'string' } },
    score: { type: 'number' },
    semantic_score: { type: 'number' },
    fulltext_score: { type: 'number' },
    retention_tier: { type: 'string', enum: ['T0', 'T1', 'T2', 'T3'] },
    expires_at: { type: ['string', 'null'] },
    expiring_soon: { type: 'boolean' },
    device_id: { type: ['string', 'null'] },
    created_at: { type: 'string' },
    last_accessed: { type: 'string' },
    archived: { type: 'boolean' },
    linked_from: { type: 'string' },
    link_relation: { type: 'string', enum: ['refines', 'contradicts', 'derived_from', 'about_same_entity', 'follows'] },
    link_direction: { type: 'string', enum: ['outgoing', 'incoming'] },
  },
  required: ['id', 'content', 'summary', 'type', 'tags', 'score', 'retention_tier', 'created_at', 'last_accessed'],
};

const WRITE_RESULT_SCHEMA = {
  type: 'object' as const,
  properties: {
    id: { type: 'string' },
    summary: { type: 'string' },
    type: { type: 'string', enum: ['episodic', 'semantic', 'procedural'] },
    operation: { type: 'string', enum: ['ADD', 'UPDATE', 'DELETE', 'NOOP'] },
    merged_with_id: { type: 'string' },
    created_at: { type: 'string' },
  },
  required: ['id', 'summary', 'type', 'operation', 'created_at'],
};

export const MCP_TOOL_DEFINITIONS = [
  {
    name: 'remember',
    title: 'Remember',
    description: 'Store a memory for long-term recall. Supports deduplication and automatic classification.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'The content to remember', maxLength: 100000 },
        namespace: { type: 'string', description: 'Namespace scope (default: global)', pattern: '^[a-zA-Z0-9/-]{1,200}$' },
        collection: { type: 'string', description: 'Collection name (default: general)', maxLength: 100 },
        type: { type: 'string', enum: ['episodic', 'semantic', 'procedural'], description: 'Memory type' },
        tags: { type: 'array', items: { type: 'string', pattern: '^[a-zA-Z0-9-]+$', maxLength: 100 }, maxItems: 20 },
        category: { type: 'string', description: 'Category name for persistent policy context', maxLength: 100 },
        importance: { type: 'number', minimum: 0, maximum: 1, description: 'Importance score 0-1' },
        source: { type: 'string', enum: ['cli', 'api', 'agent', 'import'], description: 'Memory source' },
        retention_tier: { type: 'string', enum: ['T0', 'T1', 'T2', 'T3'], description: 'Optional explicit retention tier' },
        pinned: { type: 'boolean', description: 'Pin this memory so it is always included in memory://inject payloads, bounded by defaults.pin_limit_per_namespace. On ADD, defaults to false when omitted; on UPDATE (dedup merge), omitting preserves the existing memory\'s pin state — pass explicitly to change it.' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        results: { type: 'array', items: WRITE_RESULT_SCHEMA },
      },
      required: ['results'],
    },
    // additive upsert; dedup may UPDATE an existing memory but never discards
    // user data outright, and repeat calls with the same content are not
    // guaranteed to be no-ops (dedup thresholds/model drift).
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'recall',
    title: 'Recall',
    description: 'Retrieve relevant memories by semantic similarity to a query.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'The recall query', maxLength: 500 },
        namespace: { type: 'string', pattern: '^[a-zA-Z0-9/-]{1,200}$' },
        collection: { type: 'string', maxLength: 100 },
        type: { type: 'string', enum: ['episodic', 'semantic', 'procedural'] },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 20 },
        limit: { type: 'number', minimum: 1, maximum: 20, default: 5 },
        min_score: { type: 'number', minimum: 0, maximum: 1, default: 0.6, description: 'Cosine-similarity threshold applied to the semantic score, not the fused/adjusted score' },
        after: { type: 'string', format: 'date-time', description: 'Only include memories with created_at >= this ISO 8601 timestamp (inclusive)' },
        before: { type: 'string', format: 'date-time', description: 'Only include memories with created_at <= this ISO 8601 timestamp (inclusive)' },
        follow_links: { type: 'boolean', description: 'Also return each result\'s one-hop linked memories (relate tool edges, both directions, all relations), marked with linked_from/link_relation/link_direction. Default false.', default: false },
      },
      required: ['query'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        results: { type: 'array', items: SEARCH_RESULT_SCHEMA },
      },
      required: ['results'],
    },
    // Pure read: destructiveHint/idempotentHint are meaningless per spec when
    // readOnlyHint is true, so only readOnlyHint/openWorldHint are declared.
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'forget',
    title: 'Forget',
    description: 'Delete a specific memory by ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', format: 'uuid', description: 'The memory ID to delete' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    // Hard delete; repeat delete of the same id adds nothing beyond the
    // first (idempotent), and is inherently destructive.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'search',
    title: 'Search',
    description: 'Search memories using semantic, fulltext, or hybrid search modes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', maxLength: 500 },
        namespace: { type: 'string', pattern: '^[a-zA-Z0-9/-]{1,200}$' },
        collection: { type: 'string', maxLength: 100 },
        mode: { type: 'string', enum: ['semantic', 'fulltext', 'hybrid'], default: 'hybrid' },
        limit: { type: 'number', minimum: 1, maximum: 50, default: 10 },
        include_archived: { type: 'boolean', description: 'Also search archived memories (retained summary/tags only), appended and marked archived: true. Default false.', default: false },
        after: { type: 'string', format: 'date-time', description: 'Only include memories with created_at >= this ISO 8601 timestamp (inclusive)' },
        before: { type: 'string', format: 'date-time', description: 'Only include memories with created_at <= this ISO 8601 timestamp (inclusive)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object' as const,
      properties: {
        results: { type: 'array', items: SEARCH_RESULT_SCHEMA },
        degraded: { type: 'boolean' },
      },
      required: ['results'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'tag',
    title: 'Tag',
    description: 'Add or remove tags from a memory.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', format: 'uuid' },
        add: { type: 'array', items: { type: 'string', pattern: '^[a-zA-Z0-9-]+$', maxLength: 100 }, maxItems: 20 },
        remove: { type: 'array', items: { type: 'string', pattern: '^[a-zA-Z0-9-]+$', maxLength: 100 }, maxItems: 20 },
        pinned: { type: 'boolean', description: 'Pin or unpin this memory without touching its content or tags, bounded by defaults.pin_limit_per_namespace. Omit to leave pin state unchanged.' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    // Reversible metadata edit: tags/pin state can always be added/removed back.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'collections',
    title: 'Collections',
    description: 'List, create, or delete memory collections.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'delete'] },
        namespace: { type: 'string', pattern: '^[a-zA-Z0-9/-]{1,200}$', description: 'Namespace scope (default: global)' },
        name: { type: 'string', maxLength: 100 },
        force: { type: 'boolean', description: 'Required to delete non-empty collections' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    // `delete` with `force: true` cascades memory deletion.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'category',
    title: 'Category',
    description: 'Manage persistent policy categories (company-values, architecture, coding-requirements, custom).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'set', 'delete'] },
        name: { type: 'string', maxLength: 100 },
        slot: { type: 'string', enum: ['company-values', 'architecture', 'coding-requirements', 'custom'] },
        content: { type: 'string', maxLength: 100000 },
      },
      required: ['action'],
      additionalProperties: false,
    },
    // `delete` removes policy context; `set` overwrites existing content.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'backup',
    title: 'Backup',
    description: 'Create, list, or restore memory backups.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['create', 'restore', 'list'] },
        path: { type: 'string', description: 'Backup file path (required for restore)' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    // `restore` overwrites both stores.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'bootstrap',
    title: 'Bootstrap Interview',
    description: 'Interactive bootstrap interview for building your profile. Drives a stateful 10-section interview, storing memories as you go. Supports pause/resume across sessions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['start', 'submit', 'status', 'reset'], description: 'The action to perform' },
        section: { type: 'number', minimum: 1, maximum: 10, description: 'Section number (required for submit and reset)' },
        answers: { type: 'string', description: 'Your answers for the section (required for submit)', maxLength: 500000 },
        namespace: { type: 'string', description: 'Namespace scope (default: profile)', pattern: '^[a-zA-Z0-9/-]{1,200}$' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    // Writes interview memories; nothing is discarded.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'import',
    title: 'Import',
    description: 'Import a structured profile or freeform document as discrete memories. Supports the 10-section bootstrap format and arbitrary markdown text.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        format: { type: 'string', enum: ['profile', 'freeform'], description: 'Input format: "profile" for 10-section bootstrap output, "freeform" for arbitrary text' },
        content: { type: 'string', description: 'The document text to import', maxLength: 500000 },
        namespace: { type: 'string', description: 'Namespace scope (default: profile)', pattern: '^[a-zA-Z0-9/-]{1,200}$' },
        dry_run: { type: 'boolean', description: 'If true, returns a preview of what would be stored without writing', default: false },
      },
      required: ['format', 'content'],
      additionalProperties: false,
    },
    // Bulk additive writes.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'revisions',
    title: 'Revisions',
    description: 'List a memory\'s revision history, or revert its content to a prior revision.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'revert'] },
        id: { type: 'string', format: 'uuid', description: 'The memory ID' },
        revision: { type: 'number', description: 'Revision number to revert to (required for revert)' },
      },
      required: ['action', 'id'],
      additionalProperties: false,
    },
    // `revert` overwrites the memory's current content.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'review',
    title: 'Review Queue',
    description: 'List and disposition the T1 review queue, and restore archived memories. action: "list" returns due memories oldest-first (paginated); "keep" confirms a memory and re-extends its review date/expiry; "archive" retires a memory through the archive path; "restore" recreates an active memory (a provenance-carrying stub) from an archived record.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'keep', 'archive', 'restore'], description: 'The action to perform' },
        id: { type: 'string', format: 'uuid', description: 'Memory ID (required for keep/archive/restore; for restore, the original memory ID looked up in the archive)' },
        days: { type: 'number', minimum: 0, maximum: 3650, default: 0, description: '(list only) Look-ahead window in days beyond "due now"' },
        namespace: { type: 'string', description: 'Namespace scope (default: global)', pattern: '^[a-zA-Z0-9/-]{1,200}$' },
        limit: { type: 'number', minimum: 1, maximum: 100, default: 20, description: '(list only) Page size' },
        cursor: { type: 'string', description: '(list only) Pagination cursor from a prior list call' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    // `archive` is reversible via `restore`.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'relate',
    title: 'Relate',
    description: 'Connect memories with typed, directed edges. action: "add" creates an edge between two memories (idempotent: re-adding an identical edge returns the existing one); "list" returns a memory\'s edges, either direction, optionally filtered by relation; "remove" deletes a specific edge. Relations: refines, contradicts, derived_from, about_same_entity, follows.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'remove'], description: 'The action to perform' },
        from_id: { type: 'string', format: 'uuid', description: 'Source memory ID (required for add/remove)' },
        to_id: { type: 'string', format: 'uuid', description: 'Target memory ID (required for add/remove)' },
        relation: { type: 'string', enum: ['refines', 'contradicts', 'derived_from', 'about_same_entity', 'follows'], description: 'Edge type (required for add/remove)' },
        id: { type: 'string', format: 'uuid', description: 'The memory whose links to list (required for list)' },
        direction: { type: 'string', enum: ['from', 'to', 'both'], default: 'both', description: '(list only) Filter edges by direction relative to id' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    // `add` is idempotent (re-adding returns the existing edge); `remove` is
    // a targeted, reversible-by-re-adding edge deletion, not a memory delete.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'repair',
    title: 'Repair',
    description: 'Repair local state from external sources. mode: "from-qdrant" (default) recovers memories from Qdrant that are missing in SQLite. mode: "re-embed" migrates memories whose embedding stamp differs from the active embedding model/provider (run after changing embedding.provider or embedding.model).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        mode: { type: 'string', enum: ['from-qdrant', 're-embed'], description: 'Repair mode. "from-qdrant" recovers missing SQLite rows from Qdrant payloads; "re-embed" migrates vectors stamped with a stale embedding identity to the active one.', default: 'from-qdrant' },
        dry_run: { type: 'boolean', description: 'If true, only report what would change without making changes', default: false },
        device_id: { type: 'string', description: '(from-qdrant only) Filter recovery to only points matching this device_id. Mutually exclusive with all_devices.', pattern: '^[a-zA-Z0-9._-]{1,64}$' },
        all_devices: { type: 'boolean', description: '(from-qdrant only) Explicitly recover points from all devices. Mutually exclusive with device_id. This is also the default behavior when neither field is provided.', default: false },
        include_legacy: { type: 'boolean', description: '(re-embed only) Also re-embed legacy rows with no embedding stamp at all, not just rows stamped with a different model.', default: false },
        batch_size: { type: 'number', description: '(re-embed only) Memories re-embedded per batch.', minimum: 1, maximum: 500, default: 50 },
      },
      additionalProperties: false,
    },
    // Reconstructive; safe to repeat (re-scans and only recovers what's missing).
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'consolidate',
    title: 'Consolidate Duplicates',
    description: 'Discover and merge near-duplicate existing memories. action: "list" scans a namespace/collection for clusters of near-duplicate memories (bounded, paginated, no full pairwise scan) and returns each with a suggested merge target (a hint only). action: "merge" merges explicitly named source memories into an explicitly named target: unions tags, raises importance to the cluster max, and archives each source through the existing archive transition. Always requires an explicit target_id/source_ids — there is no automatic or scheduled merge.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['list', 'merge'], description: 'The action to perform' },
        namespace: { type: 'string', description: 'Namespace scope (default: global)', pattern: '^[a-zA-Z0-9/-]{1,200}$' },
        collection: { type: 'string', description: 'Collection name (default: general)', maxLength: 100 },
        cursor: { type: 'string', description: '(list only) Pagination cursor from a prior list call' },
        min_cluster_size: { type: 'number', minimum: 2, default: 2, description: '(list only) Minimum members for a cluster to be reported' },
        target_id: { type: 'string', format: 'uuid', description: '(merge only) The memory id every source is merged into' },
        source_ids: { type: 'array', items: { type: 'string', format: 'uuid' }, minItems: 1, description: '(merge only) Memory ids to merge into target_id and archive' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    // `merge` archives sources, but that transition is reversible via `review restore`.
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

/** Task 2.4: single source of truth for "is this a known MCP tool name",
 * kept in lockstep with `dispatch`'s switch in `src/tools/index.ts` by a
 * unit test (`schemas.test.ts`). */
export const MCP_TOOL_NAMES: ReadonlySet<string> = new Set(MCP_TOOL_DEFINITIONS.map(t => t.name));
