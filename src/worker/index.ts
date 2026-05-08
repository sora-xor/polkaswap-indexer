import { readConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { PostgresRepository } from '../repository/postgres.js';
import { ChainIndexer } from './chain.js';

const config = readConfig();
const repository = new PostgresRepository(config.databaseUrl);

await migrate(config.databaseUrl);

const indexer = new ChainIndexer(config, repository);

process.on('SIGINT', () => {
  repository.close().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  repository.close().finally(() => process.exit(0));
});

await indexer.start();
