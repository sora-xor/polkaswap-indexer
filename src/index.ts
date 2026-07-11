import { readConfig } from './config.js';
import { assertStandaloneStorageMode } from './deployment.js';
import { startServer } from './server.js';

const config = readConfig();
assertStandaloneStorageMode(config, 'api');
const server = await startServer(config).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

const shutdown = (signal: NodeJS.Signals): void => {
  console.info(`Received ${signal}, shutting down Polkaswap indexer API`);

  server
    ?.stop()
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
