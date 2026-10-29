import { afterEach, describe, expect, it, vi } from 'vitest';

const apiCreate = vi.hoisted(() => vi.fn());
vi.mock('@polkadot/api', () => ({ ApiPromise: { create: apiCreate }, HttpProvider: class {} }));

import { createArchiveHourlyBackfillSource, HourlyArchiveHttpProvider, readHourlyArchiveEntries } from '../src/scripts/hourly-backfill-archive.js';
import { HOURLY_GENESIS_HASH } from '../src/scripts/hourly-backfill-constants.js';
import { buildAssetHourlyCloseDocumentsAtBoundary, HOURLY_HISTORY_ASSETS } from '../src/worker/hourly-history.js';
import { prepareHourlyBackfill } from '../src/scripts/backfill-hourly-history.js';

const hash = (number: number) => `0x${number.toString(16).padStart(64, '0')}`;
const xor = HOURLY_HISTORY_ASSETS.find((asset) => asset.symbol === 'XOR')!;
const dai = HOURLY_HISTORY_ASSETS.find((asset) => asset.symbol === 'DAI')!;
const kusd = HOURLY_HISTORY_ASSETS.find((asset) => asset.symbol === 'KUSD')!;
const grt = { id: '0x00d1fb79bbd1005a678fbf2de9256b3afe260e8eead49bb07bd3a566f9fe8355', symbol: 'GRT' };
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

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('archive observation rejection boundaries', () => {
  const before = { height: 10, hash: hash(10), parentHash: hash(9), timestamp: 7_199 };
  it('disconnects a source from the wrong genesis before returning it', async () => {
    const f = setup(); f.api.genesisHash.toHex = () => hash(1);
    await expect(createArchiveHourlyBackfillSource()).rejects.toThrow(/genesis/); expect(f.disconnect).toHaveBeenCalledOnce();
  });
  it.each([0, -1, 1.5, NaN])('rejects invalid block height %s before RPC', async height => {
    const f = setup(), source = await createArchiveHourlyBackfillSource();
    await expect(source.block(height)).rejects.toThrow(/height/); expect(f.getHeader).not.toHaveBeenCalled();
  });
  it('rejects a malformed block hash and a mismatched fixed anchor', async () => {
    const f = setup(), source = await createArchiveHourlyBackfillSource();
    f.api.rpc.chain.getBlockHash.mockResolvedValue({ toHex: () => 'malformed' });
    await expect(source.block(10)).rejects.toThrow(/identity/);
    f.api.rpc.chain.getBlockHash.mockResolvedValue({ toHex: () => hash(25059555) });
    await expect(source.block(25059555)).rejects.toThrow(/identity/);
  });
  it.each(['0x01', '0xFFFFFFFFFFFFFFFF', '0xffffffffffffffff'])('rejects malformed or unsafe timestamp %s', async value => {
    const f = setup(), source = await createArchiveHourlyBackfillSource(); f.getStorage.mockResolvedValue({ toHex: () => value });
    await expect(source.block(10)).rejects.toThrow(/timestamp/);
  });
  it('rejects a header whose height disagrees with its request', async () => {
    const f = setup(), source = await createArchiveHourlyBackfillSource();
    f.getHeader.mockResolvedValue({ number: { toNumber: () => 11 }, parentHash: { toHex: () => hash(9) } });
    await expect(source.block(10)).rejects.toThrow(/header/);
  });
  it.each(['assets', 'poolXYK', 'denomination'])('requires the historical %s pallet', async pallet => {
    const f = setup(); const at = await f.at(); delete at.query[pallet];
    const source = await createArchiveHourlyBackfillSource(); await expect(source.observation(before)).rejects.toThrow(/unavailable/);
  });
  it.each([null, [], {}, { precision: 18 }, { symbol: 'XOR' }])('rejects malformed asset metadata %j', async value => {
    const f = setup(); f.assetPages.mockResolvedValue([[{ args: [key(xor.id)] }, metadata(value)]]);
    const source = await createArchiveHourlyBackfillSource(); await expect(source.observation(before)).rejects.toThrow(/metadata/);
  });
  it.each([null, {}, { code: 'invalid' }, 'invalid'])('rejects malformed asset identities %j', async value => {
    const f = setup(); f.assetPages.mockResolvedValue([[{ args: [{ toJSON: () => value }] }, metadata({ symbol: 'XOR', precision: 18 })]]);
    const source = await createArchiveHourlyBackfillSource(); await expect(source.observation(before)).rejects.toThrow(/asset storage key/);
  });
  it.each([null, [], ['1'], ['1', '2', '3'], {}])('rejects malformed reserve tuple %j', async value => {
    const f = setup(); f.reservePages.mockResolvedValue([[{ args: [key(xor.id), key(dai.id)] }, { toJSON: () => value }]]);
    const source = await createArchiveHourlyBackfillSource(); await expect(source.observation(before)).rejects.toThrow(/reserves are malformed/);
  });
  it('skips None asset options and unwraps present options with string asset IDs', async () => {
    const f = setup(); f.assetPages.mockResolvedValue([
      [{ args: [key(dai.id)] }, { isNone: true }],
      [{ args: [{ toJSON: () => xor.id.toUpperCase() }] }, { unwrap: () => metadata({ symbol: 'XOR', precision: 18 }) }],
    ]); f.reservePages.mockResolvedValue([]);
    const source = await createArchiveHourlyBackfillSource({ targets: [xor] });
    expect((await source.observation(before)).assets).toEqual([{ ...xor, decimals: 18 }]);
  });
  it('reports finalized identity and provider progress without fetching the block hash again', async () => {
    const f = setup(); Object.assign(f.api.rpc.chain, { getFinalizedHead: async () => ({ toHex: () => hash(10) }) });
    const source = await createArchiveHourlyBackfillSource();
    expect(await source.finalized()).toEqual(before); expect(await source.genesisHash()).toBe(HOURLY_GENESIS_HASH);
    expect(source.progress?.()).toMatchObject({ rpcCalls: 0, httpRequests: 0 }); expect(f.api.rpc.chain.getBlockHash).not.toHaveBeenCalled();
  });
  it('rejects oversized archive pages and nonadvancing continuation keys', async () => {
    const page = Array.from({ length: 256 }, () => [{ toHex: () => '0x01', args: [] }, {}]);
    const collect = async (rows: any[]) => { for await (const _entry of readHourlyArchiveEntries({ entriesPaged: async () => rows } as any)) {} };
    await expect(collect([...page, page[0]])).rejects.toThrow(/entry limit/);
    await expect(collect(page)).rejects.toThrow(/did not advance/);
  });
});

