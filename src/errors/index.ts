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
