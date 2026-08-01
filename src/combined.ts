import { readConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createRepository, shouldRunPostgresMigration } from './repository/factory.js';
import { startServer } from './server.js';
import { idempotentShutdown, runShutdownGroup, runShutdownSteps } from './shutdown.js';
import { ChainIndexer } from './worker/chain.js';
import { acquirePostgresWorkerLease, stopOnWorkerLeaseLoss } from './worker/lease.js';

const config = readConfig();
const migratedBeforeLease = !config.skipPostgresMigration && shouldRunPostgresMigration(config);
if (migratedBeforeLease) await migrate(config);
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
const indexer = new ChainIndexer(config, repository);
const serverConfig = migratedBeforeLease ? { ...config, skipPostgresMigration: true } : config;
const server = await startServer(serverConfig, repository, indexer).catch(async (error) => {
  await runShutdownSteps([
    () => indexer.stop(),
    () => runShutdownGroup([() => repository.close(), () => workerLease?.release()]),
  ]).catch(() => undefined);
  throw error;
});
const stopServices = idempotentShutdown(() => {
  server.stopAccepting();
  return runShutdownSteps([
    () => indexer.stop(),
    () => runShutdownGroup([() => server.stop(), () => workerLease?.release()]),
  ]);
});
const leaseLossShutdown = stopOnWorkerLeaseLoss(workerLease, stopServices, (error) => {
  console.error(error);
  process.exitCode = 1;
});
void leaseLossShutdown?.catch((error: unknown) => {
  console.error('Failed to shut down after losing the PostgreSQL worker lease', error);
  process.exitCode = 1;
});

const shutdown = (signal: NodeJS.Signals): void => {
  console.info(`Received ${signal}, shutting down combined Polkaswap indexer`);

  stopServices()
    .then(() => {
      process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
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
  await stopServices().catch((shutdownError: unknown) => {
    console.error('Failed to shut down combined Polkaswap indexer', shutdownError);
  });
  process.exitCode = 1;
});
