import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig, applyEnvOverrides, type BrainConfig } from './index.js';

const ENV_KEYS = [
  'BHGBRAIN_DATA_DIR',
  'BHGBRAIN_HTTP_HOST',
  'BHGBRAIN_HTTP_PORT',
  'BHGBRAIN_QDRANT_MODE',
  'BHGBRAIN_QDRANT_URL',
  'BHGBRAIN_REQUIRE_LOOPBACK',
  'BHGBRAIN_ALLOW_UNAUTHENTICATED',
  'BHGBRAIN_LOG_LEVEL',
] as const;

describe('env-var config overlay', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  it('overrides data_dir from BHGBRAIN_DATA_DIR', () => {
    process.env.BHGBRAIN_DATA_DIR = '/data';
    const config = loadConfig('/nonexistent/config.json');
    expect(config.data_dir).toBe('/data');
  });

  it('overrides http host from BHGBRAIN_HTTP_HOST', () => {
    process.env.BHGBRAIN_HTTP_HOST = '0.0.0.0';
    const config = loadConfig('/nonexistent/config.json');
    expect(config.transport.http.host).toBe('0.0.0.0');
  });

  it('overrides http port from BHGBRAIN_HTTP_PORT', () => {
    process.env.BHGBRAIN_HTTP_PORT = '8080';
    const config = loadConfig('/nonexistent/config.json');
    expect(config.transport.http.port).toBe(8080);
  });

  it('ignores invalid BHGBRAIN_HTTP_PORT', () => {
    process.env.BHGBRAIN_HTTP_PORT = 'not-a-number';
    const config = loadConfig('/nonexistent/config.json');
    expect(config.transport.http.port).toBe(3721);
  });

  it('overrides qdrant mode from BHGBRAIN_QDRANT_MODE', () => {
    process.env.BHGBRAIN_QDRANT_MODE = 'external';
    const config = loadConfig('/nonexistent/config.json');
    expect(config.qdrant.mode).toBe('external');
  });

  it('ignores invalid BHGBRAIN_QDRANT_MODE', () => {
    process.env.BHGBRAIN_QDRANT_MODE = 'invalid';
    const config = loadConfig('/nonexistent/config.json');
    expect(config.qdrant.mode).toBe('embedded');
  });

  it('overrides qdrant url from BHGBRAIN_QDRANT_URL', () => {
    process.env.BHGBRAIN_QDRANT_URL = 'http://qdrant:6333';
    const config = loadConfig('/nonexistent/config.json');
    expect(config.qdrant.external_url).toBe('http://qdrant:6333');
  });

  it('overrides require_loopback_http from BHGBRAIN_REQUIRE_LOOPBACK', () => {
    process.env.BHGBRAIN_REQUIRE_LOOPBACK = 'false';
    const config = loadConfig('/nonexistent/config.json');
    expect(config.security.require_loopback_http).toBe(false);
  });

  it('overrides allow_unauthenticated_http from BHGBRAIN_ALLOW_UNAUTHENTICATED', () => {
    process.env.BHGBRAIN_ALLOW_UNAUTHENTICATED = 'true';
    const config = loadConfig('/nonexistent/config.json');
    expect(config.security.allow_unauthenticated_http).toBe(true);
  });

  it('overrides log_level from BHGBRAIN_LOG_LEVEL', () => {
    process.env.BHGBRAIN_LOG_LEVEL = 'debug';
    const config = loadConfig('/nonexistent/config.json');
    expect(config.observability.log_level).toBe('debug');
  });

  it('ignores invalid BHGBRAIN_LOG_LEVEL', () => {
    process.env.BHGBRAIN_LOG_LEVEL = 'trace';
    const config = loadConfig('/nonexistent/config.json');
    expect(config.observability.log_level).toBe('info');
  });

  it('applies multiple env overrides simultaneously', () => {
    process.env.BHGBRAIN_DATA_DIR = '/data';
    process.env.BHGBRAIN_HTTP_HOST = '0.0.0.0';
    process.env.BHGBRAIN_HTTP_PORT = '9000';
    process.env.BHGBRAIN_QDRANT_MODE = 'external';
    process.env.BHGBRAIN_QDRANT_URL = 'http://qdrant:6333';
    process.env.BHGBRAIN_REQUIRE_LOOPBACK = 'false';
    process.env.BHGBRAIN_LOG_LEVEL = 'warn';

    const config = loadConfig('/nonexistent/config.json');

    expect(config.data_dir).toBe('/data');
    expect(config.transport.http.host).toBe('0.0.0.0');
    expect(config.transport.http.port).toBe(9000);
    expect(config.qdrant.mode).toBe('external');
    expect(config.qdrant.external_url).toBe('http://qdrant:6333');
    expect(config.security.require_loopback_http).toBe(false);
    expect(config.observability.log_level).toBe('warn');
  });

  it('does not override when env vars are not set', () => {
    const config = loadConfig('/nonexistent/config.json');
    expect(config.transport.http.host).toBe('127.0.0.1');
    expect(config.transport.http.port).toBe(3721);
    expect(config.qdrant.mode).toBe('embedded');
    expect(config.security.require_loopback_http).toBe(true);
    expect(config.observability.log_level).toBe('info');
  });
});