describe('archive batched HTTP protocol', () => {
  const provider = () => new HourlyArchiveHttpProvider('https://archive.invalid');
  it.each(['author_submitExtrinsic', 'state_call', 'system_health'])('rejects non-approved RPC method %s without fetching', async method => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(provider().send(method, [])).rejects.toThrow(/read-only/); expect(fetch).not.toHaveBeenCalled();
  });
  it('stops at the absolute call limit before making another HTTP request', async () => {
    const p = provider(); (p as any).calls = 300000; await expect(p.send('chain_getHeader', [])).rejects.toThrow(/limit/);
  });
  it.each([
    ['HTTP failure', () => new Response('', { status: 503 }), /HTTP 503/],
    ['missing body', () => new Response(null, { status: 200 }), /HTTP 200/],
    ['non-array response', () => Response.json({}), /invalid RPC data/],
    ['wrong batch length', () => Response.json([]), /invalid RPC data/],
    ['missing item', () => Response.json([null]), /identities/],
    ['wrong version', () => Response.json([{ jsonrpc: '1.0', id: 1, result: true }]), /identities/],
    ['wrong ID type', () => Response.json([{ jsonrpc: '2.0', id: '1', result: true }]), /identities/],
    ['unrequested ID', () => Response.json([{ jsonrpc: '2.0', id: 2, result: true }]), /identities/],
    ['RPC error', () => Response.json([{ jsonrpc: '2.0', id: 1, error: { code: -1 } }]), /RPC error/],
    ['missing result', () => Response.json([{ jsonrpc: '2.0', id: 1 }]), /RPC error/],
    ['byte budget', () => new Response(new Uint8Array(8 * 1024 * 1024 + 1)), /exceeded/],
  ])('rejects %s without hanging a caller', async (_name, response, error) => {
    vi.stubGlobal('fetch', vi.fn(async () => (response as () => Response)()));
    await expect(provider().send('chain_getHeader', [])).rejects.toThrow(error as RegExp);
  });
  it('rejects duplicate response identities for every caller in the batch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ jsonrpc: '2.0', id: 1, result: true }, { jsonrpc: '2.0', id: 1, result: true }])));
    const p = provider(), values = await Promise.allSettled([p.send('chain_getHeader', []), p.send('chain_getBlockHash', [])]);
    expect(values.every(value => value.status === 'rejected')).toBe(true);
  });
  it('serializes a second full batch and matches shuffled responses by ID', async () => {
    const fetch = vi.fn(async (_url, request) => {
      const calls = JSON.parse(request.body); return Response.json(calls.reverse().map((call: any) => ({ jsonrpc: '2.0', id: call.id, result: call.params[0] })));
    }); vi.stubGlobal('fetch', fetch); const p = provider();
    const values = await Promise.all(Array.from({ length: 34 }, (_, i) => p.send('chain_getHeader', [i])));
    expect(values).toEqual(Array.from({ length: 34 }, (_, i) => i)); expect(fetch).toHaveBeenCalledTimes(2);
    expect(p.progress()).toMatchObject({ rpcCalls: 34, httpRequests: 2, methods: { chain_getHeader: 34 } });
  });
});

