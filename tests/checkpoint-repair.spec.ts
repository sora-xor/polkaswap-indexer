import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => ({ create: vi.fn(), providers: [] as Array<{ disconnect: ReturnType<typeof vi.fn> }> }));
vi.mock('@polkadot/api', () => ({
  ApiPromise: { create: rpc.create },
  WsProvider: class {
    disconnect = vi.fn(async () => undefined);
    constructor() { rpc.providers.push(this); }
  },
}));

import { readConfig } from '../src/config.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { RocksRepository } from '../src/repository/rocksdb.js';
import { ChainIndexer } from '../src/worker/chain.js';
import { createCheckpointProjectionCapture } from '../src/worker/checkpointRepair.js';
import { readCheckpointRepairOptions, repairRocksdbLegacyCheckpoint } from '../src/scripts/repair-rocksdb-legacy-checkpoint.js';
import { createPostgresRocksdbMigrationState, POSTGRES_ROCKSDB_MIGRATION_STATE_KEY } from '../src/scripts/rocksdb-migration-state.js';
import { captureSentinelHash } from '../src/scripts/postgres-rocksdb-capture.js';
import { INDEXER_COLLECTIONS, type IndexerDocument } from '../src/repository/types.js';
import { SORA_MAINNET_GENESIS_HASH, SORA_LEGACY_IDENTITY_ANCHOR } from '../src/soraIdentity.js';

const BLOCK = 27_159_179;
const TIME = 1_785_761_832;
const hash = (digit: string) => `0x${digit.repeat(64)}`;
const HASH = hash('a');
const PARENT = hash('b');
const HISTORY = hash('c');
const FINALIZED = hash('d');
const XOR = '0x0200000000000000000000000000000000000000000000000000000000000000';
const DAI = '0x0200060000000000000000000000000000000000000000000000000000000000';
const codec = (value: unknown) => ({ toString: () => String(value), toJSON: () => value });

const originals = (): IndexerDocument[] => [
  { collection: 'updatesStreams', id: 'chainState', blockHeight: BLOCK, timestamp: TIME + 21,
    data: { id: 'chainState', block: BLOCK, data: JSON.stringify({ lastIndexedBlock: BLOCK }) } },
  ...[[BLOCK - 1, TIME - 6], [SORA_LEGACY_IDENTITY_ANCHOR.block, SORA_LEGACY_IDENTITY_ANCHOR.timestamp]].map(([block, timestamp]) => ({
    collection: 'networkSnapshots' as const, id: `block-${block}`, blockHeight: block, timestamp,
    data: { id: `block-${block}`, type: 'BLOCK', timestamp, accounts: 7, fees: '999', liquidityUSD: '777' },
  })),
  { collection: 'accountMeta', id: 'untouched', data: { id: 'untouched', existingCounter: '123' } },
  { collection: 'referrerRewards', id: 'untouched', data: { id: 'untouched', amount: '123' } },
];

