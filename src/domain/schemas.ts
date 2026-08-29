import { z } from 'zod';

const NAMESPACE_RE = /^[a-zA-Z0-9/-]{1,200}$/;
const TAG_RE = /^[a-zA-Z0-9-]+$/;

export const MemoryTypeSchema = z.enum(['episodic', 'semantic', 'procedural']);
export const CategorySlotSchema = z.enum(['company-values', 'architecture', 'coding-requirements', 'custom']);
export const MemorySourceSchema = z.enum(['cli', 'api', 'agent', 'import', 'distillation']);
export const WriteOperationSchema = z.enum(['ADD', 'UPDATE', 'DELETE', 'NOOP']);
export const SearchModeSchema = z.enum(['semantic', 'fulltext', 'hybrid']);
export const RetentionTierSchema = z.enum(['T0', 'T1', 'T2', 'T3']);

export const NamespaceSchema = z.string().regex(NAMESPACE_RE, 'Namespace must match ^[a-zA-Z0-9/-]{1,200}$');
export const TagSchema = z.string().max(100).regex(TAG_RE, 'Tag must match ^[a-zA-Z0-9-]+$');
export const TagsSchema = z.array(TagSchema).max(20);
export const ContentSchema = z.string().min(1).max(100000);
export const QuerySchema = z.string().min(1).max(500);
export const NameSchema = z.string().min(1).max(100);

function stripControlChars(s: string): string {
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

// -- Tool Input Schemas --

export const RememberInputSchema = z.object({
  content: ContentSchema.transform(stripControlChars),
  namespace: NamespaceSchema.default('global'),
  collection: NameSchema.default('general'),
  type: MemoryTypeSchema.optional(),
  tags: TagsSchema.optional().default([]),
  category: z.string().max(100).optional(),
  importance: z.number().min(0).max(1).optional(),
  source: MemorySourceSchema.optional().default('cli'),
  retention_tier: RetentionTierSchema.optional(),
  // Explicit-set-wins on UPDATE (preserves existing state when omitted);
  // defaults to false on ADD when omitted. See add-inject-pinning.
  pinned: z.boolean().optional(),
}).strict();

export const RecallInputSchema = z.object({
  query: QuerySchema.transform(stripControlChars),
  namespace: NamespaceSchema.default('global'),
  collection: NameSchema.optional(),
  type: MemoryTypeSchema.optional(),
  tags: TagsSchema.optional(),
  limit: z.number().int().min(1).max(20).default(5),
  min_score: z.number().min(0).max(1).default(0.6),
  after: z.string().datetime().optional(),
  before: z.string().datetime().optional(),
  // Opt-in one-hop neighbor expansion (add-memory-links): appends each
  // result's linked memories (relate tool edges, both directions, all
  // relations), marked linked_from/link_relation/link_direction. Default
  // false leaves recall's output unchanged from before this parameter
  // existed.
  follow_links: z.boolean().optional().default(false),
}).strict().refine(
  data => data.after === undefined || data.before === undefined || data.after <= data.before,
  { message: 'after must not be later than before', path: ['after'] },
);

export const ForgetInputSchema = z.object({
  id: z.string().uuid(),
}).strict();

export const SearchInputSchema = z.object({
  query: QuerySchema.transform(stripControlChars),
  namespace: NamespaceSchema.default('global'),
  collection: NameSchema.optional(),
  mode: SearchModeSchema.default('hybrid'),
  limit: z.number().int().min(1).max(50).default(10),
  // Additive opt-in (add-review-and-archive-recall): archived matches are
  // appended after active results, marked `archived: true`, and never count
  // against `limit`'s reduction of active results — see `search/index.ts`.
  include_archived: z.boolean().optional().default(false),
  after: z.string().datetime().optional(),
  before: z.string().datetime().optional(),
}).strict().refine(
  data => data.after === undefined || data.before === undefined || data.after <= data.before,
  { message: 'after must not be later than before', path: ['after'] },
);

export const TagInputSchema = z.object({
  id: z.string().uuid(),
  add: TagsSchema.optional().default([]),
  remove: TagsSchema.optional().default([]),
  // Dedicated pin/unpin toggle, applied only when present. See add-inject-pinning.
  pinned: z.boolean().optional(),
}).strict();

export const CollectionsInputSchema = z.object({
  action: z.enum(['list', 'create', 'delete']),
  namespace: NamespaceSchema.default('global'),
  name: NameSchema.optional(),
  force: z.boolean().optional().default(false),
}).strict();

export const CategoryInputSchema = z.object({
  action: z.enum(['list', 'get', 'set', 'delete']),
  name: NameSchema.optional(),
  slot: CategorySlotSchema.optional(),
  content: ContentSchema.transform(stripControlChars).optional(),
}).strict();

export const BackupInputSchema = z.object({
  action: z.enum(['create', 'restore', 'list']),
  path: z.string().optional(),
}).strict();

export const RevisionsInputSchema = z.object({
  action: z.enum(['list', 'revert']),
  id: z.string().uuid(),
  revision: z.number().int().positive().optional(),
}).strict().refine(
  data => data.action !== 'revert' || data.revision !== undefined,
  { message: 'revision is required for revert', path: ['revision'] },
);

export const ReviewInputSchema = z.object({
  action: z.enum(['list', 'keep', 'archive', 'restore']),
  // Required for keep/archive/restore (the memory id being actioned on; for
  // restore this is the original memory's id used to look up its archive
  // record — enforced below since it's action-dependent). Unused by list.
  id: z.string().uuid().optional(),
  // list only: look-ahead window in days beyond "due now" (0 = due only).
  days: z.number().int().min(0).max(3650).optional().default(0),
  namespace: NamespaceSchema.default('global'),
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
}).strict().refine(
  data => data.action === 'list' || data.id !== undefined,
  { message: 'id is required for keep, archive, and restore', path: ['id'] },
);

export const MemoryLinkRelationSchema = z.enum([
  'refines', 'contradicts', 'derived_from', 'about_same_entity', 'follows',
]);

export const RelateInputSchema = z.object({
  action: z.enum(['add', 'list', 'remove']),
  from_id: z.string().uuid().optional(),
  to_id: z.string().uuid().optional(),
  relation: MemoryLinkRelationSchema.optional(),
  // list only: the memory whose links to list.
  id: z.string().uuid().optional(),
  // list only: direction filter relative to `id`. Storage always returns
  // both directions; the handler post-filters when this is not 'both'.
  direction: z.enum(['from', 'to', 'both']).optional().default('both'),
}).strict().refine(
  data => data.action !== 'add' || (data.from_id !== undefined && data.to_id !== undefined && data.relation !== undefined),
  { message: 'from_id, to_id, and relation are required for add', path: ['from_id'] },
).refine(
  data => data.action !== 'remove' || (data.from_id !== undefined && data.to_id !== undefined && data.relation !== undefined),
  { message: 'from_id, to_id, and relation are required for remove', path: ['from_id'] },
).refine(
  data => data.action !== 'list' || data.id !== undefined,
  { message: 'id is required for list', path: ['id'] },
).refine(
  data => (data.action !== 'add' && data.action !== 'remove') || data.from_id !== data.to_id,
  { message: 'from_id and to_id must differ', path: ['to_id'] },
);

export const FeedbackInputSchema = z.object({
  id: z.string().uuid(),
  useful: z.boolean(),
  query: z.string().max(500).optional(),
  score: z.number().min(0).max(1).optional(),
}).strict();

export const RepairInputSchema = z.object({
  // 'from-qdrant' (default): the pre-existing behavior — recover memories
  // missing from SQLite by scrolling Qdrant payloads. 're-embed': the
  // embedding-provenance migration — re-embed memories whose stamp differs
  // from the active embedding identity. Kept on one tool (rather than a new
  // one) per the design's "extend repair" decision: it already owns
  // cross-store reconciliation UX, dry-run convention, and device scoping.
  mode: z.enum(['from-qdrant', 're-embed']).optional().default('from-qdrant'),
  dry_run: z.boolean().optional().default(false),
  device_id: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/).optional(),
  all_devices: z.boolean().optional().default(false),
  // re-embed only: also re-embed legacy rows with no stamp at all (NULL),
  // not just rows stamped with a different identity. Defaults false per
  // "Legacy unstamped rows ... included in migration only when explicitly
  // requested".
  include_legacy: z.boolean().optional().default(false),
  // re-embed only: memories re-embedded per batch.
  batch_size: z.number().int().min(1).max(500).optional().default(50),
}).strict().refine(
  data => !(data.all_devices && data.device_id !== undefined),
  { message: 'device_id and all_devices are mutually exclusive', path: ['all_devices'] },
);

