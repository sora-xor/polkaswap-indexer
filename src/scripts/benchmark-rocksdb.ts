import { performance } from 'node:perf_hooks';
import path from 'node:path';

import { readConfig } from '../config.js';
import { RocksRepository } from '../repository/rocksdb.js';
import { assertCanonicalDisjointPaths, readPositiveSafeInteger } from './env.js';

import type { IndexerCollection, IndexerDocument, RepositoryQueryArgs } from '../repository/types.js';

const percentile = (values: number[], fraction: number): number => {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(Math.ceil(sorted.length * fraction) - 1, sorted.length - 1)] ?? 0;
};

const config = readConfig();
const rawBenchmarkPath = process.env.ROCKSDB_BENCHMARK_PATH?.trim();
if (!rawBenchmarkPath) {
  throw new Error('ROCKSDB_BENCHMARK_PATH is required and must point to an offline RocksDB checkpoint');
}
const benchmarkPath = path.resolve(rawBenchmarkPath);
await assertCanonicalDisjointPaths(
  'ROCKSDB_BENCHMARK_PATH',
  benchmarkPath,
  'the live ROCKSDB_PATH',
  config.rocksdbPath
);
const repository = RocksRepository.openReadOnly({
  ...config,
  rocksdbPath: benchmarkPath,
});
const iterations = readPositiveSafeInteger(process.env, 'ROCKSDB_BENCHMARK_ITERATIONS', 10);

const first = async (collection: IndexerCollection, args: RepositoryQueryArgs): Promise<IndexerDocument | null> =>
  (await repository.query(collection, { ...args, first: 1, includeTotalCount: false })).items[0] ?? null;

const cases: Array<{ label: string; collection: IndexerCollection; args: RepositoryQueryArgs }> = [];

try {
  await repository.prepare();
  const [asset, accountLiquidity, market, latestHistory] = await Promise.all([
    // Sample through document-key order. Some high-volume collections only
    // have only query-shaped timestamp indexes, so an unfiltered latest lookup
    // would otherwise materialize and sort the entire collection.
    first('assetSnapshots', { orderBy: ['ID_ASC'] }),
    first('accountLiquiditySnapshots', { orderBy: ['ID_ASC'] }),
    first('marketSnapshots', { orderBy: ['ID_ASC'] }),
    first('historyElements', { orderBy: ['TIMESTAMP_DESC'] }),
  ]);
  const latestTimestamp = Number(latestHistory?.timestamp ?? Date.now() / 1_000);
  const monthAgo = Math.max(Math.trunc(latestTimestamp) - 30 * 86_400, 0);

  cases.push({
    label: 'history/latest-month',
    collection: 'historyElements',
    args: {
      first: 100,
      includeTotalCount: false,
      orderBy: ['TIMESTAMP_DESC'],
      filter: { timestamp: { greaterThanOrEqualTo: monthAgo } },
    },
  });
  cases.push({
    label: 'network/block-latest-month',
    collection: 'networkSnapshots',
    args: {
      first: 100,
      includeTotalCount: false,
      orderBy: ['TIMESTAMP_DESC'],
      filter: {
        and: [{ type: { equalTo: 'BLOCK' } }, { timestamp: { greaterThanOrEqualTo: monthAgo } }],
      },
    },
  });

  if (asset?.data.assetId !== undefined && asset.data.type !== undefined) {
    cases.push({
      label: 'asset/type-latest-month',
      collection: 'assetSnapshots',
      args: {
        first: 100,
        includeTotalCount: false,
        orderBy: ['TIMESTAMP_DESC'],
        filter: {
          and: [
            { assetId: { equalTo: asset.data.assetId } },
            { type: { equalTo: asset.data.type } },
            { timestamp: { greaterThanOrEqualTo: monthAgo } },
          ],
        },
      },
    });
  }
  if (accountLiquidity?.data.accountLiquidityId !== undefined) {
    cases.push({
      label: 'account-liquidity/latest',
      collection: 'accountLiquiditySnapshots',
      args: {
        first: 100,
        includeTotalCount: false,
        orderBy: ['TIMESTAMP_DESC'],
        filter: { accountLiquidityId: { equalTo: accountLiquidity.data.accountLiquidityId } },
      },
    });
  }
  if (market?.data.marketId !== undefined && market.data.type !== undefined) {
    cases.push({
      label: 'market/type/latest',
      collection: 'marketSnapshots',
      args: {
        first: 100,
        includeTotalCount: false,
        orderBy: ['TIMESTAMP_DESC'],
        filter: {
          and: [
            { marketId: { equalTo: market.data.marketId } },
            { type: { equalTo: market.data.type } },
          ],
        },
      },
    });
  }

  const results = [];
  for (const benchmark of cases) {
    await repository.query(benchmark.collection, benchmark.args);
    const durations: number[] = [];
    let returned = 0;

    for (let run = 0; run < iterations; run++) {
      const startedAt = performance.now();
      const result = await repository.query(benchmark.collection, benchmark.args);
      durations.push(performance.now() - startedAt);
      returned = result.items.length;
    }

    results.push({
      case: benchmark.label,
      iterations,
      returned,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      maxMs: Math.max(...durations),
    });
  }

  console.info(JSON.stringify(results, null, 2));
} finally {
  await repository.close();
}
