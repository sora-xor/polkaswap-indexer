import { PostgresRepository } from './postgres.js';
import { RocksRepository } from './rocksdb.js';

import type { AppConfig } from '../config.js';
import type { IndexerRepository } from './types.js';

export const createRepository = (config: AppConfig): IndexerRepository => {
  if (config.storageEngine === 'rocksdb') return new RocksRepository(config);

  return new PostgresRepository(config.databaseUrl);
};

export const shouldRunPostgresMigration = (config: AppConfig): boolean => config.storageEngine === 'postgres';
