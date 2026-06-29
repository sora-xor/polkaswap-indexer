export type OrderField = {
  field: string;
  direction: 'asc' | 'desc';
};

export const NUMERIC_ORDER_FIELDS = new Set([
  'timestamp',
  'blockHeight',
  'updatedAtBlock',
  'createdAtBlock',
  'createdAtTimestamp',
  'dexId',
  'marketId',
  'conditionId',
  'closeBlock',
  'governanceProposalIndex',
  'governanceReferendumIndex',
  'governancePollId',
  'orderId',
  'accounts',
  'transactions',
  'fees',
  'swaps',
  'activePools',
  'activeOrderBooks',
  'listedAssets',
  'bridgeIncomingTransactions',
  'bridgeOutgoingTransactions',
  'liquidity',
  'liquidityBooks',
  'liquidityUSD',
  'poolLiquidityUSD',
  'orderBookLiquidityUSD',
  'priceUSD',
  'poolTokenPriceUSD',
  'priceChangeDay',
  'priceChangeWeek',
  'volumeUSD',
  'probability',
  'priceYes',
  'priceNo',
  'creatorFees',
  'yesShares',
  'noShares',
  'collateral',
  'volumeDayUSD',
  'volumeWeekUSD',
  'velocity',
  'amount',
  'amountUSD',
  'apy',
  'commission',
  'rewardPoints',
  'baseAssetReserves',
  'targetAssetReserves',
  'quoteAssetReserves',
  'chameleonAssetReserves',
  'poolTokenSupply',
  'supply',
]);

const snakeToCamel = (value: string): string => {
  const parts = value.toLowerCase().split('_');
  return parts
    .map((part, index) => (index === 0 ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`))
    .join('')
    .replace(/Usd/g, 'USD')
    .replace(/Xyk/g, 'XYK');
};

/**
 * Converts SubQuery-style order tokens into the JSON document field names used
 * by this indexer. Acronyms such as USD and XYK must stay uppercase because the
 * stored schema uses `liquidityUSD`, not `liquidityUsd`.
 */
export const getOrderField = (orderBy: unknown): OrderField => {
  const first = Array.isArray(orderBy) ? orderBy[0] : orderBy;
  const token = String(first ?? 'ID_ASC');
  const direction = token.toUpperCase().endsWith('_DESC') ? 'desc' : 'asc';
  const rawField = token.replace(/_(ASC|DESC)$/i, '');
  const field = snakeToCamel(rawField);

  return { field, direction };
};
