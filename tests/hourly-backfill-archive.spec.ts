import { afterEach, describe, expect, it, vi } from 'vitest';

const apiCreate = vi.hoisted(() => vi.fn());
vi.mock('@polkadot/api', () => ({ ApiPromise: { create: apiCreate }, HttpProvider: class {} }));

import { createArchiveHourlyBackfillSource } from '../src/scripts/hourly-backfill-archive.js';
import { HOURLY_GENESIS_HASH } from '../src/scripts/hourly-backfill-constants.js';
import { HOURLY_HISTORY_ASSETS } from '../src/worker/hourly-history.js';

const hash = (number: number) => `0x${number.toString(16).padStart(64, '0')}`;
const xor = HOURLY_HISTORY_ASSETS.find((asset) => asset.symbol === 'XOR')!;
const dai = HOURLY_HISTORY_ASSETS.find((asset) => asset.symbol === 'DAI')!;
const metadata = (value: unknown) => ({ toHuman: () => value });
const key = (id: string) => ({ toJSON: () => ({ code: id }) });

function setup() {
  const assetPages = vi.fn().mockResolvedValue(HOURLY_HISTORY_ASSETS.map((asset) => [
    { args: [key(asset.id)] }, metadata({ symbol: asset.symbol, precision: '18' }),
  ]));
  const reservePages = vi.fn().mockResolvedValue([[
    { args: [key(xor.id), key(dai.id)] },
    { toJSON: () => ['100000000000000000000', '200000000000000000000'] },
  ]]);
  const denominator = vi.fn().mockResolvedValue({ toString: () => '1000000000000000000000000000001' });
  const at = vi.fn().mockResolvedValue({ query: {
    assets: { assetInfosV2: { entriesPaged: assetPages } },
    poolXYK: { reserves: { entriesPaged: reservePages } },
    denomination: { denominator },
  } });
  const getBlockHash = vi.fn(async (height: number) => ({ toHex: () => hash(height) }));
  const getHeader = vi.fn(async (blockHash: string) => ({
    number: { toNumber: () => Number(BigInt(blockHash)) },
    parentHash: { toHex: () => hash(Number(BigInt(blockHash)) - 1) },
  }));
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64LE(7_199_999n);
  const getStorage = vi.fn().mockResolvedValue({ toHex: () => `0x${timestamp.toString('hex')}` });
  const disconnect = vi.fn().mockResolvedValue(undefined);
  const api = {
    genesisHash: { toHex: () => HOURLY_GENESIS_HASH },
    query: { timestamp: { now: { key: () => '0xtimestampkey' } } },
    rpc: { chain: { getBlockHash, getHeader }, state: { getStorage } }, at, disconnect,
  };
  apiCreate.mockResolvedValue(api);
  return { api, at, assetPages, reservePages, denominator, getStorage, getHeader, disconnect };
}

afterEach(() => vi.clearAllMocks());

describe('pinned archive hourly source', () => {
  it('reads price graph, precision and denomination exclusively from the closing block runtime', async () => {
    const fixture = setup();
    const archive = await createArchiveHourlyBackfillSource();
    const before = { height: 10, hash: hash(10), parentHash: hash(9), timestamp: 7_199 };
    const value = await archive.observation(before);
    expect(fixture.at).toHaveBeenCalledExactlyOnceWith(before.hash);
    expect(fixture.assetPages).toHaveBeenCalledExactlyOnceWith({ args: [], pageSize: 256, startKey: undefined });
    expect(fixture.reservePages).toHaveBeenCalledExactlyOnceWith({ args: [], pageSize: 256, startKey: undefined });
    expect(value.denominator).toBe('1000000000000000000000000000001');
    expect(value.assets.find((asset) => asset.id === xor.id)).toEqual({ ...xor, decimals: 18 });
    expect(value.prices.find((price) => price.id === xor.id)?.value).toBe('2000000000000000000');
    expect(value.priceRoutes?.find((route) => route.id === xor.id)?.poolIds).toEqual([`${xor.id}:${dai.id}`]);
    expect(value.pools).toEqual([{ baseAssetId: xor.id, targetAssetId: dai.id,
      baseAssetReserves: '100000000000000000000', targetAssetReserves: '200000000000000000000' }]);
    expect(value.prices.some((price) => price.id === HOURLY_HISTORY_ASSETS.find((asset) => asset.symbol === 'LLM')!.id)).toBe(false);
    await archive.close();
    expect(fixture.disconnect).toHaveBeenCalledOnce();
  });

  it('retains actual parent hash and decodes historical millisecond timestamps without token arithmetic floats', async () => {
    const fixture = setup();
    const archive = await createArchiveHourlyBackfillSource();
    expect(await archive.block(10)).toEqual({ height: 10, hash: hash(10), parentHash: hash(9), timestamp: 7_199 });
    expect(fixture.getStorage).toHaveBeenCalledExactlyOnceWith('0xtimestampkey', hash(10));
    expect(fixture.getHeader).toHaveBeenCalledExactlyOnceWith(hash(10));
  });

  it.each(['0', '1e18', '-1', '340282366920938463463374607431768211456'])(
    'refuses invalid historical denomination %s', async (value) => {
      const fixture = setup();
      fixture.denominator.mockResolvedValue({ toString: () => value });
      const archive = await createArchiveHourlyBackfillSource();
      await expect(archive.observation({ height: 10, hash: hash(10), parentHash: hash(9), timestamp: 7_199 })).rejects.toThrow();
      expect(fixture.assetPages).not.toHaveBeenCalled();
    }
  );

  it('rejects unsupported precision instead of inferring eighteen decimals', async () => {
    const fixture = setup();
    fixture.assetPages.mockResolvedValue([[{ args: [key(xor.id)] }, metadata({ symbol: 'XOR' })]]);
    const archive = await createArchiveHourlyBackfillSource();
    await expect(archive.observation({ height: 10, hash: hash(10), parentHash: hash(9), timestamp: 7_199 })).rejects.toThrow('metadata');
  });
});
