import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ATTACKER_ACCOUNT, RECOVERY_CHECKPOINT, type BurnRecoveryPolicy } from '../src/burn-recovery.js';
import { SORA_MAINNET_GENESIS_HASH } from '../src/soraIdentity.js';
import { MemoryRepository } from '../src/repository/memory.js';
import type { IndexerDocument } from '../src/repository/types.js';
import { initializePointsRecovery, admitPointBlock, pointBlockDocuments, pointValuation, pointsDigest, pointJournalId,
  initialPointJournalCursor, validatePointJournalEntry, exportPointJournalRange, POINTS_RECOVERY_ID, POINTS_VALUATION_PREFIX,
  POINT_JOURNAL_MAX_BLOCKS, POINT_JOURNAL_MAX_LINE_BYTES, type PointJournalEntry } from '../src/points-recovery.js';
import { exportPointJournalFile, validatePointJournalFile, pointJournalLines } from '../src/scripts/points-journal.js';

// Synthetic block/event bytes exercise commitment transport only, never historical authentication.
const h = (n: number) => '0x' + n.toString(16).padStart(64, '0');
const policy: BurnRecoveryPolicy = { version: 1, policyHash: h(1), releaseManifestHash: h(2), genesisHash: SORA_MAINNET_GENESIS_HASH,
  checkpoint: RECOVERY_CHECKPOINT, postForkAnchor: { block: RECOVERY_CHECKPOINT.block + 2, hash: h(10) },
  substitutions: [{ old: h(3), new: h(4) }], attackerAccounts: [ATTACKER_ACCOUNT],
  metadata: [{ firstBlock: RECOVERY_CHECKPOINT.block + 1, lastBlock: RECOVERY_CHECKPOINT.block + 2, executionCodeHash: h(7), metadataHash: h(8) }] };
const { releaseManifestHash: _release, postForkAnchor: _anchor, metadata: _metadata, ...allocation } = policy;
const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const folders: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function folder() { const path = await realpath(await mkdtemp(join(tmpdir(), 'points-journal-test-'))); folders.push(path); return path; }
async function fixture(count = 2) {
  const repo = new MemoryRepository(); await initializePointsRecovery(repo, policy, 1);
  const entries: PointJournalEntry[] = [];
  for (let block = 1; block <= count; block++) {
    const hash = h(block + 30); const parent = block === 1 ? policy.genesisHash : h(block + 29);
    const before = await admitPointBlock(repo, policy, block, hash, parent);
    const valuation = pointValuation({ blockHeight: block - 1, blockHash: parent, assets: new Map(), pools: new Map(), prices: new Map() }, block, parent);
    const point: IndexerDocument = { collection: 'accountMeta', id: h(3), blockHeight: block, timestamp: block * 1000,
      data: { id: h(3), createdAtBlock: 1, createdAtTimestamp: 1000, xorFees: { amount: '9007199254740993.000000000000000001', amountUSD: String(block) } } };
    const rows = pointBlockDocuments(policy, before, block, hash, '0x0102', ['0x0304'], [point], valuation);
    entries.push({ journal: rows.find((row) => row.id === pointJournalId(block))!, valuation: rows.find((row) => row.id === POINTS_VALUATION_PREFIX + valuation.inputsSha256)! });
    await repo.upsertMany([point, ...rows, { collection: 'updatesStreams', id: 'chainState', blockHeight: block,
      data: { id: 'chainState', data: JSON.stringify({ lastIndexedBlock: block, blockHash: hash }) } }]);
  }
  return { repo, entries };
}
async function collect(repo: MemoryRepository, first = 1, last = 2) {
  const rows: PointJournalEntry[] = [];
  const summary = await exportPointJournalRange(repo, allocation, first, last, async (entry) => { rows.push(entry); });
  return { rows, summary };
}
async function archive() {
  const dir = await folder(); const databaseCopy = join(dir, 'stopped-copy'); await mkdir(databaseCopy); await writeFile(join(databaseCopy, 'CURRENT'), 'synthetic-stopped-copy');
  const policyPath = join(dir, 'allocation.json'); const raw = JSON.stringify(allocation); await writeFile(policyPath, raw);
  const options = { databaseCopy, policy: policyPath, policySha256: sha(raw), first: 1, last: 2, output: join(dir, 'export') };
  const { repo } = await fixture(); const result = await exportPointJournalFile(options, { openRepository: async () => repo });
  return { dir, repo, options, validation: { manifest: result.receipt, manifestSha256: result.sha256, policy: policyPath,
    policySha256: sha(raw), output: join(dir, 'VALIDATION.json') } };
}

