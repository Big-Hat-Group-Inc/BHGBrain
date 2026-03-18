import { z } from 'zod';

const NAMESPACE_RE = /^[a-zA-Z0-9/-]{1,200}$/;
const TAG_RE = /^[a-zA-Z0-9-]+$/;

export const MemoryTypeSchema = z.enum(['episodic', 'semantic', 'procedural']);
export const CategorySlotSchema = z.enum(['company-values', 'architecture', 'coding-requirements', 'custom']);
export const MemorySourceSchema = z.enum(['cli', 'api', 'agent', 'import']);
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
}).strict();

export const RecallInputSchema = z.object({
  query: QuerySchema.transform(stripControlChars),
  namespace: NamespaceSchema.default('global'),
  collection: NameSchema.optional(),
  type: MemoryTypeSchema.optional(),
  tags: TagsSchema.optional(),
  limit: z.number().int().min(1).max(20).default(5),
  min_score: z.number().min(0).max(1).default(0.6),
}).strict();

export const ForgetInputSchema = z.object({
  id: z.string().uuid(),
}).strict();

export const SearchInputSchema = z.object({
  query: QuerySchema.transform(stripControlChars),
  namespace: NamespaceSchema.default('global'),
  collection: NameSchema.optional(),
  mode: SearchModeSchema.default('hybrid'),
  limit: z.number().int().min(1).max(50).default(10),
}).strict();

export const TagInputSchema = z.object({
  id: z.string().uuid(),
  add: TagsSchema.optional().default([]),
  remove: TagsSchema.optional().default([]),
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

export const RepairInputSchema = z.object({
  dry_run: z.boolean().optional().default(false),
}).strict();

export type RememberInput = z.infer<typeof RememberInputSchema>;
export type RecallInput = z.infer<typeof RecallInputSchema>;
export type ForgetInput = z.infer<typeof ForgetInputSchema>;
export type SearchInput = z.infer<typeof SearchInputSchema>;
export type TagInput = z.infer<typeof TagInputSchema>;
export type CollectionsInput = z.infer<typeof CollectionsInputSchema>;
export type CategoryInput = z.infer<typeof CategoryInputSchema>;
export type BackupInput = z.infer<typeof BackupInputSchema>;
export type RepairInput = z.infer<typeof RepairInputSchema>;
