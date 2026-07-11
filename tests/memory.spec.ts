import { describe, expect, it } from 'vitest';

import { decodeRepositoryCursor } from '../src/repository/cursor.js';
import { MemoryRepository } from '../src/repository/memory.js';

import type { IndexerDocument } from '../src/repository/types.js';

const assetDocument = (id: string, timestamp: number, blockHeight = timestamp): IndexerDocument => ({
  collection: 'assets',
  id,
  blockHeight,
  timestamp,
  data: {
    id,
    blockHeight,
    liquidity: String(blockHeight),
    timestamp,
  },
});

describe('MemoryRepository queries', () => {
  it('paginates last windows with absolute page metadata', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      assetDocument('asset-a', 10),
      assetDocument('asset-b', 20),
      assetDocument('asset-c', 30),
      assetDocument('asset-d', 40),
    ]);

    const result = await repository.query('assets', {
      first: 3,
      last: 2,
      orderBy: ['TIMESTAMP_ASC'],
    });

    expect(result.items.map((document) => document.id)).toEqual(['asset-b', 'asset-c']);
    expect(result).toMatchObject({
      hasNextPage: true,
      hasPreviousPage: true,
      pageStart: 1,
      totalCount: 4,
    });
  });

  it('supports ascending seek pagination with timestamp and id tie-breakers', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      assetDocument('asset-a', 10),
      assetDocument('asset-b', 10),
      assetDocument('asset-c', 20),
      assetDocument('asset-d', 30),
    ]);

    const result = await repository.query('assets', {
      first: 2,
      orderBy: ['TIMESTAMP_ASC'],
      seek: { field: 'timestamp', value: 10, id: 'asset-a', direction: 'asc' },
    });

    expect(result.items.map((document) => document.id)).toEqual(['asset-b', 'asset-c']);
    expect(result).toMatchObject({
      hasNextPage: true,
      hasPreviousPage: false,
      pageStart: 0,
      totalCount: 3,
    });
  });

  it('supports descending seek pagination without counting when requested', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      assetDocument('asset-a', 10),
      assetDocument('asset-b', 20),
      assetDocument('asset-c', 20),
      assetDocument('asset-d', 30),
    ]);

    const result = await repository.query('assets', {
      first: 1,
      includeTotalCount: false,
      orderBy: ['TIMESTAMP_DESC'],
      seek: { field: 'timestamp', value: 20, id: 'asset-c', direction: 'desc' },
    });

    expect(result.items.map((document) => document.id)).toEqual(['asset-b']);
    expect(result).toMatchObject({
      hasNextPage: true,
      hasPreviousPage: false,
      pageStart: 0,
      totalCount: null,
    });
  });

  it('continues from the cursor value when earlier rows and the cursor row are deleted', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      assetDocument('asset-a', 10),
      assetDocument('asset-b', 20),
      assetDocument('asset-c', 20),
      assetDocument('asset-d', 30),
    ]);

    const first = await repository.query('assets', {
      first: 2,
      orderBy: ['TIMESTAMP_ASC'],
      includeTotalCount: true,
    });
    const keyset = decodeRepositoryCursor(first.itemCursors?.at(-1));
    expect(keyset).not.toBeNull();

    await repository.deleteMany('assets', ['asset-a', 'asset-b']);
    const second = await repository.query('assets', {
      first: 2,
      orderBy: ['TIMESTAMP_ASC'],
      includeTotalCount: true,
      keyset,
    });

    expect(second.items.map((document) => document.id)).toEqual(['asset-c', 'asset-d']);
    expect(second).toMatchObject({
      totalCount: 2,
      hasNextPage: false,
      hasPreviousPage: true,
    });
  });

  it('uses document data fallbacks for seek pagination fields', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      {
        collection: 'assets',
        id: 'asset-a',
        data: { id: 'asset-a', timestamp: 10, blockHeight: 100, liquidity: '100' },
      },
      {
        collection: 'assets',
        id: 'asset-b',
        timestamp: null,
        blockHeight: null,
        data: { id: 'asset-b', timestamp: 20, blockHeight: 200, liquidity: '200' },
      },
      assetDocument('asset-c', 30, 300),
    ]);

    const result = await repository.query('assets', {
      orderBy: ['ID_ASC'],
      seek: { field: 'blockHeight', value: 100, id: 'asset-a', direction: 'asc' },
    });

    expect(result.items.map((document) => document.id)).toEqual(['asset-b', 'asset-c']);
    expect(result).toMatchObject({
      hasNextPage: false,
      hasPreviousPage: false,
      pageStart: 0,
      totalCount: 2,
    });
  });

  it('rejects unsafe native filter, seek, and keyset positions', async () => {
    const repository = new MemoryRepository();
    await repository.upsert(assetDocument('asset-a', 10));

    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '9007199254740992', '9'.repeat(80)]) {
      await expect(
        repository.query('assets', {
          filter: { timestamp: { greaterThanOrEqualTo: value } },
          orderBy: ['TIMESTAMP_ASC'],
        })
      ).rejects.toThrow('non-negative safe integer');
    }
    await expect(
      repository.query('assets', {
        filter: { blockHeight: { in: [1, '9007199254740992'] } },
        orderBy: ['ID_ASC'],
      })
    ).rejects.toThrow('non-negative safe integer');
    await expect(
      repository.query('assets', {
        orderBy: ['TIMESTAMP_ASC'],
        seek: { field: 'timestamp', value: Number.MAX_SAFE_INTEGER + 1, id: 'asset-a' },
      })
    ).rejects.toThrow('non-negative safe integer');
    await expect(
      repository.query('assets', {
        orderBy: ['TIMESTAMP_ASC'],
        keyset: {
          scope: 'invalid-but-not-reached',
          field: 'timestamp',
          direction: 'asc',
          numeric: true,
          value: '9007199254740992',
          id: 'asset-a',
        },
      })
    ).rejects.toThrow('non-negative safe integer');
  });

  it('stops materializing a page at its document byte budget while preserving progress', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany(
      ['a', 'b', 'c'].map((id) => ({
        collection: 'updatesStreams' as const,
        id,
        data: { id, payload: 'x'.repeat(2_000) },
      }))
    );

    const result = await repository.query('updatesStreams', {
      first: 3,
      orderBy: ['ID_ASC'],
      includeTotalCount: true,
      maxBytes: 1_024,
    });

    expect(result.items.map(({ id }) => id)).toEqual(['a']);
    expect(result.totalCount).toBe(3);
    expect(result.hasNextPage).toBe(true);
  });

  it('clamps negative offsets and page sizes', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([assetDocument('asset-a', 10), assetDocument('asset-b', 20)]);

    const result = await repository.query('assets', {
      first: -1,
      offset: -10,
      orderBy: ['TIMESTAMP_ASC'],
    });

    expect(result.items).toEqual([]);
    expect(result).toMatchObject({
      hasNextPage: true,
      hasPreviousPage: false,
      pageStart: 0,
      totalCount: 2,
    });
  });

  it('returns only requested documents from getMany', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([assetDocument('asset-a', 10), assetDocument('asset-b', 20)]);

    const result = await repository.getMany('assets', ['asset-b', 'missing', 'asset-a']);

    expect([...result.keys()]).toEqual(['asset-b', 'asset-a']);
    expect(result.get('asset-b')?.data).toMatchObject({ id: 'asset-b', timestamp: 20 });
  });

  it('deletes requested documents without affecting other collections', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      assetDocument('asset-a', 10),
      assetDocument('asset-b', 20),
      { collection: 'poolXYKs', id: 'asset-a', data: { id: 'asset-a' } },
    ]);

    await repository.deleteMany('assets', ['asset-a', 'missing', 'asset-a']);

    await expect(repository.get('assets', 'asset-a')).resolves.toBeNull();
    await expect(repository.get('assets', 'asset-b')).resolves.not.toBeNull();
    await expect(repository.get('poolXYKs', 'asset-a')).resolves.not.toBeNull();
  });

  it('copies top-level document data on upsert', async () => {
    const repository = new MemoryRepository();
    const document = assetDocument('asset-a', 10);

    await repository.upsert(document);
    document.data.liquidity = 'mutated';

    await expect(repository.get('assets', 'asset-a')).resolves.toMatchObject({
      data: { id: 'asset-a', liquidity: '10' },
    });
  });

  it('rejects stale and unversioned overwrites while allowing equal/newer versions', async () => {
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'assets',
      id: 'asset-a',
      blockHeight: 20,
      timestamp: 200,
      data: { id: 'asset-a', version: 'current' },
    });

    await repository.upsert({
      collection: 'assets',
      id: 'asset-a',
      blockHeight: 19,
      timestamp: 999,
      data: { id: 'asset-a', version: 'stale' },
    });
    await repository.upsert({
      collection: 'assets',
      id: 'asset-a',
      data: { id: 'asset-a', version: 'unversioned' },
    });
    expect((await repository.get('assets', 'asset-a'))?.data.version).toBe('current');

    await repository.upsert({
      collection: 'assets',
      id: 'asset-a',
      blockHeight: 20,
      timestamp: 201,
      data: { id: 'asset-a', version: 'same-block-repair' },
    });
    await repository.upsert({
      collection: 'assets',
      id: 'asset-a',
      blockHeight: 21,
      timestamp: 202,
      data: { id: 'asset-a', version: 'newer' },
    });
    expect(await repository.get('assets', 'asset-a')).toMatchObject({
      blockHeight: 21,
      data: { version: 'newer' },
    });
  });

  it('returns owned deep clones and emits payload-free watch identities', async () => {
    const repository = new MemoryRepository();
    const firstWatcher = repository.watch('assets');
    const secondWatcher = repository.watch('assets');
    const firstNext = firstWatcher.next();
    const secondNext = secondWatcher.next();

    await repository.upsert({
      collection: 'assets',
      id: 'asset-a',
      blockHeight: 1,
      data: { id: 'asset-a', nested: { value: 'original' } },
    });

    const first = await firstNext;
    const second = await secondNext;
    expect(first.value).toEqual({ collection: 'assets', id: 'asset-a', mutationType: 'INSERT' });
    expect(second.value).toEqual(first.value);
    expect('data' in (first.value ?? {})).toBe(false);

    const read = await repository.get('assets', 'asset-a');
    ((read!.data.nested as { value: string }).value) = 'mutated-reader';
    expect((await repository.get('assets', 'asset-a'))?.data).toEqual({
      id: 'asset-a',
      nested: { value: 'original' },
    });

    await firstWatcher.return(undefined);
    await secondWatcher.return(undefined);
  });

  it('watches only matching collection and ids', async () => {
    const repository = new MemoryRepository();
    const watcher = repository.watch('assets', ['asset-b']);
    const next = watcher.next();

    await repository.upsert({
      collection: 'orderBooks',
      id: 'asset-b',
      data: { id: 'asset-b' },
    });
    await repository.upsert(assetDocument('asset-a', 10));
    await repository.upsert(assetDocument('asset-b', 20));

    await expect(next).resolves.toMatchObject({
      done: false,
      value: {
        collection: 'assets',
        id: 'asset-b',
        mutationType: 'INSERT',
      },
    });
    await watcher.return(undefined);
  });

  it('aborts an idle watcher immediately without waiting for another document', async () => {
    const repository = new MemoryRepository();
    const controller = new AbortController();
    const watcher = repository.watch('assets', ['never-updated'], controller.signal);
    const pending = watcher.next();

    controller.abort();

    await expect(pending).resolves.toEqual({ done: true, value: undefined });
  });

  it('clears documents on close', async () => {
    const repository = new MemoryRepository();
    await repository.upsert(assetDocument('asset-a', 10));

    await repository.close();

    await expect(repository.list('assets')).resolves.toEqual([]);
    await expect(repository.get('assets', 'asset-a')).resolves.toBeNull();
  });

  it.each(['', 'contains space', 'unicode-ä', 'nul\0id', 'x'.repeat(1_025)])(
    'rejects invalid persisted document id %j',
    async (id) => {
      const repository = new MemoryRepository();
      await expect(repository.upsert({ collection: 'assets', id, data: { id } })).rejects.toThrow(/document id/);
    }
  );

  it.each([
    [{ collection: 'unknown', id: 'id', data: {} }, /collection/],
    [{ collection: 'assets', id: 'id', blockHeight: -1, data: {} }, /blockHeight/],
    [{ collection: 'assets', id: 'id', timestamp: 1.5, data: {} }, /timestamp/],
    [{ collection: 'assets', id: 'id', timestamp: Number.MAX_SAFE_INTEGER + 1, data: {} }, /timestamp/],
    [{ collection: 'assets', id: 'id', data: [] }, /data/],
    [{ collection: 'assets', id: 'id', data: new (class DocumentData {})() }, /data/],
    [{ collection: 'assets', id: 'id', data: { bad: 1n } }, /non-JSON bigint/],
    [{ collection: 'assets', id: 'id', data: { bad: Number.NaN } }, /finite JSON number/],
    [{ collection: 'assets', id: 'id', data: { bad: undefined } }, /non-JSON undefined/],
    [{ collection: 'assets', id: 'id', data: { bad: new Date() } }, /plain objects/],
    [{ collection: 'assets', id: 'id', data: { bad: () => undefined } }, /non-JSON function/],
  ])('rejects malformed document writes before mutating memory %#', async (document, message) => {
    const repository = new MemoryRepository();
    await expect(repository.upsert(document as unknown as IndexerDocument)).rejects.toThrow(message);
    await expect(repository.list('assets')).resolves.toEqual([]);
  });

  it('validates an entire bulk write before storing its first document', async () => {
    const repository = new MemoryRepository();
    await expect(
      repository.upsertMany([
        assetDocument('valid-first', 1),
        { collection: 'unknown', id: 'invalid-second', data: {} } as unknown as IndexerDocument,
      ])
    ).rejects.toThrow(/collection/);
    await expect(repository.list('assets')).resolves.toEqual([]);
  });

  it('rejects cyclic document data', async () => {
    const repository = new MemoryRepository();
    const data: Record<string, unknown> = {};
    data.self = data;
    await expect(repository.upsert({ collection: 'assets', id: 'cyclic', data })).rejects.toThrow(/cycle/);
  });

  it('rejects invalid delete collection and ids before mutating memory', async () => {
    const repository = new MemoryRepository();
    await repository.upsert(assetDocument('kept', 1));
    await expect(repository.deleteMany('unknown' as never, ['kept'])).rejects.toThrow(/collection/);
    await expect(repository.deleteMany('assets', ['contains space'])).rejects.toThrow(/document id/);
    await expect(repository.get('assets', 'kept')).resolves.not.toBeNull();
  });
});
