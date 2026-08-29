import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, tmpdir } from 'node:os';
import { loadConfig, applyEnvOverrides, resolveDeviceId, ensureDataDir, type BrainConfig } from './index.js';

// `node:os`.hostname and `node:fs`.writeFileSync are ESM builtin exports —
// their module namespace is non-configurable, so `vi.spyOn` cannot patch
// them directly. Partially mocking the module (falling through to the real
// implementation via `importOriginal`) gives a spy-able wrapper instead.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, hostname: vi.fn(actual.hostname) };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

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

  it('rejects an unsupported/typo\'d model for azure-foundry', () => {
    const configPath = writeConfig({
      embedding: {
        provider: 'azure-foundry',
        model: 'text-embedding-4-ultra',
        azure: {
          resource_name: 'test-resource',
        },
      },
    });

    expect(() => loadConfig(configPath)).toThrow(
      "Unsupported embedding model 'text-embedding-4-ultra'. Supported models: text-embedding-ada-002, text-embedding-3-small, text-embedding-3-large",
    );
  });

  it('rejects an unsupported/typo\'d model for openai', () => {
    const configPath = writeConfig({
      embedding: {
        provider: 'openai',
        model: 'text-embbeding-3-small',
      },
    });

    expect(() => loadConfig(configPath)).toThrow("Unsupported embedding model 'text-embbeding-3-small'");
  });

  it('rejects text-embedding-3-large with dimensions above its cap for openai', () => {
    const configPath = writeConfig({
      embedding: {
        provider: 'openai',
        model: 'text-embedding-3-large',
        dimensions: 4096,
      },
    });

    expect(() => loadConfig(configPath)).toThrow('text-embedding-3-large supports at most 3072 dimensions');
  });

  it('accepts a supported model and resolves effective dimensions', () => {
    const configPath = writeConfig({
      embedding: {
        provider: 'openai',
        model: 'text-embedding-3-large',
        dimensions: 3072,
      },
    });

    const config = loadConfig(configPath);

    expect(config.embedding.model).toBe('text-embedding-3-large');
    expect(config.embedding.dimensions).toBe(3072);
  });
});

describe('pipeline.contradiction_detection config', () => {
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

  it('defaults to disabled with a 5000ms timeout when omitted', () => {
    const configPath = writeConfig({});

    const config = loadConfig(configPath);

    expect(config.pipeline.contradiction_detection.enabled).toBe(false);
    expect(config.pipeline.contradiction_detection.timeout_ms).toBe(5000);
  });

  it('accepts enabled: true with a missing/invalid extraction_model_env — reachability is a runtime concern, not a config-shape one', () => {
    const configPath = writeConfig({
      pipeline: {
        contradiction_detection: { enabled: true },
        extraction_model_env: '',
      },
    });

    const config = loadConfig(configPath);

    expect(config.pipeline.contradiction_detection.enabled).toBe(true);
    expect(config.pipeline.extraction_model_env).toBe('');
  });

  it('honors an explicit timeout_ms override', () => {
    const configPath = writeConfig({
      pipeline: {
        contradiction_detection: { enabled: true, timeout_ms: 2500 },
      },
    });

    const config = loadConfig(configPath);

    expect(config.pipeline.contradiction_detection.timeout_ms).toBe(2500);
  });
});

// add-memory-provenance-metadata, task 8.2
describe('pipeline.default_confidence config', () => {
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

  it('defaults to cli: 1.0, api: 1.0, agent: 0.7, import: 0.5 when omitted', () => {
    const configPath = writeConfig({});

    const config = loadConfig(configPath);

    expect(config.pipeline.default_confidence).toEqual({
      cli: 1.0, api: 1.0, agent: 0.7, import: 0.5,
    });
  });

  it('honors explicit per-source overrides', () => {
    const configPath = writeConfig({
      pipeline: {
        default_confidence: { agent: 0.3 },
      },
    });

    const config = loadConfig(configPath);

    expect(config.pipeline.default_confidence.agent).toBe(0.3);
    // Unspecified sources keep their own defaults.
    expect(config.pipeline.default_confidence.cli).toBe(1.0);
  });

  it('rejects out-of-[0,1] bounds per source', () => {
    const configPath = writeConfig({
      pipeline: {
        default_confidence: { agent: 1.5 },
      },
    });

    expect(() => loadConfig(configPath)).toThrow();
  });
});

