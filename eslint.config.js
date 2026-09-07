import tseslint from 'typescript-eslint';

export default [
  {
    ignores: ['coverage/**', 'dist/**', 'node_modules/**'],
  },
  {
    files: ['src/**/*.ts', 'src/**/*.d.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        sourceType: 'module',
        // Type-aware linting (needed for no-floating-promises /
        // no-misused-promises below): typescript-eslint picks, per linted
        // file, whichever of these two tsconfigs actually includes it — so
        // production files resolve against tsconfig.json (which excludes
        // *.test.ts) and test files resolve against tsconfig.test.json,
        // matching the split `lint:types` / `lint:types:test` already runs.
        // `projectService: true` was tried first but its lazy, open-file-
        // driven discovery never picked up tsconfig.test.json when running
        // headless over the whole `src` tree from this config, so every
        // *.test.ts file failed to parse ("not found by the project
        // service"); this eager `project` array has none of that fragility.
        // See strengthen-verification-and-code-boundaries task 1.2.
        project: ['./tsconfig.json', './tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      // A rejected promise created without `await`/`.catch()`/`void` is a
      // silent failure mode (an unhandled rejection that can crash the
      // process or vanish depending on the runtime) — exactly the class of
      // bug this proposal's Requirement "Promise is launched without
      // handling" targets.
      '@typescript-eslint/no-floating-promises': 'error',
      // Passing an async function where a plain `() => void` (or similarly
      // synchronous) callback is expected silently drops its rejection —
      // most dangerously as an Express handler or an event-emitter
      // listener, both used throughout src/transport and src/health.
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
];
