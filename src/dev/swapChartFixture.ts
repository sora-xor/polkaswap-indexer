import type { IndexerDocument } from '../repository/types.js';

export const XOR_ASSET_ID = '0x0200000000000000000000000000000000000000000000000000000000000000';
export const DAI_ASSET_ID = '0x0200060000000000000000000000000000000000000000000000000000000000';
export const XOR_DAI_POOL_ID = `${XOR_ASSET_ID}-${DAI_ASSET_ID}`;
export const SOLSWAP_LEGACY_BURN_BLOCK = 25_100_000;
export const SOLSWAP_NEXUS_BURN_BLOCK = 25_900_000;

const SOLSWAP_LEGACY_BURN_TX = '0x1111111111111111111111111111111111111111111111111111111111111111';
const SOLSWAP_NEXUS_BURN_TX = '0x2222222222222222222222222222222222222222222222222222222222222222';
const SOLSWAP_FIXTURE_ADDRESS = 'cnV5d93J89p5kC4dRqF5WWtDNCk1XZ3HQo9dEhGUxBQnohxEB';
const SORA_NEXUS_ACCOUNT =
  'sorau\uff9b1N\uff97hBUd2B\uff82\uff66\uff84i\uff94\uff86\uff82\uff87KS\uff83a\uff98\uff92\uff93Q\uff97r\uff92o\uff98\uff85n\uff73\uff98bQ\uff73QJ\uff86LJ5HSE';
const SORA_NEXUS_XOR_BURN_REMARK = JSON.stringify({
  type: 'soraNexusXorClaim',
  version: 1,
  recipient: SORA_NEXUS_ACCOUNT,
});

type AssetFixture = {
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  basePrice: number;
  supply: string;
  liquidity: string;
};

type SnapshotWindow = {
  type: 'DEFAULT' | 'HOUR' | 'DAY' | 'MONTH';
  count: number;
  seconds: number;
};

const ASSETS: AssetFixture[] = [
  {
    id: XOR_ASSET_ID,
    symbol: 'XOR',
    name: 'SORA',
    decimals: 18,
    basePrice: 362.29,
    supply: '745000000000000000000000000',
    liquidity: '2400000000000000000000000',
  },
  {
    id: DAI_ASSET_ID,
    symbol: 'DAI',
    name: 'Dai Stablecoin',
    decimals: 18,
    basePrice: 1,
    supply: '1000000000000000000000000000',
    liquidity: '870000000000000000000000000',
  },
];

const SNAPSHOT_WINDOWS: SnapshotWindow[] = [
  { type: 'DEFAULT', count: 48, seconds: 5 * 60 },
  { type: 'HOUR', count: 48, seconds: 60 * 60 },
  { type: 'DAY', count: 365, seconds: 24 * 60 * 60 },
  { type: 'MONTH', count: 24, seconds: 30 * 24 * 60 * 60 },
];

const toFixedPrice = (value: number): string => value.toFixed(8).replace(/\.?0+$/, '');

const toHex = (value: string): string => `0x${Buffer.from(value, 'utf8').toString('hex')}`;

const varyPrice = (basePrice: number, index: number, type: SnapshotWindow['type']): number => {
  if (basePrice === 1) {
    return 1 + ((index % 5) - 2) * 0.0001;
  }

  const windowAmplitude: Record<SnapshotWindow['type'], number> = {
    DEFAULT: 0.002,
    HOUR: 0.008,
    DAY: 0.035,
    MONTH: 0.075,
  };
  const amplitude = windowAmplitude[type];
  const wave = ((index % 17) - 8) / 8;

  return basePrice * (1 + wave * amplitude);
};

const priceOhlc = (close: number, index: number) => {
  const open = close * (1 + (((index + 3) % 9) - 4) * 0.0008);
  const high = Math.max(open, close) * 1.001;
  const low = Math.min(open, close) * 0.999;

  return {
    open: toFixedPrice(open),
    high: toFixedPrice(high),
    low: toFixedPrice(low),
    close: toFixedPrice(close),
  };
};

const assetDocument = (asset: AssetFixture, blockHeight: number, timestamp: number): IndexerDocument => ({
  collection: 'assets',
  id: asset.id,
  blockHeight,
  timestamp,
  data: {
    id: asset.id,
    priceUSD: toFixedPrice(asset.basePrice),
    supply: asset.supply,
    liquidity: asset.liquidity,
    liquidityBooks: '0',
    priceChangeDay: asset.id === XOR_ASSET_ID ? 0.42 : 0,
    priceChangeWeek: asset.id === XOR_ASSET_ID ? 1.15 : 0,
    volumeDayUSD: asset.id === XOR_ASSET_ID ? 1875000 : 2450000,
    volumeWeekUSD: asset.id === XOR_ASSET_ID ? 13250000 : 17150000,
    velocity: asset.id === XOR_ASSET_ID ? 0.018 : 0.004,
  },
});