describe('search.rerank config (add-opt-in-rerank-stage)', () => {
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

  it('defaults to disabled with the documented defaults when omitted', () => {
    const configPath = writeConfig({});

    const config = loadConfig(configPath);

    expect(config.search.rerank).toEqual({
      enabled: false,
      provider: 'openai',
      candidate_pool: 20,
      model: 'gpt-4o-mini',
      model_env: 'BHGBRAIN_RERANK_API_KEY',
      timeout_ms: 3000,
    });
  });

  it('honors explicit overrides', () => {
    const configPath = writeConfig({
      search: {
        rerank: {
          enabled: true,
          candidate_pool: 10,
          model: 'gpt-4o',
          model_env: 'MY_RERANK_KEY',
          timeout_ms: 1500,
        },
      },
    });

    const config = loadConfig(configPath);

    expect(config.search.rerank).toEqual({
      enabled: true,
      provider: 'openai',
      candidate_pool: 10,
      model: 'gpt-4o',
      model_env: 'MY_RERANK_KEY',
      timeout_ms: 1500,
    });
  });

  it('rejects candidate_pool: 0 (below the minimum)', () => {
    const configPath = writeConfig({ search: { rerank: { candidate_pool: 0 } } });
    expect(() => loadConfig(configPath)).toThrow();
  });

  it('rejects candidate_pool: 51 (above the maximum)', () => {
    const configPath = writeConfig({ search: { rerank: { candidate_pool: 51 } } });
    expect(() => loadConfig(configPath)).toThrow();
  });

  it('rejects an unsupported provider value', () => {
    const configPath = writeConfig({ search: { rerank: { provider: 'anthropic' } } });
    expect(() => loadConfig(configPath)).toThrow();
  });

  it('rejects a non-positive timeout_ms', () => {
    const configPath = writeConfig({ search: { rerank: { timeout_ms: 0 } } });
    expect(() => loadConfig(configPath)).toThrow();
  });
});

describe('consolidation config (add-duplicate-cluster-consolidation)', () => {
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

  it('defaults to enabled with threshold 0.9, neighbor_top_k 20, max_scan_per_call 500 when omitted', () => {
    const configPath = writeConfig({});

    const config = loadConfig(configPath);

    expect(config.consolidation.enabled).toBe(true);
    expect(config.consolidation.similarity_threshold).toBe(0.9);
    expect(config.consolidation.neighbor_top_k).toBe(20);
    expect(config.consolidation.max_scan_per_call).toBe(500);
  });

  it('honors explicit overrides', () => {
    const configPath = writeConfig({
      consolidation: {
        enabled: false, similarity_threshold: 0.85, neighbor_top_k: 10, max_scan_per_call: 100,
      },
    });

    const config = loadConfig(configPath);

    expect(config.consolidation.enabled).toBe(false);
    expect(config.consolidation.similarity_threshold).toBe(0.85);
    expect(config.consolidation.neighbor_top_k).toBe(10);
    expect(config.consolidation.max_scan_per_call).toBe(100);
  });

  it('rejects a similarity_threshold outside [0,1]', () => {
    const configPath = writeConfig({ consolidation: { similarity_threshold: 1.5 } });
    expect(() => loadConfig(configPath)).toThrow();
  });
});

