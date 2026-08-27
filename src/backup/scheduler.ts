import type { BrainConfig } from '../config/index.js';
import type { RetentionService } from './retention.js';

export interface CronSchedule {
  minute: number[];
  hour: number[];
  dayOfMonth: number[];
  month: number[];
  dayOfWeek: number[];
}

function parseCronPart(part: string, min: number, max: number): number[] {
  const [base, stepStr] = part.split('/');
  const step = stepStr !== undefined ? Number(stepStr) : 1;
  if (!Number.isInteger(step) || step <= 0) {
    throw new Error(`Invalid cron step in "${part}"`);
  }

  let rangeStart = min;
  let rangeEnd = max;
  if (base !== '*') {
    if (base?.includes('-')) {
      const [startStr, endStr] = base.split('-');
      rangeStart = Number(startStr);
      rangeEnd = Number(endStr);
    } else {
      rangeStart = rangeEnd = Number(base);
    }
  }

  if (
    !Number.isInteger(rangeStart) || !Number.isInteger(rangeEnd) ||
    rangeStart > rangeEnd || rangeStart < min || rangeEnd > max
  ) {
    throw new Error(`Invalid cron field "${part}"`);
  }

  const values: number[] = [];
  for (let v = rangeStart; v <= rangeEnd; v += step) {
    values.push(v);
  }
  return values;
}

function parseCronField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    for (const v of parseCronPart(part.trim(), min, max)) {
      values.add(v);
    }
  }
  return [...values].sort((a, b) => a - b);
}

/** Parses a standard 5-field crontab expression (minute hour dom month dow), evaluated in UTC. */
export function parseCronExpression(expr: string): CronSchedule {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression "${expr}": expected 5 fields (minute hour day month weekday)`);
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string];
  return {
    minute: parseCronField(minute, 0, 59),
    hour: parseCronField(hour, 0, 23),
    dayOfMonth: parseCronField(dayOfMonth, 1, 31),
    month: parseCronField(month, 1, 12),
    dayOfWeek: parseCronField(dayOfWeek, 0, 6),
  };
}

function advanceToNextMonth(date: Date): void {
  date.setUTCMonth(date.getUTCMonth() + 1, 1);
  date.setUTCHours(0, 0, 0, 0);
}

function advanceToNextDay(date: Date): void {
  date.setUTCDate(date.getUTCDate() + 1);
  date.setUTCHours(0, 0, 0, 0);
}

function advanceToNextHour(date: Date): void {
  date.setUTCHours(date.getUTCHours() + 1, 0, 0, 0);
}

// One year of minutes is a generous, finite search bound: pathological cron
// expressions (e.g. Feb 30) never match, and without a bound the search would
// spin forever instead of surfacing that as an error.
const MAX_SEARCH_MINUTES = 527_040;

/** Computes the next UTC run strictly after `from`, using standard crontab day-field OR semantics. */
export function nextRunAfter(schedule: CronSchedule, from: Date): Date {
  const candidate = new Date(Date.UTC(
    from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(),
    from.getUTCHours(), from.getUTCMinutes(), 0, 0,
  ));
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  const domRestricted = schedule.dayOfMonth.length < 31;
  const dowRestricted = schedule.dayOfWeek.length < 7;

  for (let i = 0; i < MAX_SEARCH_MINUTES; i++) {
    const month = candidate.getUTCMonth() + 1;
    if (!schedule.month.includes(month)) {
      advanceToNextMonth(candidate);
      continue;
    }

    const dom = candidate.getUTCDate();
    const dow = candidate.getUTCDay();
    const domMatch = schedule.dayOfMonth.includes(dom);
    const dowMatch = schedule.dayOfWeek.includes(dow);
    const dayMatches = domRestricted && dowRestricted
      ? (domMatch || dowMatch)
      : domRestricted
        ? domMatch
        : dowMatch;
    if (!dayMatches) {
      advanceToNextDay(candidate);
      continue;
    }

    if (!schedule.hour.includes(candidate.getUTCHours())) {
      advanceToNextHour(candidate);
      continue;
    }

    if (!schedule.minute.includes(candidate.getUTCMinutes())) {
      candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
      continue;
    }

    return candidate;
  }

  throw new Error('Could not compute next cron run within the search bound');
}

/**
 * Runs `RetentionService.runGc` on the schedule configured at
 * `retention.cleanup_schedule`, using the exact same execution path as the
 * `bhgbrain gc` CLI command. Self-reschedules after every run (success or
 * failure) so a single bad tick cannot silently end scheduled cleanup.
 */
export class CleanupScheduler {
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(
    private config: BrainConfig,
    private retention: RetentionService,
    private logger?: {
      info: (obj: Record<string, unknown>) => void;
      error?: (obj: Record<string, unknown>) => void;
    },
  ) {}

  start(): void {
    if (!this.config.retention.scheduled_cleanup_enabled) {
      this.logger?.info({ event: 'retention_scheduler_disabled' });
      return;
    }
    this.stopped = false;
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;

    let delayMs: number;
    try {
      const schedule = parseCronExpression(this.config.retention.cleanup_schedule);
      const next = nextRunAfter(schedule, new Date());
      delayMs = Math.max(0, next.getTime() - Date.now());
    } catch (err) {
      this.logger?.error?.({
        event: 'retention_scheduler_invalid_cron',
        cleanup_schedule: this.config.retention.cleanup_schedule,
        error: (err as Error).message,
      });
      return;
    }

    this.logger?.info({ event: 'retention_scheduler_next_run', delay_ms: delayMs });
    this.timer = setTimeout(() => {
      void this.runOnce();
    }, delayMs);
    this.timer.unref?.();
  }

  private async runOnce(): Promise<void> {
    try {
      await this.retention.runGc();
    } catch (err) {
      this.logger?.error?.({ event: 'retention_scheduler_run_failed', error: (err as Error).message });
    } finally {
      this.scheduleNext();
    }
  }
}
