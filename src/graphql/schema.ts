export const typeDefs = /* GraphQL */ `
  scalar JSON
  scalar Cursor
  scalar OrderBy
  scalar AccountFilter
  scalar AccountLiquiditySnapshotFilter
  scalar AssetFilter
  scalar AssetSnapshotFilter
  scalar HistoryElementFilter
  scalar NetworkSnapshotFilter
  scalar OrderBookFilter
  scalar OrderBookOrderFilter
  scalar OrderBookSnapshotFilter
  scalar PoolSnapshotFilter
  scalar PoolXYKFilter
  scalar ReferrerRewardFilter
  scalar VaultEventFilter
  scalar VaultFilter
  scalar XorBurnFilter

  enum HistoryElementsOrderBy {
    ID_ASC
    ID_DESC
    TIMESTAMP_ASC
    TIMESTAMP_DESC
    BLOCK_HEIGHT_ASC
    BLOCK_HEIGHT_DESC
  }

  enum SnapshotType {
    DEFAULT
    HOUR
    DAY
    MONTH
    BLOCK
  }

  enum MutationType {
    INSERT
    UPDATE
    DELETE
  }

  type Health {
    ok: Boolean!
    service: String!
  }

  type PageInfo {
    hasNextPage: Boolean!
    hasPreviousPage: Boolean!
    startCursor: Cursor
    endCursor: Cursor
  }

  type PriceSnapshot {
    low: String
    high: String
    open: String
    close: String
  }

  type AssetVolume {
    amount: String
    amountUSD: String
  }

  type AccountMetaEventCounter {
    created: Int
    closed: Int
    amountUSD: String
  }

  type AccountMetaGovernance {
    votes: Int
    amount: String
    amountUSD: String
  }

  type AccountMetaDeposit {
    incomingUSD: String
    outgoingUSD: String
  }

  type AccountMeta {
    id: String!
    accountId: String
    createdAtTimestamp: Int
    createdAtBlock: Int
    xorFees: JSON
    xorBurned: JSON
    xorStakingValRewards: JSON
    orderBook: JSON
    vault: JSON
    governance: JSON
    deposit: JSON
  }

  type AccountPointSystem {
    id: String!
    accountId: String
    version: Int
    startedAtBlock: Int
    xorFees: JSON
    xorBurned: JSON
    xorStakingValRewards: JSON
    orderBook: JSON
    vault: JSON
    governance: JSON
    deposit: JSON
  }

  type AccountPointSystemEdge {
    cursor: Cursor
    node: AccountPointSystem!
  }

  type AccountPointSystemConnection {
    edges: [AccountPointSystemEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type Asset {
    id: String!
    priceUSD: String
    supply: String
    liquidity: String
    liquidityBooks: String
    priceChangeDay: Float
    priceChangeWeek: Float
    volumeDayUSD: Float
    volumeWeekUSD: Float
    velocity: Float
  }

  type AssetEdge {
    cursor: Cursor
    node: Asset!
  }

  type AssetConnection {
    edges: [AssetEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type AssetSnapshot {
    id: String!
    assetId: String
    timestamp: Int
    type: SnapshotType
    supply: String
    mint: String
    burn: String
    priceUSD: JSON
    volume: JSON
  }

  type AssetSnapshotEdge {
    cursor: Cursor
    node: AssetSnapshot!
  }

  type AssetSnapshotConnection {
    edges: [AssetSnapshotEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type PoolXYK {
    id: String!
    baseAssetId: String
    targetAssetId: String
    baseAssetReserves: String
    targetAssetReserves: String
    chameleonAssetReserves: String
    multiplier: Float
    priceUSD: String
    strategicBonusApy: String
    poolTokenSupply: String
    poolTokenPriceUSD: String
    liquidityUSD: String
  }

  type PoolXYKEdge {
    cursor: Cursor
    node: PoolXYK!
  }

  type PoolXYKConnection {
    edges: [PoolXYKEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type PoolSnapshot {
    id: String!
    poolId: String
    timestamp: Int
    type: SnapshotType
    priceUSD: JSON
    baseAssetReserves: String
    targetAssetReserves: String
    chameleonAssetReserves: String
    baseAssetVolume: String
    targetAssetVolume: String
    chameleonAssetVolume: String
    poolTokenSupply: String
    poolTokenPriceUSD: String
    liquidityUSD: String
    volumeUSD: String
  }

  type PoolSnapshotEdge {
    cursor: Cursor
    node: PoolSnapshot!
  }

  type PoolSnapshotConnection {
    edges: [PoolSnapshotEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type AccountLiquiditySnapshot {
    id: String!
    accountLiquidityId: String
    timestamp: Int
    type: SnapshotType
    poolTokens: String
    liquidityUSD: String
  }

  type AccountLiquiditySnapshotEdge {
    cursor: Cursor
    node: AccountLiquiditySnapshot!
  }

  type AccountLiquiditySnapshotConnection {
    edges: [AccountLiquiditySnapshotEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type NetworkSnapshot {
    id: String!
    type: SnapshotType
    timestamp: Int
    accounts: Int
    transactions: Int
    fees: String
    liquidityUSD: String
    poolLiquidityUSD: String
    orderBookLiquidityUSD: String
    volumeUSD: String
    swaps: Int
    activePools: Int
    activeOrderBooks: Int
    listedAssets: Int
    bridgeIncomingTransactions: Int
    bridgeOutgoingTransactions: Int
  }

  type NetworkSnapshotEdge {
    cursor: Cursor
    node: NetworkSnapshot!
  }

  type NetworkSnapshotConnection {
    edges: [NetworkSnapshotEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type ExploreStats {
    id: String!
    tokenCount: Int!
    poolCount: Int!
    orderBookCount: Int!
    liquidityUSD: String!
    volumeDayUSD: String!
    updatedAtTimestamp: Int
  }

  type OrderBook {
    id: String!
    dexId: Int
    baseAssetId: String
    quoteAssetId: String
    baseAssetReserves: String
    quoteAssetReserves: String
    status: String
    price: String
    priceChangeDay: Float
    volumeDayUSD: String
    lastDeals: String
    updatedAtBlock: Int
  }

  type OrderBookEdge {
    cursor: Cursor
    node: OrderBook!
  }

  type OrderBookConnection {
    edges: [OrderBookEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type OrderBookOrder {
    id: String!
    type: String
    orderId: Int
    orderBookId: String
    accountId: String
    createdAtBlock: Int
    timestamp: Int
    isBuy: Boolean
    amount: String
    price: String
    lifetime: Int
    expiresAt: Int
    amountFilled: String
    status: String
    updatedAtBlock: Int
  }

  type OrderBookOrderEdge {
    cursor: Cursor
    node: OrderBookOrder!
  }

  type OrderBookOrderConnection {
    edges: [OrderBookOrderEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type OrderBookSnapshot {
    id: String!
    orderBookId: String
    timestamp: Int
    type: SnapshotType
    price: JSON
    baseAssetVolume: String
    quoteAssetVolume: String
    volumeUSD: String
    liquidityUSD: String
  }

  type OrderBookSnapshotEdge {
    cursor: Cursor
    node: OrderBookSnapshot!
  }

  type OrderBookSnapshotConnection {
    edges: [OrderBookSnapshotEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type HistoryCall {
    module: String
    method: String
    data: JSON
  }

  type HistoryCallConnection {
    nodes: [HistoryCall!]!
  }

  type HistoryExecution {
    success: Boolean
    error: JSON
  }

  type HistoryElement {
    id: String!
    type: String
    timestamp: Int
    blockHash: String
    blockHeight: Int
    module: String
    method: String
    address: String
    networkFee: String
    execution: HistoryExecution
    data: JSON
    dataFrom: String
    dataTo: String
    dataAssets: [String!]
    callNames: [String!]
    calls: HistoryCallConnection
  }

  type HistoryElementEdge {
    cursor: Cursor
    node: HistoryElement!
  }

  type HistoryElementConnection {
    edges: [HistoryElementEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type XorBurn {
    id: String!
    address: String
    amount: String
    assetId: String
    blockHeight: Int
    timestamp: Int
    txHash: String
    nexusRecipient: String
  }

  type XorBurnEdge {
    cursor: Cursor
    node: XorBurn!
  }

  type XorBurnConnection {
    edges: [XorBurnEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type ReferrerReward {
    id: String!
    referral: String
    referrer: String
    updated: Int
    amount: String
  }

  type ReferrerRewardEdge {
    cursor: Cursor
    node: ReferrerReward!
  }

  type ReferrerRewardConnection {
    edges: [ReferrerRewardEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type StakingStaker {
    id: String!
  }

  type StakingStakerEdge {
    cursor: Cursor
    node: StakingStaker!
  }

  type StakingStakerConnection {
    edges: [StakingStakerEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type Vault {
    id: String!
    type: String
    status: String
    ownerId: String
    collateralAssetId: String
    debtAssetId: String
    collateralAmountReturned: String
    createdAtBlock: Int
    updatedAtBlock: Int
  }

  type VaultEdge {
    cursor: Cursor
    node: Vault!
  }

  type VaultConnection {
    edges: [VaultEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type VaultEvent {
    id: String!
    vaultId: String
    type: String
    timestamp: Int
    block: Int
    amount: String
  }

  type VaultEventEdge {
    cursor: Cursor
    node: VaultEvent!
  }

  type VaultEventConnection {
    edges: [VaultEventEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type UpdatesStream {
    id: String!
    block: Int
    data: String
  }

  type UpdatesStreamMutation {
    id: String!
    mutation_type: String!
    _entity: JSON!
  }

  type AccountMutationEntity {
    id: String!
    latest_history_element_id: String
  }

  type AccountMutation {
    id: String!
    mutation_type: String!
    _entity: JSON!
  }

  type OrderBookMutationEntity {
    price: String
    price_change_day: Float
    volume_day_u_s_d: String
    status: String
    last_deals: String
  }

  type OrderBookMutation {
    id: String!
    mutation_type: String!
    _entity: JSON!
  }

  type Query {
    _health: Health!
    account(id: String!): JSON
    assets(first: Int, last: Int, offset: Int, after: Cursor, before: Cursor, orderBy: [OrderBy!], filter: AssetFilter): AssetConnection!
    assetSnapshots(first: Int, last: Int, offset: Int, after: Cursor, before: Cursor, orderBy: [OrderBy!], filter: AssetSnapshotFilter): AssetSnapshotConnection!
    accountLiquiditySnapshots(first: Int, last: Int, offset: Int, after: Cursor, before: Cursor, orderBy: [OrderBy!], filter: AccountLiquiditySnapshotFilter): AccountLiquiditySnapshotConnection!
    networkSnapshots(first: Int, last: Int, offset: Int, after: Cursor, before: Cursor, orderBy: [OrderBy!], filter: NetworkSnapshotFilter): NetworkSnapshotConnection!
    poolXYKs(first: Int, last: Int, offset: Int, after: Cursor, before: Cursor, orderBy: [OrderBy!], filter: PoolXYKFilter): PoolXYKConnection!
    poolSnapshots(first: Int, last: Int, offset: Int, after: Cursor, before: Cursor, orderBy: [OrderBy!], filter: PoolSnapshotFilter): PoolSnapshotConnection!
    orderBook(id: String!): OrderBook
    orderBooks(first: Int, last: Int, offset: Int, after: Cursor, before: Cursor, orderBy: [OrderBy!], filter: OrderBookFilter): OrderBookConnection!
    orderBookOrders(first: Int, last: Int, offset: Int, after: Cursor, before: Cursor, orderBy: [OrderBy!], filter: OrderBookOrderFilter): OrderBookOrderConnection!
    orderBookSnapshots(first: Int, last: Int, offset: Int, after: Cursor, before: Cursor, orderBy: [OrderBy!], filter: OrderBookSnapshotFilter): OrderBookSnapshotConnection!
    historyElements(first: Int, last: Int, offset: Int, after: Cursor, before: Cursor, orderBy: [HistoryElementsOrderBy!], filter: HistoryElementFilter): HistoryElementConnection!
    xorBurns(first: Int, last: Int, offset: Int, after: Cursor, before: Cursor, orderBy: [HistoryElementsOrderBy!], filter: XorBurnFilter): XorBurnConnection!
    referrerRewards(first: Int, last: Int, offset: Int, after: Cursor, before: Cursor, orderBy: [OrderBy!], filter: ReferrerRewardFilter): ReferrerRewardConnection!
    stakingStakers(first: Int, last: Int, offset: Int, after: Cursor, before: Cursor, orderBy: [OrderBy!], filter: AccountFilter): StakingStakerConnection!
    vaults(first: Int, last: Int, offset: Int, after: Cursor, before: Cursor, orderBy: [OrderBy!], filter: VaultFilter): VaultConnection!
    vaultEvents(first: Int, last: Int, offset: Int, after: Cursor, before: Cursor, orderBy: [OrderBy!], filter: VaultEventFilter): VaultEventConnection!
    updatesStream(id: String!): UpdatesStream
    accountMeta(id: String!): AccountMeta
    accountPointSystems(first: Int, last: Int, offset: Int, after: Cursor, before: Cursor, orderBy: [OrderBy!], filter: AccountFilter): AccountPointSystemConnection!
    exploreStats: ExploreStats!
  }

  type Subscription {
    updatesStreams(id: [ID!], mutation: [MutationType!]): UpdatesStreamMutation!
    accounts(id: [ID!], mutation: [MutationType!]): AccountMutation!
    orderBooks(id: [ID!], mutation: [MutationType!]): OrderBookMutation!
  }
`;
