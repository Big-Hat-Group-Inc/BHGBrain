import { createHash } from 'node:crypto';

export function normalizeContent(raw: string): string {
  let text = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  text = text.replace(/\r\n/g, '\n');
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

export function computeChecksum(normalizedContent: string): string {
  return createHash('sha256').update(normalizedContent, 'utf-8').digest('hex');
}

export function generateSummary(content: string, maxLen = 120): string {
  const firstLine = content.split('\n')[0] ?? '';
  if (firstLine.length <= maxLen) return firstLine;
  return firstLine.substring(0, maxLen - 3) + '...';
}

const SECRET_PATTERNS = [
  /(?:api[_-]?key|secret|token|password|passwd|credential|auth)\s*[:=]\s*\S+/i,
  /(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}/,
  /ghp_[a-zA-Z0-9]{36}/,
  /sk-[a-zA-Z0-9]{20,}/,
  /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/,
];

export function containsSecret(content: string): boolean {
  return SECRET_PATTERNS.some(p => p.test(content));
}
