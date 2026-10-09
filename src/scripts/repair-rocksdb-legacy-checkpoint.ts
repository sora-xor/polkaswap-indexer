import { randomUUID } from 'node:crypto';
import { link, lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { readConfig, type AppConfig } from '../config.js';
import { RocksRepository, ROCKSDB_FORMAT_METADATA_KEY, ROCKSDB_FORMAT_VERSION } from '../repository/rocksdb.js';
import { INDEXER_COLLECTIONS } from '../repository/types.js';
import { ChainIndexer } from '../worker/chain.js';
import { assertLegacyCheckpointBlockRepair, checkpointRepairDocumentHash, type LegacyCheckpointBlockRepair } from '../worker/checkpointRepair.js';
import { assertCanonicalDisjointPaths, readOptionalPositiveSafeInteger } from './env.js';
import { assertExistingRocksdbDirectory } from './rocksdb-artifact-source.js';
import {
  parsePostgresRocksdbMigrationState,
  POSTGRES_ROCKSDB_MIGRATION_STATE_KEY,
  type PostgresRocksdbMigrationState,
} from './rocksdb-migration-state.js';

export type CheckpointRepairOptions = { targetBlock: number; confirmation: string; receiptPath: string };
type RepairReceipt = {
  version: 1;
  kind: 'derived-missing-legacy-checkpoint-block';
  status: 'prepared' | 'applied';
  preparedAt: string;
  appliedAt: string | null;
  rocksdbPath: string;
  migration: PostgresRocksdbMigrationState;
  originalDocumentCount: number;
  addedDocuments: 1;
  documentSha256: string;
  repair: LegacyCheckpointBlockRepair;
};

/** Explicit acknowledgement of the separate one-row addition after sealed parity. */
export const readCheckpointRepairOptions = (env: NodeJS.ProcessEnv): CheckpointRepairOptions => {
  const targetBlock = readOptionalPositiveSafeInteger(env, 'ROCKSDB_CHECKPOINT_REPAIR_BLOCK');
  if (targetBlock === undefined) throw new Error('ROCKSDB_CHECKPOINT_REPAIR_BLOCK is required');
  const confirmation = env.ROCKSDB_CHECKPOINT_REPAIR_CONFIRM ?? '';
  if (confirmation !== `add-derived-block-${targetBlock}`) {
    throw new Error(`ROCKSDB_CHECKPOINT_REPAIR_CONFIRM must equal add-derived-block-${targetBlock}`);
  }
  const receiptPath = env.ROCKSDB_CHECKPOINT_REPAIR_RECEIPT ?? '';
  if (!isAbsolute(receiptPath)) throw new Error('ROCKSDB_CHECKPOINT_REPAIR_RECEIPT must be an explicit absolute path');
  return { targetBlock, confirmation, receiptPath };
};

const assertPrivateReceiptDirectory = async (receiptPath: string): Promise<void> => {
  const directory = await lstat(dirname(receiptPath));
  if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 ||
      directory.uid !== process.getuid?.()) {
    throw new Error('Checkpoint repair receipt requires an existing owner-only real directory');
  }
};

