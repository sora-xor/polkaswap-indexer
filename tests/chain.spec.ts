import { describe, expect, it } from 'vitest';

import { ChainIndexer } from '../src/worker/chain.js';
import { MemoryRepository } from '../src/repository/memory.js';

const SCALE = 10n ** 18n;
const XOR = '0x0200000000000000000000000000000000000000000000000000000000000000';
const PSWAP = '0x0200050000000000000000000000000000000000000000000000000000000000';
const DUST_DAI = '0x00a0e746a66b290bd29cbffecc710aefacb98840937229e1e847590006fa0696';
const KUSD = '0x02000c0000000000000000000000000000000000000000000000000000000000';

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
