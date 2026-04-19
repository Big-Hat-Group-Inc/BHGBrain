import { describe, it, expect } from 'vitest';
import { ProfileParser, SECTION_MAPPINGS } from './parser.js';

describe('ProfileParser', () => {
  const parser = new ProfileParser();

  describe('parseProfile', () => {
    it('parses all 10 storage-mapped sections', () => {
      const content = SECTION_MAPPINGS.map(
        m => `## ${m.section}. ${m.title}\n\nContent for section ${m.section}.`,
      ).join('\n\n');

      const { memories, sectionsProcessed } = parser.parseProfile(content);

      expect(sectionsProcessed).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(memories).toHaveLength(10);

      // Verify first section mapping
      const sec1 = memories.find(m => m.section === 1)!;
      expect(sec1.collection).toBe('identity');
      expect(sec1.type).toBe('semantic');
      expect(sec1.retention_tier).toBe('T0');
      expect(sec1.importance).toBe(1.0);
      expect(sec1.tags).toContain('identity');
    });

    it('maps each section to correct metadata', () => {
      const content = SECTION_MAPPINGS.map(
        m => `## ${m.section}. ${m.title}\n\nContent for ${m.collection}.`,
      ).join('\n\n');

      const { memories } = parser.parseProfile(content);

      for (const mapping of SECTION_MAPPINGS) {
        const mem = memories.find(m => m.section === mapping.section);
        expect(mem, `Section ${mapping.section} should produce a memory`).toBeDefined();
        expect(mem!.collection).toBe(mapping.collection);
        expect(mem!.type).toBe(mapping.type);
        expect(mem!.retention_tier).toBe(mapping.retention_tier);
        expect(mem!.importance).toBe(mapping.importance);
        expect(mem!.tags).toEqual(mapping.tags);
      }
    });

    it('handles partial profiles (missing sections)', () => {
      const content = [
        '## 1. Identity & Role\n\nJane Doe, CTO.',
        '## 7. Entity Map\n\nAcme Corp — consulting company.',
      ].join('\n\n');

      const { memories, sectionsProcessed } = parser.parseProfile(content);

      expect(sectionsProcessed).toEqual([1, 7]);
      expect(memories).toHaveLength(2);
      expect(memories[0]!.collection).toBe('identity');
      expect(memories[1]!.collection).toBe('entities');
    });

    it('splits multi-paragraph sections into multiple memories', () => {
      const content = `## 1. Identity & Role

Jane Doe — preferred short name: Jane.

Primary role: CTO at Acme Corp.

Decision types: technical architecture, hiring, vendor selection.`;

      const { memories } = parser.parseProfile(content);

      expect(memories).toHaveLength(3);
      expect(memories[0]!.content).toContain('Jane Doe');
      expect(memories[1]!.content).toContain('Primary role');
      expect(memories[2]!.content).toContain('Decision types');
    });

    it('returns empty for content with no recognized sections', () => {
      const content = 'Just some random text with no section headings.';
      const { memories, sectionsProcessed } = parser.parseProfile(content);

      expect(memories).toHaveLength(0);
      expect(sectionsProcessed).toHaveLength(0);
    });

    it('ignores sections beyond the 10 storage-mapped ones', () => {
      const content = `## 1. Identity & Role

Jane Doe.

## 11. Operating Rules for the Second Brain

Some rules.

## 12. Open Questions

Some questions.`;

      const { memories, sectionsProcessed } = parser.parseProfile(content);

      expect(sectionsProcessed).toEqual([1]);
      expect(memories).toHaveLength(1);
    });
  });

  describe('parseFreeform', () => {
    it('splits by paragraph boundaries', () => {
      const content = `First paragraph about topic A.

Second paragraph about topic B.

Third paragraph about topic C.`;

      const { memories } = parser.parseFreeform(content);

      expect(memories).toHaveLength(3);
      expect(memories[0]!.content).toContain('topic A');
      expect(memories[1]!.content).toContain('topic B');
      expect(memories[2]!.content).toContain('topic C');
    });

    it('splits by markdown headings', () => {
      const content = `## Architecture

We use microservices.

## Stack

TypeScript and Node.js.`;

      const { memories } = parser.parseFreeform(content);

      expect(memories.length).toBeGreaterThanOrEqual(2);
      const allContent = memories.map(m => m.content).join(' ');
      expect(allContent).toContain('microservices');
      expect(allContent).toContain('TypeScript');
    });

    it('assigns default metadata to all chunks', () => {
      const content = 'Some freeform text.';
      const { memories } = parser.parseFreeform(content);

      expect(memories).toHaveLength(1);
      expect(memories[0]!.collection).toBe('general');
      expect(memories[0]!.type).toBe('semantic');
      expect(memories[0]!.retention_tier).toBe('T2');
      expect(memories[0]!.importance).toBe(0.5);
      expect(memories[0]!.tags).toEqual(['imported']);
    });

    it('skips empty chunks', () => {
      const content = `First paragraph.



Second paragraph.`;

      const { memories } = parser.parseFreeform(content);

      expect(memories).toHaveLength(2);
    });

    it('returns empty for empty input', () => {
      const { memories } = parser.parseFreeform('');
      expect(memories).toHaveLength(0);
    });
  });
});
