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
