import { describe, expect, it } from 'vitest';
import { MemoryLifecycleService } from './lifecycle.js';
import type { BrainConfig } from '../config/index.js';

const config = {
  retention: {
    tier_ttl: { T0: null, T1: 365, T2: 90, T3: 30 },
    auto_promote_access_threshold: 5,
    sliding_window_enabled: true,
    pre_expiry_warning_days: 7,
  },
} as BrainConfig;

describe('MemoryLifecycleService', () => {
  const service = new MemoryLifecycleService(config);

  it('assigns explicit tier first', () => {
    expect(service.assignTier({
      explicitTier: 'T1',
      source: 'cli',
      tags: [],
      content: 'hello',
    })).toBe('T1');
  });

  // add-memory-distillation, task 7.1: confirms DistillationService's
  // explicit `retention_tier: 'T1'` call with `source: 'distillation'` still
  // resolves to T1 via the pre-existing `explicitTier` first-line short
  // circuit — no new branch needed in assignTier for the new source value.
  it('assigns explicit tier for distillation-sourced writes without a new branch', () => {
    expect(service.assignTier({
      explicitTier: 'T1',
      source: 'distillation',
      tags: [],
      content: 'We deploy via GitHub Actions.',
    })).toBe('T1');
  });

  it('assigns categories to T0', () => {
    expect(service.assignTier({
      category: 'architecture',
      source: 'cli',
      tags: [],
      content: 'hello',
    })).toBe('T0');
  });

  it('assigns transient patterns to T3', () => {
    expect(service.assignTier({
      source: 'api',
      tags: [],
      content: 'Subject: Ticket-1234 needs action today',
    })).toBe('T3');
  });

  it('promotes T3 and T2 but not T1/T0', () => {
    expect(service.shouldPromote('T3', 5)).toBe('T2');
    expect(service.shouldPromote('T2', 5)).toBe('T1');
    expect(service.shouldPromote('T1', 10)).toBeNull();
  });

  describe('dedupThresholdFor', () => {
    it('raises thresholds for protected tiers (T0/T1) above the base threshold', () => {
      const t0 = service.dedupThresholdFor('T0', 0.92);
      const t1 = service.dedupThresholdFor('T1', 0.92);
      expect(t0).toEqual({ noop: 0.98, update: 0.95 });
      expect(t1).toEqual({ noop: 0.98, update: 0.95 });
    });

    it('caps the transient tier (T3) noop threshold below T0/T1, using the base threshold as the update floor', () => {
      // update = Math.max(baseThreshold, 0.9): with a 0.92 base threshold, the
      // base wins since it's already above T3's 0.9 floor.
      expect(service.dedupThresholdFor('T3', 0.92)).toEqual({ noop: 0.95, update: 0.92 });
      // With a lower base threshold, T3's 0.9 floor takes over.
      expect(service.dedupThresholdFor('T3', 0.85)).toEqual({ noop: 0.95, update: 0.9 });
    });

    it('leaves the operational tier (T2) at the configured base threshold', () => {
      expect(service.dedupThresholdFor('T2', 0.92)).toEqual({ noop: 0.98, update: 0.92 });
    });

    it('never lowers a protected/transient floor below a higher configured base threshold', () => {
      // A caller-configured base threshold above the tier's floor must win via Math.max.
      expect(service.dedupThresholdFor('T1', 0.99).update).toBe(0.99);
      expect(service.dedupThresholdFor('T3', 0.99).update).toBe(0.99);
    });
  });

  describe('nextExpiryForAccess', () => {
    const now = new Date('2026-06-05T00:00:00.000Z');

    it('extends expiry on unchanged-tier access when sliding window is enabled', () => {
      // sliding enabled (default config above) -> recompute/extend the deadline
      expect(service.nextExpiryForAccess('T2', 'T2', now)).toBe(
        service.computeExpiry('T2', now),
      );
    });

    it('preserves existing expiry on unchanged-tier access when sliding window is disabled', () => {
      const nonSliding = new MemoryLifecycleService({
        retention: {
          tier_ttl: { T0: null, T1: 365, T2: 90, T3: 30 },
          auto_promote_access_threshold: 5,
          sliding_window_enabled: false,
          pre_expiry_warning_days: 7,
        },
      } as BrainConfig);
      // undefined = "no change": the access update must not write expires_at,
      // so an existing TTL is preserved rather than cleared.
      expect(nonSliding.nextExpiryForAccess('T2', 'T2', now)).toBeUndefined();
      expect(nonSliding.nextExpiryForAccess('T3', 'T3', now)).toBeUndefined();
    });

    it('recomputes promoted-tier expiry even when sliding window is disabled', () => {
      const nonSliding = new MemoryLifecycleService({
        retention: {
          tier_ttl: { T0: null, T1: 365, T2: 90, T3: 30 },
          auto_promote_access_threshold: 5,
          sliding_window_enabled: false,
          pre_expiry_warning_days: 7,
        },
      } as BrainConfig);
      // Promotion is a policy change: apply the promoted tier's lifecycle.
      expect(nonSliding.nextExpiryForAccess('T3', 'T2', now)).toBe(
        nonSliding.computeExpiry('T2', now),
      );
      // Promotion into a no-TTL tier clears the deadline (explicit null, not preserve).
      expect(nonSliding.nextExpiryForAccess('T1', 'T0', now)).toBeNull();
    });
  });
});
