import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryRepository } from '../src/repository/memory.js';
import { HOURLY_HISTORY_ASSETS, buildAssetHourlyCloseDocumentsAtBoundary } from '../src/worker/hourly-history.js';
import {
  applyHourlyBackfillFile, HOURLY_GENESIS_HASH, prepareHourlyBackfill,
  readHourlyBackfillArtifact, writeHourlyBackfillArtifact,
} from '../src/scripts/backfill-hourly-history.js';
import type { HourlyBackfillBlock, HourlyBackfillRow, HourlyBackfillSource } from '../src/scripts/backfill-hourly-history.js';
import { HourlyArchiveHttpProvider, readHourlyArchiveEntries } from '../src/scripts/hourly-backfill-archive.js';

const directories: string[] = [];
const hash = (height: number): string => `0x${height.toString(16).padStart(64, '0')}`;
const block = (height: number): HourlyBackfillBlock => ({
  height, hash: hash(height), parentHash: hash(height - 1), timestamp: 1_000 + (height - 1) * 1_800,
});
const source = (): HourlyBackfillSource => ({
  genesisHash: async () => HOURLY_GENESIS_HASH,
  finalized: async () => block(7),
  block: vi.fn(async (height) => block(height)),
  observation: vi.fn(async () => ({
    denominator: '1000000000000000000000000000001',
    assets: HOURLY_HISTORY_ASSETS.map((asset) => ({ ...asset, decimals: 18 })),
    prices: HOURLY_HISTORY_ASSETS.map((asset) => ({ id: asset.id, value: '1234567890123456789' })),
    pools: [],
  })),
});

async function artifact() {
  const directory = await mkdtemp(join(tmpdir(), 'hourly-history-repair-'));
  directories.push(directory);
  return writeHourlyBackfillArtifact(source(), join(directory, 'prepared.jsonl'), { hours: 2 });
}

