/**
 * Single source of truth for the running package version, read from
 * `package.json` at startup rather than hardcoded (task 1.1). Resolved
 * relative to `import.meta.url` so it works identically from `src/` under
 * tsx and from `dist/` after `npm run build` — `package.json` sits exactly
 * one directory above either (`tsconfig.json` `rootDir: "src"` /
 * `outDir: "dist"`).
 *
 * Fails loudly (throws) rather than silently reporting a wrong version if
 * `package.json` cannot be found/parsed or has no `version` field.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageJsonPath = path.join(here, '..', 'package.json');

interface PackageJsonShape {
  version?: unknown;
}

function readPackageVersion(): string {
  const raw = readFileSync(packageJsonPath, 'utf-8');
  const parsed = JSON.parse(raw) as PackageJsonShape;
  if (typeof parsed.version !== 'string' || parsed.version.length === 0) {
    throw new Error(`package.json at ${packageJsonPath} has no valid "version" field`);
  }
  return parsed.version;
}

export const PACKAGE_VERSION: string = readPackageVersion();
