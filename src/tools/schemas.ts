export const MCP_TOOL_DEFINITIONS = [
  {
    name: 'remember',
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
      },
      required: ['content'],
      additionalProperties: false,
    },
  },
  {
    name: 'recall',
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
        min_score: { type: 'number', minimum: 0, maximum: 1, default: 0.6 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'forget',
    description: 'Delete a specific memory by ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', format: 'uuid', description: 'The memory ID to delete' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'search',
    description: 'Search memories using semantic, fulltext, or hybrid search modes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', maxLength: 500 },
        namespace: { type: 'string', pattern: '^[a-zA-Z0-9/-]{1,200}$' },
        collection: { type: 'string', maxLength: 100 },
        mode: { type: 'string', enum: ['semantic', 'fulltext', 'hybrid'], default: 'hybrid' },
        limit: { type: 'number', minimum: 1, maximum: 50, default: 10 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'tag',
    description: 'Add or remove tags from a memory.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', format: 'uuid' },
        add: { type: 'array', items: { type: 'string', pattern: '^[a-zA-Z0-9-]+$', maxLength: 100 }, maxItems: 20 },
        remove: { type: 'array', items: { type: 'string', pattern: '^[a-zA-Z0-9-]+$', maxLength: 100 }, maxItems: 20 },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'collections',
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
  },
  {
    name: 'category',
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
  },
  {
    name: 'backup',
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
  },
  {
    name: 'repair',
    description: 'Recover memories from Qdrant that are missing in SQLite. Scrolls all Qdrant collections and re-inserts any points with content into SQLite.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        dry_run: { type: 'boolean', description: 'If true, only report what would be recovered without making changes', default: false },
      },
      additionalProperties: false,
    },
  },
];
