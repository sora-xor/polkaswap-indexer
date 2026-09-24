import { describe, expect, it, vi } from 'vitest';
import type { GraphQLObjectType, GraphQLResolveInfo } from 'graphql';

import {
  NETWORK_ACCOUNT_ACTIVITY_MAX_DOCUMENTS,
  NETWORK_ACCOUNT_ACTIVITY_MAX_RANGE_SECONDS,
  createSchema,
  subscriptionDocumentFingerprint,
} from '../src/graphql/resolvers.js';
import { MemoryRepository } from '../src/repository/memory.js';
import {
  createRepositoryCursorScope,
  decodeRepositoryCursor,
  encodeRepositoryCursor,
} from '../src/repository/cursor.js';
import { SORA_LEGACY_IDENTITY_ANCHOR, SORA_MAINNET_GENESIS_HASH } from '../src/soraIdentity.js';

import type { IndexerDocument, IndexerRepository, RepositoryQueryArgs } from '../src/repository/types.js';

type QueryFunction = NonNullable<IndexerRepository['query']>;

const opaqueCursor = () => expect.stringMatching(/^psc2\./);

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const ss58FixtureAccount = (index: number): string => {
  let value = index + 1;
  let encoded = '';

  while (value > 0) {
    encoded = BASE58_ALPHABET[value % BASE58_ALPHABET.length] + encoded;
    value = Math.floor(value / BASE58_ALPHABET.length);
  }

  return encoded.padStart(48, '1');
};

const repositoryWithQuery = (query: QueryFunction): IndexerRepository => ({
  list: async () => [],
  query,
  get: async () => null,
  getMany: async () => new Map(),
  upsert: async () => undefined,
  upsertMany: async () => undefined,
  deleteMany: async () => undefined,
  close: async () => undefined,
});

const repositoryWithoutQuery = (items: Awaited<ReturnType<IndexerRepository['list']>>): IndexerRepository => ({
  list: async (collection) => items.filter((item) => item.collection === collection),
  get: async () => null,
  getMany: async () => new Map(),
  upsert: async () => undefined,
  upsertMany: async () => undefined,
  deleteMany: async () => undefined,
  close: async () => undefined,
});

const VALID_CHAIN_STATE_BLOCK = SORA_LEGACY_IDENTITY_ANCHOR.block + 100;
const VALID_CHAIN_STATE_HASH = `0x${'ab'.repeat(32)}`;

const seedValidChainCheckpoint = async (repository: MemoryRepository, timestamp: number): Promise<void> => {
  await repository.upsertMany([
    {
      collection: 'updatesStreams',
      id: 'chainIdentity',
      blockHeight: SORA_LEGACY_IDENTITY_ANCHOR.block,
      timestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
      data: {
        id: 'chainIdentity',
        block: SORA_LEGACY_IDENTITY_ANCHOR.block,
        data: JSON.stringify({
          schemaVersion: 1,
          genesisHash: SORA_MAINNET_GENESIS_HASH,
          verificationBlock: SORA_LEGACY_IDENTITY_ANCHOR.block,
          verificationBlockHash: SORA_LEGACY_IDENTITY_ANCHOR.hash,
          verificationBlockTimestamp: SORA_LEGACY_IDENTITY_ANCHOR.timestamp,
          migration: 'fresh-database',
        }),
      },
    },
    {
      collection: 'updatesStreams',
      id: 'chainState',
      blockHeight: VALID_CHAIN_STATE_BLOCK,
      timestamp,
      data: {
        id: 'chainState',
        block: VALID_CHAIN_STATE_BLOCK,
        data: JSON.stringify({
          lastIndexedBlock: VALID_CHAIN_STATE_BLOCK,
          genesisHash: SORA_MAINNET_GENESIS_HASH,
          blockHash: VALID_CHAIN_STATE_HASH,
          blockTimestamp: timestamp,
        }),
      },
    },
  ]);
};

