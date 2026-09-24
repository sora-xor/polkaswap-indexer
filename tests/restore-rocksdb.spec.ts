import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';

import { backups, RocksDatabase } from '@harperfast/rocksdb-js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ROCKSDB_FORMAT_METADATA_KEY,
  ROCKSDB_FORMAT_VERSION,
  rocksCompactIndexKeysForDocument,
  RocksRepository,
} from '../src/repository/rocksdb.js';
import { createRocksdbBackup } from '../src/scripts/backup-rocksdb.js';
import {
  rocksdbBackupIntegrityManifestPath,
  verifyRocksdbBackupSha256,
  writeRocksdbBackupSha256Manifest,
} from '../src/scripts/rocksdb-backup-integrity.js';
import { createRocksdbRestorePlan } from '../src/scripts/env.js';
import { restoreRocksdbBackup } from '../src/scripts/restore-rocksdb.js';

import type { AppConfig } from '../src/config.js';
import type { IndexerDocument } from '../src/repository/types.js';

const createConfig = (rocksdbPath: string): AppConfig => ({
  host: '127.0.0.1',
  port: 4350,
  graphqlPath: '/graphql',
  httpListenBacklog: 4_096,
  httpShutdownTimeoutMs: 30_000,
  httpKeepAliveTimeoutMs: 75_000,
  httpHeadersTimeoutMs: 80_000,
  httpRequestTimeoutMs: 120_000,
  httpMaxConnections: 10_000,
  httpMaxHeaderBytes: 16_384,
  httpMaxRequestsPerSocket: 1_000,
  rateLimitWindowMs: 60_000,
  rateLimitMax: 600,
  rateLimitMaxKeys: 20_000,
  rateLimitGlobalWindowMs: 60_000,
  rateLimitGlobalMax: 50_000,
  graphqlHttpMaxBodyBytes: 262_144,
  graphqlHttpMaxInFlight: 100,
  graphqlMaxDepth: 12,
  graphqlMaxDocumentNodes: 2_000,
  graphqlMaxFields: 500,
  graphqlMaxAliases: 50,
  graphqlMaxFragmentSpreads: 100,
  graphqlMaxOperationCost: 100_000,
  graphqlAllowIntrospection: false,
  graphqlWsMaxPayloadBytes: 65_536,
  graphqlWsConnectionInitTimeoutMs: 30_000,
  graphqlWsMaxConnections: 1_000,
  graphqlWsMaxConnectionsPerClient: 16,
  graphqlWsMaxOperations: 2_000,
  graphqlWsMaxOperationsPerConnection: 20,
  graphqlWsMaxPendingMessagesPerConnection: 64,
  graphqlCacheMaxEntries: 1_000,
  graphqlCacheMaxBytes: 67_108_864,
  graphqlCacheTtlMs: 2_000,
  graphqlMaxResultBytes: 67_108_864,
  graphqlExecutionMemoryMaxBytes: 536_870_912,
  storageEngine: 'rocksdb',
  databaseUrl: 'postgres://polkaswap:polkaswap@127.0.0.1:5432/polkaswap_indexer',
  skipPostgresMigration: false,
  postgresPoolMax: 20,
  postgresListenPoolMax: 2,
  postgresConnectionTimeoutMs: 10_000,
  postgresQueryTimeoutMs: 120_000,
  postgresStatementTimeoutMs: 120_000,
  postgresMigrationQueryTimeoutMs: 0,
  postgresMigrationStatementTimeoutMs: 0,
  postgresWatchQueueMax: 1_000,
  postgresWatchReconnectMinDelayMs: 100,
  postgresWatchReconnectMaxDelayMs: 10_000,
  rocksdbPath,
  rocksdbBlockCacheMb: 32,
  rocksdbWriteBufferManagerMb: 16,
  rocksdbParallelism: 1,
  rocksdbEnableStats: false,
  rocksdbDocumentCacheMax: 128,
  rocksdbDocumentCacheMaxBytes: 268_435_456,
  rocksdbWatchQueueMax: 1_000,
  rocksdbQueryMaxScannedRows: 100_000,
  rocksdbCompactionMinFreeGb: 0,
  soraWsEndpoint: 'wss://mof2.sora.org',
  chainStartBlock: 0,
  chainBatchSize: 25,
  stateRefreshIntervalBlocks: 25,
  snapshotIntervalBlocks: 25,
  fullReconciliationIntervalBlocks: 250,
  chainShutdownTimeoutMs: 30_000,
  chainRpcTimeoutMs: 15_000,
  chainRpcMaxInFlight: 256,
  derivedStorageLoadMaxBytes: 268_435_456,
  derivedStorageCacheMaxBytes: 67_108_864,
  analyticsInputCacheMaxBytes: 134_217_728,
  backfillPrefetchConcurrency: 1,
  finalizedCatchupPrefetchConcurrency: 1,
  priceStreamRefreshIntervalBlocks: 0,
  legacySoraBlockTypes: false,
  archiveSoraWsEndpoint: '',
  workerReadinessMaxLagBlocks: 25,
  workerReadinessMaxStalenessSeconds: 120,
  workerMetricsHost: '127.0.0.1',
  workerMetricsPort: 9464,
  workerMetricsMaxInFlight: 10,
});