const syncReceiptDirectory = async (receiptPath: string): Promise<void> => {
  const directory = await open(dirname(receiptPath), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
};

const writeReceipt = async (path: string, receipt: RepairReceipt, replace: boolean): Promise<void> => {
  const encoded = `${JSON.stringify(receipt)}\n`;
  if (Buffer.byteLength(encoded) > 131_072) throw new Error('Checkpoint repair receipt exceeds its bounded file size');
  const target = `${path}.${randomUUID()}.tmp`;
  const file = await open(target, 'wx', 0o600);
  try {
    try {
      await file.writeFile(encoded, 'utf8');
      await file.sync();
    } finally { await file.close(); }
    if (replace) await rename(target, path);
    else await link(target, path); // Atomic publication that refuses an existing receipt.
    await syncReceiptDirectory(path);
  } finally {
    await unlink(target).catch(() => undefined);
  }
};

const readReceipt = async (path: string): Promise<RepairReceipt | null> => {
  let file;
  try { file = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!file.isFile() || file.isSymbolicLink() || (file.mode & 0o077) !== 0 ||
      file.uid !== process.getuid?.() || file.size > 131_072) {
    throw new Error('Checkpoint repair receipt must be a bounded owner-only real file');
  }
  const receipt = JSON.parse(await readFile(path, 'utf8')) as RepairReceipt;
  const expectedKeys = ['version', 'kind', 'status', 'preparedAt', 'appliedAt', 'rocksdbPath', 'migration',
    'originalDocumentCount', 'addedDocuments', 'documentSha256', 'repair'].sort();
  if (receipt.version !== 1 || receipt.kind !== 'derived-missing-legacy-checkpoint-block' ||
      JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(expectedKeys) ||
      !['prepared', 'applied'].includes(receipt.status) || receipt.addedDocuments !== 1 ||
      !Number.isSafeInteger(receipt.originalDocumentCount) || receipt.originalDocumentCount <= 0 ||
      !receipt.repair?.document || receipt.documentSha256 !== checkpointRepairDocumentHash(receipt.repair.document) ||
      (receipt.status === 'prepared' ? receipt.appliedAt !== null : typeof receipt.appliedAt !== 'string')) {
    throw new Error('Checkpoint repair receipt is malformed');
  }
  assertLegacyCheckpointBlockRepair(receipt.repair);
  if (parsePostgresRocksdbMigrationState(receipt.migration)?.status !== 'validated_complete') {
    throw new Error('Checkpoint repair receipt has no completed migration');
  }
  return receipt;
};

const documentCount = async (repository: RocksRepository): Promise<number> => {
  let count = 0;
  for (const collection of INDEXER_COLLECTIONS) {
    const result = await repository.query(collection, { first: 1, includeTotalCount: true });
    if (!Number.isSafeInteger(result.totalCount) || Number(result.totalCount) < 0) {
      throw new Error('Checkpoint repair could not obtain an exact original document count');
    }
    count += Number(result.totalCount);
  }
  return count;
};

const assertOriginalRows = async (repository: RocksRepository, repair: LegacyCheckpointBlockRepair): Promise<void> => {
  for (const original of [repair.legacyCheckpoint, repair.priorSnapshot, repair.anchorSnapshot]) {
    if (!isDeepStrictEqual(await repository.get(original.collection, original.id), original)) {
      throw new Error('Checkpoint repair source checkpoint, prior BLOCK, or anchor changed');
    }
  }
  if (await repository.get('updatesStreams', 'chainIdentity')) {
    throw new Error('Checkpoint repair refuses an artifact already carrying a chain identity');
  }
};

/** Owns the native exclusive writer lock; no PostgreSQL connection is opened. */
export const repairRocksdbLegacyCheckpoint = async (
  config: AppConfig,
  options: CheckpointRepairOptions,
): Promise<RepairReceipt> => {
  if (config.storageEngine !== 'rocksdb' || options.confirmation !== `add-derived-block-${options.targetBlock}` ||
      !isAbsolute(options.receiptPath)) throw new Error('Checkpoint repair requires RocksDB and exact explicit confirmation');
  await assertExistingRocksdbDirectory(config.rocksdbPath);
  await assertPrivateReceiptDirectory(options.receiptPath);
  await assertCanonicalDisjointPaths('ROCKSDB_PATH', config.rocksdbPath, 'repair receipt', options.receiptPath);
  const repository = new RocksRepository(config);
  try {
    if (repository.getMetadata(ROCKSDB_FORMAT_METADATA_KEY) !== ROCKSDB_FORMAT_VERSION) {
      throw new Error('Checkpoint repair requires the current RocksDB format');
    }
    const migration = parsePostgresRocksdbMigrationState(repository.getMetadata(POSTGRES_ROCKSDB_MIGRATION_STATE_KEY));
    if (!migration || migration.status !== 'validated_complete') {
      throw new Error('Checkpoint repair requires a sealed, exhaustively validated complete migration');
    }
    await repository.prepare();
    let receipt = await readReceipt(options.receiptPath);
    if (receipt) {
      if (receipt.rocksdbPath !== resolve(config.rocksdbPath) || !isDeepStrictEqual(receipt.migration, migration) ||
          receipt.repair.document.blockHeight !== options.targetBlock ||
          receipt.repair.document.collection !== 'networkSnapshots' || receipt.repair.document.id !== `block-${options.targetBlock}`) {
        throw new Error('Checkpoint repair receipt does not match this migration and target');
      }
      await assertOriginalRows(repository, receipt.repair);
      const existing = await repository.get('networkSnapshots', receipt.repair.document.id);
      if (existing) {
        if (!isDeepStrictEqual(existing, receipt.repair.document) ||
            await documentCount(repository) !== receipt.originalDocumentCount + 1) {
          throw new Error('Checkpoint repair receipt conflicts with the current artifact');
        }
        await repository.validateCompactIndexes();
        await repository.flushWrites();
        if (receipt.status === 'prepared') {
          receipt = { ...receipt, status: 'applied', appliedAt: new Date().toISOString() };
          await writeReceipt(options.receiptPath, receipt, true);
        }
        return receipt;
      }
      if (receipt.status === 'applied') throw new Error('Applied checkpoint repair receipt has no matching BLOCK');
    }
    const repair = await new ChainIndexer(config, repository).prepareLegacyCheckpointBlockRepair(options.targetBlock);
    assertLegacyCheckpointBlockRepair(repair);
    const originalDocumentCount = await documentCount(repository);
    if (receipt) {
      if (!isDeepStrictEqual(receipt.repair.document, repair.document) ||
          !isDeepStrictEqual(receipt.repair.legacyCheckpoint, repair.legacyCheckpoint) ||
          receipt.originalDocumentCount !== originalDocumentCount) {
        throw new Error('Resumed checkpoint projection does not match its durable prepared receipt');
      }
    } else {
      receipt = { version: 1, kind: 'derived-missing-legacy-checkpoint-block', status: 'prepared',
        preparedAt: new Date().toISOString(), appliedAt: null, rocksdbPath: resolve(config.rocksdbPath),
        migration, originalDocumentCount, addedDocuments: 1,
        documentSha256: checkpointRepairDocumentHash(repair.document), repair };
      await writeReceipt(options.receiptPath, receipt, false);
    }
    await assertOriginalRows(repository, repair);
    if (await repository.get('networkSnapshots', repair.document.id)) throw new Error('Checkpoint repair target appeared before insertion');
    await repository.upsert(repair.document);
    await assertOriginalRows(repository, repair);
    if (!isDeepStrictEqual(await repository.get('networkSnapshots', repair.document.id), repair.document) ||
        await documentCount(repository) !== originalDocumentCount + 1 ||
        !isDeepStrictEqual(repository.getMetadata(POSTGRES_ROCKSDB_MIGRATION_STATE_KEY), migration)) {
      throw new Error('Checkpoint repair did not preserve its exact one-row addition and migration receipt');
    }
    await repository.validateCompactIndexes();
    await repository.flushWrites();
    receipt = { ...receipt, status: 'applied', appliedAt: new Date().toISOString() };
    await writeReceipt(options.receiptPath, receipt, true);
    return receipt;
  } finally { await repository.close(); }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const receipt = await repairRocksdbLegacyCheckpoint(readConfig(), readCheckpointRepairOptions(process.env));
  console.info(`Added one derived BLOCK at ${receipt.repair.document.blockHeight}; preserved every original row and legacy checkpoint`);
}