const assetSnapshotDocuments = (
  asset: AssetFixture,
  blockHeight: number,
  timestamp: number
): IndexerDocument[] =>
  SNAPSHOT_WINDOWS.flatMap((window) =>
    Array.from({ length: window.count }, (_, index) => {
      const snapshotTimestamp = timestamp - index * window.seconds;
      const close = varyPrice(asset.basePrice, index, window.type);
      const volumeUsd = asset.id === XOR_ASSET_ID ? 35_000 + index * 110 : 42_000 + index * 75;

      return {
        collection: 'assetSnapshots',
        id: `asset-${asset.id}-${window.type}-${snapshotTimestamp}`,
        blockHeight,
        timestamp: snapshotTimestamp,
        data: {
          id: `asset-${asset.id}-${window.type}-${snapshotTimestamp}`,
          assetId: asset.id,
          timestamp: snapshotTimestamp,
          type: window.type,
          supply: asset.supply,
          mint: '0',
          burn: '0',
          priceUSD: priceOhlc(close, index),
          volume: {
            amount: '0',
            amountUSD: toFixedPrice(volumeUsd),
          },
        },
      } satisfies IndexerDocument;
    })
  );

const poolDocuments = (blockHeight: number, timestamp: number): IndexerDocument[] => {
  const baseReserves = '100000000000000000000000';
  const targetReserves = '36229000000000000000000000';
  const liquidityUSD = toFixedPrice(72_458_000);

  return [
    {
      collection: 'poolXYKs',
      id: XOR_DAI_POOL_ID,
      blockHeight,
      timestamp,
      data: {
        id: XOR_DAI_POOL_ID,
        baseAssetId: XOR_ASSET_ID,
        targetAssetId: DAI_ASSET_ID,
        baseAssetReserves: baseReserves,
        targetAssetReserves: targetReserves,
        chameleonAssetReserves: '0',
        multiplier: 1,
        priceUSD: '1',
        strategicBonusApy: '0',
        poolTokenSupply: '100000000000000000000000',
        poolTokenPriceUSD: toFixedPrice(724.58),
        liquidityUSD,
      },
    },
    {
      collection: 'poolSnapshots',
      id: `pool-${XOR_DAI_POOL_ID}-DAY-${timestamp}`,
      blockHeight,
      timestamp,
      data: {
        id: `pool-${XOR_DAI_POOL_ID}-DAY-${timestamp}`,
        poolId: XOR_DAI_POOL_ID,
        timestamp,
        type: 'DAY',
        priceUSD: priceOhlc(1, 0),
        baseAssetReserves: baseReserves,
        targetAssetReserves: targetReserves,
        chameleonAssetReserves: '0',
        baseAssetVolume: '0',
        targetAssetVolume: '0',
        chameleonAssetVolume: '0',
        poolTokenSupply: '100000000000000000000000',
        poolTokenPriceUSD: toFixedPrice(724.58),
        liquidityUSD,
        volumeUSD: toFixedPrice(2_250_000),
      },
    },
  ];
};

const networkSnapshotDocuments = (blockHeight: number, timestamp: number): IndexerDocument[] =>
  SNAPSHOT_WINDOWS.flatMap((window) =>
    Array.from({ length: window.count }, (_, index) => {
      const snapshotTimestamp = timestamp - index * window.seconds;
      const liquidityUSD = 72_458_000 + index * 1_250;
      const poolLiquidityUSD = 71_950_000 + index * 1_100;
      const orderBookLiquidityUSD = liquidityUSD - poolLiquidityUSD;
      const volumeUSD = 1_875_000 + index * 7_500;
      const fees = (250n + BigInt(index) * 3n) * 10n ** 18n;
      const id = `network-all-${window.type}-${snapshotTimestamp}`;

      return {
        collection: 'networkSnapshots',
        id,
        blockHeight,
        timestamp: snapshotTimestamp,
        data: {
          id,
          type: window.type,
          timestamp: snapshotTimestamp,
          accounts: 10 + (index % 8),
          transactions: 120 + index * 3,
          fees: fees.toString(),
          liquidityUSD: toFixedPrice(liquidityUSD),
          poolLiquidityUSD: toFixedPrice(poolLiquidityUSD),
          orderBookLiquidityUSD: toFixedPrice(orderBookLiquidityUSD),
          volumeUSD: toFixedPrice(volumeUSD),
          swaps: 80 + index,
          activePools: 1,
          activeOrderBooks: 0,
          listedAssets: ASSETS.length,
          bridgeIncomingTransactions: index % 3,
          bridgeOutgoingTransactions: index % 2,
        },
      } satisfies IndexerDocument;
    })
  );

