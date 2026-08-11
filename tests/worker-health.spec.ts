import { describe, expect, it, vi } from 'vitest';

import {
  parseWorkerHealthTimeoutMs,
  runWorkerHealthDatabaseProbe,
  validateWorkerHealthDocuments,
  WORKER_HEALTH_CLEANUP_TIMEOUT_MS,
  WORKER_HEALTH_CONNECTION_TIMEOUT_MS,
  WORKER_HEALTH_MAX_DOCUMENT_BYTES,
  WORKER_HEALTH_QUERY_TIMEOUT_MS,
  WORKER_HEALTH_TOTAL_TIMEOUT_MS,
} from '../src/scripts/worker-health.js';
import {
  SORA_LEGACY_IDENTITY_ANCHOR,
  SORA_MAINNET_GENESIS_HASH,
} from '../src/soraIdentity.js';

const NOW = 1_800_000_000;
const IDENTITY_BLOCK = SORA_LEGACY_IDENTITY_ANCHOR.block;
const STATE_BLOCK = 29_000_100;
const IDENTITY_TIMESTAMP = SORA_LEGACY_IDENTITY_ANCHOR.timestamp;
const STATE_TIMESTAMP = NOW - 10;
const IDENTITY_HASH = SORA_LEGACY_IDENTITY_ANCHOR.hash;
const STATE_HASH = `0x${'b'.repeat(64)}`;

type Row = {
  collection: unknown;
  id: unknown;
  blockHeight: unknown;
  timestamp: unknown;
  data: unknown;
};

const updateRow = (id: 'chainIdentity' | 'chainState', block: number, timestamp: number, payload: unknown): Row => ({
  collection: 'updatesStreams',
  id,
  blockHeight: String(block),
  timestamp: String(timestamp),
  data: {
    id,
    block,
    data: JSON.stringify(payload),
  },
});

const identityPayload = () => ({
  schemaVersion: 1,
  genesisHash: SORA_MAINNET_GENESIS_HASH,
  verificationBlock: IDENTITY_BLOCK,
  verificationBlockHash: IDENTITY_HASH,
  verificationBlockTimestamp: IDENTITY_TIMESTAMP,
  migration: 'fresh-database',
});

const statePayload = (blockTimestamp = STATE_TIMESTAMP) => ({
  lastIndexedBlock: STATE_BLOCK,
  genesisHash: SORA_MAINNET_GENESIS_HASH,
  blockHash: STATE_HASH,
  blockTimestamp,
});

const validRows = (blockTimestamp = STATE_TIMESTAMP): { updates: Row[]; snapshots: Row[] } => ({
  updates: [
    updateRow('chainIdentity', IDENTITY_BLOCK, IDENTITY_TIMESTAMP, identityPayload()),
    updateRow('chainState', STATE_BLOCK, NOW - 5, statePayload(blockTimestamp)),
  ],
  snapshots: [{
    collection: 'networkSnapshots',
    id: `block-${STATE_BLOCK}`,
    blockHeight: String(STATE_BLOCK),
    timestamp: String(blockTimestamp),
    data: {
      id: `block-${STATE_BLOCK}`,
      type: 'BLOCK',
      timestamp: blockTimestamp,
      accounts: 1,
      transactions: 2,
    },
  }],
});

const cloneRows = (): { updates: Row[]; snapshots: Row[] } => structuredClone(validRows());
const updateData = (row: Row): Record<string, unknown> => row.data as Record<string, unknown>;
const replacePayload = (row: Row, payload: unknown): void => {
  updateData(row).data = JSON.stringify(payload);
};
const codeFor = (rows: { updates: Row[]; snapshots: Row[] }, now = NOW): string => {
  const result = validateWorkerHealthDocuments(rows.updates, rows.snapshots, now);
  return result.ok ? 'ok' : result.code;
};

