import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// `node:fs` is an ESM builtin whose named exports are non-configurable, so
// `vi.spyOn` cannot patch them directly — a partial mock (falling through to
// the real implementation via `importOriginal`) gives a spy-able wrapper
// instead, scoped to this file only (align-runtime-entrypoint-contracts
// task 1.3).
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

describe('atomicWriteFileSync (align-runtime-entrypoint-contracts task 1.3)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'bhgbrain-atomic-write-'));
    tempDirs.push(dir);
    return dir;
  }

  it('writes the target file with a restrictive (owner-only) mode', async () => {
    const { atomicWriteFileSync } = await import('./sqlite.js');
    const dir = tempDir();
    const target = join(dir, 'config.json');

    atomicWriteFileSync(target, JSON.stringify({ hello: 'world' }));

    expect(existsSync(target)).toBe(true);
    const mode = statSync(target).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ hello: 'world' });
  });

  it('preserves the previous readable file when the write is interrupted before the atomic rename', async () => {
    const fs = await import('node:fs');
    const { atomicWriteFileSync } = await import('./sqlite.js');
    const dir = tempDir();
    const target = join(dir, 'config.json');

    // Establish a known-good prior version.
    atomicWriteFileSync(target, JSON.stringify({ version: 1 }));
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ version: 1 });

    // Simulate an interruption at the last possible moment — after the new
    // content has been fully written and fsynced to a temp file, but before
    // the rename that publishes it — the strongest failure case for
    // "preserves the previous readable file", since everything up to the
    // rename has already succeeded.
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw new Error('simulated interruption before rename');
    });

    expect(() => atomicWriteFileSync(target, JSON.stringify({ version: 2 }))).toThrow(/simulated interruption/);

    // The previous version must still be there, fully intact and readable.
    expect(existsSync(target)).toBe(true);
    expect(JSON.parse(readFileSync(target, 'utf-8'))).toEqual({ version: 1 });

    // No stray temp file left behind either.
    const leftoverTmp = readdirSync(dir).filter(f => f.includes('.tmp'));
    expect(leftoverTmp).toEqual([]);
  });

  it('never leaves a partially-written file at the target path on interruption when no prior file existed', async () => {
    const fs = await import('node:fs');
    const { atomicWriteFileSync } = await import('./sqlite.js');
    const dir = tempDir();
    const target = join(dir, 'fresh.json');

    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw new Error('simulated interruption before rename');
    });

    expect(() => atomicWriteFileSync(target, JSON.stringify({ version: 1 }))).toThrow();
    expect(existsSync(target)).toBe(false);
  });
});
