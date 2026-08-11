import { afterEach, describe, expect, it, vi } from 'vitest';

import { readConfig } from '../src/config.js';
import { ChainIndexer } from '../src/worker/chain.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { SORA_LEGACY_IDENTITY_ANCHOR } from '../src/soraIdentity.js';

const config = {
  ...readConfig(),
  host: '0.0.0.0',
  port: 4350,
  graphqlPath: '/graphql',
  databaseUrl: '',
  soraWsEndpoint: 'wss://primary.sora.invalid',
  archiveSoraWsEndpoint: '',
  chainStartBlock: 0,
  chainBatchSize: 25,
  stateRefreshIntervalBlocks: 250,
  snapshotIntervalBlocks: 250,
};

const hash = (byte: string): string => `0x${byte.repeat(64)}`;
const INITIAL_PENDING = SORA_LEGACY_IDENTITY_ANCHOR.block + 10;
const FINALIZED_HASH = hash('a');

type FinalizedIndexer = {
  api: unknown;
  pendingFinalizedBlock: number;
  subscribeFinalizedHeads: () => Promise<void>;
  startFinalizedHeadPolling: () => void;
  updatePendingFinalizedBlockFromRpc: () => Promise<void>;
  requestPendingFinalizedBlockUpdate: (message: string) => void;
  requestXorBurnBackfill: (block: number) => void;
  drainFinalizedHeads: () => Promise<void>;
};

const indexer = (): FinalizedIndexer =>
  new ChainIndexer(config, new MemoryRepository()) as unknown as FinalizedIndexer;

const header = (height: number, headerHash = FINALIZED_HASH) => ({
  number: { toNumber: () => height },
  hash: { toString: () => headerHash },
});

describe('finalized SORA identity validation', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ['NaN height', Number.NaN, FINALIZED_HASH],
    ['fractional height', SORA_LEGACY_IDENTITY_ANCHOR.block + 0.5, FINALIZED_HASH],
    ['unsafe height', Number.MAX_SAFE_INTEGER + 1, FINALIZED_HASH],
    ['below-anchor height', SORA_LEGACY_IDENTITY_ANCHOR.block - 1, FINALIZED_HASH],
    ['zero hash', INITIAL_PENDING + 1, hash('0')],
    ['malformed hash', INITIAL_PENDING + 1, '0x1234'],
    ['missing hash', INITIAL_PENDING + 1, ''],
  ])('does not let a subscription %s poison pending finalized state', async (_label, height, headerHash) => {
    const subject = indexer();
    let callback: ((value: ReturnType<typeof header>) => void) | undefined;
    subject.pendingFinalizedBlock = INITIAL_PENDING;
    subject.api = {
      rpc: {
        chain: {
          subscribeFinalizedHeads: vi.fn(async (listener: typeof callback) => {
            callback = listener;
            return vi.fn();
          }),
        },
      },
    };
    subject.startFinalizedHeadPolling = vi.fn();
    subject.updatePendingFinalizedBlockFromRpc = vi.fn(async () => undefined);
    subject.requestPendingFinalizedBlockUpdate = vi.fn();
    subject.drainFinalizedHeads = vi.fn(async () => undefined);

    await subject.subscribeFinalizedHeads();
    callback?.(header(height, headerHash));

    expect(subject.pendingFinalizedBlock).toBe(INITIAL_PENDING);
    expect(subject.requestPendingFinalizedBlockUpdate).toHaveBeenCalledWith(
      'Failed to recover from a malformed finalized-head subscription update',
    );
    expect(subject.drainFinalizedHeads).not.toHaveBeenCalled();
  });

  it.each([
    ['NaN height', Number.NaN, FINALIZED_HASH],
    ['fractional height', SORA_LEGACY_IDENTITY_ANCHOR.block + 0.5, FINALIZED_HASH],
    ['unsafe height', Number.MAX_SAFE_INTEGER + 1, FINALIZED_HASH],
    ['below-anchor height', SORA_LEGACY_IDENTITY_ANCHOR.block - 1, FINALIZED_HASH],
    ['zero header hash', INITIAL_PENDING + 1, hash('0')],
    ['malformed header hash', INITIAL_PENDING + 1, '0x1234'],
    ['requested/header hash mismatch', INITIAL_PENDING + 1, hash('b')],
  ])('does not let a polled %s poison pending finalized state', async (_label, height, headerHash) => {
    const subject = indexer();
    subject.pendingFinalizedBlock = INITIAL_PENDING;
    subject.api = {
      rpc: {
        chain: {
          getFinalizedHead: vi.fn(async () => ({ toString: () => FINALIZED_HASH })),
          getHeader: vi.fn(async () => header(height, headerHash)),
        },
      },
    };
    subject.requestXorBurnBackfill = vi.fn();
    subject.drainFinalizedHeads = vi.fn(async () => undefined);

    await expect(subject.updatePendingFinalizedBlockFromRpc()).rejects.toThrow(/malformed finalized header|does not match/);

    expect(subject.pendingFinalizedBlock).toBe(INITIAL_PENDING);
    expect(subject.requestXorBurnBackfill).not.toHaveBeenCalled();
    expect(subject.drainFinalizedHeads).not.toHaveBeenCalled();
  });
});
