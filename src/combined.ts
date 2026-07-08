import { readConfig } from './config.js';
import { createRepository } from './repository/factory.js';
import { startServer } from './server.js';
import { ChainIndexer } from './worker/chain.js';

const config = readConfig();
const repository = createRepository(config);
const server = await startServer(config, repository).catch(async (error) => {
  await repository.close().catch(() => undefined);
  throw error;
});
const indexer = new ChainIndexer(config, repository);

const shutdown = (signal: NodeJS.Signals): void => {
  console.info(`Received ${signal}, shutting down combined Polkaswap indexer`);

  server
    .stop()
    .then(() => {
      process.exit(0);
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await indexer.start().catch(async (error) => {
  console.error(error);
  await server.stop().catch(() => undefined);
  process.exitCode = 1;
});