describe('recovery points append-only journal', () => {
  it('retains exact inputs and recomputes every receipt without interpreting scoring', async () => {
    const { repo, entries } = await fixture(); const before = pointsDigest(await repo.list('updatesStreams'));
    const list = vi.spyOn(repo, 'list'); const writes = vi.spyOn(repo, 'upsertMany');
    const result = await collect(repo);
    expect(result.rows).toEqual(entries);
    expect(result.rows[0].journal.data.pointRows).toMatchObject([{ data: { xorFees: { amount: '9007199254740993.000000000000000001' } } }]);
    expect(result.summary).toMatchObject({ blocks: 2, commitmentChainVerified: true, suppliedSegmentStartAuthenticated: false,
      storageProofsVerified: false, scoringReexecuted: false, historicalCoverageVerified: false, productionReady: false });
    expect(list).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled();
    expect(pointsDigest(await repo.list('updatesStreams'))).toBe(before);
  });
  it('refuses a preexisting next-height journal and never overwrites it', async () => {
    const { entries } = await fixture(1); const repo = new MemoryRepository(); await initializePointsRecovery(repo, policy, 1);
    await repo.upsert(entries[0].journal);
    await expect(admitPointBlock(repo, policy, 1, h(31), policy.genesisHash)).rejects.toThrow('overwrite forbidden');
    expect(await repo.get('updatesStreams', pointJournalId(1))).toEqual(entries[0].journal);
  });
  it('refuses old continuity without journal schema instead of retrofitting it', async () => {
    const repo = new MemoryRepository(); await initializePointsRecovery(repo, policy, 1);
    const head = (await repo.get('updatesStreams', POINTS_RECOVERY_ID))!; delete head.data.journalSchema; await repo.upsert(head);
    await expect(initializePointsRecovery(repo, policy, 1)).rejects.toThrow('fresh replay');
  });
  it.each(['pointRows', 'eventHexes', 'blockHex', 'receiptRoot', 'parentHash', 'previousReceiptRoot', 'hash', 'allocation', 'valuation', 'id'])('rejects changed %s', async (field) => {
    const { entries } = await fixture(1); const entry = structuredClone(entries[0]);
    if (field === 'pointRows') ((entry.journal.data.pointRows as IndexerDocument[])[0].data.xorFees as Record<string, unknown>).amountUSD = '9';
    else if (field === 'eventHexes') entry.journal.data.eventHexes = ['0x0305'];
    else if (field === 'blockHex') entry.journal.data.blockHex = '0x0103';
    else if (field === 'allocation' || field === 'valuation') entry.journal.data[field] = {};
    else entry.journal.data[field] = h(99);
    expect(() => validatePointJournalEntry(entry, allocation, initialPointJournalCursor(allocation))).toThrow();
  });
  it('rejects missing blocks/snapshots, duplicates, wrong owners policy and changed terminal cursor', async () => {
    const { repo, entries } = await fixture();
    expect(() => validatePointJournalEntry(entries[0], { ...allocation, policyHash: h(99) }, initialPointJournalCursor(allocation))).toThrow('policy');
    const cursor = validatePointJournalEntry(entries[0], allocation, initialPointJournalCursor(allocation));
    expect(() => validatePointJournalEntry(entries[0], allocation, cursor)).toThrow('continuity');
    await repo.deleteMany('updatesStreams', [pointJournalId(2)]); await expect(collect(repo)).rejects.toThrow('missing journal block');
    await repo.upsert(entries[1].journal);
    await repo.deleteMany('updatesStreams', [entries[0].valuation.id]); await expect(collect(repo)).rejects.toThrow('valuation snapshot');
    await repo.upsert(entries[0].valuation);
    const head = (await repo.get('updatesStreams', POINTS_RECOVERY_ID))!; head.data.receiptRoot = 'a'.repeat(64); await repo.upsert(head);
    await expect(collect(repo)).rejects.toThrow('head mismatch');
  });
  it('bounds segments and records the preceding cursor without authenticating the prefix', async () => {
    const { repo } = await fixture(); const result = await collect(repo, 2, 2);
    expect(result.summary.start.block).toBe(1); expect(result.summary.suppliedSegmentStartAuthenticated).toBe(false);
    for (const [first, last] of [[0, 1], [2, 1], [1, POINT_JOURNAL_MAX_BLOCKS + 1], [1, RECOVERY_CHECKPOINT.block + 1]]) {
      await expect(collect(repo, first, last)).rejects.toThrow('range bound');
    }
    await repo.deleteMany('updatesStreams', [pointJournalId(1)]); await expect(collect(repo, 2, 2)).rejects.toThrow('preceding');
  });
  it('rejects advancing source during export', async () => {
    const { repo } = await fixture();
    await expect(exportPointJournalRange(repo, allocation, 1, 2, async () => {
      const head = (await repo.get('updatesStreams', POINTS_RECOVERY_ID))!; head.data.throughBlock = 3; await repo.upsert(head);
    })).rejects.toThrow('advanced');
  });
});

