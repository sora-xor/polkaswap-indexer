import { ApiPromise, WsProvider } from '@polkadot/api';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const SORA_GENESIS = '0x7e4e32d0feafd4f9c9414b0be86373f9a1efa904809b683453a9af6856d38ad5';
export const XOR_ID = '0x0200000000000000000000000000000000000000000000000000000000000000';
const ASSET_ID = /^0x[0-9a-f]{64}$/i;
const MAX_PAGE = 100;
const MAX_WALLET_PAGE = 50;
const TIMEOUT_MS = 30_000;

export interface AssetMetadata { id: string; symbol?: string; name?: string; decimals?: number }
export interface PoolMetadata { id: string; baseAssetId: string; targetAssetId: string }
export interface ChainProvenance {
  source: 'SORA2 finalized chain storage'; endpoint: string; genesisHash: string;
  blockHeight: number; blockHash: string; timestamp: number; fetchedAt: string; denominator: string | null;
  unitInterpretation: string;
}
export interface ChainResult<T> { data: T[]; provenance: ChainProvenance; warnings: string[] }
export interface UnknownHolding { assetId: string; atomic: Holding['atomic']; reason: string }
export interface WalletPortfolioResult extends ChainResult<Holding> {
  unresolvedAssets: UnknownHolding[];
  pagination: { hasNextPage: boolean; nextCursor: string | null; scannedTokenEntries: number; nativeIncluded: boolean };
}
interface WalletCursor { v: 1; genesisHash: string; blockHash: string; prefix: string; lastKey: string }
/** A rejected wallet input does not invalidate the shared upstream connection. */
class WalletInputError extends Error {}
export interface Holding {
  assetId: string; symbol: string; name: string; decimals: number;
  atomic: { free: string; reserved: string; frozen: string; bonded: string; total: string; transferable: string; locked: string };
  amounts: { free: string; reserved: string; frozen: string; bonded: string; total: string; transferable: string; locked: string };
}
export interface LiquidityPosition {
  poolId: string; poolAccount: string; baseAssetId: string; targetAssetId: string;
  poolTokensAtomic: string; poolTokenSupplyAtomic: string; sharePercent: string;
  baseReserveAtomic: string; targetReserveAtomic: string;
  proportionalBaseAtomic: string; proportionalTargetAtomic: string;
  proportionalBaseAmount: string; proportionalTargetAmount: string;
  baseDecimals: number; targetDecimals: number;
}

/** Read codec integers exactly, including Polkadot JSON's hexadecimal u128s. */
export function atomicInteger(value: unknown): bigint {
  if (typeof value === 'object' && value !== null && 'toJSON' in value && typeof value.toJSON === 'function') {
    return atomicInteger(value.toJSON());
  }
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^(?:0|[1-9]\d{0,119}|0x[0-9a-f]{1,128})$/i.test(value)) return BigInt(value);
  throw new Error('Missing or invalid exact chain integer');
}

/** Render an atomic balance without floating point or current/historical denomination mixing. */
export function decimalAmount(value: bigint, decimals: number): string {
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 38) throw new Error('Unsupported asset precision');
  if (value < 0n) throw new Error('Negative chain balance');
  if (decimals === 0) return value.toString();
  const text = value.toString().padStart(decimals + 1, '0');
  const fraction = text.slice(-decimals).replace(/0+$/, '');
  return `${text.slice(0, -decimals)}${fraction ? `.${fraction}` : ''}`;
}

function record(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  throw new Error('Missing chain storage record');
}
const max = (a: bigint, b: bigint): bigint => a > b ? a : b;

/** Native modern freezes cover free + reserved; legacy and ORML freezes cover free. */
export function balanceAmounts(data: Record<string, unknown>, bondedValue: unknown, native: boolean) {
  const free = atomicInteger(data.free);
  const reserved = atomicInteger(data.reserved);
  const legacy = max(atomicInteger(data.miscFrozen ?? 0), atomicInteger(data.feeFrozen ?? 0));
  const current = atomicInteger(data.frozen ?? 0);
  const frozen = max(current, legacy);
  const frozenFree = native && data.frozen !== undefined ? max(max(current - reserved, 0n), legacy) : frozen;
  const transferable = max(free - frozenFree, 0n);
  const bonded = bondedValue === null ? 0n : atomicInteger(bondedValue);
  return {
    free, reserved, frozen, bonded, total: free + reserved + bonded,
    transferable, locked: free - transferable + reserved + bonded,
  };
}

