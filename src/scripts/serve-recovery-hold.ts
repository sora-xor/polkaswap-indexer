/** Operator-only read-only API for a retained database during fork recovery.
 * Usage: node dist/src/scripts/serve-recovery-hold.js /absolute/hold-manifest.json
 * The manifest pins rocksdbPath, checkpoint, and an observed finalized height.
 * Optional dataStatus is abandoned-fork (default) or pre-fork-prefix; the latter
 * requires the fixed replay endpoint and independently verified replay evidence.
 * Stop the combined writer before starting this entrypoint. It has no worker,
 * chain connection, repair, or database mutation path.
 */
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { readConfig } from '../config.js';
import { createRecoveryHoldStatus } from '../recovery-hold.js';
import { RocksRepository } from '../repository/rocksdb.js';
import { startServer } from '../server.js';

const file = process.argv[2];
if (process.argv.length !== 3 || !file || !isAbsolute(file)) throw new Error('One absolute hold manifest is required');
const manifest = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
const config = readConfig();
if (manifest.schemaVersion !== 1 || config.storageEngine !== 'rocksdb' ||
    manifest.rocksdbPath !== config.rocksdbPath) throw new Error('Recovery hold storage target mismatch');
const repository = RocksRepository.openReadOnly(config);
try {
  await repository.prepare();
  const status = await createRecoveryHoldStatus(
    repository, manifest.checkpoint, manifest.observedFinalizedBlock as number,
    undefined, manifest.dataStatus,
  );
  const server = await startServer(config, repository, status);
  const shutdown = (): void => {
    server.stopAccepting();
    void server.stop().then(() => process.exit(0), () => process.exit(1));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  console.info('Recovery hold API started with native read-only RocksDB; indexing is stopped');
} catch (error) {
  await repository.close();
  throw error;
}
