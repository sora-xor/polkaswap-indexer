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
  },
});