describe('pinned archive hourly source', () => {
  it('validates an explicit target catalogue before opening the archive connection', async () => {
    await expect(createArchiveHourlyBackfillSource({ targets: [{ ...xor, symbol: 'OTHER' }] })).rejects.toThrow();
    expect(apiCreate).not.toHaveBeenCalled();
  });

  it('rejects a preparation scope different from the archive observation scope before further RPC', async () => {
    const fixture = setup();
    const archive = await createArchiveHourlyBackfillSource({ targets: [grt] });
    await expect(prepareHourlyBackfill(archive, { targets: [kusd], hours: 1 }).next()).rejects.toThrow('scope');
    expect(fixture.at).not.toHaveBeenCalled(); expect(fixture.getHeader).not.toHaveBeenCalled();
  });

  it('retains XOR proof context for observed absence without emitting an unrequested XOR close', async () => {
    const fixture = setup();
    fixture.assetPages.mockResolvedValue([
      [{ args: [key(xor.id)] }, metadata({ symbol: 'XOR', precision: '18' })],
      [{ args: [key(grt.id)] }, metadata({ symbol: 'GRT', precision: '6' })],
    ]);
    fixture.reservePages.mockResolvedValue([]);
    const archive = await createArchiveHourlyBackfillSource({ targets: [grt] });
    const before = { height: 10, hash: hash(10), parentHash: hash(9), timestamp: 7_199 };
    const value = await archive.observation(before);
    expect(value.assets).toEqual([{ ...xor, decimals: 18 }, { ...grt, decimals: 6 }]);
    const documents = buildAssetHourlyCloseDocumentsAtBoundary({ before,
      after: { height: 11, hash: hash(11), timestamp: 7_201 }, genesisHash: HOURLY_GENESIS_HASH,
      denominator: value.denominator, targets: [grt],
      assets: new Map(value.assets.map((asset) => [asset.id, asset])), prices: new Map(), pools: [], xorPoolsComplete: true });
    expect(documents).toHaveLength(1);
    expect(documents[0]!.data).toMatchObject({ assetId: grt.id, closeEvidence: { xorPool: null, availability: 'price-unavailable' } });
  });

  it('retains non-seven shallow direct evidence and historical rename/precision without creating a USD price', async () => {
    const fixture = setup();
    fixture.assetPages.mockResolvedValue([
      ...HOURLY_HISTORY_ASSETS.map((asset) => [{ args: [key(asset.id)] }, metadata({ symbol: asset.symbol, precision: '18' })]),
      [{ args: [key(grt.id)] }, metadata({ symbol: 'OLD_GRT', precision: '6' })],
    ]);
    fixture.reservePages.mockResolvedValue([
      [{ args: [key(xor.id), key(dai.id)] }, { toJSON: () => ['100000000000000000000', '200000000000000000000'] }],
      [{ args: [key(grt.id), key(xor.id)] }, { toJSON: () => ['900000', '1000000000000000000'] }],
    ]);
    const archive = await createArchiveHourlyBackfillSource({ targets: [grt] });
    const value = await archive.observation({ height: 10, hash: hash(10), parentHash: hash(9), timestamp: 7_199 });
    expect(value.xorPoolsComplete).toBe(true);
    expect(value.assets).toEqual(expect.arrayContaining([{ ...grt, symbol: 'OLD_GRT', decimals: 6 }, { ...xor, decimals: 18 }]));
    expect(value.prices).toEqual([]);
    expect(value.priceRoutes).toEqual([]);
    expect(value.pools).toEqual([{ baseAssetId: grt.id, targetAssetId: xor.id,
      baseAssetReserves: '900000', targetAssetReserves: '1000000000000000000' }]);
    expect(fixture.at).toHaveBeenCalledExactlyOnceWith(hash(10));
  });

  it('retains incidental pricing-route metadata without enlarging the explicit targets or price list', async () => {
    const fixture = setup();
    fixture.assetPages.mockResolvedValue([
      ...HOURLY_HISTORY_ASSETS.map((asset) => [{ args: [key(asset.id)] }, metadata({ symbol: asset.symbol, precision: '18' })]),
      [{ args: [key(grt.id)] }, metadata({ symbol: 'GRT', precision: '6' })],
    ]);
    fixture.reservePages.mockResolvedValue([
      [{ args: [key(xor.id), key(dai.id)] }, { toJSON: () => ['100000000000000000000', '200000000000000000000'] }],
      [{ args: [key(xor.id), key(grt.id)] }, { toJSON: () => ['100000000000000000000', '50000000'] }],
    ]);
    const archive = await createArchiveHourlyBackfillSource({ targets: [grt] });
    const value = await archive.observation({ height: 10, hash: hash(10), parentHash: hash(9), timestamp: 7_199 });
    expect(value.assets).toEqual(expect.arrayContaining([{ ...dai, decimals: 18 }]));
    expect(value.prices).toEqual([{ id: grt.id, value: '4000000000000000000' }]);
    expect(value.priceRoutes).toEqual([{ id: grt.id, poolIds: [`${xor.id}:${dai.id}`, `${xor.id}:${grt.id}`] }]);
  });

  it('retains nonwinning direct stable/XOR reserves and precision independently of USD routing', async () => {
    const fixture = setup();
    fixture.reservePages.mockResolvedValue([
      [{ args: [key(xor.id), key(dai.id)] }, { toJSON: () => ['100000000000000000000', '200000000000000000000'] }],
      [{ args: [key(kusd.id), key(xor.id)] }, { toJSON: () => ['7000000000000000000', '1000000000000000000'] }],
    ]);
    const archive = await createArchiveHourlyBackfillSource();
    const value = await archive.observation({ height: 10, hash: hash(10), parentHash: hash(9), timestamp: 7_199 });
    expect(value.xorPoolsComplete).toBe(true);
    expect(value.prices.find((price) => price.id === xor.id)?.value).toBe('2000000000000000000');
    expect(value.priceRoutes?.find((route) => route.id === kusd.id)?.poolIds).toEqual([]);
    expect(value.pools).toContainEqual({ baseAssetId: kusd.id, targetAssetId: xor.id,
      baseAssetReserves: '7000000000000000000', targetAssetReserves: '1000000000000000000' });
    expect(value.assets).toContainEqual({ ...kusd, decimals: 18 });
  });

  it('rejects duplicate direct pools before map retention can silently remove the ambiguity', async () => {
    const fixture = setup();
    const pool = [{ args: [key(xor.id), key(kusd.id)] }, { toJSON: () => ['1000', '2000'] }];
    fixture.reservePages.mockResolvedValue([pool, pool]);
    const archive = await createArchiveHourlyBackfillSource();
    await expect(archive.observation({ height: 10, hash: hash(10), parentHash: hash(9), timestamp: 7_199 })).rejects.toThrow('Ambiguous');
  });

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

  it.each([undefined, null, '', '1e1', false])('rejects unsupported archive precision %s', async (precision) => {
    const fixture = setup();
    fixture.assetPages.mockResolvedValue([[{ args: [key(xor.id)] }, metadata({ symbol: 'XOR', precision })]]);
    const archive = await createArchiveHourlyBackfillSource();
    await expect(archive.observation({ height: 10, hash: hash(10), parentHash: hash(9), timestamp: 7_199 })).rejects.toThrow('precision');
  });
});