describe('Polkaswap indexer schema', () => {
  it('uses fixed-size polling fingerprints instead of retaining serialized subscription payloads', () => {
    const large = { id: 'large', payload: 'x'.repeat(2 * 1_024 * 1_024) };
    const fingerprint = subscriptionDocumentFingerprint(large);

    expect(fingerprint).toHaveLength(43);
    expect(subscriptionDocumentFingerprint(large)).toBe(fingerprint);
    expect(subscriptionDocumentFingerprint({ ...large, id: 'changed' })).not.toBe(fingerprint);
  });

  it('keeps detailed worker health fields nullable while a heartbeat is unavailable', () => {
    const health = createSchema().getType('Health') as GraphQLObjectType;

    expect(String(health.getFields().workerAvailable?.type)).toBe('Boolean!');
    for (const field of [
      'genesisHash',
      'latestIndexedBlock',
      'latestIndexedBlockHash',
      'latestIndexedAt',
      'workerReady',
      'workerReadinessReason',
      'workerLifecycle',
      'workerStartupComplete',
      'workerLatestFinalizedBlock',
      'workerLatestIndexedBlock',
      'workerLag',
      'workerLastSuccessfulIndexTimestamp',
      'workerLastError',
      'workerLastErrorTimestamp',
    ]) {
      expect(String(health.getFields()[field]?.type).endsWith('!')).toBe(false);
    }
  });

  it('exposes a repository-backed health resolver', async () => {
    const schema = createSchema();
    const healthField = schema.getQueryType()?.getFields()._health;

    await expect(healthField?.resolve?.({}, {}, { repository: new MemoryRepository() }, {} as never)).resolves.toEqual({
      ok: false,
      checkpointCoherent: false,
      repositoryReady: true,
      service: 'polkaswap-indexer',
      serviceId: 'pi.soramitsu.io',
      schemaVersion: 1,
      ecosystem: 'sora2',
      chainId: 'sora:mainnet',
      network: 'mainnet',
      publicBaseUrl: 'https://pi.soramitsu.io/graphql',
      readOnly: true,
      genesisHash: null,
      latestIndexedBlock: null,
      latestIndexedBlockHash: null,
      latestIndexedAt: null,
      workerAvailable: false,
      workerReady: false,
      workerReadinessReason: 'status-unavailable',
      workerLifecycle: null,
      workerStartupComplete: null,
      workerLatestFinalizedBlock: null,
      workerLatestIndexedBlock: null,
      workerLag: null,
      workerLastSuccessfulIndexTimestamp: null,
      workerLastError: null,
      workerLastErrorTimestamp: null,
    });
  });

  it('reports unhealthy when the repository health check fails', async () => {
    const schema = createSchema();
    const healthField = schema.getQueryType()?.getFields()._health;
    const repository = {
      ...repositoryWithoutQuery([]),
      healthCheck: async () => false,
    };

    await expect(healthField?.resolve?.({}, {}, { repository }, {} as never)).resolves.toEqual({
      ok: false,
      checkpointCoherent: false,
      repositoryReady: false,
      service: 'polkaswap-indexer',
      serviceId: 'pi.soramitsu.io',
      schemaVersion: 1,
      ecosystem: 'sora2',
      chainId: 'sora:mainnet',
      network: 'mainnet',
      publicBaseUrl: 'https://pi.soramitsu.io/graphql',
      readOnly: true,
      genesisHash: null,
      latestIndexedBlock: null,
      latestIndexedBlockHash: null,
      latestIndexedAt: null,
      workerAvailable: false,
      workerReady: false,
      workerReadinessReason: 'status-unavailable',
      workerLifecycle: null,
      workerStartupComplete: null,
      workerLatestFinalizedBlock: null,
      workerLatestIndexedBlock: null,
      workerLag: null,
      workerLastSuccessfulIndexTimestamp: null,
      workerLastError: null,
      workerLastErrorTimestamp: null,
    });
  });

  it('requires worker readiness when a combined-mode status provider is present', async () => {
    const healthField = createSchema().getQueryType()?.getFields()._health;
    const now = Math.floor(Date.now() / 1_000);
    const workerStatusProvider = {
      getStatus: () => ({
        lifecycle: 'running' as const,
        startupComplete: true,
        latestFinalizedBlock: 1_000,
        latestIndexedBlock: 900,
        lag: 100,
        lastSuccessfulIndexTimestamp: now,
        lastError: null,
        lastErrorTimestamp: null,
      }),
    };

    await expect(
      healthField?.resolve?.(
        {},
        {},
        {
          repository: new MemoryRepository(),
          workerStatusProvider,
          workerReadinessThresholds: { maxLagBlocks: 25, maxStalenessSeconds: 120 },
        },
        {} as never
      )
    ).resolves.toMatchObject({
      ok: false,
      repositoryReady: true,
      workerAvailable: true,
      workerReady: false,
      workerReadinessReason: 'lag-exceeded',
      workerLifecycle: 'running',
      workerLag: 100,
    });
  });

  it('reports detailed ready worker status when the chain checkpoint is also valid', async () => {
    const healthField = createSchema().getQueryType()?.getFields()._health;
    const now = Math.floor(Date.now() / 1_000);
    const repository = new MemoryRepository();
    await seedValidChainCheckpoint(repository, now);
    const workerStatusProvider = {
      getStatus: () => ({
        lifecycle: 'running' as const,
        startupComplete: true,
        latestFinalizedBlock: VALID_CHAIN_STATE_BLOCK + 5,
        latestIndexedBlock: VALID_CHAIN_STATE_BLOCK,
        lag: 5,
        lastSuccessfulIndexTimestamp: now,
        lastError: null,
        lastErrorTimestamp: null,
      }),
    };

    await expect(
      healthField?.resolve?.(
        {},
        {},
        {
          repository,
          workerStatusProvider,
          workerReadinessThresholds: { maxLagBlocks: 25, maxStalenessSeconds: 120 },
        },
        {} as never
      )
    ).resolves.toMatchObject({
      ok: true,
      genesisHash: SORA_MAINNET_GENESIS_HASH,
      latestIndexedBlock: VALID_CHAIN_STATE_BLOCK,
      latestIndexedBlockHash: VALID_CHAIN_STATE_HASH,
      latestIndexedAt: now,
      workerAvailable: true,
      workerReady: true,
      workerReadinessReason: null,
      workerLifecycle: 'running',
      workerStartupComplete: true,
      workerLatestFinalizedBlock: VALID_CHAIN_STATE_BLOCK + 5,
      workerLatestIndexedBlock: VALID_CHAIN_STATE_BLOCK,
      workerLag: 5,
      workerLastSuccessfulIndexTimestamp: now,
    });
  });

  it('exposes Polkamarkt market and snapshot data', async () => {
    const repository = new MemoryRepository();
    // Probability/price numbers emulate documents persisted before the exact-string worker change.
    await repository.upsertMany([
      {
        collection: 'markets',
        id: '3',
        timestamp: 200,
        data: {
          id: '3',
          marketId: 3,
          conditionId: 0,
          title: 'Will KUSD stay at peg?',
          metadataUri: 'ipfs://metadata',
          metadataHash: `0x${'01'.repeat(32)}`,
          rulesUri: 'ipfs://rules',
          creatorFees: '0',
          volumeUSD: '250',
          probability: 50.66,
          priceYes: 0.5066,
          priceNo: 0.4933,
          mechanism: 'DynamicPariMutuel',
          virtualDepth: '100',
          dpmCollateral: '1200',
          realYesShares: '52',
          realNoShares: '48',
          marginalYesPriceBps: 7164,
          marginalNoPriceBps: 6976,
          impliedYesProbabilityBps: 5066,
          impliedNoProbabilityBps: 4933,
          resolutionEvidenceUri: 'ipfs://resolution',
          resolutionEvidenceHash: `0x${'02'.repeat(32)}`,
          resolutionEvidenceBlock: 99,
          cancellationEvidenceUri: null,
          cancellationEvidenceHash: null,
          cancellationEvidenceBlock: null,
          governancePallet: 'democracy',
          governanceBody: 'Democracy',
          governanceKind: 'Referendum',
          governanceReferendumIndex: 124,
        },
      },
      {
        collection: 'marketSnapshots',
        id: 'market-3-DEFAULT-180',
        timestamp: 180,
        data: {
          id: 'market-3-DEFAULT-180',
          marketId: 3,
          timestamp: 180,
          blockHeight: 90,
          type: 'DEFAULT',
          probability: 47.66,
          priceYes: 0.4766,
          priceNo: 0.5233,
          virtualDepth: '100',
          dpmCollateral: '1000',
          realYesShares: '43',
          realNoShares: '57',
          marginalYesPriceBps: 6733,
          marginalNoPriceBps: 7393,
          impliedYesProbabilityBps: 4766,
          impliedNoProbabilityBps: 5233,
          yesShares: '43',
          noShares: '57',
          liquidityUSD: '1000',
          volumeUSD: '200',
          status: 'Open',
        },
      },
      {
        collection: 'marketSnapshots',
        id: 'market-3-DEFAULT-240',
        timestamp: 240,
        data: {
          id: 'market-3-DEFAULT-240',
          marketId: 3,
          timestamp: 240,
          blockHeight: 120,
          type: 'DEFAULT',
          probability: 46,
          priceYes: 0.46,
          priceNo: 0.54,
          virtualDepth: '100',
          dpmCollateral: '1200',
          realYesShares: '38',
          realNoShares: '62',
          marginalYesPriceBps: 6484,
          marginalNoPriceBps: 7612,
          impliedYesProbabilityBps: 4600,
          impliedNoProbabilityBps: 5400,
          yesShares: '38',
          noShares: '62',
          liquidityUSD: '1200',
          volumeUSD: '250',
          status: 'Open',
        },
      },
    ]);
    const schema = createSchema();
    const marketFields = (schema.getType('Market') as { getFields?: () => Record<string, unknown> } | undefined)?.getFields?.() ?? {};
    const marketSnapshotFields =
      (schema.getType('MarketSnapshot') as { getFields?: () => Record<string, unknown> } | undefined)?.getFields?.() ?? {};

    expect(Object.keys(marketFields)).toEqual(
      expect.arrayContaining([
        'mechanism',
        'priceNo',
        'virtualDepth',
        'dpmCollateral',
        'realYesShares',
        'realNoShares',
        'marginalYesPriceBps',
        'marginalNoPriceBps',
        'impliedYesProbabilityBps',
        'impliedNoProbabilityBps',
      ])
    );
    expect(Object.keys(marketSnapshotFields)).toEqual(
      expect.arrayContaining([
        'virtualDepth',
        'dpmCollateral',
        'realYesShares',
        'realNoShares',
        'marginalYesPriceBps',
        'marginalNoPriceBps',
        'impliedYesProbabilityBps',
        'impliedNoProbabilityBps',
      ])
    );
    const marketType = schema.getType('Market') as GraphQLObjectType;
    const snapshotType = schema.getType('MarketSnapshot') as GraphQLObjectType;
    for (const field of ['probability', 'priceYes', 'priceNo']) {
      expect(String(marketType.getFields()[field]?.type)).toBe('String');
      expect(String(snapshotType.getFields()[field]?.type)).toBe('String');
    }
    expect(marketType.getFields().probability?.description).toContain('0 through 100');
    expect(marketType.getFields().priceYes?.description).toContain('0 through 1');
    expect(snapshotType.getFields().priceNo?.description).toContain('0 through 1');
    expect(
      marketType.getFields().probability?.resolve?.(
        { probability: 5e-7 },
        {},
        {},
        {} as GraphQLResolveInfo
      )
    ).toBe('0.0000005');
    expect(
      snapshotType.getFields().priceYes?.resolve?.(
        { priceYes: '000.506600' },
        {},
        {},
        {} as GraphQLResolveInfo
      )
    ).toBe('0.5066');
    expect(() => {
      snapshotType.getFields().priceNo?.resolve?.(
        { priceNo: Number.NaN },
        {},
        {},
        {} as GraphQLResolveInfo
      );
    }).toThrow('Indexed decimal quantity is invalid.');
    expect(() => {
      snapshotType.getFields().priceYes?.resolve?.(
        { priceYes: Number.MAX_SAFE_INTEGER + 1 },
        {},
        {},
        {} as GraphQLResolveInfo
      );
    }).toThrow('Indexed decimal quantity is invalid.');
    expect(() => {
      marketType.getFields().probability?.resolve?.(
        { probability: '100.01' },
        {},
        {},
        {} as GraphQLResolveInfo
      );
    }).toThrow('Indexed decimal quantity is invalid.');
    expect(() => {
      snapshotType.getFields().priceYes?.resolve?.(
        { priceYes: '1.01' },
        {},
        {},
        {} as GraphQLResolveInfo
      );
    }).toThrow('Indexed decimal quantity is invalid.');
    const marketsField = schema.getQueryType()?.getFields().markets;
    const marketSnapshotsField = schema.getQueryType()?.getFields().marketSnapshots;

    const markets = await marketsField?.resolve?.(
      {},
      { first: 10, orderBy: ['ID_ASC'] },
      { repository },
      {} as GraphQLResolveInfo
    );
    const snapshots = await marketSnapshotsField?.resolve?.(
      {},
      {
        first: 10,
        orderBy: ['TIMESTAMP_ASC'],
        filter: { marketId: { equalTo: 3 }, type: { equalTo: 'DEFAULT' } },
      },
      { repository },
      {} as GraphQLResolveInfo
    );

    expect(markets).toMatchObject({
      edges: [
        {
          node: {
            id: '3',
            marketId: 3,
            conditionId: 0,
            title: 'Will KUSD stay at peg?',
            metadataUri: 'ipfs://metadata',
            metadataHash: `0x${'01'.repeat(32)}`,
            rulesUri: 'ipfs://rules',
            creatorFees: '0',
            volumeUSD: '250',
            probability: 50.66,
            priceYes: 0.5066,
            priceNo: 0.4933,
            mechanism: 'DynamicPariMutuel',
            virtualDepth: '100',
            dpmCollateral: '1200',
            realYesShares: '52',
            realNoShares: '48',
            marginalYesPriceBps: 7164,
            marginalNoPriceBps: 6976,
            impliedYesProbabilityBps: 5066,
            impliedNoProbabilityBps: 4933,
            resolutionEvidenceUri: 'ipfs://resolution',
            resolutionEvidenceHash: `0x${'02'.repeat(32)}`,
            resolutionEvidenceBlock: 99,
            cancellationEvidenceUri: null,
            cancellationEvidenceHash: null,
            cancellationEvidenceBlock: null,
            governancePallet: 'democracy',
            governanceBody: 'Democracy',
            governanceKind: 'Referendum',
            governanceReferendumIndex: 124,
          },
        },
      ],
      totalCount: 1,
    });
    expect(snapshots).toMatchObject({
      edges: [
        {
          node: {
            id: 'market-3-DEFAULT-180',
            marketId: 3,
            probability: 47.66,
            priceYes: 0.4766,
            priceNo: 0.5233,
            virtualDepth: '100',
            dpmCollateral: '1000',
            realYesShares: '43',
            realNoShares: '57',
            marginalYesPriceBps: 6733,
            marginalNoPriceBps: 7393,
            impliedYesProbabilityBps: 4766,
            impliedNoProbabilityBps: 5233,
          },
        },
        {
          node: {
            id: 'market-3-DEFAULT-240',
            marketId: 3,
            probability: 46,
            priceYes: 0.46,
            priceNo: 0.54,
            virtualDepth: '100',
            dpmCollateral: '1200',
            realYesShares: '38',
            realNoShares: '62',
            marginalYesPriceBps: 6484,
            marginalNoPriceBps: 7612,
            impliedYesProbabilityBps: 4600,
            impliedNoProbabilityBps: 5400,
          },
        },
      ],
      totalCount: 2,
    });
  });

  it('canonicalizes every mobile quantity field without lossy default string coercion', () => {
    const schema = createSchema();
    const resolve = (typeName: string, fieldName: string, parent: Record<string, unknown>) =>
      (schema.getType(typeName) as GraphQLObjectType).getFields()[fieldName]?.resolve?.(
        parent,
        {},
        {},
        {} as GraphQLResolveInfo
      );

    expect(resolve('Asset', 'priceUSD', { priceUSD: '0001.2500' })).toBe('1.25');
    expect(String((schema.getType('Asset') as GraphQLObjectType).getFields().priceChangeDay?.type)).toBe('Float');
    expect(String((schema.getType('Asset') as GraphQLObjectType).getFields().volumeDayUSD?.type)).toBe('String');
    expect(resolve('Asset', 'volumeDayUSD', { volumeDayUSD: '999999999999999999999.1' })).toBe(
      '999999999999999999999.1'
    );
    expect(resolve('HistoryElement', 'networkFee', { networkFee: 5e-7 })).toBe('0.0000005');
    expect(resolve('AccountPosition', 'realizedPnlUsd', { realizedPnlUsd: '-001.2500' })).toBe('-1.25');
    expect(resolve('AccountTrade', 'realizedPnlUsd', { realizedPnlUsd: -0 })).toBe('0');
    expect(() =>
      resolve('Market', 'dpmCollateral', { dpmCollateral: Number.MAX_SAFE_INTEGER + 1 })
    ).toThrow('Indexed decimal quantity is invalid.');
    expect(() => resolve('MarketSnapshot', 'realYesShares', { realYesShares: '-1' })).toThrow(
      'Indexed decimal quantity is invalid.'
    );
    expect(() => resolve('PoolXYK', 'strategicBonusApy', { strategicBonusApy: true })).toThrow(
      'Indexed decimal quantity is invalid.'
    );
  });

  it('serves mobile app config for SORA iOS', async () => {
    const schema = createSchema();
    const mobileConfigField = schema.getQueryType()?.getFields().mobileConfig;

    expect(mobileConfigField?.resolve?.({}, {}, { repository: new MemoryRepository() }, {} as never)).toEqual({
      blockExplorerUrl: 'https://sorametrics.org/sorav2?tab=extrinsics&q={transaction}',
      substrateTypesUrl:
        'https://raw.githubusercontent.com/sora-xor/sora2-substrate-js-library/metadata14ios/packages/types/src/metadata/prod/types_scalecodec_mobile.json',
      soracard: false,
      nodes: [{ name: 'Sora', address: 'wss://mof2.sora.org' }],
      nexusAvailable: true,
      nexusSendsAvailable: false,
      polkamarktVisible: true,
      polkamarktMutationsAvailable: false,
      tairaDefaultVisible: true,
    });
  });

  it('declares every mobile capability as a non-null Boolean', () => {
    const mobileConfig = createSchema().getType('MobileConfig');
    expect(mobileConfig?.toString()).toBe('MobileConfig');
    const fields = (mobileConfig as GraphQLObjectType).getFields();
    for (const name of [
      'nexusAvailable',
      'nexusSendsAvailable',
      'polkamarktVisible',
      'polkamarktMutationsAvailable',
      'tairaDefaultVisible',
    ]) {
      expect(fields[name]?.type.toString()).toBe('Boolean!');
    }
  });

  it('projects explicitly admitted mobile capabilities without widening defaults', () => {
    const capabilities = {
      nexusAvailable: true,
      nexusSendsAvailable: true,
      polkamarktVisible: true,
      polkamarktMutationsAvailable: true,
      tairaDefaultVisible: true,
    };
    const schema = createSchema({
      graphqlCacheMaxEntries: 1,
      graphqlCacheMaxBytes: 1_024,
      graphqlCacheTtlMs: 1,
      mobileCapabilities: capabilities,
    });
    capabilities.nexusAvailable = false;
    const mobileConfigField = schema.getQueryType()?.getFields().mobileConfig;

    expect(
      mobileConfigField?.resolve?.(
        {},
        {},
        { repository: new MemoryRepository() },
        {} as never
      )
    ).toMatchObject({
      nexusAvailable: true,
      nexusSendsAvailable: true,
      polkamarktVisible: true,
      polkamarktMutationsAvailable: true,
      tairaDefaultVisible: true,
    });
  });

  it('derives Explore stats from active market documents and the latest day network snapshot', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      {
        collection: 'assets',
        id: 'asset-a',
        data: { id: 'asset-a', liquidity: '10', liquidityBooks: '0' },
      },
      {
        collection: 'assets',
        id: 'asset-b',
        data: { id: 'asset-b', liquidity: '0', liquidityBooks: '5' },
      },
      {
        collection: 'assets',
        id: 'asset-c',
        data: { id: 'asset-c', liquidity: '0', liquidityBooks: '0' },
      },
      {
        collection: 'poolXYKs',
        id: 'pool-a',
        data: { id: 'pool-a', baseAssetReserves: '1', targetAssetReserves: '2' },
      },
      {
        collection: 'poolXYKs',
        id: 'pool-b',
        data: { id: 'pool-b', baseAssetReserves: '0', targetAssetReserves: '2' },
      },
      {
        collection: 'orderBooks',
        id: 'book-a',
        data: { id: 'book-a' },
      },
      {
        collection: 'networkSnapshots',
        id: 'network-old',
        timestamp: 100,
        data: { id: 'network-old', type: 'DAY', timestamp: 100, liquidityUSD: '100.25', volumeUSD: '10.5' },
      },
      {
        collection: 'networkSnapshots',
        id: 'network-latest',
        timestamp: 200,
        data: { id: 'network-latest', type: 'DAY', timestamp: 200, liquidityUSD: '250.75', volumeUSD: '45.125' },
      },
    ]);

    const schema = createSchema();
    const exploreStatsField = schema.getQueryType()?.getFields().exploreStats;

    await expect(exploreStatsField?.resolve?.({}, {}, { repository }, {} as never)).resolves.toEqual({
      id: 'global',
      tokenCount: 2,
      poolCount: 1,
      orderBookCount: 1,
      liquidityUSD: '250.75',
      volumeDayUSD: '45.125',
      updatedAtTimestamp: 200,
    });
  });

  it('serves compact Polkamarkt signals from indexed documents', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      {
        collection: 'markets',
        id: '1',
        blockHeight: 10,
        timestamp: 100,
        data: {
          id: '1',
          marketId: 1,
          title: 'Open market',
          creator: 'alice',
          status: 'Open',
          liquidityUSD: '100.1',
          volumeUSD: '9007199254740993.1',
        },
      },
      {
        collection: 'markets',
        id: '2',
        blockHeight: 20,
        timestamp: 200,
        data: {
          id: '2',
          marketId: 2,
          title: 'Resolved market',
          creator: 'bob',
          status: 'Resolved',
          resolutionOutcome: 'Yes',
          closeBlock: 50,
          liquidityUSD: '0.2',
          volumeUSD: '0.2',
        },
      },
      {
        collection: 'marketSnapshots',
        id: 'snapshot-2-default',
        blockHeight: 45,
        timestamp: 150,
        data: {
          id: 'snapshot-2-default',
          marketId: 2,
          type: 'DEFAULT',
          blockHeight: 45,
          timestamp: 150,
          probability: 75,
        },
      },
      {
        collection: 'historyElements',
        id: 'history-a',
        timestamp: 210,
        data: {
          id: 'history-a',
          module: 'polkamarkt',
          address: 'charlie',
          dataFrom: 'alice',
        },
      },
      {
        collection: 'networkSnapshots',
        id: 'network-old',
        timestamp: 100,
        data: { id: 'network-old', type: 'DAY', timestamp: 100, accounts: 1, liquidityUSD: '50', volumeUSD: '5' },
      },
      {
        collection: 'networkSnapshots',
        id: 'network-new',
        timestamp: 200,
        data: { id: 'network-new', type: 'DAY', timestamp: 200, accounts: 3, liquidityUSD: '100', volumeUSD: '30' },
      },
    ]);

    const schema = createSchema();
    const signalType = schema.getType('PolkamarktSignals') as GraphQLObjectType;
    const signalPointType = schema.getType('PolkamarktSignalPoint') as GraphQLObjectType;
    const signalAnswerType = schema.getType('PolkamarktSignalAnswerBreakdown') as GraphQLObjectType;
    const signalAccuracyMarketType = schema.getType('PolkamarktSignalAccuracyMarket') as GraphQLObjectType;
    const marketType = schema.getType('Market') as GraphQLObjectType;
    const marketSnapshotType = schema.getType('MarketSnapshot') as GraphQLObjectType;
    const accountPositionType = schema.getType('AccountPosition') as GraphQLObjectType;
    const accountTradeType = schema.getType('AccountTrade') as GraphQLObjectType;
    expect(String(signalType.getFields().totalVolumeUsd?.type)).toBe('String!');
    expect(String(signalType.getFields().liquidityUsd?.type)).toBe('String!');
    expect(String(signalPointType.getFields().value?.type)).toBe('String!');
    expect(String(signalAnswerType.getFields().volumeUsd?.type)).toBe('String!');
    expect(String(signalAccuracyMarketType.getFields().marketId?.type)).toBe('UInt32!');
    expect(String(marketType.getFields().marketId?.type)).toBe('UInt32');
    expect(String(marketType.getFields().conditionId?.type)).toBe('UInt32');
    expect(String(marketType.getFields().closeBlock?.type)).toBe('UInt32');
    expect(String(marketSnapshotType.getFields().marketId?.type)).toBe('UInt32');
    expect(String(accountPositionType.getFields().marketId?.type)).toBe('UInt32');
    expect(String(accountTradeType.getFields().marketId?.type)).toBe('UInt32');
    expect(
      signalPointType.getFields().value?.resolve?.(
        { value: 1e-7 },
        {},
        {},
        {} as GraphQLResolveInfo
      )
    ).toBe('0.0000001');

    const signalsField = schema.getQueryType()?.getFields().polkamarktSignals;
    const signals = await signalsField?.resolve?.({}, {}, { repository }, {} as never);

    expect(signals).toMatchObject({
      totalVolumeUsd: '9007199254740993.3',
      activeMarkets: 1,
      activeAccounts: 3,
      liquidityUsd: '100.3',
      answerBreakdown: [],
      liquiditySeries: [
        { value: '50' },
        { value: '100' },
      ],
      accuracySummary: {
        scoredMarkets: 1,
        resolvedMarkets: 1,
        correctMarkets: 1,
        accuracyPercent: 100,
        averageConfidencePercent: 75,
        latest: {
          marketId: 2,
          title: 'Resolved market',
          outcome: 'YES',
          predictedOutcome: 'YES',
          confidencePercent: 75,
          yesProbability: 75,
          correct: true,
        },
      },
      accuracySeries: [{ value: 100, correctMarkets: 1, scoredMarkets: 1 }],
    });
  });

  it('keeps probability percentages distinct from unit prices and recognizes every active status', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      {
        collection: 'markets',
        id: '1',
        data: {
          id: '1',
          marketId: 1,
          title: 'Active market',
          creator: 'alice',
          status: 'Active',
          liquidityUSD: '0',
          volumeUSD: '0',
        },
      },
      {
        collection: 'markets',
        id: '2',
        data: {
          id: '2',
          marketId: 2,
          title: 'Live market',
          creator: 'bob',
          status: 'Live',
          liquidityUSD: '0',
          volumeUSD: '0',
        },
      },
      {
        collection: 'markets',
        id: '3',
        data: {
          id: '3',
          marketId: 3,
          title: 'One percent YES',
          creator: 'carol',
          status: 'Resolved',
          resolutionOutcome: 'No',
          closeBlock: 50,
          liquidityUSD: '0',
          volumeUSD: '0',
        },
      },
      {
        collection: 'marketSnapshots',
        id: 'snapshot-3-default',
        blockHeight: 45,
        timestamp: 150,
        data: {
          id: 'snapshot-3-default',
          marketId: 3,
          type: 'DEFAULT',
          blockHeight: 45,
          timestamp: 150,
          probability: '1',
          priceYes: '0.01',
        },
      },
      {
        collection: 'markets',
        id: '4',
        data: {
          id: '4',
          marketId: 4,
          title: 'Malformed probability',
          creator: 'dave',
          status: 'Resolved',
          resolutionOutcome: 'Yes',
          closeBlock: 50,
          liquidityUSD: '0',
          volumeUSD: '0',
        },
      },
      {
        collection: 'marketSnapshots',
        id: 'snapshot-4-default',
        blockHeight: 45,
        timestamp: 151,
        data: {
          id: 'snapshot-4-default',
          marketId: 4,
          type: 'DEFAULT',
          blockHeight: 45,
          timestamp: 151,
          probability: true,
        },
      },
    ]);

    const signalsField = createSchema().getQueryType()?.getFields().polkamarktSignals;
    const signals = await signalsField?.resolve?.({}, {}, { repository }, {} as never);

    expect(signals).toMatchObject({
      activeMarkets: 2,
      accuracySummary: {
        scoredMarkets: 1,
        resolvedMarkets: 2,
        correctMarkets: 1,
        accuracyPercent: 100,
        averageConfidencePercent: 99,
        latest: {
          marketId: 3,
          predictedOutcome: 'NO',
          confidencePercent: 99,
          yesProbability: 1,
          correct: true,
        },
      },
    });
  });

  it('starts bounded Polkamarkt signal scans without total counts', async () => {
    const queryCalls: Array<{ collection: string; args: RepositoryQueryArgs }> = [];
    const repository = repositoryWithQuery(async (collection, args) => {
      queryCalls.push({ collection, args });

      return {
        items: [],
        totalCount: args.includeTotalCount === false ? null : 0,
      };
    });
    const signalsField = createSchema().getQueryType()?.getFields().polkamarktSignals;

    await signalsField?.resolve?.({}, {}, { repository }, {} as never);

    expect(queryCalls).toHaveLength(3);
    expect(queryCalls.map((call) => call.collection)).toEqual(['markets', 'historyElements', 'networkSnapshots']);
    expect(queryCalls.map((call) => call.args.includeTotalCount)).toEqual([false, false, false]);
    expect(queryCalls.map((call) => call.args.first)).toEqual([1_000, 1_000, 8]);
    expect(queryCalls.map((call) => call.args.orderBy)).toEqual([
      ['ID_ASC'],
      ['ID_ASC'],
      ['TIMESTAMP_DESC'],
    ]);
    expect(queryCalls.map((call) => call.args.maxBytes)).toEqual([
      64 * 1_024 * 1_024,
      64 * 1_024 * 1_024,
      64 * 1_024 * 1_024,
    ]);
  });

  it('paginates Polkamarkt signals beyond the first 1,000 documents', async () => {
    const firstMarketPage: IndexerDocument[] = Array.from({ length: 1_000 }, (_, index) => ({
      collection: 'markets',
      id: `market-${String(index).padStart(4, '0')}`,
      timestamp: index,
      data: {
        id: `market-${String(index).padStart(4, '0')}`,
        creator: `creator-${index}`,
        status: 'Open',
        volumeUSD: '1',
        liquidityUSD: '2',
      },
    }));
    const finalMarket: IndexerDocument = {
      collection: 'markets',
      id: 'market-1000',
      timestamp: 1_000,
      data: {
        id: 'market-1000',
        creator: 'creator-1000',
        status: 'Open',
        volumeUSD: '1',
        liquidityUSD: '2',
      },
    };
    const marketQueries: RepositoryQueryArgs[] = [];
    const repository = repositoryWithQuery(async (collection, args) => {
      if (collection === 'markets') {
        marketQueries.push(args);
        return args.keyset
          ? { items: [finalMarket], totalCount: null, hasNextPage: false }
          : { items: firstMarketPage, totalCount: null, hasNextPage: true };
      }
      return { items: [], totalCount: null, hasNextPage: false };
    });
    const signalsField = createSchema().getQueryType()?.getFields().polkamarktSignals;
    const signals = await signalsField?.resolve?.({}, {}, { repository }, {} as never);

    expect(signals).toMatchObject({
      totalVolumeUsd: '1001',
      liquidityUsd: '2002',
      activeMarkets: 1_001,
      activeAccounts: 1_001,
    });
    expect(marketQueries).toHaveLength(2);
    expect(marketQueries[1]?.keyset).toEqual({
      scope: createRepositoryCursorScope('markets', ['ID_ASC'], {}),
      field: 'id',
      value: 'market-0999',
      id: 'market-0999',
      direction: 'asc',
      numeric: false,
    });
  });

  it('rejects repeated Polkamarkt signal pages instead of double-counting them', async () => {
    const repeatedMarket: IndexerDocument = {
      collection: 'markets',
      id: 'market-repeated',
      timestamp: 10,
      data: {
        id: 'market-repeated',
        status: 'Open',
        volumeUSD: '1',
        liquidityUSD: '1',
      },
    };
    const repository = repositoryWithQuery(async (collection) =>
      collection === 'markets'
        ? { items: [repeatedMarket], totalCount: null, hasNextPage: true }
        : { items: [], totalCount: null, hasNextPage: false }
    );
    const signalsField = createSchema().getQueryType()?.getFields().polkamarktSignals;

    await expect(signalsField?.resolve?.({}, {}, { repository }, {} as never)).rejects.toThrow(
      'repeated markets document'
    );
  });

  it('fails closed when indexed Polkamarkt signal quantities are malformed', async () => {
    const malformedMarket: IndexerDocument = {
      collection: 'markets',
      id: 'invalid-quantity',
      data: {
        id: 'invalid-quantity',
        status: 'Open',
        liquidityUSD: '1',
        volumeUSD: '1e3',
      },
    };
    const repository = repositoryWithQuery(async (collection) => ({
      items: collection === 'markets' ? [malformedMarket] : [],
      totalCount: null,
      hasNextPage: false,
    }));
    const signalsField = createSchema().getQueryType()?.getFields().polkamarktSignals;

    await expect(
      signalsField?.resolve?.({}, {}, { repository }, {} as GraphQLResolveInfo)
    ).rejects.toMatchObject({
      message: 'Indexed decimal quantity is invalid.',
      extensions: { code: 'INDEXED_DECIMAL_INVALID' },
    });
  });

  it('serves the stats page GraphQL data from network snapshots', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      {
        collection: 'assets',
        id: 'asset-a',
        data: { id: 'asset-a', liquidity: '10', liquidityBooks: '0' },
      },
      {
        collection: 'assets',
        id: 'asset-b',
        data: { id: 'asset-b', liquidity: '0', liquidityBooks: '5' },
      },
      {
        collection: 'assets',
        id: 'asset-c',
        data: { id: 'asset-c', liquidity: '0', liquidityBooks: '0' },
      },
      {
        collection: 'poolXYKs',
        id: 'pool-a',
        data: { id: 'pool-a', baseAssetReserves: '1', targetAssetReserves: '2' },
      },
      {
        collection: 'orderBooks',
        id: 'book-a',
        data: { id: 'book-a' },
      },
      {
        collection: 'networkSnapshots',
        id: 'network-day-old',
        timestamp: 100,
        data: {
          id: 'network-day-old',
          type: 'DAY',
          timestamp: 100,
          liquidityUSD: '100.25',
          volumeUSD: '10.5',
        },
      },
      {
        collection: 'networkSnapshots',
        id: 'network-hour',
        timestamp: 150,
        data: {
          id: 'network-hour',
          type: 'HOUR',
          timestamp: 150,
          accounts: 20,
          transactions: 30,
          fees: '123456789',
          liquidityUSD: '250.75',
          poolLiquidityUSD: '200.5',
          orderBookLiquidityUSD: '50.25',
          volumeUSD: '45.125',
          swaps: 7,
          activePools: 4,
          activeOrderBooks: 3,
          listedAssets: 9,
          bridgeIncomingTransactions: 1,
          bridgeOutgoingTransactions: 2,
        },
      },
    ]);

    const schema = createSchema();
    const exploreStatsField = schema.getQueryType()?.getFields().exploreStats;
    const networkSnapshotsField = schema.getQueryType()?.getFields().networkSnapshots;
    const exploreStats = await exploreStatsField?.resolve?.({}, {}, { repository }, {} as never);
    const networkSnapshots = await networkSnapshotsField?.resolve?.(
      {},
      {
        first: 10,
        orderBy: ['TIMESTAMP_DESC'],
        filter: {
          type: { equalTo: 'HOUR' },
          timestamp: { lessThanOrEqualTo: 200, greaterThanOrEqualTo: 120 },
        },
      },
      { repository },
      {} as never
    );

    expect(exploreStats).toEqual({
      id: 'global',
      tokenCount: 2,
      poolCount: 1,
      orderBookCount: 1,
      liquidityUSD: '100.25',
      volumeDayUSD: '10.5',
      updatedAtTimestamp: 100,
    });
    expect(networkSnapshots).toMatchObject({
      edges: [
        {
          cursor: opaqueCursor(),
          node: {
            id: 'network-hour',
            type: 'HOUR',
            timestamp: 150,
            accounts: 20,
            transactions: 30,
            fees: '123456789',
            liquidityUSD: '250.75',
            poolLiquidityUSD: '200.5',
            orderBookLiquidityUSD: '50.25',
            volumeUSD: '45.125',
            swaps: 7,
            activePools: 4,
            activeOrderBooks: 3,
            listedAssets: 9,
            bridgeIncomingTransactions: 1,
            bridgeOutgoingTransactions: 2,
          },
        },
      ],
      totalCount: 1,
      pageInfo: {
        endCursor: opaqueCursor(),
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: opaqueCursor(),
      },
    });
  });

  it('counts unique transaction-active accounts over a stats range', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      {
        collection: 'accountTransactions',
        id: 'tx-a-alice',
        timestamp: 100,
        data: { id: 'tx-a-alice', accountId: 'alice', historyElementId: 'tx-a', timestamp: 100 },
      },
      {
        collection: 'accountTransactions',
        id: 'tx-b-alice',
        timestamp: 150,
        data: { id: 'tx-b-alice', accountId: 'alice', historyElementId: 'tx-b', timestamp: 150 },
      },
      {
        collection: 'accountTransactions',
        id: 'tx-c-bob',
        timestamp: 200,
        data: { id: 'tx-c-bob', accountId: 'bob', historyElementId: 'tx-c', timestamp: 200 },
      },
      {
        collection: 'accountTransactions',
        id: 'tx-d-old',
        timestamp: 50,
        data: { id: 'tx-d-old', accountId: 'old', historyElementId: 'tx-d', timestamp: 50 },
      },
      {
        collection: 'accountTransactions',
        id: 'tx-e-external',
        timestamp: 160,
        data: { id: 'tx-e-external', accountId: '0xexternal', historyElementId: 'tx-e', timestamp: 160 },
      },
      {
        collection: 'accountTransactions',
        id: 'tx-f-malformed',
        timestamp: 170,
        data: { id: 'tx-f-malformed', accountId: '<script>alert(1)</script>', historyElementId: 'tx-f', timestamp: 170 },
      },
    ]);

    const schema = createSchema();
    const activityField = schema.getQueryType()?.getFields().networkAccountActivity;

    await expect(activityField?.resolve?.({}, { from: 220, to: 90 }, { repository }, {} as never)).resolves.toEqual({
      id: 'network-account-activity-90-220',
      from: 90,
      to: 220,
      activeAccounts: 2,
    });
  });

  it('counts active accounts across seek-paginated account activity pages without duplicates', async () => {
    const repository = new MemoryRepository();
    const accounts = Array.from({ length: 1_005 }, (_item, index) => ss58FixtureAccount(index));

    await repository.upsertMany([
      ...accounts.map((accountId, index) => ({
        collection: 'accountTransactions' as const,
        id: `paged-${String(index).padStart(4, '0')}`,
        timestamp: 120,
        data: { id: `paged-${String(index).padStart(4, '0')}`, accountId, historyElementId: `paged-${index}`, timestamp: 120 },
      })),
      {
        collection: 'accountTransactions',
        id: 'paged-duplicate',
        timestamp: 120,
        data: { id: 'paged-duplicate', accountId: accounts[0], historyElementId: 'paged-duplicate', timestamp: 120 },
      },
      {
        collection: 'accountTransactions',
        id: 'paged-malformed',
        timestamp: 120,
        data: { id: 'paged-malformed', accountId: 'attacker', historyElementId: 'paged-malformed', timestamp: 120 },
      },
      {
        collection: 'accountTransactions',
        id: 'paged-before-range',
        timestamp: 89,
        data: { id: 'paged-before-range', accountId: ss58FixtureAccount(1_006), historyElementId: 'paged-before-range', timestamp: 89 },
      },
      {
        collection: 'accountTransactions',
        id: 'paged-after-range',
        timestamp: 131,
        data: { id: 'paged-after-range', accountId: ss58FixtureAccount(1_007), historyElementId: 'paged-after-range', timestamp: 131 },
      },
    ]);

    const schema = createSchema();
    const activityField = schema.getQueryType()?.getFields().networkAccountActivity;

    await expect(activityField?.resolve?.({}, { from: 90, to: 130 }, { repository }, {} as never)).resolves.toMatchObject({
      activeAccounts: 1_005,
    });
  });

  it('does not scan account activity collections for invalid timestamp ranges', async () => {
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'accountTransactions',
      id: 'tx-a-alice',
      timestamp: 100,
      data: { id: 'tx-a-alice', accountId: 'alice', historyElementId: 'tx-a', timestamp: 100 },
    });
    const querySpy = vi.spyOn(repository, 'query');
    const getSpy = vi.spyOn(repository, 'get');
    const schema = createSchema();
    const activityField = schema.getQueryType()?.getFields().networkAccountActivity;

    await expect(activityField?.resolve?.({}, { from: -1, to: 130 }, { repository }, {} as never)).resolves.toEqual({
      id: 'network-account-activity-invalid',
      from: 0,
      to: 0,
      activeAccounts: 0,
    });
    await expect(activityField?.resolve?.({}, { from: Number.NaN, to: 130 }, { repository }, {} as never)).resolves.toEqual({
      id: 'network-account-activity-invalid',
      from: 0,
      to: 0,
      activeAccounts: 0,
    });
    expect(querySpy).not.toHaveBeenCalled();
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('rejects whole-chain account activity ranges before repository access', async () => {
    const repository = new MemoryRepository();
    const querySpy = vi.spyOn(repository, 'query');
    const getSpy = vi.spyOn(repository, 'get');
    const activityField = createSchema().getQueryType()?.getFields().networkAccountActivity;

    await expect(
      activityField?.resolve?.(
        {},
        { from: 0, to: NETWORK_ACCOUNT_ACTIVITY_MAX_RANGE_SECONDS + 1 },
        { repository },
        {} as never
      )
    ).rejects.toThrow('range exceeds');
    expect(querySpy).not.toHaveBeenCalled();
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('applies one document budget across seek-paginated account activity scans', async () => {
    const pageSize = 1_000;
    const page = Array.from({ length: pageSize }, (_item, index) => ({
      collection: 'accountTransactions' as const,
      id: `budget-${String(index).padStart(4, '0')}`,
      timestamp: 100,
      data: { id: `budget-${index}`, accountId: ss58FixtureAccount(0), timestamp: 100 },
    }));
    const query = vi.fn<QueryFunction>().mockResolvedValue({
      items: page,
      itemCursors: [],
      totalCount: null,
      pageStart: 0,
      hasNextPage: true,
      hasPreviousPage: false,
    });
    const repository = repositoryWithQuery(query);
    const activityField = createSchema().getQueryType()?.getFields().networkAccountActivity;

    await expect(
      activityField?.resolve?.({}, { from: 90, to: 130 }, { repository }, {} as never)
    ).rejects.toThrow(`${NETWORK_ACCOUNT_ACTIVITY_MAX_DOCUMENTS}-document scan budget`);
    expect(query).toHaveBeenCalledTimes(NETWORK_ACCOUNT_ACTIVITY_MAX_DOCUMENTS / pageSize);
    expect(query).toHaveBeenNthCalledWith(
      1,
      'accountTransactions',
      expect.objectContaining({ maxBytes: 8 * 1_024 * 1_024 })
    );
  });

  it('normalizes reversed active-account ranges before cache lookup', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      {
        collection: 'accountTransactions',
        id: 'tx-a-alice',
        timestamp: 100,
        data: { id: 'tx-a-alice', accountId: 'alice', historyElementId: 'tx-a', timestamp: 100 },
      },
    ]);
    const querySpy = vi.spyOn(repository, 'query');
    const schema = createSchema();
    const activityField = schema.getQueryType()?.getFields().networkAccountActivity;

    await expect(activityField?.resolve?.({}, { from: 130, to: 90 }, { repository }, {} as never)).resolves.toMatchObject({
      id: 'network-account-activity-90-130',
      activeAccounts: 1,
    });
    await expect(activityField?.resolve?.({}, { from: 90, to: 130 }, { repository }, {} as never)).resolves.toMatchObject({
      id: 'network-account-activity-90-130',
      activeAccounts: 1,
    });
    expect(querySpy).toHaveBeenCalledTimes(1);
  });

  it('uses only account transaction rows for activity', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      {
        collection: 'accountTransactions',
        id: 'tx-a-alice',
        timestamp: 100,
        data: { id: 'tx-a-alice', accountId: 'alice', historyElementId: 'tx-a', timestamp: 100 },
      },
    ]);

    const schema = createSchema();
    const activityField = schema.getQueryType()?.getFields().networkAccountActivity;

    await expect(activityField?.resolve?.({}, { from: 90, to: 130 }, { repository }, {} as never)).resolves.toMatchObject({
      activeAccounts: 1,
    });
  });

  it('keeps legacy Polkamarkt account activity fields schema-compatible', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      {
        collection: 'accountTransactions',
        id: 'history-a-alice',
        blockHeight: 12,
        timestamp: 200,
        data: {
          id: 'history-a-alice',
          accountId: 'alice',
          historyElementId: 'history-a',
          marketId: 4_294_967_295,
          marketIds: [4_294_967_295],
          module: 'polkamarkt',
          side: 'buy',
          outcome: 'YES',
          toOutcome: 'YES',
          collateralUsd: '5',
          shares: '10',
          sharesIn: '10',
          price: '0.5',
          blockHash: '0xabc',
          blockHeight: 12,
          timestamp: 200,
        },
      },
      {
        collection: 'accountTransactions',
        id: 'transfer-a-alice',
        blockHeight: 13,
        timestamp: 210,
        data: {
          id: 'transfer-a-alice',
          accountId: 'alice',
          historyElementId: 'transfer-a',
          module: 'assets',
          method: 'transfer',
          blockHeight: 13,
          timestamp: 210,
        },
      },
      {
        collection: 'accountTransactions',
        id: 'claim-noop-alice',
        blockHeight: 14,
        timestamp: 220,
        data: {
          id: 'claim-noop-alice',
          accountId: 'alice',
          historyElementId: 'claim-noop',
          module: 'polkamarkt',
          method: 'claim_markets',
          blockHeight: 14,
          timestamp: 220,
        },
      },
      {
        collection: 'historyElements',
        id: 'history-a',
        blockHeight: 12,
        timestamp: 200,
        data: {
          id: 'history-a',
          timestamp: 200,
          blockHash: '0xabc',
          blockHeight: 12,
          module: 'polkamarkt',
          method: 'buy',
          address: 'alice',
          data: {
            marketId: 7,
            outcome: 'YES',
            collateralUsd: '5',
            shares: '10',
            price: '0.5',
          },
        },
      },
      {
        collection: 'accountPositions',
        id: '7-alice',
        blockHeight: 12,
        timestamp: 200,
        data: {
          id: '7-alice',
          account: 'alice',
          marketId: 7,
          outcome: 'Yes',
          shares: '10',
          yesShares: '10',
          noShares: '0',
          netCollateralPaid: '5',
          claimablePayoutUsd: '0',
          isCreator: false,
          status: 'Open',
          updatedAt: '1970-01-01T00:03:20.000Z',
          market: { id: '7', marketId: 7 },
        },
      },
    ]);
    const schema = createSchema();
    const queryFields = schema.getQueryType()?.getFields();
    const positionsField = queryFields?.accountPositions;
    const tradesField = queryFields?.accountTrades;
    const getManySpy = vi.spyOn(repository, 'getMany');
    const accountTradeFields = (schema.getType('AccountTrade') as GraphQLObjectType | undefined)?.getFields() ?? {};

    expect(positionsField?.args.map((arg) => arg.name)).toContain('where');
    expect(tradesField?.args.map((arg) => arg.name)).toContain('where');
    expect(Object.keys(accountTradeFields)).toEqual(
      expect.arrayContaining(['marketIds', 'fromOutcome', 'toOutcome', 'sharesIn', 'sharesOut'])
    );
    expect(String(accountTradeFields.marketIds?.type)).toBe('[UInt32!]!');

    const positions = await positionsField?.resolve?.(
      {},
      { where: { account_eq: 'alice' }, first: 10, orderBy: ['UPDATED_AT_DESC'] },
      { repository },
      {} as never
    );
    const trades = (await tradesField?.resolve?.(
      {},
      { where: { account_eq: 'alice' }, first: 10, orderBy: ['TIMESTAMP_DESC'] },
      { repository },
      {} as never
    )) as { edges: Array<{ node: Record<string, unknown> }>; totalCount: number };

    expect(positions).toMatchObject({
      totalCount: 1,
      edges: [
        {
          node: {
            id: '7-alice',
            account: 'alice',
            marketId: 7,
            yesShares: '10',
            noShares: '0',
            netCollateralPaid: '5',
            isCreator: false,
            market: { id: '7', marketId: 7 },
          },
        },
      ],
    });
    expect(trades.totalCount).toBe(1);
    expect(trades.edges[0]?.node).toMatchObject({
      id: 'history-a-alice',
      account: 'alice',
      marketId: 4_294_967_295,
      marketIds: [4_294_967_295],
      side: 'buy',
      outcome: 'YES',
      toOutcome: 'YES',
      collateralUsd: '5',
      shares: '10',
      sharesIn: '10',
      price: '0.5',
      timestamp: '1970-01-01T00:03:20.000Z',
      blockNumber: 12,
      blockHash: '0xabc',
      extrinsicHash: 'history-a',
      market: { id: '4294967295', marketId: 4_294_967_295 },
    });
    expect(getManySpy).not.toHaveBeenCalled();
  });

  it('rejects inconsistent Polkamarkt batch identifiers in account trade projections', async () => {
    const repository = repositoryWithQuery(async (collection) => ({
      items:
        collection === 'accountTransactions'
          ? [
              {
                collection: 'accountTransactions',
                id: 'invalid-batch-alice',
                blockHeight: 12,
                timestamp: 200,
                data: {
                  id: 'invalid-batch-alice',
                  accountId: 'alice',
                  historyElementId: 'invalid-batch',
                  module: 'polkamarkt',
                  marketId: 7,
                  marketIds: [8, 7],
                },
              },
            ]
          : [],
      totalCount: 1,
      hasNextPage: false,
    }));
    const tradesField = createSchema().getQueryType()?.getFields().accountTrades;

    await expect(
      tradesField?.resolve?.(
        {},
        { where: { account_eq: 'alice' }, first: 10 },
        { repository },
        {} as never
      )
    ).rejects.toMatchObject({
      message: 'Indexed Polkamarkt market identifiers are inconsistent',
      extensions: { code: 'INDEXED_UINT32_INVALID' },
    });
  });

  it('merges Polkamarkt account position account aliases with caller filters', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      {
        collection: 'accountPositions',
        id: '7-alice',
        blockHeight: 12,
        timestamp: 200,
        data: {
          id: '7-alice',
          account: 'alice',
          marketId: 7,
          status: 'Open',
          updatedAt: '1970-01-01T00:03:20.000Z',
        },
      },
      {
        collection: 'accountPositions',
        id: '8-alice',
        blockHeight: 13,
        timestamp: 220,
        data: {
          id: '8-alice',
          account: 'alice',
          marketId: 8,
          status: 'Open',
          updatedAt: '1970-01-01T00:03:40.000Z',
        },
      },
      {
        collection: 'accountPositions',
        id: '7-alice-closed',
        blockHeight: 14,
        timestamp: 240,
        data: {
          id: '7-alice-closed',
          account: 'alice',
          marketId: 7,
          status: 'Closed',
          updatedAt: '1970-01-01T00:04:00.000Z',
        },
      },
      {
        collection: 'accountPositions',
        id: '7-bob',
        blockHeight: 15,
        timestamp: 260,
        data: {
          id: '7-bob',
          account: 'bob',
          marketId: 7,
          status: 'Open',
          updatedAt: '1970-01-01T00:04:20.000Z',
        },
      },
    ]);
    const positionsField = createSchema().getQueryType()?.getFields().accountPositions;

    const positions = (await positionsField?.resolve?.(
      {},
      {
        where: { account_eq: 'alice', marketId: { equalTo: 7 } },
        filter: { status: { equalTo: 'Open' } },
        first: 10,
        orderBy: ['UPDATED_AT_DESC'],
      },
      { repository },
      {} as never
    )) as { edges: Array<{ node: Record<string, unknown> }>; totalCount: number };

    expect(positions.totalCount).toBe(1);
    expect(positions.edges.map((edge) => edge.node.id)).toEqual(['7-alice']);
  });

  it('preserves complete account predicates when querying account trades', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      {
        collection: 'accountTransactions',
        id: 'alice-trade',
        timestamp: 20,
        data: { id: 'alice-trade', accountId: 'alice', timestamp: 20, module: 'polkamarkt', marketId: 7 },
      },
      {
        collection: 'accountTransactions',
        id: 'bob-trade',
        timestamp: 10,
        data: { id: 'bob-trade', accountId: 'bob', timestamp: 10, module: 'polkamarkt', marketId: 8 },
      },
      {
        collection: 'accountTransactions',
        id: 'alice-transfer',
        timestamp: 30,
        data: { id: 'alice-transfer', accountId: 'alice', timestamp: 30, module: 'assets' },
      },
    ]);
    const tradesField = createSchema().getQueryType()?.getFields().accountTrades;

    const alternatives = (await tradesField?.resolve?.(
      {},
      {
        first: 10,
        orderBy: ['TIMESTAMP_DESC'],
        filter: {
          or: [
            { account: { equalTo: 'alice' } },
            { account: { equalTo: 'bob' } },
          ],
        },
      },
      { repository },
      {} as never
    )) as { edges: Array<{ node: Record<string, unknown> }>; totalCount: number };
    const conflicting = (await tradesField?.resolve?.(
      {},
      {
        first: 10,
        where: { account_eq: 'alice' },
        filter: { account: { equalTo: 'bob' } },
      },
      { repository },
      {} as never
    )) as { edges: Array<{ node: Record<string, unknown> }>; totalCount: number };
    const unbound = (await tradesField?.resolve?.(
      {},
      { first: 10, orderBy: ['TIMESTAMP_DESC'] },
      { repository },
      {} as never
    )) as { edges: Array<{ node: Record<string, unknown> }>; totalCount: number };

    expect(alternatives.totalCount).toBe(2);
    expect(alternatives.edges.map(({ node }) => [node.id, node.account])).toEqual([
      ['alice-trade', 'alice'],
      ['bob-trade', 'bob'],
    ]);
    expect(conflicting).toMatchObject({ totalCount: 0, edges: [] });
    expect(unbound).toMatchObject({ totalCount: 0, edges: [] });
  });

  it('serves SubQuery-compatible asset connections', async () => {
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'assets',
      id: 'asset-a',
      data: {
        id: 'asset-a',
        priceUSD: '2',
        liquidity: '1000000000000000000',
        liquidityBooks: '0',
      },
    });

    const schema = createSchema();
    const assetsField = schema.getQueryType()?.getFields().assets;
    const result = await assetsField?.resolve?.(
      {},
      {
        filter: { liquidity: { greaterThan: '0' } },
        orderBy: ['ID_ASC'],
      },
      { repository },
      {} as never
    );

    expect(result).toMatchObject({
      totalCount: 1,
      edges: [
        {
          cursor: opaqueCursor(),
          node: {
            id: 'asset-a',
            priceUSD: '2',
            liquidity: '1000000000000000000',
            liquidityBooks: '0',
          },
        },
      ],
      pageInfo: {
        endCursor: opaqueCursor(),
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: opaqueCursor(),
      },
    });
  });

  it('emits scoped opaque keyset cursors and rejects order mismatches', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      {
        collection: 'assets',
        id: 'asset-a',
        timestamp: 10,
        data: { id: 'asset-a', timestamp: 10, priceUSD: '1', liquidity: '1', liquidityBooks: '0' },
      },
      {
        collection: 'assets',
        id: 'asset-b',
        timestamp: 20,
        data: { id: 'asset-b', timestamp: 20, priceUSD: '2', liquidity: '1', liquidityBooks: '0' },
      },
    ]);
    const query = vi.spyOn(repository, 'query');
    const assetsField = createSchema().getQueryType()?.getFields().assets;
    const firstPage = (await assetsField?.resolve?.(
      {},
      { first: 1, orderBy: ['ID_ASC'] },
      { repository },
      {} as never
    )) as { edges: Array<{ cursor: string; node: { id: string } }> };
    const cursor = firstPage.edges[0]?.cursor;

    expect(cursor).toMatch(/^psc2\./);
    expect(decodeRepositoryCursor(cursor)).toEqual({
      scope: createRepositoryCursorScope('assets', ['ID_ASC'], undefined),
      field: 'id',
      direction: 'asc',
      numeric: false,
      value: 'asset-a',
      id: 'asset-a',
    });

    const secondPage = (await assetsField?.resolve?.(
      {},
      { first: 1, after: cursor, orderBy: ['ID_ASC'] },
      { repository },
      {} as never
    )) as { edges: Array<{ cursor: string; node: { id: string } }> };

    expect(secondPage.edges.map((edge) => edge.node.id)).toEqual(['asset-b']);
    expect(query.mock.calls[1]?.[1]).toMatchObject({
      after: null,
      keyset: {
        scope: createRepositoryCursorScope('assets', ['ID_ASC'], undefined),
        field: 'id',
        direction: 'asc',
        value: 'asset-a',
        id: 'asset-a',
      },
    });
    expect(decodeRepositoryCursor(secondPage.edges[0]?.cursor)).toMatchObject({
      id: 'asset-b',
      value: 'asset-b',
    });

    await expect(
      assetsField?.resolve?.(
        {},
        { first: 1, after: cursor, orderBy: ['ID_DESC'] },
        { repository },
        {} as never
      )
    ).rejects.toThrow('Pagination cursor does not match the requested order');
    await expect(
      assetsField?.resolve?.(
        {},
        { first: 1, after: 'psc2.not-valid-base64', orderBy: ['ID_ASC'] },
        { repository },
        {} as never
      )
    ).rejects.toThrow('Invalid pagination cursor');
  });

  it('fails closed for cursor replay, unbounded pages, and adversarial connection inputs', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany([
      {
        collection: 'assets',
        id: 'asset-a',
        timestamp: 10,
        data: { id: 'asset-a', timestamp: 10, liquidity: '1', liquidityBooks: '0' },
      },
      {
        collection: 'assets',
        id: 'asset-b',
        timestamp: 20,
        data: { id: 'asset-b', timestamp: 20, liquidity: '2', liquidityBooks: '0' },
      },
    ]);
    const query = vi.spyOn(repository, 'query');
    const schema = createSchema();
    const assetsField = schema.getQueryType()?.getFields().assets;
    const poolsField = schema.getQueryType()?.getFields().poolXYKs;
    const historyField = schema.getQueryType()?.getFields().historyElements;

    await assetsField?.resolve?.({}, {}, { repository }, {} as never);
    expect(query.mock.calls[0]?.[1].first).toBe(100);

    const firstPage = (await assetsField?.resolve?.(
      {},
      {
        first: 1,
        orderBy: ['ID_ASC'],
        filter: { liquidity: { greaterThan: '0' } },
      },
      { repository },
      {} as never
    )) as { edges: Array<{ cursor: string }> };
    const cursor = firstPage.edges[0]?.cursor;

    await expect(
      assetsField?.resolve?.(
        {},
        {
          first: 1,
          after: cursor,
          orderBy: ['ID_ASC'],
          filter: { liquidity: { greaterThan: '1' } },
        },
        { repository },
        {} as never
      )
    ).rejects.toThrow(/Pagination cursor does not match the requested/);
    await expect(
      poolsField?.resolve?.(
        {},
        {
          first: 1,
          after: cursor,
          orderBy: ['ID_ASC'],
        },
        { repository },
        {} as never
      )
    ).rejects.toThrow(/Pagination cursor does not match the requested/);

    for (const first of [-1, 1.5, 1_001, Number.POSITIVE_INFINITY]) {
      await expect(
        assetsField?.resolve?.({}, { first, orderBy: ['ID_ASC'] }, { repository }, {} as never)
      ).rejects.toThrow(/first/);
    }
    await expect(
      historyField?.resolve?.(
        {},
        {
          first: 1,
          orderBy: ['TIMESTAMP_DESC'],
          filter: {
            or: Array.from({ length: 100 }, (_item, index) => ({
              module: { equalTo: `module-${index}` },
              method: { equalTo: `method-${index}` },
              address: { equalTo: `account-${index}` },
              dataFrom: { equalTo: `from-${index}` },
              dataTo: { equalTo: `to-${index}` },
            })),
          },
        },
        { repository },
        {} as never
      )
    ).rejects.toThrow('maximum input node count');
    for (const after of [0, '0', 'psc1.legacy']) {
      await expect(
        assetsField?.resolve?.({}, { first: 1, after, orderBy: ['ID_ASC'] }, { repository }, {} as never)
      ).rejects.toThrow(/cursor/i);
    }

    let deepFilter: Record<string, unknown> = { id: { equalTo: 'asset-a' } };
    for (let depth = 0; depth < 10; depth += 1) deepFilter = { and: [deepFilter] };
    await expect(
      assetsField?.resolve?.({}, { first: 1, filter: deepFilter }, { repository }, {} as never)
    ).rejects.toThrow(/depth/);
    await expect(
      assetsField?.resolve?.(
        {},
        { first: 1, filter: { id: { in: Array.from({ length: 101 }, (_, index) => String(index)) } } },
        { repository },
        {} as never
      )
    ).rejects.toThrow(/oversized array/);
    await expect(
      assetsField?.resolve?.(
        {},
        { first: 1, filter: Object.create({ polluted: true }) as Record<string, unknown> },
        { repository },
        {} as never
      )
    ).rejects.toThrow(/plain objects/);
    await expect(
      assetsField?.resolve?.(
        {},
        { first: 1, orderBy: ['TIMESTAMP_DESC', 'ID_ASC'] },
        { repository },
        {} as never
      )
    ).rejects.toThrow(/tie-breaker/);
    for (const orderBy of [[{ field: 'TIMESTAMP_DESC' }], ['NOT_A_REAL_FIELD_ASC'], [`${'A'.repeat(200)}_ASC`]]) {
      await expect(
        assetsField?.resolve?.({}, { first: 1, orderBy }, { repository }, {} as never)
      ).rejects.toThrow(/orderBy/);
    }
  });

  it('caches repeated hot connection resolver queries within the TTL window', async () => {
    const row = {
      collection: 'assets',
      id: 'asset-a',
      data: { id: 'asset-a', liquidity: '10' },
    } as const;
    const query = vi.fn<QueryFunction>().mockResolvedValue({
      items: [row],
      totalCount: 1,
      pageStart: 0,
      hasNextPage: false,
      hasPreviousPage: false,
    });
    const repository = repositoryWithQuery(query);
    const schema = createSchema();
    const assetsField = schema.getQueryType()?.getFields().assets;
    const args = { first: 10, orderBy: ['ID_ASC'] };

    await expect(assetsField?.resolve?.({}, args, { repository }, undefined as never)).resolves.toMatchObject({
      totalCount: 1,
    });
    await expect(assetsField?.resolve?.({}, args, { repository }, undefined as never)).resolves.toMatchObject({
      totalCount: 1,
    });

    expect(query).toHaveBeenCalledTimes(1);
  });

  it('caches repeated hot singleton resolver queries within the TTL window', async () => {
    const get = vi.fn<IndexerRepository['get']>().mockResolvedValue({
      collection: 'updatesStreams',
      id: 'chainState',
      data: { id: 'chainState', block: 123, data: '{"lastIndexedBlock":123}' },
    });
    const repository: IndexerRepository = {
      list: async () => [],
      query: async () => ({ items: [], totalCount: 0 }),
      get,
      getMany: async () => new Map(),
      upsert: async () => undefined,
      upsertMany: async () => undefined,
      deleteMany: async () => undefined,
      close: async () => undefined,
    };
    const schema = createSchema();
    const updatesStreamField = schema.getQueryType()?.getFields().updatesStream;
    const args = { id: 'chainState' };

    await expect(updatesStreamField?.resolve?.({}, args, { repository }, undefined as never)).resolves.toMatchObject({
      block: 123,
    });
    await expect(updatesStreamField?.resolve?.({}, args, { repository }, undefined as never)).resolves.toMatchObject({
      block: 123,
    });

    expect(get).toHaveBeenCalledTimes(1);
  });

  it('falls back to list-based filtering, sorting, and forward keyset pagination when query is unavailable', async () => {
    const repository = repositoryWithoutQuery([
      {
        collection: 'assets',
        id: 'asset-a',
        data: { id: 'asset-a', timestamp: 10, priceUSD: '1', liquidity: '0', liquidityBooks: '0' },
      },
      {
        collection: 'assets',
        id: 'asset-b',
        data: { id: 'asset-b', timestamp: 20, priceUSD: '2', liquidity: '5', liquidityBooks: '0' },
      },
      {
        collection: 'assets',
        id: 'asset-c',
        data: { id: 'asset-c', timestamp: 30, priceUSD: '3', liquidity: '10', liquidityBooks: '0' },
      },
    ]);
    const schema = createSchema();
    const assetsField = schema.getQueryType()?.getFields().assets;

    const firstPage = (await assetsField?.resolve?.(
      {},
      {
        first: 1,
        filter: { liquidity: { greaterThan: '0' } },
        orderBy: ['ID_ASC'],
      },
      { repository },
      {} as never
    )) as { edges: Array<{ cursor: string; node: { id: string } }> };
    expect(firstPage.edges.map((edge) => edge.node.id)).toEqual(['asset-b']);

    const result = await assetsField?.resolve?.(
      {},
      {
        first: 1,
        after: firstPage.edges[0]?.cursor,
        filter: { liquidity: { greaterThan: '0' } },
        orderBy: ['ID_ASC'],
      },
      { repository },
      {} as never
    );
    expect(result).toMatchObject({
      totalCount: 2,
      edges: [
        {
          cursor: opaqueCursor(),
          node: {
            id: 'asset-c',
            timestamp: 30,
            priceUSD: '3',
            liquidity: '10',
            liquidityBooks: '0',
          },
        },
      ],
      pageInfo: {
        endCursor: opaqueCursor(),
        hasNextPage: false,
        hasPreviousPage: true,
        startCursor: opaqueCursor(),
      },
    });
  });

  it('keeps list-fallback cursors usable after the cursor row is deleted', async () => {
    const items: IndexerDocument[] = [
      {
        collection: 'assets',
        id: 'asset-a',
        data: { id: 'asset-a', timestamp: 10, priceUSD: '1', liquidity: '1', liquidityBooks: '0' },
      },
      {
        collection: 'assets',
        id: 'asset-b',
        data: { id: 'asset-b', timestamp: 20, priceUSD: '2', liquidity: '2', liquidityBooks: '0' },
      },
      {
        collection: 'assets',
        id: 'asset-c',
        data: { id: 'asset-c', timestamp: 30, priceUSD: '3', liquidity: '3', liquidityBooks: '0' },
      },
    ];
    const repository = repositoryWithoutQuery(items);
    const assetsField = createSchema().getQueryType()?.getFields().assets;
    const first = (await assetsField?.resolve?.(
      {},
      { first: 1, orderBy: ['ID_ASC'] },
      { repository },
      {} as never
    )) as { edges: Array<{ cursor: string }> };

    items.splice(0, 1);
    const second = await assetsField?.resolve?.(
      {},
      { first: 2, after: first.edges[0]?.cursor, orderBy: ['ID_ASC'] },
      { repository },
      {} as never
    );

    expect(second).toMatchObject({
      totalCount: 2,
      edges: [{ node: { id: 'asset-b' } }, { node: { id: 'asset-c' } }],
      pageInfo: { hasNextPage: false, hasPreviousPage: true },
    });
  });

  it('exposes only bounded forward pagination and rejects removed legacy arguments defensively', async () => {
    const repository = new MemoryRepository();
    await repository.upsertMany(
      ['asset-a', 'asset-b', 'asset-c', 'asset-d'].map((id) => ({
        collection: 'assets',
        id,
        data: {
          id,
          priceUSD: '1',
          liquidity: '1',
          liquidityBooks: '0',
        },
      }))
    );

    const schema = createSchema();
    const assetsField = schema.getQueryType()?.getFields().assets;
    expect(assetsField?.args.map((argument) => argument.name)).toEqual(['first', 'after', 'orderBy', 'filter']);
    await expect(
      assetsField?.resolve?.({}, { first: 3, last: 2, orderBy: ['ID_ASC'] }, { repository }, {} as never)
    ).rejects.toThrow('last pagination is not supported');
    await expect(
      assetsField?.resolve?.({}, { first: 1, offset: 100_001, orderBy: ['ID_ASC'] }, { repository }, {} as never)
    ).rejects.toThrow('offset must be an integer');
    await expect(
      assetsField?.resolve?.({}, { first: 1, before: 'cursor', orderBy: ['ID_ASC'] }, { repository }, {} as never)
    ).rejects.toThrow('before pagination is not supported');
  });

  it('returns empty page info for filtered-out connection results', async () => {
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'assets',
      id: 'asset-a',
      data: {
        id: 'asset-a',
        priceUSD: '1',
        liquidity: '0',
        liquidityBooks: '0',
      },
    });

    const schema = createSchema();
    const assetsField = schema.getQueryType()?.getFields().assets;
    const result = await assetsField?.resolve?.(
      {},
      { filter: { liquidity: { greaterThan: '0' } }, orderBy: ['ID_ASC'] },
      { repository },
      {} as never
    );

    expect(result).toMatchObject({
      edges: [],
      totalCount: 0,
      pageInfo: {
        endCursor: null,
        hasNextPage: false,
        hasPreviousPage: false,
        startCursor: null,
      },
    });
  });

  it('skips repository total counts when connection selections omit totalCount', async () => {
    const queryArgs: RepositoryQueryArgs[] = [];
    const repository = repositoryWithQuery(async (_collection, args) => {
      queryArgs.push(args);

      return {
        items: [
          {
            collection: 'assets',
            id: 'asset-c',
            data: { id: 'asset-c', priceUSD: '1', liquidity: '1', liquidityBooks: '0' },
          },
        ],
        totalCount: null,
        pageStart: 2,
        hasNextPage: true,
        hasPreviousPage: true,
      };
    });
    const info = {
      fieldNodes: [
        {
          selectionSet: {
            selections: [
              { kind: 'Field', name: { value: 'edges' } },
              { kind: 'Field', name: { value: 'pageInfo' } },
            ],
          },
        },
      ],
      fragments: {},
    } as unknown as GraphQLResolveInfo;
    const schema = createSchema();
    const assetsField = schema.getQueryType()?.getFields().assets;
    const after = encodeRepositoryCursor({
      scope: createRepositoryCursorScope('assets', ['ID_ASC'], undefined),
      field: 'id',
      direction: 'asc',
      numeric: false,
      value: 'asset-b',
      id: 'asset-b',
    });

    const result = await assetsField?.resolve?.(
      {},
      { first: 1, after, orderBy: ['ID_ASC'] },
      { repository },
      info
    );

    expect(queryArgs).toHaveLength(1);
    expect(queryArgs[0]?.includeTotalCount).toBe(false);
    expect(queryArgs[0]).toMatchObject({
      after: null,
      keyset: {
        scope: createRepositoryCursorScope('assets', ['ID_ASC'], undefined),
        field: 'id',
        id: 'asset-b',
      },
    });
    expect(result).toMatchObject({
      edges: [{ cursor: opaqueCursor(), node: { id: 'asset-c' } }],
      pageInfo: {
        endCursor: opaqueCursor(),
        hasNextPage: true,
        hasPreviousPage: true,
        startCursor: opaqueCursor(),
      },
    });
  });

  it('requests repository total counts when selected through inline fragments', async () => {
    const queryArgs: RepositoryQueryArgs[] = [];
    const repository = repositoryWithQuery(async (_collection, args) => {
      queryArgs.push(args);

      return {
        items: [
          {
            collection: 'assets',
            id: 'asset-a',
            data: { id: 'asset-a', priceUSD: '1', liquidity: '1', liquidityBooks: '0' },
          },
        ],
        totalCount: 1,
      };
    });
    const info = {
      fieldNodes: [
        {
          selectionSet: {
            selections: [
              {
                kind: 'InlineFragment',
                selectionSet: {
                  selections: [{ kind: 'Field', name: { value: 'totalCount' } }],
                },
              },
            ],
          },
        },
      ],
      fragments: {},
    } as unknown as GraphQLResolveInfo;
    const schema = createSchema();
    const assetsField = schema.getQueryType()?.getFields().assets;

    const result = await assetsField?.resolve?.({}, {}, { repository }, info);

    expect(queryArgs).toHaveLength(1);
    expect(queryArgs[0]?.includeTotalCount).toBe(true);
    expect(result).toMatchObject({
      edges: [{ node: { id: 'asset-a' } }],
      totalCount: 1,
    });
  });

  it('requests repository total counts when selected through fragments', async () => {
    const queryArgs: RepositoryQueryArgs[] = [];
    const repository = repositoryWithQuery(async (_collection, args) => {
      queryArgs.push(args);

      return {
        items: [
          {
            collection: 'assets',
            id: 'asset-a',
            data: { id: 'asset-a', priceUSD: '1', liquidity: '1', liquidityBooks: '0' },
          },
        ],
        totalCount: 1,
      };
    });
    const info = {
      fieldNodes: [
        {
          selectionSet: {
            selections: [{ kind: 'FragmentSpread', name: { value: 'AssetConnectionFields' } }],
          },
        },
      ],
      fragments: {
        AssetConnectionFields: {
          selectionSet: {
            selections: [
              { kind: 'Field', name: { value: 'totalCount' } },
              { kind: 'Field', name: { value: 'edges' } },
            ],
          },
        },
      },
    } as unknown as GraphQLResolveInfo;
    const schema = createSchema();
    const assetsField = schema.getQueryType()?.getFields().assets;

    const result = await assetsField?.resolve?.({}, {}, { repository }, info);

    expect(queryArgs).toHaveLength(1);
    expect(queryArgs[0]?.includeTotalCount).toBe(true);
    expect(result).toMatchObject({
      edges: [{ node: { id: 'asset-a' } }],
      totalCount: 1,
    });
  });

  it('accepts the UI history order enum and account point-system queries', async () => {
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'historyElements',
      id: 'history-a',
      data: {
        id: 'history-a',
        type: 'CALL',
        timestamp: 10,
        blockHash: '0xabc',
        blockHeight: 1,
        module: 'assets',
        method: 'transfer',
        address: 'alice',
        networkFee: '0',
        execution: { success: true },
        data: { assetId: 'xor' },
        calls: [],
      },
    });
    await repository.upsert({
      collection: 'accountMeta',
      id: 'alice',
      data: {
        id: 'alice',
        accountId: 'alice',
        createdAtTimestamp: 10,
        createdAtBlock: 1,
        xorFees: { amount: '0', amountUSD: '0' },
        xorBurned: { amount: '0', amountUSD: '0' },
        xorStakingValRewards: { amount: '0', amountUSD: '0' },
        orderBook: { created: 0, closed: 0, amountUSD: '0' },
        vault: { created: 0, closed: 0, amountUSD: '0' },
        governance: { votes: 0, amount: '0', amountUSD: '0' },
        deposit: { incomingUSD: '0', outgoingUSD: '0' },
      },
    });

    const schema = createSchema();
    const historyOrderType = schema.getType('HistoryElementsOrderBy');
    const historyField = schema.getQueryType()?.getFields().historyElements;
    const accountMetaField = schema.getQueryType()?.getFields().accountMeta;
    const history = await historyField?.resolve?.(
      {},
      { orderBy: ['TIMESTAMP_DESC', 'ID_DESC'], filter: { address: { equalTo: 'alice' } } },
      { repository },
      {} as never
    );
    const accountMeta = await accountMetaField?.resolve?.({}, { id: 'alice' }, { repository }, {} as never);

    expect(historyOrderType?.toString()).toBe('HistoryElementsOrderBy');
    expect(history).toMatchObject({
      totalCount: 1,
      edges: [{ node: { id: 'history-a' } }],
    });
    expect(accountMeta).toMatchObject({
      createdAtBlock: 1,
      xorFees: { amount: '0', amountUSD: '0' },
    });
  });

  it('accepts a storage-anchored mobile history filter shape', async () => {
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'historyElements',
      id: 'history-transfer',
      data: {
        id: 'history-transfer',
        timestamp: 20,
        method: 'transfer',
        address: 'alice',
        dataTo: 'bob',
        execution: { success: true },
      },
    });
    await repository.upsert({
      collection: 'historyElements',
      id: 'history-swap',
      data: {
        id: 'history-swap',
        timestamp: 10,
        method: 'swap',
        address: 'alice',
        dataTo: 'bob',
        execution: { success: true },
      },
    });

    const schema = createSchema();
    const historyField = schema.getQueryType()?.getFields().historyElements;
    const history = await historyField?.resolve?.(
      {},
      {
        first: 100,
        orderBy: ['TIMESTAMP_DESC'],
        filter: {
          and: [
            { address: { equalTo: 'alice' } },
            {
              or: [
                { method: { notIn: ['swap', 'rewarded'] } },
                { dataTo: 'alice', method: { notIn: ['swap', 'rewarded'] } },
              ],
            },
          ],
        },
      },
      { repository },
      {} as never
    );

    expect(history).toMatchObject({
      totalCount: 1,
      nodes: [{ id: 'history-transfer', execution: { success: true } }],
      edges: [{ node: { id: 'history-transfer', execution: { success: true } } }],
    });
  });

  it('rejects adversarial filter paths before repository access', async () => {
    Object.defineProperty(Object.prototype, 'polkaswapIndexerPolluted', {
      configurable: true,
      value: 'owned',
    });

    try {
      const repository = new MemoryRepository();
      await repository.upsert({
        collection: 'assets',
        id: 'asset-a',
        data: { id: 'asset-a', symbol: 'XOR', liquidity: '10' },
      });

      const schema = createSchema();
      const assetsField = schema.getQueryType()?.getFields().assets;
      await expect(
        assetsField?.resolve?.(
          {},
          {
            first: 10,
            filter: {
              '__proto__.polkaswapIndexerPolluted': { equalTo: 'owned' },
            },
          },
          { repository },
          {} as never
        )
      ).rejects.toThrow('not supported by the public query plan');
    } finally {
      delete (Object.prototype as { polkaswapIndexerPolluted?: unknown }).polkaswapIndexerPolluted;
    }
  });

  it('serves SubQuery-style nodes and mobile metadata for referrer rewards', async () => {
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'referrerRewards',
      id: 'alice-bob',
      blockHeight: 42,
      timestamp: 1234,
      data: {
        id: 'alice-bob',
        referral: 'bob',
        referrer: 'alice',
        updated: 1234,
        amount: '0',
      },
    });

    const schema = createSchema();
    const rewardsField = schema.getQueryType()?.getFields().referrerRewards;
    const rewards = await rewardsField?.resolve?.(
      {},
      { first: 10, filter: { referrer: { equalTo: 'alice' } } },
      { repository },
      {} as never
    );

    expect(rewards).toMatchObject({
      totalCount: 1,
      nodes: [{ id: 'alice-bob', blockHeight: '42', timestamp: 1234 }],
      edges: [{ node: { id: 'alice-bob', blockHeight: '42', timestamp: 1234 } }],
    });
  });

  it('serves singleton query fields and normalizes history call nodes', async () => {
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'accounts',
      id: 'alice',
      data: { id: 'alice', latestHistoryElementId: 'history-a' },
    });
    await repository.upsert({
      collection: 'orderBooks',
      id: '0-xor-kusd',
      data: { id: '0-xor-kusd', status: 'Trading', price: '2' },
    });
    await repository.upsert({
      collection: 'updatesStreams',
      id: 'chainState',
      data: { id: 'chainState', block: 123, data: 'synced' },
    });

    const schema = createSchema();
    const queryFields = schema.getQueryType()?.getFields();
    const historyElementType = schema.getType('HistoryElement') as { getFields: () => Record<string, { resolve?: (...args: unknown[]) => unknown }> };
    const account = await queryFields?.account.resolve?.({}, { id: 'alice' }, { repository }, {} as never);
    const missingAccount = await queryFields?.account.resolve?.({}, { id: 'missing' }, { repository }, {} as never);
    const orderBook = await queryFields?.orderBook.resolve?.({}, { id: '0-xor-kusd' }, { repository }, {} as never);
    const updatesStream = await queryFields?.updatesStream.resolve?.({}, { id: 'chainState' }, { repository }, {} as never);
    const calls = historyElementType.getFields().calls.resolve?.(
      { calls: [{ module: 'assets', method: 'transfer', data: { amount: '1' } }] },
      {},
      {},
      {} as never
    );
    const missingCalls = historyElementType.getFields().calls.resolve?.({ calls: null }, {}, {}, {} as never);

    expect(account).toEqual({ id: 'alice', latestHistoryElementId: 'history-a' });
    expect(missingAccount).toBeNull();
    expect(orderBook).toEqual({ id: '0-xor-kusd', status: 'Trading', price: '2' });
    expect(updatesStream).toEqual({ id: 'chainState', block: 123, data: 'synced' });
    expect(calls).toEqual({ nodes: [{ module: 'assets', method: 'transfer', data: { amount: '1' } }] });
    expect(missingCalls).toEqual({ nodes: [] });
  });

  it('accepts entity-specific staking validator filter variables', () => {
    const schema = createSchema();
    const stakingValidatorFilter = schema.getType('StakingValidatorFilter');
    const stakingValidatorsField = schema.getQueryType()?.getFields().stakingValidators;
    const filterArg = stakingValidatorsField?.args.find((arg) => arg.name === 'filter');

    expect(stakingValidatorFilter?.toString()).toBe('StakingValidatorFilter');
    expect(String(filterArg?.type)).toBe('StakingValidatorFilter');
  });

  it('keeps SubQuery JSON fields selectable as scalar values', async () => {
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'historyElements',
      id: 'history-a',
      data: {
        id: 'history-a',
        type: 'CALL',
        timestamp: 10,
        blockHash: '0xabc',
        blockHeight: 1,
        module: 'liquidityProxy',
        method: 'swap',
        address: 'alice',
        networkFee: '0',
        execution: { success: true },
        data: { assetId: 'xor' },
        dataAssets: ['xor'],
        calls: [],
      },
    });
    await repository.upsert({
      collection: 'assetSnapshots',
      id: 'asset-snapshot-a',
      data: {
        id: 'asset-snapshot-a',
        assetId: 'asset-a',
        timestamp: 10,
        type: 'DAY',
        supply: '100',
        priceUSD: { open: '1', high: '2', low: '1', close: '2' },
        volume: { amount: '5', amountUSD: '10' },
      },
    });
    await repository.upsert({
      collection: 'orderBookSnapshots',
      id: 'order-book-snapshot-a',
      data: {
        id: 'order-book-snapshot-a',
        orderBookId: '0-base-quote',
        timestamp: 10,
        type: 'DAY',
        price: { open: '1', high: '2', low: '1', close: '2' },
        volumeUSD: '10',
      },
    });
    await repository.upsert({
      collection: 'accountMeta',
      id: 'alice',
      data: {
        id: 'alice',
        accountId: 'alice',
        createdAtTimestamp: 10,
        createdAtBlock: 1,
        xorFees: { amount: '1', amountUSD: '2' },
        xorBurned: { amount: '0', amountUSD: '0' },
        xorStakingValRewards: { amount: '0', amountUSD: '0' },
        orderBook: { created: 1, closed: 0, amountUSD: '2' },
        vault: { created: 0, closed: 0, amountUSD: '0' },
        governance: { votes: 1, amount: '3', amountUSD: '4' },
        deposit: { incomingUSD: '5', outgoingUSD: '6' },
      },
    });

    const schema = createSchema();
    const assetSnapshotType = schema.getType('AssetSnapshot') as { getFields: () => Record<string, { type: unknown }> };
    const orderBookSnapshotType = schema.getType('OrderBookSnapshot') as { getFields: () => Record<string, { type: unknown }> };
    const accountMetaType = schema.getType('AccountMeta') as { getFields: () => Record<string, { type: unknown }> };
    const historyElementType = schema.getType('HistoryElement') as { getFields: () => Record<string, { type: unknown }> };
    const assetSnapshotsField = schema.getQueryType()?.getFields().assetSnapshots;
    const orderBookSnapshotsField = schema.getQueryType()?.getFields().orderBookSnapshots;
    const accountMetaField = schema.getQueryType()?.getFields().accountMeta;
    const historyElementsField = schema.getQueryType()?.getFields().historyElements;
    const assetSnapshots = await assetSnapshotsField?.resolve?.({}, {}, { repository }, {} as never);
    const orderBookSnapshots = await orderBookSnapshotsField?.resolve?.({}, {}, { repository }, {} as never);
    const accountMeta = await accountMetaField?.resolve?.({}, { id: 'alice' }, { repository }, {} as never);
    const historyElements = await historyElementsField?.resolve?.(
      {},
      {
        first: 1,
        orderBy: ['TIMESTAMP_ASC'],
        filter: {
          and: [
            { address: { equalTo: 'alice' } },
            { dataAssets: { contains: 'xor' } },
            { timestamp: { greaterThan: 1 } },
          ],
        },
      },
      { repository },
      {} as never
    );

    expect(String(assetSnapshotType.getFields().priceUSD.type)).toBe('JSON');
    expect(String(assetSnapshotType.getFields().volume.type)).toBe('JSON');
    expect(String(orderBookSnapshotType.getFields().price.type)).toBe('JSON');
    expect(String(accountMetaType.getFields().xorFees.type)).toBe('JSON');
    expect(String(historyElementType.getFields().execution.type)).toBe('JSON');
    expect(assetSnapshots).toMatchObject({
      edges: [{ node: { priceUSD: { close: '2' }, volume: { amountUSD: '10' } } }],
    });
    expect(orderBookSnapshots).toMatchObject({
      edges: [{ node: { price: { close: '2' } } }],
    });
    expect(accountMeta).toMatchObject({
      xorFees: { amount: '1', amountUSD: '2' },
      orderBook: { created: 1, closed: 0, amountUSD: '2' },
      governance: { votes: 1, amount: '3', amountUSD: '4' },
      deposit: { incomingUSD: '5', outgoingUSD: '6' },
    });
    expect(historyElements).toMatchObject({
      edges: [{ node: { id: 'history-a', execution: { success: true } } }],
      totalCount: 1,
    });
  });

  it('exposes extended DeFi fields on network snapshots', () => {
    const schema = createSchema();
    const networkSnapshotType = schema.getType('NetworkSnapshot') as { getFields: () => Record<string, { type: unknown }> };

    expect(Object.keys(networkSnapshotType.getFields())).toEqual(
      expect.arrayContaining([
        'liquidityUSD',
        'poolLiquidityUSD',
        'orderBookLiquidityUSD',
        'volumeUSD',
        'swaps',
        'activePools',
        'activeOrderBooks',
        'listedAssets',
        'bridgeIncomingTransactions',
        'bridgeOutgoingTransactions',
        'accounts',
        'transactions',
        'fees',
      ])
    );
  });

  it('validates SubQuery-style subscription payload entity scalars', () => {
    const schema = createSchema();
    const updatesStreamMutationType = schema.getType('UpdatesStreamMutation') as {
      getFields: () => Record<string, { type: unknown }>;
    };
    const accountMutationType = schema.getType('AccountMutation') as { getFields: () => Record<string, { type: unknown }> };
    const orderBookMutationType = schema.getType('OrderBookMutation') as { getFields: () => Record<string, { type: unknown }> };

    expect(String(updatesStreamMutationType.getFields()._entity.type)).toBe('JSON!');
    expect(String(accountMutationType.getFields()._entity.type)).toBe('JSON!');
    expect(String(orderBookMutationType.getFields()._entity.type)).toBe('JSON!');
  });

  it('rejects unscoped and oversized public subscription id sets', async () => {
    const repository = new MemoryRepository();
    const field = createSchema().getSubscriptionType()?.getFields().accounts;
    for (const id of [undefined, [], Array.from({ length: 101 }, (_item, index) => `id-${index}`)]) {
      const iterator = field?.subscribe?.({}, { id }, { repository }, {} as never) as AsyncGenerator<unknown>;
      await expect(iterator.next()).rejects.toMatchObject({ extensions: { code: 'BAD_USER_INPUT' } });
    }
  });

  it('emits account subscription payloads with SubQuery entity field names', async () => {
    const repository = new MemoryRepository();
    const schema = createSchema();
    const accountsField = schema.getSubscriptionType()?.getFields().accounts;
    const iterator = accountsField?.subscribe?.({}, { id: ['alice'] }, { repository }, {} as never) as AsyncGenerator<
      unknown,
      void,
      unknown
    >;
    const next = iterator.next();

    await repository.upsert({
      collection: 'accounts',
      id: 'bob',
      data: { id: 'bob', latestHistoryElementId: 'history-b' },
    });
    await repository.upsert({
      collection: 'accounts',
      id: 'alice',
      data: { id: 'alice', latestHistoryElementId: 'history-a' },
    });

    const sourceEvent = await next;
    expect(sourceEvent).toEqual({
      done: false,
      value: {
        collection: 'accounts',
        id: 'alice',
        mutationType: 'INSERT',
      },
    });
    expect('data' in (sourceEvent.value as Record<string, unknown>)).toBe(false);
    await expect(
      accountsField?.resolve?.(
        sourceEvent.value,
        { id: ['alice'] },
        { repository },
        {} as never
      )
    ).resolves.toEqual({
      id: 'alice',
      mutation_type: 'INSERT',
      _entity: {
        id: 'alice',
        latest_history_element_id: 'history-a',
      },
    });
    await iterator.return(undefined);
  });

  it('emits order book subscription payloads with UI-compatible entity keys', async () => {
    const repository = new MemoryRepository();
    const schema = createSchema();
    const orderBooksField = schema.getSubscriptionType()?.getFields().orderBooks;
    const iterator = orderBooksField?.subscribe?.({}, { id: ['0-xor-kusd'] }, { repository }, {} as never) as AsyncGenerator<
      unknown,
      void,
      unknown
    >;
    const next = iterator.next();

    await repository.upsert({
      collection: 'orderBooks',
      id: '0-xor-kusd',
      data: {
        id: '0-xor-kusd',
        price: '2',
        priceChangeDay: 0.5,
        volumeDayUSD: '100',
        status: 'Trading',
        lastDeals: '[]',
        updatedAtBlock: 20,
      },
    });

    const sourceEvent = await next;
    expect(sourceEvent).toEqual({
      done: false,
      value: {
        collection: 'orderBooks',
        id: '0-xor-kusd',
        mutationType: 'INSERT',
      },
    });
    expect('data' in (sourceEvent.value as Record<string, unknown>)).toBe(false);
    await expect(
      orderBooksField?.resolve?.(
        sourceEvent.value,
        { id: ['0-xor-kusd'] },
        { repository },
        {} as never
      )
    ).resolves.toEqual({
      id: '0-xor-kusd',
      mutation_type: 'INSERT',
      _entity: {
        price: '2',
        price_change_day: 0.5,
        volume_day_u_s_d: '100',
        status: 'Trading',
        last_deals: '[]',
      },
    });
    await iterator.return(undefined);
  });

  it('filters identity events by mutation before document materialization', async () => {
    const repository = new MemoryRepository();
    const field = createSchema().getSubscriptionType()?.getFields().updatesStreams;
    const iterator = field?.subscribe?.(
      {},
      { id: ['price'], mutation: ['UPDATE'] },
      { repository },
      {} as never
    ) as AsyncGenerator<unknown, void, unknown>;
    const next = iterator.next();

    await repository.upsert({
      collection: 'updatesStreams',
      id: 'price',
      blockHeight: 1,
      data: { id: 'price', data: 'first' },
    });
    await repository.upsert({
      collection: 'updatesStreams',
      id: 'price',
      blockHeight: 2,
      data: { id: 'price', data: 'second' },
    });

    await expect(next).resolves.toEqual({
      done: false,
      value: { collection: 'updatesStreams', id: 'price', mutationType: 'UPDATE' },
    });
    await iterator.return(undefined);
  });

  it('emits payload-free deletes without fetching a removed document', async () => {
    const repository = new MemoryRepository();
    await repository.upsert({
      collection: 'updatesStreams',
      id: 'price',
      blockHeight: 1,
      data: { id: 'price', data: 'first' },
    });
    const get = vi.spyOn(repository, 'get');
    const field = createSchema().getSubscriptionType()?.getFields().updatesStreams;
    const args = { id: ['price'], mutation: ['DELETE'] };
    const iterator = field?.subscribe?.({}, args, { repository }, {} as never) as AsyncGenerator<unknown>;
    const next = iterator.next();

    await repository.deleteMany('updatesStreams', ['price']);
    const source = await next;
    expect(source).toEqual({
      done: false,
      value: { collection: 'updatesStreams', id: 'price', mutationType: 'DELETE' },
    });
    await expect(
      field?.resolve?.(source.value, args, { repository }, {} as never)
    ).resolves.toEqual({
      id: 'price',
      mutation_type: 'DELETE',
      _entity: { id: 'price' },
    });
    expect(get).not.toHaveBeenCalled();
    await iterator.return(undefined);
  });
});
