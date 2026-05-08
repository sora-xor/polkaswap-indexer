import { describe, expect, it } from 'vitest';

import { ChainIndexer } from '../src/worker/chain.js';
import { MemoryRepository } from '../src/repository/memory.js';

const SCALE = 10n ** 18n;
const XOR = '0x0200000000000000000000000000000000000000000000000000000000000000';
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
});
