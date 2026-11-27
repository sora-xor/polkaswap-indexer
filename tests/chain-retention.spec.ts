import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readConfig } from '../src/config.js';
import { RocksRepository } from '../src/repository/rocksdb.js';
import { createGraphQLHandler } from '../src/server.js';
import { ChainIndexer } from '../src/worker/chain.js';

import type { IndexerCollection, IndexerDocument } from '../src/repository/types.js';

type RetentionControls = {
  retireExpiredChartSnapshotBuckets: (groups: Array<{ collection: IndexerCollection }>, block: number, timestamp: number) => Promise<void>;
  retireExpiredChartSnapshotBucketsInternal: (groups: Array<{ collection: IndexerCollection }>, timestamp: number) => Promise<void>;
  retireExpiredNetworkBlockSnapshots: (timestamp: number) => Promise<void>;
  shouldPersistBackfillNetworkAggregate: (document: IndexerDocument, timestamp: number) => boolean;
};

describe('all-history snapshot preservation with native RocksDB', () => {
  let temporary: string;
  let repository: RocksRepository;

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'polkaswap-all-history-'));
    vi.stubEnv('STORAGE_ENGINE', 'rocksdb');
    vi.stubEnv('ROCKSDB_PATH', join(temporary, 'indexer.rocksdb'));
    vi.stubEnv('ROCKSDB_BLOCK_CACHE_MB', '16');
    vi.stubEnv('ROCKSDB_WRITE_BUFFER_MANAGER_MB', '16');
    vi.stubEnv('ROCKSDB_DOCUMENT_CACHE_MAX', '0');
    vi.stubEnv('ROCKSDB_DOCUMENT_CACHE_MAX_BYTES', '0');
    vi.stubEnv('CHAIN_SNAPSHOT_RETENTION_MODE', 'all');
    repository = new RocksRepository(readConfig());
    await repository.prepare();
  });

  afterEach(async () => {
    await repository?.close();
    vi.unstubAllEnvs();
    await rm(temporary, { recursive: true, force: true });
  });

  it('preserves migrated historical rows before any cleanup query and keeps old granularities queryable after reopen', async () => {
    const collections = ['accountLiquiditySnapshots', 'assetSnapshots', 'poolSnapshots', 'orderBookSnapshots', 'marketSnapshots', 'networkSnapshots'] as const;
    const documents: IndexerDocument[] = collections.flatMap((collection) =>
      (collection === 'accountLiquiditySnapshots' ? ['DEFAULT'] : ['BLOCK', 'DEFAULT', 'HOUR', 'DAY', 'MONTH']).map((type) => {
        const id = `${collection}-historical-${type}`;
        return { collection, id, blockHeight: 1, timestamp: 1,
          data: { id, type, timestamp: 1, assetId: 'asset', poolId: 'pool', orderBookId: 'book', marketId: 1 } };
      }));
    const checkpoint: IndexerDocument = { collection:'updatesStreams',id:'chainState',blockHeight:1,timestamp:1,
      data:{id:'chainState',block:1,data:'{"lastIndexedBlock":1}'} };
    await repository.upsertMany([...documents,checkpoint]);
    const query = vi.spyOn(repository,'query');
    const remove = vi.spyOn(repository,'deleteMany');
    const indexer = new ChainIndexer(readConfig(),repository) as unknown as RetentionControls;
    const groups = collections.map((collection)=>({collection}));
    await indexer.retireExpiredChartSnapshotBuckets(groups,2,10_000_000);
    await indexer.retireExpiredChartSnapshotBucketsInternal(groups,10_000_000);
    await indexer.retireExpiredNetworkBlockSnapshots(10_000_000);
    expect(query).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    for (const document of documents) expect(await repository.get(document.collection,document.id)).toEqual(document);
    expect(await repository.get('updatesStreams','chainState')).toEqual(checkpoint);
    await repository.validateCompactIndexes();
    await repository.close();
    repository = new RocksRepository(readConfig());
    await repository.prepare();
    for (const document of documents) expect(await repository.get(document.collection,document.id)).toEqual(document);
    const {yoga} = createGraphQLHandler(readConfig(),repository);
    const response = await yoga.fetch('http://localhost/graphql',{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:`{
        blocks: networkSnapshots(first:3,orderBy:[TIMESTAMP_ASC],filter:{type:{equalTo:"BLOCK"},timestamp:{lessThan:100}}){totalCount nodes{id type timestamp}}
        defaults: assetSnapshots(first:3,orderBy:[TIMESTAMP_ASC],filter:{assetId:{equalTo:"asset"},type:{equalTo:"DEFAULT"},timestamp:{lessThan:100}}){totalCount nodes{id type timestamp}}
        hours: assetSnapshots(first:3,orderBy:[TIMESTAMP_ASC],filter:{assetId:{equalTo:"asset"},type:{equalTo:"HOUR"},timestamp:{lessThan:100}}){totalCount nodes{id type timestamp}}
      }`}),
    });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.errors).toBeUndefined();
    for (const [key,type,id] of [['blocks','BLOCK','networkSnapshots-historical-BLOCK'],['defaults','DEFAULT','assetSnapshots-historical-DEFAULT'],['hours','HOUR','assetSnapshots-historical-HOUR']]) {
      expect(payload.data[key]).toEqual({totalCount:1,nodes:[{id,type,timestamp:1}]});
    }
  });

  it('persists every old time bucket while keeping aggregate windows separate from BLOCK charts', () => {
    const indexer = new ChainIndexer(readConfig(),repository) as unknown as RetentionControls & {
      createNetworkBackfillWindows: () => Array<{type:string}>;
    };
    expect(indexer.createNetworkBackfillWindows().map(({type})=>type)).toEqual(['DEFAULT','HOUR','DAY','MONTH']);
    for (const type of ['DEFAULT','HOUR','DAY','MONTH']) {
      const id = `old-${type}`;
      expect(indexer.shouldPersistBackfillNetworkAggregate({collection:'networkSnapshots',id,blockHeight:1,timestamp:1,
        data:{id,type,timestamp:1}},10_000_000)).toBe(true);
    }
  });
});
