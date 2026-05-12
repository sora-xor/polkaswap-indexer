import { describe, expect, it, vi } from 'vitest';

import { ChainIndexer } from '../src/worker/chain.js';
import { MemoryRepository } from '../src/repository/memory.js';

const SCALE = 10n ** 18n;
const XOR = '0x0200000000000000000000000000000000000000000000000000000000000000';
const PSWAP = '0x0200050000000000000000000000000000000000000000000000000000000000';
const DUST_DAI = '0x00a0e746a66b290bd29cbffecc710aefacb98840937229e1e847590006fa0696';
const ETH = '0x0200070000000000000000000000000000000000000000000000000000000000';
const XSTUSD = '0x0200080000000000000000000000000000000000000000000000000000000000';
const KUSD = '0x02000c0000000000000000000000000000000000000000000000000000000000';

const eventRecord = (section: string, method: string, data: Record<string, unknown>) => ({
  phase: {
    isApplyExtrinsic: true,
    asApplyExtrinsic: { toNumber: () => 0 },
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
  databaseUrl: '',
  soraWsEndpoint: 'wss://mof2.sora.org',
  chainStartBlock: 0,
  chainBatchSize: 25,
  stateRefreshIntervalBlocks: 250,
  snapshotIntervalBlocks: 250,
};

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
                hash: { toString: () => '0xblock' },
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

    await indexer.indexBlockByHash('0xblock');

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
      data: JSON.stringify({ lastIndexedBlock: 25_900_001 }),
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
                hash: { toString: () => '0xbridgeblock' },
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

    await indexer.indexBlockByHash('0xbridgeblock');

    const history = await repository.get('historyElements', '0xevmburn');
    const snapshot = await repository.get('networkSnapshots', 'block-42');
    const accountMeta = await repository.get('accountMeta', 'alice');

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
                hash: { toString: () => '0xinboundblock' },
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

    await indexer.indexBlockByHash('0xinboundblock');

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
                hash: { toString: () => '0xinbound-no-request-block' },
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

    await indexer.indexBlockByHash('0xinbound-no-request-block');

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
                hash: { toString: () => '0xinbound-no-asset-block' },
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

    await indexer.indexBlockByHash('0xinbound-no-asset-block');

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
                hash: { toString: () => '0xinbound-invalid-amount-block' },
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

    await indexer.indexBlockByHash('0xinbound-invalid-amount-block');

    const synthetic = await repository.get('historyElements', '0xrequest-invalid-amount-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-46');
    const accountMeta = await repository.get('accountMeta', 'alice');

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
                number: { toNumber: () => 47 },
                hash: { toString: () => '0xevmburn-no-duplicate-block' },
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

    await indexer.indexBlockByHash('0xevmburn-no-duplicate-block');

    const outgoing = await repository.get('historyElements', '0xevmburn-no-duplicate');
    const synthetic = await repository.get('historyElements', '0xburn-request-mint');
    const snapshot = await repository.get('networkSnapshots', 'block-47');
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

  it('backfills compact XOR burn documents without rewinding chain state', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      backfillXorBurns: (finalizedBlock: number) => Promise<void>;
    };
    const burnBlock = 25_043_003;
    const chainStateBlock = 26_000_000;
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
          getBlockHash: async (block: number) => `hash-${block}`,
          getBlock: async () => ({
            block: {
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
              hash === `hash-${burnBlock}`
                ? [eventRecord('assets', 'Burn', { address: 'alice', assetId: XOR, amount: '10000000000000000000' })]
                : [],
          },
        },
      },
    };

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
  });

  it('skips expensive derived-state refreshes while backfilling historical blocks', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(
      { ...config, stateRefreshIntervalBlocks: 1, snapshotIntervalBlocks: 1 },
      repository
    ) as unknown as {
      api: unknown;
      backfill: () => Promise<void>;
      indexBlockByNumber: (block: number, options?: { refreshDerivedState?: boolean }) => Promise<void>;
      refreshDerivedState: (blockHeight: number, timestamp: number, includeSnapshots: boolean) => Promise<void>;
    };
    const indexedBlocks: Array<{ block: number; refreshDerivedState?: boolean }> = [];
    const refreshes: Array<{ blockHeight: number; includeSnapshots: boolean }> = [];

    indexer.api = {
      rpc: {
        chain: {
          getFinalizedHead: async () => '0xfinal',
          getHeader: async () => ({ number: { toNumber: () => 3 } }),
        },
      },
    };
    indexer.indexBlockByNumber = async (block, options) => {
      indexedBlocks.push({ block, refreshDerivedState: options?.refreshDerivedState });
    };
    indexer.refreshDerivedState = async (blockHeight, _timestamp, includeSnapshots) => {
      refreshes.push({ blockHeight, includeSnapshots });
    };

    await indexer.backfill();

    expect(indexedBlocks).toEqual([
      { block: 1, refreshDerivedState: false },
      { block: 2, refreshDerivedState: false },
      { block: 3, refreshDerivedState: false },
    ]);
    expect(refreshes).toEqual([{ blockHeight: 3, includeSnapshots: true }]);
  });

  it('retries missed finalized blocks before indexing later heads', async () => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(config, repository) as unknown as {
      api: unknown;
      subscribeFinalizedHeads: () => Promise<void>;
      indexBlockByNumber: (block: number) => Promise<void>;
    };
    const indexedBlocks: number[] = [];
    let finalizedHeadCallback: ((header: { number: { toNumber: () => number } }) => Promise<void>) | undefined;

    await repository.upsert({
      collection: 'updatesStreams',
      id: 'chainState',
      blockHeight: 9,
      timestamp: 1,
      data: {
        id: 'chainState',
        block: 9,
        data: JSON.stringify({ lastIndexedBlock: 9 }),
      },
    });

    indexer.api = {
      rpc: {
        chain: {
          subscribeFinalizedHeads: async (callback: typeof finalizedHeadCallback) => {
            finalizedHeadCallback = callback;
          },
        },
      },
    };
    indexer.indexBlockByNumber = async (block) => {
      indexedBlocks.push(block);
      if (block === 10 && indexedBlocks.length === 1) {
        throw new Error('transient database failure');
      }

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
      await finalizedHeadCallback?.({ number: { toNumber: () => 10 } });
      expect(indexedBlocks).toEqual([10]);
      expect((await repository.get('updatesStreams', 'chainState'))?.data.block).toBe(9);
      expect(consoleError).toHaveBeenCalledWith('Failed to index finalized block 10', expect.any(Error));

      await finalizedHeadCallback?.({ number: { toNumber: () => 12 } });
      expect(indexedBlocks).toEqual([10, 10, 11, 12]);
      expect((await repository.get('updatesStreams', 'chainState'))?.data.block).toBe(12);
    } finally {
      consoleError.mockRestore();
    }
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
      module: 'referenda',
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
          updated: 1_700_000_000,
          amount: '0',
        },
      },
    ]);
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

  it('creates network snapshots only for aggregate windows', () => {
    const indexer = new ChainIndexer(config, new MemoryRepository()) as unknown as {
      createNetworkSnapshotDocuments: (
        analytics: unknown,
        blockHeight: number,
        timestamp: number,
        includeSnapshots: boolean
      ) => Array<{ collection: string; data: Record<string, unknown> }>;
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
