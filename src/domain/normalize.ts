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
  // `indexOf`/`substring` instead of `split('\n')[0]` (trim-sqlite-query-and-
  // health-overhead task 6.1): equivalent for every input — content is
  // already `\r\n`-normalized upstream by `normalizeContent` — without
  // allocating an array of every line in `content` just to read the first.
  const newlineIndex = content.indexOf('\n');
  const firstLine = newlineIndex === -1 ? content : content.substring(0, newlineIndex);
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

// Deterministic phrase heuristics that flag a candidate as explicitly
// invalidating a prior memory (vs. simply refining/extending it). Used by
// the write-decision pipeline to reach the DELETE operation — see
// `write-decision-pipeline/spec.md`, "Candidate invalidation results in
// DELETE". Deliberately conservative: these are v1 deterministic triggers,
// not semantic understanding, so they only fire on explicit correction
// language rather than trying to infer intent from arbitrary rewrites.
const INVALIDATION_PATTERNS = [
  /\bno longer\b/i,
  /\bnot true anymore\b/i,
  /\bis outdated\b/i,
  /\b(that|this)('|’)s (wrong|incorrect|false)\b/i,
  /\b(correction|retraction|retract)\s*[:\-]/i,
  /\bforget (that|this|what i said)\b/i,
  /\bdelete (that|this)( memory| fact)?\b/i,
  /\bwas incorrect\b/i,
  /\bactually,? (that|this) (is|was) (wrong|false|incorrect)\b/i,
];

export function detectsInvalidation(content: string): boolean {
  return INVALIDATION_PATTERNS.some(p => p.test(content));
}