/** Proportional reserve share is an estimate, rounded down; it is not a withdrawal quote. */
export function proportionalReserve(reserve: bigint, shares: bigint, supply: bigint): bigint {
  if (supply <= 0n || shares < 0n || shares > supply || reserve < 0n) throw new Error('Invalid pool share/supply');
  return reserve * shares / supply;
}

/** Preserve tiny u128 pool shares instead of displaying a nonzero position as 0%. */
export function sharePercentage(shares: bigint, supply: bigint): string {
  return decimalAmount(proportionalReserve(100n * 10n ** 38n, shares, supply), 38);
}

async function bounded<T>(promise: Promise<T>, timeoutMs = TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('SORA read timed out')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function mapLimited<T, U>(items: T[], action: (item: T) => Promise<U>): Promise<U[]> {
  const result: U[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, items.length) }, async () => {
    while (next < items.length) { const index = next++; result[index] = await action(items[index]); }
  }));
  return result;
}

/** A long-lived, bounded read-only chain adapter; no account, secret, signing, or execution API is exposed. */
export class ChainReader {
  private connection: Promise<ApiPromise> | undefined;
  private provider: WsProvider | undefined;
  private readonly cursorKey = randomBytes(32);
  constructor(
    readonly endpoint = 'wss://ws.mof.sora.org',
    private readonly createApi?: () => Promise<ApiPromise>,
  ) {
    const url = new URL(endpoint);
    if (url.protocol !== 'wss:' || url.username || url.password) throw new Error('SORA endpoint must be an unauthenticated wss URL');
  }

  private async api(): Promise<ApiPromise> {
    if (!this.connection) {
      this.connection = this.createApi ? this.createApi() : (() => {
        this.provider = new WsProvider(this.endpoint);
        return ApiPromise.create({ provider: this.provider, noInitWarn: true });
      })();
    }
    try {
      const api = await bounded(this.connection);
      if (api.genesisHash.toHex().toLowerCase() !== SORA_GENESIS) throw new Error('RPC is not the reviewed SORA mainnet');
      if (!api.isConnected) throw new Error('SORA RPC is disconnected');
      return api;
    } catch (error) { await this.close(); throw error; }
  }

  /** Release socket resources on shutdown or after an unavailable chain response. */
  async close(): Promise<void> {
    const connection = this.connection;
    this.connection = undefined;
    const provider = this.provider;
    this.provider = undefined;
    await provider?.disconnect();
    if (connection) void connection.then(api => api.disconnect()).catch(() => undefined);
  }

  private async anchor(frozenHash?: string) {
    const api = await this.api();
    const finalizedHash = await bounded(api.rpc.chain.getFinalizedHead());
    const hash = frozenHash ?? finalizedHash;
    const [header, at] = await bounded(Promise.all([api.rpc.chain.getHeader(hash), api.at(hash)]));
    if (frozenHash) {
      const [finalizedHeader, canonicalHash] = await bounded(Promise.all([
        api.rpc.chain.getHeader(finalizedHash), api.rpc.chain.getBlockHash(header.number.toNumber()),
      ]));
      if (header.number.toNumber() > finalizedHeader.number.toNumber() || canonicalHash.toHex() !== frozenHash) {
        throw new Error('Wallet cursor block is not canonical finalized SORA state');
      }
    }
    const timestamp = atomicInteger(await bounded(at.query.timestamp.now()));
    let denominator: string | null = null;
    try {
      denominator = atomicInteger(await bounded(at.query.denomination.denominator())).toString();
      if (denominator === '0') denominator = null;
    } catch { /* Missing denomination is disclosed as unknown. */ }
    const milliseconds = Number(timestamp);
    if (!Number.isSafeInteger(milliseconds)) throw new Error('Invalid chain timestamp');
    const provenance: ChainProvenance = {
      source: 'SORA2 finalized chain storage', endpoint: this.endpoint, genesisHash: SORA_GENESIS,
      blockHeight: header.number.toNumber(), blockHash: typeof hash === 'string' ? hash : hash.toHex(), timestamp: Math.floor(milliseconds / 1000),
      fetchedAt: new Date().toISOString(), denominator,
      unitInterpretation: 'Current storage amounts = atomic integer / 10^asset precision. The cumulative denomination coefficient is reported separately; it is not another decimal precision and is not divided into current storage balances. Historical values retain their historical units.',
    };
    return { at, provenance };
  }

