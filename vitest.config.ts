import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // GraphQL schemas and validators rely on realm identity checks. Force
    // GraphQL Tools, Yoga, and tests through one module instance just as the
    // built Node.js service does.
    dedupe: ['graphql'],
    alias: [
      {
        find: /^graphql$/,
        replacement: resolve(process.cwd(), 'node_modules/graphql/index.js'),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    // PostgreSQL integration files share migrated state and advisory locks.
    // RocksDB backup and restore files also compete for native I/O resources;
    // parallel files can exceed their test deadlines on release runners.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      // Include unimported production files as uncovered, including worker/CLI entry points.
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text-summary', 'json', 'json-summary', 'html', 'lcov'],
      thresholds: { lines: 90.01, statements: 90.01, functions: 90.01, branches: 90.01 },
    },
  },
});
