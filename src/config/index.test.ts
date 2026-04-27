import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, applyEnvOverrides, type BrainConfig } from './index.js';

describe('loadConfig Azure embedding validation', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function writeConfig(raw: unknown): string {
    const dir = mkdtempSync(join(tmpdir(), 'bhgbrain-config-'));
    const path = join(dir, 'config.json');
    tempDirs.push(dir);
    writeFileSync(path, JSON.stringify(raw, null, 2), 'utf-8');
    return path;
  }

  it('loads valid Azure embedding config with defaults applied', () => {
    const configPath = writeConfig({
      embedding: {
        provider: 'azure-foundry',
        model: 'text-embedding-3-small',
        dimensions: 1536,
        azure: {
          resource_name: 'test-resource',
        },
      },
    });

    const config = loadConfig(configPath);

    expect(config.embedding.provider).toBe('azure-foundry');
    expect(config.embedding.request_timeout_ms).toBe(30000);
    expect(config.embedding.max_batch_inputs).toBe(2048);
    expect(config.embedding.azure?.api_key_env).toBe('AZURE_FOUNDRY_API_KEY');
  });

  it('rejects missing Azure config when provider is azure-foundry', () => {
    const configPath = writeConfig({
      embedding: {
        provider: 'azure-foundry',
      },
    });

    try {
      loadConfig(configPath);
      throw new Error('Expected loadConfig to reject missing Azure config');
    } catch (error) {
      expect(String(error)).toContain('embedding.azure is required when embedding.provider');
    }
  });

  it('rejects invalid Azure resource names', () => {
    const configPath = writeConfig({
      embedding: {
        provider: 'azure-foundry',
        azure: {
          resource_name: 'Invalid Resource Name',
        },
      },
    });

    expect(() => loadConfig(configPath)).toThrow('resource_name must contain only lowercase letters, numbers, and hyphens');
  });

  it('rejects incompatible dimensions for text-embedding-ada-002', () => {
    const configPath = writeConfig({
      embedding: {
        provider: 'azure-foundry',
        model: 'text-embedding-ada-002',
        dimensions: 512,
        azure: {
          resource_name: 'test-resource',
        },
      },
    });

    expect(() => loadConfig(configPath)).toThrow('text-embedding-ada-002 requires dimensions = 1536');
  });
});

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
