import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { ApiPromise } from '@polkadot/api';
import { ChainIndexer } from '../src/worker/chain.js';
import { MemoryRepository } from '../src/repository/memory.js';
import {
  SORA_LEGACY_IDENTITY_ANCHOR,
  SORA_MAINNET_GENESIS_HASH,
  SORA_MAX_BLOCK_NUMBER,
} from '../src/soraIdentity.js';
import { MAX_REPOSITORY_WRITE_CALL_DOCUMENTS } from '../src/repository/validation.js';
import { createPersistedWorkerStatusDocument } from '../src/worker/status.js';
import { estimateRetainedValueBytes } from '../src/cache-weight.js';

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
  snapshotRetentionMode: 'rolling' as const,
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

/** Builds the minimal signed extrinsic shape consumed by the chain worker tests. */
const testExtrinsic = (
  hash: string,
  section: string,
  method: string,
  args: unknown[],
  argumentNames: string[],
  signer = 'alice'
) => ({
  isSigned: true,
  signer: { toString: () => signer },
  hash: { toString: () => hash },
  method: {
    section,
    method,
    args,
    meta: { args: argumentNames.map((name) => ({ name })) },
  },
});

/** Builds a pinned block API response without requiring a live SORA node. */
const testBlockApi = (
  blockHeight: number,
  blockHash: string,
  extrinsics: ReturnType<typeof testExtrinsic>[],
  events: ReturnType<typeof eventRecord>[],
  timestampMs = 1_700_000_000_000
) => ({
  rpc: {
    chain: {
      getBlock: async () => ({
        block: {
          header: {
            number: { toNumber: () => blockHeight },
            hash: { toString: () => canonicalBlockHash(blockHash) },
          },
          extrinsics,
        },
      }),
    },
  },
  query: {
    system: {
      events: {
        at: async () => events,
      },
    },
    timestamp: {
      now: {
        at: async () => ({ toString: () => String(timestampMs) }),
      },
    },
  },
});

