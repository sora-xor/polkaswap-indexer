export const typeDefs = /* GraphQL */ `
  scalar JSON
  scalar Cursor
  scalar OrderBy
  scalar AccountFilter
  scalar AccountLiquiditySnapshotFilter
  scalar AccountPositionFilter
  scalar AccountTradeFilter
  scalar AssetFilter
  scalar AssetSnapshotFilter
  scalar HistoryElementFilter
  scalar MarketFilter
  scalar MarketSnapshotFilter
  scalar NetworkSnapshotFilter
  scalar OrderBookFilter
  scalar OrderBookOrderFilter
  scalar OrderBookSnapshotFilter
  scalar PoolSnapshotFilter
  scalar PoolXYKFilter
  scalar ReferrerRewardFilter
  scalar StakingValidatorFilter
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
    repositoryReady: Boolean!
    service: String!
    serviceId: String!
    schemaVersion: Int!
    ecosystem: String!
    chainId: String!
    network: String!
    publicBaseUrl: String!
    readOnly: Boolean!
    genesisHash: String
    latestIndexedBlock: Int
    latestIndexedBlockHash: String
    latestIndexedAt: Int
    workerAvailable: Boolean!
    workerReady: Boolean
    workerReadinessReason: String
    workerLifecycle: String
    workerStartupComplete: Boolean
    workerLatestFinalizedBlock: Float
    workerLatestIndexedBlock: Float
    workerLag: Float
    workerLastSuccessfulIndexTimestamp: Float
    workerLastError: String
    workerLastErrorTimestamp: Float
  }

  type MobileChainNode {
    name: String!
    address: String!
  }

  type MobileConfig {
    blockExplorerUrl: String!
    substrateTypesUrl: String
    soracard: Boolean!
    nodes: [MobileChainNode!]!
    nexusAvailable: Boolean!
    nexusSendsAvailable: Boolean!
    polkamarktVisible: Boolean!
    polkamarktMutationsAvailable: Boolean!
    tairaDefaultVisible: Boolean!
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
    nodes: [AccountPointSystem!]!
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
    nodes: [Asset!]!
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
    nodes: [AssetSnapshot!]!
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
    nodes: [PoolXYK!]!
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
    nodes: [PoolSnapshot!]!
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
    nodes: [AccountLiquiditySnapshot!]!
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
    nodes: [NetworkSnapshot!]!
    edges: [NetworkSnapshotEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type NetworkAccountActivity {
    id: String!
    from: Int!
    to: Int!
    activeAccounts: Int!
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

  type PolkamarktSignalPoint {
    label: String!
    value: Float!
  }

  type PolkamarktSignalAnswerBreakdown {
    answer: String!
    volumeUsd: Float!
    markets: Int!
  }

  type PolkamarktSignalAccuracyMarket {
    marketId: Int!
    title: String!
    outcome: String!
    predictedOutcome: String!
    confidencePercent: Float!
    yesProbability: Float!
    correct: Boolean!
    label: String!
  }

  type PolkamarktSignalAccuracySummary {
    scoredMarkets: Int!
    resolvedMarkets: Int!
    correctMarkets: Int!
    accuracyPercent: Float!
    averageConfidencePercent: Float!
    latest: PolkamarktSignalAccuracyMarket
  }

  type PolkamarktSignalAccuracyPoint {
    label: String!
    value: Float!
    correctMarkets: Int!
    scoredMarkets: Int!
  }

  type PolkamarktSignals {
    totalVolumeUsd: Float!
    activeMarkets: Int!
    activeAccounts: Int!
    liquidityUsd: Float!
    liquiditySeries: [PolkamarktSignalPoint!]!
    answerBreakdown: [PolkamarktSignalAnswerBreakdown!]!
    accuracySummary: PolkamarktSignalAccuracySummary
    accuracySeries: [PolkamarktSignalAccuracyPoint!]!
  }

  type AccountPosition {
    id: String!
    account: String
    marketId: Int
    outcome: String
    shares: String
    yesShares: String
    noShares: String
    netCollateralPaid: String
    costBasisUsd: String
    yesCostBasisUsd: String
    noCostBasisUsd: String
    marketValueUsd: String
    realizedPnlUsd: String
    unrealizedPnlUsd: String
    claimablePayoutUsd: String
    isCreator: Boolean
    status: String
    updatedAt: String
    market: Market
  }

  type AccountPositionEdge {
    cursor: Cursor
    node: AccountPosition!
  }

  type AccountPositionConnection {
    edges: [AccountPositionEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type AccountTrade {
    id: String!
    account: String
    marketId: Int
    side: String
    outcome: String
    fromOutcome: String
    toOutcome: String
    collateralUsd: String
    collateralAmountUsd: String
    shares: String
    sharesAmount: String
    sharesIn: String
    sharesOut: String
    price: String
    executionPrice: String
    feeUsd: String
    feeAmountUsd: String
    realizedPnlUsd: String
    timestamp: String
    blockNumber: Int
    blockHash: String
    extrinsicHash: String
    market: Market
  }

  type AccountTradeEdge {
    cursor: Cursor
    node: AccountTrade!
  }

  type AccountTradeConnection {
    edges: [AccountTradeEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type Market {
    id: String!
    marketId: Int
    conditionId: Int
    title: String
    category: String
    tags: String
    description: String
    metadataUri: String
    metadataHash: String
    rulesUri: String
    oracle: String
    resolutionSource: String
    closeBlock: Int
    status: String
    mechanism: String
    creator: String
    collateralAsset: String
    creatorFees: String
    liquidityUSD: String
    volumeUSD: String
    probability: Float
    priceYes: Float
    priceNo: Float
    virtualDepth: String
    dpmCollateral: String
    realYesShares: String
    realNoShares: String
    marginalYesPriceBps: Int
    marginalNoPriceBps: Int
    impliedYesProbabilityBps: Int
    impliedNoProbabilityBps: Int
    collateral: String
    yesShares: String
    noShares: String
    resolutionOutcome: String
    resolutionEvidenceUri: String
    resolutionEvidenceHash: String
    resolutionEvidenceBlock: Int
    cancellationEvidenceUri: String
    cancellationEvidenceHash: String
    cancellationEvidenceBlock: Int
    governancePallet: String
    governanceBody: String
    governanceKind: String
    governanceProposalIndex: Int
    governanceReferendumIndex: Int
    governanceMotionHash: String
    governancePollId: Int
    governanceUrl: String
    updatedAtBlock: Int
    timestamp: Int
  }

  type MarketEdge {
    cursor: Cursor
    node: Market!
  }

  type MarketConnection {
    edges: [MarketEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type MarketSnapshot {
    id: String!
    marketId: Int
    timestamp: Int
    blockHeight: Int
    type: SnapshotType
    probability: Float
    priceYes: Float
    priceNo: Float
    virtualDepth: String
    dpmCollateral: String
    realYesShares: String
    realNoShares: String
    marginalYesPriceBps: Int
    marginalNoPriceBps: Int
    impliedYesProbabilityBps: Int
    impliedNoProbabilityBps: Int
    collateral: String
    yesShares: String
    noShares: String
    liquidityUSD: String
    volumeUSD: String
    status: String
  }

  type MarketSnapshotEdge {
    cursor: Cursor
    node: MarketSnapshot!
  }

  type MarketSnapshotConnection {
    edges: [MarketSnapshotEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
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
    nodes: [OrderBook!]!
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
    nodes: [OrderBookOrder!]!
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
    nodes: [OrderBookSnapshot!]!
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
    execution: JSON
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
    nodes: [HistoryElement!]!
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
    nodes: [XorBurn!]!
    edges: [XorBurnEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type ReferrerReward {
    id: String!
    referral: String
    referrer: String
    blockHeight: String
    timestamp: Int
    updated: Int
    amount: String
  }

  type ReferrerRewardEdge {
    cursor: Cursor
    node: ReferrerReward!
  }

  type ReferrerRewardConnection {
    nodes: [ReferrerReward!]!
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
    nodes: [StakingStaker!]!
    edges: [StakingStakerEdge!]!
    pageInfo: PageInfo!
    totalCount: Int!
  }

  type StakingValidator {
    id: String!
    address: String
    commission: String
    blocked: Boolean
    rewardPoints: Int
    nominators: JSON
    identity: JSON
    apy: String
    isOversubscribed: Boolean
    isKnownGood: Boolean
    stake: JSON
    era: Int
    updated: Int
  }

  type StakingValidatorEdge {
    cursor: Cursor
    node: StakingValidator!
  }

  type StakingValidatorConnection {
    nodes: [StakingValidator!]!
    edges: [StakingValidatorEdge!]!
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
    nodes: [Vault!]!
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
    nodes: [VaultEvent!]!
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
    mobileConfig: MobileConfig!
    account(id: String!): JSON
    assets(first: Int, after: Cursor, orderBy: [OrderBy!], filter: AssetFilter): AssetConnection!
    assetSnapshots(first: Int, after: Cursor, orderBy: [OrderBy!], filter: AssetSnapshotFilter): AssetSnapshotConnection!
    accountLiquiditySnapshots(first: Int, after: Cursor, orderBy: [OrderBy!], filter: AccountLiquiditySnapshotFilter): AccountLiquiditySnapshotConnection!
    market(id: String!): Market
    markets(first: Int, after: Cursor, orderBy: [OrderBy!], filter: MarketFilter): MarketConnection!
    marketSnapshots(first: Int, after: Cursor, orderBy: [OrderBy!], filter: MarketSnapshotFilter): MarketSnapshotConnection!
    networkSnapshots(first: Int, after: Cursor, orderBy: [OrderBy!], filter: NetworkSnapshotFilter): NetworkSnapshotConnection!
    poolXYKs(first: Int, after: Cursor, orderBy: [OrderBy!], filter: PoolXYKFilter): PoolXYKConnection!
    poolSnapshots(first: Int, after: Cursor, orderBy: [OrderBy!], filter: PoolSnapshotFilter): PoolSnapshotConnection!
    orderBook(id: String!): OrderBook
    orderBooks(first: Int, after: Cursor, orderBy: [OrderBy!], filter: OrderBookFilter): OrderBookConnection!
    orderBookOrders(first: Int, after: Cursor, orderBy: [OrderBy!], filter: OrderBookOrderFilter): OrderBookOrderConnection!
    orderBookSnapshots(first: Int, after: Cursor, orderBy: [OrderBy!], filter: OrderBookSnapshotFilter): OrderBookSnapshotConnection!
    historyElements(first: Int, last: Int, offset: Int, before: Cursor, after: Cursor, orderBy: [HistoryElementsOrderBy!], filter: HistoryElementFilter): HistoryElementConnection!
    xorBurns(first: Int, after: Cursor, orderBy: [HistoryElementsOrderBy!], filter: XorBurnFilter): XorBurnConnection!
    referrerRewards(first: Int, after: Cursor, orderBy: [OrderBy!], filter: ReferrerRewardFilter): ReferrerRewardConnection!
    stakingStakers(first: Int, after: Cursor, orderBy: [OrderBy!], filter: AccountFilter): StakingStakerConnection!
    stakingValidators(first: Int, after: Cursor, orderBy: [OrderBy!], filter: StakingValidatorFilter): StakingValidatorConnection!
    vaults(first: Int, after: Cursor, orderBy: [OrderBy!], filter: VaultFilter): VaultConnection!
    vaultEvents(first: Int, offset: Int, after: Cursor, orderBy: [OrderBy!], filter: VaultEventFilter): VaultEventConnection!
    updatesStream(id: String!): UpdatesStream
    accountMeta(id: String!): AccountMeta
    accountPointSystems(first: Int, after: Cursor, orderBy: [OrderBy!], filter: AccountFilter): AccountPointSystemConnection!
    accountPositions(first: Int, after: Cursor, orderBy: [OrderBy!], filter: AccountPositionFilter, where: AccountPositionFilter): AccountPositionConnection!
    accountTrades(first: Int, after: Cursor, orderBy: [OrderBy!], filter: AccountTradeFilter, where: AccountTradeFilter): AccountTradeConnection!
    exploreStats: ExploreStats!
    polkamarktSignals: PolkamarktSignals!
    networkAccountActivity(from: Int!, to: Int!): NetworkAccountActivity!
  }

  type Subscription {
    updatesStreams(id: [ID!], mutation: [MutationType!]): UpdatesStreamMutation!
    accounts(id: [ID!], mutation: [MutationType!]): AccountMutation!
    orderBooks(id: [ID!], mutation: [MutationType!]): OrderBookMutation!
  }
`;
