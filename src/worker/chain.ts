import { ApiPromise, WsProvider } from '@polkadot/api';

import type { AppConfig } from '../config.js';
import type { IndexerCollection, IndexerDocument, IndexerRepository, RepositoryQueryArgs } from '../repository/types.js';

type CodecLike = {
  toJSON?: () => unknown;
  toHuman?: () => unknown;
  toString?: () => string;
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
  accounts: number;
  transactions: number;
  fees: bigint;
  volumeUSD: bigint;
  swaps: number;
  bridgeIncomingTransactions: number;
  bridgeOutgoingTransactions: number;
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

const CHAIN_STATE_ID = 'chainState';
const XOR_BURN_BACKFILL_STATE_ID = 'xorBurnsBackfill';
const DECIMALS = 18;
const SCALE = 10n ** 18n;
const XOR = '0x0200000000000000000000000000000000000000000000000000000000000000';
const SORA_NEXUS_XOR_BURN_REMARK_TYPE = 'soraNexusXorClaim';
const SORA_XOR_BURN_START_BLOCK = 25_043_003;
const XOR_BURN_BACKFILL_BATCH_SIZE = 250;
const FINALIZED_HEAD_RETRY_DELAY_MS = 5_000;
const PSWAP = '0x0200050000000000000000000000000000000000000000000000000000000000';
const DAI = '0x0200060000000000000000000000000000000000000000000000000000000000';
const XSTUSD = '0x0200080000000000000000000000000000000000000000000000000000000000';
const KUSD = '0x02000c0000000000000000000000000000000000000000000000000000000000';
const STABLE_ASSET_IDS = new Set([DAI, XSTUSD, KUSD]);
// Keep shallow pools from becoming global price oracles and inflating Explore TVL.
const MIN_PRICE_DISCOVERY_LIQUIDITY_USD = 100n * SCALE;
const MIN_PRICE_DISCOVERY_AMOUNT = 10n ** 16n;
const SNAPSHOT_TYPES: SnapshotTypeName[] = ['DEFAULT', 'HOUR', 'DAY', 'MONTH', 'BLOCK'];
const AGGREGATE_SNAPSHOT_TYPES: SnapshotTypeName[] = SNAPSHOT_TYPES.filter((type) => type !== 'BLOCK');
const SNAPSHOT_WINDOW_SECONDS: Record<SnapshotTypeName, number> = {
  DEFAULT: 86_400,
  HOUR: 3_600,
  DAY: 86_400,
  MONTH: 30 * 86_400,
  BLOCK: 0,
};
const FARMING_PSWAP_PER_DAY = 2_500_000n * SCALE;
const DAYS_PER_YEAR = 365n;
const EVENT_DATA_CACHE = new WeakMap<EventRecord['event'], Record<string, unknown>>();

const activeAggregateSnapshotTypes = (eventTimestamp: number, timestamp: number): SnapshotTypeName[] => {
  const active: SnapshotTypeName[] = [];

  for (const type of AGGREGATE_SNAPSHOT_TYPES) {
    if (eventTimestamp >= timestamp - SNAPSHOT_WINDOW_SECONDS[type]) active.push(type);
  }

  return active;
};

const collection = <T extends IndexerDocument['collection']>(name: T): T => name;

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

const codecToDecimalString = (value: unknown, decimals = DECIMALS): string =>
  decimalToString(codecToBigInt(value), decimals, 18);

const scaledMul = (left: bigint, right: bigint): bigint => (left * right) / SCALE;
const scaledDiv = (left: bigint, right: bigint): bigint => (right === 0n ? 0n : (left * SCALE) / right);
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

const codecArgs = (method: { args?: unknown[]; meta?: { args?: Array<{ name?: string | { toString: () => string } }> } }) => {
  const args = method.args ?? [];
  const names = method.meta?.args ?? [];

  return Object.fromEntries(
    args.map((arg, index) => {
      const rawName = names[index]?.name;
      const name = normalizeKey(typeof rawName === 'string' ? rawName : rawName?.toString?.() ?? `arg${index}`);
      return [name, normalizeValue(arg)];
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
    const keys = ['EVM', 'Evm', 'evm', 'EVMLegacy', 'evmLegacy', 'Sora', 'sora', 'value', 'id', 'code'];

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

const findIncomingBridgeMovement = (events: EventRecord[]): AssetMovement | null => {
  for (const event of events) {
    const movement = assetMovementFromEvent(event);
    if (!movement?.assetId || !movement.recipient || movement.amount === undefined || movement.amount === null) continue;

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
    const baseAssetId = firstString(args, ['inputAssetId', 'baseAssetId', 'assetId']) || firstString(exchange, ['inputAssetId', 'baseAssetId']);
    const targetAssetId =
      firstString(args, ['outputAssetId', 'targetAssetId']) || firstString(exchange, ['outputAssetId', 'targetAssetId']);
    const baseAmount = args.amount ?? args.swapAmount ?? exchange.inputAmount ?? '0';
    const targetAmount = exchange.outputAmount ?? args.minOutputAmount ?? '0';
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
          ...(networkId ? { networkId } : {}),
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
        ...(networkId ? { networkId } : {}),
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
  if (base.module === 'bridgeProxy' && base.method === 'burn') return null;

  const request = bridgeRequestUpdate(base.events);
  if (!request.requestHash) return null;

  const movement = findIncomingBridgeMovement(base.events);
  if (!movement) return null;

  const message = args.message && typeof args.message === 'object' && !Array.isArray(args.message) ? (args.message as Record<string, unknown>) : args;
  const networkId = firstNestedString(args, ['networkId', 'network', 'arg0']);
  const recipient = firstNestedString(message, ['dest', 'recipient', 'to', 'account']) || movement.recipient;
  const sender = firstNestedString(message, ['source', 'sender', 'from']) || movement.sender;
  const history = {
    data: {
      ...createAmountData(movement.assetId, movement.amount, prices, assets),
      ...(networkId ? { networkId } : {}),
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
    accounts: [...new Set([recipient, sender].filter(Boolean))],
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

const emptyPriceOhlc = (price: string): PriceOhlc => ({ open: price, high: price, low: price, close: price });

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

  constructor(
    private readonly config: AppConfig,
    private readonly repository: IndexerRepository
  ) {}

  async start(): Promise<void> {
    const provider = new WsProvider(this.config.soraWsEndpoint);
    this.api = await ApiPromise.create({ provider });
    const finalizedHash = await this.api.rpc.chain.getFinalizedHead();
    const finalizedHeader = await this.api.rpc.chain.getHeader(finalizedHash);
    const finalizedBlock = finalizedHeader.number.toNumber();

    await this.refreshDerivedState(finalizedBlock, Math.floor(Date.now() / 1000), true);
    await this.backfill();
    await this.subscribeFinalizedHeads();
    void this.backfillXorBurns(finalizedBlock).catch((error: unknown) => {
      console.error('Failed to backfill XOR burn documents', error);
    });
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

  private async backfillXorBurns(finalizedBlock: number): Promise<void> {
    if (!this.api || finalizedBlock < SORA_XOR_BURN_START_BLOCK) return;

    const lastBackfilled = await this.getXorBurnBackfillBlock();
    const startBlock = Math.max(SORA_XOR_BURN_START_BLOCK, lastBackfilled + 1);

    if (startBlock > finalizedBlock) return;

    for (let block = startBlock; block <= finalizedBlock; block += XOR_BURN_BACKFILL_BATCH_SIZE) {
      const batchEnd = Math.min(block + XOR_BURN_BACKFILL_BATCH_SIZE - 1, finalizedBlock);
      const blocks = Array.from({ length: batchEnd - block + 1 }, (_item, index) => block + index);
      const blockHashes = await Promise.all(blocks.map((blockHeight) => this.api!.rpc.chain.getBlockHash(blockHeight)));
      const eventsByBlock = (await Promise.all(blockHashes.map((hash) => (this.api!.query as any).system.events.at(hash)))) as EventRecord[][];
      const burnBlockIndexes = eventsByBlock.flatMap((events, index) =>
        events.some((event) => getXorBurnEvent(event, this.assetInfos)) ? [index] : []
      );
      const signedBlocksByIndex = new Map<number, unknown>();

      if (burnBlockIndexes.length) {
        const signedBlocks = await Promise.all(burnBlockIndexes.map((index) => this.api!.rpc.chain.getBlock(blockHashes[index])));
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

  private async backfill(): Promise<void> {
    if (!this.api) return;

    const finalizedHash = await this.api.rpc.chain.getFinalizedHead();
    const finalizedHeader = await this.api.rpc.chain.getHeader(finalizedHash);
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
      await this.refreshDerivedState(finalizedBlock, Math.floor(Date.now() / 1000), true);
    }
  }

  private async subscribeFinalizedHeads(): Promise<void> {
    if (!this.api) return;

    await this.api.rpc.chain.subscribeFinalizedHeads(async (header) => {
      this.pendingFinalizedBlock = Math.max(this.pendingFinalizedBlock, header.number.toNumber());
      await this.drainFinalizedHeads();
    });
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

    const hash = await this.api.rpc.chain.getBlockHash(block);
    await this.indexBlockByHash(hash.toString(), options);
  }

  private async indexBlockByHash(hash: string, options: IndexBlockOptions = {}): Promise<void> {
    if (!this.api) return;

    const [signedBlock, eventsCodec, timestampNow] = await Promise.all([
      this.api.rpc.chain.getBlock(hash),
      (this.api.query as any).system.events.at(hash),
      (this.api.query as any).timestamp?.now.at(hash).catch(() => null),
    ]);
    const events = eventsCodec as unknown as EventRecord[];
    const eventsByExtrinsic = groupEventsByExtrinsic(events);
    const blockHeight = signedBlock.block.header.number.toNumber();
    const blockHash = signedBlock.block.header.hash.toString();
    const timestamp = timestampNow ? Math.floor(Number(timestampNow.toString()) / 1000) : Math.floor(Date.now() / 1000);
    const documents: IndexerDocument[] = [];
    const touchedAccounts = new Set<string>();
    let totalFees = 0n;
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
      const currentAccounts = [...new Set([address, history.from, history.to].filter(Boolean))];
      totalFees += fee;
      volumeUSD += this.extractVolumeUSD(history.data);
      if (
        (extrinsic.method.section === 'liquidityProxy' &&
          (extrinsic.method.method === 'swap' || extrinsic.method.method === 'swapTransfer')) ||
        callNames.some((name) => name === 'liquidityProxy.swap' || name === 'liquidityProxy.swapTransfer')
      ) {
        swaps += 1;
      }
      if (extrinsic.method.section === 'bridgeMultisig') bridgeIncomingTransactions += 1;
      if (extrinsic.method.section === 'ethBridge' || (extrinsic.method.section === 'bridgeProxy' && extrinsic.method.method === 'burn')) {
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
      documents.push({
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
          execution: context.failed
            ? { success: false, error: { moduleErrorId: 0, moduleErrorIndex: 0 } }
            : { success: true },
          data: context.history.data,
          dataFrom: context.history.from || context.address,
          dataTo: context.history.to,
          dataAssets: context.history.assets,
          callNames: context.callNames,
          calls: context.calls,
        },
      });

      documents.push(...createXorBurnDocuments(context, blockHeight, timestamp, this.assetInfos));
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
        },
        existingAccountMeta
      );
      documents.push(...this.createEventDocuments(context.events, blockHeight, timestamp, context.address));
    }

    documents.push(
      ...this.createFinalAccountDocuments([...touchedAccounts], latestHistoryByAccount, blockHeight, timestamp, accountPointData)
    );

    documents.push({
      collection: collection('networkSnapshots'),
      id: `block-${blockHeight}`,
      blockHeight,
      timestamp,
      data: {
        id: `block-${blockHeight}`,
        type: 'BLOCK',
        timestamp,
        accounts: touchedAccounts.size,
        transactions: signedBlock.block.extrinsics.length,
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
    await this.repository.upsertMany(documents);

    if ((options.refreshDerivedState ?? true) && blockHeight % this.config.stateRefreshIntervalBlocks === 0) {
      await this.refreshDerivedState(blockHeight, timestamp, blockHeight % this.config.snapshotIntervalBlocks === 0);
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
    update?: { module: string; method: string; data: unknown; fee: bigint },
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

  private applyAccountPointUpdates(
    accounts: string[],
    blockHeight: number,
    timestamp: number,
    pendingPointData: Map<string, Record<string, unknown>>,
    update: { module: string; method: string; data: unknown; fee: bigint } | undefined,
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
    update?: { module: string; method: string; data: unknown; fee: bigint }
  ): Record<string, unknown> {
    const data = this.clonePointData(current);
    if (!update) return data;

    if (update.fee > 0n) {
      this.addPointVolume(data, 'xorFees', codecToDecimalString(update.fee), codecUsd(XOR, update.fee, this.prices));
    }

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

    if (update.module.includes('democracy') || update.module.includes('referenda') || update.method.toLowerCase().includes('vote')) {
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

  private async refreshDerivedState(blockHeight: number, timestamp: number, includeSnapshots: boolean): Promise<void> {
    if (!this.api) return;

    const auxiliaryStoragePromise = Promise.all([
      (this.api.query as any).poolXYK.poolProviders.entries(),
      (this.api.query as any).staking.nominators.entries(),
      (this.api.query as any).referrals.referrers.entries(),
      (this.api.query as any).kensetsu.cdpDepository.entries(),
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
      farmingPoolFarmers,
      indexedAccountCount,
      latestHeader,
    ] = await Promise.all([
      (this.api.query as any).assets.assetInfosV2.entries(),
      (this.api.query as any).tokens.totalIssuance.entries(),
      (this.api.query as any).poolXYK.properties.entries(),
      (this.api.query as any).poolXYK.reserves.entries(),
      (this.api.query as any).poolXYK.totalIssuances.entries(),
      (this.api.query as any).orderBook.orderBooks.entries(),
      (this.api.query as any).orderBook.bids.entries().catch(() => []),
      (this.api.query as any).orderBook.asks.entries().catch(() => []),
      (this.api.query as any).orderBook.limitOrders.entries().catch(() => []),
      (this.api.query as any).farming?.poolFarmers?.entries
        ? (this.api.query as any).farming.poolFarmers.entries().catch(() => [])
        : [],
      this.countIndexedAccounts(),
      this.api.rpc.chain.getHeader().catch(() => null),
    ]);
    const effectiveBlockHeight = blockHeight || Number(latestHeader?.number?.toString?.() ?? 0);

    const supplyByAsset = new Map<string, bigint>();
    for (const [key, value] of tokenIssuances) {
      supplyByAsset.set(assetIdToString(key.args[0]), codecToBigInt(value));
    }

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
      provisionalLiquidityStats,
      indexedAccountCount
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
    const marketDocuments: IndexerDocument[] = [
      ...assetDocuments,
      ...poolDocuments,
      ...orderBookDocuments,
      ...this.createNetworkSnapshotDocuments(analytics, effectiveBlockHeight, timestamp, includeSnapshots),
      ...this.createUpdateStreams(poolStates, assets, prices, apyByPool, effectiveBlockHeight, timestamp),
    ];

    await this.repository.upsertMany(marketDocuments);

    const [poolProviders, nominators, referrers, cdpEntries] = await auxiliaryStoragePromise;
    const vaultDocuments = await this.createVaultDocuments(cdpEntries, effectiveBlockHeight, timestamp);
    const auxiliaryDocuments: IndexerDocument[] = [
      ...this.createStakingDocuments(nominators, effectiveBlockHeight, timestamp),
      ...this.createReferralDocuments(referrers, effectiveBlockHeight, timestamp),
      ...vaultDocuments,
      ...this.createAccountLiquidityDocuments(poolProviders, poolStates, assets, prices, effectiveBlockHeight, timestamp),
    ];

    await this.repository.upsertMany(auxiliaryDocuments);
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

  private async queryAll(collectionName: IndexerCollection, args: RepositoryQueryArgs = {}): Promise<IndexerDocument[]> {
    if (!this.repository.query) {
      return this.repository.list(collectionName);
    }

    const pageSize = 1_000;
    const documents: IndexerDocument[] = [];
    const firstOrder = Array.isArray(args.orderBy) ? args.orderBy[0] : args.orderBy;
    const useTimestampSeek =
      String(firstOrder ?? '').toUpperCase() === 'TIMESTAMP_ASC' &&
      args.offset === undefined &&
      args.after === undefined &&
      args.last === undefined;
    let offset = 0;
    let seek: RepositoryQueryArgs['seek'];

    while (true) {
      const page = await this.repository.query(collectionName, {
        ...args,
        first: pageSize,
        offset: useTimestampSeek ? null : offset,
        includeTotalCount: false,
        seek,
      });
      documents.push(...page.items);

      if (page.items.length < pageSize) break;

      if (useTimestampSeek) {
        const last = page.items[page.items.length - 1];
        const timestampValue = Number(last?.timestamp ?? last?.data.timestamp);
        if (!last || !Number.isFinite(timestampValue)) break;

        seek = { field: 'timestamp', value: timestampValue, id: last.id, direction: 'asc' };
      } else {
        offset += pageSize;
      }
    }

    return documents;
  }

  private async countIndexedAccounts(): Promise<number> {
    if (!this.repository.query) {
      return (await this.repository.list(collection('accounts'))).length;
    }

    const result = await this.repository.query(collection('accounts'), {
      first: 0,
      includeTotalCount: true,
    });

    return result.totalCount ?? 0;
  }

  private async buildAnalytics(
    timestamp: number,
    assets: Map<string, AssetInfo>,
    prices: Map<string, bigint>,
    pools: PoolState[],
    liquidityStats: NetworkLiquidityStats,
    chainAccountCount: number
  ): Promise<Analytics> {
    const analytics = emptyAnalytics();
    const since = timestamp - SNAPSHOT_WINDOW_SECONDS.MONTH;
    const [history, blockSnapshots, orderBookOrders, assetDaySnapshots, orderBookDaySnapshots] = await Promise.all([
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

        const current = analytics.network.get(type) ?? newNetworkAggregate(chainAccountCount, liquidityStats);
        current.transactions += Number(document.data.transactions ?? 0);
        current.fees += codecToBigInt(document.data.fees ?? 0);
        current.volumeUSD += decimalStringToScaled(document.data.volumeUSD ?? '0');
        current.swaps += Number(document.data.swaps ?? 0);
        current.bridgeIncomingTransactions += Number(document.data.bridgeIncomingTransactions ?? 0);
        current.bridgeOutgoingTransactions += Number(document.data.bridgeOutgoingTransactions ?? 0);
        current.accounts = Math.max(current.accounts, chainAccountCount);
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
        analytics.network.set(type, newNetworkAggregate(chainAccountCount, liquidityStats));
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
