import type { MemoryType, RetentionTier } from '../domain/types.js';
import { BOOTSTRAP_SECTIONS, type SectionDefinition } from '../bootstrap/sections.js';

export type SectionMapping = SectionDefinition;

export interface ParsedMemory {
  content: string;
  collection: string;
  type: MemoryType;
  retention_tier: RetentionTier;
  importance: number;
  tags: string[];
  section?: number;
}

/**
 * Re-exported from the shared bootstrap sections module.
 * Used by tests and consumers that previously imported from parser.
 */
export const SECTION_MAPPINGS: SectionMapping[] = BOOTSTRAP_SECTIONS;

const SECTION_HEADING_RE = /^##\s+(\d{1,2})\.\s+/m;

export class ProfileParser {
  /**
   * Parses a 12-section bootstrap profile document into discrete memory candidates.
   * Splits by `## N.` headings and maps each section to its storage metadata.
   */
  parseProfile(content: string): { memories: ParsedMemory[]; sectionsProcessed: number[] } {
    const sections = this.splitSections(content);
    const memories: ParsedMemory[] = [];
    const sectionsProcessed: number[] = [];

    for (const { sectionNumber, body } of sections) {
      const mapping = SECTION_MAPPINGS.find(m => m.section === sectionNumber);
      if (!mapping) continue;

      sectionsProcessed.push(sectionNumber);
      const chunks = this.splitByParagraphs(body);

      for (const chunk of chunks) {
        memories.push({
          content: chunk,
          collection: mapping.collection,
          type: mapping.type,
          retention_tier: mapping.retention_tier,
          importance: mapping.importance,
          tags: [...mapping.tags],
          section: sectionNumber,
        });
      }
    }

    return { memories, sectionsProcessed };
  }

  /**
   * Parses freeform markdown text into memory candidates using heading/paragraph splitting.
   * Defaults: type=semantic, tier=T2, importance=0.5.
   */
  parseFreeform(content: string): { memories: ParsedMemory[] } {
    const chunks = this.splitFreeform(content);
    const memories: ParsedMemory[] = [];

    for (const chunk of chunks) {
      memories.push({
        content: chunk,
        collection: 'general',
        type: 'semantic',
        retention_tier: 'T2',
        importance: 0.5,
        tags: ['imported'],
      });
    }

    return { memories };
  }

  private splitSections(content: string): Array<{ sectionNumber: number; body: string }> {
    const lines = content.split('\n');
    const sections: Array<{ sectionNumber: number; body: string }> = [];
    let current: { sectionNumber: number; lines: string[] } | null = null;

    for (const line of lines) {
      const match = line.match(SECTION_HEADING_RE);
      if (match) {
        if (current) {
          sections.push({ sectionNumber: current.sectionNumber, body: current.lines.join('\n').trim() });
        }
        current = { sectionNumber: parseInt(match[1]!, 10), lines: [] };
      } else if (current) {
        current.lines.push(line);
      }
    }

    if (current) {
      sections.push({ sectionNumber: current.sectionNumber, body: current.lines.join('\n').trim() });
    }

    return sections;
  }

  private splitFreeform(content: string): string[] {
    // Split on markdown headings or double-newline paragraph boundaries
    const parts = content.split(/(?=^#{1,3}\s)/m);
    const chunks: string[] = [];

    for (const part of parts) {
      // Further split long parts by double-newline paragraphs
      const paragraphs = part.split(/\n\s*\n/);
      for (const p of paragraphs) {
        const trimmed = p.trim();
        if (trimmed.length > 0) {
          chunks.push(trimmed);
        }
      }
    }

    return chunks;
  }

  private splitByParagraphs(body: string): string[] {
    const paragraphs = body.split(/\n\s*\n/);
    const chunks: string[] = [];

    for (const p of paragraphs) {
      const trimmed = p.trim();
      if (trimmed.length > 0) {
        chunks.push(trimmed);
      }
    }

    return chunks;
  }
}
