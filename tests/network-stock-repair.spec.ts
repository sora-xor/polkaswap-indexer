import { describe, expect, it, vi } from 'vitest';
import { MemoryRepository } from '../src/repository/memory.js';
import type { IndexerDocument } from '../src/repository/types.js';
import {
  applyNetworkStockRepair, NETWORK_STOCK_REPAIR_ARCHIVE, NETWORK_STOCK_REPAIR_GENESIS,
  NETWORK_STOCK_REPAIR_MAX_BYTES, parseNetworkStockRepairArtifact, planNetworkStockRepair,
  validateNetworkStockRepairArtifact,
  type NetworkStockObservation, type NetworkStockRepairArtifact,
} from '../src/scripts/network-stock-repair.js';

const NOW = 1792171200;
const HASH = `0x${'1'.repeat(64)}`;

/** Completed historical observation; USD addition exercises all eight decimal places. */
function observation(offset = 0, type: NetworkStockObservation['type'] = 'HOUR'): NetworkStockObservation {
  const timestamp = 1792015194 + offset * 3600, blockHeight = 28047897 + offset * 600;
  const window = { DEFAULT: 300, HOUR: 3600, DAY: 86400 }[type];
  return {
    id: `network-all-${type}-${Math.floor(timestamp / window) * window}`, type, timestamp, blockHeight, blockHash: HASH,
    stock: { liquidityUSD: '13.00000003', poolLiquidityUSD: '10.00000001', orderBookLiquidityUSD: '3.00000002',
      activePools: 393, activeOrderBooks: 2, listedAssets: 957 },
    proof: { kind: 'archive-network-stock', genesisHash: NETWORK_STOCK_REPAIR_GENESIS,
      archiveEndpoint: NETWORK_STOCK_REPAIR_ARCHIVE, blockHash: HASH, blockHeight, timestamp,
      collector: { method: 'pinned-storage', finalized: true } },
  };
}

/** The artifact is a retained external receipt; it never becomes a database projection. */
function artifact(observations = [observation()]): NetworkStockRepairArtifact {
  return { kind: 'network-stock-repair-v1', genesisHash: NETWORK_STOCK_REPAIR_GENESIS,
    archiveEndpoint: NETWORK_STOCK_REPAIR_ARCHIVE, generatedAt: new Date(NOW * 1000).toISOString(), observations };
}

/** Mirror production native envelopes and preserve unrelated flow/calendar/custom metadata. */
function target(row: NetworkStockObservation): IndexerDocument {
  return { collection: 'networkSnapshots', id: row.id, blockHeight: row.blockHeight, timestamp: row.timestamp,
    data: { id: row.id, type: row.type, timestamp: row.timestamp, liquidityUSD: null, poolLiquidityUSD: null,
      activePools: null, activeOrderBooks: null, listedAssets: null, volumeUSD: '159.12345678', transactions: 7,
      calendarFlows: { version: 1, bucketStart: 1792011600, bucketEnd: 1792015200, complete: true,
        throughBlock: row.blockHeight, throughTimestamp: row.timestamp, volumeUSD: '18.3417085' },
      custom: { nested: ['preserve', 123] } } };
}

/** BLOCK stocks intentionally differ: they are not a substitute for archive post-block observations. */
function source(row: NetworkStockObservation): IndexerDocument {
  return { collection: 'networkSnapshots', id: `block-${row.blockHeight}`, blockHeight: row.blockHeight, timestamp: row.timestamp,
    data: { id: `block-${row.blockHeight}`, type: 'BLOCK', timestamp: row.timestamp,
      poolLiquidityUSD: '9.99999999', liquidityUSD: null, transactions: 1, fees: '300000000000000000' } };
}

/** Seed only an isolated in-memory database and observe every subsequent write call. */
async function setup(receipt = artifact()) {
  const repository = new MemoryRepository();
  const documents = receipt.observations.flatMap((row) => [target(row), source(row)]);
  const chainState: IndexerDocument = { collection: 'updatesStreams', id: 'chainState', blockHeight: 28080000,
    timestamp: NOW, data: { id: 'chainState', block: 28080000, data: '{"untouched":true}' } };
  const current: IndexerDocument = { collection: 'assets', id: 'xor', blockHeight: 28080000,
    timestamp: NOW, data: { id: 'xor', priceUSD: '5.78' } };
  await repository.upsertMany([...documents, chainState, current]);
  const writes = vi.spyOn(repository, 'upsertMany');
  return { repository, writes, receipt, chainState, current };
}

