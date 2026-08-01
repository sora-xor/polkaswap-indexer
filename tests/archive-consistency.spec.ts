import { describe, expect, it, vi } from 'vitest';

import { ChainIndexer } from '../src/worker/chain.js';
import { MemoryRepository } from '../src/repository/memory.js';
import {
  SORA_LEGACY_IDENTITY_ANCHOR,
  SORA_MAINNET_GENESIS_HASH,
} from '../src/soraIdentity.js';

const config = {
  host: '0.0.0.0',
  port: 4350,
  graphqlPath: '/graphql',
  databaseUrl: '',
  soraWsEndpoint: 'wss://primary.sora.invalid',
  soraArchiveWsEndpoint: 'wss://archive.sora.invalid',
  chainStartBlock: 0,
  chainBatchSize: 25,
  stateRefreshIntervalBlocks: 250,
  snapshotIntervalBlocks: 250,
};

const BLOCK_HASH = `0x${'ab'.repeat(32)}`;
const BLOCK_HEIGHT = SORA_LEGACY_IDENTITY_ANCHOR.block + 1_000;
const BLOCK_TIMESTAMP = SORA_LEGACY_IDENTITY_ANCHOR.timestamp + 1_000;

type PayloadOptions = {
  blockHex?: string | null;
  eventsHex?: string | null;
  timestamp?: number;
  timestampMilliseconds?: number;
  source?: string;
};

const apiPayload = ({
  blockHex = '0x01020304',
  eventsHex = '0x05060708',
  timestamp = BLOCK_TIMESTAMP,
  timestampMilliseconds,
  source = 'endpoint',
}: PayloadOptions = {}) => {
  const rawTimestampMilliseconds = timestampMilliseconds ?? timestamp * 1_000;
  const block: Record<string, unknown> = {
    header: {
      number: { toNumber: () => BLOCK_HEIGHT },
      hash: { toString: () => BLOCK_HASH },
    },
    extrinsics: [],
    decodedBy: source,
  };
  if (blockHex !== null) block.toHex = () => blockHex;
  const events: Record<string, unknown> = { decodedBy: source };
  if (eventsHex !== null) events.toHex = () => eventsHex;

  return {
    rpc: {
      chain: {
        getBlock: vi.fn(async () => ({ block })),
      },
    },
    query: {
      system: { events: { at: vi.fn(async () => events) } },
      timestamp: { now: { at: vi.fn(async () => ({ toString: () => String(rawTimestampMilliseconds) })) } },
    },
  };
};

type ConsistencyIndexer = {
  api: unknown;
  legacyBlockApi: unknown;
  fetchBlockByHash: (blockHash: string) => Promise<{
    signedBlock: { block: { decodedBy: string } };
    timestamp: number;
  }>;
  backfillXorBurns: (finalizedBlock: number) => Promise<void>;
  backfillBridgeProxyHistory: (finalizedBlock: number) => Promise<void>;
  drainFinalizedHeads: () => Promise<void>;
};

const subjectWith = (
  primary: unknown,
  archive: unknown,
  repository = new MemoryRepository()
): ConsistencyIndexer => {
  const subject = new ChainIndexer(config, repository) as unknown as ConsistencyIndexer;
  subject.api = primary;
  subject.legacyBlockApi = archive;
  return subject;
};

