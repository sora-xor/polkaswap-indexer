import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { ApiPromise } from '@polkadot/api';
import { ChainIndexer } from '../src/worker/chain.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { SORA_LEGACY_IDENTITY_ANCHOR, SORA_MAINNET_GENESIS_HASH } from '../src/soraIdentity.js';
import { MAX_REPOSITORY_WRITE_CALL_DOCUMENTS } from '../src/repository/validation.js';
import { createPersistedWorkerStatusDocument } from '../src/worker/status.js';

import type { IndexerDocument } from '../src/repository/types.js';

const SCALE = 10n ** 18n;
const XOR = '0x0200000000000000000000000000000000000000000000000000000000000000';
const VAL = '0x0200040000000000000000000000000000000000000000000000000000000000';
const PSWAP = '0x0200050000000000000000000000000000000000000000000000000000000000';
const DUST_DAI = '0x00a0e746a66b290bd29cbffecc710aefacb98840937229e1e847590006fa0696';
const ETH = '0x0200070000000000000000000000000000000000000000000000000000000000';
const XSTUSD = '0x0200080000000000000000000000000000000000000000000000000000000000';
const KUSD = '0x02000c0000000000000000000000000000000000000000000000000000000000';
const LIBERLAND_ACCOUNT = '5GrwvaEF5zXb26Fz9rcQpDWSxZ9zC7d4L4sUx8m6RRnF9jqw';
const canonicalBlockHash = (label: string): string =>
  `0x${createHash('sha256').update(label).digest('hex')}`;
const markIndexerMainnet = (indexer: unknown): void => {
  (indexer as { observedGenesisHash: string }).observedGenesisHash = SORA_MAINNET_GENESIS_HASH;
};

const eventRecord = (section: string, method: string, data: Record<string, unknown>, extrinsicIndex = 0) => ({
  phase: {
    isApplyExtrinsic: true,
    asApplyExtrinsic: { toNumber: () => extrinsicIndex },
  },
  event: {
    section,
    method,
    data: {
      toArray: () =>
        Object.values(data).map((value) => ({
          toJSON: () => value,
          toString: () => String(value ?? ''),
        })),
    },
    meta: {
      fields: Object.keys(data).map((name) => ({
        name: {
          isSome: true,
          unwrap: () => ({ toString: () => name }),
        },
      })),
    },
  },
});

const config = {
  host: '0.0.0.0',
  port: 4350,
  graphqlPath: '/graphql',
  httpListenBacklog: 4_096,
  httpShutdownTimeoutMs: 30_000,
  httpKeepAliveTimeoutMs: 75_000,
  httpHeadersTimeoutMs: 80_000,
  httpRequestTimeoutMs: 120_000,
  httpMaxConnections: 10_000,
  httpMaxHeaderBytes: 16_384,
  httpMaxRequestsPerSocket: 1_000,
  rateLimitWindowMs: 60_000,
  rateLimitMax: 600,
  rateLimitMaxKeys: 20_000,
  rateLimitGlobalWindowMs: 60_000,
  rateLimitGlobalMax: 50_000,
  graphqlHttpMaxBodyBytes: 262_144,
  graphqlHttpMaxInFlight: 100,
  graphqlMaxDepth: 12,
  graphqlMaxDocumentNodes: 2_000,
  graphqlMaxFields: 500,
  graphqlMaxAliases: 50,
  graphqlMaxFragmentSpreads: 100,
  graphqlMaxOperationCost: 100_000,
  graphqlAllowIntrospection: false,
  graphqlWsMaxPayloadBytes: 65_536,
  graphqlWsConnectionInitTimeoutMs: 30_000,
  graphqlWsMaxConnections: 1_000,
  graphqlWsMaxConnectionsPerClient: 16,
  graphqlWsMaxOperations: 2_000,
  graphqlWsMaxOperationsPerConnection: 20,
  graphqlWsMaxPendingMessagesPerConnection: 64,
  graphqlCacheMaxEntries: 1_000,
  graphqlCacheMaxBytes: 67_108_864,
  graphqlCacheTtlMs: 2_000,
  graphqlMaxResultBytes: 67_108_864,
  graphqlExecutionMemoryMaxBytes: 536_870_912,
  storageEngine: 'postgres' as const,
  databaseUrl: '',
  skipPostgresMigration: false,
  postgresPoolMax: 20,
  postgresListenPoolMax: 2,
  postgresConnectionTimeoutMs: 10_000,
  postgresQueryTimeoutMs: 120_000,
  postgresStatementTimeoutMs: 120_000,
  postgresMigrationQueryTimeoutMs: 0,
  postgresMigrationStatementTimeoutMs: 0,
  postgresWatchQueueMax: 1_000,
  postgresWatchReconnectMinDelayMs: 100,
  postgresWatchReconnectMaxDelayMs: 10_000,
  rocksdbPath: './data/polkaswap-indexer.rocksdb',
  rocksdbBlockCacheMb: 512,
  rocksdbWriteBufferManagerMb: 256,
  rocksdbParallelism: 4,
  rocksdbEnableStats: false,
  rocksdbDocumentCacheMax: 10_000,
  rocksdbDocumentCacheMaxBytes: 268_435_456,
  rocksdbWatchQueueMax: 1_000,
  rocksdbQueryMaxScannedRows: 100_000,
  rocksdbCompactionMinFreeGb: 10,
  soraWsEndpoint: 'wss://mof2.sora.org',
  chainStartBlock: 0,
  chainBatchSize: 25,
  stateRefreshIntervalBlocks: 250,
  snapshotIntervalBlocks: 250,
  fullReconciliationIntervalBlocks: 250,
  chainShutdownTimeoutMs: 30_000,
  chainRpcTimeoutMs: 15_000,
  chainRpcMaxInFlight: 256,
  derivedStorageLoadMaxBytes: 268_435_456,
  derivedStorageCacheMaxBytes: 67_108_864,
  analyticsInputCacheMaxBytes: 134_217_728,
  backfillPrefetchConcurrency: 1,
  finalizedCatchupPrefetchConcurrency: 1,
  priceStreamRefreshIntervalBlocks: 0,
  legacySoraBlockTypes: false,
  archiveSoraWsEndpoint: '',
  workerReadinessMaxLagBlocks: 25,
  workerReadinessMaxStalenessSeconds: 120,
  workerMetricsHost: '127.0.0.1',
  workerMetricsPort: 9464,
  workerMetricsMaxInFlight: 10,
};

const mainnetStartApi = (finalizedBlock = SORA_LEGACY_IDENTITY_ANCHOR.block + 100) => {
  const finalizedHash = canonicalBlockHash(`finalized-${finalizedBlock}`);
  return {
    rpc: {
      chain: {
        getBlockHash: async (block: number) => ({
          toString: () => block === 0
            ? SORA_MAINNET_GENESIS_HASH
            : block === SORA_LEGACY_IDENTITY_ANCHOR.block
              ? SORA_LEGACY_IDENTITY_ANCHOR.hash
              : canonicalBlockHash(`block-${block}`),
        }),
        getFinalizedHead: async () => ({ toString: () => finalizedHash }),
        getHeader: async () => ({
          number: { toNumber: () => finalizedBlock },
          hash: { toString: () => finalizedHash },
        }),
      },
    },
    query: {
      timestamp: {
        now: {
          at: async (blockHash: string) => ({
            toString: () => String(
              (blockHash === SORA_LEGACY_IDENTITY_ANCHOR.hash
                ? SORA_LEGACY_IDENTITY_ANCHOR.timestamp
                : 1_800_000_000) * 1_000,
            ),
          }),
        },
      },
    },
  };
};

const createBlockNetworkSnapshot = (
  blockHeight: number,
  timestamp: number,
  data: Partial<Record<string, unknown>>
) => ({
  collection: 'networkSnapshots' as const,
  id: `block-${blockHeight}`,
  blockHeight,
  timestamp,
  data: {
    id: `block-${blockHeight}`,
    type: 'BLOCK',
    timestamp,
    accounts: 0,
    transactions: 0,
    fees: '0',
    liquidityUSD: '0',
    poolLiquidityUSD: '0',
    orderBookLiquidityUSD: '0',
    volumeUSD: '0',
    swaps: 0,
    activePools: 0,
    activeOrderBooks: 0,
    listedAssets: 0,
    bridgeIncomingTransactions: 0,
    bridgeOutgoingTransactions: 0,
    ...data,
  },
});

const createAssetSnapshot = (
  id: string,
  timestamp: number,
  priceUSD: { open: string; high: string; low: string; close: string },
  volumeUSD = '0'
) => ({
  collection: 'assetSnapshots' as const,
  id,
  blockHeight: 1,
  timestamp,
  data: {
    id,
    assetId: XOR,
    timestamp,
    type: 'DEFAULT',
    supply: '0',
    mint: '0',
    burn: '0',
    priceUSD,
    volume: {
      amount: '0',
      amountUSD: volumeUSD,
    },
  },
});

