import type { AppConfig } from './config.js';

/**
 * Embedded RocksDB can only be shared safely by the API and worker through one
 * process-local repository instance. Fail before opening the database when a
 * split entry point is misconfigured to use it.
 */
export const assertStandaloneStorageMode = (
  config: Pick<AppConfig, 'storageEngine'>,
  role: 'api' | 'worker'
): void => {
  if (config.storageEngine === 'rocksdb') {
    throw new Error(
      `The standalone ${role} cannot use embedded RocksDB; run the combined entry point with yarn start:combined`
    );
  }
};