async function rewrite(path: string, mutate: (lines: Record<string, unknown>[]) => void): Promise<string> {
  const lines = (await readFile(path, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  mutate(lines);
  const value = `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`;
  await writeFile(path, value);
  return createHash('sha256').update(value).digest('hex');
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('finalized hourly archive preparation', () => {
  it('enters the preparation CLI without a circular top-level await or any real network request', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'hourly-history-cli-'));
    directories.push(directory);
    const preload = join(directory, 'offline.mjs');
    await writeFile(preload, "globalThis.fetch = async () => { throw new Error('OFFLINE_ARCHIVE_FIXTURE'); };\n");
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--import', preload,
      resolve('src/scripts/backfill-hourly-history.ts'), '--hours=1', `--output=${join(directory, 'output.jsonl')}`],
    { encoding: 'utf8', timeout: 10_000 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('OFFLINE_ARCHIVE_FIXTURE');
    expect(child.stderr).not.toContain('unsettled top-level await');
  });

  it('passes the required empty map arguments on each bounded archive storage page', async () => {
    const codec = { toJSON: () => [], toHuman: () => ({}), toString: () => '0', toHex: () => '0x00' };
    const page = Array.from({ length: 256 }, (_, index) => [
      { ...codec, args: [], toHex: () => `0x${index.toString(16).padStart(4, '0')}` }, codec,
    ] as const);
    const entriesPaged = vi.fn().mockResolvedValueOnce(page).mockResolvedValueOnce([]);
    const storage = Object.assign(async () => codec, { entriesPaged });
    let entries = 0;
    for await (const _entry of readHourlyArchiveEntries(storage)) entries += 1;
    expect(entries).toBe(256);
    expect(entriesPaged).toHaveBeenNthCalledWith(1, { args: [], pageSize: 256, startKey: undefined });
    expect(entriesPaged).toHaveBeenNthCalledWith(2, { args: [], pageSize: 256, startKey: '0x00ff' });
  });

  it('permits runtime metadata negotiation and rejects signing or arbitrary runtime calls', async () => {
    const fetcher = vi.fn(async (_url: unknown, options: RequestInit) => {
      const requests = JSON.parse(String(options.body)) as Array<{ id: number }>;
      return new Response(JSON.stringify(requests.map((request) => ({ jsonrpc: '2.0', id: request.id, result: '0x00' }))));
    });
    vi.stubGlobal('fetch', fetcher);
    const provider = new HourlyArchiveHttpProvider('https://mof2.sora.org/');
    expect(await provider.send('state_call', ['Metadata_metadata_versions', '0x'])).toBe('0x00');
    await expect(provider.send('author_submitExtrinsic', ['0x00'])).rejects.toThrow('read-only');
    await expect(provider.send('state_call', ['Other_runtime_api', '0x'])).rejects.toThrow('read-only');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://mof2.sora.org/');
  });

  it('finds exact adjacent closed-hour blocks and preserves exact prices and denomination', async () => {
    const archive = source();
    const rows = [];
    for await (const row of prepareHourlyBackfill(archive, { hours: 2 })) rows.push(row);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ startAt: 3_600, endAt: 10_800, finalized: block(7) });
    expect(rows[1]).toMatchObject({ boundary: 7_200, before: block(4), after: block(5), denominator: '1000000000000000000000000000001' });
    expect(rows[2]).toMatchObject({ boundary: 10_800, before: block(6), after: block(7) });
    expect(archive.observation).toHaveBeenCalledTimes(2);
    expect(archive.observation).toHaveBeenNthCalledWith(1, block(4));
    expect((rows[1] as HourlyBackfillRow).prices[0]?.value).toBe('1234567890123456789');
  });

  it.each([0, 2161, 1.5, Number.NaN])('rejects unbounded hours %s before archive calls', async (hours) => {
    const archive = source();
    archive.genesisHash = vi.fn(archive.genesisHash);
    await expect(prepareHourlyBackfill(archive, { hours }).next()).rejects.toThrow('hours');
    expect(archive.genesisHash).not.toHaveBeenCalled();
  });

  it('rejects the wrong chain and a non-finalized requested window', async () => {
    await expect(prepareHourlyBackfill({ ...source(), genesisHash: async () => hash(99) }, { hours: 2 }).next()).rejects.toThrow('genesis');
    await expect(prepareHourlyBackfill(source(), { hours: 2, endAt: 14_400 }).next()).rejects.toThrow('finalized range');
  });

  it('does not publish a completed file after an inconsistent parent proof', async () => {
    const archive = source();
    archive.block = async (height) => ({ ...block(height), parentHash: hash(999) });
    const directory = await mkdtemp(join(tmpdir(), 'hourly-history-repair-'));
    directories.push(directory);
    const path = join(directory, 'bad.jsonl');
    await expect(writeHourlyBackfillArtifact(archive, path, { hours: 2 })).rejects.toThrow('evidence');
    await expect(readFile(path)).rejects.toThrow();
  });

  it('records unavailable prices separately while emitting all seven observed assets', async () => {
    const archive = source();
    const observe = archive.observation;
    archive.observation = async (at) => ({ ...await observe(at), prices: [] });
    const directory = await mkdtemp(join(tmpdir(), 'hourly-history-repair-'));
    directories.push(directory);
    const result = await writeHourlyBackfillArtifact(archive, join(directory, 'unpriced.jsonl'), { hours: 2 });
    expect(result.documents).toBe(14);
    expect(result.missing).toEqual(Object.fromEntries(HOURLY_HISTORY_ASSETS.map((asset) => [asset.symbol, 2])));
  });
});