describe('standalone PI worker health document validation', () => {
  it('accepts a coherent fresh-database checkpoint and returns parsed identity', () => {
    const rows = validRows();
    const result = validateWorkerHealthDocuments(rows.updates, rows.snapshots, NOW);
    expect(result).toMatchObject({
      ok: true,
      identity: { genesisHash: SORA_MAINNET_GENESIS_HASH, verificationBlock: IDENTITY_BLOCK },
      state: { lastIndexedBlock: STATE_BLOCK, blockHash: STATE_HASH },
    });
  });

  it('accepts the exact audited legacy anchor', () => {
    const rows = validRows();
    rows.updates[0] = updateRow(
      'chainIdentity',
      SORA_LEGACY_IDENTITY_ANCHOR.block,
      SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
      {
        schemaVersion: 1,
        genesisHash: SORA_MAINNET_GENESIS_HASH,
        verificationBlock: SORA_LEGACY_IDENTITY_ANCHOR.block,
        verificationBlockHash: SORA_LEGACY_IDENTITY_ANCHOR.hash,
        verificationBlockTimestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
        migration: 'legacy-production-anchor-v1',
      },
    );
    expect(codeFor(rows)).toBe('ok');
  });

  it.each([
    ['exactly 300 seconds stale', NOW - 300],
    ['exactly 30 seconds ahead', NOW + 30],
  ])('accepts a state timestamp %s', (_label, timestamp) => {
    const rows = validRows(timestamp);
    (rows.updates[1] as Row).timestamp = String(timestamp);
    expect(codeFor(rows)).toBe('ok');
  });

  const malformedUpdateCases: Array<[string, (rows: { updates: Row[]; snapshots: Row[] }) => void, string]> = [
    ['missing identity', (rows) => { rows.updates.shift(); }, 'identity-row-invalid'],
    ['missing state', (rows) => { rows.updates.pop(); }, 'identity-row-invalid'],
    ['duplicate identity', (rows) => { rows.updates[1] = structuredClone(rows.updates[0]); }, 'identity-row-invalid'],
    ['an extra update row', (rows) => { rows.updates.push(structuredClone(rows.updates[0])); }, 'identity-row-invalid'],
    ['wrong identity collection', (rows) => { rows.updates[0].collection = 'networkSnapshots'; }, 'identity-row-invalid'],
    ['wrong identity id', (rows) => { rows.updates[0].id = 'chainState'; }, 'identity-row-invalid'],
    ['extra identity row field', (rows) => { (rows.updates[0] as Record<string, unknown>).secret = true; }, 'identity-row-invalid'],
    ['numeric bigint field', (rows) => { rows.updates[0].blockHeight = IDENTITY_BLOCK; }, 'identity-row-invalid'],
    ['leading-zero bigint field', (rows) => { rows.updates[0].blockHeight = `0${IDENTITY_BLOCK}`; }, 'identity-row-invalid'],
    ['zero bigint field', (rows) => { rows.updates[0].blockHeight = '0'; }, 'identity-row-invalid'],
    ['negative bigint field', (rows) => { rows.updates[0].timestamp = '-1'; }, 'identity-row-invalid'],
    ['unsafe bigint field', (rows) => { rows.updates[0].blockHeight = '9007199254740992'; }, 'identity-row-invalid'],
    ['non-object update data', (rows) => { rows.updates[0].data = 'json'; }, 'identity-row-invalid'],
    ['extra update envelope field', (rows) => { updateData(rows.updates[0]).extra = true; }, 'identity-row-invalid'],
    ['wrong update envelope id', (rows) => { updateData(rows.updates[0]).id = 'chainState'; }, 'identity-row-invalid'],
    ['wrong update envelope block', (rows) => { updateData(rows.updates[0]).block = IDENTITY_BLOCK + 1; }, 'identity-row-invalid'],
    ['string update envelope block', (rows) => { updateData(rows.updates[0]).block = String(IDENTITY_BLOCK); }, 'identity-row-invalid'],
    ['non-string encoded payload', (rows) => { updateData(rows.updates[0]).data = identityPayload(); }, 'identity-row-invalid'],
    ['invalid encoded JSON', (rows) => { updateData(rows.updates[0]).data = '{'; }, 'identity-row-invalid'],
    ['oversized encoded JSON', (rows) => { updateData(rows.updates[0]).data = 'x'.repeat(WORKER_HEALTH_MAX_DOCUMENT_BYTES + 1); }, 'identity-row-invalid'],
  ];

  it.each(malformedUpdateCases)('rejects %s', (_label, mutate, expected) => {
    const rows = cloneRows();
    mutate(rows);
    expect(codeFor(rows)).toBe(expected);
  });

  const identityCases: Array<[string, (identity: Record<string, unknown>) => void, string]> = [
    ['an extra identity property', (value) => { value.extra = true; }, 'identity-checkpoint-invalid'],
    ['a static but wrong genesis', (value) => { value.genesisHash = `0x${'c'.repeat(64)}`; }, 'identity-checkpoint-invalid'],
    ['an uppercase checkpoint hash', (value) => { value.verificationBlockHash = IDENTITY_HASH.toUpperCase(); }, 'identity-checkpoint-invalid'],
    ['a zero checkpoint hash', (value) => { value.verificationBlockHash = `0x${'0'.repeat(64)}`; }, 'identity-checkpoint-invalid'],
    ['a numeric-string checkpoint block', (value) => { value.verificationBlock = String(IDENTITY_BLOCK); }, 'identity-checkpoint-invalid'],
    ['an unknown migration', (value) => { value.migration = 'trust-me'; }, 'identity-checkpoint-invalid'],
    ['a fresh checkpoint before the anchor', (value) => { value.verificationBlock = SORA_LEGACY_IDENTITY_ANCHOR.block - 1; }, 'identity-checkpoint-invalid'],
    ['a fresh timestamp before the anchor', (value) => { value.verificationBlockTimestamp = SORA_LEGACY_IDENTITY_ANCHOR.timestamp - 1; }, 'identity-checkpoint-invalid'],
  ];

  it.each(identityCases)('rejects %s', (_label, mutate, expected) => {
    const rows = cloneRows();
    const identity = identityPayload() as Record<string, unknown>;
    mutate(identity);
    replacePayload(rows.updates[0], identity);
    if (typeof identity.verificationBlock === 'number') {
      rows.updates[0].blockHeight = String(identity.verificationBlock);
      updateData(rows.updates[0]).block = identity.verificationBlock;
    }
    if (typeof identity.verificationBlockTimestamp === 'number') {
      rows.updates[0].timestamp = String(identity.verificationBlockTimestamp);
    }
    expect(codeFor(rows)).toBe(expected);
  });

  it.each([
    ['wrong block hash', { verificationBlockHash: `0x${'c'.repeat(64)}` }],
    ['wrong timestamp', { verificationBlockTimestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp + 1 }],
    ['wrong block', { verificationBlock: SORA_LEGACY_IDENTITY_ANCHOR.block + 1 }],
  ])('rejects a legacy anchor with %s', (_label, override) => {
    const rows = cloneRows();
    const identity = {
      schemaVersion: 1,
      genesisHash: SORA_MAINNET_GENESIS_HASH,
      verificationBlock: SORA_LEGACY_IDENTITY_ANCHOR.block,
      verificationBlockHash: SORA_LEGACY_IDENTITY_ANCHOR.hash,
      verificationBlockTimestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
      migration: 'legacy-production-anchor-v1',
      ...override,
    };
    rows.updates[0] = updateRow(
      'chainIdentity',
      Number(identity.verificationBlock),
      Number(identity.verificationBlockTimestamp),
      identity,
    );
    expect(codeFor(rows)).toBe('identity-checkpoint-invalid');
  });

  const stateCases: Array<[string, (rows: { updates: Row[]; snapshots: Row[] }) => void, string]> = [
    ['an extra state property', (rows) => { const value = statePayload() as Record<string, unknown>; value.extra = true; replacePayload(rows.updates[1], value); }, 'state-checkpoint-invalid'],
    ['a wrong state genesis', (rows) => { const value = statePayload(); value.genesisHash = `0x${'c'.repeat(64)}` as typeof SORA_MAINNET_GENESIS_HASH; replacePayload(rows.updates[1], value); }, 'state-checkpoint-invalid'],
    ['an uppercase state hash', (rows) => { const value = statePayload(); value.blockHash = STATE_HASH.toUpperCase(); replacePayload(rows.updates[1], value); }, 'state-checkpoint-invalid'],
    ['a state payload height mismatch', (rows) => { const value = statePayload(); value.lastIndexedBlock += 1; replacePayload(rows.updates[1], value); }, 'state-checkpoint-invalid'],
    ['a state behind identity', (rows) => { const value = statePayload(); value.lastIndexedBlock = IDENTITY_BLOCK - 1; replacePayload(rows.updates[1], value); rows.updates[1].blockHeight = String(value.lastIndexedBlock); updateData(rows.updates[1]).block = value.lastIndexedBlock; }, 'state-incoherent'],
    ['a state timestamp before identity', (rows) => { const value = statePayload(IDENTITY_TIMESTAMP - 1); replacePayload(rows.updates[1], value); }, 'state-incoherent'],
    ['an envelope clock before block tolerance', (rows) => { rows.updates[1].timestamp = String(STATE_TIMESTAMP - 31); }, 'state-incoherent'],
    ['an envelope clock after future tolerance', (rows) => { rows.updates[1].timestamp = String(NOW + 31); }, 'state-incoherent'],
  ];

  it.each(stateCases)('rejects %s', (_label, mutate, expected) => {
    const rows = cloneRows();
    mutate(rows);
    expect(codeFor(rows)).toBe(expected);
  });

  it('requires an equal-height state to match the identity hash and timestamp', () => {
    const rows = cloneRows();
    const state = statePayload(IDENTITY_TIMESTAMP);
    state.lastIndexedBlock = IDENTITY_BLOCK;
    rows.updates[1] = updateRow('chainState', IDENTITY_BLOCK, IDENTITY_TIMESTAMP, state);
    rows.snapshots[0].id = `block-${IDENTITY_BLOCK}`;
    rows.snapshots[0].blockHeight = String(IDENTITY_BLOCK);
    rows.snapshots[0].timestamp = String(IDENTITY_TIMESTAMP);
    const data = rows.snapshots[0].data as Record<string, unknown>;
    data.id = `block-${IDENTITY_BLOCK}`;
    data.timestamp = IDENTITY_TIMESTAMP;
    expect(codeFor(rows, IDENTITY_TIMESTAMP)).toBe('state-incoherent');
    state.blockHash = IDENTITY_HASH;
    replacePayload(rows.updates[1], state);
    expect(codeFor(rows, IDENTITY_TIMESTAMP)).toBe('ok');
  });

  it('rejects state timestamps one second outside both freshness boundaries', () => {
    const stale = validRows(NOW - 301);
    stale.updates[1].timestamp = String(NOW - 301);
    expect(codeFor(stale)).toBe('state-stale');
    const future = validRows(NOW + 31);
    future.updates[1].timestamp = String(NOW + 30);
    expect(codeFor(future)).toBe('state-future');
  });

  const snapshotCases: Array<[string, (rows: { updates: Row[]; snapshots: Row[] }) => void, string]> = [
    ['a missing snapshot', (rows) => { rows.snapshots = []; }, 'snapshot-row-invalid'],
    ['duplicate snapshots', (rows) => { rows.snapshots.push(structuredClone(rows.snapshots[0])); }, 'snapshot-row-invalid'],
    ['a wrong snapshot collection', (rows) => { rows.snapshots[0].collection = 'updatesStreams'; }, 'snapshot-envelope-invalid'],
    ['a wrong snapshot id', (rows) => { rows.snapshots[0].id = `block-${STATE_BLOCK + 1}`; }, 'snapshot-envelope-invalid'],
    ['a wrong snapshot block height', (rows) => { rows.snapshots[0].blockHeight = String(STATE_BLOCK + 1); }, 'snapshot-envelope-invalid'],
    ['a numeric snapshot block height', (rows) => { rows.snapshots[0].blockHeight = STATE_BLOCK; }, 'snapshot-envelope-invalid'],
    ['a wrong snapshot timestamp', (rows) => { rows.snapshots[0].timestamp = String(STATE_TIMESTAMP + 1); }, 'snapshot-envelope-invalid'],
    ['an extra snapshot envelope field', (rows) => { (rows.snapshots[0] as Record<string, unknown>).extra = true; }, 'snapshot-envelope-invalid'],
    ['null snapshot data', (rows) => { rows.snapshots[0].data = null; }, 'snapshot-envelope-invalid'],
    ['a wrong data id', (rows) => { (rows.snapshots[0].data as Record<string, unknown>).id = 'block-1'; }, 'snapshot-envelope-invalid'],
    ['a non-BLOCK snapshot', (rows) => { (rows.snapshots[0].data as Record<string, unknown>).type = 'DAY'; }, 'snapshot-envelope-invalid'],
    ['a wrong data timestamp', (rows) => { (rows.snapshots[0].data as Record<string, unknown>).timestamp = STATE_TIMESTAMP + 1; }, 'snapshot-envelope-invalid'],
    ['a string data timestamp', (rows) => { (rows.snapshots[0].data as Record<string, unknown>).timestamp = String(STATE_TIMESTAMP); }, 'snapshot-envelope-invalid'],
  ];

  it.each(snapshotCases)('rejects %s', (_label, mutate, expected) => {
    const rows = cloneRows();
    mutate(rows);
    expect(codeFor(rows)).toBe(expected);
  });

  it('rejects an invalid verifier clock without inspecting attacker rows', () => {
    expect(validateWorkerHealthDocuments(null, null, 0)).toEqual({ ok: false, code: 'deadline-invalid' });
  });
});

