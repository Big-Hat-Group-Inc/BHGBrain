import { describe, it, expect, vi, beforeEach } from 'vitest';
import initSqlJs from 'sql.js';
import { SqliteStore } from '../storage/sqlite.js';
import { handleTool, type ToolContext } from './index.js';
import type { StorageManager } from '../storage/index.js';
import type { EmbeddingProvider } from '../embedding/index.js';
import type { WritePipeline } from '../pipeline/index.js';
import type { SearchService } from '../search/index.js';
import type { BackupService } from '../backup/index.js';
import type { HealthService } from '../health/index.js';
import type { MetricsCollector } from '../health/metrics.js';
import type pino from 'pino';
import { TOTAL_SECTIONS } from '../bootstrap/sections.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('bootstrap tool', () => {
  let ctx: ToolContext;
  let store: SqliteStore;
  let pipelineProcess: ReturnType<typeof vi.fn>;
  let deleteMemory: ReturnType<typeof vi.fn>;
  let memCounter: number;

  beforeEach(async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'bhgbrain-bootstrap-test-'));
    store = new SqliteStore(tempDir);
    await store.init();

    memCounter = 0;
    pipelineProcess = vi.fn(async () => {
      memCounter++;
      return [{ id: `mem-${memCounter}`, summary: 'test', type: 'semantic', operation: 'ADD', created_at: '2026-01-01' }];
    });
    deleteMemory = vi.fn(async () => true);

    ctx = {
      config: { device: { id: 'dev-1' } } as ToolContext['config'],
      storage: {
        sqlite: store,
        deleteMemory,
      } as unknown as StorageManager,
      embedding: { model: 'm', dimensions: 1 } as EmbeddingProvider,
      pipeline: { process: pipelineProcess } as unknown as WritePipeline,
      search: {} as SearchService,
      backup: {} as BackupService,
      health: {} as HealthService,
      metrics: { incCounter: vi.fn(), recordHistogram: vi.fn(), setGauge: vi.fn() } as unknown as MetricsCollector,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as pino.Logger,
    };
  });

  describe('full flow: start → submit all → completion', () => {
    it('completes all 10 sections', async () => {
      // Start
      const startResult = await handleTool(ctx, 'bootstrap', { action: 'start' }) as Record<string, unknown>;
      expect(startResult.complete).toBe(false);
      expect(startResult.current_section).toBe(1);
      expect(Array.isArray(startResult.questions)).toBe(true);

      // Submit all sections
      for (let i = 1; i <= TOTAL_SECTIONS; i++) {
        const result = await handleTool(ctx, 'bootstrap', {
          action: 'submit',
          section: i,
          answers: `Answer for section ${i}.`,
        }) as Record<string, unknown>;

        expect(result.submitted).toBe(i);
        expect(result.memories_stored).toBeGreaterThan(0);

        if (i < TOTAL_SECTIONS) {
          expect(result.complete).toBe(false);
          expect(result.next_section).toBe(i + 1);
        } else {
          expect(result.complete).toBe(true);
        }
      }

      // Status should show all complete
      const status = await handleTool(ctx, 'bootstrap', { action: 'status' }) as Record<string, unknown>;
      expect(status.complete_sections).toBe(TOTAL_SECTIONS);
      expect(status.total_memories).toBe(TOTAL_SECTIONS);
    });
  });

  describe('resume after restart', () => {
    it('resumes from first incomplete section', async () => {
      // Start and submit first 3 sections
      await handleTool(ctx, 'bootstrap', { action: 'start' });
      for (let i = 1; i <= 3; i++) {
        await handleTool(ctx, 'bootstrap', {
          action: 'submit', section: i, answers: `Answer ${i}.`,
        });
      }

      // "Restart" — call start again
      const resumed = await handleTool(ctx, 'bootstrap', { action: 'start' }) as Record<string, unknown>;
      expect(resumed.complete).toBe(false);
      expect(resumed.current_section).toBe(4);
      expect((resumed.progress as Record<string, number>).complete).toBe(3);
    });
  });

  describe('reset section', () => {
    it('resets a section and deletes its memories', async () => {
      await handleTool(ctx, 'bootstrap', { action: 'start' });
      await handleTool(ctx, 'bootstrap', {
        action: 'submit', section: 1, answers: 'Jane Doe, CTO.',
      });

      // Reset section 1
      const resetResult = await handleTool(ctx, 'bootstrap', {
        action: 'reset', section: 1,
      }) as Record<string, unknown>;

      expect(resetResult.memories_removed).toBe(1);
      expect(deleteMemory).toHaveBeenCalledTimes(1);

      // Section 1 should be pending again — start returns it
      const startResult = await handleTool(ctx, 'bootstrap', { action: 'start' }) as Record<string, unknown>;
      expect(startResult.current_section).toBe(1);
    });

    it('no-ops on pending section', async () => {
      await handleTool(ctx, 'bootstrap', { action: 'start' });

      const resetResult = await handleTool(ctx, 'bootstrap', {
        action: 'reset', section: 1,
      }) as Record<string, unknown>;

      expect(resetResult.memories_removed).toBe(0);
      expect(deleteMemory).not.toHaveBeenCalled();
    });

    it('allows re-submission after reset', async () => {
      await handleTool(ctx, 'bootstrap', { action: 'start' });
      await handleTool(ctx, 'bootstrap', {
        action: 'submit', section: 1, answers: 'Old answer.',
      });
      await handleTool(ctx, 'bootstrap', {
        action: 'reset', section: 1,
      });

      // Re-submit
      const result = await handleTool(ctx, 'bootstrap', {
        action: 'submit', section: 1, answers: 'New answer.',
      }) as Record<string, unknown>;

      expect(result.submitted).toBe(1);
      expect(result.memories_stored).toBe(1);
    });
  });

  describe('validation', () => {
    it('rejects submit without section', async () => {
      await handleTool(ctx, 'bootstrap', { action: 'start' });
      const result = await handleTool(ctx, 'bootstrap', {
        action: 'submit', answers: 'Some answer.',
      }) as Record<string, unknown>;

      expect(result.error).toBeDefined();
    });

    it('rejects submit on already complete section', async () => {
      await handleTool(ctx, 'bootstrap', { action: 'start' });
      await handleTool(ctx, 'bootstrap', {
        action: 'submit', section: 1, answers: 'Answer.',
      });

      const result = await handleTool(ctx, 'bootstrap', {
        action: 'submit', section: 1, answers: 'Another answer.',
      }) as Record<string, unknown>;

      expect(result.error).toBeDefined();
      expect((result.error as Record<string, unknown>).code).toBe('INVALID_INPUT');
    });

    it('status without session suggests starting', async () => {
      const result = await handleTool(ctx, 'bootstrap', { action: 'status' }) as Record<string, unknown>;
      expect(result.exists).toBe(false);
      expect(typeof result.message).toBe('string');
    });
  });
});