export const ConsolidateInputSchema = z.object({
  action: z.enum(['list', 'merge']),
  namespace: NamespaceSchema.default('global'),
  collection: NameSchema.default('general'),
  // list only: cursor from a prior list call, and the minimum cluster size
  // (edges within the scanned page) below which a cluster is dropped.
  cursor: z.string().optional(),
  min_cluster_size: z.number().int().min(2).default(2),
  // merge only: the human-chosen canonical memory and the ids merged into it.
  target_id: z.string().uuid().optional(),
  source_ids: z.array(z.string().uuid()).min(1).optional(),
}).strict().refine(
  data => data.action !== 'merge' || (data.target_id !== undefined && data.source_ids !== undefined),
  { message: 'target_id and source_ids are required for merge', path: ['target_id'] },
).refine(
  data => data.action !== 'merge' || !data.source_ids?.includes(data.target_id!),
  { message: 'target_id must not appear in source_ids', path: ['source_ids'] },
);

export type RememberInput = z.infer<typeof RememberInputSchema>;
export type RecallInput = z.infer<typeof RecallInputSchema>;
export type ForgetInput = z.infer<typeof ForgetInputSchema>;
export type SearchInput = z.infer<typeof SearchInputSchema>;
export type TagInput = z.infer<typeof TagInputSchema>;
export type CollectionsInput = z.infer<typeof CollectionsInputSchema>;
export type CategoryInput = z.infer<typeof CategoryInputSchema>;
export type BackupInput = z.infer<typeof BackupInputSchema>;
export type RepairInput = z.infer<typeof RepairInputSchema>;
export type RevisionsInput = z.infer<typeof RevisionsInputSchema>;
export type ReviewInput = z.infer<typeof ReviewInputSchema>;
export type ConsolidateInput = z.infer<typeof ConsolidateInputSchema>;
export type RelateInput = z.infer<typeof RelateInputSchema>;
export type FeedbackInput = z.infer<typeof FeedbackInputSchema>;
