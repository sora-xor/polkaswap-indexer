import {
  assertExplicitProductionWorkerChainInputs,
  assertIndependentSoraRpcEndpoints,
  readConfig,
  readSoraArchiveWsEndpoint,
} from '../config.js';
import { assertStandaloneStorageMode } from '../deployment.js';
import { migrate } from '../db/migrate.js';
import { createRepository, shouldRunPostgresMigration } from '../repository/factory.js';
import { idempotentShutdown, runShutdownGroup, runShutdownSteps } from '../shutdown.js';
import { ChainIndexer } from './chain.js';
import { preflightSoraMainnetIdentity } from './identityPreflight.js';
import { acquirePostgresWorkerLease, stopOnWorkerLeaseLoss } from './lease.js';
import { startWorkerObservabilityServer } from './observability.js';

const config = readConfig();
assertStandaloneStorageMode(config, 'worker');
assertExplicitProductionWorkerChainInputs();

const archiveSoraWsEndpoint = readSoraArchiveWsEndpoint(process.env.NODE_ENV === 'production');
if (archiveSoraWsEndpoint) {
  assertIndependentSoraRpcEndpoints(config.soraWsEndpoint, archiveSoraWsEndpoint);
}
await Promise.all([
  preflightSoraMainnetIdentity(config.soraWsEndpoint, { requireAnchorTimestamp: true }),
  ...(archiveSoraWsEndpoint ? [preflightSoraMainnetIdentity(archiveSoraWsEndpoint)] : []),
]);
console.info(
  archiveSoraWsEndpoint
    ? 'Verified reviewed primary and archive SORA mainnet identities before storage initialization'
    : 'Verified reviewed SORA mainnet identity before storage initialization'
);

if (!config.skipPostgresMigration && shouldRunPostgresMigration(config)) await migrate(config);
const workerLease =
  config.storageEngine === 'postgres'
    ? await acquirePostgresWorkerLease(config.databaseUrl, {
        connectionTimeoutMs: config.postgresConnectionTimeoutMs,
        queryTimeoutMs: config.postgresQueryTimeoutMs,
        statementTimeoutMs: config.postgresStatementTimeoutMs,
      })
    : null;
const repository = await Promise.resolve()
  .then(() =>
    createRepository(config, {
      postgresWorkerFencingToken: workerLease?.fencingToken,
    })
  )
  .catch(async (error) => {
    await workerLease?.release().catch(() => undefined);
    throw error;
  });
await repository.prepare?.().catch(async (error) => {
  await runShutdownGroup([() => repository.close(), () => workerLease?.release()]).catch(() => undefined);
  throw error;
});

const indexer = new ChainIndexer(config, repository);
const observability = await startWorkerObservabilityServer(config, repository, indexer).catch(async (error) => {
  await indexer.stop().catch(() => undefined);
  await runShutdownGroup([() => repository.close(), () => workerLease?.release()]).catch(() => undefined);
  throw error;
});
const stopWorker = idempotentShutdown(() => {
  observability.stopAccepting();
  return runShutdownSteps([
    () => indexer.stop(),
    () => observability.stop(),
    () => runShutdownGroup([() => repository.close(), () => workerLease?.release()]),
  ]);
});
const leaseLossShutdown = stopOnWorkerLeaseLoss(workerLease, stopWorker, (error) => {
  console.error(error);
  process.exitCode = 1;
});
void leaseLossShutdown?.catch((error: unknown) => {
  console.error('Failed to shut down after losing the PostgreSQL worker lease', error);
  process.exitCode = 1;
});

const shutdown = (signal: NodeJS.Signals): void => {
  console.info(`Received ${signal}, shutting down Polkaswap chain worker`);

  stopWorker()
    .then(() => process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0))
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await indexer.start().catch(async (error) => {
  await stopWorker().catch((shutdownError: unknown) => {
    console.error('Failed to shut down Polkaswap chain worker', shutdownError);
  });
  throw error;
});
