import type { SqliteStorage, BootstrapSectionRow } from '../storage/sqlite.js';
import { TOTAL_SECTIONS } from './sections.js';

export interface SessionStatus {
  namespace: string;
  sections: BootstrapSectionRow[];
  total_sections: number;
  complete_sections: number;
  total_memories: number;
  last_updated: string | null;
}

export class BootstrapSessionManager {
  constructor(private sqlite: SqliteStorage) {}

  createOrResume(namespace: string): BootstrapSectionRow[] {
    if (!this.sqlite.bootstrapSessionExists(namespace)) {
      this.sqlite.createBootstrapSession(namespace, TOTAL_SECTIONS);
      this.sqlite.flushIfDirty();
    }
    return this.sqlite.getBootstrapSession(namespace);
  }

  getStatus(namespace: string): SessionStatus | null {
    if (!this.sqlite.bootstrapSessionExists(namespace)) {
      return null;
    }

    const sections = this.sqlite.getBootstrapSession(namespace);
    const completeSections = sections.filter(s => s.status === 'complete').length;
    const totalMemories = sections.reduce((sum, s) => sum + s.memory_ids.length, 0);
    const lastUpdated = sections
      .filter(s => s.status === 'complete')
      .map(s => s.updated_at)
      .sort()
      .pop() ?? null;

    return {
      namespace,
      sections,
      total_sections: TOTAL_SECTIONS,
      complete_sections: completeSections,
      total_memories: totalMemories,
      last_updated: lastUpdated,
    };
  }

  markComplete(namespace: string, sectionNumber: number, memoryIds: string[]): void {
    this.sqlite.updateBootstrapSection(namespace, sectionNumber, 'complete', memoryIds);
    this.sqlite.flushIfDirty();
  }

  resetSection(namespace: string, sectionNumber: number): string[] {
    const memoryIds = this.sqlite.resetBootstrapSection(namespace, sectionNumber);
    this.sqlite.flushIfDirty();
    return memoryIds;
  }

  /**
   * Reads a section's tracked memory IDs without clearing them. Pair with `clearSection`,
   * called only after every memory has been deleted, so the tracking list stays intact
   * (and the section stays recoverable) if a deletion fails partway through.
   */
  getSectionMemoryIds(namespace: string, sectionNumber: number): string[] {
    return this.sqlite.getBootstrapSectionMemoryIds(namespace, sectionNumber);
  }

  /**
   * Clears a section's tracked memory IDs and marks it pending. Must only be called after
   * every memory returned by `getSectionMemoryIds` has been successfully deleted.
   */
  clearSection(namespace: string, sectionNumber: number): void {
    this.sqlite.clearBootstrapSection(namespace, sectionNumber);
    this.sqlite.flushIfDirty();
  }

  exists(namespace: string): boolean {
    return this.sqlite.bootstrapSessionExists(namespace);
  }

  getFirstIncompleteSection(sections: BootstrapSectionRow[]): number | null {
    const pending = sections.find(s => s.status === 'pending');
    return pending ? pending.section_number : null;
  }
}
