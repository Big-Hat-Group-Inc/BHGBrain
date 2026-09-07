import type { ErrorCode, ErrorEnvelope } from '../domain/types.js';

export class BrainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'BrainError';
  }

  toEnvelope(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
      },
    };
  }
}

export function invalidInput(message: string): BrainError {
  return new BrainError('INVALID_INPUT', message, false);
}

export function notFound(message: string): BrainError {
  return new BrainError('NOT_FOUND', message, false);
}

export function conflict(message: string): BrainError {
  return new BrainError('CONFLICT', message, false);
}

export function authRequired(message: string): BrainError {
  return new BrainError('AUTH_REQUIRED', message, false);
}

export function rateLimited(message: string): BrainError {
  return new BrainError('RATE_LIMITED', message, true);
}

export function embeddingUnavailable(message: string): BrainError {
  return new BrainError('EMBEDDING_UNAVAILABLE', message, true);
}

export function internal(message: string): BrainError {
  return new BrainError('INTERNAL', message, true);
}

// harden-dual-store-mutations task 2.5 / design.md decision 3: SQLite's own
// busy_timeout (SqliteStore.openDatabase) waits out ordinary CLI/server
// overlap; a lock error that survives that wait is a residual, retryable
// contention condition, not a permanent failure — the caller should retry
// rather than treat it as an unrecoverable INTERNAL error. `node:sqlite`
// (DatabaseSync) throws a plain `Error` for this with `code:
// 'ERR_SQLITE_ERROR'` and `errcode: 5` (SQLITE_BUSY) or `6` (SQLITE_LOCKED);
// the message-substring check covers both that raw shape and the case where
// the message has already been re-wrapped (e.g. "SQLite write failed:
// database is locked") by an intermediate `internal(...)` call, once the
// original error's own `code`/`errcode` properties are no longer reachable.
const SQLITE_LOCK_ERRCODES = new Set([5, 6]);

export function isResidualSqliteLockError(err: unknown): boolean {
  if (err && typeof err === 'object') {
    const candidate = err as { code?: unknown; errcode?: unknown };
    if (candidate.code === 'ERR_SQLITE_ERROR' && typeof candidate.errcode === 'number' &&
      SQLITE_LOCK_ERRCODES.has(candidate.errcode)) {
      return true;
    }
  }
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /database is locked|database table is locked/i.test(message);
}

/**
 * Reclassifies a residual SQLite lock condition — whether still a raw
 * `node:sqlite` error or already wrapped into a non-CONFLICT `BrainError` by
 * an intermediate catch — into a retryable `CONFLICT`, preserving the
 * original message. Returns the input unchanged when it isn't one.
 */
export function classifyResidualLockError(err: unknown): unknown {
  if (!isResidualSqliteLockError(err)) return err;
  if (err instanceof BrainError) {
    if (err.code === 'CONFLICT' && err.retryable) return err;
    return new BrainError('CONFLICT', err.message, true);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new BrainError('CONFLICT', message, true);
}

/**
 * Canonical mapping from a classified error code to its REST HTTP status —
 * the single source every transport-facing adapter (REST's route handlers
 * and error middleware, and `isErrorEnvelope` below) shares, so a status
 * code can never drift between routes (align-runtime-entrypoint-contracts
 * task 2.2; design.md decision 3).
 */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  INVALID_INPUT: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  AUTH_REQUIRED: 401,
  RATE_LIMITED: 429,
  EMBEDDING_UNAVAILABLE: 503,
  INTERNAL: 500,
};

/**
 * The one strict error-envelope predicate shared by every native transport
 * adapter — REST (`src/transport/http.ts`), MCP
 * (`src/transport/mcp-response.ts`, `src/transport/mcp-server.ts`), and the
 * CLI (`src/cli/index.ts`) — so "is this tool/resource result actually a
 * failure" is answered identically everywhere a `handleTool`/
 * `ResourceHandler.handle` result is inspected
 * (align-runtime-entrypoint-contracts task 2.2; design.md decision 3:
 * "Export one strict error predicate ... Key-presence-only predicates ...
 * were rejected"). Unlike a bare `'error' in value` check, this validates
 * that `code` is one of the known classified `ErrorCode` values, `message`
 * is a string, and `retryable` is a boolean — the exact shape every
 * `BrainError.toEnvelope()` and every hand-built resource error object in
 * this codebase produces — so a coincidentally `error`-shaped *successful*
 * result is never misread as a failure.
 */
export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  if (value === null || typeof value !== 'object') return false;
  const err = (value as { error?: unknown }).error;
  if (err === null || typeof err !== 'object') return false;
  const { code, message, retryable } = err as Record<string, unknown>;
  return typeof code === 'string' && code in ERROR_STATUS &&
    typeof message === 'string' && typeof retryable === 'boolean';
}
