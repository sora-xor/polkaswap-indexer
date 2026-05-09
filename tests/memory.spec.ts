import { describe, expect, it } from 'vitest';

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

  it('returns only requested documents from getMany', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([assetDocument('asset-a', 10), assetDocument('asset-b', 20)]);

    const result = await repository.getMany('assets', ['asset-b', 'missing', 'asset-a']);

    expect([...result.keys()]).toEqual(['asset-b', 'asset-a']);
    expect(result.get('asset-b')?.data).toMatchObject({ id: 'asset-b', timestamp: 20 });
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
        data: { id: 'asset-b', timestamp: 20 },
      },
    });
    await watcher.return(undefined);
  });

  it('clears documents on close', async () => {
    const repository = new MemoryRepository();
    await repository.upsert(assetDocument('asset-a', 10));

    await repository.close();

    await expect(repository.list('assets')).resolves.toEqual([]);
    await expect(repository.get('assets', 'asset-a')).resolves.toBeNull();
  });
});
