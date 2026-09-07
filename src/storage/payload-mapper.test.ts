import { describe, it, expect } from 'vitest';
import { mapQdrantPayloadToMemoryFields } from './payload-mapper.js';

// strengthen-verification-and-code-boundaries task 3.1: the one canonical
// Qdrant-payload-to-memory-fields mapper hydration, repair, and search
// fallback all consume — tested standalone here, independent of any
// transport/storage setup, so this file governs every recovery/fallback
// consumer's field coverage in one place (task 3.2's round-trip tests then
// confirm each consumer actually wires it up).
describe('mapQdrantPayloadToMemoryFields', () => {
  const NOW = '2026-09-06T12:00:00.000Z';

  it('recovers every field from a fully-populated payload unchanged', () => {
    const payload = {
      content: 'full content', summary: 'full summary', namespace: 'team-a', collection: 'work',
      type: 'episodic', category: 'policy', tags: ['a', 'b'], source: 'agent', checksum: 'chk-1',
      importance: 0.75, retention_tier: 'T1', expires_at: '2027-01-01T00:00:00.000Z',
      decay_eligible: false, review_due: '2026-12-01T00:00:00.000Z', access_count: 5,
      last_operation: 'UPDATE', derived_from: ['src-1', 'src-2'], pinned: true, device_id: 'device-9',
      embedding_model: 'openai/text-embedding-3-small@1536',
      origin: { session_id: 'sess-1', tool: 'claude-code' }, confidence: 0.9,
      created_at: '2026-01-01T00:00:00.000Z', last_accessed: '2026-06-01T00:00:00.000Z',
    };

    expect(mapQdrantPayloadToMemoryFields(payload, NOW)).toEqual({
      content: 'full content', summary: 'full summary', namespace: 'team-a', collection: 'work',
      type: 'episodic', category: 'policy', tags: ['a', 'b'], source: 'agent', checksum: 'chk-1',
      importance: 0.75, retention_tier: 'T1', expires_at: '2027-01-01T00:00:00.000Z',
      decay_eligible: false, review_due: '2026-12-01T00:00:00.000Z', access_count: 5,
      last_operation: 'UPDATE', derived_from: ['src-1', 'src-2'], pinned: true, device_id: 'device-9',
      embedding_model: 'openai/text-embedding-3-small@1536',
      origin: { session_id: 'sess-1', tool: 'claude-code' }, confidence: 0.9,
      created_at: '2026-01-01T00:00:00.000Z', last_accessed: '2026-06-01T00:00:00.000Z',
    });
  });

  it('applies every safe default for a completely empty payload', () => {
    expect(mapQdrantPayloadToMemoryFields({}, NOW)).toEqual({
      content: undefined, summary: '', namespace: 'global', collection: 'general',
      type: 'semantic', category: null, tags: [], source: 'import', checksum: '',
      importance: 0.5, retention_tier: 'T2', expires_at: null, decay_eligible: true,
      review_due: null, access_count: 0, last_operation: 'ADD', derived_from: null,
      pinned: false, device_id: null, embedding_model: null, origin: null, confidence: 1.0,
      created_at: NOW, last_accessed: NOW,
    });
  });

  it('leaves content undefined (not defaulted) so callers can decide unusable vs recoverable', () => {
    expect(mapQdrantPayloadToMemoryFields({ content: 123 }, NOW).content).toBeUndefined();
    expect(mapQdrantPayloadToMemoryFields({ content: '' }, NOW).content).toBe('');
  });

  // Lifecycle: retention_tier is the one field whose default is stricter
  // than the pre-consolidation SqliteStore inline narrowing — see the
  // module doc comment.
  it('falls back retention_tier to T2 for a value outside T0-T3, not the raw string', () => {
    expect(mapQdrantPayloadToMemoryFields({ retention_tier: 'not-a-tier' }, NOW).retention_tier).toBe('T2');
    expect(mapQdrantPayloadToMemoryFields({ retention_tier: 'T0' }, NOW).retention_tier).toBe('T0');
  });

  it('falls back decay_eligible to true for a non-boolean value', () => {
    expect(mapQdrantPayloadToMemoryFields({ decay_eligible: 'yes' }, NOW).decay_eligible).toBe(true);
    expect(mapQdrantPayloadToMemoryFields({ decay_eligible: false }, NOW).decay_eligible).toBe(false);
  });

  // Expiry: both an ISO string and legacy epoch-seconds forms round-trip.
  it('narrows expires_at from either an ISO string or epoch seconds, else null', () => {
    expect(mapQdrantPayloadToMemoryFields({ expires_at: '2027-01-01T00:00:00.000Z' }, NOW).expires_at)
      .toBe('2027-01-01T00:00:00.000Z');
    expect(mapQdrantPayloadToMemoryFields({ expires_at: 1798761600 }, NOW).expires_at)
      .toBe(new Date(1798761600 * 1000).toISOString());
    expect(mapQdrantPayloadToMemoryFields({ expires_at: 'not-a-date' }, NOW).expires_at).toBeNull();
    expect(mapQdrantPayloadToMemoryFields({ expires_at: -1 }, NOW).expires_at).toBeNull();
  });

  // Review: review_due follows the same plain-string-or-null narrowing as
  // every other timestamp field with no dedicated "unknown" sentinel.
  it('narrows review_due to a string or null', () => {
    expect(mapQdrantPayloadToMemoryFields({ review_due: '2026-12-01T00:00:00.000Z' }, NOW).review_due)
      .toBe('2026-12-01T00:00:00.000Z');
    expect(mapQdrantPayloadToMemoryFields({ review_due: 12345 }, NOW).review_due).toBeNull();
  });

  // Checksum: never defaults to a placeholder that could collide with a
  // real checksum — an empty string is itself already outside the checksum
  // format real writes produce.
  it('falls back checksum to an empty string when absent or non-string', () => {
    expect(mapQdrantPayloadToMemoryFields({ checksum: 'real-checksum' }, NOW).checksum).toBe('real-checksum');
    expect(mapQdrantPayloadToMemoryFields({ checksum: 42 }, NOW).checksum).toBe('');
  });

  // Embedding provenance: null means "unknown", never the active
  // configuration's identity — this is metadata recovery, not a new write.
  it('carries embedding_model forward verbatim, or null when absent', () => {
    expect(mapQdrantPayloadToMemoryFields({ embedding_model: 'azure-foundry/x@1536' }, NOW).embedding_model)
      .toBe('azure-foundry/x@1536');
    expect(mapQdrantPayloadToMemoryFields({}, NOW).embedding_model).toBeNull();
  });

  // Content provenance: origin/confidence.
  it('narrows origin to a plain object or null, rejecting arrays and non-objects', () => {
    expect(mapQdrantPayloadToMemoryFields({ origin: { tool: 'cli' } }, NOW).origin).toEqual({ tool: 'cli' });
    expect(mapQdrantPayloadToMemoryFields({ origin: ['not', 'an', 'object'] }, NOW).origin).toBeNull();
    expect(mapQdrantPayloadToMemoryFields({ origin: 'not-an-object' }, NOW).origin).toBeNull();
    expect(mapQdrantPayloadToMemoryFields({ origin: null }, NOW).origin).toBeNull();
  });

  it('falls back confidence to 1.0 for a non-number value', () => {
    expect(mapQdrantPayloadToMemoryFields({ confidence: 0.42 }, NOW).confidence).toBe(0.42);
    expect(mapQdrantPayloadToMemoryFields({ confidence: 'high' }, NOW).confidence).toBe(1.0);
  });

  it('filters tags and derived_from to string-only arrays, dropping non-string entries', () => {
    expect(mapQdrantPayloadToMemoryFields({ tags: ['a', 1, 'b', null] }, NOW).tags).toEqual(['a', 'b']);
    expect(mapQdrantPayloadToMemoryFields({ tags: 'not-an-array' }, NOW).tags).toEqual([]);
    expect(mapQdrantPayloadToMemoryFields({ derived_from: ['s1', 2, 's2'] }, NOW).derived_from).toEqual(['s1', 's2']);
    // derived_from's absence-vs-empty-array distinction is preserved
    // (null, not []) — mirrors merged_from's "no predecessor" convention.
    expect(mapQdrantPayloadToMemoryFields({}, NOW).derived_from).toBeNull();
  });

  it('falls back type to semantic for an out-of-enum value', () => {
    expect(mapQdrantPayloadToMemoryFields({ type: 'not-a-type' }, NOW).type).toBe('semantic');
    expect(mapQdrantPayloadToMemoryFields({ type: 'procedural' }, NOW).type).toBe('procedural');
  });

  it('falls back access_count to 0 for a non-integer value', () => {
    expect(mapQdrantPayloadToMemoryFields({ access_count: 3.5 }, NOW).access_count).toBe(0);
    expect(mapQdrantPayloadToMemoryFields({ access_count: -1 }, NOW).access_count).toBe(-1);
    expect(mapQdrantPayloadToMemoryFields({ access_count: 'many' }, NOW).access_count).toBe(0);
  });

  it('carries source and last_operation through as-is, matching the columns\' absent CHECK constraints', () => {
    expect(mapQdrantPayloadToMemoryFields({ source: 'anything' }, NOW).source).toBe('anything');
    expect(mapQdrantPayloadToMemoryFields({ last_operation: 'anything' }, NOW).last_operation).toBe('anything');
  });

  it('restores pinned from the payload rather than defaulting a repair rebuild to unpinned', () => {
    expect(mapQdrantPayloadToMemoryFields({ pinned: true }, NOW).pinned).toBe(true);
    expect(mapQdrantPayloadToMemoryFields({ pinned: 'true' }, NOW).pinned).toBe(false);
  });
});
