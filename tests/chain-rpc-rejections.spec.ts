import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));

// A separate strict Node process is necessary: a process-wide rejection listener
// in the Vitest process could hide the production crash this test reproduces.
const projectionFixture = String.raw`
  import assert from 'node:assert/strict';
  import { setTimeout as delay } from 'node:timers/promises';
  import { ChainIndexer } from './src/worker/chain.ts';
  import { MemoryRepository } from './src/repository/memory.ts';

  globalThis.fetch = async () => { throw new Error('NO_NETWORK_ALLOWED'); };
  const scenario = process.env.PROJECTION_REJECTION_SCENARIO;
  const indexer = new ChainIndexer({
    soraWsEndpoint: 'wss://mof2.sora.org', archiveSoraWsEndpoint: '',
    chainRpcTimeoutMs: 20, chainRpcMaxInFlight: 10,
  }, new MemoryRepository());
  indexer.api = {};
  indexer.canSynchronizePolkamarktAccountPositions = () => false;
  indexer.canSynchronizePolkamarktMarkets = () => false;
  indexer.shouldFullyReconcileDerivedStorage = () => true;
  const auxiliaryFailure = new Error('auxiliary pool provider failure');
  let finishRequest;
  indexer.loadDerivedStorageDomainWithStatus = async (domain) => {
    if (domain === 'poolProviders') {
      return indexer.withRpcTimeout(() => new Promise((resolve, reject) => {
        finishRequest = () => reject(auxiliaryFailure);
        if (scenario !== 'late-request-rejection') setTimeout(finishRequest, 5);
      }), 'poolXYK.poolProviders.entriesPaged()');
    }
    if (domain === 'staking') return {
      value: { nominators: [], validatorInputs: {} }, refreshed: false,
      authoritativeForGeneration: false,
    };
    assert.equal(domain, 'orderBooks');
    return { value: { orderBooks: [], orderBookBids: [], orderBookAsks: [], orderBookLimitOrders: [] },
      refreshed: false, authoritativeForGeneration: false };
  };
  indexer.loadDerivedStorageDomain = async () => [];
  const mainFailure = new Error('main storage failure');
  indexer.loadAssetStorageDomain = async () => {
    if (scenario === 'main-fails-first') throw mainFailure;
    await delay(80);
    return { assetInfos: [], tokenIssuances: [], nativeXorIssuance: 0n, assetMetadataAuthoritative: false };
  };
  indexer.loadPoolStorageDomain = async () => ({
    poolProperties: [], poolReserves: [], poolIssuances: [], poolReservesAuthoritative: false,
  });
  indexer.loadPolkamarktStorageDomain = async () => ({});
  indexer.buildAnalytics = async () => ({ orderBookActiveReserves: new Map(), network: new Map() });
  indexer.mergeLimitOrderStorage = () => undefined;
  indexer.derivePoolApy = () => new Map();
  for (const name of ['createAssetDocuments', 'createPoolDocuments', 'createOrderBookDocuments',
    'createPolkamarktMarketDocuments', 'createPolkamarktPositionDocuments',
    'createNetworkSnapshotDocuments', 'createUpdateStreams']) indexer[name] = () => [];
  indexer.upsertDocumentsInCallChunks = async () => undefined;
  indexer.reconcilePendingAuthoritativeCollection = async () => undefined;
  try {
    await indexer.refreshDerivedStateInternal({ poolXYK: {}, staking: {}, referrals: {}, kensetsu: {} }, 100, 1000, false);
    assert.fail('The original failure must still reject the refresh');
  } catch (error) {
    if (scenario === 'main-fails-first') assert.equal(error, mainFailure);
    else if (scenario === 'late-request-rejection') {
      assert.match(error.message, /poolXYK\.poolProviders\.entriesPaged\(\) timed out after 20ms/);
      finishRequest();
    } else assert.equal(error, auxiliaryFailure);
  }
  // Includes the auxiliary rejection after an earlier main-storage failure and
  // the underlying RPC rejection after its timeout wrapper has already settled.
  await delay(40);
  console.log('projection failure handled without process termination');
`;

describe('derived projection RPC rejection ownership', () => {
  for (const scenario of ['auxiliary-fails-first', 'main-fails-first', 'late-request-rejection']) {
    it(`keeps the original refresh error catchable when ${scenario}`, () => {
      const child = spawnSync(process.execPath, [
        '--unhandled-rejections=strict', '--import', 'tsx', '--input-type=module', '-e', projectionFixture,
      ], {
        cwd: repoRoot, encoding: 'utf8', timeout: 20_000,
        env: { ...process.env, NODE_ENV: 'test', PROJECTION_REJECTION_SCENARIO: scenario },
      });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout).toContain('projection failure handled without process termination');
      expect(child.stderr).not.toContain('PromiseRejectionHandledWarning');
    }, 25_000);
  }
});