const assetDocument = (id: string, blockHeight: number): IndexerDocument => ({
  collection: 'assets',
  id,
  blockHeight,
  timestamp: blockHeight * 1_000,
  data: {
    id,
    symbol: id.toUpperCase(),
    name: `Asset ${id}`,
    blockHeight,
    timestamp: blockHeight * 1_000,
  },
});

const createCurrentDatabase = async (databasePath: string, documents: IndexerDocument[]): Promise<void> => {
  const repository = new RocksRepository(createConfig(databasePath));
  try {
    await repository.prepare();
    await repository.upsertMany(documents);
    await repository.validateCompactIndexes();
  } finally {
    await repository.close();
  }
};

const expectCurrentDocument = async (databasePath: string, expected: IndexerDocument): Promise<void> => {
  const repository = RocksRepository.openReadOnly(createConfig(databasePath));
  try {
    await repository.prepare();
    await expect(repository.get(expected.collection, expected.id)).resolves.toEqual(expected);
    await expect(repository.validateCompactIndexes()).resolves.toBeUndefined();
  } finally {
    await repository.close();
  }
};

const pathExists = async (candidate: string): Promise<boolean> =>
  lstat(candidate).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  );

const listRegularFiles = async (directory: string): Promise<string[]> => {
  const files: string[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const candidate = join(current, entry.name);
      if (entry.isDirectory()) await visit(candidate);
      else if (entry.isFile()) files.push(candidate);
    }
  };
  await visit(directory);
  return files;
};

