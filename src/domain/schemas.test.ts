import { describe, it, expect } from 'vitest';
import {
  RememberInputSchema, RecallInputSchema, ForgetInputSchema,
  SearchInputSchema, TagInputSchema, CollectionsInputSchema,
  CategoryInputSchema,
} from './schemas.js';

describe('RememberInputSchema', () => {
  it('accepts valid minimal input', () => {
    const result = RememberInputSchema.parse({ content: 'hello world' });
    expect(result.content).toBe('hello world');
    expect(result.namespace).toBe('global');
    expect(result.collection).toBe('general');
    expect(result.source).toBe('cli');
    expect(result.tags).toEqual([]);
  });

  it('accepts full input', () => {
    const result = RememberInputSchema.parse({
      content: 'test',
      namespace: 'myns',
      collection: 'mycol',
      type: 'episodic',
      tags: ['tag1', 'tag2'],
      importance: 0.8,
      source: 'agent',
    });
    expect(result.type).toBe('episodic');
    expect(result.tags).toEqual(['tag1', 'tag2']);
  });

  it('rejects unknown fields', () => {
    expect(() => RememberInputSchema.parse({ content: 'x', unknown: true })).toThrow();
  });

  it('rejects invalid namespace', () => {
    expect(() => RememberInputSchema.parse({ content: 'x', namespace: 'has spaces!' })).toThrow();
  });

  it('rejects invalid type', () => {
    expect(() => RememberInputSchema.parse({ content: 'x', type: 'invalid' })).toThrow();
  });

  it('rejects content over 100000 chars', () => {
    expect(() => RememberInputSchema.parse({ content: 'x'.repeat(100001) })).toThrow();
  });

  it('rejects more than 20 tags', () => {
    const tags = Array.from({ length: 21 }, (_, i) => `tag${i}`);
    expect(() => RememberInputSchema.parse({ content: 'x', tags })).toThrow();
  });

  it('rejects invalid tag format', () => {
    expect(() => RememberInputSchema.parse({ content: 'x', tags: ['has spaces'] })).toThrow();
  });

  it('strips control characters from content', () => {
    const result = RememberInputSchema.parse({ content: 'hello\x00world' });
    expect(result.content).toBe('helloworld');
  });
});

describe('RecallInputSchema', () => {
  it('accepts valid input with defaults', () => {
    const result = RecallInputSchema.parse({ query: 'test query' });
    expect(result.limit).toBe(5);
    expect(result.min_score).toBe(0.6);
    expect(result.namespace).toBe('global');
  });

  it('rejects query over 500 chars', () => {
    expect(() => RecallInputSchema.parse({ query: 'x'.repeat(501) })).toThrow();
  });
});

describe('ForgetInputSchema', () => {
  it('accepts valid UUID', () => {
    const result = ForgetInputSchema.parse({ id: '550e8400-e29b-41d4-a716-446655440000' });
    expect(result.id).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('rejects non-UUID', () => {
    expect(() => ForgetInputSchema.parse({ id: 'not-a-uuid' })).toThrow();
  });
});

describe('SearchInputSchema', () => {
  it('defaults to hybrid mode', () => {
    const result = SearchInputSchema.parse({ query: 'test' });
    expect(result.mode).toBe('hybrid');
    expect(result.limit).toBe(10);
  });

  it('accepts all modes', () => {
    for (const mode of ['semantic', 'fulltext', 'hybrid']) {
      const result = SearchInputSchema.parse({ query: 'test', mode });
      expect(result.mode).toBe(mode);
    }
  });

  it('rejects limit > 50', () => {
    expect(() => SearchInputSchema.parse({ query: 'test', limit: 51 })).toThrow();
  });
});

describe('TagInputSchema', () => {
  it('accepts add and remove arrays', () => {
    const result = TagInputSchema.parse({
      id: '550e8400-e29b-41d4-a716-446655440000',
      add: ['new-tag'],
      remove: ['old-tag'],
    });
    expect(result.add).toEqual(['new-tag']);
    expect(result.remove).toEqual(['old-tag']);
  });
});

describe('CollectionsInputSchema', () => {
  it('accepts valid actions', () => {
    for (const action of ['list', 'create', 'delete']) {
      expect(() => CollectionsInputSchema.parse({ action })).not.toThrow();
    }
  });
});

describe('CategoryInputSchema', () => {
  it('accepts all actions', () => {
    for (const action of ['list', 'get', 'set', 'delete']) {
      expect(() => CategoryInputSchema.parse({ action })).not.toThrow();
    }
  });

  it('accepts valid slot values', () => {
    for (const slot of ['company-values', 'architecture', 'coding-requirements', 'custom']) {
      expect(() => CategoryInputSchema.parse({ action: 'set', slot, name: 'test', content: 'test' })).not.toThrow();
    }
  });
});
