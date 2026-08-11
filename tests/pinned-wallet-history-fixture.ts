/**
 * Exact SubQuery document and default operation-filter shape emitted by
 * @soramitsu/soraneo-wallet-web 1.46.3. Values are representative, while the
 * logical/operator structure mirrors the published source map one-for-one.
 */

export const PINNED_WALLET_HISTORY_DOCUMENT = /* GraphQL */ `
  query SubqueryHistoryElements(
    $first: Int = null
    $last: Int = null
    $offset: Int = null
    $after: Cursor = ""
    $before: Cursor = ""
    $orderBy: [HistoryElementsOrderBy!] = [TIMESTAMP_DESC, ID_DESC]
    $filter: HistoryElementFilter
  ) {
    data: historyElements(
      first: $first
      last: $last
      offset: $offset
      before: $before
      after: $after
      orderBy: $orderBy
      filter: $filter
    ) {
      edges {
        node {
          id
          type
          timestamp
          blockHash
          blockHeight
          module
          method
          address
          networkFee
          execution
          data
          dataFrom
          dataTo
          calls {
            nodes {
              module
              method
              data
            }
          }
        }
      }
      pageInfo {
        ...PageInfoFragment
      }
      totalCount
    }
  }

  fragment PageInfoFragment on PageInfo {
    hasNextPage
    hasPreviousPage
    startCursor
    endCursor
  }
`;

const moduleMethod = (module: string, method: string): Record<string, unknown> => ({
  module: { equalTo: module },
  method: { equalTo: method },
});

const callNames = (names: string | string[]): Record<string, unknown> => ({ callNames: { contains: names } });

const rewardsClaims = [
  ['pswapDistribution', 'claimIncentive'],
  ['rewards', 'claim'],
  ['vestedRewards', 'claimRewards'],
  ['vestedRewards', 'claimCrowdloanRewards'],
] as const;

/** The 39 operations visible in wallet 1.46.3, in its published order. */
export const PINNED_WALLET_OPERATION_CRITERIA: readonly Record<string, unknown>[] = [
  moduleMethod('assets', 'burn'),
  {
    or: [
      moduleMethod('assets', 'mint'),
      { module: { equalTo: 'tokens' }, method: { equalTo: 'deposited' } },
      { module: { equalTo: 'balances' }, method: { equalTo: 'deposited' } },
    ],
  },
  {
    or: [
      { module: { equalTo: 'assets' }, method: { equalToInsensitive: 'transfer' } },
      moduleMethod('liquidityProxy', 'xorlessTransfer'),
      { module: { equalTo: 'tokens' }, method: { equalToInsensitive: 'transfer' } },
      { module: { equalTo: 'balances' }, method: { equalToInsensitive: 'transfer' } },
    ],
  },
  moduleMethod('vestedRewards', 'vestedTransfer'),
  moduleMethod('liquidityProxy', 'swap'),
  moduleMethod('liquidityProxy', 'swapTransfer'),
  moduleMethod('liquidityProxy', 'swapTransferBatch'),
  {
    ...moduleMethod('utility', 'batchAll'),
    ...callNames(['poolXYK.initializePool', 'poolXYK.depositLiquidity']),
  },
  { module: { includesInsensitive: 'poolXYK' }, method: { equalTo: 'depositLiquidity' } },
  { module: { includesInsensitive: 'poolXYK' }, method: { equalTo: 'withdrawLiquidity' } },
  moduleMethod('assets', 'register'),
  moduleMethod('referrals', 'setReferrer'),
  moduleMethod('referrals', 'reserve'),
  moduleMethod('referrals', 'unreserve'),
  {
    or: [
      ...rewardsClaims.map(([module, method]) => moduleMethod(module, method)),
      {
        ...moduleMethod('utility', 'batchAll'),
        or: rewardsClaims.map(([module, method]) => callNames(`${module}.${method}`)),
      },
    ],
  },
  moduleMethod('demeterFarmingPlatform', 'deposit'),
  moduleMethod('demeterFarmingPlatform', 'withdraw'),
  moduleMethod('demeterFarmingPlatform', 'deposit'),
  moduleMethod('demeterFarmingPlatform', 'withdraw'),
  moduleMethod('demeterFarmingPlatform', 'getRewards'),
  moduleMethod('orderBook', 'placeLimitOrder'),
  moduleMethod('orderBook', 'cancelLimitOrders'),
  moduleMethod('orderBook', 'cancelLimitOrders'),
  moduleMethod('staking', 'bond'),
  moduleMethod('staking', 'bondExtra'),
  moduleMethod('staking', 'rebond'),
  moduleMethod('staking', 'unbond'),
  moduleMethod('staking', 'withdrawUnbonded'),
  moduleMethod('staking', 'nominate'),
  moduleMethod('staking', 'chill'),
  moduleMethod('staking', 'setPayee'),
  moduleMethod('staking', 'setController'),
  {
    or: [
      moduleMethod('staking', 'payoutStakers'),
      {
        ...moduleMethod('utility', 'batchAll'),
        ...callNames(['staking.payoutStakers', 'staking.setPayee']),
      },
    ],
  },
  {
    ...moduleMethod('utility', 'batchAll'),
    ...callNames(['staking.bond', 'staking.nominate']),
  },
  moduleMethod('kensetsu', 'createCdp'),
  // The published 1.46.3 filter maps CloseVault to the create method too.
  moduleMethod('kensetsu', 'createCdp'),
  moduleMethod('kensetsu', 'depositCollateral'),
  moduleMethod('kensetsu', 'repayDebt'),
  moduleMethod('kensetsu', 'borrow'),
];

export const createPinnedWalletHistoryFilter = ({
  address = 'cn-wallet-account',
  assetAddress = '',
  accountSearch = '',
  hexSearch = '',
  assetSearch = [] as string[],
}: {
  address?: string;
  assetAddress?: string;
  accountSearch?: string;
  hexSearch?: string;
  assetSearch?: string[];
} = {}): Record<string, unknown> => {
  const and: Record<string, unknown>[] = [
    { address: { equalTo: address } },
    { or: PINNED_WALLET_OPERATION_CRITERIA },
  ];
  if (assetAddress) and.push({ dataAssets: { contains: assetAddress } });

  const search: Record<string, unknown>[] = [];
  if (accountSearch) {
    search.push({ dataFrom: { equalTo: accountSearch } }, { dataTo: { equalTo: accountSearch } });
  }
  if (hexSearch) {
    search.push(
      { dataAssets: { contains: hexSearch } },
      { blockHash: { includesInsensitive: hexSearch } }
    );
  }
  for (const assetId of assetSearch) search.push({ dataAssets: { contains: assetId } });
  if (search.length) and.push({ or: search });

  return { and };
};
