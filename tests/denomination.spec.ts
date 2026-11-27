import { buildSchema, GraphQLObjectType } from 'graphql';
import { describe, expect, it } from 'vitest';
import { preDenominationSnapshotFactor, readSnapshotDenominator, type PreDenominationEvidence } from '../src/worker/denomination.js';
import { SORA_MAINNET_GENESIS_HASH } from '../src/soraIdentity.js';
import { typeDefs } from '../src/graphql/schema.js';

describe('snapshot denomination evidence', () => {
  it('preserves the cumulative coefficient as an exact decimal string', async () => {
    const value = '100000000000000000000000000000000000001';
    expect(await readSnapshotDenominator({ denomination: { denominator: async () => ({ toString: () => value }) } })).toBe(value);
  });
  it('leaves absent, invalid and pruned historical storage unknown', async () => {
    expect(await readSnapshotDenominator({})).toBeNull();
    for (const value of ['0', '-1', 'NaN', '1e6', '1.5', ' 1']) {
      expect(await readSnapshotDenominator({ denomination: { denominator: async () => ({ toString: () => value }) } })).toBeNull();
    }
    expect(await readSnapshotDenominator({ denomination: { denominator: async () => { throw new Error('pruned'); } } })).toBeNull();
  });
  it('adds a nullable GraphQL field so old snapshots are not falsely normalized', () => {
    const snapshot = buildSchema(typeDefs).getType('AssetSnapshot') as GraphQLObjectType;
    expect(String(snapshot.getFields().denominator?.type)).toBe('String');
  });
});

describe('reviewed pre-pallet denomination evidence', () => {
  const evidence: PreDenominationEvidence = {
    genesisHash: SORA_MAINNET_GENESIS_HASH, block: 90,
    blockHash: '0xa07c08f83b432f84a3e98746bd7d0844bd5ea9eb328f989a7cb814951cdd2a1f',
    specName: 'sora-substrate', specVersion: 1,
    palletNames: ['System', 'Timestamp', 'Assets', 'PoolXYK'], rawDenominator: null,
  };
  it('identifies original units only in the reviewed pre-denomination interval', () => {
    expect(preDenominationSnapshotFactor(evidence)).toBe('1');
    expect(preDenominationSnapshotFactor({ ...evidence, block: 21_063_092, specVersion: 113 })).toBe('1');
  });
  it.each([
    { genesisHash: '0x' + '1'.repeat(64) }, { block: -1 }, { block: 1.5 }, { block: 21_063_093 },
    { blockHash: '0x' + '0'.repeat(64) }, { specName: 'other' }, { specVersion: 0 },
    { specVersion: 114 }, { specVersion: Number.NaN }, { palletNames: [] },
    { palletNames: ['System', 'Assets'] }, { palletNames: [...evidence.palletNames, 'Denomination'] },
    { rawDenominator: undefined }, { rawDenominator: '0x01000000000000000000000000000000' },
  ])('rejects missing or contradictory evidence %j', override => {
    expect(preDenominationSnapshotFactor({ ...evidence, ...override })).toBeNull();
  });
});
