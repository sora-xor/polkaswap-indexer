import { ApiPromise, WsProvider } from '@polkadot/api';

import type { AppConfig } from '../config.js';
import type { IndexerDocument, IndexerRepository } from '../repository/types.js';

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

const CHAIN_STATE_ID = 'chainState';
const DECIMALS = 18;
const SCALE = 10n ** 18n;
const BLOCKS_PER_YEAR = 5_256_000n;
const XOR = '0x0200000000000000000000000000000000000000000000000000000000000000';
const PSWAP = '0x0200050000000000000000000000000000000000000000000000000000000000';
const DAI = '0x0200060000000000000000000000000000000000000000000000000000000000';
const XSTUSD = '0x0200080000000000000000000000000000000000000000000000000000000000';
const KUSD = '0x02000c0000000000000000000000000000000000000000000000000000000000';
const STABLE_ASSET_IDS = new Set([DAI, XSTUSD, KUSD]);

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

const codecUsd = (assetId: string, amount: bigint, prices: Map<string, bigint>, decimals = DECIMALS): string => {
  const price = prices.get(assetId) ?? 0n;
  const natural = scaledDiv(amount, 10n ** BigInt(decimals));

  return scaledToString(scaledMul(natural, price), 8);
};

const reserveToNaturalScaled = (reserve: bigint, decimals = DECIMALS): bigint => scaledDiv(reserve, 10n ** BigInt(decimals));

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
  const values = event.data.toArray?.() ?? [];
  const fields = event.meta?.fields ?? [];

  return Object.fromEntries(
    values.map((value, index) => {
      const nameValue = fields[index]?.name;
      const name = nameValue?.isSome ? nameValue.unwrap?.().toString() : undefined;
      return [normalizeKey(name ?? `arg${index}`), normalizeValue(value)];
    })
  );
};

const getSigner = (extrinsic: { isSigned?: boolean; signer?: { toString: () => string } }): string => {
  return extrinsic.isSigned ? (extrinsic.signer?.toString() ?? '') : '';
};

const getUtilityCalls = (extrinsic: { method: { section: string; method: string; args?: unknown[] } }): IndexedCall[] => {
  if (extrinsic.method.section !== 'utility') return [];

  const maybeCalls = toJson(extrinsic.method.args?.[0]);
  if (!Array.isArray(maybeCalls)) return [];

  return maybeCalls.map((call) => {
    const item = call as Record<string, unknown>;
    const callName = String(item.call ?? '');
    const [module = '', method = ''] = callName.split('.');
    const args = normalizeValue(item.args) as Record<string, unknown>;

    return { module, method, data: { args } };
  });
};

const collectAssets = (value: unknown, assets = new Set<string>()): string[] => {
  if (!value) return [...assets];

  if (typeof value === 'string' && value.startsWith('0x') && value.length >= 66) {
    assets.add(value);
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectAssets(item, assets));
  } else if (typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach((item) => collectAssets(item, assets));
  }

  return [...assets];
};

const firstString = (record: Record<string, unknown>, keys: string[]): string => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
    if (value !== undefined && value !== null && typeof value !== 'object') return String(value);
  }

  return '';
};