const makeApi = () => {
  const header = (block: number) => ({ number: { toNumber: () => block }, hash: codec(block === BLOCK ? HASH : block === BLOCK - 1 ? PARENT : FINALIZED), parentHash: codec(PARENT) });
  const events = Object.assign([{ phase: { isApplyExtrinsic: true, asApplyExtrinsic: { toNumber: (): number => 0 } },
    event: { section: 'system', method: 'ExtrinsicSuccess', data: { toArray: () => [] } } }], { toHex: (): string => '0x010203' });
  const extrinsic = { isSigned: false, hash: codec(HISTORY), method: { section: 'timestamp', method: 'set',
    args: [codec(TIME * 1_000)], meta: { args: [{ name: 'now' }] } } };
  const api = {
    events,
    extrinsic,
    header,
    disconnect: vi.fn(async () => undefined),
    rpc: { chain: {
      getBlockHash: vi.fn(async (block: number) => codec(block === 0 ? SORA_MAINNET_GENESIS_HASH :
        block === SORA_LEGACY_IDENTITY_ANCHOR.block ? SORA_LEGACY_IDENTITY_ANCHOR.hash : block === BLOCK - 1 ? PARENT : HASH)),
      getFinalizedHead: vi.fn(async () => codec(FINALIZED)),
      getHeader: vi.fn(async () => header(BLOCK + 2)),
      getBlock: vi.fn(async (requested: string) => ({ block: {
        header: header(requested === PARENT ? BLOCK - 1 : BLOCK),
        extrinsics: [extrinsic], toHex: () => '0x040506',
      } })),
    } },
    query: { timestamp: { now: { at: vi.fn(async (requested: string) => codec((requested === SORA_LEGACY_IDENTITY_ANCHOR.hash ?
      SORA_LEGACY_IDENTITY_ANCHOR.timestamp : requested === PARENT ? TIME - 6 : TIME) * 1_000)) } } },
    at: vi.fn(async (requested: string) => ({ query: {
      system: { events: vi.fn(async () => events) },
      timestamp: { now: vi.fn(async () => codec((requested === PARENT ? TIME - 6 : TIME) * 1_000)) },
      assets: { assetInfosV2: { entriesPaged: vi.fn(async () => [XOR, DAI].map((id) => [
        { args: [codec(id)], toHex: () => '0x01' },
        { toHuman: () => ({ symbol: id === XOR ? 'XOR' : 'DAI', name: 'asset', precision: 18 }) },
      ])) } },
      poolXYK: { reserves: { entriesPaged: vi.fn(async () => [[
        { args: [codec(XOR), codec(DAI)], toHex: () => '0x02' },
        { toJSON: () => ['1000000000000000000', '2000000000000000000'] },
      ]]) } },
    } })),
  };
  return api;
};

const migrationState = () => {
  const sourceId = '11111111-1111-4111-8111-111111111111';
  const sentinel = captureSentinelHash(sourceId);
  const state = createPostgresRocksdbMigrationState({ version: 1, sourceId, sourceDatabaseIdentity: 'a'.repeat(64),
    headSeq: '0', headHash: sentinel, sealed: false, sealedSeq: null, sealedHash: null,
    cutoverRunId: null, cutoverDestinationId: null, cutoverSeq: null, cutoverHash: null });
  return { ...state, status: 'validated_complete' as const, exportCompleted: true,
    sealedSeq: '0', sealedHash: sentinel, validatedAt: new Date().toISOString(), rows: originals().length,
    collection: 'updatesStreams', id: 'chainState' };
};

