export type IndexerCollection =
  | 'accounts'
  | 'accountMeta'
  | 'accountPointSystems'
  | 'accountLiquiditySnapshots'
  | 'assets'
  | 'assetSnapshots'
  | 'historyCalls'
  | 'historyElements'
  | 'networkSnapshots'
  | 'orderBooks'
  | 'orderBookOrders'
  | 'orderBookSnapshots'
  | 'poolXYKs'
  | 'poolSnapshots'
  | 'referrerRewards'
  | 'stakingStakers'
  | 'stakingValidators'
  | 'updatesStreams'
  | 'vaults'
  | 'vaultEvents'
  | 'xorBurns';

export type IndexerDocument = {
  collection: IndexerCollection;
  id: string;
  blockHeight?: number | null;
  timestamp?: number | null;
  data: Record<string, unknown>;
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
  seek?: {
    field: 'timestamp' | 'blockHeight';
    value: number;
    id: string;
    direction?: 'asc' | 'desc';
  };
};

export type RepositoryQueryResult = {
  items: IndexerDocument[];
  totalCount: number | null;
  pageStart?: number;
  hasNextPage?: boolean;
  hasPreviousPage?: boolean;
};

export type RepositoryMetricsSnapshot = Record<string, number>;

export interface IndexerRepository {
  list(collection: IndexerCollection): Promise<IndexerDocument[]>;
  query?(collection: IndexerCollection, args: RepositoryQueryArgs): Promise<RepositoryQueryResult>;
  watch?(collection: IndexerCollection, ids?: string[]): AsyncGenerator<IndexerDocument, void, unknown>;
  metricsSnapshot?(): RepositoryMetricsSnapshot;
  healthCheck?(): Promise<boolean>;
  get(collection: IndexerCollection, id: string): Promise<IndexerDocument | null>;
  getMany(collection: IndexerCollection, ids: string[]): Promise<Map<string, IndexerDocument>>;
  upsert(document: IndexerDocument): Promise<void>;
  upsertMany(documents: IndexerDocument[]): Promise<void>;
  close(): Promise<void>;
}