const findEvent = (events: EventRecord[], section: string, method: string): Record<string, unknown> | null => {
  const match = events.find((item) => item.event.section === section && item.event.method === method);
  return match ? eventData(match.event) : null;
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

  const withAmount = (assetId: string, amount: unknown) => {
    const info = assets.get(assetId);
    const raw = codecToBigInt(amount);
    return {
      amount: codecToDecimalString(amount, info?.decimals ?? DECIMALS),
      amountUSD: codecUsd(assetId, raw, prices, info?.decimals ?? DECIMALS),
      assetId,
    };
  };

  if (module === 'assets' && method === 'transfer') {
    const assetId = firstString(args, ['assetId']);
    const to = firstString(args, ['to', 'dest']);
    return {
      data: { ...withAmount(assetId, args.amount), from: signer, to },
      from: signer,
      to,
      assets: [assetId],
    };
  }

  if (module === 'assets' && (method === 'burn' || method === 'mint')) {
    const assetId = firstString(args, ['assetId']);
    const to = firstString(args, ['to']);
    return {
      data: { ...withAmount(assetId, args.amount), ...(to ? { to } : {}) },
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
    const assetId = side === 'Buy' ? orderBookId.quoteAssetId : orderBookId.baseAssetId;

    return {
      data: {
        dexId: orderBookId.dexId,
        baseAssetId: orderBookId.baseAssetId,
        quoteAssetId: orderBookId.quoteAssetId,
        orderId,
        price: codecToDecimalString(args.price, DECIMALS),
        amount: codecToDecimalString(args.amount, assets.get(orderBookId.baseAssetId)?.decimals ?? DECIMALS),
        amountUSD: codecUsd(assetId, codecToBigInt(args.amount), prices, assets.get(assetId)?.decimals ?? DECIMALS),
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
    return {
      data: {
        ...withAmount(assetId, args.amount),
        sidechainAddress: firstString(args, ['to', 'sidechainAddress']),
      },
      from: signer,
      to: firstString(args, ['to', 'sidechainAddress']),
      assets: [assetId],
    };
  }

  return result;
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

const snapshotId = (prefix: string, id: string, type: string, timestamp: number): string => `${prefix}-${id}-${type}-${timestamp}`;

export class ChainIndexer {
  private api: ApiPromise | null = null;
  private assetInfos = new Map<string, AssetInfo>();
  private prices = new Map<string, bigint>();

  constructor(
    private readonly config: AppConfig,
    private readonly repository: IndexerRepository
  ) {}

  async start(): Promise<void> {
    const provider = new WsProvider(this.config.soraWsEndpoint);
    this.api = await ApiPromise.create({ provider });

    await this.refreshDerivedState(0, Math.floor(Date.now() / 1000), true);
    await this.backfill();
    await this.subscribeFinalizedHeads();
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

  private async setLastIndexedBlock(block: number): Promise<void> {
    await this.repository.upsert({
      collection: collection('updatesStreams'),
      id: CHAIN_STATE_ID,
      blockHeight: block,
      timestamp: Math.floor(Date.now() / 1000),
      data: {
        id: CHAIN_STATE_ID,
        block,
        data: JSON.stringify({ lastIndexedBlock: block }),
      },
    });
  }

  private async backfill(): Promise<void> {
    if (!this.api) return;

    const finalizedHash = await this.api.rpc.chain.getFinalizedHead();
    const finalizedHeader = await this.api.rpc.chain.getHeader(finalizedHash);
    const finalizedBlock = finalizedHeader.number.toNumber();
    const lastIndexed = await this.getLastIndexedBlock();
    const startBlock = Math.max(this.config.chainStartBlock, lastIndexed + 1);

    for (let block = startBlock; block <= finalizedBlock; block += 1) {
      await this.indexBlockByNumber(block);

      if (block % this.config.chainBatchSize === 0) {
        console.info(`Indexed SORA block ${block}/${finalizedBlock}`);
      }
    }
  }

  private async subscribeFinalizedHeads(): Promise<void> {
    if (!this.api) return;

    await this.api.rpc.chain.subscribeFinalizedHeads(async (header) => {
      try {
        await this.indexBlockByHash(header.hash.toString());
      } catch (error) {
        console.error(`Failed to index finalized block ${header.number.toString()}`, error);
      }
    });
  }

  private async indexBlockByNumber(block: number): Promise<void> {
    if (!this.api) return;

    const hash = await this.api.rpc.chain.getBlockHash(block);
    await this.indexBlockByHash(hash.toString());
  }

  private async indexBlockByHash(hash: string): Promise<void> {
    if (!this.api) return;

    const [signedBlock, eventsCodec, timestampNow] = await Promise.all([
      this.api.rpc.chain.getBlock(hash),
      (this.api.query as any).system.events.at(hash),
      (this.api.query as any).timestamp?.now.at(hash).catch(() => null),
    ]);
    const events = eventsCodec as unknown as EventRecord[];
    const blockHeight = signedBlock.block.header.number.toNumber();
    const blockHash = signedBlock.block.header.hash.toString();
    const timestamp = timestampNow ? Math.floor(Number(timestampNow.toString()) / 1000) : Math.floor(Date.now() / 1000);
    const documents: IndexerDocument[] = [];
    const touchedAccounts = new Set<string>();
    let totalFees = 0n;
    let volumeUSD = 0n;
    let bridgeIncomingTransactions = 0;
    let bridgeOutgoingTransactions = 0;

    for (const [index, extrinsic] of signedBlock.block.extrinsics.entries()) {
      const eventsForExtrinsic = events.filter(
        ({ phase }) => phase.isApplyExtrinsic && phase.asApplyExtrinsic.toNumber() === index
      );
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
      totalFees += fee;
      volumeUSD += this.extractVolumeUSD(history.data);
      if (extrinsic.method.section === 'bridgeMultisig') bridgeIncomingTransactions += 1;
      if (extrinsic.method.section === 'ethBridge') bridgeOutgoingTransactions += 1;

      documents.push({
        collection: collection('historyElements'),
        id,
        blockHeight,
        timestamp,
        data: {
          id,
          type: 'CALL',
          timestamp,
          blockHash,
          blockHeight,
          module: extrinsic.method.section,
          method: extrinsic.method.method,
          address,
          networkFee: fee.toString(),
          execution: failed
            ? { success: false, error: { moduleErrorId: 0, moduleErrorIndex: 0 } }
            : { success: true },
          data: history.data,
          dataFrom: history.from || address,
          dataTo: history.to,
          dataAssets: history.assets,
          callNames,
          calls,
        },
      });

      [address, history.from, history.to].filter(Boolean).forEach((account) => touchedAccounts.add(account));
      documents.push(...(await this.createAccountDocuments([...touchedAccounts], id, blockHeight, timestamp)));
      documents.push(...this.createEventDocuments(eventsForExtrinsic, blockHeight, timestamp, address));
    }

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
        liquidityUSD: await this.getCurrentNetworkLiquidity(),
        volumeUSD: scaledToString(volumeUSD, 8),
        bridgeIncomingTransactions,
        bridgeOutgoingTransactions,
      },
    });

    await this.repository.upsertMany(documents);

    if (blockHeight % this.config.stateRefreshIntervalBlocks === 0) {
      await this.refreshDerivedState(blockHeight, timestamp, blockHeight % this.config.snapshotIntervalBlocks === 0);
    }

    await this.setLastIndexedBlock(blockHeight);
  }

  private extractNetworkFee(events: EventRecord[]): bigint {
    return events
      .filter(({ event }) => event.section === 'xorFee' && event.method === 'FeeWithdrawn')
      .reduce((sum, { event }) => {
        const data = eventData(event);
        return sum + codecToBigInt(data.amount ?? data.fee ?? data.arg1 ?? data.arg0 ?? 0);
      }, 0n);
  }

  private extractVolumeUSD(data: unknown): bigint {
    if (!data || typeof data !== 'object') return 0n;

    return Object.entries(data as Record<string, unknown>)
      .filter(([key]) => key.endsWith('AmountUSD') || key === 'amountUSD' || key === 'volumeUSD')
      .reduce((sum, [, value]) => sum + decimalStringToScaled(value), 0n);
  }

  private async createAccountDocuments(
    accounts: string[],
    latestHistoryElementId: string,
    blockHeight: number,
    timestamp: number
  ): Promise<IndexerDocument[]> {
    const documents: IndexerDocument[] = [];

    for (const account of accounts) {
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

      if (!(await this.repository.get(collection('accountMeta'), account))) {
        const data = emptyPointData(account, blockHeight, timestamp);
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
            startedAtBlock: blockHeight,
          },
        });
      }
    }

    return documents;
  }

  private createEventDocuments(events: EventRecord[], blockHeight: number, timestamp: number, signer: string): IndexerDocument[] {
    const documents: IndexerDocument[] = [];

    for (const { event } of events) {
      const data = eventData(event);

      if (event.section === 'orderBook') {
        documents.push(...this.createOrderBookEventDocuments(event.method, data, blockHeight, timestamp, signer));
      }

      if (event.section === 'kensetsu') {
        documents.push(...this.createVaultEventDocuments(event.method, data, blockHeight, timestamp, signer));
      }

      if (event.section === 'xorFee' && event.method === 'ReferrerRewarded') {
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

    const [assetInfos, tokenIssuances, poolProperties, poolReserves, poolIssuances, poolProviders, orderBooks, nominators, referrers, cdpEntries] =
      await Promise.all([
        (this.api.query as any).assets.assetInfosV2.entries(),
        (this.api.query as any).tokens.totalIssuance.entries(),
        (this.api.query as any).poolXYK.properties.entries(),
        (this.api.query as any).poolXYK.reserves.entries(),
        (this.api.query as any).poolXYK.totalIssuances.entries(),
        (this.api.query as any).poolXYK.poolProviders.entries(),
        (this.api.query as any).orderBook.orderBooks.entries(),
        (this.api.query as any).staking.nominators.entries(),
        (this.api.query as any).referrals.referrers.entries(),
        (this.api.query as any).kensetsu.cdpDepository.entries(),
      ]);

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

    const documents: IndexerDocument[] = [];
    documents.push(...this.createAssetDocuments(assets, prices, assetPoolLiquidity, blockHeight, timestamp, includeSnapshots));
    documents.push(...this.createPoolDocuments(poolStates, prices, assets, blockHeight, timestamp, includeSnapshots));
    documents.push(...this.createOrderBookDocuments(orderBooks, blockHeight, timestamp, includeSnapshots));
    documents.push(...this.createStakingDocuments(nominators, blockHeight, timestamp));
    documents.push(...this.createReferralDocuments(referrers, blockHeight, timestamp));
    documents.push(...this.createVaultDocuments(cdpEntries, blockHeight, timestamp));
    documents.push(...this.createAccountLiquidityDocuments(poolProviders, poolStates, assets, prices, blockHeight, timestamp));
    documents.push(...this.createUpdateStreams(poolStates, assets, prices, blockHeight, timestamp));

    await this.repository.upsertMany(documents);
  }

  private derivePrices(
    assets: Map<string, AssetInfo>,
    pools: Array<{ baseAssetId: string; targetAssetId: string; baseAssetReserves: bigint; targetAssetReserves: bigint }>
  ): Map<string, bigint> {
    const prices = new Map<string, bigint>();
    const confidence = new Map<string, bigint>();
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

        const applyCandidate = (assetId: string, price: bigint, candidateConfidence: bigint) => {
          if (fixedAssets.has(assetId) || price <= 0n || candidateConfidence <= 0n) return;

          if (candidateConfidence > (confidence.get(assetId) ?? 0n)) {
            prices.set(assetId, price);
            confidence.set(assetId, candidateConfidence);
            changed = true;
          }
        };

        if (basePrice && basePrice > 0n) {
          const baseLiquidityUSD = scaledMul(baseNatural, basePrice);
          const baseConfidence = confidence.get(pool.baseAssetId);
          applyCandidate(
            pool.targetAssetId,
            scaledDiv(baseLiquidityUSD, targetNatural),
            baseConfidence ? baseConfidence < baseLiquidityUSD ? baseConfidence : baseLiquidityUSD : baseLiquidityUSD
          );
        }

        if (targetPrice && targetPrice > 0n) {
          const targetLiquidityUSD = scaledMul(targetNatural, targetPrice);
          const targetConfidence = confidence.get(pool.targetAssetId);
          applyCandidate(
            pool.baseAssetId,
            scaledDiv(targetLiquidityUSD, baseNatural),
            targetConfidence ? targetConfidence < targetLiquidityUSD ? targetConfidence : targetLiquidityUSD : targetLiquidityUSD
          );
        }
      }

      if (!changed) {
        break;
      }
    }

    return prices;
  }

  private createAssetDocuments(
    assets: Map<string, AssetInfo>,
    prices: Map<string, bigint>,
    liquidity: Map<string, bigint>,
    blockHeight: number,
    timestamp: number,
    includeSnapshots: boolean
  ): IndexerDocument[] {
    const documents: IndexerDocument[] = [];

    for (const asset of assets.values()) {
      const priceUSD = scaledToString(prices.get(asset.id) ?? 0n, 8);
      const assetLiquidity = liquidity.get(asset.id) ?? 0n;

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
          liquidityBooks: '0',
          priceChangeDay: 0,
          priceChangeWeek: 0,
          volumeDayUSD: 0,
          volumeWeekUSD: 0,
          velocity: 0,
        },
      });

      if (includeSnapshots) {
        for (const type of ['DEFAULT', 'HOUR', 'DAY', 'MONTH', 'BLOCK']) {
          documents.push({
            collection: collection('assetSnapshots'),
            id: snapshotId('asset', asset.id, type, timestamp),
            blockHeight,
            timestamp,
            data: {
              id: snapshotId('asset', asset.id, type, timestamp),
              assetId: asset.id,
              timestamp,
              type,
              supply: asset.supply.toString(),
              mint: '0',
              burn: '0',
              priceUSD: { open: priceUSD, high: priceUSD, low: priceUSD, close: priceUSD },
              volume: emptyVolume(),
            },
          });
        }
      }
    }

    return documents;
  }

  private createPoolDocuments(
    pools: PoolState[],
    prices: Map<string, bigint>,
    assets: Map<string, AssetInfo>,
    blockHeight: number,
    timestamp: number,
    includeSnapshots: boolean
  ): IndexerDocument[] {
    const documents: IndexerDocument[] = [];
    const apyByPool = this.derivePoolApy(pools, prices);

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
        for (const type of ['DEFAULT', 'HOUR', 'DAY', 'MONTH', 'BLOCK']) {
          const id = snapshotId('pool', pool.id, type, timestamp);
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
              priceUSD: { open: pool.priceUSD, high: pool.priceUSD, low: pool.priceUSD, close: pool.priceUSD },
              baseAssetReserves: pool.baseAssetReserves.toString(),
              targetAssetReserves: pool.targetAssetReserves.toString(),
              chameleonAssetReserves: '0',
              baseAssetVolume: '0',
              targetAssetVolume: '0',
              chameleonAssetVolume: '0',
              poolTokenSupply: pool.poolTokenSupply.toString(),
              poolTokenPriceUSD: poolTokenPrice,
              liquidityUSD: pool.liquidityUSD,
              volumeUSD: '0',
            },
          });
        }
      }
    }

    return documents;
  }

  private derivePoolApy(pools: PoolState[], prices: Map<string, bigint>): Map<string, string> {
    const result = new Map<string, string>();
    const pswapPrice = prices.get(PSWAP) ?? 0n;

    for (const pool of pools) {
      if (pool.liquidityUSD === '0' || pswapPrice === 0n) {
        result.set(pool.id, '0');
        continue;
      }

      result.set(pool.id, '0');
    }

    return result;
  }

  private createOrderBookDocuments(orderBooks: any[], blockHeight: number, timestamp: number, includeSnapshots: boolean): IndexerDocument[] {
    const documents: IndexerDocument[] = [];

    for (const [key, value] of orderBooks) {
      const id = parseOrderBookId(key.args[0]);
      const data = toJson(value) as Record<string, unknown>;
      const idString = orderBookIdString(id);
      const status = String(data.status ?? 'Stop');

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
          baseAssetReserves: '0',
          quoteAssetReserves: '0',
          status,
          price: '0',
          priceChangeDay: 0,
          volumeDayUSD: '0',
          lastDeals: '[]',
          updatedAtBlock: blockHeight,
        },
      });

      if (includeSnapshots) {
        for (const type of ['DEFAULT', 'HOUR', 'DAY', 'MONTH', 'BLOCK']) {
          const snapshot = snapshotId('orderBook', idString, type, timestamp);
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
              price: { open: '0', high: '0', low: '0', close: '0' },
              baseAssetVolume: '0',
              quoteAssetVolume: '0',
              volumeUSD: '0',
              liquidityUSD: '0',
            },
          });
        }
      }
    }

    return documents;
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

  private createVaultDocuments(cdpEntries: any[], blockHeight: number, timestamp: number): IndexerDocument[] {
    return cdpEntries.map(([key, value]) => {
      const id = String(key.args[0]);
      const data = normalizeValue(value) as Record<string, unknown>;
      return {
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
          createdAtBlock: blockHeight,
          updatedAtBlock: blockHeight,
        },
      };
    });
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
    blockHeight: number,
    timestamp: number
  ): IndexerDocument[] {
    const priceData = Object.fromEntries([...assets.values()].map((asset) => [asset.id, scaledToString(prices.get(asset.id) ?? 0n, 8)]));
    const apyData = Object.fromEntries(pools.map((pool) => [pool.id, '0']));
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

  private async getCurrentNetworkLiquidity(): Promise<string> {
    const assets = await this.repository.list(collection('assets'));

    return scaledToString(
      assets.reduce((sum, document) => {
        const liquidity = codecToBigInt(document.data.liquidity ?? 0);
        const assetId = String(document.data.id ?? '');
        const decimals = this.assetInfos.get(assetId)?.decimals ?? DECIMALS;
        const amount = scaledDiv(liquidity, 10n ** BigInt(decimals));
        return sum + scaledMul(amount, this.prices.get(assetId) ?? 0n);
      }, 0n),
      8
    );
  }
}
