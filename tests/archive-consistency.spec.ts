import { describe, expect, it, vi } from 'vitest';

import { ChainIndexer } from '../src/worker/chain.js';
import { MemoryRepository } from '../src/repository/memory.js';
import { SORA_LEGACY_IDENTITY_ANCHOR } from '../src/soraIdentity.js';

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
};

const subjectWith = (primary: unknown, archive: unknown): ConsistencyIndexer => {
  const subject = new ChainIndexer(config, new MemoryRepository()) as unknown as ConsistencyIndexer;
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