describe('owner-only hourly snapshot repair', () => {
  it('upgrades existing same-block hourly rows with new direct-pair evidence despite a legacy repair receipt', async () => {
    const file = await artifact();
    const repository = new MemoryRepository();
    const options = { ...file, genesisHash: HOURLY_GENESIS_HASH, finalizedHeight: 7 };
    await applyHourlyBackfillFile(repository, options);
    const before = await repository.list('assetSnapshots');
    expect(before[0]?.data.closeEvidence).not.toHaveProperty('xorPool');
    const sha256 = await rewrite(file.path, (lines) => {
      for (const line of lines.slice(1)) line.xorPoolsComplete = true;
    });
    expect(await applyHourlyBackfillFile(repository, { ...options, sha256 })).toMatchObject({ status: 'applied', changed: 14 });
    const after = await repository.list('assetSnapshots');
    expect(after.map(({ id, blockHeight }) => ({ id, blockHeight }))).toEqual(before.map(({ id, blockHeight }) => ({ id, blockHeight })));
    expect(after.every((row) => (row.data.closeEvidence as Record<string, unknown>).xorPool === null)).toBe(true);
    expect(await applyHourlyBackfillFile(repository, { ...options, sha256 })).toMatchObject({ status: 'already-applied', changed: 0 });
  });

  it.each([false, true])('keeps legacy coverage unknown and publishes explicit complete XOR coverage (%s)', async (complete) => {
    const file = await artifact();
    const sha256 = complete ? await rewrite(file.path, (lines) => {
      for (const line of lines.slice(1)) line.xorPoolsComplete = true;
    }) : file.sha256;
    const repository = new MemoryRepository();
    await applyHourlyBackfillFile(repository, { ...file, sha256, genesisHash: HOURLY_GENESIS_HASH, finalizedHeight: 7 });
    const rows = await repository.list('assetSnapshots');
    for (const row of rows) {
      if (complete) expect(row.data.closeEvidence).toHaveProperty('xorPool', null);
      else expect(row.data.closeEvidence).not.toHaveProperty('xorPool');
    }
  });

  it('rejects malformed direct-pool completeness before any write', async () => {
    const file = await artifact();
    const sha256 = await rewrite(file.path, (lines) => { lines[2]!.xorPoolsComplete = 'true'; });
    const repository = new MemoryRepository();
    await expect(applyHourlyBackfillFile(repository, { ...file, sha256, genesisHash: HOURLY_GENESIS_HASH, finalizedHeight: 7 })).rejects.toThrow('completeness');
    expect(await repository.list('assetSnapshots')).toEqual([]);
  });

  it('round trips a nonwinning reversed direct pool without changing the stable USD mark', async () => {
    const file = await artifact();
    const xor = HOURLY_HISTORY_ASSETS[0]!.id, kusd = HOURLY_HISTORY_ASSETS[4]!.id;
    const sha256 = await rewrite(file.path, (lines) => {
      for (const line of lines.slice(1)) {
        line.xorPoolsComplete = true;
        line.pools = [{ baseAssetId: kusd, targetAssetId: xor, baseAssetReserves: '456789', targetAssetReserves: '1234567890123456789' }];
        line.priceRoutes = HOURLY_HISTORY_ASSETS.map((asset) => ({ id: asset.id, poolIds: [] }));
      }
    });
    const repository = new MemoryRepository();
    await applyHourlyBackfillFile(repository, { ...file, sha256, genesisHash: HOURLY_GENESIS_HASH, finalizedHeight: 7 });
    const row = (await repository.list('assetSnapshots')).find((item) => item.data.assetId === kusd)!;
    expect(row.data.priceUSD).toEqual({ close: '1.234567890123456789' });
    expect(row.data.closeEvidence).toMatchObject({ pools: [], xorPool: {
      baseAssetId: xor, targetAssetId: kusd, baseAssetReserves: '1234567890123456789', targetAssetReserves: '456789',
      baseDecimals: 18, targetDecimals: 18,
    } });
  });

  it('changes only CLOSE/provenance, preserves nonempty fields and leaves current assets/checkpoint untouched', async () => {
    const file = await artifact();
    const { rows } = await readHourlyBackfillArtifact(file.path, file.sha256);
    const row = rows[0]!;
    const initial = buildAssetHourlyCloseDocumentsAtBoundary({
      ...row, genesisHash: HOURLY_GENESIS_HASH,
      assets: new Map(row.assets.map((asset) => [asset.id, asset])),
      prices: new Map(row.prices.map((price) => [price.id, BigInt(price.value)])),
      priceRoutes: undefined,
      pools: [],
    })[0]!;
    const prior = { ...initial, blockHeight: 100, data: { ...initial.data,
      priceUSD: { open: '2', high: '3', low: '1.5', close: '9', custom: 'retained' },
      volume: { amount: '98765432109876543210', amountUSD: '12' }, supply: '123456789012345678901', mint: '10', burn: '2' } };
    const repository = new MemoryRepository();
    await repository.upsert(prior);
    const checkpoint = { collection: 'updatesStreams' as const, id: 'chainState', blockHeight: 500, data: { id: 'chainState', blockHeight: 500 } };
    const latest = { collection: 'assets' as const, id: HOURLY_HISTORY_ASSETS[0]!.id, blockHeight: 500, data: { priceUSD: '999' } };
    await repository.upsertMany([checkpoint, latest]);
    const result = await applyHourlyBackfillFile(repository, { ...file, genesisHash: HOURLY_GENESIS_HASH, finalizedHeight: 500 });
    expect(result).toEqual({ status: 'applied', hours: 2, documents: 14, changed: 14 });
    const saved = await repository.get('assetSnapshots', prior.id);
    expect(saved?.blockHeight).toBe(100);
    expect(saved?.data.priceUSD).toEqual({ open: '2', high: '3', low: '1.5', close: '1.234567890123456789', custom: 'retained' });
    expect(saved?.data).toMatchObject({ volume: prior.data.volume, supply: prior.data.supply, mint: '10', burn: '2', denominator: row.denominator });
    expect(saved?.data.closeEvidence).toMatchObject({ blockHash: row.before.hash, blockHeight: row.before.height, nextBlockHash: row.after.hash });
    expect(await repository.get('updatesStreams', 'chainState')).toEqual(checkpoint);
    expect(await repository.get('assets', latest.id)).toEqual(latest);
    const writes = vi.spyOn(repository, 'upsertMany');
    expect(await applyHourlyBackfillFile(repository, { ...file, genesisHash: HOURLY_GENESIS_HASH, finalizedHeight: 500 })).toMatchObject({ status: 'already-applied', changed: 0 });
    expect(writes).not.toHaveBeenCalled();
  });

  it('resumes safely after a partial batch failure without duplicating completed hours', async () => {
    const file = await artifact();
    const repository = new MemoryRepository();
    const original = repository.upsertMany.bind(repository);
    const writes = vi.spyOn(repository, 'upsertMany');
    writes.mockImplementationOnce(original).mockRejectedValueOnce(new Error('interrupted'));
    const options = { ...file, genesisHash: HOURLY_GENESIS_HASH, finalizedHeight: 7 };
    await expect(applyHourlyBackfillFile(repository, options)).rejects.toThrow('interrupted');
    expect(await repository.list('assetSnapshots')).toHaveLength(7);
    writes.mockRestore();
    expect(await applyHourlyBackfillFile(repository, options)).toMatchObject({ documents: 14, changed: 7 });
    expect(await repository.list('assetSnapshots')).toHaveLength(14);
  });

  it('verifies the entire artifact before writing even when the last hour is invalid', async () => {
    const file = await artifact();
    const sha256 = await rewrite(file.path, (lines) => { lines[2]!.denominator = '0'; });
    const repository = new MemoryRepository();
    const writes = vi.spyOn(repository, 'upsertMany');
    await expect(applyHourlyBackfillFile(repository, { ...file, sha256, genesisHash: HOURLY_GENESIS_HASH, finalizedHeight: 7 })).rejects.toThrow('evidence');
    expect(writes).not.toHaveBeenCalled();
  });

  it('refuses a hash mismatch, active-chain mismatch, or insufficient finalized height', async () => {
    const file = await artifact();
    const repository = new MemoryRepository();
    await expect(readHourlyBackfillArtifact(file.path, '0'.repeat(64))).rejects.toThrow('SHA-256 mismatch');
    for (const proof of [{ genesisHash: hash(99), finalizedHeight: 7 }, { genesisHash: HOURLY_GENESIS_HASH, finalizedHeight: 6 }]) {
      await expect(applyHourlyBackfillFile(repository, { ...file, ...proof })).rejects.toThrow('active finalized chain');
    }
    expect(await repository.list('assetSnapshots')).toEqual([]);
  });
});