describe('primary/archive raw block agreement', () => {
  it('accepts independently decoded payloads only when block SCALE, events SCALE, and timestamp agree', async () => {
    const exactRawTimestamp = BLOCK_TIMESTAMP * 1_000 + 123;
    const primary = apiPayload({ source: 'primary', timestampMilliseconds: exactRawTimestamp });
    const archive = apiPayload({ source: 'archive', timestampMilliseconds: exactRawTimestamp });
    const subject = subjectWith(primary, archive);

    await expect(subject.fetchBlockByHash(BLOCK_HASH)).resolves.toMatchObject({
      signedBlock: { block: { decodedBy: 'archive' } },
      timestamp: BLOCK_TIMESTAMP,
    });
    expect(primary.rpc.chain.getBlock).toHaveBeenCalledWith(BLOCK_HASH);
    expect(archive.rpc.chain.getBlock).toHaveBeenCalledWith(BLOCK_HASH);
  });

  it('rejects raw timestamp millisecond divergence even within the same persisted second', async () => {
    const primary = apiPayload({ timestampMilliseconds: BLOCK_TIMESTAMP * 1_000 });
    const archive = apiPayload({ timestampMilliseconds: BLOCK_TIMESTAMP * 1_000 + 999 });
    const subject = subjectWith(primary, archive);

    await expect(subject.fetchBlockByHash(BLOCK_HASH)).rejects.toThrow(
      `SORA primary and block data endpoints returned different payloads for block ${BLOCK_HASH}`,
    );
  });

  it.each([
    ['block SCALE bytes', { blockHex: '0x9999' }, {}],
    ['events SCALE bytes', { eventsHex: '0x9999' }, {}],
    ['timestamp', { timestamp: BLOCK_TIMESTAMP + 1 }, {}],
  ])('rejects archive/primary divergence in %s', async (_label, archiveOverrides, primaryOverrides) => {
    const subject = subjectWith(apiPayload(primaryOverrides), apiPayload(archiveOverrides));

    await expect(subject.fetchBlockByHash(BLOCK_HASH)).rejects.toThrow(
      `SORA primary and block data endpoints returned different payloads for block ${BLOCK_HASH}`,
    );
  });

  it.each([
    ['archive block', { blockHex: null }, {}],
    ['primary block', {}, { blockHex: null }],
    ['archive events', { eventsHex: null }, {}],
    ['primary events', {}, { eventsHex: null }],
  ])('rejects %s payload without canonical toHex bytes', async (_label, archiveOverrides, primaryOverrides) => {
    const subject = subjectWith(apiPayload(primaryOverrides), apiPayload(archiveOverrides));

    await expect(subject.fetchBlockByHash(BLOCK_HASH)).rejects.toThrow('did not expose canonical SCALE bytes');
  });
});

const maintenanceHashes = (blocks: number[]): Map<number, string> => new Map(
  blocks.map((block) => [block, `0x${block.toString(16).padStart(64, '0')}`])
);

const maintenanceApi = ({
  hashes,
  divergentBlock,
  failBlockHashOnce,
  bridgeRuntime = false,
}: {
  hashes: Map<number, string>;
  divergentBlock?: number;
  failBlockHashOnce?: number;
  bridgeRuntime?: boolean;
}) => {
  const blocksByHash = new Map([...hashes].map(([block, hash]) => [hash, block]));
  const failedBlockHashes = new Set<number>();
  const getBlockHash = vi.fn(async (block: number) => {
    if (block === failBlockHashOnce && !failedBlockHashes.has(block)) {
      failedBlockHashes.add(block);
      throw new Error(`temporary getBlockHash failure at ${block}`);
    }
    return hashes.get(block);
  });
  const getBlock = vi.fn(async (hash: string) => {
    const blockHeight = blocksByHash.get(hash);
    if (blockHeight === undefined) throw new Error(`unknown maintenance hash ${hash}`);
    const block = {
      header: {
        number: { toNumber: () => blockHeight },
        hash: { toString: () => hash },
      },
      extrinsics: [],
      toHex: () => blockHeight === divergentBlock ? '0xffff' : `0x${blockHeight.toString(16).padStart(8, '0')}`,
    };
    return { block };
  });
  const getMetadata = vi.fn(async () => ({
    asLatest: {
      pallets: bridgeRuntime ? [{ name: { toString: () => 'bridgeProxy' } }] : [],
    },
  }));
  const eventsAt = vi.fn(async () => Object.assign([], { toHex: () => '0x00' }));
  const timestampAt = vi.fn(async () => ({ toString: (): string => '1700000000000' }));

  return {
    rpc: {
      chain: { getBlockHash, getBlock },
      state: { getMetadata },
    },
    query: {
      system: { events: { at: eventsAt } },
      timestamp: { now: { at: timestampAt } },
    },
  };
};

