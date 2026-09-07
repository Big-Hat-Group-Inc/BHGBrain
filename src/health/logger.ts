import pino from 'pino';
import { createHash } from 'node:crypto';
import type { BrainConfig } from '../config/index.js';
import { PACKAGE_VERSION } from '../version.js';

const SERVICE_NAME = 'bhgbrain';

const REDACT_PATHS = [
  'req.headers.authorization',
  'token',
  'bearer',
  'api_key',
  // Already-hashed by `redactToken` before it ever reaches a log call (see
  // transport/middleware.ts), but listed anyway as defense in depth — a
  // future call site that logs a raw `token_preview`-named field without
  // going through `redactToken` first is still covered.
  'token_preview',
  // Memory content previews: enforced by config (redact paths below), not by
  // omission at call sites — see the `content-preview redaction` audit
  // follow-up (2026-06-05, add-operations-security-reliability task 4.3).
  // strengthen-operational-observability task 1.4: matched against the
  // field names this codebase's log call sites and `err`-serialized detail
  // objects would actually use if content/preview/summary text were ever
  // attached to a log record, one level of nesting included.
  'content',
  'preview',
  'summary',
  '*.content',
  '*.preview',
  '*.summary',
];

const CONTENT_PREVIEW_MAX = 50;

export function createLogger(config: BrainConfig, destination?: NodeJS.WritableStream): pino.Logger {
  const level = config.observability.log_level;

  const logger = pino(
    {
      level,
      // strengthen-operational-observability task 1.1: every log line
      // carries which service and build produced it, so logs aggregated
      // from multiple processes/versions (or copy-pasted into a bug report)
      // are self-describing without cross-referencing a deploy record.
      base: { service: SERVICE_NAME, version: PACKAGE_VERSION },
      formatters: {
        level(label) {
          return { level: label };
        },
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: config.security.log_redaction ? REDACT_PATHS : undefined,
      // strengthen-operational-observability task 1.1/1.2: registers pino's
      // standard `err` serializer (pino-std-serializers) for any log record
      // that carries an `err` field — the one field name every failure path
      // in this codebase now logs a raw Error/BrainError under (see
      // `toLogError` below and its call sites). It walks `.cause` chains
      // into both `message` and `stack`, copies BrainError's own enumerable
      // `code`/`retryable` properties through untouched, and — because the
      // original error object it stashes under `.raw` is keyed by a Symbol,
      // which `JSON.stringify` never serializes — never leaks the raw
      // object itself into the emitted JSON line.
      serializers: { err: pino.stdSerializers.err },
    },
    destination ?? process.stdout,
  );

  return logger;
}

export function redactContent(content: string): string {
  if (content.length <= CONTENT_PREVIEW_MAX) return content;
  return content.substring(0, CONTENT_PREVIEW_MAX) + '...[redacted]';
}

/**
 * Non-reversible preview of a secret token for log output — a fixed-length
 * hash prefix rather than literal characters from the token itself
 * (strengthen-operational-observability task 1.4/design.md decision 4:
 * "token previews become hash prefixes"). The prior preview (first 4 +
 * last 4 raw characters) put real token material into logs; a truncated
 * SHA-256 digest still lets an operator correlate "this is the same failing
 * token as last time" across repeated auth-failure log lines without
 * exposing any byte of the actual secret. Deterministic (same token always
 * hashes to the same preview) but not reversible.
 */
export function redactToken(token: string): string {
  if (token.length === 0) return '***';
  const digest = createHash('sha256').update(token, 'utf8').digest('hex');
  return `sha256:${digest.substring(0, 8)}`;
}

/**
 * Normalizes anything caught from a `catch` block into the shape pino's
 * `err` serializer above expects. Real `Error`/`BrainError` instances pass
 * through unchanged (so `type`/`message`/`stack`/`.cause`/BrainError's own
 * `code`/`retryable` all serialize); a non-Error throw (a string, a plain
 * object, `undefined`) is wrapped in an `Error` first so it still logs as a
 * structured `err` field instead of silently vanishing (pino's serializer
 * only special-cases values `isErrorLike`).
 */
export function toLogError(err: unknown): Error {
  if (err instanceof Error) return err;
  const wrapped = new Error(typeof err === 'string' ? err : JSON.stringify(err));
  wrapped.name = 'NonErrorThrow';
  return wrapped;
}

/**
 * Merges a caller-influenced `details` object into a log payload without
 * ever letting it override the event's own stable identifying fields (task
 * 1.2: "verify stable event fields cannot be overwritten by caller data") —
 * `stable` is spread last, so a `details` key that collides with one of
 * `stable`'s own keys (e.g. a `ConsolidationSourceFailure.message` happening
 * to be named `event`) can never shadow it.
 */
export function withStableFields<T extends Record<string, unknown>>(
  stable: T,
  details?: object,
): T & Record<string, unknown> {
  return { ...(details ?? {}), ...stable };
}