describe('guarded network stock repair', () => {
  it('fills only missing stocks, preserving full envelopes, flows, BLOCK sources, checkpoints and current projections', async () => {
    const { repository, writes, receipt, chainState, current } = await setup(artifact([observation(), observation(1)]));
    const originals = await Promise.all(receipt.observations.map((row) => repository.get('networkSnapshots', row.id)));
    const plan = await planNetworkStockRepair(repository, receipt);
    expect(plan).toMatchObject({ observations: 2, changedRows: 2, unchangedRows: 0 });
    expect(writes).not.toHaveBeenCalled();
    expect(await applyNetworkStockRepair(repository, plan)).toEqual({ changedRows: 2, verifiedRows: 2 });
    expect(writes).toHaveBeenCalledTimes(1);
    expect(writes.mock.calls[0]![0]).toHaveLength(2);
    for (let i = 0; i < receipt.observations.length; i++) {
      const row = receipt.observations[i]!;
      expect(await repository.get('networkSnapshots', row.id)).toEqual({ ...originals[i],
        data: { ...originals[i]!.data, ...row.stock } });
      expect(await repository.get('networkSnapshots', `block-${row.blockHeight}`)).toEqual(source(row));
    }
    expect(await repository.get('updatesStreams', chainState.id)).toEqual(chainState);
    expect(await repository.get('assets', current.id)).toEqual(current);
    expect(originals[0]!.data.liquidityUSD).toBeNull();
  });

  it('is idempotent on a fresh plan and does not rewrite already repaired documents', async () => {
    const { repository, writes, receipt } = await setup();
    await applyNetworkStockRepair(repository, await planNetworkStockRepair(repository, receipt));
    writes.mockClear();
    const plan = await planNetworkStockRepair(repository, receipt);
    expect(plan).toMatchObject({ changedRows: 0, unchangedRows: 1, changes: [] });
    expect(await applyNetworkStockRepair(repository, plan)).toEqual({ changedRows: 0, verifiedRows: 1 });
    expect(writes).not.toHaveBeenCalled();
  });

  it('keeps a matching present stock while filling its missing peers', async () => {
    const { repository, writes, receipt } = await setup();
    const row = target(receipt.observations[0]!);
    row.data.poolLiquidityUSD = receipt.observations[0]!.stock.poolLiquidityUSD;
    await repository.upsert(row); writes.mockClear();
    const plan = await planNetworkStockRepair(repository, receipt);
    expect(plan.changes[0]!.fields).not.toContain('poolLiquidityUSD');
    await applyNetworkStockRepair(repository, plan);
    expect((await repository.get('networkSnapshots', row.id))!.data).toMatchObject(receipt.observations[0]!.stock);
  });

  it.each([
    ['foreign genesis', (a: NetworkStockRepairArtifact) => { a.genesisHash = `0x${'2'.repeat(64)}`; }],
    ['different archive', (a: NetworkStockRepairArtifact) => { a.archiveEndpoint = 'https://example.com/'; }],
    ['noncanonical ID', (a: NetworkStockRepairArtifact) => { a.observations[0]!.id += '-wrong'; }],
    ['wrong bucket', (a: NetworkStockRepairArtifact) => { a.observations[0]!.id = 'network-all-HOUR-1792015200'; }],
    ['duplicate IDs', (a: NetworkStockRepairArtifact) => { a.observations.push(structuredClone(a.observations[0]!)); }],
    ['incorrect total', (a: NetworkStockRepairArtifact) => { a.observations[0]!.stock.liquidityUSD = '13.00000004'; }],
    ['negative amount', (a: NetworkStockRepairArtifact) => { a.observations[0]!.stock.poolLiquidityUSD = '-1'; }],
    ['excess precision', (a: NetworkStockRepairArtifact) => { a.observations[0]!.stock.poolLiquidityUSD = '10.000000001'; }],
    ['noncanonical number', (a: NetworkStockRepairArtifact) => { a.observations[0]!.stock.poolLiquidityUSD = '01'; }],
    ['fractional count', (a: NetworkStockRepairArtifact) => { a.observations[0]!.stock.activePools = 1.5; }],
    ['invalid position', (a: NetworkStockRepairArtifact) => { a.observations[0]!.blockHeight = 0; }],
    ['zero hash', (a: NetworkStockRepairArtifact) => { a.observations[0]!.blockHash = `0x${'0'.repeat(64)}`; }],
    ['unbound proof', (a: NetworkStockRepairArtifact) => { a.observations[0]!.proof.blockHeight++; }],
    ['foreign proof genesis', (a: NetworkStockRepairArtifact) => { a.observations[0]!.proof.genesisHash = HASH; }],
    ['future generation', (a: NetworkStockRepairArtifact) => { a.generatedAt = '2099-01-01T00:00:00.000Z'; }],
    ['incomplete bucket', (a: NetworkStockRepairArtifact) => { a.generatedAt = new Date(a.observations[0]!.timestamp * 1000).toISOString(); }],
    ['uninventoried DEFAULT', (a: NetworkStockRepairArtifact) => { a.observations = [observation(0, 'DEFAULT')]; }],
  ])('rejects %s before any write', async (_label, mutate) => {
    const { repository, writes, receipt } = await setup();
    mutate(receipt);
    await expect(planNetworkStockRepair(repository, receipt)).rejects.toThrow();
    expect(writes).not.toHaveBeenCalled();
  });

  it('accepts inventoried DEFAULT and DAY observations but refuses surplus stock fields', () => {
    const a = artifact([observation(0, 'DEFAULT'), observation(0, 'DAY')]);
    a.inventoryTypes = ['DEFAULT', 'DAY'];
    expect(validateNetworkStockRepairArtifact(a, NOW).observations).toHaveLength(2);
    (a.observations[0]!.stock as unknown as Record<string, unknown>).transactions = 0;
    expect(() => validateNetworkStockRepairArtifact(a, NOW)).toThrow('exactly six');
  });

  it('bounds parser bytes, rows and plain JSON, and detaches the validated receipt', () => {
    const a = artifact();
    const parsed = parseNetworkStockRepairArtifact(JSON.stringify(a), NOW);
    a.observations[0]!.stock.activePools = 0;
    expect(parsed.observations[0]!.stock.activePools).toBe(393);
    expect(() => parseNetworkStockRepairArtifact(' '.repeat(NETWORK_STOCK_REPAIR_MAX_BYTES + 1), NOW)).toThrow('byte bound');
    expect(() => validateNetworkStockRepairArtifact(artifact(Array.from({ length: 601 }, () => observation())), NOW)).toThrow('1–600');
    const getter = Object.defineProperty({}, 'kind', { enumerable: true, get: () => { throw new Error('must not invoke'); } });
    expect(() => validateNetworkStockRepairArtifact(getter, NOW)).toThrow('unsafe JSON key');
    expect(() => parseNetworkStockRepairArtifact('{bad-json', NOW)).toThrow();
  });

  it('aborts the entire multirow plan for a late present-stock conflict', async () => {
    const { repository, writes, receipt } = await setup(artifact([observation(), observation(1)]));
    const conflicting = target(receipt.observations[1]!); conflicting.data.liquidityUSD = '99';
    await repository.upsert(conflicting); writes.mockClear();
    await expect(planNetworkStockRepair(repository, receipt)).rejects.toThrow('Present stock mismatch');
    expect(writes).not.toHaveBeenCalled();
    expect((await repository.get('networkSnapshots', receipt.observations[0]!.id))!.data.liquidityUSD).toBeNull();
  });

  it.each(['target timestamp', 'source timestamp', 'source type', 'source hash', 'source collection', 'missing source'])
  ('refuses %s mismatches before writes', async (fault) => {
    const { repository, writes, receipt } = await setup();
    const row = receipt.observations[0]!, originalGet = repository.get.bind(repository);
    vi.spyOn(repository, 'get').mockImplementation(async (collection, id) => {
      const document = await originalGet(collection, id);
      if (id === row.id && fault === 'target timestamp') return { ...document!, timestamp: row.timestamp + 1 };
      if (id !== `block-${row.blockHeight}` || !document) return document;
      if (fault === 'missing source') return null;
      if (fault === 'source timestamp') return { ...document, timestamp: row.timestamp + 1 };
      if (fault === 'source collection') return { ...document, collection: 'assetSnapshots' };
      if (fault === 'source type') document.data.type = 'HOUR';
      if (fault === 'source hash') document.data.blockHash = `0x${'2'.repeat(64)}`;
      return document;
    });
    await expect(planNetworkStockRepair(repository, receipt)).rejects.toThrow('position mismatch');
    expect(writes).not.toHaveBeenCalled();
  });

  it.each(['target', 'canonical source'])('rechecks %s for changes between planning and applying', async (changed) => {
    const { repository, writes, receipt } = await setup();
    const row = receipt.observations[0]!, plan = await planNetworkStockRepair(repository, receipt);
    const document = changed === 'target' ? target(row) : source(row);
    document.data.transactions = 999;
    await repository.upsert(document); writes.mockClear();
    await expect(applyNetworkStockRepair(repository, plan)).rejects.toThrow('changed since planning');
    expect(writes).not.toHaveBeenCalled();
  });

  it('refuses forged plans and freezes the dry-run summary', async () => {
    const { repository, writes, receipt } = await setup();
    const plan = await planNetworkStockRepair(repository, receipt);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.changes[0]!.fields)).toBe(true);
    await expect(applyNetworkStockRepair(repository, { ...plan })).rejects.toThrow('not issued');
    expect(writes).not.toHaveBeenCalled();
  });

  it('detects complete-document corruption in backend write verification', async () => {
    const { repository, writes, receipt } = await setup();
    const plan = await planNetworkStockRepair(repository, receipt);
    const originalWrite = MemoryRepository.prototype.upsertMany.bind(repository);
    writes.mockImplementation(async (documents) => {
      documents[0]!.data.volumeUSD = '0';
      await originalWrite(documents);
    });
    await expect(applyNetworkStockRepair(repository, plan)).rejects.toThrow('full-document verification failed');
  });
});
