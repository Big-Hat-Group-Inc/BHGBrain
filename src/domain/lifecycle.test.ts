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
});
