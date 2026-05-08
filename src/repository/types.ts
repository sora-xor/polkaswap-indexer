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
  | 'updatesStreams'
  | 'vaults'
  | 'vaultEvents';

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
};

export type RepositoryQueryResult = {
  items: IndexerDocument[];
  totalCount: number;
};

export interface IndexerRepository {
  list(collection: IndexerCollection): Promise<IndexerDocument[]>;
  query?(collection: IndexerCollection, args: RepositoryQueryArgs): Promise<RepositoryQueryResult>;
  get(collection: IndexerCollection, id: string): Promise<IndexerDocument | null>;
  upsert(document: IndexerDocument): Promise<void>;
  upsertMany(documents: IndexerDocument[]): Promise<void>;
  close(): Promise<void>;
}