describe('maintenance primary/archive agreement', () => {
  it('does not checkpoint XOR maintenance when the next verified height diverges', async () => {
    const repository = new MemoryRepository();
    const startBlock = 25_043_003;
    const divergentBlock = startBlock + 1;
    const hashes = maintenanceHashes([startBlock, divergentBlock]);
    const primary = maintenanceApi({ hashes });
    const archive = maintenanceApi({ hashes, divergentBlock });
    const subject = subjectWith(primary, archive, repository);
    subject.drainFinalizedHeads = vi.fn(async () => undefined);

    await expect(subject.backfillXorBurns(divergentBlock)).rejects.toThrow(
      `SORA primary and block data endpoints returned different payloads for block ${hashes.get(divergentBlock)}`,
    );

    expect(primary.rpc.chain.getBlockHash).toHaveBeenCalledWith(divergentBlock);
    expect(archive.rpc.chain.getBlockHash).toHaveBeenCalledWith(divergentBlock);
    expect(primary.rpc.chain.getBlock).toHaveBeenCalledTimes(2);
    expect(archive.rpc.chain.getBlock).toHaveBeenCalledTimes(2);
    await expect(repository.list('xorBurns')).resolves.toEqual([]);
    await expect(repository.get('updatesStreams', 'xorBurnsBackfill')).resolves.toBeNull();
  });

  it('retries a transient XOR RPC failure without retrying endpoint comparison', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const repository = new MemoryRepository();
    const startBlock = 25_043_003;
    const hashes = maintenanceHashes([startBlock]);
    const primary = maintenanceApi({ hashes });
    const archive = maintenanceApi({ hashes, failBlockHashOnce: startBlock });
    const subject = subjectWith(primary, archive, repository);
    subject.drainFinalizedHeads = vi.fn(async () => undefined);

    try {
      const backfill = subject.backfillXorBurns(startBlock);
      await vi.runAllTimersAsync();
      await expect(backfill).resolves.toBeUndefined();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }

    expect(archive.rpc.chain.getBlockHash).toHaveBeenCalledTimes(2);
    expect(primary.rpc.chain.getBlockHash).toHaveBeenCalledTimes(1);
    await expect(repository.get('updatesStreams', 'xorBurnsBackfill')).resolves.toMatchObject({
      blockHeight: startBlock,
    });
  });

  it('verifies bridge payloads from block 1 and leaves no writes after a later divergence', async () => {
    const repository = new MemoryRepository();
    const hashes = maintenanceHashes([1, 2]);
    const primary = maintenanceApi({ hashes });
    const archive = maintenanceApi({ hashes, divergentBlock: 2 });
    const subject = subjectWith(primary, archive, repository);
    subject.drainFinalizedHeads = vi.fn(async () => undefined);

    await expect(subject.backfillBridgeProxyHistory(2)).rejects.toThrow(
      `SORA primary and block data endpoints returned different payloads for block ${hashes.get(2)}`,
    );

    expect(primary.rpc.chain.getBlockHash).not.toHaveBeenCalledWith(0);
    expect(archive.rpc.chain.getBlockHash).not.toHaveBeenCalledWith(0);
    expect(primary.rpc.chain.getBlockHash).toHaveBeenCalledWith(1);
    expect(archive.rpc.chain.getBlockHash).toHaveBeenCalledWith(2);
    expect(archive.rpc.state.getMetadata).toHaveBeenCalledWith(SORA_MAINNET_GENESIS_HASH);
    await expect(repository.list('historyElements')).resolves.toEqual([]);
    await expect(repository.list('accountTransactions')).resolves.toEqual([]);
    await expect(repository.get('updatesStreams', 'bridgeProxyHistoryBackfill-v1')).resolves.toBeNull();
  });

  it('uses genesis only for bridge metadata and never fetches or indexes a genesis payload', async () => {
    const repository = new MemoryRepository();
    const hashes = maintenanceHashes([]);
    const primary = maintenanceApi({ hashes });
    const archive = maintenanceApi({ hashes });
    const subject = subjectWith(primary, archive, repository);
    subject.drainFinalizedHeads = vi.fn(async () => undefined);

    await expect(subject.backfillBridgeProxyHistory(0)).resolves.toBeUndefined();

    expect(primary.rpc.chain.getBlockHash).not.toHaveBeenCalled();
    expect(archive.rpc.chain.getBlockHash).not.toHaveBeenCalled();
    expect(primary.rpc.chain.getBlock).not.toHaveBeenCalled();
    expect(archive.rpc.chain.getBlock).not.toHaveBeenCalled();
    expect(archive.rpc.state.getMetadata).toHaveBeenCalledWith(SORA_MAINNET_GENESIS_HASH);
    await expect(repository.list('historyElements')).resolves.toEqual([]);
    await expect(repository.get('updatesStreams', 'bridgeProxyHistoryBackfill-v1')).resolves.toMatchObject({
      blockHeight: 0,
    });
  });
});