describe('ChainIndexer price derivation', () => {
  it('prefers liquid stable pools over dust pools for derived asset prices', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      derivePrices: (
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        pools: Array<{ baseAssetId: string; targetAssetId: string; baseAssetReserves: bigint; targetAssetReserves: bigint }>
      ) => Map<string, bigint>;
    };

    const prices = indexer.derivePrices(
      new Map([
        [XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }],
        [DUST_DAI, { id: DUST_DAI, symbol: 'DAI', name: 'Dust DAI', decimals: 18, supply: 0n }],
        [KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18, supply: 0n }],
      ]),
      [
        {
          baseAssetId: XOR,
          targetAssetId: DUST_DAI,
          baseAssetReserves: 707_000_000_000_000n,
          targetAssetReserves: 701n,
        },
        {
          baseAssetId: XOR,
          targetAssetId: KUSD,
          baseAssetReserves: 40_668_701_790_400_544_319n,
          targetAssetReserves: 243_698_436_474_125_931_406n,
        },
      ]
    );

    expect(prices.get(XOR)).toBeGreaterThan(5n * SCALE);
    expect(prices.get(XOR)).toBeLessThan(7n * SCALE);
  });

  it('does not derive global prices from dust or low-liquidity pools', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      derivePrices: (
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        pools: Array<{ baseAssetId: string; targetAssetId: string; baseAssetReserves: bigint; targetAssetReserves: bigint }>
      ) => Map<string, bigint>;
    };
    const dustAsset = '0x0300000000000000000000000000000000000000000000000000000000000000';
    const lowLiquidityAsset = '0x0400000000000000000000000000000000000000000000000000000000000000';

    const prices = indexer.derivePrices(
      new Map([
        [KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18, supply: 0n }],
        [XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }],
        [dustAsset, { id: dustAsset, symbol: 'DUST', name: 'Dust token', decimals: 18, supply: 0n }],
        [lowLiquidityAsset, { id: lowLiquidityAsset, symbol: 'LOW', name: 'Low liquidity token', decimals: 18, supply: 0n }],
      ]),
      [
        {
          baseAssetId: KUSD,
          targetAssetId: XOR,
          baseAssetReserves: 200n * SCALE,
          targetAssetReserves: 100n * SCALE,
        },
        {
          baseAssetId: XOR,
          targetAssetId: dustAsset,
          baseAssetReserves: 10n * SCALE,
          targetAssetReserves: 1n,
        },
        {
          baseAssetId: XOR,
          targetAssetId: lowLiquidityAsset,
          baseAssetReserves: 10n * SCALE,
          targetAssetReserves: SCALE,
        },
      ]
    );

    expect(prices.get(XOR)).toBe(2n * SCALE);
    expect(prices.has(dustAsset)).toBe(false);
    expect(prices.has(lowLiquidityAsset)).toBe(false);
  });

  it('rejects shallow stable pools with enough stable-side liquidity to imply bad asset prices', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      derivePrices: (
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        pools: Array<{ baseAssetId: string; targetAssetId: string; baseAssetReserves: bigint; targetAssetReserves: bigint }>
      ) => Map<string, bigint>;
    };

    const prices = indexer.derivePrices(
      new Map([
        [XOR, { id: XOR, symbol: 'XOR', name: 'SORA', decimals: 18, supply: 0n }],
        [XSTUSD, { id: XSTUSD, symbol: 'XSTUSD', name: 'SORA Synthetic USD', decimals: 18, supply: 0n }],
      ]),
      [
        {
          baseAssetId: XOR,
          targetAssetId: XSTUSD,
          baseAssetReserves: 267_093_660_969_057_671n,
          targetAssetReserves: 122_541_250_000_000_000_000n,
        },
      ]
    );

    expect(prices.has(XOR)).toBe(false);
  });

  it('still derives XOR from a current-depth stable pool', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      derivePrices: (
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        pools: Array<{ baseAssetId: string; targetAssetId: string; baseAssetReserves: bigint; targetAssetReserves: bigint }>
      ) => Map<string, bigint>;
    };

    const prices = indexer.derivePrices(
      new Map([
        [XOR, { id: XOR, symbol: 'XOR', name: 'SORA', decimals: 18, supply: 0n }],
        [KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18, supply: 0n }],
      ]),
      [
        {
          baseAssetId: XOR,
          targetAssetId: KUSD,
          baseAssetReserves: 54_108_391_503_195_511_939n,
          targetAssetReserves: 284_137_450_352_029_888_903n,
        },
      ]
    );

    expect(prices.get(XOR)).toBeGreaterThan(5n * SCALE);
    expect(prices.get(XOR)).toBeLessThan(6n * SCALE);
  });



  it('prefers deeper target reserves over a shallow pool with more stable-side liquidity', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      derivePrices: (
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        pools: Array<{ baseAssetId: string; targetAssetId: string; baseAssetReserves: bigint; targetAssetReserves: bigint }>
      ) => Map<string, bigint>;
    };

    const prices = indexer.derivePrices(
      new Map([
        [ETH, { id: ETH, symbol: 'ETH', name: 'Ether', decimals: 18, supply: 0n }],
        [XSTUSD, { id: XSTUSD, symbol: 'XSTUSD', name: 'SORA Synthetic USD', decimals: 18, supply: 0n }],
        [KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18, supply: 0n }],
      ]),
      [
        {
          baseAssetId: XSTUSD,
          targetAssetId: ETH,
          baseAssetReserves: 5_000n * SCALE,
          targetAssetReserves: SCALE / 50n,
        },
        {
          baseAssetId: KUSD,
          targetAssetId: ETH,
          baseAssetReserves: 2_000n * SCALE,
          targetAssetReserves: SCALE,
        },
      ]
    );

    expect(prices.get(ETH)).toBe(2_000n * SCALE);
  });

  it('uses the largest USD leg for transaction volume', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      extractVolumeUSD: (data: unknown) => bigint;
    };

    const volume = indexer.extractVolumeUSD({
      baseAssetAmountUSD: '10',
      targetAssetAmountUSD: '9.95',
      amountUSD: '1',
    });

    expect(volume).toBe(10n * SCALE);
  });

  it('sums xor fee withdrawal events as network fees', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      extractNetworkFee: (events: unknown[]) => bigint;
    };

    const fee = indexer.extractNetworkFee([
      eventRecord('xorFee', 'FeeWithdrawn', { amount: '100' }),
      eventRecord('xorFee', 'FeeWithdrawn', { fee: '23' }),
      eventRecord('balances', 'Transfer', { amount: '999' }),
    ]);

    expect(fee).toBe(123n);
  });

  it('mirrors the runtime XOR fee split when deriving direct fee burns', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      extractXorFeeBurn: (networkFee: unknown) => bigint;
    };

    expect(indexer.extractXorFeeBurn(85n * SCALE)).toBe(20n * SCALE);
    expect(indexer.extractXorFeeBurn('123')).toBe(30n);
    expect(indexer.extractXorFeeBurn('0')).toBe(0n);
  });

  it('uses native balances issuance directly for XOR asset supply snapshots', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createSupplyByAsset: (
        tokenIssuances: Array<[{ args: unknown[] }, unknown]>,
        nativeXorIssuance: unknown
      ) => Map<string, bigint>;
    };

    const nativeXorIssuance = (999n * SCALE * 1_000_000n + 123n).toString();
    const supplyByAsset = indexer.createSupplyByAsset([[{ args: [KUSD] }, '123']], nativeXorIssuance);

    expect(supplyByAsset.get(XOR)).toBe(999n * SCALE * 1_000_000n + 123n);
    expect(supplyByAsset.get(KUSD)).toBe(123n);
  });



  it('requires native balances issuance when refreshing XOR supply', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      fetchNativeXorIssuance: () => Promise<unknown>;
    };

    indexer.api = { query: { balances: {} } };

    await expect(indexer.fetchNativeXorIssuance()).rejects.toThrow(
      'balances.totalIssuance is required to refresh native XOR supply'
    );
  });

  it('propagates native balances issuance query failures', async () => {
    const failure = new Error('RPC unavailable');
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      fetchNativeXorIssuance: () => Promise<unknown>;
    };

    indexer.api = {
      query: {
        balances: {
          totalIssuance: vi.fn().mockRejectedValue(failure),
        },
      },
    };

    await expect(indexer.fetchNativeXorIssuance()).rejects.toBe(failure);
  });

  it('requires storage entry queries instead of using empty collection fallbacks', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      fetchStorageEntries: (storage: unknown, label: string) => Promise<unknown[]>;
    };

    await expect(indexer.fetchStorageEntries({}, 'orderBook.bids')).rejects.toThrow(
      'orderBook.bids.entriesPaged is required to refresh derived state'
    );
  });

  it('loads storage entries in bounded pages and advances with the prior page startKey', async () => {
    const firstPage = Array.from({ length: 256 }, (_item, index) => [
      { args: [index], toHex: () => `0x${index.toString(16).padStart(4, '0')}` },
      index,
    ]) as Array<[{ args: unknown[]; toHex: () => string }, number]>;
    const finalEntry = [
      { args: [256], toHex: () => '0x0100' },
      256,
    ] as [{ args: unknown[]; toHex: () => string }, number];
    const entriesPaged = vi.fn(async ({ startKey }: { startKey?: unknown }) =>
      startKey ? [finalEntry] : firstPage
    );
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      fetchStorageEntries: (storage: unknown, label: string, ...args: unknown[]) => Promise<unknown[]>;
    };

    await expect(
      indexer.fetchStorageEntries({ entriesPaged }, 'poolXYK.reserves', 'scope')
    ).resolves.toHaveLength(257);
    expect(entriesPaged).toHaveBeenCalledTimes(2);
    expect(entriesPaged.mock.calls[0]?.[0]).toEqual({ args: ['scope'], pageSize: 256 });
    expect(entriesPaged.mock.calls[1]?.[0]).toEqual({
      args: ['scope'],
      pageSize: 256,
      startKey: '0x00ff',
    });
  });

  it('fails closed when an entriesPaged backend repeats a page without continuation progress', async () => {
    const repeatedPage = Array.from({ length: 256 }, (_item, index) => [
      { args: [index], toHex: () => `0x${index.toString(16).padStart(4, '0')}` },
      index,
    ]) as Array<[{ args: unknown[]; toHex: () => string }, number]>;
    const entriesPaged = vi.fn().mockResolvedValue(repeatedPage);
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      fetchStorageEntries: (storage: unknown, label: string) => Promise<unknown[]>;
    };

    await expect(indexer.fetchStorageEntries({ entriesPaged }, 'orderBook.limitOrders')).rejects.toThrow(
      /progress|startKey/
    );
    expect(entriesPaged).toHaveBeenCalledTimes(2);
  });

  it('rejects an oversized derived storage entry before retaining it', async () => {
    const indexer = new ChainIndexer(
      { ...config, derivedStorageLoadMaxBytes: 256 },
      new MemoryRepository()
    ) as unknown as {
      fetchStorageEntries: (storage: unknown, label: string) => Promise<unknown[]>;
    };
    const entriesPaged = vi.fn().mockResolvedValue([
      [{ args: ['large'] }, { value: 'x'.repeat(1_000) }],
    ]);

    await expect(indexer.fetchStorageEntries({ entriesPaged }, 'orderBook.limitOrders')).rejects.toThrow(
      /retained-load limit/
    );
    expect(entriesPaged).toHaveBeenCalledTimes(1);
  });

  it('classifies only storage domains that can be changed by a pallet operation', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      derivedStorageDomainsForPallet: (pallet: string, method?: string) => string[];
    };

    expect(indexer.derivedStorageDomainsForPallet('poolXYK', 'ReservesChanged')).toEqual(['poolReserves']);
    expect(indexer.derivedStorageDomainsForPallet('poolXYK', 'Exchange')).toEqual(['poolReserves']);
    expect(indexer.derivedStorageDomainsForPallet('poolXYK', 'DepositLiquidity')).toEqual([
      'poolReserves',
      'poolIssuance',
      'poolProviders',
    ]);
    expect(indexer.derivedStorageDomainsForPallet('liquidityProxy', 'Swap')).toEqual([]);
    expect(indexer.derivedStorageDomainsForPallet('xorFee', 'FeeWithdrawn')).toEqual([]);
    expect(indexer.derivedStorageDomainsForPallet('assets', 'Transfer')).toEqual([]);
    expect(indexer.derivedStorageDomainsForPallet('assets', 'Issued')).toEqual(['assetSupply']);
    expect(indexer.derivedStorageDomainsForPallet('assets', 'AssetRegistered')).toEqual(['assetMetadata']);
    expect(indexer.derivedStorageDomainsForPallet('tokens', 'Transfer')).toEqual([]);
    expect(indexer.derivedStorageDomainsForPallet('tokens', 'Withdrawn')).toEqual(['assetSupply']);
    expect(indexer.derivedStorageDomainsForPallet('balances', 'Rescinded')).toEqual(['assetSupply']);
    expect(indexer.derivedStorageDomainsForPallet('system', 'CodeUpdated')).toHaveLength(12);
  });

  it('reuses clean storage domains and reloads only domains marked dirty', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      loadDerivedStorageDomain: <T>(
        domain: string,
        blockHeight: number,
        forceReconciliation: boolean,
        loader: () => Promise<T>
      ) => Promise<T>;
      markDerivedStorageDomainsDirty: (domains: Iterable<string>) => void;
      getDerivedStorageCacheMetrics: () => {
        loads: number;
        hits: number;
        cachedDomains: number;
        dirtyDomains: number;
      };
    };
    const firstOrderBookLoad = vi.fn().mockResolvedValue(['order-1']);
    const skippedOrderBookLoad = vi.fn().mockResolvedValue(['should-not-load']);
    const poolLoad = vi.fn().mockResolvedValue(['pool-1']);
    const refreshedOrderBookLoad = vi.fn().mockResolvedValue(['order-2']);

    expect(await indexer.loadDerivedStorageDomain('orderBooks', 10, false, firstOrderBookLoad)).toEqual(['order-1']);
    expect(await indexer.loadDerivedStorageDomain('poolReserves', 10, false, poolLoad)).toEqual(['pool-1']);
    expect(await indexer.loadDerivedStorageDomain('orderBooks', 20, false, skippedOrderBookLoad)).toEqual(['order-1']);

    indexer.markDerivedStorageDomainsDirty(['orderBooks']);

    expect(await indexer.loadDerivedStorageDomain('orderBooks', 25, false, refreshedOrderBookLoad)).toEqual(['order-2']);
    expect(firstOrderBookLoad).toHaveBeenCalledTimes(1);
    expect(skippedOrderBookLoad).not.toHaveBeenCalled();
    expect(poolLoad).toHaveBeenCalledTimes(1);
    expect(refreshedOrderBookLoad).toHaveBeenCalledTimes(1);
    expect(indexer.getDerivedStorageCacheMetrics()).toMatchObject({ loads: 3, hits: 1, cachedDomains: 2 });
  });

  it('keeps metadata and LP issuance cached across reserve- and supply-only mutations', async () => {
    const assetInfos = vi.fn().mockResolvedValue([]);
    const tokenIssuance = vi.fn().mockResolvedValue([]);
    const nativeIssuance = vi.fn().mockResolvedValue('0');
    const poolProperties = vi.fn().mockResolvedValue([]);
    const poolReserves = vi.fn().mockResolvedValue([]);
    const poolIssuance = vi.fn().mockResolvedValue([]);
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      loadAssetStorageDomain: (block: number) => Promise<unknown>;
      loadPoolStorageDomain: (block: number) => Promise<unknown>;
      markDerivedStorageDomainsDirty: (domains: Iterable<string>) => void;
    };
    indexer.api = {
      query: {
        assets: { assetInfosV2: { entriesPaged: assetInfos } },
        tokens: { totalIssuance: { entriesPaged: tokenIssuance } },
        balances: { totalIssuance: nativeIssuance },
        poolXYK: {
          properties: { entriesPaged: poolProperties },
          reserves: { entriesPaged: poolReserves },
          totalIssuances: { entriesPaged: poolIssuance },
        },
      },
    };

    await indexer.loadAssetStorageDomain(10);
    await indexer.loadPoolStorageDomain(10);
    indexer.markDerivedStorageDomainsDirty(['assetSupply', 'poolReserves']);
    await indexer.loadAssetStorageDomain(11);
    await indexer.loadPoolStorageDomain(11);

    expect(assetInfos).toHaveBeenCalledTimes(1);
    expect(tokenIssuance).toHaveBeenCalledTimes(2);
    expect(nativeIssuance).toHaveBeenCalledTimes(2);
    expect(poolProperties).toHaveBeenCalledTimes(1);
    expect(poolReserves).toHaveBeenCalledTimes(2);
    expect(poolIssuance).toHaveBeenCalledTimes(1);
  });

  it('does not let an older in-flight domain load overwrite a newer dirty generation', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      derivedStorageCache: Map<string, { generation: number; value: unknown }>;
      dirtyDerivedStorageDomains: Set<string>;
      loadDerivedStorageDomain: <T>(
        domain: string,
        blockHeight: number,
        forceReconciliation: boolean,
        loader: () => Promise<T>
      ) => Promise<T>;
      markDerivedStorageDomainsDirty: (domains: Iterable<string>) => void;
    };
    let releaseOldLoad!: () => void;
    let signalOldLoadStarted!: () => void;
    const oldLoadGate = new Promise<void>((resolve) => {
      releaseOldLoad = resolve;
    });
    const oldLoadStarted = new Promise<void>((resolve) => {
      signalOldLoadStarted = resolve;
    });
    const oldLoad = indexer.loadDerivedStorageDomain('poolReserves', 100, false, async () => {
      signalOldLoadStarted();
      await oldLoadGate;
      return ['old-pool-state'];
    });

    await oldLoadStarted;
    indexer.markDerivedStorageDomainsDirty(['poolReserves']);
    await expect(
      indexer.loadDerivedStorageDomain('poolReserves', 101, false, async () => ['fresh-pool-state'])
    ).resolves.toEqual(['fresh-pool-state']);
    releaseOldLoad();
    await expect(oldLoad).resolves.toEqual(['old-pool-state']);

    expect(indexer.derivedStorageCache.get('poolReserves')?.value).toEqual(['fresh-pool-state']);
    expect(indexer.dirtyDerivedStorageDomains.has('poolReserves')).toBe(false);
  });

  it('marks a storage load non-authoritative when its domain is dirtied in flight', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      loadDerivedStorageDomainWithStatus: <T>(
        domain: string,
        blockHeight: number,
        forceReconciliation: boolean,
        loader: () => Promise<T>
      ) => Promise<{ value: T; refreshed: boolean; authoritativeForGeneration: boolean }>;
      markDerivedStorageDomainsDirty: (domains: Iterable<string>) => void;
    };
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loadStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const load = indexer.loadDerivedStorageDomainWithStatus('assetMetadata', 100, false, async () => {
      started();
      await gate;
      return ['stale-generation'];
    });

    await loadStarted;
    indexer.markDerivedStorageDomainsDirty(['assetMetadata']);
    release();

    await expect(load).resolves.toEqual({
      value: ['stale-generation'],
      refreshed: true,
      authoritativeForGeneration: false,
    });
  });

  it('never serves or installs a future-block domain cache for an older request', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      derivedStorageCache: Map<string, { blockHeight: number; value: unknown }>;
      loadDerivedStorageDomainWithStatus: <T>(
        domain: string,
        blockHeight: number,
        forceReconciliation: boolean,
        loader: () => Promise<T>
      ) => Promise<{ value: T; refreshed: boolean; authoritativeForGeneration: boolean }>;
    };
    await indexer.loadDerivedStorageDomainWithStatus('poolReserves', 200, false, async () => ['future']);
    const historicalLoader = vi.fn().mockResolvedValue(['historical']);

    await expect(
      indexer.loadDerivedStorageDomainWithStatus('poolReserves', 100, false, historicalLoader)
    ).resolves.toEqual({
      value: ['historical'],
      refreshed: true,
      authoritativeForGeneration: true,
    });
    expect(historicalLoader).toHaveBeenCalledOnce();
    expect(indexer.derivedStorageCache.get('poolReserves')).toMatchObject({
      blockHeight: 200,
      value: ['future'],
    });
  });

  it('serializes projections and gives each one a query snapshot pinned to its finalized block', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      runProjectionRefreshExclusive: (
        blockHeight: number,
        task: (query: { marker: string }) => Promise<void>
      ) => Promise<void>;
    };
    const getBlockHash = vi.fn(async (blockHeight: number) => ({ toString: () => `0x${blockHeight}` }));
    const at = vi.fn(async (hash: string) => ({ query: { marker: hash } }));
    indexer.api = { rpc: { chain: { getBlockHash } }, at, query: { marker: 'live-changing-state' } };
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const markers: string[] = [];
    const first = indexer.runProjectionRefreshExclusive(10, async (query) => {
      markers.push(query.marker);
      firstStarted();
      await firstGate;
    });
    const second = indexer.runProjectionRefreshExclusive(11, async (query) => {
      markers.push(query.marker);
    });

    await firstStartedPromise;
    expect(at).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second]);

    expect(getBlockHash.mock.calls.map(([blockHeight]) => blockHeight)).toEqual([10, 11]);
    expect(at.mock.calls.map(([hash]) => hash)).toEqual(['0x10', '0x11']);
    expect(markers).toEqual(['0x10', '0x11']);
  });

  it('skips an obsolete lower-block projection after a higher block has published shared state', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      assetInfos: Map<string, unknown>;
      assetInfosBlockHeight: number;
      networkLiquidityStats: Record<string, unknown>;
      networkLiquidityStatsBlockHeight: number;
      lastDerivedStorageReconciliationBlock: number | null;
      runProjectionRefreshExclusive: (
        blockHeight: number,
        task: (query: { marker: string }) => Promise<void>
      ) => Promise<void>;
      publishAssetInfos: (assets: Map<string, unknown>, blockHeight: number) => boolean;
      publishNetworkLiquidityStats: (stats: Record<string, unknown>, blockHeight: number) => boolean;
      completeDerivedStorageReconciliation: (blockHeight: number, reconciled: boolean) => void;
    };
    const getBlockHash = vi.fn(async (blockHeight: number) => ({ toString: () => `0x${blockHeight}` }));
    const at = vi.fn(async (hash: string) => ({ query: { marker: hash } }));
    indexer.api = { rpc: { chain: { getBlockHash } }, at };
    const obsolete = vi.fn(async () => {
      indexer.publishAssetInfos(new Map([['lower', {}]]), 10);
      indexer.publishNetworkLiquidityStats({ liquidityUSD: '10' }, 10);
      indexer.completeDerivedStorageReconciliation(10, true);
    });

    await indexer.runProjectionRefreshExclusive(11, async () => {
      indexer.publishAssetInfos(new Map([['higher', {}]]), 11);
      indexer.publishNetworkLiquidityStats({ liquidityUSD: '11' }, 11);
      indexer.completeDerivedStorageReconciliation(11, true);
    });
    await indexer.runProjectionRefreshExclusive(10, obsolete);

    expect(obsolete).not.toHaveBeenCalled();
    expect(getBlockHash).toHaveBeenCalledTimes(1);
    expect(indexer.assetInfos.has('higher')).toBe(true);
    expect(indexer.assetInfosBlockHeight).toBe(11);
    expect(indexer.networkLiquidityStats).toEqual({ liquidityUSD: '11' });
    expect(indexer.networkLiquidityStatsBlockHeight).toBe(11);
    expect(indexer.lastDerivedStorageReconciliationBlock).toBe(11);
  });

  it('publishes shared prices monotonically by finalized block height', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      prices: Map<string, bigint>;
      pricesBlockHeight: number;
      publishPrices: (prices: Map<string, bigint>, blockHeight: number) => boolean;
    };

    expect(indexer.publishPrices(new Map([[XOR, 11n]]), 101)).toBe(true);
    expect(indexer.publishPrices(new Map([[XOR, 10n]]), 100)).toBe(false);
    expect(indexer.prices.get(XOR)).toBe(11n);
    expect(indexer.pricesBlockHeight).toBe(101);
  });

  it('makes clean-cache consumers await an in-flight forced reconciliation', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      loadDerivedStorageDomain: <T>(
        domain: string,
        blockHeight: number,
        forceReconciliation: boolean,
        loader: () => Promise<T>
      ) => Promise<T>;
    };
    await indexer.loadDerivedStorageDomain('orderBooks', 10, false, async () => ['old-state']);

    let releaseReconciliation!: () => void;
    let signalReconciliationStarted!: () => void;
    const reconciliationGate = new Promise<void>((resolve) => {
      releaseReconciliation = resolve;
    });
    const reconciliationStarted = new Promise<void>((resolve) => {
      signalReconciliationStarted = resolve;
    });
    const forced = indexer.loadDerivedStorageDomain('orderBooks', 20, true, async () => {
      signalReconciliationStarted();
      await reconciliationGate;
      return ['reconciled-state'];
    });
    await reconciliationStarted;

    const staleLoader = vi.fn().mockResolvedValue(['stale-cache-value']);
    const overlappingConsumer = indexer.loadDerivedStorageDomain('orderBooks', 20, false, staleLoader);
    let overlappingSettled = false;
    void overlappingConsumer.finally(() => {
      overlappingSettled = true;
    });
    await Promise.resolve();
    expect(overlappingSettled).toBe(false);

    releaseReconciliation();
    await expect(forced).resolves.toEqual(['reconciled-state']);
    await expect(overlappingConsumer).resolves.toEqual(['reconciled-state']);
    expect(staleLoader).not.toHaveBeenCalled();
  });

  it('releases the old domain generation before a replacement scan and keeps failures dirty', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      derivedStorageCache: Map<string, { value: unknown }>;
      dirtyDerivedStorageDomains: Set<string>;
      loadDerivedStorageDomain: <T>(
        domain: string,
        blockHeight: number,
        forceReconciliation: boolean,
        loader: () => Promise<T>
      ) => Promise<T>;
      markDerivedStorageDomainsDirty: (domains: Iterable<string>) => void;
    };

    await indexer.loadDerivedStorageDomain('vaults', 10, false, async () => ['last-good-vault-state']);
    indexer.markDerivedStorageDomainsDirty(['vaults']);

    await expect(
      indexer.loadDerivedStorageDomain('vaults', 11, false, async () => {
        throw new Error('RPC unavailable');
      })
    ).rejects.toThrow('RPC unavailable');
    expect(indexer.derivedStorageCache.get('vaults')).toBeUndefined();
    expect(indexer.dirtyDerivedStorageDomains.has('vaults')).toBe(true);
  });

  it('evicts least-recently-used derived domains to stay within the byte budget', async () => {
    const indexer = new ChainIndexer(
      { ...config, derivedStorageCacheMaxBytes: 600 },
      new MemoryRepository()
    ) as unknown as {
      derivedStorageCache: Map<string, { value: unknown }>;
      dirtyDerivedStorageDomains: Set<string>;
      loadDerivedStorageDomain: <T>(
        domain: string,
        blockHeight: number,
        forceReconciliation: boolean,
        loader: () => Promise<T>
      ) => Promise<T>;
      getDerivedStorageCacheMetrics: () => {
        cachedBytes: number;
        maximumBytes: number;
        capacityEvictions: number;
      };
    };

    await indexer.loadDerivedStorageDomain('poolReserves', 1, false, async () => ['a'.repeat(100)]);
    await indexer.loadDerivedStorageDomain('vaults', 1, false, async () => ['b'.repeat(100)]);

    expect(indexer.derivedStorageCache.has('poolReserves')).toBe(false);
    expect(indexer.derivedStorageCache.has('vaults')).toBe(true);
    expect(indexer.dirtyDerivedStorageDomains.has('poolReserves')).toBe(true);
    expect(indexer.getDerivedStorageCacheMetrics()).toMatchObject({
      maximumBytes: 600,
      capacityEvictions: 1,
    });
    expect(indexer.getDerivedStorageCacheMetrics().cachedBytes).toBeLessThanOrEqual(600);
  });

  it('serves but does not retain a derived domain larger than the byte budget', async () => {
    const indexer = new ChainIndexer(
      { ...config, derivedStorageCacheMaxBytes: 256 },
      new MemoryRepository()
    ) as unknown as {
      derivedStorageCache: Map<string, { value: unknown }>;
      dirtyDerivedStorageDomains: Set<string>;
      loadDerivedStorageDomain: <T>(
        domain: string,
        blockHeight: number,
        forceReconciliation: boolean,
        loader: () => Promise<T>
      ) => Promise<T>;
      getDerivedStorageCacheMetrics: () => {
        cachedBytes: number;
        capacityBypasses: number;
        capacityBypassedBytes: number;
      };
    };
    const value = ['x'.repeat(10_000)];

    await expect(
      indexer.loadDerivedStorageDomain('orderBooks', 1, false, async () => value)
    ).resolves.toBe(value);
    expect(indexer.derivedStorageCache.has('orderBooks')).toBe(false);
    expect(indexer.dirtyDerivedStorageDomains.has('orderBooks')).toBe(true);
    expect(indexer.getDerivedStorageCacheMetrics()).toMatchObject({
      cachedBytes: 0,
      capacityBypasses: 1,
      capacityBypassedBytes: 257,
    });
  });

  it('marks block storage domains only after the indexed documents commit', async () => {
    const repository = new MemoryRepository();
    vi.spyOn(repository, 'upsertMany').mockRejectedValue(new Error('write failed'));
    const indexer = new ChainIndexer(config, repository) as unknown as {
      dirtyDerivedStorageDomains: Set<string>;
      indexFetchedBlock: (block: unknown) => Promise<void>;
    };
    indexer.dirtyDerivedStorageDomains.clear();
    markIndexerMainnet(indexer);
    const blockHash = canonicalBlockHash('storage-domain-commit');

    await expect(
      indexer.indexFetchedBlock({
        requestedHash: blockHash,
        signedBlock: {
          block: {
            header: {
              number: { toNumber: () => 249 },
              hash: { toString: () => blockHash },
            },
            extrinsics: [],
          },
        },
        events: [eventRecord('poolXYK', 'ReservesChanged', {})],
        timestamp: 994,
      })
    ).rejects.toThrow('write failed');

    expect(indexer.dirtyDerivedStorageDomains.size).toBe(0);
  });

  it('preserves full reconciliation while merging a newer derived-state request', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      mergeDerivedStateRefreshRequests: (
        left: { blockHeight: number; timestamp: number; includeSnapshots: boolean; forceFullReconciliation?: boolean },
        right: { blockHeight: number; timestamp: number; includeSnapshots: boolean; forceFullReconciliation?: boolean }
      ) => { blockHeight: number; includeSnapshots: boolean; forceFullReconciliation?: boolean };
    };

    expect(
      indexer.mergeDerivedStateRefreshRequests(
        { blockHeight: 250, timestamp: 1_000, includeSnapshots: false, forceFullReconciliation: true },
        { blockHeight: 251, timestamp: 1_006, includeSnapshots: true, forceFullReconciliation: false }
      )
    ).toMatchObject({ blockHeight: 251, includeSnapshots: true, forceFullReconciliation: true });
  });

  it('schedules the 250-block reconciliation independently of the normal refresh interval', async () => {
    const repository = new MemoryRepository();
    const requestDerivedStateRefresh = vi.fn();
    const indexer = new ChainIndexer(
      { ...config, stateRefreshIntervalBlocks: 60, snapshotIntervalBlocks: 1_000 },
      repository
    ) as unknown as {
      requestDerivedStateRefresh: typeof requestDerivedStateRefresh;
      indexFetchedBlock: (block: unknown) => Promise<void>;
    };
    indexer.requestDerivedStateRefresh = requestDerivedStateRefresh;
    markIndexerMainnet(indexer);
    const blockHash = canonicalBlockHash('full-reconciliation');

    await indexer.indexFetchedBlock({
      requestedHash: blockHash,
      signedBlock: {
        block: {
          header: {
            number: { toNumber: () => 250 },
            hash: { toString: () => blockHash },
          },
          extrinsics: [],
        },
      },
      events: [],
      timestamp: 1_000,
    });

    expect(requestDerivedStateRefresh).toHaveBeenCalledWith(250, 1_000, false, true);
  });

  it('propagates block timestamp query failures', async () => {
    const failure = new Error('timestamp RPC unavailable');
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      fetchBlockTimestamp: (hash: string) => Promise<number>;
    };

    indexer.api = {
      query: {
        timestamp: {
          now: {
            at: vi.fn().mockRejectedValue(failure),
          },
        },
      },
    };

    await expect(indexer.fetchBlockTimestamp(canonicalBlockHash('block'))).rejects.toBe(failure);
  });

  it('propagates validator identity query failures', async () => {
    const failure = new Error('identity RPC unavailable');
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      readValidatorIdentity: (address: string) => Promise<Record<string, unknown> | null>;
    };

    indexer.api = {
      query: {
        identity: {
          identityOf: vi.fn().mockRejectedValue(failure),
        },
      },
    };

    await expect(indexer.readValidatorIdentity('validator-1')).rejects.toBe(failure);
  });

  it('requires staking validator storage instead of returning an empty validator stream', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      createStakingValidatorDocuments: (
        blockHeight: number,
        timestamp: number,
        prices: Map<string, bigint>,
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>
      ) => Promise<unknown[]>;
    };

    indexer.api = { query: { staking: {} } };

    await expect(indexer.createStakingValidatorDocuments(1, 1, new Map(), new Map())).rejects.toThrow(
      'staking.validators.entriesPaged is required to refresh staking validators'
    );
  });

  it('reads paged staking exposure storage from the current SORA runtime shape', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      getEraExposures: (era: number) => Promise<Map<string, { total: bigint; own: string; others: unknown[] }>>;
    };

    indexer.api = {
      query: {
        staking: {
          erasStakersOverview: {
            entriesPaged: async () => [
              [
                { args: [10, 'validator-1'] },
                { toHuman: () => ({ total: '100', own: '25', pageCount: '1' }) },
              ],
            ],
          },
          erasStakersPaged: {
            entriesPaged: async () => [
              [
                { args: [10, 'validator-1', { toString: () => '0' }] },
                { toHuman: () => ({ pageTotal: '75', others: [{ who: 'nominator-1', value: '75' }] }) },
              ],
            ],
          },
        },
      },
    };

    const exposures = await indexer.getEraExposures(10);

    expect(exposures.get('validator-1')).toEqual({
      total: 100n,
      own: '25',
      others: [{ who: 'nominator-1', value: '75' }],
    });
  });

  it('reads legacy staking exposure storage for eras that predate paged exposure entries', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      getEraExposures: (era: number) => Promise<Map<string, { total: bigint; own: string; others: unknown[] }>>;
    };

    indexer.api = {
      query: {
        staking: {
          erasStakersOverview: { entriesPaged: async () => [] },
          erasStakersPaged: { entriesPaged: async () => [] },
          erasStakers: {
            entriesPaged: async () => [
              [
                { args: [9, 'validator-1'] },
                {
                  total: '100',
                  own: '25',
                  others: [{ who: 'nominator-1', value: '75' }],
                },
              ],
            ],
          },
        },
      },
    };

    const exposures = await indexer.getEraExposures(9);

    expect(exposures.get('validator-1')).toEqual({
      total: 100n,
      own: '25',
      others: [{ who: 'nominator-1', value: '75' }],
    });
  });

  it('adds direct XOR fee burns to asset snapshot burn aggregates', async () => {
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'historyElements',
      id: 'fee-history',
      blockHeight: 10,
      timestamp: 1_700_000_000,
      data: {
        id: 'fee-history',
        timestamp: 1_700_000_000,
        module: 'liquidityProxy',
        method: 'swap',
        networkFee: (85n * SCALE).toString(),
        data: {},
      },
    });
    await repository.upsert({
      collection: 'historyElements',
      id: '0xrequest-mint',
      blockHeight: 10,
      timestamp: 1_700_000_000,
      data: {
        id: '0xrequest-mint',
        timestamp: 1_700_000_000,
        module: 'bridgeProxy',
        method: 'mint',
        networkFee: (85n * SCALE).toString(),
        data: { requestHash: '0xrequest' },
      },
    });

    const indexer = new ChainIndexer(config, repository) as unknown as {
      buildAnalytics: (
        timestamp: number,
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        prices: Map<string, bigint>,
        pools: unknown[],
        liquidityStats: {
          liquidityUSD: string;
          poolLiquidityUSD: string;
          orderBookLiquidityUSD: string;
          activePools: number;
          activeOrderBooks: number;
          listedAssets: number;
        }
      ) => Promise<{ assets: Map<string, Map<string, { burn: bigint }>> }>;
    };
    const analytics = await indexer.buildAnalytics(
      1_700_000_000,
      new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]),
      new Map([[XOR, SCALE]]),
      [],
      {
        liquidityUSD: '0',
        poolLiquidityUSD: '0',
        orderBookLiquidityUSD: '0',
        activePools: 0,
        activeOrderBooks: 0,
        listedAssets: 1,
      }
    );

    expect(analytics.assets.get(XOR)?.get('HOUR')?.burn).toBe(20n * SCALE);
    expect(analytics.assets.get(XOR)?.get('DAY')?.burn).toBe(20n * SCALE);
  });

  it('calculates validator APY from latest era reward points, prices, stake, and commission', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      calculateValidatorApy: (
        validatorTotalStake: bigint,
        eraValidatorReward: bigint,
        rewardPoints: number,
        totalRewardPoints: number,
        commission: string,
        prices: Map<string, bigint>,
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>
      ) => string;
    };

    expect(
      indexer.calculateValidatorApy(
        1_000n * SCALE,
        1n * SCALE,
        25,
        100,
        '100000000',
        new Map([
          [XOR, SCALE],
          [VAL, 2n * SCALE],
        ]),
        new Map([
          [XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }],
          [VAL, { id: VAL, symbol: 'VAL', name: 'VAL', decimals: 18, supply: 0n }],
        ])
      )
    ).toBe('65.7');
  });

  it('creates indexed validator return documents and a compact stream payload', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      createStakingValidatorDocuments: (
        blockHeight: number,
        timestamp: number,
        prices: Map<string, bigint>,
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>
      ) => Promise<Array<{ collection: string; id: string; data: Record<string, any> }>>;
      createStakingValidatorsStream: (
        validatorDocuments: Array<{ collection: string; id: string; data: Record<string, any> }>,
        blockHeight: number,
        timestamp: number
      ) => { collection: string; id: string; data: Record<string, string> };
    };
    const account = { toString: () => 'validator-1' };
    const point = { toString: () => '25' };
    const reward = { unwrap: () => ({ toString: () => (1n * SCALE).toString() }) };
    const identity = {
      isEmpty: false,
      isNone: false,
      unwrap: () => ({
        toHuman: () => ({
          judgements: [[0, 'KnownGood']],
          info: { display: { Raw: 'Validator One' }, image: 'None' },
        }),
      }),
    };

    indexer.api = {
      consts: {
        staking: {
          maxNominatorRewardedPerValidator: { toNumber: () => 1 },
        },
      },
      query: {
        identity: {
          identityOf: async () => identity,
        },
        staking: {
          validators: {
            entriesPaged: async () => [
              [
                { args: ['validator-1'] },
                {
                  commission: { unwrap: () => ({ toString: () => '100000000' }) },
                  blocked: { isTrue: false },
                },
              ],
            ],
          },
          currentEra: async () => ({ toString: () => '10' }),
          erasValidatorReward: {
            entriesPaged: async () => [[{ args: [{ toString: () => '9' }] }, reward]],
          },
          erasRewardPoints: async () => ({
            total: { toString: () => '100' },
            individual: new Map([[account, point]]),
          }),
          erasStakers: {
            entriesPaged: async ({ args: [era] }: { args: [number] }) => [
              [
                { args: [era, 'validator-1'] },
                {
                  total: (1_000n * SCALE).toString(),
                  own: (100n * SCALE).toString(),
                  others: [
                    { who: { toString: () => 'nominator-1' }, value: '1' },
                    { who: { toString: () => 'nominator-2' }, value: '2' },
                  ],
                },
              ],
            ],
          },
        },
      },
    };

    const documents = await indexer.createStakingValidatorDocuments(
      12,
      1_700_000_000,
      new Map([
        [XOR, SCALE],
        [VAL, 2n * SCALE],
      ]),
      new Map([
        [XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }],
        [VAL, { id: VAL, symbol: 'VAL', name: 'VAL', decimals: 18, supply: 0n }],
      ])
    );
    const stream = indexer.createStakingValidatorsStream(documents, 12, 1_700_000_000);

    expect(documents).toHaveLength(1);
    expect(documents[0]).toEqual(
      expect.objectContaining({
        collection: 'stakingValidators',
        id: 'validator-1',
        data: expect.objectContaining({
          address: 'validator-1',
          apy: '65.7',
          commission: '100000000',
          identity: expect.objectContaining({ info: { display: 'Validator One', image: '' } }),
          isKnownGood: true,
          isOversubscribed: true,
          rewardPoints: 25,
        }),
      })
    );
    expect(JSON.parse(stream.data.data)[0].apy).toBe('65.7');
  });

  it('publishes staking validators without APY before a completed reward era exists', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      createStakingValidatorDocuments: (
        blockHeight: number,
        timestamp: number,
        prices: Map<string, bigint>,
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>
      ) => Promise<Array<{ data: Record<string, any> }>>;
    };

    indexer.api = {
      consts: { staking: { maxNominatorRewardedPerValidator: { toNumber: () => 64 } } },
      query: {
        identity: { identityOf: async () => ({ isEmpty: true }) },
        staking: {
          validators: {
            entriesPaged: async () => [
              [{ args: ['validator-1'] }, { commission: { unwrap: () => ({ toString: () => '0' }) }, blocked: { isTrue: false } }],
            ],
          },
          currentEra: async () => ({ toString: () => '10' }),
          erasValidatorReward: { entriesPaged: async () => [] },
          erasRewardPoints: async () => {
            throw new Error('staking.erasRewardPoints should not be read without a completed reward era');
          },
          erasStakers: {
            entriesPaged: async ({ args: [era] }: { args: [number] }) => [
              [
                { args: [era, 'validator-1'] },
                {
                  total: '100',
                  own: '25',
                  others: [{ who: 'nominator-1', value: '75' }],
                },
              ],
            ],
          },
        },
      },
    };

    const documents = await indexer.createStakingValidatorDocuments(
      12,
      1_700_000_000,
      new Map([
        [XOR, SCALE],
        [VAL, SCALE],
      ]),
      new Map([
        [XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }],
        [VAL, { id: VAL, symbol: 'VAL', name: 'VAL', decimals: 18, supply: 0n }],
      ])
    );

    expect(documents[0]?.data).toEqual(
      expect.objectContaining({
        address: 'validator-1',
        apy: null,
        era: null,
        rewardPoints: null,
      })
    );
  });

  it('leaves validator APY null when the reward era has no validator exposure or reward points', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      api: unknown;
      createStakingValidatorDocuments: (
        blockHeight: number,
        timestamp: number,
        prices: Map<string, bigint>,
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>
      ) => Promise<Array<{ data: Record<string, any> }>>;
    };
    const rewardPoints = new Map<object, object>();

    indexer.api = {
      consts: { staking: { maxNominatorRewardedPerValidator: { toNumber: () => 64 } } },
      query: {
        identity: { identityOf: async () => ({ isEmpty: true }) },
        staking: {
          validators: {
            entriesPaged: async () => [
              [{ args: ['validator-1'] }, { commission: { unwrap: () => ({ toString: () => '0' }) }, blocked: { isTrue: false } }],
            ],
          },
          currentEra: async () => ({ toString: () => '10' }),
          erasValidatorReward: {
            entriesPaged: async () => [[{ args: [{ toString: () => '9' }] }, { unwrap: () => ({ toString: () => '100' }) }]],
          },
          erasRewardPoints: async () => ({
            total: { toString: () => '100' },
            individual: rewardPoints,
          }),
          erasStakers: {
            entriesPaged: async ({ args: [era] }: { args: [number] }) =>
              era === 10
                ? [
                    [
                      { args: [era, 'validator-1'] },
                      {
                        total: '100',
                        own: '25',
                        others: [{ who: 'nominator-1', value: '75' }],
                      },
                    ],
                  ]
                : [
                    [
                      { args: [era, 'validator-2'] },
                      {
                        total: '200',
                        own: '50',
                        others: [{ who: 'nominator-2', value: '150' }],
                      },
                    ],
                  ],
          },
        },
      },
    };

    const documents = await indexer.createStakingValidatorDocuments(
      12,
      1_700_000_000,
      new Map([
        [XOR, SCALE],
        [VAL, SCALE],
      ]),
      new Map([
        [XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }],
        [VAL, { id: VAL, symbol: 'VAL', name: 'VAL', decimals: 18, supply: 0n }],
      ])
    );

    expect(documents[0]?.data.apy).toBeNull();

    rewardPoints.set({ toString: () => 'validator-1' }, { toString: () => '1' });
    await expect(
      indexer.createStakingValidatorDocuments(
        12,
        1_700_000_000,
        new Map([
          [XOR, SCALE],
          [VAL, SCALE],
        ]),
        new Map([
          [XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }],
          [VAL, { id: VAL, symbol: 'VAL', name: 'VAL', decimals: 18, supply: 0n }],
        ])
      )
    ).rejects.toThrow('has reward points but is missing APY exposure');
  });

  it('derives pool APY from farming reward weights and liquidity', () => {
    const poolId = `${XOR}-${KUSD}`;
    const otherPoolId = `${KUSD}-${PSWAP}`;
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      derivePoolApy: (
        pools: Array<{
          id: string;
          baseAssetId: string;
          targetAssetId: string;
          baseAssetReserves: bigint;
          targetAssetReserves: bigint;
          poolAccount: string;
          poolTokenSupply: bigint;
          liquidityUSD: string;
          priceUSD: string;
        }>,
        farmingPoolFarmers: unknown[],
        currentBlock: number,
        prices: Map<string, bigint>
      ) => Map<string, string>;
    };

    const apy = indexer.derivePoolApy(
      [
        {
          id: poolId,
          baseAssetId: XOR,
          targetAssetId: KUSD,
          baseAssetReserves: 0n,
          targetAssetReserves: 0n,
          poolAccount: '',
          poolTokenSupply: 0n,
          liquidityUSD: '9125000000',
          priceUSD: '1',
        },
        {
          id: otherPoolId,
          baseAssetId: KUSD,
          targetAssetId: PSWAP,
          baseAssetReserves: 0n,
          targetAssetReserves: 0n,
          poolAccount: 'pool-2',
          poolTokenSupply: 0n,
          liquidityUSD: '9125000000',
          priceUSD: '2',
        },
      ],
      [
        [
          { args: [''] },
          {
            toJSON: () => [{ account: 'alice', block: 100, weight: (1_000n * SCALE).toString() }],
          },
        ],
        [
          { args: ['pool-2'] },
          {
            toJSON: () => [{ account: 'bob', block: 100, weight: (1_000n * SCALE).toString() }],
          },
        ],
      ],
      100,
      new Map([[PSWAP, 2n * SCALE]])
    );

    expect(Number(apy.get(poolId))).toBeCloseTo(0.1, 8);
    expect(Number(apy.get(otherPoolId))).toBeCloseTo(0.1, 8);
  });

  it('accumulates account point metadata from indexed activity', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      prices: Map<string, bigint>;
      createAccountDocuments: (
        accounts: string[],
        latestHistoryElementId: string,
        blockHeight: number,
        timestamp: number,
        pendingPointData: Map<string, Record<string, unknown>>,
        update: { module: string; method: string; data: unknown; fee: bigint }
      ) => Promise<Array<{ collection: string; id: string; data: Record<string, unknown> }>>;
    };
    indexer.prices = new Map([[XOR, 5n * SCALE]]);

    const documents = await indexer.createAccountDocuments(['alice'], 'history-1', 10, 1000, new Map(), {
      module: 'assets',
      method: 'burn',
      data: { assetId: XOR, amount: '2', amountUSD: '10' },
      fee: SCALE,
    });
    const meta = documents.find((document) => document.collection === 'accountMeta')?.data;

    expect(meta?.xorFees).toEqual({ amount: '1', amountUSD: '5' });
    expect(meta?.xorBurned).toEqual({ amount: '2', amountUSD: '10' });
  });

  it('counts only newly indexed accounts in block network snapshots', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    await repository.upsert({
      collection: 'accountMeta',
      id: 'alice',
      blockHeight: 1,
      timestamp: 100,
      data: { id: 'alice', accountId: 'alice', createdAtBlock: 1, createdAtTimestamp: 100 },
    });

    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 42 },
                hash: { toString: () => canonicalBlockHash('block') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'alice' },
                  hash: { toString: () => '0xtransfer' },
                  method: {
                    section: 'assets',
                    method: 'transfer',
                    args: [XOR, 'bob', SCALE.toString()],
                    meta: { args: [{ name: 'assetId' }, { name: 'to' }, { name: 'amount' }] },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [eventRecord('xorFee', 'FeeWithdrawn', { amount: SCALE.toString() }, 0)],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000000000' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('block'));

    const snapshot = await repository.get('networkSnapshots', 'block-42');
    const aliceActivity = await repository.get('accountTransactions', '0xtransfer-alice');
    const bobActivity = await repository.get('accountTransactions', '0xtransfer-bob');

    expect(snapshot?.data.accounts).toBe(1);
    expect(snapshot?.data.transactions).toBe(1);
    expect(aliceActivity?.data).toMatchObject({
      accountId: 'alice',
      historyElementId: '0xtransfer',
      blockHeight: 42,
      timestamp: 1_700_000_000,
    });
    expect(bobActivity?.data).toMatchObject({
      accountId: 'bob',
      historyElementId: '0xtransfer',
      blockHeight: 42,
      timestamp: 1_700_000_000,
    });
  });

  it('aggregates Polkamarkt batch claims without inventing payouts for skipped markets', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 46 },
                hash: { toString: () => canonicalBlockHash('polkamarkt-claims-block') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'alice' },
                  hash: { toString: () => '0xpolkamarkt-claims' },
                  method: {
                    section: 'polkamarkt',
                    method: 'claim_markets',
                    args: [[1, 2, 3]],
                    meta: { args: [{ name: 'marketIds' }] },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('polkamarkt', 'MarketClaimed', { marketId: 1, trader: 'alice', payout: (2n * SCALE).toString() }, 0),
              eventRecord('polkamarkt', 'MarketClaimed', { marketId: 3, trader: 'alice', payout: (3n * SCALE).toString() }, 0),
              eventRecord('polkamarkt', 'MarketClaimsBatched', { trader: 'alice', requested: 3, claimed: 2 }, 0),
              eventRecord('xorFee', 'FeeWithdrawn', { amount: SCALE.toString() }, 0),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000002000' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('polkamarkt-claims-block'));

    const history = await repository.get('historyElements', '0xpolkamarkt-claims');
    expect(history?.data).toMatchObject({
      module: 'polkamarkt',
      method: 'claim_markets',
      dataFrom: 'alice',
      data: {
        marketId: 1,
        side: 'claim',
        claimedMarkets: 2,
        requestedMarkets: 3,
        collateralUsd: '5',
        collateralAmountUsd: '5',
      },
    });
  });

  it('indexes zero-payout Polkamarkt batch claims without inventing collateral', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 47 },
                hash: { toString: () => canonicalBlockHash('polkamarkt-zero-claim-block') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'alice' },
                  hash: { toString: () => '0xpolkamarkt-zero-claim' },
                  method: {
                    section: 'polkamarkt',
                    method: 'claim_markets',
                    args: [[1, 1, 1]],
                    meta: { args: [{ name: 'marketIds' }] },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('polkamarkt', 'MarketClaimed', { marketId: 1, trader: 'alice', payout: '0' }, 0),
              eventRecord('polkamarkt', 'MarketClaimsBatched', { trader: 'alice', requested: 3, claimed: 1 }, 0),
              eventRecord('xorFee', 'FeeWithdrawn', { amount: SCALE.toString() }, 0),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000002250' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('polkamarkt-zero-claim-block'));

    const history = await repository.get('historyElements', '0xpolkamarkt-zero-claim');
    const snapshot = await repository.get('networkSnapshots', 'block-47');
    expect(history?.data).toMatchObject({
      module: 'polkamarkt',
      method: 'claim_markets',
      dataFrom: 'alice',
      data: {
        marketId: 1,
        side: 'claim',
        claimedMarkets: 1,
        requestedMarkets: 3,
        collateralUsd: '0',
        collateralAmountUsd: '0',
      },
    });
    expect(snapshot?.data.volumeUSD).toBe('0');
  });

  it('does not synthesize batch claim activity from a bare batch summary event', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 47 },
                hash: { toString: () => canonicalBlockHash('polkamarkt-bare-claims-block') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'mallory' },
                  hash: { toString: () => '0xpolkamarkt-bare-claims' },
                  method: {
                    section: 'polkamarkt',
                    method: 'claim_markets',
                    args: [[1, 2]],
                    meta: { args: [{ name: 'marketIds' }] },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('polkamarkt', 'MarketClaimsBatched', { trader: 'mallory', requested: 2, claimed: 0 }, 0),
              eventRecord('xorFee', 'FeeWithdrawn', { amount: SCALE.toString() }, 0),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000002500' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('polkamarkt-bare-claims-block'));

    const history = await repository.get('historyElements', '0xpolkamarkt-bare-claims');
    expect(history?.data.data).toMatchObject({ marketIds: [1, 2] });
    expect(history?.data.data).not.toMatchObject({ side: 'claim' });
    expect(history?.data.data).not.toHaveProperty('claimedMarkets');
    expect(history?.data.data).not.toHaveProperty('collateralUsd');
  });

  it('does not attribute batch claim payouts when claim and batch traders disagree', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 49 },
                hash: { toString: () => canonicalBlockHash('polkamarkt-mismatched-claims-block') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'alice' },
                  hash: { toString: () => '0xpolkamarkt-mismatched-claims' },
                  method: {
                    section: 'polkamarkt',
                    method: 'claim_markets',
                    args: [[1, 2]],
                    meta: { args: [{ name: 'marketIds' }] },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('polkamarkt', 'MarketClaimed', { marketId: 1, trader: 'bob', payout: (2n * SCALE).toString() }, 0),
              eventRecord('polkamarkt', 'MarketClaimsBatched', { trader: 'alice', requested: 2, claimed: 1 }, 0),
              eventRecord('xorFee', 'FeeWithdrawn', { amount: SCALE.toString() }, 0),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000002600' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('polkamarkt-mismatched-claims-block'));

    const history = await repository.get('historyElements', '0xpolkamarkt-mismatched-claims');
    const bobActivity = await repository.get('accountTransactions', '0xpolkamarkt-mismatched-claims-bob');
    expect(history?.data.data).toMatchObject({ marketIds: [1, 2] });
    expect(history?.data.data).not.toMatchObject({ side: 'claim' });
    expect(history?.data.data).not.toHaveProperty('claimedMarkets');
    expect(history?.data.data).not.toHaveProperty('collateralUsd');
    expect(bobActivity).toBeNull();
  });

  it('does not synthesize DPM activity from removed creator-liquidity claims', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 50 },
                hash: { toString: () => canonicalBlockHash('polkamarkt-creator-liquidity-block') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'creator' },
                  hash: { toString: () => '0xpolkamarkt-creator-liquidity' },
                  method: {
                    section: 'polkamarkt',
                    method: 'claim_creator_liquidity',
                    args: [7],
                    meta: { args: [{ name: 'marketId' }] },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('polkamarkt', 'CreatorLiquidityClaimed', { marketId: 7, creator: 'creator', amount: SCALE.toString() }, 0),
              eventRecord('xorFee', 'FeeWithdrawn', { amount: SCALE.toString() }, 0),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000002700' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('polkamarkt-creator-liquidity-block'));

    const history = await repository.get('historyElements', '0xpolkamarkt-creator-liquidity');
    expect(history?.data.data).toMatchObject({ marketId: 7 });
    expect(history?.data.data).not.toMatchObject({ side: 'claim_creator_liquidity' });
    expect(history?.data.data).not.toHaveProperty('collateralUsd');
    expect(history?.data.data).not.toHaveProperty('collateralAmountUsd');
  });

  it('counts only signed fee-paying extrinsics as block network transactions', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 43 },
                hash: { toString: () => canonicalBlockHash('block-transactions') },
              },
              extrinsics: [
                {
                  isSigned: false,
                  hash: { toString: () => '0xtimestamp' },
                  method: {
                    section: 'timestamp',
                    method: 'set',
                    args: ['1700000000000'],
                    meta: { args: [{ name: 'now' }] },
                  },
                },
                {
                  isSigned: true,
                  signer: { toString: () => 'alice' },
                  hash: { toString: () => '0xfee-transfer' },
                  method: {
                    section: 'assets',
                    method: 'transfer',
                    args: [XOR, 'bob', SCALE.toString()],
                    meta: { args: [{ name: 'assetId' }, { name: 'to' }, { name: 'amount' }] },
                  },
                },
                {
                  isSigned: true,
                  signer: { toString: () => 'carol' },
                  hash: { toString: () => '0xfree-remark' },
                  method: {
                    section: 'system',
                    method: 'remark',
                    args: ['0x00'],
                    meta: { args: [{ name: 'remark' }] },
                  },
                },
                {
                  isSigned: false,
                  hash: { toString: () => '0xunsigned-fee-event' },
                  method: {
                    section: 'system',
                    method: 'remark',
                    args: ['0x01'],
                    meta: { args: [{ name: 'remark' }] },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('xorFee', 'FeeWithdrawn', { amount: SCALE.toString() }, 1),
              eventRecord('xorFee', 'FeeWithdrawn', { amount: SCALE.toString() }, 3),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000000000' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('block-transactions'));

    const snapshot = await repository.get('networkSnapshots', 'block-43');

    expect(snapshot?.data.transactions).toBe(1);
    expect(snapshot?.data.fees).toBe((2n * SCALE).toString());
  });

  it('does not count failed swaps as business volume while still counting the paid transaction fee', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 60 },
                hash: { toString: () => canonicalBlockHash('failed-swap-block') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'alice' },
                  hash: { toString: () => '0xfailed-swap' },
                  method: {
                    section: 'liquidityProxy',
                    method: 'swap',
                    args: [
                      0,
                      XOR,
                      KUSD,
                      { WithDesiredInput: { desiredAmountIn: (5n * SCALE).toString(), minAmountOut: '0' } },
                      'PoolXYK',
                      'Disabled',
                    ],
                    meta: {
                      args: [
                        { name: 'dexId' },
                        { name: 'inputAssetId' },
                        { name: 'outputAssetId' },
                        { name: 'swapAmount' },
                        { name: 'selectedSourceType' },
                        { name: 'filterMode' },
                      ],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('xorFee', 'FeeWithdrawn', { amount: SCALE.toString() }),
              eventRecord('system', 'ExtrinsicFailed', {}),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000000000' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('failed-swap-block'));

    const snapshot = await repository.get('networkSnapshots', 'block-60');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(snapshot?.data.transactions).toBe(1);
    expect(snapshot?.data.swaps).toBe(0);
    expect(snapshot?.data.volumeUSD).toBe('0');
    expect(snapshot?.data.fees).toBe(SCALE.toString());
    expect(accountMeta?.data.xorFees).toEqual({ amount: '1', amountUSD: '2' });
  });

  it('does not count failed bridge burns as outgoing bridge volume or deposits', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 61 },
                hash: { toString: () => canonicalBlockHash('failed-bridge-block') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'alice' },
                  hash: { toString: () => '0xfailed-bridge-burn' },
                  method: {
                    section: 'bridgeProxy',
                    method: 'burn',
                    args: [{ EVM: '0x6f' }, XOR, { EVM: '0xrecipient' }, (5n * SCALE).toString()],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'assetId' }, { name: 'recipient' }, { name: 'amount' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('xorFee', 'FeeWithdrawn', { amount: SCALE.toString() }),
              eventRecord('system', 'ExtrinsicFailed', {}),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000000000' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('failed-bridge-block'));

    const snapshot = await repository.get('networkSnapshots', 'block-61');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(snapshot?.data.transactions).toBe(1);
    expect(snapshot?.data.bridgeOutgoingTransactions).toBe(0);
    expect(snapshot?.data.volumeUSD).toBe('0');
    expect(accountMeta?.data.deposit).toEqual({ incomingUSD: '0', outgoingUSD: '0' });
    expect(accountMeta?.data.xorFees).toEqual({ amount: '1', amountUSD: '2' });
  });

  it('indexes utility batch burn calls for burn page stats', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      indexBlockByHash: (hash: string) => Promise<void>;
    };
    const blockTimestampMs = 1_700_000_000_000;
    const burnCall = {
      section: 'assets',
      method: 'burn',
      args: [XOR, '10000000000000000000'],
      meta: { args: [{ name: 'assetId' }, { name: 'amount' }] },
    };
    const remarkCall = {
      section: 'system',
      method: 'remark',
      args: ['0x7b7d'],
      meta: { args: [{ name: 'remark' }] },
    };

    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 25_900_001 },
                hash: { toString: () => canonicalBlockHash('block') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'alice' },
                  hash: { toString: () => '0xbatchburn' },
                  method: {
                    section: 'utility',
                    method: 'batchAll',
                    args: [[burnCall, remarkCall]],
                    meta: { args: [{ name: 'calls' }] },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => String(blockTimestampMs) }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('block'));

    const history = await repository.get('historyElements', '0xbatchburn');
    const xorBurn = await repository.get('xorBurns', '0xbatchburn');
    const chainState = await repository.get('updatesStreams', 'chainState');

    expect(history?.data).toMatchObject({
      module: 'utility',
      method: 'batchAll',
      address: 'alice',
      blockHeight: 25_900_001,
      timestamp: 1_700_000_000,
      callNames: ['assets.burn', 'system.remark'],
      calls: [
        {
          module: 'assets',
          method: 'burn',
          data: { args: { assetId: XOR, amount: '10000000000000000000' } },
        },
        {
          module: 'system',
          method: 'remark',
          data: { args: { remark: '0x7b7d' } },
        },
      ],
    });
    expect(xorBurn?.data).toMatchObject({
      id: '0xbatchburn',
      address: 'alice',
      amount: '10',
      assetId: XOR,
      blockHeight: 25_900_001,
      timestamp: 1_700_000_000,
      txHash: '0xbatchburn',
    });
    expect(chainState?.data).toMatchObject({
      id: 'chainState',
      block: 25_900_001,
      data: JSON.stringify({
        lastIndexedBlock: 25_900_001,
        genesisHash: SORA_MAINNET_GENESIS_HASH,
        blockHash: canonicalBlockHash('block'),
        blockTimestamp: 1_700_000_000,
      }),
    });
  });

  it('indexes bridgeProxy burn history with request metadata for EVM outgoing restores', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 42 },
                hash: { toString: () => canonicalBlockHash('bridgeblock') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'alice' },
                  hash: { toString: () => '0xevmburn' },
                  method: {
                    section: 'bridgeProxy',
                    method: 'burn',
                    args: [{ EVM: '0x6f' }, XOR, { EVM: '0xrecipient' }, (5n * SCALE).toString()],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'assetId' }, { name: 'recipient' }, { name: 'amount' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest', status: 'Done' })],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000000000' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('bridgeblock'));

    const history = await repository.get('historyElements', '0xevmburn');
    const snapshot = await repository.get('networkSnapshots', 'block-42');
    const accountMeta = await repository.get('accountMeta', 'alice');
    const aliceActivity = await repository.get('accountTransactions', '0xevmburn-alice');
    const externalActivity = await repository.get('accountTransactions', '0xevmburn-0xrecipient');

    expect(history?.data).toMatchObject({
      module: 'bridgeProxy',
      method: 'burn',
      address: 'alice',
      dataFrom: 'alice',
      dataTo: '0xrecipient',
      data: {
        assetId: XOR,
        amount: '5',
        amountUSD: '10',
        networkId: '0x6f',
        recipient: '0xrecipient',
        requestHash: '0xrequest',
        status: 'Done',
      },
    });
    expect(snapshot?.data.bridgeOutgoingTransactions).toBe(1);
    expect(accountMeta?.data.deposit).toEqual({ incomingUSD: '0', outgoingUSD: '10' });
    expect(aliceActivity?.data).toMatchObject({ accountId: 'alice', historyElementId: '0xevmburn' });
    expect(externalActivity).toBeNull();
  });

  it('indexes bridgeProxy burn history for outgoing Liberland bridge transfers without treating the external account as local', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 45 },
                hash: { toString: () => canonicalBlockHash('liberlandoutblock') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'alice' },
                  hash: { toString: () => '0xliberlandout' },
                  method: {
                    section: 'bridgeProxy',
                    method: 'burn',
                    args: [{ Sub: 'Liberland' }, XOR, { Liberland: LIBERLAND_ACCOUNT }, (7n * SCALE).toString()],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'assetId' }, { name: 'recipient' }, { name: 'amount' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xliberlandrequest', status: 'Done' }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000002000' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('liberlandoutblock'));

    const history = await repository.get('historyElements', '0xliberlandout');
    const snapshot = await repository.get('networkSnapshots', 'block-45');
    const accountMeta = await repository.get('accountMeta', 'alice');
    const aliceActivity = await repository.get('accountTransactions', '0xliberlandout-alice');
    const externalActivity = await repository.get('accountTransactions', `0xliberlandout-${LIBERLAND_ACCOUNT}`);

    expect(history?.data).toMatchObject({
      module: 'bridgeProxy',
      method: 'burn',
      address: 'alice',
      dataFrom: 'alice',
      dataTo: LIBERLAND_ACCOUNT,
      data: {
        assetId: XOR,
        amount: '7',
        amountUSD: '14',
        networkId: 'Liberland',
        externalNetwork: 'Liberland',
        externalNetworkType: 'Sub',
        recipient: LIBERLAND_ACCOUNT,
        requestHash: '0xliberlandrequest',
        status: 'Done',
      },
    });
    expect(snapshot?.data.bridgeOutgoingTransactions).toBe(1);
    expect(accountMeta?.data.deposit).toEqual({ incomingUSD: '0', outgoingUSD: '14' });
    expect(aliceActivity?.data).toMatchObject({ accountId: 'alice', historyElementId: '0xliberlandout' });
    expect(externalActivity).toBeNull();
  });

  it('indexes liquidityProxy swap history from the actual Exchange event amounts', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([
      [XOR, 3n * SCALE],
      [KUSD, SCALE],
    ]);
    indexer.assetInfos = new Map([
      [XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }],
      [KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18, supply: 0n }],
    ]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 44 },
                hash: { toString: () => canonicalBlockHash('swapblock') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'alice' },
                  hash: { toString: () => '0xswap' },
                  method: {
                    section: 'liquidityProxy',
                    method: 'swap',
                    args: [
                      0,
                      XOR,
                      KUSD,
                      {
                        WithDesiredInput: {
                          desiredAmountIn: '0',
                          minAmountOut: '0',
                        },
                      },
                      'PoolXYK',
                      'Disabled',
                    ],
                    meta: {
                      args: [
                        { name: 'dexId' },
                        { name: 'inputAssetId' },
                        { name: 'outputAssetId' },
                        { name: 'swapAmount' },
                        { name: 'selectedSourceType' },
                        { name: 'filterMode' },
                      ],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('liquidityProxy', 'Exchange', {
                arg0: 'alice',
                arg1: 0,
                arg2: XOR,
                arg3: KUSD,
                arg4: (5n * SCALE).toString(),
                arg5: ((499n * SCALE) / 100n).toString(),
                arg6: '0',
              }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000000000' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('swapblock'));

    const history = await repository.get('historyElements', '0xswap');
    const snapshot = await repository.get('networkSnapshots', 'block-44');

    expect(history?.data).toMatchObject({
      module: 'liquidityProxy',
      method: 'swap',
      address: 'alice',
      dataFrom: 'alice',
      data: {
        baseAssetId: XOR,
        targetAssetId: KUSD,
        selectedMarket: 'PoolXYK',
        baseAssetAmount: '5',
        targetAssetAmount: '4.99',
        baseAssetAmountUSD: '15',
        targetAssetAmountUSD: '4.99',
      },
    });
    expect(snapshot?.data.swaps).toBe(1);
    expect(snapshot?.data.volumeUSD).toBe('15');
  });

  it('indexes bridgeMultisig asset movements by recipient for ETH incoming restores', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 43 },
                hash: { toString: () => canonicalBlockHash('ethincomingblock') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'bridge-peer' },
                  hash: { toString: () => '0xethincoming' },
                  method: {
                    section: 'bridgeMultisig',
                    method: 'asMulti',
                    args: [{ toHex: () => '0ximportincomingrequest', toJSON: () => ({ call: 'expanded' }) }],
                    meta: { args: [{ name: 'call' }] },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: (4n * SCALE).toString() }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000000500' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('ethincomingblock'));

    const history = await repository.get('historyElements', '0xethincoming');
    const accountMeta = await repository.get('accountMeta', 'alice');
    const aliceActivity = await repository.get('accountTransactions', '0xethincoming-alice');
    const bridgeSignerActivity = await repository.get('accountTransactions', '0xethincoming-bridge-peer');

    expect(history?.data).toMatchObject({
      module: 'bridgeMultisig',
      method: 'asMulti',
      address: 'bridge-peer',
      dataFrom: 'bridge-peer',
      dataTo: 'alice',
      dataAssets: [XOR],
      data: {
        amount: '4',
        amountUSD: '8',
        assetId: XOR,
        call: '0ximportincomingrequest',
        to: 'alice',
      },
    });
    expect(accountMeta?.data.deposit).toEqual({ incomingUSD: '8', outgoingUSD: '0' });
    expect(aliceActivity?.data).toMatchObject({ accountId: 'alice', historyElementId: '0xethincoming' });
    expect(bridgeSignerActivity).toBeNull();
  });

  it('indexes bridgeProxy request events as mint history for EVM incoming restores', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 43 },
                hash: { toString: () => canonicalBlockHash('inboundblock') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinboundsubmit' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0x6f' },
                      {
                        source: { EVM: '0xsender' },
                        dest: { Sora: 'alice' },
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xinboundrequest', status: 'Done' }),
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: (3n * SCALE).toString() }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000001000' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('inboundblock'));

    const original = await repository.get('historyElements', '0xinboundsubmit');
    const history = await repository.get('historyElements', '0xinboundrequest-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-43');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(original?.data).toMatchObject({
      module: 'bridgeChannelInbound',
      method: 'submit',
      address: 'relayer',
    });
    expect(history?.data).toMatchObject({
      module: 'bridgeProxy',
      method: 'mint',
      address: 'relayer',
      dataFrom: 'alice',
      dataTo: '0xsender',
      data: {
        assetId: XOR,
        amount: '3',
        amountUSD: '6',
        networkId: '0x6f',
        recipient: 'alice',
        sender: '0xsender',
        requestHash: '0xinboundrequest',
        status: 'Done',
      },
    });
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(1);
    expect(accountMeta?.data.deposit).toEqual({ incomingUSD: '6', outgoingUSD: '0' });
  });

  it('indexes bridgeProxy request events as mint history for incoming Liberland bridge transfers', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 46 },
                hash: { toString: () => canonicalBlockHash('liberlandinblock') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xliberlandinboundsubmit' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { Sub: 'Liberland' },
                      {
                        source: { Liberland: LIBERLAND_ACCOUNT },
                        dest: { Sora: 'alice' },
                        assetId: XOR,
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xliberlandinrequest', status: 'Done' }),
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: (4n * SCALE).toString() }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000003000' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('liberlandinblock'));

    const original = await repository.get('historyElements', '0xliberlandinboundsubmit');
    const history = await repository.get('historyElements', '0xliberlandinrequest-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-46');
    const accountMeta = await repository.get('accountMeta', 'alice');
    const aliceActivity = await repository.get('accountTransactions', '0xliberlandinrequest-mint-alice');
    const externalActivity = await repository.get('accountTransactions', `0xliberlandinrequest-mint-${LIBERLAND_ACCOUNT}`);

    expect(original?.data).toMatchObject({
      module: 'bridgeChannelInbound',
      method: 'submit',
      address: 'relayer',
    });
    expect(history?.data).toMatchObject({
      module: 'bridgeProxy',
      method: 'mint',
      address: 'relayer',
      dataFrom: 'alice',
      dataTo: LIBERLAND_ACCOUNT,
      data: {
        assetId: XOR,
        amount: '4',
        amountUSD: '8',
        networkId: 'Liberland',
        externalNetwork: 'Liberland',
        externalNetworkType: 'Sub',
        recipient: 'alice',
        sender: LIBERLAND_ACCOUNT,
        requestHash: '0xliberlandinrequest',
        status: 'Done',
      },
    });
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(1);
    expect(accountMeta?.data.deposit).toEqual({ incomingUSD: '8', outgoingUSD: '0' });
    expect(aliceActivity?.data).toMatchObject({ accountId: 'alice', historyElementId: '0xliberlandinrequest-mint' });
    expect(externalActivity).toBeNull();
  });

  it('does not synthesize EVM incoming bridge history without a request hash event', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 44 },
                hash: { toString: () => canonicalBlockHash('inbound-no-request-block') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-no-request' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0x6f' },
                      {
                        source: { EVM: '0xsender' },
                        dest: { Sora: 'alice' },
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: SCALE.toString() })],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000002000' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('inbound-no-request-block'));

    const original = await repository.get('historyElements', '0xinbound-no-request');
    const accidentalSynthetic = await repository.get('historyElements', '-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-44');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(original?.data).toMatchObject({
      module: 'bridgeChannelInbound',
      method: 'submit',
      address: 'relayer',
    });
    expect(accidentalSynthetic).toBeNull();
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(0);
    expect(accountMeta).toBeNull();
  });

  it('does not synthesize EVM incoming bridge history when the request has no asset movement', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 45 },
                hash: { toString: () => canonicalBlockHash('inbound-no-asset-block') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-no-asset' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0x6f' },
                      {
                        source: { EVM: '0xsender' },
                        dest: { Sora: 'alice' },
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest-no-asset', status: 'Done' }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000003000' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('inbound-no-asset-block'));

    const synthetic = await repository.get('historyElements', '0xrequest-no-asset-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-45');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(synthetic).toBeNull();
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(0);
    expect(accountMeta).toBeNull();
  });

  it('does not synthesize EVM incoming bridge history for invalid asset movement amounts', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 46 },
                hash: { toString: () => canonicalBlockHash('inbound-invalid-amount-block') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-invalid-amount' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0x6f' },
                      {
                        source: { EVM: '0xsender' },
                        dest: { Sora: 'alice' },
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest-invalid-amount', status: 'Done' }),
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: 'not-a-number' }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000003500' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('inbound-invalid-amount-block'));

    const synthetic = await repository.get('historyElements', '0xrequest-invalid-amount-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-46');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(synthetic).toBeNull();
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(0);
    expect(accountMeta).toBeNull();
  });

  it('does not synthesize EVM incoming bridge history for zero asset movement amounts', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 47 },
                hash: { toString: () => canonicalBlockHash('inbound-zero-amount-block') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-zero-amount' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0x6f' },
                      {
                        source: { EVM: '0xsender' },
                        dest: { Sora: 'alice' },
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest-zero-amount', status: 'Done' }),
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: '0' }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000003600' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('inbound-zero-amount-block'));

    const synthetic = await repository.get('historyElements', '0xrequest-zero-amount-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-47');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(synthetic).toBeNull();
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(0);
    expect(accountMeta).toBeNull();
  });

  it('does not synthesize EVM incoming bridge history for failed inbound extrinsics', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 48 },
                hash: { toString: () => canonicalBlockHash('inbound-failed-block') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-failed' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0x6f' },
                      {
                        source: { EVM: '0xsender' },
                        dest: { Sora: 'alice' },
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('system', 'ExtrinsicFailed', { dispatchError: { module: { index: 1, error: '0x00' } } }),
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest-failed', status: 'Done' }),
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: SCALE.toString() }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000003700' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('inbound-failed-block'));

    const original = await repository.get('historyElements', '0xinbound-failed');
    const synthetic = await repository.get('historyElements', '0xrequest-failed-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-48');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect((original?.data.execution as { success: boolean }).success).toBe(false);
    expect(synthetic).toBeNull();
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(0);
    expect(accountMeta).toBeNull();
  });

  it('does not synthesize EVM incoming bridge history without an inbound recipient', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 53 },
                hash: { toString: () => canonicalBlockHash('inbound-missing-recipient-block') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-missing-recipient' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0x6f' },
                      {
                        source: { EVM: '0xsender' },
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest-missing-recipient', status: 'Done' }),
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: SCALE.toString() }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000004100' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('inbound-missing-recipient-block'));

    const synthetic = await repository.get('historyElements', '0xrequest-missing-recipient-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-53');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(synthetic).toBeNull();
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(0);
    expect(accountMeta).toBeNull();
  });

  it('does not synthesize EVM incoming bridge history without an external sender', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 54 },
                hash: { toString: () => canonicalBlockHash('inbound-missing-sender-block') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-missing-sender' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0x6f' },
                      {
                        dest: { Sora: 'alice' },
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest-missing-sender', status: 'Done' }),
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: SCALE.toString() }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000004200' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('inbound-missing-sender-block'));

    const synthetic = await repository.get('historyElements', '0xrequest-missing-sender-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-54');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(synthetic).toBeNull();
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(0);
    expect(accountMeta).toBeNull();
  });

  it('does not synthesize EVM incoming bridge history without a network id', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 55 },
                hash: { toString: () => canonicalBlockHash('inbound-missing-network-block') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-missing-network' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      {
                        source: { EVM: '0xsender' },
                        dest: { Sora: 'alice' },
                      },
                    ],
                    meta: {
                      args: [{ name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest-missing-network', status: 'Done' }),
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: SCALE.toString() }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000004300' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('inbound-missing-network-block'));

    const synthetic = await repository.get('historyElements', '0xrequest-missing-network-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-55');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(synthetic).toBeNull();
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(0);
    expect(accountMeta).toBeNull();
  });

  it('does not synthesize EVM incoming bridge history with a malformed network id', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 56 },
                hash: { toString: () => canonicalBlockHash('inbound-malformed-network-block') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-malformed-network' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0xnot-hex' },
                      {
                        source: { EVM: '0xsender' },
                        dest: { Sora: 'alice' },
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest-malformed-network', status: 'Done' }),
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: SCALE.toString() }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000004400' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('inbound-malformed-network-block'));

    const synthetic = await repository.get('historyElements', '0xrequest-malformed-network-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-56');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(synthetic).toBeNull();
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(0);
    expect(accountMeta).toBeNull();
  });

  it('does not synthesize EVM incoming bridge history for non-completed request statuses', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 57 },
                hash: { toString: () => canonicalBlockHash('inbound-pending-status-block') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-pending-status' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0x6f' },
                      {
                        source: { EVM: '0xsender' },
                        dest: { Sora: 'alice' },
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest-pending-status', status: 'Pending' }),
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: SCALE.toString() }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000004500' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('inbound-pending-status-block'));

    const synthetic = await repository.get('historyElements', '0xrequest-pending-status-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-57');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(synthetic).toBeNull();
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(0);
    expect(accountMeta).toBeNull();
  });

  it('ignores asset movement events for a different recipient when synthesizing incoming bridge history', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 50 },
                hash: { toString: () => canonicalBlockHash('inbound-recipient-filter-block') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-recipient-filter' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0x6f' },
                      {
                        source: { EVM: '0xsender' },
                        dest: { Sora: 'alice' },
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest-recipient-filter', status: 'Done' }),
              eventRecord('assets', 'Transfer', {
                assetId: XOR,
                from: 'bob',
                to: 'mallory',
                amount: (5n * SCALE).toString(),
              }),
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: (3n * SCALE).toString() }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000003800' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('inbound-recipient-filter-block'));

    const synthetic = await repository.get('historyElements', '0xrequest-recipient-filter-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-50');
    const aliceMeta = await repository.get('accountMeta', 'alice');
    const malloryMeta = await repository.get('accountMeta', 'mallory');

    expect(synthetic?.data).toMatchObject({
      module: 'bridgeProxy',
      method: 'mint',
      dataFrom: 'alice',
      dataTo: '0xsender',
      data: {
        amount: '3',
        amountUSD: '6',
        recipient: 'alice',
      },
    });
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(1);
    expect(aliceMeta?.data.deposit).toEqual({ incomingUSD: '6', outgoingUSD: '0' });
    expect(malloryMeta).toBeNull();
  });

  it('does not synthesize EVM incoming bridge history when message asset and movement asset differ', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([
      [XOR, 2n * SCALE],
      [PSWAP, SCALE],
    ]);
    indexer.assetInfos = new Map([
      [XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }],
      [PSWAP, { id: PSWAP, symbol: 'PSWAP', name: 'PSWAP', decimals: 18, supply: 0n }],
    ]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 58 },
                hash: { toString: () => canonicalBlockHash('inbound-asset-mismatch-block') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-asset-mismatch' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0x6f' },
                      {
                        source: { EVM: '0xsender' },
                        dest: { Sora: 'alice' },
                        assetId: XOR,
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest-asset-mismatch', status: 'Done' }),
              eventRecord('assets', 'Issued', { assetId: PSWAP, owner: 'alice', amount: (5n * SCALE).toString() }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000004600' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('inbound-asset-mismatch-block'));

    const synthetic = await repository.get('historyElements', '0xrequest-asset-mismatch-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-58');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(synthetic).toBeNull();
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(0);
    expect(accountMeta).toBeNull();
  });

  it('ignores wrong asset movement and uses the later matching asset for incoming bridge history', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([
      [XOR, 2n * SCALE],
      [PSWAP, SCALE],
    ]);
    indexer.assetInfos = new Map([
      [XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }],
      [PSWAP, { id: PSWAP, symbol: 'PSWAP', name: 'PSWAP', decimals: 18, supply: 0n }],
    ]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 59 },
                hash: { toString: () => canonicalBlockHash('inbound-asset-filter-block') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-asset-filter' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0x6f' },
                      {
                        source: { EVM: '0xsender' },
                        dest: { Sora: 'alice' },
                        assetId: XOR,
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest-asset-filter', status: 'Done' }),
              eventRecord('assets', 'Issued', { assetId: PSWAP, owner: 'alice', amount: (5n * SCALE).toString() }),
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: (3n * SCALE).toString() }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000004700' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('inbound-asset-filter-block'));

    const synthetic = await repository.get('historyElements', '0xrequest-asset-filter-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-59');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(synthetic?.data).toMatchObject({
      module: 'bridgeProxy',
      method: 'mint',
      dataFrom: 'alice',
      dataTo: '0xsender',
      data: {
        assetId: XOR,
        amount: '3',
        amountUSD: '6',
        recipient: 'alice',
      },
    });
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(1);
    expect(accountMeta?.data.deposit).toEqual({ incomingUSD: '6', outgoingUSD: '0' });
  });

  it('does not synthesize EVM incoming bridge history for failed bridge request statuses', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 51 },
                hash: { toString: () => canonicalBlockHash('inbound-failed-status-block') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-failed-status' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0x6f' },
                      {
                        source: { EVM: '0xsender' },
                        dest: { Sora: 'alice' },
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest-failed-status', status: 'Failed' }),
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: SCALE.toString() }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000003900' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('inbound-failed-status-block'));

    const synthetic = await repository.get('historyElements', '0xrequest-failed-status-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-51');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(synthetic).toBeNull();
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(0);
    expect(accountMeta).toBeNull();
  });

  it('does not synthesize EVM incoming bridge history from events attached to another extrinsic', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 52 },
                hash: { toString: () => canonicalBlockHash('inbound-wrong-phase-block') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'relayer' },
                  hash: { toString: () => '0xinbound-wrong-phase' },
                  method: {
                    section: 'bridgeChannelInbound',
                    method: 'submit',
                    args: [
                      { EVM: '0x6f' },
                      {
                        source: { EVM: '0xsender' },
                        dest: { Sora: 'alice' },
                      },
                    ],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'message' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xrequest-wrong-phase', status: 'Done' }, 1),
              eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: SCALE.toString() }, 1),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000004000' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('inbound-wrong-phase-block'));

    const original = await repository.get('historyElements', '0xinbound-wrong-phase');
    const synthetic = await repository.get('historyElements', '0xrequest-wrong-phase-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-52');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(original?.data).toMatchObject({
      module: 'bridgeChannelInbound',
      method: 'submit',
    });
    expect(synthetic).toBeNull();
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(0);
    expect(accountMeta).toBeNull();
  });

  it('does not duplicate outgoing bridgeProxy burns as synthetic incoming history', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 49 },
                hash: { toString: () => canonicalBlockHash('evmburn-no-duplicate-block') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'alice' },
                  hash: { toString: () => '0xevmburn-no-duplicate' },
                  method: {
                    section: 'bridgeProxy',
                    method: 'burn',
                    args: [{ EVM: '0x6f' }, XOR, { EVM: '0xrecipient' }, (2n * SCALE).toString()],
                    meta: {
                      args: [{ name: 'networkId' }, { name: 'assetId' }, { name: 'recipient' }, { name: 'amount' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xburn-request', status: 'Done' }),
              eventRecord('assets', 'Transfer', {
                assetId: XOR,
                from: 'alice',
                to: 'bridge-account',
                amount: (2n * SCALE).toString(),
              }),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000004000' }),
          },
        },
      },
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('evmburn-no-duplicate-block'));

    const outgoing = await repository.get('historyElements', '0xevmburn-no-duplicate');
    const synthetic = await repository.get('historyElements', '0xburn-request-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-49');
    const accountMeta = await repository.get('accountMeta', 'alice');

    expect(outgoing?.data).toMatchObject({
      module: 'bridgeProxy',
      method: 'burn',
      data: {
        requestHash: '0xburn-request',
      },
    });
    expect(synthetic).toBeNull();
    expect(snapshot?.data.bridgeOutgoingTransactions).toBe(1);
    expect(snapshot?.data.bridgeIncomingTransactions).toBe(0);
    expect(accountMeta?.data.deposit).toEqual({ incomingUSD: '0', outgoingUSD: '4' });
  });









  it('backfills account transaction rows from legacy history without external hex addresses', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      backfillAccountTransactions: () => Promise<boolean>;
    };

    await repository.upsertMany([
      {
        collection: 'historyElements',
        id: 'legacy-a',
        blockHeight: 1,
        timestamp: 100,
        data: {
          id: 'legacy-a',
          blockHeight: 1,
          timestamp: 100,
          address: 'alice',
          dataFrom: 'alice',
          dataTo: '0xrecipient',
        },
      },
      {
        collection: 'historyElements',
        id: 'legacy-b',
        blockHeight: 2,
        timestamp: 200,
        data: {
          id: 'legacy-b',
          blockHeight: 2,
          timestamp: 200,
          address: '0xbridgepeer',
          dataFrom: '0xsender',
          dataTo: 'bob',
        },
      },
      {
        collection: 'historyElements',
        id: 'legacy-c',
        blockHeight: 0,
        timestamp: 0,
        data: {
          id: 'legacy-c',
          blockHeight: 0,
          timestamp: 0,
          address: ' alice ',
          dataFrom: 'not an account',
          dataTo: '',
        },
      },
    ]);

    await expect(indexer.backfillAccountTransactions()).resolves.toBe(true);

    const aliceActivity = await repository.get('accountTransactions', 'legacy-a-alice');
    const bobActivity = await repository.get('accountTransactions', 'legacy-b-bob');
    const duplicateAliceActivity = await repository.get('accountTransactions', 'legacy-c-alice');
    const externalRecipient = await repository.get('accountTransactions', 'legacy-a-0xrecipient');
    const externalSender = await repository.get('accountTransactions', 'legacy-b-0xsender');
    const malformedText = (await repository.list('accountTransactions')).find(
      (document) => document.data.accountId === 'not an account'
    );
    const objectCoercion = await repository.get('accountTransactions', 'legacy-c-carol');
    const backfillState = await repository.get('updatesStreams', 'accountTransactionsBackfill-v1');

    expect(aliceActivity?.data).toMatchObject({ accountId: 'alice', historyElementId: 'legacy-a', timestamp: 100 });
    expect(bobActivity?.data).toMatchObject({ accountId: 'bob', historyElementId: 'legacy-b', timestamp: 200 });
    expect(duplicateAliceActivity?.data).toMatchObject({ accountId: 'alice', historyElementId: 'legacy-c', timestamp: 0 });
    expect(externalRecipient).toBeNull();
    expect(externalSender).toBeNull();
    expect(malformedText).toBeUndefined();
    expect(objectCoercion).toBeNull();
    expect(backfillState?.data).toMatchObject({
      id: 'accountTransactionsBackfill-v1',
      block: 2,
      data: JSON.stringify({ processedDocuments: 3, writtenDocuments: 3, lastIndexedBlock: 2, lastTimestamp: 200 }),
    });
    await expect(indexer.backfillAccountTransactions()).resolves.toBe(false);
    await expect(repository.list('accountTransactions')).resolves.toHaveLength(3);
  });

  it('does not trust a corrupt account transaction backfill marker', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      backfillAccountTransactions: () => Promise<boolean>;
    };

    await repository.upsertMany([
      {
        collection: 'updatesStreams',
        id: 'accountTransactionsBackfill-v1',
        data: { id: 'accountTransactionsBackfill-v1', data: 'not-json' },
      },
      {
        collection: 'historyElements',
        id: 'legacy-corrupt-state',
        blockHeight: 9,
        timestamp: 900,
        data: { id: 'legacy-corrupt-state', blockHeight: 9, timestamp: 900, address: 'bob' },
      },
    ]);

    await expect(indexer.backfillAccountTransactions()).resolves.toBe(true);

    expect(await repository.get('accountTransactions', 'legacy-corrupt-state-bob')).not.toBeNull();
    expect((await repository.get('updatesStreams', 'accountTransactionsBackfill-v1'))?.data.data).toBe(
      JSON.stringify({ processedDocuments: 1, writtenDocuments: 1, lastIndexedBlock: 9, lastTimestamp: 900 })
    );
  });

  it('does not trust structurally invalid account transaction backfill markers', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      backfillAccountTransactions: () => Promise<boolean>;
    };

    await repository.upsertMany([
      {
        collection: 'updatesStreams',
        id: 'accountTransactionsBackfill-v1',
        data: {
          id: 'accountTransactionsBackfill-v1',
          data: JSON.stringify({
            processedDocuments: '1',
            writtenDocuments: 1,
            lastIndexedBlock: -1,
            lastTimestamp: 900,
          }),
        },
      },
      {
        collection: 'historyElements',
        id: 'legacy-invalid-state-shape',
        blockHeight: 10,
        timestamp: 1_000,
        data: { id: 'legacy-invalid-state-shape', blockHeight: 10, timestamp: 1_000, address: 'carol' },
      },
    ]);

    await expect(indexer.backfillAccountTransactions()).resolves.toBe(true);

    expect(await repository.get('accountTransactions', 'legacy-invalid-state-shape-carol')).not.toBeNull();
    expect((await repository.get('updatesStreams', 'accountTransactionsBackfill-v1'))?.data.data).toBe(
      JSON.stringify({ processedDocuments: 1, writtenDocuments: 1, lastIndexedBlock: 10, lastTimestamp: 1_000 })
    );
  });

  it('reconstructs missing legacy aggregate windows from stored block snapshots', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      backfillNetworkAggregateSnapshots: () => Promise<boolean>;
    };
    await repository.upsertMany([
      createBlockNetworkSnapshot(1, 100, { transactions: 1, fees: '10', volumeUSD: '1.25' }),
      createBlockNetworkSnapshot(2, 86_500, { transactions: 2, fees: '20', volumeUSD: '2.5' }),
    ]);

    await expect(indexer.backfillNetworkAggregateSnapshots()).resolves.toBe(true);

    expect(await repository.get('networkSnapshots', 'network-all-DAY-0')).toMatchObject({
      data: { type: 'DAY', transactions: 1, fees: '10', volumeUSD: '1.25' },
    });
    expect(await repository.get('networkSnapshots', 'network-all-DAY-86400')).toMatchObject({
      data: { type: 'DAY', transactions: 3, fees: '30', volumeUSD: '3.75' },
    });
    expect(await repository.get('updatesStreams', 'networkAggregateSnapshotsBackfill')).not.toBeNull();
    await expect(indexer.backfillNetworkAggregateSnapshots()).resolves.toBe(false);
  });

  it('allows worker status metadata across fresh-identity restart checks', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      chainIdentityDocument: (migration: 'fresh-database') => IndexerDocument;
      repositoryIsEmpty: () => Promise<boolean>;
      repositoryContainsOnlyChainIdentity: () => Promise<boolean>;
      verifyStoredChainState: (finalizedBlock: number) => Promise<void>;
    };
    const workerStatus = createPersistedWorkerStatusDocument({
      lifecycle: 'stopped',
      startupComplete: false,
      latestFinalizedBlock: null,
      latestIndexedBlock: null,
      lag: null,
      lastSuccessfulIndexTimestamp: null,
      lastError: null,
      lastErrorTimestamp: null,
    });

    await repository.upsert(workerStatus);
    await expect(indexer.repositoryIsEmpty()).resolves.toBe(true);
    await repository.upsert(indexer.chainIdentityDocument('fresh-database'));
    await expect(indexer.repositoryContainsOnlyChainIdentity()).resolves.toBe(true);
    await expect(
      indexer.verifyStoredChainState(SORA_LEGACY_IDENTITY_ANCHOR.block + 1)
    ).resolves.toBeUndefined();
  });

  it('backfills compact XOR burn documents without rewinding chain state', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      backfillXorBurns: (finalizedBlock: number) => Promise<void>;
      drainFinalizedHeads: () => Promise<void>;
    };
    const burnBlock = 25_043_003;
    const chainStateBlock = 26_000_000;
    const burnBlockHash = canonicalBlockHash(`xor-burn-backfill-${burnBlock}`);
    const nexusRecipient = 'sora-nexus-account';
    const burnCall = {
      section: 'assets',
      method: 'burn',
      args: [XOR, '10000000000000000000'],
      meta: { args: [{ name: 'assetId' }, { name: 'amount' }] },
    };
    const remarkCall = {
      section: 'system',
      method: 'remark',
      args: [
        `0x${Buffer.from(
          JSON.stringify({ type: 'soraNexusXorClaim', version: 1, recipient: nexusRecipient }),
          'utf8'
        ).toString('hex')}`,
      ],
      meta: { args: [{ name: 'remark' }] },
    };

    await repository.upsert({
      collection: 'updatesStreams',
      id: 'chainState',
      blockHeight: chainStateBlock,
      timestamp: 1,
      data: {
        id: 'chainState',
        block: chainStateBlock,
        data: JSON.stringify({ lastIndexedBlock: chainStateBlock }),
      },
    });

    indexer.api = {
      rpc: {
        chain: {
          getBlockHash: async (block: number) => canonicalBlockHash(`xor-burn-backfill-${block}`),
          getBlock: async (hash: string) => ({
            block: {
              header: {
                number: { toNumber: () => hash === burnBlockHash ? burnBlock : burnBlock + 1 },
                hash: { toString: () => hash },
              },
              extrinsics: [
                {
                  hash: { toString: () => '0xbackfilledburn' },
                  method: {
                    section: 'utility',
                    method: 'batchAll',
                    args: [[burnCall, remarkCall]],
                    meta: { args: [{ name: 'calls' }] },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async (hash: string) =>
              hash === burnBlockHash
                ? [eventRecord('assets', 'Burn', { address: 'alice', assetId: XOR, amount: '10000000000000000000' })]
                : [],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000000000' }),
          },
        },
      },
    };
    indexer.drainFinalizedHeads = vi.fn(async () => undefined);

    await indexer.backfillXorBurns(burnBlock + 1);

    const xorBurn = await repository.get('xorBurns', '0xbackfilledburn');
    const chainState = await repository.get('updatesStreams', 'chainState');
    const backfillState = await repository.get('updatesStreams', 'xorBurnsBackfill');

    expect(xorBurn?.data).toMatchObject({
      id: '0xbackfilledburn',
      address: 'alice',
      amount: '10',
      assetId: XOR,
      blockHeight: burnBlock,
      txHash: '0xbackfilledburn',
      nexusRecipient,
    });
    expect(chainState?.data).toMatchObject({
      id: 'chainState',
      block: chainStateBlock,
      data: JSON.stringify({ lastIndexedBlock: chainStateBlock }),
    });
    expect(backfillState?.data).toMatchObject({
      id: 'xorBurnsBackfill',
      block: burnBlock + 1,
      data: JSON.stringify({ lastIndexedBlock: burnBlock + 1 }),
    });
    expect(indexer.drainFinalizedHeads).toHaveBeenCalled();
  });

  it('skips compact XOR burn backfill when the node has pruned historical state', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      backfillXorBurns: (finalizedBlock: number) => Promise<void>;
      drainFinalizedHeads: () => Promise<void>;
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    indexer.api = {
      rpc: {
        chain: {
          getBlockHash: async () => {
            throw new Error('State already discarded for historical block');
          },
        },
      },
      query: { system: { events: { at: async () => [] } } },
    };
    indexer.drainFinalizedHeads = vi.fn(async () => undefined);

    try {
      await expect(indexer.backfillXorBurns(25_043_010)).resolves.toBeUndefined();
    } finally {
      warn.mockRestore();
    }

    expect(await repository.get('updatesStreams', 'xorBurnsBackfill')).toBeNull();
    expect(indexer.drainFinalizedHeads).not.toHaveBeenCalled();
  });

  it('backfills bridgeProxy burn history from the first block without rewinding live chain state', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer({ ...config, chainStartBlock: 123 }, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      backfillBridgeProxyHistory: (finalizedBlock: number) => Promise<void>;
      drainFinalizedHeads: () => Promise<void>;
    };
    const chainStateBlock = 26_000_000;
    const bridgeBlock = 5;
    const blockHashCalls: number[] = [];
    const blockHashes = new Map(
      Array.from({ length: bridgeBlock + 2 }, (_item, block) => [block, canonicalBlockHash(`bridge-backfill-${block}`)])
    );
    const blocksByHash = new Map([...blockHashes].map(([block, hash]) => [hash, block]));

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    await repository.upsert({
      collection: 'updatesStreams',
      id: 'chainState',
      blockHeight: chainStateBlock,
      timestamp: 1,
      data: {
        id: 'chainState',
        block: chainStateBlock,
        data: JSON.stringify({ lastIndexedBlock: chainStateBlock }),
      },
    });
    await repository.upsert({
      collection: 'accountTransactions',
      id: `0xbridgebackfill-${LIBERLAND_ACCOUNT}`,
      blockHeight: bridgeBlock,
      timestamp: 1,
      data: {
        id: `0xbridgebackfill-${LIBERLAND_ACCOUNT}`,
        accountId: LIBERLAND_ACCOUNT,
        historyElementId: '0xbridgebackfill',
        blockHeight: bridgeBlock,
        timestamp: 1,
      },
    });

    indexer.api = {
      rpc: {
        chain: {
          getBlockHash: async (block: number) => {
            blockHashCalls.push(block);
            return blockHashes.get(block);
          },
          getBlock: async (hash: string) => {
            const block = blocksByHash.get(hash) ?? 0;
            return {
              block: {
                header: {
                  number: { toNumber: () => block },
                  hash: { toString: () => hash },
                },
                extrinsics:
                  block === bridgeBlock
                    ? [
                        {
                          isSigned: true,
                          signer: { toString: () => 'alice' },
                          hash: { toString: () => '0xbridgebackfill' },
                          method: {
                            section: 'bridgeProxy',
                            method: 'burn',
                            args: [{ Sub: 'Liberland' }, XOR, { Liberland: LIBERLAND_ACCOUNT }, (7n * SCALE).toString()],
                            meta: {
                              args: [{ name: 'networkId' }, { name: 'assetId' }, { name: 'recipient' }, { name: 'amount' }],
                            },
                          },
                        },
                      ]
                    : [],
              },
            };
          },
        },
        state: {
          getMetadata: async () => ({
            asLatest: {
              pallets: [{ name: { toString: () => 'bridgeProxy' } }],
            },
          }),
        },
      },
      at: async (hash: string) => ({
        query: {
          system: {
            events: async () =>
              hash === blockHashes.get(bridgeBlock)
                ? [eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xbridgebackfillrequest', status: 'Done' })]
                : [],
          },
          timestamp: {
            now: async () => ({ toString: () => '1700000002000' }),
          },
        },
      }),
      query: {
        system: {
          events: {
            at: async (hash: string) =>
              hash === blockHashes.get(bridgeBlock)
                ? [eventRecord('bridgeProxy', 'RequestStatusUpdate', { requestHash: '0xbridgebackfillrequest', status: 'Done' })]
                : [],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000002000' }),
          },
        },
      },
    };
    indexer.drainFinalizedHeads = vi.fn(async () => undefined);

    await indexer.backfillBridgeProxyHistory(bridgeBlock + 1);

    const history = await repository.get('historyElements', '0xbridgebackfill');
    const aliceActivity = await repository.get('accountTransactions', '0xbridgebackfill-alice');
    const externalActivity = await repository.get('accountTransactions', `0xbridgebackfill-${LIBERLAND_ACCOUNT}`);
    const chainState = await repository.get('updatesStreams', 'chainState');
    const backfillState = await repository.get('updatesStreams', 'bridgeProxyHistoryBackfill-v1');

    expect(blockHashCalls).not.toContain(0);
    expect(blockHashCalls).toContain(1);
    expect(history?.data).toMatchObject({
      module: 'bridgeProxy',
      method: 'burn',
      address: 'alice',
      dataFrom: 'alice',
      dataTo: LIBERLAND_ACCOUNT,
      data: {
        assetId: XOR,
        amount: '7',
        amountUSD: '14',
        networkId: 'Liberland',
        externalNetwork: 'Liberland',
        externalNetworkType: 'Sub',
        recipient: LIBERLAND_ACCOUNT,
        requestHash: '0xbridgebackfillrequest',
        status: 'Done',
      },
    });
    expect(aliceActivity?.data).toMatchObject({ accountId: 'alice', historyElementId: '0xbridgebackfill' });
    expect(externalActivity).toBeNull();
    await expect(repository.list('accounts')).resolves.toHaveLength(0);
    await expect(repository.list('accountMeta')).resolves.toHaveLength(0);
    await expect(repository.list('networkSnapshots')).resolves.toHaveLength(0);
    expect(chainState?.data).toMatchObject({
      id: 'chainState',
      block: chainStateBlock,
      data: JSON.stringify({ lastIndexedBlock: chainStateBlock }),
    });
    expect(backfillState?.data).toMatchObject({
      id: 'bridgeProxyHistoryBackfill-v1',
      block: bridgeBlock + 1,
      data: JSON.stringify({ lastIndexedBlock: bridgeBlock + 1 }),
    });
    expect(indexer.drainFinalizedHeads).toHaveBeenCalled();
  });

  it('skips bridgeProxy history backfill when the node has pruned historical state', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      backfillBridgeProxyHistory: (finalizedBlock: number) => Promise<void>;
      drainFinalizedHeads: () => Promise<void>;
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    indexer.api = {
      rpc: {
        chain: {
          getBlockHash: async (block: number) => canonicalBlockHash(`pruned-bridge-backfill-${block}`),
          getBlock: async (hash: string) => ({
            block: {
              header: {
                number: { toNumber: () => 1 },
                hash: { toString: () => hash },
              },
              extrinsics: [],
            },
          }),
        },
        state: {
          getMetadata: async () => {
            throw new Error('State already discarded for historical block');
          },
        },
      },
      query: {
        system: { events: { at: async () => [] } },
        timestamp: { now: { at: async () => ({ toString: () => '1700000000000' }) } },
      },
    };
    indexer.drainFinalizedHeads = vi.fn(async () => undefined);

    try {
      await expect(indexer.backfillBridgeProxyHistory(10)).resolves.toBeUndefined();
    } finally {
      warn.mockRestore();
    }

    expect(await repository.get('updatesStreams', 'bridgeProxyHistoryBackfill-v1')).toBeNull();
    expect(indexer.drainFinalizedHeads).not.toHaveBeenCalled();
  });

  it('backfills completed incoming bridgeProxy mint history without indexing the external Liberland account', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      backfillBridgeProxyHistory: (finalizedBlock: number) => Promise<void>;
      drainFinalizedHeads: () => Promise<void>;
    };
    const bridgeBlock = 7;
    const blockHashes = new Map(
      Array.from({ length: bridgeBlock + 1 }, (_item, block) => [block, canonicalBlockHash(`incoming-backfill-${block}`)])
    );
    const blocksByHash = new Map([...blockHashes].map(([block, hash]) => [hash, block]));

    indexer.prices = new Map([[XOR, 2n * SCALE]]);
    indexer.assetInfos = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }]]);
    await repository.upsert({
      collection: 'accountTransactions',
      id: `0xincomingbackfillrequest-mint-${LIBERLAND_ACCOUNT}`,
      blockHeight: bridgeBlock,
      timestamp: 1,
      data: {
        id: `0xincomingbackfillrequest-mint-${LIBERLAND_ACCOUNT}`,
        accountId: LIBERLAND_ACCOUNT,
        historyElementId: '0xincomingbackfillrequest-mint',
        blockHeight: bridgeBlock,
        timestamp: 1,
      },
    });

    indexer.api = {
      rpc: {
        chain: {
          getBlockHash: async (block: number) => blockHashes.get(block),
          getBlock: async (hash: string) => {
            const block = blocksByHash.get(hash) ?? 0;
            return {
              block: {
                header: {
                  number: { toNumber: () => block },
                  hash: { toString: () => hash },
                },
                extrinsics:
                  block === bridgeBlock
                    ? [
                        {
                          isSigned: true,
                          signer: { toString: () => 'relayer' },
                          hash: { toString: () => '0xincomingbackfillsubmit' },
                          method: {
                            section: 'bridgeChannelInbound',
                            method: 'submit',
                            args: [
                              { Sub: 'Liberland' },
                              {
                                source: { Liberland: LIBERLAND_ACCOUNT },
                                dest: { Sora: 'alice' },
                                assetId: XOR,
                              },
                            ],
                            meta: {
                              args: [{ name: 'networkId' }, { name: 'message' }],
                            },
                          },
                        },
                      ]
                    : [],
              },
            };
          },
        },
        state: {
          getMetadata: async () => ({
            asLatest: {
              pallets: [{ name: { toString: () => 'bridgeChannelInbound' } }],
            },
          }),
        },
      },
      at: async (hash: string) => ({
        query: {
          system: {
            events: async () =>
              hash === blockHashes.get(bridgeBlock)
                ? [
                    eventRecord('bridgeProxy', 'RequestStatusUpdate', {
                      requestHash: '0xincomingbackfillrequest',
                      status: 'Done',
                    }),
                    eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: (4n * SCALE).toString() }),
                  ]
                : [],
          },
          timestamp: {
            now: async () => ({ toString: () => '1700000003000' }),
          },
        },
      }),
      query: {
        system: {
          events: {
            at: async (hash: string) =>
              hash === blockHashes.get(bridgeBlock)
                ? [
                    eventRecord('bridgeProxy', 'RequestStatusUpdate', {
                      requestHash: '0xincomingbackfillrequest',
                      status: 'Done',
                    }),
                    eventRecord('assets', 'Issued', { assetId: XOR, owner: 'alice', amount: (4n * SCALE).toString() }),
                  ]
                : [],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000003000' }),
          },
        },
      },
    };
    indexer.drainFinalizedHeads = vi.fn(async () => undefined);

    await indexer.backfillBridgeProxyHistory(bridgeBlock);

    const original = await repository.get('historyElements', '0xincomingbackfillsubmit');
    const history = await repository.get('historyElements', '0xincomingbackfillrequest-mint');
    const aliceActivity = await repository.get('accountTransactions', '0xincomingbackfillrequest-mint-alice');
    const externalActivity = await repository.get('accountTransactions', `0xincomingbackfillrequest-mint-${LIBERLAND_ACCOUNT}`);

    expect(original).toBeNull();
    expect(history?.data).toMatchObject({
      module: 'bridgeProxy',
      method: 'mint',
      address: 'relayer',
      dataFrom: 'alice',
      dataTo: LIBERLAND_ACCOUNT,
      data: {
        assetId: XOR,
        amount: '4',
        amountUSD: '8',
        networkId: 'Liberland',
        externalNetwork: 'Liberland',
        externalNetworkType: 'Sub',
        recipient: 'alice',
        sender: LIBERLAND_ACCOUNT,
        requestHash: '0xincomingbackfillrequest',
        status: 'Done',
      },
    });
    expect(aliceActivity?.data).toMatchObject({ accountId: 'alice', historyElementId: '0xincomingbackfillrequest-mint' });
    expect(externalActivity).toBeNull();
  });


  it('publishes current-state maintenance before subscribing to finalized heads', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      start: () => Promise<void>;
      stop: () => Promise<void>;
      backfill: () => Promise<boolean>;
      subscribeFinalizedHeads: () => Promise<void>;
      runStartupMaintenance: (finalizedBlock: number) => Promise<number>;
      getStatus: () => { startupComplete: boolean };
    };
    const order: string[] = [];
    let finishBackfill: (() => void) | undefined;
    let finishMaintenance: (() => void) | undefined;
    const apiCreate = vi.spyOn(ApiPromise, 'create').mockResolvedValue(mainnetStartApi() as never);

    indexer.backfill = async () => {
      order.push('normal-backfill-start');
      await new Promise<void>((resolve) => {
        finishBackfill = resolve;
      });
      order.push('normal-backfill-end');
      return false;
    };
    indexer.subscribeFinalizedHeads = async () => {
      order.push('subscribe');
    };
    indexer.runStartupMaintenance = async () => {
      order.push('current-state-maintenance');
      await new Promise<void>((resolve) => {
        finishMaintenance = resolve;
      });
      return 25_900_000;
    };

    try {
      const starting = indexer.start();
      await vi.waitFor(() => expect(order).toEqual(['normal-backfill-start']));
      finishBackfill?.();
      await vi.waitFor(() =>
        expect(order).toEqual([
          'normal-backfill-start',
          'normal-backfill-end',
          'current-state-maintenance',
        ])
      );
      expect(indexer.getStatus().startupComplete).toBe(false);
      finishMaintenance?.();
      await starting;
      expect(order).toEqual([
        'normal-backfill-start',
        'normal-backfill-end',
        'current-state-maintenance',
        'subscribe',
      ]);
      expect(indexer.getStatus().startupComplete).toBe(true);
    } finally {
      await indexer.stop();
      apiCreate.mockRestore();
    }
  });

  it('does not scan historical collections during fresh-store startup maintenance', async () => {
    const repository = new MemoryRepository();
    const query = vi.spyOn(repository, 'query');
    const list = vi.spyOn(repository, 'list');
    const refreshDerivedState = vi.fn(async () => undefined);
    const indexer = new ChainIndexer(config, repository) as unknown as {
      runStartupMaintenance: (finalizedBlock: number) => Promise<number>;
      refreshDerivedState: typeof refreshDerivedState;
    };
    indexer.refreshDerivedState = refreshDerivedState;

    await expect(indexer.runStartupMaintenance(100)).resolves.toBe(100);

    expect(query).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(refreshDerivedState).toHaveBeenCalledWith(100, expect.any(Number), true, true);
  });

  it('treats genesis as the fresh checkpoint and rejects malformed persisted chain state', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      getLastIndexedBlock: () => Promise<number>;
    };

    await expect(indexer.getLastIndexedBlock()).resolves.toBe(0);

    repository.get = vi.fn(
      async () =>
        ({
          collection: 'updatesStreams',
          id: 'chainState',
          blockHeight: 10,
          data: {
            id: 'chainState',
            block: 9,
            data: JSON.stringify({ lastIndexedBlock: 10 }),
          },
        }) as IndexerDocument
    );
    await expect(indexer.getLastIndexedBlock()).rejects.toThrow(
      'Stored PI chainState checkpoint is malformed'
    );
  });



  it('keeps finalized-head subscription alive when the initial RPC update times out', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      subscribeFinalizedHeads: () => Promise<void>;
      startFinalizedHeadPolling: () => void;
      updatePendingFinalizedBlockFromRpc: () => Promise<void>;
    };
    const failure = new Error('block data endpoint.getFinalizedHead() timed out after 15000ms');
    const subscribeFinalizedHeads = vi.fn(async () => undefined);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    indexer.api = {
      rpc: {
        chain: {
          subscribeFinalizedHeads,
        },
      },
    };
    indexer.startFinalizedHeadPolling = vi.fn();
    indexer.updatePendingFinalizedBlockFromRpc = vi.fn(async () => {
      throw failure;
    });

    try {
      await expect(indexer.subscribeFinalizedHeads()).resolves.toBeUndefined();
      expect(subscribeFinalizedHeads).toHaveBeenCalledOnce();
      expect(consoleError).toHaveBeenCalledWith('Failed to initialize finalized head polling', failure);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('logs finalized-head subscription update failures without leaving an unhandled rejection', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      requestPendingFinalizedBlockUpdate: (errorMessage: string) => void;
      updatePendingFinalizedBlockFromRpc: () => Promise<void>;
    };
    const failure = new Error('block data endpoint.getFinalizedHead() timed out after 15000ms');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    indexer.updatePendingFinalizedBlockFromRpc = vi.fn(async () => {
      throw failure;
    });

    try {
      indexer.requestPendingFinalizedBlockUpdate('Failed to update finalized head from subscription');
      await vi.waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith('Failed to update finalized head from subscription', failure);
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('skips expensive derived-state refreshes while backfilling historical blocks', async () => {
    const repository = new MemoryRepository();
    const startBlock = SORA_LEGACY_IDENTITY_ANCHOR.block;
    const finalizedBlock = startBlock + 3;
    const finalizedHash = canonicalBlockHash(`finalized-${finalizedBlock}`);
    const indexer = new ChainIndexer(
      {
        ...config,
        chainStartBlock: startBlock,
        stateRefreshIntervalBlocks: 1,
        snapshotIntervalBlocks: 1,
      },
      repository
    ) as unknown as {
      api: unknown;
      getIndexableFinalizedBlock: () => Promise<number>;
      backfill: () => Promise<boolean>;
      indexBlockByNumber: (block: number, options?: { refreshDerivedState?: boolean }) => Promise<void>;
      initializeHistoricalValuationState: (startBlock: number) => Promise<unknown>;
      refreshDerivedState: (blockHeight: number, timestamp: number, includeSnapshots: boolean) => Promise<void>;
    };
    const indexedBlocks: Array<{ block: number; refreshDerivedState?: boolean }> = [];
    const refreshes: Array<{ blockHeight: number; includeSnapshots: boolean }> = [];

    indexer.api = {
      rpc: {
        chain: {
          getFinalizedHead: async () => ({ toString: () => finalizedHash }),
          getHeader: async () => ({
            number: { toNumber: () => finalizedBlock },
            hash: { toString: () => finalizedHash },
          }),
        },
      },
    };
    indexer.initializeHistoricalValuationState = vi.fn(async () => ({ blockHeight: 0 }));
    indexer.indexBlockByNumber = async (block, options) => {
      indexedBlocks.push({ block, refreshDerivedState: options?.refreshDerivedState });
    };
    indexer.refreshDerivedState = async (blockHeight, _timestamp, includeSnapshots) => {
      refreshes.push({ blockHeight, includeSnapshots });
    };

    await indexer.backfill();

    expect(indexedBlocks).toEqual([
      { block: startBlock, refreshDerivedState: false },
      { block: startBlock + 1, refreshDerivedState: false },
      { block: startBlock + 2, refreshDerivedState: false },
      { block: finalizedBlock, refreshDerivedState: false },
    ]);
    expect(refreshes).toEqual([]);
  });

  it('keeps finalized block indexing committed when a scheduled derived-state refresh fails', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(
      { ...config, stateRefreshIntervalBlocks: 1, snapshotIntervalBlocks: 1 },
      repository
    ) as unknown as {
      api: unknown;
      indexBlockByNumber: (block: number) => Promise<void>;
      refreshDerivedState: (blockHeight: number, timestamp: number, includeSnapshots: boolean) => Promise<void>;
    };
    const failure = new Error('refresh query timeout');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const requestedHash = canonicalBlockHash('scheduled-refresh-10');

    indexer.api = {
      rpc: {
        chain: {
          getBlockHash: async () => ({ toString: () => canonicalBlockHash('block') }),
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 10 },
                hash: { toString: () => canonicalBlockHash('block') },
              },
              extrinsics: [],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1000000' }),
          },
        },
      },
    };
    markIndexerMainnet(indexer);
    indexer.refreshDerivedState = async () => {
      throw failure;
    };

    try {
      markIndexerMainnet(indexer);
      await indexer.indexBlockByNumber(10);

      expect((await repository.get('updatesStreams', 'chainState'))?.data.block).toBe(10);
      await vi.waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith('Failed to refresh derived state at SORA block 10', failure);
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('queues an immediate Polkamarkt snapshot refresh for finalized trade blocks', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      indexBlockByHash: (hash: string) => Promise<void>;
      refreshPolkamarktState: (blockHeight: number, timestamp: number, includeSnapshots: boolean) => Promise<void>;
    };
    const refreshes: Array<{ blockHeight: number; timestamp: number; includeSnapshots: boolean }> = [];

    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 11 },
                hash: { toString: () => canonicalBlockHash('polkamarkt-trade-block') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'alice' },
                  hash: { toString: () => '0xpolkamarkt-buy' },
                  method: {
                    section: 'polkamarkt',
                    method: 'buy',
                    args: [3, 'Yes', SCALE.toString(), (32n * SCALE).toString()],
                    meta: {
                      args: [
                        { name: 'marketId' },
                        { name: 'outcome' },
                        { name: 'collateralIn' },
                        { name: 'minSharesOut' },
                      ],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord(
                'polkamarkt',
                'TradeExecuted',
                {
                  marketId: 3,
                  trader: 'alice',
                  side: 'buy',
                  outcome: 'Yes',
                  collateralAmount: SCALE.toString(),
                  shareAmount: (32n * SCALE).toString(),
                  feeAmount: '0',
                },
                0
              ),
              eventRecord('xorFee', 'FeeWithdrawn', { amount: SCALE.toString() }, 0),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000011000' }),
          },
        },
      },
    };
    indexer.refreshPolkamarktState = async (blockHeight, timestamp, includeSnapshots) => {
      refreshes.push({ blockHeight, timestamp, includeSnapshots });
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('polkamarkt-trade-block'));

    await vi.waitFor(() => {
      expect(refreshes).toEqual([{ blockHeight: 11, timestamp: 1_700_000_011, includeSnapshots: true }]);
    });
  });

  it('does not queue immediate Polkamarkt snapshots for non-trade blocks', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      indexBlockByHash: (hash: string) => Promise<void>;
      refreshPolkamarktState: (blockHeight: number, timestamp: number, includeSnapshots: boolean) => Promise<void>;
    };
    const refreshes: Array<{ blockHeight: number; timestamp: number; includeSnapshots: boolean }> = [];

    indexer.api = {
      rpc: {
        chain: {
          getBlock: async () => ({
            block: {
              header: {
                number: { toNumber: () => 12 },
                hash: { toString: () => canonicalBlockHash('balances-block') },
              },
              extrinsics: [
                {
                  isSigned: true,
                  signer: { toString: () => 'alice' },
                  hash: { toString: () => '0xbalances-transfer' },
                  method: {
                    section: 'balances',
                    method: 'transfer',
                    args: ['bob', SCALE.toString()],
                    meta: {
                      args: [{ name: 'dest' }, { name: 'value' }],
                    },
                  },
                },
              ],
            },
          }),
        },
      },
      query: {
        system: {
          events: {
            at: async () => [
              eventRecord('balances', 'Transfer', { from: 'alice', to: 'bob', amount: SCALE.toString() }, 0),
              eventRecord('xorFee', 'FeeWithdrawn', { amount: SCALE.toString() }, 0),
            ],
          },
        },
        timestamp: {
          now: {
            at: async () => ({ toString: () => '1700000012000' }),
          },
        },
      },
    };
    indexer.refreshPolkamarktState = async (blockHeight, timestamp, includeSnapshots) => {
      refreshes.push({ blockHeight, timestamp, includeSnapshots });
    };

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('balances-block'));
    await Promise.resolve();

    expect(refreshes).toEqual([]);
  });

  it('retries missed finalized blocks before indexing later heads', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      subscribeFinalizedHeads: () => Promise<void>;
      ensureLiveValuationState: (block: number) => Promise<{ blockHeight: number }>;
      indexBlockByNumber: (
        block: number,
        options?: { historicalValuationState?: { blockHeight: number } }
      ) => Promise<void>;
    };
    const indexedBlocks: number[] = [];
    const baseBlock = SORA_LEGACY_IDENTITY_ANCHOR.block;
    const initialFinalizedHash = canonicalBlockHash('retry-initial-finalized');
    let finalizedHeadCallback: ((header: {
      number: { toNumber: () => number };
      hash: { toString: () => string };
    }) => void) | undefined;

    await repository.upsert({
      collection: 'updatesStreams',
      id: 'chainState',
      blockHeight: baseBlock + 9,
      timestamp: 1,
      data: {
        id: 'chainState',
        block: baseBlock + 9,
        data: JSON.stringify({ lastIndexedBlock: baseBlock + 9 }),
      },
    });

    indexer.api = {
      rpc: {
        chain: {
          subscribeFinalizedHeads: async (callback: typeof finalizedHeadCallback) => {
            finalizedHeadCallback = callback;
          },
          getFinalizedHead: async () => ({ toString: () => initialFinalizedHash }),
          getHeader: async () => ({
            number: { toNumber: () => baseBlock + 9 },
            hash: { toString: () => initialFinalizedHash },
          }),
        },
      },
    };
    const valuationState = { blockHeight: 9 };
    indexer.ensureLiveValuationState = vi.fn(async () => valuationState);
    indexer.indexBlockByNumber = async (block, options) => {
      indexedBlocks.push(block);
      if (block === baseBlock + 10 && indexedBlocks.length === 1) {
        throw new Error('transient database failure');
      }

      options!.historicalValuationState!.blockHeight = block;

      await repository.upsert({
        collection: 'updatesStreams',
        id: 'chainState',
        blockHeight: block,
        timestamp: 1,
        data: {
          id: 'chainState',
          block,
          data: JSON.stringify({ lastIndexedBlock: block }),
        },
      });
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await indexer.subscribeFinalizedHeads();
      finalizedHeadCallback?.({
        number: { toNumber: () => baseBlock + 10 },
        hash: { toString: () => canonicalBlockHash('retry-head-10') },
      });
      await vi.waitFor(() => {
        expect(indexedBlocks).toEqual([baseBlock + 10]);
      });
      expect((await repository.get('updatesStreams', 'chainState'))?.data.block).toBe(baseBlock + 9);
      expect(consoleError).toHaveBeenCalledWith(`Failed to index finalized block ${baseBlock + 10}`, expect.any(Error));

      finalizedHeadCallback?.({
        number: { toNumber: () => baseBlock + 12 },
        hash: { toString: () => canonicalBlockHash('retry-head-12') },
      });
      await vi.waitFor(() => {
        expect(indexedBlocks).toEqual([
          baseBlock + 10,
          baseBlock + 10,
          baseBlock + 11,
          baseBlock + 12,
        ]);
      });
      expect((await repository.get('updatesStreams', 'chainState'))?.data.block).toBe(baseBlock + 12);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('drains to the latest finalized block immediately after subscribing', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      subscribeFinalizedHeads: () => Promise<void>;
      ensureLiveValuationState: (block: number) => Promise<{ blockHeight: number }>;
      indexBlockByNumber: (
        block: number,
        options?: { historicalValuationState?: { blockHeight: number } }
      ) => Promise<void>;
    };
    const indexedBlocks: number[] = [];
    const baseBlock = SORA_LEGACY_IDENTITY_ANCHOR.block;
    const finalizedHash = canonicalBlockHash('drain-finalized');

    await repository.upsert({
      collection: 'updatesStreams',
      id: 'chainState',
      blockHeight: baseBlock + 9,
      timestamp: 1,
      data: {
        id: 'chainState',
        block: baseBlock + 9,
        data: JSON.stringify({ lastIndexedBlock: baseBlock + 9 }),
      },
    });

    indexer.api = {
      rpc: {
        chain: {
          subscribeFinalizedHeads: async () => undefined,
          getFinalizedHead: async () => ({ toString: () => finalizedHash }),
          getHeader: async () => ({
            number: { toNumber: () => baseBlock + 12 },
            hash: { toString: () => finalizedHash },
          }),
        },
      },
    };
    const valuationState = { blockHeight: 9 };
    indexer.ensureLiveValuationState = vi.fn(async () => valuationState);
    indexer.indexBlockByNumber = async (block, options) => {
      indexedBlocks.push(block);
      options!.historicalValuationState!.blockHeight = block;
      await repository.upsert({
        collection: 'updatesStreams',
        id: 'chainState',
        blockHeight: block,
        timestamp: 1,
        data: {
          id: 'chainState',
          block,
          data: JSON.stringify({ lastIndexedBlock: block }),
        },
      });
    };

    await indexer.subscribeFinalizedHeads();

    expect(indexedBlocks).toEqual([baseBlock + 10, baseBlock + 11, baseBlock + 12]);
    expect((await repository.get('updatesStreams', 'chainState'))?.data.block).toBe(baseBlock + 12);
  });

  it('continues existing account point metadata from the repository', async () => {
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'accountMeta',
      id: 'alice',
      blockHeight: 1,
      timestamp: 100,
      data: {
        id: 'alice',
        accountId: 'alice',
        createdAtTimestamp: 100,
        createdAtBlock: 1,
        orderBook: { created: 1, closed: 0, amountUSD: '10' },
      },
    });
    const indexer = new ChainIndexer(config, repository) as unknown as {
      createAccountDocuments: (
        accounts: string[],
        latestHistoryElementId: string,
        blockHeight: number,
        timestamp: number,
        pendingPointData: Map<string, Record<string, unknown>>,
        update: { module: string; method: string; data: unknown; fee: bigint }
      ) => Promise<Array<{ collection: string; id: string; data: Record<string, unknown> }>>;
    };

    const documents = await indexer.createAccountDocuments(['alice'], 'history-2', 20, 2000, new Map(), {
      module: 'orderBook',
      method: 'placeLimitOrder',
      data: { amountUSD: '12.5' },
      fee: 0n,
    });
    const meta = documents.find((document) => document.collection === 'accountMeta')?.data;
    const pointSystem = documents.find((document) => document.collection === 'accountPointSystems')?.data;

    expect(meta).toMatchObject({
      createdAtBlock: 1,
      createdAtTimestamp: 100,
      orderBook: { created: 2, closed: 0, amountUSD: '22.5' },
      xorFees: { amount: '0', amountUSD: '0' },
    });
    expect(pointSystem).toMatchObject({
      accountId: 'alice',
      startedAtBlock: 1,
      orderBook: { created: 2, closed: 0, amountUSD: '22.5' },
    });
  });

  it('keeps pending account point updates across multiple same-block activities', async () => {
    const repository = new MemoryRepository();
    const pendingPointData = new Map<string, Record<string, unknown>>();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      createAccountDocuments: (
        accounts: string[],
        latestHistoryElementId: string,
        blockHeight: number,
        timestamp: number,
        pendingPointData: Map<string, Record<string, unknown>>,
        update: { module: string; method: string; data: unknown; fee: bigint }
      ) => Promise<Array<{ collection: string; id: string; data: Record<string, unknown> }>>;
    };

    await indexer.createAccountDocuments(['alice'], 'history-1', 10, 1000, pendingPointData, {
      module: 'ethBridge',
      method: 'transferToSidechain',
      data: { amountUSD: '3.25' },
      fee: 0n,
    });
    const documents = await indexer.createAccountDocuments(['alice'], 'history-2', 10, 1000, pendingPointData, {
      module: 'bridgeMultisig',
      method: 'approveRequest',
      data: { amountUSD: '4.75' },
      fee: 0n,
    });
    const meta = documents.find((document) => document.collection === 'accountMeta')?.data;

    expect(meta?.deposit).toEqual({ incomingUSD: '4.75', outgoingUSD: '3.25' });
  });

  it('tracks order book cancels, vault closes, and governance votes in account points', async () => {
    const repository = new MemoryRepository();
    const pendingPointData = new Map<string, Record<string, unknown>>();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      createAccountDocuments: (
        accounts: string[],
        latestHistoryElementId: string,
        blockHeight: number,
        timestamp: number,
        pendingPointData: Map<string, Record<string, unknown>>,
        update: { module: string; method: string; data: unknown; fee: bigint }
      ) => Promise<Array<{ collection: string; id: string; data: Record<string, unknown> }>>;
    };

    await indexer.createAccountDocuments(['alice'], 'history-1', 10, 1000, pendingPointData, {
      module: 'orderBook',
      method: 'cancelLimitOrdersBatch',
      data: [{ orderId: 1 }, { orderId: 2 }, { orderId: 3 }],
      fee: 0n,
    });
    await indexer.createAccountDocuments(['alice'], 'history-2', 10, 1000, pendingPointData, {
      module: 'kensetsu',
      method: 'closeCdp',
      data: { debtAmountUSD: '8.5' },
      fee: 0n,
    });
    const documents = await indexer.createAccountDocuments(['alice'], 'history-3', 10, 1000, pendingPointData, {
      module: 'democracy',
      method: 'vote',
      data: { amount: '7', amountUSD: '14' },
      fee: 0n,
    });
    const meta = documents.find((document) => document.collection === 'accountMeta')?.data;

    expect(meta).toMatchObject({
      orderBook: { created: 0, closed: 3, amountUSD: '0' },
      vault: { created: 0, closed: 1, amountUSD: '8.5' },
      governance: { votes: 1, amount: '7', amountUSD: '14' },
    });
  });

  it('creates indexed documents from order book, vault, and referrer events', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createEventDocuments: (
        events: unknown[],
        blockHeight: number,
        timestamp: number,
        signer: string
      ) => Array<{ collection: string; id: string; data: Record<string, unknown> }>;
    };

    const documents = indexer.createEventDocuments(
      [
        eventRecord('orderBook', 'LimitOrderPlaced', {
          orderBookId: `0-${XOR}-${KUSD}`,
          orderId: 42,
          side: 'Sell',
          amount: (3n * SCALE).toString(),
          price: (2n * SCALE).toString(),
          owner: 'alice',
        }),
        eventRecord('kensetsu', 'CDPClosed', {
          cdpId: 'vault-1',
          collateralAssetId: XOR,
          stablecoinAssetId: KUSD,
          amount: (5n * SCALE).toString(),
          owner: 'bob',
        }),
        eventRecord('xorFee', 'ReferrerRewarded', {
          referral: 'charlie',
          referrer: 'dave',
          amount: '123',
        }),
      ],
      99,
      1_700_000_000,
      'fallback-signer'
    );

    expect(documents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          collection: 'orderBookOrders',
          id: `0-${XOR}-${KUSD}-42`,
          data: expect.objectContaining({
            accountId: 'alice',
            amount: '3',
            isBuy: false,
            orderBookId: `0-${XOR}-${KUSD}`,
            price: '2',
            status: 'Active',
          }),
        }),
        expect.objectContaining({
          collection: 'vaultEvents',
          id: 'vault-1-99-CDPClosed',
          data: expect.objectContaining({
            amount: '5',
            type: 'Closed',
            vaultId: 'vault-1',
          }),
        }),
        expect.objectContaining({
          collection: 'vaults',
          id: 'vault-1',
          data: expect.objectContaining({
            collateralAmountReturned: '5',
            ownerId: 'bob',
            status: 'Closed',
          }),
        }),
        expect.objectContaining({
          collection: 'referrerRewards',
          id: 'dave-charlie',
          data: expect.objectContaining({
            amount: '123',
            referral: 'charlie',
            referrer: 'dave',
          }),
        }),
      ])
    );
  });

  it('creates storage-derived staking and referral documents', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createStakingDocuments: (nominators: unknown[], blockHeight: number, timestamp: number) => unknown[];
      createReferralDocuments: (referrers: unknown[], blockHeight: number, timestamp: number) => unknown[];
    };

    const staking = indexer.createStakingDocuments([[{ args: ['alice'] }]], 12, 1_700_000_000);
    const referrals = indexer.createReferralDocuments(
      [[{ args: ['charlie'] }, { toJSON: () => 'dave' }]],
      12,
      1_700_000_000
    );

    expect(staking).toEqual([
      {
        collection: 'stakingStakers',
        id: 'alice',
        blockHeight: 12,
        timestamp: 1_700_000_000,
        data: { id: 'alice' },
      },
    ]);
    expect(referrals).toEqual([
      {
        collection: 'referrerRewards',
        id: 'dave-charlie',
        blockHeight: 12,
        timestamp: 1_700_000_000,
        data: {
          id: 'dave-charlie',
          referral: 'charlie',
          referrer: 'dave',
          blockHeight: 12,
          timestamp: 1_700_000_000,
          updated: 1_700_000_000,
          amount: '0',
        },
      },
    ]);
  });

  it('preserves accumulated referral rewards when storage refreshes referral relationships', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      createEventDocuments: (
        events: unknown[],
        blockHeight: number,
        timestamp: number,
        signer: string
      ) => Array<{ collection: string; id: string; data: Record<string, unknown> }>;
      createReferralDocuments: (referrers: unknown[], blockHeight: number, timestamp: number) => unknown[];
      prepareReferrerRewardDocuments: (documents: unknown[]) => Promise<any[]>;
    };

    await repository.upsert({
      collection: 'referrerRewards',
      id: 'dave-charlie',
      blockHeight: 11,
      timestamp: 1_700_000_000,
      data: {
        id: 'dave-charlie',
        referral: 'charlie',
        referrer: 'dave',
        updated: 1_700_000_000,
        amount: '100',
      },
    });

    const rewardDocuments = indexer.createEventDocuments(
      [eventRecord('xorFee', 'ReferrerRewarded', { referral: 'charlie', referrer: 'dave', amount: '23' })],
      12,
      1_700_000_010,
      'fallback-signer'
    );
    const storageDocuments = indexer.createReferralDocuments(
      [[{ args: ['charlie'] }, { toJSON: () => 'dave' }]],
      12,
      1_700_000_010
    );

    await repository.upsertMany(await indexer.prepareReferrerRewardDocuments([...rewardDocuments, ...storageDocuments]));

    await expect(repository.get('referrerRewards', 'dave-charlie')).resolves.toMatchObject({
      data: {
        amount: '123',
        referral: 'charlie',
        referrer: 'dave',
      },
    });
  });

  it('preserves vault creation blocks while refreshing storage-derived vaults', async () => {
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'vaults',
      id: 'vault-1',
      blockHeight: 50,
      timestamp: 1_600_000_000,
      data: {
        id: 'vault-1',
        createdAtBlock: 50,
      },
    });
    const indexer = new ChainIndexer(config, repository) as unknown as {
      createVaultDocuments: (cdpEntries: unknown[], blockHeight: number, timestamp: number) => Promise<unknown[]>;
    };

    const documents = await indexer.createVaultDocuments(
      [
        [
          { args: ['vault-1'] },
          {
            toJSON: () => ({
              owner: 'alice',
              collateral_asset_id: XOR,
              stablecoin_asset_id: KUSD,
            }),
          },
        ],
      ],
      99,
      1_700_000_000
    );

    expect(documents).toEqual([
      {
        collection: 'vaults',
        id: 'vault-1',
        blockHeight: 99,
        timestamp: 1_700_000_000,
        data: {
          id: 'vault-1',
          type: 'Type2',
          status: 'Opened',
          ownerId: 'alice',
          collateralAssetId: XOR,
          debtAssetId: KUSD,
          collateralAmountReturned: '0',
          createdAtBlock: 50,
          updatedAtBlock: 99,
        },
      },
    ]);
  });

  it('creates account liquidity snapshots from pool provider shares', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createAccountLiquidityDocuments: (
        poolProviders: unknown[],
        pools: unknown[],
        assets: Map<string, unknown>,
        prices: Map<string, bigint>,
        blockHeight: number,
        timestamp: number
      ) => unknown[];
    };

    const documents = indexer.createAccountLiquidityDocuments(
      [[{ args: ['pool-account', 'alice'] }, (250n * SCALE).toString()]],
      [
        {
          id: `${XOR}-${KUSD}`,
          poolAccount: 'pool-account',
          poolTokenSupply: 1_000n * SCALE,
          liquidityUSD: '1000',
        },
      ],
      new Map(),
      new Map(),
      77,
      1_700_000_000
    );

    expect(documents).toEqual([
      expect.objectContaining({
        collection: 'accountLiquiditySnapshots',
        blockHeight: 77,
        timestamp: 1_700_000_000,
        data: expect.objectContaining({
          accountLiquidityId: `alice-${XOR}-${KUSD}`,
          poolTokens: (250n * SCALE).toString(),
          liquidityUSD: '250',
          type: 'DEFAULT',
        }),
      }),
    ]);
  });

  it('writes account liquidity only on snapshot ticks and skips unchanged writes in the same bucket', async () => {
    const repository = new MemoryRepository();
    const getMany = vi.spyOn(repository, 'getMany');
    const indexer = new ChainIndexer(config, repository) as unknown as {
      createChangedAccountLiquidityDocuments: (
        poolProviders: unknown[],
        pools: unknown[],
        assets: Map<string, unknown>,
        prices: Map<string, bigint>,
        blockHeight: number,
        timestamp: number,
        includeSnapshots: boolean
      ) => Promise<IndexerDocument[]>;
    };
    const pools = [
      {
        id: `${XOR}-${KUSD}`,
        poolAccount: 'pool-account',
        poolTokenSupply: 1_000n * SCALE,
        liquidityUSD: '1000',
      },
    ];
    const provider = [[{ args: ['pool-account', 'alice'] }, (250n * SCALE).toString()]];
    const timestamp = 1_700_000_000;

    await expect(
      indexer.createChangedAccountLiquidityDocuments(provider, pools, new Map(), new Map(), 76, timestamp, false)
    ).resolves.toEqual([]);
    expect(getMany).not.toHaveBeenCalled();

    const initial = await indexer.createChangedAccountLiquidityDocuments(
      provider,
      pools,
      new Map(),
      new Map(),
      77,
      timestamp,
      true
    );
    expect(initial).toHaveLength(1);
    await repository.upsertMany(initial);

    await expect(
      indexer.createChangedAccountLiquidityDocuments(provider, pools, new Map(), new Map(), 78, timestamp + 10, true)
    ).resolves.toEqual([]);

    const changed = await indexer.createChangedAccountLiquidityDocuments(
      [[{ args: ['pool-account', 'alice'] }, (300n * SCALE).toString()]],
      pools,
      new Map(),
      new Map(),
      79,
      timestamp + 20,
      true
    );
    expect(changed).toEqual([
      expect.objectContaining({
        id: initial[0]?.id,
        data: expect.objectContaining({ poolTokens: (300n * SCALE).toString(), liquidityUSD: '300' }),
      }),
    ]);

    const cleanCachedNextBucket = await indexer.createChangedAccountLiquidityDocuments(
      provider,
      pools,
      new Map(),
      new Map(),
      80,
      timestamp + 300,
      false
    );
    expect(cleanCachedNextBucket).toEqual([]);

    const nextBucket = await indexer.createChangedAccountLiquidityDocuments(
      provider,
      pools,
      new Map(),
      new Map(),
      80,
      timestamp + 300,
      true
    );
    expect(nextBucket).toHaveLength(1);
    expect(nextBucket[0]?.id).not.toBe(initial[0]?.id);
  });

  it('buckets default asset snapshots into five-minute chart windows', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createAssetDocuments: (
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        prices: Map<string, bigint>,
        liquidity: Map<string, bigint>,
        analytics: {
          assets: Map<string, Map<string, unknown>>;
          assetDayVolumeUSD: Map<string, bigint>;
          assetWeekVolumeUSD: Map<string, bigint>;
          assetDayOpenPrice: Map<string, string>;
          assetWeekOpenPrice: Map<string, string>;
          assetOrderBookLiquidity: Map<string, bigint>;
        },
        blockHeight: number,
        timestamp: number,
        includeSnapshots: boolean
      ) => Promise<Array<{ collection: string; id: string; data: Record<string, unknown> }>>;
    };
    const timestamp = 1_700_000_349;
    const assets = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'SORA', decimals: 18, supply: 1_000n * SCALE }]]);
    const analytics = {
      assets: new Map(),
      assetDayVolumeUSD: new Map(),
      assetWeekVolumeUSD: new Map(),
      assetDayOpenPrice: new Map(),
      assetWeekOpenPrice: new Map(),
      assetOrderBookLiquidity: new Map(),
    };

    const documents = await indexer.createAssetDocuments(
      assets,
      new Map([[XOR, 5n * SCALE]]),
      new Map(),
      analytics,
      77,
      timestamp,
      true
    );

    const defaultSnapshot = documents.find((document) => document.collection === 'assetSnapshots' && document.data.type === 'DEFAULT');
    const daySnapshot = documents.find((document) => document.collection === 'assetSnapshots' && document.data.type === 'DAY');

    expect(defaultSnapshot?.id).toBe(`asset-${XOR}-DEFAULT-1700000100`);
    expect(defaultSnapshot?.data.timestamp).toBe(timestamp);
    expect(daySnapshot?.id).toBe(`asset-${XOR}-DAY-1699920000`);
  });

  it('does not roll default asset snapshots into the next five-minute window early', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createAssetDocuments: (
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        prices: Map<string, bigint>,
        liquidity: Map<string, bigint>,
        analytics: {
          assets: Map<string, Map<string, unknown>>;
          assetDayVolumeUSD: Map<string, bigint>;
          assetWeekVolumeUSD: Map<string, bigint>;
          assetDayOpenPrice: Map<string, string>;
          assetWeekOpenPrice: Map<string, string>;
          assetOrderBookLiquidity: Map<string, bigint>;
        },
        blockHeight: number,
        timestamp: number,
        includeSnapshots: boolean
      ) => Promise<Array<{ collection: string; id: string; data: Record<string, unknown> }>>;
    };
    const assets = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'SORA', decimals: 18, supply: 1_000n * SCALE }]]);
    const analytics = {
      assets: new Map(),
      assetDayVolumeUSD: new Map(),
      assetWeekVolumeUSD: new Map(),
      assetDayOpenPrice: new Map(),
      assetWeekOpenPrice: new Map(),
      assetOrderBookLiquidity: new Map(),
    };
    const defaultSnapshotId = async (timestamp: number): Promise<string | undefined> => {
      const documents = await indexer.createAssetDocuments(
        assets,
        new Map([[XOR, 5n * SCALE]]),
        new Map(),
        analytics,
        77,
        timestamp,
        true
      );

      return documents.find((document) => document.collection === 'assetSnapshots' && document.data.type === 'DEFAULT')?.id;
    };

    await expect(defaultSnapshotId(1_700_000_399)).resolves.toBe(`asset-${XOR}-DEFAULT-1700000100`);
    await expect(defaultSnapshotId(1_700_000_400)).resolves.toBe(`asset-${XOR}-DEFAULT-1700000400`);
  });

  it('persists only four chart asset granularities and never looks up BLOCK snapshots', async () => {
    const repository = new MemoryRepository();
    const getMany = vi.spyOn(repository, 'getMany');
    const indexer = new ChainIndexer(config, repository) as unknown as {
      createAssetDocuments: (
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        prices: Map<string, bigint>,
        liquidity: Map<string, bigint>,
        analytics: {
          assets: Map<string, Map<string, unknown>>;
          assetDayVolumeUSD: Map<string, bigint>;
          assetWeekVolumeUSD: Map<string, bigint>;
          assetDayOpenPrice: Map<string, string>;
          assetWeekOpenPrice: Map<string, string>;
          assetOrderBookLiquidity: Map<string, bigint>;
        },
        blockHeight: number,
        timestamp: number,
        includeSnapshots: boolean
      ) => Promise<Array<{ collection: string; id: string; data: Record<string, unknown> }>>;
    };
    const timestamp = 1_700_000_349;
    const assets = new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'SORA', decimals: 18, supply: 1_000n * SCALE }]]);
    const analytics = {
      assets: new Map(),
      assetDayVolumeUSD: new Map(),
      assetWeekVolumeUSD: new Map(),
      assetDayOpenPrice: new Map(),
      assetWeekOpenPrice: new Map(),
      assetOrderBookLiquidity: new Map(),
    };
    const assetDocuments = async (blockHeight: number) =>
      await indexer.createAssetDocuments(
        assets,
        new Map([[XOR, 5n * SCALE]]),
        new Map(),
        analytics,
        blockHeight,
        timestamp,
        true
      );

    const firstBlockDocuments = await assetDocuments(77);
    const secondBlockDocuments = await assetDocuments(78);
    const firstDefault = firstBlockDocuments.find(
      (document) => document.collection === 'assetSnapshots' && document.data.type === 'DEFAULT'
    );
    const secondDefault = secondBlockDocuments.find(
      (document) => document.collection === 'assetSnapshots' && document.data.type === 'DEFAULT'
    );

    expect(firstDefault?.id).toBe(secondDefault?.id);
    expect(firstDefault?.id).toBe(`asset-${XOR}-DEFAULT-1700000100`);
    for (const documents of [firstBlockDocuments, secondBlockDocuments]) {
      expect(
        documents
          .filter((document) => document.collection === 'assetSnapshots')
          .map((document) => document.data.type)
      ).toEqual(['DEFAULT', 'HOUR', 'DAY', 'MONTH']);
    }
    expect(getMany.mock.calls.flatMap((call) => call[1]).some((id) => id.includes('-BLOCK-'))).toBe(false);
  });

  it('persists tiny price changes and large or tiny volumes as plain decimal strings', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      createAssetDocuments: (
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        prices: Map<string, bigint>,
        liquidity: Map<string, bigint>,
        analytics: {
          assets: Map<string, Map<string, unknown>>;
          assetDayVolumeUSD: Map<string, bigint>;
          assetWeekVolumeUSD: Map<string, bigint>;
          assetDayOpenPrice: Map<string, string>;
          assetWeekOpenPrice: Map<string, string>;
          assetOrderBookLiquidity: Map<string, bigint>;
        },
        blockHeight: number,
        timestamp: number,
        includeSnapshots: boolean
      ) => Promise<IndexerDocument[]>;
    };
    const documents = await indexer.createAssetDocuments(
      new Map([[XOR, { id: XOR, symbol: 'XOR', name: 'SORA', decimals: 18, supply: 1_000n * SCALE }]]),
      new Map([[XOR, 100_000_000n * SCALE + 10_000_000_000n]]),
      new Map(),
      {
        assets: new Map(),
        assetDayVolumeUSD: new Map([[XOR, 10n ** 48n]]),
        assetWeekVolumeUSD: new Map([[XOR, 100_000_000_000n]]),
        assetDayOpenPrice: new Map([[XOR, '100000000']]),
        assetWeekOpenPrice: new Map([[XOR, '100000000']]),
        assetOrderBookLiquidity: new Map(),
      },
      77,
      1_700_000_000,
      false
    );
    const asset = documents.find((document) => document.collection === 'assets');

    expect(asset?.data).toMatchObject({
      priceChangeDay: '0.00000000000001',
      priceChangeWeek: '0.00000000000001',
      volumeDayUSD: '1000000000000000000000000000000',
      volumeWeekUSD: '0.0000001',
    });
    for (const value of [
      asset?.data.priceChangeDay,
      asset?.data.priceChangeWeek,
      asset?.data.volumeDayUSD,
      asset?.data.volumeWeekUSD,
    ]) {
      expect(String(value)).not.toMatch(/[eE]/);
    }
    await expect(repository.upsertMany(documents)).resolves.toBeUndefined();
  });

  it('buckets default pool snapshots into five-minute chart windows', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createPoolDocuments: (
        pools: Array<{
          id: string;
          baseAssetId: string;
          targetAssetId: string;
          baseAssetReserves: bigint;
          targetAssetReserves: bigint;
          poolAccount: string;
          poolTokenSupply: bigint;
          liquidityUSD: string;
          priceUSD: string;
        }>,
        analytics: {
          pools: Map<string, Map<string, unknown>>;
        },
        apyByPool: Map<string, string>,
        blockHeight: number,
        timestamp: number,
        includeSnapshots: boolean
      ) => Promise<Array<{ collection: string; id: string; data: Record<string, unknown> }>>;
    };
    const timestamp = 1_700_000_349;
    const poolId = `${XOR}-${KUSD}`;
    const analytics = {
      pools: new Map(),
    };

    const documents = await indexer.createPoolDocuments(
      [
        {
          id: poolId,
          baseAssetId: XOR,
          targetAssetId: KUSD,
          baseAssetReserves: 100n * SCALE,
          targetAssetReserves: 500n * SCALE,
          poolAccount: 'pool-account',
          poolTokenSupply: 1_000n * SCALE,
          liquidityUSD: '1000',
          priceUSD: '5',
        },
      ],
      analytics,
      new Map(),
      77,
      timestamp,
      true
    );

    const defaultSnapshot = documents.find((document) => document.collection === 'poolSnapshots' && document.data.type === 'DEFAULT');
    const daySnapshot = documents.find((document) => document.collection === 'poolSnapshots' && document.data.type === 'DAY');

    expect(defaultSnapshot?.id).toBe(`pool-${poolId}-DEFAULT-1700000100`);
    expect(defaultSnapshot?.data.timestamp).toBe(timestamp);
    expect(daySnapshot?.id).toBe(`pool-${poolId}-DAY-1699920000`);
    expect(
      documents
        .filter((document) => document.collection === 'poolSnapshots')
        .map((document) => document.data.type)
    ).toEqual(['DEFAULT', 'HOUR', 'DAY', 'MONTH']);
  });

  it('buckets default order book snapshots into five-minute chart windows', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createOrderBookDocuments: (
        orderBooks: unknown[],
        bids: unknown[],
        asks: unknown[],
        limitOrders: unknown[],
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        prices: Map<string, bigint>,
        analytics: {
          orderBooks: Map<string, Map<string, unknown>>;
          orderBookActiveReserves: Map<string, { baseAssetReserves: bigint; quoteAssetReserves: bigint; liquidityUSD: bigint }>;
          orderBookDayVolumeUSD: Map<string, bigint>;
          orderBookDayOpenPrice: Map<string, string>;
        },
        blockHeight: number,
        timestamp: number,
        includeSnapshots: boolean
      ) => Promise<Array<{ collection: string; id: string; data: Record<string, unknown> }>>;
    };
    const timestamp = 1_700_000_349;
    const orderBookId = `0-${XOR}-${KUSD}`;
    const assets = new Map([
      [XOR, { id: XOR, symbol: 'XOR', name: 'SORA', decimals: 18, supply: 1_000n * SCALE }],
      [KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18, supply: 1_000n * SCALE }],
    ]);
    const analytics = {
      orderBooks: new Map(),
      orderBookActiveReserves: new Map(),
      orderBookDayVolumeUSD: new Map(),
      orderBookDayOpenPrice: new Map(),
    };

    const documents = await indexer.createOrderBookDocuments(
      [[{ args: [{ dexId: 0, base: XOR, quote: KUSD }] }, { status: 'Trade' }]],
      [],
      [],
      [],
      assets,
      new Map([
        [XOR, 5n * SCALE],
        [KUSD, SCALE],
      ]),
      analytics,
      77,
      timestamp,
      true
    );

    const defaultSnapshot = documents.find(
      (document) => document.collection === 'orderBookSnapshots' && document.data.type === 'DEFAULT'
    );
    const daySnapshot = documents.find(
      (document) => document.collection === 'orderBookSnapshots' && document.data.type === 'DAY'
    );

    expect(defaultSnapshot?.id).toBe(`orderBook-${orderBookId}-DEFAULT-1700000100`);
    expect(defaultSnapshot?.data.timestamp).toBe(timestamp);
    expect(daySnapshot?.id).toBe(`orderBook-${orderBookId}-DAY-1699920000`);
    expect(
      documents
        .filter((document) => document.collection === 'orderBookSnapshots')
        .map((document) => document.data.type)
    ).toEqual(['DEFAULT', 'HOUR', 'DAY', 'MONTH']);
  });

  it('projects Polkamarkt runtime storage into production market documents', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createPolkamarktMarketDocuments: (
        conditions: unknown[],
        conditionDetails: unknown[],
        markets: unknown[],
        dpmCollaterals: unknown[],
        volumes: unknown[],
        totals: unknown[],
        resolutions: unknown[],
        resolutionEvidence: unknown[],
        cancellationEvidence: unknown[],
        creatorFees: unknown[],
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        blockHeight: number,
        timestamp: number,
        includeSnapshots?: boolean
      ) => Array<{ collection: string; id: string; data: Record<string, unknown> }>;
      createPolkamarktPositionDocuments: (
        positions: unknown[],
        markets: unknown[],
        dpmCollaterals: unknown[],
        totals: unknown[],
        resolutions: unknown[],
        dpmCostBasis: unknown[],
        dpmCostBasisTotals: unknown[],
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        blockHeight: number,
        timestamp: number
      ) => Array<{ collection: string; id: string; data: Record<string, unknown> }>;
    };
    const bytes = (value: string) => [...Buffer.from(value)];
    const assets = new Map([[KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18, supply: 0n }]]);

    const documents = indexer.createPolkamarktMarketDocuments(
      [[{ args: [7] }, { question: bytes('Will KUSD stay at peg?'), oracle: bytes('SORA Democracy'), resolutionSource: bytes('sora:governance:democracy:referendum:124') }]],
      [[{ args: [7] }, { category: bytes('Crypto'), tags: bytes('KUSD,peg'), metadataUri: bytes('ipfs://metadata'), metadataHash: new Array(32).fill(1), rulesUri: bytes('ipfs://rules') }]],
      [[{ args: [3] }, { creator: 'alice', conditionId: 7, closeBlock: 123_456, collateralAsset: KUSD, status: 'Open' }]],
      [[{ args: [3] }, (1_200n * SCALE).toString()]],
      [[{ args: [3] }, (250n * SCALE).toString()]],
      [[{ args: [3] }, { totalYesShares: (40n * SCALE).toString(), totalNoShares: (60n * SCALE).toString() }]],
      [],
      [[{ args: [3] }, { uri: bytes('ipfs://resolution'), hash: new Array(32).fill(2), atBlock: 99 }]],
      [],
      [[{ args: [3] }, (5n * SCALE).toString()]],
      assets,
      77,
      1_700_000_349
    );

    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      collection: 'markets',
      id: '3',
      data: {
        id: '3',
        marketId: 3,
        conditionId: 7,
        title: 'Will KUSD stay at peg?',
        category: 'Crypto',
        tags: 'KUSD,peg',
        description: 'Resolved by SORA Democracy. Resolution source: sora:governance:democracy:referendum:124.',
        metadataUri: 'ipfs://metadata',
        metadataHash: `0x${'01'.repeat(32)}`,
        rulesUri: 'ipfs://rules',
        oracle: 'SORA Democracy',
        resolutionSource: 'sora:governance:democracy:referendum:124',
        closeBlock: 123_456,
        status: 'Open',
        mechanism: 'DynamicPariMutuel',
        creatorFees: '5',
        liquidityUSD: '1200',
        volumeUSD: '250',
        probability: 46.66,
        priceYes: 0.4666,
        priceNo: 0.5333,
        virtualDepth: '100',
        dpmCollateral: '1200',
        realYesShares: '40',
        realNoShares: '60',
        marginalYesPriceBps: 6585,
        marginalNoPriceBps: 7525,
        impliedYesProbabilityBps: 4666,
        impliedNoProbabilityBps: 5333,
        resolutionEvidenceUri: 'ipfs://resolution',
        resolutionEvidenceHash: `0x${'02'.repeat(32)}`,
        resolutionEvidenceBlock: 99,
        governancePallet: 'democracy',
        governanceBody: 'Democracy',
        governanceKind: 'Referendum',
        governanceReferendumIndex: 124,
      },
    });

    const documentsWithSnapshots = indexer.createPolkamarktMarketDocuments(
      [[{ args: [7] }, { question: bytes('Will KUSD stay at peg?'), oracle: bytes('SORA Democracy'), resolutionSource: bytes('sora:governance:democracy:referendum:124') }]],
      [[{ args: [7] }, { category: bytes('Crypto') }]],
      [[{ args: [3] }, { creator: 'alice', conditionId: 7, closeBlock: 123_456, collateralAsset: KUSD, status: 'Open' }]],
      [[{ args: [3] }, (1_200n * SCALE).toString()]],
      [[{ args: [3] }, (250n * SCALE).toString()]],
      [[{ args: [3] }, { totalYesShares: (52n * SCALE).toString(), totalNoShares: (48n * SCALE).toString() }]],
      [],
      [],
      [],
      [],
      assets,
      79,
      1_700_000_650,
      true
    );
    const defaultSnapshot = documentsWithSnapshots.find(
      (document) => document.collection === 'marketSnapshots' && document.data.type === 'DEFAULT'
    );

    expect(defaultSnapshot).toMatchObject({
      collection: 'marketSnapshots',
      data: {
        marketId: 3,
        blockHeight: 79,
        type: 'DEFAULT',
        probability: 50.66,
        priceYes: 0.5066,
        priceNo: 0.4933,
        yesShares: '52',
        noShares: '48',
        virtualDepth: '100',
        dpmCollateral: '1200',
        realYesShares: '52',
        realNoShares: '48',
        marginalYesPriceBps: 7164,
        marginalNoPriceBps: 6976,
        impliedYesProbabilityBps: 5066,
        impliedNoProbabilityBps: 4933,
        liquidityUSD: '1200',
        volumeUSD: '250',
        status: 'Open',
      },
    });
    expect(
      documentsWithSnapshots
        .filter((document) => document.collection === 'marketSnapshots')
        .map((document) => document.data.type)
    ).toEqual(['DEFAULT', 'HOUR', 'DAY', 'MONTH']);

    const yesOnlyDocuments = indexer.createPolkamarktMarketDocuments(
      [[{ args: [7] }, { question: bytes('Will one-sided YES volume be projected?'), oracle: bytes('SORA Democracy'), resolutionSource: bytes('sora:governance:democracy:referendum:124') }]],
      [],
      [[{ args: [3] }, { creator: 'alice', conditionId: 7, closeBlock: 123_456, collateralAsset: KUSD, status: 'Open' }]],
      [[{ args: [3] }, (600n * SCALE).toString()]],
      [],
      [[{ args: [3] }, { totalYesShares: (12n * SCALE).toString(), totalNoShares: 0 }]],
      [],
      [],
      [],
      [],
      assets,
      80,
      1_700_000_700
    );

    expect(yesOnlyDocuments[0]).toMatchObject({
      collection: 'markets',
      id: '3',
      data: {
        probability: 52.83,
        priceYes: 0.5283,
        priceNo: 0.4716,
        virtualDepth: '100',
        dpmCollateral: '600',
        realYesShares: '12',
        realNoShares: '0',
        marginalYesPriceBps: 7459,
        marginalNoPriceBps: 6660,
        impliedYesProbabilityBps: 5283,
        impliedNoProbabilityBps: 4716,
      },
    });

    const migratedLegacyDocuments = indexer.createPolkamarktMarketDocuments(
      [[{ args: [7] }, { question: bytes('Will migrated markets stay frozen?'), oracle: bytes('SORA Democracy'), resolutionSource: bytes('sora:governance:democracy:referendum:124') }]],
      [],
      [[{ args: [3] }, { creator: 'alice', conditionId: 7, closeBlock: 123_456, collateralAsset: KUSD, status: 'Open', mechanism: 'MigratedLegacy' }]],
      [[{ args: [3] }, (600n * SCALE).toString()]],
      [],
      [[{ args: [3] }, { totalYesShares: (12n * SCALE).toString(), totalNoShares: 0 }]],
      [],
      [],
      [],
      [],
      assets,
      81,
      1_700_000_701,
      true
    );

    expect(migratedLegacyDocuments).toHaveLength(1);
    expect(migratedLegacyDocuments[0]).toMatchObject({
      collection: 'markets',
      id: '3',
      data: {
        mechanism: 'MigratedLegacy',
        probability: null,
        priceYes: null,
        priceNo: null,
        virtualDepth: '0',
        dpmCollateral: '0',
        realYesShares: '12',
        realNoShares: '0',
        marginalYesPriceBps: 0,
        marginalNoPriceBps: 0,
        impliedYesProbabilityBps: 0,
        impliedNoProbabilityBps: 0,
        liquidityUSD: '0',
      },
    });

    const zeroValueDocuments = indexer.createPolkamarktMarketDocuments(
      [[{ args: [0] }, { question: bytes('Will the first condition be indexed?'), oracle: bytes('SORA Council'), resolutionSource: bytes('sora:governance:council:motion:1') }]],
      [],
      [[{ args: [0] }, { creator: 'alice', conditionId: 0, closeBlock: 123_456, collateralAsset: KUSD, status: 'Open' }]],
      [],
      [],
      [],
      [],
      [],
      [],
      [],
      assets,
      78,
      1_700_000_350
    );

    expect(zeroValueDocuments).toHaveLength(1);
    expect(zeroValueDocuments[0]).toMatchObject({
      collection: 'markets',
      id: '0',
      data: {
        id: '0',
        marketId: 0,
        conditionId: 0,
        title: 'Will the first condition be indexed?',
        description: 'Resolved by SORA Council. Resolution source: sora:governance:council:motion:1.',
        creatorFees: '0',
      },
    });

    const positions = indexer.createPolkamarktPositionDocuments(
      [[{ args: [3, 'bob'] }, { yesShares: (12n * SCALE).toString(), noShares: 0, netCollateralPaid: (6n * SCALE).toString() }]],
      [[{ args: [3] }, { creator: 'alice', conditionId: 7, closeBlock: 123_456, collateralAsset: KUSD, status: 'Resolved' }]],
      [[{ args: [3] }, (1_200n * SCALE).toString()]],
      [[{ args: [3] }, { totalYesShares: (12n * SCALE).toString(), totalNoShares: 0, totalNetCollateralPaid: (6n * SCALE).toString() }]],
      [[{ args: [3] }, 'Yes']],
      [[{ args: [3, 'bob'] }, { yes: (6n * SCALE).toString(), no: 0 }]],
      [[{ args: [3] }, { yes: (6n * SCALE).toString(), no: 0 }]],
      assets,
      77,
      1_700_000_349
    );

    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({
      collection: 'accountPositions',
      id: '3-bob',
      data: {
        account: 'bob',
        marketId: 3,
        outcome: 'Yes',
        shares: '12',
        yesShares: '12',
        noShares: '0',
        netCollateralPaid: '6',
        costBasisUsd: '6',
        yesCostBasisUsd: '6',
        noCostBasisUsd: '0',
        claimablePayoutUsd: '1200',
        marketValueUsd: '1200',
        realizedPnlUsd: null,
        unrealizedPnlUsd: '1194',
        isCreator: false,
        status: 'Resolved',
        market: { id: '3', marketId: 3 },
      },
    });
  });

  it('hardens Polkamarkt market projection against malformed storage and partial upgrades', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createPolkamarktMarketDocuments: (
        conditions: unknown[],
        conditionDetails: unknown[],
        markets: unknown[],
        dpmCollaterals: unknown[],
        volumes: unknown[],
        totals: unknown[],
        resolutions: unknown[],
        resolutionEvidence: unknown[],
        cancellationEvidence: unknown[],
        creatorFees: unknown[],
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        blockHeight: number,
        timestamp: number
      ) => Array<{ collection: string; id: string; data: Record<string, unknown> }>;
    };
    const bytes = (value: string) => [...Buffer.from(value)];
    const invalidUtf8 = [0xff, 0xfe, 0xfd];
    const assets = new Map([[KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18, supply: 0n }]]);

    const documents = indexer.createPolkamarktMarketDocuments(
      [
        [{ args: [7] }, { question: invalidUtf8, oracle: bytes('bad oracle'), resolutionSource: bytes('bad source') }],
        [{ args: [8] }, { question: bytes('Will malformed metadata be ignored?'), oracle: bytes('SORA Council'), resolutionSource: bytes('sora:governance:council:motion:not-a-number') }],
      ],
      [[{ args: [8] }, { category: invalidUtf8, tags: bytes('safe,metadata'), metadataUri: invalidUtf8, metadataHash: [1, 256], rulesUri: bytes('ipfs://rules') }]],
      [
        [{ args: ['not-a-number'] }, { creator: 'mallory', conditionId: 8, closeBlock: 111, collateralAsset: KUSD, status: 'Open' }],
        [{ args: [3] }, { creator: 'alice', conditionId: 7, closeBlock: 111, collateralAsset: KUSD, status: 'Open' }],
        [{ args: [4] }, { creator: 'alice', conditionId: 8, closeBlock: 222, collateralAsset: KUSD, status: { open: null } }],
      ],
      [[{ args: [4] }, 'not-a-balance']],
      [],
      [[{ args: [4] }, 'not-a-balance']],
      [[{ args: [4] }, { no: null }]],
      [[{ args: [4] }, { uri: invalidUtf8, hash: '0xzz', atBlock: 'bad-block' }]],
      [[{ args: [4] }, { uri: invalidUtf8, hash: [2, -1], atBlock: 0 }]],
      [[{ args: [4] }, 'bad-fee']],
      assets,
      88,
      1_700_000_555
    );

    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({
      collection: 'markets',
      id: '4',
      data: {
        marketId: 4,
        conditionId: 8,
        title: 'Will malformed metadata be ignored?',
        category: 'Other',
        tags: 'safe,metadata',
        metadataUri: null,
        metadataHash: null,
        rulesUri: 'ipfs://rules',
        status: 'Open',
        liquidityUSD: '0',
        volumeUSD: '0',
        creatorFees: '0',
        resolutionOutcome: 'No',
        resolutionEvidenceUri: null,
        resolutionEvidenceHash: null,
        resolutionEvidenceBlock: null,
        cancellationEvidenceUri: null,
        cancellationEvidenceHash: null,
        cancellationEvidenceBlock: null,
      },
    });
    expect(documents[0].data.governancePallet).toBeUndefined();
    expect(documents[0].data.governanceKind).toBeUndefined();
  });

  it('hardens Polkamarkt position projection against orphaned, zero, and malformed entries', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createPolkamarktPositionDocuments: (
        positions: unknown[],
        markets: unknown[],
        dpmCollaterals: unknown[],
        totals: unknown[],
        resolutions: unknown[],
        dpmCostBasis: unknown[],
        dpmCostBasisTotals: unknown[],
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        blockHeight: number,
        timestamp: number
      ) => Array<{ collection: string; id: string; data: Record<string, unknown> }>;
    };
    const assets = new Map([[KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18, supply: 0n }]]);

    const documents = indexer.createPolkamarktPositionDocuments(
      [
        [{ args: ['bad-market', 'mallory'] }, { yesShares: (1n * SCALE).toString(), noShares: 0, netCollateralPaid: 0 }],
        [{ args: [3, ''] }, { yesShares: (1n * SCALE).toString(), noShares: 0, netCollateralPaid: 0 }],
        [{ args: [99, 'orphan'] }, { yesShares: (1n * SCALE).toString(), noShares: 0, netCollateralPaid: 0 }],
        [{ args: [3, 'zero'] }, { yesShares: 0, noShares: 0, netCollateralPaid: 0 }],
        [{ args: [3, 'bob'] }, { yesShares: (5n * SCALE).toString(), noShares: 0, netCollateralPaid: (2n * SCALE).toString() }],
        [
          { args: [3, 'carol'] },
          { yesShares: (5n * SCALE).toString(), noShares: 0, netCollateralPaid: (2n * SCALE).toString() },
        ],
      ],
      [[{ args: [3] }, { creator: 'alice', conditionId: 8, closeBlock: 222, collateralAsset: KUSD, status: 'Cancelled' }]],
      [[{ args: [3] }, (1_000n * SCALE).toString()]],
      [[{ args: [3] }, { totalYesShares: 0, totalNoShares: 0, totalNetCollateralPaid: (100n * SCALE).toString() }]],
      [],
      [[{ args: [3, 'bob'] }, { yes: (2n * SCALE).toString(), no: 0 }]],
      [[{ args: [3] }, { yes: (100n * SCALE).toString(), no: 0 }]],
      assets,
      88,
      1_700_000_555
    );

    expect(documents.map((document) => document.id).sort()).toEqual(['3-bob', '3-carol']);
    expect(documents.find((document) => document.id === '3-bob')).toMatchObject({
      data: {
        account: 'bob',
        marketId: 3,
        yesShares: '5',
        noShares: '0',
        netCollateralPaid: '2',
        yesCostBasisUsd: '2',
        noCostBasisUsd: '0',
        claimablePayoutUsd: '20',
        marketValueUsd: '20',
        unrealizedPnlUsd: '18',
      },
    });
    expect(documents.find((document) => document.id === '3-carol')).toMatchObject({
      data: {
        account: 'carol',
        marketId: 3,
        yesShares: '5',
        noShares: '0',
        netCollateralPaid: '2',
        costBasisUsd: null,
        yesCostBasisUsd: null,
        noCostBasisUsd: null,
        claimablePayoutUsd: null,
        marketValueUsd: null,
        unrealizedPnlUsd: null,
      },
    });
  });

  it('leaves unresolved Polkamarkt positions without fake mark-to-market PnL', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createPolkamarktPositionDocuments: (
        positions: unknown[],
        markets: unknown[],
        dpmCollaterals: unknown[],
        totals: unknown[],
        resolutions: unknown[],
        dpmCostBasis: unknown[],
        dpmCostBasisTotals: unknown[],
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        blockHeight: number,
        timestamp: number
      ) => Array<{ collection: string; id: string; data: Record<string, unknown> }>;
    };
    const assets = new Map([[KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18, supply: 0n }]]);

    const documents = indexer.createPolkamarktPositionDocuments(
      [[{ args: [3, 'bob'] }, { yesShares: (5n * SCALE).toString(), noShares: 0, netCollateralPaid: (2n * SCALE).toString() }]],
      [[{ args: [3] }, { creator: 'alice', conditionId: 8, closeBlock: 222, collateralAsset: KUSD, status: 'Open' }]],
      [[{ args: [3] }, (1_000n * SCALE).toString()]],
      [[{ args: [3] }, { totalYesShares: (5n * SCALE).toString(), totalNoShares: 0, totalNetCollateralPaid: (2n * SCALE).toString() }]],
      [],
      [[{ args: [3, 'bob'] }, { yes: (2n * SCALE).toString(), no: 0 }]],
      [[{ args: [3] }, { yes: (2n * SCALE).toString(), no: 0 }]],
      assets,
      88,
      1_700_000_555
    );

    expect(documents[0]?.data).toMatchObject({
      costBasisUsd: '2',
      yesCostBasisUsd: '2',
      noCostBasisUsd: '0',
      marketValueUsd: null,
      realizedPnlUsd: null,
      unrealizedPnlUsd: null,
      claimablePayoutUsd: '0',
    });
  });

  it('enriches Polkamarkt sell and claim rows with realized PnL when prior basis is indexed', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      {
        collection: 'accountPositions',
        id: '7-alice',
        blockHeight: 10,
        timestamp: 100,
        data: {
          id: '7-alice',
          account: 'alice',
          marketId: 7,
          yesShares: '10',
          noShares: '0',
          costBasisUsd: '999',
          yesCostBasisUsd: '6',
          noCostBasisUsd: '0',
        },
      },
      {
        collection: 'accountPositions',
        id: '8-alice',
        blockHeight: 10,
        timestamp: 100,
        data: {
          id: '8-alice',
          account: 'alice',
          marketId: 8,
          yesShares: '1',
          noShares: '1',
          costBasisUsd: '999',
          yesCostBasisUsd: '2',
          noCostBasisUsd: '1',
        },
      },
    ]);
    const indexer = new ChainIndexer(config, repository) as unknown as {
      enrichPolkamarktRealizedPnl: (contexts: any[]) => Promise<void>;
    };
    const sellContext = {
      id: 'sell',
      module: 'polkamarkt',
      method: 'sell',
      address: 'alice',
      failed: false,
      history: {
        data: { marketId: 7, side: 'sell', outcome: 'YES', collateralUsd: '4', shares: '5' },
        from: 'alice',
        to: '',
        assets: [],
      },
      calls: [],
      callNames: [],
      events: [],
      accounts: ['alice'],
      fee: 0n,
    };
    const claimContext = {
      id: 'claim',
      module: 'polkamarkt',
      method: 'claim_market',
      address: 'alice',
      failed: false,
      history: {
        data: { marketId: 8, side: 'claim', collateralUsd: '5' },
        from: 'alice',
        to: '',
        assets: [],
      },
      calls: [],
      callNames: [],
      events: [
        eventRecord('polkamarkt', 'MarketClaimed', { marketId: 8, trader: 'alice', payout: (5n * SCALE).toString() }, 0),
      ],
      accounts: ['alice'],
      fee: 0n,
    };

    await indexer.enrichPolkamarktRealizedPnl([sellContext, claimContext]);

    expect((sellContext.history.data as Record<string, unknown>).realizedPnlUsd).toBe('1');
    expect((claimContext.history.data as Record<string, unknown>).realizedPnlUsd).toBe('2');
  });

  it('only enriches batch claim realized PnL when every claimed market has prior basis', async () => {
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'accountPositions',
      id: '7-alice',
      blockHeight: 10,
      timestamp: 100,
      data: {
        id: '7-alice',
        account: 'alice',
        marketId: 7,
        costBasisUsd: '999',
        yesCostBasisUsd: '2',
        noCostBasisUsd: '0',
      },
    });
    const indexer = new ChainIndexer(config, repository) as unknown as {
      enrichPolkamarktRealizedPnl: (contexts: any[]) => Promise<void>;
    };
    const completeBatch = {
      id: 'complete-batch',
      module: 'polkamarkt',
      method: 'claim_markets',
      address: 'alice',
      failed: false,
      history: { data: { side: 'claim', collateralUsd: '5' }, from: 'alice', to: '', assets: [] },
      calls: [],
      callNames: [],
      events: [
        eventRecord('polkamarkt', 'MarketClaimed', { marketId: 7, trader: 'alice', payout: (5n * SCALE).toString() }, 0),
      ],
      accounts: ['alice'],
      fee: 0n,
    };
    const incompleteBatch = {
      id: 'incomplete-batch',
      module: 'polkamarkt',
      method: 'claim_markets',
      address: 'alice',
      failed: false,
      history: { data: { side: 'claim', collateralUsd: '6' }, from: 'alice', to: '', assets: [] },
      calls: [],
      callNames: [],
      events: [
        eventRecord('polkamarkt', 'MarketClaimed', { marketId: 7, trader: 'alice', payout: (5n * SCALE).toString() }, 0),
        eventRecord('polkamarkt', 'MarketClaimed', { marketId: 9, trader: 'alice', payout: (1n * SCALE).toString() }, 0),
      ],
      accounts: ['alice'],
      fee: 0n,
    };

    await indexer.enrichPolkamarktRealizedPnl([completeBatch, incompleteBatch]);

    expect((completeBatch.history.data as Record<string, unknown>).realizedPnlUsd).toBe('3');
    expect((incompleteBatch.history.data as Record<string, unknown>).realizedPnlUsd).toBeUndefined();
  });

  it('does not enrich Polkamarkt realized PnL from aggregate-only cost basis', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      {
        collection: 'accountPositions',
        id: '7-alice',
        blockHeight: 10,
        timestamp: 100,
        data: {
          id: '7-alice',
          account: 'alice',
          marketId: 7,
          yesShares: '10',
          noShares: '0',
          costBasisUsd: '6',
        },
      },
      {
        collection: 'accountPositions',
        id: '8-alice',
        blockHeight: 10,
        timestamp: 100,
        data: {
          id: '8-alice',
          account: 'alice',
          marketId: 8,
          costBasisUsd: '2',
        },
      },
    ]);
    const indexer = new ChainIndexer(config, repository) as unknown as {
      enrichPolkamarktRealizedPnl: (contexts: any[]) => Promise<void>;
    };
    const sellContext = {
      id: 'sell',
      module: 'polkamarkt',
      method: 'sell',
      address: 'alice',
      failed: false,
      history: {
        data: { marketId: 7, side: 'sell', outcome: 'YES', collateralUsd: '4', shares: '5' },
        from: 'alice',
        to: '',
        assets: [],
      },
      calls: [],
      callNames: [],
      events: [],
      accounts: ['alice'],
      fee: 0n,
    };
    const claimContext = {
      id: 'claim',
      module: 'polkamarkt',
      method: 'claim_market',
      address: 'alice',
      failed: false,
      history: {
        data: { marketId: 8, side: 'claim', collateralUsd: '5' },
        from: 'alice',
        to: '',
        assets: [],
      },
      calls: [],
      callNames: [],
      events: [
        eventRecord('polkamarkt', 'MarketClaimed', { marketId: 8, trader: 'alice', payout: (5n * SCALE).toString() }, 0),
      ],
      accounts: ['alice'],
      fee: 0n,
    };

    await indexer.enrichPolkamarktRealizedPnl([sellContext, claimContext]);

    expect((sellContext.history.data as Record<string, unknown>).realizedPnlUsd).toBeUndefined();
    expect((claimContext.history.data as Record<string, unknown>).realizedPnlUsd).toBeUndefined();
  });

  it('deletes stale Polkamarkt account positions after zero or removed storage entries', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      {
        collection: 'accountPositions',
        id: '3-bob',
        blockHeight: 70,
        timestamp: 1_700_000_000,
        data: { id: '3-bob', account: 'bob', marketId: 3, yesShares: '1' },
      },
      {
        collection: 'accountPositions',
        id: '3-zero',
        blockHeight: 70,
        timestamp: 1_700_000_000,
        data: { id: '3-zero', account: 'zero', marketId: 3, yesShares: '9' },
      },
      {
        collection: 'accountPositions',
        id: '4-absent',
        blockHeight: 70,
        timestamp: 1_700_000_000,
        data: { id: '4-absent', account: 'absent', marketId: 4, yesShares: '7' },
      },
    ]);
    const indexer = new ChainIndexer(config, repository) as unknown as {
      createPolkamarktPositionDocuments: (
        positions: unknown[],
        markets: unknown[],
        dpmCollaterals: unknown[],
        totals: unknown[],
        resolutions: unknown[],
        dpmCostBasis: unknown[],
        dpmCostBasisTotals: unknown[],
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        blockHeight: number,
        timestamp: number
      ) => IndexerDocument[];
      deleteStaleAccountPositionDocuments: (activeDocuments: IndexerDocument[]) => Promise<void>;
    };
    const assets = new Map([[KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18, supply: 0n }]]);
    const activeDocuments = indexer.createPolkamarktPositionDocuments(
      [
        [{ args: [3, 'bob'] }, { yesShares: (5n * SCALE).toString(), noShares: 0, netCollateralPaid: (2n * SCALE).toString() }],
        [{ args: [3, 'zero'] }, { yesShares: 0, noShares: 0, netCollateralPaid: 0 }],
      ],
      [[{ args: [3] }, { creator: 'alice', conditionId: 8, closeBlock: 222, collateralAsset: KUSD, status: 'Open' }]],
      [[{ args: [3] }, (1_000n * SCALE).toString()]],
      [[{ args: [3] }, { totalYesShares: 0, totalNoShares: 0, totalNetCollateralPaid: 0 }]],
      [],
      [],
      [],
      assets,
      88,
      1_700_000_555
    );

    expect(activeDocuments.map((document) => document.id)).toEqual(['3-bob']);

    await repository.upsertMany(activeDocuments);
    await indexer.deleteStaleAccountPositionDocuments(activeDocuments);

    expect((await repository.get('accountPositions', '3-bob'))?.data.yesShares).toBe('5');
    await expect(repository.get('accountPositions', '3-zero')).resolves.toBeNull();
    await expect(repository.get('accountPositions', '4-absent')).resolves.toBeNull();
  });

  it('streams stale Polkamarkt positions in bounded ID pages and delete batches', async () => {
    const repository = new MemoryRepository();
    const documents: IndexerDocument[] = Array.from({ length: 2_505 }, (_item, index) => {
      const id = `position-${String(index).padStart(5, '0')}`;
      return {
        collection: 'accountPositions',
        id,
        blockHeight: 70,
        timestamp: 1_700_000_000,
        data: { id, account: `account-${index}`, marketId: index },
      };
    });
    await repository.upsertMany(documents);
    const activeDocuments = documents.filter((_document, index) => index % 500 === 0);
    const query = vi.spyOn(repository, 'query');
    const deleteMany = vi.spyOn(repository, 'deleteMany');
    const indexer = new ChainIndexer(config, repository) as unknown as {
      deleteStaleAccountPositionDocuments: (activeDocuments: IndexerDocument[]) => Promise<void>;
    };

    await indexer.deleteStaleAccountPositionDocuments(activeDocuments);

    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1]?.[1]).toMatchObject({
      orderBy: ['ID_ASC'],
      offset: null,
      keyset: { field: 'id', direction: 'asc', numeric: false },
    });
    expect(deleteMany.mock.calls.every((call) => call[1].length <= 1_000)).toBe(true);
    expect(deleteMany.mock.calls.reduce((total, call) => total + call[1].length, 0)).toBe(
      documents.length - activeDocuments.length
    );
    await expect(repository.list('accountPositions')).resolves.toHaveLength(activeDocuments.length);
  });

  it('reconciles more than one write-call cap of stale authoritative rows in bounded pages', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      upsertDocumentsInCallChunks: (documents: IndexerDocument[]) => Promise<void>;
      reconcileAuthoritativeCollection: (
        collectionName: 'assets',
        activeIds: Iterable<string>,
        blockHeight: number
      ) => Promise<void>;
    };
    const documents: IndexerDocument[] = Array.from(
      { length: MAX_REPOSITORY_WRITE_CALL_DOCUMENTS + 5 },
      (_item, index) => {
        const id = `asset-${String(index).padStart(5, '0')}`;
        return {
          collection: 'assets',
          id,
          blockHeight: 10,
          timestamp: 10,
          data: { id, priceUSD: '1' },
        };
      }
    );
    await indexer.upsertDocumentsInCallChunks(documents);
    const activeIds = documents.slice(-5).map((document) => document.id);
    const query = vi.spyOn(repository, 'query');
    const deleteMany = vi.spyOn(repository, 'deleteMany');

    await indexer.reconcileAuthoritativeCollection('assets', activeIds, 10);

    expect(query.mock.calls.length).toBeGreaterThan(10);
    expect(deleteMany.mock.calls.every((call) => call[1].length <= 1_000)).toBe(true);
    expect((await repository.list('assets')).map((document) => document.id)).toEqual(activeIds);
  });

  it('keeps an immutable authoritative retry plan and never deletes newer rows', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      pendingAuthoritativeReconciliations: Map<
        string,
        { activeIds: Set<string>; blockHeight: number }
      >;
      queueAuthoritativeReconciliation: (
        collectionName: 'assets',
        activeIds: Iterable<string>,
        blockHeight: number
      ) => void;
      reconcilePendingAuthoritativeCollection: (collectionName: 'assets') => Promise<void>;
    };
    await repository.upsertMany([
      { collection: 'assets', id: 'active', blockHeight: 100, timestamp: 100, data: { id: 'active', priceUSD: '1' } },
      { collection: 'assets', id: 'stale', blockHeight: 100, timestamp: 100, data: { id: 'stale', priceUSD: '1' } },
      { collection: 'assets', id: 'newer', blockHeight: 101, timestamp: 101, data: { id: 'newer', priceUSD: '1' } },
    ]);
    indexer.queueAuthoritativeReconciliation('assets', ['active'], 100);
    const immutablePlan = indexer.pendingAuthoritativeReconciliations.get('assets');
    const deleteMany = vi.spyOn(repository, 'deleteMany');
    deleteMany.mockRejectedValueOnce(new Error('delete failed'));

    await expect(indexer.reconcilePendingAuthoritativeCollection('assets')).rejects.toThrow('delete failed');
    expect(indexer.pendingAuthoritativeReconciliations.get('assets')).toBe(immutablePlan);
    expect(await repository.get('assets', 'stale')).not.toBeNull();

    await indexer.reconcilePendingAuthoritativeCollection('assets');
    expect(await repository.get('assets', 'active')).not.toBeNull();
    expect(await repository.get('assets', 'stale')).toBeNull();
    expect(await repository.get('assets', 'newer')).not.toBeNull();
  });

  it('does not emit price chart snapshots when snapshots are disabled', async () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createAssetDocuments: (
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        prices: Map<string, bigint>,
        liquidity: Map<string, bigint>,
        analytics: {
          assets: Map<string, Map<string, unknown>>;
          assetDayVolumeUSD: Map<string, bigint>;
          assetWeekVolumeUSD: Map<string, bigint>;
          assetDayOpenPrice: Map<string, string>;
          assetWeekOpenPrice: Map<string, string>;
          assetOrderBookLiquidity: Map<string, bigint>;
        },
        blockHeight: number,
        timestamp: number,
        includeSnapshots: boolean
      ) => Promise<Array<{ collection: string; id: string; data: Record<string, unknown> }>>;
      createPoolDocuments: (
        pools: Array<{
          id: string;
          baseAssetId: string;
          targetAssetId: string;
          baseAssetReserves: bigint;
          targetAssetReserves: bigint;
          poolAccount: string;
          poolTokenSupply: bigint;
          liquidityUSD: string;
          priceUSD: string;
        }>,
        analytics: {
          pools: Map<string, Map<string, unknown>>;
        },
        apyByPool: Map<string, string>,
        blockHeight: number,
        timestamp: number,
        includeSnapshots: boolean
      ) => Promise<Array<{ collection: string; id: string; data: Record<string, unknown> }>>;
      createOrderBookDocuments: (
        orderBooks: unknown[],
        bids: unknown[],
        asks: unknown[],
        limitOrders: unknown[],
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        prices: Map<string, bigint>,
        analytics: {
          orderBooks: Map<string, Map<string, unknown>>;
          orderBookActiveReserves: Map<string, { baseAssetReserves: bigint; quoteAssetReserves: bigint; liquidityUSD: bigint }>;
          orderBookDayVolumeUSD: Map<string, bigint>;
          orderBookDayOpenPrice: Map<string, string>;
        },
        blockHeight: number,
        timestamp: number,
        includeSnapshots: boolean
      ) => Promise<Array<{ collection: string; id: string; data: Record<string, unknown> }>>;
    };
    const timestamp = 1_700_000_349;
    const assets = new Map([
      [XOR, { id: XOR, symbol: 'XOR', name: 'SORA', decimals: 18, supply: 1_000n * SCALE }],
      [KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18, supply: 1_000n * SCALE }],
    ]);
    const poolId = `${XOR}-${KUSD}`;
    const assetAnalytics = {
      assets: new Map(),
      assetDayVolumeUSD: new Map(),
      assetWeekVolumeUSD: new Map(),
      assetDayOpenPrice: new Map(),
      assetWeekOpenPrice: new Map(),
      assetOrderBookLiquidity: new Map(),
    };
    const poolAnalytics = {
      pools: new Map(),
    };
    const orderBookAnalytics = {
      orderBooks: new Map(),
      orderBookActiveReserves: new Map(),
      orderBookDayVolumeUSD: new Map(),
      orderBookDayOpenPrice: new Map(),
    };

    const assetDocuments = await indexer.createAssetDocuments(
      assets,
      new Map([[XOR, 5n * SCALE]]),
      new Map(),
      assetAnalytics,
      77,
      timestamp,
      false
    );
    const poolDocuments = await indexer.createPoolDocuments(
      [
        {
          id: poolId,
          baseAssetId: XOR,
          targetAssetId: KUSD,
          baseAssetReserves: 100n * SCALE,
          targetAssetReserves: 500n * SCALE,
          poolAccount: 'pool-account',
          poolTokenSupply: 1_000n * SCALE,
          liquidityUSD: '1000',
          priceUSD: '5',
        },
      ],
      poolAnalytics,
      new Map(),
      77,
      timestamp,
      false
    );
    const orderBookDocuments = await indexer.createOrderBookDocuments(
      [[{ args: [{ dexId: 0, base: XOR, quote: KUSD }] }, { status: 'Trade' }]],
      [],
      [],
      [],
      assets,
      new Map([
        [XOR, 5n * SCALE],
        [KUSD, SCALE],
      ]),
      orderBookAnalytics,
      77,
      timestamp,
      false
    );

    expect(assetDocuments.map((document) => document.collection)).toEqual(['assets', 'assets']);
    expect(poolDocuments.map((document) => document.collection)).toEqual(['poolXYKs']);
    expect(orderBookDocuments.map((document) => document.collection)).toEqual(['orderBooks']);
  });

  it('creates network snapshots only for aggregate windows', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createNetworkSnapshotDocuments: (
        analytics: unknown,
        blockHeight: number,
        timestamp: number,
        includeSnapshots: boolean
      ) => Array<{ collection: string; id: string; data: Record<string, unknown> }>;
    };
    const analytics = {
      network: new Map([
        [
          'DEFAULT',
          {
            accounts: 10,
            transactions: 3,
            fees: 123n,
            liquidityUSD: '456.5',
            poolLiquidityUSD: '400.25',
            orderBookLiquidityUSD: '56.25',
            volumeUSD: 789n * SCALE,
            swaps: 2,
            activePools: 7,
            activeOrderBooks: 4,
            listedAssets: 21,
            bridgeIncomingTransactions: 1,
            bridgeOutgoingTransactions: 2,
          },
        ],
      ]),
    };

    expect(indexer.createNetworkSnapshotDocuments(analytics, 10, 1_700_000_000, false)).toEqual([]);
    const documents = indexer.createNetworkSnapshotDocuments(analytics, 10, 1_700_000_000, true);

    expect(documents.map((document) => document.data.type)).toEqual(['DEFAULT', 'HOUR', 'DAY', 'MONTH']);
    expect(documents[0].id).toBe('network-all-DEFAULT-1699999800');
    expect(documents[0]).toMatchObject({
      collection: 'networkSnapshots',
      data: {
        accounts: 10,
        transactions: 3,
        fees: '123',
        liquidityUSD: '456.5',
        poolLiquidityUSD: '400.25',
        orderBookLiquidityUSD: '56.25',
        volumeUSD: '789',
        swaps: 2,
        activePools: 7,
        activeOrderBooks: 4,
        listedAssets: 21,
        bridgeIncomingTransactions: 1,
        bridgeOutgoingTransactions: 2,
      },
    });
  });

  it('does not let block height change default network aggregate buckets', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createNetworkSnapshotDocuments: (
        analytics: unknown,
        blockHeight: number,
        timestamp: number,
        includeSnapshots: boolean
      ) => Array<{ collection: string; id: string; data: Record<string, unknown> }>;
    };
    const analytics = {
      network: new Map(),
    };
    const timestamp = 1_700_000_349;

    const firstBlockDocuments = indexer.createNetworkSnapshotDocuments(analytics, 77, timestamp, true);
    const secondBlockDocuments = indexer.createNetworkSnapshotDocuments(analytics, 78, timestamp, true);
    const firstDefault = firstBlockDocuments.find((document) => document.data.type === 'DEFAULT');
    const secondDefault = secondBlockDocuments.find((document) => document.data.type === 'DEFAULT');

    expect(firstBlockDocuments.some((document) => document.data.type === 'BLOCK')).toBe(false);
    expect(firstDefault?.id).toBe(secondDefault?.id);
    expect(firstDefault?.id).toBe('network-all-DEFAULT-1700000100');
  });

  it('retires stale DEFAULT and HOUR rows by indexed type/time, including removed entities', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      retireExpiredChartSnapshotBuckets: (
        groups: Array<{ collection: string; types?: string[] }>,
        blockHeight: number,
        timestamp: number
      ) => Promise<void>;
    };
    const timestamp = 10_000_000;
    const defaultCutoff = timestamp - 48 * 60 * 60;
    const hourCutoff = timestamp - 8 * 24 * 60 * 60;
    const groups = [
      { collection: 'accountLiquiditySnapshots', types: ['DEFAULT'] },
      { collection: 'assetSnapshots' },
      { collection: 'poolSnapshots' },
      { collection: 'orderBookSnapshots' },
      { collection: 'marketSnapshots' },
      { collection: 'networkSnapshots' },
    ];
    const documents: IndexerDocument[] = [];
    for (const [groupIndex, group] of groups.entries()) {
      const types = group.types ?? ['DEFAULT', 'HOUR'];
      for (const type of types) {
        const cutoff = type === 'DEFAULT' ? defaultCutoff : hourCutoff;
        for (const [suffix, rowTimestamp] of [['removed-old', cutoff - 1], ['boundary', cutoff]] as const) {
          const id = `${group.collection}-${groupIndex}-${type}-${suffix}`;
          documents.push({
            collection: group.collection as IndexerDocument['collection'],
            id,
            blockHeight: 1,
            timestamp: rowTimestamp,
            data: { id, type, timestamp: rowTimestamp },
          });
        }
      }
      for (const type of ['DAY', 'MONTH', 'BLOCK'] as const) {
        const rowTimestamp = defaultCutoff - 1;
        const id = `${group.collection}-${groupIndex}-${type}`;
        documents.push({
          collection: group.collection as IndexerDocument['collection'],
          id,
          blockHeight: 1,
          timestamp: rowTimestamp,
          data: { id, type, timestamp: rowTimestamp },
        });
      }
    }
    await repository.upsertMany(documents);

    await indexer.retireExpiredChartSnapshotBuckets(groups, 10, timestamp);

    for (const [groupIndex, group] of groups.entries()) {
      const remaining = await repository.list(group.collection as IndexerDocument['collection']);
      expect(remaining.some((document) => document.id.includes('removed-old'))).toBe(false);
      expect(remaining.map((document) => document.data.type)).toEqual(
        expect.arrayContaining([...(group.types ?? ['DEFAULT', 'HOUR']), 'DAY', 'MONTH', 'BLOCK'])
      );
      expect(remaining.some((document) => document.id.includes(`${groupIndex}`))).toBe(true);
    }
    expect(await repository.get('updatesStreams', 'chartSnapshotRetention-v1')).toBeNull();
  });

  it('bounds query-based retention catch-up and resumes from successfully deleted rows', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      retireExpiredChartSnapshotBuckets: (
        groups: Array<{ collection: string }>,
        blockHeight: number,
        timestamp: number
      ) => Promise<void>;
    };
    const timestamp = 10_000_000;
    const cutoff = timestamp - 48 * 60 * 60;
    const groups = [{ collection: 'assetSnapshots' }];
    const documents: IndexerDocument[] = Array.from({ length: 4_005 }, (_item, index) => {
      const id = `removed-asset-${String(index).padStart(5, '0')}`;
      return {
        collection: 'assetSnapshots' as const,
        id,
        blockHeight: 1,
        timestamp: cutoff - 4_005 + index,
        data: { id, assetId: `removed-${index}`, type: 'DEFAULT', timestamp: cutoff - 4_005 + index },
      };
    });
    await repository.upsertMany(documents);
    const query = vi.spyOn(repository, 'query');
    const deleteMany = vi.spyOn(repository, 'deleteMany');

    await indexer.retireExpiredChartSnapshotBuckets(groups, 2, timestamp);

    expect(query).toHaveBeenCalledTimes(5); // four DEFAULT pages plus an empty HOUR probe
    expect(deleteMany.mock.calls.every((call) => call[1].length <= 1_000)).toBe(true);
    expect(await repository.list('assetSnapshots')).toHaveLength(5);

    await indexer.retireExpiredChartSnapshotBuckets(groups, 3, timestamp);
    expect(await repository.list('assetSnapshots')).toHaveLength(0);
  });

  it('retries the same retention page after a delete failure', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      retireExpiredChartSnapshotBuckets: (
        groups: Array<{ collection: string }>,
        blockHeight: number,
        timestamp: number
      ) => Promise<void>;
    };
    const baseTimestamp = 10_000_000;
    const groups = [{ collection: 'marketSnapshots' }];
    const id = 'removed-market-default';
    await repository.upsert({
      collection: 'marketSnapshots',
      id,
      blockHeight: 1,
      timestamp: baseTimestamp - 48 * 60 * 60 - 1,
      data: { id, marketId: 7, type: 'DEFAULT', timestamp: baseTimestamp - 48 * 60 * 60 - 1 },
    });
    const deleteMany = vi.spyOn(repository, 'deleteMany');
    deleteMany.mockRejectedValueOnce(new Error('delete failed'));

    await expect(indexer.retireExpiredChartSnapshotBuckets(groups, 2, baseTimestamp)).rejects.toThrow(
      'delete failed'
    );
    expect(await repository.get('marketSnapshots', id)).not.toBeNull();

    await expect(indexer.retireExpiredChartSnapshotBuckets(groups, 2, baseTimestamp)).resolves.toBeUndefined();
    expect(await repository.get('marketSnapshots', id)).toBeNull();
  });

  it('retains a full rolling month plus overlap while deleting only older network BLOCK rows', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      retireExpiredNetworkBlockSnapshots: (timestamp: number) => Promise<void>;
    };
    const timestamp = 10_000_000;
    const cutoff = timestamp - 31 * 86_400;
    const oldBlock = createBlockNetworkSnapshot(1, cutoff - 1, { transactions: 1 });
    const boundaryBlock = createBlockNetworkSnapshot(2, cutoff, { transactions: 2 });
    const monthBlock = createBlockNetworkSnapshot(3, timestamp - 30 * 86_400, { transactions: 3 });
    const dayId = 'network-all-DAY-old';
    const monthId = 'network-all-MONTH-old';
    await repository.upsertMany([
      oldBlock,
      boundaryBlock,
      monthBlock,
      {
        collection: 'networkSnapshots',
        id: dayId,
        blockHeight: 1,
        timestamp: cutoff - 1,
        data: { id: dayId, type: 'DAY', timestamp: cutoff - 1 },
      },
      {
        collection: 'networkSnapshots',
        id: monthId,
        blockHeight: 1,
        timestamp: cutoff - 1,
        data: { id: monthId, type: 'MONTH', timestamp: cutoff - 1 },
      },
    ]);

    await indexer.retireExpiredNetworkBlockSnapshots(timestamp);

    expect(await repository.get('networkSnapshots', oldBlock.id)).toBeNull();
    expect(await repository.get('networkSnapshots', boundaryBlock.id)).not.toBeNull();
    expect(await repository.get('networkSnapshots', monthBlock.id)).not.toBeNull();
    expect(await repository.get('networkSnapshots', dayId)).not.toBeNull();
    expect(await repository.get('networkSnapshots', monthId)).not.toBeNull();
  });

  it('bounds network BLOCK retention catch-up and resumes from deleted pages', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      retireExpiredNetworkBlockSnapshots: (timestamp: number) => Promise<void>;
    };
    const timestamp = 10_000_000;
    const cutoff = timestamp - 31 * 86_400;
    const documents = Array.from({ length: 4_005 }, (_item, index) =>
      createBlockNetworkSnapshot(index + 1, cutoff - 4_005 + index, { transactions: 1 })
    );
    await repository.upsertMany(documents);
    const query = vi.spyOn(repository, 'query');

    await indexer.retireExpiredNetworkBlockSnapshots(timestamp);
    expect(query).toHaveBeenCalledTimes(4);
    expect(await repository.list('networkSnapshots')).toHaveLength(5);

    await indexer.retireExpiredNetworkBlockSnapshots(timestamp);
    expect(await repository.list('networkSnapshots')).toHaveLength(0);
  });

  it('does not roll default network aggregates into the next five-minute window early', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createNetworkSnapshotDocuments: (
        analytics: unknown,
        blockHeight: number,
        timestamp: number,
        includeSnapshots: boolean
      ) => Array<{ collection: string; id: string; data: Record<string, unknown> }>;
    };
    const analytics = {
      network: new Map(),
    };
    const defaultSnapshotId = (timestamp: number): string | undefined => {
      const documents = indexer.createNetworkSnapshotDocuments(analytics, 77, timestamp, true);
      return documents.find((document) => document.data.type === 'DEFAULT')?.id;
    };

    expect(defaultSnapshotId(1_700_000_399)).toBe('network-all-DEFAULT-1700000100');
    expect(defaultSnapshotId(1_700_000_400)).toBe('network-all-DEFAULT-1700000400');
  });

  it('aggregates network account counts from atomic per-block creation deltas', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      buildAnalytics: (
        timestamp: number,
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>,
        prices: Map<string, bigint>,
        pools: unknown[],
        liquidityStats: {
          liquidityUSD: string;
          poolLiquidityUSD: string;
          orderBookLiquidityUSD: string;
          activePools: number;
          activeOrderBooks: number;
          listedAssets: number;
        }
      ) => Promise<{ network: Map<string, { accounts: number; transactions: number }> }>;
    };

    await repository.upsertMany([
      createBlockNetworkSnapshot(1, 100, { accounts: 1, transactions: 1 }),
      createBlockNetworkSnapshot(2, 4_000, { accounts: 1, transactions: 2 }),
      createBlockNetworkSnapshot(3, 7_000, { accounts: 1, transactions: 3 }),
    ]);

    const analytics = await indexer.buildAnalytics(
      7_300,
      new Map(),
      new Map(),
      [],
      {
        liquidityUSD: '0',
        poolLiquidityUSD: '0',
        orderBookLiquidityUSD: '0',
        activePools: 0,
        activeOrderBooks: 0,
        listedAssets: 0,
      }
    );

    expect(analytics.network.get('DEFAULT')).toMatchObject({ accounts: 1, transactions: 3 });
    expect(analytics.network.get('HOUR')).toMatchObject({ accounts: 2, transactions: 5 });
    expect(analytics.network.get('DAY')).toMatchObject({ accounts: 3, transactions: 6 });
  });

  it('incrementally refreshes bounded analytics inputs without changing aggregate results', async () => {
    const repository = new MemoryRepository();
    const query = vi.spyOn(repository, 'query');
    const liquidityStats = {
      liquidityUSD: '0',
      poolLiquidityUSD: '0',
      orderBookLiquidityUSD: '0',
      activePools: 0,
      activeOrderBooks: 0,
      listedAssets: 0,
    };
    const cachedIndexer = new ChainIndexer(config, repository) as unknown as {
      buildAnalytics: (
        timestamp: number,
        assets: Map<string, unknown>,
        prices: Map<string, bigint>,
        pools: unknown[],
        liquidity: typeof liquidityStats,
        sourceVersion?: number
      ) => Promise<unknown>;
      getAnalyticsInputCacheMetrics: () => {
        fullLoads: number;
        incrementalLoads: number;
        invalidations: number;
        documentsRead: number;
        cachedDocuments: number;
      };
      getRollingNetworkInputMetrics: () => {
        fullBuilds: number;
        incrementalUpdates: number;
        blockDocumentsProcessed: number;
        cachedBlocks: number;
      };
      queryAllWithinAnalyticsBudget: (
        collectionName: string,
        args: Record<string, unknown>,
        budget: { maximumBytes: number; retainedBytes: number }
      ) => Promise<IndexerDocument[]>;
    };

    await repository.upsertMany([
      createBlockNetworkSnapshot(1, 100, { accounts: 1, transactions: 1 }),
      createBlockNetworkSnapshot(2, 4_000, { transactions: 2 }),
      createBlockNetworkSnapshot(3, 7_000, { accounts: 1, transactions: 3 }),
    ]);

    await cachedIndexer.buildAnalytics(7_300, new Map<string, unknown>(), new Map(), [], liquidityStats, 3);
    const boundedDeltaQueries = vi.spyOn(cachedIndexer, 'queryAllWithinAnalyticsBudget');
    query.mockClear();

    await repository.upsertMany([
      createBlockNetworkSnapshot(4, 7_500, { accounts: 1, transactions: 4 }),
      createBlockNetworkSnapshot(5, 7_700, { accounts: 1, transactions: 100 }),
    ]);

    const incremental = await cachedIndexer.buildAnalytics(
      7_601,
      new Map<string, unknown>(),
      new Map(),
      [],
      liquidityStats,
      4
    );
    const uncachedIndexer = new ChainIndexer(config, repository) as unknown as {
      buildAnalytics: (
        timestamp: number,
        assets: Map<string, unknown>,
        prices: Map<string, bigint>,
        pools: unknown[],
        liquidity: typeof liquidityStats
      ) => Promise<unknown>;
    };
    const full = await uncachedIndexer.buildAnalytics(
      7_601,
      new Map<string, unknown>(),
      new Map(),
      [],
      liquidityStats
    );

    expect(incremental).toEqual(full);

    await repository.upsertMany([
      createBlockNetworkSnapshot(6, 7_800, { accounts: 1, transactions: 6 }),
    ]);
    const nextIncremental = await cachedIndexer.buildAnalytics(
      7_900,
      new Map<string, unknown>(),
      new Map(),
      [],
      liquidityStats,
      6
    );
    const nextUncachedIndexer = new ChainIndexer(config, repository) as unknown as typeof uncachedIndexer;
    const nextFull = await nextUncachedIndexer.buildAnalytics(
      7_900,
      new Map<string, unknown>(),
      new Map(),
      [],
      liquidityStats
    );
    expect(nextIncremental).toEqual(nextFull);

    expect(cachedIndexer.getAnalyticsInputCacheMetrics()).toMatchObject({
      fullLoads: 1,
      incrementalLoads: 2,
      invalidations: 0,
      cachedDocuments: 6,
    });
    expect(cachedIndexer.getRollingNetworkInputMetrics()).toEqual({
      fullBuilds: 1,
      incrementalUpdates: 2,
      blockDocumentsProcessed: 6,
      cachedBlocks: 6,
    });
    expect(boundedDeltaQueries).toHaveBeenCalledTimes(10);
    expect(new Set(boundedDeltaQueries.mock.calls.slice(0, 5).map((call) => call[2])).size).toBe(1);
    expect(new Set(boundedDeltaQueries.mock.calls.slice(5).map((call) => call[2])).size).toBe(1);
    expect(
      query.mock.calls.find(([collectionName]) => collectionName === 'historyElements')?.[1].filter
    ).toEqual({
      and: [
        { timestamp: { greaterThanOrEqualTo: 7_000, lessThanOrEqualTo: 7_601 } },
        { blockHeight: { lessThanOrEqualTo: 4 } },
      ],
    });
    expect(query.mock.calls.some(([collectionName]) => collectionName === 'accountMeta')).toBe(false);
  });

  it('updates a large rolling horizon in place and counts only changed delta rows', async () => {
    const repository = new MemoryRepository();
    const query = vi.spyOn(repository, 'query');
    const documentCount = 3_000;
    await repository.upsertMany(
      Array.from({ length: documentCount }, (_item, index) =>
        createBlockNetworkSnapshot(index + 1, 10_001 + index, { transactions: 1 })
      )
    );
    const indexer = new ChainIndexer(config, repository) as unknown as {
      rollingNetworkInputCache: null | { blocks: unknown[] };
      loadAnalyticsInputDocuments: (
        timestamp: number,
        sourceVersion: number
      ) => Promise<{ documents: { blockSnapshots: IndexerDocument[] } }>;
      getRollingNetworkInputMetrics: () => {
        blockDocumentsProcessed: number;
        incrementalUpdates: number;
      };
    };

    const cold = await indexer.loadAnalyticsInputDocuments(13_000, documentCount);
    expect(cold.documents.blockSnapshots).toEqual([]);
    const networkQueries = query.mock.calls.filter(([collectionName]) => collectionName === 'networkSnapshots');
    expect(networkQueries).toHaveLength(3);
    expect(networkQueries.every(([_collectionName, args]) => Number(args.maxBytes) > 0)).toBe(true);
    const publishedRollingCache = indexer.rollingNetworkInputCache;
    const publishedBlocks = publishedRollingCache?.blocks;
    const processedBefore = indexer.getRollingNetworkInputMetrics().blockDocumentsProcessed;

    await repository.upsert(createBlockNetworkSnapshot(documentCount + 1, 13_001, { transactions: 2 }));
    await indexer.loadAnalyticsInputDocuments(13_001, documentCount + 1);

    expect(indexer.rollingNetworkInputCache).toBe(publishedRollingCache);
    expect(indexer.rollingNetworkInputCache?.blocks).toBe(publishedBlocks);
    expect(indexer.getRollingNetworkInputMetrics()).toMatchObject({ incrementalUpdates: 1 });
    expect(indexer.getRollingNetworkInputMetrics().blockDocumentsProcessed - processedBefore).toBe(1);
  });

  it('fails a cold paged analytics load before its retained byte budget can grow without bound', async () => {
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'historyElements',
      id: 'large-history',
      blockHeight: 1,
      timestamp: 1,
      data: { id: 'large-history', timestamp: 1, module: 'system', method: 'remark', data: { value: 'x'.repeat(512) } },
    });
    const indexer = new ChainIndexer(config, repository) as unknown as {
      queryAllWithinAnalyticsBudget: (
        collectionName: 'historyElements',
        args: Record<string, unknown>,
        budget: { maximumBytes: number; retainedBytes: number }
      ) => Promise<IndexerDocument[]>;
    };
    const budget = { maximumBytes: 128, retainedBytes: 0 };

    await expect(
      indexer.queryAllWithinAnalyticsBudget(
        'historyElements',
        { orderBy: ['TIMESTAMP_ASC'] },
        budget
      )
    ).rejects.toThrow(/retained-load limit/);
    expect(budget.retainedBytes).toBe(0);
  });

  it('continues byte-truncated repository pages from pageInfo instead of treating a short page as final', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany(
      Array.from({ length: 3 }, (_item, index) => ({
        collection: 'historyElements' as const,
        id: `large-history-${index}`,
        blockHeight: index + 1,
        timestamp: index + 1,
        data: {
          id: `large-history-${index}`,
          timestamp: index + 1,
          module: 'system',
          method: 'remark',
          data: { value: 'x'.repeat(512) },
        },
      }))
    );
    const indexer = new ChainIndexer(config, repository) as unknown as {
      queryPages: (
        collectionName: 'historyElements',
        args: { orderBy: string[]; maxBytes: number }
      ) => AsyncGenerator<IndexerDocument[]>;
    };
    const pages: IndexerDocument[][] = [];

    for await (const page of indexer.queryPages('historyElements', {
      orderBy: ['TIMESTAMP_ASC'],
      maxBytes: 128,
    })) {
      pages.push(page);
    }

    expect(pages.map((page) => page.length)).toEqual([1, 1, 1]);
    expect(pages.flat().map((document) => document.id)).toEqual([
      'large-history-0',
      'large-history-1',
      'large-history-2',
    ]);
  });

  it('merges a large analytics document horizon into its existing ordered array', async () => {
    const repository = new MemoryRepository();
    const documentCount = 2_000;
    await repository.upsertMany(
      Array.from({ length: documentCount }, (_item, index) => ({
        collection: 'historyElements' as const,
        id: `history-${String(index + 1).padStart(5, '0')}`,
        blockHeight: index + 1,
        timestamp: 1_001 + index,
        data: {
          id: `history-${String(index + 1).padStart(5, '0')}`,
          timestamp: 1_001 + index,
          module: 'system',
          method: 'remark',
          data: {},
        },
      }))
    );
    const indexer = new ChainIndexer(config, repository) as unknown as {
      analyticsInputCache: null | {
        history: IndexerDocument[];
        historyById: Map<string, IndexerDocument>;
      };
      loadAnalyticsInputDocuments: (timestamp: number, sourceVersion: number) => Promise<unknown>;
    };

    await indexer.loadAnalyticsInputDocuments(3_000, documentCount);
    const publishedHistory = indexer.analyticsInputCache?.history;
    const publishedById = indexer.analyticsInputCache?.historyById;
    await repository.upsert({
      collection: 'historyElements',
      id: 'history-02001',
      blockHeight: 2_001,
      timestamp: 3_001,
      data: { id: 'history-02001', timestamp: 3_001, module: 'system', method: 'remark', data: {} },
    });

    await indexer.loadAnalyticsInputDocuments(3_001, 2_001);

    expect(indexer.analyticsInputCache?.history).toBe(publishedHistory);
    expect(indexer.analyticsInputCache?.historyById).toBe(publishedById);
    expect(indexer.analyticsInputCache?.history).toHaveLength(2_001);
    expect(indexer.analyticsInputCache?.history.at(-1)?.id).toBe('history-02001');
  });

  it('uses repository lexical order for same-timestamp analytics delta IDs', async () => {
    const repository = new MemoryRepository();
    const historyDocument = (id: string, blockHeight: number): IndexerDocument => ({
      collection: 'historyElements',
      id,
      blockHeight,
      timestamp: 1_000,
      data: { id, timestamp: 1_000, module: 'system', method: 'remark', data: {} },
    });
    await repository.upsertMany([
      historyDocument('history-a', 1),
      historyDocument('history_A', 2),
      historyDocument('history-A', 3),
    ]);
    const indexer = new ChainIndexer(config, repository) as unknown as {
      analyticsInputCache: null | { history: IndexerDocument[] };
      loadAnalyticsInputDocuments: (timestamp: number, sourceVersion: number) => Promise<unknown>;
    };
    await indexer.loadAnalyticsInputDocuments(1_000, 3);
    await repository.upsert(historyDocument('history!', 4));

    await indexer.loadAnalyticsInputDocuments(1_001, 4);

    expect(indexer.analyticsInputCache?.history.map((document) => document.id)).toEqual([
      'history!',
      'history-A',
      'history-a',
      'history_A',
    ]);
  });

  it('bypasses analytics retention when the complete cache pair exceeds its byte budget', async () => {
    const repository = new MemoryRepository();
    await repository.upsert(createBlockNetworkSnapshot(1, 7_000, { transactions: 1 }));
    const indexer = new ChainIndexer(
      { ...config, analyticsInputCacheMaxBytes: 256 },
      repository
    ) as unknown as {
      analyticsInputCache: unknown;
      rollingNetworkInputCache: unknown;
      loadAnalyticsInputDocuments: (
        timestamp: number,
        sourceVersion: number
      ) => Promise<{ rollingNetworkInputs: { blocks: unknown[] } }>;
      getAnalyticsInputCacheMetrics: () => {
        cachedBytes: number;
        maximumBytes: number;
        capacityBypasses: number;
        capacityBypassedBytes: number;
      };
    };

    const loaded = await indexer.loadAnalyticsInputDocuments(7_100, 1);

    expect(loaded.rollingNetworkInputs.blocks).toHaveLength(1);
    expect(indexer.analyticsInputCache).toBeNull();
    expect(indexer.rollingNetworkInputCache).toBeNull();
    expect(indexer.getAnalyticsInputCacheMetrics()).toMatchObject({
      cachedBytes: 0,
      maximumBytes: 256,
      capacityBypasses: 1,
      capacityBypassedBytes: 257,
    });
  });

  it('does not reinstall analytics inputs invalidated while repository reads are in flight', async () => {
    const repository = new MemoryRepository();
    const originalQuery = repository.query.bind(repository);
    let releaseHistoryQuery!: () => void;
    let signalHistoryQueryStarted!: () => void;
    const historyQueryGate = new Promise<void>((resolve) => {
      releaseHistoryQuery = resolve;
    });
    const historyQueryStarted = new Promise<void>((resolve) => {
      signalHistoryQueryStarted = resolve;
    });
    let delayedHistoryQuery = false;

    vi.spyOn(repository, 'query').mockImplementation(async (collectionName, args) => {
      if (collectionName === 'historyElements' && !delayedHistoryQuery) {
        delayedHistoryQuery = true;
        signalHistoryQueryStarted();
        await historyQueryGate;
      }

      return originalQuery(collectionName, args);
    });

    const indexer = new ChainIndexer(config, repository) as unknown as {
      analyticsInputCache: null | { sourceVersion: number; refreshedAt: number };
      invalidateAnalyticsInputCache: () => void;
      loadAnalyticsInputDocuments: (timestamp: number, sourceVersion?: number) => Promise<unknown>;
      getAnalyticsInputCacheMetrics: () => {
        invalidations: number;
        cachedDocuments: number;
      };
    };
    const staleLoad = indexer.loadAnalyticsInputDocuments(7_300, 3);

    await historyQueryStarted;
    indexer.invalidateAnalyticsInputCache();
    releaseHistoryQuery();
    await staleLoad;

    expect(indexer.analyticsInputCache).toBeNull();
    expect(indexer.getAnalyticsInputCacheMetrics()).toMatchObject({
      invalidations: 1,
      cachedDocuments: 0,
    });

    await indexer.loadAnalyticsInputDocuments(7_400, 4);
    expect(indexer.analyticsInputCache).toMatchObject({ sourceVersion: 4, refreshedAt: 7_400 });
  });

  it('retries a raced incremental analytics load from a full horizon after invalidation', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      createBlockNetworkSnapshot(1, 7_000, { accounts: 1, transactions: 1 }),
    ]);
    const indexer = new ChainIndexer(config, repository) as unknown as {
      analyticsInputCache: null | { sourceVersion: number; refreshedAt: number };
      rollingNetworkInputCache: null | {
        sourceVersion: number;
        totals: Map<string, { accounts: number; transactions: number }>;
      };
      invalidateAnalyticsInputCache: () => void;
      loadAnalyticsInputDocuments: (
        timestamp: number,
        sourceVersion: number
      ) => Promise<{ rollingNetworkInputs: { totals: Map<string, { accounts: number; transactions: number }> } }>;
    };
    await indexer.loadAnalyticsInputDocuments(7_300, 1);

    await repository.upsertMany([
      createBlockNetworkSnapshot(2, 7_400, { accounts: 1, transactions: 2 }),
    ]);
    const originalQuery = repository.query.bind(repository);
    let releaseIncremental!: () => void;
    let signalIncrementalStarted!: () => void;
    const incrementalGate = new Promise<void>((resolve) => {
      releaseIncremental = resolve;
    });
    const incrementalStarted = new Promise<void>((resolve) => {
      signalIncrementalStarted = resolve;
    });
    let delayed = false;
    vi.spyOn(repository, 'query').mockImplementation(async (collectionName, args) => {
      if (collectionName === 'historyElements' && !delayed) {
        delayed = true;
        signalIncrementalStarted();
        await incrementalGate;
      }
      return originalQuery(collectionName, args);
    });

    const load = indexer.loadAnalyticsInputDocuments(7_500, 2);
    await incrementalStarted;
    indexer.invalidateAnalyticsInputCache();
    releaseIncremental();

    const result = await load;
    expect(result.rollingNetworkInputs.totals.get('HOUR')).toMatchObject({ accounts: 2, transactions: 3 });
    expect(indexer.analyticsInputCache).toMatchObject({ sourceVersion: 2, refreshedAt: 7_500 });
    expect(indexer.rollingNetworkInputCache?.sourceVersion).toBe(2);
  });

  it('publishes analytics and rolling caches atomically across conversion failure and retry', async () => {
    const repository = new MemoryRepository();
    await repository.upsert(createBlockNetworkSnapshot(1, 7_000, { transactions: 1 }));
    const indexer = new ChainIndexer(config, repository) as unknown as {
      analyticsInputCache: null | { sourceVersion: number };
      rollingNetworkInputCache: null | {
        sourceVersion: number;
        totals: Map<string, { transactions: number }>;
      };
      rollingBlockFromSnapshot: (document: IndexerDocument) => unknown;
      loadAnalyticsInputDocuments: (
        timestamp: number,
        sourceVersion: number
      ) => Promise<{ rollingNetworkInputs: { totals: Map<string, { transactions: number }> } }>;
    };
    await indexer.loadAnalyticsInputDocuments(7_100, 1);
    const publishedDocuments = indexer.analyticsInputCache;
    const publishedRolling = indexer.rollingNetworkInputCache;

    await repository.upsert(createBlockNetworkSnapshot(2, 7_200, { transactions: 2 }));
    const originalConverter = indexer.rollingBlockFromSnapshot.bind(indexer);
    indexer.rollingBlockFromSnapshot = (document) => {
      if (document.id === 'block-2') throw new Error('malformed rolling row');
      return originalConverter(document);
    };

    await expect(indexer.loadAnalyticsInputDocuments(7_250, 2)).rejects.toThrow('malformed rolling row');
    expect(indexer.analyticsInputCache).toBe(publishedDocuments);
    expect(indexer.rollingNetworkInputCache).toBe(publishedRolling);
    expect(indexer.rollingNetworkInputCache?.totals.get('HOUR')?.transactions).toBe(1);

    indexer.rollingBlockFromSnapshot = originalConverter;
    const retried = await indexer.loadAnalyticsInputDocuments(7_250, 2);
    expect(retried.rollingNetworkInputs.totals.get('HOUR')?.transactions).toBe(3);
    expect(indexer.analyticsInputCache?.sourceVersion).toBe(2);
    expect(indexer.rollingNetworkInputCache?.sourceVersion).toBe(2);
  });

  it('applies same-id corrections, out-of-order overlap rows, and exact cutoff expiry', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      loadAnalyticsInputDocuments: (
        timestamp: number,
        sourceVersion: number
      ) => Promise<{
        rollingNetworkInputs: {
          totals: Map<string, { accounts: number; transactions: number }>;
        };
      }>;
    };
    await repository.upsertMany([
      createBlockNetworkSnapshot(1, 1_000, { accounts: 1, transactions: 1 }),
    ]);
    await indexer.loadAnalyticsInputDocuments(1_000, 1);

    const correctedBlock = createBlockNetworkSnapshot(2, 1_000, { accounts: 1, transactions: 9 });
    correctedBlock.id = 'block-1';
    correctedBlock.data.id = 'block-1';
    await repository.upsertMany([
      correctedBlock,
      createBlockNetworkSnapshot(3, 700, { transactions: 4 }),
    ]);

    const exactCutoff = await indexer.loadAnalyticsInputDocuments(1_000, 3);
    expect(exactCutoff.rollingNetworkInputs.totals.get('DEFAULT')).toMatchObject({
      accounts: 1,
      transactions: 13,
    });

    const expired = await indexer.loadAnalyticsInputDocuments(1_001, 4);
    expect(expired.rollingNetworkInputs.totals.get('DEFAULT')).toMatchObject({
      accounts: 1,
      transactions: 9,
    });
  });

  it('trims expired rolling prefixes without retaining stale id-map entries', async () => {
    const repository = new MemoryRepository();
    const documents: IndexerDocument[] = [];
    for (let block = 1; block <= 2_105; block += 1) {
      documents.push(createBlockNetworkSnapshot(block, block, { transactions: 1 }));
    }
    await repository.upsertMany(documents);
    const indexer = new ChainIndexer(config, repository) as unknown as {
      loadAnalyticsInputDocuments: (
        timestamp: number,
        sourceVersion: number
      ) => Promise<{
        rollingNetworkInputs: {
          blocks: unknown[];
          blocksById: Map<string, unknown>;
          blockStarts: Map<string, number>;
        };
      }>;
    };
    await indexer.loadAnalyticsInputDocuments(2_105, 2_105);
    const advanced = await indexer.loadAnalyticsInputDocuments(2_105 + 30 * 86_400 + 1, 2_106);

    expect(advanced.rollingNetworkInputs.blocks).toHaveLength(0);
    expect(advanced.rollingNetworkInputs.blocksById.size).toBe(0);
    expect([...advanced.rollingNetworkInputs.blockStarts.values()]).toEqual([0, 0, 0, 0]);
  });




  it('initializes fresh aggregate windows without scanning repository history', async () => {
    const repository = new MemoryRepository();
    const query = vi.spyOn(repository, 'query');
    const list = vi.spyOn(repository, 'list');
    const indexer = new ChainIndexer(config, repository) as unknown as {
      initializeNetworkBackfillWindows: (lastIndexed: number) => Promise<unknown[]>;
    };

    await expect(indexer.initializeNetworkBackfillWindows(-1)).resolves.toHaveLength(4);
    expect(query).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('restores only the bounded thirty-day aggregate horizon when resuming', async () => {
    const repository = new MemoryRepository();
    const latestTimestamp = 4_000_000;
    await repository.upsertMany([
      createBlockNetworkSnapshot(1, 1, { transactions: 1 }),
      createBlockNetworkSnapshot(2, latestTimestamp - 30 * 86_400, { transactions: 2 }),
      createBlockNetworkSnapshot(3, latestTimestamp, { transactions: 3 }),
    ]);
    const query = vi.spyOn(repository, 'query');
    const indexer = new ChainIndexer(config, repository) as unknown as {
      initializeNetworkBackfillWindows: (lastIndexed: number) => Promise<unknown[]>;
    };

    await expect(indexer.initializeNetworkBackfillWindows(3)).resolves.toHaveLength(4);

    expect(query).toHaveBeenCalledWith(
      'networkSnapshots',
      expect.objectContaining({
        filter: {
          and: expect.arrayContaining([
            {
              timestamp: {
                greaterThanOrEqualTo: latestTimestamp - 30 * 86_400,
                lessThanOrEqualTo: latestTimestamp,
              },
            },
          ]),
        },
        orderBy: ['TIMESTAMP_ASC'],
      })
    );
  });

  it('commits rolling network aggregates atomically with the final backfill chain state', async () => {
    const repository = new MemoryRepository();
    const upsertMany = vi.spyOn(repository, 'upsertMany');
    const indexer = new ChainIndexer(config, repository) as unknown as {
      createNetworkBackfillWindows: () => unknown[];
      indexFetchedBlock: (
        block: unknown,
        options: {
          refreshDerivedState: boolean;
          networkAggregateWindows: unknown[];
          flushNetworkAggregates: boolean;
        }
      ) => Promise<void>;
    };
    const windows = indexer.createNetworkBackfillWindows();
    markIndexerMainnet(indexer);
    const fetchedBlock = (blockHeight: number, timestamp: number) => {
      const blockHash = canonicalBlockHash(`network-aggregate-${blockHeight}`);
      return {
        requestedHash: blockHash,
        signedBlock: {
          block: {
            header: {
              number: { toNumber: () => blockHeight },
              hash: { toString: () => blockHash },
            },
            extrinsics: [],
          },
        },
        events: [],
        timestamp,
      };
    };

    await indexer.indexFetchedBlock(fetchedBlock(1, 100), {
      refreshDerivedState: false,
      networkAggregateWindows: windows,
      flushNetworkAggregates: false,
    });
    await indexer.indexFetchedBlock(fetchedBlock(2, 86_500), {
      refreshDerivedState: false,
      networkAggregateWindows: windows,
      flushNetworkAggregates: true,
    });

    const finalBatch = upsertMany.mock.calls.at(-1)?.[0] ?? [];
    expect(finalBatch.map((document) => document.id)).toEqual(
      expect.arrayContaining(['network-all-DAY-0', 'network-all-DAY-86400', 'chainState'])
    );
    expect(await repository.get('networkSnapshots', 'network-all-DAY-0')).not.toBeNull();
    expect(await repository.get('networkSnapshots', 'network-all-DAY-86400')).not.toBeNull();
    expect((await repository.get('updatesStreams', 'chainState'))?.data.block).toBe(2);
  });

  it('drops expired fine-grained backfill outputs while retaining their DAY and MONTH computations', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createNetworkBackfillWindows: () => Array<{ type: string; pendingDocument: IndexerDocument | null }>;
      advanceNetworkBackfillWindow: (
        window: unknown,
        block: {
          blockHeight: number;
          timestamp: number;
          accounts: number;
          transactions: number;
          fees: bigint;
          volumeUSD: bigint;
          swaps: number;
          bridgeIncomingTransactions: number;
          bridgeOutgoingTransactions: number;
        }
      ) => IndexerDocument;
      shouldPersistBackfillNetworkAggregate: (
        document: IndexerDocument,
        retentionTimestamp: number
      ) => boolean;
    };
    const windows = indexer.createNetworkBackfillWindows();
    const block = (blockHeight: number, timestamp: number, transactions: number) => ({
      blockHeight,
      timestamp,
      accounts: 0,
      transactions,
      fees: 0n,
      volumeUSD: 0n,
      swaps: 0,
      bridgeIncomingTransactions: 0,
      bridgeOutgoingTransactions: 0,
    });
    const firstByType = new Map(
      windows.map((window) => [window.type, indexer.advanceNetworkBackfillWindow(window, block(1, 100, 7))])
    );
    const completed = windows.map((window) => {
      const first = firstByType.get(window.type)!;
      const next = indexer.advanceNetworkBackfillWindow(window, block(2, 86_500, 3));
      return { type: window.type, document: first.id === next.id ? next : first };
    });
    const retentionTimestamp = 10_000_000;

    expect(
      completed.filter(({ document }) => indexer.shouldPersistBackfillNetworkAggregate(document, retentionTimestamp))
        .map(({ type }) => type)
    ).toEqual(['DAY', 'MONTH']);
    expect(completed.find(({ type }) => type === 'DAY')?.document.data.transactions).toBe(7);
    expect(completed.find(({ type }) => type === 'MONTH')?.document.data.transactions).toBe(10);
  });

  it('chunks oversized idempotent projections and retries them without reordering', async () => {
    const repository = new MemoryRepository();
    const originalUpsertMany = repository.upsertMany.bind(repository);
    const upsertMany = vi.spyOn(repository, 'upsertMany');
    const indexer = new ChainIndexer(config, repository) as unknown as {
      upsertDocumentsInCallChunks: (documents: IndexerDocument[]) => Promise<void>;
    };
    const projectionDocuments: IndexerDocument[] = Array.from(
      { length: MAX_REPOSITORY_WRITE_CALL_DOCUMENTS + 4 },
      (_item, index) => ({
        collection: 'historyCalls',
        id: `projection-${String(index).padStart(5, '0')}`,
        blockHeight: 10,
        timestamp: 10,
        data: { id: `projection-${String(index).padStart(5, '0')}` },
      })
    );
    projectionDocuments.push({
      collection: 'updatesStreams',
      id: 'projection-complete',
      blockHeight: 10,
      timestamp: 10,
      data: { id: 'projection-complete', block: 10, data: '{}' },
    });
    let call = 0;
    upsertMany.mockImplementation(async (documents) => {
      call += 1;
      if (call === 2) throw new Error('second projection chunk failed');
      await originalUpsertMany(documents);
    });

    await expect(indexer.upsertDocumentsInCallChunks(projectionDocuments)).rejects.toThrow(
      'second projection chunk failed'
    );
    expect(await repository.list('historyCalls')).toHaveLength(MAX_REPOSITORY_WRITE_CALL_DOCUMENTS);
    expect(await repository.get('updatesStreams', 'projection-complete')).toBeNull();

    upsertMany.mockImplementation(originalUpsertMany);
    await indexer.upsertDocumentsInCallChunks(projectionDocuments);
    expect(await repository.list('historyCalls')).toHaveLength(MAX_REPOSITORY_WRITE_CALL_DOCUMENTS + 4);
    expect(await repository.get('updatesStreams', 'projection-complete')).not.toBeNull();
    const retryCalls = upsertMany.mock.calls.slice(2);
    expect(retryCalls.map(([documents]) => documents.length)).toEqual([
      MAX_REPOSITORY_WRITE_CALL_DOCUMENTS,
      5,
    ]);
    expect(retryCalls.at(-1)?.[0].at(-1)?.id).toBe('projection-complete');
  });

  it('fails an oversized finalized block atomically and retries without double-applying account totals', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      indexFetchedBlock: (block: unknown, options?: { refreshDerivedState?: boolean }) => Promise<void>;
    };
    markIndexerMainnet(indexer);
    const extrinsics = Array.from({ length: 3_334 }, (_item, index) => ({
      isSigned: true,
      signer: { toString: () => 'alice' },
      hash: { toString: () => `0xtransfer-${index}` },
      method: {
        section: 'assets',
        method: 'transfer',
        args: [XOR, 'bob', SCALE.toString()],
        meta: { args: [{ name: 'assetId' }, { name: 'to' }, { name: 'amount' }] },
      },
    }));
    const fetchedBlock = (selectedExtrinsics: unknown[]) => {
      const blockHash = canonicalBlockHash('oversized-finalized-block');
      return {
        requestedHash: blockHash,
        signedBlock: {
          block: {
            header: {
              number: { toNumber: () => 42 },
              hash: { toString: () => blockHash },
            },
            extrinsics: selectedExtrinsics,
          },
        },
        events: [eventRecord('xorFee', 'FeeWithdrawn', { amount: SCALE.toString() }, 0)],
        timestamp: 1_700_000_000,
      };
    };

    await expect(
      indexer.indexFetchedBlock(fetchedBlock(extrinsics), { refreshDerivedState: false })
    ).rejects.toThrow(/maximum is 10000/);
    expect(await repository.list('historyElements')).toHaveLength(0);
    expect(await repository.get('accountMeta', 'alice')).toBeNull();
    expect(await repository.get('updatesStreams', 'chainState')).toBeNull();

    await indexer.indexFetchedBlock(fetchedBlock(extrinsics.slice(0, 1)), { refreshDerivedState: false });
    expect((await repository.get('accountMeta', 'alice'))?.data.xorFees).toEqual({
      amount: '1',
      amountUSD: '0',
    });
    expect((await repository.get('updatesStreams', 'chainState'))?.data.block).toBe(42);
  });

  it('creates update stream JSON payloads for prices, APY, and asset registration', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createUpdateStreams: (
        pools: unknown[],
        assets: Map<string, { id: string; symbol: string; name: string; decimals: number }>,
        prices: Map<string, bigint>,
        apyByPool: Map<string, string>,
        blockHeight: number,
        timestamp: number
      ) => Array<{ id: string; blockHeight: number; timestamp: number; data: { data: string; block: number } }>;
    };
    const poolId = `${XOR}-${KUSD}`;
    const documents = indexer.createUpdateStreams(
      [{ id: poolId }],
      new Map([
        [XOR, { id: XOR, symbol: 'XOR', name: 'SORA', decimals: 18 }],
        [KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18 }],
      ]),
      new Map([
        [XOR, 5n * SCALE],
        [KUSD, SCALE],
      ]),
      new Map([[poolId, '0.125']]),
      88,
      1_700_000_000
    );
    const byId = new Map(documents.map((document) => [document.id, document]));

    expect(JSON.parse(byId.get('price')?.data.data ?? '{}')).toEqual({
      [XOR]: '5',
      [KUSD]: '1',
    });
    expect(JSON.parse(byId.get('apy')?.data.data ?? '{}')).toEqual({
      [poolId]: '0.125',
    });
    expect(JSON.parse(JSON.parse(byId.get('assetRegistration')?.data.data ?? '{}')[XOR])).toEqual({
      address: XOR,
      name: 'SORA',
      symbol: 'XOR',
      decimals: 18,
    });
    expect([...byId.values()].map((document) => [document.blockHeight, document.timestamp, document.data.block])).toEqual([
      [88, 1_700_000_000, 88],
      [88, 1_700_000_000, 88],
      [88, 1_700_000_000, 88],
    ]);
  });
});

describe('MemoryRepository subscriptions', () => {
  it('emits watched document updates without polling', async () => {
    const repository = new MemoryRepository();
    const watcher = repository.watch?.('assets');
    if (!watcher) throw new Error('watch is not implemented');

    const next = watcher.next();
    await repository.upsert({
      collection: 'assets',
      id: XOR,
      blockHeight: 1,
      timestamp: 1,
      data: { id: XOR, priceUSD: '1' },
    });

    await expect(next).resolves.toMatchObject({ value: { id: XOR } });
    await watcher.return(undefined);
  });
});