describe('worker database probe deadlines and cleanup', () => {
  it('keeps connection, both query phases, and cleanup within the hard process budget', () => {
    expect(WORKER_HEALTH_CONNECTION_TIMEOUT_MS).toBeLessThan(WORKER_HEALTH_TOTAL_TIMEOUT_MS);
    expect(WORKER_HEALTH_QUERY_TIMEOUT_MS).toBeLessThan(WORKER_HEALTH_TOTAL_TIMEOUT_MS);
    expect(WORKER_HEALTH_CLEANUP_TIMEOUT_MS).toBeLessThan(WORKER_HEALTH_TOTAL_TIMEOUT_MS);
    expect(
      WORKER_HEALTH_CONNECTION_TIMEOUT_MS + (2 * WORKER_HEALTH_QUERY_TIMEOUT_MS) +
        WORKER_HEALTH_CLEANUP_TIMEOUT_MS,
    ).toBeLessThan(WORKER_HEALTH_TOTAL_TIMEOUT_MS);
    expect(WORKER_HEALTH_TOTAL_TIMEOUT_MS).toBeLessThan(5_000);
  });

  it.each([
    [undefined, 4_000],
    ['', 4_000],
    ['1000', 1_000],
    ['4500', 4_500],
    ['999', null],
    ['4501', null],
    ['4e3', null],
    [' 4000', null],
    ['4000.0', null],
  ])('parses deadline %j as %j', (input, expected) => {
    expect(parseWorkerHealthTimeoutMs(input)).toBe(expected);
  });

  it('uses parameterized bounded queries, validates rows, and closes the pool', async () => {
    const rows = validRows();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: rows.updates })
      .mockResolvedValueOnce({ rows: rows.snapshots });
    const end = vi.fn(async () => undefined);
    const result = await runWorkerHealthDatabaseProbe({
      databaseUrl: 'postgresql://worker:secret@database.invalid/polkaswap?sslmode=require',
      nowSec: NOW,
      createDatabase: () => ({ query, end }),
    });
    expect(result.ok).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][1]).toEqual(['updatesStreams', ['chainIdentity', 'chainState'], 65_536]);
    expect(query.mock.calls[1][1]).toEqual(['networkSnapshots', `block-${STATE_BLOCK}`, 65_536]);
    expect(end).toHaveBeenCalledOnce();
  });

  it.each([
    '',
    'not-a-url',
    'https://database.invalid/polkaswap',
    'postgresql:///polkaswap',
    'postgresql://database.invalid/polkaswap#secret',
    ' postgresql://database.invalid/polkaswap',
    'postgresql://database.invalid/polkaswap\npassword=secret',
  ])('rejects an invalid database URL without constructing a pool: %j', async (databaseUrl) => {
    const createDatabase = vi.fn();
    await expect(runWorkerHealthDatabaseProbe({ databaseUrl, createDatabase })).resolves.toEqual({
      ok: false,
      code: 'database-url-invalid',
    });
    expect(createDatabase).not.toHaveBeenCalled();
  });

  it('fails closed and cleans up after a query error without returning its secret-bearing message', async () => {
    const end = vi.fn(async () => undefined);
    const result = await runWorkerHealthDatabaseProbe({
      databaseUrl: 'postgresql://worker:secret@database.invalid/polkaswap',
      createDatabase: () => ({
        query: vi.fn(async () => { throw new Error('postgresql://worker:secret@database.invalid/polkaswap'); }),
        end,
      }),
    });
    expect(result).toEqual({ ok: false, code: 'database-operation-failed' });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(end).toHaveBeenCalledOnce();
  });

  it('fails closed when cleanup rejects', async () => {
    const rows = validRows();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: rows.updates })
      .mockResolvedValueOnce({ rows: rows.snapshots });
    const result = await runWorkerHealthDatabaseProbe({
      databaseUrl: 'postgresql://database.invalid/polkaswap',
      nowSec: NOW,
      createDatabase: () => ({ query, end: vi.fn(async () => { throw new Error('cleanup secret'); }) }),
    });
    expect(result).toEqual({ ok: false, code: 'database-operation-failed' });
  });

  it('fails closed on a hanging database query at the per-query deadline', async () => {
    vi.useFakeTimers();
    try {
      const end = vi.fn(async () => undefined);
      const resultPromise = runWorkerHealthDatabaseProbe({
        databaseUrl: 'postgresql://database.invalid/polkaswap',
        createDatabase: () => ({
          query: vi.fn(() => new Promise<{ rows: unknown[] }>(() => undefined)),
          end,
        }),
      });
      await vi.advanceTimersByTimeAsync(WORKER_HEALTH_QUERY_TIMEOUT_MS + 1);
      await expect(resultPromise).resolves.toEqual({ ok: false, code: 'database-operation-failed' });
      expect(end).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed on hanging pool cleanup at the cleanup deadline', async () => {
    vi.useFakeTimers();
    try {
      const rows = validRows();
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: rows.updates })
        .mockResolvedValueOnce({ rows: rows.snapshots });
      const resultPromise = runWorkerHealthDatabaseProbe({
        databaseUrl: 'postgresql://database.invalid/polkaswap',
        nowSec: NOW,
        createDatabase: () => ({
          query,
          end: vi.fn(() => new Promise<void>(() => undefined)),
        }),
      });
      await vi.advanceTimersByTimeAsync(WORKER_HEALTH_CLEANUP_TIMEOUT_MS + 1);
      await expect(resultPromise).resolves.toEqual({ ok: false, code: 'database-operation-failed' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects out-of-contract total deadlines before querying', async () => {
    const query = vi.fn();
    const createDatabase = vi.fn(() => ({ query, end: vi.fn(async () => undefined) }));
    await expect(runWorkerHealthDatabaseProbe({
      databaseUrl: 'postgresql://database.invalid/polkaswap',
      totalTimeoutMs: 4_501,
      createDatabase,
    })).resolves.toEqual({ ok: false, code: 'deadline-invalid' });
    expect(createDatabase).not.toHaveBeenCalled();
  });
});
