import { describe, it, expect } from 'vitest';
import { BOOTSTRAP_SECTIONS, TOTAL_SECTIONS, getSectionByNumber } from './sections.js';

describe('BOOTSTRAP_SECTIONS', () => {
  it('has 10 sections', () => {
    expect(BOOTSTRAP_SECTIONS).toHaveLength(10);
    expect(TOTAL_SECTIONS).toBe(10);
  });

  it('sections are numbered 1 through 10', () => {
    const numbers = BOOTSTRAP_SECTIONS.map(s => s.section);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('every section has a non-empty title', () => {
    for (const s of BOOTSTRAP_SECTIONS) {
      expect(s.title.length, `Section ${s.section} title`).toBeGreaterThan(0);
    }
  });

  it('every section has a valid collection name', () => {
    for (const s of BOOTSTRAP_SECTIONS) {
      expect(s.collection, `Section ${s.section} collection`).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('every section has a valid memory type', () => {
    const validTypes = ['episodic', 'semantic', 'procedural'];
    for (const s of BOOTSTRAP_SECTIONS) {
      expect(validTypes, `Section ${s.section} type`).toContain(s.type);
    }
  });

  it('every section has a valid retention tier', () => {
    const validTiers = ['T0', 'T1', 'T2', 'T3'];
    for (const s of BOOTSTRAP_SECTIONS) {
      expect(validTiers, `Section ${s.section} tier`).toContain(s.retention_tier);
    }
  });

  it('every section has importance between 0 and 1', () => {
    for (const s of BOOTSTRAP_SECTIONS) {
      expect(s.importance).toBeGreaterThanOrEqual(0);
      expect(s.importance).toBeLessThanOrEqual(1);
    }
  });

  it('every section has at least one tag', () => {
    for (const s of BOOTSTRAP_SECTIONS) {
      expect(s.tags.length, `Section ${s.section} tags`).toBeGreaterThan(0);
    }
  });

  it('every section has at least one question', () => {
    for (const s of BOOTSTRAP_SECTIONS) {
      expect(s.questions.length, `Section ${s.section} questions`).toBeGreaterThan(0);
    }
  });

  it('getSectionByNumber returns correct section', () => {
    const s1 = getSectionByNumber(1);
    expect(s1).toBeDefined();
    expect(s1!.collection).toBe('identity');

    const s10 = getSectionByNumber(10);
    expect(s10).toBeDefined();
    expect(s10!.collection).toBe('operating-rules');
  });

  it('getSectionByNumber returns undefined for invalid number', () => {
    expect(getSectionByNumber(0)).toBeUndefined();
    expect(getSectionByNumber(11)).toBeUndefined();
    expect(getSectionByNumber(-1)).toBeUndefined();
  });
});
