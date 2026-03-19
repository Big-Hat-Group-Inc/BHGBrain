export type MemoryType = 'episodic' | 'semantic' | 'procedural';

export type CategorySlot = 'company-values' | 'architecture' | 'coding-requirements' | 'custom';

export type MemorySource = 'cli' | 'api' | 'agent' | 'import';

export type WriteOperation = 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';

export type SearchMode = 'semantic' | 'fulltext' | 'hybrid';

export type RetentionTier = 'T0' | 'T1' | 'T2' | 'T3';

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export type ErrorCode =
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'AUTH_REQUIRED'
  | 'RATE_LIMITED'
  | 'EMBEDDING_UNAVAILABLE'
  | 'INTERNAL';

export interface MemoryRecord {
  id: string;
  namespace: string;
  collection: string;
  type: MemoryType;
  category: string | null;
  content: string;
  summary: string;
  tags: string[];
  source: MemorySource;
  checksum: string;
  embedding: number[];
  importance: number;
  retention_tier: RetentionTier;
  expires_at: string | null;
  decay_eligible: boolean;
  review_due: string | null;
  access_count: number;
  last_operation: WriteOperation;
  merged_from: string | null;
  archived: boolean;
  vector_synced: boolean;
  device_id?: string | null;
  created_at: string;
  updated_at: string;
  last_accessed: string;
}

export interface CategoryRecord {
  name: string;
  slot: CategorySlot;
  content: string;
  updated_at: string;
  revision: number;
}

export interface CollectionInfo {
  name: string;
  count: number;
}

export interface SearchResult {
  id: string;
  content: string;
  summary: string;
  type: MemoryType;
  tags: string[];
  score: number;
  semantic_score?: number;
  fulltext_score?: number;
  retention_tier: RetentionTier;
  expires_at?: string | null;
  expiring_soon?: boolean;
  device_id?: string | null;
  created_at: string;
  last_accessed: string;
}

export interface WriteResult {
  id: string;
  summary: string;
  type: MemoryType;
  operation: WriteOperation;
  merged_with_id?: string;
  created_at: string;
}

export interface BackupInfo {
  path: string;
  size_bytes: number;
  memory_count: number;
  created_at: string;
}

export interface ComponentHealth {
  status: HealthStatus;
  message?: string;
}

export interface HealthSnapshot {
  status: HealthStatus;
  components: {
    sqlite: ComponentHealth;
    qdrant: ComponentHealth;
    embedding: ComponentHealth;
    retention?: ComponentHealth;
  };
  memory_count: number;
  db_size_bytes: number;
  uptime_seconds: number;
  circuitBreakers?: Record<string, 'closed' | 'open' | 'half-open'>;
  retention?: {
    counts_by_tier: Record<RetentionTier, number>;
    expiring_soon: number;
    archived_count: number;
    unsynced_vectors: number;
    over_capacity: boolean;
  };
}

export interface ErrorEnvelope {
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
  };
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  namespace: string;
  operation: WriteOperation | 'FORGET';
  memory_id: string;
  client_id: string;
  details?: string;
}

export interface PaginatedResult<T> {
  items: T[];
  cursor: string | null;
  total_results: number;
  truncated: boolean;
}

export interface InjectPayload {
  content: string;
  truncated: boolean;
  total_results: number;
  categories_count: number;
  memories_count: number;
}

export interface ArchiveRecord {
  id: number;
  memory_id: string;
  summary: string;
  tier: RetentionTier;
  namespace: string;
  created_at: string;
  expired_at: string;
  access_count: number;
  tags: string[];
}

export interface MemoryRevisionRecord {
  id: number;
  memory_id: string;
  revision: number;
  content: string;
  updated_at: string;
  updated_by: string | null;
}

export interface TierStats {
  tier: RetentionTier;
  count: number;
}
