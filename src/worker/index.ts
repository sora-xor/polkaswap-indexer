import {
  assertIndependentSoraRpcEndpoints,
  readConfig,
  readSoraArchiveWsEndpoint,
} from '../config.js';
import { migrate } from '../db/migrate.js';
import { PostgresRepository } from '../repository/postgres.js';
import { ChainIndexer } from './chain.js';
import { preflightSoraMainnetIdentity } from './identityPreflight.js';

const baseConfig = readConfig();
const archiveSoraWsEndpoint = readSoraArchiveWsEndpoint(process.env.NODE_ENV === 'production');
if (archiveSoraWsEndpoint) {
  assertIndependentSoraRpcEndpoints(baseConfig.soraWsEndpoint, archiveSoraWsEndpoint);
}
const config = { ...baseConfig, soraArchiveWsEndpoint: archiveSoraWsEndpoint };
await Promise.all([
  preflightSoraMainnetIdentity(config.soraWsEndpoint, { requireAnchorTimestamp: true }),
  ...(archiveSoraWsEndpoint ? [preflightSoraMainnetIdentity(archiveSoraWsEndpoint)] : []),
]);
console.info(
  archiveSoraWsEndpoint
    ? 'Verified reviewed primary and archive SORA mainnet identities before database initialization'
    : 'Verified reviewed SORA mainnet identity before database initialization'
);
const repository = new PostgresRepository(config.databaseUrl);

const indexer = new ChainIndexer(config, repository);
let shuttingDown = false;

const shutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`Received ${signal}, shutting down Polkaswap indexer worker`);
  void Promise.allSettled([indexer.stop(), repository.close()]).then(() => process.exit(0));
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

try {
  await migrate(config.databaseUrl);
  await indexer.start();
} catch (error) {
  await Promise.allSettled([indexer.stop(), repository.close()]);
  throw error;
}
