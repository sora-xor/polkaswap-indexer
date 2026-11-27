import { describe, expect, it } from 'vitest';

import { readConfig } from '../src/config.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { ChainIndexer } from '../src/worker/chain.js';
import type { IndexerDocument } from '../src/repository/types.js';

const SCALE = 10n ** 18n;
const BASE = '0x0200000000000000000000000000000000000000000000000000000000000000';
const QUOTE = '0x02000c0000000000000000000000000000000000000000000000000000000000';
const timestamp = Math.floor(1_700_000_000 / 86_400) * 86_400 + 3_600;
const asset = (id: string, decimals = 18) => ({ id, symbol: 'TEST', name: 'Test asset', decimals, supply: 0n });
const liquidityStats = {
  liquidityUSD: '0', poolLiquidityUSD: '0', orderBookLiquidityUSD: '0',
  activePools: 0, activeOrderBooks: 0, listedAssets: 0,
};

describe('chain analytics amounts and price changes', () => {
  it.each([0, 6, 18])('formats order quantities with %i base-asset decimals and keeps price precision fixed', (decimals) => {
    const indexer = new ChainIndexer(readConfig(), new MemoryRepository()) as any;
    const assets = new Map([[BASE, asset(BASE, decimals)], [QUOTE, asset(QUOTE, 6)]]);
    const prices = new Map([[BASE, 2n * SCALE], [QUOTE, SCALE]]);
    const unit = 10n ** BigInt(decimals);

    for (const side of ['Buy', 'Sell']) {
      const documents = indexer.createOrderBookEventDocuments('LimitOrderPlaced', {
        orderBookId: `0-${BASE}-${QUOTE}`,
        orderId: 42,
        side,
        amount: (3n * unit).toString(),
        amountFilled: unit.toString(),
        price: (2n * SCALE).toString(),
      }, 99, timestamp, 'alice', prices, assets) as IndexerDocument[];

      expect(documents[0]?.data).toMatchObject({ amount: '3', amountFilled: '1', price: '2', amountUSD: '6' });
    }
  });

  it.each([
    { name: 'an earliest open equal to the current price', current: 10, opens: [10, 20, 30], expected: '0' },
    { name: 'an asset first observed today', current: 20, opens: [10], expected: '100' },
  ])('retains the first weekly snapshot for $name', async ({ current, opens, expected }) => {
    const repository = new MemoryRepository();
    const indexer = new ChainIndexer(readConfig(), repository) as any;
    await repository.upsertMany(opens.map((open, index) => {
      const id = `day-${index}`;
      const snapshotTimestamp = timestamp - (opens.length - index - 1) * 86_400;
      return {
        collection: 'assetSnapshots', id, timestamp: snapshotTimestamp,
        data: { id, assetId: BASE, type: 'DAY', timestamp: snapshotTimestamp, priceUSD: { open: String(open), close: String(open) } },
      };
    }));
    const assets = new Map([[BASE, asset(BASE)]]);
    const prices = new Map([[BASE, BigInt(current) * SCALE]]);

    const analytics = await indexer.buildAnalytics(timestamp, assets, prices, [], liquidityStats);
    const documents = await indexer.createAssetDocuments(assets, prices, new Map(), analytics, 100, timestamp, false) as IndexerDocument[];

    expect(analytics.assetWeekOpenPrice.get(BASE)).toBe(String(opens[0]));
    expect(documents[0]?.data.priceChangeWeek).toBe(expected);
  });
});