describe('pipeline extraction config (add-multi-candidate-extraction)', () => {
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

  it('defaults extraction_enabled to false and the three bounded-cost fields to their documented defaults', () => {
    const configPath = writeConfig({});

    const config = loadConfig(configPath);

    expect(config.pipeline.extraction_enabled).toBe(false);
    expect(config.pipeline.extraction_min_chars).toBe(120);
    expect(config.pipeline.extraction_max_candidates).toBe(6);
    expect(config.pipeline.extraction_timeout_ms).toBe(4000);
  });

  it('accepts explicit overrides for the three bounded-cost fields', () => {
    const configPath = writeConfig({
      pipeline: {
        extraction_enabled: true,
        extraction_min_chars: 50,
        extraction_max_candidates: 3,
        extraction_timeout_ms: 8000,
      },
    });

    const config = loadConfig(configPath);

    expect(config.pipeline.extraction_enabled).toBe(true);
    expect(config.pipeline.extraction_min_chars).toBe(50);
    expect(config.pipeline.extraction_max_candidates).toBe(3);
    expect(config.pipeline.extraction_timeout_ms).toBe(8000);
  });

  it('rejects a non-positive extraction_max_candidates', () => {
    const configPath = writeConfig({
      pipeline: { extraction_max_candidates: 0 },
    });

    expect(() => loadConfig(configPath)).toThrow();
  });

  it('rejects a negative extraction_min_chars', () => {
    const configPath = writeConfig({
      pipeline: { extraction_min_chars: -1 },
    });

    expect(() => loadConfig(configPath)).toThrow();
  });
});

