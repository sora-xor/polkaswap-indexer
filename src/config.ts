export type AppConfig = {
  host: string;
  port: number;
  graphqlPath: string;
  databaseUrl: string;
  soraWsEndpoint: string;
  chainStartBlock: number;
  chainBatchSize: number;
  stateRefreshIntervalBlocks: number;
  snapshotIntervalBlocks: number;
};

const DEFAULT_CHAIN_STATE_REFRESH_INTERVAL_BLOCKS = 25;
const DEFAULT_CHAIN_SNAPSHOT_INTERVAL_BLOCKS = 25;

const readNumber = (name: string, fallback: number): number => {
  const value = process.env[name];
  if (!value) return fallback;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/**
 * Reads runtime configuration from environment variables.
 *
 * The UI is static and only needs the public GraphQL URL. This service keeps
 * all node/database credentials server-side.
 */
export function readConfig(): AppConfig {
  return {
    host: process.env.HOST ?? '0.0.0.0',
    port: readNumber('PORT', 4350),
    graphqlPath: process.env.GRAPHQL_PATH ?? '/graphql',
    databaseUrl:
      process.env.DATABASE_URL ?? 'postgres://polkaswap:polkaswap@127.0.0.1:5432/polkaswap_indexer',
    soraWsEndpoint: process.env.SORA_WS_ENDPOINT ?? 'wss://mof2.sora.org',
    chainStartBlock: readNumber('CHAIN_START_BLOCK', 0),
    chainBatchSize: readNumber('CHAIN_BATCH_SIZE', 25),
    stateRefreshIntervalBlocks: readNumber(
      'CHAIN_STATE_REFRESH_INTERVAL_BLOCKS',
      DEFAULT_CHAIN_STATE_REFRESH_INTERVAL_BLOCKS
    ),
    snapshotIntervalBlocks: readNumber('CHAIN_SNAPSHOT_INTERVAL_BLOCKS', DEFAULT_CHAIN_SNAPSHOT_INTERVAL_BLOCKS),
  };
}
