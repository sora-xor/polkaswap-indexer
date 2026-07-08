import { mkdirSync } from 'node:fs';

import { RocksDatabase, backups } from '@harperfast/rocksdb-js';

import { readConfig } from '../config.js';

const config = readConfig();
const backupDir = process.env.ROCKSDB_BACKUP_DIR ?? './data/polkaswap-indexer-rocksdb-backups';
const verifyWithChecksum = process.env.ROCKSDB_BACKUP_VERIFY_CHECKSUM === 'true';
const db = RocksDatabase.open(config.rocksdbPath, {
  readOnly: true,
});

try {
  mkdirSync(backupDir, { recursive: true });
  const backupId = await db.backup(backupDir, {
    metadata: JSON.stringify({
      createdAt: new Date().toISOString(),
      rocksdbPath: config.rocksdbPath,
    }),
  });

  console.info(`Created RocksDB backup ${backupId} in ${backupDir}`);
  await backups.verify(backupDir, backupId, { verifyWithChecksum });
  console.info(
    `Verified RocksDB backup ${backupId}${verifyWithChecksum ? ' with checksums' : ' with file sizes'}`
  );
} finally {
  db.close();
}