describe('bounded offline point journal transport', () => {
  it('exports a mock stopped copy and validates parsed bytes without writes, future anchor or history claims', async () => {
    const { validation, options } = await archive(); const result = await validatePointJournalFile(validation);
    expect(result.productionReady).toBe(false);
    const report = JSON.parse(await readFile(result.receipt, 'utf8'));
    expect(report).toMatchObject({ blocks: 2, commitmentChainVerified: true, scoringReexecuted: false, historicalCoverageVerified: false, storageProofsVerified: false });
    expect(await readFile(join(options.output, 'journal.jsonl'), 'utf8')).not.toContain('postForkAnchor');
    await expect(validatePointJournalFile(validation)).rejects.toThrow();
  });
  it('checks the hash of the exact parsed stream, not only a separate pre/post read', async () => {
    const { options } = await archive(); const path = join(options.output, 'journal.jsonl');
    const raw = await readFile(path);
    const consume = async () => { for await (const _ of pointJournalLines(path, { sha256: 'f'.repeat(64), bytes: raw.length })) { /* consume */ } };
    await expect(consume()).rejects.toThrow('parsed journal stream');
  });
  it.each(['missing', 'duplicate', 'reorder', 'point-write', 'valuation', 'claim', 'prefix-claim', 'missing-prefix-scope'])('rejects rebundled %s evidence despite newly pinned file bytes', async (kind) => {
    const { validation, options } = await archive(); const path = join(options.output, 'journal.jsonl');
    const rows = (await readFile(path, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
    if (kind === 'missing') rows.pop();
    if (kind === 'duplicate') rows[1] = rows[0];
    if (kind === 'reorder') rows.reverse();
    if (kind === 'point-write') rows[0].journal.data.pointRows[0].data.xorFees.amountUSD = '999';
    if (kind === 'valuation') rows[0].valuation.data.inputs.prices = [[h(55), '10']];
    const manifest = JSON.parse(await readFile(validation.manifest, 'utf8'));
    if (kind === 'claim') manifest.storageProofsVerified = true;
    if (kind === 'prefix-claim') manifest.suppliedSegmentStartAuthenticated = true;
    if (kind === 'missing-prefix-scope') delete manifest.suppliedSegmentStartAuthenticated;
    const raw = rows.map((row) => JSON.stringify(row) + '\n').join(''); await writeFile(path, raw);
    manifest.journal.sha256 = sha(raw); manifest.journal.bytes = manifest.bytes = Buffer.byteLength(raw);
    const manifestRaw = JSON.stringify(manifest); await writeFile(validation.manifest, manifestRaw); validation.manifestSha256 = sha(manifestRaw);
    await expect(validatePointJournalFile(validation)).rejects.toThrow();
  });
  it('rejects malformed/truncated/duplicate-key/oversized lines without parsing an oversized JSON object', async () => {
    const dir = await folder(); const path = join(dir, 'bad.jsonl');
    for (const raw of ['', '{}', '\n', '{"a":1,"a":2}\n', '{}\n'.repeat(POINT_JOURNAL_MAX_BLOCKS + 1), ' '.repeat(POINT_JOURNAL_MAX_LINE_BYTES + 1)]) {
      await writeFile(path, raw);
      await expect((async () => { for await (const _ of pointJournalLines(path)) { /* consume */ } })()).rejects.toThrow();
    }
  });
  it('bounds policy/manifest reads and checks actual parsed JSON bytes before parsing', async () => {
    const { validation } = await archive();
    await writeFile(validation.manifest, '{invalid');
    await expect(validatePointJournalFile(validation)).rejects.toThrow('parsed JSON pin');
    const oversized = ' '.repeat(1024 ** 2 + 1); await writeFile(validation.manifest, oversized);
    await expect(validatePointJournalFile({ ...validation, manifestSha256: sha(oversized) })).rejects.toThrow('size bound');
  });
  it('rejects changed stopped-copy bytes and live policy fields', async () => {
    const { options, dir } = await archive(); const { repo } = await fixture();
    await expect(exportPointJournalFile({ ...options, output: join(dir, 'changed') }, { openRepository: async () => {
      await writeFile(join(options.databaseCopy, 'CURRENT'), 'changed'); return repo;
    } })).rejects.toThrow('database copy changed');
    const raw = JSON.stringify(policy); await writeFile(options.policy, raw);
    await expect(exportPointJournalFile({ ...options, policySha256: sha(raw), output: join(dir, 'live') })).rejects.toThrow('future live fields');
  });
});