describe('pipeline.long_content_threshold_chars config (add-long-content-chunking)', () => {
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

  it('defaults to 8000 when omitted from config.json', () => {
    const configPath = writeConfig({});

    const config = loadConfig(configPath);

    expect(config.pipeline.long_content_threshold_chars).toBe(8000);
  });

  it('accepts an explicit override', () => {
    const configPath = writeConfig({
      pipeline: { long_content_threshold_chars: 20000 },
    });

    const config = loadConfig(configPath);

    expect(config.pipeline.long_content_threshold_chars).toBe(20000);
  });

  it('rejects zero', () => {
    const configPath = writeConfig({
      pipeline: { long_content_threshold_chars: 0 },
    });

    expect(() => loadConfig(configPath)).toThrow();
  });

  it('rejects a negative value', () => {
    const configPath = writeConfig({
      pipeline: { long_content_threshold_chars: -1 },
    });

    expect(() => loadConfig(configPath)).toThrow();
  });

  it('rejects a non-integer value', () => {
    const configPath = writeConfig({
      pipeline: { long_content_threshold_chars: 100.5 },
    });

    expect(() => loadConfig(configPath)).toThrow();
  });

  it('rejects a value above 100000', () => {
    const configPath = writeConfig({
      pipeline: { long_content_threshold_chars: 100001 },
    });

    expect(() => loadConfig(configPath)).toThrow();
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

function makeConfig(deviceId?: string): BrainConfig {
  return {
    device: { id: deviceId },
  } as unknown as BrainConfig;
}

describe('resolveDeviceId priority chain', () => {
  const savedEnv = process.env.BHGBRAIN_DEVICE_ID;

  beforeEach(() => {
    delete process.env.BHGBRAIN_DEVICE_ID;
    vi.mocked(hostname).mockReturnValue('My Host Box');
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.BHGBRAIN_DEVICE_ID;
    } else {
      process.env.BHGBRAIN_DEVICE_ID = savedEnv;
    }
    vi.mocked(hostname).mockReset();
  });

  it('uses the persisted config.device.id when set and no env override is present', () => {
    const config = makeConfig('explicit-device');
    expect(resolveDeviceId(config)).toBe('explicit-device');
    expect(config.device.id).toBe('explicit-device');
  });

  it('falls back to a sanitized os.hostname() when neither config nor env provide an id', () => {
    const config = makeConfig(undefined);
    expect(resolveDeviceId(config)).toBe('my-host-box');
    expect(config.device.id).toBe('my-host-box');
  });

  it('BHGBRAIN_DEVICE_ID overrides a persisted config.device.id (env wins)', () => {
    process.env.BHGBRAIN_DEVICE_ID = 'env-device';
    const config = makeConfig('previously-persisted');
    expect(resolveDeviceId(config)).toBe('env-device');
    expect(config.device.id).toBe('env-device');
  });

  it('BHGBRAIN_DEVICE_ID is used even with no persisted config.device.id', () => {
    process.env.BHGBRAIN_DEVICE_ID = 'env-device-2';
    const config = makeConfig(undefined);
    expect(resolveDeviceId(config)).toBe('env-device-2');
  });

  it('ignores an env value that fails the device_id pattern, falling back to persisted config', () => {
    process.env.BHGBRAIN_DEVICE_ID = 'not a valid id!!';
    const config = makeConfig('persisted-device');
    expect(resolveDeviceId(config)).toBe('persisted-device');
  });

  it('sanitizes a hostname whose 65th character would land on a hyphen, without leaving a trailing hyphen', () => {
    // 63 'a's followed by a run of separators that collapse to a single '-'
    // right at the truncation boundary: naive strip-then-slice would already
    // have removed a *terminal* hyphen before slicing, but a slice that lands
    // exactly on a hyphen must still be cleaned up afterward.
    const raw = 'a'.repeat(63) + '-' + 'b'.repeat(10);
    vi.mocked(hostname).mockReturnValue(raw);
    const config = makeConfig(undefined);
    const id = resolveDeviceId(config);
    expect(id.length).toBeLessThanOrEqual(64);
    expect(id.endsWith('-')).toBe(false);
    expect(id.startsWith('-')).toBe(false);
  });

  it('falls back to "unknown" when the hostname sanitizes to an empty string', () => {
    vi.mocked(hostname).mockReturnValue('!!!!!');
    const config = makeConfig(undefined);
    expect(resolveDeviceId(config)).toBe('unknown');
  });
});

describe('ensureDataDir config.json write behavior', () => {
  const tempDirs: string[] = [];
  const savedEnv = process.env.BHGBRAIN_DEVICE_ID;

  beforeEach(() => {
    delete process.env.BHGBRAIN_DEVICE_ID;
  });

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.BHGBRAIN_DEVICE_ID;
    } else {
      process.env.BHGBRAIN_DEVICE_ID = savedEnv;
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDataDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'bhgbrain-ensuredir-'));
    tempDirs.push(dir);
    return dir;
  }

  it('writes config.json on first run when the file is missing', () => {
    const dir = tempDataDir();
    const config = loadConfig(join(dir, 'config.json'));
    config.data_dir = dir;

    ensureDataDir(config);

    const configPath = join(dir, 'config.json');
    expect(existsSync(configPath)).toBe(true);
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.device.id).toBe(config.device.id);
  });

  it('does not rewrite config.json on a steady-state boot with an unchanged device id', () => {
    const dir = tempDataDir();
    const configPath = join(dir, 'config.json');
    const config = loadConfig(configPath);
    config.data_dir = dir;
    ensureDataDir(config);

    // Simulate a second boot with the config already resolved/persisted.
    const secondConfig = loadConfig(configPath);
    secondConfig.data_dir = dir;
    vi.mocked(writeFileSync).mockClear();
    ensureDataDir(secondConfig);

    expect(secondConfig.device.id).toBe(config.device.id);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('rewrites config.json when BHGBRAIN_DEVICE_ID overrides the persisted device id', () => {
    const dir = tempDataDir();
    const configPath = join(dir, 'config.json');
    const config = loadConfig(configPath);
    config.data_dir = dir;
    ensureDataDir(config);
    expect(config.device.id).not.toBe('overridden-device');

    process.env.BHGBRAIN_DEVICE_ID = 'overridden-device';
    const secondConfig = loadConfig(configPath);
    secondConfig.data_dir = dir;
    ensureDataDir(secondConfig);

    expect(secondConfig.device.id).toBe('overridden-device');
    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.device.id).toBe('overridden-device');
  });
});
