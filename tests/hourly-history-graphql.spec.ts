import { graphql } from 'graphql';
import { describe, expect, it } from 'vitest';
import { createSchema } from '../src/graphql/resolvers.js';
import { MemoryRepository } from '../src/repository/memory.js';

describe('public hourly history evidence', () => {
  it('exposes exact evidence and keeps legacy evidence nullable', async () => {
    const repository = new MemoryRepository();
    const evidence = {
      kind: 'finalized-hour-close', availability: 'priced',
      genesisHash: `0x${'1'.repeat(64)}`,
      blockHeight: 123, blockHash: `0x${'2'.repeat(64)}`,
      nextBlockHeight: 124, nextBlockHash: `0x${'3'.repeat(64)}`,
      timestamp: 3599, nextTimestamp: 3601, completedAt: 3600,
      symbol: 'XOR', decimals: 18,
    };
    for (const [id, extra] of [['verified', { closeEvidence: evidence }], ['legacy', {}]] as const) {
      await repository.upsert({
        collection: 'assetSnapshots', id, blockHeight: 123, timestamp: 3599,
        data: {
          id, assetId: 'xor', type: 'HOUR', timestamp: 3599,
          denominator: '100000000000000000000000000000000000000',
          priceUSD: { close: '7.000000000000000019' }, ...extra,
        },
      });
    }
    const response = await graphql({
      schema: createSchema(),
      source: '{ assetSnapshots(first: 10) { nodes { id denominator priceUSD closeEvidence } } }',
      contextValue: { repository },
    });
    expect(response.errors).toBeUndefined();
    const nodes = (response.data?.assetSnapshots as { nodes: Array<Record<string, unknown>> }).nodes;
    expect(nodes.find(({ id }) => id === 'verified')).toMatchObject({
      denominator: '100000000000000000000000000000000000000',
      priceUSD: { close: '7.000000000000000019' },
      closeEvidence: evidence,
    });
    expect(nodes.find(({ id }) => id === 'legacy')?.closeEvidence).toBeNull();
    await repository.close();
  });
});
