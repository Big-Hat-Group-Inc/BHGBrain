import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      // Ratcheted floor, not a target: initialized a few points below the
      // measured baseline (statements 86.02%, branches 79.07%, functions
      // 87.26%, lines 87.41% as of task 1.3) so ordinary run-to-run noise
      // doesn't trip CI, while a real coverage regression still fails
      // `npm run test:coverage`. Raised once at task 3.5 to the new
      // measured baseline (statements 86.23%, branches 79.55%, functions
      // 87.41%, lines 87.58%) after this proposal's own new pure-function
      // tests (src/storage/payload-mapper.test.ts, src/search/fusion.test.ts,
      // src/tools/recall-pool.test.ts, etc.) raised it further. Raise these
      // numbers as regression tests land — never lower them to make a drop
      // pass. See design.md decision 2.
      thresholds: {
        statements: 86,
        branches: 79,
        functions: 87,
        lines: 87,
      },
    },
  },
});
