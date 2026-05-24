import { ApiPromise, WsProvider } from '@polkadot/api';

import {
  ACCOUNT_TRANSACTIONS_BACKFILL_STATE_ID,
  hasCompletedAccountTransactionsBackfill,
  normalizeIndexedAccountId,
  uniqueIndexedAccountIds,
} from '../account-activity.js';
import type { AppConfig } from '../config.js';
import type { IndexerCollection, IndexerDocument, IndexerRepository, RepositoryQueryArgs } from '../repository/types.js';

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

type IndexBlockOptions = {
  refreshDerivedState?: boolean;
};

type DerivedStateRefreshRequest = {
  blockHeight: number;
  timestamp: number;
  includeSnapshots: boolean;
};

type StorageEntryKey = {
  args: unknown[];
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

const CHAIN_STATE_ID = 'chainState';
const XOR_BURN_BACKFILL_STATE_ID = 'xorBurnsBackfill';
const BRIDGE_PROXY_HISTORY_BACKFILL_STATE_ID = 'bridgeProxyHistoryBackfill-v1';
const NETWORK_AGGREGATE_BACKFILL_STATE_ID = 'networkAggregateSnapshotsBackfill';
const NETWORK_TRANSACTION_COUNTER_REPAIR_STATE_ID = 'networkTransactionCounterRepair-v1';
const ASSET_PRICE_OUTLIER_CLEANUP_STATE_ID = 'assetSnapshotPriceOutlierCleanup-v1';
const DECIMALS = 18;
const SCALE = 10n ** 18n;
const XOR = '0x0200000000000000000000000000000000000000000000000000000000000000';
const VAL = '0x0200040000000000000000000000000000000000000000000000000000000000';
const XOR_SUPPLY_REDENOMINATION_FACTOR = 1_000_000n;
const SORA_NEXUS_XOR_BURN_REMARK_TYPE = 'soraNexusXorClaim';
const LIBERLAND_NETWORK_ID = 'Liberland';
const SORA_XOR_BURN_START_BLOCK = 25_043_003;
const XOR_BURN_BACKFILL_BATCH_SIZE = 250;
const BRIDGE_PROXY_HISTORY_BACKFILL_BATCH_SIZE = 500;
const BRIDGE_PROXY_HISTORY_BACKFILL_RPC_CONCURRENCY = 16;
const ACCOUNT_TRANSACTIONS_BACKFILL_BATCH_SIZE = 1_000;
const FINALIZED_HEAD_RETRY_DELAY_MS = 5_000;
const FINALIZED_HEAD_POLL_INTERVAL_MS = 1_000;
const DERIVED_STATE_REFRESH_RETRY_DELAY_MS = 15_000;
const CHAIN_RPC_TIMEOUT_MS = 15_000;
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
const SNAPSHOT_TYPES: SnapshotTypeName[] = ['DEFAULT', 'HOUR', 'DAY', 'MONTH', 'BLOCK'];
const AGGREGATE_SNAPSHOT_TYPES: SnapshotTypeName[] = SNAPSHOT_TYPES.filter((type) => type !== 'BLOCK');
const SNAPSHOT_WINDOW_SECONDS: Record<SnapshotTypeName, number> = {
  DEFAULT: 5 * 60,
  HOUR: 3_600,
  DAY: 86_400,
  MONTH: 30 * 86_400,
  BLOCK: 0,
};
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

  const scaled = decimalStringToScaled(text);
  return scaled > 0n ? scaled : null;
};

const codecToDecimalString = (value: unknown, decimals = DECIMALS): string =>
  decimalToString(codecToBigInt(value), decimals, 18);

const scaledMul = (left: bigint, right: bigint): bigint => (left * right) / SCALE;
const scaledDiv = (left: bigint, right: bigint): bigint => (right === 0n ? 0n : (left * SCALE) / right);

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