  private validatePage(items: Array<{ id: string }>): void {
    if (items.length > MAX_PAGE) throw new Error('Chain registry pages must not exceed 100 entries');
    if (new Set(items.map(item => item.id)).size !== items.length) throw new Error('Duplicate registry entries');
  }

  private async metadata(at: Awaited<ReturnType<ApiPromise['at']>>, id: string, requireStored = false) {
    if (!ASSET_ID.test(id)) throw new Error('Invalid asset id');
    if (requireStored && atomicInteger(await at.query.assets.assetInfosV2.size({ code: id })) === 0n) {
      throw new Error('Asset registration is unavailable');
    }
    const stored = await at.query.assets.assetInfosV2({ code: id });
    const info = record(stored.toHuman());
    const decimals = Number(info.precision);
    if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 38) throw new Error('Missing or unsupported asset precision');
    return { decimals, symbol: String(info.symbol ?? '').slice(0, 80), name: String(info.name ?? '').slice(0, 160) };
  }

  private encodeCursor(value: WalletCursor): string {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    const signature = createHmac('sha256', this.cursorKey).update(body).digest('hex');
    return `wpc1.${body}.${signature}`;
  }

  private decodeCursor(cursor: string): WalletCursor {
    if (cursor.length > 2048) throw new Error('Invalid wallet cursor');
    const match = /^wpc1\.([A-Za-z0-9_-]+)\.([0-9a-f]{64})$/.exec(cursor);
    if (!match) throw new Error('Invalid wallet cursor');
    const expected = createHmac('sha256', this.cursorKey).update(match[1]).digest();
    if (!timingSafeEqual(expected, Buffer.from(match[2], 'hex'))) throw new Error('Wallet cursor expired or invalid; start a fresh page');
    const value = record(JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')));
    if (value.v !== 1 || value.genesisHash !== SORA_GENESIS || typeof value.blockHash !== 'string' || !ASSET_ID.test(value.blockHash) ||
      typeof value.prefix !== 'string' || !/^0x[0-9a-f]+$/.test(value.prefix) || value.prefix.length > 1024 ||
      typeof value.lastKey !== 'string' || !/^0x[0-9a-f]+$/.test(value.lastKey) || value.lastKey.length > 1024 ||
      value.lastKey.length <= value.prefix.length || !value.lastKey.startsWith(value.prefix)) throw new Error('Invalid wallet cursor');
    return value as unknown as WalletCursor;
  }

  /** Page only this wallet's token-storage prefix; native XOR appears once on the first page. */
  async walletPortfolio(address: string, first = 25, after?: string): Promise<WalletPortfolioResult> {
    if (!Number.isSafeInteger(first) || first < 1 || first > MAX_WALLET_PAGE) throw new WalletInputError('Wallet pages must contain between 1 and 50 token entries');
    const cursor = after ? this.decodeCursor(after) : undefined;
    return bounded((async () => {
      const { at, provenance } = await this.anchor(cursor?.blockHash);
      const query = at.query.tokens.accounts;
      let keyPrefix: ReturnType<typeof query.keyPrefix>;
      try { keyPrefix = query.keyPrefix(address); }
      catch { throw new WalletInputError('Invalid public wallet address'); }
      const prefix = typeof keyPrefix === 'string' ? keyPrefix : (keyPrefix as unknown as { toHex(): string }).toHex();
      if (cursor && cursor.prefix !== prefix) throw new WalletInputError('Wallet cursor does not match this public address');
      const warnings = [`${cursor ? 'This page of account token storage contains chain facts; native XOR is included only on the first page.' : 'Native XOR and this page of account token storage are chain facts.'} LP provider shares, vault collateral, staking and other account-specific storage are outside this view. USD value, cost basis, P&L and tax treatment are not calculated.`];
      if (!provenance.denominator) warnings.push('The denomination coefficient is unavailable.');
      const unresolvedAssets: UnknownHolding[] = [];
      const data: Holding[] = [];
      const makeHolding = async (assetId: string, amounts: ReturnType<typeof balanceAmounts>) => {
        const atomic = Object.fromEntries(Object.entries(amounts).map(([key, value]) => [key, value.toString()])) as Holding['atomic'];
        try {
          const metadata = await this.metadata(at, assetId, true);
          return {
            assetId, ...metadata, atomic,
            amounts: Object.fromEntries(Object.entries(amounts).map(([key, value]) => [key, decimalAmount(value, metadata.decimals)])),
          } as Holding;
        } catch {
          unresolvedAssets.push({ assetId, atomic, reason: 'Registered asset metadata or precision unavailable; only exact atomic balances are known.' });
          warnings.push(`Asset ${assetId} has an observed balance but unavailable metadata; no symbol or decimal amount was invented.`);
          return null;
        }
      };
      if (!cursor) {
        try {
          const [native, bonded] = await Promise.all([at.query.system.account(address), at.query.referrals.referrerBalances(address)]);
          const holding = await makeHolding(XOR_ID, balanceAmounts(record(record(native.toJSON()).data), bonded.toJSON(), true));
          if (holding) data.push(holding);
        } catch { warnings.push('Native XOR balance unavailable; no zero balance was inferred.'); }
      }
      const raw = await query.entriesPaged({ args: [address], pageSize: first + 1, ...(cursor ? { startKey: cursor.lastKey } : {}) });
      const page = raw.slice(0, first);
      const tokenHoldings = await mapLimited(page, async ([key, stored]) => {
        const keyHex = key.toHex();
        if (!keyHex.startsWith(prefix)) throw new Error('RPC returned a token key outside the requested wallet prefix');
        let assetId: string | undefined;
        try {
          const decoded = record(key.args[1].toJSON());
          if (typeof decoded.code !== 'string' || !ASSET_ID.test(decoded.code)) throw new Error('Unknown asset key');
          assetId = decoded.code.toLowerCase();
          if (assetId === XOR_ID) return null;
          const amounts = balanceAmounts(record(stored.toJSON()), null, false);
          if (amounts.total === 0n) return null;
          return await makeHolding(assetId, amounts);
        } catch { warnings.push(`Token storage entry${assetId ? ` ${assetId}` : ''} could not be read exactly; no zero balance was inferred.`); return null; }
      });
      data.push(...tokenHoldings.filter((value): value is Holding => value !== null));
      const hasNextPage = raw.length > first;
      if (hasNextPage) warnings.push('More wallet token-storage entries remain; follow nextCursor for the same frozen block.');
      const lastKey = page.at(-1)?.[0].toHex();
      return {
        data, unresolvedAssets, provenance, warnings,
        pagination: {
          hasNextPage, nextCursor: hasNextPage && lastKey ? this.encodeCursor({ v: 1, genesisHash: SORA_GENESIS, blockHash: provenance.blockHash, prefix, lastKey }) : null,
          scannedTokenEntries: page.length, nativeIncluded: !cursor && (data.some(asset => asset.assetId === XOR_ID) || unresolvedAssets.some(asset => asset.assetId === XOR_ID)),
        },
      };
    })()).catch(async error => { if (!(error instanceof WalletInputError)) await this.close(); throw error; });
  }

  /** Holdings for the supplied registry page, all read at the same finalized block. */
  async portfolio(address: string, assets: AssetMetadata[]): Promise<ChainResult<Holding>> {
    this.validatePage(assets);
    return bounded((async () => {
      const { at, provenance } = await this.anchor();
      const warnings = ['Holdings cover only the supplied asset registry page. Other pages, LP tokens, vault collateral, staking and other account-specific storage may be outside this view. USD value, cost basis, P&L and tax treatment are not calculated.'];
      if (!provenance.denominator) warnings.push('The denomination coefficient is unavailable.');
      const values = await mapLimited(assets, async asset => {
        try {
          const native = asset.id.toLowerCase() === XOR_ID;
          const [metadata, stored, bonded] = await Promise.all([
            this.metadata(at, asset.id),
            native ? at.query.system.account(address) : at.query.tokens.accounts(address, { code: asset.id }),
            native ? at.query.referrals.referrerBalances(address) : Promise.resolve(null),
          ]);
          const json = record(stored.toJSON());
          const amounts = balanceAmounts(native ? record(json.data) : json, bonded?.toJSON() ?? null, native);
          if (amounts.total === 0n) return null;
          return {
            assetId: asset.id, ...metadata,
            atomic: Object.fromEntries(Object.entries(amounts).map(([key, value]) => [key, value.toString()])),
            amounts: Object.fromEntries(Object.entries(amounts).map(([key, value]) => [key, decimalAmount(value, metadata.decimals)])),
          } as Holding;
        } catch { warnings.push(`Balance unavailable for asset ${asset.id}; no zero balance was inferred.`); return null; }
      });
      return { data: values.filter((value): value is Holding => value !== null), provenance, warnings };
    })()).catch(async error => { await this.close(); throw error; });
  }

  /** Current provider shares for a pool registry page, with proportional reserve estimates. */
  async liquidity(address: string, pools: PoolMetadata[]): Promise<ChainResult<LiquidityPosition>> {
    this.validatePage(pools);
    return bounded((async () => {
      const { at, provenance } = await this.anchor();
      const warnings = ['Positions cover only the supplied Pool XYK registry page. Proportional reserve amounts and share percentages are rounded down; reserve estimates exclude withdrawal fees and chameleon reserves and are not redeemable-output quotes. Historical P&L and tax accounting are unavailable.'];
      const values = await mapLimited(pools, async pool => {
        try {
          if (!ASSET_ID.test(pool.baseAssetId) || !ASSET_ID.test(pool.targetAssetId)) throw new Error('Invalid pool assets');
          const properties = (await at.query.poolXYK.properties({ code: pool.baseAssetId }, { code: pool.targetAssetId })).toJSON();
          if (properties === null) return null;
          if (!Array.isArray(properties) || typeof properties[0] !== 'string') throw new Error('Invalid pool properties');
          const poolAccount = properties[0];
          const sharesValue = (await at.query.poolXYK.poolProviders(poolAccount, address)).toJSON();
          if (sharesValue === null) return null;
          const shares = atomicInteger(sharesValue);
          if (shares === 0n) return null;
          const [supplyValue, reservesValue, baseInfo, targetInfo] = await Promise.all([
            at.query.poolXYK.totalIssuances(poolAccount),
            at.query.poolXYK.reserves({ code: pool.baseAssetId }, { code: pool.targetAssetId }),
            this.metadata(at, pool.baseAssetId), this.metadata(at, pool.targetAssetId),
          ]);
          const supply = atomicInteger(supplyValue);
          const reserves = reservesValue.toJSON();
          if (!Array.isArray(reserves) || reserves.length < 2) throw new Error('Missing pool reserves');
          const baseReserve = atomicInteger(reserves[0]);
          const targetReserve = atomicInteger(reserves[1]);
          const base = proportionalReserve(baseReserve, shares, supply);
          const target = proportionalReserve(targetReserve, shares, supply);
          return {
            poolId: pool.id, poolAccount, baseAssetId: pool.baseAssetId, targetAssetId: pool.targetAssetId,
            poolTokensAtomic: shares.toString(), poolTokenSupplyAtomic: supply.toString(),
            sharePercent: sharePercentage(shares, supply),
            baseReserveAtomic: baseReserve.toString(), targetReserveAtomic: targetReserve.toString(),
            proportionalBaseAtomic: base.toString(), proportionalTargetAtomic: target.toString(),
            proportionalBaseAmount: decimalAmount(base, baseInfo.decimals), proportionalTargetAmount: decimalAmount(target, targetInfo.decimals),
            baseDecimals: baseInfo.decimals, targetDecimals: targetInfo.decimals,
          };
        } catch { warnings.push(`Position unavailable for pool ${pool.id}; no zero position was inferred.`); return null; }
      });
      return { data: values.filter((value): value is LiquidityPosition => value !== null), provenance, warnings };
    })()).catch(async error => { await this.close(); throw error; });
  }
}
