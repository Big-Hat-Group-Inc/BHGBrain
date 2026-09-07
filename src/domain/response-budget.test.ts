import { describe, it, expect } from 'vitest';
import { assembleWithinCharBudget } from './response-budget.js';

describe('assembleWithinCharBudget', () => {
  it('keeps every item and reports truncated: false when everything fits comfortably', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const result = assembleWithinCharBudget(items, 10_000);
    expect(result.items).toEqual(items);
    expect(result.truncated).toBe(false);
  });

  it('drops trailing items and reports truncated: true once the budget would be exceeded', () => {
    // Each item serializes to about 20 chars; a budget of 50 comfortably
    // fits two but not three.
    const items = [
      { id: 'aaaaaaaaaaaaaaaa' },
      { id: 'bbbbbbbbbbbbbbbb' },
      { id: 'cccccccccccccccc' },
    ];
    const result = assembleWithinCharBudget(items, 50);
    expect(result.truncated).toBe(true);
    expect(result.items.length).toBeLessThan(items.length);
    expect(result.items).toEqual(items.slice(0, result.items.length));
  });

  it('always includes at least the first item even when it alone exceeds the budget', () => {
    const items = [{ content: 'x'.repeat(1000) }, { content: 'y' }];
    const result = assembleWithinCharBudget(items, 10);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toEqual(items[0]);
    expect(result.truncated).toBe(true);
  });

  it('returns an empty, non-truncated result for an empty input', () => {
    const result = assembleWithinCharBudget([], 100);
    expect(result.items).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('reservedChars narrows the effective budget so the caller\'s enclosing envelope is accounted for', () => {
    // Each item serializes to 25 chars; both together (with their joining
    // comma) take 51.
    const items = [{ id: 'aaaaaaaaaaaaaaaa' }, { id: 'bbbbbbbbbbbbbbbb' }];
    const withoutReserve = assembleWithinCharBudget(items, 60);
    const withReserve = assembleWithinCharBudget(items, 60, 15); // effective budget 45 < 51
    expect(withoutReserve.truncated).toBe(false);
    expect(withReserve.truncated).toBe(true);
    expect(withReserve.items.length).toBeLessThan(withoutReserve.items.length);
  });

  it('the assembled array, once serialized, never exceeds maxChars minus reservedChars (plus the array\'s own 2 bracket chars, which reservedChars is documented to cover)', () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ id: `item-${i}`, content: 'x'.repeat(500) }));
    const maxChars = 5000;
    const reservedChars = 100;
    const result = assembleWithinCharBudget(items, maxChars, reservedChars);
    const serializedLength = JSON.stringify(result.items).length;
    expect(serializedLength).toBeLessThanOrEqual(maxChars - reservedChars + 2);
    expect(result.truncated).toBe(true);
  });
});