const updatesStreamDocuments = (blockHeight: number, timestamp: number): IndexerDocument[] => {
  const priceData = Object.fromEntries(ASSETS.map((asset) => [asset.id, toFixedPrice(asset.basePrice)]));
  const assetRegistration = Object.fromEntries(
    ASSETS.map((asset) => [
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
      collection: 'updatesStreams',
      id: 'price',
      blockHeight,
      timestamp,
      data: {
        id: 'price',
        block: blockHeight,
        data: JSON.stringify(priceData),
      },
    },
    {
      collection: 'updatesStreams',
      id: 'assetRegistration',
      blockHeight,
      timestamp,
      data: {
        id: 'assetRegistration',
        block: blockHeight,
        data: JSON.stringify(assetRegistration),
      },
    },
  ];
};

/**
 * Creates representative SOLSWAP campaign burns so the burn page can aggregate local fixture stats.
 */
const burnHistoryDocuments = (timestamp: number): IndexerDocument[] => [
  {
    collection: 'historyElements',
    id: SOLSWAP_LEGACY_BURN_TX,
    blockHeight: SOLSWAP_LEGACY_BURN_BLOCK,
    timestamp: timestamp - 3_600,
    data: {
      id: SOLSWAP_LEGACY_BURN_TX,
      type: 'CALL',
      timestamp: timestamp - 3_600,
      blockHash: '0xsolswaplegacyfixture',
      blockHeight: SOLSWAP_LEGACY_BURN_BLOCK,
      module: 'assets',
      method: 'burn',
      address: SOLSWAP_FIXTURE_ADDRESS,
      networkFee: '0',
      execution: { success: true },
      data: {
        amount: '1250',
        amountUSD: '452862.5',
        assetId: XOR_ASSET_ID,
      },
      dataFrom: SOLSWAP_FIXTURE_ADDRESS,
      dataTo: '',
      dataAssets: [XOR_ASSET_ID],
      callNames: [],
      calls: [],
    },
  },
  {
    collection: 'historyElements',
    id: SOLSWAP_NEXUS_BURN_TX,
    blockHeight: SOLSWAP_NEXUS_BURN_BLOCK,
    timestamp,
    data: {
      id: SOLSWAP_NEXUS_BURN_TX,
      type: 'CALL',
      timestamp,
      blockHash: '0xsolswapnexusfixture',
      blockHeight: SOLSWAP_NEXUS_BURN_BLOCK,
      module: 'utility',
      method: 'batchAll',
      address: SOLSWAP_FIXTURE_ADDRESS,
      networkFee: '0',
      execution: { success: true },
      data: {},
      dataFrom: SOLSWAP_FIXTURE_ADDRESS,
      dataTo: '',
      dataAssets: [XOR_ASSET_ID],
      callNames: ['assets.burn', 'system.remark'],
      calls: [
        {
          module: 'assets',
          method: 'burn',
          data: {
            args: {
              assetId: XOR_ASSET_ID,
              amount: '850000000000000000000',
            },
          },
        },
        {
          module: 'system',
          method: 'remark',
          data: {
            args: {
              remark: toHex(SORA_NEXUS_XOR_BURN_REMARK),
            },
          },
        },
      ],
    },
  },
];

const xorBurnDocuments = (timestamp: number): IndexerDocument[] => [
  {
    collection: 'xorBurns',
    id: SOLSWAP_LEGACY_BURN_TX,
    blockHeight: SOLSWAP_LEGACY_BURN_BLOCK,
    timestamp: timestamp - 3_600,
    data: {
      id: SOLSWAP_LEGACY_BURN_TX,
      address: SOLSWAP_FIXTURE_ADDRESS,
      amount: '1250',
      assetId: XOR_ASSET_ID,
      blockHeight: SOLSWAP_LEGACY_BURN_BLOCK,
      timestamp: timestamp - 3_600,
      txHash: SOLSWAP_LEGACY_BURN_TX,
    },
  },
  {
    collection: 'xorBurns',
    id: SOLSWAP_NEXUS_BURN_TX,
    blockHeight: SOLSWAP_NEXUS_BURN_BLOCK,
    timestamp,
    data: {
      id: SOLSWAP_NEXUS_BURN_TX,
      address: SOLSWAP_FIXTURE_ADDRESS,
      amount: '850',
      assetId: XOR_ASSET_ID,
      blockHeight: SOLSWAP_NEXUS_BURN_BLOCK,
      timestamp,
      txHash: SOLSWAP_NEXUS_BURN_TX,
      nexusRecipient: SORA_NEXUS_ACCOUNT,
    },
  },
];

/**
 * Builds local development documents needed by the exchange swap and burn
 * screens before a full historical worker backfill has completed.
 */
export function createSwapChartFixtureDocuments(now = Math.floor(Date.now() / 1000), blockHeight = 0): IndexerDocument[] {
  return [
    ...ASSETS.map((asset) => assetDocument(asset, blockHeight, now)),
    ...ASSETS.flatMap((asset) => assetSnapshotDocuments(asset, blockHeight, now)),
    ...poolDocuments(blockHeight, now),
    ...networkSnapshotDocuments(blockHeight, now),
    ...updatesStreamDocuments(blockHeight, now),
    ...burnHistoryDocuments(now),
    ...xorBurnDocuments(now),
  ];
}
