import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseCronExpression, nextRunAfter, CleanupScheduler } from './scheduler.js';
import type { BrainConfig } from '../config/index.js';
import type { RetentionService } from './retention.js';

describe('parseCronExpression', () => {
  it('parses a daily-at-2am expression', () => {
    const schedule = parseCronExpression('0 2 * * *');
    expect(schedule.minute).toEqual([0]);
    expect(schedule.hour).toEqual([2]);
    expect(schedule.dayOfMonth.length).toBe(31);
    expect(schedule.month.length).toBe(12);
    expect(schedule.dayOfWeek.length).toBe(7);
  });

  it('parses step and range fields', () => {
    const schedule = parseCronExpression('*/15 9-17 * * 1-5');
    expect(schedule.minute).toEqual([0, 15, 30, 45]);
    expect(schedule.hour).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect(schedule.dayOfWeek).toEqual([1, 2, 3, 4, 5]);
  });

  it('parses comma lists', () => {
    const schedule = parseCronExpression('0,30 * * * *');
    expect(schedule.minute).toEqual([0, 30]);
  });

  it('rejects an expression without 5 fields', () => {
    expect(() => parseCronExpression('0 2 * *')).toThrow(/expected 5 fields/);
  });

  it('rejects an out-of-range field value', () => {
    expect(() => parseCronExpression('99 2 * * *')).toThrow();
  });
});

describe('nextRunAfter', () => {
  it('finds the next daily 2am run when it is earlier the same day', () => {
    const schedule = parseCronExpression('0 2 * * *');
    const from = new Date('2026-03-10T01:00:00.000Z');
    const next = nextRunAfter(schedule, from);
    expect(next.toISOString()).toBe('2026-03-10T02:00:00.000Z');
  });

  it('rolls over to the next day once past today\'s run time', () => {
    const schedule = parseCronExpression('0 2 * * *');
    const from = new Date('2026-03-10T02:00:00.000Z');
    const next = nextRunAfter(schedule, from);
    expect(next.toISOString()).toBe('2026-03-11T02:00:00.000Z');
  });

  it('applies standard crontab OR semantics when both day-of-month and day-of-week are restricted', () => {
    // The 1st of the month OR any Monday, whichever comes first.
    const schedule = parseCronExpression('0 0 1 * 1');
    const from = new Date('2026-03-02T00:00:00.000Z'); // Monday, March 2 2026
    const next = nextRunAfter(schedule, from);
    expect(next.getUTCDay()).toBe(1);
  });
});

describe('CleanupScheduler', () => {
  function config(overrides: Partial<BrainConfig['retention']> = {}): BrainConfig {
    return {
      retention: {
        cleanup_schedule: '0 2 * * *',
        scheduled_cleanup_enabled: true,
        ...overrides,
      },
    } as unknown as BrainConfig;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-10T01:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('invokes runGc on the same execution path once the schedule elapses', async () => {
    const runGc = vi.fn(async () => ({ scanned: 0 }));
    const retention = { runGc } as unknown as RetentionService;
    const scheduler = new CleanupScheduler(config(), retention, { info: vi.fn() });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000); // 1 hour to 2am

    expect(runGc).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('does not schedule when scheduled_cleanup_enabled is false', async () => {
    const runGc = vi.fn(async () => ({ scanned: 0 }));
    const retention = { runGc } as unknown as RetentionService;
    const scheduler = new CleanupScheduler(config({ scheduled_cleanup_enabled: false }), retention, { info: vi.fn() });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

    expect(runGc).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('reschedules after a run fails so one bad tick does not end scheduled cleanup', async () => {
    const runGc = vi.fn(async () => {
      throw new Error('boom');
    });
    const retention = { runGc } as unknown as RetentionService;
    const scheduler = new CleanupScheduler(config(), retention, { info: vi.fn(), error: vi.fn() });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(runGc).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(runGc).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it('stop() prevents further scheduled runs', async () => {
    const runGc = vi.fn(async () => ({ scanned: 0 }));
    const retention = { runGc } as unknown as RetentionService;
    const scheduler = new CleanupScheduler(config(), retention, { info: vi.fn() });

    scheduler.start();
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

    expect(runGc).not.toHaveBeenCalled();
  });
});
