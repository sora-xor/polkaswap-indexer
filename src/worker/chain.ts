import { ApiPromise, WsProvider } from '@polkadot/api';
import { types as soraTypes } from '@sora-substrate/type-definitions';

import { uniqueIndexedAccountIds } from '../account-activity.js';
import { estimateRetainedValueBytes } from '../cache-weight.js';
import {
  assertIndependentSoraRpcEndpoints,
  type AppConfig,
} from '../config.js';
import { compareLexical } from '../lexical.js';
import { metrics } from '../metrics.js';
import { createRepositoryCursorScope } from '../repository/cursor.js';
import type { IndexerCollection, IndexerDocument, IndexerRepository, RepositoryQueryArgs } from '../repository/types.js';
import { MAX_REPOSITORY_WRITE_CALL_DOCUMENTS } from '../repository/validation.js';
import {
  isNonzeroCanonicalSubstrateHash,
  parseStoredSoraChainIdentity,
  parseStoredSoraChainState,
  SORA_LEGACY_IDENTITY_ANCHOR,
  SORA_MAX_BLOCK_NUMBER,
  SORA_MAINNET_GENESIS_HASH,
  type StoredSoraChainIdentity,
  type StoredSoraChainState,
} from '../soraIdentity.js';
import {
  chainIndexerLag,
  createPersistedWorkerStatusDocument,
  publishChainIndexerStatusMetrics,
  WORKER_STATUS_HEARTBEAT_INTERVAL_MS,
  WORKER_STATUS_DOCUMENT_ID,
  type ChainIndexerLifecycle,
  type ChainIndexerStatus,
} from './status.js';

export type { ChainIndexerStatus, ChainIndexerStatusProvider } from './status.js';

type CodecLike = {
  toJSON?: () => unknown;
  toHuman?: () => unknown;
  toString?: () => string;
  toHex?: () => string;
};

type EventRecord = {
  phase: {
    isApplyExtrinsic: boolean;
    asApplyExtrinsic: { toNumber: () => number };
  };
  event: CodecLike & {
    section: string;
    method: string;
    data: CodecLike & { toArray?: () => CodecLike[] };
    meta?: {
      fields?: Array<{ name?: { isSome?: boolean; unwrap?: () => { toString: () => string } } }>;
    };
  };
};

type IndexedCall = {
  module: string;
  method: string;
  data: Record<string, unknown>;
  hash?: string;
};

type CallLike = {
  section?: string;
  module?: string;
  method?: string;
  call?: string;
  args?: unknown[] | Record<string, unknown>;
  meta?: { args?: Array<{ name?: string | { toString: () => string } }> };
};

type BlockExtrinsicContext = {
  id: string;
  module: string;
  method: string;
  address: string;
  failed: boolean;
  history: { data: unknown; from: string; to: string; assets: string[] };
  calls: IndexedCall[];
  callNames: string[];
  events: EventRecord[];
  accounts: string[];
  fee: bigint;
};

type ExtrinsicLike = {
  isSigned?: boolean;
  signer?: { toString: () => string };
  hash?: { toString?: () => string };
  method: {
    section: string;
    method: string;
    args?: unknown[];
    meta?: { args?: Array<{ name?: string | { toString: () => string } }> };
  };
};

type SignedBlockLike = {
  block: {
    header?: {
      number?: { toNumber: () => number };
      hash?: { toString: () => string };
    };
    extrinsics: ExtrinsicLike[];
  };
};

type AssetInfo = {
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  supply: bigint;
};

type PoolState = {
  id: string;
  baseAssetId: string;
  targetAssetId: string;
  baseAssetReserves: bigint;
  targetAssetReserves: bigint;
  poolAccount: string;
  poolTokenSupply: bigint;
  liquidityUSD: string;
  priceUSD: string;
};

type SnapshotTypeName = 'DEFAULT' | 'HOUR' | 'DAY' | 'MONTH' | 'BLOCK';
type RetainedChartSnapshotType = 'DEFAULT' | 'HOUR';
type ChartSnapshotCollection =
  | 'accountLiquiditySnapshots'
  | 'assetSnapshots'
  | 'poolSnapshots'
  | 'orderBookSnapshots'
  | 'marketSnapshots'
  | 'networkSnapshots';
type ChartSnapshotRetentionGroup = {
  collection: ChartSnapshotCollection;
  types?: readonly RetainedChartSnapshotType[];
};

type PriceOhlc = {
  open: string;
  high: string;
  low: string;
  close: string;
};

type AssetAggregate = {
  volumeAmount: bigint;
  volumeUSD: bigint;
  mint: bigint;
  burn: bigint;
  priceUSD: PriceOhlc;
};

type PoolAggregate = {
  baseAssetVolume: bigint;
  targetAssetVolume: bigint;
  chameleonAssetVolume: bigint;
  volumeUSD: bigint;
  priceUSD: PriceOhlc;
};

type OrderBookAggregate = {
  baseAssetVolume: bigint;
  quoteAssetVolume: bigint;
  volumeUSD: bigint;
  liquidityUSD: bigint;
  price: PriceOhlc;
  lastDeals: Array<{ orderId: number; timestamp: number; isBuy: boolean; amount: string; price: string }>;
};

type NetworkLiquidityStats = {
  liquidityUSD: string;
  poolLiquidityUSD: string;
  orderBookLiquidityUSD: string;
  activePools: number;
  activeOrderBooks: number;
  listedAssets: number;
};

type NetworkAggregate = NetworkLiquidityStats & {
  /** Number of accounts first seen by the indexer during this snapshot window. */
  accounts: number;
  transactions: number;
  fees: bigint;
  volumeUSD: bigint;
  swaps: number;
  bridgeIncomingTransactions: number;
  bridgeOutgoingTransactions: number;
};

type NetworkBackfillBlock = {
  blockHeight: number;
  timestamp: number;
  accounts: number;
  transactions: number;
  fees: bigint;
  volumeUSD: bigint;
  swaps: number;
  bridgeIncomingTransactions: number;
  bridgeOutgoingTransactions: number;
};

type NetworkBackfillFlowTotals = Pick<
  NetworkAggregate,
  'accounts' | 'transactions' | 'fees' | 'volumeUSD' | 'swaps' | 'bridgeIncomingTransactions' | 'bridgeOutgoingTransactions'
>;

type NetworkBackfillWindow = {
  type: SnapshotTypeName;
  blocks: NetworkBackfillBlock[];
  windowStart: number;
  totals: NetworkBackfillFlowTotals;
  pendingDocument: IndexerDocument | null;
};

type Analytics = {
  assets: Map<string, Map<SnapshotTypeName, AssetAggregate>>;
  pools: Map<string, Map<SnapshotTypeName, PoolAggregate>>;
  orderBooks: Map<string, Map<SnapshotTypeName, OrderBookAggregate>>;
  network: Map<SnapshotTypeName, NetworkAggregate>;
  assetDayVolumeUSD: Map<string, bigint>;
  assetWeekVolumeUSD: Map<string, bigint>;
  assetDayOpenPrice: Map<string, string>;
  assetWeekOpenPrice: Map<string, string>;
  assetOrderBookLiquidity: Map<string, bigint>;
  poolDayVolumeUSD: Map<string, bigint>;
  orderBookDayVolumeUSD: Map<string, bigint>;
  orderBookDayOpenPrice: Map<string, string>;
  orderBookActiveReserves: Map<string, { baseAssetReserves: bigint; quoteAssetReserves: bigint; liquidityUSD: bigint }>;
};

type AnalyticsInputDocuments = {
  history: IndexerDocument[];
  blockSnapshots: IndexerDocument[];
  orderBookOrders: IndexerDocument[];
  assetDaySnapshots: IndexerDocument[];
  orderBookDaySnapshots: IndexerDocument[];
};

type AnalyticsInputCache = AnalyticsInputDocuments & {
  sourceVersion: number;
  refreshedAt: number;
  historyById: Map<string, IndexerDocument>;
  orderBookOrdersById: Map<string, IndexerDocument>;
  assetDaySnapshotsById: Map<string, IndexerDocument>;
  orderBookDaySnapshotsById: Map<string, IndexerDocument>;
};

type AnalyticsInputLoad = {
  documents: AnalyticsInputDocuments;
  rollingNetworkInputs: RollingNetworkInputCache;
  incremental: boolean;
  cacheable: boolean;
  sourceVersion?: number;
  previousSourceVersion?: number;
  previousRefreshedAt?: number;
  freshBlockSnapshots: IndexerDocument[];
  freshRollingBlocks: RollingNetworkBlock[];
};

type RollingNetworkBlock = NetworkBackfillBlock & { id: string };
type RollingNetworkInputCache = {
  sourceVersion: number;
  refreshedAt: number;
  blocks: RollingNetworkBlock[];
  blocksById: Map<string, RollingNetworkBlock>;
  blockStarts: Map<SnapshotTypeName, number>;
  totals: Map<SnapshotTypeName, NetworkBackfillFlowTotals>;
};

type AnalyticsInputCacheMetrics = {
  fullLoads: number;
  incrementalLoads: number;
  invalidations: number;
  documentsRead: number;
  evictions: number;
  evictedBytes: number;
  capacityBypasses: number;
  capacityBypassedBytes: number;
};

type AnalyticsRetainedLoadBudget = {
  maximumBytes: number;
  retainedBytes: number;
};

type RollingNetworkInputMetrics = {
  fullBuilds: number;
  incrementalUpdates: number;
  blockDocumentsProcessed: number;
};

type IndexBlockOptions = {
  refreshDerivedState?: boolean;
  networkAggregateWindows?: NetworkBackfillWindow[];
  flushNetworkAggregates?: boolean;
  backfillRetentionTimestamp?: number;
  retireExpiredNetworkBlocks?: boolean;
  historicalValuationState?: HistoricalValuationState;
};

type FetchedBlock = {
  requestedHash: string;
  signedBlock: any;
  events: EventRecord[];
  timestamp: number;
};

type FetchedBlockPayload = {
  fetchedBlock: FetchedBlock;
  blockHex: string | null;
  eventsHex: string | null;
  timestampMilliseconds: string;
};

type RpcExecutor = <T>(createRequest: () => Promise<T>, label: string) => Promise<T>;

type DerivedStateRefreshRequest = {
  blockHeight: number;
  timestamp: number;
  includeSnapshots: boolean;
  forceFullReconciliation?: boolean;
};

type PriceStreamRefreshRequest = {
  blockHeight: number;
  timestamp: number;
};

type StorageEntryKey = {
  args: unknown[];
  toHex?: () => string;
  toString?: () => string;
};

type StorageEntries = Array<[StorageEntryKey, unknown]>;

type DerivedStorageRetainedLoadBudget = {
  maximumBytes: number;
  retainedBytes: number;
  activeLoads: number;
  idleWaiters: Array<() => void>;
};

type HistoricalValuationPool = {
  baseAssetId: string;
  targetAssetId: string;
  baseAssetReserves: bigint;
  targetAssetReserves: bigint;
};

type HistoricalValuationState = {
  /** Storage state at this block, used as pre-state for the next block. */
  blockHeight: number;
  assets: Map<string, AssetInfo>;
  pools: Map<string, HistoricalValuationPool>;
  prices: Map<string, bigint>;
  networkLiquidityStats: NetworkLiquidityStats;
  orderBookLiquidityComplete: boolean;
};

type HistoricalValuationTouches = {
  assets: Map<string, unknown>;
  pools: Map<string, { baseAsset: unknown; targetAsset: unknown }>;
  invalidated: boolean;
  orderBookChanged: boolean;
};

type HistoricalValuationAdvance = {
  blockHeight: number;
  replacement?: HistoricalValuationState;
  assets: Array<{ id: string; value: AssetInfo | null }>;
  pools: Array<{ id: string; value: HistoricalValuationPool | null }>;
  invalidateOrderBookLiquidity?: boolean;
};

type DerivedStorageDomain =
  | 'assetMetadata'
  | 'assetSupply'
  | 'poolMetadata'
  | 'poolReserves'
  | 'poolIssuance'
  | 'poolProviders'
  | 'orderBooks'
  | 'polkamarkt'
  | 'farming'
  | 'staking'
  | 'referrals'
  | 'vaults';

type DerivedStorageCacheEntry = {
  blockHeight: number;
  generation: number;
  value: unknown;
};

type DerivedStorageLoadResult<T> = {
  value: T;
  refreshed: boolean;
  authoritativeForGeneration: boolean;
};

type AssetStorageState = {
  assetInfos: StorageEntries;
  tokenIssuances: StorageEntries;
  nativeXorIssuance: unknown;
  assetMetadataAuthoritative: boolean;
};

type PoolStorageState = {
  poolProperties: StorageEntries;
  poolReserves: StorageEntries;
  poolIssuances: StorageEntries;
  poolReservesAuthoritative: boolean;
};

type PolkamarktStorageState = {
  polkamarktConditions: StorageEntries;
  polkamarktConditionDetails: StorageEntries;
  polkamarktMarkets: StorageEntries;
  polkamarktDpmCollaterals: StorageEntries;
  polkamarktVolumes: StorageEntries;
  polkamarktTotals: StorageEntries;
  polkamarktResolutions: StorageEntries;
  polkamarktResolutionEvidence: StorageEntries;
  polkamarktCancellationEvidence: StorageEntries;
  polkamarktPositions: StorageEntries;
  polkamarktDpmCostBasis: StorageEntries;
  polkamarktDpmCostBasisTotals: StorageEntries;
  polkamarktCreatorFees: StorageEntries;
  authoritativeForGeneration: boolean;
};

type StakingValidatorInfo = {
  address: string;
  commission: string;
  blocked: boolean;
};

type StakingExposure = {
  total: bigint;
  own: string;
  others: Array<{ who: string; value: string }>;
};

type StakingRewardEra = {
  era: number;
  reward: bigint;
};

type StakingValidatorProjectionInputs = {
  validators: StakingValidatorInfo[];
  currentEra: number;
  rewardEra: StakingRewardEra | null;
  rewardPoints: { total: number; individual: Map<string, number> } | null;
  currentExposures: Map<string, StakingExposure>;
  apyExposures: Map<string, StakingExposure> | null;
  identityByAddress: Map<string, Record<string, unknown> | null>;
  maxNominatorRewarded: number;
};

type StakingStorageState = {
  nominators: StorageEntries;
  validatorInputs: StakingValidatorProjectionInputs;
};

type AccountPointUpdate = {
  module: string;
  method: string;
  data: unknown;
  fee: bigint;
  failed?: boolean;
};

type NetworkTransactionCounters = {
  transactions: number;
  swaps: number;
  bridgeIncomingTransactions: number;
  bridgeOutgoingTransactions: number;
};

type ChainIndexerConfig = Partial<AppConfig> &
  Pick<
    AppConfig,
    | 'soraWsEndpoint'
    | 'chainStartBlock'
    | 'chainBatchSize'
    | 'stateRefreshIntervalBlocks'
    | 'snapshotIntervalBlocks'
  >;

const CHAIN_STATE_ID = 'chainState';
const CHAIN_IDENTITY_ID = 'chainIdentity';
const ACCOUNT_TRANSACTIONS_BACKFILL_STATE_ID = 'accountTransactionsBackfill-v1';
const ALL_INDEXER_COLLECTIONS: readonly IndexerCollection[] = [
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
];
const XOR_BURN_BACKFILL_STATE_ID = 'xorBurnsBackfill';
const BRIDGE_PROXY_HISTORY_BACKFILL_STATE_ID = 'bridgeProxyHistoryBackfill-v1';
const NETWORK_AGGREGATE_BACKFILL_STATE_ID = 'networkAggregateSnapshotsBackfill';
const NETWORK_TRANSACTION_COUNTER_REPAIR_STATE_ID = 'networkTransactionCounterRepair-v1';
const ASSET_PRICE_OUTLIER_CLEANUP_STATE_ID = 'assetSnapshotPriceOutlierCleanup-v1';
const XOR_SUPPLY_REPAIR_STATE_ID = 'xorSupplyRepair-v1';
const DECIMALS = 18;
const SCALE = 10n ** 18n;
const DPM_VIRTUAL_SHARES = 100n * SCALE;
const XOR = '0x0200000000000000000000000000000000000000000000000000000000000000';
const VAL = '0x0200040000000000000000000000000000000000000000000000000000000000';
const SORA_NEXUS_XOR_BURN_REMARK_TYPE = 'soraNexusXorClaim';
const LIBERLAND_NETWORK_ID = 'Liberland';
const SORA_XOR_BURN_START_BLOCK = 25_043_003;
const readPositiveIntegerEnv = (name: string, fallback: number): number => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};
const XOR_BURN_BACKFILL_BATCH_SIZE = readPositiveIntegerEnv('CHAIN_XOR_BURN_BACKFILL_BATCH_SIZE', 500);
const XOR_BURN_BACKFILL_RPC_CONCURRENCY = readPositiveIntegerEnv('CHAIN_XOR_BURN_BACKFILL_RPC_CONCURRENCY', 16);
const XOR_BURN_BACKFILL_RETRY_DELAY_MS = readPositiveIntegerEnv('CHAIN_XOR_BURN_BACKFILL_RETRY_DELAY_MS', 30_000);
const XOR_BURN_BACKFILL_RPC_RETRIES = readPositiveIntegerEnv('CHAIN_XOR_BURN_BACKFILL_RPC_RETRIES', 3);
const XOR_BURN_BACKFILL_RPC_RETRY_DELAY_MS = readPositiveIntegerEnv('CHAIN_XOR_BURN_BACKFILL_RPC_RETRY_DELAY_MS', 2_000);
const BRIDGE_PROXY_HISTORY_BACKFILL_BATCH_SIZE = 500;
const BRIDGE_PROXY_HISTORY_BACKFILL_RPC_CONCURRENCY = 16;
const XOR_SUPPLY_REPAIR_RPC_CONCURRENCY = 8;
const ACCOUNT_TRANSACTIONS_BACKFILL_BATCH_SIZE = 1_000;
const FINALIZED_HEAD_RETRY_DELAY_MS = 5_000;
const FINALIZED_HEAD_POLL_INTERVAL_MS = 1_000;
const DERIVED_STATE_REFRESH_RETRY_DELAY_MS = 15_000;
const CHAIN_RPC_TIMEOUT_MS = 15_000;
const CHAIN_DISCONNECT_TIMEOUT_MS = 5_000;
const soraSpec1Types = {
  ...soraTypes,
  DispatchErrorModuleV0: { index: 'u8', error: 'u8' },
  DispatchError: {
    _enum: {
      Other: 'Null',
      CannotLookup: 'Null',
      BadOrigin: 'Null',
      Module: 'DispatchErrorModuleV0',
      ConsumerRemaining: 'Null',
      NoProviders: 'Null',
      TooManyConsumers: 'Null',
      Token: 'TokenError',
      Arithmetic: 'ArithmeticError',
    },
  },
  Weight: 'u64',
  DispatchInfo: { weight: 'u64', class: 'DispatchClass', paysFee: 'Pays' },
  PostDispatchInfo: { actualWeight: 'Option<u64>', paysFee: 'Pays' },
  // Spec 1 BridgeMultisig metadata exposes the bridge timepoint under the generic Timepoint name.
  Timepoint: 'BridgeTimepoint',
};
const soraArchiveTypesBundle = {
  spec: {
    sora: {
      types: [
        { minmax: [0, 1], types: soraSpec1Types },
        { minmax: [2, null], types: soraTypes },
      ],
    },
    'sora-substrate': {
      types: [
        { minmax: [0, 1], types: soraSpec1Types },
        { minmax: [2, null], types: soraTypes },
      ],
    },
  },
};
const PSWAP = '0x0200050000000000000000000000000000000000000000000000000000000000';
const DAI = '0x0200060000000000000000000000000000000000000000000000000000000000';
const XSTUSD = '0x0200080000000000000000000000000000000000000000000000000000000000';
const KUSD = '0x02000c0000000000000000000000000000000000000000000000000000000000';
const STABLE_ASSET_IDS = new Set([DAI, XSTUSD, KUSD]);
// Keep shallow pools from becoming global price oracles and inflating Explore TVL.
const MIN_PRICE_DISCOVERY_LIQUIDITY_USD = 100n * SCALE;
// Require meaningful natural depth on the asset being priced. Sub-0.5 token pools
// are too easy to skew, even when the stable side happens to exceed $100.
const MIN_PRICE_DISCOVERY_AMOUNT = SCALE / 2n;
const ASSET_PRICE_OUTLIER_RATIO = 20n;
const ASSET_PRICE_OUTLIER_NEIGHBOR_WINDOW_SECONDS = 30 * 86_400;
const ASSET_PRICE_OUTLIER_MIN_NEIGHBORS = 3;
const FEE_REFERRER_WEIGHT = 10;
const FEE_XOR_BURNED_WEIGHT = 20;
const FEE_VAL_BURNED_WEIGHT = 50;
const FEE_KUSD_BURNED_WEIGHT = 5;
const PERSISTED_CHART_SNAPSHOT_TYPES: readonly SnapshotTypeName[] = ['DEFAULT', 'HOUR', 'DAY', 'MONTH'];
const AGGREGATE_SNAPSHOT_TYPES = PERSISTED_CHART_SNAPSHOT_TYPES;
const RETAINED_CHART_SNAPSHOT_TYPES: readonly RetainedChartSnapshotType[] = ['DEFAULT', 'HOUR'];
const CHART_SNAPSHOT_RETENTION_SECONDS: Readonly<Record<RetainedChartSnapshotType, number>> = {
  DEFAULT: 48 * 60 * 60,
  HOUR: 8 * 24 * 60 * 60,
};
const SNAPSHOT_RETIREMENT_DELETE_BATCH_SIZE = Math.min(1_000, MAX_REPOSITORY_WRITE_CALL_DOCUMENTS);
const MAX_CHART_SNAPSHOT_RETENTION_PAGES_PER_TYPE_PER_REFRESH = 4;
const SNAPSHOT_WINDOW_SECONDS: Record<SnapshotTypeName, number> = {
  DEFAULT: 5 * 60,
  HOUR: 3_600,
  DAY: 86_400,
  MONTH: 30 * 86_400,
  BLOCK: 0,
};
// Rolling analytics consumes at most the latest thirty days. Keep an extra
// day so startup/backfill reads retain a complete month across timestamp
// overlap and small chain-time corrections.
const NETWORK_BLOCK_SNAPSHOT_RETENTION_SECONDS = SNAPSHOT_WINDOW_SECONDS.MONTH + 86_400;
const MAX_NETWORK_BLOCK_RETENTION_PAGES_PER_REFRESH = 4;
// Re-read one default snapshot window on incremental analytics refreshes. The
// overlap makes same-timestamp writes and small chain timestamp corrections
// idempotent while keeping repository scans bounded.
const ANALYTICS_INPUT_CACHE_OVERLAP_SECONDS = SNAPSHOT_WINDOW_SECONDS.DEFAULT;
const MIN_ANALYTICS_COLD_LOAD_MAX_BYTES = 64 * 1024 * 1024;
const ANALYTICS_COLD_LOAD_CACHE_MULTIPLIER = 2;
const ANALYTICS_RETAINED_ENTRY_OVERHEAD_BYTES = 32;
// Repository pages are a transient allocation on top of the retained
// analytics arrays. Keep every worker query page bounded independently so a
// small row count cannot materialize an arbitrarily large PostgreSQL result.
const WORKER_REPOSITORY_QUERY_PAGE_MAX_BYTES = 8 * 1024 * 1024;
const DERIVED_STORAGE_ENTRIES_PAGE_SIZE = 256;
const DERIVED_STORAGE_RETAINED_ENTRY_OVERHEAD_BYTES = 32;
const MAX_HISTORICAL_VALUATION_POINT_READS_PER_BLOCK = 1_024;
const DERIVED_STORAGE_CACHE_ENTRY_OVERHEAD_BYTES = 128;
const DERIVED_STORAGE_DOMAINS: readonly DerivedStorageDomain[] = [
  'assetMetadata',
  'assetSupply',
  'poolMetadata',
  'poolReserves',
  'poolIssuance',
  'poolProviders',
  'orderBooks',
  'polkamarkt',
  'farming',
  'staking',
  'referrals',
  'vaults',
];
const FARMING_PSWAP_PER_DAY = 2_500_000n * SCALE;
const DAYS_PER_YEAR = 365n;
const ERAS_PER_DAY = 4n;
const COMMISSION_DENOMINATOR = 1_000_000_000n;
const VALIDATOR_IDENTITY_CONCURRENCY = 8;
const EVENT_DATA_CACHE = new WeakMap<EventRecord['event'], Record<string, unknown>>();

const activeAggregateSnapshotTypes = (eventTimestamp: number, timestamp: number): SnapshotTypeName[] => {
  const active: SnapshotTypeName[] = [];

  for (const type of AGGREGATE_SNAPSHOT_TYPES) {
    if (eventTimestamp >= timestamp - SNAPSHOT_WINDOW_SECONDS[type]) active.push(type);
  }

  return active;
};

const collection = <T extends IndexerDocument['collection']>(name: T): T => name;

const emptyNetworkTransactionCounters = (): NetworkTransactionCounters => ({
  transactions: 0,
  swaps: 0,
  bridgeIncomingTransactions: 0,
  bridgeOutgoingTransactions: 0,
});

const isLiquidityProxySwap = (module: string, method: string, callNames: string[] = []): boolean =>
  (module === 'liquidityProxy' && (method === 'swap' || method === 'swapTransfer')) ||
  callNames.some((name) => name === 'liquidityProxy.swap' || name === 'liquidityProxy.swapTransfer');

const isBridgeOutgoing = (module: string, method: string): boolean =>
  module === 'ethBridge' || (module === 'bridgeProxy' && method === 'burn');

const isSyntheticBridgeIncoming = (id: string, module: string, method: string): boolean =>
  module === 'bridgeProxy' && method === 'mint' && id.endsWith('-mint');

const isBridgeIncoming = (id: string, module: string, method: string): boolean =>
  module === 'bridgeMultisig' || isSyntheticBridgeIncoming(id, module, method);

const historyExecutionSucceeded = (execution: unknown): boolean =>
  !execution || typeof execution !== 'object' || (execution as Record<string, unknown>).success !== false;

/** Corrupt or partial markers must not suppress reconstruction from legacy history rows. */
const hasCompletedAccountTransactionsBackfill = (value: unknown): boolean => {
  if (typeof value !== 'string' || !value) return false;

  try {
    const parsed = JSON.parse(value) as {
      processedDocuments?: unknown;
      writtenDocuments?: unknown;
      lastIndexedBlock?: unknown;
      lastTimestamp?: unknown;
    };

    return [parsed.processedDocuments, parsed.writtenDocuments, parsed.lastIndexedBlock, parsed.lastTimestamp].every(
      (item) => Number.isSafeInteger(item) && Number(item) >= 0
    );
  } catch {
    return false;
  }
};

/** Runs bounded async work so storage-derived refreshes do not flood the RPC node. */
const mapWithConcurrency = async <T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
  if (!items.length) return [];

  const limit = Math.max(1, Math.floor(concurrency));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;

      if (index >= items.length) return;

      results[index] = await mapper(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
};

const withTimeout = async <T>(promise: Promise<T>, label: string, timeoutMs = CHAIN_RPC_TIMEOUT_MS): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

type ParsedChainTimestamp = { seconds: number; milliseconds: string };

const parseChainTimestamp = (codec: unknown, label: string): ParsedChainTimestamp => {
  const text = String((codec as CodecLike | undefined)?.toString?.() ?? codec);
  if (!/^(0|[1-9][0-9]*)$/.test(text)) {
    throw new Error(`Invalid ${label} timestamp value`);
  }
  const timestampMs = Number(text);
  if (!Number.isSafeInteger(timestampMs) || timestampMs <= 0) {
    throw new Error(`Invalid ${label} timestamp value`);
  }
  const timestamp = Math.floor(timestampMs / 1000);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    throw new Error(`Invalid ${label} timestamp value`);
  }
  return { seconds: timestamp, milliseconds: text };
};

const canonicalCodecHex = (codec: unknown, label: string): string => {
  const value = (codec as { toHex?: () => unknown } | null)?.toHex?.();
  if (typeof value !== 'string' || !/^0x[0-9a-f]*$/i.test(value) || (value.length - 2) % 2 !== 0) {
    throw new Error(`${label} did not expose canonical SCALE bytes`);
  }
  return value.toLowerCase();
};

const isPrunedHistoricalStateErrorValue = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('State already discarded') || message.includes('unknown Block');
};

const delay = (delayMs: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, delayMs));

const toJson = (value: unknown): unknown => {
  if (value && typeof value === 'object' && 'toJSON' in value) {
    try {
      return (value as CodecLike).toJSON?.();
    } catch {
      return String(value);
    }
  }

  return value;
};

const toHuman = (value: unknown): unknown => {
  if (value && typeof value === 'object' && 'toHuman' in value) {
    try {
      return (value as CodecLike).toHuman?.();
    } catch {
      return toJson(value);
    }
  }

  return toJson(value);
};

const parseJsonString = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const CANONICAL_SORA_ASSET_ID_PATTERN = /^0x[0-9a-f]{64}$/i;

const assetIdToString = (value: unknown): string => {
  if (!value) return '';

  const json = toJson(value);
  if (typeof json === 'string') return json;
  if (json && typeof json === 'object' && 'code' in json) return String((json as { code?: unknown }).code ?? '');

  const human = toHuman(value);
  if (human && typeof human === 'object' && 'code' in human) return String((human as { code?: unknown }).code ?? '');

  const stringValue = String((value as CodecLike).toString?.() ?? value);
  const parsed = parseJsonString(stringValue);

  if (parsed && typeof parsed === 'object' && 'code' in parsed) {
    return String((parsed as { code?: unknown }).code ?? '');
  }

  return stringValue;
};

const canonicalSoraAssetId = (value: unknown): string | null => {
  const id = assetIdToString(value);
  return CANONICAL_SORA_ASSET_ID_PATTERN.test(id) ? id.toLowerCase() : null;
};

const codecToBigInt = (value: unknown): bigint => {
  const json = toJson(value);
  if (typeof json === 'number') return BigInt(Math.trunc(json));
  if (typeof json === 'bigint') return json;

  if (json && typeof json === 'object' && 'inner' in json) {
    return codecToBigInt((json as { inner?: unknown }).inner);
  }

  if (typeof json === 'string') {
    if (json.startsWith('0x')) return BigInt(json);
    return BigInt(json.replace(/,/g, '') || '0');
  }

  const stringValue = String((value as CodecLike | undefined)?.toString?.() ?? value ?? '0').replace(/,/g, '');
  if (!stringValue || stringValue === '[object Object]') return 0n;
  if (stringValue.startsWith('0x')) return BigInt(stringValue);

  return BigInt(stringValue);
};

/** Parses persisted referral reward codec amounts without letting malformed rows stop indexing. */
const referrerRewardAmount = (value: unknown): bigint => {
  try {
    return codecToBigInt(value);
  } catch {
    return 0n;
  }
};

const decimalToString = (value: bigint, decimals = DECIMALS, precision = 18): string => {
  const negative = value < 0n;
  const normalized = negative ? -value : value;
  const divisor = 10n ** BigInt(decimals);
  const integer = normalized / divisor;
  const fraction = normalized % divisor;
  const fractionText = fraction.toString().padStart(decimals, '0').slice(0, precision).replace(/0+$/, '');

  return `${negative ? '-' : ''}${integer.toString()}${fractionText ? `.${fractionText}` : ''}`;
};

const scaledToString = (value: bigint, precision = 10): string => decimalToString(value, 18, precision);

const decimalStringToScaled = (value: unknown): bigint => {
  const text = String(value ?? '0');
  const negative = text.startsWith('-');
  const normalized = negative ? text.slice(1) : text;
  const [integer = '0', fraction = ''] = normalized.split('.');
  const scaled = BigInt(integer || '0') * SCALE + BigInt(fraction.padEnd(18, '0').slice(0, 18) || '0');

  return negative ? -scaled : scaled;
};

const positiveDecimalStringToScaled = (value: unknown): bigint | null => {
  const text = String(value ?? '');
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(text)) return null;

  try {
    return decimalStringToScaled(text);
  } catch {
    return null;
  }
};

const codecToDecimalString = (value: unknown, decimals = DECIMALS): string =>
  decimalToString(codecToBigInt(value), decimals, 18);

const scaledMul = (left: bigint, right: bigint): bigint => (left * right) / SCALE;
const scaledDiv = (left: bigint, right: bigint): bigint => (right === 0n ? 0n : (left * SCALE) / right);

const integerSqrt = (value: bigint): bigint => {
  if (value < 0n) throw new Error('Cannot square-root a negative bigint');
  if (value < 2n) return value;

  let previous = value;
  let current = (value >> 1n) + 1n;

  while (current < previous) {
    previous = current;
    current = (current + value / current) >> 1n;
  }

  return previous;
};

const ratioBps = (numerator: bigint, denominator: bigint): number =>
  denominator <= 0n ? 0 : Number((numerator * 10_000n) / denominator);

const normalizedMechanism = (value: string): string => value.replace(/[_\s-]/g, '').toLowerCase();

const emptyIndexedMarketState = (yesShares: bigint, noShares: bigint) => ({
  realYesShares: yesShares < 0n ? 0n : yesShares,
  realNoShares: noShares < 0n ? 0n : noShares,
  virtualDepth: 0n,
  marginalYesPriceBps: 0,
  marginalNoPriceBps: 0,
  impliedYesProbabilityBps: 0,
  impliedNoProbabilityBps: 0,
  probability: null as number | null,
  priceYes: null as number | null,
  priceNo: null as number | null,
});

const dpmIndexedState = (yesShares: bigint, noShares: bigint) => {
  const realYesShares = yesShares < 0n ? 0n : yesShares;
  const realNoShares = noShares < 0n ? 0n : noShares;
  const qYes = DPM_VIRTUAL_SHARES + realYesShares;
  const qNo = DPM_VIRTUAL_SHARES + realNoShares;
  const totalQ = qYes + qNo;
  const cost = integerSqrt(qYes * qYes + qNo * qNo);
  const impliedYesProbabilityBps = ratioBps(qYes, totalQ);
  const impliedNoProbabilityBps = ratioBps(qNo, totalQ);
  const marginalYesPriceBps = ratioBps(qYes, cost);
  const marginalNoPriceBps = ratioBps(qNo, cost);

  return {
    realYesShares,
    realNoShares,
    virtualDepth: DPM_VIRTUAL_SHARES,
    marginalYesPriceBps,
    marginalNoPriceBps,
    impliedYesProbabilityBps,
    impliedNoProbabilityBps,
    probability: impliedYesProbabilityBps / 100,
    priceYes: impliedYesProbabilityBps / 10_000,
    priceNo: impliedNoProbabilityBps / 10_000,
  };
};

/** Mirrors Substrate `Imbalance::ration`: first share is floored, second share keeps the remainder. */
const splitByRatio = (amount: bigint, first: number, second: number): [bigint, bigint] => {
  const total = BigInt(first + second);
  if (total === 0n) return [0n, 0n];

  const firstAmount = (amount * BigInt(first)) / total;
  return [firstAmount, amount - firstAmount];
};
const scaledPow = (base: bigint, exponent: number): bigint => {
  let result = SCALE;
  for (let index = 0; index < exponent; index += 1) {
    result = scaledMul(result, base);
  }
  return result;
};

const codecUsd = (assetId: string, amount: bigint, prices: Map<string, bigint>, decimals = DECIMALS): string => {
  const price = prices.get(assetId) ?? 0n;
  const natural = scaledDiv(amount, 10n ** BigInt(decimals));

  return scaledToString(scaledMul(natural, price), 8);
};

const reserveToNaturalScaled = (reserve: bigint, decimals = DECIMALS): bigint => scaledDiv(reserve, 10n ** BigInt(decimals));

const naturalScaledToCodec = (amount: bigint, decimals = DECIMALS): bigint => (amount * 10n ** BigInt(decimals)) / SCALE;

const orderBookAmountUsd = (
  baseAssetId: string,
  quoteAssetId: string,
  amount: bigint,
  price: bigint,
  side: string,
  prices: Map<string, bigint>,
  assets: Map<string, AssetInfo>
): string => {
  const baseDecimals = assets.get(baseAssetId)?.decimals ?? DECIMALS;
  const baseAmount = reserveToNaturalScaled(amount, baseDecimals);

  if (side === 'Buy') {
    const quoteAmount = scaledMul(baseAmount, price);
    return scaledToString(scaledMul(quoteAmount, prices.get(quoteAssetId) ?? 0n), 8);
  }

  return scaledToString(scaledMul(baseAmount, prices.get(baseAssetId) ?? 0n), 8);
};

const emptyVolume = () => ({ amount: '0', amountUSD: '0' });
const emptyCounter = () => ({ created: 0, closed: 0, amountUSD: '0' });
const emptyGovernance = () => ({ votes: 0, amount: '0', amountUSD: '0' });
const emptyDeposit = () => ({ incomingUSD: '0', outgoingUSD: '0' });

const emptyPointData = (id: string, blockHeight: number, timestamp: number) => ({
  id,
  accountId: id,
  createdAtTimestamp: timestamp,
  createdAtBlock: blockHeight,
  xorFees: emptyVolume(),
  xorBurned: emptyVolume(),
  xorStakingValRewards: emptyVolume(),
  orderBook: emptyCounter(),
  vault: emptyCounter(),
  governance: emptyGovernance(),
  deposit: emptyDeposit(),
});

const normalizeKey = (key: string): string => {
  const normalized = key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
  return normalized === 'assetId' || normalized === 'assetID' ? 'assetId' : normalized;
};

const normalizeCallArgument = (value: unknown): unknown => {
  const hex = (value as CodecLike | undefined)?.toHex?.();

  return hex || normalizeValue(value);
};

const codecArgs = (method: { args?: unknown[]; meta?: { args?: Array<{ name?: string | { toString: () => string } }> } }) => {
  const args = method.args ?? [];
  const names = method.meta?.args ?? [];

  return Object.fromEntries(
    args.map((arg, index) => {
      const rawName = names[index]?.name;
      const name = normalizeKey(typeof rawName === 'string' ? rawName : rawName?.toString?.() ?? `arg${index}`);
      return [name, name === 'call' ? normalizeCallArgument(arg) : normalizeValue(arg)];
    })
  );
};

const normalizeValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(normalizeValue);

  const json = toJson(value);
  if (Array.isArray(json)) return json.map(normalizeValue);
  if (json && typeof json === 'object') {
    if ('code' in json) return String((json as { code?: unknown }).code ?? '');

    return Object.fromEntries(Object.entries(json as Record<string, unknown>).map(([key, item]) => [normalizeKey(key), normalizeValue(item)]));
  }

  if (typeof json === 'number' || typeof json === 'boolean' || json === null) return json;
  if (typeof json === 'string') return json;

  return String((value as CodecLike | undefined)?.toString?.() ?? '');
};

const eventData = (event: EventRecord['event']): Record<string, unknown> => {
  const cached = EVENT_DATA_CACHE.get(event);
  if (cached) return cached;

  const values = event.data.toArray?.() ?? [];
  const fields = event.meta?.fields ?? [];
  const data = Object.fromEntries(
    values.map((value, index) => {
      const nameValue = fields[index]?.name;
      const name = nameValue?.isSome ? nameValue.unwrap?.().toString() : undefined;
      return [normalizeKey(name ?? `arg${index}`), normalizeValue(value)];
    })
  );
  EVENT_DATA_CACHE.set(event, data);

  return data;
};

const getSigner = (extrinsic: { isSigned?: boolean; signer?: { toString: () => string } }): string => {
  return extrinsic.isSigned ? (extrinsic.signer?.toString() ?? '') : '';
};

/**
 * Normalizes nested utility-call arguments from either live codec calls or JSON payloads.
 */
const normalizeCallArgs = (call: CallLike): Record<string, unknown> => {
  if (Array.isArray(call.args)) {
    return codecArgs(call as { args?: unknown[]; meta?: { args?: Array<{ name?: string | { toString: () => string } }> } });
  }
  if (call.args && typeof call.args === 'object') return normalizeValue(call.args) as Record<string, unknown>;

  return {};
};

/**
 * Projects a nested utility call into the GraphQL shape consumed by the exchange UI.
 */
const toIndexedCall = (call: unknown): IndexedCall => {
  const direct = call as CallLike;
  if (direct?.section || direct?.module) {
    return {
      module: String(direct.section ?? direct.module ?? ''),
      method: String(direct.method ?? ''),
      data: { args: normalizeCallArgs(direct) },
    };
  }

  const item = toJson(call) as CallLike | null;
  if (!item || typeof item !== 'object') return { module: '', method: '', data: { args: {} } };

  const callName = String(item.call ?? '');
  const [callModule = '', callMethod = ''] = callName.split('.');

  return {
    module: String(item.section ?? item.module ?? callModule),
    method: String(item.method ?? callMethod),
    data: { args: normalizeCallArgs(item) },
  };
};

/**
 * Reads utility batch calls before lossy JSON conversion can erase codec call metadata.
 */
const getUtilityCallItems = (value: unknown): unknown[] => {
  if (!value) return [];
  if (Array.isArray(value)) return value;

  const items: unknown[] = [];
  const forEach = (value as { forEach?: (callback: (item: unknown) => void) => void }).forEach;
  if (typeof forEach === 'function') {
    forEach.call(value, (item) => items.push(item));
    return items;
  }

  if (typeof (value as { [Symbol.iterator]?: unknown })[Symbol.iterator] === 'function') {
    return Array.from(value as Iterable<unknown>);
  }

  const json = toJson(value);
  return Array.isArray(json) ? json : [];
};

const getUtilityCalls = (extrinsic: { method: { section: string; method: string; args?: unknown[] } }): IndexedCall[] => {
  if (extrinsic.method.section !== 'utility') return [];

  const maybeCalls = getUtilityCallItems(extrinsic.method.args?.[0]);

  return maybeCalls.map(toIndexedCall);
};

const getCallArgs = (call: IndexedCall): Record<string, unknown> => {
  const args = call.data.args;
  return args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
};

const decodeText = (value: unknown): string => {
  const text = String(value ?? '');
  if (!text.startsWith('0x')) return text;

  try {
    return Buffer.from(text.slice(2), 'hex').toString('utf8');
  } catch {
    return text;
  }
};

const parseSoraNexusRecipient = (remark: unknown): string | undefined => {
  try {
    const parsed = JSON.parse(decodeText(remark)) as { type?: unknown; version?: unknown; recipient?: unknown };
    if (
      parsed.type === SORA_NEXUS_XOR_BURN_REMARK_TYPE &&
      parsed.version === 1 &&
      typeof parsed.recipient === 'string'
    ) {
      return parsed.recipient;
    }
  } catch {
    return undefined;
  }

  return undefined;
};

const isXorBurnCall = (call: IndexedCall): boolean => {
  if (call.module !== 'assets' || call.method !== 'burn') return false;

  const args = getCallArgs(call);
  return firstString(args, ['assetId', 'asset_id', 'arg0']) === XOR;
};

const getBatchAllNexusRecipient = (context: BlockExtrinsicContext): string | undefined => {
  if (context.module !== 'utility' || context.method !== 'batchAll' || context.calls.length !== 2) return undefined;

  const [burnCall, remarkCall] = context.calls;
  if (!burnCall || !remarkCall || !isXorBurnCall(burnCall) || remarkCall.module !== 'system' || remarkCall.method !== 'remark') {
    return undefined;
  }

  const remarkArgs = getCallArgs(remarkCall);
  return parseSoraNexusRecipient(remarkArgs.remark ?? remarkArgs.arg0);
};

/**
 * Emits compact XOR burn documents so the burn page does not need an expensive historyElements scan.
 */
const createXorBurnDocuments = (
  context: BlockExtrinsicContext,
  blockHeight: number,
  timestamp: number,
  assets: Map<string, AssetInfo>
): IndexerDocument[] => {
  const createDocument = (id: string, address: string, amount: string, nexusRecipient?: string): IndexerDocument => ({
    collection: collection('xorBurns'),
    id,
    blockHeight,
    timestamp,
    data: {
      id,
      address,
      amount,
      assetId: XOR,
      blockHeight,
      timestamp,
      txHash: context.id,
      ...(nexusRecipient ? { nexusRecipient } : {}),
    },
  });

  if (context.module === 'assets' && context.method === 'burn') {
    const data = context.history.data as Record<string, unknown>;
    if (String(data.assetId ?? data.asset_id ?? '') !== XOR || !data.amount) return [];

    return [createDocument(context.id, context.address || context.history.from, String(data.amount))];
  }

  if (context.module !== 'utility' || (context.method !== 'batchAll' && context.method !== 'batch')) return [];

  const nexusRecipient = getBatchAllNexusRecipient(context);
  const burnCalls = context.calls.filter(isXorBurnCall);

  return burnCalls.map((call, index) => {
    const args = getCallArgs(call);
    const amount = codecToDecimalString(args.amount ?? args.arg1 ?? '0', assets.get(XOR)?.decimals ?? DECIMALS);
    const id = burnCalls.length === 1 ? context.id : `${context.id}-${index}`;

    return createDocument(id, context.address || context.history.from, amount, nexusRecipient);
  });
};

const getEventExtrinsicIndex = (record: EventRecord): number | null => {
  if (!record.phase?.isApplyExtrinsic) return null;

  const index = record.phase.asApplyExtrinsic.toNumber();
  return Number.isFinite(index) ? index : null;
};

const getXorBurnEvent = (
  record: EventRecord,
  assets: Map<string, AssetInfo>
): { address: string; amount: string; extrinsicIndex: number | null } | null => {
  if (record.event.section !== 'assets' || record.event.method.toLowerCase() !== 'burn') return null;

  const values = record.event.data.toArray?.() ?? [];
  const [first, second, third] = values;
  const [address, assetId, amount] = assetIdToString(first) === XOR ? [second, first, third] : [first, second, third];

  if (!address || !assetId || !amount || assetIdToString(assetId) !== XOR) return null;

  return {
    address: String(address.toString?.() ?? normalizeValue(address)),
    amount: codecToDecimalString(amount, assets.get(XOR)?.decimals ?? DECIMALS),
    extrinsicIndex: getEventExtrinsicIndex(record),
  };
};

const getExtrinsicNexusRecipient = (extrinsic: { method: { section: string; method: string; args?: unknown[] } }): string | undefined => {
  if (extrinsic.method.section !== 'utility' || extrinsic.method.method !== 'batchAll') return undefined;

  const calls = getUtilityCalls(extrinsic);
  const [burnCall, remarkCall] = calls;

  if (!burnCall || !remarkCall || calls.length !== 2 || !isXorBurnCall(burnCall) || remarkCall.module !== 'system' || remarkCall.method !== 'remark') {
    return undefined;
  }

  const remarkArgs = getCallArgs(remarkCall);
  return parseSoraNexusRecipient(remarkArgs.remark ?? remarkArgs.arg0);
};

const createXorBurnDocumentsFromEvents = (
  blockHeight: number,
  timestamp: number | null,
  signedBlock: { block: { extrinsics: Array<{ hash?: { toString?: () => string }; method: { section: string; method: string; args?: unknown[] } }> } },
  events: EventRecord[],
  assets: Map<string, AssetInfo>
): IndexerDocument[] => {
  const extrinsics = signedBlock.block.extrinsics;
  const burnCountsByTx = new Map<string, number>();

  return events.flatMap((record) => {
    const burn = getXorBurnEvent(record, assets);
    if (!burn) return [];

    const extrinsic = burn.extrinsicIndex === null ? undefined : extrinsics[burn.extrinsicIndex];
    const txHash = extrinsic?.hash?.toString?.();
    const baseId = txHash || `${blockHeight}-${burn.extrinsicIndex ?? 'event'}`;
    const txBurnCount = burnCountsByTx.get(baseId) ?? 0;
    burnCountsByTx.set(baseId, txBurnCount + 1);
    const id = txBurnCount === 0 ? baseId : `${baseId}-${txBurnCount}`;
    const nexusRecipient = extrinsic ? getExtrinsicNexusRecipient(extrinsic) : undefined;

    return [
      {
        collection: collection('xorBurns'),
        id,
        blockHeight,
        timestamp,
        data: {
          id,
          address: burn.address,
          amount: burn.amount,
          assetId: XOR,
          blockHeight,
          ...(timestamp === null ? {} : { timestamp }),
          ...(txHash ? { txHash } : {}),
          ...(nexusRecipient ? { nexusRecipient } : {}),
        },
      },
    ];
  });
};

const collectAssetsInto = (value: unknown, assets: Set<string>): void => {
  if (!value) return;

  if (typeof value === 'string' && value.startsWith('0x') && value.length >= 66) {
    assets.add(value);
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectAssetsInto(item, assets));
  } else if (typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => collectAssetsInto(item, assets));
  }
};

const collectAssets = (value: unknown): string[] => {
  const assets = new Set<string>();
  collectAssetsInto(value, assets);

  return [...assets];
};

const nestedString = (value: unknown): string => {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value !== undefined && value !== null && typeof value !== 'object') return String(value);

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const keys = [
      'EVM',
      'Evm',
      'evm',
      'EVMLegacy',
      'evmLegacy',
      'Sub',
      'sub',
      'Sora',
      'sora',
      'Liberland',
      'liberland',
      'Parachain',
      'parachain',
      'TON',
      'Ton',
      'ton',
      'Unknown',
      'unknown',
      'Root',
      'root',
      'value',
      'id',
      'code',
    ];

    for (const key of keys) {
      const nested = nestedString(record[key]);
      if (nested) return nested;
    }
  }

  return '';
};

const firstString = (record: Record<string, unknown>, keys: string[]): string => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
    if (value !== undefined && value !== null && typeof value !== 'object') return String(value);
  }

  return '';
};

const firstNestedString = (record: Record<string, unknown>, keys: string[]): string => {
  for (const key of keys) {
    const value = nestedString(record[key]);
    if (value) return value;
  }

  return '';
};

/** Returns the first non-empty raw value without coercing nested codec payloads. */
const firstPresentValue = (record: Record<string, unknown>, keys: string[]): unknown => {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }

  return undefined;
};

/** Returns the first record-shaped value for variant-style normalized data. */
const firstRecord = (record: Record<string, unknown>, keys: string[]): Record<string, unknown> | null => {
  for (const key of keys) {
    const value = record[key];
    if (isRecord(value)) return value;
  }

  return null;
};

/** Finds a variant object inside the normalized SwapAmount argument shape. */
const swapAmountVariant = (value: unknown, keys: string[]): Record<string, unknown> | null => {
  if (!isRecord(value)) return null;

  return firstRecord(value, keys);
};

/** Extracts the requested input amount from current and legacy swap argument shapes. */
const swapInputAmountFromArgs = (args: Record<string, unknown>): unknown => {
  const desiredInput = swapAmountVariant(args.swapAmount, ['WithDesiredInput', 'withDesiredInput']);

  return (
    firstPresentValue(args, ['amount', 'baseAssetAmount', 'inputAmount']) ??
    firstPresentValue(desiredInput ?? {}, ['desiredAmountIn', 'desired_amount_in', 'amount', 'arg0'])
  );
};

/** Extracts the requested output amount from current and legacy swap argument shapes. */
const swapOutputAmountFromArgs = (args: Record<string, unknown>): unknown => {
  const desiredOutput = swapAmountVariant(args.swapAmount, ['WithDesiredOutput', 'withDesiredOutput']);

  return (
    firstPresentValue(args, ['targetAssetAmount', 'outputAmount']) ??
    firstPresentValue(desiredOutput ?? {}, ['desiredAmountOut', 'desired_amount_out', 'amount', 'arg0']) ??
    firstPresentValue(args, ['minOutputAmount'])
  );
};

const isValidEvmNetworkId = (value: string): boolean => {
  if (!value) return false;

  if (value.startsWith('0x')) {
    try {
      const parsed = BigInt(value);

      return parsed > 0n && parsed <= BigInt(Number.MAX_SAFE_INTEGER);
    } catch {
      return false;
    }
  }

  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed > 0;
};

/** Returns true for the standalone Substrate network currently restored through bridgeProxy history. */
const isLiberlandBridgeNetwork = (value: string): boolean => value.toLowerCase() === LIBERLAND_NETWORK_ID.toLowerCase();

/** Classifies bridgeProxy network identifiers that can be restored into bridge history rows. */
const bridgeNetworkType = (networkId: string): string => {
  if (isLiberlandBridgeNetwork(networkId)) return 'Sub';
  if (isValidEvmNetworkId(networkId)) return 'Evm';

  return '';
};

/** Adds explicit external-network metadata used by bridge history consumers. */
const bridgeNetworkData = (networkId: string): Record<string, string> => {
  const externalNetworkType = bridgeNetworkType(networkId);

  return {
    ...(networkId ? { networkId } : {}),
    ...(externalNetworkType ? { externalNetwork: isLiberlandBridgeNetwork(networkId) ? LIBERLAND_NETWORK_ID : networkId } : {}),
    ...(externalNetworkType ? { externalNetworkType } : {}),
  };
};

/** Keeps external Liberland SS58 addresses out of local SORA account activity rows. */
const historyIndexedAccounts = (
  module: string,
  method: string,
  address: string,
  history: { data: unknown; from: string; to: string }
): string[] => {
  if (module === 'bridgeProxy' && isRecord(history.data) && bridgeNetworkType(String(history.data.networkId ?? '')) === 'Sub') {
    return uniqueIndexedAccountIds(method === 'mint' ? [history.from || address] : [address, history.from]);
  }

  return uniqueIndexedAccountIds([address, history.from, history.to]);
};

const findEvent = (events: EventRecord[], section: string, method: string): Record<string, unknown> | null => {
  const match = events.find((item) => item.event.section === section && item.event.method === method);
  return match ? eventData(match.event) : null;
};

const findEvents = (events: EventRecord[], section: string, method: string): Array<Record<string, unknown>> =>
  events.filter((item) => item.event.section === section && item.event.method === method).map((item) => eventData(item.event));

const hasStorageEntries = (storage: unknown): boolean =>
  typeof (storage as { entriesPaged?: unknown } | undefined)?.entriesPaged === 'function';

const createAmountData = (assetId: string, amount: unknown, prices: Map<string, bigint>, assets: Map<string, AssetInfo>) => {
  const info = assets.get(assetId);
  const raw = codecToBigInt(amount);

  return {
    amount: codecToDecimalString(amount, info?.decimals ?? DECIMALS),
    amountUSD: codecUsd(assetId, raw, prices, info?.decimals ?? DECIMALS),
    assetId,
  };
};

const createPolkamarktHistoryData = (
  method: string,
  args: Record<string, unknown>,
  events: EventRecord[],
  signer: string
): { data: unknown; from: string; to: string; assets: string[] } | null => {
  const token = method.replace(/_/g, '').toLowerCase();
  const trade = findEvent(events, 'polkamarkt', 'TradeExecuted');

  if ((token === 'buy' || token === 'sell') && trade) {
    const marketId = Number(trade.marketId ?? trade.arg0 ?? args.marketId ?? args.arg0 ?? 0);
    const trader = firstString(trade, ['trader', 'account', 'arg1']) || signer;
    const collateralAmount = firstPresentValue(trade, ['collateralAmount', 'arg4']) ?? args.collateralIn ?? args.arg2 ?? 0;
    const shareAmount = firstPresentValue(trade, ['shareAmount', 'shares', 'arg5']) ?? args.sharesIn ?? args.arg2 ?? 0;
    const feeAmount = firstPresentValue(trade, ['feeAmount', 'fee', 'arg6']) ?? 0;
    const collateralRaw = codecToBigInt(collateralAmount);
    const sharesRaw = codecToBigInt(shareAmount);

    return {
      data: {
        marketId,
        side: firstString(trade, ['side', 'arg2']) || token,
        outcome: firstString(trade, ['outcome', 'arg3']) || firstString(args, ['outcome', 'arg1']),
        collateralUsd: codecToDecimalString(collateralAmount, DECIMALS),
        collateralAmountUsd: codecToDecimalString(collateralAmount, DECIMALS),
        shares: codecToDecimalString(shareAmount, DECIMALS),
        sharesAmount: codecToDecimalString(shareAmount, DECIMALS),
        price: decimalToString(scaledDiv(collateralRaw, sharesRaw), DECIMALS, 8),
        executionPrice: decimalToString(scaledDiv(collateralRaw, sharesRaw), DECIMALS, 8),
        feeUsd: codecToDecimalString(feeAmount, DECIMALS),
        feeAmountUsd: codecToDecimalString(feeAmount, DECIMALS),
      },
      from: trader,
      to: '',
      assets: [],
    };
  }

  if (token === 'claimmarket') {
    const claim = findEvent(events, 'polkamarkt', 'MarketClaimed');
    if (!claim) return null;
    const trader = firstString(claim, ['trader', 'account', 'arg1']) || signer;
    const payout = firstPresentValue(claim, ['payout', 'amount', 'arg2']) ?? 0;

    return {
      data: {
        marketId: Number(claim.marketId ?? claim.arg0 ?? args.marketId ?? args.arg0 ?? 0),
        side: 'claim',
        collateralUsd: codecToDecimalString(payout, DECIMALS),
        collateralAmountUsd: codecToDecimalString(payout, DECIMALS),
      },
      from: trader,
      to: '',
      assets: [],
    };
  }

  if (token === 'claimmarkets') {
    const claims = findEvents(events, 'polkamarkt', 'MarketClaimed');
    const batch = findEvent(events, 'polkamarkt', 'MarketClaimsBatched');
    if (!claims.length) return null;
    const batchTrader = firstString(batch ?? {}, ['trader', 'account', 'arg0', 'arg1']);
    const claimTraders = claims.map((claim) => firstString(claim, ['trader', 'account', 'arg1'])).filter(Boolean);
    const uniqueTraders = new Set([batchTrader, ...claimTraders].filter(Boolean));
    if (uniqueTraders.size > 1) return null;
    const trader = batchTrader || claimTraders[0] || signer;
    const payout = claims.reduce((sum, claim) => sum + codecToBigInt(firstPresentValue(claim, ['payout', 'amount', 'arg2']) ?? 0), 0n);

    return {
      data: {
        marketId: Number(claims[0]?.marketId ?? claims[0]?.arg0 ?? 0) || null,
        side: 'claim',
        claimedMarkets: claims.length,
        requestedMarkets: Number(batch?.requested ?? batch?.arg1 ?? 0) || claims.length,
        collateralUsd: codecToDecimalString(payout, DECIMALS),
        collateralAmountUsd: codecToDecimalString(payout, DECIMALS),
      },
      from: trader,
      to: '',
      assets: [],
    };
  }

  if (token === 'claimcreatorfees') {
    const claim = findEvent(events, 'polkamarkt', 'CreatorFeesClaimed');
    if (!claim) return null;
    const creator = firstString(claim, ['creator', 'account', 'arg1']) || signer;
    const amount = firstPresentValue(claim, ['amount', 'arg2']) ?? 0;

    return {
      data: {
        marketId: Number(claim.marketId ?? claim.arg0 ?? args.marketId ?? args.arg0 ?? 0),
        side: 'claim_creator_fees',
        collateralUsd: codecToDecimalString(amount, DECIMALS),
        collateralAmountUsd: codecToDecimalString(amount, DECIMALS),
      },
      from: creator,
      to: '',
      assets: [],
    };
  }

  return null;
};

const bridgeRequestUpdate = (events: EventRecord[]): { requestHash: string; status: string } => {
  const event = findEvent(events, 'bridgeProxy', 'RequestStatusUpdate') ?? {};

  return {
    requestHash: firstNestedString(event, ['requestHash', 'hash', 'arg0']),
    status: firstNestedString(event, ['status', 'arg1']),
  };
};

type AssetMovement = {
  assetId: string;
  amount: unknown;
  recipient: string;
  sender: string;
};

const assetMovementFromEvent = (record: EventRecord): AssetMovement | null => {
  const { event } = record;
  const data = eventData(event);

  if (event.section === 'assets') {
    if (event.method === 'Transfer') {
      return {
        assetId: firstString(data, ['assetId', 'currencyId', 'arg0']),
        sender: firstString(data, ['from', 'source', 'arg1']),
        recipient: firstString(data, ['to', 'dest', 'recipient', 'arg2']),
        amount: data.amount ?? data.arg3 ?? '0',
      };
    }

    if (['Issued', 'Minted', 'Deposited'].includes(event.method)) {
      return {
        assetId: firstString(data, ['assetId', 'currencyId', 'arg0']),
        sender: '',
        recipient: firstString(data, ['owner', 'who', 'account', 'accountId', 'to', 'recipient', 'arg1']),
        amount: data.amount ?? data.arg2 ?? '0',
      };
    }
  }

  if (event.section === 'tokens') {
    if (event.method === 'Transfer') {
      return {
        assetId: firstString(data, ['currencyId', 'assetId', 'arg0']),
        sender: firstString(data, ['from', 'source', 'arg1']),
        recipient: firstString(data, ['to', 'dest', 'recipient', 'arg2']),
        amount: data.amount ?? data.arg3 ?? '0',
      };
    }

    if (['Deposited', 'Endowed'].includes(event.method)) {
      return {
        assetId: firstString(data, ['currencyId', 'assetId', 'arg0']),
        sender: '',
        recipient: firstString(data, ['who', 'account', 'accountId', 'to', 'recipient', 'arg1']),
        amount: data.amount ?? data.arg2 ?? '0',
      };
    }
  }

  if (event.section === 'balances') {
    if (event.method === 'Transfer') {
      return {
        assetId: XOR,
        sender: firstString(data, ['from', 'source', 'arg0']),
        recipient: firstString(data, ['to', 'dest', 'recipient', 'arg1']),
        amount: data.amount ?? data.arg2 ?? '0',
      };
    }

    if (['Deposited', 'Endowed'].includes(event.method)) {
      return {
        assetId: XOR,
        sender: '',
        recipient: firstString(data, ['who', 'account', 'accountId', 'to', 'recipient', 'arg0']),
        amount: data.amount ?? data.arg1 ?? '0',
      };
    }
  }

  return null;
};

const FailedBridgeRequestStatuses = new Set(['Failed', 'Refunded']);
const CompletedBridgeRequestStatus = 'Done';

/** Finds the asset movement that belongs to an inbound bridge request, scoped by decoded message hints when present. */
const findIncomingBridgeMovement = (events: EventRecord[], expectedRecipient = '', expectedAssetId = ''): AssetMovement | null => {
  for (const event of events) {
    const movement = assetMovementFromEvent(event);
    if (!movement?.assetId || !movement.recipient || movement.amount === undefined || movement.amount === null) continue;
    if (expectedRecipient && movement.recipient !== expectedRecipient) continue;
    if (expectedAssetId && movement.assetId !== expectedAssetId) continue;

    try {
      if (codecToBigInt(movement.amount) > 0n) return movement;
    } catch {
      continue;
    }
  }

  return null;
};

const groupEventsByExtrinsic = (events: EventRecord[]): Map<number, EventRecord[]> => {
  const grouped = new Map<number, EventRecord[]>();

  for (const event of events) {
    if (!event.phase.isApplyExtrinsic) continue;

    const extrinsicIndex = event.phase.asApplyExtrinsic.toNumber();
    const group = grouped.get(extrinsicIndex);
    if (group) {
      group.push(event);
    } else {
      grouped.set(extrinsicIndex, [event]);
    }
  }

  return grouped;
};

const createHistoryData = (
  module: string,
  method: string,
  args: Record<string, unknown>,
  events: EventRecord[],
  signer: string,
  prices: Map<string, bigint>,
  assets: Map<string, AssetInfo>
): { data: unknown; from: string; to: string; assets: string[] } => {
  const result = {
    data: args as unknown,
    from: signer,
    to: '',
    assets: collectAssets(args),
  };

  if (module === 'assets' && method === 'transfer') {
    const assetId = firstString(args, ['assetId']);
    const to = firstString(args, ['to', 'dest']);
    return {
      data: { ...createAmountData(assetId, args.amount, prices, assets), from: signer, to },
      from: signer,
      to,
      assets: [assetId],
    };
  }

  if (module === 'assets' && (method === 'burn' || method === 'mint')) {
    const assetId = firstString(args, ['assetId']);
    const to = firstString(args, ['to']);
    return {
      data: { ...createAmountData(assetId, args.amount, prices, assets), ...(to ? { to } : {}) },
      from: signer,
      to,
      assets: [assetId],
    };
  }

  if (module === 'assets' && method === 'register') {
    const registered = findEvent(events, 'assets', 'AssetRegistered');
    const assetId = firstString(registered ?? args, ['assetId', 'arg0']);
    return { data: { assetId }, from: signer, to: '', assets: assetId ? [assetId] : [] };
  }

  if (module === 'polkamarkt') {
    const polkamarkt = createPolkamarktHistoryData(method, args, events, signer);
    if (polkamarkt) return polkamarkt;
  }

  if (module === 'poolXYK' && (method === 'depositLiquidity' || method === 'withdrawLiquidity')) {
    const baseAssetId = firstString(args, ['baseAssetId', 'inputAssetA', 'inputA', 'assetA']);
    const targetAssetId = firstString(args, ['targetAssetId', 'inputAssetB', 'inputB', 'assetB']);
    const baseAmount = args.baseAssetAmount ?? args.baseAssetDesired ?? args.inputADesired ?? args.inputA ?? args.amountA ?? '0';
    const targetAmount = args.targetAssetAmount ?? args.targetAssetDesired ?? args.inputBDesired ?? args.inputB ?? args.amountB ?? '0';

    return {
      data: {
        baseAssetId,
        targetAssetId,
        baseAssetAmount: codecToDecimalString(baseAmount, assets.get(baseAssetId)?.decimals ?? DECIMALS),
        targetAssetAmount: codecToDecimalString(targetAmount, assets.get(targetAssetId)?.decimals ?? DECIMALS),
        baseAssetAmountUSD: codecUsd(baseAssetId, codecToBigInt(baseAmount), prices, assets.get(baseAssetId)?.decimals ?? DECIMALS),
        targetAssetAmountUSD: codecUsd(
          targetAssetId,
          codecToBigInt(targetAmount),
          prices,
          assets.get(targetAssetId)?.decimals ?? DECIMALS
        ),
        type: method === 'depositLiquidity' ? 'Deposit' : 'Withdraw',
      },
      from: signer,
      to: '',
      assets: [baseAssetId, targetAssetId].filter(Boolean),
    };
  }

  if (module === 'liquidityProxy' && (method === 'swap' || method === 'swapTransfer')) {
    const exchange = findEvent(events, 'liquidityProxy', 'Exchange') ?? {};
    const baseAssetId =
      firstString(args, ['inputAssetId', 'baseAssetId', 'assetId']) ||
      firstString(exchange, ['inputAssetId', 'baseAssetId', 'arg2']);
    const targetAssetId =
      firstString(args, ['outputAssetId', 'targetAssetId']) ||
      firstString(exchange, ['outputAssetId', 'targetAssetId', 'arg3']);
    const baseAmount =
      firstPresentValue(exchange, ['inputAmount', 'baseAssetAmount', 'arg4']) ?? swapInputAmountFromArgs(args) ?? '0';
    const targetAmount =
      firstPresentValue(exchange, ['outputAmount', 'targetAssetAmount', 'arg5']) ?? swapOutputAmountFromArgs(args) ?? '0';
    const to = firstString(args, ['receiver', 'to']);

    return {
      data: {
        baseAssetId,
        targetAssetId,
        selectedMarket: firstString(args, ['selectedSourceType', 'selectedMarket']) || 'PoolXYK',
        baseAssetAmount: codecToDecimalString(baseAmount, assets.get(baseAssetId)?.decimals ?? DECIMALS),
        targetAssetAmount: codecToDecimalString(targetAmount, assets.get(targetAssetId)?.decimals ?? DECIMALS),
        baseAssetAmountUSD: codecUsd(baseAssetId, codecToBigInt(baseAmount), prices, assets.get(baseAssetId)?.decimals ?? DECIMALS),
        targetAssetAmountUSD: codecUsd(
          targetAssetId,
          codecToBigInt(targetAmount),
          prices,
          assets.get(targetAssetId)?.decimals ?? DECIMALS
        ),
        ...(to ? { to } : {}),
      },
      from: signer,
      to,
      assets: [baseAssetId, targetAssetId].filter(Boolean),
    };
  }

  if (module === 'orderBook' && method === 'placeLimitOrder') {
    const orderBookId = parseOrderBookId(args.orderBookId);
    const event = findEvent(events, 'orderBook', 'LimitOrderPlaced') ?? {};
    const orderId = Number(event.orderId ?? args.orderId ?? 0);
    const side = String(args.side ?? event.side ?? 'Buy');
    const amount = codecToBigInt(args.amount);
    const price = codecToBigInt(args.price);

    return {
      data: {
        dexId: orderBookId.dexId,
        baseAssetId: orderBookId.baseAssetId,
        quoteAssetId: orderBookId.quoteAssetId,
        orderId,
        price: codecToDecimalString(args.price, DECIMALS),
        amount: codecToDecimalString(args.amount, assets.get(orderBookId.baseAssetId)?.decimals ?? DECIMALS),
        amountUSD: orderBookAmountUsd(
          orderBookId.baseAssetId,
          orderBookId.quoteAssetId,
          amount,
          price,
          side,
          prices,
          assets
        ),
        side,
        lifetime: Number(args.lifetime ?? 0),
      },
      from: signer,
      to: '',
      assets: [orderBookId.baseAssetId, orderBookId.quoteAssetId].filter(Boolean),
    };
  }

  if (module === 'orderBook' && (method === 'cancelLimitOrder' || method === 'cancelLimitOrdersBatch')) {
    const orderBookId = parseOrderBookId(args.orderBookId);
    const orderIds = Array.isArray(args.orderIds) ? args.orderIds : [args.orderId];
    return {
      data: orderIds.map((orderId) => ({ ...orderBookId, orderId: Number(orderId ?? 0) })),
      from: signer,
      to: '',
      assets: [orderBookId.baseAssetId, orderBookId.quoteAssetId].filter(Boolean),
    };
  }

  if (module === 'staking') {
    return {
      data: normalizeStakingData(method, args, prices),
      from: signer,
      to: '',
      assets: [XOR],
    };
  }

  if (module === 'kensetsu') {
    const cdp = findEvent(events, 'kensetsu', 'CDPCreated') ?? findEvent(events, 'kensetsu', 'CDPClosed') ?? {};
    const collateralAssetId = firstString(args, ['collateralAssetId']) || firstString(cdp, ['collateralAssetId']);
    const debtAssetId = firstString(args, ['stablecoinAssetId', 'debtAssetId']) || firstString(cdp, ['stablecoinAssetId']);
    const collateralAmount = args.collateralAmount ?? args.amount ?? cdp.collateralAmount ?? '0';
    const debtAmount = args.debt ?? args.debtAmount ?? cdp.debt ?? '0';

    return {
      data: {
        id: String(cdp.cdpId ?? cdp.id ?? args.cdpId ?? args.id ?? ''),
        collateralAssetId,
        debtAssetId,
        collateralAmount: codecToDecimalString(collateralAmount, assets.get(collateralAssetId)?.decimals ?? DECIMALS),
        debtAmount: codecToDecimalString(debtAmount, assets.get(debtAssetId)?.decimals ?? DECIMALS),
        collateralAmountUSD: codecUsd(
          collateralAssetId,
          codecToBigInt(collateralAmount),
          prices,
          assets.get(collateralAssetId)?.decimals ?? DECIMALS
        ),
        debtAmountUSD: codecUsd(debtAssetId, codecToBigInt(debtAmount), prices, assets.get(debtAssetId)?.decimals ?? DECIMALS),
      },
      from: signer,
      to: '',
      assets: [collateralAssetId, debtAssetId].filter(Boolean),
    };
  }

  if (module === 'ethBridge' && method === 'transferToSidechain') {
    const assetId = firstString(args, ['assetId']);
    const { requestHash, status } = bridgeRequestUpdate(events);
    return {
      data: {
        ...createAmountData(assetId, args.amount, prices, assets),
        sidechainAddress: firstString(args, ['to', 'sidechainAddress']),
        ...(requestHash ? { requestHash } : {}),
        ...(status ? { status } : {}),
      },
      from: signer,
      to: firstString(args, ['to', 'sidechainAddress']),
      assets: [assetId],
    };
  }

  if (module === 'bridgeMultisig') {
    const movement = findIncomingBridgeMovement(events);

    if (movement) {
      return {
        data: {
          ...args,
          ...createAmountData(movement.assetId, movement.amount, prices, assets),
          to: movement.recipient,
        },
        from: movement.sender || signer,
        to: movement.recipient,
        assets: [movement.assetId],
      };
    }
  }

  if (module === 'bridgeProxy' && (method === 'burn' || method === 'mint')) {
    const assetId = firstString(args, ['assetId']);
    const amount = args.amount ?? args.value ?? '0';
    const networkId = firstNestedString(args, ['networkId', 'network', 'arg0']);
    const recipient = firstNestedString(args, ['recipient', 'to', 'dest', 'account', 'arg2']);
    const sender = firstNestedString(args, ['sender', 'from', 'source']);
    const { requestHash, status } = bridgeRequestUpdate(events);

    if (method === 'burn') {
      return {
        data: {
          ...createAmountData(assetId, amount, prices, assets),
          ...bridgeNetworkData(networkId),
          ...(recipient ? { recipient } : {}),
          ...(requestHash ? { requestHash } : {}),
          ...(status ? { status } : {}),
        },
        from: signer,
        to: recipient,
        assets: [assetId],
      };
    }

    return {
      data: {
        ...createAmountData(assetId, amount, prices, assets),
        ...bridgeNetworkData(networkId),
        ...(recipient ? { recipient } : {}),
        ...(sender ? { sender } : {}),
        ...(requestHash ? { requestHash } : {}),
        ...(status ? { status } : {}),
      },
      from: recipient || signer,
      to: sender,
      assets: [assetId],
    };
  }

  return result;
};

const createBridgeProxyIncomingContext = (
  base: Pick<BlockExtrinsicContext, 'id' | 'module' | 'method' | 'address' | 'failed' | 'calls' | 'callNames' | 'events' | 'fee'>,
  args: Record<string, unknown>,
  prices: Map<string, bigint>,
  assets: Map<string, AssetInfo>
): BlockExtrinsicContext | null => {
  if (base.failed) return null;
  if (base.module === 'bridgeProxy' && base.method === 'burn') return null;

  const request = bridgeRequestUpdate(base.events);
  if (!request.requestHash) return null;
  if (FailedBridgeRequestStatuses.has(request.status) || request.status !== CompletedBridgeRequestStatus) return null;

  const message = args.message && typeof args.message === 'object' && !Array.isArray(args.message) ? (args.message as Record<string, unknown>) : args;
  const networkId = firstNestedString(args, ['networkId', 'network', 'arg0']);
  if (!bridgeNetworkType(networkId)) return null;

  const expectedRecipient = firstNestedString(message, ['dest', 'recipient', 'to', 'account']);
  const sender = firstNestedString(message, ['source', 'sender', 'from']);
  const expectedAssetId = firstNestedString(message, ['assetId', 'asset', 'currencyId', 'token']);
  if (!expectedRecipient || !sender) return null;

  const movement = findIncomingBridgeMovement(base.events, expectedRecipient, expectedAssetId);
  if (!movement) return null;

  const recipient = expectedRecipient || movement.recipient;
  const history = {
    data: {
      ...createAmountData(movement.assetId, movement.amount, prices, assets),
      ...bridgeNetworkData(networkId),
      recipient,
      ...(sender ? { sender } : {}),
      requestHash: request.requestHash,
      ...(request.status ? { status: request.status } : {}),
    },
    from: recipient,
    to: sender,
    assets: [movement.assetId],
  };

  return {
    ...base,
    id: `${request.requestHash}-mint`,
    module: 'bridgeProxy',
    method: 'mint',
    history,
    accounts:
      bridgeNetworkType(networkId) === 'Sub'
        ? historyIndexedAccounts('bridgeProxy', 'mint', base.address, history)
        : uniqueIndexedAccountIds([recipient, sender]),
  };
};

const normalizeStakingData = (method: string, args: Record<string, unknown>, prices: Map<string, bigint>) => {
  const amount = args.value ?? args.maxAdditional ?? args.amount ?? '0';
  const amountData = {
    amount: codecToDecimalString(amount, DECIMALS),
    amountUSD: codecUsd(XOR, codecToBigInt(amount), prices, DECIMALS),
  };

  if (method === 'bond') return { ...amountData, controller: firstString(args, ['controller']), payee: args.payee ?? {} };
  if (method === 'bondExtra') return amountData;
  if (method === 'unbond') return { amount: String(amount), amountUSD: amountData.amountUSD };
  if (method === 'rebond') return { value: amountData.amount, amountUSD: amountData.amountUSD };
  if (method === 'nominate') return { targets: Array.isArray(args.targets) ? args.targets : [] };
  if (method === 'withdrawUnbonded') return { ...amountData, numSlashingSpans: Number(args.numSlashingSpans ?? 0) };
  if (method === 'setPayee') return { payeeType: args.payee, payee: String(args.payee ?? '') };
  if (method === 'setController') return { controller: firstString(args, ['controller']) };
  if (method === 'payoutStakers') return { validatorStash: firstString(args, ['validatorStash']), era: Number(args.era ?? 0) };
  return {};
};

const parseOrderBookId = (value: unknown): { dexId: number; baseAssetId: string; quoteAssetId: string } => {
  const json = normalizeValue(value);
  if (json && typeof json === 'object') {
    const record = json as Record<string, unknown>;
    return {
      dexId: Number(record.dexId ?? 0),
      baseAssetId: assetIdToString(record.base),
      quoteAssetId: assetIdToString(record.quote),
    };
  }

  const [dexId = '0', baseAssetId = '', quoteAssetId = ''] = String(json ?? '').split('-');
  return { dexId: Number(dexId), baseAssetId, quoteAssetId };
};

const orderBookIdString = ({ dexId, baseAssetId, quoteAssetId }: { dexId: number; baseAssetId: string; quoteAssetId: string }) =>
  `${dexId}-${baseAssetId}-${quoteAssetId}`;

const snapshotBucket = (type: string, timestamp: number, blockHeight = 0): number => {
  if (type === 'BLOCK') return blockHeight || timestamp;

  const seconds = SNAPSHOT_WINDOW_SECONDS[type as SnapshotTypeName] ?? SNAPSHOT_WINDOW_SECONDS.DEFAULT;
  return Math.floor(timestamp / seconds) * seconds;
};

const snapshotId = (prefix: string, id: string, type: string, timestamp: number, blockHeight = 0): string =>
  `${prefix}-${id}-${type}-${snapshotBucket(type, timestamp, blockHeight)}`;

const accountTransactionId = (historyElementId: string, account: string): string => `${historyElementId}-${account}`;

const emptyPriceOhlc = (price: string): PriceOhlc => ({ open: price, high: price, low: price, close: price });

const snapshotDocumentTimestamp = (document: IndexerDocument): number => {
  const timestamp = Number(document.timestamp ?? document.data.timestamp ?? 0);
  return Number.isFinite(timestamp) ? timestamp : 0;
};

const priceOhlcValues = (price: unknown): bigint[] | null => {
  if (!price || typeof price !== 'object') return null;

  const record = price as Record<string, unknown>;
  const values = ['open', 'high', 'low', 'close'].map((field) => positiveDecimalStringToScaled(record[field]));

  return values.every((value): value is bigint => value !== null) ? values : null;
};

const priceOhlcClose = (price: unknown): bigint | null => {
  if (!price || typeof price !== 'object') return null;
  return positiveDecimalStringToScaled((price as Record<string, unknown>).close);
};

const medianBigInt = (values: bigint[]): bigint => {
  if (!values.length) return 0n;

  const sorted = [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return sorted[Math.floor(sorted.length / 2)] ?? 0n;
};

const isPriceOutlierAgainstBaseline = (value: bigint, baseline: bigint): boolean =>
  baseline > 0n && (value > baseline * ASSET_PRICE_OUTLIER_RATIO || baseline > value * ASSET_PRICE_OUTLIER_RATIO);

const snapshotVolumeUsd = (document: IndexerDocument): bigint => {
  const volume = document.data.volume;
  if (!volume || typeof volume !== 'object') return 0n;

  return positiveDecimalStringToScaled((volume as Record<string, unknown>).amountUSD) ?? 0n;
};

const isAssetSnapshotPriceOutlier = (document: IndexerDocument, group: IndexerDocument[]): boolean => {
  if (snapshotVolumeUsd(document) !== 0n) return false;

  const values = priceOhlcValues(document.data.priceUSD);
  if (!values) return false;

  const timestamp = snapshotDocumentTimestamp(document);
  const nearbyCloses = group
    .filter(
      (candidate) =>
        candidate.id !== document.id &&
        Math.abs(snapshotDocumentTimestamp(candidate) - timestamp) <= ASSET_PRICE_OUTLIER_NEIGHBOR_WINDOW_SECONDS
    )
    .map((candidate) => priceOhlcClose(candidate.data.priceUSD))
    .filter((value): value is bigint => value !== null);

  if (nearbyCloses.length < ASSET_PRICE_OUTLIER_MIN_NEIGHBORS) return false;

  const baseline = medianBigInt(nearbyCloses);
  return values.some((value) => isPriceOutlierAgainstBaseline(value, baseline));
};

const minDecimalString = (left: string, right: string): string => (decimalStringToScaled(left) <= decimalStringToScaled(right) ? left : right);

const maxDecimalString = (left: string, right: string): string => (decimalStringToScaled(left) >= decimalStringToScaled(right) ? left : right);

const mergePriceOhlc = (previous: unknown, currentPrice: string): PriceOhlc => {
  if (!previous || typeof previous !== 'object') return emptyPriceOhlc(currentPrice);

  const record = previous as Record<string, unknown>;
  const open = String(record.open ?? currentPrice);
  const high = maxDecimalString(String(record.high ?? open), currentPrice);
  const low = minDecimalString(String(record.low ?? open), currentPrice);

  return { open, high, low, close: currentPrice };
};

const percentChange = (openPrice: string, closePrice: string): string => {
  const open = decimalStringToScaled(openPrice);
  if (open === 0n) return '0';

  const close = decimalStringToScaled(closePrice);
  return scaledToString(scaledDiv(close - open, open) * 100n, 18);
};

const addDecimalStrings = (left: unknown, right: unknown, precision = 18): string =>
  scaledToString(decimalStringToScaled(left) + decimalStringToScaled(right), precision);

const poolIdForAssets = (baseAssetId: string, targetAssetId: string): string =>
  baseAssetId && targetAssetId ? `${baseAssetId}-${targetAssetId}` : '';

const getTypeMap = <T>(map: Map<string, Map<SnapshotTypeName, T>>, id: string): Map<SnapshotTypeName, T> => {
  const current = map.get(id);
  if (current) return current;

  const created = new Map<SnapshotTypeName, T>();
  map.set(id, created);
  return created;
};

const getAggregate = <T>(
  map: Map<string, Map<SnapshotTypeName, T>>,
  id: string,
  type: SnapshotTypeName,
  create: () => T
): T => {
  const byType = getTypeMap(map, id);
  const current = byType.get(type);
  if (current) return current;

  const created = create();
  byType.set(type, created);
  return created;
};

const newAssetAggregate = (priceUSD: string): AssetAggregate => ({
  volumeAmount: 0n,
  volumeUSD: 0n,
  mint: 0n,
  burn: 0n,
  priceUSD: emptyPriceOhlc(priceUSD),
});

const newPoolAggregate = (priceUSD: string): PoolAggregate => ({
  baseAssetVolume: 0n,
  targetAssetVolume: 0n,
  chameleonAssetVolume: 0n,
  volumeUSD: 0n,
  priceUSD: emptyPriceOhlc(priceUSD),
});

const newOrderBookAggregate = (price: string): OrderBookAggregate => ({
  baseAssetVolume: 0n,
  quoteAssetVolume: 0n,
  volumeUSD: 0n,
  liquidityUSD: 0n,
  price: emptyPriceOhlc(price),
  lastDeals: [],
});

const emptyNetworkLiquidityStats = (): NetworkLiquidityStats => ({
  liquidityUSD: '0',
  poolLiquidityUSD: '0',
  orderBookLiquidityUSD: '0',
  activePools: 0,
  activeOrderBooks: 0,
  listedAssets: 0,
});

const createNetworkLiquidityStats = (
  poolLiquidityUSD: string,
  orderBookLiquidityUSD: string,
  activePools: number,
  activeOrderBooks: number,
  listedAssets: number
): NetworkLiquidityStats => {
  const totalLiquidityUSD = scaledToString(
    decimalStringToScaled(poolLiquidityUSD) + decimalStringToScaled(orderBookLiquidityUSD),
    8
  );

  return {
    liquidityUSD: totalLiquidityUSD,
    poolLiquidityUSD,
    orderBookLiquidityUSD,
    activePools,
    activeOrderBooks,
    listedAssets,
  };
};

/** Sums exact scaled values before display rounding so dust pools are not lost per row. */
export const summarizeExactPoolLiquidity = (
  liquidities: Iterable<bigint>
): { poolLiquidityUSD: string; activePools: number } => {
  let total = 0n;
  let activePools = 0;
  for (const liquidity of liquidities) {
    total += liquidity;
    if (liquidity > 0n) activePools += 1;
  }
  return { poolLiquidityUSD: scaledToString(total, 8), activePools };
};

const newNetworkAggregate = (accounts = 0, liquidityStats = emptyNetworkLiquidityStats()): NetworkAggregate => ({
  ...liquidityStats,
  accounts,
  transactions: 0,
  fees: 0n,
  volumeUSD: 0n,
  swaps: 0,
  bridgeIncomingTransactions: 0,
  bridgeOutgoingTransactions: 0,
});

const emptyAnalytics = (): Analytics => ({
  assets: new Map(),
  pools: new Map(),
  orderBooks: new Map(),
  network: new Map(),
  assetDayVolumeUSD: new Map(),
  assetWeekVolumeUSD: new Map(),
  assetDayOpenPrice: new Map(),
  assetWeekOpenPrice: new Map(),
  assetOrderBookLiquidity: new Map(),
  poolDayVolumeUSD: new Map(),
  orderBookDayVolumeUSD: new Map(),
  orderBookDayOpenPrice: new Map(),
  orderBookActiveReserves: new Map(),
});

const isPolkamarktTradeContext = (context: BlockExtrinsicContext): boolean => {
  if (context.failed) return false;

  const method = context.method.toLowerCase();
  return (
    (context.module === 'polkamarkt' && (method.includes('buy') || method.includes('sell'))) ||
    context.callNames.some((callName) => /^polkamarkt\.(buy|sell)/i.test(callName)) ||
    context.events.some(
      ({ event }) => event.section === 'polkamarkt' && event.method === 'TradeExecuted'
    )
  );
};

export class ChainIndexer {
  private readonly config: AppConfig;
  private api: ApiPromise | null = null;
  private primaryProvider: WsProvider | null = null;
  private observedGenesisHash: string | null = null;
  private legacyBlockApi: ApiPromise | null = null;
  private legacyBlockProvider: WsProvider | null = null;
  private legacyBlockApiPromise: Promise<ApiPromise> | null = null;
  private unsubscribeFinalizedHeads: (() => void | Promise<void>) | null = null;
  private lifecycleState: ChainIndexerLifecycle = 'idle';
  private startupComplete = false;
  private latestFinalizedBlock: number | null = null;
  private latestIndexedBlock: number | null = null;
  private lastSuccessfulIndexTimestamp: number | null = null;
  private lastError: string | null = null;
  private lastErrorTimestamp: number | null = null;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private readonly backgroundTasks = new Set<Promise<void>>();
  private readonly disconnectedResources = new WeakSet<object>();
  private readonly outstandingRpcRequests = new Set<Promise<unknown>>();
  private readonly lateRpcDisposals = new Set<Promise<void>>();
  private readonly rpcTimeoutCancellations = new Set<() => void>();
  private workerStatusHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private workerStatusWritePromise: Promise<void> | null = null;
  private pendingWorkerStatusDocument: IndexerDocument | null = null;
  private repositoryStatusWritesEnabled = false;
  private assetInfos = new Map<string, AssetInfo>();
  private assetInfosBlockHeight = -1;
  private prices = new Map<string, bigint>();
  private pricesBlockHeight = -1;
  private networkLiquidityStats = emptyNetworkLiquidityStats();
  private networkLiquidityStatsBlockHeight = -1;
  private liveValuationState: HistoricalValuationState | null = null;
  private pendingFinalizedBlock = 0;
  private finalizedHeadDrainRunning = false;
  private finalizedHeadRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private finalizedHeadPollTimer: ReturnType<typeof setInterval> | null = null;
  private finalizedHeadPollRunning = false;
  private finalizedHeadRpcUpdateRunning = false;
  private finalizedHeadRpcUpdateQueued = false;
  private derivedStateRefreshRunning = false;
  private priceStreamRefreshRunning = false;
  private polkamarktStateRefreshRunning = false;
  private bridgeProxyHistoryRuntimeAvailable = false;
  private derivedStateRefreshRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private priceStreamRefreshRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private polkamarktStateRefreshRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingDerivedStateRefresh: DerivedStateRefreshRequest | null = null;
  private pendingPriceStreamRefresh: PriceStreamRefreshRequest | null = null;
  private pendingPolkamarktStateRefresh: DerivedStateRefreshRequest | null = null;
  private xorBurnBackfillRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private xorBurnBackfillRunning = false;
  private xorBurnBackfillTargetBlock = 0;
  private readonly archiveSoraWsEndpoint: string;
  private readonly enforceFinalizedIdentity: boolean;
  private analyticsInputCache: AnalyticsInputCache | null = null;
  private analyticsInputCacheBytes = 0;
  private analyticsInputCacheGeneration = 0;
  private readonly analyticsInputCacheMetrics: AnalyticsInputCacheMetrics = {
    fullLoads: 0,
    incrementalLoads: 0,
    invalidations: 0,
    documentsRead: 0,
    evictions: 0,
    evictedBytes: 0,
    capacityBypasses: 0,
    capacityBypassedBytes: 0,
  };
  private rollingNetworkInputCache: RollingNetworkInputCache | null = null;
  private readonly rollingNetworkInputMetrics: RollingNetworkInputMetrics = {
    fullBuilds: 0,
    incrementalUpdates: 0,
    blockDocumentsProcessed: 0,
  };
  private readonly derivedStorageCache = new Map<DerivedStorageDomain, DerivedStorageCacheEntry>();
  private readonly derivedStorageCacheByteSizes = new Map<DerivedStorageDomain, number>();
  private derivedStorageCacheBytes = 0;
  private readonly derivedStorageDomainLoads = new Map<
    DerivedStorageDomain,
    { generation: number; blockHeight: number; promise: Promise<DerivedStorageLoadResult<unknown>> }
  >();
  private activeDerivedStorageLoadBudget: DerivedStorageRetainedLoadBudget | null = null;
  private readonly dirtyDerivedStorageDomains = new Set<DerivedStorageDomain>(DERIVED_STORAGE_DOMAINS);
  private readonly derivedStorageDomainGenerations = new Map<DerivedStorageDomain, number>();
  private lastDerivedStorageReconciliationBlock: number | null = null;
  private chartSnapshotRetentionQueue: Promise<void> = Promise.resolve();
  private projectionRefreshQueue: Promise<void> = Promise.resolve();
  private highestCompletedProjectionBlock = -1;
  private readonly pendingAuthoritativeReconciliations = new Map<
    IndexerCollection,
    { activeIds: Set<string>; blockHeight: number }
  >();
  private readonly derivedStorageCacheMetrics = {
    loads: 0,
    hits: 0,
    coalescedLoads: 0,
    dirtyMarks: 0,
    reconciliations: 0,
    capacityEvictions: 0,
    capacityEvictedBytes: 0,
    capacityBypasses: 0,
    capacityBypassedBytes: 0,
  };

  constructor(config: ChainIndexerConfig, private readonly repository: IndexerRepository) {
    const archiveSoraWsEndpoint =
      config.soraArchiveWsEndpoint ??
      config.archiveSoraWsEndpoint ??
      process.env.SORA_ARCHIVE_WS_ENDPOINT?.trim() ??
      '';
    this.config = {
      fullReconciliationIntervalBlocks: 250,
      chainShutdownTimeoutMs: CHAIN_DISCONNECT_TIMEOUT_MS,
      chainRpcTimeoutMs: CHAIN_RPC_TIMEOUT_MS,
      chainRpcMaxInFlight: 256,
      derivedStorageLoadMaxBytes: 268_435_456,
      derivedStorageCacheMaxBytes: 67_108_864,
      analyticsInputCacheMaxBytes: 134_217_728,
      backfillPrefetchConcurrency: 1,
      finalizedCatchupPrefetchConcurrency: 1,
      priceStreamRefreshIntervalBlocks: 0,
      legacySoraBlockTypes: false,
      ...config,
      soraArchiveWsEndpoint: archiveSoraWsEndpoint || null,
      archiveSoraWsEndpoint,
    } as AppConfig;
    this.archiveSoraWsEndpoint = archiveSoraWsEndpoint;
    this.enforceFinalizedIdentity =
      process.env.NODE_ENV === 'production' ||
      (Object.prototype.hasOwnProperty.call(config, 'soraArchiveWsEndpoint') &&
        config.chainRpcTimeoutMs === undefined);
    if (process.env.NODE_ENV === 'production') {
      if (!this.archiveSoraWsEndpoint) {
        throw new Error('SORA_ARCHIVE_WS_ENDPOINT is required for the production worker.');
      }
      assertIndependentSoraRpcEndpoints(this.config.soraWsEndpoint, this.archiveSoraWsEndpoint);
    }
    this.publishStatusMetrics();
  }

  getStatus(): ChainIndexerStatus {
    return {
      lifecycle: this.lifecycleState,
      startupComplete: this.startupComplete,
      latestFinalizedBlock: this.latestFinalizedBlock,
      latestIndexedBlock: this.latestIndexedBlock,
      lag: chainIndexerLag(this.latestFinalizedBlock, this.latestIndexedBlock),
      lastSuccessfulIndexTimestamp: this.lastSuccessfulIndexTimestamp,
      lastError: this.lastError,
      lastErrorTimestamp: this.lastErrorTimestamp,
    };
  }

  private publishStatusMetrics(): void {
    publishChainIndexerStatusMetrics(this.getStatus());
  }

  private setLifecycle(lifecycle: ChainIndexerLifecycle, startupComplete = this.startupComplete): void {
    this.lifecycleState = lifecycle;
    this.startupComplete = startupComplete;
    this.publishStatusMetrics();
  }

  private updateFinalizedStatus(block: number): void {
    if (!Number.isSafeInteger(block) || block < 0) return;
    this.latestFinalizedBlock = Math.max(this.latestFinalizedBlock ?? block, block);
    this.publishStatusMetrics();
  }

  private updateIndexedStatus(block: number, timestamp: number | null, clearError = true): void {
    if (!Number.isSafeInteger(block) || block < 0) return;
    this.latestIndexedBlock = Math.max(this.latestIndexedBlock ?? block, block);
    if (timestamp !== null && Number.isSafeInteger(timestamp) && timestamp >= 0) {
      this.lastSuccessfulIndexTimestamp = Math.max(this.lastSuccessfulIndexTimestamp ?? timestamp, timestamp);
    }
    if (clearError) {
      this.lastError = null;
      this.lastErrorTimestamp = null;
    }
    this.publishStatusMetrics();
  }

  private recordError(error: unknown): void {
    let message = 'Unknown worker error';
    try {
      message = error instanceof Error ? error.message || error.name : String(error);
    } catch {
      // Keep the stable fallback when hostile error coercion throws.
    }
    this.lastError = message.slice(0, 1_000);
    const timestamp = Math.floor(Date.now() / 1_000);
    this.lastErrorTimestamp = Math.max(this.lastErrorTimestamp ?? timestamp, timestamp);
    this.publishStatusMetrics();
    if (this.repositoryStatusWritesEnabled) void this.persistWorkerStatusBestEffort();
  }

  private persistWorkerStatus(status: ChainIndexerStatus = this.getStatus()): Promise<void> {
    this.pendingWorkerStatusDocument = createPersistedWorkerStatusDocument(status);
    if (this.workerStatusWritePromise) return this.workerStatusWritePromise;

    const drain = async (): Promise<void> => {
      while (this.pendingWorkerStatusDocument) {
        const document = this.pendingWorkerStatusDocument;
        this.pendingWorkerStatusDocument = null;
        await this.repository.upsert(document);
        metrics.setGauge('indexer_worker_heartbeat_timestamp_seconds', {}, document.timestamp ?? 0);
      }
    };
    const write = drain().finally(() => {
      if (this.workerStatusWritePromise === write) this.workerStatusWritePromise = null;
      if (this.pendingWorkerStatusDocument) void this.persistWorkerStatusBestEffort();
    });
    this.workerStatusWritePromise = write;
    return write;
  }

  private async persistWorkerStatusBestEffort(status: ChainIndexerStatus = this.getStatus()): Promise<void> {
    try {
      await this.persistWorkerStatus(status);
    } catch (error) {
      metrics.increment('indexer_worker_status_persistence_errors_total');
      if (!this.isStopping()) console.error('Failed to persist worker status heartbeat', error);
    }
  }

  private startWorkerStatusHeartbeat(): void {
    if (this.workerStatusHeartbeatTimer) return;
    this.workerStatusHeartbeatTimer = setInterval(() => {
      void this.persistWorkerStatusBestEffort();
    }, WORKER_STATUS_HEARTBEAT_INTERVAL_MS);
    this.workerStatusHeartbeatTimer.unref?.();
  }

  start(): Promise<void> {
    if (this.isStopping()) {
      return Promise.reject(new Error('Cannot start the chain indexer after shutdown has begun'));
    }

    this.startPromise ??= this.startInternal();
    return this.startPromise;
  }

  /**
   * Stops new indexing work, releases subscriptions/connections, and waits a
   * bounded amount of time for already-running work to settle. The caller may
   * safely close the shared repository after this promise resolves.
   */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (this.lifecycleState === 'stopped') return Promise.resolve();

    this.stopPromise = this.stopInternal(true);
    return this.stopPromise;
  }

  private async startInternal(): Promise<void> {
    this.setLifecycle('starting', false);

    try {
      const provider = new WsProvider(this.config.soraWsEndpoint);
      this.primaryProvider = provider;
      const api = await this.withRpcTimeout(
        () => ApiPromise.create({ provider }),
        'primary SORA endpoint connection',
        undefined,
        (lateApi) => this.disconnectResource(lateApi, 'late SORA chain API')
      );
      if (this.isStopping()) {
        await this.disconnectResource(api, 'SORA chain API');
        return;
      }

      this.api = api;
      const supportsIdentityPreflight =
        typeof (api.rpc.chain as { getBlockHash?: unknown }).getBlockHash === 'function';
      if (supportsIdentityPreflight) {
        this.observedGenesisHash = await this.requireMainnetIdentity(api, 'primary SORA endpoint');
        await this.requireReviewedMainnetAnchor(api, 'primary SORA endpoint', true);
      }
      const finalizedBlock = await this.getFinalizedBlock(api, 'chain');
      if (this.isStopping()) return;

      if (supportsIdentityPreflight) await this.ensureChainIdentity(finalizedBlock);
      if (this.isStopping()) return;
      this.repositoryStatusWritesEnabled = true;
      this.startWorkerStatusHeartbeat();
      await this.persistWorkerStatusBestEffort();

      this.updateFinalizedStatus(finalizedBlock);
      const indexedAny = await this.backfill();
      if (this.isStopping()) return;

      // Backfill owns a block-pinned historical valuation state. Publish the
      // one current-state projection only after chainState has caught up;
      // loading it earlier would leak future prices into historical rows.
      const caughtUpBlock = await this.getLastIndexedBlock();
      const projectionBlock = Math.max(0, Math.min(finalizedBlock, caughtUpBlock));
      const startupMaintenanceBlock = await this.runStartupMaintenance(projectionBlock);
      if (this.isStopping()) return;
      this.discardRefreshRequestsCoveredBy(startupMaintenanceBlock);

      await this.subscribeFinalizedHeads();
      if (this.isStopping()) return;

      this.trackBackgroundTask(
        this.runLegacyStartupMaintenance(projectionBlock, indexedAny),
        'Legacy startup maintenance failed'
      );

      this.setLifecycle('running', true);
      await this.persistWorkerStatusBestEffort();
      this.startPendingRefreshQueues();
    } catch (error) {
      if (this.isStopping()) return;

      this.recordError(error);
      this.stopPromise = this.stopInternal(false, 'failed');
      await this.stopPromise;
      throw error;
    }
  }

  private isStopping(): boolean {
    return (
      this.lifecycleState === 'stopping' ||
      this.lifecycleState === 'stopped' ||
      this.lifecycleState === 'failed'
    );
  }

  private trackBackgroundTask(task: Promise<unknown>, errorMessage?: string): void {
    if (this.isStopping()) {
      void task.catch(() => undefined);
      return;
    }

    const tracked = task.then(
      () => undefined,
      (error: unknown) => {
        if (!this.isStopping()) {
          this.recordError(error);
          if (errorMessage) console.error(errorMessage, error);
        }
      }
    );
    this.backgroundTasks.add(tracked);
    void tracked.then(() => this.backgroundTasks.delete(tracked));
  }

  private clearLifecycleTimersAndQueues(): void {
    if (this.finalizedHeadRetryTimer) clearTimeout(this.finalizedHeadRetryTimer);
    if (this.finalizedHeadPollTimer) clearInterval(this.finalizedHeadPollTimer);
    if (this.derivedStateRefreshRetryTimer) clearTimeout(this.derivedStateRefreshRetryTimer);
    if (this.priceStreamRefreshRetryTimer) clearTimeout(this.priceStreamRefreshRetryTimer);
    if (this.polkamarktStateRefreshRetryTimer) clearTimeout(this.polkamarktStateRefreshRetryTimer);
    if (this.xorBurnBackfillRetryTimer) clearTimeout(this.xorBurnBackfillRetryTimer);
    if (this.workerStatusHeartbeatTimer) clearInterval(this.workerStatusHeartbeatTimer);
    for (const cancel of [...this.rpcTimeoutCancellations]) cancel();

    this.finalizedHeadRetryTimer = null;
    this.finalizedHeadPollTimer = null;
    this.derivedStateRefreshRetryTimer = null;
    this.priceStreamRefreshRetryTimer = null;
    this.polkamarktStateRefreshRetryTimer = null;
    this.xorBurnBackfillRetryTimer = null;
    this.workerStatusHeartbeatTimer = null;
    this.pendingDerivedStateRefresh = null;
    this.pendingPriceStreamRefresh = null;
    this.pendingPolkamarktStateRefresh = null;
    this.finalizedHeadRpcUpdateQueued = false;
    this.pendingFinalizedBlock = 0;
  }

  private withRpcTimeout<T>(
    createRequest: () => Promise<T>,
    label: string,
    timeoutMs = this.config.chainRpcTimeoutMs ?? CHAIN_RPC_TIMEOUT_MS,
    disposeLateValue?: (value: T) => void | Promise<void>
  ): Promise<T> {
    if (this.isStopping()) {
      return Promise.reject(new Error(`${label} cancelled during shutdown`));
    }
    const maximumInFlight = this.config.chainRpcMaxInFlight ?? 256;
    if (this.outstandingRpcRequests.size >= maximumInFlight) {
      metrics.increment('indexer_worker_rpc_admission_rejections_total');
      return Promise.reject(
        new Error(
          `${label} was not started because the ${maximumInFlight} request RPC budget is exhausted`
        )
      );
    }

    let request: Promise<T>;
    try {
      request = Promise.resolve(createRequest());
    } catch (error) {
      return Promise.reject(error);
    }
    this.outstandingRpcRequests.add(request);
    metrics.setGauge('indexer_worker_rpc_outstanding_requests', {}, this.outstandingRpcRequests.size);
    const releaseRequest = (): void => {
      this.outstandingRpcRequests.delete(request);
      metrics.setGauge('indexer_worker_rpc_outstanding_requests', {}, this.outstandingRpcRequests.size);
    };
    void request.then(releaseRequest, releaseRequest);

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (result: { value: T } | { error: unknown }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.rpcTimeoutCancellations.delete(cancel);
        if ('error' in result) reject(result.error);
        else resolve(result.value);
      };
      const cancel = (): void => finish({ error: new Error(`${label} cancelled during shutdown`) });
      const timeout = setTimeout(
        () => {
          metrics.increment('indexer_worker_rpc_timeouts_total');
          finish({ error: new Error(`${label} timed out after ${timeoutMs}ms`) });
        },
        timeoutMs
      );

      timeout.unref?.();
      this.rpcTimeoutCancellations.add(cancel);
      void request.then(
        (value) => {
          if (!settled) {
            finish({ value });
            return;
          }
          if (!disposeLateValue) return;

          metrics.increment('indexer_worker_rpc_late_values_disposed_total');
          const disposal = Promise.resolve()
            .then(() => disposeLateValue(value))
            .catch((error: unknown) => {
              metrics.increment('indexer_worker_rpc_late_disposal_errors_total');
              console.error(`Failed to dispose the late result from ${label}`, error);
            })
            .then(() => undefined);
          this.lateRpcDisposals.add(disposal);
          metrics.setGauge('indexer_worker_rpc_late_disposals', {}, this.lateRpcDisposals.size);
          void disposal.then(() => {
            this.lateRpcDisposals.delete(disposal);
            metrics.setGauge('indexer_worker_rpc_late_disposals', {}, this.lateRpcDisposals.size);
          });
        },
        (error: unknown) => finish({ error })
      );
    });
  }

  private async withRpcRetry<T>(
    createRequest: () => Promise<T>,
    label: string,
    attempts = XOR_BURN_BACKFILL_RPC_RETRIES
  ): Promise<T> {
    let lastError: unknown;
    const maximumAttempts = Math.max(1, attempts);

    for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
      if (this.isStopping()) throw new Error(`${label} cancelled during shutdown`);
      try {
        return await this.withRpcTimeout(createRequest, label);
      } catch (error) {
        if (this.isStopping() || isPrunedHistoricalStateErrorValue(error)) throw error;
        lastError = error;
        if (attempt >= maximumAttempts) break;

        console.warn(`${label} failed on attempt ${attempt}/${maximumAttempts}; retrying`);
        await delay(XOR_BURN_BACKFILL_RPC_RETRY_DELAY_MS * attempt);
      }
    }

    throw lastError;
  }

  private async requireMainnetIdentity(api: ApiPromise, label: string): Promise<string> {
    const genesis = await withTimeout(api.rpc.chain.getBlockHash(0), `${label}.chain.getBlockHash(0)`);
    const observed = genesis?.toString?.().toLowerCase() ?? '';
    if (!isNonzeroCanonicalSubstrateHash(observed)) {
      throw new Error(`${label} returned a missing, zero, or malformed genesis hash`);
    }
    if (observed !== SORA_MAINNET_GENESIS_HASH) {
      throw new Error(`${label} genesis hash does not match the reviewed SORA mainnet identity`);
    }
    return observed;
  }

  private async requireReviewedMainnetAnchor(
    api: ApiPromise,
    label: string,
    requireTimestamp = false
  ): Promise<void> {
    const anchor = await withTimeout(
      api.rpc.chain.getBlockHash(SORA_LEGACY_IDENTITY_ANCHOR.block),
      `${label}.chain.getBlockHash(${SORA_LEGACY_IDENTITY_ANCHOR.block})`
    );
    const observed = anchor?.toString?.().toLowerCase() ?? '';
    if (observed !== SORA_LEGACY_IDENTITY_ANCHOR.hash) {
      throw new Error(`${label} does not contain the reviewed SORA mainnet history anchor`);
    }
    if (requireTimestamp) {
      const timestamp = await this.fetchBlockTimestamp(observed, api);
      if (timestamp !== SORA_LEGACY_IDENTITY_ANCHOR.timestamp) {
        throw new Error(`${label} does not contain the reviewed SORA mainnet history anchor timestamp`);
      }
    }
  }

  private chainIdentityDocument(migration: StoredSoraChainIdentity['migration']): IndexerDocument {
    const verificationBlock = SORA_LEGACY_IDENTITY_ANCHOR.block;
    const verificationBlockHash = SORA_LEGACY_IDENTITY_ANCHOR.hash;
    const verificationBlockTimestamp = SORA_LEGACY_IDENTITY_ANCHOR.timestamp;
    const identity: StoredSoraChainIdentity = {
      schemaVersion: 1,
      genesisHash: SORA_MAINNET_GENESIS_HASH,
      verificationBlock,
      verificationBlockHash,
      verificationBlockTimestamp,
      migration,
    };
    return {
      collection: collection('updatesStreams'),
      id: CHAIN_IDENTITY_ID,
      blockHeight: verificationBlock,
      timestamp: verificationBlockTimestamp,
      data: {
        id: CHAIN_IDENTITY_ID,
        block: verificationBlock,
        data: JSON.stringify(identity),
      },
    };
  }

  private parseChainIdentity(document: IndexerDocument): StoredSoraChainIdentity {
    if (document.collection !== 'updatesStreams' || document.id !== CHAIN_IDENTITY_ID ||
        Object.keys(document.data).sort().join(',') !== 'block,data,id' ||
        document.data.id !== CHAIN_IDENTITY_ID) {
      throw new Error('Stored PI chain identity envelope is malformed');
    }
    if (typeof document.data?.data !== 'string') throw new Error('Stored PI chain identity data must be JSON text');
    let parsed: unknown;
    try {
      parsed = JSON.parse(document.data.data);
    } catch {
      throw new Error('Stored PI chain identity data must be valid JSON');
    }
    const value = parseStoredSoraChainIdentity(parsed);
    if (!value) {
      throw new Error('Stored PI chain identity checkpoint is malformed');
    }
    if (document.data.block !== value.verificationBlock ||
        document.blockHeight !== value.verificationBlock ||
        document.timestamp !== value.verificationBlockTimestamp) {
      throw new Error('Stored PI chain identity envelope does not match its checkpoint');
    }
    if (value.migration === 'legacy-production-anchor-v1' &&
        (value.verificationBlock !== SORA_LEGACY_IDENTITY_ANCHOR.block ||
         value.verificationBlockHash !== SORA_LEGACY_IDENTITY_ANCHOR.hash ||
         value.verificationBlockTimestamp !== SORA_LEGACY_IDENTITY_ANCHOR.timestamp)) {
      throw new Error('Stored PI legacy chain identity does not match the audited migration anchor');
    }
    return value;
  }

  private async repositoryIsEmpty(): Promise<boolean> {
    for (const name of ALL_INDEXER_COLLECTIONS) {
      const documents = this.repository.query
        ? (await this.repository.query(name, { first: 2, includeTotalCount: false })).items
        : await this.repository.list(name);
      if (documents.some((document) =>
        document.collection !== 'updatesStreams' || document.id !== WORKER_STATUS_DOCUMENT_ID
      )) return false;
    }
    return true;
  }

  private async repositoryContainsOnlyChainIdentity(): Promise<boolean> {
    for (const name of ALL_INDEXER_COLLECTIONS) {
      const documents = this.repository.query
        ? (await this.repository.query(name, { first: 3, includeTotalCount: false })).items
        : await this.repository.list(name);
      if (documents.some((document) =>
        document.collection !== 'updatesStreams' ||
        (document.id !== CHAIN_IDENTITY_ID && document.id !== WORKER_STATUS_DOCUMENT_ID)
      )) return false;
    }
    return true;
  }

  private async verifyStoredChainIdentity(
    identity: StoredSoraChainIdentity,
    finalizedBlock: number
  ): Promise<void> {
    if (!this.api) throw new Error('Cannot verify PI chain identity before the chain API is initialized');
    if (identity.verificationBlock > finalizedBlock) {
      throw new Error('Stored PI chain identity checkpoint is ahead of the primary finalized chain');
    }
    const liveHash = (
      await withTimeout(
        this.api.rpc.chain.getBlockHash(identity.verificationBlock),
        `chain.getBlockHash(${identity.verificationBlock})`
      )
    )?.toString?.().toLowerCase() ?? '';
    if (!isNonzeroCanonicalSubstrateHash(liveHash) || liveHash !== identity.verificationBlockHash) {
      throw new Error('Stored PI chain identity checkpoint hash does not match the primary SORA chain');
    }
    const liveTimestamp = await this.fetchBlockTimestamp(liveHash, this.api);
    if (liveTimestamp !== identity.verificationBlockTimestamp) {
      throw new Error('Stored PI chain identity checkpoint timestamp does not match the primary SORA chain');
    }
  }

  private parseLegacyChainState(document: IndexerDocument): number {
    if (document.collection !== 'updatesStreams' || document.id !== CHAIN_STATE_ID ||
        Object.keys(document.data).sort().join(',') !== 'block,data,id' ||
        document.data.id !== CHAIN_STATE_ID || typeof document.data.data !== 'string') {
      throw new Error('Legacy PI chainState envelope is malformed');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(document.data.data);
    } catch {
      throw new Error('Legacy PI chainState data must be valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        Object.keys(parsed as Record<string, unknown>).join(',') !== 'lastIndexedBlock') {
      throw new Error('Legacy PI chainState data is malformed');
    }
    const lastIndexedBlock = (parsed as { lastIndexedBlock?: unknown }).lastIndexedBlock;
    if (!Number.isSafeInteger(lastIndexedBlock) || Number(lastIndexedBlock) <= 0 ||
        Number(lastIndexedBlock) > SORA_MAX_BLOCK_NUMBER ||
        document.data.block !== lastIndexedBlock || document.blockHeight !== lastIndexedBlock ||
        !Number.isSafeInteger(document.timestamp) || Number(document.timestamp) <= 0) {
      throw new Error('Legacy PI chainState checkpoint is malformed');
    }
    return Number(lastIndexedBlock);
  }

  private parseCurrentChainState(document: IndexerDocument): StoredSoraChainState {
    if (document.collection !== 'updatesStreams' || document.id !== CHAIN_STATE_ID ||
        Object.keys(document.data).sort().join(',') !== 'block,data,id' ||
        document.data.id !== CHAIN_STATE_ID || typeof document.data.data !== 'string') {
      throw new Error('Stored PI chainState envelope is malformed');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(document.data.data);
    } catch {
      throw new Error('Stored PI chainState data must be valid JSON');
    }
    const state = parseStoredSoraChainState(parsed);
    if (!state) throw new Error('Stored PI chainState checkpoint is malformed');
    if (document.data.block !== state.lastIndexedBlock || document.blockHeight !== state.lastIndexedBlock ||
        !Number.isSafeInteger(document.timestamp) || Number(document.timestamp) <= 0) {
      throw new Error('Stored PI chainState envelope does not match its checkpoint');
    }
    return state;
  }

  private async requireMatchingBlockSnapshot(block: number, timestamp: number): Promise<void> {
    const expectedId = `block-${block}`;
    const snapshot = await this.repository.get(collection('networkSnapshots'), expectedId);
    if (!snapshot || snapshot.collection !== 'networkSnapshots' || snapshot.id !== expectedId ||
        snapshot.blockHeight !== block || snapshot.timestamp !== timestamp ||
        snapshot.data?.id !== expectedId || snapshot.data?.type !== 'BLOCK' ||
        snapshot.data?.timestamp !== timestamp) {
      throw new Error('Stored PI chainState does not have an exact matching BLOCK snapshot');
    }
  }

  private async verifyChainStateDocument(document: IndexerDocument, finalizedBlock: number): Promise<void> {
    let block: number;
    let expectedHash: string | null;
    let expectedTimestamp: number;
    try {
      const state = this.parseCurrentChainState(document);
      block = state.lastIndexedBlock;
      expectedHash = state.blockHash;
      expectedTimestamp = state.blockTimestamp;
    } catch (currentError) {
      try {
        block = this.parseLegacyChainState(document);
      } catch {
        throw currentError;
      }
      const snapshot = await this.repository.get(collection('networkSnapshots'), `block-${block}`);
      expectedHash = null;
      expectedTimestamp = Number(snapshot?.timestamp);
      if (!Number.isSafeInteger(expectedTimestamp) || expectedTimestamp <= 0) {
        throw new Error('Legacy PI chainState does not have a timestamped BLOCK snapshot');
      }
    }
    if (block > finalizedBlock) {
      throw new Error('Stored PI chainState is ahead of the primary finalized SORA chain');
    }
    await this.requireMatchingBlockSnapshot(block, expectedTimestamp);
    if (!this.api) throw new Error('Cannot verify PI chainState before the chain API is initialized');
    const liveHash = (
      await withTimeout(this.api.rpc.chain.getBlockHash(block), `chain.getBlockHash(${block})`)
    )?.toString?.().toLowerCase() ?? '';
    if (!isNonzeroCanonicalSubstrateHash(liveHash) || (expectedHash !== null && liveHash !== expectedHash)) {
      throw new Error('Stored PI chainState block hash does not match the primary SORA chain');
    }
    const liveTimestamp = await this.fetchBlockTimestamp(liveHash, this.api);
    if (liveTimestamp !== expectedTimestamp) {
      throw new Error('Stored PI chainState timestamp does not match the primary SORA chain');
    }
  }

  private async verifyStoredChainState(finalizedBlock: number): Promise<void> {
    const state = await this.repository.get(collection('updatesStreams'), CHAIN_STATE_ID);
    if (!state) {
      if (!(await this.repositoryContainsOnlyChainIdentity())) {
        throw new Error('PI database has indexed data but no chainState checkpoint');
      }
      return;
    }
    await this.verifyChainStateDocument(state, finalizedBlock);
  }

  private async ensureChainIdentity(finalizedBlock: number): Promise<void> {
    const stored = await this.repository.get(collection('updatesStreams'), CHAIN_IDENTITY_ID);
    if (stored) {
      await this.verifyStoredChainIdentity(this.parseChainIdentity(stored), finalizedBlock);
      await this.verifyStoredChainState(finalizedBlock);
      return;
    }

    const chainState = await this.repository.get(collection('updatesStreams'), CHAIN_STATE_ID);
    if (!chainState) {
      if (!(await this.repositoryIsEmpty())) {
        throw new Error('PI database is nonempty but has no immutable chain identity or chainState');
      }
      await this.repository.upsert(
        this.chainIdentityDocument('fresh-database')
      );
      return;
    }

    const lastIndexedBlock = this.parseLegacyChainState(chainState);
    if (lastIndexedBlock < SORA_LEGACY_IDENTITY_ANCHOR.block) {
      throw new Error('Legacy PI database predates the audited SORA mainnet identity migration anchor');
    }
    await this.verifyChainStateDocument(chainState, finalizedBlock);
    const anchorSnapshot = await this.repository.get(
      collection('networkSnapshots'),
      `block-${SORA_LEGACY_IDENTITY_ANCHOR.block}`
    );
    if (!anchorSnapshot || anchorSnapshot.timestamp !== SORA_LEGACY_IDENTITY_ANCHOR.timestamp ||
        anchorSnapshot.blockHeight !== SORA_LEGACY_IDENTITY_ANCHOR.block ||
        anchorSnapshot.data?.id !== `block-${SORA_LEGACY_IDENTITY_ANCHOR.block}` ||
        anchorSnapshot.data?.type !== 'BLOCK' ||
        anchorSnapshot.data?.timestamp !== SORA_LEGACY_IDENTITY_ANCHOR.timestamp) {
      throw new Error('Legacy PI database does not contain the audited SORA mainnet migration anchor snapshot');
    }
    if (!this.api) throw new Error('Cannot migrate PI chain identity before the chain API is initialized');
    const liveAnchorHash = (
      await withTimeout(
        this.api.rpc.chain.getBlockHash(SORA_LEGACY_IDENTITY_ANCHOR.block),
        `chain.getBlockHash(${SORA_LEGACY_IDENTITY_ANCHOR.block})`
      )
    ).toString().toLowerCase();
    if (liveAnchorHash !== SORA_LEGACY_IDENTITY_ANCHOR.hash) {
      throw new Error('Live SORA chain does not match the audited PI migration anchor block hash');
    }
    const liveAnchorTimestamp = await this.fetchBlockTimestamp(liveAnchorHash, this.api);
    if (liveAnchorTimestamp !== SORA_LEGACY_IDENTITY_ANCHOR.timestamp) {
      throw new Error('Live SORA chain does not match the audited PI migration anchor timestamp');
    }
    await this.repository.upsert(
      this.chainIdentityDocument('legacy-production-anchor-v1')
    );
  }

  private async disconnectResource(
    resource: { disconnect?: () => void | Promise<void> } | null,
    label: string
  ): Promise<void> {
    if (!resource || typeof resource !== 'object' || this.disconnectedResources.has(resource)) return;
    this.disconnectedResources.add(resource);

    try {
      await resource.disconnect?.();
    } catch (error) {
      console.error(`Failed to disconnect ${label}`, error);
    }
  }

  private async invokeFinalizedHeadUnsubscribe(
    unsubscribe: (() => void | Promise<void>) | null
  ): Promise<void> {
    if (!unsubscribe) return;

    try {
      await unsubscribe();
    } catch (error) {
      console.error('Failed to unsubscribe from finalized SORA heads', error);
    }
  }

  private async waitForShutdownTasks(
    tasks: readonly Promise<unknown>[],
    deadline = Date.now() + (this.config.chainShutdownTimeoutMs ?? CHAIN_DISCONNECT_TIMEOUT_MS)
  ): Promise<void> {
    if (!tasks.length) return;
    const remainingMs = Math.max(0, deadline - Date.now());
    if (remainingMs === 0) {
      console.warn(
        `Chain indexer shutdown timed out after ${this.config.chainShutdownTimeoutMs ?? CHAIN_DISCONNECT_TIMEOUT_MS}ms with unfinished work`
      );
      return;
    }

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const settled = Promise.allSettled(tasks).then(() => true);
    const completed = await Promise.race([
      settled,
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), remainingMs);
        timeout.unref?.();
      }),
    ]);

    if (timeout) clearTimeout(timeout);
    if (!completed) {
      console.warn(
        `Chain indexer shutdown timed out after ${this.config.chainShutdownTimeoutMs ?? CHAIN_DISCONNECT_TIMEOUT_MS}ms with unfinished work`
      );
    }
  }

  private async stopInternal(
    includeStartPromise: boolean,
    terminalLifecycle: Extract<ChainIndexerLifecycle, 'stopped' | 'failed'> = 'stopped'
  ): Promise<void> {
    const stoppedFromIdle = this.lifecycleState === 'idle';
    const shutdownDeadline =
      Date.now() + (this.config.chainShutdownTimeoutMs ?? CHAIN_DISCONNECT_TIMEOUT_MS);
    this.setLifecycle('stopping');
    this.clearLifecycleTimersAndQueues();
    const terminalStatusWrite = this.repositoryStatusWritesEnabled || stoppedFromIdle
      ? this.persistWorkerStatusBestEffort({
          ...this.getStatus(),
          lifecycle: terminalLifecycle,
        })
      : Promise.resolve();

    const unsubscribe = this.unsubscribeFinalizedHeads;
    this.unsubscribeFinalizedHeads = null;
    const api = this.api;
    this.api = null;
    const legacyApi = this.legacyBlockApi;
    this.legacyBlockApi = null;
    const legacyProvider = this.legacyBlockProvider;
    this.legacyBlockProvider = null;
    const provider = this.primaryProvider;
    this.primaryProvider = null;
    this.observedGenesisHash = null;
    const legacyApiPromise = this.legacyBlockApiPromise;
    this.legacyBlockApiPromise = null;

    const resourceTasks: Promise<unknown>[] = [this.invokeFinalizedHeadUnsubscribe(unsubscribe)];
    if (api) resourceTasks.push(this.disconnectResource(api, 'SORA chain API'));
    if (provider) resourceTasks.push(this.disconnectResource(provider, 'SORA WebSocket provider'));
    if (legacyApi && legacyApi !== api) {
      resourceTasks.push(this.disconnectResource(legacyApi, 'SORA block data API'));
    }
    if (legacyProvider && legacyProvider !== provider) {
      resourceTasks.push(this.disconnectResource(legacyProvider, 'SORA block data WebSocket provider'));
    }

    const workTasks: Promise<unknown>[] = [
      ...this.backgroundTasks,
      ...(includeStartPromise ? this.outstandingRpcRequests : []),
      ...this.lateRpcDisposals,
      ...resourceTasks,
      terminalStatusWrite,
    ];
    if (includeStartPromise && this.startPromise) workTasks.push(this.startPromise);
    if (legacyApiPromise) workTasks.push(legacyApiPromise);

    await this.waitForShutdownTasks(workTasks, shutdownDeadline);
    await this.waitForShutdownTasks([...this.lateRpcDisposals], shutdownDeadline);
    this.setLifecycle(terminalLifecycle);
  }

  private async runStartupMaintenance(finalizedBlock: number): Promise<number> {
    const latestIndexedBlock = await this.getLastIndexedBlock();
    if (this.isStopping()) return latestIndexedBlock;

    // Current storage-derived documents are produced directly from chain
    // state. Historical events are already handled by the normal block
    // backfill, so a fresh release has no one-time compatibility scans.
    const maintenanceBlock = Math.max(finalizedBlock, latestIndexedBlock);
    await this.refreshDerivedState(
      maintenanceBlock,
      Math.floor(Date.now() / 1_000),
      true,
      true
    );
    return maintenanceBlock;
  }

  private async runLegacyStartupMaintenance(finalizedBlock: number, indexedAny: boolean): Promise<void> {
    if (this.isStopping()) return;
    const cleanedOutliers = await this.cleanupAssetSnapshotPriceOutliers();
    if (this.isStopping()) return;
    const repairedSupply = await this.repairXorSupplyDocuments();
    if (this.isStopping()) return;
    const backfilledTransactions = await this.backfillAccountTransactions();
    if (this.isStopping()) return;
    const repairedCounters = await this.repairNetworkTransactionCounters();
    if (this.isStopping()) return;
    const backfilledNetworkAggregates = await this.backfillNetworkAggregateSnapshots();
    if (this.isStopping()) return;

    if (
      indexedAny ||
      cleanedOutliers ||
      repairedSupply ||
      backfilledTransactions ||
      repairedCounters ||
      backfilledNetworkAggregates
    ) {
      const latestIndexedBlock = await this.getLastIndexedBlock();
      this.requestDerivedStateRefresh(
        Math.max(finalizedBlock, latestIndexedBlock),
        Math.floor(Date.now() / 1_000),
        true,
        true
      );
    }
    this.requestXorBurnBackfill(finalizedBlock);
    if (this.isStopping()) return;
    await this.backfillBridgeProxyHistory(finalizedBlock);
  }

  private requestXorBurnBackfill(finalizedBlock: number): void {
    if (this.isStopping() || !this.api || finalizedBlock < SORA_XOR_BURN_START_BLOCK) return;
    this.xorBurnBackfillTargetBlock = Math.max(this.xorBurnBackfillTargetBlock, finalizedBlock);
    if (this.xorBurnBackfillRunning || this.xorBurnBackfillRetryTimer) return;
    this.trackBackgroundTask(this.runXorBurnBackfill());
  }

  private scheduleXorBurnBackfillRetry(delayMs = XOR_BURN_BACKFILL_RETRY_DELAY_MS): void {
    if (this.isStopping() || this.xorBurnBackfillRetryTimer) return;
    this.xorBurnBackfillRetryTimer = setTimeout(() => {
      this.xorBurnBackfillRetryTimer = null;
      if (!this.isStopping()) this.trackBackgroundTask(this.runXorBurnBackfill());
    }, delayMs);
    this.xorBurnBackfillRetryTimer.unref?.();
  }

  private async runXorBurnBackfill(): Promise<void> {
    if (this.isStopping() || !this.api || this.xorBurnBackfillRunning) return;
    this.xorBurnBackfillRunning = true;
    const targetBlock = this.xorBurnBackfillTargetBlock;
    try {
      await this.backfillXorBurns(targetBlock);
      if (this.xorBurnBackfillTargetBlock > targetBlock) this.scheduleXorBurnBackfillRetry(0);
    } catch (error) {
      if (!this.isStopping()) {
        console.error('XOR burn backfill failed', error);
        this.scheduleXorBurnBackfillRetry();
      }
    } finally {
      this.xorBurnBackfillRunning = false;
    }
  }

  private discardRefreshRequestsCoveredBy(blockHeight: number): void {
    if ((this.pendingDerivedStateRefresh?.blockHeight ?? Number.POSITIVE_INFINITY) <= blockHeight) {
      this.pendingDerivedStateRefresh = null;
    }
    if ((this.pendingPolkamarktStateRefresh?.blockHeight ?? Number.POSITIVE_INFINITY) <= blockHeight) {
      this.pendingPolkamarktStateRefresh = null;
    }
    if ((this.pendingPriceStreamRefresh?.blockHeight ?? Number.POSITIVE_INFINITY) <= blockHeight) {
      this.pendingPriceStreamRefresh = null;
    }
  }

  private startPendingRefreshQueues(): void {
    if (this.pendingDerivedStateRefresh) this.trackBackgroundTask(this.drainDerivedStateRefreshQueue());
    if (this.pendingPolkamarktStateRefresh) this.trackBackgroundTask(this.drainPolkamarktStateRefreshQueue());
    if (this.pendingPriceStreamRefresh) this.trackBackgroundTask(this.drainPriceStreamRefreshQueue());
  }

  private async getLastIndexedBlock(): Promise<number> {
    const state = await this.repository.get('updatesStreams', CHAIN_STATE_ID);
    if (!state) return Math.max(0, this.config.chainStartBlock - 1);
    let block: number;
    try {
      block = this.parseCurrentChainState(state).lastIndexedBlock;
    } catch {
      try {
        block = this.parseLegacyChainState(state);
      } catch {
        throw new Error('Stored chainState document is malformed');
      }
    }
    this.updateIndexedStatus(block, state.timestamp ?? null, false);
    return block;
  }

  private createChainStateDocument(block: number, blockHash: string, blockTimestamp: number): IndexerDocument {
    if (this.observedGenesisHash !== SORA_MAINNET_GENESIS_HASH ||
        !Number.isSafeInteger(block) || block <= 0 || block > SORA_MAX_BLOCK_NUMBER ||
        !isNonzeroCanonicalSubstrateHash(blockHash) ||
        !Number.isSafeInteger(blockTimestamp) || blockTimestamp <= 0) {
      throw new Error('Cannot persist PI chainState without validated SORA mainnet block identity');
    }
    return {
      collection: collection('updatesStreams'),
      id: CHAIN_STATE_ID,
      blockHeight: block,
      timestamp: Math.floor(Date.now() / 1000),
      data: {
        id: CHAIN_STATE_ID,
        block,
        data: JSON.stringify({
          lastIndexedBlock: block,
          genesisHash: this.observedGenesisHash,
          blockHash: blockHash.toLowerCase(),
          blockTimestamp,
        }),
      },
    };
  }

  private async getXorBurnBackfillBlock(): Promise<number> {
    const state = await this.repository.get('updatesStreams', XOR_BURN_BACKFILL_STATE_ID);
    if (!state?.data?.data || typeof state.data.data !== 'string') return SORA_XOR_BURN_START_BLOCK - 1;

    try {
      const parsed = JSON.parse(state.data.data) as { lastIndexedBlock?: number };
      return Number(parsed.lastIndexedBlock ?? SORA_XOR_BURN_START_BLOCK - 1);
    } catch {
      return SORA_XOR_BURN_START_BLOCK - 1;
    }
  }

  private createXorBurnBackfillStateDocument(block: number): IndexerDocument {
    return {
      collection: collection('updatesStreams'),
      id: XOR_BURN_BACKFILL_STATE_ID,
      blockHeight: block,
      timestamp: Math.floor(Date.now() / 1000),
      data: {
        id: XOR_BURN_BACKFILL_STATE_ID,
        block,
        data: JSON.stringify({ lastIndexedBlock: block }),
      },
    };
  }

  private isPrunedHistoricalStateError(error: unknown): boolean {
    return isPrunedHistoricalStateErrorValue(error);
  }

  private skipPrunedHistoricalBackfill(label: string, block: number, error: unknown): boolean {
    if (!this.isPrunedHistoricalStateError(error)) return false;

    console.warn(`${label} skipped at SORA block ${block}: node has pruned historical state`);
    return true;
  }

  private bridgeProxyHistoryBackfillStartBlock(): number {
    return 0;
  }

  private async getBridgeProxyHistoryBackfillBlock(): Promise<number> {
    const beforeStart = this.bridgeProxyHistoryBackfillStartBlock() - 1;
    const state = await this.repository.get('updatesStreams', BRIDGE_PROXY_HISTORY_BACKFILL_STATE_ID);
    if (!state?.data?.data || typeof state.data.data !== 'string') return beforeStart;

    try {
      const parsed = JSON.parse(state.data.data) as { lastIndexedBlock?: number };
      const block = Number(parsed.lastIndexedBlock);

      return Number.isFinite(block) ? Math.max(Math.trunc(block), beforeStart) : beforeStart;
    } catch {
      return beforeStart;
    }
  }

  private createBridgeProxyHistoryBackfillStateDocument(block: number): IndexerDocument {
    return {
      collection: collection('updatesStreams'),
      id: BRIDGE_PROXY_HISTORY_BACKFILL_STATE_ID,
      blockHeight: block,
      timestamp: Math.floor(Date.now() / 1000),
      data: {
        id: BRIDGE_PROXY_HISTORY_BACKFILL_STATE_ID,
        block,
        data: JSON.stringify({ lastIndexedBlock: block }),
      },
    };
  }

  private createNetworkAggregateBackfillStateDocument(block: number, timestamp: number): IndexerDocument {
    return {
      collection: collection('updatesStreams'),
      id: NETWORK_AGGREGATE_BACKFILL_STATE_ID,
      blockHeight: block,
      timestamp: Math.floor(Date.now() / 1000),
      data: {
        id: NETWORK_AGGREGATE_BACKFILL_STATE_ID,
        block,
        data: JSON.stringify({ lastIndexedBlock: block, lastTimestamp: timestamp }),
      },
    };
  }

  private createNetworkTransactionCounterRepairStateDocument(
    latestBlock: number,
    blockSnapshotsUpdated: number,
    aggregateSnapshotsUpdated: number
  ): IndexerDocument {
    return {
      collection: collection('updatesStreams'),
      id: NETWORK_TRANSACTION_COUNTER_REPAIR_STATE_ID,
      blockHeight: latestBlock,
      timestamp: Math.floor(Date.now() / 1000),
      data: {
        id: NETWORK_TRANSACTION_COUNTER_REPAIR_STATE_ID,
        block: latestBlock,
        data: JSON.stringify({ latestBlock, blockSnapshotsUpdated, aggregateSnapshotsUpdated }),
      },
    };
  }

  private createAssetPriceOutlierCleanupStateDocument(deletedCount: number): IndexerDocument {
    return {
      collection: collection('updatesStreams'),
      id: ASSET_PRICE_OUTLIER_CLEANUP_STATE_ID,
      timestamp: Math.floor(Date.now() / 1000),
      data: {
        id: ASSET_PRICE_OUTLIER_CLEANUP_STATE_ID,
        data: JSON.stringify({ deletedCount }),
      },
    };
  }

  private createXorSupplyRepairStateDocument(
    processedDocuments: number,
    writtenDocuments: number,
    skippedDocuments: number,
    latestBlock: number,
    latestTimestamp: number
  ): IndexerDocument {
    return {
      collection: collection('updatesStreams'),
      id: XOR_SUPPLY_REPAIR_STATE_ID,
      blockHeight: latestBlock || null,
      timestamp: Math.floor(Date.now() / 1000),
      data: {
        id: XOR_SUPPLY_REPAIR_STATE_ID,
        block: latestBlock,
        data: JSON.stringify({
          processedDocuments,
          writtenDocuments,
          skippedDocuments,
          lastIndexedBlock: latestBlock,
          lastTimestamp: latestTimestamp,
        }),
      },
    };
  }

  private createAccountTransactionsBackfillStateDocument(
    processedDocuments: number,
    writtenDocuments: number,
    blockHeight: number,
    timestamp: number
  ): IndexerDocument {
    return {
      collection: collection('updatesStreams'),
      id: ACCOUNT_TRANSACTIONS_BACKFILL_STATE_ID,
      blockHeight,
      timestamp: Math.floor(Date.now() / 1000),
      data: {
        id: ACCOUNT_TRANSACTIONS_BACKFILL_STATE_ID,
        block: blockHeight,
        data: JSON.stringify({
          processedDocuments,
          writtenDocuments,
          lastIndexedBlock: blockHeight,
          lastTimestamp: timestamp,
        }),
      },
    };
  }

  /**
   * Removes legacy zero-volume asset snapshots whose OHLC prices are extreme
   * outliers versus nearby snapshots for the same asset and interval.
   */
  private async cleanupAssetSnapshotPriceOutliers(): Promise<boolean> {
    if (this.isStopping()) return false;
    const state = await this.repository.get(collection('updatesStreams'), ASSET_PRICE_OUTLIER_CLEANUP_STATE_ID);
    if (state) return false;

    const groups = new Map<string, IndexerDocument[]>();
    for await (const page of this.queryPages(collection('assetSnapshots'), { orderBy: ['TIMESTAMP_ASC'] })) {
      if (this.isStopping()) return false;
      for (const document of page) {
        const type = String(document.data.type ?? '');
        if (!AGGREGATE_SNAPSHOT_TYPES.includes(type as SnapshotTypeName)) continue;

        const assetId = String(document.data.assetId ?? '');
        if (!assetId) continue;

        const key = `${assetId}\0${type}`;
        const group = groups.get(key) ?? [];
        group.push(document);
        groups.set(key, group);
      }
    }

    const outlierIds = new Set<string>();
    for (const group of groups.values()) {
      group.sort((left, right) => snapshotDocumentTimestamp(left) - snapshotDocumentTimestamp(right));

      for (const document of group) {
        if (isAssetSnapshotPriceOutlier(document, group)) {
          outlierIds.add(document.id);
        }
      }
    }

    const ids = [...outlierIds];
    for (let start = 0; start < ids.length; start += 1_000) {
      if (this.isStopping()) return false;
      await this.repository.deleteMany(collection('assetSnapshots'), ids.slice(start, start + 1_000));
    }

    if (this.isStopping()) return false;
    await this.repository.upsert(this.createAssetPriceOutlierCleanupStateDocument(ids.length));
    if (ids.length) console.info(`Deleted ${ids.length} zero-volume asset snapshot price outliers`);
    return ids.length > 0;
  }

  /**
   * Rewrites legacy XOR supply rows so GraphQL exposes the same codec-scale
   * contract as live `balances.totalIssuance` and every other asset supply.
   */
  private async repairXorSupplyDocuments(): Promise<boolean> {
    if (this.isStopping()) return false;
    const state = await this.repository.get(collection('updatesStreams'), XOR_SUPPLY_REPAIR_STATE_ID);
    if (state) return false;

    const supplyByBlock = new Map<number, Promise<string>>();
    let processedDocuments = 0;
    let writtenDocuments = 0;
    let skippedDocuments = 0;
    let skippedPrunedDocuments = 0;
    let latestBlock = 0;
    let latestTimestamp = 0;

    const getSupplyAtBlock = (blockHeight: number): Promise<string> => {
      let supply = supplyByBlock.get(blockHeight);
      if (!supply) {
        supply = this.fetchNativeXorIssuanceAtBlock(blockHeight).then((value) => value.toString());
        supplyByBlock.set(blockHeight, supply);
      }

      return supply;
    };

    const repairDocument = async (document: IndexerDocument): Promise<IndexerDocument | null> => {
      processedDocuments += 1;

      const blockHeight = Number(document.blockHeight ?? document.data.blockHeight);
      const timestamp = Number(document.timestamp ?? document.data.timestamp);
      if (Number.isFinite(blockHeight)) latestBlock = Math.max(latestBlock, Math.trunc(blockHeight));
      if (Number.isFinite(timestamp)) latestTimestamp = Math.max(latestTimestamp, Math.trunc(timestamp));

      if (!Number.isFinite(blockHeight) || blockHeight <= 0) {
        skippedDocuments += 1;
        return null;
      }

      let supply: string;
      try {
        supply = await getSupplyAtBlock(Math.trunc(blockHeight));
      } catch (error) {
        if (!this.isPrunedHistoricalStateError(error)) throw error;

        skippedDocuments += 1;
        skippedPrunedDocuments += 1;
        return null;
      }

      if (String(document.data.supply ?? '') === supply) return null;

      return {
        ...document,
        data: {
          ...document.data,
          supply,
        },
      };
    };

    const flush = async (documents: IndexerDocument[]): Promise<void> => {
      if (!documents.length || this.isStopping()) return;

      const repaired = (
        await mapWithConcurrency(documents, XOR_SUPPLY_REPAIR_RPC_CONCURRENCY, (document) => repairDocument(document))
      ).filter((document): document is IndexerDocument => Boolean(document));

      if (repaired.length && !this.isStopping()) {
        await this.repository.upsertMany(repaired);
        writtenDocuments += repaired.length;
      }

      await this.drainFinalizedHeads();
    };

    const currentAsset = await this.repository.get(collection('assets'), XOR);
    if (currentAsset) await flush([currentAsset]);

    for await (const page of this.queryPages(collection('assetSnapshots'), {
      filter: { assetId: { equalTo: XOR } },
      orderBy: ['BLOCK_HEIGHT_ASC'],
    })) {
      if (this.isStopping()) return false;
      await flush(page);
    }

    if (this.isStopping()) return false;
    if (skippedPrunedDocuments) {
      console.warn(`Skipped ${skippedPrunedDocuments} XOR supply rows because the node has pruned historical state`);
    } else {
      await this.repository.upsert(
        this.createXorSupplyRepairStateDocument(
          processedDocuments,
          writtenDocuments,
          skippedDocuments,
          latestBlock,
          latestTimestamp
        )
      );
    }
    if (writtenDocuments) console.info(`Repaired ${writtenDocuments} XOR supply rows from native balances issuance`);

    return writtenDocuments > 0;
  }

  /**
   * Creates compact per-account transaction rows for data indexed before the
   * `accountTransactions` collection existed. A completion marker lets GraphQL
   * avoid legacy history scans after the one-time migration has finished.
   */
  private async backfillAccountTransactions(): Promise<boolean> {
    if (this.isStopping()) return false;
    const state = await this.repository.get(collection('updatesStreams'), ACCOUNT_TRANSACTIONS_BACKFILL_STATE_ID);
    if (hasCompletedAccountTransactionsBackfill(state?.data?.data)) return false;

    const documents: IndexerDocument[] = [];
    let processedDocuments = 0;
    let writtenDocuments = 0;
    let latestBlock = 0;
    let latestTimestamp = 0;
    const flush = async (): Promise<void> => {
      if (!documents.length || this.isStopping()) return;

      const batch = documents.splice(0, documents.length);
      await this.repository.upsertMany(batch);
      writtenDocuments += batch.length;
      await this.drainFinalizedHeads();
    };

    for await (const page of this.queryPages(collection('historyElements'), { orderBy: ['TIMESTAMP_ASC'] })) {
      if (this.isStopping()) return false;
      for (const document of page) {
        processedDocuments += 1;
        const blockHeight = Number(document.blockHeight ?? document.data.blockHeight ?? latestBlock);
        const timestamp = Number(document.timestamp ?? document.data.timestamp ?? latestTimestamp);
        if (Number.isFinite(blockHeight)) latestBlock = Math.max(latestBlock, blockHeight);
        if (Number.isFinite(timestamp)) latestTimestamp = Math.max(latestTimestamp, timestamp);

        documents.push(...this.createAccountTransactionDocumentsFromHistory(document));
        if (documents.length >= ACCOUNT_TRANSACTIONS_BACKFILL_BATCH_SIZE) await flush();
      }
    }

    await flush();
    if (this.isStopping()) return false;
    await this.repository.upsert(
      this.createAccountTransactionsBackfillStateDocument(processedDocuments, writtenDocuments, latestBlock, latestTimestamp)
    );
    if (writtenDocuments) console.info(`Backfilled ${writtenDocuments} account transaction rows from legacy history`);

    return writtenDocuments > 0;
  }

  private addNetworkTransactionCounters(target: NetworkTransactionCounters, delta: NetworkTransactionCounters): void {
    target.transactions += delta.transactions;
    target.swaps += delta.swaps;
    target.bridgeIncomingTransactions += delta.bridgeIncomingTransactions;
    target.bridgeOutgoingTransactions += delta.bridgeOutgoingTransactions;
  }

  private networkTransactionCountersFromHistory(document: IndexerDocument): { blockHeight: number; counters: NetworkTransactionCounters } | null {
    const blockHeight = Number(document.blockHeight ?? document.data.blockHeight ?? 0);
    if (!Number.isFinite(blockHeight) || blockHeight <= 0) return null;

    const id = String(document.data.id ?? document.id);
    const module = String(document.data.module ?? '');
    const method = String(document.data.method ?? '');
    const callNames = Array.isArray(document.data.callNames) ? document.data.callNames.map(String) : [];
    const counters = emptyNetworkTransactionCounters();
    const fee = codecToBigInt(document.data.networkFee ?? 0);
    const syntheticBridgeIncoming = isSyntheticBridgeIncoming(id, module, method);

    if (fee > 0n && !syntheticBridgeIncoming) counters.transactions += 1;
    if (!historyExecutionSucceeded(document.data.execution)) return { blockHeight, counters };

    if (isLiquidityProxySwap(module, method, callNames)) counters.swaps += 1;
    if (isBridgeIncoming(id, module, method)) counters.bridgeIncomingTransactions += 1;
    if (isBridgeOutgoing(module, method)) counters.bridgeOutgoingTransactions += 1;

    return { blockHeight, counters };
  }

  private async collectNetworkTransactionCountersByBlock(): Promise<Map<number, NetworkTransactionCounters>> {
    const countersByBlock = new Map<number, NetworkTransactionCounters>();

    for await (const page of this.queryPages(collection('historyElements'), { orderBy: ['BLOCK_HEIGHT_ASC'] })) {
      if (this.isStopping()) return countersByBlock;
      for (const document of page) {
        const result = this.networkTransactionCountersFromHistory(document);
        if (!result) continue;

        const counters = countersByBlock.get(result.blockHeight) ?? emptyNetworkTransactionCounters();
        this.addNetworkTransactionCounters(counters, result.counters);
        countersByBlock.set(result.blockHeight, counters);
      }

      await this.drainFinalizedHeads();
    }

    return countersByBlock;
  }

  private networkTransactionCountersChanged(document: IndexerDocument, counters: NetworkTransactionCounters): boolean {
    return (
      Number(document.data.transactions ?? 0) !== counters.transactions ||
      Number(document.data.swaps ?? 0) !== counters.swaps ||
      Number(document.data.bridgeIncomingTransactions ?? 0) !== counters.bridgeIncomingTransactions ||
      Number(document.data.bridgeOutgoingTransactions ?? 0) !== counters.bridgeOutgoingTransactions
    );
  }

  private withNetworkTransactionCounters(document: IndexerDocument, counters: NetworkTransactionCounters): IndexerDocument {
    return {
      ...document,
      data: {
        ...document.data,
        transactions: counters.transactions,
        swaps: counters.swaps,
        bridgeIncomingTransactions: counters.bridgeIncomingTransactions,
        bridgeOutgoingTransactions: counters.bridgeOutgoingTransactions,
      },
    };
  }

  /**
   * Repairs legacy network transaction counters that previously counted unsigned
   * inherent extrinsics and failed business actions. Existing aggregate rows keep
   * their stock metrics while their transaction-like counters are recomputed from
   * corrected block snapshots.
   */
  private async repairNetworkTransactionCounters(): Promise<boolean> {
    if (this.isStopping()) return false;
    const state = await this.repository.get(collection('updatesStreams'), NETWORK_TRANSACTION_COUNTER_REPAIR_STATE_ID);
    if (state) return false;

    const countersByBlock = await this.collectNetworkTransactionCountersByBlock();
    if (this.isStopping()) return false;
    const aggregateSnapshots = new Map<string, IndexerDocument>();

    for await (const page of this.queryPages(collection('networkSnapshots'), {
      filter: { type: { notEqualTo: 'BLOCK' } },
    })) {
      if (this.isStopping()) return false;
      page.forEach((document) => aggregateSnapshots.set(document.id, document));
    }

    const windows = this.createNetworkBackfillWindows();
    const blockUpdates: IndexerDocument[] = [];
    const aggregateUpdates: IndexerDocument[] = [];
    let latestBlock = 0;
    let blockSnapshotsUpdated = 0;
    let aggregateSnapshotsUpdated = 0;

    const flushBlockUpdates = async (): Promise<void> => {
      if (!blockUpdates.length || this.isStopping()) return;

      const batch = blockUpdates.splice(0, blockUpdates.length);
      await this.repository.upsertMany(batch);
    };

    const flushAggregateUpdates = async (): Promise<void> => {
      if (!aggregateUpdates.length || this.isStopping()) return;

      const batch = aggregateUpdates.splice(0, aggregateUpdates.length);
      await this.repository.upsertMany(batch);
    };

    const enqueueAggregateRepair = async (document: IndexerDocument | null): Promise<void> => {
      if (!document) return;

      const existing = aggregateSnapshots.get(document.id);
      if (!existing) return;

      const counters = {
        transactions: Number(document.data.transactions ?? 0),
        swaps: Number(document.data.swaps ?? 0),
        bridgeIncomingTransactions: Number(document.data.bridgeIncomingTransactions ?? 0),
        bridgeOutgoingTransactions: Number(document.data.bridgeOutgoingTransactions ?? 0),
      };

      if (!this.networkTransactionCountersChanged(existing, counters)) return;

      aggregateUpdates.push(this.withNetworkTransactionCounters(existing, counters));
      aggregateSnapshotsUpdated += 1;

      if (aggregateUpdates.length >= 1_000) await flushAggregateUpdates();
    };

    for await (const page of this.queryPages(collection('networkSnapshots'), {
      filter: { type: { equalTo: 'BLOCK' } },
      orderBy: ['BLOCK_HEIGHT_ASC'],
    })) {
      if (this.isStopping()) return false;
      for (const document of page) {
        const blockHeight = Number(document.blockHeight ?? document.data.blockHeight ?? 0);
        if (!Number.isFinite(blockHeight) || blockHeight <= 0) continue;

        latestBlock = Math.max(latestBlock, blockHeight);
        const counters = countersByBlock.get(blockHeight) ?? emptyNetworkTransactionCounters();
        const repairedBlockDocument = this.networkTransactionCountersChanged(document, counters)
          ? this.withNetworkTransactionCounters(document, counters)
          : document;

        if (repairedBlockDocument !== document) {
          blockUpdates.push(repairedBlockDocument);
          blockSnapshotsUpdated += 1;
        }

        const block = this.networkBackfillBlockFromSnapshot(repairedBlockDocument);
        if (!block) continue;

        for (const window of windows) {
          const nextDocument = this.advanceNetworkBackfillWindow(window, block);
          if (window.pendingDocument && window.pendingDocument.id !== nextDocument.id) {
            await enqueueAggregateRepair(window.pendingDocument);
          }
          window.pendingDocument = nextDocument;
        }

        if (blockUpdates.length >= 1_000) await flushBlockUpdates();
      }

      await this.drainFinalizedHeads();
    }

    for (const window of windows) {
      await enqueueAggregateRepair(window.pendingDocument);
      window.pendingDocument = null;
    }

    await flushBlockUpdates();
    await flushAggregateUpdates();
    if (this.isStopping()) return false;
    await this.repository.upsert(
      this.createNetworkTransactionCounterRepairStateDocument(latestBlock, blockSnapshotsUpdated, aggregateSnapshotsUpdated)
    );

    if (blockSnapshotsUpdated || aggregateSnapshotsUpdated) {
      console.info(
        `Repaired ${blockSnapshotsUpdated} block and ${aggregateSnapshotsUpdated} aggregate network transaction snapshots`
      );
    }

    return blockSnapshotsUpdated > 0 || aggregateSnapshotsUpdated > 0;
  }

  /**
   * Reconstructs missing legacy aggregate network windows from stored BLOCK
   * snapshots. Existing aggregates remain authoritative for their stock fields.
   */
  private async backfillNetworkAggregateSnapshots(): Promise<boolean> {
    if (this.isStopping()) return false;
    const state = await this.repository.get(collection('updatesStreams'), NETWORK_AGGREGATE_BACKFILL_STATE_ID);
    if (state?.data?.data) return false;

    const existingAggregateSnapshotIds = new Set<string>();
    for await (const page of this.queryPages(collection('networkSnapshots'), {
      filter: { type: { notEqualTo: 'BLOCK' } },
    })) {
      if (this.isStopping()) return false;
      page.forEach((document) => existingAggregateSnapshotIds.add(document.id));
    }

    const windows = this.createNetworkBackfillWindows();
    const documents: IndexerDocument[] = [];
    const maximumBatchSize = Math.min(1_000, MAX_REPOSITORY_WRITE_CALL_DOCUMENTS);
    let latestBlock = 0;
    let latestTimestamp = 0;
    let processedBlocks = 0;
    let writtenDocuments = 0;
    const flush = async (): Promise<void> => {
      if (!documents.length || this.isStopping()) return;
      const batch = documents.splice(0, documents.length);
      await this.repository.upsertMany(batch);
      writtenDocuments += batch.length;
    };
    const enqueue = async (document: IndexerDocument | null): Promise<void> => {
      if (!document || existingAggregateSnapshotIds.has(document.id)) return;

      documents.push(document);
      existingAggregateSnapshotIds.add(document.id);
      if (documents.length >= maximumBatchSize) await flush();
    };

    for await (const page of this.queryPages(collection('networkSnapshots'), {
      filter: { type: { equalTo: 'BLOCK' } },
      orderBy: ['BLOCK_HEIGHT_ASC'],
    })) {
      if (this.isStopping()) return false;
      for (const document of page) {
        const block = this.networkBackfillBlockFromSnapshot(document);
        if (!block) continue;

        processedBlocks += 1;
        latestBlock = block.blockHeight;
        latestTimestamp = block.timestamp;

        for (const window of windows) {
          const nextDocument = this.advanceNetworkBackfillWindow(window, block);
          if (window.pendingDocument && window.pendingDocument.id !== nextDocument.id) {
            await enqueue(window.pendingDocument);
          }
          window.pendingDocument = existingAggregateSnapshotIds.has(nextDocument.id) ? null : nextDocument;
        }
      }
      await this.drainFinalizedHeads();
    }

    if (!processedBlocks) return false;

    for (const window of windows) {
      await enqueue(window.pendingDocument);
      window.pendingDocument = null;
    }
    await flush();

    if (this.isStopping()) return false;
    await this.repository.upsert(
      this.createNetworkAggregateBackfillStateDocument(latestBlock, latestTimestamp)
    );
    console.info(`Backfilled ${writtenDocuments} aggregate network snapshots through SORA block ${latestBlock}`);
    return true;
  }

  private async backfillXorBurns(finalizedBlock: number): Promise<void> {
    if (this.isStopping() || !this.api || finalizedBlock < SORA_XOR_BURN_START_BLOCK) return;

    const lastBackfilled = await this.getXorBurnBackfillBlock();
    const startBlock = Math.max(SORA_XOR_BURN_START_BLOCK, lastBackfilled + 1);

    if (startBlock > finalizedBlock) return;

    const runRpc: RpcExecutor = (createRequest, label) => this.withRpcRetry(createRequest, label);
    const prefetchedBlocks = new Map<number, FetchedBlock>();
    try {
      prefetchedBlocks.set(startBlock, await this.fetchBlockByNumber(startBlock, runRpc));
    } catch (error) {
      if (this.skipPrunedHistoricalBackfill('XOR burn backfill', startBlock, error)) return;
      throw error;
    }

    for (let block = startBlock; block <= finalizedBlock; block += XOR_BURN_BACKFILL_BATCH_SIZE) {
      if (this.isStopping()) return;
      await this.drainFinalizedHeads();
      if (this.isStopping()) return;

      const batchEnd = Math.min(block + XOR_BURN_BACKFILL_BATCH_SIZE - 1, finalizedBlock);
      const blocks = Array.from({ length: batchEnd - block + 1 }, (_item, index) => block + index);
      const fetchedBlocks = await mapWithConcurrency(
        blocks,
        XOR_BURN_BACKFILL_RPC_CONCURRENCY,
        async (blockHeight): Promise<FetchedBlock> =>
          prefetchedBlocks.get(blockHeight) ?? this.fetchBlockByNumber(blockHeight, runRpc)
      );
      if (this.isStopping()) return;
      const burnBlockIndexes = fetchedBlocks.flatMap((fetchedBlock, index) =>
        fetchedBlock.events.some((event) => getXorBurnEvent(event, this.assetInfos)) ? [index] : []
      );

      const documents = burnBlockIndexes.flatMap((index) => {
        const fetchedBlock = fetchedBlocks[index];

        return createXorBurnDocumentsFromEvents(
          blocks[index],
          null,
          fetchedBlock.signedBlock,
          fetchedBlock.events,
          this.assetInfos
        );
      });

      documents.push(this.createXorBurnBackfillStateDocument(batchEnd));
      if (this.isStopping()) return;
      await this.repository.upsertMany(documents);
      console.info(`Backfilled XOR burns through SORA block ${batchEnd}/${finalizedBlock}`);
    }
  }

  private async backfillBridgeProxyHistory(finalizedBlock: number): Promise<void> {
    if (this.isStopping() || !this.api) return;

    const lastBackfilled = await this.getBridgeProxyHistoryBackfillBlock();
    const startBlock = Math.max(this.bridgeProxyHistoryBackfillStartBlock(), lastBackfilled + 1);

    if (startBlock > finalizedBlock) return;

    let blockApi: ApiPromise;
    const prefetchedBlocks = new Map<number, FetchedBlock>();
    try {
      blockApi = await this.getBlockDataApi();
      const firstPayloadBlock = Math.max(1, startBlock);
      if (firstPayloadBlock <= finalizedBlock) {
        prefetchedBlocks.set(firstPayloadBlock, await this.fetchBlockByNumber(firstPayloadBlock));
      }
      const startHash = startBlock === 0
        ? SORA_MAINNET_GENESIS_HASH
        : prefetchedBlocks.get(startBlock)!.requestedHash;
      await this.hasBridgeProxyHistoryRuntime(startHash, startBlock, blockApi);
    } catch (error) {
      if (this.skipPrunedHistoricalBackfill('bridgeProxy history backfill', startBlock, error)) return;
      throw error;
    }

    for (let block = startBlock; block <= finalizedBlock; block += BRIDGE_PROXY_HISTORY_BACKFILL_BATCH_SIZE) {
      if (this.isStopping()) return;
      await this.drainFinalizedHeads();
      if (this.isStopping()) return;

      const batchEnd = Math.min(block + BRIDGE_PROXY_HISTORY_BACKFILL_BATCH_SIZE - 1, finalizedBlock);
      const blocks = Array.from({ length: batchEnd - block + 1 }, (_item, index) => block + index);
      const payloadBlocks = blocks.filter((blockHeight) => blockHeight > 0);
      const fetchedBlocks = await mapWithConcurrency(
        payloadBlocks,
        BRIDGE_PROXY_HISTORY_BACKFILL_RPC_CONCURRENCY,
        async (blockHeight): Promise<FetchedBlock> =>
          prefetchedBlocks.get(blockHeight) ?? this.fetchBlockByNumber(blockHeight)
      );
      if (this.isStopping()) return;
      const fetchedBlocksByHeight = new Map(
        payloadBlocks.map((blockHeight, index) => [blockHeight, fetchedBlocks[index]])
      );
      const blockHashes = blocks.map((blockHeight) =>
        blockHeight === 0
          ? SORA_MAINNET_GENESIS_HASH
          : fetchedBlocksByHeight.get(blockHeight)?.requestedHash ?? ''
      );
      let scanBlockIndexes = blocks.flatMap((blockHeight, index) => blockHeight > 0 ? [index] : []);

      if (!this.bridgeProxyHistoryRuntimeAvailable) {
        const batchEndHasBridgeRuntime = await this.hasBridgeProxyHistoryRuntime(
          blockHashes[blockHashes.length - 1]?.toString() ?? '',
          batchEnd,
          blockApi
        );

        if (!batchEndHasBridgeRuntime) {
          if (this.isStopping()) return;
          await this.repository.upsert(this.createBridgeProxyHistoryBackfillStateDocument(batchEnd));
          console.info(`Backfilled bridgeProxy history through SORA block ${batchEnd}/${finalizedBlock}`);
          continue;
        }

        const runtimeAvailability = await mapWithConcurrency(
          blockHashes,
          BRIDGE_PROXY_HISTORY_BACKFILL_RPC_CONCURRENCY,
          (hash, index) => this.hasBridgeProxyHistoryRuntime(hash.toString(), blocks[index], blockApi)
        );
        scanBlockIndexes = runtimeAvailability.flatMap((available, index) =>
          available && blocks[index] > 0 ? [index] : []
        );
        this.bridgeProxyHistoryRuntimeAvailable = scanBlockIndexes.length > 0;
      }

      const bridgeBlockIndexes = scanBlockIndexes.flatMap((index) =>
        this.hasBridgeProxyHistoryExtrinsics(
          fetchedBlocksByHeight.get(blocks[index])!.signedBlock as SignedBlockLike
        ) ? [index] : []
      );
      const batchDocuments: IndexerDocument[] = [];
      const accountTransactionDocuments: IndexerDocument[] = [];
      const historyElementIds: string[] = [];

      if (bridgeBlockIndexes.length) {
        const bridgeBlocks = await mapWithConcurrency(
          bridgeBlockIndexes,
          BRIDGE_PROXY_HISTORY_BACKFILL_RPC_CONCURRENCY,
          async (index) => {
            const fetchedBlock = fetchedBlocksByHeight.get(blocks[index]);
            if (!fetchedBlock) {
              throw new Error(`Missing verified payload for bridgeProxy history backfill block ${blocks[index]}`);
            }

            return {
              signedBlock: fetchedBlock.signedBlock as SignedBlockLike,
              events: fetchedBlock.events,
              timestamp: fetchedBlock.timestamp,
            };
          }
        );

        for (const { signedBlock, events, timestamp } of bridgeBlocks) {
          const { blockHeight, blockHash, contexts } = this.createBridgeProxyHistoryContexts(signedBlock, events);

          for (const context of contexts) {
            historyElementIds.push(context.id);
            const historyDocument = this.createHistoryElementDocument(context, blockHeight, timestamp, blockHash);
            batchDocuments.push(historyDocument);
            accountTransactionDocuments.push(
              ...this.createAccountTransactionDocuments(context, blockHeight, timestamp, historyDocument)
            );
          }
        }
      }

      if (this.isStopping()) return;
      await this.repository.upsertMany(batchDocuments);
      await this.upsertAndPruneAccountTransactionDocuments(historyElementIds, accountTransactionDocuments);
      if (this.isStopping()) return;
      await this.repository.upsert(this.createBridgeProxyHistoryBackfillStateDocument(batchEnd));
      console.info(`Backfilled bridgeProxy history through SORA block ${batchEnd}/${finalizedBlock}`);
    }
  }

  private async hasBridgeProxyHistoryRuntime(hash: string, blockHeight: number, api = this.api): Promise<boolean> {
    if (!this.api) throw new Error('Cannot inspect historical metadata before the chain API is initialized');
    if (!api) throw new Error('Cannot inspect historical metadata before the chain API is initialized');
    if (!hash) throw new Error(`Missing block hash for historical metadata at SORA block ${blockHeight}`);

    const getMetadata = (api.rpc as unknown as { state?: { getMetadata?: (hash: string) => Promise<unknown> } }).state?.getMetadata;
    if (typeof getMetadata !== 'function') {
      throw new Error('state.getMetadata is required to find the bridgeProxy history start');
    }

    const metadata = await withTimeout(getMetadata.call((api.rpc as any).state, hash), `state.getMetadata(${blockHeight})`);
    const pallets = (metadata as { asLatest?: { pallets?: Iterable<{ name?: { toString?: () => string } }> } }).asLatest?.pallets;

    if (pallets) {
      for (const pallet of pallets) {
        const name = pallet.name?.toString?.() ?? '';
        if (name === 'bridgeProxy' || name === 'bridgeChannelInbound') return true;
      }

      return false;
    }

    const json = (metadata as CodecLike | undefined)?.toJSON?.();
    return JSON.stringify(json ?? '').includes('bridgeProxy') || JSON.stringify(json ?? '').includes('bridgeChannelInbound');
  }

  private hasBridgeProxyHistoryExtrinsics(signedBlock: SignedBlockLike): boolean {
    return signedBlock.block.extrinsics.some((extrinsic) => {
      const section = extrinsic.method.section;

      return section === 'bridgeProxy' || section === 'bridgeChannelInbound';
    });
  }

  private createBridgeProxyHistoryContexts(
    signedBlock: SignedBlockLike,
    events: EventRecord[]
  ): { blockHeight: number; blockHash: string; contexts: BlockExtrinsicContext[] } {
    const eventsByExtrinsic = groupEventsByExtrinsic(events);
    const blockHeight = signedBlock.block.header?.number?.toNumber() ?? 0;
    const blockHash = signedBlock.block.header?.hash?.toString() ?? '';
    const contexts: BlockExtrinsicContext[] = [];

    for (const [index, extrinsic] of signedBlock.block.extrinsics.entries()) {
      const eventsForExtrinsic = eventsByExtrinsic.get(index) ?? [];
      if (!eventsForExtrinsic.some((record) => record.event.section === 'bridgeProxy')) continue;

      const failed = eventsForExtrinsic.find(({ event }) => event.section === 'system' && event.method === 'ExtrinsicFailed');
      const args = codecArgs(extrinsic.method);
      const calls = getUtilityCalls(extrinsic);
      const callNames = calls.map((call) => `${call.module}.${call.method}`);
      const address = getSigner(extrinsic);
      const history = createHistoryData(
        extrinsic.method.section,
        extrinsic.method.method,
        args,
        eventsForExtrinsic,
        address,
        this.prices,
        this.assetInfos
      );
      const id = extrinsic.hash?.toString?.() || `${blockHeight}-${index}`;
      const fee = this.extractNetworkFee(eventsForExtrinsic);
      const context: BlockExtrinsicContext = {
        id,
        module: extrinsic.method.section,
        method: extrinsic.method.method,
        address,
        failed: Boolean(failed),
        history,
        calls,
        callNames,
        events: eventsForExtrinsic,
        accounts: historyIndexedAccounts(extrinsic.method.section, extrinsic.method.method, address, history),
        fee,
      };

      if (context.module === 'bridgeProxy' && (context.method === 'burn' || context.method === 'mint')) {
        contexts.push(context);
      }

      const incomingContext = createBridgeProxyIncomingContext(context, args, this.prices, this.assetInfos);
      if (incomingContext) contexts.push(incomingContext);
    }

    return { blockHeight, blockHash, contexts };
  }

  private async upsertAndPruneAccountTransactionDocuments(
    historyElementIds: string[],
    documents: IndexerDocument[]
  ): Promise<void> {
    const uniqueHistoryElementIds = [...new Set(historyElementIds)];
    if (!uniqueHistoryElementIds.length) return;

    const expectedIds = new Set(documents.map((document) => document.id));
    const staleIds: string[] = [];

    await this.repository.upsertMany(documents);

    for await (const page of this.queryPages(collection('accountTransactions'), {
      filter: { historyElementId: { in: uniqueHistoryElementIds } },
    })) {
      for (const document of page) {
        if (!expectedIds.has(document.id)) staleIds.push(document.id);
      }
    }

    for (let start = 0; start < staleIds.length; start += ACCOUNT_TRANSACTIONS_BACKFILL_BATCH_SIZE) {
      await this.repository.deleteMany(collection('accountTransactions'), staleIds.slice(start, start + ACCOUNT_TRANSACTIONS_BACKFILL_BATCH_SIZE));
    }
  }

  private async backfill(): Promise<boolean> {
    if (this.isStopping() || !this.api) return false;

    const finalizedBlock = await this.getIndexableFinalizedBlock();
    const lastIndexed = await this.getLastIndexedBlock();
    if (lastIndexed >= this.config.chainStartBlock && lastIndexed > finalizedBlock) {
      throw new Error(
        `Stored chain state ${lastIndexed} is ahead of the configured SORA endpoint finalized block ${finalizedBlock}`
      );
    }
    const startBlock = Math.max(1, this.config.chainStartBlock, lastIndexed + 1);
    if (startBlock > finalizedBlock) return false;

    const networkAggregateWindows = await this.initializeNetworkBackfillWindows(lastIndexed);
    const historicalValuationState = await this.initializeHistoricalValuationState(startBlock);
    const backfillRetentionTimestamp = Math.floor(Date.now() / 1_000);
    let indexedAny = false;

    if (this.config.backfillPrefetchConcurrency === 1) {
      for (let block = startBlock; block <= finalizedBlock; block += 1) {
        if (this.isStopping()) return indexedAny;
        await this.indexBlockByNumber(block, {
          refreshDerivedState: false,
          networkAggregateWindows,
          flushNetworkAggregates: block === finalizedBlock,
          backfillRetentionTimestamp,
          historicalValuationState,
          retireExpiredNetworkBlocks:
            block === finalizedBlock || block % this.config.chainBatchSize === 0,
        });
        indexedAny = true;

        if (block % this.config.chainBatchSize === 0) {
          console.info(`Indexed SORA block ${block}/${finalizedBlock}`);
        }
      }
    } else {
      for (
        let batchStart = startBlock;
        batchStart <= finalizedBlock;
        batchStart += this.config.backfillPrefetchConcurrency
      ) {
        if (this.isStopping()) return indexedAny;
        const batchEnd = Math.min(batchStart + this.config.backfillPrefetchConcurrency - 1, finalizedBlock);
        const blocks = Array.from({ length: batchEnd - batchStart + 1 }, (_item, index) => batchStart + index);
        const fetchedBlocks = await mapWithConcurrency(blocks, this.config.backfillPrefetchConcurrency, (block) =>
          this.fetchBlockByNumber(block)
        );

        for (const fetchedBlock of fetchedBlocks) {
          if (this.isStopping()) return indexedAny;
          const block = fetchedBlock.signedBlock.block.header.number.toNumber();
          await this.indexFetchedBlock(fetchedBlock, {
            refreshDerivedState: false,
            networkAggregateWindows,
            flushNetworkAggregates: block === finalizedBlock,
            backfillRetentionTimestamp,
            historicalValuationState,
            retireExpiredNetworkBlocks:
              block === finalizedBlock || block % this.config.chainBatchSize === 0,
          });
          indexedAny = true;

          if (block % this.config.chainBatchSize === 0) {
            console.info(`Indexed SORA block ${block}/${finalizedBlock}`);
          }
        }
      }
    }

    return indexedAny;
  }

  /**
   * Restores only the bounded rolling horizon needed when a normal chain
   * backfill resumes. A brand-new store avoids repository history scans.
   */
  private async initializeNetworkBackfillWindows(lastIndexed: number): Promise<NetworkBackfillWindow[]> {
    const windows = this.createNetworkBackfillWindows();
    if (lastIndexed < this.config.chainStartBlock || !this.repository.query) return windows;

    const latest = await this.repository.query(collection('networkSnapshots'), {
      first: 1,
      orderBy: ['BLOCK_HEIGHT_DESC'],
      filter: {
        and: [{ type: { equalTo: 'BLOCK' } }, { blockHeight: { lessThanOrEqualTo: lastIndexed } }],
      },
      includeTotalCount: false,
    });
    const latestBlock = latest.items[0];
    const latestTimestamp = Number(latestBlock?.timestamp ?? latestBlock?.data.timestamp);
    if (!latestBlock || !Number.isSafeInteger(latestTimestamp) || latestTimestamp <= 0) return windows;

    const oldestTimestamp = latestTimestamp - SNAPSHOT_WINDOW_SECONDS.MONTH;
    for await (const page of this.queryPages(collection('networkSnapshots'), {
      filter: {
        and: [
          { type: { equalTo: 'BLOCK' } },
          { timestamp: { greaterThanOrEqualTo: oldestTimestamp, lessThanOrEqualTo: latestTimestamp } },
          { blockHeight: { lessThanOrEqualTo: lastIndexed } },
        ],
      },
      orderBy: ['TIMESTAMP_ASC'],
    })) {
      for (const document of page) {
        const block = this.networkBackfillBlockFromSnapshot(document);
        if (!block) continue;
        for (const window of windows) {
          window.pendingDocument = this.advanceNetworkBackfillWindow(window, block);
        }
      }
    }

    return windows;
  }

  private async subscribeFinalizedHeads(): Promise<void> {
    if (this.isStopping() || !this.api) return;

    let unsubscribe: () => void | Promise<void>;
    try {
      unsubscribe = await this.withRpcTimeout(
        () =>
          this.api!.rpc.chain.subscribeFinalizedHeads((header) => {
            if (this.isStopping()) return;

            let finalizedBlock: number;
            try {
              finalizedBlock = this.observedGenesisHash || this.enforceFinalizedIdentity
                ? this.validatedFinalizedHeaderHeight(header, 'finalized-head subscription')
                : header.number.toNumber();
              if (!Number.isSafeInteger(finalizedBlock) || finalizedBlock < 0) {
                throw new Error('finalized-head subscription returned an invalid height');
              }
            } catch {
              this.requestPendingFinalizedBlockUpdate(
                'Failed to recover from a malformed finalized-head subscription update'
              );
              return;
            }
            this.updateFinalizedStatus(finalizedBlock);
            if (this.archiveSoraWsEndpoint) {
              this.requestPendingFinalizedBlockUpdate('Failed to update finalized head from subscription');
              return;
            }

            this.pendingFinalizedBlock = Math.max(this.pendingFinalizedBlock, finalizedBlock);
            this.trackBackgroundTask(this.drainFinalizedHeads());
          }),
        'chain.subscribeFinalizedHeads()',
        undefined,
        (lateUnsubscribe) => this.invokeFinalizedHeadUnsubscribe(lateUnsubscribe)
      );
    } catch (error) {
      if (this.isStopping()) return;
      throw error;
    }
    if (this.isStopping()) {
      await this.invokeFinalizedHeadUnsubscribe(unsubscribe);
      return;
    }
    this.unsubscribeFinalizedHeads = unsubscribe;

    this.startFinalizedHeadPolling();
    await this.updatePendingFinalizedBlockFromRpc().catch((error: unknown) => {
      if (!this.isStopping()) {
        this.recordError(error);
        console.error('Failed to initialize finalized head polling', error);
      }
    });
  }

  private async updatePendingFinalizedBlockFromRpc(): Promise<void> {
    if (this.isStopping() || !this.api) return;
    if (this.finalizedHeadRpcUpdateRunning) {
      this.finalizedHeadRpcUpdateQueued = true;
      return;
    }

    this.finalizedHeadRpcUpdateRunning = true;

    try {
      do {
        if (this.isStopping()) return;
        this.finalizedHeadRpcUpdateQueued = false;
        this.pendingFinalizedBlock = Math.max(this.pendingFinalizedBlock, await this.getIndexableFinalizedBlock());
        if (this.isStopping()) return;
        await this.drainFinalizedHeads();
      } while (!this.isStopping() && this.finalizedHeadRpcUpdateQueued);
    } finally {
      this.finalizedHeadRpcUpdateRunning = false;
    }
  }

  private requestPendingFinalizedBlockUpdate(errorMessage: string): void {
    if (this.isStopping()) return;
    this.trackBackgroundTask(this.updatePendingFinalizedBlockFromRpc(), errorMessage);
  }

  private startFinalizedHeadPolling(): void {
    if (this.isStopping() || this.finalizedHeadPollTimer) return;

    this.finalizedHeadPollTimer = setInterval(() => {
      if (this.isStopping() || this.finalizedHeadPollRunning) return;

      this.finalizedHeadPollRunning = true;
      const task = this.updatePendingFinalizedBlockFromRpc()
        .catch((error: unknown) => {
          if (!this.isStopping()) {
            this.recordError(error);
            console.error('Failed to poll finalized head', error);
          }
        })
        .finally(() => {
          this.finalizedHeadPollRunning = false;
        });
      this.trackBackgroundTask(task);
    }, FINALIZED_HEAD_POLL_INTERVAL_MS);
    this.finalizedHeadPollTimer.unref?.();
  }

  private scheduleFinalizedHeadRetry(): void {
    if (this.isStopping() || this.finalizedHeadRetryTimer) return;

    this.finalizedHeadRetryTimer = setTimeout(() => {
      this.finalizedHeadRetryTimer = null;
      if (this.isStopping()) return;
      this.trackBackgroundTask(this.drainFinalizedHeads());
    }, FINALIZED_HEAD_RETRY_DELAY_MS);
    this.finalizedHeadRetryTimer.unref?.();
  }

  private async drainFinalizedHeads(): Promise<void> {
    if (this.isStopping() || !this.api || this.finalizedHeadDrainRunning) return;

    this.finalizedHeadDrainRunning = true;

    try {
      let nextBlock = (await this.getLastIndexedBlock()) + 1;
      while (!this.isStopping() && nextBlock <= this.pendingFinalizedBlock) {
        try {
          const batchEnd = Math.min(
            nextBlock + this.config.finalizedCatchupPrefetchConcurrency - 1,
            this.pendingFinalizedBlock
          );

          if (batchEnd === nextBlock) {
            const valuationState = await this.ensureLiveValuationState(nextBlock);
            await this.indexBlockByNumber(nextBlock, { historicalValuationState: valuationState });
            this.promoteLiveValuationState(valuationState);
            nextBlock += 1;
            continue;
          }

          const blocks = Array.from({ length: batchEnd - nextBlock + 1 }, (_item, index) => nextBlock + index);
          const fetchedBlocks = await mapWithConcurrency(
            blocks,
            this.config.finalizedCatchupPrefetchConcurrency,
            (block) => this.fetchBlockByNumber(block)
          );

          for (let index = 0; index < fetchedBlocks.length; index += 1) {
            if (this.isStopping()) return;
            const fetchedBlock = fetchedBlocks[index];
            const expectedBlock = blocks[index];
            const fetchedBlockHeight = fetchedBlock.signedBlock.block.header.number.toNumber();
            if (fetchedBlockHeight !== expectedBlock) {
              throw new Error(`Fetched SORA block ${fetchedBlockHeight} while indexing finalized block ${expectedBlock}`);
            }

            const valuationState = await this.ensureLiveValuationState(expectedBlock);
            await this.indexFetchedBlock(fetchedBlock, { historicalValuationState: valuationState });
            this.promoteLiveValuationState(valuationState);
            nextBlock = expectedBlock + 1;
          }
        } catch (error) {
          if (!this.isStopping()) {
            this.recordError(error);
            console.error(`Failed to index finalized block ${nextBlock}`, error);
            this.scheduleFinalizedHeadRetry();
          }
          return;
        }
      }

      if (this.finalizedHeadRetryTimer) {
        clearTimeout(this.finalizedHeadRetryTimer);
        this.finalizedHeadRetryTimer = null;
      }
    } catch (error) {
      if (!this.isStopping()) {
        this.recordError(error);
        console.error('Failed to drain finalized blocks', error);
        this.scheduleFinalizedHeadRetry();
      }
    } finally {
      this.finalizedHeadDrainRunning = false;
    }
  }

  private async indexBlockByNumber(block: number, options: IndexBlockOptions = {}): Promise<void> {
    if (!this.api) return;

    await this.indexFetchedBlock(await this.fetchBlockByNumber(block), options);
  }

  private async indexBlockByHash(hash: string, options: IndexBlockOptions = {}): Promise<void> {
    if (!this.api) return;

    await this.indexFetchedBlock(await this.fetchBlockByHash(hash), options);
  }

  private async fetchBlockByNumber(block: number, executeRpc?: RpcExecutor): Promise<FetchedBlock> {
    if (!this.api) throw new Error('Cannot fetch SORA block before the chain API is initialized');
    const runRpc: RpcExecutor =
      executeRpc ?? ((createRequest, label) => this.withRpcTimeout(createRequest, label));
    if (!Number.isSafeInteger(block) || block <= 0 || block > SORA_MAX_BLOCK_NUMBER) {
      throw new Error(`Cannot fetch invalid SORA block height ${block}`);
    }

    const blockApi = await this.getBlockDataApi();
    const hash = await runRpc(() => blockApi.rpc.chain.getBlockHash(block), `chain.getBlockHash(${block})`);
    const hashText = hash?.toString?.().toLowerCase() ?? '';
    if (!isNonzeroCanonicalSubstrateHash(hashText)) {
      throw new Error(`No SORA block hash available for block ${block} from the configured block data endpoint`);
    }
    if (blockApi !== this.api) {
      const primaryHash = await runRpc(
        () => this.api!.rpc.chain.getBlockHash(block),
        `primary.chain.getBlockHash(${block})`
      );
      const primaryHashText = primaryHash?.toString?.().toLowerCase() ?? '';
      if (!isNonzeroCanonicalSubstrateHash(primaryHashText) || primaryHashText !== hashText) {
        throw new Error(`SORA block data endpoint hash diverges from the primary endpoint at block ${block}`);
      }
    }

    const fetched = await this.fetchBlockByHash(hashText, runRpc);
    const fetchedHeight = fetched.signedBlock?.block?.header?.number?.toNumber?.();
    if (fetchedHeight !== block) {
      throw new Error(`SORA block data endpoint returned block ${fetchedHeight} for requested height ${block}`);
    }
    return fetched;
  }

  private async fetchBlockByHash(hash: string, executeRpc?: RpcExecutor): Promise<FetchedBlock> {
    if (!this.api) throw new Error('Cannot fetch SORA block before the chain API is initialized');
    const runRpc: RpcExecutor =
      executeRpc ?? ((createRequest, label) => this.withRpcTimeout(createRequest, label));
    const requestedHash = hash.toLowerCase();
    if (!isNonzeroCanonicalSubstrateHash(requestedHash)) {
      throw new Error('Cannot fetch a missing, zero, or malformed SORA block hash');
    }

    const blockApi = await this.getBlockDataApi();
    if (blockApi === this.api) {
      return (await this.fetchBlockPayloadFromApi(requestedHash, blockApi, false, runRpc)).fetchedBlock;
    }

    const [blockDataPayload, primaryPayload] = await Promise.all([
      this.fetchBlockPayloadFromApi(requestedHash, blockApi, true, runRpc),
      this.fetchBlockPayloadFromApi(requestedHash, this.api, true, runRpc),
    ]);
    if (blockDataPayload.blockHex !== primaryPayload.blockHex ||
        blockDataPayload.eventsHex !== primaryPayload.eventsHex ||
        blockDataPayload.timestampMilliseconds !== primaryPayload.timestampMilliseconds) {
      throw new Error(`SORA primary and block data endpoints returned different payloads for block ${requestedHash}`);
    }
    return blockDataPayload.fetchedBlock;
  }

  private async fetchBlockPayloadFromApi(
    hash: string,
    blockApi: ApiPromise,
    requireCanonicalBytes: boolean,
    executeRpc?: RpcExecutor
  ): Promise<FetchedBlockPayload> {
    const runRpc: RpcExecutor =
      executeRpc ?? ((createRequest, label) => this.withRpcTimeout(createRequest, label));
    const canFetchApiAt = typeof (blockApi as unknown as { at?: unknown }).at === 'function';
    if (!canFetchApiAt) {
      const [signedBlock, eventsCodec, timestamp] = await Promise.all([
        runRpc(() => this.fetchSignedBlock(hash, blockApi), `chain.getBlock(${hash})`),
        runRpc(() => (blockApi.query as any).system.events.at(hash), `system.events.at(${hash})`),
        this.fetchBlockTimestampIdentity(hash, blockApi, runRpc),
      ]);

      return {
        fetchedBlock: {
          requestedHash: hash,
          signedBlock,
          events: eventsCodec as unknown as EventRecord[],
          timestamp: timestamp.seconds,
        },
        blockHex: requireCanonicalBytes
          ? canonicalCodecHex((signedBlock as { block?: unknown })?.block, `SORA block ${hash}`)
          : null,
        eventsHex: requireCanonicalBytes ? canonicalCodecHex(eventsCodec, `SORA events ${hash}`) : null,
        timestampMilliseconds: timestamp.milliseconds,
      };
    }

    const apiAt = await this.fetchApiAtFrom(blockApi, hash, `SORA block ${hash}`, runRpc);
    const system = (apiAt.query as { system?: { events?: () => Promise<unknown> } }).system;
    const systemEvents = system?.events;
    const timestampNow = (apiAt.query as { timestamp?: { now?: () => Promise<unknown> } }).timestamp?.now;
    if (typeof systemEvents !== 'function') {
      throw new Error(`system.events is required to decode SORA block ${hash}`);
    }
    if (typeof timestampNow !== 'function') {
      throw new Error(`timestamp.now is required to decode SORA block ${hash}`);
    }

    const [signedBlock, eventsCodec, timestamp] = await Promise.all([
      runRpc(() => this.fetchSignedBlock(hash, blockApi), `chain.getBlock(${hash})`),
      runRpc(() => systemEvents.call(system), `system.events(${hash})`),
      runRpc(() => timestampNow(), `timestamp.now(${hash})`).then((codec) =>
        parseChainTimestamp(codec, `timestamp.now for block ${hash}`)
      ),
    ]);

    return {
      fetchedBlock: {
        requestedHash: hash,
        signedBlock,
        events: eventsCodec as unknown as EventRecord[],
        timestamp: timestamp.seconds,
      },
      blockHex: requireCanonicalBytes
        ? canonicalCodecHex((signedBlock as { block?: unknown })?.block, `SORA block ${hash}`)
        : null,
      eventsHex: requireCanonicalBytes ? canonicalCodecHex(eventsCodec, `SORA events ${hash}`) : null,
      timestampMilliseconds: timestamp.milliseconds,
    };
  }

  private async fetchSignedBlock(hash: string, api = this.api): Promise<unknown> {
    if (!this.api) throw new Error('Cannot fetch SORA block before the chain API is initialized');
    if (!api) throw new Error('Cannot fetch SORA block before the chain API is initialized');

    return api.rpc.chain.getBlock(hash);
  }

  private async getBlockDataApi(): Promise<ApiPromise> {
    if (this.isStopping()) throw new Error('Cannot initialize the SORA block data API during shutdown');

    if (!this.archiveSoraWsEndpoint && !this.config.legacySoraBlockTypes) {
      if (!this.api) throw new Error('Cannot fetch SORA block before the chain API is initialized');
      return this.api;
    }

    if (this.legacyBlockApi) return this.legacyBlockApi;

    if (this.legacyBlockApiPromise) return this.legacyBlockApiPromise;

    const endpoint = this.archiveSoraWsEndpoint || this.config.soraWsEndpoint;
    const provider = new WsProvider(endpoint);
    this.legacyBlockProvider = provider;
    const apiOptions = this.config.legacySoraBlockTypes
      ? { typesBundle: soraArchiveTypesBundle as any }
      : {};
    let creation: Promise<ApiPromise>;
    creation = this.withRpcTimeout(
      () => ApiPromise.create({ provider, ...apiOptions }),
      'SORA block data endpoint connection',
      undefined,
      (lateApi) => this.disconnectResource(lateApi, 'late SORA block data API')
    )
      .then(async (api) => {
        try {
          await this.requireMainnetIdentity(api, 'SORA block data endpoint');
          await this.requireReviewedMainnetAnchor(api, 'SORA block data endpoint');
          if (this.legacyBlockProvider === provider) this.legacyBlockProvider = null;
          if (this.legacyBlockApiPromise !== creation || !this.api || this.isStopping()) {
            throw new Error('PI block data endpoint startup was cancelled');
          }
          this.legacyBlockApi = api;
          return api;
        } catch (error) {
          await this.disconnectResource(api, 'SORA block data API');
          throw error;
        }
      })
      .catch(async (error: unknown) => {
        if (this.legacyBlockProvider === provider) this.legacyBlockProvider = null;
        await this.disconnectResource(provider, 'SORA block data WebSocket provider');
        if (this.legacyBlockApiPromise === creation) this.legacyBlockApiPromise = null;
        throw error;
      });
    this.legacyBlockApiPromise = creation;
    return creation;
  }

  private async getIndexableFinalizedBlock(): Promise<number> {
    if (!this.api) throw new Error('Cannot read finalized SORA block before the chain API is initialized');

    const localFinalizedBlock = await this.getFinalizedBlock(this.api, 'chain');
    this.updateFinalizedStatus(localFinalizedBlock);
    if (!this.archiveSoraWsEndpoint) return localFinalizedBlock;

    const blockDataApi = await this.getBlockDataApi();
    const blockDataFinalizedBlock = await this.getFinalizedBlock(blockDataApi, 'block data endpoint');
    if (blockDataFinalizedBlock < localFinalizedBlock) {
      console.warn(
        `Block data endpoint is behind localhost SORA: archive=${blockDataFinalizedBlock}, localhost=${localFinalizedBlock}`
      );
    }

    return Math.min(localFinalizedBlock, blockDataFinalizedBlock);
  }

  private async getFinalizedBlock(api: ApiPromise, label: string): Promise<number> {
    const finalizedHash = await this.withRpcTimeout(
      () => api.rpc.chain.getFinalizedHead(),
      `${label}.getFinalizedHead()`
    );
    const finalizedHashText = finalizedHash?.toString?.().toLowerCase() ?? '';
    const finalizedHeader = await this.withRpcTimeout(
      () => api.rpc.chain.getHeader(finalizedHash),
      `${label}.getHeader(${finalizedHashText})`
    );
    if (this.observedGenesisHash || this.enforceFinalizedIdentity) {
      if (!isNonzeroCanonicalSubstrateHash(finalizedHashText)) {
        throw new Error(`${label} returned a malformed finalized hash`);
      }
      const height = this.validatedFinalizedHeaderHeight(finalizedHeader, label);
      if (finalizedHeader.hash.toString().toLowerCase() !== finalizedHashText) {
        if (label === 'chain') {
          throw new Error(
            'primary SORA endpoint returned a malformed finalized header: malformed finalized block identity; header does not match requested hash'
          );
        }
        throw new Error(`${label} finalized header does not match its requested hash`);
      }
      return height;
    }

    const height = finalizedHeader?.number?.toNumber?.();
    if (!Number.isSafeInteger(height) || Number(height) < 0) {
      throw new Error(`${label} returned a malformed finalized header`);
    }
    return Number(height);
  }

  private validatedFinalizedHeaderHeight(
    header: { number: { toNumber: () => number }; hash: { toString: () => string } },
    label: string
  ): number {
    const height = header?.number?.toNumber?.();
    const hash = header?.hash?.toString?.().toLowerCase() ?? '';
    if (!Number.isSafeInteger(height) || Number(height) < SORA_LEGACY_IDENTITY_ANCHOR.block ||
        Number(height) > SORA_MAX_BLOCK_NUMBER ||
        !isNonzeroCanonicalSubstrateHash(hash)) {
      throw new Error(`${label} returned a malformed finalized header`);
    }
    return Number(height);
  }

  private decimalStringToScaledOrNull(value: unknown): bigint | null {
    if (value === null || value === undefined || value === '') return null;

    try {
      return decimalStringToScaled(value);
    } catch {
      return null;
    }
  }

  private readPositionCostBasis(position: IndexerDocument | null | undefined): bigint | null {
    if (!position) return null;

    const yesCostBasis = this.decimalStringToScaledOrNull(position.data.yesCostBasisUsd);
    const noCostBasis = this.decimalStringToScaledOrNull(position.data.noCostBasisUsd);
    if (yesCostBasis === null || noCostBasis === null) return null;

    return yesCostBasis + noCostBasis;
  }

  private readSideCostBasis(position: IndexerDocument, outcome: string): { shares: bigint; costBasis: bigint } | null {
    const normalizedOutcome = outcome.toLowerCase();
    const yesShares = this.decimalStringToScaledOrNull(position.data.yesShares) ?? 0n;
    const noShares = this.decimalStringToScaledOrNull(position.data.noShares) ?? 0n;
    const shares = normalizedOutcome === 'yes' ? yesShares : normalizedOutcome === 'no' ? noShares : 0n;
    const explicitCostBasis =
      normalizedOutcome === 'yes'
        ? this.decimalStringToScaledOrNull(position.data.yesCostBasisUsd)
        : normalizedOutcome === 'no'
          ? this.decimalStringToScaledOrNull(position.data.noCostBasisUsd)
          : null;

    if (shares <= 0n) return null;
    if (explicitCostBasis !== null) return { shares, costBasis: explicitCostBasis };

    return null;
  }

  private async enrichSellRealizedPnl(context: BlockExtrinsicContext, data: Record<string, unknown>): Promise<string | null> {
    const marketId = Number(data.marketId ?? data.market_id ?? 0);
    const account = context.history.from || context.address;
    const outcome = firstString(data, ['outcome', 'toOutcome', 'to_outcome']);
    const sharesSold = this.decimalStringToScaledOrNull(data.shares ?? data.sharesAmount ?? data.shareAmount);
    const collateralOut = this.decimalStringToScaledOrNull(data.collateralUsd ?? data.collateralAmountUsd);
    if (!Number.isSafeInteger(marketId) || !account || !outcome || sharesSold === null || collateralOut === null) return null;

    const position = await this.repository.get(collection('accountPositions'), `${marketId}-${account}`);
    if (!position) return null;

    const sideCostBasis = this.readSideCostBasis(position, outcome);
    if (!sideCostBasis || sideCostBasis.shares <= 0n) return null;

    const basisReduction =
      sharesSold >= sideCostBasis.shares
        ? sideCostBasis.costBasis
        : (sideCostBasis.costBasis * sharesSold) / sideCostBasis.shares;

    return decimalToString(collateralOut - basisReduction, DECIMALS, 8);
  }

  private async enrichClaimRealizedPnl(context: BlockExtrinsicContext): Promise<string | null> {
    const claims = findEvents(context.events, 'polkamarkt', 'MarketClaimed');
    const account = context.history.from || context.address;
    if (!claims.length || !account) return null;

    let payoutTotal = 0n;
    let basisTotal = 0n;

    for (const claim of claims) {
      const trader = firstString(claim, ['trader', 'account', 'arg1']) || account;
      if (trader !== account) return null;

      const marketId = Number(claim.marketId ?? claim.arg0 ?? 0);
      if (!Number.isSafeInteger(marketId)) return null;

      const position = await this.repository.get(collection('accountPositions'), `${marketId}-${trader}`);
      const costBasis = this.readPositionCostBasis(position);
      if (costBasis === null) return null;

      payoutTotal += this.safeCodecToBigInt(firstPresentValue(claim, ['payout', 'amount', 'arg2']) ?? 0);
      basisTotal += costBasis;
    }

    return decimalToString(payoutTotal - basisTotal, DECIMALS, 8);
  }

  private async enrichPolkamarktRealizedPnl(contexts: BlockExtrinsicContext[]): Promise<void> {
    await Promise.all(
      contexts.map(async (context) => {
        if (context.failed || context.module !== 'polkamarkt' || !isRecord(context.history.data)) return;

        const data = context.history.data;
        const side = String(data.side ?? '').toLowerCase();
        const realizedPnlUsd =
          side === 'sell'
            ? await this.enrichSellRealizedPnl(context, data)
            : side === 'claim'
              ? await this.enrichClaimRealizedPnl(context)
              : null;

        if (realizedPnlUsd === null) return;

        context.history = {
          ...context.history,
          data: {
            ...data,
            realizedPnlUsd,
          },
        };
      })
    );
  }

  private async indexFetchedBlock({ requestedHash, signedBlock, events, timestamp }: FetchedBlock, options: IndexBlockOptions = {}): Promise<void> {
    if (this.isStopping()) return;

    const eventsByExtrinsic = groupEventsByExtrinsic(events);
    const blockHeight = signedBlock.block.header.number.toNumber();
    const blockHash = signedBlock.block.header.hash.toString();
    const canonicalBlockHash = blockHash.toLowerCase();
    if (
      (this.observedGenesisHash || this.enforceFinalizedIdentity) &&
      (!isNonzeroCanonicalSubstrateHash(canonicalBlockHash) || canonicalBlockHash !== requestedHash)
    ) {
      throw new Error(`SORA block data endpoint returned a block that does not match requested hash ${requestedHash}`);
    }
    const historicalValuationState = options.historicalValuationState;
    if (
      historicalValuationState &&
      historicalValuationState.blockHeight !== Math.max(0, blockHeight - 1)
    ) {
      throw new Error(
        `Historical valuation state at block ${historicalValuationState.blockHeight} cannot value SORA block ${blockHeight}`
      );
    }
    const valuationAssets = historicalValuationState?.assets ?? this.assetInfos;
    const valuationPrices = historicalValuationState?.prices ?? this.prices;
    const valuationLiquidityStats =
      historicalValuationState?.networkLiquidityStats ?? this.networkLiquidityStats;
    const documents: IndexerDocument[] = [];
    const touchedAccounts = new Set<string>();
    let totalFees = 0n;
    let feePayingSignedTransactions = 0;
    let volumeUSD = 0n;
    let swaps = 0;
    let bridgeIncomingTransactions = 0;
    let bridgeOutgoingTransactions = 0;
    const accountPointData = new Map<string, Record<string, unknown>>();
    const extrinsicContexts: BlockExtrinsicContext[] = [];
    const latestHistoryByAccount = new Map<string, string>();

    for (const [index, extrinsic] of signedBlock.block.extrinsics.entries()) {
      const eventsForExtrinsic = eventsByExtrinsic.get(index) ?? [];
      const failed = eventsForExtrinsic.find(({ event }) => event.section === 'system' && event.method === 'ExtrinsicFailed');
      const historyEvents = failed && extrinsic.method.section === 'polkamarkt' ? [] : eventsForExtrinsic;
      const args = codecArgs(extrinsic.method as any);
      const calls = getUtilityCalls(extrinsic as any);
      const callNames = calls.map((call) => `${call.module}.${call.method}`);
      const address = getSigner(extrinsic as any);
      const history = createHistoryData(
        extrinsic.method.section,
        extrinsic.method.method,
        args,
        historyEvents,
        address,
        valuationPrices,
        valuationAssets
      );
      const id = extrinsic.hash?.toString?.() || `${blockHeight}-${index}`;
      const fee = this.extractNetworkFee(eventsForExtrinsic);
      if (extrinsic.isSigned && fee > 0n) feePayingSignedTransactions += 1;
      const currentAccounts = historyIndexedAccounts(extrinsic.method.section, extrinsic.method.method, address, history);
      totalFees += fee;
      if (!failed) volumeUSD += this.extractVolumeUSD(history.data);
      if (!failed && isLiquidityProxySwap(extrinsic.method.section, extrinsic.method.method, callNames)) {
        swaps += 1;
      }
      if (!failed && extrinsic.method.section === 'bridgeMultisig') bridgeIncomingTransactions += 1;
      if (!failed && isBridgeOutgoing(extrinsic.method.section, extrinsic.method.method)) {
        bridgeOutgoingTransactions += 1;
      }
      currentAccounts.forEach((account) => touchedAccounts.add(account));
      const context = {
        id,
        module: extrinsic.method.section,
        method: extrinsic.method.method,
        address,
        failed: Boolean(failed),
        history,
        calls,
        callNames,
        events: eventsForExtrinsic,
        accounts: currentAccounts,
        fee,
      };
      extrinsicContexts.push(context);

      const incomingContext = createBridgeProxyIncomingContext(context, args, valuationPrices, valuationAssets);
      if (incomingContext) {
        volumeUSD += this.extractVolumeUSD(incomingContext.history.data);
        bridgeIncomingTransactions += 1;
        incomingContext.accounts.forEach((account) => touchedAccounts.add(account));
        extrinsicContexts.push(incomingContext);
      }
    }

    const shouldRefreshPolkamarktState = extrinsicContexts.some(isPolkamarktTradeContext);
    await this.enrichPolkamarktRealizedPnl(extrinsicContexts);
    if (this.isStopping()) return;
    const historicalValuationAdvance = historicalValuationState
      ? await this.prepareHistoricalValuationAdvance(
          historicalValuationState,
          blockHeight,
          extrinsicContexts,
          events
        )
      : null;
    if (this.isStopping()) return;
    const existingAccountMeta = await this.repository.getMany(collection('accountMeta'), [...touchedAccounts]);
    const orderBookLiquidityComplete =
      historicalValuationState?.orderBookLiquidityComplete ?? true;

    for (const context of extrinsicContexts) {
      const historyDocument = this.createHistoryElementDocument(context, blockHeight, timestamp, blockHash);
      documents.push(historyDocument);
      documents.push(...this.createAccountTransactionDocuments(context, blockHeight, timestamp, historyDocument));
      if (!context.failed) documents.push(...createXorBurnDocuments(context, blockHeight, timestamp, valuationAssets));
      context.accounts.forEach((account) => latestHistoryByAccount.set(account, context.id));
      this.applyAccountPointUpdates(
        context.accounts,
        blockHeight,
        timestamp,
        accountPointData,
        {
          module: context.module,
          method: context.method,
          data: context.history.data,
          fee: context.fee,
          failed: context.failed,
        },
        existingAccountMeta,
        valuationPrices
      );
      documents.push(
        ...this.createEventDocuments(
          context.events,
          blockHeight,
          timestamp,
          context.address,
          valuationPrices,
          valuationAssets
        )
      );
    }

    documents.push(
      ...this.createFinalAccountDocuments([...touchedAccounts], latestHistoryByAccount, blockHeight, timestamp, accountPointData)
    );

    const newAccountCount = [...touchedAccounts].filter((account) => !existingAccountMeta.has(account)).length;

    const networkBlockDocument: IndexerDocument = {
      collection: collection('networkSnapshots'),
      id: `block-${blockHeight}`,
      blockHeight,
      timestamp,
      data: {
        id: `block-${blockHeight}`,
        type: 'BLOCK',
        timestamp,
        accounts: newAccountCount,
        transactions: feePayingSignedTransactions,
        fees: totalFees.toString(),
        liquidityUSD: orderBookLiquidityComplete ? valuationLiquidityStats.liquidityUSD : null,
        poolLiquidityUSD: valuationLiquidityStats.poolLiquidityUSD,
        orderBookLiquidityUSD: orderBookLiquidityComplete
          ? valuationLiquidityStats.orderBookLiquidityUSD
          : null,
        volumeUSD: scaledToString(volumeUSD, 8),
        swaps,
        activePools: valuationLiquidityStats.activePools,
        activeOrderBooks: orderBookLiquidityComplete
          ? valuationLiquidityStats.activeOrderBooks
          : null,
        listedAssets: valuationLiquidityStats.listedAssets,
        bridgeIncomingTransactions,
        bridgeOutgoingTransactions,
      },
    };
    documents.push(networkBlockDocument);

    const networkAggregateWindows = options.networkAggregateWindows;
    if (networkAggregateWindows) {
      const block = this.networkBackfillBlockFromSnapshot(networkBlockDocument);
      if (!block) throw new Error(`Cannot aggregate invalid network snapshot for SORA block ${blockHeight}`);

      for (const window of networkAggregateWindows) {
        const nextDocument = this.advanceNetworkBackfillWindow(window, block);
        if (
          window.pendingDocument &&
          window.pendingDocument.id !== nextDocument.id &&
          this.shouldPersistBackfillNetworkAggregate(
            window.pendingDocument,
            options.backfillRetentionTimestamp
          )
        ) {
          documents.push(window.pendingDocument);
        }
        window.pendingDocument = nextDocument;
        if (
          options.flushNetworkAggregates &&
          this.shouldPersistBackfillNetworkAggregate(nextDocument, options.backfillRetentionTimestamp)
        ) {
          documents.push(nextDocument);
        }
      }
    }

    documents.push(this.createChainStateDocument(blockHeight, canonicalBlockHash, timestamp));
    if (this.isStopping()) return;
    const preparedDocuments = await this.prepareReferrerRewardDocuments(documents);
    if (this.isStopping()) return;
    // A finalized block contains read-modify-write account/referral totals and
    // its checkpoint. Keep that set in one validated backend transaction: an
    // oversized block must fail before any document is written, because
    // chunking would make a crash retry double-apply those totals.
    await this.repository.upsertMany(preparedDocuments);
    if (historicalValuationState && historicalValuationAdvance) {
      this.applyHistoricalValuationAdvance(historicalValuationState, historicalValuationAdvance);
    }
    this.updateIndexedStatus(blockHeight, Math.floor(Date.now() / 1_000));
    if (options.retireExpiredNetworkBlocks) {
      // Persist then retire a rolling 31-day input horizon. Skipping the input
      // write outright would make crash-resume aggregation incorrect.
      try {
        await this.retireExpiredNetworkBlockSnapshots(timestamp);
      } catch (error) {
        // The block transaction and checkpoint already committed. Retrying
        // the block would double-apply read-modify-write account totals, so
        // leave cleanup rows in place and retry retention at the next batch.
        this.recordError(error);
        console.error(`Failed to retire network block snapshots after SORA block ${blockHeight}`, error);
      }
    }
    if (this.isStopping()) return;
    this.markDerivedStorageDomainsDirtyFromBlock(extrinsicContexts, events);

    if ((options.refreshDerivedState ?? true) && shouldRefreshPolkamarktState) {
      this.requestPolkamarktStateRefresh(blockHeight, timestamp, true);
    }
    if (
      (options.refreshDerivedState ?? true) &&
      (blockHeight % this.config.stateRefreshIntervalBlocks === 0 ||
        blockHeight % this.config.fullReconciliationIntervalBlocks === 0)
    ) {
      this.requestDerivedStateRefresh(
        blockHeight,
        timestamp,
        blockHeight % this.config.snapshotIntervalBlocks === 0,
        blockHeight % this.config.fullReconciliationIntervalBlocks === 0
      );
    }
    if (
      (options.refreshDerivedState ?? true) &&
      this.config.priceStreamRefreshIntervalBlocks > 0 &&
      blockHeight % this.config.priceStreamRefreshIntervalBlocks === 0
    ) {
      this.requestPriceStreamRefresh(blockHeight, timestamp);
    }
  }

  private mergeDerivedStateRefreshRequests(
    left: DerivedStateRefreshRequest | null,
    right: DerivedStateRefreshRequest | null
  ): DerivedStateRefreshRequest | null {
    if (!left) return right;
    if (!right) return left;

    const latest = left.blockHeight >= right.blockHeight ? left : right;
    return {
      ...latest,
      includeSnapshots: left.includeSnapshots || right.includeSnapshots,
      forceFullReconciliation: left.forceFullReconciliation || right.forceFullReconciliation,
    };
  }

  private requestDerivedStateRefresh(
    blockHeight: number,
    timestamp: number,
    includeSnapshots: boolean,
    forceFullReconciliation = false
  ): void {
    if (this.isStopping()) return;
    this.pendingDerivedStateRefresh = this.mergeDerivedStateRefreshRequests(this.pendingDerivedStateRefresh, {
      blockHeight,
      timestamp,
      includeSnapshots,
      forceFullReconciliation,
    });
    if (this.lifecycleState === 'starting') return;
    this.trackBackgroundTask(this.drainDerivedStateRefreshQueue());
  }

  private requestPolkamarktStateRefresh(blockHeight: number, timestamp: number, includeSnapshots: boolean): void {
    if (this.isStopping()) return;
    this.pendingPolkamarktStateRefresh = this.mergeDerivedStateRefreshRequests(this.pendingPolkamarktStateRefresh, {
      blockHeight,
      timestamp,
      includeSnapshots,
    });
    if (this.lifecycleState === 'starting') return;
    this.trackBackgroundTask(this.drainPolkamarktStateRefreshQueue());
  }

  private scheduleDerivedStateRefreshRetry(): void {
    if (this.isStopping() || this.derivedStateRefreshRetryTimer) return;

    this.derivedStateRefreshRetryTimer = setTimeout(() => {
      this.derivedStateRefreshRetryTimer = null;
      if (this.isStopping()) return;
      this.trackBackgroundTask(this.drainDerivedStateRefreshQueue());
    }, DERIVED_STATE_REFRESH_RETRY_DELAY_MS);
    this.derivedStateRefreshRetryTimer.unref?.();
  }

  private async drainDerivedStateRefreshQueue(): Promise<void> {
    if (this.isStopping() || this.derivedStateRefreshRunning) return;

    const request = this.pendingDerivedStateRefresh;
    if (!request) return;

    this.pendingDerivedStateRefresh = null;
    this.derivedStateRefreshRunning = true;

    try {
      await this.refreshDerivedState(
        request.blockHeight,
        request.timestamp,
        request.includeSnapshots,
        request.forceFullReconciliation
      );
      if (this.derivedStateRefreshRetryTimer) {
        clearTimeout(this.derivedStateRefreshRetryTimer);
        this.derivedStateRefreshRetryTimer = null;
      }
    } catch (error) {
      if (!this.isStopping()) {
        this.recordError(error);
        console.error(`Failed to refresh derived state at SORA block ${request.blockHeight}`, error);
        this.pendingDerivedStateRefresh = this.mergeDerivedStateRefreshRequests(request, this.pendingDerivedStateRefresh);
        this.scheduleDerivedStateRefreshRetry();
      }
    } finally {
      this.derivedStateRefreshRunning = false;
    }

    if (!this.isStopping() && this.pendingDerivedStateRefresh && !this.derivedStateRefreshRetryTimer) {
      this.trackBackgroundTask(this.drainDerivedStateRefreshQueue());
    }
  }

  private schedulePolkamarktStateRefreshRetry(): void {
    if (this.isStopping() || this.polkamarktStateRefreshRetryTimer) return;

    this.polkamarktStateRefreshRetryTimer = setTimeout(() => {
      this.polkamarktStateRefreshRetryTimer = null;
      if (this.isStopping()) return;
      this.trackBackgroundTask(this.drainPolkamarktStateRefreshQueue());
    }, DERIVED_STATE_REFRESH_RETRY_DELAY_MS);
    this.polkamarktStateRefreshRetryTimer.unref?.();
  }

  private async drainPolkamarktStateRefreshQueue(): Promise<void> {
    if (this.isStopping() || this.polkamarktStateRefreshRunning) return;

    const request = this.pendingPolkamarktStateRefresh;
    if (!request) return;

    this.pendingPolkamarktStateRefresh = null;
    this.polkamarktStateRefreshRunning = true;

    try {
      await this.refreshPolkamarktState(request.blockHeight, request.timestamp, request.includeSnapshots);
      if (this.polkamarktStateRefreshRetryTimer) {
        clearTimeout(this.polkamarktStateRefreshRetryTimer);
        this.polkamarktStateRefreshRetryTimer = null;
      }
    } catch (error) {
      if (!this.isStopping()) {
        this.recordError(error);
        console.error(`Failed to refresh Polkamarkt state at SORA block ${request.blockHeight}`, error);
        this.pendingPolkamarktStateRefresh = this.mergeDerivedStateRefreshRequests(
          request,
          this.pendingPolkamarktStateRefresh
        );
        this.schedulePolkamarktStateRefreshRetry();
      }
    } finally {
      this.polkamarktStateRefreshRunning = false;
    }

    if (!this.isStopping() && this.pendingPolkamarktStateRefresh && !this.polkamarktStateRefreshRetryTimer) {
      this.trackBackgroundTask(this.drainPolkamarktStateRefreshQueue());
    }
  }

  private mergePriceStreamRefreshRequests(
    left: PriceStreamRefreshRequest | null,
    right: PriceStreamRefreshRequest | null
  ): PriceStreamRefreshRequest | null {
    if (!left) return right;
    if (!right) return left;

    return left.blockHeight >= right.blockHeight ? left : right;
  }

  private requestPriceStreamRefresh(blockHeight: number, timestamp: number): void {
    if (this.isStopping()) return;
    this.pendingPriceStreamRefresh = this.mergePriceStreamRefreshRequests(this.pendingPriceStreamRefresh, {
      blockHeight,
      timestamp,
    });
    if (this.lifecycleState === 'starting') return;
    this.trackBackgroundTask(this.drainPriceStreamRefreshQueue());
  }

  private schedulePriceStreamRefreshRetry(): void {
    if (this.isStopping() || this.priceStreamRefreshRetryTimer) return;

    this.priceStreamRefreshRetryTimer = setTimeout(() => {
      this.priceStreamRefreshRetryTimer = null;
      if (this.isStopping()) return;
      this.trackBackgroundTask(this.drainPriceStreamRefreshQueue());
    }, DERIVED_STATE_REFRESH_RETRY_DELAY_MS);
    this.priceStreamRefreshRetryTimer.unref?.();
  }

  private async drainPriceStreamRefreshQueue(): Promise<void> {
    if (this.isStopping() || this.priceStreamRefreshRunning) return;

    const request = this.pendingPriceStreamRefresh;
    if (!request) return;

    this.pendingPriceStreamRefresh = null;
    this.priceStreamRefreshRunning = true;

    try {
      await this.refreshPriceStream(request.blockHeight, request.timestamp);
      if (this.priceStreamRefreshRetryTimer) {
        clearTimeout(this.priceStreamRefreshRetryTimer);
        this.priceStreamRefreshRetryTimer = null;
      }
    } catch (error) {
      if (!this.isStopping()) {
        this.recordError(error);
        console.error(`Failed to refresh price stream at SORA block ${request.blockHeight}`, error);
        this.pendingPriceStreamRefresh = this.mergePriceStreamRefreshRequests(request, this.pendingPriceStreamRefresh);
        this.schedulePriceStreamRefreshRetry();
      }
    } finally {
      this.priceStreamRefreshRunning = false;
    }

    if (!this.isStopping() && this.pendingPriceStreamRefresh && !this.priceStreamRefreshRetryTimer) {
      this.trackBackgroundTask(this.drainPriceStreamRefreshQueue());
    }
  }

  private extractNetworkFee(events: EventRecord[]): bigint {
    let total = 0n;

    for (const { event } of events) {
      if (event.section === 'xorFee' && event.method === 'FeeWithdrawn') {
        const data = eventData(event);
        total += codecToBigInt(data.amount ?? data.fee ?? data.arg1 ?? data.arg0 ?? 0);
      }
    }

    return total;
  }

  /** Returns the direct XOR burn portion of a withdrawn XOR fee using the runtime split weights. */
  private extractXorFeeBurn(networkFee: unknown): bigint {
    const fee = codecToBigInt(networkFee);
    if (fee <= 0n) return 0n;

    const [, afterReferrer] = splitByRatio(
      fee,
      FEE_REFERRER_WEIGHT,
      FEE_XOR_BURNED_WEIGHT + FEE_VAL_BURNED_WEIGHT + FEE_KUSD_BURNED_WEIGHT
    );
    const [, xorAndKusd] = splitByRatio(
      afterReferrer,
      FEE_VAL_BURNED_WEIGHT,
      FEE_XOR_BURNED_WEIGHT + FEE_KUSD_BURNED_WEIGHT
    );
    const [, xorBurned] = splitByRatio(xorAndKusd, FEE_KUSD_BURNED_WEIGHT, FEE_XOR_BURNED_WEIGHT);

    return xorBurned;
  }

  /**
   * Combines ORML token issuance with native Balances issuance, which is where XOR supply is stored.
   * All supplies are persisted as codec-scale strings matching the asset precision exposed by chain metadata.
   */
  private createSupplyByAsset(
    tokenIssuances: Array<[StorageEntryKey, unknown]>,
    nativeXorIssuance: unknown
  ): Map<string, bigint> {
    const supplyByAsset = new Map<string, bigint>();

    for (const [key, value] of tokenIssuances) {
      supplyByAsset.set(assetIdToString(key.args[0]), codecToBigInt(value));
    }

    supplyByAsset.set(XOR, codecToBigInt(nativeXorIssuance));
    return supplyByAsset;
  }

  private async fetchNativeXorIssuance(query: any = this.api?.query): Promise<unknown> {
    if (!query) throw new Error('Cannot refresh native XOR supply before the chain API is initialized');

    const balances = query.balances;
    if (typeof balances?.totalIssuance !== 'function') {
      throw new Error('balances.totalIssuance is required to refresh native XOR supply');
    }

    return this.withRpcTimeout(
      () => balances.totalIssuance.call(balances),
      'balances.totalIssuance()'
    );
  }

  private async fetchNativeXorIssuanceAtBlock(blockHeight: number): Promise<bigint> {
    if (!this.api) throw new Error('Cannot repair native XOR supply before the chain API is initialized');

    const blockApi = await this.getBlockDataApi();
    const hash = await this.withRpcTimeout(
      () => blockApi.rpc.chain.getBlockHash(blockHeight),
      `chain.getBlockHash(${blockHeight})`
    );
    const hashText = hash?.toString?.() ?? '';
    if (!hashText || /^0x0+$/.test(hashText)) {
      throw new Error(`No SORA block hash available for block ${blockHeight} from the configured block data endpoint`);
    }

    const apiAt = await this.fetchApiAtFrom(blockApi, hashText, `SORA block ${blockHeight}`);
    const balances = (apiAt.query as { balances?: { totalIssuance?: () => Promise<unknown> } }).balances;
    if (typeof balances?.totalIssuance !== 'function') {
      throw new Error(`balances.totalIssuance is required to repair XOR supply at SORA block ${blockHeight}`);
    }

    return codecToBigInt(
      await this.withRpcTimeout(
        () => balances.totalIssuance!.call(balances),
        `balances.totalIssuance(${blockHeight})`
      )
    );
  }

  private async fetchStorageEntries(
    storage: unknown,
    label: string,
    ...args: unknown[]
  ): Promise<Array<[StorageEntryKey, unknown]>> {
    const entriesPaged = (
      storage as
        | {
            entriesPaged?: (options: {
              args: unknown[];
              pageSize: number;
              startKey?: string;
            }) => Promise<StorageEntries>;
          }
        | undefined
    )?.entriesPaged;

    if (typeof entriesPaged !== 'function') {
      throw new Error(`${label}.entriesPaged is required to refresh derived state`);
    }

    return this.fetchStorageEntriesPaged(storage, entriesPaged, label, args);
  }

  private async fetchOptionalStorageEntries(
    storage: unknown,
    label: string,
    ...args: unknown[]
  ): Promise<Array<[StorageEntryKey, unknown]>> {
    const entriesPaged = (
      storage as
        | {
            entriesPaged?: (options: {
              args: unknown[];
              pageSize: number;
              startKey?: string;
            }) => Promise<StorageEntries>;
          }
        | undefined
    )?.entriesPaged;

    if (typeof entriesPaged !== 'function') return [];
    return this.fetchStorageEntriesPaged(storage, entriesPaged, label, args);
  }

  private createDerivedStorageLoadBudget(): DerivedStorageRetainedLoadBudget {
    return {
      maximumBytes: this.config.derivedStorageLoadMaxBytes,
      retainedBytes: 0,
      activeLoads: 0,
      idleWaiters: [],
    };
  }

  private async withDerivedStorageLoadBudget<T>(task: () => Promise<T>): Promise<T> {
    if (this.activeDerivedStorageLoadBudget) return task();

    const budget = this.createDerivedStorageLoadBudget();
    this.activeDerivedStorageLoadBudget = budget;
    metrics.setGauge('indexer_worker_derived_storage_load_retained_bytes', {}, 0);
    let value: T | undefined;
    let failure: unknown;
    let failed = false;
    try {
      value = await task();
    } catch (error) {
      failed = true;
      failure = error;
    }

    // Promise.all rejects on the first failed storage map while sibling RPC
    // pages continue. Keep the shared budget installed and wait for every
    // registered loader before allowing the next pinned projection to start.
    if (budget.activeLoads > 0) {
      await new Promise<void>((resolve) => budget.idleWaiters.push(resolve));
    }
    if (this.activeDerivedStorageLoadBudget === budget) this.activeDerivedStorageLoadBudget = null;
    metrics.setGauge('indexer_worker_derived_storage_load_retained_bytes', {}, 0);
    if (failed) throw failure;
    return value as T;
  }

  private storageEntryKeyFingerprint(key: StorageEntryKey): string | null {
    try {
      const hex = key.toHex?.();
      if (typeof hex === 'string' && hex.length > 0) return `hex:${hex}`;
    } catch {
      // Fall through to decoded arguments for defensive test/runtime codecs.
    }

    try {
      const rendered = key.toString?.();
      if (typeof rendered === 'string' && rendered.length > 0 && rendered !== '[object Object]') {
        return `string:${rendered}`;
      }
    } catch {
      // Fall through to decoded arguments.
    }

    try {
      return `args:${JSON.stringify(
        key.args.map((argument) => {
          if (argument && typeof argument === 'object') {
            const codec = argument as CodecLike;
            try {
              const hex = codec.toHex?.();
              if (typeof hex === 'string') return hex;
            } catch {
              // Use the stable string representation below.
            }
            try {
              return codec.toString?.() ?? String(argument);
            } catch {
              return '[unrenderable]';
            }
          }
          return String(argument);
        })
      )}`;
    } catch {
      return null;
    }
  }

  private retainDerivedStorageEntry(
    entry: [StorageEntryKey, unknown],
    budget: DerivedStorageRetainedLoadBudget,
    label: string
  ): void {
    const remaining = Math.max(0, budget.maximumBytes - budget.retainedBytes);
    const estimatedBytes =
      estimateRetainedValueBytes(
        entry,
        Math.max(0, remaining - DERIVED_STORAGE_RETAINED_ENTRY_OVERHEAD_BYTES)
      ) + DERIVED_STORAGE_RETAINED_ENTRY_OVERHEAD_BYTES;
    if (estimatedBytes > remaining) {
      metrics.increment('indexer_worker_derived_storage_load_rejections_total', {
        storage: label,
        reason: 'byte-budget',
      });
      throw new Error(
        `Derived storage load exceeds its ${budget.maximumBytes} byte retained-load limit while reading ${label}`
      );
    }
    budget.retainedBytes += estimatedBytes;
    metrics.setGauge('indexer_worker_derived_storage_load_retained_bytes', {}, budget.retainedBytes);
  }

  private async fetchStorageEntriesPaged(
    storage: unknown,
    entriesPaged: (options: {
      args: unknown[];
      pageSize: number;
      startKey?: string;
    }) => Promise<StorageEntries>,
    label: string,
    args: unknown[]
  ): Promise<StorageEntries> {
    const inheritedBudget = this.activeDerivedStorageLoadBudget;
    const budget = inheritedBudget ?? this.createDerivedStorageLoadBudget();
    budget.activeLoads += 1;
    const retained: StorageEntries = [];
    let startKey: string | undefined;
    let startFingerprint: string | null = null;

    try {
      while (true) {
        const page = await this.withRpcTimeout(
          () =>
            entriesPaged.call(storage, {
              args,
              pageSize: DERIVED_STORAGE_ENTRIES_PAGE_SIZE,
              ...(startKey ? { startKey } : {}),
            }),
          `${label}.entriesPaged()`
        );
        if (!Array.isArray(page)) throw new Error(`${label}.entriesPaged() returned a non-array page`);
        if (page.length > DERIVED_STORAGE_ENTRIES_PAGE_SIZE) {
          throw new Error(
            `${label}.entriesPaged() returned ${page.length} entries for page size ${DERIVED_STORAGE_ENTRIES_PAGE_SIZE}`
          );
        }
        if (!page.length) break;

        const firstFingerprint = this.storageEntryKeyFingerprint(page[0]![0]);
        if (startFingerprint !== null && firstFingerprint === startFingerprint) {
          throw new Error(`${label}.entriesPaged() repeated its startKey without exclusive progress`);
        }

        for (const entry of page) {
          if (!Array.isArray(entry) || entry.length !== 2 || !entry[0] || !Array.isArray(entry[0].args)) {
            throw new Error(`${label}.entriesPaged() returned an invalid storage entry`);
          }
          this.retainDerivedStorageEntry(entry, budget, label);
          retained.push(entry);
        }
        metrics.increment('indexer_worker_derived_storage_load_pages_total', { storage: label });
        metrics.increment('indexer_worker_derived_storage_load_entries_total', { storage: label }, page.length);

        if (page.length < DERIVED_STORAGE_ENTRIES_PAGE_SIZE) break;
        const nextStartKeyCodec = page[page.length - 1]![0];
        let nextStartKey: string;
        try {
          nextStartKey = nextStartKeyCodec.toHex?.() ?? '';
        } catch {
          nextStartKey = '';
        }
        if (!nextStartKey || !/^0x[0-9a-f]+$/i.test(nextStartKey)) {
          throw new Error(`${label}.entriesPaged() returned a storage key without a hex continuation encoding`);
        }
        const nextFingerprint = `hex:${nextStartKey}`;
        if (nextFingerprint === startFingerprint) {
          throw new Error(`${label}.entriesPaged() made no continuation progress`);
        }
        startKey = nextStartKey;
        startFingerprint = nextFingerprint;
      }

      return retained;
    } finally {
      budget.activeLoads -= 1;
      if (budget.activeLoads === 0) {
        const waiters = budget.idleWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
    }
  }

  /**
   * Streams storage pages into a compact retained representation. The active
   * budget accounts for the already-converted state plus the complete current
   * codec page, then releases page bytes before requesting another page.
   */
  private async consumeStorageEntriesPaged(
    storage: unknown,
    label: string,
    args: unknown[],
    consume: (entry: [StorageEntryKey, unknown]) => unknown
  ): Promise<void> {
    const entriesPaged = (
      storage as
        | {
            entriesPaged?: (options: {
              args: unknown[];
              pageSize: number;
              startKey?: string;
            }) => Promise<StorageEntries>;
          }
        | undefined
    )?.entriesPaged;
    if (typeof entriesPaged !== 'function') {
      throw new Error(`${label}.entriesPaged is required to refresh historical valuation`);
    }
    const inheritedBudget = this.activeDerivedStorageLoadBudget;
    const budget = inheritedBudget ?? this.createDerivedStorageLoadBudget();
    budget.activeLoads += 1;
    let startKey: string | undefined;
    let startFingerprint: string | null = null;
    try {
      while (true) {
        const page = await this.withRpcTimeout(
          () =>
            entriesPaged.call(storage, {
              args,
              pageSize: DERIVED_STORAGE_ENTRIES_PAGE_SIZE,
              ...(startKey ? { startKey } : {}),
            }),
          `${label}.entriesPaged()`
        );
        if (!Array.isArray(page)) throw new Error(`${label}.entriesPaged() returned a non-array page`);
        if (page.length > DERIVED_STORAGE_ENTRIES_PAGE_SIZE) {
          throw new Error(
            `${label}.entriesPaged() returned ${page.length} entries for page size ${DERIVED_STORAGE_ENTRIES_PAGE_SIZE}`
          );
        }
        if (!page.length) break;
        const firstFingerprint = this.storageEntryKeyFingerprint(page[0]![0]);
        if (startFingerprint !== null && firstFingerprint === startFingerprint) {
          throw new Error(`${label}.entriesPaged() repeated its startKey without exclusive progress`);
        }

        let pageBytes = 0;
        for (const entry of page) {
          if (!Array.isArray(entry) || entry.length !== 2 || !entry[0] || !Array.isArray(entry[0].args)) {
            throw new Error(`${label}.entriesPaged() returned an invalid storage entry`);
          }
          const remaining = Math.max(0, budget.maximumBytes - budget.retainedBytes - pageBytes);
          const bytes =
            estimateRetainedValueBytes(
              entry,
              Math.max(0, remaining - DERIVED_STORAGE_RETAINED_ENTRY_OVERHEAD_BYTES)
            ) + DERIVED_STORAGE_RETAINED_ENTRY_OVERHEAD_BYTES;
          if (bytes > remaining) {
            metrics.increment('indexer_worker_derived_storage_load_rejections_total', {
              storage: label,
              reason: 'byte-budget',
            });
            throw new Error(
              `Historical valuation load exceeds its ${budget.maximumBytes} byte peak retained-load limit while reading ${label}`
            );
          }
          pageBytes += bytes;
        }

        let convertedBytes = 0;
        for (const entry of page) {
          const retainedValue = consume(entry);
          const remaining = Math.max(
            0,
            budget.maximumBytes - budget.retainedBytes - pageBytes - convertedBytes
          );
          const bytes =
            estimateRetainedValueBytes(
              retainedValue,
              Math.max(0, remaining - DERIVED_STORAGE_RETAINED_ENTRY_OVERHEAD_BYTES)
            ) + DERIVED_STORAGE_RETAINED_ENTRY_OVERHEAD_BYTES;
          if (bytes > remaining) {
            metrics.increment('indexer_worker_derived_storage_load_rejections_total', {
              storage: label,
              reason: 'converted-byte-budget',
            });
            throw new Error(
              `Historical valuation load exceeds its ${budget.maximumBytes} byte peak retained-load limit while converting ${label}`
            );
          }
          convertedBytes += bytes;
        }
        budget.retainedBytes += convertedBytes;
        metrics.setGauge('indexer_worker_derived_storage_load_retained_bytes', {}, budget.retainedBytes);
        metrics.increment('indexer_worker_derived_storage_load_pages_total', { storage: label });
        metrics.increment('indexer_worker_derived_storage_load_entries_total', { storage: label }, page.length);

        if (page.length < DERIVED_STORAGE_ENTRIES_PAGE_SIZE) break;
        const lastKey = page[page.length - 1]![0];
        let nextStartKey: string;
        try {
          nextStartKey = lastKey.toHex?.() ?? '';
        } catch {
          nextStartKey = '';
        }
        if (!nextStartKey || !/^0x[0-9a-f]+$/i.test(nextStartKey)) {
          throw new Error(`${label}.entriesPaged() returned a storage key without a hex continuation encoding`);
        }
        const nextFingerprint = `hex:${nextStartKey}`;
        if (nextFingerprint === startFingerprint) {
          throw new Error(`${label}.entriesPaged() made no continuation progress`);
        }
        startKey = nextStartKey;
        startFingerprint = nextFingerprint;
      }
    } finally {
      budget.activeLoads -= 1;
      if (budget.activeLoads === 0) {
        const waiters = budget.idleWaiters.splice(0);
        for (const resolve of waiters) resolve();
      }
    }
  }

  private retainDerivedStorageConversion(
    source: unknown,
    converted: unknown,
    budget: DerivedStorageRetainedLoadBudget,
    label: string
  ): void {
    const remaining = Math.max(0, budget.maximumBytes - budget.retainedBytes);
    const sourceBytes = estimateRetainedValueBytes(source, remaining);
    const afterSource = Math.max(0, remaining - sourceBytes);
    const convertedBytes =
      estimateRetainedValueBytes(
        converted,
        Math.max(0, afterSource - DERIVED_STORAGE_RETAINED_ENTRY_OVERHEAD_BYTES)
      ) + DERIVED_STORAGE_RETAINED_ENTRY_OVERHEAD_BYTES;
    if (sourceBytes > remaining || convertedBytes > afterSource) {
      metrics.increment('indexer_worker_derived_storage_load_rejections_total', {
        storage: label,
        reason: 'converted-byte-budget',
      });
      throw new Error(
        `Historical valuation load exceeds its ${budget.maximumBytes} byte peak retained-load limit while converting ${label}`
      );
    }
    budget.retainedBytes += convertedBytes;
    metrics.setGauge('indexer_worker_derived_storage_load_retained_bytes', {}, budget.retainedBytes);
  }

  private derivedStorageDomainsForPallet(pallet: string, method = ''): DerivedStorageDomain[] {
    const normalizedPallet = pallet.toLowerCase();
    const normalizedMethod = method.toLowerCase();

    if (
      normalizedPallet === 'system' &&
      (normalizedMethod === 'codeupdated' || normalizedMethod === 'setstorage' || normalizedMethod === 'killstorage')
    ) {
      return [...DERIVED_STORAGE_DOMAINS];
    }
    if (normalizedPallet === 'assets') {
      if (/transfer/.test(normalizedMethod)) return [];
      if (/(issu|mint|burn|rescind)/.test(normalizedMethod)) return ['assetSupply'];
      if (/(register|metadata|symbol|name|precision|content|owner)/.test(normalizedMethod)) {
        return ['assetMetadata'];
      }
      return ['assetMetadata', 'assetSupply'];
    }
    if (normalizedPallet === 'tokens') {
      // Plain transfers do not change total issuance. Issuance-changing token
      // events use one of these explicit lifecycle names on supported runtimes.
      return /(issu|mint|burn|deposit|withdraw|slash|dust|endow|setbalance)/.test(normalizedMethod)
        ? ['assetSupply']
        : [];
    }
    if (normalizedPallet === 'balances') {
      return /(issu|mint|burn|deposit|withdraw|slash|dust|endow|setbalance|rescind)/.test(normalizedMethod)
        ? ['assetSupply']
        : [];
    }
    // xorFee and liquidityProxy orchestrate other pallets; the underlying
    // assets/balances/pool/order-book events below identify actual storage
    // mutations without invalidating unrelated domains on every paid swap.
    if (normalizedPallet === 'xorfee' || normalizedPallet === 'liquidityproxy') return [];
    if (normalizedPallet === 'poolxyk') {
      if (/(exchange|swap|reserve)/.test(normalizedMethod)) return ['poolReserves'];
      if (/(deposit|withdraw|liquidity|provider)/.test(normalizedMethod)) {
        return ['poolReserves', 'poolIssuance', 'poolProviders'];
      }
      if (/(initialize|register|create)/.test(normalizedMethod)) {
        return ['poolMetadata', 'poolReserves', 'poolIssuance'];
      }
      return ['poolMetadata', 'poolReserves', 'poolIssuance', 'poolProviders'];
    }
    if (normalizedPallet === 'orderbook') return ['orderBooks'];
    if (normalizedPallet === 'polkamarkt') return ['polkamarkt'];
    if (normalizedPallet === 'farming') return ['farming'];
    if (
      normalizedPallet === 'staking' ||
      normalizedPallet === 'session' ||
      normalizedPallet === 'identity' ||
      normalizedPallet.includes('election')
    ) {
      return ['staking'];
    }
    if (normalizedPallet === 'referrals') return ['referrals'];
    if (normalizedPallet === 'kensetsu') return ['vaults'];
    if (['bridgeproxy', 'bridgemultisig', 'ethbridge'].includes(normalizedPallet)) return [];

    return [];
  }

  private markDerivedStorageDomainsDirty(domains: Iterable<DerivedStorageDomain>): void {
    for (const domain of new Set(domains)) {
      this.derivedStorageDomainGenerations.set(domain, (this.derivedStorageDomainGenerations.get(domain) ?? 0) + 1);
      this.dirtyDerivedStorageDomains.add(domain);
      this.derivedStorageCacheMetrics.dirtyMarks += 1;
      metrics.increment('indexer_worker_derived_storage_dirty_marks_total', { domain });
    }

    metrics.setGauge('indexer_worker_derived_storage_dirty_domains', {}, this.dirtyDerivedStorageDomains.size);
  }

  private markDerivedStorageDomainsDirtyFromBlock(
    contexts: BlockExtrinsicContext[],
    events: EventRecord[]
  ): void {
    const domains = new Set<DerivedStorageDomain>();
    const addPallet = (pallet: string, method: string): void => {
      for (const domain of this.derivedStorageDomainsForPallet(pallet, method)) domains.add(domain);
    };

    for (const context of contexts) {
      if (context.failed) continue;
      addPallet(context.module, context.method);
      for (const call of context.calls) addPallet(call.module, call.method);
    }
    // Include initialization/finalization events as well as extrinsic events;
    // runtime hooks can mutate indexed storage without an outer signed call.
    for (const { event } of events) addPallet(event.section, event.method);

    this.markDerivedStorageDomainsDirty(domains);
  }

  private shouldFullyReconcileDerivedStorage(blockHeight: number): boolean {
    const last = this.lastDerivedStorageReconciliationBlock;
    if (last !== null && blockHeight < last) return false;
    return (
      last === null ||
      blockHeight % this.config.fullReconciliationIntervalBlocks === 0 ||
      blockHeight - last >= this.config.fullReconciliationIntervalBlocks
    );
  }

  private derivedStorageEntryCount(value: unknown): number {
    if (Array.isArray(value)) return value.length;
    if (!value || typeof value !== 'object') return 0;

    return Object.values(value as Record<string, unknown>).reduce<number>(
      (total, item) => total + (Array.isArray(item) ? item.length : 0),
      0
    );
  }

  private publishDerivedStorageCacheGauges(): void {
    metrics.setGauge('indexer_worker_derived_storage_cached_domains', {}, this.derivedStorageCache.size);
    metrics.setGauge('indexer_worker_derived_storage_cached_bytes', {}, this.derivedStorageCacheBytes);
    metrics.setGauge('indexer_worker_derived_storage_dirty_domains', {}, this.dirtyDerivedStorageDomains.size);
  }

  private removeDerivedStorageCacheEntry(domain: DerivedStorageDomain, capacityEviction = false): void {
    if (!this.derivedStorageCache.delete(domain)) return;

    const bytes = this.derivedStorageCacheByteSizes.get(domain) ?? 0;
    this.derivedStorageCacheByteSizes.delete(domain);
    this.derivedStorageCacheBytes = Math.max(0, this.derivedStorageCacheBytes - bytes);
    metrics.setGauge('indexer_worker_derived_storage_cached_entries', { domain }, 0);

    if (capacityEviction) {
      this.dirtyDerivedStorageDomains.add(domain);
      this.derivedStorageCacheMetrics.capacityEvictions += 1;
      this.derivedStorageCacheMetrics.capacityEvictedBytes += bytes;
      metrics.increment('indexer_worker_derived_storage_cache_evictions_total', { domain });
      metrics.increment('indexer_worker_derived_storage_cache_evicted_bytes_total', { domain }, bytes);
    }

    this.publishDerivedStorageCacheGauges();
  }

  private cacheDerivedStorageValue<T>(
    domain: DerivedStorageDomain,
    blockHeight: number,
    generation: number,
    value: T
  ): boolean {
    const maximumBytes = this.config.derivedStorageCacheMaxBytes;
    const availableValueBytes = Math.max(0, maximumBytes - DERIVED_STORAGE_CACHE_ENTRY_OVERHEAD_BYTES);
    const estimatedValueBytes =
      maximumBytes > DERIVED_STORAGE_CACHE_ENTRY_OVERHEAD_BYTES
        ? estimateRetainedValueBytes(value, availableValueBytes)
        : availableValueBytes + 1;
    const candidateBytes = estimatedValueBytes + DERIVED_STORAGE_CACHE_ENTRY_OVERHEAD_BYTES;

    if (maximumBytes === 0 || candidateBytes > maximumBytes) {
      const reason = maximumBytes === 0 ? 'disabled' : 'byte-budget';
      this.removeDerivedStorageCacheEntry(domain);
      this.dirtyDerivedStorageDomains.add(domain);
      this.derivedStorageCacheMetrics.capacityBypasses += 1;
      this.derivedStorageCacheMetrics.capacityBypassedBytes += candidateBytes;
      metrics.increment('indexer_worker_derived_storage_cache_bypasses_total', { domain, reason });
      metrics.increment(
        'indexer_worker_derived_storage_cache_bypassed_bytes_total',
        { domain, reason },
        candidateBytes
      );
      this.publishDerivedStorageCacheGauges();
      return false;
    }

    this.removeDerivedStorageCacheEntry(domain);
    while (this.derivedStorageCacheBytes + candidateBytes > maximumBytes) {
      const oldestDomain = this.derivedStorageCache.keys().next().value as DerivedStorageDomain | undefined;
      if (!oldestDomain) break;
      this.removeDerivedStorageCacheEntry(oldestDomain, true);
    }

    this.derivedStorageCache.set(domain, { blockHeight, generation, value });
    this.derivedStorageCacheByteSizes.set(domain, candidateBytes);
    this.derivedStorageCacheBytes += candidateBytes;
    this.dirtyDerivedStorageDomains.delete(domain);
    metrics.setGauge(
      'indexer_worker_derived_storage_cached_entries',
      { domain },
      this.derivedStorageEntryCount(value)
    );
    this.publishDerivedStorageCacheGauges();
    return true;
  }

  private async loadDerivedStorageDomain<T>(
    domain: DerivedStorageDomain,
    blockHeight: number,
    forceReconciliation: boolean,
    loader: () => Promise<T>
  ): Promise<T> {
    return (await this.loadDerivedStorageDomainWithStatus(domain, blockHeight, forceReconciliation, loader)).value;
  }

  private async loadDerivedStorageDomainWithStatus<T>(
    domain: DerivedStorageDomain,
    blockHeight: number,
    forceReconciliation: boolean,
    loader: () => Promise<T>
  ): Promise<DerivedStorageLoadResult<T>> {
    const cached = this.derivedStorageCache.get(domain);
    const dirty = this.dirtyDerivedStorageDomains.has(domain);
    const generation = this.derivedStorageDomainGenerations.get(domain) ?? 0;
    const inFlight = this.derivedStorageDomainLoads.get(domain);

    // A forced reconciliation supersedes a clean cached value. Consumers that
    // arrive while it is in flight must coalesce with that generation instead
    // of publishing the old cache concurrently.
    if (inFlight?.generation === generation && inFlight.blockHeight === blockHeight) {
      this.derivedStorageCacheMetrics.coalescedLoads += 1;
      metrics.increment('indexer_worker_derived_storage_coalesced_loads_total', { domain });
      return (await inFlight.promise) as DerivedStorageLoadResult<T>;
    }

    if (cached && cached.blockHeight <= blockHeight && !dirty && !forceReconciliation) {
      // Map insertion order is the eviction order. Promote successful hits so
      // a hot small domain does not lose its slot to a cold large scan.
      this.derivedStorageCache.delete(domain);
      this.derivedStorageCache.set(domain, cached);
      this.derivedStorageCacheMetrics.hits += 1;
      metrics.increment('indexer_worker_derived_storage_cache_hits_total', { domain });
      return { value: cached.value as T, refreshed: false, authoritativeForGeneration: false };
    }

    const reason = forceReconciliation ? 'reconciliation' : cached ? (dirty ? 'dirty' : 'historical') : 'cold';
    const preserveNewerCache = Boolean(cached && !dirty && cached.blockHeight > blockHeight);
    if (cached && !preserveNewerCache) {
      // Do not retain an old full storage scan while its replacement is being
      // materialized. A failed refresh remains dirty and is retried.
      this.removeDerivedStorageCacheEntry(domain);
      this.dirtyDerivedStorageDomains.add(domain);
    }
    const loadPromise = (async (): Promise<DerivedStorageLoadResult<T>> => {
      const value = await loader();
      const currentGeneration = this.derivedStorageDomainGenerations.get(domain) ?? 0;
      const authoritativeForGeneration = currentGeneration === generation;

      const currentCache = this.derivedStorageCache.get(domain);
      if (
        authoritativeForGeneration &&
        (!currentCache || currentCache.blockHeight <= blockHeight)
      ) {
        this.cacheDerivedStorageValue(domain, blockHeight, generation, value);
      } else if (this.derivedStorageCache.get(domain)?.generation !== currentGeneration) {
        // A newer block dirtied the domain while the RPC was in flight. The
        // caller may finish its older-block refresh with this value, but it
        // must never displace a newer cached generation.
        this.dirtyDerivedStorageDomains.add(domain);
      }
      this.derivedStorageCacheMetrics.loads += 1;
      metrics.increment('indexer_worker_derived_storage_loads_total', { domain, reason });
      this.publishDerivedStorageCacheGauges();

      return { value, refreshed: true, authoritativeForGeneration };
    })();
    this.derivedStorageDomainLoads.set(domain, { generation, blockHeight, promise: loadPromise });

    try {
      return await loadPromise;
    } finally {
      if (this.derivedStorageDomainLoads.get(domain)?.promise === loadPromise) {
        this.derivedStorageDomainLoads.delete(domain);
      }
    }
  }

  private async loadAssetStorageDomain(
    blockHeight: number,
    forceReconciliation = false,
    query: any = this.api?.query
  ): Promise<AssetStorageState> {
    if (!query) throw new Error('Cannot load asset storage before the chain API is initialized');
    const [assetInfoLoad, supply] = await Promise.all([
      this.loadDerivedStorageDomainWithStatus('assetMetadata', blockHeight, forceReconciliation, () =>
        this.fetchStorageEntries(query.assets.assetInfosV2, 'assets.assetInfosV2')
      ),
      this.loadDerivedStorageDomain('assetSupply', blockHeight, forceReconciliation, async () => {
        const [tokenIssuances, nativeXorIssuance] = await Promise.all([
          this.fetchStorageEntries(query.tokens.totalIssuance, 'tokens.totalIssuance'),
          this.fetchNativeXorIssuance(query),
        ]);
        return { tokenIssuances, nativeXorIssuance };
      }),
    ]);

    return {
      assetInfos: assetInfoLoad.value,
      ...supply,
      assetMetadataAuthoritative: assetInfoLoad.refreshed && assetInfoLoad.authoritativeForGeneration,
    };
  }

  private async loadPoolStorageDomain(
    blockHeight: number,
    forceReconciliation = false,
    query: any = this.api?.query
  ): Promise<PoolStorageState> {
    if (!query) throw new Error('Cannot load pool storage before the chain API is initialized');
    const [poolProperties, poolReserveLoad, poolIssuances] = await Promise.all([
      this.loadDerivedStorageDomain('poolMetadata', blockHeight, forceReconciliation, () =>
        this.fetchStorageEntries(query.poolXYK.properties, 'poolXYK.properties')
      ),
      this.loadDerivedStorageDomainWithStatus('poolReserves', blockHeight, forceReconciliation, () =>
        this.fetchStorageEntries(query.poolXYK.reserves, 'poolXYK.reserves')
      ),
      this.loadDerivedStorageDomain('poolIssuance', blockHeight, forceReconciliation, () =>
        this.fetchStorageEntries(query.poolXYK.totalIssuances, 'poolXYK.totalIssuances')
      ),
    ]);

    return {
      poolProperties,
      poolReserves: poolReserveLoad.value,
      poolIssuances,
      poolReservesAuthoritative: poolReserveLoad.refreshed && poolReserveLoad.authoritativeForGeneration,
    };
  }

  private loadPolkamarktStorageDomain(
    blockHeight: number,
    forceReconciliation = false,
    query: any = this.api?.query
  ): Promise<PolkamarktStorageState> {
    if (!query) return Promise.reject(new Error('Cannot load Polkamarkt storage before the chain API is initialized'));
    return this.loadDerivedStorageDomainWithStatus('polkamarkt', blockHeight, forceReconciliation, async () => {
      const polkamarkt = query.polkamarkt;
      const [
        polkamarktConditions,
        polkamarktConditionDetails,
        polkamarktMarkets,
        polkamarktDpmCollaterals,
        polkamarktVolumes,
        polkamarktTotals,
        polkamarktResolutions,
        polkamarktResolutionEvidence,
        polkamarktCancellationEvidence,
        polkamarktPositions,
        polkamarktDpmCostBasis,
        polkamarktDpmCostBasisTotals,
        polkamarktCreatorFees,
      ] = await Promise.all([
        this.fetchOptionalStorageEntries(polkamarkt?.conditions, 'polkamarkt.conditions'),
        this.fetchOptionalStorageEntries(polkamarkt?.conditionDetails, 'polkamarkt.conditionDetails'),
        this.fetchOptionalStorageEntries(polkamarkt?.markets, 'polkamarkt.markets'),
        this.fetchOptionalStorageEntries(polkamarkt?.marketDpmCollateral, 'polkamarkt.marketDpmCollateral'),
        this.fetchOptionalStorageEntries(polkamarkt?.marketVolume, 'polkamarkt.marketVolume'),
        this.fetchOptionalStorageEntries(polkamarkt?.marketPositionTotals, 'polkamarkt.marketPositionTotals'),
        this.fetchOptionalStorageEntries(polkamarkt?.marketResolution, 'polkamarkt.marketResolution'),
        this.fetchOptionalStorageEntries(polkamarkt?.marketResolutionEvidence, 'polkamarkt.marketResolutionEvidence'),
        this.fetchOptionalStorageEntries(polkamarkt?.marketCancellationEvidence, 'polkamarkt.marketCancellationEvidence'),
        this.fetchOptionalStorageEntries(polkamarkt?.marketPositions, 'polkamarkt.marketPositions'),
        this.fetchOptionalStorageEntries(polkamarkt?.dpmCostBasis, 'polkamarkt.dpmCostBasis'),
        this.fetchOptionalStorageEntries(polkamarkt?.dpmCostBasisTotals, 'polkamarkt.dpmCostBasisTotals'),
        this.fetchOptionalStorageEntries(polkamarkt?.marketCreatorFees, 'polkamarkt.marketCreatorFees'),
      ]);

      return {
        polkamarktConditions,
        polkamarktConditionDetails,
        polkamarktMarkets,
        polkamarktDpmCollaterals,
        polkamarktVolumes,
        polkamarktTotals,
        polkamarktResolutions,
        polkamarktResolutionEvidence,
        polkamarktCancellationEvidence,
        polkamarktPositions,
        polkamarktDpmCostBasis,
        polkamarktDpmCostBasisTotals,
        polkamarktCreatorFees,
      };
    }).then((load) => ({
      ...load.value,
      authoritativeForGeneration: load.refreshed && load.authoritativeForGeneration,
    }));
  }

  private completeDerivedStorageReconciliation(blockHeight: number, reconciled: boolean): void {
    if (!reconciled) return;
    if (this.lastDerivedStorageReconciliationBlock !== null && blockHeight < this.lastDerivedStorageReconciliationBlock) {
      return;
    }

    this.lastDerivedStorageReconciliationBlock = blockHeight;
    this.derivedStorageCacheMetrics.reconciliations += 1;
    metrics.increment('indexer_worker_derived_storage_reconciliations_total');
    metrics.setGauge('indexer_worker_derived_storage_last_reconciliation_block', {}, blockHeight);
  }

  private getDerivedStorageCacheMetrics(): typeof this.derivedStorageCacheMetrics & {
    cachedDomains: number;
    cachedBytes: number;
    maximumBytes: number;
    dirtyDomains: number;
    lastReconciliationBlock: number | null;
    reconciliationIntervalBlocks: number;
  } {
    return {
      ...this.derivedStorageCacheMetrics,
      cachedDomains: this.derivedStorageCache.size,
      cachedBytes: this.derivedStorageCacheBytes,
      maximumBytes: this.config.derivedStorageCacheMaxBytes,
      dirtyDomains: this.dirtyDerivedStorageDomains.size,
      lastReconciliationBlock: this.lastDerivedStorageReconciliationBlock,
      reconciliationIntervalBlocks: this.config.fullReconciliationIntervalBlocks,
    };
  }

  private async fetchApiAtFrom(
    api: ApiPromise,
    hash: string,
    label: string,
    executeRpc?: RpcExecutor
  ): Promise<{ query: unknown; rpc?: unknown }> {
    const at = (api as unknown as { at?: (hash: string) => Promise<{ query: unknown }> }).at;
    if (typeof at !== 'function') {
      throw new Error('api.at is required to decode historical chain state');
    }

    return (executeRpc ?? ((createRequest, rpcLabel) => this.withRpcTimeout(createRequest, rpcLabel)))(
      () => at.call(api, hash),
      `api.at(${label})`
    );
  }

  private async getProjectionQueryAt(blockHeight: number): Promise<any> {
    if (!this.api) throw new Error('Cannot capture derived state before the chain API is initialized');
    const hash = await this.withRpcTimeout(
      () => this.api!.rpc.chain.getBlockHash(blockHeight),
      `chain.getBlockHash(${blockHeight}) for derived state`
    );
    const hashText = hash?.toString?.() ?? String(hash ?? '');
    if (!hashText || /^0x0+$/.test(hashText)) {
      throw new Error(`No SORA block hash is available for derived state at finalized block ${blockHeight}`);
    }

    return (await this.fetchApiAtFrom(this.api, hashText, `derived state block ${blockHeight}`)).query as any;
  }

  private async getHistoricalValuationQueryAt(blockHeight: number): Promise<any> {
    const blockApi = await this.getBlockDataApi();
    const chain = (blockApi as unknown as { rpc?: { chain?: Record<string, unknown> } }).rpc?.chain;
    const getBlockHash = chain?.getBlockHash;
    if (typeof getBlockHash !== 'function') {
      throw new Error('chain.getBlockHash is required to load historical valuation state');
    }
    const hash = await this.withRpcTimeout(
      () => getBlockHash.call(chain, blockHeight),
      `chain.getBlockHash(${blockHeight}) for historical valuation`
    );
    const hashText = hash?.toString?.() ?? String(hash ?? '');
    if (!hashText || /^0x0+$/.test(hashText)) {
      throw new Error(`No SORA block hash is available for historical valuation at block ${blockHeight}`);
    }

    return (
      await this.fetchApiAtFrom(blockApi, hashText, `historical valuation block ${blockHeight}`)
    ).query as any;
  }

  private historicalPoolKey(baseAssetId: string, targetAssetId: string): string {
    return `${baseAssetId}\u0000${targetAssetId}`;
  }

  private storageOptionValue(value: unknown): unknown | null {
    if (!value || typeof value !== 'object') return value;
    const option = value as { isEmpty?: boolean; isNone?: boolean; unwrap?: () => unknown; value?: unknown };
    if (option.isEmpty || option.isNone) return null;
    if (typeof option.unwrap === 'function') return option.unwrap();
    if (option.value !== undefined) return option.value;
    return value;
  }

  private parseHistoricalAssetInfo(id: string, value: unknown): AssetInfo | null {
    const unwrapped = this.storageOptionValue(value);
    if (unwrapped === null) return null;
    const human = toHuman(unwrapped);
    if (!isRecord(human)) throw new Error(`Historical asset metadata for ${id} is not an object`);
    const decimals = Number(human.precision ?? human.decimals ?? DECIMALS);
    if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) {
      throw new Error(`Historical asset metadata for ${id} has invalid precision`);
    }
    return {
      id,
      symbol: String(human.symbol ?? ''),
      name: String(human.name ?? ''),
      decimals,
      // Historical transaction valuation needs metadata and reserves only;
      // supply is deliberately not synthesized from a later head.
      supply: 0n,
    };
  }

  private parseHistoricalPool(
    baseAsset: unknown,
    targetAsset: unknown,
    value: unknown
  ): HistoricalValuationPool | null {
    const baseAssetId = canonicalSoraAssetId(baseAsset);
    const targetAssetId = canonicalSoraAssetId(targetAsset);
    if (!baseAssetId || !targetAssetId) {
      throw new Error('Historical pool storage key is missing a canonical asset id');
    }
    const unwrapped = this.storageOptionValue(value);
    if (unwrapped === null) return null;
    const reserves = toJson(unwrapped);
    if (!Array.isArray(reserves) || reserves.length < 2) {
      throw new Error(`Historical pool ${baseAssetId}-${targetAssetId} has invalid reserves`);
    }
    return {
      baseAssetId,
      targetAssetId,
      baseAssetReserves: codecToBigInt(reserves[0]),
      targetAssetReserves: codecToBigInt(reserves[1]),
    };
  }

  private recalculateHistoricalValuationState(state: HistoricalValuationState): void {
    const pools = [...state.pools.values()];
    state.prices = this.derivePrices(state.assets, pools);
    const liquidities = pools.map((pool) => {
      const baseLiquidity = scaledMul(
        reserveToNaturalScaled(
          pool.baseAssetReserves,
          state.assets.get(pool.baseAssetId)?.decimals ?? DECIMALS
        ),
        state.prices.get(pool.baseAssetId) ?? 0n
      );
      const targetLiquidity = scaledMul(
        reserveToNaturalScaled(
          pool.targetAssetReserves,
          state.assets.get(pool.targetAssetId)?.decimals ?? DECIMALS
        ),
        state.prices.get(pool.targetAssetId) ?? 0n
      );
      return baseLiquidity + targetLiquidity;
    });
    const { poolLiquidityUSD, activePools } = summarizeExactPoolLiquidity(liquidities);
    const orderBookLiquidityUSD = state.orderBookLiquidityComplete
      ? state.networkLiquidityStats.orderBookLiquidityUSD
      : '0';
    state.networkLiquidityStats = createNetworkLiquidityStats(
      poolLiquidityUSD,
      orderBookLiquidityUSD,
      activePools,
      state.orderBookLiquidityComplete ? state.networkLiquidityStats.activeOrderBooks : 0,
      state.assets.size
    );
  }

  private async loadHistoricalValuationBaseline(
    blockHeight: number,
    reason = 'baseline'
  ): Promise<HistoricalValuationState> {
    return this.withDerivedStorageLoadBudget(async () => {
      const query = await this.getHistoricalValuationQueryAt(blockHeight);
      const assets = new Map<string, AssetInfo>();
      await this.consumeStorageEntriesPaged(
        query.assets?.assetInfosV2,
        'assets.assetInfosV2',
        [],
        ([key, value]) => {
          const id = canonicalSoraAssetId(key.args[0]);
          if (!id) throw new Error('Historical asset metadata storage key is missing a canonical asset id');
          const asset = this.parseHistoricalAssetInfo(id, value);
          if (asset) assets.set(id, asset);
          return { id, asset };
        }
      );
      const pools = new Map<string, HistoricalValuationPool>();
      await this.consumeStorageEntriesPaged(
        query.poolXYK?.reserves,
        'poolXYK.reserves',
        [],
        ([key, value]) => {
          const pool = this.parseHistoricalPool(key.args[0], key.args[1], value);
          if (pool) pools.set(this.historicalPoolKey(pool.baseAssetId, pool.targetAssetId), pool);
          return pool;
        }
      );
      const state: HistoricalValuationState = {
        blockHeight,
        assets,
        pools,
        prices: new Map(),
        networkLiquidityStats: emptyNetworkLiquidityStats(),
        orderBookLiquidityComplete: false,
      };
      this.recalculateHistoricalValuationState(state);
      metrics.increment('indexer_worker_historical_valuation_full_loads_total', { reason });
      return state;
    });
  }

  private initializeHistoricalValuationState(startBlock: number): Promise<HistoricalValuationState> {
    if (!Number.isSafeInteger(startBlock) || startBlock < 0) {
      return Promise.reject(new Error('Historical valuation start block must be a non-negative safe integer'));
    }
    return this.loadHistoricalValuationBaseline(Math.max(0, startBlock - 1));
  }

  private historicalMutationDataCandidates(data: unknown): Record<string, unknown>[] {
    if (!isRecord(data)) return [];
    const candidates = [data];
    if (isRecord(data.args)) candidates.push(data.args);
    return candidates;
  }

  private historicalRawField(candidates: Record<string, unknown>[], names: readonly string[]): unknown {
    for (const candidate of candidates) {
      for (const name of names) {
        const value = candidate[name];
        if (value !== undefined && value !== null && assetIdToString(value)) return value;
      }
    }
    return undefined;
  }

  private recordHistoricalAssetTouch(data: unknown, touches: HistoricalValuationTouches): boolean {
    const candidates = this.historicalMutationDataCandidates(data);
    const raw = this.historicalRawField(candidates, [
      'assetId',
      'asset_id',
      'asset',
      'id',
      'arg0',
    ]);
    const id = canonicalSoraAssetId(raw);
    if (!raw || !id) return false;
    touches.assets.set(id, raw);
    return true;
  }

  private recordHistoricalPoolTouch(
    data: unknown,
    touches: HistoricalValuationTouches,
    state: HistoricalValuationState
  ): boolean {
    const candidates = this.historicalMutationDataCandidates(data);
    const namedPairs: ReadonlyArray<readonly [string, string]> = [
      ['baseAssetId', 'targetAssetId'],
      ['baseAsset', 'targetAsset'],
      ['inputAssetId', 'outputAssetId'],
      ['assetIdA', 'assetIdB'],
      ['assetA', 'assetB'],
      ['arg1', 'arg2'],
      ['arg0', 'arg1'],
    ];
    for (const [baseName, targetName] of namedPairs) {
      const baseAsset = this.historicalRawField(candidates, [baseName]);
      const targetAsset = this.historicalRawField(candidates, [targetName]);
      const baseAssetId = canonicalSoraAssetId(baseAsset);
      const targetAssetId = canonicalSoraAssetId(targetAsset);
      if (!baseAsset || !targetAsset || !baseAssetId || !targetAssetId) continue;
      const baseIsKnown = state.assets.has(baseAssetId) || touches.assets.has(baseAssetId);
      const targetIsKnown = state.assets.has(targetAssetId) || touches.assets.has(targetAssetId);
      if (!baseIsKnown || !targetIsKnown || baseAssetId === targetAssetId) continue;
      const directId = this.historicalPoolKey(baseAssetId, targetAssetId);
      const reverseId = this.historicalPoolKey(targetAssetId, baseAssetId);
      // Trade direction and PoolXYK storage-key direction are independent.
      // Probe both keys so a remove/recreate that reverses an existing pair is
      // also represented exactly in the post-state.
      touches.pools.set(directId, { baseAsset, targetAsset });
      touches.pools.set(reverseId, {
        baseAsset: targetAsset,
        targetAsset: baseAsset,
      });
      return true;
    }
    return false;
  }

  private recordHistoricalMutation(
    pallet: string,
    method: string,
    data: unknown,
    touches: HistoricalValuationTouches,
    state: HistoricalValuationState
  ): void {
    const normalizedPallet = pallet.toLowerCase();
    const normalizedMethod = method.toLowerCase();
    if (
      normalizedPallet === 'system' &&
      (normalizedMethod === 'codeupdated' ||
        normalizedMethod === 'setstorage' ||
        normalizedMethod === 'killstorage')
    ) {
      touches.invalidated = true;
      return;
    }
    const domains = this.derivedStorageDomainsForPallet(pallet, method);
    if (domains.includes('orderBooks')) touches.orderBookChanged = true;
    if (domains.includes('assetMetadata') && !this.recordHistoricalAssetTouch(data, touches)) {
      touches.invalidated = true;
    }
    if (domains.includes('poolReserves') && !this.recordHistoricalPoolTouch(data, touches, state)) {
      touches.invalidated = true;
    }
  }

  private collectHistoricalValuationTouches(
    state: HistoricalValuationState,
    contexts: BlockExtrinsicContext[],
    events: EventRecord[]
  ): HistoricalValuationTouches {
    const touches: HistoricalValuationTouches = {
      assets: new Map(),
      pools: new Map(),
      invalidated: false,
      orderBookChanged: false,
    };
    for (const { event } of events) {
      this.recordHistoricalMutation(event.section, event.method, eventData(event), touches, state);
    }
    for (const context of contexts) {
      if (context.failed) continue;
      const outerDomains = this.derivedStorageDomainsForPallet(context.module, context.method);
      if (outerDomains.some((domain) => domain === 'assetMetadata' || domain === 'poolReserves' || domain === 'orderBooks')) {
        this.recordHistoricalMutation(context.module, context.method, context.history.data, touches, state);
      }
      for (const call of context.calls) {
        const callDomains = this.derivedStorageDomainsForPallet(call.module, call.method);
        if (callDomains.some((domain) => domain === 'assetMetadata' || domain === 'poolReserves' || domain === 'orderBooks')) {
          this.recordHistoricalMutation(call.module, call.method, call.data, touches, state);
        }
      }
    }
    return touches;
  }

  private async prepareHistoricalValuationAdvance(
    state: HistoricalValuationState,
    blockHeight: number,
    contexts: BlockExtrinsicContext[],
    events: EventRecord[]
  ): Promise<HistoricalValuationAdvance> {
    const touches = this.collectHistoricalValuationTouches(state, contexts, events);
    const pointReadCount = touches.assets.size + touches.pools.size;
    if (touches.invalidated || pointReadCount > MAX_HISTORICAL_VALUATION_POINT_READS_PER_BLOCK) {
      const reason = touches.invalidated ? 'invalidated' : 'touched-key-limit';
      return {
        blockHeight,
        replacement: await this.loadHistoricalValuationBaseline(blockHeight, reason),
        assets: [],
        pools: [],
        invalidateOrderBookLiquidity: touches.orderBookChanged,
      };
    }
    if (pointReadCount === 0) {
      return {
        blockHeight,
        assets: [],
        pools: [],
        invalidateOrderBookLiquidity: touches.orderBookChanged,
      };
    }

    return this.withDerivedStorageLoadBudget(async () => {
      const query = await this.getHistoricalValuationQueryAt(blockHeight);
      const assetStorage = query.assets?.assetInfosV2;
      const poolStorage = query.poolXYK?.reserves;
      if (touches.assets.size && typeof assetStorage !== 'function') {
        throw new Error('assets.assetInfosV2 point reads are required for historical valuation');
      }
      if (touches.pools.size && typeof poolStorage !== 'function') {
        throw new Error('poolXYK.reserves point reads are required for historical valuation');
      }
      const reads: Array<
        | { kind: 'asset'; id: string; raw: unknown }
        | { kind: 'pool'; id: string; baseAsset: unknown; targetAsset: unknown }
      > = [
        ...[...touches.assets].map(([id, raw]) => ({ kind: 'asset' as const, id, raw })),
        ...[...touches.pools].map(([id, pair]) => ({ kind: 'pool' as const, id, ...pair })),
      ];
      const budget = this.activeDerivedStorageLoadBudget;
      if (!budget) throw new Error('Historical valuation point reads require an active retained-load budget');
      const settled = await mapWithConcurrency(
        reads,
        // A single sequential response makes the configured byte ceiling a
        // true aggregate peak bound; multiple resolved codec values must not
        // coexist outside accounting before conversion.
        1,
        async (read) => {
          try {
            if (read.kind === 'asset') {
              const value = await this.withRpcTimeout(
                () => assetStorage.call(query.assets, read.raw),
                `assets.assetInfosV2(${read.id}) at ${blockHeight}`
              );
              const update = {
                kind: 'asset' as const,
                id: read.id,
                value: this.parseHistoricalAssetInfo(read.id, value),
              };
              this.retainDerivedStorageConversion(value, update, budget, 'assets.assetInfosV2');
              return { ok: true as const, update };
            }
            const value = await this.withRpcTimeout(
              () => poolStorage.call(query.poolXYK, read.baseAsset, read.targetAsset),
              `poolXYK.reserves(${read.id}) at ${blockHeight}`
            );
            const update = {
              kind: 'pool' as const,
              id: read.id,
              value: this.parseHistoricalPool(read.baseAsset, read.targetAsset, value),
            };
            this.retainDerivedStorageConversion(value, update, budget, 'poolXYK.reserves');
            return { ok: true as const, update };
          } catch (error) {
            return { ok: false as const, error };
          }
        }
      );
      const failed = settled.find((result) => !result.ok);
      if (failed && !failed.ok) throw failed.error;
      const advance: HistoricalValuationAdvance = {
        blockHeight,
        assets: [],
        pools: [],
        invalidateOrderBookLiquidity: touches.orderBookChanged,
      };
      for (const result of settled) {
        if (!result.ok) continue;
        if (result.update.kind === 'asset') {
          advance.assets.push({ id: result.update.id, value: result.update.value });
        } else {
          advance.pools.push({ id: result.update.id, value: result.update.value });
        }
      }
      metrics.increment('indexer_worker_historical_valuation_point_reads_total', {}, pointReadCount);
      return advance;
    });
  }

  private applyHistoricalValuationAdvance(
    state: HistoricalValuationState,
    advance: HistoricalValuationAdvance
  ): void {
    if (advance.replacement) {
      state.blockHeight = advance.replacement.blockHeight;
      state.assets = advance.replacement.assets;
      state.pools = advance.replacement.pools;
      state.prices = advance.replacement.prices;
      state.networkLiquidityStats = advance.replacement.networkLiquidityStats;
      state.orderBookLiquidityComplete = advance.replacement.orderBookLiquidityComplete;
      return;
    }
    for (const update of advance.assets) {
      if (update.value) state.assets.set(update.id, update.value);
      else state.assets.delete(update.id);
    }
    for (const update of advance.pools) {
      if (update.value) state.pools.set(update.id, update.value);
      else state.pools.delete(update.id);
    }
    if (advance.invalidateOrderBookLiquidity || advance.assets.length || advance.pools.length) {
      // Order-book reserves are valued with the price graph. Any metadata or
      // pool update can change those prices even when no order changed, so the
      // USD stock fields are unknown until a full pinned projection refreshes
      // the raw order reserves. The GraphQL fields are nullable by contract.
      state.orderBookLiquidityComplete = false;
    }
    state.blockHeight = advance.blockHeight;
    if (advance.assets.length || advance.pools.length || advance.invalidateOrderBookLiquidity) {
      this.recalculateHistoricalValuationState(state);
    }
  }

  private async fetchBlockTimestamp(hash: string, api = this.api): Promise<number> {
    return (await this.fetchBlockTimestampIdentity(hash, api)).seconds;
  }

  private async fetchBlockTimestampIdentity(
    hash: string,
    api = this.api,
    executeRpc?: RpcExecutor
  ): Promise<ParsedChainTimestamp> {
    if (!this.api) throw new Error('Cannot index a block before the chain API is initialized');
    if (!api) throw new Error('Cannot index a block before the chain API is initialized');

    const timestampNow = (api.query as any).timestamp?.now;
    const at = timestampNow?.at;
    if (typeof at !== 'function') {
      throw new Error('timestamp.now.at is required to index block timestamps');
    }

    const codec = await (
      executeRpc ?? ((createRequest, label) => this.withRpcTimeout(createRequest, label))
    )(() => at.call(timestampNow, hash), `timestamp.now.at(${hash})`);
    return parseChainTimestamp(codec, `timestamp.now for block ${hash}`);
  }

  private extractVolumeUSD(data: unknown): bigint {
    if (!data || typeof data !== 'object') return 0n;

    let max = 0n;

    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      const normalizedKey = key.toLowerCase();
      if (
        normalizedKey.endsWith('amountusd') ||
        normalizedKey === 'amountusd' ||
        normalizedKey === 'volumeusd' ||
        normalizedKey === 'collateralusd' ||
        normalizedKey === 'collateralreinvestedusd'
      ) {
        const amount = decimalStringToScaled(value);
        if (amount > max) max = amount;
      }
    }

    return max;
  }

  private async createAccountDocuments(
    accounts: string[],
    latestHistoryElementId: string,
    blockHeight: number,
    timestamp: number,
    pendingPointData: Map<string, Record<string, unknown>>,
    update?: AccountPointUpdate,
    existingAccountMeta?: Map<string, IndexerDocument>
  ): Promise<IndexerDocument[]> {
    const accountMeta =
      existingAccountMeta ??
      (await this.repository.getMany(
        collection('accountMeta'),
        accounts.filter((account) => !pendingPointData.has(account))
      ));
    const latestHistoryByAccount = new Map(accounts.map((account) => [account, latestHistoryElementId]));

    this.applyAccountPointUpdates(accounts, blockHeight, timestamp, pendingPointData, update, accountMeta);

    return this.createFinalAccountDocuments(accounts, latestHistoryByAccount, blockHeight, timestamp, pendingPointData);
  }

  private createHistoryElementDocument(
    context: BlockExtrinsicContext,
    blockHeight: number,
    timestamp: number,
    blockHash: string
  ): IndexerDocument {
    return {
      collection: collection('historyElements'),
      id: context.id,
      blockHeight,
      timestamp,
      data: {
        id: context.id,
        type: 'CALL',
        timestamp,
        blockHash,
        blockHeight,
        module: context.module,
        method: context.method,
        address: context.address,
        networkFee: context.fee.toString(),
        execution: context.failed ? { success: false, error: { moduleErrorId: 0, moduleErrorIndex: 0 } } : { success: true },
        data: context.history.data,
        dataFrom: context.history.from || context.address,
        dataTo: context.history.to,
        dataAssets: context.history.assets,
        callNames: context.callNames,
        calls: context.calls,
      },
    };
  }

  /**
   * Stores one row per account involved in each indexed transaction so range
   * stats can count distinct active accounts without scanning transaction JSON.
   * A small trade projection is denormalized here so accountTrades never has
   * to hydrate up to 100 legal 32 MiB history documents in one request.
   */
  private createAccountTransactionDocuments(
    context: Pick<BlockExtrinsicContext, 'id' | 'accounts'>,
    blockHeight: number,
    timestamp: number,
    historyDocument: IndexerDocument
  ): IndexerDocument[] {
    const source = historyDocument.data;
    const payload = isRecord(source.data) ? source.data : {};
    const firstCall = Array.isArray(source.calls) && isRecord(source.calls[0]) ? source.calls[0] : {};
    const firstCallData = isRecord(firstCall.data) ? firstCall.data : {};
    const records = [source, payload, firstCall, firstCallData];
    const firstScalar = (keys: readonly string[]): string | number | boolean | null => {
      for (const record of records) {
        for (const key of keys) {
          const value = record[key];
          if (
            typeof value === 'string' ||
            typeof value === 'boolean' ||
            (typeof value === 'number' && Number.isFinite(value))
          ) {
            return value;
          }
        }
      }
      return null;
    };
    const tradeProjection: Record<string, string | number | boolean> = {};
    for (const [field, keys] of [
      ['marketId', ['marketId', 'market_id', 'conditionId', 'condition_id']],
      ['side', ['side', 'action', 'method']],
      ['outcome', ['outcome', 'direction']],
      ['fromOutcome', ['fromOutcome', 'from_outcome', 'outcomeIn', 'outcome_in']],
      ['toOutcome', ['toOutcome', 'to_outcome', 'outcomeOut', 'outcome_out', 'outcome', 'direction']],
      ['collateralUsd', ['collateralUsd', 'collateralUSD', 'collateralAmountUsd', 'amountUsd']],
      ['shares', ['shares', 'sharesAmount', 'shareAmount']],
      ['sharesIn', ['sharesIn', 'shares_in', 'sharesAmountIn', 'sharesAmount', 'shares', 'shareAmount']],
      ['sharesOut', ['sharesOut', 'shares_out', 'sharesAmountOut']],
      ['price', ['price', 'executionPrice', 'avgPrice']],
      ['feeUsd', ['feeUsd', 'feeUSD', 'feeAmountUsd']],
      ['realizedPnlUsd', ['realizedPnlUsd', 'realizedPnlUSD', 'pnlUsd']],
      ['blockHash', ['blockHash']],
      ['module', ['module']],
      ['method', ['method']],
    ] as const) {
      const value = firstScalar(keys);
      if (value !== null) tradeProjection[field] = value;
    }

    return uniqueIndexedAccountIds(context.accounts).map((account) => {
      const id = accountTransactionId(context.id, account);

      return {
        collection: collection('accountTransactions'),
        id,
        blockHeight,
        timestamp,
        data: {
          id,
          accountId: account,
          historyElementId: context.id,
          ...tradeProjection,
          blockHeight,
          timestamp,
        },
      };
    });
  }

  /** Reconstructs per-account transaction rows from indexer-owned legacy history fields. */
  private createAccountTransactionDocumentsFromHistory(document: IndexerDocument): IndexerDocument[] {
    const historyElementId = String(document.data.id ?? document.id);
    const blockHeightValue = Number(document.blockHeight ?? document.data.blockHeight ?? 0);
    const timestampValue = Number(document.timestamp ?? document.data.timestamp ?? 0);
    const blockHeight = Number.isFinite(blockHeightValue) ? blockHeightValue : 0;
    const timestamp = Number.isFinite(timestampValue) ? timestampValue : 0;
    const accounts = uniqueIndexedAccountIds([document.data.address, document.data.dataFrom, document.data.dataTo]);

    return accounts.map((account) => {
      const id = accountTransactionId(historyElementId, account);

      return {
        collection: collection('accountTransactions'),
        id,
        blockHeight,
        timestamp,
        data: {
          id,
          accountId: account,
          historyElementId,
          blockHeight,
          timestamp,
        },
      };
    });
  }

  private applyAccountPointUpdates(
    accounts: string[],
    blockHeight: number,
    timestamp: number,
    pendingPointData: Map<string, Record<string, unknown>>,
    update: AccountPointUpdate | undefined,
    existingAccountMeta: Map<string, IndexerDocument>,
    prices: Map<string, bigint> = this.prices
  ): void {
    for (const account of accounts) {
      const existing = pendingPointData.get(account) ?? existingAccountMeta.get(account)?.data;
      const data = this.applyAccountPointUpdate(
        existing ?? emptyPointData(account, blockHeight, timestamp),
        update,
        prices
      );
      pendingPointData.set(account, data);
    }
  }

  private createFinalAccountDocuments(
    accounts: string[],
    latestHistoryByAccount: Map<string, string>,
    blockHeight: number,
    timestamp: number,
    pointData: Map<string, Record<string, unknown>>
  ): IndexerDocument[] {
    const documents: IndexerDocument[] = [];

    for (const account of accounts) {
      const latestHistoryElementId = latestHistoryByAccount.get(account) ?? '';
      const data = pointData.get(account) ?? emptyPointData(account, blockHeight, timestamp);

      documents.push({
        collection: collection('accounts'),
        id: account,
        blockHeight,
        timestamp,
        data: {
          id: account,
          latest_history_element_id: latestHistoryElementId,
          latestHistoryElementId,
        },
      });

      documents.push({ collection: collection('accountMeta'), id: account, blockHeight, timestamp, data });
      documents.push({
        collection: collection('accountPointSystems'),
        id: `${account}-1`,
        blockHeight,
        timestamp,
        data: {
          ...data,
          id: `${account}-1`,
          accountId: account,
          version: 1,
          startedAtBlock: Number(data.createdAtBlock ?? blockHeight),
        },
      });
    }

    return documents;
  }

  private applyAccountPointUpdate(
    current: Record<string, unknown>,
    update?: AccountPointUpdate,
    prices: Map<string, bigint> = this.prices
  ): Record<string, unknown> {
    const data = this.clonePointData(current);
    if (!update) return data;

    if (update.fee > 0n) {
      this.addPointVolume(data, 'xorFees', codecToDecimalString(update.fee), codecUsd(XOR, update.fee, prices));
    }

    if (update.failed) return data;

    const payload = Array.isArray(update.data) ? {} : ((update.data ?? {}) as Record<string, unknown>);
    const amountUSD = String(payload.amountUSD ?? payload.collateralAmountUSD ?? payload.debtAmountUSD ?? '0');

    if (update.module === 'assets' && update.method === 'burn' && String(payload.assetId ?? '') === XOR) {
      this.addPointVolume(data, 'xorBurned', String(payload.amount ?? '0'), amountUSD);
    }

    if (update.module === 'orderBook') {
      if (update.method === 'placeLimitOrder') {
        this.addPointCounter(data, 'orderBook', 'created', 1, amountUSD);
      } else if (update.method === 'cancelLimitOrder' || update.method === 'cancelLimitOrdersBatch') {
        const closed = Array.isArray(update.data) ? update.data.length : 1;
        this.addPointCounter(data, 'orderBook', 'closed', closed, '0');
      }
    }

    if (update.module === 'kensetsu') {
      const method = update.method.toLowerCase();
      if (method.includes('create')) {
        this.addPointCounter(data, 'vault', 'created', 1, amountUSD);
      } else if (method.includes('close') || method.includes('liquidat')) {
        this.addPointCounter(data, 'vault', 'closed', 1, amountUSD);
      }
    }

    if (update.module === 'ethBridge') {
      this.addPointDeposit(data, 'outgoingUSD', amountUSD);
    }

    if (update.module === 'bridgeProxy') {
      this.addPointDeposit(data, update.method === 'burn' ? 'outgoingUSD' : 'incomingUSD', amountUSD);
    }

    if (update.module === 'bridgeMultisig') {
      this.addPointDeposit(data, 'incomingUSD', amountUSD);
    }

    if (update.module.includes('democracy') || update.method.toLowerCase().includes('vote')) {
      const governance = data.governance as Record<string, unknown>;
      governance.votes = Number(governance.votes ?? 0) + 1;
      governance.amount = addDecimalStrings(governance.amount ?? '0', payload.amount ?? payload.balance ?? '0');
      governance.amountUSD = addDecimalStrings(governance.amountUSD ?? '0', amountUSD, 8);
    }

    return data;
  }

  private clonePointData(current: Record<string, unknown>): Record<string, unknown> {
    return {
      ...current,
      xorFees: { ...emptyVolume(), ...((current.xorFees as Record<string, unknown> | undefined) ?? {}) },
      xorBurned: { ...emptyVolume(), ...((current.xorBurned as Record<string, unknown> | undefined) ?? {}) },
      xorStakingValRewards: { ...emptyVolume(), ...((current.xorStakingValRewards as Record<string, unknown> | undefined) ?? {}) },
      orderBook: { ...emptyCounter(), ...((current.orderBook as Record<string, unknown> | undefined) ?? {}) },
      vault: { ...emptyCounter(), ...((current.vault as Record<string, unknown> | undefined) ?? {}) },
      governance: { ...emptyGovernance(), ...((current.governance as Record<string, unknown> | undefined) ?? {}) },
      deposit: { ...emptyDeposit(), ...((current.deposit as Record<string, unknown> | undefined) ?? {}) },
    };
  }

  private addPointVolume(data: Record<string, unknown>, field: string, amount: unknown, amountUSD: unknown): void {
    const volume = data[field] as Record<string, unknown>;
    volume.amount = addDecimalStrings(volume.amount ?? '0', amount);
    volume.amountUSD = addDecimalStrings(volume.amountUSD ?? '0', amountUSD, 8);
  }

  private addPointCounter(
    data: Record<string, unknown>,
    field: string,
    counter: 'created' | 'closed',
    count: number,
    amountUSD: unknown
  ): void {
    const value = data[field] as Record<string, unknown>;
    value[counter] = Number(value[counter] ?? 0) + count;
    value.amountUSD = addDecimalStrings(value.amountUSD ?? '0', amountUSD, 8);
  }

  private addPointDeposit(data: Record<string, unknown>, field: 'incomingUSD' | 'outgoingUSD', amountUSD: unknown): void {
    const deposit = data.deposit as Record<string, unknown>;
    deposit[field] = addDecimalStrings(deposit[field] ?? '0', amountUSD, 8);
  }

  /**
   * Keeps indexed referral rows as one fast lookup surface for both invited
   * users and accumulated rewards. Event rows carry positive reward deltas,
   * while storage refresh rows carry zero and must not erase prior rewards.
   */
  private async prepareReferrerRewardDocuments(documents: IndexerDocument[]): Promise<IndexerDocument[]> {
    const rewardDocuments = documents.filter((document) => document.collection === collection('referrerRewards'));
    if (!rewardDocuments.length) return documents;

    const existing = await this.repository.getMany(
      collection('referrerRewards'),
      rewardDocuments.map((document) => document.id)
    );
    const totals = new Map<string, bigint>();

    return documents.map((document) => {
      if (document.collection !== collection('referrerRewards')) return document;

      const previousAmount = totals.get(document.id) ?? referrerRewardAmount(existing.get(document.id)?.data.amount ?? 0);
      const incomingAmount = referrerRewardAmount(document.data.amount);
      const amount = incomingAmount > 0n ? previousAmount + incomingAmount : previousAmount;

      totals.set(document.id, amount);

      return {
        ...document,
        data: {
          ...document.data,
          amount: amount.toString(),
        },
      };
    });
  }

  private createEventDocuments(
    events: EventRecord[],
    blockHeight: number,
    timestamp: number,
    signer: string,
    prices: Map<string, bigint> = this.prices,
    assets: Map<string, AssetInfo> = this.assetInfos
  ): IndexerDocument[] {
    const documents: IndexerDocument[] = [];

    for (const { event } of events) {
      if (event.section === 'orderBook' && event.method.includes('LimitOrder')) {
        const data = eventData(event);
        documents.push(
          ...this.createOrderBookEventDocuments(
            event.method,
            data,
            blockHeight,
            timestamp,
            signer,
            prices,
            assets
          )
        );
        continue;
      }

      if (event.section === 'kensetsu') {
        const data = eventData(event);
        documents.push(...this.createVaultEventDocuments(event.method, data, blockHeight, timestamp, signer));
        continue;
      }

      if (event.section === 'xorFee' && event.method === 'ReferrerRewarded') {
        const data = eventData(event);
        const referral = firstString(data, ['referral', 'who', 'arg0']);
        const referrer = firstString(data, ['referrer', 'arg1']);
        const amount = codecToBigInt(data.amount ?? data.arg2 ?? 0);
        if (referral && referrer) {
          documents.push({
            collection: collection('referrerRewards'),
            id: `${referrer}-${referral}`,
            blockHeight,
            timestamp,
            data: {
              id: `${referrer}-${referral}`,
              referral,
              referrer,
              updated: timestamp,
              amount: amount.toString(),
            },
          });
        }
      }
    }

    return documents;
  }

  private createOrderBookEventDocuments(
    method: string,
    data: Record<string, unknown>,
    blockHeight: number,
    timestamp: number,
    signer: string,
    prices: Map<string, bigint> = this.prices,
    assets: Map<string, AssetInfo> = this.assetInfos
  ): IndexerDocument[] {
    const orderBookId = parseOrderBookId(data.orderBookId ?? data.arg0);
    const id = orderBookIdString(orderBookId);
    const documents: IndexerDocument[] = [];

    if (!orderBookId.baseAssetId || !orderBookId.quoteAssetId) return documents;

    if (method.includes('LimitOrder')) {
      const orderId = Number(data.orderId ?? data.arg1 ?? 0);
      const isBuy = String(data.side ?? data.arg2 ?? 'Buy') === 'Buy';
      const amount = codecToBigInt(data.amount ?? data.arg3 ?? 0);
      const price = codecToBigInt(data.price ?? data.arg4 ?? 0);
      const status = method === 'LimitOrderPlaced' || method === 'LimitOrderUpdated' ? 'Active' : method === 'LimitOrderFilled' ? 'Filled' : 'Canceled';
      const amountUSD = orderBookAmountUsd(
        orderBookId.baseAssetId,
        orderBookId.quoteAssetId,
        amount,
        price,
        isBuy ? 'Buy' : 'Sell',
        prices,
        assets
      );

      documents.push({
        collection: collection('orderBookOrders'),
        id: `${id}-${orderId}`,
        blockHeight,
        timestamp,
        data: {
          id: `${id}-${orderId}`,
          type: 'Limit',
          orderId,
          orderBookId: id,
          accountId: firstString(data, ['owner', 'accountId']) || signer,
          createdAtBlock: blockHeight,
          timestamp,
          isBuy,
          amount: decimalToString(amount),
          price: decimalToString(price),
          amountUSD,
          lifetime: Number(data.lifetime ?? 0),
          expiresAt: Number(data.expiresAt ?? 0),
          amountFilled: decimalToString(codecToBigInt(data.amountFilled ?? 0)),
          status,
          updatedAtBlock: blockHeight,
        },
      });
    }

    return documents;
  }

  private createVaultEventDocuments(
    method: string,
    data: Record<string, unknown>,
    blockHeight: number,
    timestamp: number,
    signer: string
  ): IndexerDocument[] {
    const id = String(data.cdpId ?? data.id ?? data.arg0 ?? '');
    if (!id) return [];

    const amount = codecToDecimalString(data.amount ?? data.collateralAmount ?? data.debt ?? 0);
    const typeMap: Record<string, string> = {
      CDPCreated: 'Created',
      CDPClosed: 'Closed',
      CollateralDeposit: 'CollateralDeposit',
      DebtIncreased: 'DebtIncreased',
      DebtPayment: 'DebtPayment',
      Liquidated: 'Liquidated',
    };
    const type = typeMap[method] ?? method;

    return [
      {
        collection: collection('vaultEvents'),
        id: `${id}-${blockHeight}-${method}`,
        blockHeight,
        timestamp,
        data: {
          id: `${id}-${blockHeight}-${method}`,
          vaultId: id,
          type,
          timestamp,
          block: blockHeight,
          amount,
        },
      },
      {
        collection: collection('vaults'),
        id,
        blockHeight,
        timestamp,
        data: {
          id,
          type: 'Type2',
          status: method === 'CDPClosed' ? 'Closed' : method === 'Liquidated' ? 'Liquidated' : 'Opened',
          ownerId: firstString(data, ['owner']) || signer,
          collateralAssetId: firstString(data, ['collateralAssetId']),
          debtAssetId: firstString(data, ['stablecoinAssetId', 'debtAssetId']),
          collateralAmountReturned: method === 'CDPClosed' || method === 'Liquidated' ? amount : '0',
          createdAtBlock: blockHeight,
          updatedAtBlock: blockHeight,
        },
      },
    ];
  }

  private publishPrices(prices: Map<string, bigint>, blockHeight: number): boolean {
    if (blockHeight < this.pricesBlockHeight) return false;
    this.prices = prices;
    this.pricesBlockHeight = blockHeight;
    return true;
  }

  private publishAssetInfos(assets: Map<string, AssetInfo>, blockHeight: number): boolean {
    if (blockHeight < this.assetInfosBlockHeight) return false;
    this.assetInfos = assets;
    this.assetInfosBlockHeight = blockHeight;
    return true;
  }

  private publishNetworkLiquidityStats(stats: NetworkLiquidityStats, blockHeight: number): boolean {
    if (blockHeight < this.networkLiquidityStatsBlockHeight) return false;
    this.networkLiquidityStats = stats;
    this.networkLiquidityStatsBlockHeight = blockHeight;
    return true;
  }

  private publishLiveValuationState(
    blockHeight: number,
    assets: Map<string, AssetInfo>,
    pools: Iterable<HistoricalValuationPool>,
    prices: Map<string, bigint>,
    networkLiquidityStats: NetworkLiquidityStats
  ): boolean {
    if (this.liveValuationState && blockHeight < this.liveValuationState.blockHeight) return false;
    const poolsById = new Map<string, HistoricalValuationPool>();
    for (const pool of pools) {
      poolsById.set(this.historicalPoolKey(pool.baseAssetId, pool.targetAssetId), {
        baseAssetId: pool.baseAssetId,
        targetAssetId: pool.targetAssetId,
        baseAssetReserves: pool.baseAssetReserves,
        targetAssetReserves: pool.targetAssetReserves,
      });
    }
    this.liveValuationState = {
      blockHeight,
      assets: new Map(assets),
      pools: poolsById,
      prices: new Map(prices),
      networkLiquidityStats: { ...networkLiquidityStats },
      orderBookLiquidityComplete: true,
    };
    return true;
  }

  private async ensureLiveValuationState(nextBlock: number): Promise<HistoricalValuationState> {
    const expectedBlock = Math.max(0, nextBlock - 1);
    if (this.liveValuationState?.blockHeight === expectedBlock) return this.liveValuationState;
    this.liveValuationState = await this.loadHistoricalValuationBaseline(expectedBlock, 'live-resume');
    return this.liveValuationState;
  }

  private promoteLiveValuationState(state: HistoricalValuationState): void {
    const current = this.liveValuationState;
    if (current && current.blockHeight > state.blockHeight) return;
    if (
      current &&
      current.blockHeight === state.blockHeight &&
      current.orderBookLiquidityComplete &&
      !state.orderBookLiquidityComplete
    ) {
      return;
    }
    this.liveValuationState = state;
  }

  private retireExpiredChartSnapshotBuckets(
    groups: readonly ChartSnapshotRetentionGroup[],
    _blockHeight: number,
    timestamp: number
  ): Promise<void> {
    const previous = this.chartSnapshotRetentionQueue;
    const run = previous
      .catch(() => undefined)
      .then(() => this.retireExpiredChartSnapshotBucketsInternal(groups, timestamp));
    this.chartSnapshotRetentionQueue = run;
    return run;
  }

  private async retireExpiredChartSnapshotBucketsInternal(
    groups: readonly ChartSnapshotRetentionGroup[],
    timestamp: number
  ): Promise<void> {
    const processed = new Set<string>();

    for (const group of groups) {
      for (const type of group.types ?? RETAINED_CHART_SNAPSHOT_TYPES) {
        const key = `${group.collection}:${type}`;
        if (processed.has(key)) continue;
        processed.add(key);
        const cutoff = timestamp - CHART_SNAPSHOT_RETENTION_SECONDS[type];
        if (cutoff <= 0) continue;
        const result = await this.deleteExpiredSnapshotPages(
          group.collection,
          type,
          cutoff,
          MAX_CHART_SNAPSHOT_RETENTION_PAGES_PER_TYPE_PER_REFRESH
        );
        metrics.increment(
          'indexer_worker_snapshot_retention_documents_total',
          { collection: group.collection, type },
          result.documents
        );
        metrics.increment(
          'indexer_worker_snapshot_retention_pages_total',
          { collection: group.collection, type },
          result.pages
        );
        metrics.setGauge(
          'indexer_worker_snapshot_retention_backlog',
          { collection: group.collection, type },
          result.exhausted ? 0 : 1
        );
      }
    }
  }

  private async deleteExpiredSnapshotPages(
    collectionName: ChartSnapshotCollection,
    type: SnapshotTypeName,
    cutoff: number,
    maximumPages: number
  ): Promise<{ documents: number; pages: number; exhausted: boolean }> {
    if (!this.repository.query) return { documents: 0, pages: 0, exhausted: true };

    let documents = 0;
    let pages = 0;
    let exhausted = false;
    for (let pageIndex = 0; pageIndex < maximumPages; pageIndex += 1) {
      const page = await this.repository.query(collectionName, {
        first: SNAPSHOT_RETIREMENT_DELETE_BATCH_SIZE,
        maxBytes: WORKER_REPOSITORY_QUERY_PAGE_MAX_BYTES,
        offset: null,
        orderBy: ['TIMESTAMP_ASC'],
        filter: {
          and: [{ type: { equalTo: type } }, { timestamp: { lessThan: cutoff } }],
        },
        includeTotalCount: false,
      });
      const ids = page.items.map((document) => document.id);
      if (!ids.length) {
        if (page.hasNextPage) {
          throw new Error(`Repository reported expired ${collectionName} rows without a deletion cursor`);
        }
        exhausted = true;
        break;
      }

      await this.deleteDocumentIdsInCallChunks(collectionName, ids);
      pages += 1;
      documents += ids.length;
      if (
        page.hasNextPage === false ||
        (page.hasNextPage === undefined && ids.length < SNAPSHOT_RETIREMENT_DELETE_BATCH_SIZE)
      ) {
        exhausted = true;
        break;
      }
    }

    return { documents, pages, exhausted };
  }

  /**
   * Raw per-block network rows are rolling-analytics inputs rather than public
   * chart history. Delete only rows strictly older than the thirty-one-day
   * safety horizon through the type/timestamp index. Deletion itself is the
   * durable cursor: a failed page remains visible for the next refresh, while
   * successful pages expose the next oldest rows without offset drift.
   */
  private async retireExpiredNetworkBlockSnapshots(timestamp: number): Promise<void> {
    const cutoff = timestamp - NETWORK_BLOCK_SNAPSHOT_RETENTION_SECONDS;
    if (cutoff <= 0) return;
    const result = await this.deleteExpiredSnapshotPages(
      'networkSnapshots',
      'BLOCK',
      cutoff,
      MAX_NETWORK_BLOCK_RETENTION_PAGES_PER_REFRESH
    );
    if (result.documents) {
      metrics.increment(
        'indexer_worker_network_block_retention_documents_total',
        {},
        result.documents
      );
      metrics.increment('indexer_worker_network_block_retention_pages_total', {}, result.pages);
    }
    metrics.setGauge('indexer_worker_network_block_retention_backlog', {}, result.exhausted ? 0 : 1);
  }

  private runProjectionRefreshExclusive(
    blockHeight: number,
    task: (query: any) => Promise<void>
  ): Promise<void> {
    const run = this.projectionRefreshQueue
      .catch(() => undefined)
      .then(async () => {
        if (blockHeight < this.highestCompletedProjectionBlock) {
          metrics.increment('indexer_worker_projection_refreshes_skipped_total', { reason: 'obsolete-block' });
          return;
        }
        const query = await this.getProjectionQueryAt(blockHeight);
        await this.withDerivedStorageLoadBudget(() => task(query));
        this.highestCompletedProjectionBlock = Math.max(this.highestCompletedProjectionBlock, blockHeight);
      });
    this.projectionRefreshQueue = run.catch(() => undefined);
    return run;
  }

  private refreshPolkamarktState(blockHeight: number, timestamp: number, includeSnapshots: boolean): Promise<void> {
    return this.runProjectionRefreshExclusive(blockHeight, (query) =>
      this.refreshPolkamarktStateInternal(query, blockHeight, timestamp, includeSnapshots)
    );
  }

  private async refreshPolkamarktStateInternal(
    query: any,
    blockHeight: number,
    timestamp: number,
    includeSnapshots: boolean
  ): Promise<void> {
    if (!this.api) throw new Error('Cannot refresh Polkamarkt state before the chain API is initialized');

    const canSynchronizeAccountPositions = this.canSynchronizePolkamarktAccountPositions(query);
    const canSynchronizeMarkets = this.canSynchronizePolkamarktMarkets(query);
    const [assetStorage, polkamarktStorage] = await Promise.all([
      this.loadAssetStorageDomain(blockHeight, false, query),
      this.loadPolkamarktStorageDomain(blockHeight, false, query),
    ]);
    const { assetInfos, tokenIssuances, nativeXorIssuance } = assetStorage;
    const {
      polkamarktConditions,
      polkamarktConditionDetails,
      polkamarktMarkets,
      polkamarktDpmCollaterals,
      polkamarktVolumes,
      polkamarktTotals,
      polkamarktResolutions,
      polkamarktResolutionEvidence,
      polkamarktCancellationEvidence,
      polkamarktPositions,
      polkamarktDpmCostBasis,
      polkamarktDpmCostBasisTotals,
      polkamarktCreatorFees,
      authoritativeForGeneration: polkamarktAuthoritative,
    } = polkamarktStorage;
    const supplyByAsset = this.createSupplyByAsset(tokenIssuances, nativeXorIssuance);
    const assets = new Map<string, AssetInfo>();

    for (const [key, value] of assetInfos) {
      const id = assetIdToString(key.args[0]);
      const human = toHuman(value) as Record<string, unknown>;
      assets.set(id, {
        id,
        symbol: String(human.symbol ?? ''),
        name: String(human.name ?? ''),
        decimals: Number(human.precision ?? DECIMALS),
        supply: supplyByAsset.get(id) ?? 0n,
      });
    }
    this.publishAssetInfos(assets, blockHeight);

    const polkamarktMarketDocuments = this.createPolkamarktMarketDocuments(
      polkamarktConditions,
      polkamarktConditionDetails,
      polkamarktMarkets,
      polkamarktDpmCollaterals,
      polkamarktVolumes,
      polkamarktTotals,
      polkamarktResolutions,
      polkamarktResolutionEvidence,
      polkamarktCancellationEvidence,
      polkamarktCreatorFees,
      assets,
      blockHeight,
      timestamp,
      includeSnapshots
    );
    const polkamarktPositionDocuments = this.createPolkamarktPositionDocuments(
      polkamarktPositions,
      polkamarktMarkets,
      polkamarktDpmCollaterals,
      polkamarktTotals,
      polkamarktResolutions,
      polkamarktDpmCostBasis,
      polkamarktDpmCostBasisTotals,
      assets,
      blockHeight,
      timestamp
    );

    await this.upsertDocumentsInCallChunks([...polkamarktMarketDocuments, ...polkamarktPositionDocuments]);
    if (polkamarktAuthoritative && canSynchronizeMarkets) {
      this.queueAuthoritativeReconciliation(
        collection('markets'),
        polkamarktMarkets.map(([key]) => String(key.args[0])),
        blockHeight
      );
      await this.reconcilePendingAuthoritativeCollection(collection('markets'));
    }
    if (polkamarktAuthoritative && canSynchronizeAccountPositions) {
      this.queueAuthoritativeReconciliation(
        collection('accountPositions'),
        polkamarktPositionDocuments.map((document) => document.id),
        blockHeight
      );
      await this.reconcilePendingAuthoritativeCollection(collection('accountPositions'));
    }
    if (includeSnapshots) {
      await this.retireExpiredChartSnapshotBuckets(
        [
          {
            collection: 'marketSnapshots',
          },
        ],
        blockHeight,
        timestamp
      );
    }
  }

  private refreshDerivedState(
    blockHeight: number,
    timestamp: number,
    includeSnapshots: boolean,
    forceFullReconciliation = false
  ): Promise<void> {
    return this.runProjectionRefreshExclusive(blockHeight, (query) =>
      this.refreshDerivedStateInternal(query, blockHeight, timestamp, includeSnapshots, forceFullReconciliation)
    );
  }

  private async refreshDerivedStateInternal(
    query: any,
    blockHeight: number,
    timestamp: number,
    includeSnapshots: boolean,
    forceFullReconciliation = false
  ): Promise<void> {
    if (!this.api) throw new Error('Cannot refresh derived state before the chain API is initialized');

    const canSynchronizeAccountPositions = this.canSynchronizePolkamarktAccountPositions(query);
    const canSynchronizeMarkets = this.canSynchronizePolkamarktMarkets(query);
    const forceStorageReconciliation =
      forceFullReconciliation || this.shouldFullyReconcileDerivedStorage(blockHeight);
    const shouldRefreshPoolProviders =
      forceStorageReconciliation || this.dirtyDerivedStorageDomains.has('poolProviders');
    const auxiliaryStoragePromise = Promise.all([
      shouldRefreshPoolProviders
        ? this.loadDerivedStorageDomainWithStatus('poolProviders', blockHeight, forceStorageReconciliation, () =>
            this.fetchStorageEntries(query.poolXYK.poolProviders, 'poolXYK.poolProviders')
          )
        : Promise.resolve({
            value: [] as StorageEntries,
            refreshed: false,
            authoritativeForGeneration: false,
          }),
      this.loadDerivedStorageDomainWithStatus('staking', blockHeight, forceStorageReconciliation, async () => {
        const [nominators, validatorInputs] = await Promise.all([
          this.fetchStorageEntries(query.staking.nominators, 'staking.nominators'),
          this.loadStakingValidatorProjectionInputs(query),
        ]);
        return { nominators, validatorInputs } satisfies StakingStorageState;
      }),
      this.loadDerivedStorageDomain('referrals', blockHeight, forceStorageReconciliation, () =>
        this.fetchStorageEntries(query.referrals.referrers, 'referrals.referrers')
      ),
      this.loadDerivedStorageDomain('vaults', blockHeight, forceStorageReconciliation, () =>
        this.fetchStorageEntries(query.kensetsu.cdpDepository, 'kensetsu.cdpDepository')
      ),
    ]);
    const [assetStorage, poolStorage, orderBookLoad, polkamarktStorage, farmingPoolFarmers] =
      await Promise.all([
        this.loadAssetStorageDomain(blockHeight, forceStorageReconciliation, query),
        this.loadPoolStorageDomain(blockHeight, forceStorageReconciliation, query),
        this.loadDerivedStorageDomainWithStatus('orderBooks', blockHeight, forceStorageReconciliation, async () => {
          const [orderBooks, orderBookBids, orderBookAsks, orderBookLimitOrders] = await Promise.all([
            this.fetchStorageEntries(query.orderBook.orderBooks, 'orderBook.orderBooks'),
            this.fetchStorageEntries(query.orderBook.bids, 'orderBook.bids'),
            this.fetchStorageEntries(query.orderBook.asks, 'orderBook.asks'),
            this.fetchStorageEntries(query.orderBook.limitOrders, 'orderBook.limitOrders'),
          ]);
          return { orderBooks, orderBookBids, orderBookAsks, orderBookLimitOrders };
        }),
        this.loadPolkamarktStorageDomain(blockHeight, forceStorageReconciliation, query),
        this.loadDerivedStorageDomain('farming', blockHeight, forceStorageReconciliation, () =>
          this.fetchStorageEntries(query.farming.poolFarmers, 'farming.poolFarmers')
        ),
      ]);
    const { assetInfos, tokenIssuances, nativeXorIssuance, assetMetadataAuthoritative } = assetStorage;
    const { poolProperties, poolReserves, poolIssuances, poolReservesAuthoritative } = poolStorage;
    const { orderBooks, orderBookBids, orderBookAsks, orderBookLimitOrders } = orderBookLoad.value;
    const {
      polkamarktConditions,
      polkamarktConditionDetails,
      polkamarktMarkets,
      polkamarktDpmCollaterals,
      polkamarktVolumes,
      polkamarktTotals,
      polkamarktResolutions,
      polkamarktResolutionEvidence,
      polkamarktCancellationEvidence,
      polkamarktPositions,
      polkamarktDpmCostBasis,
      polkamarktDpmCostBasisTotals,
      polkamarktCreatorFees,
      authoritativeForGeneration: polkamarktAuthoritative,
    } = polkamarktStorage;
    const effectiveBlockHeight = blockHeight;
    const supplyByAsset = this.createSupplyByAsset(tokenIssuances, nativeXorIssuance);

    const assets = new Map<string, AssetInfo>();
    for (const [key, value] of assetInfos) {
      const id = assetIdToString(key.args[0]);
      const human = toHuman(value) as Record<string, unknown>;
      assets.set(id, {
        id,
        symbol: String(human.symbol ?? ''),
        name: String(human.name ?? ''),
        decimals: Number(human.precision ?? DECIMALS),
        supply: supplyByAsset.get(id) ?? 0n,
      });
    }
    this.publishAssetInfos(assets, effectiveBlockHeight);

    const poolAccounts = new Map<string, string>();
    for (const [key, value] of poolProperties) {
      const baseAssetId = assetIdToString(key.args[0]);
      const targetAssetId = assetIdToString(key.args[1]);
      const human = toHuman(value);
      const poolAccount = Array.isArray(human) ? String(human[0] ?? '') : '';
      poolAccounts.set(`${baseAssetId}-${targetAssetId}`, poolAccount);
    }

    const issuanceByPoolAccount = new Map<string, bigint>();
    for (const [key, value] of poolIssuances) {
      issuanceByPoolAccount.set(String(key.args[0]), codecToBigInt(value));
    }

    const poolsRaw: Array<{
      baseAssetId: string;
      targetAssetId: string;
      baseAssetReserves: bigint;
      targetAssetReserves: bigint;
    }> = (poolReserves as Array<[any, any]>).map(([key, value]) => {
      const reserves = toJson(value);
      return {
        baseAssetId: assetIdToString(key.args[0]),
        targetAssetId: assetIdToString(key.args[1]),
        baseAssetReserves: codecToBigInt(Array.isArray(reserves) ? reserves[0] : 0),
        targetAssetReserves: codecToBigInt(Array.isArray(reserves) ? reserves[1] : 0),
      };
    });
    const prices = this.derivePrices(assets, poolsRaw);
    this.publishPrices(prices, effectiveBlockHeight);

    const exactPoolLiquidities: bigint[] = [];
    const poolStates: PoolState[] = poolsRaw.map((pool) => {
      const id = `${pool.baseAssetId}-${pool.targetAssetId}`;
      const poolAccount = poolAccounts.get(id) ?? '';
      const baseLiquidity = scaledMul(scaledDiv(pool.baseAssetReserves, 10n ** BigInt(assets.get(pool.baseAssetId)?.decimals ?? DECIMALS)), prices.get(pool.baseAssetId) ?? 0n);
      const targetLiquidity = scaledMul(
        scaledDiv(pool.targetAssetReserves, 10n ** BigInt(assets.get(pool.targetAssetId)?.decimals ?? DECIMALS)),
        prices.get(pool.targetAssetId) ?? 0n
      );
      const liquidity = baseLiquidity + targetLiquidity;
      exactPoolLiquidities.push(liquidity);
      const supply = issuanceByPoolAccount.get(poolAccount) ?? 0n;

      return {
        id,
        ...pool,
        poolAccount,
        poolTokenSupply: supply,
        liquidityUSD: scaledToString(liquidity, 8),
        priceUSD: scaledToString(prices.get(pool.targetAssetId) ?? 0n, 8),
      };
    });

    const assetPoolLiquidity = new Map<string, bigint>();
    for (const pool of poolStates) {
      assetPoolLiquidity.set(pool.baseAssetId, (assetPoolLiquidity.get(pool.baseAssetId) ?? 0n) + pool.baseAssetReserves);
      assetPoolLiquidity.set(pool.targetAssetId, (assetPoolLiquidity.get(pool.targetAssetId) ?? 0n) + pool.targetAssetReserves);
    }

    const { poolLiquidityUSD, activePools } = summarizeExactPoolLiquidity(exactPoolLiquidities);
    const provisionalLiquidityStats = createNetworkLiquidityStats(poolLiquidityUSD, '0', activePools, 0, assets.size);
    const analytics = await this.buildAnalytics(
      timestamp,
      assets,
      prices,
      poolStates,
      provisionalLiquidityStats,
      effectiveBlockHeight
    );
    this.mergeLimitOrderStorage(orderBookLimitOrders, assets, prices, analytics);
    const orderBookLiquidityUSD = scaledToString(
      [...analytics.orderBookActiveReserves.values()].reduce((sum, reserves) => sum + reserves.liquidityUSD, 0n),
      8
    );
    const activeOrderBooks = [...analytics.orderBookActiveReserves.values()].filter((reserves) => reserves.liquidityUSD > 0n).length;
    const liquidityStats = createNetworkLiquidityStats(poolLiquidityUSD, orderBookLiquidityUSD, activePools, activeOrderBooks, assets.size);
    this.publishNetworkLiquidityStats(liquidityStats, effectiveBlockHeight);
    this.publishLiveValuationState(effectiveBlockHeight, assets, poolStates, prices, liquidityStats);
    this.applyNetworkLiquidityStats(analytics, liquidityStats);
    const apyByPool = this.derivePoolApy(poolStates, farmingPoolFarmers, effectiveBlockHeight, prices);
    const [assetDocuments, poolDocuments, orderBookDocuments] = await Promise.all([
      this.createAssetDocuments(assets, prices, assetPoolLiquidity, analytics, effectiveBlockHeight, timestamp, includeSnapshots),
      this.createPoolDocuments(poolStates, analytics, apyByPool, effectiveBlockHeight, timestamp, includeSnapshots),
      this.createOrderBookDocuments(
        orderBooks,
        orderBookBids,
        orderBookAsks,
        orderBookLimitOrders,
        assets,
        prices,
        analytics,
        effectiveBlockHeight,
        timestamp,
        includeSnapshots
      ),
    ]);
    const polkamarktMarketDocuments = this.createPolkamarktMarketDocuments(
      polkamarktConditions,
      polkamarktConditionDetails,
      polkamarktMarkets,
      polkamarktDpmCollaterals,
      polkamarktVolumes,
      polkamarktTotals,
      polkamarktResolutions,
      polkamarktResolutionEvidence,
      polkamarktCancellationEvidence,
      polkamarktCreatorFees,
      assets,
      effectiveBlockHeight,
      timestamp,
      includeSnapshots
    );
    const polkamarktPositionDocuments = this.createPolkamarktPositionDocuments(
      polkamarktPositions,
      polkamarktMarkets,
      polkamarktDpmCollaterals,
      polkamarktTotals,
      polkamarktResolutions,
      polkamarktDpmCostBasis,
      polkamarktDpmCostBasisTotals,
      assets,
      effectiveBlockHeight,
      timestamp
    );
    const marketDocuments: IndexerDocument[] = [
      ...assetDocuments,
      ...poolDocuments,
      ...orderBookDocuments,
      ...polkamarktMarketDocuments,
      ...polkamarktPositionDocuments,
      ...this.createNetworkSnapshotDocuments(analytics, effectiveBlockHeight, timestamp, includeSnapshots),
      ...this.createUpdateStreams(poolStates, assets, prices, apyByPool, effectiveBlockHeight, timestamp),
    ];

    await this.upsertDocumentsInCallChunks(marketDocuments);
    if (assetMetadataAuthoritative) {
      this.queueAuthoritativeReconciliation(
        collection('assets'),
        assetInfos.map(([key]) => assetIdToString(key.args[0])),
        effectiveBlockHeight
      );
    }
    if (poolReservesAuthoritative) {
      this.queueAuthoritativeReconciliation(
        collection('poolXYKs'),
        poolReserves.map(([key]) => `${assetIdToString(key.args[0])}-${assetIdToString(key.args[1])}`),
        effectiveBlockHeight
      );
    }
    if (orderBookLoad.refreshed && orderBookLoad.authoritativeForGeneration) {
      this.queueAuthoritativeReconciliation(
        collection('orderBooks'),
        orderBooks.map(([key]) => orderBookIdString(parseOrderBookId(key.args[0]))),
        effectiveBlockHeight
      );
    }
    if (polkamarktAuthoritative && canSynchronizeMarkets) {
      this.queueAuthoritativeReconciliation(
        collection('markets'),
        polkamarktMarkets.map(([key]) => String(key.args[0])),
        effectiveBlockHeight
      );
    }
    if (polkamarktAuthoritative && canSynchronizeAccountPositions) {
      this.queueAuthoritativeReconciliation(
        collection('accountPositions'),
        polkamarktPositionDocuments.map((document) => document.id),
        effectiveBlockHeight
      );
    }
    await this.reconcilePendingAuthoritativeCollection(collection('assets'));
    await this.reconcilePendingAuthoritativeCollection(collection('poolXYKs'));
    await this.reconcilePendingAuthoritativeCollection(collection('orderBooks'));
    await this.reconcilePendingAuthoritativeCollection(collection('markets'));
    await this.reconcilePendingAuthoritativeCollection(collection('accountPositions'));
    if (includeSnapshots) {
      await this.retireExpiredChartSnapshotBuckets(
        [
          { collection: 'accountLiquiditySnapshots', types: ['DEFAULT'] },
          { collection: 'assetSnapshots' },
          { collection: 'poolSnapshots' },
          { collection: 'orderBookSnapshots' },
          { collection: 'marketSnapshots' },
          { collection: 'networkSnapshots' },
        ],
        effectiveBlockHeight,
        timestamp
      );
      await this.retireExpiredNetworkBlockSnapshots(timestamp);
    }

    const [poolProviderLoad, stakingLoad, referrers, cdpEntries] = await auxiliaryStoragePromise;
    const poolProviders = poolProviderLoad.value;
    const { nominators, validatorInputs } = stakingLoad.value;
    const stakingValidatorDocuments = this.createStakingValidatorDocumentsFromInputs(
      validatorInputs,
      effectiveBlockHeight,
      timestamp,
      prices,
      assets
    );
    const [vaultDocuments, accountLiquidityDocuments] = await Promise.all([
      this.createVaultDocuments(cdpEntries, effectiveBlockHeight, timestamp),
      this.createChangedAccountLiquidityDocuments(
        poolProviders,
        poolStates,
        assets,
        prices,
        effectiveBlockHeight,
        timestamp,
        shouldRefreshPoolProviders
      ),
    ]);
    const auxiliaryDocuments: IndexerDocument[] = [
      ...this.createStakingDocuments(nominators, effectiveBlockHeight, timestamp),
      ...stakingValidatorDocuments,
      this.createStakingValidatorsStream(stakingValidatorDocuments, effectiveBlockHeight, timestamp),
      ...this.createReferralDocuments(referrers, effectiveBlockHeight, timestamp),
      ...vaultDocuments,
      ...accountLiquidityDocuments,
    ];

    await this.upsertDocumentsInCallChunks(await this.prepareReferrerRewardDocuments(auxiliaryDocuments));
    if (stakingLoad.refreshed && stakingLoad.authoritativeForGeneration) {
      this.queueAuthoritativeReconciliation(
        collection('stakingStakers'),
        nominators.map(([key]) => String(key.args[0])),
        effectiveBlockHeight
      );
    }
    if (stakingLoad.refreshed && stakingLoad.authoritativeForGeneration) {
      this.queueAuthoritativeReconciliation(
        collection('stakingValidators'),
        stakingValidatorDocuments.map((document) => document.id),
        effectiveBlockHeight
      );
    }
    await this.reconcilePendingAuthoritativeCollection(collection('stakingStakers'));
    await this.reconcilePendingAuthoritativeCollection(collection('stakingValidators'));
    this.completeDerivedStorageReconciliation(blockHeight, forceStorageReconciliation);
  }

  private refreshPriceStream(blockHeight: number, timestamp: number): Promise<void> {
    return this.runProjectionRefreshExclusive(blockHeight, (query) =>
      this.refreshPriceStreamInternal(query, blockHeight, timestamp)
    );
  }

  private async refreshPriceStreamInternal(query: any, blockHeight: number, timestamp: number): Promise<void> {
    if (!this.api) throw new Error('Cannot refresh price stream before the chain API is initialized');
    if (blockHeight < this.pricesBlockHeight) return;

    const [assetInfos, poolReserves] = await Promise.all([
      this.loadDerivedStorageDomain('assetMetadata', blockHeight, false, () =>
        this.fetchStorageEntries(query.assets.assetInfosV2, 'assets.assetInfosV2')
      ),
      this.loadDerivedStorageDomain('poolReserves', blockHeight, false, () =>
        this.fetchStorageEntries(query.poolXYK.reserves, 'poolXYK.reserves')
      ),
    ]);
    const assets = new Map<string, Pick<AssetInfo, 'id' | 'decimals'>>();

    for (const [key, value] of assetInfos) {
      const id = assetIdToString(key.args[0]);
      const human = toHuman(value) as Record<string, unknown>;
      assets.set(id, {
        id,
        decimals: Number(human.precision ?? DECIMALS),
      });
    }

    const poolsRaw: Array<{
      baseAssetId: string;
      targetAssetId: string;
      baseAssetReserves: bigint;
      targetAssetReserves: bigint;
    }> = (poolReserves as Array<[any, any]>).map(([key, value]) => {
      const reserves = toJson(value);
      return {
        baseAssetId: assetIdToString(key.args[0]),
        targetAssetId: assetIdToString(key.args[1]),
        baseAssetReserves: codecToBigInt(Array.isArray(reserves) ? reserves[0] : 0),
        targetAssetReserves: codecToBigInt(Array.isArray(reserves) ? reserves[1] : 0),
      };
    });
    const prices = this.derivePrices(assets, poolsRaw);

    this.publishPrices(prices, blockHeight);
    await this.repository.upsert(this.createPriceStreamDocument(assets.keys(), prices, blockHeight, timestamp));
  }

  private canSynchronizePolkamarktAccountPositions(query: any = this.api?.query): boolean {
    const polkamarkt = (query as { polkamarkt?: Record<string, unknown> } | undefined)?.polkamarkt;

    return (
      hasStorageEntries(polkamarkt?.markets) &&
      hasStorageEntries(polkamarkt?.marketPositions)
    );
  }

  private canSynchronizePolkamarktMarkets(query: any = this.api?.query): boolean {
    const polkamarkt = (query as { polkamarkt?: Record<string, unknown> } | undefined)?.polkamarkt;
    return hasStorageEntries(polkamarkt?.markets);
  }

  private async reconcileAuthoritativeCollection(
    collectionName: IndexerCollection,
    activeIdsInput: Iterable<string>,
    authoritativeBlockHeight: number
  ): Promise<void> {
    const activeIds = new Set(activeIdsInput);
    let staleIds: string[] = [];

    for await (const page of this.queryPages(collectionName, { orderBy: ['ID_ASC'] })) {
      for (const document of page) {
        const documentBlockHeight = Number(document.blockHeight ?? document.data.blockHeight ?? 0);
        if (
          !activeIds.has(document.id) &&
          Number.isFinite(documentBlockHeight) &&
          documentBlockHeight <= authoritativeBlockHeight
        ) {
          staleIds.push(document.id);
        }
        if (staleIds.length === 1_000) {
          await this.deleteDocumentIdsInCallChunks(collectionName, staleIds);
          staleIds = [];
        }
      }
    }
    await this.deleteDocumentIdsInCallChunks(collectionName, staleIds);
  }

  private queueAuthoritativeReconciliation(
    collectionName: IndexerCollection,
    activeIds: Iterable<string>,
    authoritativeBlockHeight: number
  ): void {
    this.pendingAuthoritativeReconciliations.set(collectionName, {
      activeIds: new Set(activeIds),
      blockHeight: authoritativeBlockHeight,
    });
  }

  private async reconcilePendingAuthoritativeCollection(collectionName: IndexerCollection): Promise<void> {
    const plan = this.pendingAuthoritativeReconciliations.get(collectionName);
    if (!plan) return;
    await this.reconcileAuthoritativeCollection(collectionName, plan.activeIds, plan.blockHeight);
    if (this.pendingAuthoritativeReconciliations.get(collectionName) === plan) {
      this.pendingAuthoritativeReconciliations.delete(collectionName);
    }
  }

  private async deleteStaleAccountPositionDocuments(
    activeDocuments: IndexerDocument[],
    authoritativeBlockHeight = Math.max(
      0,
      ...activeDocuments.map((document) => Number(document.blockHeight ?? 0))
    )
  ): Promise<void> {
    await this.reconcileAuthoritativeCollection(
      collection('accountPositions'),
      activeDocuments.map((document) => document.id),
      authoritativeBlockHeight
    );
  }

  private derivePrices(
    assets: Map<string, Pick<AssetInfo, 'id' | 'decimals'>>,
    pools: Array<{ baseAssetId: string; targetAssetId: string; baseAssetReserves: bigint; targetAssetReserves: bigint }>
  ): Map<string, bigint> {
    const prices = new Map<string, bigint>();
    const confidence = new Map<string, bigint>();
    const depth = new Map<string, bigint>();
    const fixedAssets = new Set<string>();

    for (const asset of assets.values()) {
      if (STABLE_ASSET_IDS.has(asset.id)) {
        prices.set(asset.id, SCALE);
        fixedAssets.add(asset.id);
      }
    }

    for (let round = 0; round < 12; round += 1) {
      let changed = false;

      for (const pool of pools) {
        if (pool.baseAssetReserves === 0n || pool.targetAssetReserves === 0n) continue;

        const baseInfo = assets.get(pool.baseAssetId);
        const targetInfo = assets.get(pool.targetAssetId);
        if (!baseInfo || !targetInfo) continue;

        const baseNatural = reserveToNaturalScaled(pool.baseAssetReserves, baseInfo.decimals);
        const targetNatural = reserveToNaturalScaled(pool.targetAssetReserves, targetInfo.decimals);
        if (baseNatural === 0n || targetNatural === 0n) continue;

        const basePrice = prices.get(pool.baseAssetId);
        const targetPrice = prices.get(pool.targetAssetId);

        const applyCandidate = (assetId: string, price: bigint, candidateConfidence: bigint, candidateDepth: bigint) => {
          if (
            fixedAssets.has(assetId) ||
            price <= 0n ||
            candidateConfidence < MIN_PRICE_DISCOVERY_LIQUIDITY_USD ||
            candidateDepth < MIN_PRICE_DISCOVERY_AMOUNT
          ) {
            return;
          }

          const currentDepth = depth.get(assetId) ?? 0n;
          const currentConfidence = confidence.get(assetId) ?? 0n;

          if (candidateDepth > currentDepth || (candidateDepth === currentDepth && candidateConfidence > currentConfidence)) {
            prices.set(assetId, price);
            confidence.set(assetId, candidateConfidence);
            depth.set(assetId, candidateDepth);
            changed = true;
          }
        };

        if (basePrice && basePrice > 0n) {
          const baseLiquidityUSD = scaledMul(baseNatural, basePrice);
          const baseConfidence = confidence.get(pool.baseAssetId);
          applyCandidate(
            pool.targetAssetId,
            scaledDiv(baseLiquidityUSD, targetNatural),
            baseConfidence ? baseConfidence < baseLiquidityUSD ? baseConfidence : baseLiquidityUSD : baseLiquidityUSD,
            targetNatural
          );
        }

        if (targetPrice && targetPrice > 0n) {
          const targetLiquidityUSD = scaledMul(targetNatural, targetPrice);
          const targetConfidence = confidence.get(pool.targetAssetId);
          applyCandidate(
            pool.baseAssetId,
            scaledDiv(targetLiquidityUSD, baseNatural),
            targetConfidence ? targetConfidence < targetLiquidityUSD ? targetConfidence : targetLiquidityUSD : targetLiquidityUSD,
            baseNatural
          );
        }
      }

      if (!changed) {
        break;
      }
    }

    return prices;
  }

  /**
   * Repository write calls are deliberately capped so validation and backend
   * transactions cannot grow without bound. Only idempotent current-state
   * projections use this helper; finalized block writes remain a single
   * transaction because they contain read-modify-write aggregates.
   */
  private async upsertDocumentsInCallChunks(documents: IndexerDocument[]): Promise<void> {
    if (!documents.length) return;
    if (documents.length <= MAX_REPOSITORY_WRITE_CALL_DOCUMENTS) {
      await this.repository.upsertMany(documents);
      return;
    }

    for (let start = 0; start < documents.length; start += MAX_REPOSITORY_WRITE_CALL_DOCUMENTS) {
      await this.repository.upsertMany(documents.slice(start, start + MAX_REPOSITORY_WRITE_CALL_DOCUMENTS));
    }
  }

  private async deleteDocumentIdsInCallChunks(
    collectionName: IndexerCollection,
    ids: readonly string[]
  ): Promise<void> {
    for (let start = 0; start < ids.length; start += MAX_REPOSITORY_WRITE_CALL_DOCUMENTS) {
      await this.repository.deleteMany(
        collectionName,
        ids.slice(start, start + MAX_REPOSITORY_WRITE_CALL_DOCUMENTS)
      );
    }
  }

  private async *queryPages(
    collectionName: IndexerCollection,
    args: RepositoryQueryArgs = {},
    remainingRetainedBytes?: () => number
  ): AsyncGenerator<IndexerDocument[], void, unknown> {
    if (!this.repository.query) {
      yield await this.repository.list(collectionName);
      return;
    }

    const pageSize = 1_000;
    const firstOrder = Array.isArray(args.orderBy) ? args.orderBy[0] : args.orderBy;
    const normalizedOrder = String(firstOrder ?? '').toUpperCase();
    const useIdKeyset =
      normalizedOrder === 'ID_ASC' &&
      args.offset === undefined &&
      args.after === undefined &&
      args.last === undefined &&
      args.keyset === undefined;
    const seekField =
      normalizedOrder === 'TIMESTAMP_ASC'
        ? 'timestamp'
        : normalizedOrder === 'BLOCK_HEIGHT_ASC'
          ? 'blockHeight'
          : null;
    const useSeek =
      seekField !== null &&
      args.offset === undefined &&
      args.after === undefined &&
      args.last === undefined;
    let offset = 0;
    let seek: RepositoryQueryArgs['seek'];
    let keyset: RepositoryQueryArgs['keyset'];
    const configuredPageMaxBytes = Math.min(
      WORKER_REPOSITORY_QUERY_PAGE_MAX_BYTES,
      args.maxBytes ?? WORKER_REPOSITORY_QUERY_PAGE_MAX_BYTES
    );

    while (true) {
      const remainingBytes = remainingRetainedBytes?.();
      if (remainingBytes !== undefined && remainingBytes <= 0) {
        throw new Error(`Repository ${collectionName} load exhausted its aggregate retained-byte budget`);
      }
      const pageMaxBytes = Math.min(
        configuredPageMaxBytes,
        remainingBytes ?? configuredPageMaxBytes
      );
      const page = await this.repository.query(collectionName, {
        ...args,
        first: pageSize,
        maxBytes: pageMaxBytes,
        offset: useSeek || useIdKeyset ? null : offset,
        includeTotalCount: false,
        seek,
        keyset: useIdKeyset ? keyset : args.keyset,
      });
      if (page.items.length) yield page.items;

      // Byte-limited repositories can deliberately return a short page while
      // more matches remain. PageInfo is therefore authoritative; the length
      // fallback exists only for older repository test doubles.
      const hasNextPage = page.hasNextPage ?? page.items.length >= pageSize;
      if (!hasNextPage) break;
      if (!page.items.length) {
        throw new Error(`Repository reported another ${collectionName} page without returning a cursor row`);
      }

      if (useIdKeyset) {
        const last = page.items[page.items.length - 1];
        if (!last) break;
        keyset = {
          scope: createRepositoryCursorScope(collectionName, args.orderBy, args.filter),
          field: 'id',
          value: last.id,
          id: last.id,
          direction: 'asc',
          numeric: false,
        };
      } else if (useSeek) {
        const last = page.items[page.items.length - 1];
        const seekValue = Number(
          seekField === 'timestamp' ? last?.timestamp ?? last?.data.timestamp : last?.blockHeight ?? last?.data.blockHeight
        );
        if (!last || !Number.isFinite(seekValue)) break;

        seek = { field: seekField, value: seekValue, id: last.id, direction: 'asc' };
      } else {
        // A byte budget may truncate an offset page before `pageSize`.
        offset += page.items.length;
      }
    }
  }

  private async queryAll(collectionName: IndexerCollection, args: RepositoryQueryArgs = {}): Promise<IndexerDocument[]> {
    const documents: IndexerDocument[] = [];

    for await (const page of this.queryPages(collectionName, args)) {
      documents.push(...page);
    }

    return documents;
  }

  private retainAnalyticsValueWithinBudget<T>(
    value: T,
    budget: AnalyticsRetainedLoadBudget,
    collectionName: IndexerCollection
  ): T {
    const remaining = Math.max(0, budget.maximumBytes - budget.retainedBytes);
    const estimatedBytes =
      estimateRetainedValueBytes(value, Math.max(0, remaining - ANALYTICS_RETAINED_ENTRY_OVERHEAD_BYTES)) +
      ANALYTICS_RETAINED_ENTRY_OVERHEAD_BYTES;
    if (estimatedBytes > remaining) {
      metrics.increment('indexer_worker_analytics_cold_load_rejections_total', {
        collection: collectionName,
        reason: 'byte-budget',
      });
      throw new Error(
        `Cold analytics input exceeds its ${budget.maximumBytes} byte retained-load limit while reading ${collectionName}`
      );
    }
    budget.retainedBytes += estimatedBytes;
    metrics.setGauge('indexer_worker_analytics_cold_load_retained_bytes', {}, budget.retainedBytes);
    return value;
  }

  private async queryAllWithinAnalyticsBudget(
    collectionName: IndexerCollection,
    args: RepositoryQueryArgs,
    budget: AnalyticsRetainedLoadBudget
  ): Promise<IndexerDocument[]> {
    const documents: IndexerDocument[] = [];
    for await (const page of this.queryPages(collectionName, {
      ...args,
      maxBytes: WORKER_REPOSITORY_QUERY_PAGE_MAX_BYTES,
    }, () => budget.maximumBytes - budget.retainedBytes)) {
      for (const document of page) {
        documents.push(this.retainAnalyticsValueWithinBudget(document, budget, collectionName));
      }
    }
    return documents;
  }

  private analyticsDocumentTimestamp(document: IndexerDocument): number {
    const timestamp = Number(document.data.timestamp ?? document.timestamp ?? 0);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  private mergeAnalyticsInputDocuments(
    cached: IndexerDocument[],
    cachedById: Map<string, IndexerDocument>,
    fresh: IndexerDocument[],
    since: number,
    timestampOf: (document: IndexerDocument) => number = (document) => this.analyticsDocumentTimestamp(document)
  ): IndexerDocument[] {
    const compare = (left: IndexerDocument, right: IndexerDocument): number =>
      timestampOf(left) - timestampOf(right) || compareLexical(left.id, right.id);
    const lowerBound = (document: IndexerDocument): number => {
      let low = 0;
      let high = cached.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (compare(cached[middle]!, document) < 0) low = middle + 1;
        else high = middle;
      }
      return low;
    };

    // Expire only the sorted prefix and retain the existing array/map. This
    // avoids rebuilding and sorting a month-sized cache for a five-minute
    // overlap delta.
    let expired = 0;
    while (expired < cached.length && timestampOf(cached[expired]!) < since) expired += 1;
    if (expired > 0) {
      for (let index = 0; index < expired; index += 1) {
        const document = cached[index]!;
        if (cachedById.get(document.id) === document) cachedById.delete(document.id);
      }
      cached.splice(0, expired);
    }

    const orderedFresh = [...fresh].sort(compare);
    for (const document of orderedFresh) {
      if (timestampOf(document) < since) continue;
      const existing = cachedById.get(document.id);
      if (existing) {
        const existingIndex = lowerBound(existing);
        if (cached[existingIndex] === existing) cached.splice(existingIndex, 1);
        else {
          // Defensive fallback for a corrupted ordering invariant. This path
          // is correction-only and never runs for the normal append suffix.
          const fallbackIndex = cached.indexOf(existing);
          if (fallbackIndex >= 0) cached.splice(fallbackIndex, 1);
        }
      }

      const insertionIndex = lowerBound(document);
      if (insertionIndex === cached.length) cached.push(document);
      else cached.splice(insertionIndex, 0, document);
      cachedById.set(document.id, document);
    }

    return cached;
  }

  private invalidateAnalyticsInputCache(): void {
    const evictedBytes = this.analyticsInputCacheBytes;
    this.analyticsInputCacheGeneration += 1;
    this.analyticsInputCache = null;
    this.rollingNetworkInputCache = null;
    this.analyticsInputCacheBytes = 0;
    this.analyticsInputCacheMetrics.invalidations += 1;
    if (evictedBytes > 0) {
      this.analyticsInputCacheMetrics.evictions += 1;
      this.analyticsInputCacheMetrics.evictedBytes += evictedBytes;
      metrics.increment('indexer_worker_analytics_input_cache_evictions_total');
      metrics.increment('indexer_worker_analytics_input_cache_evicted_bytes_total', {}, evictedBytes);
    }
    metrics.increment('indexer_worker_analytics_input_cache_invalidations_total');
    metrics.setGauge('indexer_worker_analytics_input_cached_bytes', {}, 0);
    metrics.setGauge('indexer_worker_analytics_input_cached_documents', {}, 0);
    metrics.setGauge('indexer_worker_analytics_rolling_cached_documents', { collection: 'networkSnapshots' }, 0);
  }

  /** Exposes cache counters without coupling worker analytics to a metrics backend. */
  private getAnalyticsInputCacheMetrics(): AnalyticsInputCacheMetrics & {
    cachedDocuments: number;
    cachedBytes: number;
    maximumBytes: number;
  } {
    const cache = this.analyticsInputCache;
    const cachedDocuments = cache
      ? cache.history.length +
        (this.rollingNetworkInputCache?.blocks.length ?? cache.blockSnapshots.length) +
        cache.orderBookOrders.length +
        cache.assetDaySnapshots.length +
        cache.orderBookDaySnapshots.length
      : 0;

    return {
      ...this.analyticsInputCacheMetrics,
      cachedDocuments,
      cachedBytes: this.analyticsInputCacheBytes,
      maximumBytes: this.config.analyticsInputCacheMaxBytes,
    };
  }

  private async loadAnalyticsInputDocuments(
    timestamp: number,
    sourceVersion?: number
  ): Promise<AnalyticsInputLoad> {
    const monthSince = Math.max(0, timestamp - SNAPSHOT_WINDOW_SECONDS.MONTH);
    const assetWeekSince = Math.max(0, timestamp - 7 * 86_400);
    const orderBookDaySince = Math.max(0, timestamp - 86_400);
    const cached = sourceVersion === undefined ? null : this.analyticsInputCache;
    const canLoadIncrementally = Boolean(
      cached && sourceVersion !== undefined && sourceVersion >= cached.sourceVersion && timestamp >= cached.refreshedAt
    );

    if (cached && !canLoadIncrementally) this.invalidateAnalyticsInputCache();
    const cacheGeneration = this.analyticsInputCacheGeneration;

    const historySince = canLoadIncrementally
      ? Math.max(monthSince, cached!.refreshedAt - ANALYTICS_INPUT_CACHE_OVERLAP_SECONDS)
      : monthSince;
    const assetSnapshotSince = canLoadIncrementally
      ? Math.max(assetWeekSince, cached!.refreshedAt - ANALYTICS_INPUT_CACHE_OVERLAP_SECONDS)
      : assetWeekSince;
    const orderBookSnapshotSince = canLoadIncrementally
      ? Math.max(orderBookDaySince, cached!.refreshedAt - ANALYTICS_INPUT_CACHE_OVERLAP_SECONDS)
      : orderBookDaySince;
    const timestampRange = (from: number): Record<string, unknown> => ({
      greaterThanOrEqualTo: from,
      lessThanOrEqualTo: timestamp,
    });
    const throughSourceVersion =
      sourceVersion === undefined ? [] : [{ blockHeight: { lessThanOrEqualTo: sourceVersion } }];
    const blockSnapshotQuery: RepositoryQueryArgs = {
      filter: {
        and: [{ type: { equalTo: 'BLOCK' } }, { timestamp: timestampRange(historySince) }, ...throughSourceVersion],
      },
      orderBy: ['TIMESTAMP_ASC'],
    };
    const historyQuery: RepositoryQueryArgs = {
      filter: { and: [{ timestamp: timestampRange(historySince) }, ...throughSourceVersion] },
      orderBy: ['TIMESTAMP_ASC'],
    };
    const orderBookOrderQuery: RepositoryQueryArgs = {
      filter: { and: [{ timestamp: timestampRange(historySince) }, ...throughSourceVersion] },
      orderBy: ['TIMESTAMP_ASC'],
    };
    const assetSnapshotQuery: RepositoryQueryArgs = {
      filter: {
        and: [
          { type: { equalTo: 'DAY' } },
          { timestamp: timestampRange(assetSnapshotSince) },
          ...throughSourceVersion,
        ],
      },
      orderBy: ['TIMESTAMP_ASC'],
    };
    const orderBookSnapshotQuery: RepositoryQueryArgs = {
      filter: {
        and: [
          { type: { equalTo: 'DAY' } },
          { timestamp: timestampRange(orderBookSnapshotSince) },
          ...throughSourceVersion,
        ],
      },
      orderBy: ['TIMESTAMP_ASC'],
    };
    let history: IndexerDocument[];
    let blockSnapshots: IndexerDocument[];
    let orderBookOrders: IndexerDocument[];
    let assetDaySnapshots: IndexerDocument[];
    let orderBookDaySnapshots: IndexerDocument[];
    let coldRollingNetworkInputs: RollingNetworkInputCache | null;
    const maximumRetainedLoadBytes = Math.max(
      MIN_ANALYTICS_COLD_LOAD_MAX_BYTES,
      Math.min(
        Number.MAX_SAFE_INTEGER,
        this.config.analyticsInputCacheMaxBytes * ANALYTICS_COLD_LOAD_CACHE_MULTIPLIER
      )
    );
    const retainedBudget: AnalyticsRetainedLoadBudget = {
      maximumBytes: maximumRetainedLoadBytes,
      retainedBytes: 0,
    };
    metrics.setGauge('indexer_worker_analytics_cold_load_retained_bytes', {}, 0);
    if (canLoadIncrementally) {
      // These deltas share one aggregate retained-load budget and are read
      // sequentially. No combination of five concurrent result arrays can
      // exceed the limit before accounting catches up.
      history = await this.queryAllWithinAnalyticsBudget(
        collection('historyElements'),
        historyQuery,
        retainedBudget
      );
      blockSnapshots = await this.queryAllWithinAnalyticsBudget(
        collection('networkSnapshots'),
        blockSnapshotQuery,
        retainedBudget
      );
      orderBookOrders = await this.queryAllWithinAnalyticsBudget(
        collection('orderBookOrders'),
        orderBookOrderQuery,
        retainedBudget
      );
      assetDaySnapshots = await this.queryAllWithinAnalyticsBudget(
        collection('assetSnapshots'),
        assetSnapshotQuery,
        retainedBudget
      );
      orderBookDaySnapshots = await this.queryAllWithinAnalyticsBudget(
        collection('orderBookSnapshots'),
        orderBookSnapshotQuery,
        retainedBudget
      );
      coldRollingNetworkInputs = null;
    } else {
      // Cold loads are sequential and page-budgeted so no set of month-scale
      // document arrays can grow concurrently before the cache size check.
      history = await this.queryAllWithinAnalyticsBudget(
        collection('historyElements'),
        historyQuery,
        retainedBudget
      );
      blockSnapshots = [];
      coldRollingNetworkInputs = await this.loadRollingNetworkInputCacheFromPages(
        timestamp,
        sourceVersion ?? -1,
        blockSnapshotQuery,
        retainedBudget
      );
      orderBookOrders = await this.queryAllWithinAnalyticsBudget(
        collection('orderBookOrders'),
        orderBookOrderQuery,
        retainedBudget
      );
      assetDaySnapshots = await this.queryAllWithinAnalyticsBudget(
        collection('assetSnapshots'),
        assetSnapshotQuery,
        retainedBudget
      );
      orderBookDaySnapshots = await this.queryAllWithinAnalyticsBudget(
        collection('orderBookSnapshots'),
        orderBookSnapshotQuery,
        retainedBudget
      );
    }
    const documentsRead =
      history.length +
      blockSnapshots.length +
      (coldRollingNetworkInputs?.blocks.length ?? 0) +
      orderBookOrders.length +
      assetDaySnapshots.length +
      orderBookDaySnapshots.length;

    this.analyticsInputCacheMetrics.documentsRead += documentsRead;
    const loadMode = canLoadIncrementally ? 'incremental' : 'full';
    if (canLoadIncrementally) this.analyticsInputCacheMetrics.incrementalLoads += 1;
    else this.analyticsInputCacheMetrics.fullLoads += 1;
    metrics.increment('indexer_worker_analytics_input_loads_total', { mode: loadMode });
    metrics.increment('indexer_worker_analytics_input_documents_read_total', { mode: loadMode }, documentsRead);

    const cacheable = sourceVersion !== undefined && cacheGeneration === this.analyticsInputCacheGeneration;
    if (canLoadIncrementally && !cacheable) {
      // The incremental query only contains an overlap delta; its full block
      // horizon lives in the rolling cache. If invalidation won
      // the race while these reads were in flight, retry cold rather than
      // rebuilding totals from deliberately empty baseline arrays.
      return this.loadAnalyticsInputDocuments(timestamp, sourceVersion);
    }

    const canApplyRollingDelta = Boolean(
      canLoadIncrementally &&
        this.rollingNetworkInputCache?.sourceVersion === cached!.sourceVersion &&
        this.rollingNetworkInputCache.refreshedAt === cached!.refreshedAt
    );
    if (canLoadIncrementally && !canApplyRollingDelta) {
      this.invalidateAnalyticsInputCache();
      return this.loadAnalyticsInputDocuments(timestamp, sourceVersion);
    }
    // Validate and normalize the rolling delta before mutating any published
    // analytics arrays. Failed codec/decimal conversion leaves the complete
    // previous cache generation retryable.
    const freshRollingBlocks = canApplyRollingDelta
      ? blockSnapshots.map((document) => this.rollingBlockFromSnapshot(document))
      : [];
    const inputs: AnalyticsInputDocuments = canLoadIncrementally
      ? {
          history: this.mergeAnalyticsInputDocuments(
            cached!.history,
            cached!.historyById,
            history,
            monthSince
          ),
          // The rolling accumulator owns the complete block horizon.
          // Keeping the cold baseline here avoids an O(30-day) merge on every
          // refresh; fresh overlap rows are applied by ID below.
          blockSnapshots: canApplyRollingDelta
            ? cached!.blockSnapshots
            : blockSnapshots,
          orderBookOrders: this.mergeAnalyticsInputDocuments(
            cached!.orderBookOrders,
            cached!.orderBookOrdersById,
            orderBookOrders,
            monthSince
          ),
          assetDaySnapshots: this.mergeAnalyticsInputDocuments(
            cached!.assetDaySnapshots,
            cached!.assetDaySnapshotsById,
            assetDaySnapshots,
            assetWeekSince
          ),
          orderBookDaySnapshots: this.mergeAnalyticsInputDocuments(
            cached!.orderBookDaySnapshots,
            cached!.orderBookDaySnapshotsById,
            orderBookDaySnapshots,
            orderBookDaySince
          ),
        }
      : { history, blockSnapshots, orderBookOrders, assetDaySnapshots, orderBookDaySnapshots };

    const load: Omit<AnalyticsInputLoad, 'rollingNetworkInputs'> = {
      documents: inputs,
      incremental: canLoadIncrementally,
      cacheable,
      sourceVersion,
      previousSourceVersion: canLoadIncrementally ? cached!.sourceVersion : undefined,
      previousRefreshedAt: canLoadIncrementally ? cached!.refreshedAt : undefined,
      freshBlockSnapshots: blockSnapshots,
      freshRollingBlocks,
    };
    const rollingNetworkInputs =
      coldRollingNetworkInputs ?? this.updateRollingNetworkInputCache(timestamp, load);
    if (cacheable && cacheGeneration === this.analyticsInputCacheGeneration) {
      // Publish the document and rolling caches as one state transition. The
      // rolling builder works on a copy, so conversion failures leave the
      // previously published pair untouched and retryable.
      const cacheCandidate: AnalyticsInputCache = {
        ...inputs,
        blockSnapshots: [],
        sourceVersion,
        refreshedAt: timestamp,
        historyById: canLoadIncrementally
          ? cached!.historyById
          : new Map(inputs.history.map((document) => [document.id, document])),
        orderBookOrdersById: canLoadIncrementally
          ? cached!.orderBookOrdersById
          : new Map(inputs.orderBookOrders.map((document) => [document.id, document])),
        assetDaySnapshotsById: canLoadIncrementally
          ? cached!.assetDaySnapshotsById
          : new Map(inputs.assetDaySnapshots.map((document) => [document.id, document])),
        orderBookDaySnapshotsById: canLoadIncrementally
          ? cached!.orderBookDaySnapshotsById
          : new Map(inputs.orderBookDaySnapshots.map((document) => [document.id, document])),
      };
      const maximumBytes = this.config.analyticsInputCacheMaxBytes;
      const candidateBytes =
        maximumBytes === 0
          ? 1
          : estimateRetainedValueBytes(
              { cache: cacheCandidate, rollingNetworkInputs },
              maximumBytes
            );

      if (candidateBytes <= maximumBytes) {
        this.analyticsInputCacheGeneration += 1;
        this.rollingNetworkInputCache = rollingNetworkInputs;
        this.analyticsInputCache = cacheCandidate;
        this.analyticsInputCacheBytes = candidateBytes;
        metrics.setGauge('indexer_worker_analytics_input_cached_bytes', {}, candidateBytes);
        metrics.setGauge(
          'indexer_worker_analytics_input_cached_documents',
          {},
          this.getAnalyticsInputCacheMetrics().cachedDocuments
        );
      } else {
        const reason = maximumBytes === 0 ? 'disabled' : 'byte-budget';
        this.invalidateAnalyticsInputCache();
        this.analyticsInputCacheMetrics.capacityBypasses += 1;
        this.analyticsInputCacheMetrics.capacityBypassedBytes += candidateBytes;
        metrics.increment('indexer_worker_analytics_input_cache_bypasses_total', { reason });
        metrics.increment(
          'indexer_worker_analytics_input_cache_bypassed_bytes_total',
          { reason },
          candidateBytes
        );
      }
    }

    return { ...load, rollingNetworkInputs };
  }

  private rollingEntryCompare(
    left: { id: string; timestamp: number },
    right: { id: string; timestamp: number }
  ): number {
    if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
    if (left.id === right.id) return 0;
    return left.id < right.id ? -1 : 1;
  }

  private rollingLowerBound<T extends { timestamp: number }>(items: T[], timestamp: number): number {
    let low = 0;
    let high = items.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if ((items[middle]?.timestamp ?? Number.POSITIVE_INFINITY) < timestamp) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private insertRollingEntry<T extends { id: string; timestamp: number }>(items: T[], entry: T): number {
    const last = items[items.length - 1];
    if (!last || this.rollingEntryCompare(last, entry) <= 0) {
      items.push(entry);
      return items.length - 1;
    }

    let low = 0;
    let high = items.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.rollingEntryCompare(items[middle]!, entry) <= 0) low = middle + 1;
      else high = middle;
    }
    items.splice(low, 0, entry);
    return low;
  }

  private rollingBlockFromSnapshot(document: IndexerDocument): RollingNetworkBlock {
    return {
      id: document.id,
      blockHeight: Number(document.blockHeight ?? document.data.blockHeight ?? 0),
      timestamp: this.analyticsDocumentTimestamp(document),
      accounts: Number(document.data.accounts ?? 0),
      transactions: Number(document.data.transactions ?? 0),
      fees: codecToBigInt(document.data.fees ?? 0),
      volumeUSD: decimalStringToScaled(document.data.volumeUSD ?? '0'),
      swaps: Number(document.data.swaps ?? 0),
      bridgeIncomingTransactions: Number(document.data.bridgeIncomingTransactions ?? 0),
      bridgeOutgoingTransactions: Number(document.data.bridgeOutgoingTransactions ?? 0),
    };
  }

  private async loadRollingNetworkInputCacheFromPages(
    timestamp: number,
    sourceVersion: number,
    args: RepositoryQueryArgs,
    budget?: AnalyticsRetainedLoadBudget
  ): Promise<RollingNetworkInputCache> {
    const blocks: RollingNetworkBlock[] = [];
    for await (const page of this.queryPages(collection('networkSnapshots'), args)) {
      // Convert and release each repository page before requesting the next;
      // a cold month load therefore never retains full IndexerDocument rows
      // alongside the compact rolling representation.
      for (const document of page) {
        const block = this.rollingBlockFromSnapshot(document);
        blocks.push(
          budget
            ? this.retainAnalyticsValueWithinBudget(block, budget, collection('networkSnapshots'))
            : block
        );
      }
    }

    return this.createRollingNetworkInputCacheFromBlocks(timestamp, sourceVersion, blocks);
  }

  private createRollingNetworkInputCache(
    timestamp: number,
    sourceVersion: number,
    documents: AnalyticsInputDocuments
  ): RollingNetworkInputCache {
    const blocks = documents.blockSnapshots
      .map((document) => this.rollingBlockFromSnapshot(document))
      .sort((left, right) => this.rollingEntryCompare(left, right));
    return this.createRollingNetworkInputCacheFromBlocks(timestamp, sourceVersion, blocks);
  }

  private createRollingNetworkInputCacheFromBlocks(
    timestamp: number,
    sourceVersion: number,
    blocks: RollingNetworkBlock[]
  ): RollingNetworkInputCache {
    blocks.sort((left, right) => this.rollingEntryCompare(left, right));
    const cache: RollingNetworkInputCache = {
      sourceVersion,
      refreshedAt: timestamp,
      blocks,
      blocksById: new Map(blocks.map((block) => [block.id, block])),
      blockStarts: new Map(),
      totals: new Map(),
    };
    this.recalculateRollingNetworkWindows(cache, timestamp);

    this.rollingNetworkInputMetrics.fullBuilds += 1;
    this.rollingNetworkInputMetrics.blockDocumentsProcessed += blocks.length;
    metrics.increment('indexer_worker_analytics_rolling_updates_total', { mode: 'full' });
    metrics.increment('indexer_worker_analytics_rolling_documents_processed_total', { collection: 'networkSnapshots' }, blocks.length);

    return cache;
  }

  private recalculateRollingNetworkWindows(cache: RollingNetworkInputCache, timestamp: number): void {
    cache.blockStarts.clear();
    cache.totals.clear();

    for (const type of AGGREGATE_SNAPSHOT_TYPES) {
      const cutoff = timestamp - SNAPSHOT_WINDOW_SECONDS[type];
      const blockStart = this.rollingLowerBound(cache.blocks, cutoff);
      const total = this.emptyNetworkBackfillFlowTotals();
      for (let index = blockStart; index < cache.blocks.length; index += 1) {
        this.addNetworkBackfillBlock(total, cache.blocks[index]!);
      }
      cache.blockStarts.set(type, blockStart);
      cache.totals.set(type, total);
    }
  }

  private advanceRollingNetworkInputCache(cache: RollingNetworkInputCache, timestamp: number): void {
    for (const type of AGGREGATE_SNAPSHOT_TYPES) {
      const cutoff = timestamp - SNAPSHOT_WINDOW_SECONDS[type];
      const total = cache.totals.get(type)!;
      let blockStart = cache.blockStarts.get(type) ?? 0;
      while (blockStart < cache.blocks.length && cache.blocks[blockStart]!.timestamp < cutoff) {
        this.removeNetworkBackfillBlock(total, cache.blocks[blockStart]!);
        blockStart += 1;
      }
      cache.blockStarts.set(type, blockStart);
    }
  }

  private addRollingNetworkBlock(
    cache: RollingNetworkInputCache,
    block: RollingNetworkBlock,
    timestamp: number
  ): boolean {
    const existing = cache.blocksById.get(block.id);
    if (existing) {
      const unchanged =
        existing.blockHeight === block.blockHeight &&
        existing.timestamp === block.timestamp &&
        existing.transactions === block.transactions &&
        existing.fees === block.fees &&
        existing.volumeUSD === block.volumeUSD &&
        existing.swaps === block.swaps &&
        existing.bridgeIncomingTransactions === block.bridgeIncomingTransactions &&
        existing.bridgeOutgoingTransactions === block.bridgeOutgoingTransactions;
      if (unchanged) return false;

      const existingIndex = cache.blocks.indexOf(existing);
      if (existingIndex >= 0) cache.blocks.splice(existingIndex, 1);
      this.insertRollingEntry(cache.blocks, block);
      cache.blocksById.set(block.id, block);
      this.recalculateRollingNetworkWindows(cache, timestamp);
      return true;
    }

    const index = this.insertRollingEntry(cache.blocks, block);
    cache.blocksById.set(block.id, block);

    for (const type of AGGREGATE_SNAPSHOT_TYPES) {
      const cutoff = timestamp - SNAPSHOT_WINDOW_SECONDS[type];
      const active = block.timestamp >= cutoff;
      const start = cache.blockStarts.get(type) ?? 0;
      if (index < start || (index === start && !active)) cache.blockStarts.set(type, start + 1);
      if (active) this.addNetworkBackfillBlock(cache.totals.get(type)!, block);
    }
    return true;
  }

  private trimRollingNetworkInputCache(cache: RollingNetworkInputCache): void {
    const trimTimeline = <T extends { id: string }>(
      items: T[],
      byId: Map<string, T>,
      starts: Map<SnapshotTypeName, number>
    ): void => {
      const trim = Math.min(...AGGREGATE_SNAPSHOT_TYPES.map((type) => starts.get(type) ?? 0));
      if (trim <= 1_000 || trim * 2 <= items.length) return;
      for (const item of items.slice(0, trim)) byId.delete(item.id);
      items.splice(0, trim);
      for (const type of AGGREGATE_SNAPSHOT_TYPES) starts.set(type, (starts.get(type) ?? 0) - trim);
    };

    trimTimeline(cache.blocks, cache.blocksById, cache.blockStarts);
  }

  private updateRollingNetworkInputCache(
    timestamp: number,
    load: Omit<AnalyticsInputLoad, 'rollingNetworkInputs'>
  ): RollingNetworkInputCache {
    const current = this.rollingNetworkInputCache;
    const canUpdateIncrementally = Boolean(
      load.cacheable &&
        load.incremental &&
        current &&
        current.sourceVersion === load.previousSourceVersion &&
        current.refreshedAt === load.previousRefreshedAt
    );
    // Convert the whole overlap delta before mutating the published rolling
    // cache. Codec/decimal failures therefore leave the prior generation
    // untouched, while the successful path updates only the delta in place.
    const freshBlocks = canUpdateIncrementally ? load.freshRollingBlocks : [];
    const cache = canUpdateIncrementally
      ? current!
      : this.createRollingNetworkInputCache(timestamp, load.sourceVersion ?? -1, load.documents);

    if (canUpdateIncrementally) {
      this.advanceRollingNetworkInputCache(cache, timestamp);
      let blockDocumentsProcessed = 0;
      for (const block of freshBlocks) {
        if (this.addRollingNetworkBlock(cache, block, timestamp)) {
          blockDocumentsProcessed += 1;
        }
      }
      this.trimRollingNetworkInputCache(cache);
      this.rollingNetworkInputMetrics.incrementalUpdates += 1;
      this.rollingNetworkInputMetrics.blockDocumentsProcessed += blockDocumentsProcessed;
      metrics.increment('indexer_worker_analytics_rolling_updates_total', { mode: 'incremental' });
      metrics.increment(
        'indexer_worker_analytics_rolling_documents_processed_total',
        { collection: 'networkSnapshots' },
        blockDocumentsProcessed
      );
    }

    cache.sourceVersion = load.sourceVersion ?? -1;
    cache.refreshedAt = timestamp;
    metrics.setGauge('indexer_worker_analytics_rolling_cached_documents', { collection: 'networkSnapshots' }, cache.blocks.length);
    return cache;
  }

  private getRollingNetworkInputMetrics(): RollingNetworkInputMetrics & {
    cachedBlocks: number;
  } {
    return {
      ...this.rollingNetworkInputMetrics,
      cachedBlocks: this.rollingNetworkInputCache?.blocks.length ?? 0,
    };
  }

  private async buildAnalytics(
    timestamp: number,
    assets: Map<string, AssetInfo>,
    prices: Map<string, bigint>,
    pools: PoolState[],
    liquidityStats: NetworkLiquidityStats,
    sourceVersion?: number
  ): Promise<Analytics> {
    const analytics = emptyAnalytics();
    const inputLoad = await this.loadAnalyticsInputDocuments(timestamp, sourceVersion);
    const { history, orderBookOrders, assetDaySnapshots, orderBookDaySnapshots } = inputLoad.documents;
    const { rollingNetworkInputs } = inputLoad;
    const poolById = new Map(pools.map((pool) => [pool.id, pool]));

    for (const asset of assets.values()) {
      const currentPrice = scaledToString(prices.get(asset.id) ?? 0n, 8);
      analytics.assetDayOpenPrice.set(asset.id, currentPrice);
      analytics.assetWeekOpenPrice.set(asset.id, currentPrice);
    }

    for (const snapshot of assetDaySnapshots) {
      const assetId = String(snapshot.data.assetId ?? '');
      const price = snapshot.data.priceUSD as Record<string, unknown> | undefined;
      const open = String(price?.open ?? price?.close ?? '');
      if (!assetId || !open) continue;

      if (Number(snapshot.data.timestamp ?? 0) >= snapshotBucket('DAY', timestamp)) {
        analytics.assetDayOpenPrice.set(assetId, open);
      }
      if (!analytics.assetWeekOpenPrice.has(assetId) || analytics.assetWeekOpenPrice.get(assetId) === analytics.assetDayOpenPrice.get(assetId)) {
        analytics.assetWeekOpenPrice.set(assetId, open);
      }
    }

    for (const snapshot of orderBookDaySnapshots) {
      const orderBookId = String(snapshot.data.orderBookId ?? '');
      const price = snapshot.data.price as Record<string, unknown> | undefined;
      const open = String(price?.open ?? price?.close ?? '');
      if (orderBookId && open) analytics.orderBookDayOpenPrice.set(orderBookId, open);
    }

    for (const document of history) {
      const eventTimestamp = Number(document.data.timestamp ?? document.timestamp ?? 0);
      const eventData = (document.data.data ?? {}) as Record<string, unknown>;
      const module = String(document.data.module ?? '');
      const method = String(document.data.method ?? '');
      const activeTypes = activeAggregateSnapshotTypes(eventTimestamp, timestamp);
      // Synthetic bridge mint rows are derived from the original extrinsic; the original row owns the fee burn.
      const aggregateXorFeeBurn = !(module === 'bridgeProxy' && method === 'mint' && document.id.endsWith('-mint'));
      const updateAsset = (assetId: string, amount: unknown, amountUSD: unknown): void => {
        if (!assetId) return;
        const currentPrice = scaledToString(prices.get(assetId) ?? 0n, 8);
        const amountScaled = decimalStringToScaled(amount);
        const amountUSDScaled = decimalStringToScaled(amountUSD);
        for (const type of activeTypes) {
          const aggregate = getAggregate(analytics.assets, assetId, type, () => newAssetAggregate(currentPrice));
          aggregate.volumeAmount += amountScaled;
          aggregate.volumeUSD += amountUSDScaled;
          aggregate.priceUSD.close = currentPrice;
        }
      };
      const updatePool = (
        baseAssetId: string,
        targetAssetId: string,
        baseAmount: unknown,
        targetAmount: unknown,
        amountUSD: bigint
      ): void => {
        const poolId = poolIdForAssets(baseAssetId, targetAssetId);
        const pool = poolById.get(poolId);
        if (!pool) return;
        const baseAmountScaled = decimalStringToScaled(baseAmount);
        const targetAmountScaled = decimalStringToScaled(targetAmount);

        for (const type of activeTypes) {
          const aggregate = getAggregate(analytics.pools, poolId, type, () => newPoolAggregate(pool.priceUSD));
          aggregate.baseAssetVolume += baseAmountScaled;
          aggregate.targetAssetVolume += targetAmountScaled;
          aggregate.volumeUSD += amountUSD;
          aggregate.priceUSD.close = pool.priceUSD;
        }

        if (eventTimestamp >= timestamp - 86_400) {
          analytics.poolDayVolumeUSD.set(poolId, (analytics.poolDayVolumeUSD.get(poolId) ?? 0n) + amountUSD);
        }
      };
      const volumeUSD = this.extractVolumeUSD(eventData);
      const eventAssets = collectAssets(eventData);
      const xorFeeBurn = aggregateXorFeeBurn
        ? reserveToNaturalScaled(
            this.extractXorFeeBurn(document.data.networkFee),
            assets.get(XOR)?.decimals ?? DECIMALS
          )
        : 0n;

      if (xorFeeBurn > 0n) {
        const currentPrice = scaledToString(prices.get(XOR) ?? 0n, 8);
        for (const type of activeTypes) {
          const aggregate = getAggregate(analytics.assets, XOR, type, () => newAssetAggregate(currentPrice));
          aggregate.burn += xorFeeBurn;
        }
      }

      if (eventTimestamp >= timestamp - 86_400) {
        for (const assetId of eventAssets) {
          analytics.assetDayVolumeUSD.set(assetId, (analytics.assetDayVolumeUSD.get(assetId) ?? 0n) + volumeUSD);
        }
      }
      if (eventTimestamp >= timestamp - 7 * 86_400) {
        for (const assetId of eventAssets) {
          analytics.assetWeekVolumeUSD.set(assetId, (analytics.assetWeekVolumeUSD.get(assetId) ?? 0n) + volumeUSD);
        }
      }

      if (module === 'assets' && method === 'mint') {
        const assetId = String(eventData.assetId ?? '');
        const amount = decimalStringToScaled(eventData.amount ?? '0');
        for (const type of activeTypes) {
          const aggregate = getAggregate(analytics.assets, assetId, type, () =>
            newAssetAggregate(scaledToString(prices.get(assetId) ?? 0n, 8))
          );
          aggregate.mint += amount;
        }
      }

      if (module === 'assets' && method === 'burn') {
        const assetId = String(eventData.assetId ?? '');
        const amount = decimalStringToScaled(eventData.amount ?? '0');
        for (const type of activeTypes) {
          const aggregate = getAggregate(analytics.assets, assetId, type, () =>
            newAssetAggregate(scaledToString(prices.get(assetId) ?? 0n, 8))
          );
          aggregate.burn += amount;
        }
      }

      const baseAssetId = String(eventData.baseAssetId ?? '');
      const targetAssetId = String(eventData.targetAssetId ?? '');
      const baseAssetAmount = eventData.baseAssetAmount ?? eventData.amount ?? '0';
      const targetAssetAmount = eventData.targetAssetAmount ?? '0';
      const baseAssetAmountUSD = eventData.baseAssetAmountUSD ?? eventData.amountUSD ?? '0';
      const targetAssetAmountUSD = eventData.targetAssetAmountUSD ?? eventData.amountUSD ?? '0';

      if (baseAssetId) updateAsset(baseAssetId, baseAssetAmount, baseAssetAmountUSD);
      if (targetAssetId) updateAsset(targetAssetId, targetAssetAmount, targetAssetAmountUSD);
      if (baseAssetId && targetAssetId) {
        updatePool(baseAssetId, targetAssetId, baseAssetAmount, targetAssetAmount, volumeUSD);
      }
    }

    for (const type of AGGREGATE_SNAPSHOT_TYPES) {
      const totals = rollingNetworkInputs.totals.get(type) ?? this.emptyNetworkBackfillFlowTotals();
      const current = analytics.network.get(type) ?? newNetworkAggregate(0, liquidityStats);
      current.accounts += totals.accounts;
      current.transactions += totals.transactions;
      current.fees += totals.fees;
      current.volumeUSD += totals.volumeUSD;
      current.swaps += totals.swaps;
      current.bridgeIncomingTransactions += totals.bridgeIncomingTransactions;
      current.bridgeOutgoingTransactions += totals.bridgeOutgoingTransactions;
      Object.assign(current, liquidityStats);
      analytics.network.set(type, current);
    }

    for (const document of orderBookOrders) {
      const eventTimestamp = Number(document.data.timestamp ?? document.timestamp ?? 0);
      const orderBookId = String(document.data.orderBookId ?? '');
      const [dexId, baseAssetId, quoteAssetId] = orderBookId.split('-');
      if (!dexId || !baseAssetId || !quoteAssetId) continue;

      const amount = decimalStringToScaled(document.data.amount ?? '0');
      const price = decimalStringToScaled(document.data.price ?? '0');
      const quoteAmount = scaledMul(amount, price);
      const isBuy = Boolean(document.data.isBuy);
      const storedAmountUSD = decimalStringToScaled(document.data.amountUSD ?? '0');
      const amountUSD =
        storedAmountUSD > 0n
          ? storedAmountUSD
          : isBuy
            ? scaledMul(quoteAmount, prices.get(quoteAssetId) ?? 0n)
            : scaledMul(amount, prices.get(baseAssetId) ?? 0n);
      const activeTypes = activeAggregateSnapshotTypes(eventTimestamp, timestamp);
      const priceText = String(document.data.price ?? '0');
      const status = String(document.data.status ?? '');

      if (status === 'Active') {
        const reserves =
          analytics.orderBookActiveReserves.get(orderBookId) ?? { baseAssetReserves: 0n, quoteAssetReserves: 0n, liquidityUSD: 0n };
        if (isBuy) {
          const quoteReserve = naturalScaledToCodec(quoteAmount, assets.get(quoteAssetId)?.decimals ?? DECIMALS);
          reserves.quoteAssetReserves += quoteReserve;
          analytics.assetOrderBookLiquidity.set(
            quoteAssetId,
            (analytics.assetOrderBookLiquidity.get(quoteAssetId) ?? 0n) + quoteReserve
          );
        } else {
          const baseReserve = naturalScaledToCodec(amount, assets.get(baseAssetId)?.decimals ?? DECIMALS);
          reserves.baseAssetReserves += baseReserve;
          analytics.assetOrderBookLiquidity.set(
            baseAssetId,
            (analytics.assetOrderBookLiquidity.get(baseAssetId) ?? 0n) + baseReserve
          );
        }
        reserves.liquidityUSD += amountUSD;
        analytics.orderBookActiveReserves.set(orderBookId, reserves);
      }

      if (eventTimestamp >= timestamp - 86_400) {
        analytics.orderBookDayVolumeUSD.set(orderBookId, (analytics.orderBookDayVolumeUSD.get(orderBookId) ?? 0n) + amountUSD);
      }

      for (const type of activeTypes) {
        const aggregate = getAggregate(analytics.orderBooks, orderBookId, type, () => newOrderBookAggregate(priceText));
        aggregate.baseAssetVolume += amount;
        aggregate.quoteAssetVolume += quoteAmount;
        aggregate.volumeUSD += amountUSD;
        aggregate.price.close = priceText;
        aggregate.price.high = maxDecimalString(aggregate.price.high, priceText);
        aggregate.price.low = minDecimalString(aggregate.price.low, priceText);

        if (status === 'Filled') {
          aggregate.lastDeals.unshift({
            orderId: Number(document.data.orderId ?? 0),
            timestamp: eventTimestamp,
            isBuy,
            amount: String(document.data.amount ?? '0'),
            price: priceText,
          });
          aggregate.lastDeals = aggregate.lastDeals.slice(0, 25);
        }
      }
    }

    for (const type of AGGREGATE_SNAPSHOT_TYPES) {
      if (!analytics.network.has(type)) {
        analytics.network.set(type, newNetworkAggregate(0, liquidityStats));
      }
    }

    return analytics;
  }

  /**
   * Refreshes stock metrics after order-book storage has been merged into the
   * in-memory analytics snapshot. Flow metrics such as volume and fees stay
   * aggregated from historical block snapshots.
   */
  private applyNetworkLiquidityStats(analytics: Analytics, liquidityStats: NetworkLiquidityStats): void {
    for (const aggregate of analytics.network.values()) {
      Object.assign(aggregate, liquidityStats);
    }
  }

  private async createAssetDocuments(
    assets: Map<string, AssetInfo>,
    prices: Map<string, bigint>,
    liquidity: Map<string, bigint>,
    analytics: Analytics,
    blockHeight: number,
    timestamp: number,
    includeSnapshots: boolean
  ): Promise<IndexerDocument[]> {
    const documents: IndexerDocument[] = [];
    const previousSnapshots = includeSnapshots
      ? await this.repository.getMany(
          collection('assetSnapshots'),
          [...assets.values()].flatMap((asset) =>
            PERSISTED_CHART_SNAPSHOT_TYPES.map((type) => snapshotId('asset', asset.id, type, timestamp, blockHeight))
          )
        )
      : new Map<string, IndexerDocument>();

    for (const asset of assets.values()) {
      const priceUSD = scaledToString(prices.get(asset.id) ?? 0n, 8);
      const assetLiquidity = liquidity.get(asset.id) ?? 0n;
      const assetLiquidityUSD = scaledMul(reserveToNaturalScaled(assetLiquidity, asset.decimals), prices.get(asset.id) ?? 0n);
      const dayVolumeUSD = analytics.assetDayVolumeUSD.get(asset.id) ?? 0n;
      const weekVolumeUSD = analytics.assetWeekVolumeUSD.get(asset.id) ?? 0n;
      const priceChangeDay = percentChange(analytics.assetDayOpenPrice.get(asset.id) ?? priceUSD, priceUSD);
      const priceChangeWeek = percentChange(analytics.assetWeekOpenPrice.get(asset.id) ?? priceUSD, priceUSD);
      const velocity = assetLiquidityUSD === 0n ? 0 : Number(scaledDiv(dayVolumeUSD, assetLiquidityUSD)) / 10 ** 18;

      documents.push({
        collection: collection('assets'),
        id: asset.id,
        blockHeight,
        timestamp,
        data: {
          id: asset.id,
          priceUSD,
          supply: asset.supply.toString(),
          liquidity: assetLiquidity.toString(),
          liquidityBooks: (analytics.assetOrderBookLiquidity.get(asset.id) ?? 0n).toString(),
          priceChangeDay,
          priceChangeWeek,
          volumeDayUSD: scaledToString(dayVolumeUSD, 8),
          volumeWeekUSD: scaledToString(weekVolumeUSD, 8),
          velocity,
        },
      });

      if (includeSnapshots) {
        for (const type of PERSISTED_CHART_SNAPSHOT_TYPES) {
          const id = snapshotId('asset', asset.id, type, timestamp, blockHeight);
          const aggregate = analytics.assets.get(asset.id)?.get(type) ?? newAssetAggregate(priceUSD);
          const previous = previousSnapshots.get(id);
          const priceSnapshot = mergePriceOhlc(previous?.data.priceUSD, priceUSD);
          documents.push({
            collection: collection('assetSnapshots'),
            id,
            blockHeight,
            timestamp,
            data: {
              id,
              assetId: asset.id,
              timestamp,
              type,
              supply: asset.supply.toString(),
              mint: scaledToString(aggregate.mint),
              burn: scaledToString(aggregate.burn),
              priceUSD: {
                open: priceSnapshot.open,
                high: maxDecimalString(priceSnapshot.high, aggregate.priceUSD.high),
                low: minDecimalString(priceSnapshot.low, aggregate.priceUSD.low),
                close: priceUSD,
              },
              volume: {
                amount: scaledToString(aggregate.volumeAmount),
                amountUSD: scaledToString(aggregate.volumeUSD, 8),
              },
            },
          });
        }
      }
    }

    return documents;
  }

  private async createPoolDocuments(
    pools: PoolState[],
    analytics: Analytics,
    apyByPool: Map<string, string>,
    blockHeight: number,
    timestamp: number,
    includeSnapshots: boolean
  ): Promise<IndexerDocument[]> {
    const documents: IndexerDocument[] = [];
    const previousSnapshots = includeSnapshots
      ? await this.repository.getMany(
          collection('poolSnapshots'),
          pools.flatMap((pool) =>
            PERSISTED_CHART_SNAPSHOT_TYPES.map((type) => snapshotId('pool', pool.id, type, timestamp, blockHeight))
          )
        )
      : new Map<string, IndexerDocument>();

    for (const pool of pools) {
      const poolTokenPrice =
        pool.poolTokenSupply === 0n ? '0' : scaledToString(scaledDiv(decimalStringToScaled(pool.liquidityUSD), pool.poolTokenSupply), 8);
      const strategicBonusApy = apyByPool.get(pool.id) ?? '0';

      documents.push({
        collection: collection('poolXYKs'),
        id: pool.id,
        blockHeight,
        timestamp,
        data: {
          id: pool.id,
          baseAssetId: pool.baseAssetId,
          targetAssetId: pool.targetAssetId,
          baseAssetReserves: pool.baseAssetReserves.toString(),
          targetAssetReserves: pool.targetAssetReserves.toString(),
          chameleonAssetReserves: '0',
          multiplier: 0,
          priceUSD: pool.priceUSD,
          strategicBonusApy,
          poolTokenSupply: pool.poolTokenSupply.toString(),
          poolTokenPriceUSD: poolTokenPrice,
          liquidityUSD: pool.liquidityUSD,
        },
      });

      if (includeSnapshots) {
        for (const type of PERSISTED_CHART_SNAPSHOT_TYPES) {
          const id = snapshotId('pool', pool.id, type, timestamp, blockHeight);
          const aggregate = analytics.pools.get(pool.id)?.get(type) ?? newPoolAggregate(pool.priceUSD);
          const previous = previousSnapshots.get(id);
          const priceSnapshot = mergePriceOhlc(previous?.data.priceUSD, pool.priceUSD);
          documents.push({
            collection: collection('poolSnapshots'),
            id,
            blockHeight,
            timestamp,
            data: {
              id,
              poolId: pool.id,
              timestamp,
              type,
              priceUSD: {
                open: priceSnapshot.open,
                high: maxDecimalString(priceSnapshot.high, aggregate.priceUSD.high),
                low: minDecimalString(priceSnapshot.low, aggregate.priceUSD.low),
                close: pool.priceUSD,
              },
              baseAssetReserves: pool.baseAssetReserves.toString(),
              targetAssetReserves: pool.targetAssetReserves.toString(),
              chameleonAssetReserves: '0',
              baseAssetVolume: scaledToString(aggregate.baseAssetVolume),
              targetAssetVolume: scaledToString(aggregate.targetAssetVolume),
              chameleonAssetVolume: scaledToString(aggregate.chameleonAssetVolume),
              poolTokenSupply: pool.poolTokenSupply.toString(),
              poolTokenPriceUSD: poolTokenPrice,
              liquidityUSD: pool.liquidityUSD,
              volumeUSD: scaledToString(aggregate.volumeUSD, 8),
            },
          });
        }
      }
    }

    return documents;
  }

  /**
   * Mirrors farming pallet time amplification: weight * (1 + farming_time / current_block)^3.
   */
  private farmingWeight(weight: bigint, farmerBlock: number, currentBlock: number): bigint {
    if (weight <= 0n) return 0n;
    if (!currentBlock || farmerBlock >= currentBlock) return weight;

    const farmingTime = BigInt(Math.max(currentBlock - farmerBlock, 0));
    const coefficient = scaledPow(SCALE + scaledDiv(farmingTime * SCALE, BigInt(currentBlock) * SCALE), 3);

    return scaledMul(weight, coefficient);
  }

  /**
   * Computes strategic bonus APY from on-chain farming weights and the runtime PSWAP/day emission.
   */
  private derivePoolApy(pools: PoolState[], farmingPoolFarmers: any[], currentBlock: number, prices: Map<string, bigint>): Map<string, string> {
    const result = new Map<string, string>();
    const poolByAccount = new Map(pools.map((pool) => [pool.poolAccount, pool]));
    const weightByPool = new Map<string, bigint>();
    let totalWeight = 0n;

    for (const [key, value] of farmingPoolFarmers) {
      const poolAccount = String(key.args?.[0] ?? '');
      const pool = poolByAccount.get(poolAccount);
      if (!pool) continue;

      const farmers = normalizeValue(value);
      if (!Array.isArray(farmers)) continue;

      for (const farmer of farmers) {
        if (!farmer || typeof farmer !== 'object') continue;

        const data = farmer as Record<string, unknown>;
        const weight = codecToBigInt(data.weight ?? 0);
        const farmerBlock = Number(data.block ?? 0);
        const amplifiedWeight = this.farmingWeight(weight, farmerBlock, currentBlock);

        weightByPool.set(pool.id, (weightByPool.get(pool.id) ?? 0n) + amplifiedWeight);
        totalWeight += amplifiedWeight;
      }
    }

    const pswapPriceUSD = prices.get(PSWAP) ?? 0n;
    const annualRewardUSD = scaledMul(reserveToNaturalScaled(FARMING_PSWAP_PER_DAY * DAYS_PER_YEAR), pswapPriceUSD);

    for (const pool of pools) {
      const liquidityUSD = decimalStringToScaled(pool.liquidityUSD);
      const weight = weightByPool.get(pool.id) ?? 0n;

      if (liquidityUSD === 0n || weight === 0n || totalWeight === 0n || annualRewardUSD === 0n) {
        result.set(pool.id, '0');
        continue;
      }

      const poolAnnualRewardUSD = (annualRewardUSD * weight) / totalWeight;
      result.set(pool.id, scaledToString(scaledDiv(poolAnnualRewardUSD, liquidityUSD), 8));
    }

    return result;
  }

  private storageKeyNumber(key: StorageEntryKey): number | null {
    const raw = normalizeValue(key.args?.[0]);
    const parsed = Number(raw);

    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  private normalizedRecord(value: unknown): Record<string, unknown> {
    const normalized = normalizeValue(value);
    if (isRecord(normalized)) return normalized;

    const human = toHuman(value);
    if (isRecord(human)) {
      return Object.fromEntries(Object.entries(human).map(([key, item]) => [normalizeKey(key), item]));
    }

    return {};
  }

  private decodeMetadataText(value: unknown): string {
    const normalized = normalizeValue(value);
    const clean = (text: string) => (text.includes('\uFFFD') ? '' : text.trim());

    if (typeof normalized === 'string') {
      if (/^0x[0-9a-fA-F]*$/.test(normalized) && normalized.length > 2) {
        return clean(Buffer.from(normalized.slice(2), 'hex').toString('utf8'));
      }

      return clean(normalized);
    }

    if (Array.isArray(normalized)) {
      const bytes = normalized.map((item) => Number(item));
      if (bytes.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return '';
      if (bytes.length) return clean(Buffer.from(bytes).toString('utf8'));
    }

    if (isRecord(normalized)) {
      for (const key of ['value', 'inner', 'raw']) {
        const decoded = this.decodeMetadataText(normalized[key]);
        if (decoded) return decoded;
      }
    }

    return '';
  }

  private decodeBytesHex(value: unknown): string | null {
    const normalized = normalizeValue(value);
    if (normalized === null || normalized === undefined || normalized === '') return null;

    if (typeof normalized === 'string') {
      if (normalized.startsWith('0x')) {
        return /^0x(?:[0-9a-fA-F]{2})+$/.test(normalized) ? normalized.toLowerCase() : null;
      }
      return `0x${Buffer.from(normalized, 'utf8').toString('hex')}`;
    }

    if (Array.isArray(normalized)) {
      const bytes = normalized.map((item) => Number(item));
      if (bytes.some((item) => !Number.isInteger(item) || item < 0 || item > 255)) return null;
      return bytes.length ? `0x${Buffer.from(bytes).toString('hex')}` : null;
    }

    if (isRecord(normalized)) {
      for (const key of ['value', 'inner', 'raw']) {
        const decoded = this.decodeBytesHex(normalized[key]);
        if (decoded) return decoded;
      }
    }

    return null;
  }

  private variantName(value: unknown): string {
    const normalized = normalizeValue(value);
    if (typeof normalized === 'string') return normalized;

    if (isRecord(normalized)) {
      const explicit = normalized.type ?? normalized.status ?? normalized.outcome;
      if (typeof explicit === 'string') return explicit;

      const key = Object.keys(normalized).find((item) => normalized[item] === null || normalized[item] === true || normalized[item] === undefined);
      if (key) return key.charAt(0).toUpperCase() + key.slice(1);
    }

    return '';
  }

  private safeCodecToBigInt(value: unknown): bigint {
    try {
      return codecToBigInt(value ?? 0);
    } catch {
      return 0n;
    }
  }

  private normalizeSoraGovernancePallet(value: string): string | null {
    const normalized = value.replace(/[\s_-]/g, '').toLowerCase();
    if (normalized === 'democracy') return 'democracy';
    if (normalized === 'council') return 'council';
    if (normalized === 'technicalcommittee') return 'technicalCommittee';
    if (normalized === 'ceres' || normalized === 'ceresgovernance' || normalized === 'ceresgovernanceplatform') {
      return 'ceresGovernancePlatform';
    }
    if (normalized === 'hermes' || normalized === 'hermesgovernance' || normalized === 'hermesgovernanceplatform') {
      return 'hermesGovernancePlatform';
    }
    return null;
  }

  private parseSoraGovernanceReference(source: string): Record<string, unknown> {
    const match = source
      .trim()
      .match(/^(?:sora:governance:|sora:\/\/governance\/)([A-Za-z-]+)[:/]([A-Za-z-]+)[:/]([A-Za-z0-9]+|0x[0-9a-fA-F]+)$/);
    if (!match) return {};

    const pallet = this.normalizeSoraGovernancePallet(match[1] ?? '');
    if (!pallet) return {};

    const kindToken = (match[2] ?? '').replace(/[\s_-]/g, '').toLowerCase();
    const reference = match[3] ?? '';
    const numericReference = Number(reference);
    const numberValue = Number.isInteger(numericReference) && numericReference > 0 ? numericReference : undefined;
    const base: Record<string, unknown> = {
      governancePallet: pallet,
      governanceBody:
        pallet === 'technicalCommittee'
          ? 'Technical Committee'
          : pallet === 'ceresGovernancePlatform'
            ? 'Ceres Governance'
            : pallet === 'hermesGovernancePlatform'
              ? 'Hermes Governance'
              : pallet.charAt(0).toUpperCase() + pallet.slice(1),
    };

    if (pallet === 'democracy' && kindToken === 'referendum') {
      return { ...base, governanceKind: 'Referendum', governanceReferendumIndex: numberValue };
    }

    if (pallet === 'democracy' && (kindToken === 'proposal' || kindToken === 'publicproposal')) {
      return { ...base, governanceKind: 'PublicProposal', governanceProposalIndex: numberValue };
    }

    if (pallet === 'council' && kindToken === 'motion') {
      return {
        ...base,
        governanceKind: 'CouncilMotion',
        governanceMotionHash: reference.startsWith('0x') ? reference : undefined,
        governanceProposalIndex: reference.startsWith('0x') ? undefined : numberValue,
      };
    }

    if (pallet === 'technicalCommittee' && kindToken === 'motion') {
      return {
        ...base,
        governanceKind: 'TechnicalCommitteeMotion',
        governanceMotionHash: reference.startsWith('0x') ? reference : undefined,
        governanceProposalIndex: reference.startsWith('0x') ? undefined : numberValue,
      };
    }

    if (pallet === 'ceresGovernancePlatform' && kindToken === 'poll') {
      return { ...base, governanceKind: 'CeresPoll', governancePollId: numberValue };
    }

    if (pallet === 'hermesGovernancePlatform' && kindToken === 'poll') {
      return { ...base, governanceKind: 'HermesPoll', governancePollId: numberValue };
    }

    return {};
  }

  private createPolkamarktMarketDescription(oracle: string | null, resolutionSource: string | null): string | null {
    const sentences = [
      oracle ? `Resolved by ${oracle.replace(/[.\s]+$/, '')}` : null,
      resolutionSource ? `Resolution source: ${resolutionSource.replace(/[.\s]+$/, '')}` : null,
    ].filter((sentence): sentence is string => Boolean(sentence));

    return sentences.length ? `${sentences.join('. ')}.` : null;
  }

  private createPolkamarktMarketDocuments(
    conditions: Array<[StorageEntryKey, unknown]>,
    conditionDetails: Array<[StorageEntryKey, unknown]>,
    markets: Array<[StorageEntryKey, unknown]>,
    dpmCollaterals: Array<[StorageEntryKey, unknown]>,
    volumes: Array<[StorageEntryKey, unknown]>,
    totals: Array<[StorageEntryKey, unknown]>,
    resolutions: Array<[StorageEntryKey, unknown]>,
    resolutionEvidence: Array<[StorageEntryKey, unknown]>,
    cancellationEvidence: Array<[StorageEntryKey, unknown]>,
    creatorFees: Array<[StorageEntryKey, unknown]>,
    assets: Map<string, AssetInfo>,
    blockHeight: number,
    timestamp: number,
    includeSnapshots = false
  ): IndexerDocument[] {
    const conditionsById = new Map<number, Record<string, unknown>>();
    const conditionDetailsById = new Map<number, Record<string, unknown>>();
    const dpmCollateralByMarket = new Map<number, bigint>();
    const volumesByMarket = new Map<number, bigint>();
    const totalsByMarket = new Map<number, Record<string, unknown>>();
    const resolutionsByMarket = new Map<number, string>();
    const resolutionEvidenceByMarket = new Map<number, Record<string, unknown>>();
    const cancellationEvidenceByMarket = new Map<number, Record<string, unknown>>();
    const creatorFeesByMarket = new Map<number, bigint>();

    for (const [key, value] of conditions) {
      const id = this.storageKeyNumber(key);
      if (id === null) continue;
      conditionsById.set(id, this.normalizedRecord(value));
    }

    for (const [key, value] of conditionDetails) {
      const id = this.storageKeyNumber(key);
      if (id === null) continue;
      conditionDetailsById.set(id, this.normalizedRecord(value));
    }

    for (const [key, value] of dpmCollaterals) {
      const id = this.storageKeyNumber(key);
      if (id === null) continue;
      dpmCollateralByMarket.set(id, this.safeCodecToBigInt(value));
    }

    for (const [key, value] of volumes) {
      const id = this.storageKeyNumber(key);
      if (id === null) continue;
      volumesByMarket.set(id, this.safeCodecToBigInt(value));
    }

    for (const [key, value] of totals) {
      const id = this.storageKeyNumber(key);
      if (id === null) continue;
      totalsByMarket.set(id, this.normalizedRecord(value));
    }

    for (const [key, value] of resolutions) {
      const id = this.storageKeyNumber(key);
      if (id === null) continue;
      resolutionsByMarket.set(id, this.variantName(value));
    }

    for (const [key, value] of resolutionEvidence) {
      const id = this.storageKeyNumber(key);
      if (id === null) continue;
      resolutionEvidenceByMarket.set(id, this.normalizedRecord(value));
    }

    for (const [key, value] of cancellationEvidence) {
      const id = this.storageKeyNumber(key);
      if (id === null) continue;
      cancellationEvidenceByMarket.set(id, this.normalizedRecord(value));
    }

    for (const [key, value] of creatorFees) {
      const id = this.storageKeyNumber(key);
      if (id === null) continue;
      creatorFeesByMarket.set(id, this.safeCodecToBigInt(value));
    }

    return markets.flatMap(([key, value]) => {
      const marketId = this.storageKeyNumber(key);
      if (marketId === null) return [];

      const market = this.normalizedRecord(value);
      const conditionId = Number(market.conditionId ?? market.condition ?? -1);
      const condition = conditionsById.get(conditionId);
      const details = conditionDetailsById.get(conditionId) ?? {};
      const title = this.decodeMetadataText(condition?.question);
      if (!title) return [];

      const totalsForMarket = totalsByMarket.get(marketId) ?? {};
      const collateralAsset = assetIdToString(market.collateralAsset);
      const decimals = assets.get(collateralAsset)?.decimals ?? DECIMALS;
      const collateral = dpmCollateralByMarket.get(marketId) ?? 0n;
      const yesShares = this.safeCodecToBigInt(totalsForMarket.totalYesShares);
      const noShares = this.safeCodecToBigInt(totalsForMarket.totalNoShares);
      const volume = volumesByMarket.get(marketId) ?? 0n;
      const creatorFeesForMarket = creatorFeesByMarket.get(marketId) ?? 0n;
      const mechanism = this.variantName(market.mechanism) || 'DynamicPariMutuel';
      const isDynamicPariMutuel = normalizedMechanism(mechanism) === 'dynamicparimutuel';
      const dpmCollateral = isDynamicPariMutuel ? collateral : 0n;
      const dpmState =
        isDynamicPariMutuel
          ? dpmIndexedState(yesShares, noShares)
          : emptyIndexedMarketState(yesShares, noShares);
      const liquidityUSD = decimalToString(dpmCollateral, decimals, 8);
      const volumeUSD = decimalToString(volume, decimals, 8);
      const oracle = this.decodeMetadataText(condition?.oracle);
      const resolutionSource = this.decodeMetadataText(condition?.resolutionSource);
      const category = this.decodeMetadataText(details.category) || 'Other';
      const tags = this.decodeMetadataText(details.tags);
      const metadataUri = this.decodeMetadataText(details.metadataUri);
      const rulesUri = this.decodeMetadataText(details.rulesUri);
      const resolutionEvidenceForMarket = resolutionEvidenceByMarket.get(marketId) ?? {};
      const cancellationEvidenceForMarket = cancellationEvidenceByMarket.get(marketId) ?? {};
      const governance = resolutionSource ? this.parseSoraGovernanceReference(resolutionSource) : {};
      const description = this.createPolkamarktMarketDescription(oracle, resolutionSource);
      const marketDocument: IndexerDocument = {
        collection: collection('markets'),
        id: String(marketId),
        blockHeight,
        timestamp,
        data: {
          id: String(marketId),
          marketId,
          conditionId,
          title,
          category,
          tags: tags || null,
          description,
          metadataUri: metadataUri || null,
          metadataHash: this.decodeBytesHex(details.metadataHash),
          rulesUri: rulesUri || null,
          oracle,
          resolutionSource,
          closeBlock: Number(market.closeBlock ?? 0),
          status: this.variantName(market.status),
          mechanism,
          creator: String(market.creator ?? ''),
          collateralAsset,
          creatorFees: decimalToString(creatorFeesForMarket, decimals, 8),
          liquidityUSD,
          volumeUSD,
          probability: dpmState.probability,
          priceYes: dpmState.priceYes,
          priceNo: dpmState.priceNo,
          virtualDepth: decimalToString(dpmState.virtualDepth, decimals, 8),
          dpmCollateral: decimalToString(dpmCollateral, decimals, 8),
          realYesShares: decimalToString(dpmState.realYesShares, decimals, 8),
          realNoShares: decimalToString(dpmState.realNoShares, decimals, 8),
          marginalYesPriceBps: dpmState.marginalYesPriceBps,
          marginalNoPriceBps: dpmState.marginalNoPriceBps,
          impliedYesProbabilityBps: dpmState.impliedYesProbabilityBps,
          impliedNoProbabilityBps: dpmState.impliedNoProbabilityBps,
          collateral: decimalToString(dpmCollateral, decimals, 8),
          yesShares: decimalToString(dpmState.realYesShares, decimals, 8),
          noShares: decimalToString(dpmState.realNoShares, decimals, 8),
          resolutionOutcome: resolutionsByMarket.get(marketId) ?? null,
          resolutionEvidenceUri: this.decodeMetadataText(resolutionEvidenceForMarket.uri) || null,
          resolutionEvidenceHash: this.decodeBytesHex(resolutionEvidenceForMarket.hash),
          resolutionEvidenceBlock: Number(resolutionEvidenceForMarket.atBlock ?? 0) || null,
          cancellationEvidenceUri: this.decodeMetadataText(cancellationEvidenceForMarket.uri) || null,
          cancellationEvidenceHash: this.decodeBytesHex(cancellationEvidenceForMarket.hash),
          cancellationEvidenceBlock: Number(cancellationEvidenceForMarket.atBlock ?? 0) || null,
          ...governance,
          updatedAtBlock: blockHeight,
          timestamp,
        },
      };

      const marketSnapshotDocuments: IndexerDocument[] =
        includeSnapshots && dpmState.probability !== null
          ? PERSISTED_CHART_SNAPSHOT_TYPES.map((type) => {
              const id = snapshotId('market', String(marketId), type, timestamp, blockHeight);

              return {
                collection: collection('marketSnapshots'),
                id,
                blockHeight,
                timestamp,
                data: {
                  id,
                  marketId,
                  timestamp,
                  blockHeight,
                  type,
                  probability: dpmState.probability,
                  priceYes: dpmState.priceYes,
                  priceNo: dpmState.priceNo,
                  virtualDepth: decimalToString(dpmState.virtualDepth, decimals, 8),
                  dpmCollateral: decimalToString(dpmCollateral, decimals, 8),
                  realYesShares: decimalToString(dpmState.realYesShares, decimals, 8),
                  realNoShares: decimalToString(dpmState.realNoShares, decimals, 8),
                  marginalYesPriceBps: dpmState.marginalYesPriceBps,
                  marginalNoPriceBps: dpmState.marginalNoPriceBps,
                  impliedYesProbabilityBps: dpmState.impliedYesProbabilityBps,
                  impliedNoProbabilityBps: dpmState.impliedNoProbabilityBps,
                  collateral: decimalToString(dpmCollateral, decimals, 8),
                  yesShares: decimalToString(dpmState.realYesShares, decimals, 8),
                  noShares: decimalToString(dpmState.realNoShares, decimals, 8),
                  liquidityUSD,
                  volumeUSD,
                  status: this.variantName(market.status),
                },
              };
            })
          : [];

      return [marketDocument, ...marketSnapshotDocuments];
    });
  }

  private createPolkamarktPositionDocuments(
    positions: Array<[StorageEntryKey, unknown]>,
    markets: Array<[StorageEntryKey, unknown]>,
    dpmCollaterals: Array<[StorageEntryKey, unknown]>,
    totals: Array<[StorageEntryKey, unknown]>,
    resolutions: Array<[StorageEntryKey, unknown]>,
    dpmCostBasis: Array<[StorageEntryKey, unknown]>,
    dpmCostBasisTotals: Array<[StorageEntryKey, unknown]>,
    assets: Map<string, AssetInfo>,
    blockHeight: number,
    timestamp: number
  ): IndexerDocument[] {
    const marketsById = new Map<number, Record<string, unknown>>();
    const dpmCollateralByMarket = new Map<number, bigint>();
    const totalsByMarket = new Map<number, Record<string, unknown>>();
    const resolutionsByMarket = new Map<number, string>();
    const costBasisByKey = new Map<string, Record<string, unknown>>();
    const costBasisTotalsByMarket = new Map<number, Record<string, unknown>>();
    const positionsByKey = new Map<string, Record<string, unknown>>();
    const accountMarketKeys = new Map<string, { marketId: number; account: string }>();

    for (const [key, value] of markets) {
      const id = this.storageKeyNumber(key);
      if (id === null) continue;
      marketsById.set(id, this.normalizedRecord(value));
    }

    for (const [key, value] of dpmCollaterals) {
      const id = this.storageKeyNumber(key);
      if (id === null) continue;
      dpmCollateralByMarket.set(id, this.safeCodecToBigInt(value));
    }

    for (const [key, value] of totals) {
      const id = this.storageKeyNumber(key);
      if (id === null) continue;
      totalsByMarket.set(id, this.normalizedRecord(value));
    }

    for (const [key, value] of resolutions) {
      const id = this.storageKeyNumber(key);
      if (id === null) continue;
      resolutionsByMarket.set(id, this.variantName(value));
    }

    for (const [key, value] of dpmCostBasis) {
      const marketIdRaw = normalizeValue(key.args?.[0]);
      const marketId = Number(marketIdRaw);
      const account = String(normalizeValue(key.args?.[1]) ?? '');
      if (!Number.isSafeInteger(marketId) || !account) continue;
      costBasisByKey.set(`${marketId}-${account}`, this.normalizedRecord(value));
    }

    for (const [key, value] of dpmCostBasisTotals) {
      const id = this.storageKeyNumber(key);
      if (id === null) continue;
      costBasisTotalsByMarket.set(id, this.normalizedRecord(value));
    }

    for (const [key, value] of positions) {
      const marketIdRaw = normalizeValue(key.args?.[0]);
      const marketId = Number(marketIdRaw);
      const account = String(normalizeValue(key.args?.[1]) ?? '');
      if (!Number.isSafeInteger(marketId) || !account) continue;
      const id = `${marketId}-${account}`;
      positionsByKey.set(id, this.normalizedRecord(value));
      accountMarketKeys.set(id, { marketId, account });
    }

    return [...accountMarketKeys.entries()].flatMap(([id, entry]) => {
      const { marketId, account } = entry;
      const market = marketsById.get(marketId);
      if (!market) return [];
      const totalsForMarket = totalsByMarket.get(marketId) ?? {};
      const marketPosition = positionsByKey.get(id) ?? {};
      const collateralAsset = assetIdToString(market.collateralAsset);
      const decimals = assets.get(collateralAsset)?.decimals ?? DECIMALS;
      const yesShares = this.safeCodecToBigInt(marketPosition.yesShares ?? marketPosition.yes_shares);
      const noShares = this.safeCodecToBigInt(marketPosition.noShares ?? marketPosition.no_shares);
      const netCollateralPaid = this.safeCodecToBigInt(marketPosition.netCollateralPaid ?? marketPosition.net_collateral_paid);
      if (yesShares === 0n && noShares === 0n && netCollateralPaid === 0n) return [];
      const hasAccountCostBasis = costBasisByKey.has(id);
      const hasMarketCostBasisTotals = costBasisTotalsByMarket.has(marketId);
      const accountCostBasis = costBasisByKey.get(id) ?? {};
      const marketCostBasisTotals = costBasisTotalsByMarket.get(marketId) ?? {};
      const yesCostBasis = this.safeCodecToBigInt(accountCostBasis.yes);
      const noCostBasis = this.safeCodecToBigInt(accountCostBasis.no);
      const accountCostBasisTotal = yesCostBasis + noCostBasis;
      const totalCostBasis =
        this.safeCodecToBigInt(marketCostBasisTotals.yes) + this.safeCodecToBigInt(marketCostBasisTotals.no);
      const status = this.variantName(market.status);
      const resolutionOutcome = resolutionsByMarket.get(marketId) ?? null;
      const normalizedStatus = status.toLowerCase();
      const normalizedResolution = resolutionOutcome?.toLowerCase();
      const collateral = dpmCollateralByMarket.get(marketId) ?? 0n;
      const winningShares =
        normalizedResolution === 'yes' ? yesShares : normalizedResolution === 'no' ? noShares : 0n;
      const totalWinningShares =
        normalizedResolution === 'yes'
          ? this.safeCodecToBigInt(totalsForMarket.totalYesShares)
          : normalizedResolution === 'no'
            ? this.safeCodecToBigInt(totalsForMarket.totalNoShares)
            : 0n;
      const claimablePayout =
        normalizedStatus === 'resolved'
          ? totalWinningShares > 0n
            ? (collateral * winningShares) / totalWinningShares
            : 0n
          : normalizedStatus === 'cancelled'
            ? hasAccountCostBasis && hasMarketCostBasisTotals && totalCostBasis > 0n
              ? (collateral * accountCostBasisTotal) / totalCostBasis
              : null
            : 0n;
      const finalized = normalizedStatus === 'resolved' || normalizedStatus === 'cancelled';
      const settlementPnl =
        finalized && claimablePayout !== null && hasAccountCostBasis ? claimablePayout - accountCostBasisTotal : null;
      const dominantOutcome = yesShares >= noShares ? 'Yes' : 'No';
      const dominantShares = yesShares >= noShares ? yesShares : noShares;

      return [
        {
          collection: collection('accountPositions'),
          id,
          blockHeight,
          timestamp,
          data: {
            id,
            account,
            marketId,
            outcome: dominantShares > 0n ? dominantOutcome : null,
            shares: decimalToString(dominantShares, decimals, 8),
            yesShares: decimalToString(yesShares, decimals, 8),
            noShares: decimalToString(noShares, decimals, 8),
            netCollateralPaid: decimalToString(netCollateralPaid, decimals, 8),
            costBasisUsd: hasAccountCostBasis ? decimalToString(accountCostBasisTotal, decimals, 8) : null,
            yesCostBasisUsd: hasAccountCostBasis ? decimalToString(yesCostBasis, decimals, 8) : null,
            noCostBasisUsd: hasAccountCostBasis ? decimalToString(noCostBasis, decimals, 8) : null,
            marketValueUsd: finalized && claimablePayout !== null ? decimalToString(claimablePayout, decimals, 8) : null,
            realizedPnlUsd: null,
            unrealizedPnlUsd: settlementPnl === null ? null : decimalToString(settlementPnl, decimals, 8),
            claimablePayoutUsd: claimablePayout === null ? null : decimalToString(claimablePayout, decimals, 8),
            isCreator: String(market.creator ?? '') === account,
            status,
            updatedAt: new Date(timestamp * 1000).toISOString(),
            market: { id: String(marketId), marketId },
          },
        },
      ];
    });
  }

  private async createOrderBookDocuments(
    orderBooks: any[],
    bids: any[],
    asks: any[],
    limitOrders: any[],
    assets: Map<string, AssetInfo>,
    prices: Map<string, bigint>,
    analytics: Analytics,
    blockHeight: number,
    timestamp: number,
    includeSnapshots: boolean
  ): Promise<IndexerDocument[]> {
    const documents: IndexerDocument[] = [];
    const priceLevels = this.extractOrderBookPriceLevels(bids, asks);
    const orderBookSnapshotIds = includeSnapshots
      ? orderBooks.flatMap(([key]) => {
          const idString = orderBookIdString(parseOrderBookId(key.args[0]));
          return PERSISTED_CHART_SNAPSHOT_TYPES.map((type) =>
            snapshotId('orderBook', idString, type, timestamp, blockHeight)
          );
        })
      : [];
    const previousSnapshots = includeSnapshots
      ? await this.repository.getMany(collection('orderBookSnapshots'), orderBookSnapshotIds)
      : new Map<string, IndexerDocument>();

    for (const [key, value] of orderBooks) {
      const id = parseOrderBookId(key.args[0]);
      const data = toJson(value) as Record<string, unknown>;
      const idString = orderBookIdString(id);
      const status = String(data.status ?? 'Stop');
      const levels = priceLevels.get(idString);
      const reserves =
        analytics.orderBookActiveReserves.get(idString) ?? { baseAssetReserves: 0n, quoteAssetReserves: 0n, liquidityUSD: 0n };
      const aggregate = analytics.orderBooks.get(idString)?.get('DAY') ?? newOrderBookAggregate('0');
      const price =
        levels?.bestAsk && levels.bestBid
          ? scaledToString((levels.bestAsk + levels.bestBid) / 2n, 8)
          : levels?.bestAsk
            ? scaledToString(levels.bestAsk, 8)
            : levels?.bestBid
              ? scaledToString(levels.bestBid, 8)
              : aggregate.price.close;
      const priceChangeDay = percentChange(analytics.orderBookDayOpenPrice.get(idString) ?? price, price);
      const volumeDayUSD = analytics.orderBookDayVolumeUSD.get(idString) ?? aggregate.volumeUSD;

      documents.push({
        collection: collection('orderBooks'),
        id: idString,
        blockHeight,
        timestamp,
        data: {
          id: idString,
          dexId: id.dexId,
          baseAssetId: id.baseAssetId,
          quoteAssetId: id.quoteAssetId,
          baseAssetReserves: reserves.baseAssetReserves.toString(),
          quoteAssetReserves: reserves.quoteAssetReserves.toString(),
          status,
          price,
          priceChangeDay,
          volumeDayUSD: scaledToString(volumeDayUSD, 8),
          lastDeals: JSON.stringify(aggregate.lastDeals),
          updatedAtBlock: blockHeight,
        },
      });

      if (includeSnapshots) {
        for (const type of PERSISTED_CHART_SNAPSHOT_TYPES) {
          const snapshot = snapshotId('orderBook', idString, type, timestamp, blockHeight);
          const typeAggregate = analytics.orderBooks.get(idString)?.get(type) ?? newOrderBookAggregate(price);
          const previous = previousSnapshots.get(snapshot);
          const priceSnapshot = mergePriceOhlc(previous?.data.price, price);
          documents.push({
            collection: collection('orderBookSnapshots'),
            id: snapshot,
            blockHeight,
            timestamp,
            data: {
              id: snapshot,
              orderBookId: idString,
              timestamp,
              type,
              price: {
                open: priceSnapshot.open,
                high: maxDecimalString(priceSnapshot.high, typeAggregate.price.high),
                low: minDecimalString(priceSnapshot.low, typeAggregate.price.low),
                close: price,
              },
              baseAssetVolume: scaledToString(typeAggregate.baseAssetVolume),
              quoteAssetVolume: scaledToString(typeAggregate.quoteAssetVolume),
              volumeUSD: scaledToString(typeAggregate.volumeUSD, 8),
              liquidityUSD: scaledToString(reserves.liquidityUSD, 8),
            },
          });
        }
      }
    }

    return documents;
  }

  private extractOrderBookPriceLevels(
    bids: any[],
    asks: any[]
  ): Map<string, { bestBid?: bigint; bestAsk?: bigint }> {
    const result = new Map<string, { bestBid?: bigint; bestAsk?: bigint }>();

    for (const [key] of bids) {
      const id = orderBookIdString(parseOrderBookId(key.args[0]));
      const price = codecToBigInt(key.args[1]);
      const current = result.get(id) ?? {};
      current.bestBid = current.bestBid === undefined || price > current.bestBid ? price : current.bestBid;
      result.set(id, current);
    }

    for (const [key] of asks) {
      const id = orderBookIdString(parseOrderBookId(key.args[0]));
      const price = codecToBigInt(key.args[1]);
      const current = result.get(id) ?? {};
      current.bestAsk = current.bestAsk === undefined || price < current.bestAsk ? price : current.bestAsk;
      result.set(id, current);
    }

    return result;
  }

  private mergeLimitOrderStorage(limitOrders: any[], assets: Map<string, AssetInfo>, prices: Map<string, bigint>, analytics: Analytics): void {
    for (const [key, value] of limitOrders) {
      const orderBookId = orderBookIdString(parseOrderBookId(key.args[0]));
      const [dexId, baseAssetId, quoteAssetId] = orderBookId.split('-');
      if (!dexId || !baseAssetId || !quoteAssetId) continue;

      const data = normalizeValue(value) as Record<string, unknown>;
      const side = String(data.side ?? 'Sell');
      const amount = decimalStringToScaled(codecToDecimalString(data.amount ?? 0, assets.get(baseAssetId)?.decimals ?? DECIMALS));
      const price = decimalStringToScaled(codecToDecimalString(data.price ?? 0, DECIMALS));
      const quoteAmount = scaledMul(amount, price);
      const reserves =
        analytics.orderBookActiveReserves.get(orderBookId) ?? { baseAssetReserves: 0n, quoteAssetReserves: 0n, liquidityUSD: 0n };

      if (side === 'Buy') {
        const quoteReserve = naturalScaledToCodec(quoteAmount, assets.get(quoteAssetId)?.decimals ?? DECIMALS);
        reserves.quoteAssetReserves += quoteReserve;
        reserves.liquidityUSD += scaledMul(quoteAmount, prices.get(quoteAssetId) ?? 0n);
        analytics.assetOrderBookLiquidity.set(quoteAssetId, (analytics.assetOrderBookLiquidity.get(quoteAssetId) ?? 0n) + quoteReserve);
      } else {
        const baseReserve = naturalScaledToCodec(amount, assets.get(baseAssetId)?.decimals ?? DECIMALS);
        reserves.baseAssetReserves += baseReserve;
        reserves.liquidityUSD += scaledMul(amount, prices.get(baseAssetId) ?? 0n);
        analytics.assetOrderBookLiquidity.set(baseAssetId, (analytics.assetOrderBookLiquidity.get(baseAssetId) ?? 0n) + baseReserve);
      }

      analytics.orderBookActiveReserves.set(orderBookId, reserves);
    }
  }

  private createNetworkSnapshotDocuments(
    analytics: Analytics,
    blockHeight: number,
    timestamp: number,
    includeSnapshots: boolean
  ): IndexerDocument[] {
    if (!includeSnapshots) return [];

    return AGGREGATE_SNAPSHOT_TYPES.map((type) => {
      const aggregate =
        analytics.network.get(type) ?? newNetworkAggregate(0, this.networkLiquidityStats);
      const id = snapshotId('network', 'all', type, timestamp, blockHeight);

      return {
        collection: collection('networkSnapshots'),
        id,
        blockHeight,
        timestamp,
        data: {
          id,
          type,
          timestamp,
          accounts: aggregate.accounts,
          transactions: aggregate.transactions,
          fees: aggregate.fees.toString(),
          liquidityUSD: aggregate.liquidityUSD,
          poolLiquidityUSD: aggregate.poolLiquidityUSD,
          orderBookLiquidityUSD: aggregate.orderBookLiquidityUSD,
          volumeUSD: scaledToString(aggregate.volumeUSD, 8),
          swaps: aggregate.swaps,
          activePools: aggregate.activePools,
          activeOrderBooks: aggregate.activeOrderBooks,
          listedAssets: aggregate.listedAssets,
          bridgeIncomingTransactions: aggregate.bridgeIncomingTransactions,
          bridgeOutgoingTransactions: aggregate.bridgeOutgoingTransactions,
        },
      };
    });
  }

  private emptyNetworkBackfillFlowTotals(): NetworkBackfillFlowTotals {
    return {
      accounts: 0,
      transactions: 0,
      fees: 0n,
      volumeUSD: 0n,
      swaps: 0,
      bridgeIncomingTransactions: 0,
      bridgeOutgoingTransactions: 0,
    };
  }

  private createNetworkBackfillWindows(): NetworkBackfillWindow[] {
    return AGGREGATE_SNAPSHOT_TYPES.map((type) => ({
      type,
      blocks: [],
      windowStart: 0,
      totals: this.emptyNetworkBackfillFlowTotals(),
      pendingDocument: null,
    }));
  }

  private networkBackfillBlockFromSnapshot(document: IndexerDocument): NetworkBackfillBlock | null {
    const timestamp = Number(document.data.timestamp ?? document.timestamp ?? 0);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
    const blockHeight = Number(document.blockHeight ?? document.data.blockHeight ?? 0);
    if (!Number.isFinite(blockHeight)) return null;

    return {
      blockHeight,
      timestamp,
      accounts: Number(document.data.accounts ?? 0),
      transactions: Number(document.data.transactions ?? 0),
      fees: codecToBigInt(document.data.fees ?? 0),
      volumeUSD: decimalStringToScaled(document.data.volumeUSD ?? '0'),
      swaps: Number(document.data.swaps ?? 0),
      bridgeIncomingTransactions: Number(document.data.bridgeIncomingTransactions ?? 0),
      bridgeOutgoingTransactions: Number(document.data.bridgeOutgoingTransactions ?? 0),
    };
  }

  private addNetworkBackfillBlock(totals: NetworkBackfillFlowTotals, block: NetworkBackfillBlock): void {
    totals.accounts += block.accounts;
    totals.transactions += block.transactions;
    totals.fees += block.fees;
    totals.volumeUSD += block.volumeUSD;
    totals.swaps += block.swaps;
    totals.bridgeIncomingTransactions += block.bridgeIncomingTransactions;
    totals.bridgeOutgoingTransactions += block.bridgeOutgoingTransactions;
  }

  private removeNetworkBackfillBlock(totals: NetworkBackfillFlowTotals, block: NetworkBackfillBlock): void {
    totals.accounts -= block.accounts;
    totals.transactions -= block.transactions;
    totals.fees -= block.fees;
    totals.volumeUSD -= block.volumeUSD;
    totals.swaps -= block.swaps;
    totals.bridgeIncomingTransactions -= block.bridgeIncomingTransactions;
    totals.bridgeOutgoingTransactions -= block.bridgeOutgoingTransactions;
  }

  private advanceNetworkBackfillWindow(window: NetworkBackfillWindow, block: NetworkBackfillBlock): IndexerDocument {
    window.blocks.push(block);
    this.addNetworkBackfillBlock(window.totals, block);

    const cutoff = block.timestamp - SNAPSHOT_WINDOW_SECONDS[window.type];
    while (window.windowStart < window.blocks.length && window.blocks[window.windowStart].timestamp < cutoff) {
      this.removeNetworkBackfillBlock(window.totals, window.blocks[window.windowStart]);
      window.windowStart++;
    }

    if (window.windowStart > 1_000 && window.windowStart * 2 > window.blocks.length) {
      window.blocks.splice(0, window.windowStart);
      window.windowStart = 0;
    }

    const id = snapshotId('network', 'all', window.type, block.timestamp, block.blockHeight);
    return {
      collection: collection('networkSnapshots'),
      id,
      blockHeight: block.blockHeight,
      timestamp: block.timestamp,
      data: {
        id,
        type: window.type,
        timestamp: block.timestamp,
        accounts: window.totals.accounts,
        transactions: window.totals.transactions,
        fees: window.totals.fees.toString(),
        volumeUSD: scaledToString(window.totals.volumeUSD, 8),
        swaps: window.totals.swaps,
        bridgeIncomingTransactions: window.totals.bridgeIncomingTransactions,
        bridgeOutgoingTransactions: window.totals.bridgeOutgoingTransactions,
      },
    };
  }

  private shouldPersistBackfillNetworkAggregate(
    document: IndexerDocument,
    retentionTimestamp: number | undefined
  ): boolean {
    if (retentionTimestamp === undefined) return true;
    const type = String(document.data.type ?? '');
    if (type !== 'DEFAULT' && type !== 'HOUR') return true;
    const documentTimestamp = Number(document.timestamp ?? document.data.timestamp ?? 0);
    if (!Number.isFinite(documentTimestamp)) return false;
    return documentTimestamp >= retentionTimestamp - CHART_SNAPSHOT_RETENTION_SECONDS[type];
  }

  private getStakingConstNumber(name: string): number | null {
    const constant = ((this.api?.consts as unknown as { staking?: Record<string, { toNumber?: () => number } | undefined> })?.staking ??
      {})[name];
    const value = constant?.toNumber?.();

    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private getMaxNominatorRewardedPerValidator(): number {
    const value =
      this.getStakingConstNumber('maxNominatorRewardedPerValidator') ?? this.getStakingConstNumber('maxExposurePageSize');

    if (value === null) {
      throw new Error('staking.maxNominatorRewardedPerValidator or staking.maxExposurePageSize is required');
    }

    return value;
  }

  private unwrapOption(value: unknown): unknown {
    if (!value || typeof value !== 'object') return value;

    const option = value as { isEmpty?: boolean; isNone?: boolean; unwrap?: () => unknown; value?: unknown };
    if (option.isEmpty || option.isNone) return 0n;
    if (typeof option.unwrap === 'function') return option.unwrap();
    if (option.value !== undefined) return option.value;

    return value;
  }

  private codecRecordCandidates(value: unknown): Record<string, unknown>[] {
    const candidates: Record<string, unknown>[] = [];
    const json = toJson(value);
    const human = toHuman(value);

    if (isRecord(json)) candidates.push(json);
    if (isRecord(human) && human !== json) candidates.push(human);
    if (isRecord(value) && value !== json && value !== human) candidates.push(value);

    return candidates;
  }

  private codecField(value: unknown, field: string): unknown {
    for (const candidate of this.codecRecordCandidates(value)) {
      if (field in candidate) return candidate[field];
    }

    return undefined;
  }

  private codecArray(value: unknown): unknown[] | null {
    const unwrapped = this.unwrapOption(value);
    if (Array.isArray(unwrapped)) return unwrapped;

    const toArray = (unwrapped as { toArray?: () => unknown[] } | undefined)?.toArray;
    if (typeof toArray === 'function') {
      const array = toArray.call(unwrapped);
      if (Array.isArray(array)) return array;
    }

    const json = toJson(unwrapped);
    if (Array.isArray(json)) return json;

    const human = toHuman(unwrapped);
    if (Array.isArray(human)) return human;

    return null;
  }

  private codecToNumber(value: unknown): number | null {
    const unwrapped = this.unwrapOption(value);
    const text = String((unwrapped as CodecLike | undefined)?.toString?.() ?? unwrapped ?? '');
    const parsed = Number(text.replace(/,/g, ''));

    return Number.isFinite(parsed) ? parsed : null;
  }

  private latestRewardEra(rewardEntries: Array<[StorageEntryKey, unknown]>): StakingRewardEra | null {
    let latest: StakingRewardEra | null = null;

    for (const [key, value] of rewardEntries) {
      const era = this.codecToNumber(key.args[0]);
      const reward = codecToBigInt(this.unwrapOption(value));

      if (era === null || reward <= 0n) continue;
      if (!latest || era > latest.era) latest = { era, reward };
    }

    return latest;
  }

  private formatValidatorPrefs(entries: Array<[StorageEntryKey, unknown]>): StakingValidatorInfo[] {
    return entries.map(([key, value]) => {
      const prefs = value as {
        commission?: { unwrap?: () => unknown; toString?: () => string };
        blocked?: { isTrue?: boolean; toJSON?: () => unknown; toString?: () => string };
      };
      const address = key.args[0]?.toString?.() ?? key.args[0];
      const commissionValue = prefs.commission?.unwrap?.() ?? prefs.commission?.toString?.();
      const blockedValue = prefs.blocked?.isTrue ?? prefs.blocked?.toJSON?.() ?? prefs.blocked?.toString?.();

      if (!address) throw new Error('staking.validators entry is missing a validator address');
      if (commissionValue === undefined || commissionValue === null) {
        throw new Error(`staking.validators entry for ${String(address)} is missing commission`);
      }
      if (blockedValue === undefined || blockedValue === null) {
        throw new Error(`staking.validators entry for ${String(address)} is missing blocked status`);
      }

      return {
        address: String(address),
        commission: String(commissionValue),
        blocked: blockedValue === true || blockedValue === 'true',
      };
    });
  }

  private async getEraRewardPoints(
    era: number,
    query: any = this.api?.query
  ): Promise<{ total: number; individual: Map<string, number> }> {
    if (!query) throw new Error('Cannot read staking reward points before the chain API is initialized');

    const erasRewardPoints = query.staking?.erasRewardPoints;
    if (typeof erasRewardPoints !== 'function') {
      throw new Error('staking.erasRewardPoints is required to refresh staking validators');
    }

    const data = await this.withRpcTimeout<{
      total?: unknown;
      individual?: { entries?: () => Iterable<[unknown, unknown]> };
    }>(
      () => erasRewardPoints(era),
      `staking.erasRewardPoints(${era})`
    );
    const total = this.codecToNumber(data?.total);
    const individual = new Map<string, number>();

    if (total === null) {
      throw new Error(`staking.erasRewardPoints(${era}) is missing total points`);
    }
    if (typeof data?.individual?.entries !== 'function') {
      throw new Error(`staking.erasRewardPoints(${era}) is missing individual points`);
    }

    for (const [account, points] of data.individual.entries()) {
      const parsedPoints = this.codecToNumber(points);
      if (parsedPoints === null) {
        throw new Error(`staking.erasRewardPoints(${era}) has invalid points for ${String(account)}`);
      }
      individual.set(String(account), parsedPoints);
    }

    return { total, individual };
  }

  private async getEraExposures(era: number, query: any = this.api?.query): Promise<Map<string, StakingExposure>> {
    if (!query) throw new Error('Cannot read staking exposures before the chain API is initialized');

    const staking = query.staking;
    if (
      hasStorageEntries(staking?.erasStakersOverview) &&
      hasStorageEntries(staking?.erasStakersPaged)
    ) {
      const [overviewEntries, pageEntries] = await Promise.all([
        this.fetchStorageEntries(staking.erasStakersOverview, 'staking.erasStakersOverview', era),
        this.fetchStorageEntries(staking.erasStakersPaged, 'staking.erasStakersPaged', era),
      ]);

      if (overviewEntries.length > 0) return this.getPagedEraExposures(era, overviewEntries, pageEntries);
      if (pageEntries.length > 0) {
        throw new Error(`staking.erasStakersPaged(${era}) has pages without staking.erasStakersOverview entries`);
      }
    }

    const entries = await this.fetchStorageEntries(staking?.erasStakers, 'staking.erasStakers', era);
    if (!entries.length) throw new Error(`staking.erasStakers(${era}) returned no validator exposures`);

    return this.parseEraExposureEntries(era, entries);
  }

  private parseEraExposureEntries(era: number, entries: Array<[StorageEntryKey, unknown]>): Map<string, StakingExposure> {
    const exposures = new Map<string, StakingExposure>();

    for (const [key, value] of entries) {
      const address = key.args[1]?.toString?.() ?? key.args[1];
      const total = this.codecField(value, 'total');
      const own = this.codecField(value, 'own');
      const othersRaw = this.codecArray(this.codecField(value, 'others'));

      if (!address) throw new Error(`staking.erasStakers(${era}) entry is missing a validator address`);
      if (total === undefined || total === null) {
        throw new Error(`staking.erasStakers(${era}) entry for ${String(address)} is missing total exposure`);
      }
      if (own === undefined || own === null) {
        throw new Error(`staking.erasStakers(${era}) entry for ${String(address)} is missing own exposure`);
      }
      if (!othersRaw) {
        throw new Error(`staking.erasStakers(${era}) entry for ${String(address)} is missing nominators`);
      }

      const others = othersRaw.map((item) => {
        const whoValue = this.codecField(item, 'who');
        const nominatorValue = this.codecField(item, 'value');
        const who = (whoValue as CodecLike | undefined)?.toString?.() ?? whoValue;

        if (!who) throw new Error(`staking.erasStakers(${era}) entry for ${String(address)} has a nominator without an address`);
        if (nominatorValue === undefined || nominatorValue === null) {
          throw new Error(`staking.erasStakers(${era}) entry for ${String(address)} has a nominator without exposure`);
        }

        return {
          who: String(who),
          value: codecToBigInt(nominatorValue).toString(),
        };
      });

      exposures.set(String(address), {
        total: codecToBigInt(total),
        own: codecToBigInt(own).toString(),
        others,
      });
    }

    return exposures;
  }

  private async getPagedEraExposures(
    era: number,
    overviewEntries: Array<[StorageEntryKey, unknown]>,
    pageEntries: Array<[StorageEntryKey, unknown]>
  ): Promise<Map<string, StakingExposure>> {
    const pagesByValidator = new Map<string, Map<number, Array<{ who: string; value: string }>>>();

    for (const [key, value] of pageEntries) {
      const address = key.args[1]?.toString?.() ?? key.args[1];
      const pageIndex = this.codecToNumber(key.args[2]);
      const pageTotal = this.codecField(value, 'pageTotal');
      const othersRaw = this.codecArray(this.codecField(value, 'others'));

      if (!address) throw new Error(`staking.erasStakersPaged(${era}) entry is missing a validator address`);
      if (pageIndex === null) throw new Error(`staking.erasStakersPaged(${era}) entry for ${String(address)} has invalid page`);
      if (pageIndex < 0) throw new Error(`staking.erasStakersPaged(${era}) entry for ${String(address)} has invalid page`);
      if (pageTotal === undefined || pageTotal === null) {
        throw new Error(`staking.erasStakersPaged(${era}) entry for ${String(address)} page ${pageIndex} is missing page total`);
      }
      if (!othersRaw) throw new Error(`staking.erasStakersPaged(${era}) entry for ${String(address)} is missing nominators`);

      const others = othersRaw.map((item) => {
        const whoValue = this.codecField(item, 'who');
        const nominatorValue = this.codecField(item, 'value');
        const who = (whoValue as CodecLike | undefined)?.toString?.() ?? whoValue;

        if (!who) throw new Error(`staking.erasStakersPaged(${era}) entry for ${String(address)} has a nominator without an address`);
        if (nominatorValue === undefined || nominatorValue === null) {
          throw new Error(`staking.erasStakersPaged(${era}) entry for ${String(address)} has a nominator without exposure`);
        }

        return { who: String(who), value: codecToBigInt(nominatorValue).toString() };
      });
      const pages = pagesByValidator.get(String(address)) ?? new Map<number, Array<{ who: string; value: string }>>();
      if (pages.has(pageIndex)) {
        throw new Error(`staking.erasStakersPaged(${era}) has duplicate page ${pageIndex} for validator ${String(address)}`);
      }
      pages.set(pageIndex, others);
      pagesByValidator.set(String(address), pages);
    }

    const exposures = new Map<string, StakingExposure>();
    for (const [key, value] of overviewEntries) {
      const address = key.args[1]?.toString?.() ?? key.args[1];
      const total = this.codecField(value, 'total');
      const own = this.codecField(value, 'own');
      const pageCount = this.codecToNumber(this.codecField(value, 'pageCount'));

      if (!address) throw new Error(`staking.erasStakersOverview(${era}) entry is missing a validator address`);
      if (total === undefined || total === null) {
        throw new Error(`staking.erasStakersOverview(${era}) entry for ${String(address)} is missing total exposure`);
      }
      if (own === undefined || own === null) {
        throw new Error(`staking.erasStakersOverview(${era}) entry for ${String(address)} is missing own exposure`);
      }
      if (pageCount === null) {
        throw new Error(`staking.erasStakersOverview(${era}) entry for ${String(address)} has invalid page count`);
      }

      const pages = pagesByValidator.get(String(address)) ?? new Map<number, Array<{ who: string; value: string }>>();
      if (pages.size !== pageCount) {
        throw new Error(`staking.erasStakersPaged(${era}) is missing pages for validator ${String(address)}`);
      }
      const others: Array<{ who: string; value: string }> = [];
      for (let index = 0; index < pageCount; index += 1) {
        const page = pages.get(index);
        if (!page) {
          throw new Error(`staking.erasStakersPaged(${era}) is missing page ${index} for validator ${String(address)}`);
        }
        others.push(...page);
      }

      exposures.set(String(address), {
        total: codecToBigInt(total),
        own: codecToBigInt(own).toString(),
        others,
      });
    }

    for (const address of pagesByValidator.keys()) {
      if (!exposures.has(address)) {
        throw new Error(`staking.erasStakersOverview(${era}) is missing overview for validator ${address}`);
      }
    }

    return exposures;
  }

  private normalizeIdentityInfoValue(value: unknown): unknown {
    if (value === 'None' || value === null || value === undefined) return '';
    if (!Array.isArray(value) && typeof value === 'object' && 'Raw' in value) {
      return String((value as { Raw?: unknown }).Raw ?? '');
    }

    return value;
  }

  private async readValidatorIdentity(
    address: string,
    query: any = this.api?.query
  ): Promise<Record<string, unknown> | null> {
    const identityOf = query?.identity?.identityOf;
    if (typeof identityOf !== 'function') {
      throw new Error('identity.identityOf is required to refresh staking validators');
    }

    const codec = await this.withRpcTimeout<{ isEmpty?: boolean; isNone?: boolean }>(
      () => identityOf(address),
      `identity.identityOf(${address})`
    );
    if (!codec) throw new Error(`identity.identityOf(${address}) returned no codec`);
    if (codec.isEmpty || codec.isNone) return null;

    const identity = toHuman(this.unwrapOption(codec)) as Record<string, unknown>;
    const info =
      identity.info && typeof identity.info === 'object' && !Array.isArray(identity.info)
        ? Object.fromEntries(
            Object.entries(identity.info as Record<string, unknown>).map(([key, value]) => [
              key,
              this.normalizeIdentityInfoValue(value),
            ])
          )
        : {};

    return { ...identity, info };
  }

  private isKnownGoodIdentity(identity: Record<string, unknown> | null): boolean {
    const judgements = Array.isArray(identity?.judgements) ? identity.judgements : [];

    return judgements.some((judgement) => {
      if (Array.isArray(judgement)) return judgement[1] === 'KnownGood';
      if (judgement && typeof judgement === 'object') return Object.values(judgement).includes('KnownGood');
      return judgement === 'KnownGood';
    });
  }

  /**
   * Annualizes the latest completed validator-era reward as a nominator return percentage.
   */
  private calculateValidatorApy(
    validatorTotalStake: bigint,
    eraValidatorReward: bigint,
    rewardPoints: number,
    totalRewardPoints: number,
    commission: string,
    prices: Map<string, bigint>,
    assets: Map<string, AssetInfo>
  ): string | null {
    const xorPriceUSD = prices.get(XOR) ?? 0n;
    const valPriceUSD = prices.get(VAL) ?? 0n;

    if (
      validatorTotalStake <= 0n ||
      eraValidatorReward <= 0n ||
      rewardPoints <= 0 ||
      totalRewardPoints <= 0 ||
      xorPriceUSD <= 0n ||
      valPriceUSD <= 0n
    ) {
      return null;
    }

    const validatorReward = (eraValidatorReward * BigInt(rewardPoints)) / BigInt(totalRewardPoints);
    const rewardVal = reserveToNaturalScaled(validatorReward, assets.get(VAL)?.decimals ?? DECIMALS);
    const rewardUSD = scaledMul(rewardVal, valPriceUSD);
    const rewardXor = scaledDiv(rewardUSD, xorPriceUSD);
    const totalStakeXor = reserveToNaturalScaled(validatorTotalStake, assets.get(XOR)?.decimals ?? DECIMALS);
    const commissionValue = codecToBigInt(commission);
    const nominatorShare =
      commissionValue >= COMMISSION_DENOMINATOR
        ? 0n
        : SCALE - (commissionValue * SCALE) / COMMISSION_DENOMINATOR;
    const annualizedReturn = scaledDiv(rewardXor, totalStakeXor) * ERAS_PER_DAY * DAYS_PER_YEAR;
    const apyPercent = scaledMul(annualizedReturn, nominatorShare) * 100n;

    return scaledToString(apyPercent, 8);
  }

  private async loadStakingValidatorProjectionInputs(
    query: any = this.api?.query
  ): Promise<StakingValidatorProjectionInputs> {
    if (!query) throw new Error('Cannot refresh staking validators before the chain API is initialized');

    const validatorsStorage = query.staking?.validators;
    const currentEraStorage = query.staking?.currentEra;
    const rewardsStorage = query.staking?.erasValidatorReward;

    if (!hasStorageEntries(validatorsStorage)) {
      throw new Error('staking.validators.entriesPaged is required to refresh staking validators');
    }
    if (typeof currentEraStorage !== 'function') {
      throw new Error('staking.currentEra is required to refresh staking validators');
    }
    if (!hasStorageEntries(rewardsStorage)) {
      throw new Error('staking.erasValidatorReward.entriesPaged is required to refresh staking validators');
    }

    const [validatorEntries, currentEraCodec, rewardEntries] = await Promise.all([
      this.fetchStorageEntries(validatorsStorage, 'staking.validators'),
      this.withRpcTimeout(() => currentEraStorage(), 'staking.currentEra()'),
      this.fetchStorageEntries(rewardsStorage, 'staking.erasValidatorReward'),
    ]);
    const validators = this.formatValidatorPrefs(validatorEntries);
    if (!validators.length) {
      return {
        validators: [],
        currentEra: 0,
        rewardEra: null,
        rewardPoints: null,
        currentExposures: new Map(),
        apyExposures: null,
        identityByAddress: new Map(),
        maxNominatorRewarded: this.getMaxNominatorRewardedPerValidator(),
      };
    }

    const currentEra = this.codecToNumber(currentEraCodec);
    if (currentEra === null) throw new Error('staking.currentEra returned an invalid era');

    const rewardEra = this.latestRewardEra(rewardEntries);
    const apyEra = rewardEra?.era ?? null;
    const [rewardPoints, currentExposures, apyExposureEntries, identities] = await Promise.all([
      rewardEra ? this.getEraRewardPoints(rewardEra.era, query) : Promise.resolve(null),
      this.getEraExposures(currentEra, query),
      rewardEra && apyEra !== currentEra ? this.getEraExposures(rewardEra.era, query) : Promise.resolve(null),
      mapWithConcurrency(validators, VALIDATOR_IDENTITY_CONCURRENCY, async (validator) => [
        validator.address,
        await this.readValidatorIdentity(validator.address, query),
      ] as const),
    ]);
    if (!currentExposures.size) throw new Error(`staking.erasStakers(${currentEra}) returned no validator exposures`);

    const apyExposures = rewardEra ? (apyExposureEntries ?? currentExposures) : null;
    const identityByAddress = new Map(identities);
    const maxNominatorRewarded = this.getMaxNominatorRewardedPerValidator();
    if (!validators.some((validator) => currentExposures.has(validator.address))) {
      throw new Error(`staking.erasStakers(${currentEra}) did not match any staking.validators entries`);
    }

    return {
      validators,
      currentEra,
      rewardEra,
      rewardPoints,
      currentExposures,
      apyExposures,
      identityByAddress,
      maxNominatorRewarded,
    };
  }

  private createStakingValidatorDocumentsFromInputs(
    inputs: StakingValidatorProjectionInputs,
    blockHeight: number,
    timestamp: number,
    prices: Map<string, bigint>,
    assets: Map<string, AssetInfo>
  ): IndexerDocument[] {
    const {
      validators,
      currentEra,
      rewardEra,
      rewardPoints,
      currentExposures,
      apyExposures,
      identityByAddress,
      maxNominatorRewarded,
    } = inputs;
    const apyEra = rewardEra?.era ?? null;
    const activeValidators = validators.filter((validator) => currentExposures.has(validator.address));

    return activeValidators.map((validator) => {
      const exposure = currentExposures.get(validator.address);
      const apyExposure = apyExposures?.get(validator.address) ?? null;
      const identity = identityByAddress.get(validator.address) ?? null;
      const validatorRewardPoints = rewardPoints?.individual.get(validator.address) ?? null;

      if (!exposure) {
        throw new Error(`staking.erasStakers(${currentEra}) is missing exposure for validator ${validator.address}`);
      }
      if (!apyExposure && validatorRewardPoints && validatorRewardPoints > 0) {
        throw new Error(
          `staking.erasStakers(${apyEra}) has reward points but is missing APY exposure for validator ${validator.address}`
        );
      }

      const apy = rewardEra && rewardPoints && apyExposure
        ? this.calculateValidatorApy(
            apyExposure.total,
            rewardEra.reward,
            validatorRewardPoints ?? 0,
            rewardPoints.total,
            validator.commission,
            prices,
            assets
          )
        : null;

      return {
        collection: collection('stakingValidators'),
        id: validator.address,
        blockHeight,
        timestamp,
        data: {
          id: validator.address,
          address: validator.address,
          commission: validator.commission,
          blocked: validator.blocked,
          rewardPoints: validatorRewardPoints,
          nominators: exposure.others,
          identity,
          apy,
          isOversubscribed: exposure.others.length > maxNominatorRewarded,
          isKnownGood: this.isKnownGoodIdentity(identity),
          stake: {
            total: exposure.total.toString(),
            own: exposure.own,
          },
          era: apyEra,
          updated: timestamp,
        },
      };
    });
  }

  private async createStakingValidatorDocuments(
    blockHeight: number,
    timestamp: number,
    prices: Map<string, bigint>,
    assets: Map<string, AssetInfo>,
    query: any = this.api?.query
  ): Promise<IndexerDocument[]> {
    return this.createStakingValidatorDocumentsFromInputs(
      await this.loadStakingValidatorProjectionInputs(query),
      blockHeight,
      timestamp,
      prices,
      assets
    );
  }

  private createStakingValidatorsStream(
    validatorDocuments: IndexerDocument[],
    blockHeight: number,
    timestamp: number
  ): IndexerDocument {
    return {
      collection: collection('updatesStreams'),
      id: 'stakingValidators',
      blockHeight,
      timestamp,
      data: {
        id: 'stakingValidators',
        block: blockHeight,
        data: JSON.stringify(validatorDocuments.map((document) => document.data)),
      },
    };
  }

  private createStakingDocuments(nominators: any[], blockHeight: number, timestamp: number): IndexerDocument[] {
    return nominators.map(([key]) => {
      const id = String(key.args[0]);
      return {
        collection: collection('stakingStakers'),
        id,
        blockHeight,
        timestamp,
        data: { id },
      };
    });
  }

  private createReferralDocuments(referrers: any[], blockHeight: number, timestamp: number): IndexerDocument[] {
    return referrers.map(([key, value]) => {
      const referral = String(key.args[0]);
      const referrer = String(toJson(value));
      return {
        collection: collection('referrerRewards'),
        id: `${referrer}-${referral}`,
        blockHeight,
        timestamp,
        data: {
          id: `${referrer}-${referral}`,
          referral,
          referrer,
          blockHeight,
          timestamp,
          updated: timestamp,
          amount: '0',
        },
      };
    });
  }

  private async createVaultDocuments(cdpEntries: any[], blockHeight: number, timestamp: number): Promise<IndexerDocument[]> {
    const documents: IndexerDocument[] = [];
    const existingVaults = await this.repository.getMany(
      collection('vaults'),
      cdpEntries.map(([key]) => String(key.args[0]))
    );

    for (const [key, value] of cdpEntries) {
      const id = String(key.args[0]);
      const data = normalizeValue(value) as Record<string, unknown>;
      const existing = existingVaults.get(id);
      documents.push({
        collection: collection('vaults'),
        id,
        blockHeight,
        timestamp,
        data: {
          id,
          type: 'Type2',
          status: 'Opened',
          ownerId: firstString(data, ['owner']),
          collateralAssetId: firstString(data, ['collateralAssetId']),
          debtAssetId: firstString(data, ['stablecoinAssetId']),
          collateralAmountReturned: '0',
          createdAtBlock: Number(existing?.data.createdAtBlock ?? blockHeight),
          updatedAtBlock: blockHeight,
        },
      });
    }

    return documents;
  }

  private createAccountLiquidityDocuments(
    poolProviders: any[],
    pools: PoolState[],
    assets: Map<string, AssetInfo>,
    prices: Map<string, bigint>,
    blockHeight: number,
    timestamp: number
  ): IndexerDocument[] {
    const poolByAccount = new Map(pools.map((pool) => [pool.poolAccount, pool]));

    return poolProviders.flatMap(([key, value]) => {
      const poolAccount = String(key.args[0]);
      const account = String(key.args[1]);
      const pool = poolByAccount.get(poolAccount);
      if (!pool) return [];

      const poolTokens = codecToBigInt(value);
      const poolShare = pool.poolTokenSupply === 0n ? 0n : scaledDiv(poolTokens, pool.poolTokenSupply);
      const liquidityScaled = decimalStringToScaled(pool.liquidityUSD);
      const liquidityUSD = scaledToString(scaledMul(liquidityScaled, poolShare), 8);
      const id = `${account}-${pool.id}`;

      return [
        {
          collection: collection('accountLiquiditySnapshots'),
          id: snapshotId('accountLiquidity', id, 'DEFAULT', timestamp),
          blockHeight,
          timestamp,
          data: {
            id: snapshotId('accountLiquidity', id, 'DEFAULT', timestamp),
            accountLiquidityId: id,
            timestamp,
            type: 'DEFAULT',
            poolTokens: poolTokens.toString(),
            liquidityUSD,
          },
        },
      ];
    });
  }

  private accountLiquiditySnapshotPayloadEquals(left: IndexerDocument, right: IndexerDocument): boolean {
    return (
      left.data.id === right.data.id &&
      left.data.accountLiquidityId === right.data.accountLiquidityId &&
      left.data.type === right.data.type &&
      left.data.poolTokens === right.data.poolTokens &&
      left.data.liquidityUSD === right.data.liquidityUSD
    );
  }

  private async createChangedAccountLiquidityDocuments(
    poolProviders: any[],
    pools: PoolState[],
    assets: Map<string, AssetInfo>,
    prices: Map<string, bigint>,
    blockHeight: number,
    timestamp: number,
    includeSnapshots: boolean
  ): Promise<IndexerDocument[]> {
    if (!includeSnapshots) return [];

    const candidates = this.createAccountLiquidityDocuments(
      poolProviders,
      pools,
      assets,
      prices,
      blockHeight,
      timestamp
    );
    if (!candidates.length) return [];

    const candidatesById = new Map(candidates.map((document) => [document.id, document]));
    const existing = await this.repository.getMany(collection('accountLiquiditySnapshots'), [...candidatesById.keys()]);

    return [...candidatesById.values()].filter((document) => {
      const previous = existing.get(document.id);
      return !previous || !this.accountLiquiditySnapshotPayloadEquals(previous, document);
    });
  }

  private createPriceStreamDocument(
    assetIds: Iterable<string>,
    prices: Map<string, bigint>,
    blockHeight: number,
    timestamp: number
  ): IndexerDocument {
    const priceData = Object.fromEntries([...assetIds].map((id) => [id, scaledToString(prices.get(id) ?? 0n, 8)]));

    return {
      collection: collection('updatesStreams'),
      id: 'price',
      blockHeight,
      timestamp,
      data: { id: 'price', block: blockHeight, data: JSON.stringify(priceData) },
    };
  }

  private createUpdateStreams(
    pools: PoolState[],
    assets: Map<string, AssetInfo>,
    prices: Map<string, bigint>,
    apyByPool: Map<string, string>,
    blockHeight: number,
    timestamp: number
  ): IndexerDocument[] {
    const apyData = Object.fromEntries(pools.map((pool) => [pool.id, apyByPool.get(pool.id) ?? '0']));
    const assetRegistrationData = Object.fromEntries(
      [...assets.values()].map((asset) => [
        asset.id,
        JSON.stringify({
          address: asset.id,
          name: asset.name,
          symbol: asset.symbol,
          decimals: asset.decimals,
        }),
      ])
    );

    return [
      ...(this.config.priceStreamRefreshIntervalBlocks > 0
        ? []
        : [this.createPriceStreamDocument(assets.keys(), prices, blockHeight, timestamp)]),
      {
        collection: collection('updatesStreams'),
        id: 'apy',
        blockHeight,
        timestamp,
        data: { id: 'apy', block: blockHeight, data: JSON.stringify(apyData) },
      },
      {
        collection: collection('updatesStreams'),
        id: 'assetRegistration',
        blockHeight,
        timestamp,
        data: { id: 'assetRegistration', block: blockHeight, data: JSON.stringify(assetRegistrationData) },
      },
    ];
  }
}