const corruptBackedUpTableFile = async (backupDir: string): Promise<string> => {
  const files = await listRegularFiles(backupDir);
  const candidate = files.find((file) => /(?:^|\/)(?:shared|shared_checksum|private)(?:\/|$)/.test(file) && /\.sst(?:$|_)/.test(basename(file)))
    ?? files.find((file) => /(?:^|\/)(?:shared|shared_checksum|private)(?:\/|$)/.test(file));
  if (!candidate) throw new Error(`No RocksDB backup data file found under ${backupDir}`);

  const details = await stat(candidate);
  if (details.size < 1) throw new Error(`RocksDB backup data file is unexpectedly empty: ${candidate}`);
  const handle = await open(candidate, 'r+');
  try {
    const position = Math.floor(details.size / 2);
    const byte = Buffer.alloc(1);
    const { bytesRead } = await handle.read(byte, 0, 1, position);
    if (bytesRead !== 1) throw new Error(`Could not read RocksDB backup data file: ${candidate}`);
    byte[0] = byte[0]! ^ 0xff;
    await handle.write(byte, 0, 1, position);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return relative(backupDir, candidate);
};

describe('RocksDB restore operation', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'polkaswap-restore-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    'rejects invalid backup id %s before creating a staging parent',
    async (backupId) => {
      const restoreParent = join(root, 'must-not-be-created');
      await expect(
        restoreRocksdbBackup(createConfig(join(root, 'live.rocksdb')), {
          backupDir: join(root, 'backups'),
          backupId,
          targetPath: join(restoreParent, 'restore.rocksdb'),
        })
      ).rejects.toThrow(/positive safe integer/);
      await expect(pathExists(restoreParent)).resolves.toBe(false);
    }
  );

  it('checksum-verifies a current compact backup, restores into fresh random staging, and preserves readback', async () => {
    const sourcePath = join(root, 'live.rocksdb');
    const backupDir = join(root, 'backups');
    const restoreParent = join(root, 'restore-staging');
    const xor = assetDocument('xor', 101);
    const val = assetDocument('val', 102);
    await createCurrentDatabase(sourcePath, [xor, val]);
    const backupId = await createRocksdbBackup(sourcePath, backupDir);
    await expect(backups.verify(backupDir, backupId, { verifyWithChecksum: true })).resolves.toBeUndefined();

    const suffix = randomUUID();
    const plan = createRocksdbRestorePlan(
      {
        ROCKSDB_PATH: sourcePath,
        ROCKSDB_BACKUP_DIR: backupDir,
        ROCKSDB_RESTORE_PARENT_PATH: restoreParent,
        ROCKSDB_RESTORE_BACKUP_ID: String(backupId),
      },
      root,
      suffix
    );
    expect(plan.targetPath).toBe(join(restoreParent, `backup-${backupId}-${suffix}.rocksdb`));
    await expect(pathExists(plan.targetPath)).resolves.toBe(false);

    const result = await restoreRocksdbBackup(createConfig(sourcePath), plan);
    expect(result).toEqual({
      backupId,
      targetPath: await realpath(plan.targetPath),
    });
    await expectCurrentDocument(plan.targetPath, xor);
    await expectCurrentDocument(plan.targetPath, val);
    await expectCurrentDocument(sourcePath, xor);
  });

  it('rejects an existing generated target without changing its contents or the live database', async () => {
    const sourcePath = join(root, 'live.rocksdb');
    const backupDir = join(root, 'backups');
    const live = assetDocument('live-sentinel', 201);
    await createCurrentDatabase(sourcePath, [live]);
    const backupId = await createRocksdbBackup(sourcePath, backupDir);
    const plan = createRocksdbRestorePlan(
      {
        ROCKSDB_PATH: sourcePath,
        ROCKSDB_BACKUP_DIR: backupDir,
        ROCKSDB_RESTORE_PARENT_PATH: join(root, 'restore-staging'),
        ROCKSDB_RESTORE_BACKUP_ID: String(backupId),
      },
      root,
      randomUUID()
    );
    const sentinelPath = join(plan.targetPath, 'operator-sentinel.txt');
    await mkdir(plan.targetPath, { recursive: true });
    await writeFile(sentinelPath, 'must remain byte-for-byte unchanged');

    await expect(restoreRocksdbBackup(createConfig(sourcePath), plan)).rejects.toThrow(/already exists/);
    await expect(readFile(sentinelPath, 'utf8')).resolves.toBe('must remain byte-for-byte unchanged');
    await expect(readdir(plan.targetPath)).resolves.toEqual(['operator-sentinel.txt']);
    await expectCurrentDocument(sourcePath, live);
  });

  it('rejects canonical symlink overlap before creating anything inside the live or backup directories', async () => {
    const sourcePath = join(root, 'source.rocksdb');
    const backupDir = join(root, 'backups');
    const livePath = join(root, 'live.rocksdb');
    const live = assetDocument('live-sentinel', 301);
    await createCurrentDatabase(sourcePath, [assetDocument('backup-source', 300)]);
    await createCurrentDatabase(livePath, [live]);
    const backupId = await createRocksdbBackup(sourcePath, backupDir);
    const liveAlias = join(root, 'live-alias');
    const backupAlias = join(root, 'backup-alias');
    await symlink(livePath, liveAlias, 'dir');
    await symlink(backupDir, backupAlias, 'dir');

    const liveOverlapTarget = join(liveAlias, 'must-not-be-created', `backup-${backupId}-${randomUUID()}.rocksdb`);
    await expect(
      restoreRocksdbBackup(createConfig(livePath), {
        backupDir,
        backupId,
        targetPath: liveOverlapTarget,
      })
    ).rejects.toThrow(/must not contain/);
    await expect(pathExists(join(livePath, 'must-not-be-created'))).resolves.toBe(false);

    const backupOverlapTarget = join(
      backupAlias,
      'must-not-be-created',
      `backup-${backupId}-${randomUUID()}.rocksdb`
    );
    await expect(
      restoreRocksdbBackup(createConfig(livePath), {
        backupDir,
        backupId,
        targetPath: backupOverlapTarget,
      })
    ).rejects.toThrow(/must not contain/);
    await expect(pathExists(join(backupDir, 'must-not-be-created'))).resolves.toBe(false);
    await expectCurrentDocument(livePath, live);
  });

  it('fails checksum verification before claiming a target when backup bytes are corrupted', async () => {
    const sourcePath = join(root, 'source.rocksdb');
    const backupDir = join(root, 'backups');
    const livePath = join(root, 'live.rocksdb');
    const live = assetDocument('live-sentinel', 401);
    await createCurrentDatabase(sourcePath, [assetDocument('backup-source', 400)]);
    await createCurrentDatabase(livePath, [live]);
    const backupId = await createRocksdbBackup(sourcePath, backupDir);
    const corruptedFile = await corruptBackedUpTableFile(backupDir);
    const plan = createRocksdbRestorePlan(
      {
        ROCKSDB_PATH: livePath,
        ROCKSDB_BACKUP_DIR: backupDir,
        ROCKSDB_RESTORE_PARENT_PATH: join(root, 'restore-staging'),
        ROCKSDB_RESTORE_BACKUP_ID: String(backupId),
      },
      root,
      randomUUID()
    );

    await expect(restoreRocksdbBackup(createConfig(livePath), plan)).rejects.toThrow();
    await expect(pathExists(plan.targetPath)).resolves.toBe(false);
    expect(corruptedFile).not.toBe('');
    await expectCurrentDocument(livePath, live);
  });

  it('still requires native checksums when a corrupted file has a freshly forged SHA-256 manifest', async () => {
    const sourcePath = join(root, 'source.rocksdb');
    const backupDir = join(root, 'forged-manifest-backups');
    const livePath = join(root, 'live.rocksdb');
    await createCurrentDatabase(sourcePath, [assetDocument('backup-source', 425)]);
    await createCurrentDatabase(livePath, [assetDocument('live-sentinel', 426)]);
    const backupId = await createRocksdbBackup(sourcePath, backupDir);
    await corruptBackedUpTableFile(backupDir);
    await rm(rocksdbBackupIntegrityManifestPath(backupDir, backupId));
    await writeRocksdbBackupSha256Manifest(backupDir, backupId);
    await expect(verifyRocksdbBackupSha256(backupDir, backupId)).resolves.toBeUndefined();
    await expect(backups.verify(backupDir, backupId, { verifyWithChecksum: true })).rejects.toThrow();

    const plan = createRocksdbRestorePlan(
      {
        ROCKSDB_PATH: livePath,
        ROCKSDB_BACKUP_DIR: backupDir,
        ROCKSDB_RESTORE_PARENT_PATH: join(root, 'restore-staging'),
        ROCKSDB_RESTORE_BACKUP_ID: String(backupId),
      },
      root,
      randomUUID()
    );
    await expect(restoreRocksdbBackup(createConfig(livePath), plan)).rejects.toThrow();
    await expect(pathExists(plan.targetPath)).resolves.toBe(false);
  });

  it('rejects a native backup without the mandatory first-release SHA-256 receipt before claiming a target', async () => {
    const sourcePath = join(root, 'source.rocksdb');
    const backupDir = join(root, 'native-only-backups');
    const livePath = join(root, 'live.rocksdb');
    await createCurrentDatabase(sourcePath, [assetDocument('backup-source', 450)]);
    await createCurrentDatabase(livePath, [assetDocument('live-sentinel', 451)]);
    const source = RocksDatabase.open(sourcePath);
    let backupId: number;
    try {
      backupId = await source.backup(backupDir, { flushBeforeBackup: true, sync: true });
    } finally {
      source.close();
    }
    const plan = createRocksdbRestorePlan(
      {
        ROCKSDB_PATH: livePath,
        ROCKSDB_BACKUP_DIR: backupDir,
        ROCKSDB_RESTORE_PARENT_PATH: join(root, 'restore-staging'),
        ROCKSDB_RESTORE_BACKUP_ID: String(backupId),
      },
      root,
      randomUUID()
    );

    await expect(restoreRocksdbBackup(createConfig(livePath), plan)).rejects.toThrow(
      /Missing mandatory SHA-256 integrity manifest/
    );
    await expect(pathExists(plan.targetPath)).resolves.toBe(false);
  });

  it('rejects a checksum-valid backup with a wrong storage format without touching the live database', async () => {
    const wrongPath = join(root, 'wrong-format.rocksdb');
    const backupDir = join(root, 'wrong-format-backups');
    const livePath = join(root, 'live.rocksdb');
    const live = assetDocument('live-sentinel', 501);
    await createCurrentDatabase(livePath, [live]);
    const wrong = RocksDatabase.open(wrongPath);
    let backupId: number;
    try {
      await wrong.put(['m', 'metadata', ROCKSDB_FORMAT_METADATA_KEY], ROCKSDB_FORMAT_VERSION + 1);
      backupId = await wrong.backup(backupDir, { flushBeforeBackup: true, sync: true });
    } finally {
      wrong.close();
    }
    await expect(backups.verify(backupDir, backupId, { verifyWithChecksum: true })).resolves.toBeUndefined();
    await writeRocksdbBackupSha256Manifest(backupDir, backupId);
    const plan = createRocksdbRestorePlan(
      {
        ROCKSDB_PATH: livePath,
        ROCKSDB_BACKUP_DIR: backupDir,
        ROCKSDB_RESTORE_PARENT_PATH: join(root, 'restore-staging'),
        ROCKSDB_RESTORE_BACKUP_ID: String(backupId),
      },
      root,
      randomUUID()
    );

    await expect(restoreRocksdbBackup(createConfig(livePath), plan)).rejects.toThrow(/Unsupported RocksDB format/);
    await expect(pathExists(plan.targetPath)).resolves.toBe(false);
    await expectCurrentDocument(livePath, live);
  });

  it('rejects checksum-valid compact-index corruption during exhaustive logical validation', async () => {
    const corruptPath = join(root, 'corrupt-index.rocksdb');
    const backupDir = join(root, 'corrupt-index-backups');
    const livePath = join(root, 'live.rocksdb');
    const indexed = assetDocument('indexed', 600);
    const live = assetDocument('live-sentinel', 601);
    await createCurrentDatabase(corruptPath, [indexed]);
    await createCurrentDatabase(livePath, [live]);

    const corrupt = RocksDatabase.open(corruptPath);
    let backupId: number;
    try {
      await corrupt.remove(rocksCompactIndexKeysForDocument(indexed)[0]!);
      backupId = await corrupt.backup(backupDir, { flushBeforeBackup: true, sync: true });
    } finally {
      corrupt.close();
    }
    await expect(backups.verify(backupDir, backupId, { verifyWithChecksum: true })).resolves.toBeUndefined();
    await writeRocksdbBackupSha256Manifest(backupDir, backupId);
    const plan = createRocksdbRestorePlan(
      {
        ROCKSDB_PATH: livePath,
        ROCKSDB_BACKUP_DIR: backupDir,
        ROCKSDB_RESTORE_PARENT_PATH: join(root, 'restore-staging'),
        ROCKSDB_RESTORE_BACKUP_ID: String(backupId),
      },
      root,
      randomUUID()
    );

    await expect(restoreRocksdbBackup(createConfig(livePath), plan)).rejects.toThrow(/validation failed/);
    await expect(pathExists(plan.targetPath)).resolves.toBe(false);
    await expectCurrentDocument(livePath, live);
  });
});
