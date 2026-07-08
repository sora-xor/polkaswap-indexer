import { readConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { createRepository, shouldRunPostgresMigration } from '../repository/factory.js';
import { ChainIndexer } from './chain.js';

const config = readConfig();
const repository = createRepository(config);

if (shouldRunPostgresMigration(config)) await migrate(config.databaseUrl);
await repository.prepare?.();

const indexer = new ChainIndexer(config, repository);

process.on('SIGINT', () => {
  repository.close().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  repository.close().finally(() => process.exit(0));
});

await indexer.start();
