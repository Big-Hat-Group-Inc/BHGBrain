import { describe, it, expect } from 'vitest';
import { normalizeContent, computeChecksum, generateSummary, containsSecret } from './normalize.js';

describe('normalizeContent', () => {
  it('strips control characters except tab and newline', () => {
    expect(normalizeContent('hello\x00world\ttab\nnewline')).toBe('helloworld\ttab\nnewline');
  });

  it('normalizes line endings', () => {
    expect(normalizeContent('line1\r\nline2\r\n')).toBe('line1\nline2');
  });

  it('collapses excessive blank lines', () => {
    expect(normalizeContent('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('trims whitespace', () => {
    expect(normalizeContent('  hello  ')).toBe('hello');
  });
});

describe('computeChecksum', () => {
  it('returns consistent SHA-256 hex', () => {
    const hash = computeChecksum('hello world');
    expect(hash).toHaveLength(64);
    expect(hash).toBe(computeChecksum('hello world'));
  });

  it('changes for different input', () => {
    expect(computeChecksum('a')).not.toBe(computeChecksum('b'));
  });
});

describe('generateSummary', () => {
  it('returns first line if short', () => {
    expect(generateSummary('Short line')).toBe('Short line');
  });

  it('truncates long first line', () => {
    const long = 'A'.repeat(200);
    const summary = generateSummary(long);
    expect(summary.length).toBeLessThanOrEqual(120);
    expect(summary).toContain('...');
  });

  it('uses only first line', () => {
    expect(generateSummary('first\nsecond')).toBe('first');
  });
});

describe('containsSecret', () => {
  it('detects API key patterns', () => {
    expect(containsSecret('api_key: sk-abc123xyz')).toBe(true);
  });

  it('detects GitHub tokens', () => {
    expect(containsSecret('use ghp_abcdefghij1234567890abcdefghij123456')).toBe(true);
  });

  it('detects private keys', () => {
    expect(containsSecret('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
  });

  it('allows normal content', () => {
    expect(containsSecret('TypeScript uses generics for type safety')).toBe(false);
  });
});
