import { PostgresRepository } from './postgres.js';
import { RocksRepository } from './rocksdb.js';

import type { AppConfig } from '../config.js';
import type { IndexerRepository } from './types.js';

export type RepositoryFactoryOptions = {
  postgresWorkerFencingToken?: string | null;
};

export const createRepository = (
  config: AppConfig,
  options: RepositoryFactoryOptions = {}
): IndexerRepository => {
  if (config.storageEngine === 'rocksdb') return new RocksRepository(config);

  return new PostgresRepository(config, {
    workerFencingToken: options.postgresWorkerFencingToken,
  });
};

export const shouldRunPostgresMigration = (config: AppConfig): boolean => config.storageEngine === 'postgres';