const createAmountData = (assetId: string, amount: unknown, prices: Map<string, bigint>, assets: Map<string, AssetInfo>) => {
  const info = assets.get(assetId);
  const raw = codecToBigInt(amount);

  return {
    amount: codecToDecimalString(amount, info?.decimals ?? DECIMALS),
    amountUSD: codecUsd(assetId, raw, prices, info?.decimals ?? DECIMALS),
    assetId,
  };
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

const percentChange = (openPrice: string, closePrice: string): number => {
  const open = decimalStringToScaled(openPrice);
  if (open === 0n) return 0;

  const close = decimalStringToScaled(closePrice);
  return Number(scaledDiv(close - open, open)) / 10 ** 16;
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

export class ChainIndexer {
  private api: ApiPromise | null = null;
  private assetInfos = new Map<string, AssetInfo>();
  private prices = new Map<string, bigint>();
  private networkLiquidityStats = emptyNetworkLiquidityStats();
  private pendingFinalizedBlock = 0;
  private finalizedHeadDrainRunning = false;
  private finalizedHeadRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private finalizedHeadPollTimer: ReturnType<typeof setInterval> | null = null;
  private finalizedHeadPollRunning = false;
  private derivedStateRefreshRunning = false;
  private bridgeProxyHistoryRuntimeAvailable = false;
  private derivedStateRefreshRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingDerivedStateRefresh: DerivedStateRefreshRequest | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly repository: IndexerRepository
  ) {}

  async start(): Promise<void> {
    const provider = new WsProvider(this.config.soraWsEndpoint);
    this.api = await ApiPromise.create({ provider });
    const finalizedHash = await withTimeout(this.api.rpc.chain.getFinalizedHead(), 'chain.getFinalizedHead()');
    const finalizedHeader = await withTimeout(this.api.rpc.chain.getHeader(finalizedHash), `chain.getHeader(${finalizedHash.toString()})`);
    const finalizedBlock = finalizedHeader.number.toNumber();

    await this.refreshIndexingState();
    const indexedAny = await this.backfill();
    await this.subscribeFinalizedHeads();
    void this.runStartupMaintenance(finalizedBlock, indexedAny).catch((error: unknown) => {
      console.error('Startup maintenance failed', error);
    });
  }

  private async runStartupMaintenance(finalizedBlock: number, indexedAny: boolean): Promise<void> {
    await this.cleanupAssetSnapshotPriceOutliers();
    await this.backfillAccountTransactions();
    await this.repairNetworkTransactionCounters();
    let shouldRefreshDerivedState = indexedAny;

    if (!indexedAny && (await this.backfillNetworkAggregateSnapshots())) {
      shouldRefreshDerivedState = true;
    }
    if (shouldRefreshDerivedState) {
      const latestIndexedBlock = await this.getLastIndexedBlock();
      this.requestDerivedStateRefresh(Math.max(finalizedBlock, latestIndexedBlock), Math.floor(Date.now() / 1000), true);
    }
    await this.backfillXorBurns(finalizedBlock);
    await this.backfillBridgeProxyHistory(finalizedBlock);
  }

  private async getLastIndexedBlock(): Promise<number> {
    const state = await this.repository.get('updatesStreams', CHAIN_STATE_ID);
    if (!state?.data?.data || typeof state.data.data !== 'string') return 0;

    try {
      const parsed = JSON.parse(state.data.data) as { lastIndexedBlock?: number };
      return Number(parsed.lastIndexedBlock ?? 0);
    } catch {
      return 0;
    }
  }

  private createChainStateDocument(block: number): IndexerDocument {
    return {
      collection: collection('updatesStreams'),
      id: CHAIN_STATE_ID,
      blockHeight: block,
      timestamp: Math.floor(Date.now() / 1000),
      data: {
        id: CHAIN_STATE_ID,
        block,
        data: JSON.stringify({ lastIndexedBlock: block }),
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
    const state = await this.repository.get(collection('updatesStreams'), ASSET_PRICE_OUTLIER_CLEANUP_STATE_ID);
    if (state) return false;

    const groups = new Map<string, IndexerDocument[]>();
    for await (const page of this.queryPages(collection('assetSnapshots'), { orderBy: ['TIMESTAMP_ASC'] })) {
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
      await this.repository.deleteMany(collection('assetSnapshots'), ids.slice(start, start + 1_000));
    }

    await this.repository.upsert(this.createAssetPriceOutlierCleanupStateDocument(ids.length));
    if (ids.length) console.info(`Deleted ${ids.length} zero-volume asset snapshot price outliers`);
    return ids.length > 0;
  }

  /**
   * Creates compact per-account transaction rows for data indexed before the
   * `accountTransactions` collection existed. A completion marker lets GraphQL
   * avoid legacy history scans after the one-time migration has finished.
   */
  private async backfillAccountTransactions(): Promise<boolean> {
    const state = await this.repository.get(collection('updatesStreams'), ACCOUNT_TRANSACTIONS_BACKFILL_STATE_ID);
    if (hasCompletedAccountTransactionsBackfill(state?.data?.data)) return false;

    const documents: IndexerDocument[] = [];
    let processedDocuments = 0;
    let writtenDocuments = 0;
    let latestBlock = 0;
    let latestTimestamp = 0;
    const flush = async (): Promise<void> => {
      if (!documents.length) return;

      const batch = documents.splice(0, documents.length);
      await this.repository.upsertMany(batch);
      writtenDocuments += batch.length;
      await this.drainFinalizedHeads();
    };

    for await (const page of this.queryPages(collection('historyElements'), { orderBy: ['TIMESTAMP_ASC'] })) {
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
    const state = await this.repository.get(collection('updatesStreams'), NETWORK_TRANSACTION_COUNTER_REPAIR_STATE_ID);
    if (state) return false;

    const countersByBlock = await this.collectNetworkTransactionCountersByBlock();
    const aggregateSnapshots = new Map<string, IndexerDocument>();

    for await (const page of this.queryPages(collection('networkSnapshots'), {
      filter: { type: { notEqualTo: 'BLOCK' } },
    })) {
      page.forEach((document) => aggregateSnapshots.set(document.id, document));
    }

    const windows = this.createNetworkBackfillWindows();
    const blockUpdates: IndexerDocument[] = [];
    const aggregateUpdates: IndexerDocument[] = [];
    let latestBlock = 0;
    let blockSnapshotsUpdated = 0;
    let aggregateSnapshotsUpdated = 0;

    const flushBlockUpdates = async (): Promise<void> => {
      if (!blockUpdates.length) return;

      const batch = blockUpdates.splice(0, blockUpdates.length);
      await this.repository.upsertMany(batch);
    };

    const flushAggregateUpdates = async (): Promise<void> => {
      if (!aggregateUpdates.length) return;

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

  private async backfillXorBurns(finalizedBlock: number): Promise<void> {
    if (!this.api || finalizedBlock < SORA_XOR_BURN_START_BLOCK) return;

    const lastBackfilled = await this.getXorBurnBackfillBlock();
    const startBlock = Math.max(SORA_XOR_BURN_START_BLOCK, lastBackfilled + 1);

    if (startBlock > finalizedBlock) return;

    for (let block = startBlock; block <= finalizedBlock; block += XOR_BURN_BACKFILL_BATCH_SIZE) {
      await this.drainFinalizedHeads();

      const batchEnd = Math.min(block + XOR_BURN_BACKFILL_BATCH_SIZE - 1, finalizedBlock);
      const blocks = Array.from({ length: batchEnd - block + 1 }, (_item, index) => block + index);
      const blockHashes = await Promise.all(
        blocks.map((blockHeight) =>
          withTimeout(this.api!.rpc.chain.getBlockHash(blockHeight), `chain.getBlockHash(${blockHeight})`)
        )
      );
      const eventsByBlock = (await Promise.all(
        blockHashes.map((hash, index) =>
          withTimeout((this.api!.query as any).system.events.at(hash), `system.events.at(${blocks[index]})`)
        )
      )) as EventRecord[][];
      const burnBlockIndexes = eventsByBlock.flatMap((events, index) =>
        events.some((event) => getXorBurnEvent(event, this.assetInfos)) ? [index] : []
      );
      const signedBlocksByIndex = new Map<number, unknown>();

      if (burnBlockIndexes.length) {
        const signedBlocks = await Promise.all(
          burnBlockIndexes.map((index) =>
            withTimeout(this.api!.rpc.chain.getBlock(blockHashes[index]), `chain.getBlock(${blocks[index]})`)
          )
        );
        burnBlockIndexes.forEach((index, resultIndex) => {
          signedBlocksByIndex.set(index, signedBlocks[resultIndex]);
        });
      }

      const documents = burnBlockIndexes.flatMap((index) => {
        const signedBlock = signedBlocksByIndex.get(index);
        if (!signedBlock) return [];

        return createXorBurnDocumentsFromEvents(blocks[index], null, signedBlock as any, eventsByBlock[index] ?? [], this.assetInfos);
      });

      documents.push(this.createXorBurnBackfillStateDocument(batchEnd));
      await this.repository.upsertMany(documents);
      console.info(`Backfilled XOR burns through SORA block ${batchEnd}/${finalizedBlock}`);
    }
  }

  private async backfillBridgeProxyHistory(finalizedBlock: number): Promise<void> {
    if (!this.api) return;

    const lastBackfilled = await this.getBridgeProxyHistoryBackfillBlock();
    const startBlock = Math.max(this.bridgeProxyHistoryBackfillStartBlock(), lastBackfilled + 1);

    if (startBlock > finalizedBlock) return;

    for (let block = startBlock; block <= finalizedBlock; block += BRIDGE_PROXY_HISTORY_BACKFILL_BATCH_SIZE) {
      await this.drainFinalizedHeads();

      const batchEnd = Math.min(block + BRIDGE_PROXY_HISTORY_BACKFILL_BATCH_SIZE - 1, finalizedBlock);
      const blocks = Array.from({ length: batchEnd - block + 1 }, (_item, index) => block + index);
      const blockHashes = await mapWithConcurrency(
        blocks,
        BRIDGE_PROXY_HISTORY_BACKFILL_RPC_CONCURRENCY,
        (blockHeight) => withTimeout(this.api!.rpc.chain.getBlockHash(blockHeight), `chain.getBlockHash(${blockHeight})`)
      );
      let scanBlockIndexes = blocks.map((_blockHeight, index) => index);

      if (!this.bridgeProxyHistoryRuntimeAvailable) {
        const batchEndHasBridgeRuntime = await this.hasBridgeProxyHistoryRuntime(
          blockHashes[blockHashes.length - 1]?.toString() ?? '',
          batchEnd
        );

        if (!batchEndHasBridgeRuntime) {
          await this.repository.upsert(this.createBridgeProxyHistoryBackfillStateDocument(batchEnd));
          console.info(`Backfilled bridgeProxy history through SORA block ${batchEnd}/${finalizedBlock}`);
          continue;
        }

        const runtimeAvailability = await mapWithConcurrency(
          blockHashes,
          BRIDGE_PROXY_HISTORY_BACKFILL_RPC_CONCURRENCY,
          (hash, index) => this.hasBridgeProxyHistoryRuntime(hash.toString(), blocks[index])
        );
        scanBlockIndexes = runtimeAvailability.flatMap((available, index) => (available ? [index] : []));
        this.bridgeProxyHistoryRuntimeAvailable = scanBlockIndexes.length > 0;
      }

      const signedBlocks = (await mapWithConcurrency(
        scanBlockIndexes,
        BRIDGE_PROXY_HISTORY_BACKFILL_RPC_CONCURRENCY,
        (index) => withTimeout(this.api!.rpc.chain.getBlock(blockHashes[index]), `chain.getBlock(${blocks[index]})`)
      )) as SignedBlockLike[];
      const bridgeBlockIndexes = signedBlocks.flatMap((signedBlock, resultIndex) =>
        this.hasBridgeProxyHistoryExtrinsics(signedBlock) ? [scanBlockIndexes[resultIndex]] : []
      );
      const signedBlocksByIndex = new Map<number, SignedBlockLike>(
        scanBlockIndexes.map((blockIndex, resultIndex) => [blockIndex, signedBlocks[resultIndex]])
      );
      const batchDocuments: IndexerDocument[] = [];
      const accountTransactionDocuments: IndexerDocument[] = [];
      const historyElementIds: string[] = [];

      if (bridgeBlockIndexes.length) {
        const bridgeBlocks = await mapWithConcurrency(
          bridgeBlockIndexes,
          BRIDGE_PROXY_HISTORY_BACKFILL_RPC_CONCURRENCY,
          async (index) => {
            const hash = blockHashes[index]?.toString();
            if (!hash) throw new Error(`Missing block hash for bridgeProxy history backfill block ${blocks[index]}`);

            const [events, timestamp] = await Promise.all([
              this.fetchHistoricalSystemEvents(hash, blocks[index]),
              this.fetchHistoricalBlockTimestamp(hash, blocks[index]),
            ]);

            return {
              signedBlock: signedBlocksByIndex.get(index) as SignedBlockLike,
              events,
              timestamp,
            };
          }
        );

        for (const { signedBlock, events, timestamp } of bridgeBlocks) {
          const { blockHeight, blockHash, contexts } = this.createBridgeProxyHistoryContexts(signedBlock, events);

          for (const context of contexts) {
            historyElementIds.push(context.id);
            batchDocuments.push(this.createHistoryElementDocument(context, blockHeight, timestamp, blockHash));
            accountTransactionDocuments.push(...this.createAccountTransactionDocuments(context, blockHeight, timestamp));
          }
        }
      }

      await this.repository.upsertMany(batchDocuments);
      await this.upsertAndPruneAccountTransactionDocuments(historyElementIds, accountTransactionDocuments);
      await this.repository.upsert(this.createBridgeProxyHistoryBackfillStateDocument(batchEnd));
      console.info(`Backfilled bridgeProxy history through SORA block ${batchEnd}/${finalizedBlock}`);
    }
  }

  private async hasBridgeProxyHistoryRuntime(hash: string, blockHeight: number): Promise<boolean> {
    if (!this.api) throw new Error('Cannot inspect historical metadata before the chain API is initialized');
    if (!hash) throw new Error(`Missing block hash for historical metadata at SORA block ${blockHeight}`);

    const getMetadata = (this.api.rpc as unknown as { state?: { getMetadata?: (hash: string) => Promise<unknown> } }).state?.getMetadata;
    if (typeof getMetadata !== 'function') {
      throw new Error('state.getMetadata is required to find the bridgeProxy history start');
    }

    const metadata = await withTimeout(getMetadata.call((this.api.rpc as any).state, hash), `state.getMetadata(${blockHeight})`);
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
    if (!this.api) return false;

    const finalizedHash = await withTimeout(this.api.rpc.chain.getFinalizedHead(), 'chain.getFinalizedHead()');
    const finalizedHeader = await withTimeout(this.api.rpc.chain.getHeader(finalizedHash), `chain.getHeader(${finalizedHash.toString()})`);
    const finalizedBlock = finalizedHeader.number.toNumber();
    const lastIndexed = await this.getLastIndexedBlock();
    const startBlock = Math.max(this.config.chainStartBlock, lastIndexed + 1);
    let indexedAny = false;

    for (let block = startBlock; block <= finalizedBlock; block += 1) {
      await this.indexBlockByNumber(block, { refreshDerivedState: false });
      indexedAny = true;

      if (block % this.config.chainBatchSize === 0) {
        console.info(`Indexed SORA block ${block}/${finalizedBlock}`);
      }
    }

    if (indexedAny) {
      await this.backfillNetworkAggregateSnapshots();
    }

    return indexedAny;
  }

  /**
   * Builds historical aggregate network snapshots from stored per-block
   * snapshots. Only flow metrics are backfilled; stock metrics such as account
   * count and TVL stay owned by live storage-derived snapshots.
   */
  private async backfillNetworkAggregateSnapshots(): Promise<boolean> {
    const state = await this.repository.get(collection('updatesStreams'), NETWORK_AGGREGATE_BACKFILL_STATE_ID);
    if (state?.data?.data) return false;

    const existingAggregateSnapshotIds = new Set<string>();
    for await (const page of this.queryPages(collection('networkSnapshots'), {
      filter: { type: { notEqualTo: 'BLOCK' } },
    })) {
      page.forEach((document) => existingAggregateSnapshotIds.add(document.id));
    }

    const windows = this.createNetworkBackfillWindows();
    const documents: IndexerDocument[] = [];
    let latestBlock = 0;
    let latestTimestamp = 0;
    let processedBlocks = 0;
    let writtenDocuments = 0;
    const enqueue = async (document: IndexerDocument | null): Promise<void> => {
      if (!document || existingAggregateSnapshotIds.has(document.id)) return;

      documents.push(document);
      existingAggregateSnapshotIds.add(document.id);

      if (documents.length >= 1_000) {
        const batch = documents.splice(0, documents.length);
        await this.repository.upsertMany(batch);
        writtenDocuments += batch.length;
      }
    };

    for await (const page of this.queryPages(collection('networkSnapshots'), {
      filter: { type: { equalTo: 'BLOCK' } },
      orderBy: ['BLOCK_HEIGHT_ASC'],
    })) {
      for (const document of page) {
        const block = this.networkBackfillBlockFromSnapshot(document);
        if (!block) continue;

        processedBlocks++;
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

    if (documents.length) {
      const batch = documents.splice(0, documents.length);
      await this.repository.upsertMany(batch);
      writtenDocuments += batch.length;
    }

    await this.repository.upsert(this.createNetworkAggregateBackfillStateDocument(latestBlock, latestTimestamp));
    console.info(`Backfilled ${writtenDocuments} aggregate network snapshots through SORA block ${latestBlock}`);
    return true;
  }

  private async subscribeFinalizedHeads(): Promise<void> {
    if (!this.api) return;

    await this.api.rpc.chain.subscribeFinalizedHeads((header) => {
      this.pendingFinalizedBlock = Math.max(this.pendingFinalizedBlock, header.number.toNumber());
      void this.drainFinalizedHeads();
    });

    this.startFinalizedHeadPolling();
    await this.updatePendingFinalizedBlockFromRpc();
  }

  private async updatePendingFinalizedBlockFromRpc(): Promise<void> {
    if (!this.api) return;

    const finalizedHash = await withTimeout(this.api.rpc.chain.getFinalizedHead(), 'chain.getFinalizedHead()');
    const finalizedHeader = await withTimeout(this.api.rpc.chain.getHeader(finalizedHash), `chain.getHeader(${finalizedHash.toString()})`);
    this.pendingFinalizedBlock = Math.max(this.pendingFinalizedBlock, finalizedHeader.number.toNumber());
    await this.drainFinalizedHeads();
  }

  private startFinalizedHeadPolling(): void {
    if (this.finalizedHeadPollTimer) return;

    this.finalizedHeadPollTimer = setInterval(() => {
      if (this.finalizedHeadPollRunning) return;

      this.finalizedHeadPollRunning = true;
      this.updatePendingFinalizedBlockFromRpc()
        .catch((error: unknown) => {
          console.error('Failed to poll finalized head', error);
        })
        .finally(() => {
          this.finalizedHeadPollRunning = false;
        });
    }, FINALIZED_HEAD_POLL_INTERVAL_MS);
  }

  private scheduleFinalizedHeadRetry(): void {
    if (this.finalizedHeadRetryTimer) return;

    this.finalizedHeadRetryTimer = setTimeout(() => {
      this.finalizedHeadRetryTimer = null;
      void this.drainFinalizedHeads();
    }, FINALIZED_HEAD_RETRY_DELAY_MS);
  }

  private async drainFinalizedHeads(): Promise<void> {
    if (!this.api || this.finalizedHeadDrainRunning) return;

    this.finalizedHeadDrainRunning = true;

    try {
      let nextBlock = (await this.getLastIndexedBlock()) + 1;

      while (nextBlock <= this.pendingFinalizedBlock) {
        try {
          await this.indexBlockByNumber(nextBlock);
          nextBlock += 1;
        } catch (error) {
          console.error(`Failed to index finalized block ${nextBlock}`, error);
          this.scheduleFinalizedHeadRetry();
          return;
        }
      }

      if (this.finalizedHeadRetryTimer) {
        clearTimeout(this.finalizedHeadRetryTimer);
        this.finalizedHeadRetryTimer = null;
      }
    } catch (error) {
      console.error('Failed to drain finalized blocks', error);
      this.scheduleFinalizedHeadRetry();
    } finally {
      this.finalizedHeadDrainRunning = false;
    }
  }

  private async indexBlockByNumber(block: number, options: IndexBlockOptions = {}): Promise<void> {
    if (!this.api) return;

    const hash = await withTimeout(this.api.rpc.chain.getBlockHash(block), `chain.getBlockHash(${block})`);
    await this.indexBlockByHash(hash.toString(), options);
  }

  private async indexBlockByHash(hash: string, options: IndexBlockOptions = {}): Promise<void> {
    if (!this.api) return;

    const [signedBlock, eventsCodec, timestamp] = await Promise.all([
      withTimeout(this.api.rpc.chain.getBlock(hash), `chain.getBlock(${hash})`),
      withTimeout((this.api.query as any).system.events.at(hash), `system.events.at(${hash})`),
      withTimeout(this.fetchBlockTimestamp(hash), `timestamp.now.at(${hash})`),
    ]);
    const events = eventsCodec as unknown as EventRecord[];
    const eventsByExtrinsic = groupEventsByExtrinsic(events);
    const blockHeight = signedBlock.block.header.number.toNumber();
    const blockHash = signedBlock.block.header.hash.toString();
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
      const args = codecArgs(extrinsic.method as any);
      const calls = getUtilityCalls(extrinsic as any);
      const callNames = calls.map((call) => `${call.module}.${call.method}`);
      const address = getSigner(extrinsic as any);
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

      const incomingContext = createBridgeProxyIncomingContext(context, args, this.prices, this.assetInfos);
      if (incomingContext) {
        volumeUSD += this.extractVolumeUSD(incomingContext.history.data);
        bridgeIncomingTransactions += 1;
        incomingContext.accounts.forEach((account) => touchedAccounts.add(account));
        extrinsicContexts.push(incomingContext);
      }
    }

    const existingAccountMeta = await this.repository.getMany(collection('accountMeta'), [...touchedAccounts]);

    for (const context of extrinsicContexts) {
      documents.push(this.createHistoryElementDocument(context, blockHeight, timestamp, blockHash));
      documents.push(...this.createAccountTransactionDocuments(context, blockHeight, timestamp));
      if (!context.failed) documents.push(...createXorBurnDocuments(context, blockHeight, timestamp, this.assetInfos));
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
        existingAccountMeta
      );
      documents.push(...this.createEventDocuments(context.events, blockHeight, timestamp, context.address));
    }

    documents.push(
      ...this.createFinalAccountDocuments([...touchedAccounts], latestHistoryByAccount, blockHeight, timestamp, accountPointData)
    );

    const newAccountCount = [...touchedAccounts].filter((account) => !existingAccountMeta.has(account)).length;

    documents.push({
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
        liquidityUSD: this.networkLiquidityStats.liquidityUSD,
        poolLiquidityUSD: this.networkLiquidityStats.poolLiquidityUSD,
        orderBookLiquidityUSD: this.networkLiquidityStats.orderBookLiquidityUSD,
        volumeUSD: scaledToString(volumeUSD, 8),
        swaps,
        activePools: this.networkLiquidityStats.activePools,
        activeOrderBooks: this.networkLiquidityStats.activeOrderBooks,
        listedAssets: this.networkLiquidityStats.listedAssets,
        bridgeIncomingTransactions,
        bridgeOutgoingTransactions,
      },
    });

    documents.push(this.createChainStateDocument(blockHeight));
    await this.repository.upsertMany(await this.prepareReferrerRewardDocuments(documents));

    if ((options.refreshDerivedState ?? true) && blockHeight % this.config.stateRefreshIntervalBlocks === 0) {
      this.requestDerivedStateRefresh(blockHeight, timestamp, blockHeight % this.config.snapshotIntervalBlocks === 0);
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
    };
  }

  private requestDerivedStateRefresh(blockHeight: number, timestamp: number, includeSnapshots: boolean): void {
    this.pendingDerivedStateRefresh = this.mergeDerivedStateRefreshRequests(this.pendingDerivedStateRefresh, {
      blockHeight,
      timestamp,
      includeSnapshots,
    });
    void this.drainDerivedStateRefreshQueue();
  }

  private scheduleDerivedStateRefreshRetry(): void {
    if (this.derivedStateRefreshRetryTimer) return;

    this.derivedStateRefreshRetryTimer = setTimeout(() => {
      this.derivedStateRefreshRetryTimer = null;
      void this.drainDerivedStateRefreshQueue();
    }, DERIVED_STATE_REFRESH_RETRY_DELAY_MS);
    this.derivedStateRefreshRetryTimer.unref?.();
  }

  private async drainDerivedStateRefreshQueue(): Promise<void> {
    if (this.derivedStateRefreshRunning) return;

    const request = this.pendingDerivedStateRefresh;
    if (!request) return;

    this.pendingDerivedStateRefresh = null;
    this.derivedStateRefreshRunning = true;

    try {
      await this.refreshDerivedState(request.blockHeight, request.timestamp, request.includeSnapshots);
      if (this.derivedStateRefreshRetryTimer) {
        clearTimeout(this.derivedStateRefreshRetryTimer);
        this.derivedStateRefreshRetryTimer = null;
      }
    } catch (error) {
      console.error(`Failed to refresh derived state at SORA block ${request.blockHeight}`, error);
      this.pendingDerivedStateRefresh = this.mergeDerivedStateRefreshRequests(request, this.pendingDerivedStateRefresh);
      this.scheduleDerivedStateRefreshRetry();
    } finally {
      this.derivedStateRefreshRunning = false;
    }

    if (this.pendingDerivedStateRefresh && !this.derivedStateRefreshRetryTimer) {
      void this.drainDerivedStateRefreshQueue();
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
   * Native XOR issuance is still exposed in the pre-redenomination scale, while asset snapshots are
   * consumed as current XOR units by Polkaswap and external supply displays.
   */
  private createSupplyByAsset(
    tokenIssuances: Array<[StorageEntryKey, unknown]>,
    nativeXorIssuance: unknown
  ): Map<string, bigint> {
    const supplyByAsset = new Map<string, bigint>();

    for (const [key, value] of tokenIssuances) {
      supplyByAsset.set(assetIdToString(key.args[0]), codecToBigInt(value));
    }

    supplyByAsset.set(XOR, codecToBigInt(nativeXorIssuance) / XOR_SUPPLY_REDENOMINATION_FACTOR);
    return supplyByAsset;
  }

  private async fetchNativeXorIssuance(): Promise<unknown> {
    if (!this.api) throw new Error('Cannot refresh native XOR supply before the chain API is initialized');

    const balances = (this.api.query as any).balances;
    if (typeof balances?.totalIssuance !== 'function') {
      throw new Error('balances.totalIssuance is required to refresh native XOR supply');
    }

    return balances.totalIssuance.call(balances);
  }

  private async fetchStorageEntries(
    storage: unknown,
    label: string,
    ...args: unknown[]
  ): Promise<Array<[StorageEntryKey, unknown]>> {
    const entries = (storage as { entries?: (...args: unknown[]) => Promise<Array<[StorageEntryKey, unknown]>> } | undefined)
      ?.entries;

    if (typeof entries !== 'function') {
      throw new Error(`${label}.entries is required to refresh derived state`);
    }

    return entries.apply(storage, args);
  }

  private async fetchOptionalStorageEntries(
    storage: unknown,
    _label: string,
    ...args: unknown[]
  ): Promise<Array<[StorageEntryKey, unknown]>> {
    const entries = (storage as { entries?: (...args: unknown[]) => Promise<Array<[StorageEntryKey, unknown]>> } | undefined)
      ?.entries;

    if (typeof entries !== 'function') return [];

    return entries.apply(storage, args);
  }

  private async fetchApiAt(hash: string, label: string): Promise<{ query: unknown }> {
    if (!this.api) throw new Error(`Cannot fetch historical chain state for ${label} before the chain API is initialized`);

    const at = (this.api as unknown as { at?: (hash: string) => Promise<{ query: unknown }> }).at;
    if (typeof at !== 'function') {
      throw new Error('api.at is required to decode historical chain state');
    }

    return withTimeout(at.call(this.api, hash), `api.at(${label})`);
  }

  private async fetchHistoricalSystemEvents(hash: string, blockHeight: number): Promise<EventRecord[]> {
    const apiAt = await this.fetchApiAt(hash, `SORA block ${blockHeight}`);
    const system = (apiAt.query as { system?: { events?: () => Promise<unknown> } }).system;
    if (typeof system?.events !== 'function') {
      throw new Error(`system.events is required to decode historical SORA block ${blockHeight}`);
    }

    return (await withTimeout(system.events.call(system), `system.events(${blockHeight})`)) as EventRecord[];
  }

  private async fetchHistoricalBlockTimestamp(hash: string, blockHeight: number): Promise<number> {
    const apiAt = await this.fetchApiAt(hash, `SORA block ${blockHeight}`);
    const timestampNow = (apiAt.query as { timestamp?: { now?: () => Promise<unknown> } }).timestamp?.now;
    if (typeof timestampNow !== 'function') {
      throw new Error(`timestamp.now is required to index historical SORA block ${blockHeight}`);
    }

    const codec = await withTimeout(timestampNow(), `timestamp.now(${blockHeight})`);
    const timestampMs = Number((codec as CodecLike | undefined)?.toString?.() ?? codec);
    if (!Number.isFinite(timestampMs)) {
      throw new Error(`Invalid timestamp.now value for historical SORA block ${blockHeight}`);
    }

    return Math.floor(timestampMs / 1000);
  }

  private async fetchBlockTimestamp(hash: string): Promise<number> {
    if (!this.api) throw new Error('Cannot index a block before the chain API is initialized');

    const timestampNow = (this.api.query as any).timestamp?.now;
    const at = timestampNow?.at;
    if (typeof at !== 'function') {
      throw new Error('timestamp.now.at is required to index block timestamps');
    }

    const codec = await at.call(timestampNow, hash);
    const timestampMs = Number(codec?.toString?.() ?? codec);
    if (!Number.isFinite(timestampMs)) {
      throw new Error(`Invalid timestamp.now value for block ${hash}`);
    }

    return Math.floor(timestampMs / 1000);
  }

  private extractVolumeUSD(data: unknown): bigint {
    if (!data || typeof data !== 'object') return 0n;

    let max = 0n;

    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (key.endsWith('AmountUSD') || key === 'amountUSD' || key === 'volumeUSD') {
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
   */
  private createAccountTransactionDocuments(
    context: Pick<BlockExtrinsicContext, 'id' | 'accounts'>,
    blockHeight: number,
    timestamp: number
  ): IndexerDocument[] {
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
          blockHeight,
          timestamp,
        },
      };
    });
  }

  /**
   * Reconstructs per-account transaction rows from legacy history documents.
   * Only indexer-owned account fields are considered; hex external recipients
   * and asset identifiers are filtered by `normalizeIndexedAccountId`.
   */
  private createAccountTransactionDocumentsFromHistory(document: IndexerDocument): IndexerDocument[] {
    const historyElementId = String(document.data.id ?? document.id);
    const blockHeight = Number(document.blockHeight ?? document.data.blockHeight ?? 0);
    const timestamp = Number(document.timestamp ?? document.data.timestamp ?? 0);
    const accounts = uniqueIndexedAccountIds([document.data.address, document.data.dataFrom, document.data.dataTo]);

    return accounts.map((account) => {
      const id = accountTransactionId(historyElementId, account);

      return {
        collection: collection('accountTransactions'),
        id,
        blockHeight: Number.isFinite(blockHeight) ? blockHeight : 0,
        timestamp: Number.isFinite(timestamp) ? timestamp : 0,
        data: {
          id,
          accountId: normalizeIndexedAccountId(account),
          historyElementId,
          blockHeight: Number.isFinite(blockHeight) ? blockHeight : 0,
          timestamp: Number.isFinite(timestamp) ? timestamp : 0,
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
    existingAccountMeta: Map<string, IndexerDocument>
  ): void {
    for (const account of accounts) {
      const existing = pendingPointData.get(account) ?? existingAccountMeta.get(account)?.data;
      const data = this.applyAccountPointUpdate(existing ?? emptyPointData(account, blockHeight, timestamp), update);
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
    update?: AccountPointUpdate
  ): Record<string, unknown> {
    const data = this.clonePointData(current);
    if (!update) return data;

    if (update.fee > 0n) {
      this.addPointVolume(data, 'xorFees', codecToDecimalString(update.fee), codecUsd(XOR, update.fee, this.prices));
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

  private createEventDocuments(events: EventRecord[], blockHeight: number, timestamp: number, signer: string): IndexerDocument[] {
    const documents: IndexerDocument[] = [];

    for (const { event } of events) {
      if (event.section === 'orderBook' && event.method.includes('LimitOrder')) {
        const data = eventData(event);
        documents.push(...this.createOrderBookEventDocuments(event.method, data, blockHeight, timestamp, signer));
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
    signer: string
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
        this.prices,
        this.assetInfos
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

  private async refreshIndexingState(): Promise<void> {
    if (!this.api) throw new Error('Cannot refresh indexing state before the chain API is initialized');

    const [
      assetInfos,
      tokenIssuances,
      poolProperties,
      poolReserves,
      poolIssuances,
      orderBookLimitOrders,
      nativeXorIssuance,
    ] = await Promise.all([
      this.fetchStorageEntries((this.api.query as any).assets.assetInfosV2, 'assets.assetInfosV2'),
      this.fetchStorageEntries((this.api.query as any).tokens.totalIssuance, 'tokens.totalIssuance'),
      this.fetchStorageEntries((this.api.query as any).poolXYK.properties, 'poolXYK.properties'),
      this.fetchStorageEntries((this.api.query as any).poolXYK.reserves, 'poolXYK.reserves'),
      this.fetchStorageEntries((this.api.query as any).poolXYK.totalIssuances, 'poolXYK.totalIssuances'),
      this.fetchStorageEntries((this.api.query as any).orderBook.limitOrders, 'orderBook.limitOrders'),
      this.fetchNativeXorIssuance(),
    ]);
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
    this.assetInfos = assets;

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
    this.prices = prices;

    const poolStates: PoolState[] = poolsRaw.map((pool) => {
      const id = `${pool.baseAssetId}-${pool.targetAssetId}`;
      const poolAccount = poolAccounts.get(id) ?? '';
      const baseLiquidity = scaledMul(
        scaledDiv(pool.baseAssetReserves, 10n ** BigInt(assets.get(pool.baseAssetId)?.decimals ?? DECIMALS)),
        prices.get(pool.baseAssetId) ?? 0n
      );
      const targetLiquidity = scaledMul(
        scaledDiv(pool.targetAssetReserves, 10n ** BigInt(assets.get(pool.targetAssetId)?.decimals ?? DECIMALS)),
        prices.get(pool.targetAssetId) ?? 0n
      );
      const liquidity = baseLiquidity + targetLiquidity;

      return {
        id,
        ...pool,
        poolAccount,
        poolTokenSupply: issuanceByPoolAccount.get(poolAccount) ?? 0n,
        liquidityUSD: scaledToString(liquidity, 8),
        priceUSD: scaledToString(prices.get(pool.targetAssetId) ?? 0n, 8),
      };
    });
    const poolLiquidityUSD = scaledToString(
      poolStates.reduce((sum, pool) => sum + decimalStringToScaled(pool.liquidityUSD), 0n),
      8
    );
    const activePools = poolStates.filter((pool) => decimalStringToScaled(pool.liquidityUSD) > 0n).length;
    const analytics = emptyAnalytics();

    this.mergeLimitOrderStorage(orderBookLimitOrders, assets, prices, analytics);
    const orderBookLiquidityUSD = scaledToString(
      [...analytics.orderBookActiveReserves.values()].reduce((sum, reserves) => sum + reserves.liquidityUSD, 0n),
      8
    );
    const activeOrderBooks = [...analytics.orderBookActiveReserves.values()].filter((reserves) => reserves.liquidityUSD > 0n).length;
    this.networkLiquidityStats = createNetworkLiquidityStats(poolLiquidityUSD, orderBookLiquidityUSD, activePools, activeOrderBooks, assets.size);
  }

  private async refreshDerivedState(blockHeight: number, timestamp: number, includeSnapshots: boolean): Promise<void> {
    if (!this.api) throw new Error('Cannot refresh derived state before the chain API is initialized');

    const auxiliaryStoragePromise = Promise.all([
      this.fetchStorageEntries((this.api.query as any).poolXYK.poolProviders, 'poolXYK.poolProviders'),
      this.fetchStorageEntries((this.api.query as any).staking.nominators, 'staking.nominators'),
      this.fetchStorageEntries((this.api.query as any).referrals.referrers, 'referrals.referrers'),
      this.fetchStorageEntries((this.api.query as any).kensetsu.cdpDepository, 'kensetsu.cdpDepository'),
    ]);
    const [
      assetInfos,
      tokenIssuances,
      poolProperties,
      poolReserves,
      poolIssuances,
      orderBooks,
      orderBookBids,
      orderBookAsks,
      orderBookLimitOrders,
      polkamarktConditions,
      polkamarktMarkets,
      polkamarktPools,
      polkamarktVolumes,
      polkamarktTotals,
      polkamarktResolutions,
      farmingPoolFarmers,
      nativeXorIssuance,
    ] = await Promise.all([
      this.fetchStorageEntries((this.api.query as any).assets.assetInfosV2, 'assets.assetInfosV2'),
      this.fetchStorageEntries((this.api.query as any).tokens.totalIssuance, 'tokens.totalIssuance'),
      this.fetchStorageEntries((this.api.query as any).poolXYK.properties, 'poolXYK.properties'),
      this.fetchStorageEntries((this.api.query as any).poolXYK.reserves, 'poolXYK.reserves'),
      this.fetchStorageEntries((this.api.query as any).poolXYK.totalIssuances, 'poolXYK.totalIssuances'),
      this.fetchStorageEntries((this.api.query as any).orderBook.orderBooks, 'orderBook.orderBooks'),
      this.fetchStorageEntries((this.api.query as any).orderBook.bids, 'orderBook.bids'),
      this.fetchStorageEntries((this.api.query as any).orderBook.asks, 'orderBook.asks'),
      this.fetchStorageEntries((this.api.query as any).orderBook.limitOrders, 'orderBook.limitOrders'),
      this.fetchOptionalStorageEntries((this.api.query as any).polkamarkt?.conditions, 'polkamarkt.conditions'),
      this.fetchOptionalStorageEntries((this.api.query as any).polkamarkt?.markets, 'polkamarkt.markets'),
      this.fetchOptionalStorageEntries((this.api.query as any).polkamarkt?.marketPools, 'polkamarkt.marketPools'),
      this.fetchOptionalStorageEntries((this.api.query as any).polkamarkt?.marketVolume, 'polkamarkt.marketVolume'),
      this.fetchOptionalStorageEntries((this.api.query as any).polkamarkt?.marketPositionTotals, 'polkamarkt.marketPositionTotals'),
      this.fetchOptionalStorageEntries((this.api.query as any).polkamarkt?.marketResolution, 'polkamarkt.marketResolution'),
      this.fetchStorageEntries((this.api.query as any).farming.poolFarmers, 'farming.poolFarmers'),
      this.fetchNativeXorIssuance(),
    ]);
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
    this.assetInfos = assets;

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
    this.prices = prices;

    const poolStates: PoolState[] = poolsRaw.map((pool) => {
      const id = `${pool.baseAssetId}-${pool.targetAssetId}`;
      const poolAccount = poolAccounts.get(id) ?? '';
      const baseLiquidity = scaledMul(scaledDiv(pool.baseAssetReserves, 10n ** BigInt(assets.get(pool.baseAssetId)?.decimals ?? DECIMALS)), prices.get(pool.baseAssetId) ?? 0n);
      const targetLiquidity = scaledMul(
        scaledDiv(pool.targetAssetReserves, 10n ** BigInt(assets.get(pool.targetAssetId)?.decimals ?? DECIMALS)),
        prices.get(pool.targetAssetId) ?? 0n
      );
      const liquidity = baseLiquidity + targetLiquidity;
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

    const poolLiquidityUSD = scaledToString(
      poolStates.reduce((sum, pool) => sum + decimalStringToScaled(pool.liquidityUSD), 0n),
      8
    );
    const activePools = poolStates.filter((pool) => decimalStringToScaled(pool.liquidityUSD) > 0n).length;
    const provisionalLiquidityStats = createNetworkLiquidityStats(poolLiquidityUSD, '0', activePools, 0, assets.size);
    const analytics = await this.buildAnalytics(
      timestamp,
      assets,
      prices,
      poolStates,
      provisionalLiquidityStats
    );
    this.mergeLimitOrderStorage(orderBookLimitOrders, assets, prices, analytics);
    const orderBookLiquidityUSD = scaledToString(
      [...analytics.orderBookActiveReserves.values()].reduce((sum, reserves) => sum + reserves.liquidityUSD, 0n),
      8
    );
    const activeOrderBooks = [...analytics.orderBookActiveReserves.values()].filter((reserves) => reserves.liquidityUSD > 0n).length;
    const liquidityStats = createNetworkLiquidityStats(poolLiquidityUSD, orderBookLiquidityUSD, activePools, activeOrderBooks, assets.size);
    this.networkLiquidityStats = liquidityStats;
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
      polkamarktMarkets,
      polkamarktPools,
      polkamarktVolumes,
      polkamarktTotals,
      polkamarktResolutions,
      assets,
      effectiveBlockHeight,
      timestamp
    );
    const marketDocuments: IndexerDocument[] = [
      ...assetDocuments,
      ...poolDocuments,
      ...orderBookDocuments,
      ...polkamarktMarketDocuments,
      ...this.createNetworkSnapshotDocuments(analytics, effectiveBlockHeight, timestamp, includeSnapshots),
      ...this.createUpdateStreams(poolStates, assets, prices, apyByPool, effectiveBlockHeight, timestamp),
    ];

    await this.repository.upsertMany(marketDocuments);

    const [poolProviders, nominators, referrers, cdpEntries] = await auxiliaryStoragePromise;
    const [vaultDocuments, stakingValidatorDocuments] = await Promise.all([
      this.createVaultDocuments(cdpEntries, effectiveBlockHeight, timestamp),
      this.createStakingValidatorDocuments(effectiveBlockHeight, timestamp, prices, assets),
    ]);
    const auxiliaryDocuments: IndexerDocument[] = [
      ...this.createStakingDocuments(nominators, effectiveBlockHeight, timestamp),
      ...stakingValidatorDocuments,
      this.createStakingValidatorsStream(stakingValidatorDocuments, effectiveBlockHeight, timestamp),
      ...this.createReferralDocuments(referrers, effectiveBlockHeight, timestamp),
      ...vaultDocuments,
      ...this.createAccountLiquidityDocuments(poolProviders, poolStates, assets, prices, effectiveBlockHeight, timestamp),
    ];

    await this.repository.upsertMany(await this.prepareReferrerRewardDocuments(auxiliaryDocuments));
  }

  private derivePrices(
    assets: Map<string, AssetInfo>,
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

  private async *queryPages(
    collectionName: IndexerCollection,
    args: RepositoryQueryArgs = {}
  ): AsyncGenerator<IndexerDocument[], void, unknown> {
    if (!this.repository.query) {
      yield await this.repository.list(collectionName);
      return;
    }

    const pageSize = 1_000;
    const firstOrder = Array.isArray(args.orderBy) ? args.orderBy[0] : args.orderBy;
    const normalizedOrder = String(firstOrder ?? '').toUpperCase();
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

    while (true) {
      const page = await this.repository.query(collectionName, {
        ...args,
        first: pageSize,
        offset: useSeek ? null : offset,
        includeTotalCount: false,
        seek,
      });
      if (page.items.length) yield page.items;

      if (page.items.length < pageSize) break;

      if (useSeek) {
        const last = page.items[page.items.length - 1];
        const seekValue = Number(
          seekField === 'timestamp' ? last?.timestamp ?? last?.data.timestamp : last?.blockHeight ?? last?.data.blockHeight
        );
        if (!last || !Number.isFinite(seekValue)) break;

        seek = { field: seekField, value: seekValue, id: last.id, direction: 'asc' };
      } else {
        offset += pageSize;
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

  private async buildAnalytics(
    timestamp: number,
    assets: Map<string, AssetInfo>,
    prices: Map<string, bigint>,
    pools: PoolState[],
    liquidityStats: NetworkLiquidityStats
  ): Promise<Analytics> {
    const analytics = emptyAnalytics();
    const since = timestamp - SNAPSHOT_WINDOW_SECONDS.MONTH;
    const [history, blockSnapshots, orderBookOrders, assetDaySnapshots, orderBookDaySnapshots, accountMetaDocuments] =
      await Promise.all([
        this.queryAll(collection('historyElements'), {
          filter: { timestamp: { greaterThanOrEqualTo: since } },
          orderBy: ['TIMESTAMP_ASC'],
        }),
        this.queryAll(collection('networkSnapshots'), {
          filter: { and: [{ type: { equalTo: 'BLOCK' } }, { timestamp: { greaterThanOrEqualTo: since } }] },
          orderBy: ['TIMESTAMP_ASC'],
        }),
        this.queryAll(collection('orderBookOrders'), {
          filter: { timestamp: { greaterThanOrEqualTo: since } },
          orderBy: ['TIMESTAMP_ASC'],
        }),
        this.queryAll(collection('assetSnapshots'), {
          filter: { and: [{ type: { equalTo: 'DAY' } }, { timestamp: { greaterThanOrEqualTo: timestamp - 7 * 86_400 } }] },
          orderBy: ['TIMESTAMP_ASC'],
        }),
        this.queryAll(collection('orderBookSnapshots'), {
          filter: { and: [{ type: { equalTo: 'DAY' } }, { timestamp: { greaterThanOrEqualTo: timestamp - 86_400 } }] },
          orderBy: ['TIMESTAMP_ASC'],
        }),
        this.queryAll(collection('accountMeta'), {
          filter: { createdAtTimestamp: { greaterThanOrEqualTo: since } },
          orderBy: ['TIMESTAMP_ASC'],
        }),
      ]);
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

    for (const document of blockSnapshots) {
      const eventTimestamp = Number(document.data.timestamp ?? document.timestamp ?? 0);
      for (const type of AGGREGATE_SNAPSHOT_TYPES) {
        if (eventTimestamp < timestamp - SNAPSHOT_WINDOW_SECONDS[type]) continue;

        const current = analytics.network.get(type) ?? newNetworkAggregate(0, liquidityStats);
        current.transactions += Number(document.data.transactions ?? 0);
        current.fees += codecToBigInt(document.data.fees ?? 0);
        current.volumeUSD += decimalStringToScaled(document.data.volumeUSD ?? '0');
        current.swaps += Number(document.data.swaps ?? 0);
        current.bridgeIncomingTransactions += Number(document.data.bridgeIncomingTransactions ?? 0);
        current.bridgeOutgoingTransactions += Number(document.data.bridgeOutgoingTransactions ?? 0);
        Object.assign(current, liquidityStats);
        analytics.network.set(type, current);
      }
    }

    for (const document of accountMetaDocuments) {
      const createdAtTimestamp = Number(document.data.createdAtTimestamp ?? document.timestamp ?? 0);
      for (const type of AGGREGATE_SNAPSHOT_TYPES) {
        if (createdAtTimestamp < timestamp - SNAPSHOT_WINDOW_SECONDS[type]) continue;

        const current = analytics.network.get(type) ?? newNetworkAggregate(0, liquidityStats);
        current.accounts += 1;
        Object.assign(current, liquidityStats);
        analytics.network.set(type, current);
      }
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
          [...assets.values()].flatMap((asset) => SNAPSHOT_TYPES.map((type) => snapshotId('asset', asset.id, type, timestamp, blockHeight)))
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
          volumeDayUSD: Number(scaledToString(dayVolumeUSD, 8)),
          volumeWeekUSD: Number(scaledToString(weekVolumeUSD, 8)),
          velocity,
        },
      });

      if (includeSnapshots) {
        for (const type of SNAPSHOT_TYPES) {
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
          pools.flatMap((pool) => SNAPSHOT_TYPES.map((type) => snapshotId('pool', pool.id, type, timestamp, blockHeight)))
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
        for (const type of SNAPSHOT_TYPES) {
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

    if (typeof normalized === 'string') {
      if (/^0x[0-9a-fA-F]*$/.test(normalized) && normalized.length > 2) {
        return Buffer.from(normalized.slice(2), 'hex').toString('utf8').trim();
      }

      return normalized.trim();
    }

    if (Array.isArray(normalized)) {
      const bytes = normalized.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item >= 0 && item <= 255);
      if (bytes.length) return Buffer.from(bytes).toString('utf8').trim();
    }

    if (isRecord(normalized)) {
      for (const key of ['value', 'inner', 'raw']) {
        const decoded = this.decodeMetadataText(normalized[key]);
        if (decoded) return decoded;
      }
    }

    return '';
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

  private createPolkamarktMarketDocuments(
    conditions: Array<[StorageEntryKey, unknown]>,
    markets: Array<[StorageEntryKey, unknown]>,
    pools: Array<[StorageEntryKey, unknown]>,
    volumes: Array<[StorageEntryKey, unknown]>,
    totals: Array<[StorageEntryKey, unknown]>,
    resolutions: Array<[StorageEntryKey, unknown]>,
    assets: Map<string, AssetInfo>,
    blockHeight: number,
    timestamp: number
  ): IndexerDocument[] {
    const conditionsById = new Map<number, Record<string, unknown>>();
    const poolsByMarket = new Map<number, Record<string, unknown>>();
    const volumesByMarket = new Map<number, bigint>();
    const totalsByMarket = new Map<number, Record<string, unknown>>();
    const resolutionsByMarket = new Map<number, string>();

    for (const [key, value] of conditions) {
      const id = this.storageKeyNumber(key);
      if (id === null) continue;
      conditionsById.set(id, this.normalizedRecord(value));
    }

    for (const [key, value] of pools) {
      const id = this.storageKeyNumber(key);
      if (id === null) continue;
      poolsByMarket.set(id, this.normalizedRecord(value));
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

    return markets.flatMap(([key, value]) => {
      const marketId = this.storageKeyNumber(key);
      if (marketId === null) return [];

      const market = this.normalizedRecord(value);
      const conditionId = Number(market.conditionId ?? market.condition ?? -1);
      const condition = conditionsById.get(conditionId);
      const title = this.decodeMetadataText(condition?.question);
      if (!title) return [];

      const pool = poolsByMarket.get(marketId) ?? {};
      const totalsForMarket = totalsByMarket.get(marketId) ?? {};
      const collateralAsset = assetIdToString(market.collateralAsset);
      const decimals = assets.get(collateralAsset)?.decimals ?? DECIMALS;
      const seedLiquidity = this.safeCodecToBigInt(market.seedLiquidity);
      const collateral = this.safeCodecToBigInt(pool.collateral ?? seedLiquidity);
      const yesShares = this.safeCodecToBigInt(pool.yes ?? totalsForMarket.totalYesShares ?? seedLiquidity);
      const noShares = this.safeCodecToBigInt(pool.no ?? totalsForMarket.totalNoShares ?? seedLiquidity);
      const volume = volumesByMarket.get(marketId) ?? 0n;
      const probability =
        yesShares + noShares > 0n
          ? Number((noShares * 10_000n) / (yesShares + noShares)) / 100
          : null;
      const liquidityUSD = decimalToString(collateral, decimals, 8);
      const volumeUSD = decimalToString(volume, decimals, 8);
      const oracle = this.decodeMetadataText(condition?.oracle);
      const resolutionSource = this.decodeMetadataText(condition?.resolutionSource);
      const governance = resolutionSource ? this.parseSoraGovernanceReference(resolutionSource) : {};

      return [
        {
          collection: collection('markets'),
          id: String(marketId),
          blockHeight,
          timestamp,
          data: {
            id: String(marketId),
            marketId,
            conditionId,
            title,
            category: 'Other',
            oracle,
            resolutionSource,
            closeBlock: Number(market.closeBlock ?? 0),
            status: this.variantName(market.status),
            creator: String(market.creator ?? ''),
            collateralAsset,
            seedLiquidity: decimalToString(seedLiquidity, decimals, 8),
            liquidityUSD,
            volumeUSD,
            probability,
            priceYes: probability === null ? null : probability / 100,
            collateral: decimalToString(collateral, decimals, 8),
            yesShares: decimalToString(yesShares, decimals, 8),
            noShares: decimalToString(noShares, decimals, 8),
            resolutionOutcome: resolutionsByMarket.get(marketId) ?? null,
            ...governance,
            updatedAtBlock: blockHeight,
            timestamp,
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
          return SNAPSHOT_TYPES.map((type) => snapshotId('orderBook', idString, type, timestamp, blockHeight));
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
        for (const type of SNAPSHOT_TYPES) {
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

  private async getEraRewardPoints(era: number): Promise<{ total: number; individual: Map<string, number> }> {
    if (!this.api) throw new Error('Cannot read staking reward points before the chain API is initialized');

    const erasRewardPoints = (this.api.query as any).staking?.erasRewardPoints;
    if (typeof erasRewardPoints !== 'function') {
      throw new Error('staking.erasRewardPoints is required to refresh staking validators');
    }

    const data = await erasRewardPoints(era);
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

  private async getEraExposures(era: number): Promise<Map<string, StakingExposure>> {
    if (!this.api) throw new Error('Cannot read staking exposures before the chain API is initialized');

    const staking = (this.api.query as any).staking;
    if (
      typeof staking?.erasStakersOverview?.entries === 'function' &&
      typeof staking?.erasStakersPaged?.entries === 'function'
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

  private async readValidatorIdentity(address: string): Promise<Record<string, unknown> | null> {
    const identityOf = (this.api?.query as any)?.identity?.identityOf;
    if (typeof identityOf !== 'function') {
      throw new Error('identity.identityOf is required to refresh staking validators');
    }

    const codec = await identityOf(address);
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

  private async createStakingValidatorDocuments(
    blockHeight: number,
    timestamp: number,
    prices: Map<string, bigint>,
    assets: Map<string, AssetInfo>
  ): Promise<IndexerDocument[]> {
    if (!this.api) throw new Error('Cannot refresh staking validators before the chain API is initialized');

    const validatorsStorage = (this.api?.query as any)?.staking?.validators;
    const currentEraStorage = (this.api?.query as any)?.staking?.currentEra;
    const rewardsStorage = (this.api?.query as any)?.staking?.erasValidatorReward;

    if (typeof validatorsStorage?.entries !== 'function') {
      throw new Error('staking.validators.entries is required to refresh staking validators');
    }
    if (typeof currentEraStorage !== 'function') {
      throw new Error('staking.currentEra is required to refresh staking validators');
    }
    if (typeof rewardsStorage?.entries !== 'function') {
      throw new Error('staking.erasValidatorReward.entries is required to refresh staking validators');
    }

    const [validatorEntries, currentEraCodec, rewardEntries] = await Promise.all([
      validatorsStorage.entries(),
      currentEraStorage(),
      rewardsStorage.entries(),
    ]);
    const validators = this.formatValidatorPrefs(validatorEntries);
    if (!validators.length) return [];

    const currentEra = this.codecToNumber(currentEraCodec);
    if (currentEra === null) throw new Error('staking.currentEra returned an invalid era');

    const rewardEra = this.latestRewardEra(rewardEntries);
    if (!rewardEra) throw new Error('staking.erasValidatorReward has no completed reward era');

    const apyEra = rewardEra.era;
    const [rewardPoints, currentExposures, apyExposureEntries, identities] = await Promise.all([
      this.getEraRewardPoints(rewardEra.era),
      this.getEraExposures(currentEra),
      apyEra === currentEra ? Promise.resolve(null) : this.getEraExposures(apyEra),
      mapWithConcurrency(validators, VALIDATOR_IDENTITY_CONCURRENCY, async (validator) => [
        validator.address,
        await this.readValidatorIdentity(validator.address),
      ] as const),
    ]);
    if (!currentExposures.size) throw new Error(`staking.erasStakers(${currentEra}) returned no validator exposures`);

    const apyExposures = apyExposureEntries ?? currentExposures;
    const identityByAddress = new Map(identities);
    const maxNominatorRewarded = this.getMaxNominatorRewardedPerValidator();
    const activeValidators = validators.filter((validator) => currentExposures.has(validator.address));
    if (!activeValidators.length) {
      throw new Error(`staking.erasStakers(${currentEra}) did not match any staking.validators entries`);
    }

    return activeValidators.map((validator) => {
      const exposure = currentExposures.get(validator.address);
      const apyExposure = apyExposures.get(validator.address);
      const identity = identityByAddress.get(validator.address) ?? null;
      const validatorRewardPoints = rewardPoints.individual.get(validator.address) ?? 0;

      if (!exposure) {
        throw new Error(`staking.erasStakers(${currentEra}) is missing exposure for validator ${validator.address}`);
      }
      if (!apyExposure && validatorRewardPoints > 0) {
        throw new Error(
          `staking.erasStakers(${apyEra}) has reward points but is missing APY exposure for validator ${validator.address}`
        );
      }

      const apy = apyExposure
        ? this.calculateValidatorApy(
            apyExposure.total,
            rewardEra.reward,
            validatorRewardPoints,
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
          blockHeight: String(blockHeight),
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

  private createUpdateStreams(
    pools: PoolState[],
    assets: Map<string, AssetInfo>,
    prices: Map<string, bigint>,
    apyByPool: Map<string, string>,
    blockHeight: number,
    timestamp: number
  ): IndexerDocument[] {
    const priceData = Object.fromEntries([...assets.values()].map((asset) => [asset.id, scaledToString(prices.get(asset.id) ?? 0n, 8)]));
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
      {
        collection: collection('updatesStreams'),
        id: 'price',
        blockHeight,
        timestamp,
        data: { id: 'price', block: blockHeight, data: JSON.stringify(priceData) },
      },
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