describe('network executed exchange volume', () => {
  it('counts every supported direct swap method from executed Exchange events only', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      indexBlockByHash: (hash: string) => Promise<void>;
    };
    const desiredInput = (amount: bigint) => ({
      WithDesiredInput: { desiredAmountIn: amount.toString(), minAmountOut: '0' },
    });
    const batchArgs = [
      [
        {
          outcomeAssetId: KUSD,
          outcomeAssetReuse: '0',
          dexId: 0,
          receivers: [{ accountId: 'bob', targetAmount: (11n * SCALE).toString() }],
        },
      ],
      XOR,
      (6n * SCALE).toString(),
      ['PoolXYK'],
      'Disabled',
      null,
    ];

    indexer.prices = new Map([
      [XOR, 3n * SCALE],
      [KUSD, SCALE],
    ]);
    indexer.assetInfos = new Map([
      [XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }],
      [KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18, supply: 0n }],
    ]);
    indexer.api = testBlockApi(
      62,
      '0xsupported-swaps-block',
      [
        testExtrinsic(
          '0xdirect-swap',
          'liquidityProxy',
          'swap',
          [0, XOR, KUSD, desiredInput(5n * SCALE), ['PoolXYK'], 'Disabled'],
          ['dexId', 'inputAssetId', 'outputAssetId', 'swapAmount', 'selectedSourceTypes', 'filterMode']
        ),
        testExtrinsic(
          '0xswap-transfer',
          'liquidityProxy',
          'swapTransfer',
          ['bob', 0, XOR, KUSD, desiredInput(2n * SCALE), ['PoolXYK'], 'Disabled'],
          [
            'receiver',
            'dexId',
            'inputAssetId',
            'outputAssetId',
            'swapAmount',
            'selectedSourceTypes',
            'filterMode',
          ]
        ),
        testExtrinsic(
          '0xswap-transfer-batch',
          'liquidityProxy',
          'swapTransferBatch',
          batchArgs,
          [
            'swapBatches',
            'inputAssetId',
            'maxInputAmount',
            'selectedSourceTypes',
            'filterMode',
            'additionalData',
          ]
        ),
        testExtrinsic(
          '0xtransfer-only-batch',
          'liquidityProxy',
          'swapTransferBatch',
          [
            [
              {
                outcomeAssetId: XOR,
                outcomeAssetReuse: '0',
                dexId: 0,
                receivers: [{ accountId: 'carol', targetAmount: (3n * SCALE).toString() }],
              },
            ],
            XOR,
            (3n * SCALE).toString(),
            ['PoolXYK'],
            'Disabled',
            null,
          ],
          [
            'swapBatches',
            'inputAssetId',
            'maxInputAmount',
            'selectedSourceTypes',
            'filterMode',
            'additionalData',
          ]
        ),
      ],
      [
        eventRecord(
          'liquidityProxy',
          'Exchange',
          {
            inputAssetId: XOR,
            outputAssetId: KUSD,
            inputAmount: (5n * SCALE).toString(),
            outputAmount: (14n * SCALE).toString(),
          },
          0
        ),
        eventRecord(
          'liquidityProxy',
          'Exchange',
          {
            inputAssetId: XOR,
            outputAssetId: KUSD,
            inputAmount: (2n * SCALE).toString(),
            outputAmount: ((11n * SCALE) / 2n).toString(),
          },
          1
        ),
        eventRecord(
          'liquidityProxy',
          'Exchange',
          {
            inputAssetId: XOR,
            outputAssetId: KUSD,
            inputAmount: (4n * SCALE).toString(),
            outputAmount: (11n * SCALE).toString(),
          },
          2
        ),
        eventRecord(
          'liquidityProxy',
          'BatchSwapExecuted',
          {
            adarFee: '0',
            inputAmount: (6n * SCALE).toString(),
            additionalData: null,
          },
          2
        ),
        eventRecord(
          'liquidityProxy',
          'BatchSwapExecuted',
          {
            adarFee: '0',
            inputAmount: (3n * SCALE).toString(),
            additionalData: null,
          },
          3
        ),
      ]
    );

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('0xsupported-swaps-block'));

    const snapshot = await repository.get('networkSnapshots', 'block-62');
    const histories = await repository.getMany('historyElements', [
      '0xdirect-swap',
      '0xswap-transfer',
      '0xswap-transfer-batch',
      '0xtransfer-only-batch',
    ]);

    expect(snapshot?.data.swaps).toBe(4);
    expect(snapshot?.data.volumeUSD).toBe('33');
    expect(
      [
        '0xdirect-swap',
        '0xswap-transfer',
        '0xswap-transfer-batch',
        '0xtransfer-only-batch',
      ].map((id) => (histories.get(id)?.data.data as Record<string, unknown>)?.exchangeVolumeUSD)
    ).toEqual(['15', '6', '12', '0']);
  });

  it('values utility-wrapped swaps from their scoped Exchange events', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      extractVolumeUSD: (data: unknown) => bigint;
      indexBlockByHash: (hash: string) => Promise<void>;
    };
    const swapCall = {
      section: 'liquidityProxy',
      method: 'swap',
      args: [
        0,
        XOR,
        KUSD,
        { WithDesiredInput: { desiredAmountIn: (5n * SCALE).toString(), minAmountOut: '0' } },
        ['PoolXYK'],
        'Disabled',
      ],
      meta: {
        args: [
          { name: 'dexId' },
          { name: 'inputAssetId' },
          { name: 'outputAssetId' },
          { name: 'swapAmount' },
          { name: 'selectedSourceTypes' },
          { name: 'filterMode' },
        ],
      },
    };

    indexer.prices = new Map([
      [XOR, 3n * SCALE],
      [KUSD, SCALE],
    ]);
    indexer.assetInfos = new Map([
      [XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }],
      [KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18, supply: 0n }],
    ]);
    indexer.api = testBlockApi(
      63,
      '0xutility-swap-block',
      [testExtrinsic('0xutility-swap', 'utility', 'batchAll', [[swapCall]], ['calls'])],
      [
        eventRecord('liquidityProxy', 'Exchange', {
          inputAssetId: XOR,
          outputAssetId: KUSD,
          inputAmount: (5n * SCALE).toString(),
          outputAmount: (14n * SCALE).toString(),
        }),
      ]
    );

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash('0xutility-swap-block'));

    const history = await repository.get('historyElements', '0xutility-swap');
    const snapshot = await repository.get('networkSnapshots', 'block-63');

    expect(indexer.extractVolumeUSD(history?.data.data)).toBe(0n);
    expect(history?.data.data).toMatchObject({ exchangeVolumeUSD: '15' });
    expect(snapshot?.data.swaps).toBe(1);
    expect(snapshot?.data.volumeUSD).toBe('15');
  });

  it.each([
    {
      label: 'million XOR asset transfer',
      blockHeight: 71,
      module: 'assets',
      method: 'transfer',
      args: [XOR, 'bob', (1_000_000n * SCALE).toString()],
      argumentNames: ['assetId', 'to', 'amount'],
      events: [],
    },
    {
      label: 'outgoing ETH bridge transfer',
      blockHeight: 72,
      module: 'ethBridge',
      method: 'transferToSidechain',
      args: [XOR, '0xade919a974bd98ddfd24801bf479dac6475f6a65', (5n * SCALE).toString(), 0],
      argumentNames: ['assetId', 'to', 'amount', 'networkId'],
      events: [],
    },
    {
      label: 'asset burn',
      blockHeight: 64,
      module: 'assets',
      method: 'burn',
      args: [XOR, (5n * SCALE).toString()],
      argumentNames: ['assetId', 'amount'],
      events: [],
    },
    {
      label: 'asset mint',
      blockHeight: 65,
      module: 'assets',
      method: 'mint',
      args: [XOR, 'bob', (5n * SCALE).toString()],
      argumentNames: ['assetId', 'to', 'amount'],
      events: [],
    },
    {
      label: 'liquidity deposit',
      blockHeight: 66,
      module: 'poolXYK',
      method: 'depositLiquidity',
      args: [0, XOR, KUSD, (5n * SCALE).toString(), (10n * SCALE).toString(), '0', '0'],
      argumentNames: [
        'dexId',
        'inputAssetA',
        'inputAssetB',
        'inputADesired',
        'inputBDesired',
        'inputAMin',
        'inputBMin',
      ],
      events: [],
    },
    {
      label: 'Polkamarkt claim',
      blockHeight: 67,
      module: 'polkamarkt',
      method: 'claimMarket',
      args: [7],
      argumentNames: ['marketId'],
      events: [
        eventRecord('polkamarkt', 'MarketClaimed', {
          marketId: 7,
          trader: 'alice',
          payout: (10n * SCALE).toString(),
        }),
      ],
    },
  ])('excludes successful $label history with USD amounts from network volume', async (testCase) => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      prices: Map<string, bigint>;
      assetInfos: Map<string, { id: string; symbol: string; name: string; decimals: number; supply: bigint }>;
      extractVolumeUSD: (data: unknown) => bigint;
      indexBlockByHash: (hash: string) => Promise<void>;
    };
    const blockHash = `0xnon-swap-${testCase.blockHeight}`;
    const extrinsicHash = `0xnon-swap-extrinsic-${testCase.blockHeight}`;

    indexer.prices = new Map([
      [XOR, 2n * SCALE],
      [KUSD, SCALE],
    ]);
    indexer.assetInfos = new Map([
      [XOR, { id: XOR, symbol: 'XOR', name: 'XOR', decimals: 18, supply: 0n }],
      [KUSD, { id: KUSD, symbol: 'KUSD', name: 'Kensetsu USD', decimals: 18, supply: 0n }],
    ]);
    indexer.api = testBlockApi(
      testCase.blockHeight,
      blockHash,
      [
        testExtrinsic(
          extrinsicHash,
          testCase.module,
          testCase.method,
          testCase.args,
          testCase.argumentNames
        ),
      ],
      testCase.events
    );

    markIndexerMainnet(indexer);
    await indexer.indexBlockByHash(canonicalBlockHash(blockHash));

    const history = await repository.get('historyElements', extrinsicHash);
    const snapshot = await repository.get('networkSnapshots', `block-${testCase.blockHeight}`);

    expect(indexer.extractVolumeUSD(history?.data.data)).toBeGreaterThan(0n);
    expect(history?.data.data).not.toHaveProperty('exchangeVolumeUSD');
    expect(snapshot?.data.swaps).toBe(0);
    expect(snapshot?.data.volumeUSD).toBe('0');
  });

});
