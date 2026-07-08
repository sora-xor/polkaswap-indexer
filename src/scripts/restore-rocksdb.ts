import { backups } from '@harperfast/rocksdb-js';

import { readConfig } from '../config.js';

const config = readConfig();
const backupDir = process.env.ROCKSDB_BACKUP_DIR ?? './data/polkaswap-indexer-rocksdb-backups';
const targetPath = process.env.ROCKSDB_RESTORE_TARGET_PATH ?? config.rocksdbPath;
const backupId = process.env.ROCKSDB_RESTORE_BACKUP_ID ? Number(process.env.ROCKSDB_RESTORE_BACKUP_ID) : undefined;

await backups.restore(backupDir, targetPath, {
  backupId: Number.isFinite(backupId) ? backupId : undefined,
  mode: 'purgeAllFiles',
});

console.info(`Restored RocksDB backup from ${backupDir} into ${targetPath}`);
