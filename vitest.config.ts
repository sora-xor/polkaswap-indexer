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
    maxWorkers: 2,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts'],
      reporter: ['text-summary', 'json', 'json-summary', 'lcov'],
      thresholds: { lines: 80 },
    },
    // PostgreSQL integration files share one migrated database and several
    // intentionally global tables/advisory locks. Running those files in
    // parallel makes a neighboring truncate race otherwise-correct fencing
    // assertions. Unit-only runs keep Vitest's normal file parallelism.
    fileParallelism: !process.env.POSTGRES_TEST_DATABASE_URL,
  },
});
