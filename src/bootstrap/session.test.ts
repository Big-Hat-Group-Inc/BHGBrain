import { describe, it, expect, beforeEach } from 'vitest';
import initSqlJs from 'sql.js';
import { SqliteStore } from '../storage/sqlite.js';
import { BootstrapSessionManager } from './session.js';
import { TOTAL_SECTIONS } from './sections.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('BootstrapSessionManager', () => {
  let store: SqliteStore;
  let session: BootstrapSessionManager;

  beforeEach(async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-session-test-'));
    store = new SqliteStore(tempDir);
    await store.init();
    session = new BootstrapSessionManager(store);
  });

  it('creates a new session with all sections pending', () => {
    const sections = session.createOrResume('profile');

    expect(sections).toHaveLength(TOTAL_SECTIONS);
    for (const s of sections) {
      expect(s.status).toBe('pending');
      expect(s.memory_ids).toEqual([]);
    }
  });

  it('resumes an existing session without duplicating rows', () => {
    session.createOrResume('profile');
    session.markComplete('profile', 1, ['mem-1', 'mem-2']);

    const sections = session.createOrResume('profile');
    expect(sections).toHaveLength(TOTAL_SECTIONS);

    const sec1 = sections.find(s => s.section_number === 1)!;
    expect(sec1.status).toBe('complete');
    expect(sec1.memory_ids).toEqual(['mem-1', 'mem-2']);
  });

  it('marks a section as complete with memory IDs', () => {
    session.createOrResume('profile');
    session.markComplete('profile', 3, ['a', 'b', 'c']);

    const status = session.getStatus('profile')!;
    const sec3 = status.sections.find(s => s.section_number === 3)!;
    expect(sec3.status).toBe('complete');
    expect(sec3.memory_ids).toEqual(['a', 'b', 'c']);
    expect(status.complete_sections).toBe(1);
    expect(status.total_memories).toBe(3);
  });

  it('resets a section and returns memory IDs for deletion', () => {
    session.createOrResume('profile');
    session.markComplete('profile', 5, ['x', 'y']);

    const memoryIds = session.resetSection('profile', 5);
    expect(memoryIds).toEqual(['x', 'y']);

    const status = session.getStatus('profile')!;
    const sec5 = status.sections.find(s => s.section_number === 5)!;
    expect(sec5.status).toBe('pending');
    expect(sec5.memory_ids).toEqual([]);
  });

  it('reset on a pending section returns empty array', () => {
    session.createOrResume('profile');

    const memoryIds = session.resetSection('profile', 1);
    expect(memoryIds).toEqual([]);
  });

  it('returns null status for non-existent session', () => {
    const status = session.getStatus('nonexistent');
    expect(status).toBeNull();
  });

  it('exists returns false for non-existent session', () => {
    expect(session.exists('nonexistent')).toBe(false);
  });

  it('exists returns true after creation', () => {
    session.createOrResume('profile');
    expect(session.exists('profile')).toBe(true);
  });

  it('getFirstIncompleteSection returns first pending section number', () => {
    const sections = session.createOrResume('profile');
    expect(session.getFirstIncompleteSection(sections)).toBe(1);

    session.markComplete('profile', 1, ['m1']);
    session.markComplete('profile', 2, ['m2']);
    const updated = session.createOrResume('profile');
    expect(session.getFirstIncompleteSection(updated)).toBe(3);
  });

  it('getFirstIncompleteSection returns null when all complete', () => {
    session.createOrResume('profile');
    for (let i = 1; i <= TOTAL_SECTIONS; i++) {
      session.markComplete('profile', i, [`mem-${i}`]);
    }
    const sections = session.createOrResume('profile');
    expect(session.getFirstIncompleteSection(sections)).toBeNull();
  });
});
