import { createServer } from 'node:http';

import { createYoga } from 'graphql-yoga';
import { useServer } from 'graphql-ws/use/ws';
import { WebSocketServer } from 'ws';

import { readConfig, type AppConfig } from './config.js';
import { migrate } from './db/migrate.js';
import { createSchema } from './graphql/resolvers.js';
import { PostgresRepository } from './repository/postgres.js';

import type { IndexerRepository } from './repository/types.js';

export type ServerHandle = {
  stop: () => Promise<void>;
};

/**
 * Starts the Polkaswap indexer GraphQL API.
 */
export async function startServer(
  config: AppConfig = readConfig(),
  repository: IndexerRepository = new PostgresRepository(config.databaseUrl)
): Promise<ServerHandle> {
  await migrate(config.databaseUrl);

  const schema = createSchema();
  const yoga = createYoga({
    schema,
    graphqlEndpoint: config.graphqlPath,
    context: () => ({ repository }),
    cors: {
      origin: '*',
      credentials: false,
    },
  });

  const server = createServer(yoga);
  const wsServer = new WebSocketServer({
    server,
    path: config.graphqlPath,
  });
  const wsCleanup = useServer(
    {
      schema,
      context: () => ({ repository }),
    },
    wsServer
  );

  await new Promise<void>((resolve) => {
    server.listen(config.port, config.host, resolve);
  });

  console.info(`Polkaswap indexer listening on http://${config.host}:${config.port}${config.graphqlPath}`);

  return {
    stop: async () => {
      await wsCleanup.dispose();
      wsServer.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await repository.close();
    },
  };
}
