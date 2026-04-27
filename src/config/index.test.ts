import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from './index.js';

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
