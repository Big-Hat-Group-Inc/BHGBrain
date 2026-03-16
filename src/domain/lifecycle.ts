import type { BrainConfig } from '../config/index.js';
import type { MemorySource, MemoryType, RetentionTier } from './types.js';

export interface LifecycleInput {
  category?: string;
  source: MemorySource;
  type?: MemoryType;
  tags: string[];
  content: string;
  explicitTier?: RetentionTier;
}

export interface LifecycleMetadata {
  retention_tier: RetentionTier;
  expires_at: string | null;
  decay_eligible: boolean;
  review_due: string | null;
}

const TRANSIENT_PATTERNS = [
  /\b(?:jira|ticket|incident|case)-?\d+\b/i,
  /\b(?:from|subject|fw|re):/i,
  /\b(?:today|this week|by friday|standup|meeting minutes|action items)\b/i,
  /\bq[1-4]\s+20\d{2}\b/i,
];

const T0_HINTS = [
  'architecture',
  'design decision',
  'adr',
  'rfc',
  'contract',
  'schema',
  'legal',
  'compliance',
  'policy',
  'standard',
  'accounting',
  'security',
  'runbook',
];

export class MemoryLifecycleService {
  constructor(private config: BrainConfig) {}

  assignTier(input: LifecycleInput): RetentionTier {
    if (input.explicitTier) return input.explicitTier;
    if (input.category) return 'T0';

    const tags = new Set(input.tags.map(tag => tag.toLowerCase()));
    const content = input.content.toLowerCase();

    if (input.source === 'import' && this.hasT0Signal(tags, content)) return 'T0';
    if (input.source === 'agent' && input.type === 'procedural') return 'T1';
    if (input.source === 'agent' && input.type === 'episodic') return 'T2';
    if (input.source === 'cli') return 'T2';
    if (TRANSIENT_PATTERNS.some(pattern => pattern.test(content))) return 'T3';
    if (this.hasT0Signal(tags, content)) return 'T0';

    return 'T2';
  }

  buildMetadata(tier: RetentionTier, now: Date): LifecycleMetadata {
    const t1Days = this.config.retention?.tier_ttl?.T1 ?? 365;
    return {
      retention_tier: tier,
      expires_at: this.computeExpiry(tier, now),
      decay_eligible: tier !== 'T0',
      review_due: tier === 'T1'
        ? this.addDays(now, t1Days).toISOString()
        : null,
    };
  }

  computeExpiry(tier: RetentionTier, now: Date): string | null {
    const tierTtl = this.config.retention?.tier_ttl ?? { T0: null, T1: 365, T2: 90, T3: 30 };
    const ttlDays = tierTtl[tier];
    if (ttlDays === null) return null;
    return this.addDays(now, ttlDays).toISOString();
  }

  isExpired(expiresAt: string | null, now: Date): boolean {
    return expiresAt !== null && Date.parse(expiresAt) < now.getTime();
  }

  isExpiringSoon(expiresAt: string | null, now: Date): boolean {
    if (!expiresAt) return false;
    const warningDays = this.config.retention?.pre_expiry_warning_days ?? 7;
    const warningMs = warningDays * 24 * 60 * 60 * 1000;
    const expiryMs = Date.parse(expiresAt);
    return expiryMs >= now.getTime() && expiryMs - now.getTime() <= warningMs;
  }

  shouldPromote(tier: RetentionTier, accessCount: number): RetentionTier | null {
    if (tier === 'T0' || tier === 'T1') return null;
    const threshold = this.config.retention?.auto_promote_access_threshold ?? 5;
    if (accessCount < threshold) return null;
    return tier === 'T3' ? 'T2' : 'T1';
  }

  dedupThresholdFor(tier: RetentionTier, baseThreshold: number): { noop: number; update: number } {
    if (tier === 'T0' || tier === 'T1') {
      return {
        noop: 0.98,
        update: Math.max(baseThreshold, 0.95),
      };
    }

    if (tier === 'T3') {
      return {
        noop: 0.95,
        update: Math.max(baseThreshold, 0.9),
      };
    }

    return {
      noop: 0.98,
      update: baseThreshold,
    };
  }

  extendExpiry(tier: RetentionTier, now: Date): string | null {
    if (this.config.retention?.sliding_window_enabled === false) return null;
    return this.computeExpiry(tier, now);
  }

  private hasT0Signal(tags: Set<string>, content: string): boolean {
    for (const hint of T0_HINTS) {
      if (content.includes(hint)) return true;
    }

    for (const tag of tags) {
      if (T0_HINTS.some(hint => tag.includes(hint.replace(/\s+/g, '-')) || tag.includes(hint.replace(/\s+/g, '')))) {
        return true;
      }
    }

    return false;
  }

  private addDays(date: Date, days: number): Date {
    const copy = new Date(date.getTime());
    copy.setUTCDate(copy.getUTCDate() + days);
    return copy;
  }
}
