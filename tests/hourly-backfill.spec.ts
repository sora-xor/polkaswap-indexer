import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MemoryRepository } from '../src/repository/memory.js';
import { RocksRepository } from '../src/repository/rocksdb.js';
import { readConfig } from '../src/config.js';
import { HOURLY_HISTORY_ASSETS, buildAssetHourlyCloseDocumentsAtBoundary, type HourlyHistoryTarget } from '../src/worker/hourly-history.js';
import { hourlyCloseMetadata } from '../src/graphql/hourly-history.js';
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

// Public catalogue IDs; all observations below remain synthetic and offline.
const extraTargets: HourlyHistoryTarget[] = [
  { id: '0x00d1fb79bbd1005a678fbf2de9256b3afe260e8eead49bb07bd3a566f9fe8355', symbol: 'GRT' },
  { id: '0x0500ed06084001e2d8a5674b9728d2da5ecb0000000000000000000000000000', symbol: 'KCNY' },
  { id: '0x02000a0000000000000000000000000000000000000000000000000000000000', symbol: 'TBCD' },
  { id: '0x006a271832f44c93bd8692584d85415f0f3dccef9748fecd129442c8edcb4361', symbol: 'VXOR' },
  { id: '0x0200090000000000000000000000000000000000000000000000000000000000', symbol: 'XST' },
  { id: '0x0200080000000000000000000000000000000000000000000000000000000000', symbol: 'XSTUSD' },
];
function dynamicSource(targets = extraTargets): HourlyBackfillSource {
  return { ...source(), observation: vi.fn(async () => ({
    denominator: '1000000000000000000000000000001', xorPoolsComplete: true as const,
    assets: [...HOURLY_HISTORY_ASSETS.map((asset) => ({ ...asset, decimals: 18 })),
      ...targets.map((asset, index) => ({ ...asset, symbol: index === 0 ? 'OLD_GRT' : asset.symbol, decimals: index === 0 ? 6 : 18 }))],
    prices: targets.map((asset) => ({ id: asset.id, value: '1234567890123456789' })),
    pools: targets.map((asset) => ({ baseAssetId: HOURLY_HISTORY_ASSETS[0]!.id, targetAssetId: asset.id,
      baseAssetReserves: '1234567890123456789', targetAssetReserves: '987654321' })),
  })) };
}
async function dynamicArtifact(targets = extraTargets) {
  const directory = await mkdtemp(join(tmpdir(), 'hourly-dynamic-repair-'));
  directories.push(directory);
  return writeHourlyBackfillArtifact(dynamicSource(targets), join(directory, 'prepared.jsonl'), { hours: 2, targets });
}

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
    { encoding: 'utf8', timeout: 30_000 });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(1);
    expect(child.stderr).toContain('OFFLINE_ARCHIVE_FIXTURE');
    expect(child.stderr).not.toContain('unsettled top-level await');
  }, 45_000);

  it.each(['invalid', 'oversized'])('validates a %s --targets file before any network initialization', async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), 'hourly-target-cli-')); directories.push(directory);
    const targets = join(directory, 'targets.json');
    await writeFile(targets, kind === 'invalid' ? JSON.stringify([{ ...HOURLY_HISTORY_ASSETS[0], symbol: 'FALSE_XOR' }]) : ' '.repeat(128 * 1024 + 1));
    const preload = join(directory, 'offline.mjs');
    await writeFile(preload, "globalThis.fetch = async () => { throw new Error('TARGET_NETWORK_WAS_CALLED'); };\n");
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--import', preload,
      resolve('src/scripts/backfill-hourly-history.ts'), `--targets=${targets}`, '--hours=1', `--output=${join(directory, 'output.jsonl')}`],
    { encoding: 'utf8', timeout: 30_000 });
    expect(child.error).toBeUndefined(); expect(child.status).toBe(1);
    expect(child.stderr).toContain(kind === 'invalid' ? 'target identity' : 'target file exceeds byte limit');
    expect(child.stderr).not.toContain('TARGET_NETWORK_WAS_CALLED');
    await expect(readFile(join(directory, 'output.jsonl.partial'))).rejects.toThrow();
  }, 45_000);

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

  it.each([false, true])('reports validated artifact hours without a progress callback (explicit scope: %s)', async (explicit) => {
    const directory = await mkdtemp(join(tmpdir(), 'hourly-count-no-progress-'));
    directories.push(directory);
    const targets = explicit ? extraTargets : undefined;
    const result = await writeHourlyBackfillArtifact(
      explicit ? dynamicSource() : source(), join(directory, 'prepared.jsonl'), { hours: 2, targets }
    );
    const validated = await readHourlyBackfillArtifact(result.path, result.sha256);
    expect(result.hours).toBe(2);
    expect(result.hours).toBe(validated.rows.length);
    expect(validated.manifest.endAt - validated.manifest.startAt).toBe(result.hours * 3_600);
    expect(result.documents).toBe(result.hours * (targets ?? HOURLY_HISTORY_ASSETS).length);
    if (explicit) expect(validated.manifest).toMatchObject({ version: 2, targets: extraTargets });
    else {
      expect(validated.manifest.version).toBe(1);
      expect(validated.manifest).not.toHaveProperty('targets');
    }
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


describe('explicit hourly artifact target scope', () => {
  it('keeps the implicit v1 manifest, seven-document counts and receipt namespace unchanged', async () => {
    const file = await artifact();
    const { manifest } = await readHourlyBackfillArtifact(file.path, file.sha256);
    expect(Object.keys(manifest)).toEqual(['kind', 'version', 'archiveEndpoint', 'genesisHash', 'startAt', 'endAt', 'finalized']);
    expect(manifest.version).toBe(1);
    expect(file.documents).toBe(14);
    const repository = new MemoryRepository();
    await applyHourlyBackfillFile(repository, { ...file, genesisHash: HOURLY_GENESIS_HASH, finalizedHeight: 7 });
    expect(await repository.get('updatesStreams', `hourlyHistoryRepair-v1-${file.sha256}`)).not.toBeNull();
    expect(await repository.get('updatesStreams', 'hourlyHistoryTargets-v1')).toBeNull();
  });

  it('imports the six additional census IDs only, retaining actual historical rename/precision and separate v2 receipts', async () => {
    const file = await dynamicArtifact();
    const { manifest } = await readHourlyBackfillArtifact(file.path, file.sha256);
    expect(manifest).toMatchObject({ version: 2, targets: extraTargets });
    expect(file.documents).toBe(12);
    expect(Object.keys(file.missing)).toEqual(extraTargets.map(({ id }) => id));
    const repository = new MemoryRepository();
    await applyHourlyBackfillFile(repository, { ...file, genesisHash: HOURLY_GENESIS_HASH, finalizedHeight: 7 });
    const rows = await repository.list('assetSnapshots');
    expect(rows).toHaveLength(12);
    expect(new Set(rows.map((row) => row.data.assetId))).toEqual(new Set(extraTargets.map(({ id }) => id)));
    const renamed = rows.find((row) => row.data.assetId === extraTargets[0]!.id)!;
    expect(renamed.data.closeEvidence).toMatchObject({ requestedSymbol: 'GRT', symbol: 'OLD_GRT', decimals: 6,
      xorPool: { targetDecimals: 6, targetAssetReserves: '987654321' } });
    expect(hourlyCloseMetadata(renamed, extraTargets[0]!.id, Math.floor(renamed.timestamp! / 3_600) * 3_600)).toMatchObject({ proofStatus: 'VERIFIED', poolStatus: 'USABLE', decimals: 6 });
    expect((await repository.get('updatesStreams', `hourlyHistoryRepair-v2-${file.sha256}`))?.data).toMatchObject({
      artifactVersion: 2, targets: extraTargets, documents: 12, complete: true,
    });
    expect(await repository.get('updatesStreams', `hourlyHistoryRepair-v1-${file.sha256}`)).toBeNull();
    const catalogue = await repository.get('updatesStreams', 'hourlyHistoryTargets-v1');
    expect(catalogue?.blockHeight).toBe(7);
    expect(catalogue?.data.targets).toHaveLength(13);
    expect(catalogue?.data.targets).toEqual(expect.arrayContaining([...HOURLY_HISTORY_ASSETS, ...extraTargets]));
    expect(await applyHourlyBackfillFile(repository, { ...file, genesisHash: HOURLY_GENESIS_HASH, finalizedHeight: 7 })).toMatchObject({ status: 'already-applied', changed: 0 });
  });

  it.each([
    ['missing targets', (manifest: Record<string, unknown>) => { delete manifest.targets; }],
    ['empty scope', (manifest: Record<string, unknown>) => { manifest.targets = []; }],
    ['duplicate IDs', (manifest: Record<string, unknown>) => { manifest.targets = [extraTargets[0], extraTargets[0]]; }],
    ['noncanonical ID', (manifest: Record<string, unknown>) => { manifest.targets = [{ id: 'GRT', symbol: 'GRT' }]; }],
    ['known wrong symbol', (manifest: Record<string, unknown>) => { manifest.targets = [{ ...HOURLY_HISTORY_ASSETS[0], symbol: 'GRT' }]; }],
    ['smuggled manifest field', (manifest: Record<string, unknown>) => { manifest.collection = 'assets'; }],
    ['smuggled target field', (manifest: Record<string, unknown>) => { manifest.targets = [{ ...extraTargets[0], collection: 'assets' }]; }],
    ['v1 scope relabel', (manifest: Record<string, unknown>) => { manifest.version = 1; }],
  ])('rejects %s before any repository writes', async (_name, change) => {
    const file = await dynamicArtifact();
    const sha256 = await rewrite(file.path, (lines) => change(lines[0]!));
    const repository = new MemoryRepository();
    const writes = vi.spyOn(repository, 'upsertMany'); const singles = vi.spyOn(repository, 'upsert');
    await expect(applyHourlyBackfillFile(repository, { ...file, sha256, genesisHash: HOURLY_GENESIS_HASH, finalizedHeight: 7 })).rejects.toThrow();
    expect(writes).not.toHaveBeenCalled(); expect(singles).not.toHaveBeenCalled();
  });

  it('rejects incidental pricing targets, while preserving existing catalogue descriptors across legitimate renames', async () => {
    const file = await dynamicArtifact();
    const sha256 = await rewrite(file.path, (lines) => {
      (lines[2]!.prices as unknown[]).push({ id: HOURLY_HISTORY_ASSETS[0]!.id, value: '1' });
    });
    const repository = new MemoryRepository();
    const writes = vi.spyOn(repository, 'upsertMany');
    await expect(applyHourlyBackfillFile(repository, { ...file, sha256, genesisHash: HOURLY_GENESIS_HASH, finalizedHeight: 7 })).rejects.toThrow();
    expect(writes).not.toHaveBeenCalled();
    const clean = await dynamicArtifact();
    await repository.upsert({ collection: 'updatesStreams', id: 'hourlyHistoryTargets-v1', blockHeight: 7,
      data: { id: 'hourlyHistoryTargets-v1', targets: [{ ...extraTargets[0], symbol: 'OTHER_CATALOGUE' }] } });
    await applyHourlyBackfillFile(repository, { ...clean, genesisHash: HOURLY_GENESIS_HASH, finalizedHeight: 7 });
    expect((await repository.get('updatesStreams', 'hourlyHistoryTargets-v1'))?.data.targets)
      .toEqual(expect.arrayContaining([{ ...extraTargets[0], symbol: 'OTHER_CATALOGUE' }]));
    expect((await repository.get('updatesStreams', `hourlyHistoryRepair-v2-${clean.sha256}`))?.data.targets).toEqual(extraTargets);
    expect(await applyHourlyBackfillFile(repository, { ...clean, genesisHash: HOURLY_GENESIS_HASH, finalizedHeight: 7 }))
      .toMatchObject({ status: 'already-applied', changed: 0 });
  });

  it('rejects a malformed persisted catalogue before writing any hour', async () => {
    const file = await dynamicArtifact(); const repository = new MemoryRepository();
    await repository.upsert({ collection: 'updatesStreams', id: 'hourlyHistoryTargets-v1', blockHeight: 7,
      data: { id: 'hourlyHistoryTargets-v1', targets: [{ ...HOURLY_HISTORY_ASSETS[0], symbol: 'FALSE_XOR' }] } });
    const writes = vi.spyOn(repository, 'upsertMany');
    await expect(applyHourlyBackfillFile(repository, { ...file, genesisHash: HOURLY_GENESIS_HASH, finalizedHeight: 7 })).rejects.toThrow();
    expect(writes).not.toHaveBeenCalled();
  });

  it('does not register targets after interrupted or unverified writes, and safely resumes completed hours', async () => {
    const file = await dynamicArtifact(); const repository = new MemoryRepository();
    const original = repository.upsertMany.bind(repository);
    const writes = vi.spyOn(repository, 'upsertMany').mockImplementationOnce(original).mockRejectedValueOnce(new Error('interrupted-v2'));
    const options = { ...file, genesisHash: HOURLY_GENESIS_HASH, finalizedHeight: 7 };
    await expect(applyHourlyBackfillFile(repository, options)).rejects.toThrow('interrupted-v2');
    expect(await repository.list('assetSnapshots')).toHaveLength(6);
    expect(await repository.get('updatesStreams', 'hourlyHistoryTargets-v1')).toBeNull();
    expect(await repository.get('updatesStreams', `hourlyHistoryRepair-v2-${file.sha256}`)).toBeNull();
    writes.mockRestore();
    expect(await applyHourlyBackfillFile(repository, options)).toMatchObject({ documents: 12, changed: 6 });
    const second = new MemoryRepository();
    vi.spyOn(second, 'upsertMany').mockResolvedValue(undefined);
    await expect(applyHourlyBackfillFile(second, options)).rejects.toThrow('write verification');
    expect(await second.get('updatesStreams', 'hourlyHistoryTargets-v1')).toBeNull();
  });

  it('counts unavailable v2 prices by ID even when two targets share a symbol', async () => {
    const targets = [extraTargets[0]!, { ...extraTargets[1]!, symbol: 'GRT' }];
    const archive = dynamicSource(targets); const observe = archive.observation;
    archive.observation = async (at) => ({ ...await observe(at), prices: [{ id: targets[0]!.id, value: '1' }] });
    const directory = await mkdtemp(join(tmpdir(), 'hourly-shared-symbol-')); directories.push(directory);
    const result = await writeHourlyBackfillArtifact(archive, join(directory, 'prepared.jsonl'), { hours: 2, targets });
    expect(result.missing).toEqual({ [targets[0]!.id]: 0, [targets[1]!.id]: 2 });
  });

  it('checks completed v2 receipt scope and retained target catalogue on replay', async () => {
    const file = await dynamicArtifact(); const repository = new MemoryRepository();
    const options = { ...file, genesisHash: HOURLY_GENESIS_HASH, finalizedHeight: 7 };
    await applyHourlyBackfillFile(repository, options);
    const receipt = (await repository.get('updatesStreams', `hourlyHistoryRepair-v2-${file.sha256}`))!;
    await repository.upsert({ ...receipt, data: { ...receipt.data, targets: [extraTargets[0]] } });
    const writes = vi.spyOn(repository, 'upsertMany');
    await expect(applyHourlyBackfillFile(repository, options)).rejects.toThrow('scope');
    expect(writes).not.toHaveBeenCalled();
    await repository.upsert(receipt);
    const catalogue = (await repository.get('updatesStreams', 'hourlyHistoryTargets-v1'))!;
    await repository.upsert({ ...catalogue, data: { ...catalogue.data, targets: [...HOURLY_HISTORY_ASSETS] } });
    await expect(applyHourlyBackfillFile(repository, options)).rejects.toThrow('catalogue');
    expect(writes).not.toHaveBeenCalled();
  });

  it.each([{ targets: [] }, { targets: [extraTargets[0], extraTargets[0]] }, { targets: [{ id: 'GRT', symbol: 'GRT' }] }])(
    'validates explicit targets before archive calls: %o', async ({ targets }) => {
      const archive = dynamicSource(); archive.genesisHash = vi.fn(archive.genesisHash);
      await expect(prepareHourlyBackfill(archive, { hours: 2, targets: targets as HourlyHistoryTarget[] }).next()).rejects.toThrow();
      expect(archive.genesisHash).not.toHaveBeenCalled();
    }
  );
});

describe('native single-owner hourly repair', () => {
  it.each(['v1', 'v2'])('preserves current state and historical fields through interruption, reopen and replay (%s)', async (version) => {
    const file = version === 'v1' ? await artifact() : await dynamicArtifact();
    const perHour = version === 'v1' ? 7 : extraTargets.length;
    const directory = await mkdtemp(join(tmpdir(), 'hourly-native-repair-'));
    directories.push(directory);
    const config = { ...readConfig(), storageEngine: 'rocksdb' as const,
      rocksdbPath: join(directory, 'indexer.rocksdb'), rocksdbBlockCacheMb: 16,
      rocksdbWriteBufferManagerMb: 16, rocksdbDocumentCacheMax: 0, rocksdbDocumentCacheMaxBytes: 0 };
    let repository = new RocksRepository(config);
    const options = { ...file, genesisHash: HOURLY_GENESIS_HASH, finalizedHeight: 500 };
    try {
      await repository.prepare();
      const { rows } = await readHourlyBackfillArtifact(file.path, file.sha256);
      const row = rows[0]!;
      const assetId = version === 'v1' ? HOURLY_HISTORY_ASSETS[0]!.id : extraTargets[0]!.id;
      const id = `asset-${assetId}-HOUR-${row.boundary - 3600}`;
      const prior = { collection: 'assetSnapshots' as const, id, blockHeight: 100, timestamp: row.before.timestamp,
        data: { id, assetId, type: 'HOUR', timestamp: row.before.timestamp,
          priceUSD: { open: '2', high: '3', low: '1.5', close: '9' },
          supply: '123456789012345678901', volume: { amount: '98765432109876543210', amountUSD: '12' } } };
      const checkpoint = { collection: 'updatesStreams' as const, id: 'chainState', blockHeight: 500,
        data: { id: 'chainState', block: 500, data: '{"lastIndexedBlock":500}' } };
      const latest = { collection: 'assets' as const, id: assetId, blockHeight: 500, data: { id: assetId, priceUSD: '999' } };
      await repository.upsertMany([prior, checkpoint, latest]);
      const write = repository.upsertMany.bind(repository);
      const writes = vi.spyOn(repository, 'upsertMany');
      writes.mockImplementationOnce(write).mockRejectedValueOnce(new Error('interrupted-hourly-repair'));
      await expect(applyHourlyBackfillFile(repository, options)).rejects.toThrow('interrupted-hourly-repair');
      expect(await repository.get('updatesStreams', `hourlyHistoryRepair-${version}-${file.sha256}`)).toBeNull();
      expect(await repository.get('updatesStreams', 'hourlyHistoryTargets-v1')).toBeNull();
      expect(await repository.get('updatesStreams', 'chainState')).toEqual(checkpoint);
      expect(await repository.get('assets', assetId)).toEqual(latest);
      writes.mockRestore();
      await repository.close();
      repository = new RocksRepository(config);
      await repository.prepare();
      expect(await applyHourlyBackfillFile(repository, options)).toMatchObject({ status: 'applied', hours: 2, documents: perHour * 2, changed: perHour });
      const saved = await repository.get('assetSnapshots', id);
      expect(saved?.data.priceUSD).toEqual({ open: '2', high: '3', low: '1.5', close: '1.234567890123456789' });
      expect(saved?.data).toMatchObject({ supply: prior.data.supply, volume: prior.data.volume, denominator: row.denominator });
      expect(saved?.blockHeight).toBe(100);
      expect(saved?.data.closeEvidence).toMatchObject({ blockHeight: row.before.height, blockHash: row.before.hash, nextBlockHash: row.after.hash });
      expect(await repository.get('updatesStreams', 'chainState')).toEqual(checkpoint);
      expect(await repository.get('assets', assetId)).toEqual(latest);
      await repository.validateCompactIndexes();
      await repository.close();
      repository = new RocksRepository(config);
      await repository.prepare();
      const replay = vi.spyOn(repository, 'upsertMany');
      expect(await applyHourlyBackfillFile(repository, options)).toMatchObject({ status: 'already-applied', changed: 0 });
      expect(replay).not.toHaveBeenCalled();
      expect(await repository.get('assetSnapshots', id)).toEqual(saved);
    } finally {
      await repository.close();
    }
  });
});
