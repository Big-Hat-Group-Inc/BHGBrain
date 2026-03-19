import pino from 'pino';
import type { BrainConfig } from '../config/index.js';

const REDACT_PATHS = [
  'req.headers.authorization',
  'token',
  'bearer',
  'api_key',
];

const CONTENT_PREVIEW_MAX = 50;

export function createLogger(config: BrainConfig, destination?: NodeJS.WritableStream): pino.Logger {
  const level = config.observability.log_level;

  const logger = pino(
    {
      level,
      formatters: {
        level(label) {
          return { level: label };
        },
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: config.security.log_redaction ? REDACT_PATHS : undefined,
    },
    destination ?? process.stdout,
  );

  return logger;
}

export function redactContent(content: string): string {
  if (content.length <= CONTENT_PREVIEW_MAX) return content;
  return content.substring(0, CONTENT_PREVIEW_MAX) + '...[redacted]';
}

export function redactToken(token: string): string {
  if (token.length <= 8) return '***';
  return token.substring(0, 4) + '...' + token.substring(token.length - 4);
}
