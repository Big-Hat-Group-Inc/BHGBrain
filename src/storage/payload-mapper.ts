/**
 * The one schema-narrowing mapper from an untrusted Qdrant point payload to
 * recoverable `MemoryRecord` fields — every field a payload can restore
 * short of the embedding vector itself (lifecycle, expiry, review,
 * checksum, embedding provenance, and content provenance), each independently
 * validated with a safe default rather than an unchecked cast.
 *
 * Three call sites used to hand-roll this narrowing independently:
 * `SqliteStore`'s hydration path (`hydrateBatch`/`upsertMemoryFromPayload`,
 * also reused by the `repair` tool), and `SearchService`'s cross-device
 * fallback (a ranked id present in Qdrant but missing locally). They agreed
 * on nearly every field's default already, which is precisely the risk this
 * consolidates away: a new payload field, or a changed default, previously
 * had to be updated in two places to stay in sync, and nothing would fail if
 * it wasn't — exactly the drift `add-inject-pinning`'s `pinned` field or
 * `add-memory-provenance-metadata`'s `origin`/`confidence` fields could have
 * silently hit. See strengthen-verification-and-code-boundaries tasks 3.1/3.2.
 *
 * `content` is deliberately left `string | undefined` rather than defaulted
 * here: hydration recovers a row even with degraded/missing content (falls
 * back to `''`), while search's fallback must not surface a contentless
 * result at all (drops it) — that is caller-specific policy, not narrowing,
 * so each consumer applies its own rule to the same narrowed value.
 *
 * `retention_tier` is validated against the real `RetentionTier` union here
 * (falling back to `'T2'` like an invalid `type` already did) even though
 * `SqliteStore`'s pre-consolidation inline narrowing accepted any string —
 * there is no database CHECK constraint on the column, so a corrupted or
 * foreign tier value would have been stored verbatim and then fed straight
 * into tier-keyed TTL/decay lookups (`tier_ttl[tier]`) as `undefined`. This
 * is the one deliberate behavior change in this consolidation; every other
 * field's validation and default matches both pre-existing call sites.
 */

import type { MemoryOrigin, MemorySource, MemoryType, RetentionTier, WriteOperation } from '../domain/types.js';

const MEMORY_TYPES: readonly MemoryType[] = ['episodic', 'semantic', 'procedural'];
const RETENTION_TIERS: readonly RetentionTier[] = ['T0', 'T1', 'T2', 'T3'];

function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === 'string' && (MEMORY_TYPES as readonly string[]).includes(value);
}

function isRetentionTier(value: unknown): value is RetentionTier {
  return typeof value === 'string' && (RETENTION_TIERS as readonly string[]).includes(value);
}

function narrowString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function narrowStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

// `expires_at` is stored as an ISO string but some historical/foreign
// payloads carry it as epoch seconds — both forms round-trip through here.
function narrowExpiry(value: unknown): string | null {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value * 1000).toISOString();
  }
  return null;
}

// A malformed/absent `origin` narrows to `null` ("unknown"), matching
// `SqliteStore.parseOrigin`'s fail-soft posture. See
// add-memory-provenance-metadata.
function narrowOrigin(value: unknown): MemoryOrigin | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as MemoryOrigin : null;
}

export interface RecoveredMemoryFields {
  content: string | undefined;
  summary: string;
  namespace: string;
  collection: string;
  type: MemoryType;
  category: string | null;
  tags: string[];
  // No DB CHECK constraint on `source`/`last_operation` (unlike `type`), so —
  // matching both pre-existing call sites — any string round-trips as-is
  // rather than being validated against the union and rejected.
  source: MemorySource;
  checksum: string;
  importance: number;
  retention_tier: RetentionTier;
  expires_at: string | null;
  decay_eligible: boolean;
  review_due: string | null;
  access_count: number;
  last_operation: WriteOperation;
  derived_from: string[] | null;
  pinned: boolean;
  device_id: string | null;
  embedding_model: string | null;
  origin: MemoryOrigin | null;
  confidence: number;
  created_at: string;
  last_accessed: string;
}

/**
 * `nowIso` supplies every "no recoverable timestamp" default (`created_at`,
 * `last_accessed`) — passed in rather than read via `new Date()` here so a
 * caller inserting many payloads in one pass (hydration) can share one
 * timestamp across the batch, and so this function stays pure and testable
 * against a fixed clock.
 */
export function mapQdrantPayloadToMemoryFields(payload: Record<string, unknown>, nowIso: string): RecoveredMemoryFields {
  return {
    content: narrowString(payload.content),
    summary: narrowString(payload.summary) ?? '',
    namespace: narrowString(payload.namespace) ?? 'global',
    collection: narrowString(payload.collection) ?? 'general',
    type: isMemoryType(payload.type) ? payload.type : 'semantic',
    category: narrowString(payload.category) ?? null,
    tags: narrowStringArray(payload.tags),
    source: (narrowString(payload.source) ?? 'import') as MemorySource,
    checksum: narrowString(payload.checksum) ?? '',
    importance: typeof payload.importance === 'number' ? payload.importance : 0.5,
    retention_tier: isRetentionTier(payload.retention_tier) ? payload.retention_tier : 'T2',
    expires_at: narrowExpiry(payload.expires_at),
    decay_eligible: typeof payload.decay_eligible === 'boolean' ? payload.decay_eligible : true,
    review_due: narrowString(payload.review_due) ?? null,
    access_count: typeof payload.access_count === 'number' && Number.isInteger(payload.access_count) ? payload.access_count : 0,
    last_operation: (narrowString(payload.last_operation) ?? 'ADD') as WriteOperation,
    derived_from: Array.isArray(payload.derived_from) ? narrowStringArray(payload.derived_from) : null,
    pinned: typeof payload.pinned === 'boolean' ? payload.pinned : false,
    device_id: narrowString(payload.device_id) ?? null,
    embedding_model: narrowString(payload.embedding_model) ?? null,
    origin: narrowOrigin(payload.origin),
    confidence: typeof payload.confidence === 'number' ? payload.confidence : 1.0,
    created_at: narrowString(payload.created_at) ?? nowIso,
    last_accessed: narrowString(payload.last_accessed) ?? nowIso,
  };
}
