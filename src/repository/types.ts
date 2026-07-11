export const INDEXER_COLLECTIONS = [
  'accounts',
  'accountMeta',
  'accountPointSystems',
  'accountPositions',
  'accountTrades',
  'accountTransactions',
  'accountLiquiditySnapshots',
  'assets',
  'assetSnapshots',
  'historyCalls',
  'historyElements',
  'markets',
  'marketSnapshots',
  'networkSnapshots',
  'orderBooks',
  'orderBookOrders',
  'orderBookSnapshots',
  'poolXYKs',
  'poolSnapshots',
  'referrerRewards',
  'stakingStakers',
  'stakingValidators',
  'updatesStreams',
  'vaults',
  'vaultEvents',
  'xorBurns',
] as const;

export type IndexerCollection = (typeof INDEXER_COLLECTIONS)[number];

export type IndexerDocument = {
  collection: IndexerCollection;
  id: string;
  blockHeight?: number | null;
  timestamp?: number | null;
  data: Record<string, unknown>;
};

/**
 * Stable sort position decoded from a GraphQL cursor. The logical offset is
 * retained only for repositories that still use offset pagination and for
 * page metadata; repositories with ordered indexes should seek by value/id.
 */
export type RepositoryKeyset = {
  scope: string;
  field: string;
  value: string | null;
  id: string;
  direction: 'asc' | 'desc';
  numeric: boolean;
};

export type RepositoryQueryArgs = {
  first?: number | null;
  last?: number | null;
  offset?: number | null;
  after?: string | number | null;
  before?: string | number | null;
  orderBy?: unknown;
  filter?: Record<string, unknown> | null;
  includeTotalCount?: boolean;
  /** Maximum retained/encoded bytes for returned documents; the first matching document always fits for progress. */
  maxBytes?: number | null;
  keyset?: RepositoryKeyset | null;
  seek?: {
    field: 'timestamp' | 'blockHeight';
    value: number;
    id: string;
    direction?: 'asc' | 'desc';
  };
};

export type RepositoryQueryResult = {
  items: IndexerDocument[];
  /** Opaque cursors aligned one-to-one with `items`, when available. */
  itemCursors?: string[];
  totalCount: number | null;
  pageStart?: number;
  hasNextPage?: boolean;
  hasPreviousPage?: boolean;
};

export type RepositoryMetricsSnapshot = Record<string, number>;

export type RepositoryWatchMutation = 'INSERT' | 'UPDATE' | 'DELETE';

/** Lightweight change identity; full documents are materialized only after transport admission. */
export type RepositoryWatchEvent = {
  collection: IndexerCollection;
  id: string;
  mutationType: RepositoryWatchMutation;
};

export interface IndexerRepository {
  prepare?(): Promise<void>;
  list(collection: IndexerCollection): Promise<IndexerDocument[]>;
  query?(collection: IndexerCollection, args: RepositoryQueryArgs): Promise<RepositoryQueryResult>;
  watch?(
    collection: IndexerCollection,
    ids?: string[],
    signal?: AbortSignal
  ): AsyncGenerator<RepositoryWatchEvent, void, unknown>;
  metricsSnapshot?(): RepositoryMetricsSnapshot;
  healthCheck?(): Promise<boolean>;
  get(collection: IndexerCollection, id: string): Promise<IndexerDocument | null>;
  getMany(collection: IndexerCollection, ids: string[]): Promise<Map<string, IndexerDocument>>;
  upsert(document: IndexerDocument): Promise<void>;
  upsertMany(documents: IndexerDocument[]): Promise<void>;
  deleteMany(collection: IndexerCollection, ids: string[]): Promise<void>;
  close(): Promise<void>;
}