describe('offline missing legacy checkpoint projection', () => {
  let root: string;
  let primary: ReturnType<typeof makeApi>;
  let archive: ReturnType<typeof makeApi>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'checkpoint-repair-'));
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('STORAGE_ENGINE', 'rocksdb');
    vi.stubEnv('ROCKSDB_PATH', join(root, 'indexer.rocksdb'));
    vi.stubEnv('SORA_WS_ENDPOINT', 'wss://mof2.sora.org');
    vi.stubEnv('SORA_ARCHIVE_WS_ENDPOINT', 'wss://mof2.sora.org');
    vi.stubEnv('CHAIN_START_BLOCK', String(SORA_LEGACY_IDENTITY_ANCHOR.block));
    primary = makeApi(); archive = makeApi();
    rpc.create.mockReset().mockResolvedValueOnce(primary).mockResolvedValueOnce(archive);
  });
  afterEach(async () => {
    vi.restoreAllMocks(); vi.unstubAllEnvs(); rpc.providers.length = 0;
    await rm(root, { force: true, recursive: true });
  });

  const memory = async () => { const repository = new MemoryRepository(); await repository.upsertMany(originals()); return repository; };
  const prepare = async (repository?: MemoryRepository) => new ChainIndexer(readConfig(), repository ?? await memory()).prepareLegacyCheckpointBlockRepair(BLOCK);

  it('captures the normal kernel with true parent valuation and preserves all originals', async () => {
    const repository = await memory();
    const upsert = vi.spyOn(repository, 'upsert');
    const upsertMany = vi.spyOn(repository, 'upsertMany');
    const result = await prepare(repository);
    expect(result.document).toMatchObject({ id: `block-${BLOCK}`, blockHeight: BLOCK, timestamp: TIME,
      data: { accounts: 0, transactions: 0, fees: '0', volumeUSD: '0', swaps: 0,
        bridgeIncomingTransactions: 0, bridgeOutgoingTransactions: 0,
        listedAssets: 2, activePools: 1, poolLiquidityUSD: '2',
        liquidityUSD: null, orderBookLiquidityUSD: null, activeOrderBooks: null } });
    expect(result.proof).toMatchObject({ baselineBlock: BLOCK - 1, baselineHash: PARENT, baselineAssets: 2, baselinePools: 1 });
    expect(archive.at).toHaveBeenCalledWith(PARENT);
    expect(upsert).not.toHaveBeenCalled(); expect(upsertMany).not.toHaveBeenCalled();
    for (const document of originals()) expect(await repository.get(document.collection, document.id)).toEqual(document);
    expect(primary.disconnect).toHaveBeenCalled(); expect(archive.disconnect).toHaveBeenCalled();
    await repository.upsert(result.document);
    const startup = new ChainIndexer(readConfig(), repository) as unknown as {
      api: unknown; ensureChainIdentity: (finalized: number) => Promise<void>;
    };
    startup.api = primary;
    await expect(startup.ensureChainIdentity(BLOCK + 2)).resolves.toBeUndefined();
    expect(await repository.get('updatesStreams', 'chainIdentity')).toBeTruthy();
    expect(await repository.get('updatesStreams', 'chainState')).toEqual(originals()[0]);
  });

  it.each([
    ['wrong genesis', () => primary.rpc.chain.getBlockHash.mockResolvedValue(codec(hash('e')))],
    ['unfinalized target', () => primary.rpc.chain.getHeader.mockResolvedValue({ ...primary.header(BLOCK - 1), hash: codec(FINALIZED) })],
    ['wrong parent', () => {
      const original = archive.rpc.chain.getBlock.getMockImplementation()!;
      archive.rpc.chain.getBlock.mockImplementation(async (requested) => {
        const payload = await original(requested);
        if (requested === HASH) payload.block.header.parentHash = codec(hash('e'));
        return payload;
      });
    }],
    ['signed timestamp', () => { archive.extrinsic.isSigned = true; }],
    ['business call', () => { archive.extrinsic.method.section = 'assets'; }],
    ['wrong timestamp argument', () => { archive.extrinsic.method.args = [codec(TIME * 1_000 + 1)]; }],
    ['extra event', () => { archive.events.push(archive.events[0]); }],
    ['fee event', () => { archive.events[0].event.section = 'xorFee'; archive.events[0].event.method = 'FeeWithdrawn'; }],
    ['wrong event phase', () => { archive.events[0].phase.asApplyExtrinsic.toNumber = () => 1; }],
    ['initialization event', () => { archive.events[0].phase.isApplyExtrinsic = false; }],
    ['events bytes divergence', () => { archive.events.toHex = () => '0x9999'; }],
    ['extra extrinsic', () => {
      const original = archive.rpc.chain.getBlock.getMockImplementation()!;
      archive.rpc.chain.getBlock.mockImplementation(async (requested) => {
        const payload = await original(requested);
        payload.block.extrinsics.push(archive.extrinsic);
        return payload;
      });
    }],
  ] as const)('rejects %s without source writes', async (_label, mutate) => {
    mutate();
    const repository = await memory();
    const writes = vi.spyOn(repository, 'upsertMany');
    await expect(prepare(repository)).rejects.toThrow();
    expect(writes).not.toHaveBeenCalled();
    expect(await repository.get('networkSnapshots', `block-${BLOCK}`)).toBeNull();
  });

  it('pins the actual baseline lookup to the previously verified parent hash', async () => {
    let parents = 0;
    archive.rpc.chain.getBlockHash.mockImplementation(async (block) => {
      if (block === BLOCK - 1 && ++parents === 2) return codec(hash('e'));
      return codec(block === 0 ? SORA_MAINNET_GENESIS_HASH : block === SORA_LEGACY_IDENTITY_ANCHOR.block ?
        SORA_LEGACY_IDENTITY_ANCHOR.hash : block === BLOCK - 1 ? PARENT : HASH);
    });
    await expect(prepare()).rejects.toThrow('baseline does not match the verified parent');
  });

  it.each(['missing prior', 'wrong anchor', 'present target', 'current state', 'present identity'])(
    'rejects source with %s', async (label) => {
      const repository = await memory();
      if (label === 'missing prior') await repository.deleteMany('networkSnapshots', [`block-${BLOCK - 1}`]);
      if (label === 'wrong anchor') await repository.upsert({ ...originals()[2], timestamp: 1, data: { ...originals()[2].data, timestamp: 1 } });
      if (label === 'present target') await repository.upsert({ ...originals()[1], id: `block-${BLOCK}`, data: { ...originals()[1].data, id: `block-${BLOCK}` } });
      if (label === 'current state') await repository.upsert({ ...originals()[0], data: { id: 'chainState', block: BLOCK, data: '{}' } });
      if (label === 'present identity') await repository.upsert({ collection: 'updatesStreams', id: 'chainIdentity', data: {} });
      await expect(prepare(repository)).rejects.toThrow();
    });

  const seed = async (migration: unknown = migrationState()) => {
    const repository = new RocksRepository(readConfig());
    try { await repository.prepare(); await repository.upsertMany(originals()); if (migration !== null) await repository.setMetadata(POSTGRES_ROCKSDB_MIGRATION_STATE_KEY, migration); }
    finally { await repository.close(); }
  };
  const options = () => ({ targetBlock: BLOCK, confirmation: `add-derived-block-${BLOCK}`, receiptPath: join(root, 'repair.json') });

  it('adds exactly one BLOCK, validates indexes, preserves metadata and writes a private durable receipt', async () => {
    const migration = migrationState(); await seed(migration);
    const receipt = await repairRocksdbLegacyCheckpoint(readConfig(), options());
    expect(receipt.status).toBe('applied'); expect(receipt.originalDocumentCount).toBe(originals().length);
    expect((await stat(options().receiptPath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(options().receiptPath, 'utf8')).addedDocuments).toBe(1);
    const repository = new RocksRepository(readConfig());
    try {
      await repository.prepare(); await repository.validateCompactIndexes();
      for (const document of originals()) expect(await repository.get(document.collection, document.id)).toEqual(document);
      expect(repository.getMetadata(POSTGRES_ROCKSDB_MIGRATION_STATE_KEY)).toEqual(migration);
      let total = 0; for (const collection of INDEXER_COLLECTIONS) total += (await repository.query(collection, { first: 1, includeTotalCount: true })).totalCount!;
      expect(total).toBe(originals().length + 1);
      expect(await repository.get('historyElements', HISTORY)).toBeNull();
      expect(await repository.get('updatesStreams', 'chainIdentity')).toBeNull();
    } finally { await repository.close(); }
    rpc.create.mockReset();
    expect((await repairRocksdbLegacyCheckpoint(readConfig(), options())).status).toBe('applied');
    expect(rpc.create).not.toHaveBeenCalled();
  });

  it.each([null, { ...migrationState(), status: 'in_progress', sealedSeq: null, sealedHash: null, validatedAt: null }])(
    'rejects absent or incomplete migration metadata', async (migration) => {
      await seed(migration);
      await expect(repairRocksdbLegacyCheckpoint(readConfig(), options())).rejects.toThrow(/complete migration/);
      expect(rpc.create).not.toHaveBeenCalled();
    });

  it('requires explicit target confirmation and private receipt custody before opening storage', async () => {
    expect(() => readCheckpointRepairOptions({})).toThrow('REPAIR_BLOCK');
    expect(() => readCheckpointRepairOptions({ ROCKSDB_CHECKPOINT_REPAIR_BLOCK: String(BLOCK) })).toThrow('REPAIR_CONFIRM');
    await seed(); await writeFile(options().receiptPath, '{}', { mode: 0o644 });
    await expect(repairRocksdbLegacyCheckpoint(readConfig(), options())).rejects.toThrow('owner-only real file');
    expect(rpc.create).not.toHaveBeenCalled();
  });

  it('keeps a durable prepared receipt on insertion failure and resumes with one addition', async () => {
    await seed();
    const insert = vi.spyOn(RocksRepository.prototype, 'upsert').mockRejectedValueOnce(new Error('injected write failure'));
    await expect(repairRocksdbLegacyCheckpoint(readConfig(), options())).rejects.toThrow('injected write failure');
    expect(JSON.parse(await readFile(options().receiptPath, 'utf8')).status).toBe('prepared');
    insert.mockRestore();
    rpc.create.mockReset().mockResolvedValueOnce(makeApi()).mockResolvedValueOnce(makeApi());
    const receipt = await repairRocksdbLegacyCheckpoint(readConfig(), options());
    expect(receipt.status).toBe('applied');
    expect(receipt.originalDocumentCount).toBe(originals().length);
  });

  it('recovers a prepared receipt after committed insertion without RPC, writes or duplicate counts', async () => {
    await seed();
    await repairRocksdbLegacyCheckpoint(readConfig(), options());
    const receipt = JSON.parse(await readFile(options().receiptPath, 'utf8'));
    receipt.status = 'prepared'; receipt.appliedAt = null;
    await writeFile(options().receiptPath, `${JSON.stringify(receipt)}\n`, { mode: 0o600, flush: true });
    const insert = vi.spyOn(RocksRepository.prototype, 'upsert');
    rpc.create.mockReset();
    expect((await repairRocksdbLegacyCheckpoint(readConfig(), options())).status).toBe('applied');
    expect(insert).not.toHaveBeenCalled(); expect(rpc.create).not.toHaveBeenCalled();
  });

  it('rejects a symlink database without creating or altering storage', async () => {
    await seed();
    const config = readConfig(); const alias = join(root, 'alias.rocksdb');
    await symlink(config.rocksdbPath, alias);
    await expect(repairRocksdbLegacyCheckpoint({ ...config, rocksdbPath: alias }, options())).rejects.toThrow('real database directory');
    expect(rpc.create).not.toHaveBeenCalled();
  });

  it('rejects another live writer under the native exclusive lock', async () => {
    await seed();
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { RocksDatabase } from '@harperfast/rocksdb-js';
      const db = RocksDatabase.open(${JSON.stringify(readConfig().rocksdbPath)});
      process.stdout.write('ready\\n');
      process.stdin.once('data', () => { db.close(); process.exit(0); });
    `], { stdio: ['pipe', 'pipe', 'pipe'], cwd: process.cwd() });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) => reject(new Error(`Test writer exited early: ${code}`)));
        child.stdout.once('data', () => resolve());
      });
      await expect(repairRocksdbLegacyCheckpoint(readConfig(), options())).rejects.toThrow(/lock|temporarily unavailable/i);
      expect(rpc.create).not.toHaveBeenCalled();
    } finally {
      child.stdin.end('\n');
      if (child.exitCode === null) await once(child, 'exit');
    }
  });

  it('rejects malformed or conflicting prepared repair receipts', async () => {
    await seed(); await repairRocksdbLegacyCheckpoint(readConfig(), options());
    const receipt = JSON.parse(await readFile(options().receiptPath, 'utf8'));
    receipt.repair.document.data.transactions = 1;
    await writeFile(options().receiptPath, JSON.stringify(receipt), { mode: 0o600 });
    rpc.create.mockReset();
    await expect(repairRocksdbLegacyCheckpoint(readConfig(), options())).rejects.toThrow('malformed');
    expect(rpc.create).not.toHaveBeenCalled();
  });

  it('refuses unexpected capture reads, writes and nonzero business output', async () => {
    const capture = createCheckpointProjectionCapture(BLOCK, HASH, TIME, HISTORY, String(TIME * 1_000));
    await expect(capture.repository.upsert(originals()[0])).rejects.toThrow('unexpected repository');
    await expect(capture.repository.getMany('accountMeta', ['account'])).rejects.toThrow('business accounts');
    await expect(capture.repository.upsertMany(originals())).rejects.toThrow('three-document');
    await expect(capture.repository.upsertMany(originals().slice(0, 3))).rejects.toThrow('business or counter');
  });
});
